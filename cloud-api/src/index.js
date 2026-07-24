'use strict';

require('dotenv').config();

const express = require('express');
const { authMiddleware, handleAuthBili } = require('./auth');
const { handleKbChanges, handleKbPush } = require('./kb');

const app = express();
app.use(express.json({ limit: '12mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bili-pet-cloud-api', ts: Date.now() });
});

app.post('/auth/bili', (req, res) => {
  handleAuthBili(req, res).catch((err) => {
    console.error('[cloud-api] auth/bili', err.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  });
});

app.get('/kb/changes', authMiddleware, (req, res) => {
  handleKbChanges(req, res).catch((err) => {
    console.error('[cloud-api] kb/changes', err.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  });
});

app.post('/kb/push', authMiddleware, (req, res) => {
  handleKbPush(req, res).catch((err) => {
    console.error('[cloud-api] kb/push', err.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  });
});

const port = Number(process.env.PORT) || 8787;
// 临时公网联调用 0.0.0.0；上 Nginx 后可改回 127.0.0.1
const host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`[cloud-api] listening on http://${host}:${port}`);
});
