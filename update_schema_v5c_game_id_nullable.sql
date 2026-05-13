-- Migration v5c: Fix generated_cards schema issues
--   1. game_id TEXT NOT NULL → TEXT NULL
--   2. season  TEXT NOT NULL → TEXT NULL
--   3. idx_cards_content_hash → add WHERE content_hash IS NOT NULL
--
-- Uses rename-recreate-drop (SQLite cannot ALTER COLUMN).
-- Safe to run on empty table; INSERT INTO ... SELECT included for completeness.
--
-- Rollback (do not commit — run manually if needed):
--   DROP TABLE IF EXISTS generated_cards;
--   ALTER TABLE generated_cards_old RENAME TO generated_cards;
--   CREATE INDEX idx_cards_game ON generated_cards(game_id) WHERE deleted_at IS NULL;
--   CREATE INDEX idx_cards_team_season ON generated_cards(team_id, season, created_at DESC) WHERE deleted_at IS NULL;
--   CREATE INDEX idx_cards_published ON generated_cards(game_id, published) WHERE deleted_at IS NULL AND archived = 0;
--   CREATE INDEX idx_cards_season ON generated_cards(season, created_at DESC) WHERE deleted_at IS NULL;
--   CREATE UNIQUE INDEX idx_cards_content_hash ON generated_cards(content_hash);

-- Step 1: rename existing table
ALTER TABLE generated_cards RENAME TO generated_cards_old;

-- Step 2: create corrected table
CREATE TABLE generated_cards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      TEXT,
  team_id      TEXT    NOT NULL,
  season       TEXT,
  template     TEXT    NOT NULL,
  lang         TEXT    NOT NULL,
  size_variant TEXT    NOT NULL,
  r2_key       TEXT    NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  metadata     TEXT,
  content_hash TEXT
);

-- Step 3: migrate existing rows (none expected; included for safety)
INSERT INTO generated_cards
  (id, game_id, team_id, season, template, lang, size_variant, r2_key,
   published, published_at, archived, created_by, created_at,
   deleted_at, metadata, content_hash)
SELECT
   id, game_id, team_id, season, template, lang, size_variant, r2_key,
   published, published_at, archived, created_by, created_at,
   deleted_at, metadata, content_hash
FROM generated_cards_old;

-- Step 4: drop old table
DROP TABLE generated_cards_old;

-- Step 5: recreate indexes (content_hash index now filtered)
CREATE INDEX idx_cards_game ON generated_cards(game_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_cards_team_season ON generated_cards(team_id, season, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_cards_published ON generated_cards(game_id, published)
  WHERE deleted_at IS NULL AND archived = 0;

CREATE INDEX idx_cards_season ON generated_cards(season, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_cards_content_hash ON generated_cards(content_hash)
  WHERE content_hash IS NOT NULL;
