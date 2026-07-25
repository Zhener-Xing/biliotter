'use strict';

const { query, withTransaction } = require('./db');
const { normalizeUid } = require('./auth');

const ONLINE_MS = 90_000;
const PET_COOLDOWN_MS = 5 * 60_000;
const PET_TTL_MS = 12 * 60 * 60_000;
const INVITE_TTL_DEFAULT_MS = 5 * 60_000;
const INVITE_TTL_MIN_MS = 60_000;
const INVITE_TTL_MAX_MS = 60 * 60_000;

function pairUids(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? { lo: x, hi: y } : { lo: y, hi: x };
}

function normalizePin(raw) {
  const pin = String(raw ?? '').trim();
  if (!/^\d{4}$/.test(pin)) return null;
  return pin;
}

function normalizeUname(raw) {
  const s = String(raw ?? '').trim().slice(0, 64);
  return s || null;
}

function displayName(uname, uid) {
  return uname || `UID ${uid}`;
}

async function purgeExpired(now = Date.now()) {
  await query(`DELETE FROM friend_invites WHERE expires_at < :now`, { now });
  await query(`DELETE FROM friend_pet_inbox WHERE expires_at < :now`, { now });
}

async function getUserRow(uid) {
  const rows = await query(
    `SELECT uid, uname, last_heartbeat_at FROM users WHERE uid = :uid LIMIT 1`,
    { uid }
  );
  return rows[0] || null;
}

async function ensureUser(uid, uname = null) {
  const now = Date.now();
  const name = normalizeUname(uname);
  await query(
    `
    INSERT INTO users (uid, created_at, last_login_at, uname)
    VALUES (:uid, :now, :now, :uname)
    ON DUPLICATE KEY UPDATE
      uname = COALESCE(VALUES(uname), users.uname)
  `,
    { uid, now, uname: name }
  );
}

function isOnline(lastHeartbeatAt, now = Date.now()) {
  const t = Number(lastHeartbeatAt) || 0;
  return t > 0 && now - t < ONLINE_MS;
}

async function areFriends(uidA, uidB) {
  const { lo, hi } = pairUids(uidA, uidB);
  const rows = await query(
    `
    SELECT 1 AS ok FROM friendships
    WHERE uid_lo = :lo AND uid_hi = :hi
    LIMIT 1
  `,
    { lo, hi }
  );
  return Boolean(rows[0]);
}

async function handlePresence(req, res) {
  const uid = req.uid;
  const now = Date.now();
  const uname = normalizeUname(req.body?.uname);
  await query(
    `
    INSERT INTO users (uid, created_at, last_login_at, uname, last_heartbeat_at)
    VALUES (:uid, :now, :now, :uname, :now)
    ON DUPLICATE KEY UPDATE
      last_heartbeat_at = VALUES(last_heartbeat_at),
      uname = COALESCE(VALUES(uname), users.uname)
  `,
    { uid, now, uname }
  );
  res.json({ ok: true, ts: now, onlineWindowMs: ONLINE_MS });
}

async function handleCreateInvite(req, res) {
  const uid = req.uid;
  const pin = normalizePin(req.body?.pin);
  if (!pin) {
    res.status(400).json({ ok: false, error: 'invalid_pin' });
    return;
  }
  let ttlMs = Number(req.body?.ttlMs);
  if (!Number.isFinite(ttlMs)) ttlMs = INVITE_TTL_DEFAULT_MS;
  ttlMs = Math.min(INVITE_TTL_MAX_MS, Math.max(INVITE_TTL_MIN_MS, Math.floor(ttlMs)));

  const now = Date.now();
  await purgeExpired(now);
  const expiresAt = now + ttlMs;

  try {
    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM friend_invites WHERE host_uid = ? OR pin = ?', [uid, pin]);
      await conn.execute(
        `
        INSERT INTO friend_invites (host_uid, pin, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `,
        [uid, pin, now, expiresAt]
      );
    });
  } catch (err) {
    if (String(err?.code) === 'ER_DUP_ENTRY') {
      res.status(409).json({ ok: false, error: 'pin_taken' });
      return;
    }
    throw err;
  }

  res.json({ ok: true, pin, expiresAt, ttlMs });
}

async function handleCancelInvite(req, res) {
  await query(`DELETE FROM friend_invites WHERE host_uid = :uid`, { uid: req.uid });
  res.json({ ok: true });
}

async function handleGetInvite(req, res) {
  const now = Date.now();
  await purgeExpired(now);
  const rows = await query(
    `
    SELECT pin, created_at AS createdAt, expires_at AS expiresAt
    FROM friend_invites
    WHERE host_uid = :uid AND expires_at >= :now
    LIMIT 1
  `,
    { uid: req.uid, now }
  );
  res.json({ ok: true, invite: rows[0] || null });
}

async function handleJoinInvite(req, res) {
  const guestUid = req.uid;
  const pin = normalizePin(req.body?.pin);
  if (!pin) {
    res.status(400).json({ ok: false, error: 'invalid_pin' });
    return;
  }
  const guestUname = normalizeUname(req.body?.uname);
  const now = Date.now();
  await purgeExpired(now);

  const invites = await query(
    `
    SELECT host_uid AS hostUid, pin, expires_at AS expiresAt
    FROM friend_invites
    WHERE pin = :pin AND expires_at >= :now
    LIMIT 1
  `,
    { pin, now }
  );
  const invite = invites[0];
  if (!invite) {
    res.status(404).json({ ok: false, error: 'invite_not_found' });
    return;
  }
  const hostUid = normalizeUid(invite.hostUid);
  if (!hostUid) {
    res.status(404).json({ ok: false, error: 'invite_not_found' });
    return;
  }
  if (hostUid === guestUid) {
    res.status(400).json({ ok: false, error: 'cannot_friend_self' });
    return;
  }

  if (await areFriends(hostUid, guestUid)) {
    await query(`DELETE FROM friend_invites WHERE host_uid = :hostUid`, { hostUid });
    const host = await getUserRow(hostUid);
    res.json({
      ok: true,
      alreadyFriends: true,
      friend: {
        uid: hostUid,
        uname: displayName(host?.uname, hostUid),
      },
    });
    return;
  }

  await ensureUser(guestUid, guestUname);
  const host = await getUserRow(hostUid);
  const { lo, hi } = pairUids(hostUid, guestUid);
  const unameLo = lo === hostUid ? host?.uname : guestUname;
  const unameHi = hi === hostUid ? host?.uname : guestUname;

  await withTransaction(async (conn) => {
    await conn.execute(
      `
      INSERT INTO friendships (uid_lo, uid_hi, created_at, uname_lo, uname_hi)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE created_at = friendships.created_at
    `,
      [lo, hi, now, normalizeUname(unameLo), normalizeUname(unameHi)]
    );
    await conn.execute('DELETE FROM friend_invites WHERE host_uid = ?', [hostUid]);
  });

  res.json({
    ok: true,
    alreadyFriends: false,
    friend: {
      uid: hostUid,
      uname: displayName(host?.uname, hostUid),
    },
  });
}

async function handleListFriends(req, res) {
  const uid = req.uid;
  const now = Date.now();
  const rows = await query(
    `
    SELECT
      CASE WHEN f.uid_lo = :uid THEN f.uid_hi ELSE f.uid_lo END AS friendUid,
      CASE WHEN f.uid_lo = :uid THEN f.uname_hi ELSE f.uname_lo END AS friendUnameStored,
      f.created_at AS createdAt,
      u.uname AS liveUname,
      u.last_heartbeat_at AS lastHeartbeatAt
    FROM friendships f
    LEFT JOIN users u
      ON u.uid = CASE WHEN f.uid_lo = :uid THEN f.uid_hi ELSE f.uid_lo END
    WHERE f.uid_lo = :uid OR f.uid_hi = :uid
    ORDER BY f.created_at DESC
  `,
    { uid }
  );

  const friends = rows.map((r) => {
    const friendUid = String(r.friendUid);
    const uname = displayName(r.liveUname || r.friendUnameStored, friendUid);
    return {
      uid: friendUid,
      uname,
      createdAt: Number(r.createdAt) || 0,
      online: isOnline(r.lastHeartbeatAt, now),
    };
  });

  res.json({ ok: true, friends });
}

async function handleRemoveFriend(req, res) {
  const uid = req.uid;
  const other = normalizeUid(req.params?.uid || req.body?.uid);
  if (!other) {
    res.status(400).json({ ok: false, error: 'missing_uid' });
    return;
  }
  if (other === uid) {
    res.status(400).json({ ok: false, error: 'cannot_friend_self' });
    return;
  }
  const { lo, hi } = pairUids(uid, other);
  await query(`DELETE FROM friendships WHERE uid_lo = :lo AND uid_hi = :hi`, { lo, hi });
  await query(
    `
    DELETE FROM friend_pet_cooldown
    WHERE (from_uid = :uid AND to_uid = :other)
       OR (from_uid = :other AND to_uid = :uid)
  `,
    { uid, other }
  );
  // Remove live pet events between the pair
  await query(
    `
    DELETE FROM friend_pet_inbox
    WHERE kind = 'live'
      AND (
        (to_uid = :uid AND from_uid = :other)
        OR (to_uid = :other AND from_uid = :uid)
      )
  `,
    { uid, other }
  );
  // Offline aggregates: drop the other user from from-lists, or delete if empty
  const offlineRows = await query(
    `
    SELECT id, from_uids_json AS fromUidsJson, from_unames_json AS fromUnamesJson
    FROM friend_pet_inbox
    WHERE kind = 'offline' AND (to_uid = :uid OR to_uid = :other)
  `,
    { uid, other }
  );
  for (const row of offlineRows) {
    let uids = [];
    let names = [];
    try {
      uids = JSON.parse(row.fromUidsJson || '[]');
    } catch {
      uids = [];
    }
    try {
      names = JSON.parse(row.fromUnamesJson || '[]');
    } catch {
      names = [];
    }
    if (!Array.isArray(uids)) uids = [];
    if (!Array.isArray(names)) names = [];

    const nextUids = [];
    const nextNames = [];
    for (let i = 0; i < uids.length; i += 1) {
      const id = String(uids[i] || '');
      if (!id || id === uid || id === other) continue;
      nextUids.push(id);
      nextNames.push(
        names[i] != null && String(names[i]).trim()
          ? String(names[i]).trim()
          : displayName(null, id)
      );
    }

    if (!nextUids.length) {
      await query(`DELETE FROM friend_pet_inbox WHERE id = :id`, { id: row.id });
      continue;
    }

    await query(
      `
      UPDATE friend_pet_inbox
      SET from_uids_json = :uidsJson,
          from_unames_json = :namesJson,
          from_uid = :fromUid,
          from_uname = :fromUname
      WHERE id = :id
    `,
      {
        id: row.id,
        uidsJson: JSON.stringify(nextUids),
        namesJson: JSON.stringify(nextNames),
        fromUid: nextUids[0],
        fromUname: nextNames[0] || displayName(null, nextUids[0]),
      }
    );
  }
  res.json({ ok: true });
}

async function handlePetFriend(req, res) {
  const fromUid = req.uid;
  const toUid = normalizeUid(req.body?.toUid || req.body?.uid);
  const fromUname = normalizeUname(req.body?.uname);
  if (!toUid) {
    res.status(400).json({ ok: false, error: 'missing_uid' });
    return;
  }
  if (toUid === fromUid) {
    res.status(400).json({ ok: false, error: 'cannot_pet_self' });
    return;
  }
  if (!(await areFriends(fromUid, toUid))) {
    res.status(403).json({ ok: false, error: 'not_friends' });
    return;
  }

  const now = Date.now();
  await purgeExpired(now);
  await ensureUser(fromUid, fromUname);

  const cool = await query(
    `
    SELECT last_at AS lastAt FROM friend_pet_cooldown
    WHERE from_uid = :fromUid AND to_uid = :toUid
    LIMIT 1
  `,
    { fromUid, toUid }
  );
  const lastAt = Number(cool[0]?.lastAt) || 0;
  if (lastAt && now - lastAt < PET_COOLDOWN_MS) {
    const retryAfterMs = PET_COOLDOWN_MS - (now - lastAt);
    res.status(429).json({
      ok: false,
      error: 'cooldown',
      retryAfterMs,
      cooldownMs: PET_COOLDOWN_MS,
    });
    return;
  }

  const target = await getUserRow(toUid);
  const online = isOnline(target?.last_heartbeat_at, now);
  const uname = displayName(fromUname || (await getUserRow(fromUid))?.uname, fromUid);
  const expiresAt = now + PET_TTL_MS;

  if (online) {
    await query(
      `
      INSERT INTO friend_pet_inbox
        (to_uid, kind, from_uid, from_uname, from_uids_json, from_unames_json, created_at, expires_at)
      VALUES
        (:toUid, 'live', :fromUid, :uname, NULL, NULL, :now, :expiresAt)
    `,
      { toUid, fromUid, uname, now, expiresAt }
    );
  } else {
    const existing = await query(
      `
      SELECT id, from_uids_json AS fromUidsJson, from_unames_json AS fromUnamesJson
      FROM friend_pet_inbox
      WHERE to_uid = :toUid AND kind = 'offline' AND expires_at >= :now
      ORDER BY id ASC
      LIMIT 1
    `,
      { toUid, now }
    );
    if (existing[0]) {
      let uids = [];
      let names = [];
      try {
        uids = JSON.parse(existing[0].fromUidsJson || '[]');
      } catch {
        uids = [];
      }
      try {
        names = JSON.parse(existing[0].fromUnamesJson || '[]');
      } catch {
        names = [];
      }
      if (!Array.isArray(uids)) uids = [];
      if (!Array.isArray(names)) names = [];
      if (!uids.includes(fromUid)) {
        uids.push(fromUid);
        names.push(uname);
      }
      await query(
        `
        UPDATE friend_pet_inbox
        SET from_uids_json = :uidsJson,
            from_unames_json = :namesJson,
            from_uid = :fromUid,
            from_uname = :uname,
            expires_at = :expiresAt
        WHERE id = :id
      `,
        {
          id: existing[0].id,
          uidsJson: JSON.stringify(uids),
          namesJson: JSON.stringify(names),
          fromUid,
          uname,
          expiresAt,
        }
      );
    } else {
      await query(
        `
        INSERT INTO friend_pet_inbox
          (to_uid, kind, from_uid, from_uname, from_uids_json, from_unames_json, created_at, expires_at)
        VALUES
          (:toUid, 'offline', :fromUid, :uname, :uidsJson, :namesJson, :now, :expiresAt)
      `,
        {
          toUid,
          fromUid,
          uname,
          uidsJson: JSON.stringify([fromUid]),
          namesJson: JSON.stringify([uname]),
          now,
          expiresAt,
        }
      );
    }
  }

  await query(
    `
    INSERT INTO friend_pet_cooldown (from_uid, to_uid, last_at)
    VALUES (:fromUid, :toUid, :now)
    ON DUPLICATE KEY UPDATE last_at = VALUES(last_at)
  `,
    { fromUid, toUid, now }
  );

  res.json({
    ok: true,
    delivered: online ? 'live' : 'queued',
    cooldownMs: PET_COOLDOWN_MS,
    targetOnline: online,
  });
}

function buildOfflinePayload(row) {
  let uids = [];
  let names = [];
  try {
    uids = JSON.parse(row.fromUidsJson || '[]');
  } catch {
    uids = [];
  }
  try {
    names = JSON.parse(row.fromUnamesJson || '[]');
  } catch {
    names = [];
  }
  if (!Array.isArray(uids)) uids = [];
  if (!Array.isArray(names)) names = [];
  if (!uids.length && row.fromUid) {
    uids = [String(row.fromUid)];
    names = [displayName(row.fromUname, row.fromUid)];
  }
  const uniqueCount = uids.length || 1;
  const primaryName = names[0] || displayName(row.fromUname, row.fromUid);
  let message;
  if (uniqueCount > 1) {
    message = '你的多个好朋友在你离开时摸了摸你的獭';
  } else {
    message = `「${primaryName}」在你离开时摸了摸你的獭`;
  }
  return {
    id: Number(row.id),
    kind: 'offline',
    multi: uniqueCount > 1,
    fromUid: uids[0] || row.fromUid || null,
    fromUname: primaryName,
    fromCount: uniqueCount,
    message,
    createdAt: Number(row.createdAt) || 0,
    expiresAt: Number(row.expiresAt) || 0,
  };
}

async function handlePetInbox(req, res) {
  const uid = req.uid;
  const now = Date.now();
  await purgeExpired(now);

  // Touch presence so friends see us online while polling inbox
  const uname = normalizeUname(req.body?.uname || req.query?.uname);
  await query(
    `
    INSERT INTO users (uid, created_at, last_login_at, uname, last_heartbeat_at)
    VALUES (:uid, :now, :now, :uname, :now)
    ON DUPLICATE KEY UPDATE
      last_heartbeat_at = VALUES(last_heartbeat_at),
      uname = COALESCE(VALUES(uname), users.uname)
  `,
    { uid, now, uname }
  );

  const liveRows = await query(
    `
    SELECT id, from_uid AS fromUid, from_uname AS fromUname,
           created_at AS createdAt, expires_at AS expiresAt
    FROM friend_pet_inbox
    WHERE to_uid = :uid AND kind = 'live' AND expires_at >= :now
    ORDER BY id ASC
    LIMIT 20
  `,
    { uid, now }
  );

  const offlineRows = await query(
    `
    SELECT id, from_uid AS fromUid, from_uname AS fromUname,
           from_uids_json AS fromUidsJson, from_unames_json AS fromUnamesJson,
           created_at AS createdAt, expires_at AS expiresAt
    FROM friend_pet_inbox
    WHERE to_uid = :uid AND kind = 'offline' AND expires_at >= :now
    ORDER BY id ASC
    LIMIT 1
  `,
    { uid, now }
  );

  const events = [];
  for (const row of liveRows) {
    const name = displayName(row.fromUname, row.fromUid);
    events.push({
      id: Number(row.id),
      kind: 'live',
      multi: false,
      fromUid: row.fromUid,
      fromUname: name,
      fromCount: 1,
      message: `「${name}」摸了摸你的獭`,
      createdAt: Number(row.createdAt) || 0,
      expiresAt: Number(row.expiresAt) || 0,
    });
  }
  if (offlineRows[0]) {
    events.push(buildOfflinePayload(offlineRows[0]));
  }

  res.json({ ok: true, events, ts: now });
}

async function handlePetInboxAck(req, res) {
  const uid = req.uid;
  const idsRaw = req.body?.ids;
  const ids = Array.isArray(idsRaw)
    ? idsRaw.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (!ids.length) {
    res.json({ ok: true, deleted: 0 });
    return;
  }
  const placeholders = ids.map((_, i) => `:id${i}`).join(', ');
  const params = { uid };
  ids.forEach((id, i) => {
    params[`id${i}`] = id;
  });
  const result = await query(
    `
    DELETE FROM friend_pet_inbox
    WHERE to_uid = :uid AND id IN (${placeholders})
  `,
    params
  );
  res.json({ ok: true, deleted: result?.affectedRows ?? 0 });
}

module.exports = {
  ONLINE_MS,
  PET_COOLDOWN_MS,
  PET_TTL_MS,
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
};
