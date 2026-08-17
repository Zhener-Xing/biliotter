const { completeTask } = require('./llm');
const {
  listCourseGroups,
  getCourseGroup,
  createCourseGroup,
  createCourseFolder,
  addCourseGroupItem,
  updateCourseGroupItem,
  listNoteDocs,
  searchNotes,
  loadNoteDoc,
  normalizeBvid,
} = require('./notes-db');

let lastCourseContext = {
  groupId: null,
  groupTitle: null,
  folderId: null,
  folderTitle: null,
};

let pendingConfirm = null;

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》【】\[\]（）()·.•]/g, '')
    .replace(/课程组$/g, '');
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

function findBestByTitle(list, title, getTitle) {
  const q = String(title || '').trim();
  if (!q || !Array.isArray(list) || !list.length) return null;
  let best = null;
  let bestScore = 0;
  for (const item of list) {
    const score = scoreName(q, getTitle(item));
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (bestScore < 50) return null;
  return { item: best, score: bestScore };
}

function looksLikeCourseAction(question) {
  const q = String(question || '').trim();
  if (!q) return false;
  if (isAffirmative(q) && pendingConfirm) return true;
  if (isNegative(q) && pendingConfirm) return true;
  if (/稍后再看|待看|晚点看|我的收藏|收藏夹/.test(q) && !/课程组|文件夹/.test(q)) {
    return false;
  }
  if (/笔记/.test(q) && /放进|放到|加入|加到|保存到|保存进/.test(q) && /课程组|文件夹/.test(q)) {
    return true;
  }
  if (/课程组|文件夹/.test(q)) {
    return /新建|创建|建立|建个|建一个|建一下|加个|加入|放进|放到|加到|在里面|其中|下面|底下|里建|下建|帮我建|帮我创建/.test(
      q
    );
  }
  return /新建.*课|创建.*课|建个.*课|建一个.*课|建一下.*课|建立.*课/.test(q);
}

function mentionsVideoMove(question) {
  const q = String(question || '').trim();
  return /视频|笔记|放进|放到|加入|加进|放进去|保存到|保存进|加到/.test(q);
}

function isAffirmative(q) {
  const s = String(q || '').trim();
  if (s.length > 12) return false;
  return (
    /^(好的?|可以|行|是的?|对|嗯|要|创建|建|建立|新建|确认|ok|yes|y)([！!。.~～]?)$/i.test(
      s
    ) || /^(好的?|可以|行|是的?)[，, ]*(创建|建|建立|新建|吧)?$/.test(s)
  );
}

function isNegative(q) {
  const s = String(q || '').trim();
  if (s.length > 12) return false;
  return /^(不|不要|不用|算了|取消|no|n)([！!。.]?)$/i.test(s);
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

function formatCourseCatalog(groups) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return '（当前没有任何课程组）';
  return list
    .map((g, i) => {
      const detail = getCourseGroup(g.id);
      const folders = (detail?.folders || [])
        .map((f) => f.title)
        .filter(Boolean);
      const folderPart = folders.length
        ? `；文件夹：${folders.join('、')}`
        : '；尚无文件夹';
      return `${i + 1}. 「${g.title}」${g.topic ? `（主题：${g.topic}）` : ''} · ${g.itemCount || 0} 个视频${folderPart}`;
    })
    .join('\n');
}

function stripCourseSuffix(name) {
  return String(name || '')
    .trim()
    .replace(/课程组$/u, '')
    .trim();
}

function stripNoteSuffix(name) {
  return String(name || '')
    .trim()
    .replace(/^(把|将)/, '')
    .replace(/[「」『』“”"']/g, '')
    .replace(/这几篇$/u, '')
    .replace(/几篇$/u, '')
    .replace(/(这篇)?笔记$/u, '')
    .replace(/(这个|当前|本篇)?(视频|笔记)$/u, '')
    .trim();
}

/** 把「线性代数、积分和极限」或「A笔记和B笔记」拆成多标题 */
function splitNoteTitles(raw) {
  let s = String(raw || '').trim();
  if (!s) return [];
  const hadBatchHint = /这几篇|几篇/.test(s);
  s = s
    .replace(/^把|^将/, '')
    .replace(/这几篇$/u, '')
    .replace(/几篇$/u, '')
    .trim();

  let parts;
  if (/笔记\s*[、，,和与及]/.test(s) || /[、，,和与及]\s*[^、，,和与及]+笔记/.test(s)) {
    parts = s.split(/\s*(?:笔记)?\s*[、，,和与及/]+\s*/);
  } else if (/[、，,/]/.test(s)) {
    parts = s.split(/\s*[、，,/]\s*/).flatMap((p) =>
      /[和与及]/.test(p) ? String(p).split(/\s*[和与及]\s*/) : [p]
    );
  } else if (hadBatchHint && /[和与及]/.test(s)) {
    parts = s.split(/\s*[和与及]\s*/);
  } else {
    parts = [s];
  }

  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const t = stripNoteSuffix(p) || String(p || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function collectNoteQueries(intent = {}) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const parts = splitNoteTitles(raw);
    if (parts.length) {
      for (const t of parts) {
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
      return;
    }
    const single = stripNoteSuffix(raw) || String(raw || '').trim();
    if (!single || seen.has(single)) return;
    seen.add(single);
    out.push(single);
  };
  if (Array.isArray(intent.noteTitles)) {
    for (const t of intent.noteTitles) push(t);
  }
  if (intent.noteTitle) push(intent.noteTitle);
  if (intent.noteQuery) push(intent.noteQuery);
  return out;
}

function resolveManyNotes(queries, fallbackMeta = {}) {
  const list = Array.isArray(queries) ? queries.filter(Boolean) : [];
  if (!list.length) {
    const one = resolveNoteTarget('', fallbackMeta);
    if (one.ok) return { ok: true, notes: [one], failures: [] };
    return { ok: false, notes: [], failures: [{ query: '', resolved: one }] };
  }
  const notes = [];
  const failures = [];
  const seenBvid = new Set();
  for (const q of list) {
    const r = resolveNoteTarget(q, fallbackMeta);
    if (!r.ok) {
      failures.push({ query: q, resolved: r });
      continue;
    }
    const id = String(r.bvid || '').trim();
    if (id && seenBvid.has(id)) continue;
    if (id) seenBvid.add(id);
    notes.push({ ...r, query: q });
  }
  return { ok: notes.length > 0, notes, failures };
}

function formatNoteResolveFailures(failures) {
  if (!failures?.length) return '';
  return failures
    .map((f) => noteResolveErrorMessage(f.resolved) || `没找到「${f.query}」`)
    .join(' ');
}

function addResolvedNotesToGroup(groupId, notes, folderId = null) {
  let ok = 0;
  let fail = 0;
  const failNames = [];
  const okNames = [];
  for (const n of notes || []) {
    const added = ensureItemInGroup(groupId, {
      bvid: n.bvid,
      title: n.title,
      folderId,
    });
    if (added.ok) {
      ok += 1;
      okNames.push(n.title || n.bvid);
    } else {
      fail += 1;
      failNames.push(n.title || n.bvid || n.query || '');
    }
  }
  return { ok, fail, failNames, okNames };
}

function formatBatchAddMessage({
  groupTitle,
  folderPart,
  okNames,
  failNames,
  resolveFailures,
  prefix = '',
}) {
  const parts = [];
  if (prefix) parts.push(prefix);
  if (okNames.length === 1) {
    parts.push(
      `已把笔记「${okNames[0]}」加入课程组「${groupTitle}」${folderPart || ''}`
    );
  } else if (okNames.length > 1) {
    const preview =
      okNames.length <= 3
        ? okNames.map((n) => `「${n}」`).join('、')
        : okNames
            .slice(0, 3)
            .map((n) => `「${n}」`)
            .join('、') + ` 等 ${okNames.length} 篇`;
    parts.push(
      `已把 ${okNames.length} 篇笔记（${preview}）加入课程组「${groupTitle}」${folderPart || ''}`
    );
  }
  if (failNames.length) {
    parts.push(`未能加入：${failNames.map((n) => `「${n}」`).join('、')}`);
  }
  if (resolveFailures?.length) {
    parts.push(formatNoteResolveFailures(resolveFailures));
  }
  const body = parts.filter(Boolean).join('。').replace(/。{2,}/g, '。');
  if (!body) return '';
  return /[。！？]$/.test(body) ? body : `${body}。`;
}

function resolveNoteTarget(noteQuery, fallbackMeta = {}) {
  const raw = String(noteQuery || '').trim();
  if (!raw || /^(这个|当前|本篇|正在看的?)(视频|笔记)?$/u.test(raw)) {
    const bvid = normalizeBvid(fallbackMeta.bvid) || String(fallbackMeta.bvid || '').trim();
    if (bvid) {
      return {
        ok: true,
        bvid,
        title: String(fallbackMeta.title || '').trim() || bvid,
        from: 'current',
      };
    }
    return { ok: false, error: 'no_current' };
  }

  const q = stripNoteSuffix(raw) || raw;
  const asBv = normalizeBvid(q) || (/^BV[\w]+/i.test(q) ? q : '');
  if (asBv) {
    const doc = loadNoteDoc(asBv);
    if (doc) {
      return {
        ok: true,
        bvid: doc.bvid || asBv,
        title: doc.title || asBv,
        from: 'bvid',
      };
    }
    return { ok: false, error: 'not_found', query: asBv };
  }

  const notes = listNoteDocs();
  const hit = findBestByTitle(notes, q, (n) => n.title);
  if (hit && hit.score >= 55) {
    return {
      ok: true,
      bvid: hit.item.bvid,
      title: hit.item.title,
      score: hit.score,
      from: 'title',
    };
  }

  const searched = searchNotes(q, { limit: 8 });
  const found = Array.isArray(searched?.notes) ? searched.notes : [];
  if (found.length === 1) {
    return {
      ok: true,
      bvid: found[0].bvid,
      title: found[0].title,
      from: 'search',
    };
  }
  if (found.length > 1) {
    const ranked = found
      .map((n) => ({ note: n, score: scoreName(q, n.title) }))
      .sort((a, b) => b.score - a.score);
    if (ranked[0].score >= 70 && ranked[0].score - (ranked[1]?.score || 0) >= 15) {
      return {
        ok: true,
        bvid: ranked[0].note.bvid,
        title: ranked[0].note.title,
        score: ranked[0].score,
        from: 'search',
      };
    }
    return {
      ok: false,
      error: 'ambiguous',
      query: q,
      candidates: ranked.slice(0, 5).map((x) => x.note),
    };
  }

  return { ok: false, error: 'not_found', query: q };
}

function findFolderAcrossGroups(folderTitle) {
  const name = String(folderTitle || '').trim();
  if (!name) return null;
  let best = null;
  for (const g of listCourseGroups()) {
    const detail = getCourseGroup(g.id) || g;
    const hit = findBestByTitle(detail.folders || [], name, (f) => f.title);
    if (!hit) continue;
    if (!best || hit.score > best.score) {
      best = {
        group: detail,
        folder: hit.item,
        score: hit.score,
      };
    }
  }
  return best && best.score >= 50 ? best : null;
}

function noteResolveErrorMessage(resolved) {
  if (!resolved || resolved.ok) return '';
  if (resolved.error === 'ambiguous') {
    const names = (resolved.candidates || [])
      .map((n) => `「${n.title || n.bvid}」`)
      .join('、');
    return `找到多篇和「${resolved.query}」相近的笔记：${names}。请说得更具体一点，或带上 BV 号。`;
  }
  if (resolved.error === 'not_found') {
    return `知识库里没找到「${resolved.query || '这篇'}」笔记。可以换个标题关键词，或先打开对应视频。`;
  }
  if (resolved.error === 'no_current') {
    return '请指明笔记名字，例如「把线性代数笔记放进线代课程组」，或先打开对应视频。';
  }
  return '没能定位到要操作的笔记，请再说一次笔记标题。';
}

function heuristicParseIntent(question, { recentGroupTitle } = {}) {
  const q = String(question || '').trim();
  if (!q) return null;

  const recent = String(recentGroupTitle || lastCourseContext.groupTitle || '').trim();
  const withVideo = mentionsVideoMove(q);

  const normalizeGroupTitle = (raw) => {
    let t = String(raw || '').trim();
    t = t.replace(/^(到|至|进|入|叫|名为|一个)/, '');
    t = stripCourseSuffix(t);
    if (!t) return '';
    return /课程组$/.test(t) ? t : `${t}课程组`;
  };

  const normalizeFolderTitle = (raw) =>
    String(raw || '')
      .trim()
      .replace(/^(叫|名为|一个|文件夹)/, '')
      .replace(/(文件夹|目录)$/u, '')
      .replace(/[下里中]$/u, '')
      .trim();

  // 把「xx」笔记放进课程组 / 文件夹（支持「A、B、C这几篇笔记」）
  let m =
    q.match(
      /(?:把|将)?[「『""]?(.+?)[」』""]?(?:这篇|这几篇)?笔记(?:放进|放到|加入|加到|保存到|保存进)(.+?)课程组(?:的|里的|下的|里|下)?(.+?)文件夹/
    ) ||
    q.match(
      /(?:把|将)(.+?)(?:这篇|这几篇)?笔记(?:放进|放到|加入|加到|保存到|保存进)(.+?)课程组(?:的|里的|下的|里|下)?(.+?)文件夹/
    );
  if (m) {
    const titles = splitNoteTitles(m[1]);
    return {
      action: 'add_to_group',
      noteTitle: titles[0] || stripNoteSuffix(m[1]),
      noteTitles: titles,
      groupTitle: normalizeGroupTitle(m[2]),
      folderTitle: normalizeFolderTitle(m[3]),
      topic: '',
      createFolderIfMissing: true,
      confidence: 0.94,
      source: 'heuristic',
    };
  }

  m =
    q.match(
      /(?:把|将)?[「『""]?(.+?)[」』""]?(?:这篇|这几篇)?笔记(?:放进|放到|加入|加到|保存到|保存进)(.+?)课程组/
    ) ||
    q.match(
      /(?:把|将)(.+?)(?:这篇|这几篇)?笔记(?:放进|放到|加入|加到|保存到|保存进)(.+?)课程组/
    );
  if (m) {
    const titles = splitNoteTitles(m[1]);
    return {
      action: 'add_to_group',
      noteTitle: titles[0] || stripNoteSuffix(m[1]),
      noteTitles: titles,
      groupTitle: normalizeGroupTitle(m[2]),
      folderTitle: '',
      topic: '',
      createFolderIfMissing: false,
      confidence: 0.93,
      source: 'heuristic',
    };
  }

  m =
    q.match(
      /(?:把|将)?[「『""]?(.+?)[」』""]?(?:这篇|这几篇)?笔记(?:放进|放到|加入|加到|保存到|保存进)(.+?)文件夹/
    ) ||
    q.match(
      /(?:把|将)(.+?)(?:这篇|这几篇)?笔记(?:放进|放到|加入|加到|保存到|保存进)(.+?)文件夹/
    );
  if (m) {
    const titles = splitNoteTitles(m[1]);
    return {
      action: 'add_to_group',
      noteTitle: titles[0] || stripNoteSuffix(m[1]),
      noteTitles: titles,
      groupTitle: recent || '',
      folderTitle: normalizeFolderTitle(m[2]),
      topic: '',
      createFolderIfMissing: true,
      confidence: recent ? 0.9 : 0.78,
      source: 'heuristic',
    };
  }

  // 在「某课程组」下/里 建文件夹
  m =
    q.match(
      /在(.+?)课程组(?:里|中|下|下面|底下)?(?:再)?(?:新建|创建|建立|建一个|建个|加一个|加个)(?:一个)?(?:文件夹(?:叫|名为)?)?(.+?)(?:文件夹)?$/
    ) ||
    q.match(
      /在(.+?)(?:里|中|下|下面|底下)(?:再)?(?:新建|创建|建立|建一个|建个|加一个|加个)(?:一个)?(?:文件夹(?:叫|名为)?)?(.+?)文件夹/
    ) ||
    q.match(
      /(?:给|为)(.+?)课程组(?:再)?(?:新建|创建|建立|建一个|建个|加一个|加个)(?:一个)?(?:文件夹(?:叫|名为)?)?(.+?)(?:文件夹)?$/
    );
  if (m) {
    const groupTitle = normalizeGroupTitle(m[1]);
    const folderTitle = normalizeFolderTitle(m[2]);
    if (groupTitle && folderTitle) {
      return {
        action: withVideo ? 'create_folder_and_add' : 'create_folder',
        groupTitle,
        folderTitle,
        topic: '',
        createFolderIfMissing: true,
        confidence: 0.93,
        source: 'heuristic',
      };
    }
  }

  // 新建课程组（可附带文件夹）
  m =
    q.match(/(?:新建|创建|建立|建一个|建个|帮我建|帮我创建)(?:一个)?(?:叫|名为)?(.+?)课程组/) ||
    q.match(/课程组(?:名叫|叫|名为)(.+?)(?:$|[，,。！!\s])/);
  if (m) {
    const groupTitle = normalizeGroupTitle(m[1]);
    const rest = q.slice((m.index || 0) + m[0].length);
    const folderM = rest.match(
      /(?:，|,|。|；|;|和|并|同时)?(?:再)?(?:在)?(?:下面|底下|其中|里面)?(?:再)?(?:新建|创建|建立|建一个|建个)?(?:一个)?([A-Za-z0-9_-]+|[\u4e00-\u9fff]{1,16})文件夹/
    );
    return {
      action: withVideo ? 'create_group_and_add' : 'create_group',
      groupTitle,
      folderTitle: folderM ? normalizeFolderTitle(folderM[1]) : '',
      topic: '',
      createFolderIfMissing: true,
      confidence: 0.92,
      source: 'heuristic',
    };
  }

  // 在里面 / 该课程组 创建文件夹
  m =
    q.match(/在里面(?:再)?(?:新建|创建|建立|建一个|建个|加一个|加个)(?:一个)?(.+?)(?:文件夹)?$/) ||
    q.match(
      /在(?:其中|该课程组|这个课程组|刚才(?:的)?课程组)(?:里|中|下)?(?:再)?(?:新建|创建|建立|建一个|建个|加一个|加个)(?:一个)?(.+?)(?:文件夹)?$/
    ) ||
    q.match(/(?:新建|创建|建立|建一个|建个|加一个|加个)(?:一个)?(.+?)文件夹/);
  if (m) {
    const folderTitle = normalizeFolderTitle(m[1]);
    const hasRef = /在里面|其中|该课程组|这个课程组|刚才/.test(q);
    if (folderTitle && (recent || hasRef || /文件夹/.test(q))) {
      if (!recent && !hasRef && !/在里面|其中|该课程组|这个课程组/.test(q)) {
        // 「创建 XX 文件夹」但无上下文：仍尝试用 recent；没有则低置信度交给 LLM/追问
        if (!recent) {
          return {
            action: withVideo ? 'create_folder_and_add' : 'create_folder',
            groupTitle: '',
            folderTitle,
            topic: '',
            createFolderIfMissing: true,
            confidence: 0.62,
            source: 'heuristic',
          };
        }
      }
      return {
        action: withVideo ? 'create_folder_and_add' : 'create_folder',
        groupTitle: recent || '',
        folderTitle,
        topic: '',
        createFolderIfMissing: true,
        confidence: recent || hasRef ? 0.92 : 0.7,
        source: 'heuristic',
      };
    }
  }

  m = q.match(/在(.+?)课程组(?:里|中)?(?:再)?创建(?:一个)?(.+?)文件夹/);
  if (m) {
    return {
      action: withVideo ? 'create_folder_and_add' : 'create_folder',
      groupTitle: normalizeGroupTitle(m[1]),
      folderTitle: normalizeFolderTitle(m[2]),
      topic: '',
      createFolderIfMissing: true,
      confidence: 0.92,
      source: 'heuristic',
    };
  }

  m =
    q.match(/(?:保存|加入|放)到(.+?)课程组(?:的|里的|下的|里|下)?(.+?)文件夹/) ||
    q.match(
      /(?:把|将).*(?:笔记|视频).*(?:保存|加入|放)到(.+?)课程组(?:的|里的|下的|里|下)?(.+?)文件夹/
    );
  if (m) {
    return {
      action: 'add_to_group',
      groupTitle: normalizeGroupTitle(m[1]),
      folderTitle: normalizeFolderTitle(m[2]),
      topic: '',
      createFolderIfMissing: false,
      confidence: 0.9,
      source: 'heuristic',
    };
  }

  m = q.match(/(?:加入|放进|放到|加到)(.+?)课程组(?!.*文件夹)/);
  if (m) {
    return {
      action: 'add_to_group',
      groupTitle: normalizeGroupTitle(m[1]),
      folderTitle: '',
      topic: '',
      createFolderIfMissing: false,
      confidence: 0.84,
      source: 'heuristic',
    };
  }

  return null;
}

function extractRecentGroupFromHistory(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    const text = String(msg?.content || '');
    const m =
      text.match(/课程组「([^」]+)」/) ||
      text.match(/新建课程组「([^」]+)」/) ||
      text.match(/已新建课程组「([^」]+)」/);
    if (m) return m[1];
  }
  return lastCourseContext.groupTitle || '';
}

async function parseCourseActionIntent(question, { bvid, title, history } = {}) {
  const groups = listCourseGroups();
  const recentGroupTitle = extractRecentGroupFromHistory(history);
  const heuristic = heuristicParseIntent(question, { recentGroupTitle });
  const noteDocs = listNoteDocs().slice(0, 40);

  const payload = {
    userMessage: String(question || '').trim(),
    recentCourseGroup: recentGroupTitle || null,
    dialogueHint:
      '若用户说「在里面」「该课程组」「其中」，指代 recentCourseGroup；若把「某笔记」或「A、B、C这几篇笔记」放进课程组/文件夹，填写 noteTitle / noteTitles；若为空再看已有课程组与笔记列表。',
    currentVideo: {
      bvid: bvid || null,
      title: title || null,
    },
    existingNotes: noteDocs.map((n) => ({
      bvid: n.bvid,
      title: n.title,
    })),
    existingCourseGroups: groups.map((g) => ({
      id: g.id,
      title: g.title,
      topic: g.topic,
      itemCount: g.itemCount,
      folderCount: g.folderCount,
    })),
    catalogText: formatCourseCatalog(groups),
  };

  let obj = null;
  try {
    const raw = await completeTask('course_action', payload, {
      max_tokens: 400,
      jsonMode: true,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 20000,
    });
    obj = parseJsonObject(raw);
  } catch (err) {
    console.warn('[bili-pet] course intent LLM failed:', err.message || err);
    obj = null;
  }

  if (!obj || typeof obj !== 'object') {
    return heuristic || { action: 'none', confidence: 0, source: 'fallback' };
  }

  const action = String(obj.action || 'none').trim();
  const allowed = new Set([
    'none',
    'create_group',
    'create_folder',
    'add_to_group',
    'create_folder_and_add',
    'create_group_and_add',
  ]);
  const llmIntent = {
    action: allowed.has(action) ? action : 'none',
    groupTitle: String(obj.groupTitle || '').trim(),
    folderTitle: String(obj.folderTitle || '').trim(),
    noteTitle: String(obj.noteTitle || obj.noteQuery || '').trim(),
    noteTitles: Array.isArray(obj.noteTitles)
      ? obj.noteTitles.map((t) => String(t || '').trim()).filter(Boolean)
      : [],
    topic: String(obj.topic || '').trim(),
    createFolderIfMissing: Boolean(obj.createFolderIfMissing),
    confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0)),
    source: 'llm',
  };

  if (!llmIntent.noteTitles.length && llmIntent.noteTitle) {
    llmIntent.noteTitles = splitNoteTitles(llmIntent.noteTitle);
  }
  if (llmIntent.noteTitles.length && !llmIntent.noteTitle) {
    llmIntent.noteTitle = llmIntent.noteTitles[0];
  }
  const hasNamedNotes = Boolean(
    llmIntent.noteTitle || (llmIntent.noteTitles && llmIntent.noteTitles.length)
  );

  if (
    (!llmIntent.groupTitle || /里面|其中|该课程组|这个课程组|刚才/.test(question)) &&
    recentGroupTitle &&
    (llmIntent.action === 'create_folder' ||
      llmIntent.action === 'create_folder_and_add' ||
      llmIntent.action === 'add_to_group')
  ) {
    llmIntent.groupTitle = llmIntent.groupTitle || recentGroupTitle;
    llmIntent.confidence = Math.max(llmIntent.confidence, 0.8);
  }

  // 点名某笔记时，一定按「加入」处理，不要降成只建结构
  if (hasNamedNotes && llmIntent.action === 'create_folder') {
    llmIntent.action = 'add_to_group';
    llmIntent.createFolderIfMissing = true;
  }
  if (hasNamedNotes && llmIntent.action === 'create_group') {
    llmIntent.action = 'create_group_and_add';
  }

  // 用户没提放视频/笔记时，把 *_and_add 降为纯创建
  if (
    !mentionsVideoMove(question) &&
    !hasNamedNotes &&
    (llmIntent.action === 'create_group_and_add' ||
      llmIntent.action === 'create_folder_and_add')
  ) {
    llmIntent.action =
      llmIntent.action === 'create_group_and_add' ? 'create_group' : 'create_folder';
  }

  if (llmIntent.action === 'none' || llmIntent.confidence < 0.55) {
    if (heuristic && heuristic.confidence >= 0.62) return heuristic;
  }
  if (
    heuristic &&
    heuristic.confidence >= 0.85 &&
    (llmIntent.confidence < heuristic.confidence ||
      ((heuristic.noteTitle || heuristic.noteTitles?.length) && !hasNamedNotes))
  ) {
    return heuristic;
  }

  return llmIntent;
}

function ensureItemInGroup(groupId, { bvid, title, folderId = null }) {
  const add = addCourseGroupItem(groupId, { bvid, title, folderId });
  if (add.ok) return add;
  if (add.error === 'already_in_group') {
    return updateCourseGroupItem(groupId, bvid, {
      folderId,
      title: title || undefined,
    });
  }
  return add;
}

function resolveOrCreateFolder(groupId, folderTitle, { createIfMissing }) {
  const name = String(folderTitle || '').trim();
  if (!name) return { ok: true, folderId: null };

  const group = getCourseGroup(groupId);
  if (!group) return { ok: false, error: 'not_found' };

  const hit = findBestByTitle(group.folders || [], name, (f) => f.title);
  if (hit) return { ok: true, folderId: hit.item.id, folderTitle: hit.item.title };

  if (!createIfMissing) {
    return { ok: false, error: 'folder_not_found', folderTitle: name };
  }

  const created = createCourseFolder(groupId, { title: name });
  if (!created.ok) return created;
  return {
    ok: true,
    folderId: created.folderId,
    folderTitle: name,
    created: true,
  };
}

function rememberCourse(group, folderTitle, folderId) {
  if (!group) return;
  lastCourseContext = {
    groupId: group.id,
    groupTitle: group.title,
    folderId: folderId || null,
    folderTitle: folderTitle || null,
  };
}

function askConfirm(message, nextIntent, videoMeta) {
  pendingConfirm = {
    intent: nextIntent,
    videoMeta: {
      bvid: videoMeta?.bvid || null,
      title: videoMeta?.title || '',
    },
    askedAt: Date.now(),
  };
  return {
    handled: true,
    ok: true,
    needsConfirm: true,
    message,
  };
}

function clearPending() {
  pendingConfirm = null;
}

function executeCourseAction(intent, videoMeta = {}, { forceCreate = false } = {}) {
  let action = intent?.action || 'none';
  if (action === 'none') {
    return { handled: false };
  }

  const noteQueries = collectNoteQueries(intent);
  const noteQuery = noteQueries[0] || String(intent.noteTitle || intent.noteQuery || '').trim();
  const wantsNotes =
    noteQueries.length > 0 ||
    action === 'add_to_group' ||
    action === 'create_group_and_add' ||
    action === 'create_folder_and_add';

  let workingMeta = {
    bvid: videoMeta?.bvid || null,
    title: String(videoMeta?.title || '').trim(),
  };
  let notesToAdd = [];
  let resolveFailures = [];

  if (wantsNotes) {
    const batch = resolveManyNotes(noteQueries, workingMeta);
    notesToAdd = batch.notes;
    resolveFailures = batch.failures || [];
    if (!notesToAdd.length) {
      return {
        handled: true,
        ok: false,
        message:
          formatNoteResolveFailures(resolveFailures) ||
          '要把笔记/视频加进课程组，请写明笔记名（如「把线性代数、积分笔记放进线代课程组」），或先打开对应视频。',
      };
    }
    workingMeta = {
      bvid: notesToAdd[0].bvid,
      title: notesToAdd[0].title,
    };
  }

  const key =
    normalizeBvid(workingMeta.bvid) || String(workingMeta.bvid || '').trim();
  const videoTitle = String(workingMeta.title || '').trim();
  videoMeta = workingMeta;
  const addVideo = notesToAdd.length > 0;
  const noteTitlesForConfirm = notesToAdd.map((n) => n.query || n.title).filter(Boolean);

  if (action === 'add_to_group' && !addVideo) {
    return {
      handled: true,
      ok: false,
      message:
        '要把笔记/视频加进课程组，请写明笔记名（如「把线性代数笔记放进线代课程组」），或先打开对应视频。',
    };
  }

  // —— 新建课程组（可顺带建文件夹；有目标笔记/视频时再放入）——
  if (action === 'create_group' || action === 'create_group_and_add') {
    let groupTitle =
      String(intent.groupTitle || '').trim() ||
      (videoTitle ? `${videoTitle.slice(0, 24)}` : '');
    if (!groupTitle) {
      return {
        handled: true,
        ok: false,
        message: '请告诉我课程组名字，例如「新建线性代数课程组」。',
      };
    }
    if (!/课程组$/.test(groupTitle)) groupTitle += '课程组';

    const existing = findBestByTitle(listCourseGroups(), groupTitle, (g) => g.title);
    if (existing && existing.score >= 80) {
      const next = {
        ...intent,
        noteTitle: noteQuery || intent.noteTitle || '',
        noteTitles: noteTitlesForConfirm.length
          ? noteTitlesForConfirm
          : intent.noteTitles || noteQueries,
        action: intent.folderTitle
          ? addVideo
            ? 'create_folder_and_add'
            : 'create_folder'
          : addVideo
            ? 'add_to_group'
            : 'create_folder',
        groupTitle: existing.item.title,
        createFolderIfMissing: Boolean(intent.folderTitle) || forceCreate,
      };
      // 已有同名组且只想建组：直接说明已存在
      if (!intent.folderTitle && !addVideo) {
        rememberCourse(existing.item);
        return {
          handled: true,
          ok: true,
          message: `课程组「${existing.item.title}」已经存在，不用重复创建。可以说「在里面创建某某文件夹」。`,
        };
      }
      if (!intent.folderTitle && addVideo) {
        next.action = 'add_to_group';
      }
      return executeCourseAction(next, videoMeta, { forceCreate });
    }

    const created = createCourseGroup({
      title: groupTitle,
      topic: String(intent.topic || '').trim(),
    });
    if (!created.ok || !created.group) {
      return {
        handled: true,
        ok: false,
        message: `没能创建课程组「${groupTitle}」，请稍后再试。`,
      };
    }

    let folderId = null;
    let folderTitle = '';
    const wantFolder = String(intent.folderTitle || '').trim();
    if (wantFolder) {
      const folder = resolveOrCreateFolder(created.group.id, wantFolder, {
        createIfMissing: true,
      });
      if (!folder.ok) {
        rememberCourse(created.group);
        return {
          handled: true,
          ok: false,
          message: `课程组「${groupTitle}」已创建，但文件夹「${wantFolder}」没建成功，可以说「在里面创建${wantFolder}文件夹」。`,
        };
      }
      folderId = folder.folderId;
      folderTitle = folder.folderTitle || wantFolder;
    }

    rememberCourse(created.group, folderTitle, folderId);
    clearPending();

    if (addVideo) {
      const result = addResolvedNotesToGroup(created.group.id, notesToAdd, folderId);
      const where = folderTitle ? `，放到文件夹「${folderTitle}」` : '，放在课程组下';
      const prefix = `好的，已新建课程组「${groupTitle}」${folderTitle ? `，文件夹「${folderTitle}」也建好了` : ''}`;
      if (!result.ok) {
        return {
          handled: true,
          ok: false,
          message: formatBatchAddMessage({
            groupTitle,
            folderPart: where,
            okNames: result.okNames,
            failNames: result.failNames,
            resolveFailures,
            prefix,
          }) || `${prefix}，但笔记没加进去。`,
        };
      }
      return {
        handled: true,
        ok: true,
        message: formatBatchAddMessage({
          groupTitle,
          folderPart: where,
          okNames: result.okNames,
          failNames: result.failNames,
          resolveFailures,
          prefix,
        }),
      };
    }

    if (folderTitle) {
      return {
        handled: true,
        ok: true,
        message: `好的，已新建课程组「${groupTitle}」，并在其下创建文件夹「${folderTitle}」。`,
      };
    }
    return {
      handled: true,
      ok: true,
      message: `好的，已新建课程组「${groupTitle}」。可以说「在里面创建某某文件夹」继续整理。`,
    };
  }

  // —— 解析目标课程组 ——
  let groupTitle = String(intent.groupTitle || '').trim();
  let folderTitleAim = String(intent.folderTitle || '').trim();
  if (!groupTitle && folderTitleAim && addVideo) {
    const found = findFolderAcrossGroups(folderTitleAim);
    if (found) {
      groupTitle = found.group.title;
      folderTitleAim = found.folder.title;
      intent = { ...intent, groupTitle, folderTitle: folderTitleAim };
    }
  }
  if (!groupTitle && lastCourseContext.groupTitle) {
    groupTitle = lastCourseContext.groupTitle;
  }
  if (!groupTitle) {
    return {
      handled: true,
      ok: false,
      message:
        '我还不确定要放到哪个课程组。可以说「把某某笔记放进线性代数课程组」，或「放进线代课程组的极限文件夹」。',
    };
  }

  const groups = listCourseGroups();
  const matched = findBestByTitle(groups, groupTitle, (g) => g.title);
  if (!matched) {
    const nice = /课程组$/.test(groupTitle) ? groupTitle : `${groupTitle}课程组`;
    const folderPart = folderTitleAim
      ? `，并创建文件夹「${folderTitleAim}」`
      : '';
    const itemLabel =
      notesToAdd.length > 1
        ? `${notesToAdd.length} 篇笔记`
        : notesToAdd[0]
          ? `笔记「${notesToAdd[0].title || notesToAdd[0].bvid}」`
          : '当前视频';
    const videoPart = addVideo ? `，再把${itemLabel}放进去` : '';
    return askConfirm(
      `还没有「${nice}」。要现在新建${folderPart}${videoPart}吗？回复「好的」或「创建」我就帮你建。`,
      {
        action: addVideo ? 'create_group_and_add' : 'create_group',
        groupTitle: nice,
        folderTitle: folderTitleAim,
        noteTitle: noteQuery || '',
        noteTitles: noteTitlesForConfirm,
        topic: '',
        createFolderIfMissing: true,
        confidence: 1,
      },
      videoMeta
    );
  }

  const group = matched.item;
  rememberCourse(group);

  const createFolder =
    forceCreate ||
    action === 'create_folder' ||
    action === 'create_folder_and_add' ||
    Boolean(intent.createFolderIfMissing);
  let folderTitle = folderTitleAim;

  if (
    (action === 'create_folder' || action === 'create_folder_and_add') &&
    !folderTitle
  ) {
    return {
      handled: true,
      ok: false,
      message: `要在「${group.title}」里建文件夹的话，请告诉我文件夹名字，例如「创建极限文件夹」。`,
    };
  }

  // —— 只建文件夹，不放视频 ——
  if (action === 'create_folder' || (folderTitle && createFolder && !addVideo)) {
    if (!folderTitle) {
      return {
        handled: true,
        ok: false,
        message: `请告诉我文件夹名字，例如「在「${group.title}」里创建极限文件夹」。`,
      };
    }
    const folder = resolveOrCreateFolder(group.id, folderTitle, {
      createIfMissing: true,
    });
    if (!folder.ok) {
      return {
        handled: true,
        ok: false,
        message: `在「${group.title}」里创建文件夹时出了点问题，请稍后再试。`,
      };
    }
    rememberCourse(group, folder.folderTitle, folder.folderId);
    clearPending();
    if (folder.created) {
      return {
        handled: true,
        ok: true,
        message: `好的，已在课程组「${group.title}」下创建文件夹「${folder.folderTitle}」。`,
      };
    }
    return {
      handled: true,
      ok: true,
      message: `课程组「${group.title}」里已经有文件夹「${folder.folderTitle}」了。`,
    };
  }

  if (folderTitle) {
    const folder = resolveOrCreateFolder(group.id, folderTitle, {
      createIfMissing: createFolder,
    });
    if (!folder.ok && folder.error === 'folder_not_found') {
      const itemLabel =
        notesToAdd.length > 1
          ? `${notesToAdd.length} 篇笔记`
          : notesToAdd[0]
            ? `笔记「${notesToAdd[0].title || notesToAdd[0].bvid}」`
            : '当前视频';
      return askConfirm(
        `课程组「${group.title}」里还没有「${folder.folderTitle}」文件夹。要现在创建${addVideo ? `并把${itemLabel}放进去` : ''}吗？回复「好的」或「创建」即可。`,
        {
          action: addVideo ? 'create_folder_and_add' : 'create_folder',
          groupTitle: group.title,
          folderTitle: folder.folderTitle,
          noteTitle: noteQuery || '',
          noteTitles: noteTitlesForConfirm,
          topic: '',
          createFolderIfMissing: true,
          confidence: 1,
        },
        videoMeta
      );
    }
    if (!folder.ok) {
      return {
        handled: true,
        ok: false,
        message: `在「${group.title}」里处理文件夹时出了点问题，请稍后再试。`,
      };
    }

    if (!addVideo) {
      rememberCourse(group, folder.folderTitle, folder.folderId);
      clearPending();
      return {
        handled: true,
        ok: true,
        message: folder.created
          ? `好的，已在课程组「${group.title}」下创建文件夹「${folder.folderTitle}」。`
          : `课程组「${group.title}」里已经有文件夹「${folder.folderTitle}」了。`,
      };
    }

    const result = addResolvedNotesToGroup(group.id, notesToAdd, folder.folderId);
    rememberCourse(group, folder.folderTitle, folder.folderId);
    clearPending();
    const folderPart = folder.folderId
      ? `，${folder.created ? '新建并放入' : '放入'}文件夹「${folder.folderTitle}」`
      : '，放在课程组下';
    if (!result.ok) {
      return {
        handled: true,
        ok: false,
        message: formatBatchAddMessage({
          groupTitle: group.title,
          folderPart,
          okNames: result.okNames,
          failNames: result.failNames,
          resolveFailures,
        }) || `没能把笔记放进「${group.title}」，请稍后再试。`,
      };
    }
    return {
      handled: true,
      ok: true,
      message: formatBatchAddMessage({
        groupTitle: group.title,
        folderPart,
        okNames: result.okNames,
        failNames: result.failNames,
        resolveFailures,
        prefix: '好的',
      }),
    };
  }

  // 无文件夹：直接加入课程组下
  {
    const result = addResolvedNotesToGroup(group.id, notesToAdd, null);
    rememberCourse(group);
    clearPending();
    if (!result.ok) {
      return {
        handled: true,
        ok: false,
        message: formatBatchAddMessage({
          groupTitle: group.title,
          folderPart: '，放在课程组下',
          okNames: result.okNames,
          failNames: result.failNames,
          resolveFailures,
        }) || `没能把笔记加入「${group.title}」，请稍后再试。`,
      };
    }
    return {
      handled: true,
      ok: true,
      message: formatBatchAddMessage({
        groupTitle: group.title,
        folderPart: '，放在课程组下',
        okNames: result.okNames,
        failNames: result.failNames,
        resolveFailures,
        prefix: '好的',
      }),
    };
  }
}

function handlePendingConfirm(question, videoMeta) {
  if (!pendingConfirm) return null;
  if (Date.now() - (pendingConfirm.askedAt || 0) > 5 * 60 * 1000) {
    clearPending();
    return null;
  }

  if (isNegative(question)) {
    clearPending();
    return {
      handled: true,
      ok: true,
      message: '好的，先不创建。你随时可以说「新建…课程组」或换个名字再试。',
    };
  }

  if (isAffirmative(question)) {
    const intent = pendingConfirm.intent;
    const meta = {
      bvid: videoMeta?.bvid || pendingConfirm.videoMeta?.bvid,
      title: videoMeta?.title || pendingConfirm.videoMeta?.title || '',
    };
    clearPending();
    return executeCourseAction(intent, meta, { forceCreate: true });
  }

  if (looksLikeCourseAction(question) && !isAffirmative(question) && !isNegative(question)) {
    clearPending();
    return null;
  }

  return {
    handled: true,
    ok: true,
    message:
      '还在等你确认要不要创建。回复「好的」创建，或「不用」取消。',
  };
}

async function tryHandleCourseChat(question, videoMeta = {}, opts = {}) {
  const q = String(question || '').trim();
  if (!q) return { handled: false };

  if (pendingConfirm) {
    const pendingResult = handlePendingConfirm(q, videoMeta);
    if (pendingResult) return pendingResult;
  }

  if (!looksLikeCourseAction(q)) {
    return { handled: false };
  }

  let intent;
  try {
    intent = await parseCourseActionIntent(q, {
      ...videoMeta,
      history: opts.history || [],
    });
  } catch (err) {
    console.warn('[bili-pet] course parse failed:', err.message || err);
    const fallback = heuristicParseIntent(q, {
      recentGroupTitle: extractRecentGroupFromHistory(opts.history),
    });
    if (fallback) intent = fallback;
    else {
      return {
        handled: true,
        ok: false,
        message:
          '我没太听懂这句课程组指令。可以试试：「新建糖类课程组」「把线性代数、积分笔记放进线代课程组」「把 XX 笔记放进极限文件夹」。',
      };
    }
  }

  if (!intent || intent.action === 'none' || intent.confidence < 0.55) {
    if (/课程组|文件夹|放进|放到|新建|创建/.test(q)) {
      return {
        handled: true,
        ok: false,
        message:
          '我没太确定你的意思。可以说「把某某笔记放进某类课程组」，或「把某某笔记放到某类课程组的某文件夹」，或「新建某类课程组」。',
      };
    }
    return { handled: false };
  }

  return executeCourseAction(intent, videoMeta);
}

function getLastCourseContext() {
  return { ...lastCourseContext };
}

function resetCourseActionState() {
  lastCourseContext = {
    groupId: null,
    groupTitle: null,
    folderId: null,
    folderTitle: null,
  };
  clearPending();
}

module.exports = {
  looksLikeCourseAction,
  parseCourseActionIntent,
  executeCourseAction,
  tryHandleCourseChat,
  formatCourseCatalog,
  heuristicParseIntent,
  getLastCourseContext,
  resetCourseActionState,
};
//AI维护的课程组代码文件，比较懒得维护，如果能看得懂就维护吧，逻辑和之前的笔记检索是相同的