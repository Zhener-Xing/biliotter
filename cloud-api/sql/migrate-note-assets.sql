-- Note screenshot / image blobs for knowledge-base sync
CREATE TABLE IF NOT EXISTS note_assets (
  uid VARCHAR(32) NOT NULL,
  bvid VARCHAR(64) NOT NULL,
  filename VARCHAR(191) NOT NULL,
  mime VARCHAR(64) NOT NULL DEFAULT 'image/png',
  bytes LONGBLOB NOT NULL,
  updated_at BIGINT NOT NULL,
  sync_rev BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, bvid, filename),
  KEY idx_assets_sync (uid, sync_rev)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
