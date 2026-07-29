'use strict';

/**
 * 笔记成熟后后台预生成选择题，写入本地 quiz_bank。
 * /game 开局优先从题库取题，避免当场等 LLM。
 */

const { completeTask } = require('./llm');
const {
  loadNoteDoc,
  getActiveUid,
  assessNoteQuizMaturity,
  getQuizBankMetaForBvid,
  saveQuizBankQuestions,
} = require('./notes-db');

const TARGET_PER_NOTE = 5;
const PREGEN_BATCH = 3;
const DEBOUNCE_MS = 10_000;
const PREGEN_TIMEOUT_MS = 28_000;
const CORPUS_LIMIT = 1400;
const CORPUS_PER_NOTE = 420;
const AI_ORG_STRIP_RE =
  /<!--\s*bili-pet:ai-organize:start\s*-->[\s\S]*?<!--\s*bili-pet:ai-organize:end\s*-->/gi;

/** @type {Map<string, { timer: NodeJS.Timeout | null, attempts: number }>} */
const jobs = new Map();
/** @type {Set<string>} */
const inflight = new Set();

function envFlag(name, fallback = true) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function quizPregenEnabled() {
  if (!envFlag('LLM_ENABLED', true)) return false;
  if (!String(process.env.LLM_API_KEY || '').trim()) {
    // 无本地 key 时：有云端基址即可（走后方代理）
    if (!String(process.env.CLOUD_API_BASE || '').trim()) return false;
  }
  return envFlag('QUIZ_PREGEN_ENABLED', true);
}

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

function noteQuizExcerpt(doc) {
  const structured = doc?.notes;
  if (
    structured &&
    (structured.notes?.length || structured.summary || structured.cues?.length)
  ) {
    const lines = [];
    for (const item of (structured.notes || []).slice(0, 8)) {
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
    return lines.join('\n').trim();
  }

  const body = String(doc?.bodyMd || '')
    .replace(AI_ORG_STRIP_RE, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!body) return '';
  const points = extractMdSection(body, '要点');
  const summary = extractMdSection(body, '总结');
  const dense = [points, summary && `总结：\n${summary}`].filter(Boolean).join('\n\n');
  return (dense || body).trim();
}

function buildPregenCorpus(doc) {
  const text = noteQuizExcerpt(doc).slice(0, CORPUS_PER_NOTE);
  if (!text) return '';
  const title = doc.title || '';
  const block = `[${doc.bvid}${title ? ` · ${title}` : ''}]\n${text}`;
  return block.slice(0, CORPUS_LIMIT);
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
    let choices = Array.isArray(item.choices)
      ? item.choices.map((c) => String(c || '').trim())
      : [];
    if (choices.length > 4) choices = choices.slice(0, 4);
    while (choices.length < 4) choices.push(`选项${choices.length + 1}`);
    if (!q || choices.some((c) => !c)) continue;
    let answer = Number(item.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) {
      const key = String(item.answer || '').trim().toUpperCase();
      answer = { A: 0, B: 1, C: 2, D: 3 }[key];
    }
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) continue;
    out.push({
      q,
      choices,
      answer,
      explain: String(item.explain || '').trim(),
      sourceBvid: String(item.sourceBvid || item.bvid || '').trim(),
    });
    if (out.length >= PREGEN_BATCH) break;
  }
  return out;
}

async function generateQuestionsForNote(doc, need) {
  const n = Math.max(1, Math.min(PREGEN_BATCH, Number(need) || PREGEN_BATCH));
  const excerpts = buildPregenCorpus(doc);
  if (!excerpts.trim()) return [];

  const raw = await completeTask(
    'game_quiz',
    {
      maxQuestions: n,
      scope: doc.title || doc.bvid,
      excerpts,
      existingQuestions: [],
    },
    {
      max_tokens: n <= 1 ? 480 : n <= 2 ? 780 : 1100,
      timeoutMs: PREGEN_TIMEOUT_MS,
      jsonMode: true,
      temperature: 0.3,
    }
  );
  const parsed = parseJsonObject(raw);
  return normalizeQuestions(parsed?.questions).map((q) => ({
    ...q,
    sourceBvid: q.sourceBvid || doc.bvid,
  }));
}

async function runPregen(bvid) {
  const key = String(bvid || '').trim();
  if (!key || !quizPregenEnabled()) return { ok: false, skipped: true };
  if (!getActiveUid()) return { ok: false, skipped: true, reason: 'no_uid' };
  if (inflight.has(key)) return { ok: false, skipped: true, reason: 'inflight' };

  inflight.add(key);
  try {
    const doc = loadNoteDoc(key);
    if (!doc) return { ok: false, skipped: true, reason: 'no_doc' };

    const maturity = assessNoteQuizMaturity(doc);
    if (!maturity.ok) {
      return { ok: false, skipped: true, reason: maturity.reason, score: maturity.score };
    }

    const meta = getQuizBankMetaForBvid(key);
    const rev = Number(doc.revision) || 0;
    // 题库已满且基于当前/更新 revision → 跳过
    if (meta.count >= TARGET_PER_NOTE && meta.maxSourceRev >= rev) {
      return { ok: true, skipped: true, reason: 'bank_full' };
    }

    const need = Math.max(0, TARGET_PER_NOTE - meta.count);
    // 笔记修订后：即使已有题，也再补一批对齐新内容（不超过 TARGET）
    const batchNeed =
      meta.maxSourceRev < rev
        ? Math.min(PREGEN_BATCH, Math.max(need, PREGEN_BATCH))
        : need;
    if (batchNeed <= 0) {
      return { ok: true, skipped: true, reason: 'bank_full' };
    }

    const questions = await generateQuestionsForNote(doc, batchNeed);
    if (!questions.length) {
      return { ok: false, error: 'empty_questions' };
    }

    // 修订后先清旧题再写入，避免过时题混用
    if (meta.maxSourceRev > 0 && meta.maxSourceRev < rev && meta.count > 0) {
      const { deleteQuizBankForBvid } = require('./notes-db');
      deleteQuizBankForBvid(key);
    }

    const saved = saveQuizBankQuestions(key, questions, { sourceRev: rev });
    console.log(
      `[bili-pet] quiz pregen bvid=${key} saved=${saved.saved || 0} score=${maturity.score} rev=${rev}`
    );
    const after = getQuizBankMetaForBvid(key);
    if (saved.ok && after.count < TARGET_PER_NOTE && (saved.saved || 0) > 0) {
      scheduleQuizPregenForNote(key, { reason: 'top_up', immediate: true });
    }
    return { ok: Boolean(saved.ok), saved: saved.saved || 0 };
  } catch (err) {
    console.warn('[bili-pet] quiz pregen failed:', key, err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  } finally {
    inflight.delete(key);
  }
}

/**
 * 防抖调度：笔记连续保存时只在安静后跑一次。
 * @param {string} bvid
 * @param {{ reason?: string, immediate?: boolean }} [opts]
 */
function scheduleQuizPregenForNote(bvid, { reason = 'save', immediate = false } = {}) {
  const key = String(bvid || '').trim();
  if (!key || !quizPregenEnabled()) return;

  const existing = jobs.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const job = {
    timer: null,
    attempts: existing?.attempts || 0,
    reason,
  };
  jobs.set(key, job);

  const delay = immediate ? 400 : DEBOUNCE_MS;
  job.timer = setTimeout(() => {
    job.timer = null;
    jobs.delete(key);
    void runPregen(key);
  }, delay);
  if (typeof job.timer.unref === 'function') job.timer.unref();
}

module.exports = {
  scheduleQuizPregenForNote,
  runPregen,
  quizPregenEnabled,
  TARGET_PER_NOTE,
};
