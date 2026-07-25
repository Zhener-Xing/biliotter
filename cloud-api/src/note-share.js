'use strict';

const { query } = require('./db');
const { normalizeUid } = require('./auth');

const BODY_MAX = 500_000;
const SHARE_TTL_MS = 30 * 24 * 60 * 60_000; // pending expires in 30 days

function normalizeUname(raw) {
  const s = String(raw ?? '').trim().slice(0, 64);
  return s || null;
}

function displayName(uname, uid) {
  return uname || `UID ${uid}`;
}

function pairUids(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? { lo: x, hi: y } : { lo: y, hi: x };
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

async function purgeExpiredShares(now = Date.now()) {
  await query(
    `
    DELETE FROM friend_note_shares
    WHERE status = 'pending' AND expires_at < :now
  `,
    { now }
  );
}

async function handleShareNote(req, res) {
  const fromUid = req.uid;
  const toUid = normalizeUid(req.body?.toUid || req.body?.uid);
  const bvid = String(req.body?.bvid || '').trim().slice(0, 64);
  const title = String(req.body?.title || '').trim().slice(0, 512);
  const bodyMd = String(req.body?.bodyMd ?? req.body?.body_md ?? '');
  const mode = String(req.body?.mode || 'user').trim().slice(0, 16) || 'user';
  const fromUname = normalizeUname(req.body?.uname);
  let notesJson = null;
  if (req.body?.notes != null) {
    try {
      notesJson = JSON.stringify(req.body.notes);
    } catch {
      notesJson = null;
    }
  }

  if (!toUid) {
    res.status(400).json({ ok: false, error: 'missing_uid' });
    return;
  }
  if (toUid === fromUid) {
    res.status(400).json({ ok: false, error: 'cannot_share_self' });
    return;
  }
  if (!bvid) {
    res.status(400).json({ ok: false, error: 'missing_bvid' });
    return;
  }
  if (!bodyMd.trim()) {
    res.status(400).json({ ok: false, error: 'empty_note' });
    return;
  }
  if (bodyMd.length > BODY_MAX) {
    res.status(400).json({ ok: false, error: 'note_too_large' });
    return;
  }
  if (!(await areFriends(fromUid, toUid))) {
    res.status(403).json({ ok: false, error: 'not_friends' });
    return;
  }

  const now = Date.now();
  await purgeExpiredShares(now);

  const existing = await query(
    `
    SELECT id, status FROM friend_note_shares
    WHERE from_uid = :fromUid AND to_uid = :toUid AND bvid = :bvid
    LIMIT 1
  `,
    { fromUid, toUid, bvid }
  );
  if (existing[0]) {
    res.status(409).json({
      ok: false,
      error: 'already_sent',
      status: existing[0].status,
      shareId: Number(existing[0].id),
    });
    return;
  }

  try {
    const result = await query(
      `
      INSERT INTO friend_note_shares
        (from_uid, to_uid, bvid, title, body_md, notes_json, mode, from_uname, status, created_at, expires_at)
      VALUES
        (:fromUid, :toUid, :bvid, :title, :bodyMd, :notesJson, :mode, :fromUname, 'pending', :now, :expiresAt)
    `,
      {
        fromUid,
        toUid,
        bvid,
        title: title || bvid,
        bodyMd,
        notesJson,
        mode,
        fromUname,
        now,
        expiresAt: now + SHARE_TTL_MS,
      }
    );
    res.json({
      ok: true,
      shareId: Number(result?.insertId) || null,
      bvid,
      toUid,
    });
  } catch (err) {
    if (String(err?.code) === 'ER_DUP_ENTRY') {
      res.status(409).json({ ok: false, error: 'already_sent' });
      return;
    }
    throw err;
  }
}

async function handleNoteInbox(req, res) {
  const uid = req.uid;
  const now = Date.now();
  await purgeExpiredShares(now);
  const rows = await query(
    `
    SELECT id, from_uid AS fromUid, from_uname AS fromUname, bvid, title,
           created_at AS createdAt, expires_at AS expiresAt
    FROM friend_note_shares
    WHERE to_uid = :uid AND status = 'pending' AND expires_at >= :now
    ORDER BY id DESC
    LIMIT 50
  `,
    { uid, now }
  );
  const shares = rows.map((r) => ({
    id: Number(r.id),
    fromUid: r.fromUid,
    fromUname: displayName(r.fromUname, r.fromUid),
    bvid: r.bvid,
    title: r.title || r.bvid,
    createdAt: Number(r.createdAt) || 0,
    expiresAt: Number(r.expiresAt) || 0,
  }));
  res.json({ ok: true, shares });
}

async function loadPendingShare(id, toUid) {
  const rows = await query(
    `
    SELECT id, from_uid AS fromUid, from_uname AS fromUname, bvid, title,
           body_md AS bodyMd, notes_json AS notesJson, mode, status,
           created_at AS createdAt, expires_at AS expiresAt
    FROM friend_note_shares
    WHERE id = :id AND to_uid = :toUid
    LIMIT 1
  `,
    { id, toUid }
  );
  return rows[0] || null;
}

async function handleAcceptNote(req, res) {
  const uid = req.uid;
  const id = Number(req.params?.id || req.body?.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'missing_id' });
    return;
  }
  const now = Date.now();
  await purgeExpiredShares(now);
  const row = await loadPendingShare(id, uid);
  if (!row) {
    res.status(404).json({ ok: false, error: 'share_not_found' });
    return;
  }
  if (row.status !== 'pending') {
    res.status(409).json({ ok: false, error: 'already_resolved', status: row.status });
    return;
  }
  if (Number(row.expiresAt) && Number(row.expiresAt) < now) {
    res.status(410).json({ ok: false, error: 'share_expired' });
    return;
  }

  await query(
    `
    UPDATE friend_note_shares
    SET status = 'accepted', resolved_at = :now
    WHERE id = :id AND to_uid = :uid AND status = 'pending'
  `,
    { id, uid, now }
  );

  let notes = null;
  if (row.notesJson) {
    try {
      notes = JSON.parse(row.notesJson);
    } catch {
      notes = null;
    }
  }

  res.json({
    ok: true,
    note: {
      bvid: row.bvid,
      title: row.title || row.bvid,
      bodyMd: row.bodyMd || '',
      notes,
      mode: row.mode || 'user',
      fromUid: row.fromUid,
      fromUname: displayName(row.fromUname, row.fromUid),
    },
  });
}

async function handleRejectNote(req, res) {
  const uid = req.uid;
  const id = Number(req.params?.id || req.body?.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'missing_id' });
    return;
  }
  const now = Date.now();
  const row = await loadPendingShare(id, uid);
  if (!row) {
    res.status(404).json({ ok: false, error: 'share_not_found' });
    return;
  }
  if (row.status !== 'pending') {
    res.status(409).json({ ok: false, error: 'already_resolved', status: row.status });
    return;
  }
  await query(
    `
    UPDATE friend_note_shares
    SET status = 'rejected', resolved_at = :now
    WHERE id = :id AND to_uid = :uid AND status = 'pending'
  `,
    { id, uid, now }
  );
  res.json({ ok: true });
}

module.exports = {
  handleShareNote,
  handleNoteInbox,
  handleAcceptNote,
  handleRejectNote,
};
