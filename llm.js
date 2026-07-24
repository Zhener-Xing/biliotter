const { getSystemPrompt } = require('./prompts');
const {
  loadNoteDoc,
  saveNoteDoc,
  cornellToMarkdown,
} = require('./notes-db');

function envFlag(name, fallback = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function chatCompletion({
  messages,
  max_tokens = 120,
  timeoutMs,
  jsonMode = false,
} = {}) {
  const apiKey = String(process.env.LLM_API_KEY || '').trim();
  const base = String(process.env.LLM_API_BASE || 'https://api.openai.com/v1').replace(
    /\/$/,
    ''
  );
  const model = String(process.env.LLM_MODEL || 'gpt-4o-mini').trim();
  const waitMs = timeoutMs ?? envInt('LLM_TIMEOUT_MS', 20000);

  if (!apiKey) {
    throw new Error('缺少 LLM_API_KEY（请复制 .env.example 为 .env 并填写）');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);

  try {
    const body = {
      model,
      temperature: 0.6,
      max_tokens,
      messages,
    };
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.error?.message || data?.message || res.statusText;
      if (jsonMode && res.status === 400 && /response_format|json_object/i.test(String(detail))) {
        clearTimeout(timer);
        return chatCompletion({
          messages,
          max_tokens,
          timeoutMs: waitMs,
          jsonMode: false,
        });
      }
      throw new Error(`LLM HTTP ${res.status}: ${detail}`);
    }

    const text = data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== 'string') {
      throw new Error('LLM 返回空内容');
    }
    return String(text).trim();
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`LLM 请求超时（>${waitMs}ms）`);
    }
    
    if (err instanceof Error && /^LLM HTTP |无法连接 LLM|缺少 LLM_API_KEY|LLM 返回空|LLM 请求超时/.test(err.message)) {
      throw err;
    }
    const cause = err?.cause;
    const code = cause?.code || cause?.errno || '';
    const detail = [err?.message, code && `code=${code}`, cause?.message]
      .filter(Boolean)
      .join(' | ');
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
      throw new Error(
        `无法连接 LLM 接口（${detail}）。请检查 .env 里 LLM_API_BASE 是否可访问`
      );
    }
    throw new Error(detail || String(err));
  } finally {
    clearTimeout(timer);
  }
}

async function completeTask(taskId, userContent, opts = {}) {
  const system = getSystemPrompt(taskId);
  const content =
    typeof userContent === 'string'
      ? userContent
      : JSON.stringify(userContent, null, 2);

  return chatCompletion({
    max_tokens: opts.max_tokens ?? 1200,
    timeoutMs: opts.timeoutMs,
    jsonMode: Boolean(opts.jsonMode),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  });
}

function tryParseJson(slice) {
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function repairTruncatedNotesJson(slice) {
  let s = String(slice || '').trim();
  if (!s.startsWith('{')) return null;

  const repaired = tryParseJson(s);
  if (repaired) return repaired;

  s = s.replace(/\\+$/, '');
  if ((s.match(/"/g) || []).length % 2 === 1) s += '"';
  for (const tail of ['"}', '"\n}', '\n}', '}']) {
    const parsed = tryParseJson(s + tail);
    if (parsed && (parsed.ai_md || parsed.aiMd || parsed.body_md || parsed.bodyMd)) {
      return parsed;
    }
  }
  return null;
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('笔记返回为空');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');

  if (start >= 0 && end > start) {
    const slice = body.slice(start, end + 1);
    const parsed = tryParseJson(slice) || repairTruncatedNotesJson(slice);
    if (parsed) return parsed;
  }

  // 未播完二次整理时，模型有时直接吐 Markdown；兜底成笔记对象
  if (start < 0 && body.length > 0) {
    return { title: '', body_md: body };
  }

  const repaired = start >= 0 ? repairTruncatedNotesJson(body.slice(start)) : null;
  if (repaired) return repaired;

  throw new Error('笔记返回不是 JSON 对象');
}

const AI_ORG_START = '<!-- bili-pet:ai-organize:start -->';
const AI_ORG_END = '<!-- bili-pet:ai-organize:end -->';
const AI_ORG_RE =
  /<!--\s*bili-pet:ai-organize:start\s*-->[\s\S]*?<!--\s*bili-pet:ai-organize:end\s*-->/gi;

function normalizeMdBlock(text) {
  const s = String(text || '').replace(/\s+$/, '');
  return s ? `${s}\n` : '';
}

function splitOrganizeBody(bodyMd) {
  const raw = String(bodyMd || '');
  const re =
    /<!--\s*bili-pet:ai-organize:start\s*-->\s*([\s\S]*?)\s*<!--\s*bili-pet:ai-organize:end\s*-->/i;
  const m = raw.match(re);
  if (!m) {
    return {
      userBodyMd: normalizeMdBlock(raw),
      previousAiMd: '',
    };
  }
  const userBodyMd = normalizeMdBlock(raw.replace(AI_ORG_RE, '').trimEnd());
  return {
    userBodyMd,
    previousAiMd: String(m[1] || '').trim(),
  };
}

function mergeOrganizeBody(userBodyMd, aiMd) {
  const user = normalizeMdBlock(userBodyMd).replace(AI_ORG_RE, '').trimEnd();
  const ai = String(aiMd || '').trim();
  if (!ai) {
    return user ? `${user}\n` : '';
  }
  const block = `${AI_ORG_START}\n${ai}\n${AI_ORG_END}\n`;
  if (!user) return block;
  return `${user}\n\n${block}`;
}

function parseCollabJson(raw, userBodyMd = '') {
  const data = extractJsonObject(raw);
  const aiMd = String(data.ai_md || data.aiMd || data.additions_md || data.additionsMd || '').trim();
  let legacyBody = String(data.body_md || data.bodyMd || '').trim();
  if (!aiMd && legacyBody) {
    const user = String(userBodyMd || '').trim();
    if (user) {
      if (legacyBody === user) {
        legacyBody = '';
      } else if (legacyBody.startsWith(user)) {
        legacyBody = legacyBody.slice(user.length).trim();
      } else if (legacyBody.includes(user)) {
        legacyBody = legacyBody.replace(user, '').trim();
      }
    }
  }
  const resolvedAi = aiMd || legacyBody;
  if (!resolvedAi) throw new Error('协同笔记未返回 ai_md');
  return {
    title: String(data.title || '').trim(),
    aiMd: resolvedAi.endsWith('\n') ? resolvedAi : `${resolvedAi}\n`,
  };
}

const MAX_ORGANIZE_TRANSCRIPT_CHARS = 12000;

function pickTranscriptText(payload = {}) {
  const full = String(payload.fullSubtitleText || '').trim();
  const live = String(payload.transcriptText || '').trim();
  const t = Number(payload.modelInput?.playback?.t ?? payload.currentTime ?? 0);
  const duration = Number(payload.modelInput?.video?.duration || payload.duration || 0);

  let text = '';
  if (full) {
    text = full;
    if (Number.isFinite(t) && t > 0 && Number.isFinite(duration) && duration > 30) {
      const ratio = Math.min(1, Math.max(0.05, t / duration));
      const cut = Math.max(200, Math.ceil(full.length * ratio * 1.15));
      text = full.slice(0, cut);
    } else if (live && live.length >= Math.min(full.length, 200)) {
      text = live;
    }
  } else {
    text = live;
  }

  if (!text) return '';
  if (text.length <= MAX_ORGANIZE_TRANSCRIPT_CHARS) return text;
  return text.slice(0, MAX_ORGANIZE_TRANSCRIPT_CHARS);
}

function buildNotesUserPayload(payload) {
  const modelInput = payload.modelInput || null;
  const video = modelInput?.video || {};

  return {
    video: {
      title: video.title || payload.title || '',
      owner: video.owner || '',
      bvid: video.bvid || payload.bvid || '',
      part: video.part || '',
      duration: video.duration || 0,
    },
    playback: {
      t: modelInput?.playback?.t ?? payload.currentTime ?? 0,
      paused: Boolean(payload.paused),
      reason: payload.reason || null,
    },
    transcriptText: pickTranscriptText(payload),
    contextText:
      payload.contextText ||
      modelInput?.context?.text ||
      payload.currentSubtitle?.content ||
      '',
  };
}

function buildCollabUserPayload(payload, userBodyMd, previousAiMd = '') {
  return {
    ...buildNotesUserPayload(payload),
    instruction:
      '只生成/更新 AI 补充（ai_md）。不要改写 userBodyMd；结合片头到当前进度的完整已看字幕，在 previousAiMd 基础上增补，禁止只根据最近一段字幕整页重写。',
    userBodyMd: String(userBodyMd || ''),
    previousAiMd: String(previousAiMd || ''),
    用户正文: String(userBodyMd || ''),
    上次AI补充: String(previousAiMd || ''),
  };
}

function createNotesOrganizer(hooks = {}) {
  const enabled = envFlag('LLM_ENABLED', false);
  const notesTimeout = envInt('LLM_NOTES_TIMEOUT_MS', 60000);
  let inflight = false;
  let previousNotes = null;
  let previousBodyMd = '';
  let currentBvid = null;

  function bindNotes(bvid) {
    const key = String(bvid || '').trim() || null;
    currentBvid = key;
    const doc = key ? loadNoteDoc(key) : null;
    previousNotes = doc?.notes || null;
    previousBodyMd = doc?.bodyMd || (previousNotes ? cornellToMarkdown(previousNotes) : '');
    return doc;
  }

  function emitDoc(doc, meta = {}) {
    if (!doc) return;
    hooks.onUpdate?.(doc.notes || { title: doc.title, cues: [], notes: [], summary: '' }, {
      ...meta,
      doc,
      bodyMd: doc.bodyMd,
      mode: doc.mode || 'user',
    });
  }

  function resetForSession(payload) {
    const bvid = payload?.bvid || payload?.modelInput?.video?.bvid || null;
    if (bvid) {
      bindNotes(bvid);
    } else {
      previousNotes = null;
      previousBodyMd = '';
      currentBvid = null;
    }
  }

  async function organizeOnce({ payload = null, bodyMd = null, bvid = null, title = '' } = {}) {
    if (!enabled) {
      hooks.onStatus?.('未启用 LLM（检查 .env 的 LLM_ENABLED）');
      return { ok: false, error: 'llm_disabled' };
    }
    if (inflight) {
      hooks.onStatus?.('正在整理中，请稍候…');
      return { ok: false, error: 'inflight' };
    }

    const ev = payload || {};
    const key =
      String(bvid || ev.bvid || ev.modelInput?.video?.bvid || currentBvid || '').trim() || null;
    if (!key) {
      hooks.onStatus?.('尚无视频，无法整理');
      return { ok: false, error: 'no_bvid' };
    }

    bindNotes(key);
    const sourceBody = bodyMd != null ? String(bodyMd) : previousBodyMd || '';
    const { userBodyMd, previousAiMd } = splitOrganizeBody(sourceBody);
    const transcript = pickTranscriptText(ev);
    const context =
      ev.contextText ||
      ev.modelInput?.context?.text ||
      ev.currentSubtitle?.content ||
      '';
    if (!userBodyMd.trim() && !previousAiMd.trim() && !transcript && !context) {
      hooks.onStatus?.('没有可整理的内容');
      return { ok: false, error: 'empty' };
    }

    inflight = true;
    hooks.onStatus?.('正在一键整理…');
    try {
      const raw = await completeTask(
        'notes_collab',
        buildCollabUserPayload(ev, userBodyMd, previousAiMd),
        { max_tokens: 2500, timeoutMs: notesTimeout, jsonMode: true }
      );
      const collab = parseCollabJson(raw, userBodyMd);
      const nextAi = String(collab.aiMd || '').trim() || previousAiMd;
      const mergedBody = mergeOrganizeBody(userBodyMd, nextAi);
      const existingTitle =
        title || ev.title || previousNotes?.title || loadNoteDoc(key)?.title || '';
      const doc = saveNoteDoc(key, {
        mode: 'user',
        bodyMd: mergedBody,
        title: existingTitle || collab.title || '',
        sessionId: ev.sessionId || null,
        notes: previousNotes,
      });
      previousBodyMd = doc?.bodyMd || mergedBody;
      previousNotes = doc?.notes || previousNotes;
      currentBvid = key;
      emitDoc(doc, {
        sessionId: ev.sessionId || null,
        bvid: key,
        final: true,
        fromDb: false,
        organized: true,
      });
      hooks.onStatus?.('一键整理完成，已写入数据库');
      return { ok: true, doc };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      hooks.onError?.(error);
      hooks.onStatus?.(`整理失败：${error.message}`);
      return { ok: false, error: error.message };
    } finally {
      inflight = false;
    }
  }

  async function maybeHandle(payload) {
    if (!payload?.kind) return;
    if (payload.kind === 'session_start') {
      resetForSession(payload);
      hooks.onStatus?.(
        currentBvid
          ? '已切换视频'
          : '开始手写笔记'
      );
    }
  }

  return {
    enabled,
    maybeHandle,
    organizeOnce,
    loadForBvid: (bvid) => bindNotes(bvid),
  };
}

module.exports = {
  createNotesOrganizer,
  chatCompletion,
  completeTask,
};
//llm 接口代码文件，切块逻辑和喂给大模型的东西都在这里，然而这是AI维护的部分。对我来说快黑箱了
//改成向量逻辑还是要动这一块儿