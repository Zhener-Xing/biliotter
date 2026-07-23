const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(__dirname, '.bili-pet-notes.db');
const LEGACY_BUFFER_FILE = path.join(__dirname, '.bili-pet-notes-buffer.json');
const ASSETS_DIR = path.join(__dirname, 'notes-assets');

const MODES = new Set(['ai', 'user', 'collab']);

let db = null;

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
}//标准化笔记hua wei zi f

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
}

function ensureColumn(database, table, column, typeSql) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
}

function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
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
  migrateLegacyBufferOnce(db);
  backfillBodyMd(db);
  backfillAllChunksIfEmpty(db);
  return db;
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
  // 旧库可能没有 folder_id：先补列，再建索引
  ensureColumn(database, 'course_group_items', 'folder_id', 'TEXT');
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

/** 从 BV 号或 bilibili 视频 URL 中解析 bvid */
function normalizeBvid(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const fromUrl = raw.match(/BV[\w]+/i);
  if (fromUrl) return fromUrl[0];
  if (/^BV[\w]+$/i.test(raw)) return raw;
  return '';
}

function parseMetaJson(raw) {
  try {
    const obj = JSON.parse(String(raw || '{}'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

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
}

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
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    itemCount: items.length,
    folderCount: folders.length,
    folders,
    items,
  };
}

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
    return { ok: true, deleted: info.changes > 0, id: key };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

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
}

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
}

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
      // 文件夹删掉后，里面的视频回到课程组根目录
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
      /* ignore */
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
}

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
}//切块

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

/** 首次建表后若 chunks 为空，把已有笔记全部切一遍；之后补齐缺 chunk 的笔记 */
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

    // 部分笔记有正文但从未建 chunk（早期版本/半迁移）
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
}

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
]);

/** 从中文问句抽出可用于 FTS/LIKE 的词，避免整句 AND 匹配失败 */
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
    // 优先较长片段：去掉常见疑问尾巴后再切 2~4 字
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
}

function searchByLike(database, terms, { bvidKey = null, limit = 5 } = {}) {
  const lim = Math.max(1, Math.min(20, Number(limit) || 5));
  const results = [];
  const seen = new Set();
  for (const term of terms) {
    const like = `%${String(term).replace(/[%_]/g, '')}%`;
    if (!like || like === '%%') continue;
    let rows;
    if (bvidKey) {
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
        .all(bvidKey, like, like, lim);
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
}

function searchNoteChunks(query, { bvid = null, limit = 5 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const lim = Math.max(1, Math.min(20, Number(limit) || 5));
  const database = getDb();
  const bvidKey = bvid ? String(bvid) : null;
  const terms = extractSearchTerms(q);

  if (Array.from(q).length < 3) {
    try {
      return searchByLike(database, terms.length ? terms : [q], { bvidKey, limit: lim });
    } catch (err) {
      console.warn('[bili-pet] searchNoteChunks LIKE failed:', err.message || err);
      return [];
    }
  }

  // FTS：用关键词 OR，避免整句 trigram AND 导致 0 命中
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

  // FTS 空结果 → LIKE 回退
  try {
    return searchByLike(database, terms.length ? terms : [q.slice(0, 12)], {
      bvidKey,
      limit: lim,
    });
  } catch (err) {
    console.warn('[bili-pet] searchNoteChunks LIKE fallback failed:', err.message || err);
    return [];
  }
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
    if (!fs.existsSync(LEGACY_BUFFER_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(LEGACY_BUFFER_FILE, 'utf8'));
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
      const bak = `${LEGACY_BUFFER_FILE}.migrated`;
      fs.renameSync(LEGACY_BUFFER_FILE, bak);
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
}

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

  return loadNoteDoc(key);
}

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

/**
 * 搜索笔记：标题/bvid/正文命中列表 + 分块检索片段。
 */
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
    const dir = path.join(ASSETS_DIR, safeAssetKey(key));
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore asset cleanup errors */
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
  const dir = path.join(ASSETS_DIR, key);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
  const filePath = path.join(dir, name);
  const resolved = path.normalize(filePath);
  const root = path.normalize(ASSETS_DIR + path.sep);
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
    markdown: `![截图](${url})`,
  };
}

function closeNotesDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = null;
}

module.exports = {
  DB_FILE,
  ASSETS_DIR,
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
  normalizeBvid,
  listCourseGroups,
  getCourseGroup,
  createCourseGroup,
  updateCourseGroup,
  deleteCourseGroup,
  createCourseFolder,
  updateCourseFolder,
  deleteCourseFolder,
  addCourseGroupItem,
  updateCourseGroupItem,
  removeCourseGroupItem,
};
