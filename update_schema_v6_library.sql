-- Schema v6: Photo library with lazy classification
-- Rollback: DROP TABLE photo_library;

CREATE TABLE IF NOT EXISTS photo_library (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key          TEXT    NOT NULL UNIQUE,
  thumb_r2_key    TEXT    NOT NULL,
  filename        TEXT    NOT NULL,
  size_bytes      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  mime_type       TEXT    NOT NULL,

  uploaded_by     TEXT    NOT NULL,
  uploaded_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Lazy classification (E1c: multi-team)
  linked_teams      TEXT,                                       -- JSON array, e.g. '["u17d1"]' or '["u15","u17d1"]'
  linked_player_ids TEXT,                                       -- JSON array of player ids ever assigned
  first_linked_at   TEXT,
  last_linked_at    TEXT,

  -- Gallery push tracking
  pushed_to_gallery_at TEXT,
  pushed_to_gallery_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_lib_uploaded_at  ON photo_library(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_lib_filename     ON photo_library(filename);
CREATE INDEX IF NOT EXISTS idx_lib_linked_teams ON photo_library(linked_teams);
