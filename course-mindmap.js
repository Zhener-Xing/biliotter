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

function outlineFromChunks(group, chunks) {
  const lines = [`# ${group.title || '课程组'}`];
  if (group.topic) lines.push(`## ${group.topic}`);

  const byBvid = new Map();
  for (const c of chunks) {
    const bv = c.bvid || 'unknown';
    if (!byBvid.has(bv)) byBvid.set(bv, []);
    byBvid.get(bv).push(c);
  }

  for (const [bvid, list] of byBvid) {
    const item = (group.items || []).find((i) => i.bvid === bvid);
    lines.push(`## ${item?.title || bvid}`);
    const seen = new Set();
    for (const c of list) {
      let heading = String(c.heading || '').trim();
      if (!heading) {
        const first = String(c.text || '')
          .split('\n')
          .map((s) => s.trim())
          .find(Boolean);
        heading = first ? first.slice(0, 40) : '';
      }
      heading = heading.replace(/^#+\s*/, '').trim();
      if (!heading || seen.has(heading)) continue;
      seen.add(heading);
      lines.push(`### ${heading} (${bvid})`);
      if (seen.size >= 8) break;
    }
  }
  return `${lines.join('\n')}\n`;
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
  const previousMindmapMd = prev.ok ? String(prev.mindmapMd || '').trim() : '';

  const noteChunks = chunks.map((c) => ({
    bvid: c.bvid,
    heading: c.heading || '',
    text: String(c.text || '').slice(0, 500),
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
          previousMindmapMd,
          noteChunks,
          instruction:
            '根据 noteChunks 生成 Markmap 可用的 mindmap_md 大纲；有 previousMindmapMd 则增量修订。',
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

  if (!mindmapMd.trim().startsWith('#')) {
    mindmapMd = `# ${group.title}\n\n${mindmapMd}`.trim() + '\n';
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
};
//AI维护的思维导图代码文件