-- Soft-deleted notes (recycle bin), retained ~30 days client-side
CREATE TABLE IF NOT EXISTS note_trash (
  uid VARCHAR(32) NOT NULL,
  bvid VARCHAR(64) NOT NULL,
  notes_json MEDIUMTEXT NOT NULL,
  video_title VARCHAR(512) NULL,
  session_id VARCHAR(128) NULL,
  updated_at BIGINT NOT NULL,
  created_at BIGINT NULL,
  mode VARCHAR(16) NOT NULL DEFAULT 'user',
  body_md MEDIUMTEXT NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  deleted_at BIGINT NOT NULL,
  sync_rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, bvid),
  KEY idx_trash_sync (uid, sync_rev),
  KEY idx_trash_deleted (uid, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
