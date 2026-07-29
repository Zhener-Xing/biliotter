'use strict';

const { query, withTransaction } = require('./db');

async function getRevision(uid) {
  const rows = await query(
    'SELECT revision FROM sync_state WHERE uid = :uid',
    { uid }
  );
  return Number(rows[0]?.revision) || 0;
}

async function bumpRevision(conn, uid) {
  const now = Date.now();
  await conn.execute(
    `
    INSERT INTO sync_state (uid, revision, updated_at)
    VALUES (?, 1, ?)
    ON DUPLICATE KEY UPDATE
      revision = revision + 1,
      updated_at = VALUES(updated_at)
  `,
    [uid, now]
  );
  const [rows] = await conn.execute(
    'SELECT revision FROM sync_state WHERE uid = ?',
    [uid]
  );
  return Number(rows[0]?.revision) || 0;
}

async function handleKbChanges(req, res) {
  const uid = req.uid;
  const since = Math.max(0, Number(req.query.since) || 0);
  const revision = await getRevision(uid);

  const [notes, chunks, groups, folders, items, study] = await Promise.all([
    query(
      `SELECT bvid, notes_json, video_title, session_id, updated_at, created_at,
              mode, body_md, revision, sync_rev
       FROM cornell_notes WHERE uid = :uid AND sync_rev > :since`,
      { uid, since }
    ),
    query(
      `SELECT id, bvid, chunk_index, heading, text, updated_at, sync_rev
       FROM note_chunks WHERE uid = :uid AND sync_rev > :since`,
      { uid, since }
    ),
    query(
      `SELECT id, title, topic, meta_json, mindmap_md, created_at, updated_at, sync_rev
       FROM course_groups WHERE uid = :uid AND sync_rev > :since`,
      { uid, since }
    ),
    query(
      `SELECT id, group_id, title, ord, created_at, updated_at, sync_rev
       FROM course_group_folders WHERE uid = :uid AND sync_rev > :since`,
      { uid, since }
    ),
    query(
      `SELECT group_id, bvid, title, ord, status, added_at, folder_id, sync_rev
       FROM course_group_items WHERE uid = :uid AND sync_rev > :since`,
      { uid, since }
    ),
    query(
      `SELECT day, study_ms, switch_count, distract_count, updated_at, sync_rev
       FROM study_days WHERE uid = :uid AND sync_rev > :since`,
      { uid, since }
    ),
  ]);

  res.json({
    ok: true,
    uid,
    since,
    revision,
    changes: {
      notes,
      chunks,
      courseGroups: groups,
      courseFolders: folders,
      courseItems: items,
      studyDays: study,
    },
  });
}

async function handleKbPush(req, res) {
  const uid = req.uid;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const changes = body.changes && typeof body.changes === 'object' ? body.changes : {};

  const notes = Array.isArray(changes.notes) ? changes.notes : [];
  const chunksByBvid = Array.isArray(changes.noteChunks)
    ? changes.noteChunks
    : Array.isArray(changes.chunks)
      ? changes.chunks
      : [];
  const courseGroups = Array.isArray(changes.courseGroups) ? changes.courseGroups : [];
  const courseFolders = Array.isArray(changes.courseFolders) ? changes.courseFolders : [];
  const courseItems = Array.isArray(changes.courseItems) ? changes.courseItems : [];
  const studyDays = Array.isArray(changes.studyDays) ? changes.studyDays : [];

  const revision = await withTransaction(async (conn) => {
    const nextRev = await bumpRevision(conn, uid);

    for (const n of notes) {
      const bvid = String(n.bvid || '').trim();
      if (!bvid) continue;
      const isDeleted =
        n.deleted === true ||
        n.deleted === 1 ||
        n.deleted === '1' ||
        n.deleted_at != null ||
        n.deletedAt != null;
      if (isDeleted) {
        await conn.execute('DELETE FROM note_chunks WHERE uid = ? AND bvid = ?', [
          uid,
          bvid,
        ]);
        await conn.execute('DELETE FROM cornell_notes WHERE uid = ? AND bvid = ?', [
          uid,
          bvid,
        ]);
        continue;
      }
      const updatedAt = Number(n.updatedAt ?? n.updated_at) || Date.now();
      const createdAt = Number(n.createdAt ?? n.created_at) || updatedAt;
      await conn.execute(
        `
        INSERT INTO cornell_notes
          (uid, bvid, notes_json, video_title, session_id, updated_at, created_at,
           mode, body_md, revision, sync_rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          notes_json = IF(VALUES(updated_at) >= updated_at, VALUES(notes_json), notes_json),
          video_title = IF(VALUES(updated_at) >= updated_at, VALUES(video_title), video_title),
          session_id = IF(VALUES(updated_at) >= updated_at, VALUES(session_id), session_id),
          mode = IF(VALUES(updated_at) >= updated_at, VALUES(mode), mode),
          body_md = IF(VALUES(updated_at) >= updated_at, VALUES(body_md), body_md),
          revision = IF(VALUES(updated_at) >= updated_at, VALUES(revision), revision),
          updated_at = IF(VALUES(updated_at) >= updated_at, VALUES(updated_at), updated_at),
          sync_rev = IF(VALUES(updated_at) >= updated_at, VALUES(sync_rev), sync_rev)
      `,
        [
          uid,
          bvid,
          typeof n.notesJson === 'string'
            ? n.notesJson
            : JSON.stringify(n.notes || n.notes_json || {}),
          String(n.title ?? n.video_title ?? ''),
          n.sessionId ?? n.session_id ?? null,
          updatedAt,
          createdAt,
          String(n.mode || 'user'),
          String(n.bodyMd ?? n.body_md ?? ''),
          Number(n.revision) || 0,
          nextRev,
        ]
      );

      if (Array.isArray(n.chunks)) {
        await conn.execute('DELETE FROM note_chunks WHERE uid = ? AND bvid = ?', [
          uid,
          bvid,
        ]);
        for (const c of n.chunks) {
          await conn.execute(
            `
            INSERT INTO note_chunks
              (uid, bvid, chunk_index, heading, text, updated_at, sync_rev)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
            [
              uid,
              bvid,
              Number(c.chunkIndex ?? c.chunk_index) || 0,
              c.heading || null,
              String(c.text || ''),
              Number(c.updatedAt ?? c.updated_at) || updatedAt,
              nextRev,
            ]
          );
        }
      }
    }

    for (const c of chunksByBvid) {
      const bvid = String(c.bvid || '').trim();
      if (!bvid) continue;
      await conn.execute(
        `
        INSERT INTO note_chunks
          (uid, bvid, chunk_index, heading, text, updated_at, sync_rev)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          heading = VALUES(heading),
          text = VALUES(text),
          updated_at = VALUES(updated_at),
          sync_rev = VALUES(sync_rev)
      `,
        [
          uid,
          bvid,
          Number(c.chunkIndex ?? c.chunk_index) || 0,
          c.heading || null,
          String(c.text || ''),
          Number(c.updatedAt ?? c.updated_at) || Date.now(),
          nextRev,
        ]
      );
    }

    for (const g of courseGroups) {
      const id = String(g.id || '').trim();
      if (!id) continue;
      const isDeleted =
        g.deleted === true ||
        g.deleted === 1 ||
        g.deleted === '1' ||
        g.deleted_at != null ||
        g.deletedAt != null;
      if (isDeleted) {
        await conn.execute(
          'DELETE FROM course_group_items WHERE uid = ? AND group_id = ?',
          [uid, id]
        );
        await conn.execute(
          'DELETE FROM course_group_folders WHERE uid = ? AND group_id = ?',
          [uid, id]
        );
        await conn.execute('DELETE FROM course_groups WHERE uid = ? AND id = ?', [
          uid,
          id,
        ]);
        continue;
      }
      const updatedAt = Number(g.updatedAt ?? g.updated_at) || Date.now();
      await conn.execute(
        `
        INSERT INTO course_groups
          (uid, id, title, topic, meta_json, mindmap_md, created_at, updated_at, sync_rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          title = IF(VALUES(updated_at) >= updated_at, VALUES(title), title),
          topic = IF(VALUES(updated_at) >= updated_at, VALUES(topic), topic),
          meta_json = IF(VALUES(updated_at) >= updated_at, VALUES(meta_json), meta_json),
          mindmap_md = IF(VALUES(updated_at) >= updated_at, VALUES(mindmap_md), mindmap_md),
          updated_at = IF(VALUES(updated_at) >= updated_at, VALUES(updated_at), updated_at),
          sync_rev = IF(VALUES(updated_at) >= updated_at, VALUES(sync_rev), sync_rev)
      `,
        [
          uid,
          id,
          String(g.title || ''),
          String(g.topic || ''),
          typeof g.metaJson === 'string'
            ? g.metaJson
            : JSON.stringify(g.meta || g.meta_json || {}),
          String(g.mindmapMd ?? g.mindmap_md ?? ''),
          Number(g.createdAt ?? g.created_at) || updatedAt,
          updatedAt,
          nextRev,
        ]
      );
    }

    for (const f of courseFolders) {
      const id = String(f.id || '').trim();
      const isDeleted =
        f.deleted === true ||
        f.deleted === 1 ||
        f.deleted === '1' ||
        f.deleted_at != null ||
        f.deletedAt != null;
      if (isDeleted) {
        if (!id) continue;
        await conn.execute(
          'UPDATE course_group_items SET folder_id = NULL WHERE uid = ? AND folder_id = ?',
          [uid, id]
        );
        await conn.execute(
          'DELETE FROM course_group_folders WHERE uid = ? AND id = ?',
          [uid, id]
        );
        continue;
      }
      const groupId = String(f.groupId ?? f.group_id ?? '').trim();
      if (!id || !groupId) continue;
      const updatedAt = Number(f.updatedAt ?? f.updated_at) || Date.now();
      await conn.execute(
        `
        INSERT INTO course_group_folders
          (uid, id, group_id, title, ord, created_at, updated_at, sync_rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          ord = VALUES(ord),
          updated_at = VALUES(updated_at),
          sync_rev = VALUES(sync_rev)
      `,
        [
          uid,
          id,
          groupId,
          String(f.title || ''),
          Number(f.ord) || 0,
          Number(f.createdAt ?? f.created_at) || updatedAt,
          updatedAt,
          nextRev,
        ]
      );
    }

    for (const it of courseItems) {
      const groupId = String(it.groupId ?? it.group_id ?? '').trim();
      const bvid = String(it.bvid || '').trim();
      if (!groupId || !bvid) continue;
      const isDeleted =
        it.deleted === true ||
        it.deleted === 1 ||
        it.deleted === '1' ||
        it.deleted_at != null ||
        it.deletedAt != null;
      if (isDeleted) {
        await conn.execute(
          'DELETE FROM course_group_items WHERE uid = ? AND group_id = ? AND bvid = ?',
          [uid, groupId, bvid]
        );
        continue;
      }
      await conn.execute(
        `
        INSERT INTO course_group_items
          (uid, group_id, bvid, title, ord, status, added_at, folder_id, sync_rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          ord = VALUES(ord),
          status = VALUES(status),
          folder_id = VALUES(folder_id),
          sync_rev = VALUES(sync_rev)
      `,
        [
          uid,
          groupId,
          bvid,
          String(it.title || ''),
          Number(it.ord) || 0,
          String(it.status || 'planned'),
          Number(it.addedAt ?? it.added_at) || Date.now(),
          it.folderId ?? it.folder_id ?? null,
          nextRev,
        ]
      );
    }

    for (const s of studyDays) {
      const day = String(s.day || '').trim();
      if (!day) continue;
      const updatedAt = Number(s.updatedAt ?? s.updated_at) || Date.now();
      await conn.execute(
        `
        INSERT INTO study_days
          (uid, day, study_ms, switch_count, distract_count, updated_at, sync_rev)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          study_ms = IF(VALUES(updated_at) >= updated_at, VALUES(study_ms), study_ms),
          switch_count = IF(VALUES(updated_at) >= updated_at, VALUES(switch_count), switch_count),
          distract_count = IF(VALUES(updated_at) >= updated_at, VALUES(distract_count), distract_count),
          updated_at = IF(VALUES(updated_at) >= updated_at, VALUES(updated_at), updated_at),
          sync_rev = IF(VALUES(updated_at) >= updated_at, VALUES(sync_rev), sync_rev)
      `,
        [
          uid,
          day,
          Number(s.studyMs ?? s.study_ms) || 0,
          Number(s.switchCount ?? s.switch_count) || 0,
          Number(s.distractCount ?? s.distract_count) || 0,
          updatedAt,
          nextRev,
        ]
      );
    }

    return nextRev;
  });

  res.json({ ok: true, uid, revision });
}

async function handleKbRevision(req, res) {
  const uid = req.uid;
  const revision = await getRevision(uid);
  res.json({ ok: true, uid, revision });
}

module.exports = { handleKbChanges, handleKbPush, handleKbRevision, getRevision };
