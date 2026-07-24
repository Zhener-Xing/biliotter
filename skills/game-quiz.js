const { completeTask } = require('../llm');
const {
  listCourseGroups,
  getCourseGroup,
  searchNotes,
  loadNoteDoc,
  normalizeBvid,
} = require('../notes-db');

const MAX_TOPIC_NOTES = 8;
const MAX_QUESTIONS = 5;
/** 首包题量：略多于 2，减少答完先到题后还在等补题的概率 */
const EARLY_READY = 3;
const START_LIVES = 3;
/** 出题语料上限：过大只会拖慢 LLM（输入 token），对题质帮助有限 */
const CORPUS_CHAR_LIMIT = 4200;
const CORPUS_PER_NOTE = 900;
const CORPUS_MAX_NOTES = 6;
/** 单题补全时更短，进一步压延迟 */
const CORPUS_SLIM_LIMIT = 2200;
const BV_RE = /BV[\w]+/i;

/** @type {(kind: string, payload?: object) => void} */
let petNotifier = () => {};

function setPetNotifier(fn) {
  petNotifier = typeof fn === 'function' ? fn : () => {};
}

function notifyPet(kind, payload = {}) {
  try {
    petNotifier(kind, payload);
  } catch (err) {
    console.warn('[bili-pet] game pet notify failed:', err?.message || err);
  }
}

/**
 * @typedef {{
 *   type: 'group' | 'folder' | 'current' | 'bvid' | 'topic',
 *   label: string,
 *   bvids: string[],
 *   notes: { bvid: string, title: string }[],
 *   groupId?: string | null,
 *   folderId?: string | null,
 *   query?: string,
 * }} GameScope
 *
 * @typedef {{
 *   q: string,
 *   choices: string[],
 *   answer: number,
 *   explain: string,
 *   sourceBvid: string,
 * }} GameQuestion
 */

/** @type {{
 *   phase: 'idle' | 'awaiting_scope' | 'scope_ready' | 'generating' | 'asking' | 'ended',
 *   startedAt: number | null,
 *   scope: GameScope | null,
 *   pendingChoices: { label: string, scope: GameScope }[] | null,
 *   questions: GameQuestion[],
 *   index: number,
 *   lives: number,
 *   correctCount: number,
 *   backfilling: boolean,
 *   targetTotal: number,
 * }} */
let session = blankSession();
let backfillToken = 0;

function blankSession() {
  return {
    phase: 'idle',
    startedAt: null,
    scope: null,
    pendingChoices: null,
    questions: [],
    index: 0,
    lives: START_LIVES,
    correctCount: 0,
    backfilling: false,
    targetTotal: MAX_QUESTIONS,
  };
}

function isActive() {
  return session.phase !== 'idle';
}

function isPlaying() {
  return (
    session.phase === 'generating' ||
    session.phase === 'asking' ||
    session.phase === 'ended'
  );
}

function resetSession() {
  backfillToken += 1;
  session = blankSession();
}

function startAwaitingScope() {
  backfillToken += 1;
  session = {
    ...blankSession(),
    phase: 'awaiting_scope',
    startedAt: Date.now(),
  };
}

function parseSlash(question) {
  const q = String(question || '').trim();
  if (!q.startsWith('/')) return null;
  return q.split(/\s+/)[0].toLowerCase();
}

/** Strip leading /game so the rest can be treated as scope text. */
function stripGameCommand(question) {
  return String(question || '')
    .trim()
    .replace(/^\/game\b/i, '')
    .trim();
}

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》【】\[\]（）()·.•]/g, '')
    .replace(/课程组$/g, '')
    .replace(/文件夹$/g, '');
}

function scoreName(query, name) {
  const q = normalizeName(query);
  const n = normalizeName(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  if (n.includes(q) || q.includes(n)) {
    const shorter = Math.min(q.length, n.length);
    const longer = Math.max(q.length, n.length);
    if (shorter <= 4 && longer - shorter >= 1 && q !== n) {
      if (longer <= shorter + 2) return 70;
      return 0;
    }
    return 80;
  }
  if (q.length <= 6 || n.length <= 6) return 0;
  let hit = 0;
  const chars = Array.from(q);
  for (const ch of chars) {
    if (n.includes(ch)) hit += 1;
  }
  if (!chars.length) return 0;
  const ratio = hit / chars.length;
  return ratio >= 0.85 ? Math.round(50 + ratio * 20) : 0;
}

function noteMeta(bvid) {
  const key = normalizeBvid(bvid) || String(bvid || '').trim();
  if (!key) return null;
  const doc = loadNoteDoc(key);
  const title = String(doc?.title || '').trim() || key;
  const body = String(doc?.bodyMd || '').trim();
  return { bvid: key, title, hasBody: Boolean(body) };
}

function notesFromBvids(bvids) {
  const out = [];
  const seen = new Set();
  for (const raw of bvids || []) {
    const meta = noteMeta(raw);
    if (!meta || seen.has(meta.bvid)) continue;
    seen.add(meta.bvid);
    if (!meta.hasBody) continue;
    out.push({ bvid: meta.bvid, title: meta.title });
  }
  return out;
}

function buildScope({ type, label, bvids, groupId = null, folderId = null, query = '' }) {
  const notes = notesFromBvids(bvids);
  return {
    type,
    label: String(label || '').trim() || type,
    bvids: notes.map((n) => n.bvid),
    notes,
    groupId,
    folderId,
    query: query || undefined,
  };
}

function formatNotesPreview(notes, { limit = 6 } = {}) {
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) return '（没有可用笔记）';
  const shown = list.slice(0, limit);
  const lines = shown.map((n, i) => `${i + 1}. [${n.bvid}] ${n.title}`);
  if (list.length > shown.length) {
    lines.push(`…另有 ${list.length - shown.length} 篇`);
  }
  return lines.join('\n');
}

function applyScope(scope) {
  if (!scope || !scope.notes?.length) {
    session.pendingChoices = null;
    session.phase = 'awaiting_scope';
    session.scope = null;
    return {
      handled: true,
      ok: false,
      game: true,
      message:
        '这个范围里没有可用的笔记正文，换个课程组/文件夹/主题试试，或先给视频记笔记。',
    };
  }

  session.scope = scope;
  session.pendingChoices = null;
  session.phase = 'scope_ready';
  session.questions = [];
  session.index = 0;
  session.lives = START_LIVES;
  session.correctCount = 0;
  session.backfilling = false;
  session.targetTotal = MAX_QUESTIONS;

  return {
    handled: true,
    ok: true,
    game: true,
    scopeReady: true,
    message:
      `好，范围已定：${scope.label}\n` +
      `共 ${scope.notes.length} 篇笔记将用于出题：\n${formatNotesPreview(scope.notes)}`,
  };
}

function offerChoices(choices, intro) {
  const list = (choices || []).slice(0, 5);
  if (!list.length) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: '没找到匹配项，换个说法试试。',
    };
  }
  session.pendingChoices = list;
  session.phase = 'awaiting_scope';
  session.scope = null;
  const lines = list.map((c, i) => `${i + 1}. ${c.label}`);
  return {
    handled: true,
    ok: true,
    game: true,
    message: `${intro}\n${lines.join('\n')}\n\n回复序号即可。`,
  };
}

function tryPickPendingChoice(question) {
  const choices = session.pendingChoices;
  if (!choices?.length) return null;
  const q = String(question || '').trim();
  const m = q.match(/^([1-9])(?:\s*[.、)]?)?$/);
  if (!m) return null;
  const idx = Number(m[1]) - 1;
  if (idx < 0 || idx >= choices.length) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: `请回复 1–${choices.length} 之间的序号。`,
    };
  }
  return applyScope(choices[idx].scope);
}

function looksLikeCurrent(q) {
  return (
    /^(当前|这个|正在看的?)?(视频|的)?$/.test(q) ||
    /当前(视频|这个)?|这个视频|正在看|本集|这集|^current$/i.test(q)
  );
}

function resolveCurrent(videoMeta = {}) {
  const bvid = normalizeBvid(videoMeta.bvid) || String(videoMeta.bvid || '').trim();
  if (!bvid) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: '现在没有检测到正在看的视频。可以说课程组、文件夹，或一个主题。',
    };
  }
  const title = String(videoMeta.title || '').trim() || noteMeta(bvid)?.title || bvid;
  return applyScope(
    buildScope({
      type: 'current',
      label: `当前视频「${title}」`,
      bvids: [bvid],
    })
  );
}

function resolveBvidMention(q) {
  const m = String(q || '').match(BV_RE);
  if (!m) return null;
  const bvid = normalizeBvid(m[0]) || m[0];
  const meta = noteMeta(bvid);
  if (!meta?.hasBody) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: `找不到 ${bvid} 的笔记正文，换一篇或先记笔记。`,
    };
  }
  return applyScope(
    buildScope({
      type: 'bvid',
      label: `笔记「${meta.title}」`,
      bvids: [bvid],
    })
  );
}

function scoredGroups(query) {
  return listCourseGroups()
    .map((g) => ({ group: g, score: scoreName(query, g.title) }))
    .filter((x) => x.score >= 50)
    .sort((a, b) => b.score - a.score);
}

function parseGroupFolderHints(q) {
  const raw = String(q || '').trim();
  let groupHint = '';
  let folderHint = '';

  // 只认明确的课程组/文件夹结构，避免「相关的吧」被拆成文件夹「吧」
  const groupThenFolder = raw.match(
    /^(.+?)课程组(?:的|里的|中的|\/|／)\s*(.+?)(?:文件夹)?$/
  );
  if (groupThenFolder) {
    groupHint = groupThenFolder[1].trim();
    folderHint = groupThenFolder[2].trim();
  } else {
    const folderOfGroup = raw.match(/^(.+?)(?:的|里的|中的|\/|／)\s*(.+?)文件夹$/);
    if (folderOfGroup) {
      groupHint = folderOfGroup[1].trim();
      folderHint = folderOfGroup[2].trim();
    } else {
      const gOnly = raw.match(/^(.+?)课程组$/);
      if (gOnly) groupHint = gOnly[1].trim();
      const fOnly = raw.match(/^(.+?)文件夹$/);
      if (fOnly) folderHint = fOnly[1].trim();
    }
  }

  if (/文件夹/.test(raw) && !folderHint) {
    folderHint = raw.replace(/文件夹/g, '').replace(/课程组/g, '').trim();
  }
  if (/课程组/.test(raw) && !groupHint) {
    groupHint = raw.replace(/课程组/g, '').replace(/文件夹/g, '').trim();
  }

  // 语气词 / 过短片段不能当文件夹名
  const junk = /^(吧|呢|啊|呀|嘛|啦|哦|哈|嗯|相关|一下|一个|这个|那个)$/;
  if (folderHint && (junk.test(folderHint) || folderHint.length <= 1)) {
    folderHint = '';
  }
  if (groupHint && (junk.test(groupHint) || groupHint.length <= 1)) {
    groupHint = '';
  }

  return { groupHint, folderHint, raw };
}

function scopeFromGroup(group, folder = null) {
  const detail = getCourseGroup(group.id) || group;
  const items = Array.isArray(detail.items) ? detail.items : [];
  let picked = items;
  let label = `课程组「${detail.title || group.title}」`;
  let folderId = null;

  if (folder) {
    folderId = folder.id;
    picked = items.filter((it) => String(it.folderId || '') === String(folder.id));
    label = `课程组「${detail.title || group.title}」/ 文件夹「${folder.title}」`;
  }

  return buildScope({
    type: folder ? 'folder' : 'group',
    label,
    bvids: picked.map((it) => it.bvid),
    groupId: detail.id || group.id,
    folderId,
  });
}

function resolveCourseScope(q) {
  const { groupHint, folderHint, raw } = parseGroupFolderHints(q);
  const groups = listCourseGroups();
  if (!groups.length && (groupHint || folderHint || /课程组|文件夹/.test(raw))) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: '还没有任何课程组。可以改说一个主题，用笔记检索出题。',
    };
  }

  const queryForGroup = groupHint || (!folderHint ? raw : '');
  let groupHits = queryForGroup ? scoredGroups(queryForGroup) : [];

  if (folderHint) {
    const folderChoices = [];
    const groupPool = groupHits.length
      ? groupHits.map((h) => getCourseGroup(h.group.id)).filter(Boolean)
      : groups.map((g) => getCourseGroup(g.id)).filter(Boolean);

    for (const detail of groupPool) {
      for (const folder of detail.folders || []) {
        const score = scoreName(folderHint, folder.title);
        if (score < 50) continue;
        const scope = scopeFromGroup(detail, folder);
        folderChoices.push({
          label: `${detail.title} / ${folder.title}（${scope.notes.length} 篇笔记）`,
          scope,
          score,
        });
      }
    }

    folderChoices.sort((a, b) => b.score - a.score);
    if (folderChoices.length === 1 && folderChoices[0].score >= 70) {
      return applyScope(folderChoices[0].scope);
    }
    if (folderChoices.length >= 1) {
      return offerChoices(
        folderChoices.map(({ label, scope }) => ({ label, scope })),
        '找到多个文件夹，选一个：'
      );
    }
    if (groupHint || /文件夹/.test(raw)) {
      return {
        handled: true,
        ok: false,
        game: true,
        message: `没找到叫「${folderHint}」的文件夹。可以说课程组名，或换个主题检索。`,
      };
    }
  }

  if (!groupHits.length && queryForGroup) {
    groupHits = scoredGroups(queryForGroup);
  }

  const strong = groupHits.filter((h) => h.score >= 70);
  const preferGroup =
    Boolean(groupHint) || /课程组/.test(raw) || strong.length > 0;

  if (preferGroup && groupHits.length) {
    if (groupHits.length > 1 && groupHits[0].score - groupHits[1].score < 15) {
      const choices = groupHits.slice(0, 5).map(({ group }) => {
        const scope = scopeFromGroup(group);
        return {
          label: `课程组「${group.title}」（${scope.notes.length} 篇笔记）`,
          scope,
        };
      });
      return offerChoices(choices, '找到多个课程组，选一个：');
    }
    return applyScope(scopeFromGroup(groupHits[0].group));
  }

  return null;
}

function resolveTopic(q) {
  const query = cleanTopicQuery(q) || String(q || '').trim();
  if (!query) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: '说具体一点：课程组、文件夹、当前视频，或一个主题关键词。',
    };
  }

  const { notes } = searchNotes(query, { limit: 20 });
  const picked = (notes || [])
    .filter((n) => noteMeta(n.bvid)?.hasBody)
    .slice(0, MAX_TOPIC_NOTES)
    .map((n) => ({
      bvid: n.bvid,
      title: String(n.title || '').trim() || n.bvid,
    }));

  if (!picked.length) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: `主题「${query}」没有检索到相关笔记。换个词，或指定课程组/当前视频。`,
    };
  }

  return applyScope({
    type: 'topic',
    label: `主题「${query}」`,
    bvids: picked.map((n) => n.bvid),
    notes: picked,
    query,
  });
}

function cleanTopicQuery(q) {
  let s = String(q || '').trim();
  s = s
    .replace(/^\/game\b/i, '')
    .replace(
      /^(请|帮我|我想|我想要|给我|来|那就|那就考|那就测)?(一下|一考|一测)?/u,
      ''
    )
    .replace(/^(考|测|测验|测试|练习|复习)(个|一下|下|一考|一测)?/u, '')
    .replace(
      /(考一下|测验一下|测试一下|出题|做题|答题|练习|复习一下)/gu,
      ' '
    )
    .replace(
      /(相关的?(知识点|内容|笔记|部分)?|方面的?|的笔记|笔记|知识点|内容|主题|课程)/gu,
      ' '
    )
    .replace(/(吧|呢|啊|呀|嘛|啦|哦|呗)$/u, '')
    .replace(/[，。！？、,.!?;；：:\s]+/g, ' ')
    .trim();
  return s;
}

function looksLikeTopicUtterance(q) {
  const s = String(q || '').trim();
  if (!s) return false;
  if (/课程组|文件夹|BV[\w]+/i.test(s)) return false;
  return /(考|测|练习|复习|相关|关于|知识点|主题)/.test(s);
}

function formatGameCatalog() {
  const groups = listCourseGroups();
  if (!groups.length) return '（当前没有任何课程组）';
  return groups
    .map((g, i) => {
      const detail = getCourseGroup(g.id);
      const folders = (detail?.folders || [])
        .map((f) => f.title)
        .filter(Boolean);
      const folderPart = folders.length
        ? `；文件夹：${folders.join('、')}`
        : '';
      return `${i + 1}. 「${g.title}」${g.topic ? `（${g.topic}）` : ''} · ${g.itemCount || 0} 视频${folderPart}`;
    })
    .join('\n');
}

function findGroupByTitle(title) {
  const hits = scoredGroups(title);
  return hits[0]?.group || null;
}

function findFolderInGroup(group, folderTitle) {
  const detail = getCourseGroup(group.id) || group;
  const folders = detail.folders || [];
  let best = null;
  let bestScore = 0;
  for (const folder of folders) {
    const score = scoreName(folderTitle, folder.title);
    if (score > bestScore) {
      bestScore = score;
      best = folder;
    }
  }
  if (bestScore < 50) return null;
  return best;
}

function applyLlmScopeIntent(intent, videoMeta = {}) {
  const kind = String(intent?.kind || 'unknown').trim();
  const confidence = Number(intent?.confidence) || 0;

  if (kind === 'unknown' || confidence < 0.45) {
    return null;
  }

  if (kind === 'current') {
    return resolveCurrent(videoMeta);
  }

  if (kind === 'bvid') {
    const bvid = normalizeBvid(intent.bvid) || String(intent.bvid || '').trim();
    if (!bvid) return null;
    const meta = noteMeta(bvid);
    if (!meta?.hasBody) {
      return {
        handled: true,
        ok: false,
        game: true,
        message: `找不到 ${bvid} 的笔记正文，换一篇或先记笔记。`,
      };
    }
    return applyScope(
      buildScope({
        type: 'bvid',
        label: `笔记「${meta.title}」`,
        bvids: [bvid],
      })
    );
  }

  if (kind === 'group' || kind === 'folder') {
    const groupTitle = String(intent.groupTitle || '').trim();
    const folderTitle = String(intent.folderTitle || '').trim();
    const junk = /^(吧|呢|啊|呀|嘛|啦|哦|哈|嗯|相关|一下|一个|这个|那个)$/;
    if (folderTitle && (junk.test(folderTitle) || folderTitle.length <= 1)) {
      // 模型误把语气词当成文件夹 → 改走主题
      const topic =
        cleanTopicQuery(intent.topic || groupTitle || '') ||
        cleanTopicQuery(String(intent.topic || ''));
      if (topic) return resolveTopic(topic);
      return null;
    }
    let group = groupTitle ? findGroupByTitle(groupTitle) : null;

    if (!group && folderTitle) {
      // 只给了文件夹名：全库搜文件夹
      const folderChoices = [];
      for (const g of listCourseGroups()) {
        const detail = getCourseGroup(g.id);
        if (!detail) continue;
        for (const folder of detail.folders || []) {
          const score = scoreName(folderTitle, folder.title);
          if (score < 50) continue;
          const scope = scopeFromGroup(detail, folder);
          folderChoices.push({
            label: `${detail.title} / ${folder.title}（${scope.notes.length} 篇笔记）`,
            scope,
            score,
          });
        }
      }
      folderChoices.sort((a, b) => b.score - a.score);
      if (folderChoices.length === 1) return applyScope(folderChoices[0].scope);
      if (folderChoices.length > 1) {
        return offerChoices(
          folderChoices.slice(0, 5).map(({ label, scope }) => ({ label, scope })),
          '找到多个文件夹，选一个：'
        );
      }
    }

    if (!group) {
      return null;
    }

    if (kind === 'folder' || folderTitle) {
      const folder = folderTitle ? findFolderInGroup(group, folderTitle) : null;
      if (!folder && folderTitle) {
        return {
          handled: true,
          ok: false,
          game: true,
          message: `在「${group.title}」里没找到文件夹「${folderTitle}」。换个名字或改说主题。`,
        };
      }
      if (folder) return applyScope(scopeFromGroup(group, folder));
    }

    return applyScope(scopeFromGroup(group));
  }

  if (kind === 'topic') {
    const topic = cleanTopicQuery(intent.topic || '') || String(intent.topic || '').trim();
    if (!topic) return null;
    return resolveTopic(topic);
  }

  return null;
}

async function parseScopeWithLlm(question, videoMeta = {}) {
  const groups = listCourseGroups();
  const payload = {
    userMessage: String(question || '').trim(),
    currentVideo: {
      bvid: videoMeta.bvid || null,
      title: videoMeta.title || null,
    },
    catalogText: formatGameCatalog(),
    existingCourseGroups: groups.map((g) => ({
      id: g.id,
      title: g.title,
      topic: g.topic,
      itemCount: g.itemCount,
      folderCount: g.folderCount,
    })),
  };

  try {
    const raw = await completeTask('game_scope', payload, {
      max_tokens: 400,
      timeoutMs: 20000,
      jsonMode: true,
    });
    return parseJsonObject(raw);
  } catch (err) {
    console.warn('[bili-pet] game scope LLM failed:', err?.message || err);
    return null;
  }
}

async function resolveScope(question, videoMeta = {}) {
  const pending = tryPickPendingChoice(question);
  if (pending) return pending;

  const q = String(question || '').trim();
  if (!q) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: '想考哪一块？可以说课程组、文件夹、当前视频，或一个大致主题。',
    };
  }

  if (looksLikeCurrent(q)) {
    return resolveCurrent(videoMeta);
  }

  const byBvid = resolveBvidMention(q);
  if (byBvid) return byBvid;

  const explicitCourse = /课程组|文件夹/.test(q);
  // 口语主题（「考个网瘾相关的吧」）优先走主题，避免被误拆成文件夹
  if (!explicitCourse && looksLikeTopicUtterance(q)) {
    const intent = await parseScopeWithLlm(q, videoMeta);
    const fromLlm = intent ? applyLlmScopeIntent(intent, videoMeta) : null;
    if (fromLlm) return fromLlm;
    return resolveTopic(q);
  }

  // 启发式课程组/文件夹：仅在明确提到结构词，或已有待选列表时
  const course = resolveCourseScope(q);
  if (
    course &&
    (course.scopeReady ||
      (course.ok === false && explicitCourse) ||
      explicitCourse ||
      session.pendingChoices?.length)
  ) {
    return course;
  }

  const intent = await parseScopeWithLlm(q, videoMeta);
  const fromLlm = intent ? applyLlmScopeIntent(intent, videoMeta) : null;
  if (fromLlm) return fromLlm;

  if (course && course.scopeReady) return course;

  return resolveTopic(q);
}

/** 从 bodyMd 里抠出指定二级标题段落（要点 / 总结） */
function extractMdSection(bodyMd, heading) {
  const md = String(bodyMd || '').replace(/\r\n/g, '\n');
  if (!md.trim()) return '';
  const startRe = new RegExp(`^##\\s*${heading}\\s*$`, 'm');
  const m = startRe.exec(md);
  if (!m) return '';
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^##\s/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/**
 * 出题只用笔记正文里的高密度部分：优先康奈尔「要点 + 总结」，
 * 不再塞 note_chunks 长摘录（以前最多 ~10k，输入 token 是延迟大头）。
 */
function noteQuizExcerpt(doc) {
  const structured = doc?.notes;
  if (
    structured &&
    (structured.notes?.length || structured.summary || structured.cues?.length)
  ) {
    const lines = [];
    if (structured.notes?.length) {
      for (const item of structured.notes) {
        const t = String(item || '').trim();
        if (t) lines.push(`- ${t}`);
      }
    }
    if (structured.summary) {
      lines.push(`总结：${String(structured.summary).trim()}`);
    }
    if (!lines.length && structured.cues?.length) {
      for (const c of structured.cues.slice(0, 10)) {
        const t = String(c || '').trim();
        if (t) lines.push(`- ${t}`);
      }
    }
    return lines.join('\n').trim();
  }

  const body = String(doc?.bodyMd || '').trim();
  if (!body) return '';
  const points = extractMdSection(body, '要点');
  const summary = extractMdSection(body, '总结');
  const dense = [points, summary && `总结：\n${summary}`].filter(Boolean).join('\n\n');
  return (dense || body).trim();
}

/**
 * @param {GameScope} scope
 * @param {{ charLimit?: number, noteOffset?: number, maxNotes?: number }} [opts]
 */
function buildCorpus(scope, opts = {}) {
  const charLimit = Math.max(
    400,
    Number(opts.charLimit) || CORPUS_CHAR_LIMIT
  );
  const maxNotes = Math.max(
    1,
    Math.min(CORPUS_MAX_NOTES, Number(opts.maxNotes) || CORPUS_MAX_NOTES)
  );
  const notes = Array.isArray(scope?.notes) ? scope.notes.slice() : [];
  if (!notes.length) return '';

  const offset =
    notes.length > 0 ? Math.abs(Number(opts.noteOffset) || 0) % notes.length : 0;
  const ordered = offset
    ? notes.slice(offset).concat(notes.slice(0, offset))
    : notes;

  const parts = [];
  let used = 0;
  let taken = 0;

  for (const meta of ordered) {
    if (taken >= maxNotes || used >= charLimit) break;
    const doc = loadNoteDoc(meta.bvid);
    if (!doc) continue;
    const text = noteQuizExcerpt(doc).slice(0, CORPUS_PER_NOTE);
    if (!text) continue;

    const title = meta.title || doc.title || '';
    const block = `[${meta.bvid}${title ? ` · ${title}` : ''}]\n${text}`;
    const room = charLimit - used;
    if (room < 80) break;
    if (block.length > room) {
      parts.push(block.slice(0, room));
      used = charLimit;
      taken += 1;
      break;
    }
    parts.push(block);
    used += block.length + 2;
    taken += 1;
  }

  return parts.join('\n\n');
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function normalizeQuestions(rawList) {
  const out = [];
  for (const item of rawList || []) {
    if (!item || typeof item !== 'object') continue;
    const q = String(item.q || item.question || '').trim();
    let choices = Array.isArray(item.choices) ? item.choices.map((c) => String(c || '').trim()) : [];
    if (choices.length > 4) choices = choices.slice(0, 4);
    while (choices.length < 4) choices.push(`选项${choices.length + 1}`);
    if (!q || choices.some((c) => !c)) continue;
    let answer = Number(item.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) {
      const key = String(item.answer || '').trim().toUpperCase();
      const map = { A: 0, B: 1, C: 2, D: 3 };
      answer = map[key];
    }
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) continue;
    out.push({
      q,
      choices,
      answer,
      explain: String(item.explain || '').trim(),
      sourceBvid: String(item.sourceBvid || item.bvid || '').trim(),
    });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

function publicGameUi(extra = {}) {
  const ready = session.questions.length;
  const total = session.backfilling
    ? Math.max(ready, session.targetTotal || MAX_QUESTIONS)
    : ready;
  const q = session.questions[session.index];
  const base = {
    mode: session.phase,
    lives: session.lives,
    index: session.index,
    total,
    readyCount: ready,
    backfilling: Boolean(session.backfilling),
    correctCount: session.correctCount,
    scopeLabel: session.scope?.label || '',
    ...extra,
  };

  if (session.phase === 'generating') {
    return {
      ...base,
      q: '正在根据笔记出题…',
      choices: ['…', '…', '…', '…'],
      disabled: true,
    };
  }

  if (session.phase === 'ended') {
    const won = session.lives > 0 && session.index >= ready && ready > 0;
    return {
      ...base,
      q: won
        ? `通关！答对 ${session.correctCount}/${ready}\n范围：${session.scope?.label || ''}`
        : `GAME OVER\n答对 ${session.correctCount}/${ready} · 命尽`,
      choices: ['—', '—', '—', '—'],
      disabled: true,
      won,
    };
  }

  if (session.phase === 'asking' && extra.waitingMore) {
    return {
      ...base,
      mode: 'asking',
      q: `第 ${session.index + 1} 题准备中…\n后台还在补题，稍等片刻`,
      choices: ['…', '…', '…', '…'],
      disabled: true,
      waitingMore: true,
    };
  }

  if (session.phase === 'asking' && q) {
    const totalLabel = session.backfilling ? `${total}+` : String(total);
    return {
      ...base,
      q: `第 ${session.index + 1}/${totalLabel} 题 · 命×${session.lives}\n${q.q}`,
      choices: q.choices.slice(0, 4),
      disabled: false,
    };
  }

  return {
    ...base,
    q: '',
    choices: ['', '', '', ''],
    disabled: true,
  };
}

async function requestQuestions({ maxQuestions, corpus, existing = [] }) {
  const n = Math.max(1, Math.min(Number(maxQuestions) || 1, MAX_QUESTIONS));
  // 单题/少题用更小 max_tokens，降低补题延迟
  const maxTokens = n <= 1 ? 520 : n <= 2 ? 900 : 1600;
  // 单题补全用更短语料；多题用完整语料
  const excerpts =
    n <= 1 && session.scope
      ? buildCorpus(session.scope, {
          charLimit: CORPUS_SLIM_LIMIT,
          maxNotes: 4,
          noteOffset: session.questions.length,
        }) || corpus
      : corpus;
  const raw = await completeTask(
    'game_quiz',
    {
      maxQuestions: n,
      scope: session.scope?.label || '',
      notes: (session.scope?.notes || []).map((x) => ({
        bvid: x.bvid,
        title: x.title,
      })),
      excerpts,
      existingQuestions: existing.map((item) => item.q),
    },
    { max_tokens: maxTokens, timeoutMs: 45000, jsonMode: true }
  );
  const parsed = parseJsonObject(raw);
  return normalizeQuestions(parsed?.questions).slice(0, n);
}

function appendUniqueQuestions(list) {
  const seen = new Set(session.questions.map((q) => q.q));
  let added = 0;
  for (const item of list || []) {
    if (!item?.q || seen.has(item.q)) continue;
    session.questions.push(item);
    seen.add(item.q);
    added += 1;
    if (session.questions.length >= MAX_QUESTIONS) break;
  }
  return added;
}

/**
 * 逐题补全：每出 1 题就刷新 UI，避免整批 3 题一次 LLM 调用卡住「准备中」。
 */
async function backfillQuestions(corpus, token) {
  const finish = (endedByEmpty) => {
    if (token !== backfillToken) return;
    session.backfilling = false;
    if (
      endedByEmpty &&
      session.phase === 'asking' &&
      session.index >= session.questions.length
    ) {
      session.phase = 'ended';
    }
    notifyPet('game_ui_refresh', { gameUi: publicGameUi() });
  };

  try {
    let idleRounds = 0;
    while (session.questions.length < MAX_QUESTIONS) {
      if (token !== backfillToken) return;
      if (session.phase !== 'asking' && session.phase !== 'ended') return;

      const need = MAX_QUESTIONS - session.questions.length;
      if (need <= 0) break;

      const more = await requestQuestions({
        maxQuestions: 1,
        corpus,
        existing: session.questions.slice(),
      });
      if (token !== backfillToken) return;
      if (session.phase !== 'asking' && session.phase !== 'ended') return;

      const added = appendUniqueQuestions(more);
      if (added > 0) {
        idleRounds = 0;
        notifyPet('game_ui_refresh', { gameUi: publicGameUi() });
      } else {
        idleRounds += 1;
        // 连续空返回则停止，避免死循环烧配额
        if (idleRounds >= 2) break;
      }
    }
    finish(session.questions.length <= session.index);
  } catch (err) {
    console.warn('[bili-pet] game backfill failed:', err?.message || err);
    finish(session.phase === 'asking' && session.index >= session.questions.length);
  }
}

async function beginQuizFromScope() {
  if (!session.scope?.notes?.length) {
    session.phase = 'awaiting_scope';
    return {
      handled: true,
      ok: false,
      game: true,
      message: '范围无效，请重新选择。',
    };
  }

  session.phase = 'generating';
  session.questions = [];
  session.index = 0;
  session.lives = START_LIVES;
  session.correctCount = 0;
  session.backfilling = false;
  session.targetTotal = MAX_QUESTIONS;
  notifyPet('game_generating');

  const corpus = buildCorpus(session.scope);
  if (!corpus.trim()) {
    session.phase = 'awaiting_scope';
    notifyPet('game_generating_end');
    return {
      handled: true,
      ok: false,
      game: true,
      message: '这些笔记没有可出题的正文片段，换个范围试试。',
    };
  }

  try {
    // 首包与「多预取 1 题」并行：总等待≈max(两路)，开局题库更厚，少卡补题
    const prefetchExtra = MAX_QUESTIONS > EARLY_READY;
    const [first, bonus] = await Promise.all([
      requestQuestions({
        maxQuestions: EARLY_READY,
        corpus,
        existing: [],
      }),
      prefetchExtra
        ? requestQuestions({
            maxQuestions: 1,
            corpus,
            existing: [],
          }).catch((err) => {
            console.warn('[bili-pet] game prefetch failed:', err?.message || err);
            return [];
          })
        : Promise.resolve([]),
    ]);
    if (!first.length) {
      session.phase = 'awaiting_scope';
      notifyPet('game_generating_end');
      return {
        handled: true,
        ok: false,
        game: true,
        message: '出题失败：模型没有返回有效题目。换个范围或再试一次。',
      };
    }

    session.questions = first;
    appendUniqueQuestions(bonus);
    const ready = session.questions.length;
    session.phase = 'asking';
    session.backfilling = ready < MAX_QUESTIONS;
    notifyPet('game_generating_end');
    notifyPet('game_play_start');

    if (session.backfilling) {
      const token = ++backfillToken;
      void backfillQuestions(corpus, token);
    }

    return {
      handled: true,
      ok: true,
      game: true,
      gameUi: publicGameUi(),
      message: session.backfilling
        ? `开始答题：${session.scope.label}（先到 ${ready} 题，其余后台补全，3 条命）\n中途退出：⌘S+G。`
        : `开始答题：${session.scope.label}（共 ${ready} 题，3 条命）\n中途退出：⌘S+G。`,
    };
  } catch (err) {
    session.phase = 'awaiting_scope';
    notifyPet('game_generating_end');
    return {
      handled: true,
      ok: false,
      game: true,
      message: `出题失败：${err?.message || err}`,
    };
  }
}

function answerGame(choiceIndex) {
  if (session.phase !== 'asking') {
    return {
      ok: false,
      error: 'not_asking',
      gameUi: isPlaying() ? publicGameUi() : null,
    };
  }

  const idx = Number(choiceIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx > 3) {
    return { ok: false, error: 'bad_choice', gameUi: publicGameUi() };
  }

  const current = session.questions[session.index];
  if (!current) {
    if (session.backfilling) {
      return {
        ok: true,
        correct: false,
        feedback: '',
        gameUi: publicGameUi({ waitingMore: true }),
        waitingMore: true,
      };
    }
    session.phase = 'ended';
    const gameUi = publicGameUi();
    return {
      ok: true,
      correct: false,
      feedback: '',
      gameUi,
      autoClose: false,
      endMessage: '本局已结束。',
    };
  }

  const correct = idx === current.answer;
  let feedback = '';
  if (correct) {
    session.correctCount += 1;
    feedback = `正确！${current.explain ? ` ${current.explain}` : ''}`;
  } else {
    session.lives -= 1;
    const right = current.choices[current.answer] || '';
    feedback = `不对。答案是 ${String.fromCharCode(65 + current.answer)}. ${right}${
      current.explain ? ` — ${current.explain}` : ''
    }`;
  }

  if (!correct && session.lives <= 0) {
    session.phase = 'ended';
  } else {
    session.index += 1;
    if (session.index >= session.questions.length) {
      if (session.backfilling) {
        return {
          ok: true,
          correct,
          feedback: feedback.trim(),
          gameUi: publicGameUi({ waitingMore: true }),
          waitingMore: true,
        };
      }
      session.phase = 'ended';
    }
  }

  if (session.phase !== 'ended') {
    return {
      ok: true,
      correct,
      feedback: feedback.trim(),
      gameUi: publicGameUi(),
    };
  }

  const total = session.questions.length;
  const won = session.lives > 0 && session.index >= total && total > 0;
  const endMessage = won
    ? `通关！答对 ${session.correctCount}/${total}。范围：${session.scope?.label || ''}`
    : `GAME OVER。答对 ${session.correctCount}/${total}，命尽。`;
  // 前端展示结算后自动关页并 gameStop；此处不露宠物、不重置
  return {
    ok: true,
    correct,
    feedback: feedback.trim(),
    gameUi: publicGameUi(),
    autoClose: true,
    endMessage,
    won,
  };
}

function stopGame() {
  const wasActive = isActive();
  const wasPlaying = isPlaying();
  resetSession();
  if (wasPlaying || wasActive) {
    notifyPet('game_play_end');
  }
  return {
    ok: true,
    stopped: wasActive,
    message: wasActive ? '已中途退出答题。' : '当前没有进行中的答题。',
  };
}

/**
 * @param {string} question
 * @param {{ bvid?: string | null, title?: string }} [videoMeta]
 */
async function tryHandleGameChat(question, videoMeta = {}) {
  const q = String(question || '').trim();
  if (!q) return { handled: false };

  const slash = parseSlash(q);

  if (slash === '/game') {
    // 重开时不要先 game_play_end（会闪出宠物）；直接重置并保持隐藏直到真正退出
    if (isPlaying()) {
      backfillToken += 1;
    }
    startAwaitingScope();

    const rest = stripGameCommand(q);
    if (rest) {
      const resolved = await resolveScope(rest, videoMeta);
      if (resolved?.scopeReady && session.phase === 'scope_ready') {
        return beginQuizFromScope();
      }
      return (
        resolved || {
          handled: true,
          ok: false,
          game: true,
          message: '没理解考查范围，再说一下课程组、文件夹、当前视频或主题吧。',
        }
      );
    }

    return {
      handled: true,
      ok: true,
      game: true,
      message:
        '答题模式已开启。想考哪一块？可以说课程组、文件夹、当前视频，或一个大致主题。\n也可直接发：/game 考一下某某\n选好范围后会自动出题；中途退出请按 ⌘S+G。',
    };
  }

  if (slash && isActive()) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: '答题模式下输入 /game 可重开选范围。中途退出请按 ⌘S+G。',
    };
  }

  if (session.phase === 'asking') {
    const letter = q.toUpperCase();
    const map = { A: 0, B: 1, C: 2, D: 3, '1': 0, '2': 1, '3': 2, '4': 3 };
    if (map[letter] !== undefined || map[q] !== undefined) {
      const choice = map[letter] ?? map[q];
      const result = answerGame(choice);
      return {
        handled: true,
        ok: result.ok,
        game: true,
        gameUi: result.gameUi,
        autoClose: Boolean(result.autoClose),
        endMessage: result.endMessage || '',
        message: result.endMessage || result.feedback || '',
      };
    }
    return {
      handled: true,
      ok: false,
      game: true,
      gameUi: publicGameUi(),
      message: '请点击选项，或输入 A/B/C/D。中途退出：⌘S+G。',
    };
  }

  if (session.phase === 'ended') {
    return {
      handled: true,
      ok: true,
      game: true,
      gameUi: publicGameUi(),
      message: '本局已结束。输入 /game 可再开一局。',
    };
  }

  if (session.phase === 'generating') {
    return {
      handled: true,
      ok: true,
      game: true,
      gameUi: publicGameUi(),
      message: '还在出题，稍等片刻。',
    };
  }

  if (session.phase === 'awaiting_scope' || session.phase === 'scope_ready') {
    const resolved = await resolveScope(q, videoMeta);
    if (resolved?.scopeReady && session.phase === 'scope_ready') {
      return beginQuizFromScope();
    }
    return resolved;
  }

  return { handled: false };
}

function getGameSession() {
  return {
    ...session,
    scope: session.scope ? { ...session.scope, notes: [...(session.scope.notes || [])] } : null,
    pendingChoices: session.pendingChoices
      ? session.pendingChoices.map((c) => ({ label: c.label, scope: c.scope }))
      : null,
    questions: session.questions.map((q) => ({
      q: q.q,
      choices: [...q.choices],
      sourceBvid: q.sourceBvid,
    })),
  };
}

module.exports = {
  tryHandleGameChat,
  answerGame,
  stopGame,
  publicGameUi,
  getGameSession,
  resetSession,
  isActive,
  isPlaying,
  setPetNotifier,
};
