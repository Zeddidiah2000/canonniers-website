-- v2: add height_inches INTEGER column, backfill from legacy height TEXT
ALTER TABLE players ADD COLUMN height_inches INTEGER;

UPDATE players
SET height_inches =
  CAST(SUBSTR(height, 1, INSTR(height, '''') - 1) AS INTEGER) * 12
  + CAST(
      REPLACE(
        SUBSTR(height, INSTR(height, '''') + 1),
        '"', ''
      ) AS INTEGER
    )
WHERE height IS NOT NULL
  AND height != ''
  AND INSTR(height, '''') > 0;
