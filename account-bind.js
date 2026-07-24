const fs = require('fs');
const { dataPath } = require('./paths');

function accountFile() {
  return dataPath('.bili-pet-account.json');
}

let cache = null;

function normalizeUid(uid) {
  const s = String(uid ?? '').trim();
  if (!s || s === '0') return null;
  return s;
}

function emptyAccount() {
  return {
    activeUid: null,
    boundUid: null,
    boundAt: null,
    lastSeenUid: null,
    lastSeenAt: null,
    sessionLoggedIn: false,
  };
}

function loadAccount() {
  if (cache) return cache;
  try {
    if (fs.existsSync(accountFile())) {
      const raw = JSON.parse(fs.readFileSync(accountFile(), 'utf8'));
      const activeUid =
        normalizeUid(raw.activeUid) || normalizeUid(raw.boundUid);
      cache = {
        activeUid,
        boundUid: activeUid,
        boundAt: Number(raw.boundAt) || null,
        lastSeenUid: normalizeUid(raw.lastSeenUid),
        lastSeenAt: Number(raw.lastSeenAt) || null,
        sessionLoggedIn: Boolean(raw.sessionLoggedIn),
      };
      return cache;
    }
  } catch (err) {
    console.warn('[bili-pet] account load failed:', err.message || err);
  }
  cache = emptyAccount();
  return cache;
}

function saveAccount(patch = {}) {
  const prev = loadAccount();
  cache = { ...prev, ...patch };
  if (cache.activeUid) {
    cache.boundUid = cache.activeUid;
  } else if (Object.prototype.hasOwnProperty.call(patch, 'activeUid') && !patch.activeUid) {
    cache.boundUid = null;
  }
  try {
    fs.writeFileSync(accountFile(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn('[bili-pet] account save failed:', err.message || err);
  }
  return cache;
}

/** After successful local purge on logout. */
function clearBinding() {
  return saveAccount({
    activeUid: null,
    boundUid: null,
    boundAt: null,
    lastSeenUid: null,
    lastSeenAt: Date.now(),
    sessionLoggedIn: false,
  });
}

/** Commit active uid after first bind or successful switch purge. */
function commitBinding(uid) {
  const id = normalizeUid(uid);
  if (!id) return clearBinding();
  const now = Date.now();
  return saveAccount({
    activeUid: id,
    boundUid: id,
    boundAt: now,
    lastSeenUid: id,
    lastSeenAt: now,
    sessionLoggedIn: true,
  });
}

function extractUid(payload) {
  return normalizeUid(
    payload?.account?.uid ?? payload?.uid ?? payload?.account?.mid
  );
}

/**
 * @returns {{
 *   ok: boolean,
 *   status: string,
 *   uid: string | null,
 *   prevUid: string | null,
 *   account: ReturnType<typeof loadAccount>,
 * }}
 */
function handleAccountPayload(payload) {
  const kind = String(payload?.kind || '');
  const uid = extractUid(payload);
  const account = loadAccount();
  const now = Number(payload?.ts) || Date.now();
  const prevUid = account.activeUid || account.boundUid || null;

  if (kind === 'account_logout') {
    // Keep activeUid until flushAndPurgeUid succeeds (canva clearBinding).
    saveAccount({
      lastSeenUid: null,
      lastSeenAt: now,
      sessionLoggedIn: false,
    });
    return {
      ok: true,
      status: 'logout',
      uid: null,
      prevUid,
      account: loadAccount(),
    };
  }

  if (kind === 'account_login' || kind === 'account_hello') {
    if (!uid) {
      saveAccount({
        lastSeenUid: null,
        lastSeenAt: now,
        sessionLoggedIn: false,
      });
      return {
        ok: false,
        status: 'logged_out',
        uid: null,
        prevUid,
        account: loadAccount(),
      };
    }
    if (!prevUid) {
      saveAccount({
        activeUid: uid,
        boundUid: uid,
        boundAt: now,
        lastSeenUid: uid,
        lastSeenAt: now,
        sessionLoggedIn: true,
      });
      return {
        ok: true,
        status: 'auto_bound',
        uid,
        prevUid: null,
        account: loadAccount(),
      };
    }
    if (prevUid !== uid) {
      // Detect switch but do NOT commit activeUid until old store is purged.
      saveAccount({
        lastSeenUid: uid,
        lastSeenAt: now,
        sessionLoggedIn: true,
      });
      return {
        ok: true,
        status: 'switched',
        uid,
        prevUid,
        account: loadAccount(),
      };
    }
    saveAccount({
      lastSeenUid: uid,
      lastSeenAt: now,
      sessionLoggedIn: true,
    });
    return {
      ok: true,
      status: 'logged_in',
      uid,
      prevUid,
      account: loadAccount(),
    };
  }

  if (!uid) {
    return {
      ok: false,
      status: 'logged_out',
      uid: null,
      prevUid,
      account,
    };
  }

  if (!prevUid) {
    saveAccount({
      activeUid: uid,
      boundUid: uid,
      boundAt: now,
      lastSeenUid: uid,
      lastSeenAt: now,
      sessionLoggedIn: true,
    });
    return {
      ok: true,
      status: 'auto_bound',
      uid,
      prevUid: null,
      account: loadAccount(),
    };
  }

  if (prevUid !== uid) {
    saveAccount({
      lastSeenUid: uid,
      lastSeenAt: now,
      sessionLoggedIn: true,
    });
    return {
      ok: true,
      status: 'switched',
      uid,
      prevUid,
      account: loadAccount(),
    };
  }

  saveAccount({
    lastSeenUid: uid,
    lastSeenAt: now,
    sessionLoggedIn: true,
  });
  return {
    ok: true,
    status: 'ok',
    uid,
    prevUid,
    account: loadAccount(),
  };
}

module.exports = {
  get ACCOUNT_FILE() {
    return accountFile();
  },
  normalizeUid,
  loadAccount,
  saveAccount,
  clearBinding,
  commitBinding,
  handleAccountPayload,
};
