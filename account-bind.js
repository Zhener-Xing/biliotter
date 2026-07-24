const fs = require('fs');
const path = require('path');

const ACCOUNT_FILE = path.join(__dirname, '.bili-pet-account.json');

let cache = null;

function normalizeUid(uid) {
  const s = String(uid ?? '').trim();
  if (!s || s === '0') return null;
  return s;
}

function emptyAccount() {
  return {
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
    if (fs.existsSync(ACCOUNT_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
      cache = {
        boundUid: normalizeUid(raw.boundUid),
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
  try {
    fs.writeFileSync(ACCOUNT_FILE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn('[bili-pet] account save failed:', err.message || err);
  }
  return cache;
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
 *   account: ReturnType<typeof loadAccount>,
 * }}
 */
function handleAccountPayload(payload) {
  const kind = String(payload?.kind || '');
  const uid = extractUid(payload);
  const account = loadAccount();
  const now = Number(payload?.ts) || Date.now();

  if (kind === 'account_logout') {
    saveAccount({
      lastSeenUid: null,
      lastSeenAt: now,
      sessionLoggedIn: false,
    });
    return { ok: true, status: 'logout', uid: null, account: loadAccount() };
  }

  if (kind === 'account_login' || kind === 'account_hello') {
    if (!uid) {
      saveAccount({
        lastSeenUid: null,
        lastSeenAt: now,
        sessionLoggedIn: false,
      });
      return { ok: false, status: 'logged_out', uid: null, account: loadAccount() };
    }
    if (!account.boundUid) {
      saveAccount({
        boundUid: uid,
        boundAt: now,
        lastSeenUid: uid,
        lastSeenAt: now,
        sessionLoggedIn: true,
      });
      return { ok: true, status: 'auto_bound', uid, account: loadAccount() };
    }
    if (account.boundUid !== uid) {
      saveAccount({
        lastSeenUid: uid,
        lastSeenAt: now,
        sessionLoggedIn: false,
      });
      return { ok: false, status: 'mismatch', uid, account: loadAccount() };
    }
    saveAccount({
      lastSeenUid: uid,
      lastSeenAt: now,
      sessionLoggedIn: true,
    });
    return { ok: true, status: 'logged_in', uid, account: loadAccount() };
  }

  if (!uid) {
    return { ok: false, status: 'logged_out', uid: null, account };
  }

  if (!account.boundUid) {
    saveAccount({
      boundUid: uid,
      boundAt: now,
      lastSeenUid: uid,
      lastSeenAt: now,
      sessionLoggedIn: true,
    });
    return { ok: true, status: 'auto_bound', uid, account: loadAccount() };
  }

  if (account.boundUid !== uid) {
    saveAccount({
      lastSeenUid: uid,
      lastSeenAt: now,
      sessionLoggedIn: false,
    });
    return { ok: false, status: 'mismatch', uid, account: loadAccount() };
  }

  saveAccount({
    lastSeenUid: uid,
    lastSeenAt: now,
    sessionLoggedIn: true,
  });
  return { ok: true, status: 'ok', uid, account: loadAccount() };
}

module.exports = {
  ACCOUNT_FILE,
  normalizeUid,
  loadAccount,
  saveAccount,
  handleAccountPayload,
};
//！！！！账号绑定函数，但是逻辑还存在问题