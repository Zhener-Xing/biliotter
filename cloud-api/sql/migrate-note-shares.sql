-- Note sharing between friends (run once on existing DBs)
CREATE TABLE IF NOT EXISTS friend_note_shares (
  id BIGINT NOT NULL AUTO_INCREMENT,
  from_uid VARCHAR(32) NOT NULL,
  to_uid VARCHAR(32) NOT NULL,
  bvid VARCHAR(64) NOT NULL,
  title VARCHAR(512) NULL,
  body_md MEDIUMTEXT NOT NULL,
  notes_json MEDIUMTEXT NULL,
  mode VARCHAR(16) NOT NULL DEFAULT 'user',
  from_uname VARCHAR(64) NULL,
  status ENUM('pending', 'accepted', 'rejected') NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  resolved_at BIGINT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_note_share_once (from_uid, to_uid, bvid),
  KEY idx_note_share_to (to_uid, status, created_at),
  KEY idx_note_share_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
