-- v7: coaches table — runtime-editable coach bio/profile data.
-- Photo data continues to live in coach_photos (referenced by slug, not FK-enforced
-- to avoid deletion coupling — photo rows can outlive a coaches row deletion if needed).
--
-- All text fields are stored as plaintext. Newlines (\n) render as <br> on the public site.
-- HTML is NOT rendered; bios are escaped on read.
--
-- playing_bg is JSON-encoded array of {level_fr, level_en, where, years}. Validated server-side.

CREATE TABLE IF NOT EXISTS coaches (
  slug            TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  number          TEXT,                          -- jersey number, stored as text (could be '00')
  role_fr         TEXT    NOT NULL,
  role_en         TEXT    NOT NULL,
  team            TEXT    NOT NULL CHECK (team IN ('u15', 'u17d1', 'u17d2')),
  coaching_since  TEXT,                          -- year string e.g. '2018', or NULL
  with_org_since  TEXT,                          -- year string e.g. '2022', or NULL
  bio_fr          TEXT    NOT NULL DEFAULT '',
  bio_en          TEXT    NOT NULL DEFAULT '',
  playing_bg      TEXT    NOT NULL DEFAULT '[]', -- JSON array
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coaches_team ON coaches (team);
