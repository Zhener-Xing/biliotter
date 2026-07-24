-- bili_pet cloud schema (MySQL 8+)
-- Run as app user after creating database.

CREATE TABLE IF NOT EXISTS users (
  uid VARCHAR(32) NOT NULL,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT NOT NULL,
  PRIMARY KEY (uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sync_state (
  uid VARCHAR(32) NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cornell_notes (
  uid VARCHAR(32) NOT NULL,
  bvid VARCHAR(64) NOT NULL,
  notes_json MEDIUMTEXT NOT NULL,
  video_title VARCHAR(512) NULL,
  session_id VARCHAR(128) NULL,
  updated_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  mode VARCHAR(16) NOT NULL DEFAULT 'user',
  body_md MEDIUMTEXT NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  sync_rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, bvid),
  KEY idx_cornell_sync (uid, sync_rev)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS note_chunks (
  uid VARCHAR(32) NOT NULL,
  id BIGINT NOT NULL AUTO_INCREMENT,
  bvid VARCHAR(64) NOT NULL,
  chunk_index INT NOT NULL,
  heading VARCHAR(512) NULL,
  text MEDIUMTEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  sync_rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_chunk (uid, bvid, chunk_index),
  KEY idx_chunks_sync (uid, sync_rev),
  KEY idx_chunks_bvid (uid, bvid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS course_groups (
  uid VARCHAR(32) NOT NULL,
  id VARCHAR(64) NOT NULL,
  title VARCHAR(512) NOT NULL,
  topic VARCHAR(512) NOT NULL DEFAULT '',
  meta_json MEDIUMTEXT NOT NULL,
  mindmap_md MEDIUMTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  sync_rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, id),
  KEY idx_cg_sync (uid, sync_rev)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS course_group_folders (
  uid VARCHAR(32) NOT NULL,
  id VARCHAR(64) NOT NULL,
  group_id VARCHAR(64) NOT NULL,
  title VARCHAR(512) NOT NULL,
  ord INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  sync_rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, id),
  KEY idx_cgf_group (uid, group_id),
  KEY idx_cgf_sync (uid, sync_rev)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS course_group_items (
  uid VARCHAR(32) NOT NULL,
  group_id VARCHAR(64) NOT NULL,
  bvid VARCHAR(64) NOT NULL,
  title VARCHAR(512) NOT NULL DEFAULT '',
  ord INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'planned',
  added_at BIGINT NOT NULL,
  folder_id VARCHAR(64) NULL,
  sync_rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, group_id, bvid),
  KEY idx_cgi_sync (uid, sync_rev)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS study_days (
  uid VARCHAR(32) NOT NULL,
  day CHAR(10) NOT NULL,
  study_ms BIGINT NOT NULL DEFAULT 0,
  switch_count INT NOT NULL DEFAULT 0,
  distract_count INT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  sync_rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, day),
  KEY idx_study_sync (uid, sync_rev)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
