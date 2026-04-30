CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cf_image_id TEXT UNIQUE NOT NULL,
  team_category TEXT NOT NULL CHECK (team_category IN ('u15','u17d1','u17d2')),
  event_type TEXT NOT NULL DEFAULT 'game'
    CHECK (event_type IN ('game','practice','team_event','tournament','other')),
  event_name_fr TEXT NOT NULL,
  event_date TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  file_size_bytes INTEGER,
  mime_type TEXT,
  caption_fr TEXT,
  caption_en TEXT,
  uploaded_by TEXT DEFAULT 'Admin',
  is_published INTEGER NOT NULL DEFAULT 1,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_photos_team_date ON photos(team_category, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_photos_published_date ON photos(is_published, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_photos_team_type_date ON photos(team_category, event_type, event_date DESC);
