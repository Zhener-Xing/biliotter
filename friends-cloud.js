'use strict';

const { cloudEnabled, loadToken, apiFetch } = require('./cloud-sync');
const { isAccountOpsReady } = require('./session-gate');

const INBOX_POLL_MS = 8_000;
const PRESENCE_MS = 30_000;

/** @type {null | ((event: object) => void)} */
let broadcast = null;
let started = false;
let inboxTimer = null;
let presenceTimer = null;
let polling = false;
/** @type {Set<number>} */
const seenEventIds = new Set();

function getUname() {
  return loadToken()?.uname || null;
}

async function cloudCall(pathname, { method = 'GET', body = null } = {}) {
  if (!cloudEnabled()) return { ok: false, error: 'cloud_disabled' };
  const session = loadToken();
  if (!session?.token) return { ok: false, error: 'no_token' };
  try {
    const data = await apiFetch(pathname, {
      method,
      body,
      token: session.token,
      timeoutMs: 12_000,
    });
    return data && typeof data === 'object' ? data : { ok: false, error: 'bad_response' };
  } catch (err) {
    return {
      ok: false,
      error: err?.data?.error || err.message || String(err),
      status: err?.status,
      data: err?.data || null,
      retryAfterMs: err?.data?.retryAfterMs,
    };
  }
}

function emitFriendEvent(partial) {
  const event = {
    v: 1,
    source: 'bili-pet-friends',
    ts: Date.now(),
    ...partial,
  };
  try {
    broadcast?.(event);
  } catch (err) {
    console.warn('[bili-pet] friends broadcast failed:', err.message || err);
  }
  return event;
}

async function heartbeat() {
  if (!isAccountOpsReady() || !cloudEnabled()) return;
  await cloudCall('/friends/presence', {
    method: 'POST',
    body: { uname: getUname() },
  });
}

async function pollPetInbox() {
  if (polling) return;
  if (!isAccountOpsReady() || !cloudEnabled()) return;
  polling = true;
  try {
    const data = await cloudCall(
      `/friends/pet-inbox${getUname() ? `?uname=${encodeURIComponent(getUname())}` : ''}`,
      { method: 'GET' }
    );
    if (!data?.ok || !Array.isArray(data.events) || !data.events.length) return;

    const ackIds = [];
    // Offline first (one aggregated), then live — play offline once, then lives
    const offline = data.events.filter((e) => e.kind === 'offline');
    const live = data.events.filter((e) => e.kind === 'live');
    const ordered = [...offline, ...live];

    let delayMs = 0;
    for (const ev of ordered) {
      const id = Number(ev.id);
      if (!Number.isFinite(id)) continue;
      if (seenEventIds.has(id)) {
        ackIds.push(id);
        continue;
      }
      seenEventIds.add(id);
      if (seenEventIds.size > 400) {
        const first = seenEventIds.values().next().value;
        seenEventIds.delete(first);
      }
      ackIds.push(id);
      const payload = {
        kind: 'friend_pet',
        mode: ev.kind,
        multi: Boolean(ev.multi),
        message: String(ev.message || ''),
        fromUid: ev.fromUid || null,
        fromUname: ev.fromUname || null,
        fromCount: Number(ev.fromCount) || 1,
        eventId: id,
      };
      if (delayMs <= 0) emitFriendEvent(payload);
      else {
        setTimeout(() => emitFriendEvent(payload), delayMs);
      }
      delayMs += 5200;
    }

    if (ackIds.length) {
      await cloudCall('/friends/pet-inbox/ack', {
        method: 'POST',
        body: { ids: ackIds },
      });
    }
  } finally {
    polling = false;
  }
}

async function listFriends() {
  return cloudCall('/friends');
}

async function getInvite() {
  return cloudCall('/friends/invite');
}

async function createInvite(pin, ttlMs) {
  return cloudCall('/friends/invite', {
    method: 'POST',
    body: { pin, ttlMs },
  });
}

async function cancelInvite() {
  return cloudCall('/friends/invite', { method: 'DELETE' });
}

async function joinInvite(pin) {
  return cloudCall('/friends/join', {
    method: 'POST',
    body: { pin, uname: getUname() },
  });
}

async function removeFriend(uid) {
  return cloudCall(`/friends/${encodeURIComponent(uid)}`, { method: 'DELETE' });
}

async function petFriend(toUid) {
  return cloudCall('/friends/pet', {
    method: 'POST',
    body: { toUid, uname: getUname() },
  });
}

async function shareNote(payload) {
  return cloudCall('/friends/notes/share', {
    method: 'POST',
    body: {
      toUid: payload?.toUid,
      bvid: payload?.bvid,
      title: payload?.title,
      bodyMd: payload?.bodyMd,
      notes: payload?.notes,
      mode: payload?.mode,
      uname: getUname(),
    },
  });
}

async function listNoteInbox() {
  return cloudCall('/friends/notes/inbox');
}

async function acceptNoteShare(id) {
  return cloudCall(`/friends/notes/inbox/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    body: {},
  });
}

async function rejectNoteShare(id) {
  return cloudCall(`/friends/notes/inbox/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: {},
  });
}

/** @type {Set<number>} */
const seenNoteShareIds = new Set();

async function pollNoteInboxNotify() {
  if (!isAccountOpsReady() || !cloudEnabled()) return;
  const data = await listNoteInbox();
  if (!data?.ok || !Array.isArray(data.shares)) return;
  for (const s of data.shares) {
    const id = Number(s.id);
    if (!Number.isFinite(id) || seenNoteShareIds.has(id)) continue;
    seenNoteShareIds.add(id);
    if (seenNoteShareIds.size > 400) {
      const first = seenNoteShareIds.values().next().value;
      seenNoteShareIds.delete(first);
    }
    const title = String(s.title || s.bvid || '笔记').slice(0, 40);
    emitFriendEvent({
      kind: 'friend_note_offer',
      message: `「${s.fromUname}」给你传来笔记「${title}」，右键打开好友面板接收`,
      shareId: id,
      fromUid: s.fromUid,
      fromUname: s.fromUname,
      title,
      bvid: s.bvid,
    });
  }
}

function startFriendsCloud({ onBroadcast } = {}) {
  if (started) return;
  started = true;
  broadcast = typeof onBroadcast === 'function' ? onBroadcast : null;

  if (!cloudEnabled()) {
    console.log('[bili-pet] friends cloud disabled (no CLOUD_API_BASE)');
    return;
  }

  const tickInbox = () => {
    void pollPetInbox();
    void pollNoteInboxNotify();
  };
  const tickPresence = () => {
    void heartbeat();
  };

  inboxTimer = setInterval(tickInbox, INBOX_POLL_MS);
  presenceTimer = setInterval(tickPresence, PRESENCE_MS);
  if (typeof inboxTimer.unref === 'function') inboxTimer.unref();
  if (typeof presenceTimer.unref === 'function') presenceTimer.unref();

  setTimeout(() => {
    void heartbeat();
    void pollPetInbox();
    void pollNoteInboxNotify();
  }, 1500);

  console.log(
    `[bili-pet] friends cloud enabled (inbox ${INBOX_POLL_MS}ms, presence ${PRESENCE_MS}ms)`
  );
}

function stopFriendsCloud() {
  if (inboxTimer) clearInterval(inboxTimer);
  if (presenceTimer) clearInterval(presenceTimer);
  inboxTimer = null;
  presenceTimer = null;
  started = false;
  broadcast = null;
  seenEventIds.clear();
  seenNoteShareIds.clear();
}

module.exports = {
  startFriendsCloud,
  stopFriendsCloud,
  listFriends,
  getInvite,
  createInvite,
  cancelInvite,
  joinInvite,
  removeFriend,
  petFriend,
  shareNote,
  listNoteInbox,
  acceptNoteShare,
  rejectNoteShare,
  pollPetInbox,
  pollNoteInboxNotify,
  heartbeat,
};
