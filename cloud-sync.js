'use strict';

const fs = require('fs');
const path = require('path');
const {
  setOnLocalWriteHook,
  hasPendingSync,
  buildPendingPushPayload,
  clearPending,
  getCloudRevision,
  setCloudRevision,
  applyRemoteChanges,
  setActiveUid,
  getActiveUid,
} = require('./notes-db');

const TOKEN_FILE = path.join(__dirname, '.bili-pet-cloud-token.json');
const PULL_INTERVAL_MS = 30_000;
const PUSH_DEBOUNCE_MS = 1500;
const QUIT_PUSH_TIMEOUT_MS = 12_000;

/** @type {null | ((event: object) => void)} */
let broadcast = null;
let pushTimer = null;
let pullTimer = null;
let pushing = false;
let pulling = false;
let started = false;

function apiBase() {
  return String(process.env.CLOUD_API_BASE || '')
    .trim()
    .replace(/\/+$/, '');
}

function cloudEnabled() {
  return Boolean(apiBase());
}

function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const token = String(raw.token || '').trim();
    const uid = String(raw.uid || '').trim();
    const expiresAt = Number(raw.expiresAt) || 0;
    if (!token || !uid) return null;
    if (expiresAt && expiresAt < Date.now() - 5_000) return null;
    return { token, uid, expiresAt };
  } catch {
    return null;
  }
}

function saveToken(session) {
  const payload = {
    token: String(session?.token || ''),
    uid: String(session?.uid || ''),
    expiresAt: Number(session?.expiresAt) || 0,
    savedAt: Date.now(),
  };
  fs.writeFileSync(TOKEN_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function clearToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch {
    /* ignore */
  }
}

function emitSyncState(status, extra = {}) {
  const event = {
    v: 1,
    source: 'bili-pet-sync',
    kind: 'sync_state',
    ts: Date.now(),
    status,
    uid: getActiveUid(),
    cloudEnabled: cloudEnabled(),
    hasPending: hasPendingSync(),
    ...extra,
  };
  try {
    broadcast?.(event);
  } catch (err) {
    console.warn('[bili-pet] sync broadcast failed:', err.message || err);
  }
  return event;
}

async function apiFetch(pathname, { method = 'GET', body = null, token = null } = {}) {
  const base = apiBase();
  if (!base) throw new Error('cloud_disabled');
  const headers = { Accept: 'application/json' };
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function authenticateWithCookie(cookieHeader) {
  if (!cloudEnabled()) {
    return { ok: false, error: 'cloud_disabled' };
  }
  const cookie = String(cookieHeader || '').trim();
  if (!cookie) return { ok: false, error: 'missing_cookie' };

  emitSyncState('auth');
  try {
    const data = await apiFetch('/auth/bili', {
      method: 'POST',
      body: { cookieHeader: cookie },
    });
    if (!data?.ok || !data.token || !data.uid) {
      emitSyncState('auth_error', { error: data?.error || 'auth_failed' });
      return { ok: false, error: data?.error || 'auth_failed' };
    }
    saveToken(data);
    emitSyncState('authenticated', { uid: data.uid });
    return { ok: true, uid: data.uid, expiresAt: data.expiresAt };
  } catch (err) {
    emitSyncState('auth_error', { error: err.message || String(err) });
    return { ok: false, error: err.message || String(err) };
  }
}

async function pushPending({ reason = 'manual' } = {}) {
  if (!cloudEnabled()) return { ok: true, skipped: true, reason: 'cloud_disabled' };
  if (pushing) return { ok: true, skipped: true, reason: 'busy' };
  if (!hasPendingSync()) return { ok: true, skipped: true, reason: 'empty' };

  const session = loadToken();
  const active = getActiveUid();
  if (!session?.token) {
    emitSyncState('push_skipped', { reason: 'no_token' });
    return { ok: false, error: 'no_token' };
  }
  if (active && session.uid && session.uid !== active) {
    emitSyncState('push_skipped', {
      reason: 'token_uid_mismatch',
      tokenUid: session.uid,
      activeUid: active,
    });
    return { ok: false, error: 'token_uid_mismatch' };
  }

  pushing = true;
  emitSyncState('pushing', { reason });
  try {
    const { pending, changes } = buildPendingPushPayload();
    const empty =
      !changes.notes.length &&
      !changes.studyDays.length &&
      !changes.courseGroups.length &&
      !changes.courseFolders.length &&
      !changes.courseItems.length;
    if (empty) {
      clearPending(pending);
      emitSyncState('ready', { reason: 'push_empty_cleared' });
      return { ok: true, revision: getCloudRevision() };
    }

    const data = await apiFetch('/kb/push', {
      method: 'POST',
      token: session.token,
      body: { changes },
    });
    clearPending(pending);
    if (data?.revision != null) setCloudRevision(data.revision);
    emitSyncState('ready', { reason: 'push_ok', revision: data?.revision });
    return { ok: true, revision: data?.revision };
  } catch (err) {
    emitSyncState('push_error', { error: err.message || String(err), reason });
    return { ok: false, error: err.message || String(err) };
  } finally {
    pushing = false;
  }
}

function schedulePush(reason = 'debounce') {
  if (!cloudEnabled()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushPending({ reason });
  }, PUSH_DEBOUNCE_MS);
}

async function pullChanges({ reason = 'timer' } = {}) {
  if (!cloudEnabled()) return { ok: true, skipped: true, reason: 'cloud_disabled' };
  if (pulling) return { ok: true, skipped: true, reason: 'busy' };

  const session = loadToken();
  const active = getActiveUid();
  if (!session?.token) return { ok: false, error: 'no_token' };
  if (active && session.uid && session.uid !== active) {
    emitSyncState('pull_skipped', {
      reason: 'token_uid_mismatch',
      tokenUid: session.uid,
      activeUid: active,
    });
    return { ok: false, error: 'token_uid_mismatch' };
  }

  pulling = true;
  emitSyncState('pulling', { reason });
  try {
    const since = getCloudRevision();
    const data = await apiFetch(`/kb/changes?since=${encodeURIComponent(since)}`, {
      method: 'GET',
      token: session.token,
    });
    const applied = applyRemoteChanges(data?.changes || {});
    if (data?.revision != null) setCloudRevision(data.revision);
    emitSyncState('ready', {
      reason: 'pull_ok',
      revision: data?.revision,
      applied: applied.applied,
    });
    return { ok: true, revision: data?.revision, applied: applied.applied };
  } catch (err) {
    emitSyncState('pull_error', { error: err.message || String(err), reason });
    return { ok: false, error: err.message || String(err) };
  } finally {
    pulling = false;
  }
}

async function onAccountReady({
  uid,
  cookieHeader = null,
  switched = false,
  prevUid = null,
  isStale = null,
} = {}) {
  const id = String(uid || '').trim();
  if (!id) return { ok: false, error: 'no_uid' };
  const stale = () => (typeof isStale === 'function' ? isStale() : false);

  emitSyncState(switched ? 'switching' : 'syncing_login', {
    prevUid: prevUid || null,
    uid: id,
  });

  // 切号时尽量先把旧库 pending 推上去，但最多等 3s，绝不堵死换库
  if (switched && prevUid && cloudEnabled()) {
    if (getActiveUid() && getActiveUid() !== prevUid) {
      console.warn(
        '[bili-pet] skip switch_push_old: activeUid=%s prevUid=%s',
        getActiveUid(),
        prevUid
      );
    } else {
      const pushOld = await Promise.race([
        pushPending({ reason: 'switch_push_old' }),
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: false, error: 'push_timeout', skipped: true }), 3000)
        ),
      ]);
      if (stale()) return { ok: false, error: 'stale' };
      if (!pushOld.ok && !pushOld.skipped) {
        console.warn(
          '[bili-pet] switch_push_old failed, continue switch:',
          pushOld.error || 'push_failed'
        );
        emitSyncState('push_error', {
          error: pushOld.error || 'push_failed',
          reason: 'switch_push_old_continued',
          prevUid,
          uid: id,
        });
      }
    }
  }

  if (stale()) return { ok: false, error: 'stale' };

  // 立刻换本地库，UI/API 马上读新账号（不要等云端 pull 完）
  const existing = loadToken();
  if (existing?.uid && existing.uid !== id) {
    clearToken();
  }
  setActiveUid(id);
  console.log(`[bili-pet] local db active uid=${id}`);
  emitSyncState('local_ready', { uid: id, prevUid: prevUid || null, switched });
  if (stale()) return { ok: false, error: 'stale' };

  if (cookieHeader && cloudEnabled()) {
    await authenticateWithCookie(cookieHeader);
    if (stale()) return { ok: false, error: 'stale' };
  }

  const session = loadToken();
  if (cloudEnabled() && session?.token && session.uid === id) {
    await pullChanges({ reason: switched ? 'switch_pull' : 'login_pull' });
    if (stale()) return { ok: false, error: 'stale' };
  } else {
    emitSyncState('ready', {
      reason: cloudEnabled()
        ? session?.token
          ? 'waiting_auth_uid_match'
          : 'waiting_auth'
        : 'local_only',
      uid: id,
    });
  }

  if (stale()) return { ok: false, error: 'stale' };

  emitSyncState('account_switched', {
    kindHint: 'account_switched',
    prevUid: prevUid || null,
    uid: id,
    switched: Boolean(switched),
  });

  return { ok: true, uid: id };
}

function startCloudSync({ onBroadcast } = {}) {
  if (started) return;
  started = true;
  broadcast = typeof onBroadcast === 'function' ? onBroadcast : null;

  setOnLocalWriteHook(() => {
    schedulePush('local_write');
  });

  if (cloudEnabled()) {
    pullTimer = setInterval(() => {
      void pullChanges({ reason: 'timer_30s' });
    }, PULL_INTERVAL_MS);
    if (typeof pullTimer.unref === 'function') pullTimer.unref();
    console.log(`[bili-pet] cloud sync enabled → ${apiBase()} (pull every ${PULL_INTERVAL_MS}ms)`);
  } else {
    console.log('[bili-pet] cloud sync disabled (set CLOUD_API_BASE to enable)');
  }
}

function stopCloudSync() {
  if (pushTimer) clearTimeout(pushTimer);
  if (pullTimer) clearInterval(pullTimer);
  pushTimer = null;
  pullTimer = null;
  started = false;
}

async function flushBeforeQuit({ timeoutMs = QUIT_PUSH_TIMEOUT_MS } = {}) {
  emitSyncState('syncing_quit');
  if (!cloudEnabled()) {
    emitSyncState('ready', { reason: 'quit_local_only' });
    return { ok: true, skipped: true };
  }
  const result = await Promise.race([
    pushPending({ reason: 'quit' }),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs)
    ),
  ]);
  if (!result.ok && !result.skipped) {
    emitSyncState('quit_push_error', { error: result.error });
  } else {
    emitSyncState('ready', { reason: 'quit_flush_done' });
  }
  return result;
}

function handleAuthCookiePayload(payload) {
  const cookie =
    payload?.cookieHeader ||
    payload?.cookie ||
    payload?.account?.cookieHeader ||
    '';
  if (!cookie) return { ok: false, error: 'missing_cookie' };
  return authenticateWithCookie(cookie);
}

module.exports = {
  TOKEN_FILE,
  startCloudSync,
  stopCloudSync,
  onAccountReady,
  authenticateWithCookie,
  handleAuthCookiePayload,
  pushPending,
  pullChanges,
  flushBeforeQuit,
  schedulePush,
  cloudEnabled,
  loadToken,
  clearToken,
  emitSyncState,
};
