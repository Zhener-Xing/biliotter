const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getDataRoot, dataPath } = require('./paths');

function getLegacyDbFile() {
  return dataPath('.bili-pet-notes.db');
}
function getLegacyBufferFile() {
  return dataPath('.bili-pet-notes-buffer.json');
}
function getAssetsDir() {
  return dataPath('notes-assets');
}

const MODES = new Set(['ai', 'user', 'collab']);

let db = null;
let activeUid = null;
/** @type {string | null} */
let activeDbFile = null;
/** @type {null | ((info: { entityType: string, entityKey: string }) => void)} */
let onLocalWriteHook = null;
let suppressWriteHook = 0;

function normalizeUid(uid) {
  const s = String(uid ?? '').trim();
  if (!s || s === '0') return null;
  return s;
}

function dbPathForUid(uid) {
  const id = normalizeUid(uid);
  if (!id) return getLegacyDbFile();
  return dataPath(`.bili-pet-notes-${id}.db`);
}

function getActiveUid() {
  return activeUid;
}

function getActiveDbFile() {
  return activeDbFile || getLegacyDbFile();
}

function setOnLocalWriteHook(fn) {
  onLocalWriteHook = typeof fn === 'function' ? fn : null;
}

function migrateLegacyDbToUid(uid) {
  if (process.env.BILI_PET_SKIP_LEGACY_MIGRATE === '1') return false;
  const id = normalizeUid(uid);
  if (!id) return false;
  const target = dbPathForUid(id);
  if (fs.existsSync(target)) return false;
  if (!fs.existsSync(getLegacyDbFile())) return false;
  try {
    fs.copyFileSync(getLegacyDbFile(), target);
    for (const suffix of ['-wal', '-shm']) {
      const side = `${getLegacyDbFile()}${suffix}`;
      if (fs.existsSync(side)) {
        fs.copyFileSync(side, `${target}${suffix}`);
      }
    }
    const bak = `${getLegacyDbFile()}.migrated-${id}`;
    try {
      fs.renameSync(getLegacyDbFile(), bak);
    } catch {
      /* keep legacy if rename fails */
    }
    console.log(`[bili-pet] migrated legacy notes db → uid=${id}`);
    return true;
  } catch (err) {
    console.warn('[bili-pet] legacy db migrate failed:', err.message || err);
    return false;
  }
}

function closeNotesDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
  }
  db = null;
}

/**
 * Switch local SQLite file to this Bilibili uid.
 * Call after account switch / first bind. Migrates legacy single-file DB once.
 */
function setActiveUid(uid) {
  const next = normalizeUid(uid);
  const nextFile = dbPathForUid(next);
  if (next && !fs.existsSync(nextFile) && fs.existsSync(getLegacyDbFile())) {
    migrateLegacyDbToUid(next);
  }
  if (db && activeUid === next && activeDbFile === nextFile) {
    return { ok: true, uid: next, dbFile: nextFile, switched: false };
  }
  closeNotesDb();
  activeUid = next;
  activeDbFile = nextFile;
  if (next) getDb();
  return { ok: true, uid: next, dbFile: nextFile, switched: true };
}

function localDbExists(uid) {
  const id = normalizeUid(uid);
  if (!id) return false;
  return fs.existsSync(dbPathForUid(id));
}

/** List bvids in currently mounted DB (for asset cleanup). */
function listLocalNoteBvids() {
  try {
    const rows = getDb().prepare('SELECT bvid FROM cornell_notes').all();
    return rows.map((r) => String(r.bvid || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readBvidsFromUidFile(uid) {
  const id = normalizeUid(uid);
  if (!id) return [];
  if (activeUid === id && db) return listLocalNoteBvids();
  const file = dbPathForUid(id);
  if (!fs.existsSync(file)) return [];
  let temp = null;
  try {
    temp = new DatabaseSync(file);
    const rows = temp.prepare('SELECT bvid FROM cornell_notes').all();
    return rows.map((r) => String(r.bvid || '').trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    try {
      temp?.close();
    } catch {
      /* ignore */
    }
  }
}

function removeNoteAssetsForBvids(bvids) {
  const removed = [];
  for (const bvid of bvids || []) {
    const key = safeAssetKey(bvid);
    if (!key) continue;
    const dir = path.join(getAssetsDir(), key);
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch (err) {
      console.warn('[bili-pet] asset purge failed:', dir, err.message || err);
    }
  }
  return removed;
}

function hasLocalKbData() {
  try {
    const database = getDb();
    const note = database.prepare('SELECT 1 AS ok FROM cornell_notes LIMIT 1').get();
    if (note) return true;
    const study = database.prepare('SELECT 1 AS ok FROM study_days LIMIT 1').get();
    if (study) return true;
    const group = database.prepare('SELECT 1 AS ok FROM course_groups LIMIT 1').get();
    return Boolean(group);
  } catch {
    return false;
  }
}

/** Discover uid SQLite files on disk (non-active leftovers). */
function listUidDbFilesOnDisk() {
  const out = [];
  let names = [];
  const root = getDataRoot();
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = /^\.bili-pet-notes-(\d+)\.db$/.exec(name);
    if (!m) continue;
    out.push({ uid: m[1], file: path.join(root, name) });
  }
  return out;
}

/**
 * Close DB if active, delete this uid's SQLite files (+ wal/shm) and note assets.
 */
function purgeUidLocalStore(uid) {
  const id = normalizeUid(uid);
  if (!id) return { ok: false, error: 'no_uid' };
  const file = dbPathForUid(id);
  const assetBvids = readBvidsFromUidFile(id);

  if (activeUid === id) {
    closeNotesDb();
    activeUid = null;
    activeDbFile = getLegacyDbFile();
  }

  const removedAssets = removeNoteAssetsForBvids(assetBvids);
  const removed = [...removedAssets];
  for (const p of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    } catch (err) {
      console.warn('[bili-pet] purge unlink failed:', p, err.message || err);
      return { ok: false, error: err.message || String(err), uid: id };
    }
  }
  console.log(
    `[bili-pet] purged local store uid=${id} files=${removed.length} assets=${removedAssets.length}`
  );
  return { ok: true, uid: id, removed, removedAssets };
}

function normalizeMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return MODES.has(m) ? m : 'user';
}

function normalizeNotes(notes) {
  if (!notes || typeof notes !== 'object') return null;
  const next = {
    title: String(notes.title || '').trim(),
    cues: Array.isArray(notes.cues)
      ? notes.cues.map((x) => String(x || '').trim()).filter(Boolean)
      : [],
    notes: Array.isArray(notes.notes)
      ? notes.notes.map((x) => String(x || '').trim()).filter(Boolean)
      : [],
    summary: String(notes.summary || '').trim(),
  };
  const has =
    next.title || next.cues.length || next.notes.length || next.summary;
  return has ? next : null;
}//标准化笔记

function cornellToMarkdown(notes) {
  const n = normalizeNotes(notes);
  if (!n) return '';
  const lines = [];
  if (n.title) lines.push(`# ${n.title}`, '');
  if (n.cues.length) {
    lines.push('## 线索', '');
    for (const c of n.cues) lines.push(`- ${c}`);
    lines.push('');
  }
  if (n.notes.length) {
    lines.push('## 要点', '');
    for (const item of n.notes) lines.push(`- ${item}`);
    lines.push('');
  }
  if (n.summary) {
    lines.push('## 总结', '', n.summary, '');
  }
  return lines.join('\n').trim() + '\n';
}//建立康奈尔结构

function ensureColumn(database, table, column, typeSql) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
}

function ensureSyncTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sync_pending (
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity_type, entity_key)
    );
    CREATE TABLE IF NOT EXISTS local_sync_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

function getDb() {
  if (db) return db;
  if (!normalizeUid(activeUid)) {
    throw new Error('no_active_uid');
  }
  db = new DatabaseSync(activeDbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cornell_notes (
      bvid TEXT PRIMARY KEY NOT NULL,
      notes_json TEXT NOT NULL DEFAULT '{}',
      video_title TEXT,
      session_id TEXT,
      updated_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'user',
      body_md TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureColumn(db, 'cornell_notes', 'mode', "TEXT NOT NULL DEFAULT 'user'");
  ensureColumn(db, 'cornell_notes', 'body_md', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'cornell_notes', 'revision', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'cornell_notes', 'created_at', 'INTEGER');
  backfillCreatedAt(db);
  ensureChunkTables(db);
  ensureCourseGroupTables(db);
  ensureStudyActivityTables(db);
  ensureSyncTables(db);
  migrateLegacyBufferOnce(db);
  backfillBodyMd(db);
  backfillAllChunksIfEmpty(db);
  return db;
}//切块

function ensureStudyActivityTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS study_days (
      day TEXT PRIMARY KEY NOT NULL,
      study_ms INTEGER NOT NULL DEFAULT 0,
      switch_count INTEGER NOT NULL DEFAULT 0,
      distract_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
}

function dayKeyFromTs(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}//日期函数

function ensureStudyDayRow(database, day, now = Date.now()) {
  database
    .prepare(
      `INSERT OR IGNORE INTO study_days (day, study_ms, switch_count, distract_count, updated_at)
       VALUES (?, 0, 0, 0, ?)`
    )
    .run(day, now);
}

function markPending(entityType, entityKey) {
  const type = String(entityType || '').trim();
  const key = String(entityKey || '').trim();
  if (!type || !key) return;
  if (suppressWriteHook > 0) return;
  try {
    getDb()
      .prepare(
        `
        INSERT INTO sync_pending (entity_type, entity_key, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(entity_type, entity_key) DO UPDATE SET updated_at = excluded.updated_at
      `
      )
      .run(type, key, Date.now());
  } catch (err) {
    console.warn('[bili-pet] markPending failed:', err.message || err);
  }
  try {
    onLocalWriteHook?.({ entityType: type, entityKey: key });
  } catch {
    /* ignore */
  }
}

function listPending() {
  try {
    return getDb()
      .prepare(
        `SELECT entity_type AS entityType, entity_key AS entityKey, updated_at AS updatedAt
         FROM sync_pending ORDER BY updated_at ASC`
      )
      .all();
  } catch {
    return [];
  }
}

function clearPending(keys) {
  const rows = Array.isArray(keys) ? keys : [];
  if (!rows.length) return;
  const stmt = getDb().prepare(
    'DELETE FROM sync_pending WHERE entity_type = ? AND entity_key = ?'
  );
  for (const row of rows) {
    const type = String(row.entityType || row.entity_type || '').trim();
    const key = String(row.entityKey || row.entity_key || '').trim();
    if (type && key) stmt.run(type, key);
  }
}

function clearAllPending() {
  try {
    getDb().prepare('DELETE FROM sync_pending').run();
  } catch {
    /* ignore */
  }
}

function getLocalSyncMeta(key, fallback = null) {
  try {
    const row = getDb()
      .prepare('SELECT value FROM local_sync_meta WHERE key = ?')
      .get(String(key));
    return row ? String(row.value) : fallback;
  } catch {
    return fallback;
  }
}

function setLocalSyncMeta(key, value) {
  getDb()
    .prepare(
      `
      INSERT INTO local_sync_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
    )
    .run(String(key), String(value));
}

function getCloudRevision() {
  return Math.max(0, Number(getLocalSyncMeta('cloud_revision', '0')) || 0);
}

function setCloudRevision(rev) {
  setLocalSyncMeta('cloud_revision', String(Math.max(0, Number(rev) || 0)));
}

function loadChunksForBvid(bvid) {
  const key = String(bvid || '').trim();
  if (!key) return [];
  try {
    return getDb()
      .prepare(
        `SELECT bvid, chunk_index AS chunkIndex, heading, text, updated_at AS updatedAt
         FROM note_chunks WHERE bvid = ? ORDER BY chunk_index`
      )
      .all(key);
  } catch {
    return [];
  }
}

function buildPendingPushPayload() {
  const pending = listPending();
  const notes = [];
  const studyDays = [];
  const courseGroups = [];
  const courseFolders = [];
  const courseItems = [];
  const seenNotes = new Set();
  const seenStudy = new Set();
  const seenGroups = new Set();
  const seenFolders = new Set();
  const seenItems = new Set();

  for (const p of pending) {
    if (p.entityType === 'note' && !seenNotes.has(p.entityKey)) {
      seenNotes.add(p.entityKey);
      const doc = loadNoteDoc(p.entityKey);
      if (!doc) continue;
      notes.push({
        bvid: doc.bvid,
        notes: doc.notes,
        title: doc.title,
        sessionId: doc.sessionId,
        updatedAt: doc.updatedAt,
        createdAt: doc.createdAt,
        mode: doc.mode,
        bodyMd: doc.bodyMd,
        revision: doc.revision,
        chunks: loadChunksForBvid(doc.bvid),
      });
    } else if (p.entityType === 'study_day' && !seenStudy.has(p.entityKey)) {
      seenStudy.add(p.entityKey);
      const day = getStudyDay(p.entityKey);
      if (day) studyDays.push(day);
    } else if (p.entityType === 'course_group' && !seenGroups.has(p.entityKey)) {
      seenGroups.add(p.entityKey);
      const g = getCourseGroup(p.entityKey);
      if (g) {
        courseGroups.push({
          id: g.id,
          title: g.title,
          topic: g.topic,
          meta: g.meta,
          mindmapMd: g.mindmapMd || '',
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
        });
      }
    } else if (p.entityType === 'course_folder' && !seenFolders.has(p.entityKey)) {
      seenFolders.add(p.entityKey);
      try {
        const row = getDb()
          .prepare(
            `SELECT id, group_id AS groupId, title, ord, created_at AS createdAt,
                    updated_at AS updatedAt FROM course_group_folders WHERE id = ?`
          )
          .get(p.entityKey);
        if (row) courseFolders.push(row);
      } catch {
        /* ignore */
      }
    } else if (p.entityType === 'course_item' && !seenItems.has(p.entityKey)) {
      seenItems.add(p.entityKey);
      const [groupId, bvid] = String(p.entityKey).split('::');
      if (!groupId || !bvid) continue;
      try {
        const row = getDb()
          .prepare(
            `SELECT group_id AS groupId, bvid, title, ord, status, added_at AS addedAt,
                    folder_id AS folderId
             FROM course_group_items WHERE group_id = ? AND bvid = ?`
          )
          .get(groupId, bvid);
        if (row) courseItems.push(row);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    pending,
    changes: { notes, studyDays, courseGroups, courseFolders, courseItems },
  };
}

function applyRemoteChanges(changes = {}) {
  suppressWriteHook += 1;
  try {
    return applyRemoteChangesInner(changes);
  } finally {
    suppressWriteHook = Math.max(0, suppressWriteHook - 1);
  }
}

function applyRemoteChangesInner(changes = {}) {
  const notes = Array.isArray(changes.notes) ? changes.notes : [];
  const studyDays = Array.isArray(changes.studyDays) ? changes.studyDays : [];
  const courseGroups = Array.isArray(changes.courseGroups)
    ? changes.courseGroups
    : [];
  const courseFolders = Array.isArray(changes.courseFolders)
    ? changes.courseFolders
    : [];
  const courseItems = Array.isArray(changes.courseItems)
    ? changes.courseItems
    : [];

  let applied = 0;
  for (const n of notes) {
    const bvid = String(n.bvid || '').trim();
    if (!bvid) continue;
    const remoteUpdated = Number(n.updated_at ?? n.updatedAt) || 0;
    const local = loadNoteDoc(bvid);
    if (local && local.updatedAt > remoteUpdated) continue;
    let notesObj = n.notes;
    if (typeof n.notes_json === 'string') {
      try {
        notesObj = JSON.parse(n.notes_json);
      } catch {
        notesObj = null;
      }
    }
    saveNoteDoc(bvid, {
      notes: notesObj,
      title: n.video_title ?? n.title ?? '',
      sessionId: n.session_id ?? n.sessionId ?? null,
      mode: n.mode || 'user',
      bodyMd: n.body_md ?? n.bodyMd ?? '',
    });
    // saveNoteDoc marks pending — clear for this note after remote apply
    clearPending([{ entityType: 'note', entityKey: bvid }]);
    applied += 1;
  }

  for (const s of studyDays) {
    const day = String(s.day || '').trim();
    if (!day) continue;
    const remoteUpdated = Number(s.updated_at ?? s.updatedAt) || 0;
    const local = getStudyDay(day);
    if (local && Number(local.updatedAt) > remoteUpdated) continue;
    const database = getDb();
    ensureStudyDayRow(database, day, remoteUpdated || Date.now());
    database
      .prepare(
        `UPDATE study_days
         SET study_ms = ?, switch_count = ?, distract_count = ?, updated_at = ?
         WHERE day = ?`
      )
      .run(
        Number(s.study_ms ?? s.studyMs) || 0,
        Number(s.switch_count ?? s.switchCount) || 0,
        Number(s.distract_count ?? s.distractCount) || 0,
        remoteUpdated || Date.now(),
        day
      );
    clearPending([{ entityType: 'study_day', entityKey: day }]);
    applied += 1;
  }

  for (const g of courseGroups) {
    const id = String(g.id || '').trim();
    if (!id) continue;
    const database = getDb();
    const updatedAt = Number(g.updated_at ?? g.updatedAt) || Date.now();
    const metaJson =
      typeof g.meta_json === 'string'
        ? g.meta_json
        : JSON.stringify(g.meta || {});
    database
      .prepare(
        `
        INSERT INTO course_groups (id, title, topic, meta_json, mindmap_md, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          topic = excluded.topic,
          meta_json = excluded.meta_json,
          mindmap_md = excluded.mindmap_md,
          updated_at = excluded.updated_at
      `
      )
      .run(
        id,
        String(g.title || ''),
        String(g.topic || ''),
        metaJson,
        String(g.mindmap_md ?? g.mindmapMd ?? ''),
        Number(g.created_at ?? g.createdAt) || updatedAt,
        updatedAt
      );
    clearPending([{ entityType: 'course_group', entityKey: id }]);
    applied += 1;
  }

  for (const f of courseFolders) {
    const id = String(f.id || '').trim();
    const groupId = String(f.group_id ?? f.groupId ?? '').trim();
    if (!id || !groupId) continue;
    const updatedAt = Number(f.updated_at ?? f.updatedAt) || Date.now();
    getDb()
      .prepare(
        `
        INSERT INTO course_group_folders (id, group_id, title, ord, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          ord = excluded.ord,
          updated_at = excluded.updated_at
      `
      )
      .run(
        id,
        groupId,
        String(f.title || ''),
        Number(f.ord) || 0,
        Number(f.created_at ?? f.createdAt) || updatedAt,
        updatedAt
      );
    clearPending([{ entityType: 'course_folder', entityKey: id }]);
    applied += 1;
  }

  for (const it of courseItems) {
    const groupId = String(it.group_id ?? it.groupId ?? '').trim();
    const bvid = String(it.bvid || '').trim();
    if (!groupId || !bvid) continue;
    getDb()
      .prepare(
        `
        INSERT INTO course_group_items (group_id, bvid, title, ord, status, added_at, folder_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id, bvid) DO UPDATE SET
          title = excluded.title,
          ord = excluded.ord,
          status = excluded.status,
          folder_id = excluded.folder_id
      `
      )
      .run(
        groupId,
        bvid,
        String(it.title || ''),
        Number(it.ord) || 0,
        String(it.status || 'planned'),
        Number(it.added_at ?? it.addedAt) || Date.now(),
        it.folder_id ?? it.folderId ?? null
      );
    clearPending([
      { entityType: 'course_item', entityKey: `${groupId}::${bvid}` },
    ]);
    applied += 1;
  }

  return { ok: true, applied };
}

function hasPendingSync() {
  return listPending().length > 0;
}

function addStudyMs(ms, at = Date.now()) {
  const amount = Math.max(0, Math.floor(Number(ms) || 0));
  if (!amount) return getStudyDay(dayKeyFromTs(at));
  const database = getDb();
  const day = dayKeyFromTs(at);
  const now = Date.now();
  ensureStudyDayRow(database, day, now);
  database
    .prepare(
      `UPDATE study_days
       SET study_ms = study_ms + ?, updated_at = ?
       WHERE day = ?`
    )
    .run(amount, now, day);
  markPending('study_day', day);
  return getStudyDay(day);
}//获取学习日期函数

function addSwitchCount(n = 1, at = Date.now()) {
  const amount = Math.max(0, Math.floor(Number(n) || 0));
  if (!amount) return getStudyDay(dayKeyFromTs(at));
  const database = getDb();
  const day = dayKeyFromTs(at);
  const now = Date.now();
  ensureStudyDayRow(database, day, now);
  database
    .prepare(
      `UPDATE study_days
       SET switch_count = switch_count + ?, updated_at = ?
       WHERE day = ?`
    )
    .run(amount, now, day);
  markPending('study_day', day);
  return getStudyDay(day);
}

function addDistractCount(n = 1, at = Date.now()) {
  const amount = Math.max(0, Math.floor(Number(n) || 0));
  if (!amount) return getStudyDay(dayKeyFromTs(at));
  const database = getDb();
  const day = dayKeyFromTs(at);
  const now = Date.now();
  ensureStudyDayRow(database, day, now);
  database
    .prepare(
      `UPDATE study_days
       SET distract_count = distract_count + ?, updated_at = ?
       WHERE day = ?`
    )
    .run(amount, now, day);
  markPending('study_day', day);
  return getStudyDay(day);
}//增加分心函数，可以写到另一个文件去

function getStudyDay(day) {
  const key = String(day || dayKeyFromTs());
  const row = getDb()
    .prepare(
      `SELECT day, study_ms AS studyMs, switch_count AS switchCount,
              distract_count AS distractCount, updated_at AS updatedAt
       FROM study_days WHERE day = ?`
    )
    .get(key);
  if (!row) {
    return {
      day: key,
      studyMs: 0,
      switchCount: 0,
      distractCount: 0,
      interruptCount: 0,
      updatedAt: null,
    };
  }
  return {
    day: row.day,
    studyMs: Number(row.studyMs) || 0,
    switchCount: Number(row.switchCount) || 0,
    distractCount: Number(row.distractCount) || 0,
    interruptCount: (Number(row.switchCount) || 0) + (Number(row.distractCount) || 0),
    updatedAt: row.updatedAt == null ? null : Number(row.updatedAt),
  };
}


function listStudyActivity(opts = {}) {
  const days = Math.min(400, Math.max(7, Math.floor(Number(opts.days) || 371)));
  const endKey = opts.endDay ? String(opts.endDay) : dayKeyFromTs();
  const endParts = endKey.split('-').map(Number);
  const endDate = new Date(endParts[0], endParts[1] - 1, endParts[2]);
  if (Number.isNaN(endDate.getTime())) {
    return listStudyActivity({ days, endDay: dayKeyFromTs() });
  }

  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (days - 1));
  const startKey = dayKeyFromTs(startDate.getTime());

  const rows = getDb()
    .prepare(
      `SELECT day, study_ms AS studyMs, switch_count AS switchCount,
              distract_count AS distractCount, updated_at AS updatedAt
       FROM study_days
       WHERE day >= ? AND day <= ?
       ORDER BY day ASC`
    )
    .all(startKey, endKey);

  const byDay = new Map();
  for (const row of rows) {
    const switchCount = Number(row.switchCount) || 0;
    const distractCount = Number(row.distractCount) || 0;
    byDay.set(row.day, {
      day: row.day,
      studyMs: Number(row.studyMs) || 0,
      switchCount,
      distractCount,
      interruptCount: switchCount + distractCount,
      updatedAt: row.updatedAt == null ? null : Number(row.updatedAt),
    });
  }

  const out = [];
  const cursor = new Date(startDate);
  for (let i = 0; i < days; i += 1) {
    const key = dayKeyFromTs(cursor.getTime());
    out.push(
      byDay.get(key) || {
        day: key,
        studyMs: 0,
        switchCount: 0,
        distractCount: 0,
        interruptCount: 0,
        updatedAt: null,
      }
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function ensureCourseGroupTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS course_groups (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS course_group_folders (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL,
      title TEXT NOT NULL,
      ord INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (group_id) REFERENCES course_groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_course_group_folders_group
      ON course_group_folders(group_id, ord);
    CREATE TABLE IF NOT EXISTS course_group_items (
      group_id TEXT NOT NULL,
      bvid TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      ord INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'planned',
      added_at INTEGER NOT NULL,
      folder_id TEXT,
      PRIMARY KEY (group_id, bvid),
      FOREIGN KEY (group_id) REFERENCES course_groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_course_group_items_bvid
      ON course_group_items(bvid);
  `);
  //SQLite逻辑
  ensureColumn(database, 'course_group_items', 'folder_id', 'TEXT');
  ensureColumn(database, 'course_groups', 'mindmap_md', "TEXT NOT NULL DEFAULT ''");
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_course_group_items_folder
      ON course_group_items(group_id, folder_id);
  `);
}

function makeCourseGroupId() {
  return `cg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeCourseFolderId() {
  return `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeBvid(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const fromUrl = raw.match(/BV[\w]+/i);
  if (fromUrl) return fromUrl[0];
  if (/^BV[\w]+$/i.test(raw)) return raw;
  return '';
}//解析BVID

function parseMetaJson(raw) {
  try {
    const obj = JSON.parse(String(raw || '{}'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}//解析JSON格式

function touchCourseGroup(database, groupId, now = Date.now()) {
  database
    .prepare('UPDATE course_groups SET updated_at = ? WHERE id = ?')
    .run(now, groupId);
}

function listFoldersForGroup(database, groupId) {
  const rows = database
    .prepare(
      `
      SELECT f.*,
        (SELECT COUNT(*) FROM course_group_items i
         WHERE i.group_id = f.group_id AND i.folder_id = f.id) AS item_count
      FROM course_group_folders f
      WHERE f.group_id = ?
      ORDER BY f.ord ASC, f.created_at ASC
    `
    )
    .all(groupId);
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    title: String(r.title || '').trim() || '未命名文件夹',
    ord: Number(r.ord) || 0,
    itemCount: Number(r.item_count) || 0,
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  }));
}//课程组管理

function resolveFolderId(database, groupId, folderId) {
  if (folderId == null || folderId === '' || folderId === 'root') return null;
  const fid = String(folderId).trim();
  if (!fid) return null;
  const row = database
    .prepare(
      'SELECT id FROM course_group_folders WHERE id = ? AND group_id = ?'
    )
    .get(fid, groupId);
  return row ? row.id : undefined;
}

function rowToCourseGroup(row, { items = [], folders = [] } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    title: String(row.title || '').trim() || '未命名课程组',
    topic: String(row.topic || '').trim(),
    meta: parseMetaJson(row.meta_json),
    mindmapMd: String(row.mindmap_md || ''),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    itemCount: items.length,
    folderCount: folders.length,
    folders,
    items,
  };
}//文件夹管理逻辑

function listItemsForGroup(database, groupId) {
  const rows = database
    .prepare(
      `
      SELECT i.group_id, i.bvid, i.title, i.ord, i.status, i.added_at, i.folder_id,
             n.video_title AS note_title, n.body_md AS note_body,
             n.updated_at AS note_updated_at
      FROM course_group_items i
      LEFT JOIN cornell_notes n ON n.bvid = i.bvid
      WHERE i.group_id = ?
      ORDER BY i.ord ASC, i.added_at ASC
    `
    )
    .all(groupId);

  return rows.map((r) => {
    const noteTitle = String(r.note_title || '').trim();
    const itemTitle = String(r.title || '').trim();
    const hasNote = r.note_body != null;
    return {
      bvid: r.bvid,
      title: itemTitle || noteTitle || r.bvid,
      ord: Number(r.ord) || 0,
      status: String(r.status || 'planned'),
      addedAt: Number(r.added_at) || 0,
      folderId: r.folder_id || null,
      hasNote,
      noteTitle: noteTitle || null,
      noteUpdatedAt: hasNote ? Number(r.note_updated_at) || 0 : null,
      url: `https://www.bilibili.com/video/${r.bvid}`,
    };
  });
}

function listCourseGroups() {
  try {
    const database = getDb();
    const rows = database
      .prepare(
        `
        SELECT g.*,
          (SELECT COUNT(*) FROM course_group_items i WHERE i.group_id = g.id) AS item_count,
          (SELECT COUNT(*) FROM course_group_folders f WHERE f.group_id = g.id) AS folder_count
        FROM course_groups g
        ORDER BY g.updated_at DESC, g.created_at DESC
      `
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      title: String(row.title || '').trim() || '未命名课程组',
      topic: String(row.topic || '').trim(),
      meta: parseMetaJson(row.meta_json),
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      itemCount: Number(row.item_count) || 0,
      folderCount: Number(row.folder_count) || 0,
    }));
  } catch {
    return [];
  }
}

function getCourseGroup(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  try {
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM course_groups WHERE id = ?')
      .get(key);
    if (!row) return null;
    return rowToCourseGroup(row, {
      items: listItemsForGroup(database, key),
      folders: listFoldersForGroup(database, key),
    });
  } catch {
    return null;
  }
}

function createCourseGroup({ title, topic = '', items = [], meta = null } = {}) {
  const name = String(title || '').trim();
  if (!name) return { ok: false, error: 'title_required' };

  const id = makeCourseGroupId();
  const now = Date.now();
  const metaJson = JSON.stringify(
    meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
  );

  try {
    const database = getDb();
    withTransaction(database, () => {
      database
        .prepare(
          `
          INSERT INTO course_groups (id, title, topic, meta_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `
        )
        .run(id, name, String(topic || '').trim(), metaJson, now, now);

      const list = Array.isArray(items) ? items : [];
      const ins = database.prepare(
        `
        INSERT INTO course_group_items (group_id, bvid, title, ord, status, added_at, folder_id)
        VALUES (?, ?, ?, ?, 'planned', ?, NULL)
      `
      );
      let ord = 0;
      const seen = new Set();
      for (const raw of list) {
        const bvid = normalizeBvid(raw?.bvid ?? raw);
        if (!bvid || seen.has(bvid.toUpperCase())) continue;
        seen.add(bvid.toUpperCase());
        const itemTitle =
          raw && typeof raw === 'object'
            ? String(raw.title || '').trim()
            : '';
        ins.run(id, bvid, itemTitle, ord, now);
        ord += 1;
      }
    });
    markPending('course_group', id);
    return { ok: true, group: getCourseGroup(id) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function updateCourseGroup(id, patch = {}) {
  const key = String(id || '').trim();
  if (!key) return { ok: false, error: 'no_id' };

  try {
    const database = getDb();
    const existing = database
      .prepare('SELECT * FROM course_groups WHERE id = ?')
      .get(key);
    if (!existing) return { ok: false, error: 'not_found' };

    const title =
      patch.title != null
        ? String(patch.title).trim()
        : String(existing.title || '').trim();
    if (!title) return { ok: false, error: 'title_required' };

    const topic =
      patch.topic != null
        ? String(patch.topic).trim()
        : String(existing.topic || '').trim();

    let metaJson = existing.meta_json || '{}';
    if (patch.meta != null) {
      metaJson = JSON.stringify(
        typeof patch.meta === 'object' && !Array.isArray(patch.meta)
          ? patch.meta
          : {}
      );
    }

    const now = Date.now();
    database
      .prepare(
        `
        UPDATE course_groups
        SET title = ?, topic = ?, meta_json = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(title, topic, metaJson, now, key);

    markPending('course_group', key);
    return { ok: true, group: getCourseGroup(key) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function deleteCourseGroup(id) {
  const key = String(id || '').trim();
  if (!key) return { ok: false, error: 'no_id' };
  try {
    const database = getDb();
    const info = withTransaction(database, () => {
      database
        .prepare('DELETE FROM course_group_items WHERE group_id = ?')
        .run(key);
      database
        .prepare('DELETE FROM course_group_folders WHERE group_id = ?')
        .run(key);
      return database.prepare('DELETE FROM course_groups WHERE id = ?').run(key);
    });
    if (info.changes > 0) markPending('course_group', key);
    return { ok: true, deleted: info.changes > 0, id: key };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}//以上是基础课程组管理函数，都比较浅显按需取用

function getCourseMindmap(groupId) {
  const key = String(groupId || '').trim();
  if (!key) return { ok: false, error: 'no_id' };
  const group = getCourseGroup(key);
  if (!group) return { ok: false, error: 'not_found' };
  return {
    ok: true,
    groupId: key,
    title: group.title,
    topic: group.topic,
    mindmapMd: String(group.mindmapMd || ''),
    updatedAt: group.updatedAt,
    itemCount: group.itemCount,
    bvids: (group.items || []).map((i) => i.bvid),
  };
}//获取思维导图函数

function saveCourseMindmap(groupId, mindmapMd) {
  const key = String(groupId || '').trim();
  if (!key) return { ok: false, error: 'no_id' };
  try {
    const database = getDb();
    const existing = database
      .prepare('SELECT id FROM course_groups WHERE id = ?')
      .get(key);
    if (!existing) return { ok: false, error: 'not_found' };
    const md = String(mindmapMd || '');
    const now = Date.now();
    database
      .prepare(
        `
        UPDATE course_groups
        SET mindmap_md = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(md, now, key);
    markPending('course_group', key);
    return getCourseMindmap(key);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}//保存思维导图函数

function createCourseFolder(groupId, { title = '', ord = null } = {}) {
  const gid = String(groupId || '').trim();
  const name = String(title || '').trim();
  if (!gid) return { ok: false, error: 'no_group' };
  if (!name) return { ok: false, error: 'title_required' };

  try {
    const database = getDb();
    const group = database
      .prepare('SELECT id FROM course_groups WHERE id = ?')
      .get(gid);
    if (!group) return { ok: false, error: 'not_found' };

    let nextOrd = ord;
    if (nextOrd == null || !Number.isFinite(Number(nextOrd))) {
      const row = database
        .prepare(
          'SELECT COALESCE(MAX(ord), -1) AS m FROM course_group_folders WHERE group_id = ?'
        )
        .get(gid);
      nextOrd = Number(row?.m) + 1;
    }

    const id = makeCourseFolderId();
    const now = Date.now();
    withTransaction(database, () => {
      database
        .prepare(
          `
          INSERT INTO course_group_folders (id, group_id, title, ord, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `
        )
        .run(id, gid, name, Number(nextOrd) || 0, now, now);
      touchCourseGroup(database, gid, now);
    });
    return { ok: true, folderId: id, group: getCourseGroup(gid) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}//建立文件夹函数，按理来说不应该在这个位置，但是算了吧

function updateCourseFolder(groupId, folderId, patch = {}) {
  const gid = String(groupId || '').trim();
  const fid = String(folderId || '').trim();
  if (!gid) return { ok: false, error: 'no_group' };
  if (!fid) return { ok: false, error: 'no_folder' };

  try {
    const database = getDb();
    const existing = database
      .prepare(
        'SELECT * FROM course_group_folders WHERE id = ? AND group_id = ?'
      )
      .get(fid, gid);
    if (!existing) return { ok: false, error: 'not_found' };

    const title =
      patch.title != null
        ? String(patch.title).trim()
        : String(existing.title || '').trim();
    if (!title) return { ok: false, error: 'title_required' };

    const now = Date.now();
    withTransaction(database, () => {
      database
        .prepare(
          `
          UPDATE course_group_folders
          SET title = ?, updated_at = ?
          WHERE id = ? AND group_id = ?
        `
        )
        .run(title, now, fid, gid);
      touchCourseGroup(database, gid, now);
    });
    return { ok: true, group: getCourseGroup(gid) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}//依旧SQLite命令来的

function deleteCourseFolder(groupId, folderId) {
  const gid = String(groupId || '').trim();
  const fid = String(folderId || '').trim();
  if (!gid) return { ok: false, error: 'no_group' };
  if (!fid) return { ok: false, error: 'no_folder' };

  try {
    const database = getDb();
    const existing = database
      .prepare(
        'SELECT id FROM course_group_folders WHERE id = ? AND group_id = ?'
      )
      .get(fid, gid);
    if (!existing) return { ok: false, error: 'not_found' };

    const now = Date.now();
    withTransaction(database, () => {
      database
        .prepare(
          `
          UPDATE course_group_items
          SET folder_id = NULL
          WHERE group_id = ? AND folder_id = ?
        `
        )
        .run(gid, fid);
      database
        .prepare('DELETE FROM course_group_folders WHERE id = ? AND group_id = ?')
        .run(fid, gid);
      touchCourseGroup(database, gid, now);
    });
    return { ok: true, group: getCourseGroup(gid) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function addCourseGroupItem(
  groupId,
  { bvid, title = '', ord = null, folderId = null } = {}
) {
  const gid = String(groupId || '').trim();
  const key = normalizeBvid(bvid);
  if (!gid) return { ok: false, error: 'no_group' };
  if (!key) return { ok: false, error: 'invalid_bvid' };

  try {
    const database = getDb();
    const group = database
      .prepare('SELECT id FROM course_groups WHERE id = ?')
      .get(gid);
    if (!group) return { ok: false, error: 'not_found' };

    const resolved = resolveFolderId(database, gid, folderId);
    if (resolved === undefined) return { ok: false, error: 'folder_not_found' };

    const existing = database
      .prepare(
        'SELECT bvid FROM course_group_items WHERE group_id = ? AND bvid = ? COLLATE NOCASE'
      )
      .get(gid, key);
    if (existing) return { ok: false, error: 'already_in_group' };

    let nextOrd = ord;
    if (nextOrd == null || !Number.isFinite(Number(nextOrd))) {
      const row = database
        .prepare(
          'SELECT COALESCE(MAX(ord), -1) AS m FROM course_group_items WHERE group_id = ?'
        )
        .get(gid);
      nextOrd = Number(row?.m) + 1;
    }

    const now = Date.now();
    const itemTitle = String(title || '').trim();
    withTransaction(database, () => {
      database
        .prepare(
          `
          INSERT INTO course_group_items (group_id, bvid, title, ord, status, added_at, folder_id)
          VALUES (?, ?, ?, ?, 'planned', ?, ?)
        `
        )
        .run(gid, key, itemTitle, Number(nextOrd) || 0, now, resolved);
      touchCourseGroup(database, gid, now);
    });

    return { ok: true, group: getCourseGroup(gid) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function updateCourseGroupItem(groupId, bvid, patch = {}) {
  const gid = String(groupId || '').trim();
  const key = normalizeBvid(bvid);
  if (!gid) return { ok: false, error: 'no_group' };
  if (!key) return { ok: false, error: 'invalid_bvid' };

  try {
    const database = getDb();
    const existing = database
      .prepare(
        'SELECT * FROM course_group_items WHERE group_id = ? AND bvid = ? COLLATE NOCASE'
      )
      .get(gid, key);
    if (!existing) return { ok: false, error: 'not_found' };

    let folderId = existing.folder_id || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'folderId')) {
      const resolved = resolveFolderId(database, gid, patch.folderId);
      if (resolved === undefined) return { ok: false, error: 'folder_not_found' };
      folderId = resolved;
    }

    const title =
      patch.title != null
        ? String(patch.title).trim()
        : String(existing.title || '').trim();

    const now = Date.now();
    withTransaction(database, () => {
      database
        .prepare(
          `
          UPDATE course_group_items
          SET title = ?, folder_id = ?
          WHERE group_id = ? AND bvid = ? COLLATE NOCASE
        `
        )
        .run(title, folderId, gid, key);
      touchCourseGroup(database, gid, now);
    });
    return { ok: true, group: getCourseGroup(gid) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function removeCourseGroupItem(groupId, bvid) {
  const gid = String(groupId || '').trim();
  const key = normalizeBvid(bvid);
  if (!gid) return { ok: false, error: 'no_group' };
  if (!key) return { ok: false, error: 'invalid_bvid' };

  try {
    const database = getDb();
    const now = Date.now();
    const info = withTransaction(database, () => {
      const result = database
        .prepare(
          'DELETE FROM course_group_items WHERE group_id = ? AND bvid = ? COLLATE NOCASE'
        )
        .run(gid, key);
      if (result.changes > 0) {
        touchCourseGroup(database, gid, now);
      }
      return result;
    });
    if (!info.changes) return { ok: false, error: 'not_found' };
    return { ok: true, group: getCourseGroup(gid) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function backfillCreatedAt(database) {
  try {
    database
      .prepare(
        `UPDATE cornell_notes
         SET created_at = updated_at
         WHERE created_at IS NULL OR created_at = 0`
      )
      .run();
  } catch (err) {
    console.warn('[bili-pet] created_at backfill skipped:', err.message || err);
  }
}

const CHUNK_MAX_CHARS = 450;
const CHUNK_OVERLAP = 60;

function ensureChunkTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS note_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bvid TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading TEXT,
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_chunks_bvid
      ON note_chunks(bvid, chunk_index);
  `);

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS note_chunks_fts USING fts5(
        text,
        heading,
        bvid UNINDEXED,
        chunk_id UNINDEXED,
        tokenize = 'trigram'
      );
    `);
  } catch (err) {
    console.warn('[bili-pet] fts5 trigram unavailable, fallback:', err.message || err);
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS note_chunks_fts USING fts5(
        text,
        heading,
        bvid UNINDEXED,
        chunk_id UNINDEXED
      );
    `);
  }
}//建立笔记块表

function withTransaction(database, fn) {
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
    }
    throw err;
  }
}

function splitLongText(text, heading, maxChars, overlap) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= maxChars) {
    return [{ heading, text: chars.join('') }];
  }

  const out = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + maxChars, chars.length);
    if (end < chars.length) {
      const window = chars.slice(start, end);
      let cut = -1;
      for (let i = window.length - 1; i >= Math.floor(window.length * 0.6); i -= 1) {
        if ('。！？\n；;'.includes(window[i])) {
          cut = i + 1;
          break;
        }
      }
      if (cut > 0) end = start + cut;
    }
    const piece = chars.slice(start, end).join('').trim();
    if (piece) out.push({ heading, text: piece });
    if (end >= chars.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}//真正的切块逻辑在这里！！！！！！！！

function chunkMarkdown(bodyMd, { title = '' } = {}) {
  const md = String(bodyMd || '').replace(/\r\n/g, '\n').trim();
  if (!md) return [];

  const lines = md.split('\n');
  const sections = [];
  let heading = String(title || '').trim();
  let buf = [];

  function flush() {
    const text = buf.join('\n').trim();
    buf = [];
    if (text) sections.push({ heading, text });
  }

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      heading = String(m[2] || '').trim() || heading;
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();

  if (!sections.length) {
    sections.push({ heading: String(title || '').trim(), text: md });
  }

  const chunks = [];
  for (const sec of sections) {
    for (const part of splitLongText(sec.text, sec.heading, CHUNK_MAX_CHARS, CHUNK_OVERLAP)) {
      chunks.push(part);
    }
  }

  return chunks.map((c, i) => ({
    chunkIndex: i,
    heading: c.heading || '',
    text: c.text,
  }));
}//切块MD的逻辑

function reindexNoteChunks(bvid, bodyMd, meta = {}) {
  const key = String(bvid || '').trim();
  if (!key) return { ok: false, count: 0 };

  const database = getDb();
  const title = String(meta.title || '').trim();
  const chunks = chunkMarkdown(bodyMd, { title });
  const updatedAt = Date.now();

  const delChunks = database.prepare('DELETE FROM note_chunks WHERE bvid = ?');
  const delFts = database.prepare('DELETE FROM note_chunks_fts WHERE bvid = ?');
  const insChunk = database.prepare(`
    INSERT INTO note_chunks (bvid, chunk_index, heading, text, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insFts = database.prepare(`
    INSERT INTO note_chunks_fts (text, heading, bvid, chunk_id)
    VALUES (?, ?, ?, ?)
  `);

  withTransaction(database, () => {
    delFts.run(key);
    delChunks.run(key);
    for (const c of chunks) {
      const info = insChunk.run(key, c.chunkIndex, c.heading, c.text, updatedAt);
      insFts.run(c.text, c.heading, key, Number(info.lastInsertRowid));
    }
  });

  return { ok: true, count: chunks.length, bvid: key };
}

function backfillAllChunksIfEmpty(database) {
  try {
    const n = database.prepare('SELECT COUNT(*) AS c FROM note_chunks').get();
    if (Number(n?.c) === 0) {
      const rows = database
        .prepare('SELECT bvid, body_md, video_title FROM cornell_notes')
        .all();
      if (!rows.length) return;
      let total = 0;
      for (const row of rows) {
        const r = reindexNoteChunks(row.bvid, row.body_md || '', {
          title: row.video_title || '',
        });
        total += r.count || 0;
      }
      if (total > 0) {
        console.log(`[bili-pet] backfilled ${total} note chunks for FTS5`);
      }
      return;
    }

    const missing = database
      .prepare(
        `
        SELECT n.bvid, n.body_md, n.video_title
        FROM cornell_notes n
        WHERE TRIM(COALESCE(n.body_md, '')) != ''
          AND NOT EXISTS (SELECT 1 FROM note_chunks c WHERE c.bvid = n.bvid)
      `
      )
      .all();
    if (!missing.length) return;
    let total = 0;
    for (const row of missing) {
      const r = reindexNoteChunks(row.bvid, row.body_md || '', {
        title: row.video_title || '',
      });
      total += r.count || 0;
    }
    if (total > 0) {
      console.log(`[bili-pet] backfilled ${total} missing note chunks`);
    }
  } catch (err) {
    console.warn('[bili-pet] chunk backfill skipped:', err.message || err);
  }
}//鲁棒性函数，AI维护的

const SEARCH_STOPWORDS = new Set([
  '这个',
  '那个',
  '什么',
  '怎么',
  '如何',
  '多少',
  '几篇',
  '有没有',
  '请问',
  '一下',
  '内容',
  '笔记',
  '视频',
  '讲了',
  '在讲',
  '最近',
  '一篇',
  '我的',
  '我有',
  '是什么',
  '讲什么',
  '关于',
  '可以',
  '一下',
  '告诉',
  '帮我',
  '看看',
]);//其实我觉得不需要加，这是AI逻辑出来的

function extractSearchTerms(query) {
  const q = String(query || '').trim();
  if (!q) return [];

  const terms = [];
  const seen = new Set();
  const push = (t) => {
    const s = String(t || '').trim();
    if (s.length < 2) return;
    if (SEARCH_STOPWORDS.has(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    terms.push(s);
  };

  for (const m of q.match(/[A-Za-z][A-Za-z0-9_-]{1,}|BV[\w]+|\d+(?:\.\d+)?/g) || []) {
    push(m);
  }

  const zh = q.replace(/[^\u4e00-\u9fff]/g, '');
  if (zh.length >= 2) {
    const cleaned = zh
      .replace(/(是什么|讲什么|讲了什么|有多少|有几篇|怎么样|如何|什么意思)$/g, '')
      .replace(/^(这个|那个|我的|最近|请问)/g, '');
    const base = cleaned.length >= 2 ? cleaned : zh;
    if (base.length <= 8) {
      push(base);
    } else {
      for (let i = 0; i < base.length - 1 && terms.length < 8; i += 2) {
        push(base.slice(i, i + 3));
      }
    }
  }

  if (!terms.length && Array.from(q).length >= 2) {
    push(Array.from(q).slice(0, 8).join(''));
  }
  return terms.slice(0, 8);
}//中文逻辑字段处理

function normalizeBvidFilter({ bvid = null, bvids = null } = {}) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(bvids)) {
    for (const v of bvids) push(v);
  }
  if (bvid) push(bvid);
  return out;
}//自然语言拆成FTS匹配字节块

function searchByLike(database, terms, { bvidKey = null, bvidKeys = null, limit = 5 } = {}) {
  const lim = Math.max(1, Math.min(40, Number(limit) || 5));
  const keys =
    Array.isArray(bvidKeys) && bvidKeys.length
      ? bvidKeys
      : bvidKey
        ? [bvidKey]
        : null;
  const results = [];
  const seen = new Set();
  for (const term of terms) {
    const like = `%${String(term).replace(/[%_]/g, '')}%`;
    if (!like || like === '%%') continue;
    let rows;
    if (keys && keys.length === 1) {
      rows = database
        .prepare(
          `
          SELECT id, bvid, chunk_index AS chunkIndex, heading, text
          FROM note_chunks
          WHERE bvid = ? AND (text LIKE ? OR heading LIKE ?)
          ORDER BY chunk_index
          LIMIT ?
        `
        )
        .all(keys[0], like, like, lim);
    } else if (keys && keys.length > 1) {
      const ph = keys.map(() => '?').join(',');
      rows = database
        .prepare(
          `
          SELECT id, bvid, chunk_index AS chunkIndex, heading, text
          FROM note_chunks
          WHERE bvid IN (${ph}) AND (text LIKE ? OR heading LIKE ?)
          ORDER BY chunk_index
          LIMIT ?
        `
        )
        .all(...keys, like, like, lim);
    } else {
      rows = database
        .prepare(
          `
          SELECT id, bvid, chunk_index AS chunkIndex, heading, text
          FROM note_chunks
          WHERE text LIKE ? OR heading LIKE ?
          ORDER BY updated_at DESC, chunk_index
          LIMIT ?
        `
        )
        .all(like, like, lim);
    }
    for (const row of rows || []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      results.push(row);
      if (results.length >= lim) return results;
    }
  }
  return results;
}//依旧数据库检索逻辑

function searchNoteChunks(query, { bvid = null, bvids = null, limit = 5 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const lim = Math.max(1, Math.min(40, Number(limit) || 5));
  const database = getDb();
  const keys = normalizeBvidFilter({ bvid, bvids });
  const bvidKey = keys.length === 1 ? keys[0] : null;
  const bvidKeys = keys.length > 1 ? keys : null;
  const terms = extractSearchTerms(q);

  if (Array.from(q).length < 3) {
    try {
      return searchByLike(database, terms.length ? terms : [q], {
        bvidKey,
        bvidKeys,
        limit: lim,
      });
    } catch (err) {
      console.warn('[bili-pet] searchNoteChunks LIKE failed:', err.message || err);
      return [];
    }
  }

  const ftsTerms = (terms.length ? terms : [q])
    .map((t) => t.replace(/["*^\-{}():]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 2)
    .map((t) => `"${t}"`);
  const matchExpr = ftsTerms.join(' OR ');

  let rows = [];
  if (matchExpr) {
    try {
      if (bvidKey) {
        rows = database
          .prepare(
            `
            SELECT c.id, c.bvid, c.chunk_index AS chunkIndex, c.heading, c.text
            FROM note_chunks_fts f
            JOIN note_chunks c ON c.id = f.chunk_id
            WHERE f.bvid = ? AND note_chunks_fts MATCH ?
            ORDER BY bm25(note_chunks_fts)
            LIMIT ?
          `
          )
          .all(bvidKey, matchExpr, lim);
      } else if (bvidKeys) {
        const ph = bvidKeys.map(() => '?').join(',');
        rows = database
          .prepare(
            `
            SELECT c.id, c.bvid, c.chunk_index AS chunkIndex, c.heading, c.text
            FROM note_chunks_fts f
            JOIN note_chunks c ON c.id = f.chunk_id
            WHERE f.bvid IN (${ph}) AND note_chunks_fts MATCH ?
            ORDER BY bm25(note_chunks_fts)
            LIMIT ?
          `
          )
          .all(...bvidKeys, matchExpr, lim);
      } else {
        rows = database
          .prepare(
            `
            SELECT c.id, c.bvid, c.chunk_index AS chunkIndex, c.heading, c.text
            FROM note_chunks_fts f
            JOIN note_chunks c ON c.id = f.chunk_id
            WHERE note_chunks_fts MATCH ?
            ORDER BY bm25(note_chunks_fts)
            LIMIT ?
          `
          )
          .all(matchExpr, lim);
      }
    } catch (err) {
      console.warn('[bili-pet] searchNoteChunks FTS failed:', err.message || err);
      rows = [];
    }
  }

  if (rows.length) return rows;

  try {
    return searchByLike(database, terms.length ? terms : [q.slice(0, 12)], {
      bvidKey,
      bvidKeys,
      limit: lim,
    });
  } catch (err) {
    console.warn('[bili-pet] searchNoteChunks LIKE fallback failed:', err.message || err);
    return [];
  }
}//AI维护的命中逻辑函数，先用着，用不好再说

function listChunksForBvids(bvids, { limit = 40, perBvid = 6 } = {}) {
  const keys = normalizeBvidFilter({ bvids });
  if (!keys.length) return [];
  const lim = Math.max(1, Math.min(80, Number(limit) || 40));
  const per = Math.max(1, Math.min(20, Number(perBvid) || 6));
  const database = getDb();
  const stmt = database.prepare(
    `
    SELECT id, bvid, chunk_index AS chunkIndex, heading, text
    FROM note_chunks
    WHERE bvid = ?
    ORDER BY chunk_index
    LIMIT ?
  `
  );
  const results = [];
  for (const bv of keys) {
    for (const row of stmt.all(bv, per)) {
      results.push(row);
      if (results.length >= lim) return results;
    }
  }
  return results;
}

function gatherCourseChunks(groupId, { limit = 36 } = {}) {
  const group = getCourseGroup(groupId);
  if (!group) return { ok: false, error: 'not_found', group: null, chunks: [] };
  const bvids = (group.items || []).map((i) => i.bvid).filter(Boolean);
  if (!bvids.length) {
    return { ok: false, error: 'no_items', group, chunks: [] };
  }

  const lim = Math.max(6, Math.min(40, Number(limit) || 36));
  const query = [group.title, group.topic].filter(Boolean).join(' ').trim() || group.title;
  let chunks = query ? searchNoteChunks(query, { bvids, limit: lim }) : [];
  if (chunks.length < Math.min(8, lim)) {
    const seen = new Set(chunks.map((c) => c.id));
    for (const row of listChunksForBvids(bvids, { limit: lim, perBvid: 8 })) {
      if (seen.has(row.id)) continue;
      chunks.push(row);
      seen.add(row.id);
      if (chunks.length >= lim) break;
    }
  }
  if (!chunks.length) {
    return { ok: false, error: 'no_chunks', group, chunks: [] };
  }
  return { ok: true, group, chunks };
}

function backfillBodyMd(database) {//填充笔记内容
  const rows = database
    .prepare(
      `SELECT bvid, notes_json, body_md FROM cornell_notes
       WHERE body_md IS NULL OR TRIM(body_md) = ''`
    )
    .all();
  const upd = database.prepare(
    'UPDATE cornell_notes SET body_md = ? WHERE bvid = ?'
  );
  for (const row of rows) {
    try {
      const md = cornellToMarkdown(JSON.parse(row.notes_json || '{}'));
      if (md) upd.run(md, row.bvid);
    } catch {
      /* ignore */
    }
  }
}

function migrateLegacyBufferOnce(database) {
  try {
    if (!fs.existsSync(getLegacyBufferFile())) return;
    const raw = JSON.parse(fs.readFileSync(getLegacyBufferFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return;

    const upsert = database.prepare(`
      INSERT INTO cornell_notes (bvid, notes_json, video_title, session_id, updated_at, mode, body_md, revision)
      VALUES (?, ?, ?, ?, ?, 'ai', ?, 0)
      ON CONFLICT(bvid) DO UPDATE SET
        notes_json = excluded.notes_json,
        video_title = excluded.video_title,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        body_md = CASE
          WHEN TRIM(cornell_notes.body_md) = '' THEN excluded.body_md
          ELSE cornell_notes.body_md
        END
      WHERE excluded.updated_at >= cornell_notes.updated_at
    `);

    let migrated = 0;
    for (const [bvid, entry] of Object.entries(raw)) {
      const key = String(bvid || '').trim();
      const normalized = normalizeNotes(entry?.notes);
      if (!key || !normalized) continue;
      const md = cornellToMarkdown(normalized);
      upsert.run(
        key,
        JSON.stringify(normalized),
        String(entry.title || normalized.title || ''),
        entry.sessionId || null,
        Number(entry.updatedAt) || Date.now(),
        md
      );
      migrated += 1;
    }

    if (migrated > 0) {
      const bak = `${getLegacyBufferFile()}.migrated`;
      fs.renameSync(getLegacyBufferFile(), bak);
      console.log(`[bili-pet] migrated ${migrated} notes from JSON buffer → SQLite`);
    }
  } catch (err) {
    console.warn('[bili-pet] notes JSON→SQLite migrate skipped:', err.message || err);
  }
}

function rowToDoc(row) {
  if (!row) return null;
  let notes = null;
  try {
    notes = normalizeNotes(JSON.parse(row.notes_json || '{}'));
  } catch {
    notes = null;
  }
  const bodyMd = String(row.body_md || '');
  return {
    bvid: row.bvid,
    mode: normalizeMode(row.mode),
    bodyMd: bodyMd || (notes ? cornellToMarkdown(notes) : ''),
    notes,
    title: String(row.video_title || notes?.title || ''),
    sessionId: row.session_id || null,
    updatedAt: Number(row.updated_at) || 0,
    createdAt: Number(row.created_at) || Number(row.updated_at) || 0,
    revision: Number(row.revision) || 0,
  };
}

function loadNoteDoc(bvid) {
  const key = String(bvid || '').trim();
  if (!key) return null;
  try {
    const row = getDb()
      .prepare(
        `SELECT bvid, notes_json, video_title, session_id, updated_at, created_at, mode, body_md, revision
         FROM cornell_notes WHERE bvid = ?`
      )
      .get(key);
    return rowToDoc(row);
  } catch {
    return null;
  }
}//加载函数，没啥用，放着就行

function saveNoteDoc(bvid, patch = {}) {
  const key = String(bvid || '').trim();
  if (!key) return null;

  const existing = loadNoteDoc(key);
  const mode = normalizeMode(patch.mode || existing?.mode || 'user');
  const bodyMd =
    patch.bodyMd != null ? String(patch.bodyMd) : existing?.bodyMd || '';
  const notes =
    patch.notes != null
      ? normalizeNotes(patch.notes)
      : existing?.notes || null;
  const title =
    patch.title != null
      ? String(patch.title)
      : existing?.title || notes?.title || '';
  const sessionId =
    patch.sessionId !== undefined
      ? patch.sessionId
      : existing?.sessionId || null;
  const updatedAt = Date.now();
  const createdAt = existing?.createdAt || updatedAt;
  const revision = (existing?.revision || 0) + 1;

  getDb()
    .prepare(
      `
      INSERT INTO cornell_notes (bvid, notes_json, video_title, session_id, updated_at, created_at, mode, body_md, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bvid) DO UPDATE SET
        notes_json = excluded.notes_json,
        video_title = excluded.video_title,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        mode = excluded.mode,
        body_md = excluded.body_md,
        revision = excluded.revision
    `
    )
    .run(
      key,
      JSON.stringify(notes || {}),
      title,
      sessionId,
      updatedAt,
      createdAt,
      mode,
      bodyMd,
      revision
    );

  reindexNoteChunks(key, bodyMd, { title });

  markPending('note', key);
  return loadNoteDoc(key);
}//数据更新逻辑

function safeAssetKey(bvid) {
  const key = String(bvid || '').trim();
  if (/^BV[\w]+$/i.test(key)) return key;
  if (/^[\w.-]+$/.test(key) && !key.includes('..')) return key;
  return '_draft';
}

function listNoteDocs() {
  try {
    const rows = getDb()
      .prepare(
        `SELECT bvid, video_title, session_id, updated_at, created_at, mode, body_md, notes_json
         FROM cornell_notes
         ORDER BY COALESCE(created_at, updated_at) DESC, updated_at DESC`
      )
      .all();
    return rows.map((row) => {
      const doc = rowToDoc(row);
      const preview = String(doc.bodyMd || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      return {
        bvid: doc.bvid,
        title: doc.title || doc.bvid,
        mode: doc.mode,
        updatedAt: doc.updatedAt,
        createdAt: doc.createdAt,
        sessionId: doc.sessionId,
        preview,
        bodyLen: String(doc.bodyMd || '').length,
      };
    });
  } catch {
    return [];
  }
}


function searchNotes(query, { limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return { notes: listNoteDocs(), hits: [] };
  }

  const qLower = q.toLowerCase();
  const all = listNoteDocs();
  const notes = all.filter((n) => {
    const title = String(n.title || '').toLowerCase();
    const bvid = String(n.bvid || '').toLowerCase();
    const preview = String(n.preview || '').toLowerCase();
    return title.includes(qLower) || bvid.includes(qLower) || preview.includes(qLower);
  });

  // 正文更深检索：用 chunk 命中补全列表里没有的笔记
  const hits = searchNoteChunks(q, { limit: Math.max(5, Math.min(20, Number(limit) || 20)) });
  const seen = new Set(notes.map((n) => n.bvid));
  for (const hit of hits) {
    if (!hit?.bvid || seen.has(hit.bvid)) continue;
    const found = all.find((n) => n.bvid === hit.bvid);
    if (found) {
      notes.push(found);
      seen.add(hit.bvid);
    }
  }

  return {
    notes,
    hits: hits.map((h) => ({
      bvid: h.bvid,
      heading: h.heading || '',
      text: String(h.text || '').slice(0, 160),
      chunkIndex: h.chunkIndex,
    })),
  };
}

function deleteNoteDoc(bvid) {
  const key = String(bvid || '').trim();
  if (!key) return { ok: false, error: 'no_bvid' };
  try {
    const database = getDb();
    const info = withTransaction(database, () => {
      database.prepare('DELETE FROM note_chunks_fts WHERE bvid = ?').run(key);
      database.prepare('DELETE FROM note_chunks WHERE bvid = ?').run(key);
      return database.prepare('DELETE FROM cornell_notes WHERE bvid = ?').run(key);
    });
    const dir = path.join(getAssetsDir(), safeAssetKey(key));
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    }
    return { ok: true, deleted: info.changes > 0, bvid: key };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function saveNoteAsset(bvid, { bytes, ext = 'png', mime = 'image/png' } = {}) {
  const key = safeAssetKey(bvid);
  if (!bytes || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) {
    throw new Error('无效的图片数据');
  }
  const safeExt = String(ext || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const dir = path.join(getAssetsDir(), key);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const filePath = path.join(dir, name);
  const resolved = path.normalize(filePath);
  const root = path.normalize(getAssetsDir() + path.sep);
  if (!resolved.startsWith(root)) {
    throw new Error('非法资源路径');
  }
  fs.writeFileSync(resolved, Buffer.from(bytes));
  const url = `bilinotes://asset/${encodeURIComponent(key)}/${encodeURIComponent(name)}`;
  return {
    bvid: key,
    path: resolved,
    url,
    mime,
    markdown: `![图片](${url})`,
  };
}

module.exports = {
  getAssetsDir,
  getLegacyDbFile,
  cornellToMarkdown,
  chunkMarkdown,
  reindexNoteChunks,
  searchNoteChunks,
  searchNotes,
  loadNoteDoc,
  saveNoteDoc,
  saveNoteAsset,
  listNoteDocs,
  deleteNoteDoc,
  closeNotesDb,
  setActiveUid,
  purgeUidLocalStore,
  getActiveUid,
  getActiveDbFile,
  dbPathForUid,
  localDbExists,
  listLocalNoteBvids,
  hasLocalKbData,
  listUidDbFilesOnDisk,
  removeNoteAssetsForBvids,
  setOnLocalWriteHook,
  markPending,
  listPending,
  clearPending,
  clearAllPending,
  hasPendingSync,
  getCloudRevision,
  setCloudRevision,
  buildPendingPushPayload,
  applyRemoteChanges,
  normalizeBvid,
  listCourseGroups,
  getCourseGroup,
  createCourseGroup,
  updateCourseGroup,
  deleteCourseGroup,
  getCourseMindmap,
  saveCourseMindmap,
  gatherCourseChunks,
  listChunksForBvids,
  createCourseFolder,
  updateCourseFolder,
  deleteCourseFolder,
  addCourseGroupItem,
  updateCourseGroupItem,
  removeCourseGroupItem,
  dayKeyFromTs,
  addStudyMs,
  addSwitchCount,
  addDistractCount,
  getStudyDay,
  listStudyActivity,
};
//主要是数据库逻辑，有一部分AI维护优先让AI读逻辑，我都标注出来了
