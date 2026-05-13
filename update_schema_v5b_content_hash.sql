-- Migration v5b: Add content_hash to generated_cards for D02 render caching
-- Forward-only; do not edit update_schema_v5_cards.sql
-- Idempotent: safe to re-run
--
-- Rollback (do not commit):
--   DROP INDEX IF EXISTS idx_cards_content_hash;
--   ALTER TABLE generated_cards DROP COLUMN content_hash;

ALTER TABLE generated_cards ADD COLUMN content_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_content_hash
  ON generated_cards(content_hash);
