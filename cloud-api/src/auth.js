'use strict';

const jwt = require('jsonwebtoken');
const { query } = require('./db');

function jwtSecret() {
  const s = String(process.env.JWT_SECRET || '').trim();
  if (!s || s === 'change-me-to-a-long-random-string') {
    console.warn('[cloud-api] WARNING: set a strong JWT_SECRET in production');
  }
  return s || 'dev-insecure-secret';
}

function jwtExpiresSec() {
  return Math.max(60, Number(process.env.JWT_EXPIRES_SEC) || 604800);
}

function normalizeUid(uid) {
  const s = String(uid ?? '').trim();
  if (!s || s === '0') return null;
  return s;
}

function extractCookieHeader(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.cookieHeader === 'string' && body.cookieHeader.trim()) {
    return body.cookieHeader.trim();
  }
  if (typeof body.cookie === 'string' && body.cookie.trim()) {
    return body.cookie.trim();
  }
  return '';
}

async function verifyBiliCookie(cookieHeader) {
  const cookie = String(cookieHeader || '').trim();
  if (!cookie) {
    return { ok: false, error: 'missing_cookie' };
  }

  let res;
  try {
    res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        Referer: 'https://www.bilibili.com',
        'User-Agent':
          'Mozilla/5.0 (compatible; bili-pet-cloud-api/1.0; +local)',
      },
    });
  } catch (err) {
    return { ok: false, error: 'nav_network', detail: String(err.message || err) };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'nav_bad_json', status: res.status };
  }

  const mid = normalizeUid(data?.data?.mid);
  const isLogin = Boolean(data?.data?.isLogin) || data?.code === 0;
  if (!mid || !isLogin) {
    return {
      ok: false,
      error: 'not_logged_in',
      code: data?.code ?? null,
    };
  }

  const uname = String(data?.data?.uname || '').trim().slice(0, 64) || null;
  return { ok: true, uid: mid, uname };
}

function signToken(uid) {
  const expiresIn = jwtExpiresSec();
  const token = jwt.sign({ uid }, jwtSecret(), { expiresIn });
  return {
    token,
    uid,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

function authMiddleware(req, res, next) {
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.status(401).json({ ok: false, error: 'missing_token' });
    return;
  }
  try {
    const payload = jwt.verify(m[1], jwtSecret());
    const uid = normalizeUid(payload?.uid || payload?.sub);
    if (!uid) {
      res.status(401).json({ ok: false, error: 'invalid_token_uid' });
      return;
    }
    req.uid = uid;
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

async function upsertUserLogin(uid, uname = null) {
  const now = Date.now();
  const name = String(uname || '').trim().slice(0, 64) || null;
  await query(
    `
    INSERT INTO users (uid, created_at, last_login_at, uname)
    VALUES (:uid, :now, :now, :uname)
    ON DUPLICATE KEY UPDATE
      last_login_at = VALUES(last_login_at),
      uname = COALESCE(VALUES(uname), users.uname)
  `,
    { uid, now, uname: name }
  );
  await query(
    `
    INSERT INTO sync_state (uid, revision, updated_at)
    VALUES (:uid, 0, :now)
    ON DUPLICATE KEY UPDATE updated_at = sync_state.updated_at
  `,
    { uid, now }
  );
}

async function handleAuthBili(req, res) {
  const cookieHeader = extractCookieHeader(req.body);
  const verified = await verifyBiliCookie(cookieHeader);
  if (!verified.ok) {
    res.status(401).json({ ok: false, ...verified });
    return;
  }
  await upsertUserLogin(verified.uid, verified.uname);
  const session = signToken(verified.uid);
  res.json({ ok: true, ...session, uname: verified.uname || null, via: 'bili_cookie' });
}

/**
 * Self-hosted bypass: prove possession of DEVICE_AUTH_SECRET + claim a uid.
 * For private deployments when browser Cookie cannot be read by the extension.
 * Set the same secret on desktop (.env CLOUD_DEVICE_SECRET) and cloud-api.
 */
function deviceAuthSecret() {
  const fromEnv = String(
    process.env.DEVICE_AUTH_SECRET || process.env.CLOUD_DEVICE_SECRET || ''
  ).trim();
  // Same test-distribution default as desktop CLOUD_DEVICE_SECRET
  return fromEnv || '0703251607192333333';
}

async function handleAuthDevice(req, res) {
  const expected = deviceAuthSecret();
  if (!expected) {
    res.status(503).json({ ok: false, error: 'device_auth_disabled' });
    return;
  }
  const secret = String(req.body?.secret || req.body?.deviceSecret || '').trim();
  const uid = normalizeUid(req.body?.uid);
  const uname = String(req.body?.uname || '').trim().slice(0, 64) || null;
  if (!uid) {
    res.status(400).json({ ok: false, error: 'missing_uid' });
    return;
  }
  if (!secret || secret !== expected) {
    res.status(401).json({ ok: false, error: 'invalid_device_secret' });
    return;
  }
  await upsertUserLogin(uid, uname);
  const session = signToken(uid);
  res.json({ ok: true, ...session, uname, via: 'device_secret' });
}

module.exports = {
  normalizeUid,
  authMiddleware,
  handleAuthBili,
  handleAuthDevice,
  signToken,
};
