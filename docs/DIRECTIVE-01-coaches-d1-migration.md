# Directive #1 — Coaches D1 Migration + Seed

**Goal:** Create a `coaches` table in D1, seed it with the 12 existing coaches from `coach.html`. No code changes to public site yet — this is pure data layer prep.

**Risk level:** Low. Pure additive migration. Existing `coach_photos` table untouched. Public site continues reading the hardcoded `COACHES` const in `coach.html` until directive #3.

**Rollback:** Restore from backup file produced in step 1.

---

## Pre-flight verification

Run from repo root in PowerShell:

```powershell
# 1. Confirm wrangler is authenticated and points at canonniers-db
wrangler d1 list

# 2. Confirm coach_photos table currently exists (sanity check we're hitting prod)
wrangler d1 execute canonniers-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

# 3. Confirm coaches table does NOT already exist
wrangler d1 execute canonniers-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='coaches';"
# Expected output: empty result set
```

If `coaches` table already exists, STOP and ping Jay — something is out of sync.

---

## Step 1 — Backup D1 BEFORE any change

```powershell
# Backup folder lives OUTSIDE the repo per convention
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = "..\canonniers-backups"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

wrangler d1 export canonniers-db --remote --output "$backupDir\canonniers-db-pre-coaches-$timestamp.sql"

# Verify file exists and has content
Get-Item "$backupDir\canonniers-db-pre-coaches-$timestamp.sql" | Select-Object Name, Length
# Expected: Length should be > 5000 bytes
```

**Do not proceed if backup file is empty or missing.**

---

## Step 2 — Create migration file

Save as `update_schema_v7_coaches.sql` in repo root:

```sql
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
```

---

## Step 3 — Apply migration

```powershell
wrangler d1 execute canonniers-db --remote --file update_schema_v7_coaches.sql
```

Expected output: `🌀 Executing on remote database canonniers-db ... ✅`

Verify table created with correct schema:

```powershell
wrangler d1 execute canonniers-db --remote --command "SELECT sql FROM sqlite_master WHERE name='coaches';"
```

Should return the CREATE TABLE statement above.

---

## Step 4 — Seed 12 coaches

Save as `seed_coaches_v7.sql` in repo root (this file gets committed for audit, but is only run once):

```sql
-- Seed initial 12 coaches from hardcoded COACHES const in coach.html (as of 2026-05-13).
-- Re-running this is safe (INSERT OR IGNORE).

-- 15U AAA
INSERT OR IGNORE INTO coaches (slug, name, number, role_fr, role_en, team) VALUES
  ('dave-dufour',             'Dave Dufour',             '10', 'Entraîneur-chef',   'Head Coach',      'u15'),
  ('mathieu-fontaine',        'Mathieu Fontaine',        '1',  'Entraîneur adjoint','Assistant Coach', 'u15'),
  ('jean-christophe-masson',  'Jean-Christophe Masson',  '22', 'Entraîneur adjoint','Assistant Coach', 'u15'),
  ('vincent-leveille',        'Vincent Léveillé',        '75', 'Entraîneur adjoint','Assistant Coach', 'u15');

-- 17U AAA D1
INSERT OR IGNORE INTO coaches (slug, name, number, role_fr, role_en, team) VALUES
  ('jonathan-landry',         'Jonathan Landry',         '12', 'Entraîneur-chef',   'Head Coach',      'u17d1'),
  ('jean-pierre-chamberland', 'Jean-Pierre Chamberland', '71', 'Entraîneur adjoint','Assistant Coach', 'u17d1'),
  ('mathieu-vachon',          'Mathieu Vachon',          '6',  'Entraîneur adjoint','Assistant Coach', 'u17d1'),
  ('loic-masse',              'Loïc Massé',              '8',  'Entraîneur adjoint','Assistant Coach', 'u17d1');

-- 17U AAA D2
INSERT OR IGNORE INTO coaches (slug, name, number, role_fr, role_en, team) VALUES
  ('mathieu-deschenes',       'Mathieu Deschênes',       '15', 'Entraîneur-chef',   'Head Coach',      'u17d2'),
  ('arthur-perrois',          'Arthur Perrois',          '16', 'Entraîneur adjoint','Assistant Coach', 'u17d2'),
  ('laurent-savard',          'Laurent Savard',          '55', 'Entraîneur adjoint','Assistant Coach', 'u17d2'),
  ('francis-verge',           'Francis Verge',           '23', 'Entraîneur adjoint','Assistant Coach', 'u17d2');
```

Run it:

```powershell
wrangler d1 execute canonniers-db --remote --file seed_coaches_v7.sql
```

Expected output: 3 successful INSERT statements, 12 rows affected total.

---

## Post-deploy verification

```powershell
# Confirm row count = 12
wrangler d1 execute canonniers-db --remote --command "SELECT COUNT(*) AS n FROM coaches;"
# Expected: n = 12

# Confirm team distribution: 4 per team
wrangler d1 execute canonniers-db --remote --command "SELECT team, COUNT(*) AS n FROM coaches GROUP BY team ORDER BY team;"
# Expected: u15=4, u17d1=4, u17d2=4

# Spot-check: one head coach per team
wrangler d1 execute canonniers-db --remote --command "SELECT team, name, role_en FROM coaches WHERE role_en='Head Coach' ORDER BY team;"
# Expected: 3 rows — Dave Dufour (u15), Jonathan Landry (u17d1), Mathieu Deschênes (u17d2)

# Confirm bio_fr/en/playing_bg defaults are empty/[]
wrangler d1 execute canonniers-db --remote --command "SELECT slug, bio_fr, bio_en, playing_bg FROM coaches WHERE slug='dave-dufour';"
# Expected: bio_fr='', bio_en='', playing_bg='[]'

# Confirm UTF-8 accents preserved (Léveillé, Massé, Deschênes)
wrangler d1 execute canonniers-db --remote --command "SELECT slug, name FROM coaches WHERE slug IN ('vincent-leveille','loic-masse','mathieu-deschenes');"
# Expected: 'Vincent Léveillé', 'Loïc Massé', 'Mathieu Deschênes' (NOT mojibake)
```

If accents are broken, STOP. The seed file needs to be saved as UTF-8 (no BOM). PowerShell's `Out-File` defaults to UTF-16 — use `Set-Content -Encoding utf8` or save from a real editor.

---

## Commit

```powershell
git add update_schema_v7_coaches.sql seed_coaches_v7.sql
git commit -m "coaches: D1 schema + initial seed (directive #1)

- New coaches table (slug PK, plaintext bios, playing_bg as JSON)
- Seeded 12 existing coaches from coach.html hardcoded const
- Public site unchanged — still reads inline COACHES const
- Foundation for upcoming worker endpoints + admin form
"
git push
```

No Pages deploy is needed for this commit — no public-facing file changed. Cloudflare Pages will run a no-op build.

---

## Open questions for Claude Code

1. Is `wrangler` authenticated in this terminal? Run `wrangler whoami` if unsure.
2. Does the backups folder exist at `..\canonniers-backups\`? Create if not.
3. After seed, does the UTF-8 accent verification pass? If mojibake appears, re-save `seed_coaches_v7.sql` as UTF-8 without BOM and re-run only the failing INSERT.

---

## Rollback plan

If anything goes wrong AFTER the seed runs:

```powershell
# Option A — drop the table cleanly (preferred if no other directive has run yet)
wrangler d1 execute canonniers-db --remote --command "DROP TABLE IF EXISTS coaches;"

# Option B — full restore from backup (only if Option A is insufficient)
wrangler d1 execute canonniers-db --remote --file "..\canonniers-backups\canonniers-db-pre-coaches-<timestamp>.sql"
# NOTE: this DROPS everything and replays the dump. Only use if you've also corrupted other tables.
```

Then `git revert` the migration commit.

---

**Stop after this directive. Do NOT proceed to directive #2 until Jay confirms verification queries all return expected results.**
