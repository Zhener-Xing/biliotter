const path = require('path');
const { loadEnv } = require('./load-env');
const { completeTask } = require('./llm');
const {
  gatherCourseChunks,
  getCourseMindmap,
  saveCourseMindmap,
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

function extractMindmapMd(raw) {
  const parsed = tryParseJsonObject(raw);
  if (parsed) {
    const md = String(parsed.mindmap_md || parsed.mindmapMd || parsed.markdown || '').trim();
    if (md) return md;
  }
  const text = String(raw || '').trim();
  if (text.startsWith('#')) return text;
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
function sanitizeMindmapMd(md, groupTitle = '') {
  const rootTitle =
    cleanNodeLabel(groupTitle, { maxLen: 24 }) ||
    String(groupTitle || '').trim() ||
    '课程组';
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
    title = cleanNodeLabel(title, { maxLen: level <= 2 ? 16 : 20 });
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
  // 去重：同级连续同名合并
  const deduped = [];
  const seenAtDepth = new Map();
  for (const line of out) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const depth = m[1].length;
    const key = `${depth}::${m[2]}`;
    // 重置更深层级的 seen（进入新分支）
    for (const d of [...seenAtDepth.keys()]) {
      if (d > depth) seenAtDepth.delete(d);
    }
    if (seenAtDepth.get(depth) === m[2] && depth > 1) continue;
    // 全局同名 ## 去重（知识模块不应重复）
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
  const lines = [`# ${cleanNodeLabel(group.title, { maxLen: 24 }) || group.title || '课程组'}`];

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

async function generateCourseMindmap(groupId) {
  const packed = gatherCourseChunks(groupId, { limit: 36 });
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

  const { group, chunks } = packed;
  const prev = getCourseMindmap(groupId);
  const previousMindmapMd = prev.ok
    ? sanitizeMindmapMd(String(prev.mindmapMd || '').trim(), group.title)
    : '';

  // 不传 bvid / 原始视频标题，避免模型按视频分叉或标注 BV
  const noteChunks = chunks.map((c, i) => ({
    noteIndex: i + 1,
    heading: cleanNodeLabel(c.heading, { maxLen: 20 }),
    text: scrubChunkText(c.text, 500),
  }));

  let mindmapMd = '';
  let source = 'llm';

  if (!envFlag('LLM_ENABLED', false)) {
    mindmapMd = outlineFromChunks(group, chunks);
    source = 'chunks_outline';
  } else {
    try {
      const raw = await completeTask(
        'mindmap_course',
        {
          group: {
            id: group.id,
            title: group.title,
            topic: group.topic,
            itemCount: group.itemCount,
          },
          previousMindmapMd: previousMindmapMd || undefined,
          noteChunks,
          instruction:
            '按知识模块生成 mindmap_md：## 为模块名，### 为短知识点；禁止视频标题、禁止任何 BV/来源标注；跨笔记合并相同知识点；旧稿若按视频分叉必须改写。',
        },
        { max_tokens: 2500, timeoutMs: 90000, jsonMode: true }
      );
      mindmapMd = extractMindmapMd(raw);
      if (!mindmapMd) {
        mindmapMd = outlineFromChunks(group, chunks);
        source = 'chunks_outline_fallback';
      }
    } catch (err) {
      mindmapMd = outlineFromChunks(group, chunks);
      source = 'chunks_outline_error';
      console.warn('[bili-pet] mindmap LLM failed:', err.message || err);
    }
  }

  mindmapMd = sanitizeMindmapMd(mindmapMd, group.title);
  if (!mindmapMd.trim().startsWith('#')) {
    mindmapMd = `# ${group.title}\n\n${mindmapMd}`.trim() + '\n';
    mindmapMd = sanitizeMindmapMd(mindmapMd, group.title);
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
  };
}

module.exports = {
  generateCourseMindmap,
  outlineFromChunks,
  sanitizeMindmapMd,
  cleanNodeLabel,
};
