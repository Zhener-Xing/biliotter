'use strict';

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function llmConfigured() {
  return Boolean(String(process.env.LLM_API_KEY || '').trim());
}

function normalizeLlmApiBase(raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) base = 'https://api.openai.com/v1';
  if (!/\/v\d+$/i.test(base)) base = `${base}/v1`;
  return base;
}

async function handleLlmChatCompletions(req, res) {
  const apiKey = String(process.env.LLM_API_KEY || '').trim();
  if (!apiKey) {
    res.status(503).json({ ok: false, error: 'llm_not_configured' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    res.status(400).json({ ok: false, error: 'messages_required' });
    return;
  }

  const maxTokensCap = envInt('LLM_PROXY_MAX_TOKENS', 4096);
  const maxTokens = Math.min(
    Math.max(1, Number(body.max_tokens) || 1200),
    maxTokensCap
  );
  const temperature = Number.isFinite(Number(body.temperature))
    ? Number(body.temperature)
    : 0.6;

  const upstreamBase = normalizeLlmApiBase(
    process.env.LLM_API_BASE || 'https://api.openai.com/v1'
  );
  const model = String(process.env.LLM_MODEL || 'gpt-4o-mini').trim();
  const timeoutMs = envInt('LLM_TIMEOUT_MS', 60000);

  const upstreamBody = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (body.response_format && typeof body.response_format === 'object') {
    upstreamBody.response_format = body.response_format;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(`${upstreamBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });

    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err) {
    if (err?.name === 'AbortError') {
      res.status(504).json({ ok: false, error: 'llm_upstream_timeout' });
      return;
    }
    console.error('[cloud-api] llm proxy', err?.message || err);
    res.status(502).json({
      ok: false,
      error: 'llm_upstream_error',
      detail: err?.message || String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  handleLlmChatCompletions,
  llmConfigured,
};
