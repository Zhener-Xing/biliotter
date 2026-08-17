const path = require('path');
const { loadEnv } = require('./load-env');
const { completeTask } = require('./llm');
const {
  detectContentLang,
  detectChunksLang,
  langInstruction,
  langSystemLock,
  nodeLabelMaxLen,
} = require('./content-lang');
const {
  gatherCourseChunks,
  getCourseGroup,
  getCourseMindmap,
  listChunksForBvids,
  loadNoteDoc,
  saveCourseMindmap,
  searchNoteChunks,
} = require('./notes-db');

loadEnv(path.join(__dirname, '.env'));

function envFlag(name, fallback = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function tryParseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 从模型输出抽出 Markdown 大纲；支持纯 MD、JSON、代码围栏 */
function extractMindmapMd(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const parsed = tryParseJsonObject(text);
  if (parsed) {
    const md = String(
      parsed.mindmap_md || parsed.mindmapMd || parsed.markdown || ''
    ).trim();
    if (md) return md;
  }

  const mdFence = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (mdFence) {
    const inner = String(mdFence[1] || '').trim();
    if (inner.startsWith('#')) return inner;
  }

  if (text.startsWith('#')) return text;

  const hashAt = text.indexOf('\n#');
  if (hashAt >= 0) {
    const fromHash = text.slice(hashAt + 1).trim();
    if (fromHash.startsWith('#')) return fromHash;
  }
  if (text.includes('# ')) {
    const idx = text.indexOf('# ');
    if (idx >= 0) return text.slice(idx).trim();
  }
  return '';
}

const VIDEO_NOISE_RE =
  /(一个视频讲透彻?|一站式讲解|彻底吃透|建议收藏|高清完整版|附讲义|讲义|同步全集|一轮总复习|二轮复习|完整版|必看|干货|人教A?版|高考冲刺|名师|免费领取|点击收藏|记得三连)/g;

function cleanNodeLabel(raw, { maxLen = 24 } = {}) {
  let s = String(raw || '')
    .replace(/^#+\s*/, '')
    .replace(/[【\[][^】\]]*[】\]]/g, ' ')
    .replace(VIDEO_NOISE_RE, ' ')
    .replace(/BV[\w]+/gi, ' ')
    .replace(/\bav\d+\b/gi, ' ')
    .replace(/bili-?pet/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[!！?？.。,，;；:：|｜&＆]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/\s+\S*$/, '').trim() || s.slice(0, maxLen);
  }
  return s;
}

/** 去掉导图里的视频印记 / BV / 营销标题化节点 */
function sanitizeMindmapMd(md, groupTitle = '', { lang } = {}) {
  const contentLang = lang || detectContentLang(md, groupTitle);
  const rootMax = nodeLabelMaxLen(contentLang, 'root');
  const moduleMax = nodeLabelMaxLen(contentLang, 'module');
  const leafMax = nodeLabelMaxLen(contentLang, 'leaf');
  const rootTitle =
    cleanNodeLabel(groupTitle, { maxLen: rootMax }) ||
    String(groupTitle || '').trim() ||
    (contentLang === 'en' ? 'Course' : '课程组');
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let sawRoot = false;

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) {
      const t = String(line || '').trim();
      if (!t) continue;
      if (/bili-?pet|BV[\w]+/i.test(t)) continue;
      continue;
    }
    const level = m[1].length;
    let title = String(m[2] || '')
      .replace(/\(\s*BV[\w]+\s*\)/gi, '')
      .replace(/BV[\w]+/gi, '')
      .replace(/bili-?pet/gi, '')
      .replace(/^\s*<\s*-+\s*/g, '')
      .trim();
    title = cleanNodeLabel(title, {
      maxLen: level <= 2 ? moduleMax : leafMax,
    });
    if (!title) continue;
    if (level === 1) {
      if (sawRoot) continue;
      sawRoot = true;
      out.push(`# ${rootTitle}`);
      continue;
    }
    out.push(`${'#'.repeat(level)} ${title}`);
  }

  if (!sawRoot) out.unshift(`# ${rootTitle}`);
  const deduped = [];
  const seenAtDepth = new Map();
  for (const line of out) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const depth = m[1].length;
    for (const d of [...seenAtDepth.keys()]) {
      if (d > depth) seenAtDepth.delete(d);
    }
    if (seenAtDepth.get(depth) === m[2] && depth > 1) continue;
    if (depth === 2) {
      const modKey = `mod::${m[2]}`;
      if (seenAtDepth.get(modKey)) continue;
      seenAtDepth.set(modKey, true);
    }
    seenAtDepth.set(depth, m[2]);
    deduped.push(line);
  }
  return `${deduped.join('\n')}\n`;
}

function outlineFromChunks(group, chunks) {
  const lines = [
    `# ${cleanNodeLabel(group.title, { maxLen: 24 }) || group.title || '课程组'}`,
  ];

  const byTopic = new Map();
  for (const c of chunks) {
    let topic = cleanNodeLabel(c.heading, { maxLen: 16 });
    if (!topic) {
      const first = String(c.text || '')
        .split('\n')
        .map((s) => s.trim())
        .find(Boolean);
      topic = cleanNodeLabel(first, { maxLen: 16 });
    }
    if (!topic) topic = '要点';
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(c);
  }

  const topics = [...byTopic.entries()].slice(0, 12);
  for (const [topic, list] of topics) {
    lines.push(`## ${topic}`);
    const seen = new Set();
    for (const c of list) {
      const fromText = String(c.text || '')
        .split(/[\n。；;]/)
        .map((s) => cleanNodeLabel(s, { maxLen: 20 }))
        .filter(Boolean);
      for (const point of fromText) {
        if (point === topic || seen.has(point)) continue;
        seen.add(point);
        lines.push(`### ${point}`);
        if (seen.size >= 6) break;
      }
      if (seen.size >= 6) break;
    }
  }
  return sanitizeMindmapMd(`${lines.join('\n')}\n`, group.title);
}

/** 从笔记正文抽出 Markdown 标题（#～######） */
function extractMdHeadings(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const text = String(m[2] || '')
      .replace(/\s+#+\s*$/, '')
      .replace(/BV[\w]+/gi, '')
      .trim();
    if (!text) continue;
    out.push({ level: m[1].length, text });
  }
  return out;
}

/**
 * 按课程结构生成大纲：
 * 课程组 → 文件夹 → 笔记标题 → 笔记内 # / ## …
 */
function outlineFromStructure(group, bodyByBvid) {
  const root =
    cleanNodeLabel(group.title, { maxLen: 40 }) ||
    String(group.title || '').trim() ||
    '课程组';
  const lines = [`# ${root}`];
  const folders = [...(group.folders || [])].sort(
    (a, b) => (a.ord || 0) - (b.ord || 0)
  );
  const items = [...(group.items || [])].sort(
    (a, b) => (a.ord || 0) - (b.ord || 0)
  );

  const byFolder = new Map();
  const unfiled = [];
  for (const it of items) {
    const fid = it.folderId || null;
    if (fid) {
      if (!byFolder.has(fid)) byFolder.set(fid, []);
      byFolder.get(fid).push(it);
    } else {
      unfiled.push(it);
    }
  }

  let noteCount = 0;
  let headingCount = 0;

  function emitNote(it, noteLevel) {
    const rawTitle = it.title || it.noteTitle || it.bvid || '未命名笔记';
    const title =
      cleanNodeLabel(rawTitle, { maxLen: 48 }) || String(rawTitle).trim();
    if (!title) return;
    lines.push(`${'#'.repeat(Math.min(6, noteLevel))} ${title}`);
    noteCount += 1;

    const body =
      (bodyByBvid && bodyByBvid.get(it.bvid)) ||
      (bodyByBvid && bodyByBvid.get(String(it.bvid || ''))) ||
      '';
    const titleNorm = title.replace(/\s+/g, '').toLowerCase();
    const headings = [];
    for (const h of extractMdHeadings(body)) {
      const label =
        cleanNodeLabel(h.text, { maxLen: 56 }) || String(h.text).trim();
      if (!label) continue;
      // 笔记标题已占一层时，跳过与之重复的正文一级标题
      if (
        h.level === 1 &&
        label.replace(/\s+/g, '').toLowerCase() === titleNorm
      ) {
        continue;
      }
      headings.push({ level: h.level, label });
    }
    if (!headings.length) return;
    // 相对映射：笔记下最浅标题 = 笔记的下一层，保留 # / ## 相对关系
    const minL = Math.min(...headings.map((h) => h.level));
    for (const h of headings) {
      const level = Math.min(6, noteLevel + (h.level - minL) + 1);
      lines.push(`${'#'.repeat(level)} ${h.label}`);
      headingCount += 1;
    }
  }

  for (const f of folders) {
    const fname =
      cleanNodeLabel(f.title, { maxLen: 40 }) ||
      String(f.title || '').trim() ||
      '未命名文件夹';
    lines.push(`## ${fname}`);
    const list = byFolder.get(f.id) || [];
    for (const it of list) emitNote(it, 3);
  }

  if (unfiled.length) {
    // 无文件夹的笔记直接挂在课程组下，不再套「未分类」
    for (const it of unfiled) emitNote(it, 2);
  }

  return {
    mindmapMd: `${lines.join('\n')}\n`,
    noteCount,
    headingCount,
    folderCount: folders.length,
  };
}

const MM_META_EXCLUDE = 'bili-pet:mm-excluded';
const MM_META_STRUCTURE = 'bili-pet:mm-structure';
const MM_META_JSON = 'bili-pet:mm-meta';
const MM_PATH_SEP = '\x1f';
const LEGACY_BUCKET_RE = /^(未分类|未命名文件夹)$/;

function stripMindmapMetaComments(md) {
  return String(md || '')
    .replace(/<!--\s*bili-pet:mm-(?:excluded|structure|meta):\s*[\s\S]*?-->/gi, '')
    .trim();
}

function readMindmapMetaList(md, kind) {
  const key = kind === 'structure' ? MM_META_STRUCTURE : MM_META_EXCLUDE;
  const re = new RegExp(`<!--\\s*${key}:\\s*([\\s\\S]*?)-->`, 'i');
  const m = String(md || '').match(re);
  if (!m) return [];
  return String(m[1] || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readMindmapMeta(md) {
  const raw = String(md || '');
  const meta = {
    v: 1,
    excluded: [],
    structure: [],
    origins: {},
  };
  const m = raw.match(/<!--\s*bili-pet:mm-meta:\s*([\s\S]*?)-->/i);
  if (m) {
    try {
      const parsed = JSON.parse(String(m[1] || '').trim());
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.excluded)) {
          meta.excluded = parsed.excluded.map((s) => String(s || '').trim()).filter(Boolean);
        }
        if (Array.isArray(parsed.structure)) {
          meta.structure = parsed.structure.map((s) => String(s || '').trim()).filter(Boolean);
        }
        if (parsed.origins && typeof parsed.origins === 'object') {
          for (const [k, v] of Object.entries(parsed.origins)) {
            const key = String(k || '').trim();
            const origin = String(v || '').trim().toLowerCase();
            if (!key) continue;
            if (origin === 'structure' || origin === 'user' || origin === 'ai') {
              meta.origins[key] = origin;
            }
          }
        }
      }
    } catch {
      /* ignore bad json */
    }
  }
  for (const p of readMindmapMetaList(raw, 'excluded')) {
    if (!meta.excluded.includes(p)) meta.excluded.push(p);
  }
  for (const p of readMindmapMetaList(raw, 'structure')) {
    if (!meta.structure.includes(p)) meta.structure.push(p);
  }
  return meta;
}

function writeMindmapMetaComments(md, patch = {}) {
  const prev = readMindmapMeta(md);
  const body = stripMindmapMetaComments(md);
  const excluded =
    patch.excluded != null
      ? [...new Set(patch.excluded.map((s) => String(s || '').trim()).filter(Boolean))]
      : prev.excluded;
  const structure =
    patch.structure != null
      ? [...new Set(patch.structure.map((s) => String(s || '').trim()).filter(Boolean))]
      : prev.structure;
  const origins =
    patch.origins != null && typeof patch.origins === 'object'
      ? { ...patch.origins }
      : { ...prev.origins };
  const payload = JSON.stringify({
    v: 1,
    excluded,
    structure,
    origins,
  });
  if (!body) return `<!-- ${MM_META_JSON}: ${payload} -->\n`;
  return `${body}\n<!-- ${MM_META_JSON}: ${payload} -->\n`;
}

function markdownToTree(md) {
  const text = stripMindmapMetaComments(md);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const root = { topic: '', children: [] };
  const stack = [{ level: 0, node: root }];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const level = m[1].length;
    const topic = String(m[2] || '').trim();
    if (!topic) continue;
    const node = { topic, children: [] };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1].node;
    parent.children.push(node);
    stack.push({ level, node });
  }
  if (root.children.length === 1) return root.children[0];
  if (!root.children.length) return { topic: '课程组', children: [] };
  return { topic: root.children[0]?.topic || '课程组', children: root.children };
}

function treeToMarkdown(node, depth = 1) {
  if (!node) return '';
  const level = Math.max(1, Math.min(6, depth));
  const topic = String(node.topic || '').trim() || '未命名';
  const lines = [`${'#'.repeat(level)} ${topic}`];
  for (const child of node.children || []) {
    const part = treeToMarkdown(child, level + 1);
    if (part) lines.push(part);
  }
  return lines.join('\n');
}

function cloneMindNode(node) {
  return {
    topic: String(node?.topic || '').trim() || '未命名',
    children: (node?.children || []).map(cloneMindNode),
  };
}

function collectTreePaths(node, prefix = [], out = []) {
  if (!node) return out;
  const topic = String(node.topic || '').trim();
  if (!topic) return out;
  const path = prefix.length ? prefix.concat([topic]) : [topic];
  out.push(path.join(MM_PATH_SEP));
  for (const child of node.children || []) {
    collectTreePaths(child, path, out);
  }
  return out;
}

function pathKey(parts) {
  return (parts || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(MM_PATH_SEP);
}

/** 旧版「未分类」桶：匹配时把它的子节点提升到本层 */
function unwrapLegacyBuckets(kids) {
  const list = Array.isArray(kids) ? kids : [];
  const out = [];
  for (const node of list) {
    const topic = String(node?.topic || '').trim();
    if (LEGACY_BUCKET_RE.test(topic) || topic === '未分类') {
      for (const child of node.children || []) out.push(child);
      continue;
    }
    out.push(node);
  }
  return out;
}

function findTopicMatch(buckets, topic, used) {
  const k = normLabel(topic);
  if (!k) return null;
  const exact = buckets.get(k) || [];
  const hit = exact.find((c) => !used.has(c));
  if (hit) return hit;
  // 宽松：标题互相包含（cleanNodeLabel 截断 / 用户微改）
  for (const [bk, list] of buckets.entries()) {
    if (!bk) continue;
    if (!(k.includes(bk) || bk.includes(k))) continue;
    const cand = list.find((c) => !used.has(c));
    if (cand) return cand;
  }
  return null;
}

function preferOrigin(curr, next) {
  const rank = { structure: 1, ai: 2, user: 3 };
  const c = String(curr || '').toLowerCase();
  const n = String(next || '').toLowerCase();
  if (!c && !n) return '';
  if (!c) return n;
  if (!n) return c;
  return (rank[n] || 0) >= (rank[c] || 0) ? n : c;
}

/**
 * 结构再生成合并（占位思想）：
 * - structure：大纲骨架，可被新大纲更新子结构位
 * - user / ai：用户或 AI 增改，占住后优先保留，不因重新生成丢掉
 * - 删除过的结构位（excluded / 旧快照有而现图无）不再加回
 */
function mergeStructureMindmaps(prevMd, freshMd, {
  lastStructurePaths = [],
  excludedPaths = [],
  origins: prevOrigins = {},
} = {}) {
  const freshTree = markdownToTree(freshMd);
  const freshPaths = new Set(collectTreePaths(freshTree));
  const origins = { ...(prevOrigins || {}) };
  const prevBody = stripMindmapMetaComments(prevMd);

  function stampStructure(node, prefix = []) {
    const topic = String(node?.topic || '').trim();
    if (!topic) return;
    const parts = prefix.length ? prefix.concat([topic]) : [topic];
    const key = pathKey(parts);
    origins[key] = preferOrigin(origins[key], 'structure');
    for (const child of node.children || []) stampStructure(child, parts);
  }

  if (!prevBody || countHeadingNodes(prevBody) < 1) {
    stampStructure(freshTree);
    const paths = [...freshPaths];
    return {
      mindmapMd: writeMindmapMetaComments(treeToMarkdown(freshTree) + '\n', {
        structure: paths,
        excluded: excludedPaths,
        origins,
      }),
      merged: false,
      structurePaths: paths,
      origins,
    };
  }

  const prevTree = markdownToTree(prevMd);
  const last = new Set(
    (lastStructurePaths || []).map((s) => String(s || '').trim()).filter(Boolean)
  );
  const excluded = new Set(
    (excludedPaths || []).map((s) => String(s || '').trim()).filter(Boolean)
  );

  function lookupOriginByTopic(topic) {
    const t = normLabel(topic);
    if (!t) return '';
    for (const [ok, ov] of Object.entries(origins)) {
      const leaf = String(ok.split(MM_PATH_SEP).pop() || '');
      if (normLabel(leaf) === t) return ov;
    }
    return '';
  }

  function mergeChildren(prevKids, freshKids, parentParts) {
    const prevList = unwrapLegacyBuckets(prevKids);
    const freshList = Array.isArray(freshKids) ? freshKids : [];
    const buckets = new Map();
    for (const p of prevList) {
      const k = normLabel(p.topic);
      if (!k) continue;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p);
    }
    const used = new Set();
    const out = [];

    for (const f of freshList) {
      const topic = String(f.topic || '').trim();
      if (!topic) continue;
      const parts = parentParts.concat([topic]);
      const key = pathKey(parts);
      if (excluded.has(key)) continue;

      const hit = findTopicMatch(buckets, topic, used);
      if (hit) {
        used.add(hit);
        const keepTopic =
          preferOrigin(origins[key], 'structure') === 'user'
            ? String(hit.topic || topic).trim() || topic
            : topic;
        origins[key] = preferOrigin(origins[key], 'structure');
        out.push({
          topic: keepTopic,
          children: mergeChildren(hit.children, f.children, parts),
        });
        continue;
      }

      // 旧图没有该结构位：若上次大纲里有过 → 视为用户删过，不加回
      if (last.size && last.has(key)) continue;
      origins[key] = preferOrigin(origins[key], 'structure');
      const cloned = cloneMindNode(f);
      stampStructure(cloned, parentParts);
      out.push(cloned);
    }

    // 旧图多出来的：AI/用户细节，或已改名的节点 —— 一律保留
    for (const p of prevList) {
      if (used.has(p)) continue;
      const topic = String(p.topic || '').trim();
      if (!topic) continue;
      if (LEGACY_BUCKET_RE.test(topic) || topic === '未分类') continue;
      const key = pathKey(parentParts.concat([topic]));
      if (excluded.has(key)) continue;
      let nextOrigin =
        origins[key] ||
        lookupOriginByTopic(topic) ||
        (last.has(key) || freshPaths.has(key) ? 'structure' : '');
      if (!nextOrigin || nextOrigin === 'structure') {
        // 不在新大纲里的旧节点：视为用户/AI 占位，避免被当结构清掉
        nextOrigin = lookupOriginByTopic(topic) || 'user';
      }
      origins[key] = preferOrigin(origins[key], nextOrigin);
      out.push(cloneMindNode(p));
      const walk = (node, prefix) => {
        const t = String(node?.topic || '').trim();
        if (!t) return;
        const parts = prefix.concat([t]);
        const pk = pathKey(parts);
        const guessed = origins[pk] || lookupOriginByTopic(t) || 'user';
        origins[pk] = preferOrigin(origins[pk], guessed === 'structure' ? 'user' : guessed);
        for (const c of node.children || []) walk(c, parts);
      };
      walk(p, parentParts);
    }
    return out;
  }

  const rootTopic =
    String(freshTree.topic || prevTree.topic || '课程组').trim() || '课程组';
  const rootKey = pathKey([rootTopic]);
  origins[rootKey] = preferOrigin(origins[rootKey], 'structure');
  const merged = {
    topic: rootTopic,
    children: mergeChildren(prevTree.children, freshTree.children, [rootTopic]),
  };

  const structurePaths = [...freshPaths];
  const mindmapMd = writeMindmapMetaComments(treeToMarkdown(merged) + '\n', {
    structure: structurePaths,
    excluded: [...excluded],
    origins,
  });
  return { mindmapMd, merged: true, structurePaths, origins };
}

function generateFromStructure(groupId, opts = {}) {
  const key = String(groupId || '').trim();
  if (!key) {
    return { ok: false, error: 'no_id', message: '课程组无效' };
  }
  const group = getCourseGroup(key);
  if (!group) {
    return { ok: false, error: 'not_found', message: '课程组不存在' };
  }

  const items = group.items || [];
  const folders = group.folders || [];
  if (!items.length && !folders.length) {
    return {
      ok: false,
      error: 'no_items',
      message: '课程组还没有文件夹或笔记',
    };
  }

  const bodyByBvid = new Map();
  for (const it of items) {
    const bvid = String(it.bvid || '').trim();
    if (!bvid || bodyByBvid.has(bvid)) continue;
    const doc = loadNoteDoc(bvid);
    bodyByBvid.set(bvid, String(doc?.bodyMd || ''));
  }

  const built = outlineFromStructure(group, bodyByBvid);
  let freshMd = String(built.mindmapMd || '').trim();
  if (!freshMd.startsWith('#')) {
    freshMd = `# ${group.title || '课程组'}\n${freshMd}`.trim();
  }
  freshMd = `${freshMd}\n`;

  if (countHeadingNodes(freshMd) < 1) {
    return {
      ok: false,
      error: 'empty_structure',
      message: '没有可生成的结构节点',
    };
  }

  const stored = getCourseMindmap(key);
  const clientMd = String(opts.mindmapMd || opts.previousMindmapMd || '').trim();
  const prevMd = clientMd || (stored.ok ? String(stored.mindmapMd || '') : '');
  const meta = readMindmapMeta(prevMd);
  const merged = mergeStructureMindmaps(prevMd, freshMd, {
    lastStructurePaths: meta.structure,
    excludedPaths: meta.excluded,
    origins: meta.origins,
  });
  const mindmapMd = merged.mindmapMd;

  const saved = saveCourseMindmap(key, mindmapMd);
  if (!saved.ok) return saved;

  return {
    ok: true,
    groupId: group.id,
    title: group.title,
    mindmapMd: saved.mindmapMd,
    updatedAt: saved.updatedAt,
    source: 'structure',
    noteCount: built.noteCount,
    headingCount: built.headingCount,
    folderCount: built.folderCount,
    chunkCount: 0,
    coverage: null,
    batchCount: 0,
    mergedPrevious: Boolean(merged.merged),
  };
}

function scrubChunkText(text, maxLen = 500) {
  return String(text || '')
    .replace(/BV[\w]+/gi, ' ')
    .replace(/\bav\d+\b/gi, ' ')
    .replace(/bili-?pet/gi, ' ')
    .replace(VIDEO_NOISE_RE, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function toNoteChunkPayload(chunks, startIndex = 0) {
  return chunks.map((c, i) => ({
    noteIndex: startIndex + i + 1,
    heading: cleanNodeLabel(c.heading, { maxLen: 20 }),
    text: scrubChunkText(c.text, 420),
  }));
}

/** 按字符预算拆成多批，保证每批都能塞进一次 LLM 请求 */
function splitChunksIntoBatches(chunks, { maxChunks = 48, maxChars = 22000 } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) return [];
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const c of list) {
    const add =
      Math.min(420, String(c.text || '').length) +
      String(c.heading || '').length +
      24;
    if (
      cur.length &&
      (cur.length >= maxChunks || chars + add > maxChars)
    ) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(c);
    chars += add;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function countHeadingNodes(md) {
  return String(md || '')
    .split('\n')
    .filter((line) => /^#{1,6}\s+\S/.test(line.trim())).length;
}

function finalizeMindmapMd(mindmapMd, groupTitle, { lang } = {}) {
  let md = sanitizeMindmapMd(mindmapMd, groupTitle, { lang });
  if (!md.trim().startsWith('#')) {
    md = `# ${groupTitle}\n\n${md}`.trim() + '\n';
    md = sanitizeMindmapMd(md, groupTitle, { lang });
  }
  return md;
}

async function llmMindmapOnce(group, noteChunks, {
  previousMindmapMd = '',
  instruction = '',
  contentLanguage = 'zh',
} = {}) {
  const lang = contentLanguage === 'en' ? 'en' : 'zh';
  const payload = {
    group: {
      id: group.id,
      title: group.title,
      topic: group.topic,
      itemCount: group.itemCount,
    },
    noteChunks,
    contentLanguage: lang,
    instruction:
      (instruction ||
        '根据 noteChunks 生成知识模块大纲；禁止视频标题与 BV；输出纯 Markdown 大纲。') +
      ` ${langInstruction(lang)}`,
  };
  if (previousMindmapMd) {
    payload.previousMindmapMd = previousMindmapMd;
  }
  const raw = await completeTask('mindmap_course', payload, {
    max_tokens: 4096,
    timeoutMs: 90000,
    jsonMode: false,
    temperature: 0.35,
    thinking: false,
    systemAppend: langSystemLock(lang),
  });
  return extractMindmapMd(raw);
}

/**
 * @param {string} groupId
 * @param {{ mergePrevious?: boolean, mode?: 'structure'|'ai' }} [opts]
 *   默认 mode=structure：按文件夹→笔记→MD 标题本地生成（秒级）。
 *   mode=ai 或 mergePrevious=true：走切块 + LLM（可选增补）。
 */
async function generateCourseMindmap(groupId, opts = {}) {
  const mergePrevious = Boolean(opts.mergePrevious);
  const modeRaw = String(opts.mode || '').trim().toLowerCase();
  const mode =
    modeRaw === 'ai' || modeRaw === 'llm' || mergePrevious
      ? 'ai'
      : 'structure';

  if (mode === 'structure') {
    return generateFromStructure(groupId, {
      mindmapMd: opts.mindmapMd || opts.previousMindmapMd,
    });
  }

  const packed = gatherCourseChunks(groupId, { mode: 'mindmap', limit: 160 });
  if (!packed.ok) {
    return {
      ok: false,
      error: packed.error || 'gather_failed',
      message:
        packed.error === 'no_items'
          ? '课程组还没有视频'
          : packed.error === 'no_chunks'
            ? '组内笔记尚无切块，请先写笔记或一键整理'
            : packed.error === 'not_found'
              ? '课程组不存在'
              : '无法收集笔记切块',
    };
  }

  const { group, chunks, coverage } = packed;
  // 输出语言跟笔记切块走：切块英文→英文导图，切块中文→中文导图
  const contentLanguage = detectChunksLang(chunks);
  const prev = getCourseMindmap(groupId);
  const previousMindmapMd =
    mergePrevious && prev.ok
      ? sanitizeMindmapMd(String(prev.mindmapMd || '').trim(), group.title, {
          lang: contentLanguage,
        })
      : '';

  let mindmapMd = '';
  let source = 'llm';
  let batchCount = 1;

  if (!envFlag('LLM_ENABLED', false)) {
    mindmapMd = outlineFromChunks(group, chunks);
    source = 'chunks_outline';
  } else {
    const batches = splitChunksIntoBatches(chunks, {
      maxChunks: 48,
      maxChars: 22000,
    });
    batchCount = batches.length;
    try {
      let draft = '';
      let offset = 0;
      for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        const noteChunks = toNoteChunkPayload(batch, offset);
        offset += batch.length;
        const isFirst = i === 0;
        const isLast = i === batches.length - 1;
        let instruction;
        if (isFirst && !previousMindmapMd) {
          instruction =
            batches.length > 1
              ? `这是第 1/${batches.length} 批笔记切块。先根据本批生成完整知识模块大纲骨架；后续批次会继续增补。禁止视频标题与 BV；输出纯 Markdown。`
              : '根据 noteChunks 全新生成知识模块大纲；禁止沿用或臆造旧结构；禁止视频标题与 BV；输出纯 Markdown 大纲。';
        } else {
          instruction = `这是第 ${i + 1}/${batches.length} 批笔记切块。把本批知识点合并进 previousMindmapMd：相同模块合并，新模块追加，去重；禁止视频标题与 BV；输出合并后的完整 Markdown 大纲${isLast ? '（最终版）' : ''}。`;
        }
        const prevForCall = isFirst
          ? previousMindmapMd || undefined
          : draft || previousMindmapMd || undefined;
        const out = await llmMindmapOnce(group, noteChunks, {
          previousMindmapMd: prevForCall,
          instruction,
          contentLanguage,
        });
        if (!out) {
          console.warn(
            `[bili-pet] mindmap LLM empty at batch ${i + 1}/${batches.length}`
          );
          return {
            ok: false,
            error: 'llm_empty',
            message: 'AI 未返回可用导图，本次未覆盖原导图',
            chunkCount: chunks.length,
            coverage,
            batchCount,
          };
        }
        draft = out;
      }
      mindmapMd = draft;
      source = batches.length > 1 ? 'llm_batched' : 'llm';
    } catch (err) {
      console.warn('[bili-pet] mindmap LLM failed:', err.message || err);
      return {
        ok: false,
        error: 'llm_failed',
        message: `AI 生成失败：${err.message || err}（本次未覆盖原导图）`,
        chunkCount: chunks.length,
        coverage,
        batchCount,
      };
    }
  }

  mindmapMd = finalizeMindmapMd(mindmapMd, group.title, {
    lang: contentLanguage,
  });
  if (countHeadingNodes(mindmapMd) < 2) {
    return {
      ok: false,
      error: 'llm_too_thin',
      message: '生成结果过少，本次未覆盖原导图',
      chunkCount: chunks.length,
      coverage,
      batchCount,
    };
  }

  const saved = saveCourseMindmap(groupId, mindmapMd);
  if (!saved.ok) return saved;

  return {
    ok: true,
    groupId: group.id,
    title: group.title,
    mindmapMd: saved.mindmapMd,
    updatedAt: saved.updatedAt,
    chunkCount: chunks.length,
    source,
    mergedPrevious: mergePrevious && Boolean(previousMindmapMd),
    coverage: coverage || null,
    batchCount,
  };
}

function normLabel(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 把相对 # / ## 或 - 列表解析成子树 */
function parseExpandChildren(raw, { lang } = {}) {
  let text = String(raw || '').trim();
  if (!text) return [];
  const maxLen = nodeLabelMaxLen(lang || detectContentLang(text), 'leaf');

  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fenced) text = String(fenced[1] || '').trim();

  const parsed = tryParseJsonObject(text);
  if (parsed) {
    const list = parsed.children || parsed.nodes || parsed.items;
    if (Array.isArray(list)) {
      return list
        .map((item) => {
          if (typeof item === 'string') {
            const topic = cleanNodeLabel(item, { maxLen });
            return topic ? { topic, children: [] } : null;
          }
          const topic = cleanNodeLabel(item.topic || item.title || item.text, {
            maxLen,
          });
          if (!topic) return null;
          const kids = Array.isArray(item.children)
            ? item.children
                .map((c) => {
                  const t = cleanNodeLabel(
                    typeof c === 'string' ? c : c.topic || c.title,
                    { maxLen }
                  );
                  return t ? { topic: t, children: [] } : null;
                })
                .filter(Boolean)
                .slice(0, 3)
            : [];
          return { topic, children: kids };
        })
        .filter(Boolean)
        .slice(0, 8);
    }
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const hasHash = lines.some((l) => /^#{1,3}\s+\S/.test(l.trim()));
  if (hasHash) {
    const root = { topic: '__root__', children: [] };
    const stack = [{ level: 0, node: root }];
    for (const line of lines) {
      const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
      if (!m) continue;
      const level = m[1].length;
      const topic = cleanNodeLabel(m[2], { maxLen });
      if (!topic) continue;
      const node = { topic, children: [] };
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].node;
      parent.children.push(node);
      stack.push({ level, node });
    }
    return root.children.slice(0, 8).map((n) => ({
      topic: n.topic,
      children: (n.children || []).slice(0, 3),
    }));
  }

  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*•]\s+(.+?)\s*$/);
    if (!m) continue;
    const topic = cleanNodeLabel(m[1], { maxLen });
    if (!topic) continue;
    out.push({ topic, children: [] });
    if (out.length >= 8) break;
  }
  return out;
}

function filterNewChildren(children, existingLabels) {
  const seen = new Set(
    (existingLabels || []).map(normLabel).filter(Boolean)
  );
  const out = [];
  for (const ch of children || []) {
    const key = normLabel(ch.topic);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const kidSeen = new Set([key]);
    const kids = [];
    for (const k of ch.children || []) {
      const kk = normLabel(k.topic);
      if (!kk || kidSeen.has(kk) || seen.has(kk)) continue;
      kidSeen.add(kk);
      kids.push({ topic: k.topic, children: [] });
      if (kids.length >= 3) break;
    }
    out.push({ topic: ch.topic, children: kids });
    if (out.length >= 8) break;
  }
  return out;
}

function gatherChunksForNodePath(group, pathLabels, { limit = 20 } = {}) {
  const bvids = (group.items || []).map((i) => i.bvid).filter(Boolean);
  if (!bvids.length) return [];

  const labels = (pathLabels || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const leaf = labels[labels.length - 1] || group.title || '';
  const query = labels.slice(-3).join(' ') || leaf;
  const lim = Math.max(6, Math.min(28, Number(limit) || 20));
  const seen = new Set();
  const chunks = [];

  function pushAll(rows) {
    for (const row of rows || []) {
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      chunks.push(row);
      if (chunks.length >= lim) return true;
    }
    return false;
  }

  if (query) {
    if (pushAll(searchNoteChunks(query, { bvids, limit: lim }))) return chunks;
  }
  if (leaf && leaf !== query) {
    if (pushAll(searchNoteChunks(leaf, { bvids, limit: lim }))) return chunks;
  }

  // 标题近似匹配的笔记优先补切块
  const matchedBvids = [];
  for (const it of group.items || []) {
    const title = String(it.title || it.noteTitle || '').trim();
    if (!title) continue;
    const tNorm = normLabel(title);
    const hit = labels.some((p) => {
      const pn = normLabel(p);
      return pn && tNorm && (tNorm.includes(pn) || pn.includes(tNorm));
    });
    if (hit) matchedBvids.push(it.bvid);
  }
  if (matchedBvids.length) {
    if (
      pushAll(
        listChunksForBvids(matchedBvids, {
          limit: lim,
          perBvid: 8,
        })
      )
    ) {
      return chunks;
    }
  }

  pushAll(listChunksForBvids(bvids, { limit: lim, perBvid: 4 }));
  return chunks;
}

function outlineChildrenFromChunks(chunks, existingLabels) {
  const seen = new Set((existingLabels || []).map(normLabel).filter(Boolean));
  const out = [];
  for (const c of chunks || []) {
    let topic = cleanNodeLabel(c.heading, { maxLen: 16 });
    if (!topic) {
      const first = String(c.text || '')
        .split(/[\n。；;]/)
        .map((s) => cleanNodeLabel(s, { maxLen: 16 }))
        .find(Boolean);
      topic = first || '';
    }
    const key = normLabel(topic);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ topic, children: [] });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * 只为选中节点生成子节点细节；不改骨架、不写库（由前端挂到树上再保存）。
 * @param {string} groupId
 * @param {{ path?: string[], topic?: string, existingChildren?: string[] }} [opts]
 */
async function expandMindmapNode(groupId, opts = {}) {
  const key = String(groupId || '').trim();
  if (!key) return { ok: false, error: 'no_id', message: '课程组无效' };

  const group = getCourseGroup(key);
  if (!group) return { ok: false, error: 'not_found', message: '课程组不存在' };

  const pathLabels = (Array.isArray(opts.path) ? opts.path : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const topic =
    String(opts.topic || '').trim() ||
    pathLabels[pathLabels.length - 1] ||
    '';
  if (!topic && !pathLabels.length) {
    return { ok: false, error: 'no_node', message: '请先选中要展开的节点' };
  }
  if (pathLabels.length && pathLabels[pathLabels.length - 1] !== topic && topic) {
    pathLabels.push(topic);
  } else if (!pathLabels.length && topic) {
    pathLabels.push(topic);
  }

  const existingChildren = (opts.existingChildren || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  const chunks = gatherChunksForNodePath(group, pathLabels, { limit: 20 });
  if (!chunks.length) {
    return {
      ok: false,
      error: 'no_chunks',
      message: '找不到与该节点相关的笔记切块，请先写笔记',
    };
  }

  // 输出语言只跟本次用到的笔记切块走：英文切块→英文展开，中文切块→中文展开
  const contentLanguage = detectChunksLang(chunks);

  let children = [];
  let source = 'chunks_outline';

  if (!envFlag('LLM_ENABLED', false)) {
    children = outlineChildrenFromChunks(chunks, existingChildren);
  } else {
    try {
      const noteChunks = toNoteChunkPayload(chunks);
      const expandInstruction =
        contentLanguage === 'en'
          ? `Expand ONLY under the current node. Output relative Markdown (# = direct children). Do not change the parent path. ${langInstruction('en')}`
          : `只为当前节点补充子知识点；输出相对 Markdown（# 为直接子节点）。禁止改父路径。 ${langInstruction('zh')}`;
      const raw = await completeTask(
        'mindmap_expand',
        {
          group: { id: group.id, title: group.title },
          nodePath: pathLabels,
          currentTopic: topic || pathLabels[pathLabels.length - 1],
          existingChildren,
          noteChunks,
          contentLanguage,
          instruction: expandInstruction,
        },
        {
          max_tokens: 4096,
          timeoutMs: 90000,
          jsonMode: false,
          temperature: 0.3,
          // DeepSeek V4 默认 thinking=on，会占满 max_tokens 导致 content 空
          thinking: false,
          systemAppend: langSystemLock(contentLanguage),
        }
      );
      children = filterNewChildren(
        parseExpandChildren(raw, { lang: contentLanguage }),
        existingChildren
      );
      source = 'llm';
      if (!children.length) {
        return {
          ok: false,
          error: 'llm_empty',
          message: 'AI 未返回可新增的子节点',
          chunkCount: chunks.length,
        };
      }
    } catch (err) {
      console.warn('[bili-pet] mindmap expand LLM failed:', err.message || err);
      return {
        ok: false,
        error: 'llm_failed',
        message: `AI 展开失败：${err.message || err}`,
        chunkCount: chunks.length,
      };
    }
  }

  children = filterNewChildren(children, existingChildren);
  if (!children.length) {
    return {
      ok: false,
      error: 'no_new_children',
      message: '没有可新增的细节（可能已有足够子节点）',
      chunkCount: chunks.length,
    };
  }

  return {
    ok: true,
    groupId: group.id,
    topic: topic || pathLabels[pathLabels.length - 1],
    path: pathLabels,
    children,
    source,
    chunkCount: chunks.length,
  };
}

module.exports = {
  generateCourseMindmap,
  expandMindmapNode,
  outlineFromStructure,
  outlineFromChunks,
  mergeStructureMindmaps,
  sanitizeMindmapMd,
  cleanNodeLabel,
  extractMindmapMd,
  extractMdHeadings,
  parseExpandChildren,
  stripMindmapMetaComments,
  readMindmapMetaList,
  readMindmapMeta,
  writeMindmapMetaComments,
};
