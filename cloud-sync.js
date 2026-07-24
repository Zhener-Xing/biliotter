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
  purgeUidLocalStore,
  localDbExists,
  hasLocalKbData,
  dbPathForUid,
  listUidDbFilesOnDisk,
} = require('./notes-db');
const { setAccountOpsReady, isAccountOpsReady, setForeignPurgeActive } = require('./session-gate');
const { getBiliCookieHeader } = require('./bili-web-api');

const TOKEN_FILE = path.join(__dirname, '.bili-pet-cloud-token.json');
const PULL_INTERVAL_MS = 30_000;
const PUSH_DEBOUNCE_MS = 1500;
const QUIT_PUSH_TIMEOUT_MS = 12_000;
const FIRST_PULL_TIMEOUT_MS = 5_000;
const PURGE_RETRY_MIN_MS = 3_000;
const PURGE_RETRY_MAX_MS = 60_000;
const FIRST_PULL_RETRY_MS = 4_000;

/** @type {null | ((event: object) => void)} */
let broadcast = null;
let pushTimer = null;
let pullTimer = null;
let pushing = false;
let pulling = false;
let started = false;
/** @type {Promise<void>} */
let dbMutex = Promise.resolve();
/** @type {Map<string, { reason: string, attempts: number, timer: NodeJS.Timeout | null }>} */
const purgeJobs = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const firstPullRetryTimers = new Map();

function apiBase() {
  return String(process.env.CLOUD_API_BASE || '')
    .trim()
    .replace(/\/+$/, '');
}

function cloudEnabled() {
  return Boolean(apiBase());
}

function tokenPathForUid(uid) {
  const id = String(uid || '').trim();
  return path.join(__dirname, `.bili-pet-cloud-token-${id}.json`);
}

function readTokenFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function writeTokenFile(filePath, session) {
  const payload = {
    token: String(session?.token || ''),
    uid: String(session?.uid || ''),
    expiresAt: Number(session?.expiresAt) || 0,
    savedAt: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function loadTokenForUid(uid) {
  const id = String(uid || '').trim();
  if (!id) return null;
  const perUid = readTokenFile(tokenPathForUid(id));
  if (perUid) return perUid;
  const legacy = readTokenFile(TOKEN_FILE);
  if (legacy?.uid === id) {
    try {
      writeTokenFile(tokenPathForUid(id), legacy);
    } catch {
      /* ignore */
    }
    return legacy;
  }
  return null;
}

function saveTokenForUid(session) {
  const uid = String(session?.uid || '').trim();
  if (!uid || !session?.token) return null;
  writeTokenFile(tokenPathForUid(uid), session);
  writeTokenFile(TOKEN_FILE, session);
  return session;
}

function clearTokenForUid(uid) {
  const id = String(uid || '').trim();
  if (!id) return;
  try {
    const p = tokenPathForUid(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
  const active = readTokenFile(TOKEN_FILE);
  if (active?.uid === id) {
    try {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    } catch {
      /* ignore */
    }
  }
}

function loadToken() {
  const active = getActiveUid();
  if (active) {
    const perUid = loadTokenForUid(active);
    if (perUid) return perUid;
  }
  return readTokenFile(TOKEN_FILE);
}

function saveToken(session) {
  return saveTokenForUid(session);
}

function clearToken() {
  const active = readTokenFile(TOKEN_FILE);
  if (active?.uid) clearTokenForUid(active.uid);
  else {
    try {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    } catch {
      /* ignore */
    }
  }
}

function withDbMutex(fn) {
  const run = dbMutex.then(fn, fn);
  dbMutex = run.then(
    () => undefined,
    () => undefined
  );
  return run;
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
    hasPending: (() => {
      try {
        return hasPendingSync();
      } catch {
        return false;
      }
    })(),
    opsReady: isAccountOpsReady(),
    ...extra,
  };
  try {
    broadcast?.(event);
  } catch (err) {
    console.warn('[bili-pet] sync broadcast failed:', err.message || err);
  }
  return event;
}

async function apiFetch(pathname, { method = 'GET', body = null, token = null, timeoutMs = 0 } = {}) {
  const base = apiBase();
  if (!base) throw new Error('cloud_disabled');
  const headers = { Accept: 'application/json' };
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const ctrl = timeoutMs > 0 ? new AbortController() : null;
  const timer =
    ctrl && timeoutMs > 0
      ? setTimeout(() => {
          try {
            ctrl.abort();
          } catch {
            /* ignore */
          }
        }, timeoutMs)
      : null;

  try {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl?.signal,
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
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('timeout');
      timeoutErr.code = 'timeout';
      throw timeoutErr;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
      timeoutMs: FIRST_PULL_TIMEOUT_MS,
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

async function pushPending({ reason = 'manual', tokenSession = null } = {}) {
  if (!cloudEnabled()) return { ok: true, skipped: true, reason: 'cloud_disabled' };
  if (pushing) return { ok: true, skipped: true, reason: 'busy' };
  if (!hasPendingSync()) return { ok: true, skipped: true, reason: 'empty' };

  const session = tokenSession || loadToken();
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

async function pullChanges({ reason = 'timer', timeoutMs = 0 } = {}) {
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
      timeoutMs,
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
    const error = err.message || String(err);
    emitSyncState(error === 'timeout' ? 'pull_timeout' : 'pull_error', {
      error,
      reason,
    });
    return { ok: false, error };
  } finally {
    pulling = false;
  }
}

async function probeNeedsPull(uid, { bindingChanged = false, localWasMissing = false } = {}) {
  if (!cloudEnabled()) {
    return { need: false, reason: 'local_only' };
  }
  if (bindingChanged) return { need: true, reason: 'binding_changed' };
  if (localWasMissing || !localDbExists(uid)) {
    return { need: true, reason: 'local_cleared' };
  }

  let localHasData = false;
  let localRev = 0;
  try {
    if (getActiveUid() === String(uid)) {
      localHasData = hasLocalKbData();
      localRev = getCloudRevision();
    }
  } catch {
    localHasData = false;
  }
  if (!localHasData && localRev <= 0) {
    return { need: true, reason: 'local_cleared' };
  }

  const session = loadTokenForUid(uid) || loadToken();
  if (!session?.token || session.uid !== String(uid)) {
    return { need: true, reason: 'no_token' };
  }

  try {
    const data = await apiFetch('/kb/revision', {
      method: 'GET',
      token: session.token,
      timeoutMs: Math.min(2000, FIRST_PULL_TIMEOUT_MS),
    });
    const remoteRev = Math.max(0, Number(data?.revision) || 0);
    if (remoteRev > localRev) {
      return { need: true, reason: 'revision_behind', remoteRev, localRev };
    }
    return { need: false, reason: 'up_to_date', remoteRev, localRev };
  } catch (err) {
    const status = Number(err?.status) || 0;
    const msg = err.message || String(err);
    // 远端尚未部署 /kb/revision：不要卡死，走增量 changes（本地已有数据时也很快）
    if (status === 404 || /http_404|Cannot GET \/kb\/revision/i.test(msg)) {
      return { need: true, reason: 'revision_endpoint_missing', localRev };
    }
    return { need: true, reason: 'probe_failed', error: msg };
  }
}

function clearFirstPullRetry(uid) {
  const id = String(uid || '').trim();
  const t = firstPullRetryTimers.get(id);
  if (t) clearTimeout(t);
  firstPullRetryTimers.delete(id);
}

function resolveCookieHeader(cookieHeader = null) {
  const fromArg = String(cookieHeader || '').trim();
  if (fromArg) return fromArg;
  try {
    return String(getBiliCookieHeader() || '').trim() || null;
  } catch {
    return null;
  }
}

function scheduleFirstPullRetry(uid, cookieHeader = null) {
  const id = String(uid || '').trim();
  if (!id || !cloudEnabled()) return;
  clearFirstPullRetry(id);
  const timer = setTimeout(() => {
    firstPullRetryTimers.delete(id);
    if (getActiveUid() !== id) return;
    void (async () => {
      // 后台重试：不要关掉本地可用性
      emitSyncState('syncing_login', { uid: id, reason: 'first_pull_retry' });
      const result = await runFirstPullGate({
        uid: id,
        cookieHeader: resolveCookieHeader(cookieHeader),
        pullReason: 'login_pull_retry',
      });
      if (result.ok) {
        emitSyncState('ready', {
          reason: result.pulled ? 'pull_ok' : result.reason || 'bg_sync_ok',
          uid: id,
          retried: true,
        });
      } else {
        emitSyncState('first_pull_blocked', {
          uid: id,
          error: result.error,
          reason: result.reason || result.error,
        });
        scheduleFirstPullRetry(id, resolveCookieHeader(cookieHeader));
      }
    })();
  }, FIRST_PULL_RETRY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  firstPullRetryTimers.set(id, timer);
}

async function runFirstPullGate({
  uid,
  cookieHeader = null,
  bindingChanged = false,
  localWasMissing = false,
  pullReason = 'login_pull',
  isStale = null,
} = {}) {
  const id = String(uid || '').trim();
  const stale = () => (typeof isStale === 'function' ? isStale() : false);
  const cookie = resolveCookieHeader(cookieHeader);

  if (cookie && cloudEnabled()) {
    const auth = await authenticateWithCookie(cookie);
    if (stale()) return { ok: false, error: 'stale' };
    if (!auth.ok && !loadTokenForUid(id)?.token) {
      return { ok: false, error: auth.error || 'auth_failed' };
    }
  }

  const decision = await probeNeedsPull(id, { bindingChanged, localWasMissing });
  if (stale()) return { ok: false, error: 'stale' };

  if (!decision.need) {
    emitSyncState('ready', { reason: decision.reason, uid: id });
    clearFirstPullRetry(id);
    return { ok: true, uid: id, pulled: false, reason: decision.reason };
  }

  const session = loadTokenForUid(id) || loadToken();
  if (!cloudEnabled()) {
    emitSyncState('ready', { reason: 'local_only', uid: id });
    clearFirstPullRetry(id);
    return { ok: true, uid: id, pulled: false, reason: 'local_only' };
  }
  if (!session?.token || session.uid !== id) {
    emitSyncState('ready', {
      reason: session?.token ? 'waiting_auth_uid_match' : 'waiting_auth',
      uid: id,
    });
    return { ok: false, error: 'waiting_auth' };
  }

  saveToken(session);

  const budget = FIRST_PULL_TIMEOUT_MS;
  const pull = await pullChanges({ reason: pullReason, timeoutMs: budget });
  if (stale()) return { ok: false, error: 'stale' };
  if (!pull.ok) {
    return { ok: false, error: pull.error || 'pull_error', reason: decision.reason };
  }
  clearFirstPullRetry(id);
  return { ok: true, uid: id, pulled: true, reason: decision.reason };
}

async function flushAndPurgeUid(uid, reason = 'purge', { quiet = false } = {}) {
  const id = String(uid || '').trim();
  if (!id) return { ok: true, skipped: true, reason: 'no_uid' };

  const emitBlocked = (extra) => {
    if (quiet) {
      console.warn(
        '[bili-pet] purge blocked (quiet)',
        id,
        extra?.reason || extra?.error || reason
      );
      return;
    }
    emitSyncState('purge_blocked', {
      uid: id,
      purgeReason: reason,
      ...extra,
    });
  };

  if (!cloudEnabled()) {
    emitBlocked({ reason: 'cloud_disabled' });
    return { ok: false, error: 'cloud_disabled' };
  }

  return withDbMutex(async () => {
    const resumeUid = getActiveUid();
    const resumeToken = resumeUid ? loadTokenForUid(resumeUid) || loadToken() : null;
    const session = loadTokenForUid(id) || (resumeUid === id ? loadToken() : null);
    const remountingOther = Boolean(resumeUid && resumeUid !== id);

    if (!session?.token) {
      emitBlocked({ reason: 'no_token' });
      return { ok: false, error: 'no_token' };
    }
    if (session.uid !== id) {
      emitBlocked({
        reason: 'token_uid_mismatch',
        tokenUid: session.uid,
      });
      return { ok: false, error: 'token_uid_mismatch' };
    }

    if (remountingOther) setForeignPurgeActive(true);
    try {
      if (getActiveUid() !== id) {
        setActiveUid(id);
      } else if (!getActiveUid()) {
        setActiveUid(id);
      }
      saveToken(session);

      let pushResult = await pushPending({ reason, tokenSession: session });
      if (pushResult.skipped && pushResult.reason === 'busy') {
        await new Promise((resolve) => setTimeout(resolve, 600));
        pushResult = await pushPending({ reason: `${reason}_retry`, tokenSession: session });
      }
      if (pushResult.skipped && pushResult.reason === 'busy') {
        emitBlocked({ reason: 'busy' });
        return { ok: false, error: 'busy' };
      }
      if (!pushResult.ok && !pushResult.skipped) {
        emitBlocked({ reason: pushResult.error || 'push_failed' });
        return { ok: false, error: pushResult.error || 'push_failed' };
      }
      if (hasPendingSync()) {
        emitBlocked({ reason: 'pending_remaining' });
        return { ok: false, error: 'pending_remaining' };
      }

      const purged = purgeUidLocalStore(id);
      if (!purged.ok) {
        emitBlocked({ reason: purged.error || 'purge_failed' });
        return { ok: false, error: purged.error || 'purge_failed' };
      }

      clearTokenForUid(id);
      if (!quiet) {
        emitSyncState('account_purged', { uid: id, purgeReason: reason });
      } else {
        console.log(`[bili-pet] background purged uid=${id} (${reason})`);
      }
      return { ok: true, uid: id };
    } finally {
      if (resumeUid && resumeUid !== id) {
        setActiveUid(resumeUid);
        if (resumeToken?.token) saveToken(resumeToken);
      }
      if (remountingOther) setForeignPurgeActive(false);
    }
  });
}

function cancelBackgroundPurge(uid) {
  const id = String(uid || '').trim();
  const job = purgeJobs.get(id);
  if (!job) return;
  if (job.timer) clearTimeout(job.timer);
  purgeJobs.delete(id);
}

function scheduleBackgroundPurge(uid, reason = 'background_purge') {
  const id = String(uid || '').trim();
  if (!id) return;

  const existing = purgeJobs.get(id);
  if (existing?.timer) clearTimeout(existing.timer);

  const job = {
    reason,
    attempts: existing?.attempts || 0,
    timer: null,
  };
  purgeJobs.set(id, job);

  const run = async () => {
    const current = purgeJobs.get(id);
    if (!current) return;
    if (getActiveUid() === id) {
      cancelBackgroundPurge(id);
      return;
    }
    if (!localDbExists(id)) {
      cancelBackgroundPurge(id);
      clearTokenForUid(id);
      return;
    }

    current.attempts += 1;
    // 后台清旧号：安静重试，避免反复 toast「未同步完成」
    const result = await flushAndPurgeUid(id, current.reason || reason, {
      quiet: true,
    });
    if (result.ok || result.skipped) {
      cancelBackgroundPurge(id);
      return;
    }

    const delay = Math.min(
      PURGE_RETRY_MAX_MS,
      PURGE_RETRY_MIN_MS * Math.pow(1.6, Math.min(current.attempts, 8))
    );
    console.warn(
      `[bili-pet] background purge retry uid=${id} attempt=${current.attempts} in ${delay}ms:`,
      result.error
    );
    current.timer = setTimeout(() => {
      current.timer = null;
      void run();
    }, delay);
    if (typeof current.timer.unref === 'function') current.timer.unref();
  };

  job.timer = setTimeout(() => {
    job.timer = null;
    void run();
  }, 200);
  if (typeof job.timer.unref === 'function') job.timer.unref();
}

async function onAccountReady({
  uid,
  cookieHeader = null,
  switched = false,
  autoBound = false,
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

  if (switched && prevUid) {
    const prev = String(prevUid).trim();
    if (prev && prev !== id) {
      scheduleBackgroundPurge(prev, 'switch_push_old');
    }
  }

  if (stale()) return { ok: false, error: 'stale' };

  const localWasMissing = !localDbExists(id);
  cancelBackgroundPurge(id);

  const existing = loadToken();
  if (existing?.uid && existing.uid !== id) {
    try {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    } catch {
      /* ignore */
    }
  }

  // 立刻挂本地库并放行操作（云端 pull 后台做，可牺牲一点一致性）
  setActiveUid(id);
  setAccountOpsReady(true);
  console.log(`[bili-pet] local db active uid=${id} (ops ready immediately)`);
  emitSyncState('local_ready', {
    uid: id,
    prevUid: prevUid || null,
    switched,
    opsReady: true,
  });
  // 不在此广播 account_switched：由 canva 统一发一次，避免反复 toast
  if (stale()) return { ok: false, error: 'stale' };

  const bindingChanged = Boolean(switched || autoBound);
  const pullReason = switched ? 'switch_pull' : 'login_pull';
  // 后台同步，不挡打开
  void (async () => {
    const gate = await runFirstPullGate({
      uid: id,
      cookieHeader,
      bindingChanged,
      localWasMissing,
      pullReason,
      isStale,
    });
    if (stale()) return;
    if (!gate.ok) {
      scheduleFirstPullRetry(id, cookieHeader);
      emitSyncState('first_pull_blocked', {
        uid: id,
        error: gate.error,
        reason: gate.reason || gate.error,
      });
      return;
    }
    emitSyncState('ready', {
      reason: gate.pulled ? 'pull_ok' : gate.reason || 'bg_sync_ok',
      uid: id,
      pulled: Boolean(gate.pulled),
    });
  })();

  return { ok: true, uid: id, opsReady: true };
}

function startCloudSync({ onBroadcast } = {}) {
  if (started) return;
  started = true;
  broadcast = typeof onBroadcast === 'function' ? onBroadcast : null;
  setAccountOpsReady(false);

  setOnLocalWriteHook(() => {
    schedulePush('local_write');
  });

  if (cloudEnabled()) {
    pullTimer = setInterval(() => {
      if (!isAccountOpsReady()) return;
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
  for (const [, job] of purgeJobs) {
    if (job.timer) clearTimeout(job.timer);
  }
  purgeJobs.clear();
  for (const t of firstPullRetryTimers.values()) clearTimeout(t);
  firstPullRetryTimers.clear();
  started = false;
  setAccountOpsReady(false);
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

function sweepOrphanLocalStores() {
  const active = getActiveUid();
  for (const row of listUidDbFilesOnDisk()) {
    if (!row?.uid || row.uid === active) continue;
    if (purgeJobs.has(row.uid)) continue;
    if (!loadTokenForUid(row.uid)?.token) continue;
    scheduleBackgroundPurge(row.uid, 'orphan_sweep');
  }
}

module.exports = {
  TOKEN_FILE,
  FIRST_PULL_TIMEOUT_MS,
  startCloudSync,
  stopCloudSync,
  onAccountReady,
  flushAndPurgeUid,
  scheduleBackgroundPurge,
  cancelBackgroundPurge,
  authenticateWithCookie,
  handleAuthCookiePayload,
  pushPending,
  pullChanges,
  flushBeforeQuit,
  schedulePush,
  cloudEnabled,
  loadToken,
  loadTokenForUid,
  clearToken,
  clearTokenForUid,
  emitSyncState,
  scheduleFirstPullRetry,
  sweepOrphanLocalStores,
  runFirstPullGate,
};
