-- update_schema_v8_library_cutouts.sql
-- Adds cutout_r2_key column to photo_library for D07 (compose stage).
--
-- Background-removed cutout PNGs are stored in the canonniers-cards R2 bucket
-- under cutouts/{uuid}.png (publicly reachable via cards.canonniersdequebec.ca,
-- same posture as generated cards — content-hash unguessable keys, no auth gate)
-- so that Puppeteer can fetch them when rendering cards without needing auth
-- headers. The cutout itself is generated via canonniers-claude-proxy/removebg.
--
-- Migration is idempotent + additive. Rollback = simply ignore the new column.

ALTER TABLE photo_library ADD COLUMN cutout_r2_key TEXT NULL;
