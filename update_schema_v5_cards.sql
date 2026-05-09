-- Migration v5: Add generated_cards table for the new card generator system
-- Per ADR-001 v2 (2026-05-09)
-- Idempotent: safe to re-run; uses IF NOT EXISTS

CREATE TABLE IF NOT EXISTS generated_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  season TEXT NOT NULL,
  template TEXT NOT NULL,
  lang TEXT NOT NULL,
  size_variant TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_game ON generated_cards(game_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cards_team_season ON generated_cards(team_id, season, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cards_published ON generated_cards(game_id, published)
  WHERE deleted_at IS NULL AND archived = 0;

CREATE INDEX IF NOT EXISTS idx_cards_season ON generated_cards(season, created_at DESC)
  WHERE deleted_at IS NULL;
