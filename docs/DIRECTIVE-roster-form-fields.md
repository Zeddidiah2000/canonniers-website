# Directive: Upgrade Roster Editor form fields (Position, B/T, Height, Weight, Birthdate)

**Target file:** `EditRoster/index.html` (the roster editor — NOT the homepage `index.html`)
**Repo:** `canonniers-website`, branch: `main`
**Consumes data:** `alignement.html` (player display), via the Cloudflare Worker D1 API at `https://canonniers-roster-worker.chisholm2000.workers.dev`

---

## Goal

Replace the current free-text inputs for Position, B/T, Height, Weight, and Birthdate with constrained, validated inputs. Migrate height storage from string to integer inches. Ensure bilingual labels. Ensure `alignement.html` continues to render correctly after the changes.

---

## Pre-flight verification

**Do not start patching until you have done all of these:**

1. **Read the entire roster editor `index.html`** — at minimum the form section (around lines 403–476), `editPlayer` function (around line 696), `savePlayer` function (around line 721), and `renderPlayers` row template (around line 677).
2. **Read `alignement.html` end-to-end** to identify exactly how it consumes `position`, `bats_throws`, `height`, `weight`, and `birthdate`. The migration must not break the public roster display.
3. **Read the Cloudflare Worker source** for `canonniers-roster-worker` (the API). Confirm whether it does any validation, type coercion, or formatting on these fields, or whether it just forwards the JSON payload to D1. The directive below assumes the Worker is a thin pass-through; if it isn't, flag what needs to change there too.
4. **Read the current schema files** (`schema.sql`, `update_schema.sql`, `update_schema_profile.sql`) to confirm current column types.
5. **Identify any production data already in D1** — specifically, are there players with `height` values stored as strings (e.g. `"5'11\""`, `"5 ft 11"`, `"180 cm"`, etc.)? The migration needs to handle whatever is actually in there.

If any of these reveal something this directive doesn't account for, **stop and ask Jay** before patching.

---

## Schema migration

Create a new file: `update_schema_v2.sql`

```sql
-- Add new integer height column (in inches)
ALTER TABLE players ADD COLUMN height_inches INTEGER;

-- Backfill height_inches from existing string height values where parseable.
-- Existing values may be in formats like "5'11"", "6'0"", "5 ft 11", or empty.
-- This UPDATE handles the most common format: N'M" or N'M
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

-- Note: the legacy `height` TEXT column is kept for now to avoid breaking
-- anything that still reads it. A follow-up migration can drop it once
-- alignement.html and the worker have been updated to read height_inches.
```

**Verification step before applying the migration to production D1:**
- Run the migration against a local copy of the D1 database first, or against a dev D1 binding if one exists in `wrangler.toml`.
- After the UPDATE, manually `SELECT id, name, height, height_inches FROM players` and confirm the conversions look right. Any row where `height` was non-empty but `height_inches` is NULL means the regex didn't match that row's format — those need manual cleanup.
- Only run against production D1 once dev results are clean.

If `wrangler.toml` does not have a dev D1 binding, **stop and ask Jay** how he wants to test the migration before production.

---

## Form field changes (HTML)

Replace the existing fields in the `<form id="player-form">` block (around lines 411–452). Keep all bilingual labels using the existing `<span class="fr-text">` / `<span class="en-text">` pattern.

### Position — multi-select dropdown

Replace:
```html
<input type="text" id="p-position" class="field-input">
```

With a multi-select component. Recommended pattern: a styled `<details>` / `<summary>` dropdown containing checkboxes, since it works without JS frameworks and matches the existing aesthetic. Pseudo-structure:

```html
<div class="field-group">
  <label class="field-label">Position</label>
  <details class="position-dropdown">
    <summary id="position-summary" class="field-input">
      <span class="fr-text">Choisir...</span>
      <span class="en-text">Select...</span>
    </summary>
    <div class="position-options">
      <!-- one <label><input type="checkbox" value="P"> P (Lanceur / Pitcher)</label> per position -->
    </div>
  </details>
  <input type="hidden" id="p-position" name="position">
</div>
```

**Position list (use these exact codes; they are stored as the `value` and joined with `/` for display):**

| Code | FR label              | EN label       |
|------|-----------------------|----------------|
| P    | Lanceur               | Pitcher        |
| C    | Receveur              | Catcher        |
| 1B   | 1er but               | First Base     |
| 2B   | 2e but                | Second Base    |
| 3B   | 3e but                | Third Base     |
| SS   | Arrêt-court           | Shortstop      |
| LF   | Champ gauche          | Left Field     |
| CF   | Champ centre          | Center Field   |
| RF   | Champ droit           | Right Field    |
| OF   | Champ extérieur       | Outfield       |
| IF   | Champ intérieur       | Infield        |
| DH   | Frappeur désigné      | Designated Hitter |

Behavior:
- When checkboxes change, update `#p-position` (hidden input) value to the comma-joined list of selected codes (e.g. `"1B,P,3B"`).
- Update `#position-summary` text to show the codes joined with `/` (e.g. `1B/P/3B`), or "Choisir..." / "Select..." if none selected. Use the existing `fr-text`/`en-text` span pattern for the empty state.
- Order in the joined string: **preserve the order the user clicked them**, not the order they appear in the dropdown. This matches Jay's preference for displaying primary position first.
- When `editPlayer(p)` runs, parse `p.position` (the comma-joined string), check the matching boxes in stored order, and update the summary.

Storage format in D1: comma-separated codes, no spaces (`"1B,P,3B"`). Display layer joins with `/`.

### B/T — six-option select

Replace:
```html
<input type="text" id="p-bats" class="field-input">
```

With:
```html
<div class="field-group">
  <label class="field-label">B/T</label>
  <select id="p-bats" class="field-select">
    <option value="">—</option>
    <option value="R/R">R/R</option>
    <option value="R/L">R/L</option>
    <option value="L/L">L/L</option>
    <option value="L/R">L/R</option>
    <option value="S/R">S/R</option>
    <option value="S/L">S/L</option>
  </select>
</div>
```

Stored and displayed as the literal value (`R/R`, `S/L`, etc.) in both languages. Only the column header `B/T` needs a tooltip or expanded label — add a `title` attribute:
- FR: `Frappeur / Lanceur`
- EN: `Bats / Throws`

Use the existing fr-text/en-text pattern on a tooltip wrapper if you want it to localize, otherwise just `title="Bats / Throws (Frappeur / Lanceur)"` is acceptable.

### Height — feet + inches dropdowns

Replace:
```html
<input type="text" id="p-height" class="field-input">
```

With two side-by-side selects:
```html
<div class="field-group">
  <label class="field-label">
    <span class="fr-text">Grandeur</span>
    <span class="en-text">Height</span>
  </label>
  <div class="height-inputs">
    <select id="p-height-ft" class="field-select">
      <option value="">—</option>
      <!-- 4 through 7 -->
    </select>
    <span>'</span>
    <select id="p-height-in" class="field-select">
      <option value="">—</option>
      <!-- 0 through 11 -->
    </select>
    <span>"</span>
  </div>
  <input type="hidden" id="p-height-inches">
</div>
```

Behavior:
- When either dropdown changes, compute `feet * 12 + inches` and put the integer into `#p-height-inches`.
- If either dropdown is empty, `#p-height-inches` is empty (do not save partial heights).
- `editPlayer(p)`: read `p.height_inches`, set ft = Math.floor(n / 12), in = n % 12, and select those options.
- `resetForm()` must also reset both selects.

### Weight — constrained number input

Replace:
```html
<input type="text" id="p-weight" class="field-input">
```

With:
```html
<input type="number" id="p-weight" class="field-input" min="80" max="250" step="1">
```

Display format on `alignement.html` and the roster editor list view: append ` lbs` (e.g. `145 lbs`). Storage is just the integer.

If a value outside 80–250 is encountered in existing data, do not silently clamp. Show it as-is and let Jay clean it up manually.

### Birthdate — native date picker

Replace:
```html
<input type="text" id="p-birthdate" class="field-input" placeholder="YYYY-MM-DD">
```

With:
```html
<input type="date" id="p-birthdate" class="field-input">
```

Storage stays ISO `YYYY-MM-DD` (which is what `<input type="date">` produces natively).

Display format on the public-facing pages:
- FR: `14 mars 2009` (use `Date#toLocaleDateString('fr-CA', {day:'numeric', month:'long', year:'numeric'})`)
- EN: `Mar 14, 2009` (use `Date#toLocaleDateString('en-CA', {day:'numeric', month:'short', year:'numeric'})`)

If `alignement.html` already has a date formatter, reuse it. If it doesn't, add a small helper.

---

## JS changes (roster editor `index.html`)

### `editPlayer(p)` — around line 696

Update to handle the new field structure:
- Parse `p.position` (comma-string) and check the matching boxes; update the summary text.
- Set `#p-bats` directly (still a single string value).
- Read `p.height_inches`, set the ft and in dropdowns.
- Set `#p-weight` directly.
- Set `#p-birthdate` directly (ISO string is the native format).

### `savePlayer` — around line 721

Update to read the new fields:
- `position` from `#p-position` hidden input (already comma-joined).
- `bats_throws` from `#p-bats` select.
- `height_inches` from `#p-height-inches` hidden input — send as integer or `null` if empty. **Do not send the legacy `height` field anymore.**
- `weight` as integer from `#p-weight`.
- `birthdate` from `#p-birthdate` (ISO string or empty).

The PUT/POST payload object should now include `height_inches` instead of `height`. Confirm the worker accepts this — see Worker section below.

### `resetForm()` — around line 714

Update to reset the new components:
- Uncheck all position checkboxes, clear `#p-position` hidden input, reset summary text to "Choisir..." / "Select...".
- Reset `#p-bats` select to empty.
- Reset both height dropdowns and `#p-height-inches`.
- The native form reset will handle `#p-weight` and `#p-birthdate`.

### `renderPlayers` row template — around line 677

The current row template renders `${p.position}` directly. Update to:
- Display position as the codes joined with `/` (i.e. replace commas with slashes when displaying): `(p.position || '').replace(/,/g, '/') || '—'`
- Wrap in `escapeHtml(...)` (already added during the edit-button bug fix).

The list view currently doesn't show height/weight/birthdate, so no change needed in the table rows for those.

---

## Worker (canonniers-roster-worker) changes

If the worker is a thin pass-through that JSON-stringifies the payload into D1, the only change needed is to ensure it accepts `height_inches` and writes it to the right column. Confirm by reading the worker source.

If the worker has any explicit field allowlist or validation, update it to:
- Accept `height_inches` as an integer (or null).
- Continue to accept (but ignore) `height` for backward compatibility, or reject it — Jay's call. Recommendation: accept and ignore for one deploy cycle, then remove.
- Validate `weight` as integer 80–250 (server-side defense — never trust the client).
- Validate `bats_throws` against the allowed set: `['R/R','R/L','L/L','L/R','S/R','S/L', '']`.
- Validate `position` codes against the allowed set when split by comma.
- Validate `birthdate` matches `^\d{4}-\d{2}-\d{2}$` if non-empty.

Server-side validation is not optional. The form constraints can be bypassed by anyone who opens DevTools. Reject invalid payloads with HTTP 400 and a JSON error message.

---

## `alignement.html` changes

After reading `alignement.html` to confirm what it currently does, update it to:
- Display position as `code1/code2/code3` (commas in storage → slashes in display). HTML-escape the value.
- Display height by reading `height_inches`, formatting as `${ft}'${in}"` (e.g. `5'11"`). Fall back to the legacy `height` field for any rows that haven't been migrated yet — display whatever string is there.
- Display weight with ` lbs` suffix.
- Display birthdate using the localized formatter described above.

If `alignement.html` has a stats drawer that shows any of these fields, update those too. Same rules.

If `alignement.html` is currently rendering position as a single value somewhere (e.g. a "Position" badge on the player card), make sure it still works when the value contains slashes — long position strings like `1B/P/3B/SS` may need a CSS overflow rule.

---

## CSS additions

Add these to the `<style>` block in the roster editor `index.html`:

- `.position-dropdown` — wraps `<details>`. Make it look like a field-input.
- `.position-dropdown summary` — remove default disclosure triangle, match field-input styling, show a chevron.
- `.position-options` — absolutely positioned dropdown panel, with the existing card/border styling. Scrollable if it would overflow on mobile.
- `.position-options label` — block-level, padded, hover state, checkbox + text.
- `.height-inputs` — flexbox row, gap, vertically centered ' and " separators.

Match the existing design tokens (navy, sky, border, text-dim) and Barlow Condensed typography. Do not introduce new colors or fonts.

---

## Verification after patching

1. Hard refresh the admin roster editor after Cloudflare Pages deploys.
2. **Add a new player** with all new fields filled, including multiple positions. Save. Confirm:
   - Form clears.
   - Player appears in the list with positions joined by `/`.
   - Edit button on that row repopulates the form correctly (positions checked in the right order, height dropdowns set to the right values, etc.).
3. **Edit an existing player** that was created before the migration. Confirm:
   - Their height (if previously stored as `5'11"` string and migrated to 71 inches) shows correctly in the new dropdowns.
   - Their position (if previously a free-text single value like `1B`) still loads — the parser should treat it as a one-element comma-string.
   - If their old position was something like `1B/P` (already slash-separated), the migration should have handled it; check whether any cleanup is needed.
4. **Open `alignement.html`** on the live site. Confirm:
   - Positions render with `/` separator.
   - Height renders as `5'11"`.
   - Weight renders as `145 lbs`.
   - Birthdate renders in the correct localized format for both FR and EN.
   - FR/EN toggle works as expected.
5. **Try to bypass client validation** by opening DevTools, modifying the hidden inputs, and submitting. Confirm the worker rejects invalid payloads with 400. If it doesn't, the worker validation is missing or broken.

---

## Open questions for Claude Code

If anything below is unclear from the file contents, **ask Jay before guessing:**

- **Existing position data format** — are positions in production currently stored as single values (`1B`), slash-separated (`1B/P`), or something else? The directive assumes either single value or empty. If it's already slash-separated, the migration of existing rows needs to convert `/` to `,` in storage.
- **Worker code location** — is the worker source in this repo, in a separate repo, or only in the Cloudflare dashboard? If only in the dashboard, the validation changes need a separate workflow.
- **Stats drawer fields on `alignement.html`** — does the drawer display any of these fields? If yes, those need updating too.
- **Mobile layout** — the position multi-select dropdown needs to work on mobile (Jay tests on phone). Confirm the `<details>` panel doesn't get clipped by a parent `overflow: hidden` and that touch targets are large enough.
- **Existing `bats_throws` data** — are there values currently stored that don't match the new six-option set (e.g. `RR`, `R-R`, `Right/Right`)? If yes, run a normalization UPDATE in the migration.

If any of these reveal a larger problem than the directive accounts for, stop and report.

---

## Commit message (suggested)

```
feat(admin/roster): structured inputs for position, B/T, height, weight, birthdate

- Position: multi-select dropdown, stored as comma-separated codes,
  displayed with / separator
- B/T: six-option select (R/R, R/L, L/L, L/R, S/R, S/L)
- Height: feet+inches dropdowns, stored as integer inches in new
  height_inches column
- Weight: number input constrained 80-250 lbs
- Birthdate: native <input type="date">

Adds update_schema_v2.sql migration for height_inches column with
backfill from legacy height TEXT column. Legacy height column kept
for one deploy cycle for rollback safety.

Worker payload validation added for all constrained fields to defend
against client-side bypass.

alignement.html updated to consume new field formats with localized
date display.
```
