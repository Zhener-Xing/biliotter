'use strict';

require('dotenv').config();

const express = require('express');
const { authMiddleware, handleAuthBili, handleAuthDevice } = require('./auth');
const { handleKbChanges, handleKbPush, handleKbRevision } = require('./kb');
const {
  handlePresence,
  handleCreateInvite,
  handleCancelInvite,
  handleGetInvite,
  handleJoinInvite,
  handleListFriends,
  handleRemoveFriend,
  handlePetFriend,
  handlePetInbox,
  handlePetInboxAck,
} = require('./friends');
const {
  handleShareNote,
  handleNoteInbox,
  handleAcceptNote,
  handleRejectNote,
} = require('./note-share');
const { handleLlmChatCompletions, llmConfigured } = require('./llm-proxy');

const app = express();
app.use(express.json({ limit: '12mb' }));

function wrap(name, fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[cloud-api] ${name}`, err.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    });
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bili-pet-cloud-api',
    ts: Date.now(),
    llmProxy: llmConfigured(),
  });
});

app.post('/auth/bili', wrap('auth/bili', handleAuthBili));
app.post('/auth/device', wrap('auth/device', handleAuthDevice));

app.post(
  '/llm/chat/completions',
  authMiddleware,
  wrap('llm/chat', handleLlmChatCompletions)
);

app.get('/kb/revision', authMiddleware, wrap('kb/revision', handleKbRevision));
app.get('/kb/changes', authMiddleware, wrap('kb/changes', handleKbChanges));
app.post('/kb/push', authMiddleware, wrap('kb/push', handleKbPush));

app.post('/friends/presence', authMiddleware, wrap('friends/presence', handlePresence));
app.get('/friends/invite', authMiddleware, wrap('friends/invite:get', handleGetInvite));
app.post('/friends/invite', authMiddleware, wrap('friends/invite:create', handleCreateInvite));
app.delete('/friends/invite', authMiddleware, wrap('friends/invite:cancel', handleCancelInvite));
app.post('/friends/join', authMiddleware, wrap('friends/join', handleJoinInvite));
app.get('/friends', authMiddleware, wrap('friends/list', handleListFriends));
app.delete('/friends/:uid', authMiddleware, wrap('friends/remove', handleRemoveFriend));
app.post('/friends/pet', authMiddleware, wrap('friends/pet', handlePetFriend));
app.get('/friends/pet-inbox', authMiddleware, wrap('friends/pet-inbox', handlePetInbox));
app.post('/friends/pet-inbox/ack', authMiddleware, wrap('friends/pet-inbox/ack', handlePetInboxAck));

app.post('/friends/notes/share', authMiddleware, wrap('friends/notes/share', handleShareNote));
app.get('/friends/notes/inbox', authMiddleware, wrap('friends/notes/inbox', handleNoteInbox));
app.post(
  '/friends/notes/inbox/:id/accept',
  authMiddleware,
  wrap('friends/notes/accept', handleAcceptNote)
);
app.post(
  '/friends/notes/inbox/:id/reject',
  authMiddleware,
  wrap('friends/notes/reject', handleRejectNote)
);

const port = Number(process.env.PORT) || 8787;
// 临时公网联调用 0.0.0.0；上 Nginx 后可改回 127.0.0.1
const host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`[cloud-api] listening on http://${host}:${port}`);
});
