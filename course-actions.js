const { completeTask } = require('./llm');
const {
  listCourseGroups,
  getCourseGroup,
  createCourseGroup,
  createCourseFolder,
  addCourseGroupItem,
  updateCourseGroupItem,
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
  return /课程组|文件夹|加入.*课|放进|放到|新建.*课|创建.*课|建个.*课|建一个.*课|在里面|放进去|保存.*笔记/.test(
    q
  );
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

function heuristicParseIntent(question, { recentGroupTitle } = {}) {
  const q = String(question || '').trim();
  if (!q) return null;

  const recent = String(recentGroupTitle || lastCourseContext.groupTitle || '').trim();

  const normalizeGroupTitle = (raw) => {
    let t = String(raw || '').trim();
    t = t.replace(/^(到|至|进|入)/, '');
    t = stripCourseSuffix(t);
    if (!t) return '';
    return /课程组$/.test(t) ? t : `${t}课程组`;
  };

  const normalizeFolderTitle = (raw) =>
    String(raw || '')
      .trim()
      .replace(/(文件夹|目录)$/u, '')
      .replace(/[下里中]$/u, '')
      .trim();

  let m =
    q.match(/新建(?:一个)?(.+?)课程组/) ||
    q.match(/创建(?:一个)?(.+?)课程组/);
  if (m) {
    const groupTitle = normalizeGroupTitle(m[1]);
    const folderM = q.match(/([A-Za-z0-9_-]+|[\u4e00-\u9fff]{1,20}?)文件夹/);
    return {
      action: 'create_group_and_add',
      groupTitle,
      folderTitle: folderM ? normalizeFolderTitle(folderM[1]) : '',
      topic: '',
      createFolderIfMissing: true,
      confidence: 0.9,
      source: 'heuristic',
    };
  }

  m =
    q.match(/在里面(?:再)?创建(?:一个)?(.+?)文件夹/) ||
    q.match(
      /在(?:其中|该课程组|这个课程组)(?:里|中)?(?:再)?创建(?:一个)?(.+?)文件夹/
    ) ||
    q.match(/创建(?:一个)?(.+?)文件夹/);
  if (m && (recent || /在里面|其中|该课程组|这个课程组|创建.+文件夹/.test(q))) {
    const folderTitle = normalizeFolderTitle(m[1]);
    if (folderTitle && (recent || /在里面|其中|该课程组|这个课程组/.test(q))) {
      return {
        action: 'create_folder_and_add',
        groupTitle: recent || '',
        folderTitle,
        topic: '',
        createFolderIfMissing: true,
        confidence: recent ? 0.92 : 0.72,
        source: 'heuristic',
      };
    }
  }

  m = q.match(/在(.+?)课程组(?:里|中)?(?:再)?创建(?:一个)?(.+?)文件夹/);
  if (m) {
    return {
      action: 'create_folder_and_add',
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

  m = q.match(/(?:加入|放进|放到)(.+?)课程组(?!.*文件夹)/);
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

  const payload = {
    userMessage: String(question || '').trim(),
    recentCourseGroup: recentGroupTitle || null,
    dialogueHint:
      '若用户说「在里面」「该课程组」「其中」，指代 recentCourseGroup；若为空再看已有课程组列表。',
    currentVideo: {
      bvid: bvid || null,
      title: title || null,
    },
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
    'add_to_group',
    'create_folder_and_add',
    'create_group_and_add',
  ]);
  const llmIntent = {
    action: allowed.has(action) ? action : 'none',
    groupTitle: String(obj.groupTitle || '').trim(),
    folderTitle: String(obj.folderTitle || '').trim(),
    topic: String(obj.topic || '').trim(),
    createFolderIfMissing: Boolean(obj.createFolderIfMissing),
    confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0)),
    source: 'llm',
  };

  if (
    (!llmIntent.groupTitle || /里面|其中|该课程组|这个课程组/.test(question)) &&
    recentGroupTitle &&
    (llmIntent.action === 'create_folder_and_add' ||
      llmIntent.action === 'add_to_group')
  ) {
    llmIntent.groupTitle = llmIntent.groupTitle || recentGroupTitle;
    llmIntent.confidence = Math.max(llmIntent.confidence, 0.8);
  }

  if (llmIntent.action === 'none' || llmIntent.confidence < 0.55) {
    if (heuristic && heuristic.confidence >= 0.7) return heuristic;
  }
  if (
    heuristic &&
    heuristic.confidence >= 0.85 &&
    llmIntent.confidence < heuristic.confidence
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
  const action = intent?.action || 'none';
  if (action === 'none') {
    return { handled: false };
  }

  const key = String(videoMeta.bvid || '').trim();
  if (!key) {
    return {
      handled: true,
      ok: false,
      message: '现在没有检测到正在播放的视频。请先打开一个 B 站视频再试。',
    };
  }

  const videoTitle = String(videoMeta.title || '').trim();

  if (action === 'create_group_and_add') {
    let groupTitle =
      String(intent.groupTitle || '').trim() ||
      (videoTitle ? `${videoTitle.slice(0, 24)}` : '未命名课程组');
    if (!/课程组$/.test(groupTitle)) groupTitle += '课程组';

    const existing = findBestByTitle(listCourseGroups(), groupTitle, (g) => g.title);
    if (existing && existing.score >= 80) {
      const next = {
        ...intent,
        action: intent.folderTitle ? 'create_folder_and_add' : 'add_to_group',
        groupTitle: existing.item.title,
        createFolderIfMissing: Boolean(intent.folderTitle) || forceCreate,
      };
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

    const added = ensureItemInGroup(created.group.id, {
      bvid: key,
      title: videoTitle,
      folderId,
    });
    if (!added.ok) {
      rememberCourse(created.group, folderTitle, folderId);
      return {
        handled: true,
        ok: false,
        message: `课程组「${groupTitle}」已创建，但当前视频没加进去，可以说「加入${groupTitle}」再试一次。`,
      };
    }

    rememberCourse(created.group, folderTitle, folderId);
    clearPending();
    const where = folderTitle ? `文件夹「${folderTitle}」` : '根目录（未分类）';
    return {
      handled: true,
      ok: true,
      message: `好的，已新建课程组「${groupTitle}」，并把当前视频放到${where}。`,
    };
  }

  let groupTitle = String(intent.groupTitle || '').trim();
  if (!groupTitle && lastCourseContext.groupTitle) {
    groupTitle = lastCourseContext.groupTitle;
  }
  if (!groupTitle) {
    return {
      handled: true,
      ok: false,
      message:
        '我还不确定要操作哪个课程组。可以说名字，例如「加入线性代数课程组」，或先说「新建线性代数课程组」。',
    };
  }

  const groups = listCourseGroups();
  const matched = findBestByTitle(groups, groupTitle, (g) => g.title);
  if (!matched) {
    const nice = /课程组$/.test(groupTitle) ? groupTitle : `${groupTitle}课程组`;
    const folderPart = intent.folderTitle
      ? `，并放进「${intent.folderTitle}」文件夹`
      : '';
    return askConfirm(
      `还没有「${nice}」。要现在新建并把当前视频放进去${folderPart}吗？回复「好的」或「创建」我就帮你建。`,
      {
        action: 'create_group_and_add',
        groupTitle: nice,
        folderTitle: String(intent.folderTitle || '').trim(),
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
    action === 'create_folder_and_add' ||
    Boolean(intent.createFolderIfMissing);
  let folderTitle = String(intent.folderTitle || '').trim();
  if (action === 'create_folder_and_add' && !folderTitle) {
    return {
      handled: true,
      ok: false,
      message: `要在「${group.title}」里建文件夹的话，请告诉我文件夹名字，例如「创建 USA 文件夹」。`,
    };
  }

  if (folderTitle) {
    const folder = resolveOrCreateFolder(group.id, folderTitle, {
      createIfMissing: createFolder,
    });
    if (!folder.ok && folder.error === 'folder_not_found') {
      return askConfirm(
        `课程组「${group.title}」里还没有「${folder.folderTitle}」文件夹。要现在创建并把当前视频放进去吗？回复「好的」或「创建」即可。`,
        {
          action: 'create_folder_and_add',
          groupTitle: group.title,
          folderTitle: folder.folderTitle,
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

    const added = ensureItemInGroup(group.id, {
      bvid: key,
      title: videoTitle,
      folderId: folder.folderId,
    });
    if (!added.ok) {
      return {
        handled: true,
        ok: false,
        message: `没能把当前视频放进「${group.title}」，请稍后再试。`,
      };
    }

    rememberCourse(group, folder.folderTitle, folder.folderId);
    clearPending();
    const folderPart = folder.folderId
      ? `${folder.created ? '新建并放入' : '放入'}文件夹「${folder.folderTitle}」`
      : '放到未分类';
    return {
      handled: true,
      ok: true,
      message: `好的，已把当前视频加入课程组「${group.title}」，${folderPart}。`,
    };
  }

  // 无文件夹：直接加入根目录
  const added = ensureItemInGroup(group.id, {
    bvid: key,
    title: videoTitle,
    folderId: null,
  });
  if (!added.ok) {
    return {
      handled: true,
      ok: false,
      message: `没能把当前视频加入「${group.title}」，请稍后再试。`,
    };
  }
  rememberCourse(group);
  clearPending();
  return {
    handled: true,
    ok: true,
    message: `好的，已把当前视频加入课程组「${group.title}」，放到未分类。`,
  };
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
          '我没太听懂这句课程组指令。可以试试：「新建糖类课程组」「在里面创建USA文件夹并把这个视频放进去」。',
      };
    }
  }

  if (!intent || intent.action === 'none' || intent.confidence < 0.55) {
    if (/课程组|文件夹|放进|放到|新建|创建/.test(q)) {
      return {
        handled: true,
        ok: false,
        message:
          '我没太确定你的意思。可以说清楚课程组/文件夹名字，例如「把这个视频放到糖类课程组的USA文件夹」，或「新建糖类课程组」。',
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