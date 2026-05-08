-- coach_photos: one row per coach slug, updated in-place on photo change
-- coach_id: surrogate PK (stable FK anchor for future bio columns)
-- r2_key: stored separately so old-photo cleanup never parses photo_url strings
CREATE TABLE IF NOT EXISTS coach_photos (
  coach_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL,
  photo_url  TEXT    NOT NULL,
  r2_key     TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_photos_slug ON coach_photos (slug);
