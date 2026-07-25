-- Existing DBs: run once. Ignore duplicate-column errors if already migrated.
ALTER TABLE users ADD COLUMN uname VARCHAR(64) NULL;
ALTER TABLE users ADD COLUMN last_heartbeat_at BIGINT NULL;

CREATE TABLE IF NOT EXISTS friend_invites (
  host_uid VARCHAR(32) NOT NULL,
  pin CHAR(4) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (host_uid),
  UNIQUE KEY uq_friend_invite_pin (pin),
  KEY idx_friend_invite_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS friendships (
  uid_lo VARCHAR(32) NOT NULL,
  uid_hi VARCHAR(32) NOT NULL,
  created_at BIGINT NOT NULL,
  uname_lo VARCHAR(64) NULL,
  uname_hi VARCHAR(64) NULL,
  PRIMARY KEY (uid_lo, uid_hi),
  KEY idx_friend_hi (uid_hi)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS friend_pet_cooldown (
  from_uid VARCHAR(32) NOT NULL,
  to_uid VARCHAR(32) NOT NULL,
  last_at BIGINT NOT NULL,
  PRIMARY KEY (from_uid, to_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS friend_pet_inbox (
  id BIGINT NOT NULL AUTO_INCREMENT,
  to_uid VARCHAR(32) NOT NULL,
  kind ENUM('live', 'offline') NOT NULL,
  from_uid VARCHAR(32) NULL,
  from_uname VARCHAR(64) NULL,
  from_uids_json MEDIUMTEXT NULL,
  from_unames_json MEDIUMTEXT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_pet_inbox_to (to_uid, kind, expires_at),
  KEY idx_pet_inbox_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
