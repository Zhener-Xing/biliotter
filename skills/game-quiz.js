const { completeTask } = require('../llm');
const {
  listCourseGroups,
  getCourseGroup,
  searchNotes,
  searchNoteChunks,
  listChunksForBvids,
  loadNoteDoc,
  normalizeBvid,
} = require('../notes-db');

const MAX_TOPIC_NOTES = 8;
const MAX_QUESTIONS = 5;
/** 首包必须先凑齐的题量；随后后台补到 MAX_QUESTIONS */
const EARLY_READY = 3;
/** 开局多开几路，凑齐 EARLY_READY 就开打，其余继续跑完挂上 */
const OPENING_RACE = 5;
const START_LIVES = 3;
const CORPUS_CHAR_LIMIT = 1700;
const CORPUS_PER_NOTE = 360;
const CORPUS_MAX_NOTES = 3;
const CORPUS_MAX_BULLETS = 8;
/** 单题补全时更短 */
const CORPUS_SLIM_LIMIT = 1100;
/** 首包 3 题专用上限 */
const CORPUS_FIRST_PACK_LIMIT = 1500;
const GAME_SCOPE_TIMEOUT_MS = 12_000;
const GAME_QUIZ_TIMEOUT_MS = 28_000;
/** 一块一题：与默认 LLM_TIMEOUT 对齐，避免 12s 误杀慢代理 */
const GAME_QUIZ_ONE_TIMEOUT_MS = 20_000;
const MIN_QUIZ_CHUNK_CHARS = 72;
const QUIZ_CHUNK_EXCERPT_LIMIT = 380;
const QUIZ_JUNK_HEADING_RE = /^(线索|时间戳|目录|参考|链接|封面|comment)/i;
const BV_RE = /BV[\w]+/i;
const AI_ORG_STRIP_RE =
  /<!--\s*bili-pet:ai-organize:start\s*-->[\s\S]*?<!--\s*bili-pet:ai-organize:end\s*-->/gi;

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
 *   openingBusy: boolean,
 *   backfillStarted: boolean,
 * }} */
let session = blankSession();
let backfillToken = 0;
let openingToken = 0;
/** 开局竞速在 generating 阶段迟到的题，开打前再挂上 */
let lateOpeningBuffer = [];

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
    endReason: null,
    chunkQueue: [],
    openingBusy: false,
    backfillStarted: false,
  };
}

/** 结束本局并取消后台补题。 */
function endRunAndCancelBackfill(reason = null) {
  backfillToken += 1;
  openingToken += 1;
  session.backfilling = false;
  session.openingBusy = false;
  session.backfillStarted = false;
  session.phase = 'ended';
  session.endReason = reason;
  lateOpeningBuffer = [];
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
  openingToken += 1;
  lateOpeningBuffer = [];
  session = blankSession();
}

function startAwaitingScope() {
  backfillToken += 1;
  openingToken += 1;
  lateOpeningBuffer = [];
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

/** 常见课程简称 → 全称，用来对口语考点 */
const COURSE_ALIASES = [
  ['线代', '线性代数'],
  ['高数', '高等数学'],
  ['数分', '数学分析'],
  ['概统', '概率统计', '概率论', '数理统计'],
  ['计网', '计算机网络'],
  ['计组', '计算机组成', '组成原理'],
  ['操统', '操作系统'],
  ['离散', '离散数学'],
  ['数电', '数字电路'],
  ['模电', '模拟电路'],
  ['编译', '编译原理'],
  ['计科', '计算机'],
];

function expandAliases(s) {
  const n = normalizeName(s);
  const out = new Set([n]);
  if (!n || n.length < 2) return [...out];
  for (const group of COURSE_ALIASES) {
    const norms = group.map(normalizeName);
    if (norms.includes(n)) {
      for (const x of norms) out.add(x);
    }
  }
  return [...out];
}

function bigramSet(s) {
  const str = String(s || '');
  const set = new Set();
  if (str.length <= 1) {
    if (str) set.add(str);
    return set;
  }
  for (let i = 0; i < str.length - 1; i += 1) {
    set.add(str.slice(i, i + 2));
  }
  return set;
}

function jaccardBigrams(a, b) {
  const A = bigramSet(a);
  const B = bigramSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) inter += 1;
  }
  return inter / (A.size + B.size - inter);
}

/** q 是否为 n 的顺序子序列；返回匹配跨度，否则 Infinity */
function orderedSpan(q, n) {
  let i = 0;
  let start = -1;
  for (let j = 0; j < n.length; j += 1) {
    if (n[j] !== q[i]) continue;
    if (start < 0) start = j;
    i += 1;
    if (i >= q.length) return j - start + 1;
  }
  return Infinity;
}

function scoreNamePair(q, n) {
  if (!q || !n) return 0;
  if (q === n) return 100;

  if (n.includes(q) || q.includes(n)) {
    const shorter = Math.min(q.length, n.length);
    const longer = Math.max(q.length, n.length);
    if (shorter <= 1) return 0;
    const ratio = shorter / longer;
    return Math.round(55 + 45 * ratio);
  }

  if (q.length >= 2 && q.length <= 4) {
    const span = orderedSpan(q, n);
    if (Number.isFinite(span) && span <= q.length * 3) {
      if (q.length === 2 && q[0] !== n[0]) return 0;
      const compactness = q.length / span;
      return Math.round(48 + compactness * 28);
    }
  }

  if (q.length >= 3 && n.length >= 3) {
    const jac = jaccardBigrams(q, n);
    if (jac >= 0.4) return Math.round(40 + jac * 50);
  }
  return 0;
}

function scoreName(query, name) {
  const q0 = normalizeName(query);
  const n0 = normalizeName(name);
  if (!q0 || !n0) return 0;
  let best = scoreNamePair(q0, n0);
  const qExp = expandAliases(query);
  const nExp = expandAliases(name);
  for (const q of qExp) {
    for (const n of nExp) {
      if (q === q0 && n === n0) continue;
      const s = scoreNamePair(q, n);
      if (s > 0) best = Math.max(best, s - 4);
    }
  }
  return best;
}

function lastCourseContext() {
  try {
    return require('../course-actions').getLastCourseContext() || {};
  } catch {
    return {};
  }
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
  const s = String(q || '').trim();
  if (!s) return false;
  return /^(当前(这个)?(视频)?|这个视频|正在看的?(视频)?|本集|这集|current)$/i.test(
    s
  );
}

const SCOPE_JUNK_RE =
  /^(吧|呢|啊|呀|嘛|啦|哦|哈|嗯|呗|相关|一下|一个|这个|那个|考点|题目)$/;

function isScopeJunk(s) {
  const t = String(s || '').trim();
  return !t || t.length <= 1 || SCOPE_JUNK_RE.test(t);
}

/** 去掉「考一下 / 帮我复习」等外壳，抽出真正想考的词 */
function cleanTopicQuery(q) {
  let s = String(q || '').trim();
  s = s
    .replace(/^\/game\b/i, '')
    .replace(
      /^(请|帮我|我想|我想要|给我|来|那就|那就考|那就测|给我|麻烦)?(一下|一考|一测)?/u,
      ''
    )
    .replace(
      /^(考考我|考我|自测|出几道题|出题|做题|答题)/u,
      ''
    )
    .replace(
      /^(考|测|测验|测试|练习|复习|回顾)(个|一下|下|一考|一测|一复习)?/u,
      ''
    )
    .replace(
      /(考一下|测验一下|测试一下|出题|做题|答题|练习|复习一下|自测)/gu,
      ' '
    )
    .replace(/^(关于|有关)/u, '')
    .replace(
      /(相关的?(知识点|内容|笔记|部分)?|方面的?|的笔记|知识点)/gu,
      ' '
    )
    .replace(/(这块|那块|这一块|那一块|这部分|那部分)$/u, '')
    .replace(/(吧|呢|啊|呀|嘛|啦|哦|呗)$/u, '')
    .replace(/[，。！？、,.!?;；：:\s]+/g, ' ')
    .trim();
  if (isScopeJunk(s)) return '';
  return s;
}

/** 「高数的积分」「机器学习里的反向传播」 */
function splitPossessive(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  const m = s.match(
    /^(.+?)(?:课程组)?(?:的|里的|中的|里面的|里|中|\/|／)\s*(.+?)(?:文件夹)?$/
  );
  if (!m) return null;
  const left = cleanTopicQuery(m[1]) || m[1].trim();
  const right = cleanTopicQuery(m[2]) || m[2].trim();
  if (isScopeJunk(left) || isScopeJunk(right)) return null;
  if (left.length < 2 || right.length < 2) return null;
  if (looksLikeCurrent(left) || looksLikeCurrent(s)) return null;
  return { left, right };
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
    .map((g) => ({
      group: g,
      score: Math.max(scoreName(query, g.title), scoreName(query, g.topic)),
    }))
    .filter((x) => x.score >= 50)
    .sort((a, b) => b.score - a.score);
}

function parseGroupFolderHints(q) {
  const raw = String(q || '').trim();
  let groupHint = '';
  let folderHint = '';

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

  if (folderHint && isScopeJunk(folderHint)) folderHint = '';
  if (groupHint && isScopeJunk(groupHint)) groupHint = '';

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

function collectCatalogCandidates(query) {
  const q = String(query || '').trim();
  if (!q || isScopeJunk(q)) return [];
  const out = [];
  for (const g of listCourseGroups()) {
    const detail = getCourseGroup(g.id) || g;
    const groupScore = Math.max(
      scoreName(q, detail.title || g.title),
      scoreName(q, detail.topic || g.topic)
    );
    if (groupScore >= 50) {
      const scope = scopeFromGroup(detail);
      out.push({
        kind: 'group',
        score: groupScore,
        label: `课程组「${detail.title || g.title}」（${scope.notes.length} 篇笔记）`,
        scope,
      });
    }
    for (const folder of detail.folders || []) {
      const fs = scoreName(q, folder.title);
      if (fs < 50) continue;
      const scope = scopeFromGroup(detail, folder);
      out.push({
        kind: 'folder',
        score: fs + (groupScore >= 50 ? 6 : 0),
        label: `${detail.title} / ${folder.title}（${scope.notes.length} 篇笔记）`,
        scope,
      });
    }
    for (const item of detail.items || []) {
      const is = scoreName(q, item.title);
      if (is < 72) continue;
      const meta = noteMeta(item.bvid);
      if (!meta?.hasBody) continue;
      const scope = buildScope({
        type: 'bvid',
        label: `笔记「${meta.title}」`,
        bvids: [meta.bvid],
        groupId: detail.id || g.id,
        query: q,
      });
      out.push({
        kind: 'item',
        score: is,
        label: `笔记「${meta.title}」`,
        scope,
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function pickCatalogMatch(candidates, { intro } = {}) {
  const list = (candidates || []).filter((c) => c && c.score >= 55 && c.scope);
  if (!list.length) return null;
  const best = list[0];
  const second = list[1];
  const uniqueStrong =
    best.score >= 75 && (!second || best.score - second.score >= 12);

  const applyOrEmpty = (item) => {
    if (!item.scope.notes?.length) {
      return {
        handled: true,
        ok: false,
        game: true,
        message: `「${item.label}」里没有可用笔记正文，换个范围或先记笔记。`,
      };
    }
    return applyScope(item.scope);
  };

  if (uniqueStrong) return applyOrEmpty(best);
  if (list.length === 1) {
    if (best.score >= 70) return applyOrEmpty(best);
    return null;
  }
  return offerChoices(
    list.slice(0, 5).map(({ label, scope }) => ({ label, scope })),
    intro || '找到多个接近的范围，选一个：'
  );
}

function notesMatchingQuery(query, { bvids = null, limit = MAX_TOPIC_NOTES } = {}) {
  const q = String(query || '').trim();
  if (!q || isScopeJunk(q)) return [];
  const restrict =
    Array.isArray(bvids) && bvids.length
      ? new Set(
          bvids
            .map((b) => normalizeBvid(b) || String(b || '').trim())
            .filter(Boolean)
        )
      : null;

  const picked = [];
  const seen = new Set();
  const consider = (bvid, title) => {
    const key = normalizeBvid(bvid) || String(bvid || '').trim();
    if (!key || seen.has(key)) return;
    if (restrict && !restrict.has(key)) return;
    const meta = noteMeta(key);
    if (!meta?.hasBody) return;
    seen.add(key);
    picked.push({
      bvid: key,
      title: String(title || meta.title || '').trim() || key,
    });
  };

  const { notes, hits } = searchNotes(q, { limit: 30 });
  for (const n of notes || []) consider(n.bvid, n.title);
  for (const h of hits || []) consider(h.bvid, '');

  if (restrict && picked.length < limit) {
    try {
      const chunkHits = searchNoteChunks(q, {
        bvids: [...restrict],
        limit: 20,
      });
      for (const h of chunkHits || []) consider(h.bvid, '');
    } catch {
      /* ignore */
    }
  }

  return picked.slice(0, limit);
}

function applyTopicNotes(query, notes, { label, groupId = null } = {}) {
  const picked = Array.isArray(notes) ? notes : [];
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
    label: label || `主题「${query}」`,
    bvids: picked.map((n) => n.bvid),
    notes: picked,
    groupId,
    query,
  });
}

function resolveTopicInGroup(group, innerQuery) {
  const detail = getCourseGroup(group.id) || group;
  const folder = findFolderInGroup(detail, innerQuery);
  if (folder) return applyScope(scopeFromGroup(detail, folder));

  const itemHits = (detail.items || [])
    .map((it) => ({ it, score: scoreName(innerQuery, it.title) }))
    .filter((x) => x.score >= 55)
    .sort((a, b) => b.score - a.score);

  if (itemHits.length === 1 && itemHits[0].score >= 72) {
    const meta = noteMeta(itemHits[0].it.bvid);
    if (meta?.hasBody) {
      return applyScope(
        buildScope({
          type: 'bvid',
          label: `${detail.title} · 「${meta.title}」`,
          bvids: [meta.bvid],
          groupId: detail.id,
          query: innerQuery,
        })
      );
    }
  }

  const groupBvids = (detail.items || []).map((it) => it.bvid);
  const picked = notesMatchingQuery(innerQuery, { bvids: groupBvids });
  if (picked.length) {
    return applyTopicNotes(innerQuery, picked, {
      label: `${detail.title} · ${innerQuery}`,
      groupId: detail.id,
    });
  }

  if (itemHits.length) {
    const bvids = itemHits
      .map((x) => x.it.bvid)
      .filter((bv) => noteMeta(bv)?.hasBody);
    if (bvids.length) {
      return applyScope(
        buildScope({
          type: 'topic',
          label: `${detail.title} · ${innerQuery}`,
          bvids,
          groupId: detail.id,
          query: innerQuery,
        })
      );
    }
  }

  return {
    handled: true,
    ok: false,
    game: true,
    message: `在「${detail.title}」里没找到「${innerQuery}」相关笔记。可以说文件夹名，或换个词。`,
  };
}

function resolvePossessive(q) {
  const split = splitPossessive(q);
  if (!split) return null;
  const groupHits = scoredGroups(split.left);
  if (!groupHits.length) return null;
  const best = groupHits[0];
  const second = groupHits[1];
  if (second && best.score - second.score < 12 && best.score < 80) {
    return null;
  }
  if (best.score < 55) return null;
  return resolveTopicInGroup(best.group, split.right);
}

function resolveRecentContext(q) {
  const s = String(q || '').trim();
  if (!/^(这个|刚才?(那个)?|上次的?|刚刚的?)(课程组|课)?$/.test(s)) return null;
  const ctx = lastCourseContext();
  if (ctx.groupId) {
    const group = getCourseGroup(ctx.groupId);
    if (group) {
      const folder =
        ctx.folderId &&
        (group.folders || []).find((f) => String(f.id) === String(ctx.folderId));
      return applyScope(scopeFromGroup(group, folder || null));
    }
  }
  return null;
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

function resolveTopic(q, { bvids = null, label = '' } = {}) {
  const query = cleanTopicQuery(q);
  if (!query) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: '说具体一点：课程组、文件夹、当前视频，或一个主题关键词。',
    };
  }

  const picked = notesMatchingQuery(query, { bvids });
  return applyTopicNotes(query, picked, { label });
}

function formatGameCatalog() {
  const groups = listCourseGroups();
  if (!groups.length) return '（当前没有任何课程组）';
  return groups
    .slice(0, 24)
    .map((g, i) => {
      const detail = getCourseGroup(g.id);
      const folders = (detail?.folders || [])
        .map((f) => f.title)
        .filter(Boolean)
        .slice(0, 12);
      const folderPart = folders.length
        ? `；夹：${folders.join('、')}`
        : '';
      const topic = String(g.topic || '').trim();
      const topicPart = topic ? `(${topic.slice(0, 28)})` : '';
      return `${i + 1}.「${g.title}」${topicPart}·${g.itemCount || 0}v${folderPart}`;
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
        const inner =
          cleanTopicQuery(intent.topic || folderTitle) || folderTitle;
        return resolveTopicInGroup(group, inner);
      }
      if (folder) return applyScope(scopeFromGroup(group, folder));
    }

    const innerTopic = cleanTopicQuery(intent.topic || '');
    if (innerTopic) return resolveTopicInGroup(group, innerTopic);

    return applyScope(scopeFromGroup(group));
  }

  if (kind === 'topic') {
    const topic =
      cleanTopicQuery(intent.topic || '') ||
      String(intent.topic || '').trim();
    if (!topic || isScopeJunk(topic)) return null;
    const groupTitle = String(intent.groupTitle || '').trim();
    if (groupTitle) {
      const group = findGroupByTitle(groupTitle);
      if (group) return resolveTopicInGroup(group, topic);
    }
    return resolveTopic(topic);
  }

  return null;
}

async function parseScopeWithLlm(question, videoMeta = {}) {
  const groups = listCourseGroups().slice(0, 24);
  const payload = {
    userMessage: String(question || '').trim().slice(0, 240),
    cleanedMessage: cleanTopicQuery(question).slice(0, 120),
    currentVideo: {
      bvid: videoMeta.bvid || null,
      title: videoMeta.title ? String(videoMeta.title).slice(0, 80) : null,
    },
    catalogText: formatGameCatalog(),
    existingCourseGroups: groups.map((g) => ({
      title: g.title,
      topic: g.topic ? String(g.topic).slice(0, 32) : '',
      folders: g.folderCount || 0,
    })),
  };

  try {
    const raw = await completeTask('game_scope', payload, {
      max_tokens: 800,
      timeoutMs: GAME_SCOPE_TIMEOUT_MS,
      // V4 + json_object + 小额度：非流式常返回空 content
      jsonMode: false,
      temperature: 0.2,
      thinking: false,
      reasoningEffort: 'none',
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

  const raw = String(question || '').trim();
  if (!raw) {
    return {
      handled: true,
      ok: false,
      game: true,
      message: '想考哪一块？可以说课程组、文件夹、当前视频，或一个大致主题。',
    };
  }

  const cleaned = cleanTopicQuery(raw);
  const q = cleaned || raw;

  if (looksLikeCurrent(raw) || looksLikeCurrent(q)) {
    return resolveCurrent(videoMeta);
  }

  const recent = resolveRecentContext(q) || resolveRecentContext(raw);
  if (recent) return recent;

  const byBvid = resolveBvidMention(raw);
  if (byBvid) return byBvid;

  const explicitCourse = /课程组|文件夹/.test(raw);

  const possessive = resolvePossessive(q) || resolvePossessive(raw);
  if (possessive) return possessive;

  // 目录：课程组 / 文件夹 / 课时名（先用清洗后的词，再用原句）
  let catalog = collectCatalogCandidates(q);
  if (!catalog.length && raw !== q) catalog = collectCatalogCandidates(raw);
  const catalogHit = pickCatalogMatch(catalog);
  if (catalogHit) return catalogHit;

  const course = resolveCourseScope(q) || resolveCourseScope(raw);
  if (
    course &&
    (course.scopeReady ||
      (course.ok === false && explicitCourse) ||
      explicitCourse ||
      session.pendingChoices?.length)
  ) {
    return course;
  }

  // 本地主题检索：有命中也先走，但清洗后太泛的词不要搜
  if (cleaned && cleaned.length >= 2 && !explicitCourse) {
    const topicHit = resolveTopic(cleaned);
    if (topicHit?.scopeReady) return topicHit;
    const split = splitPossessive(cleaned) || splitPossessive(raw);
    if (split?.right && split.right !== cleaned) {
      const innerHit = resolveTopic(split.right);
      if (innerHit?.scopeReady) return innerHit;
    }
  }

  const intent = await parseScopeWithLlm(raw, videoMeta);
  const fromLlm = intent ? applyLlmScopeIntent(intent, videoMeta) : null;
  if (fromLlm) return fromLlm;

  if (course && course.scopeReady) return course;

  if (cleaned && cleaned.length >= 2) return resolveTopic(cleaned);
  return resolveTopic(raw);
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

function noteQuizExcerpt(doc, topicQuery = '') {
  const topic = normalizeName(topicQuery);
  const preferTopic = (text) => {
    const raw = String(text || '').trim();
    if (!raw || !topic || topic.length < 2) return raw;
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return raw;
    const focused = lines.filter((l) => normalizeName(l).includes(topic));
    return focused.length ? focused.join('\n') : raw;
  };

  const structured = doc?.notes;
  if (
    structured &&
    (structured.notes?.length || structured.summary || structured.cues?.length)
  ) {
    const lines = [];
    const bullets = Array.isArray(structured.notes) ? structured.notes : [];
    for (const item of bullets.slice(0, CORPUS_MAX_BULLETS)) {
      const t = String(item || '').trim();
      if (t) lines.push(`- ${t}`);
    }
    if (structured.summary) {
      const s = String(structured.summary).trim().slice(0, 180);
      if (s) lines.push(`总结：${s}`);
    }
    if (!lines.length && structured.cues?.length) {
      for (const c of structured.cues.slice(0, 6)) {
        const t = String(c || '').trim();
        if (t) lines.push(`- ${t}`);
      }
    }
    return preferTopic(lines.join('\n').trim());
  }

  const body = String(doc?.bodyMd || '')
    .replace(AI_ORG_STRIP_RE, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!body) return '';
  const points = extractMdSection(body, '要点');
  const summary = extractMdSection(body, '总结');
  const dense = [points, summary && `总结：\n${summary}`].filter(Boolean).join('\n\n');
  return preferTopic((dense || body).trim());
}

function buildTopicChunkCorpus(scope, charLimit) {
  const query = String(scope?.query || '').trim();
  const bvids = (scope?.notes || [])
    .map((n) => normalizeBvid(n.bvid) || String(n.bvid || '').trim())
    .filter(Boolean);
  if (!query || query.length < 2 || !bvids.length) return '';
  let hits = [];
  try {
    hits = searchNoteChunks(query, { bvids, limit: 8 });
  } catch {
    return '';
  }
  const parts = [];
  let used = 0;
  const seen = new Set();
  for (const h of hits || []) {
    const text = String(h.text || '').trim();
    if (!text) continue;
    const key = `${h.bvid}:${h.chunkIndex || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = noteMeta(h.bvid)?.title || '';
    const heading = String(h.heading || '').trim();
    const block =
      `[${h.bvid}${title ? ` · ${title}` : ''}${heading ? ` / ${heading}` : ''}]\n` +
      text.slice(0, CORPUS_PER_NOTE);
    const room = charLimit - used;
    if (room < 80) break;
    if (block.length > room) {
      parts.push(block.slice(0, room));
      break;
    }
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join('\n\n');
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

  const topicFirst = buildTopicChunkCorpus(scope, charLimit);
  if (topicFirst && topicFirst.length >= 200) return topicFirst;

  const offset =
    notes.length > 0 ? Math.abs(Number(opts.noteOffset) || 0) % notes.length : 0;
  const ordered = offset
    ? notes.slice(offset).concat(notes.slice(0, offset))
    : notes;

  const parts = topicFirst ? [topicFirst] : [];
  let used = topicFirst.length;
  let taken = 0;

  for (const meta of ordered) {
    if (taken >= maxNotes || used >= charLimit) break;
    const doc = loadNoteDoc(meta.bvid);
    if (!doc) continue;
    const text = noteQuizExcerpt(doc, scope?.query).slice(0, CORPUS_PER_NOTE);
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

function shuffleInPlace(list) {
  const arr = Array.isArray(list) ? list : [];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function scopeBvidList(scope = session.scope) {
  const fromNotes = (scope?.notes || [])
    .map((n) => normalizeBvid(n.bvid) || String(n.bvid || '').trim())
    .filter(Boolean);
  const fromScope = Array.isArray(scope?.bvids)
    ? scope.bvids.map((b) => normalizeBvid(b) || String(b || '').trim())
    : [];
  return [...new Set([...fromNotes, ...fromScope].filter(Boolean))];
}

function isQuizableChunk(row) {
  const text = String(row?.text || '')
    .replace(/[#*`>_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < MIN_QUIZ_CHUNK_CHARS) return false;
  const heading = String(row?.heading || '').trim();
  if (heading && QUIZ_JUNK_HEADING_RE.test(heading)) return false;
  return true;
}

function formatChunkExcerpt(row) {
  const title = noteMeta(row.bvid)?.title || '';
  const heading = String(row.heading || '').trim();
  const text = String(row.text || '').trim().slice(0, QUIZ_CHUNK_EXCERPT_LIMIT);
  return `[${row.bvid}${title ? ` · ${title}` : ''}${heading ? ` / ${heading}` : ''}]\n${text}`;
}

function pickDiverseChunks(chunks, n) {
  const need = Math.max(0, Number(n) || 0);
  const byBvid = new Map();
  for (const c of chunks || []) {
    const k = String(c.bvid || '');
    if (!byBvid.has(k)) byBvid.set(k, []);
    byBvid.get(k).push(c);
  }
  const keys = [...byBvid.keys()];
  const out = [];
  const seen = new Set();
  while (out.length < need) {
    let added = false;
    for (const k of keys) {
      const q = byBvid.get(k);
      while (q && q.length) {
        const c = q.shift();
        const id = `${c.bvid}:${c.chunkIndex}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(c);
        added = true;
        break;
      }
      if (out.length >= need) break;
    }
    if (!added) break;
  }
  return out;
}

function takeQuizChunks(pool, n) {
  const picked = pickDiverseChunks(pool, n);
  if (!picked.length) return [];
  const ids = new Set(picked.map((c) => `${c.bvid}:${c.chunkIndex}`));
  for (let i = (pool || []).length - 1; i >= 0; i -= 1) {
    const c = pool[i];
    if (ids.has(`${c.bvid}:${c.chunkIndex}`)) pool.splice(i, 1);
  }
  return picked;
}

function collectQuizChunks(scope) {
  const bvids = scopeBvidList(scope);
  if (!bvids.length) return [];
  const query = String(scope?.query || '').trim();
  let hits = [];
  if (query.length >= 2) {
    try {
      hits = searchNoteChunks(query, { bvids, limit: 24 }) || [];
    } catch {
      hits = [];
    }
  }
  let extra = [];
  try {
    extra = listChunksForBvids(bvids, { limit: 80, perBvid: 8 }) || [];
  } catch {
    extra = [];
  }

  const seen = new Set();
  const take = (rows) => {
    const out = [];
    for (const row of rows || []) {
      if (!isQuizableChunk(row)) continue;
      const id = `${row.bvid}:${row.chunkIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(row);
    }
    return out;
  };

  const usableHits = shuffleInPlace(take(hits));
  const usableExtra = shuffleInPlace(take(extra));
  return usableHits.concat(usableExtra);
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

function stillExpectingMoreQuestions() {
  return (
    session.lives > 0 &&
    session.questions.length < MAX_QUESTIONS &&
    (session.backfilling || session.openingBusy)
  );
}

function publicGameUi(extra = {}) {
  const ready = session.questions.length;
  const q = session.questions[session.index];
  const waitingMore =
    Boolean(extra.waitingMore) ||
    (session.phase === 'asking' && !q && stillExpectingMoreQuestions());
  const displayTotal = Math.min(
    MAX_QUESTIONS,
    session.backfilling || session.openingBusy
      ? Math.max(ready, EARLY_READY)
      : ready
  );
  const base = {
    mode: session.phase,
    lives: session.lives,
    index: session.index,
    total: displayTotal,
    readyCount: ready,
    backfilling: Boolean(session.backfilling || session.openingBusy),
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
    const ready = session.questions.length;
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

  if (session.phase === 'asking' && waitingMore) {
    return {
      ...base,
      q: '下一题正在出…',
      choices: ['…', '…', '…', '…'],
      disabled: true,
      waitingMore: true,
    };
  }

  if (session.phase === 'asking' && q) {
    const totalLabel =
      (session.backfilling || session.openingBusy) && ready < MAX_QUESTIONS
        ? `${ready}+`
        : String(ready);
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

async function requestQuestions({
  maxQuestions,
  corpus,
  existing = [],
  attempts,
  signal,
} = {}) {
  const n = Math.max(1, Math.min(Number(maxQuestions) || 1, MAX_QUESTIONS));
  const maxTokens = n <= 1 ? 2048 : n <= 2 ? 1400 : 1800;
  const timeoutMs = n <= 1 ? GAME_QUIZ_ONE_TIMEOUT_MS : GAME_QUIZ_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Number(attempts) || (n <= 1 ? 1 : 2));
  let excerpts = String(corpus || '').trim();
  if (!excerpts && session.scope) {
    excerpts = buildCorpus(session.scope, {
      charLimit: n <= 1 ? CORPUS_SLIM_LIMIT : CORPUS_FIRST_PACK_LIMIT,
      maxNotes: n <= 1 ? 2 : CORPUS_MAX_NOTES,
      noteOffset: session.questions.length,
    });
  }
  if (!excerpts) throw new Error('没有可出题的笔记片段');

  const existingQuestions = existing
    .map((item) => item.q)
    .filter(Boolean)
    .slice(0, 8);

  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error('LLM 请求已取消');
    try {
      const raw = await completeTask(
        'game_quiz',
        {
          maxQuestions: n,
          scope: session.scope?.label || '',
          topicFocus: String(session.scope?.query || '').trim().slice(0, 40),
          excerpts,
          existingQuestions,
        },
        {
          max_tokens: maxTokens,
          timeoutMs,
          // V4 非流式 json_object 在关思考/小额度时经常 content 为空；提示词已要求 JSON
          jsonMode: false,
          temperature: 0.3,
          thinking: false,
          reasoningEffort: 'none',
          signal,
        }
      );
      const parsed = parseJsonObject(raw);
      const list = normalizeQuestions(parsed?.questions).slice(0, n);
      if (list.length) return list;
      lastErr = new Error('模型返回了 JSON 但没有有效题目');
    } catch (err) {
      lastErr = err;
      if (String(err?.message || '').includes('已取消')) throw err;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
    }
  }
  throw lastErr || new Error('出题失败');
}

async function requestOneFromChunk(chunk, existing = [], { signal } = {}) {
  const t0 = Date.now();
  try {
    const list = await requestQuestions({
      maxQuestions: 1,
      corpus: formatChunkExcerpt(chunk),
      existing,
      attempts: 1,
      signal,
    });
    const q = list[0];
    if (q && !q.sourceBvid) q.sourceBvid = chunk.bvid;
    console.log(
      `[bili-pet] game quiz chunk ok ${Date.now() - t0}ms heading=${String(chunk.heading || '').slice(0, 24)}`
    );
    return q ? [q] : [];
  } catch (err) {
    const msg = String(err?.message || err);
    if (!msg.includes('已取消')) {
      console.warn(`[bili-pet] game quiz chunk fail ${Date.now() - t0}ms:`, msg);
    }
    throw err;
  }
}

async function requestParallelFromChunks(
  chunks,
  existing = [],
  { want = EARLY_READY, abortRest = true, onExtra, onSettled } = {}
) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) {
    try {
      onSettled?.();
    } catch (_) {
      /* ignore */
    }
    return [];
  }
  const need = Math.max(1, Number(want) || EARLY_READY);
  const ac = abortRest ? new AbortController() : null;
  const collected = [];
  const seenQ = new Set((existing || []).map((q) => q.q).filter(Boolean));
  const signal = ac?.signal;

  await new Promise((resolve) => {
    let pending = list.length;
    let resolved = false;
    const resolveOnce = () => {
      if (resolved) return;
      resolved = true;
      if (abortRest) ac.abort();
      resolve();
    };

    for (const chunk of list) {
      requestOneFromChunk(chunk, existing, signal ? { signal } : {})
        .then((qs) => {
          for (const q of qs || []) {
            if (!q?.q || seenQ.has(q.q)) continue;
            seenQ.add(q.q);
            if (!resolved) {
              collected.push(q);
              if (collected.length >= need) resolveOnce();
            } else if (!abortRest) {
              onExtra?.(q);
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          pending -= 1;
          if (pending <= 0) {
            resolveOnce();
            try {
              onSettled?.();
            } catch (_) {
              /* ignore */
            }
          }
        });
    }
  });

  return collected.slice(0, MAX_QUESTIONS);
}

async function fillOpeningFromChunks(pool, existing = []) {
  const have = Array.isArray(existing) ? existing.slice() : [];
  const need = EARLY_READY - have.length;
  if (need <= 0) return have;
  const raceN = Math.max(need, Math.min(OPENING_RACE, (pool || []).length));
  const chunks = takeQuizChunks(pool, raceN);
  if (!chunks.length) return have;
  session.openingBusy = chunks.length > need;
  const token = ++openingToken;
  const more = await requestParallelFromChunks(chunks, have, {
    want: need,
    abortRest: false,
    onExtra: (q) => {
      if (token !== openingToken) return;
      handleLateQuestion(q);
    },
    onSettled: () => {
      if (token !== openingToken) return;
      session.openingBusy = false;
      startBackfillIfNeeded();
    },
  });
  const seen = new Set(have.map((q) => q.q));
  for (const q of more) {
    if (!q?.q || seen.has(q.q)) continue;
    seen.add(q.q);
    have.push(q);
    if (have.length >= MAX_QUESTIONS) break;
  }
  return have;
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

function consumeLateOpening() {
  const list = lateOpeningBuffer;
  lateOpeningBuffer = [];
  return list;
}

function handleLateQuestion(q) {
  if (!q?.q) return;
  if (session.phase === 'asking') {
    if (appendUniqueQuestions([q]) > 0) {
      notifyPet('game_ui_refresh', { gameUi: publicGameUi() });
    }
    return;
  }
  if (session.phase === 'generating') {
    lateOpeningBuffer.push(q);
  }
}

function startBackfillIfNeeded() {
  if (session.phase !== 'asking') return;
  if (session.openingBusy) {
    session.backfilling = true;
    return;
  }
  if (session.questions.length >= MAX_QUESTIONS) {
    session.backfilling = false;
    if (session.index >= session.questions.length && session.lives > 0) {
      endRunAndCancelBackfill(null);
      notifyPet('game_ui_refresh', { gameUi: publicGameUi() });
      notifyPet('game_play_end');
      return;
    }
    notifyPet('game_ui_refresh', { gameUi: publicGameUi() });
    return;
  }
  if (session.backfillStarted) return;
  session.backfillStarted = true;
  session.backfilling = true;
  const token = ++backfillToken;
  void backfillQuestions('', token);
}

async function backfillQuestions(corpus, token) {
  const finish = () => {
    if (token !== backfillToken) return;
    session.backfilling = false;
    // 补题结束且用户已答完当前全部题：这时才通关
    if (
      session.phase === 'asking' &&
      session.index >= session.questions.length &&
      session.lives > 0
    ) {
      endRunAndCancelBackfill(null);
      notifyPet('game_ui_refresh', { gameUi: publicGameUi() });
      notifyPet('game_play_end');
      return;
    }
    notifyPet('game_ui_refresh', { gameUi: publicGameUi() });
  };

  try {
    let idleRounds = 0;
    let failRounds = 0;
    while (session.questions.length < MAX_QUESTIONS) {
      if (token !== backfillToken) return;
      if (session.phase !== 'asking') return;

      const need = MAX_QUESTIONS - session.questions.length;
      if (need <= 0) break;

      let more = [];
      try {
        const batchN = Math.min(need, 2);
        const chunks = takeQuizChunks(session.chunkQueue || [], batchN);
        if (chunks.length) {
          more = await requestParallelFromChunks(
            chunks,
            session.questions.slice(),
            { want: chunks.length, abortRest: true }
          );
        } else {
          more = await requestQuestions({
            maxQuestions: 1,
            existing: session.questions.slice(),
          });
        }
      } catch (err) {
        failRounds += 1;
        console.warn('[bili-pet] game backfill slot failed:', err?.message || err);
        if (failRounds >= 2) break;
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      if (token !== backfillToken) return;
      if (session.phase !== 'asking') return;

      failRounds = 0;
      const added = appendUniqueQuestions(more);
      if (added > 0) {
        idleRounds = 0;
        notifyPet('game_ui_refresh', { gameUi: publicGameUi() });
      } else {
        idleRounds += 1;
        if (idleRounds >= 2) break;
      }
    }
    finish();
  } catch (err) {
    console.warn('[bili-pet] game backfill failed:', err?.message || err);
    finish();
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
  session.backfillStarted = false;
  session.openingBusy = false;
  session.targetTotal = MAX_QUESTIONS;
  session.chunkQueue = [];
  lateOpeningBuffer = [];
  openingToken += 1;
  notifyPet('game_generating');

  const chunkPool = collectQuizChunks(session.scope);

  const startAsking = (message) => {
    const ready = session.questions.length;
    session.phase = 'asking';
    session.backfilling = ready < MAX_QUESTIONS || session.openingBusy;
    session.targetTotal = MAX_QUESTIONS;
    notifyPet('game_generating_end');
    notifyPet('game_play_start');
    appendUniqueQuestions(consumeLateOpening());
    startBackfillIfNeeded();
    return {
      handled: true,
      ok: true,
      game: true,
      gameUi: publicGameUi(),
      message,
    };
  };

  try {
    const opening = await fillOpeningFromChunks(chunkPool, []);
    session.questions = [];
    appendUniqueQuestions(opening);
    session.chunkQueue = chunkPool;

    // 并行已拿到题就开打，缺的后台补
    if (!session.questions.length) {
      const corpus = buildCorpus(session.scope, {
        charLimit: CORPUS_FIRST_PACK_LIMIT,
        maxNotes: CORPUS_MAX_NOTES,
      });
      if (corpus.trim()) {
        try {
          const more = await requestQuestions({
            maxQuestions: 1,
            corpus,
            existing: [],
            attempts: 1,
          });
          appendUniqueQuestions(more);
        } catch (err) {
          console.warn('[bili-pet] game quiz fallback failed:', err?.message || err);
        }
      }
    }

    if (!session.questions.length) {
      session.phase = 'awaiting_scope';
      notifyPet('game_generating_end');
      return {
        handled: true,
        ok: false,
        game: true,
        message: '出题失败：没有可用题目。换个范围或再试一次。',
      };
    }

    const ready = session.questions.length;
    return startAsking(
      ready >= MAX_QUESTIONS
        ? `开始答题：${session.scope.label}（共 ${ready} 题，3 条命）\n中途退出：⌘S+G。`
        : `开始答题：${session.scope.label}（先 ${ready} 题，后台补到 ${MAX_QUESTIONS}；3 条命）\n中途退出：⌘S+G。`
    );
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

  const finishAsEnded = (correct, feedback) => {
    const total = session.questions.length;
    const won = session.lives > 0 && session.index >= total && total > 0;
    const endMessage = won
      ? `通关！答对 ${session.correctCount}/${total}。范围：${session.scope?.label || ''}`
      : `GAME OVER。答对 ${session.correctCount}/${total}，命尽。`;
    return {
      ok: true,
      correct,
      feedback: String(feedback || '').trim(),
      gameUi: publicGameUi(),
      autoClose: true,
      endMessage,
      won,
    };
  };

  const current = session.questions[session.index];
  if (!current) {
    if (stillExpectingMoreQuestions()) {
      return {
        ok: true,
        correct: false,
        feedback: '',
        waitingMore: true,
        gameUi: publicGameUi({ waitingMore: true }),
      };
    }
    endRunAndCancelBackfill(null);
    return finishAsEnded(false, '');
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
    endRunAndCancelBackfill(null);
    return finishAsEnded(correct, feedback);
  }

  session.index += 1;
  if (session.index >= session.questions.length) {
    if (stillExpectingMoreQuestions()) {
      return {
        ok: true,
        correct,
        feedback: feedback.trim(),
        waitingMore: true,
        gameUi: publicGameUi({ waitingMore: true }),
      };
    }
    endRunAndCancelBackfill(null);
    return finishAsEnded(correct, feedback);
  }

  return {
    ok: true,
    correct,
    feedback: feedback.trim(),
    gameUi: publicGameUi(),
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
        '答题模式已开启。想考哪一块？可以说课程组、文件夹、当前视频，或一个考点。\n例如：/game 考一下线代 · 高数的积分 · 反向传播\n选好范围后会自动出题；中途退出请按 ⌘S+G。',
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
