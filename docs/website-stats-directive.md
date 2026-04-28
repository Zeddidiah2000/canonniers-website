# Stats Update Directive — Canonniers Website

> **Read this file in full before doing anything else. Read `STATS_SCHEMA.md` (in the same folder as this directive) before processing any JSON. This directive governs how approved GameChanger stats get injected into `alignement.html` and pushed to git.**

---

## 0. Project boundary — read this first

This directive lives in the **canonniers-website** project. It is the **consumer** of stats produced by a separate project called `claude-android-control`. You do not need to know how those stats were produced. You do not interact with that project's files, AVD, or extraction logic.

**You receive:** approved JSON files dropped into `stats-input/` by Jay (manually copied from the other project's `output/approved/` folder).

**You produce:** an updated `alignement.html`, a rendered preview, a backup file, and a git commit pushed to `main`.

That is the entire scope of this directive. Do not extend beyond it without Jay's explicit approval.

---

## 1. Required input

Stats files Jay drops into `stats-input/` are named:

```
<team-slug>-stats-<YYYY-MM-DD>.json
```

Examples:
- `u15-stats-2026-04-28.json`
- `u17d1-stats-2026-04-28.json`
- `u17d2-stats-2026-04-28.json`

The full JSON contract — required keys, value types, null semantics, all stat field names — lives in `STATS_SCHEMA.md`. **Read that file before processing any JSON.** It is the single source of truth between the scraper project and this project. If JSON does not match the schema, abort.

### Trust boundary

Trust the values in the JSON (numbers, names). They have already been reviewed and approved by Jay player-by-player in the other project. Your job is faithful injection, not re-validation of stat values.

**However, you DO validate:**
- The file parses as JSON.
- The file matches `STATS_SCHEMA.md` (every required key present, types correct).
- Every player has a non-null `html_id`.
- Every player's `status` is `"approved"` (entries with any other status are skipped, not injected).
- Every `html_id` exists as a `drawer-<id>` row in `alignement.html`.

If any check fails, **stop** and report to Jay. Do not partially inject.

**Players present on the team but absent from the JSON are not modified.** Their existing drawer content is preserved. Partial updates are valid and expected — Jay may approve only some players in a given run.

---

## 2. Hard rules — non-negotiable

- ❌ Do not modify any data values from the JSON. Inject as-is, with HTML escaping (Section 5).
- ❌ Do not invent stats not present in the JSON.
- ❌ Do not fabricate French translations of stat labels — use the canonical labels in Section 5.
- ❌ Do not commit or push without Jay's explicit approval after preview review.
- ❌ Do not skip the backup step.
- ❌ Do not skip the structural validation step.
- ❌ Do not push if any structural validation fails.
- ❌ Do not modify any file outside of `alignement.html` and the project's own `docs/`, `scripts/`, `preview/`, `backups/`, `stats-input/` folders during a stats update run.
- ❌ Do not touch player rows themselves (jersey, name, position, B/T, height, weight). You only modify the contents of `<div class="stat-panel">` blocks inside drawers.
- ❌ Do not commit the `backups/`, `preview/`, or `stats-input/*.json` files (gitignored — Section 9).
- ❌ Do not interpolate any JSON value into HTML without escaping (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`). This applies to every value, including numeric stats. No exceptions.

---

## 3. Workflow — order of operations

When Jay says something like "update stats" or drops a new file in `stats-input/`:

1. **Read `STATS_SCHEMA.md`.**
2. **Validate inputs** (Section 1 + schema).
3. **Pre-flight backup** (Section 4).
4. **Build the stats injection** in memory (Section 5).
5. **Write to a staging copy** at `preview/alignement.html` first, never directly to live (Section 6).
6. **Run structural validation** on the staged file (Section 7).
7. **Prompt Jay to open the preview** and confirm visually (Section 8).
8. **On confirmation, copy staged → live, commit, push** (Section 9).
9. **Update notes files** (Section 10).

If any step fails, stop and report. Do not proceed to a later step on a failed earlier step.

---

## 4. Pre-flight backup

Before any modification to `alignement.html`:

```powershell
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Path backups -Force | Out-Null
Copy-Item alignement.html "backups/alignement.html.bak-$timestamp"
```

Tell Jay the backup path so they know how to roll back: *"Backup saved to `backups/alignement.html.bak-<timestamp>`. To roll back: `Copy-Item backups/alignement.html.bak-<timestamp> alignement.html`."*

---

## 5. Stats injection

### 5.1 The markup contract

`alignement.html` already uses a `.stat-grid` / `.stat-cell` rendering system. **You inject into that existing system. Do not introduce a `<table>` element. Do not add new CSS for stats.**

Each player drawer in `alignement.html` looks like this:

```html
<tr class="stats-drawer" id="drawer-<id>"><td colspan="6"><div class="drawer-inner">
  <div class="stat-tabs">
    <button class="stat-tab active" onclick="switchStatTab(event,'<id>','bat')">...</button>
    <button class="stat-tab" onclick="switchStatTab(event,'<id>','pit')">...</button>
  </div>
  <div class="stat-panel active" id="<id>-bat">
    <!-- BATTING PANEL CONTENT — you replace inside this div -->
  </div>
  <div class="stat-panel" id="<id>-pit">
    <!-- PITCHING PANEL CONTENT — you replace inside this div -->
  </div>
</div></td></tr>
```

You replace **only the inner content** of the two `<div class="stat-panel">` blocks. The `<tr>`, the `<td>`, `drawer-inner`, `stat-tabs`, the buttons, and everything else stays untouched.

### 5.2 Batting panel — content to inject

Replace the entire inner content of `<div class="stat-panel active" id="<id>-bat">` with:

```html
<div class="stat-label fr-text">Statistiques au bâton · Saison <SEASON></div>
<div class="stat-label en-text">Batting Stats · <SEASON> Season</div>
<div class="stat-grid">
  <div class="stat-cell"><span class="stat-val">{GP}</span><span class="stat-key">GP</span></div>
  <div class="stat-cell"><span class="stat-val">{PA}</span><span class="stat-key">PA</span></div>
  <div class="stat-cell"><span class="stat-val">{AB}</span><span class="stat-key">AB</span></div>
  <div class="stat-cell"><span class="stat-val highlight">{AVG}</span><span class="stat-key">AVG</span></div>
  <div class="stat-cell"><span class="stat-val">{H}</span><span class="stat-key">H</span></div>
  <div class="stat-cell"><span class="stat-val">{TB2}</span><span class="stat-key">2B</span></div>
  <div class="stat-cell"><span class="stat-val">{TB3}</span><span class="stat-key">3B</span></div>
  <div class="stat-cell"><span class="stat-val">{HR}</span><span class="stat-key">HR</span></div>
  <div class="stat-cell"><span class="stat-val">{RBI}</span><span class="stat-key">RBI</span></div>
  <div class="stat-cell"><span class="stat-val">{R}</span><span class="stat-key">R</span></div>
  <div class="stat-cell"><span class="stat-val">{BB}</span><span class="stat-key">BB</span></div>
  <div class="stat-cell"><span class="stat-val">{SO}</span><span class="stat-key">SO</span></div>
  <div class="stat-cell"><span class="stat-val">{OBP}</span><span class="stat-key">OBP</span></div>
  <div class="stat-cell"><span class="stat-val">{SLG}</span><span class="stat-key">SLG</span></div>
  <div class="stat-cell"><span class="stat-val">{OPS}</span><span class="stat-key">OPS</span></div>
</div>
<div class="stat-updated fr-text">Mis à jour : <DATE_FR></div>
<div class="stat-updated en-text">Updated: <DATE_EN></div>
```

### 5.3 Pitching panel — content to inject

Replace the entire inner content of `<div class="stat-panel" id="<id>-pit">` with:

```html
<div class="stat-label fr-text">Statistiques en monticule · Saison <SEASON></div>
<div class="stat-label en-text">Pitching Stats · <SEASON> Season</div>
<div class="stat-grid">
  <div class="stat-cell"><span class="stat-val highlight">{IP}</span><span class="stat-key">IP</span></div>
  <div class="stat-cell"><span class="stat-val">{GP}</span><span class="stat-key">GP</span></div>
  <div class="stat-cell"><span class="stat-val">{GS}</span><span class="stat-key">GS</span></div>
  <div class="stat-cell"><span class="stat-val">{BF}</span><span class="stat-key">BF</span></div>
  <div class="stat-cell"><span class="stat-val">{W}</span><span class="stat-key">W</span></div>
  <div class="stat-cell"><span class="stat-val">{L}</span><span class="stat-key">L</span></div>
  <div class="stat-cell"><span class="stat-val">{SV}</span><span class="stat-key">SV</span></div>
  <div class="stat-cell"><span class="stat-val">{ERA}</span><span class="stat-key">ERA</span></div>
  <div class="stat-cell"><span class="stat-val">{SO}</span><span class="stat-key">SO</span></div>
  <div class="stat-cell"><span class="stat-val">{BB}</span><span class="stat-key">BB</span></div>
  <div class="stat-cell"><span class="stat-val">{WHIP}</span><span class="stat-key">WHIP</span></div>
  <div class="stat-cell"><span class="stat-val">{H}</span><span class="stat-key">H</span></div>
  <div class="stat-cell"><span class="stat-val">{R}</span><span class="stat-key">R</span></div>
  <div class="stat-cell"><span class="stat-val">{ER}</span><span class="stat-key">ER</span></div>
</div>
<div class="stat-updated fr-text">Mis à jour : <DATE_FR></div>
<div class="stat-updated en-text">Updated: <DATE_EN></div>
```

### 5.4 Field name mapping (JSON → template token)

The placeholders in braces above (e.g., `{GP}`, `{TB2}`, `{ERA}`) map to JSON keys defined in `STATS_SCHEMA.md`. The schema is authoritative. If you find a token in the templates above that does not appear in the schema, abort and tell Jay.

Note: HTML id-safe placeholders use `TB2` and `TB3` (because `{2B}` and `{3B}` start with digits and are awkward in some script regexes). The rendered output still shows `2B` and `3B` as the stat key label — see the templates above where `<span class="stat-key">2B</span>` is hard-coded.

### 5.5 Value rendering rules

| JSON value | Rendered as |
|---|---|
| `null` | `—` (em dash, U+2014) |
| Integer (e.g., `5`) | `5` |
| Decimal `< 1` (e.g., `0.333`) | `.333` (drop the leading zero — baseball convention for AVG/OBP/SLG/OPS) |
| Decimal `>= 1` (e.g., `1.250`) | `1.250` (keep as-is, three decimals where present) |
| Decimal IP (e.g., `12.2`) | `12.2` (IP uses thirds — never reformat or round) |

**Every rendered value goes through HTML escaping** before insertion. No exceptions.

### 5.6 Date formatting

- `<SEASON>` = JSON's `season` field (e.g., `2026`).
- `<DATE_FR>` formatted with `Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' })` → `28 avril 2026`.
- `<DATE_EN>` formatted with `Intl.DateTimeFormat('en-CA', { day: 'numeric', month: 'long', year: 'numeric' })` → `April 28, 2026`.

Locale must be `fr-CA` and `en-CA`. Not `fr-FR`, not `en-US`. Quebec conventions matter.

### 5.7 Position-only and pitcher-only players

- If every value in `batting` is `null` → still render the batting grid with all `—`. Do not omit the grid.
- If every value in `pitching` is `null` → still render the pitching grid with all `—`. Do not omit the grid.

This keeps the page structure consistent. Players with no data in a category just show dashes.

### 5.8 Returning players with 2025 historical blocks

A small number of players (currently Aïzak Biasone `drawer-biasone` and Thomas Faucher `drawer-faucher` on the 15U team) have a `<div class="historical-block">…</div>` block already inside their stat panels, containing 2025 historical data. **Preserve these historical blocks.**

When injecting 2026 stats into a panel that contains a `historical-block`:

1. Replace only the content **above** the `<div class="historical-block">` element (i.e., the placeholder paragraph and language label).
2. Leave the `<div class="historical-block">…</div>` and everything inside it unchanged.
3. The new 2026 stat-grid sits above the historical block; the historical block stays below it.

The injection script must detect the presence of `<div class="historical-block">` inside a panel and splice around it, not over it. If you replace the entire panel content for these players, you destroy 2025 history. The structural validation in Section 7 verifies historical blocks survive.

### 5.9 No CSS changes

`.stat-grid`, `.stat-cell`, `.stat-val`, `.stat-key`, `.stat-val.highlight`, `.stat-label`, `.historical-block`, `.historical-label`, and `.stats-pending` all already exist in `alignement.html`. The `.stat-updated` class is the only new selector you'll introduce. **Do not add a `<style>` block for it.** Add this single rule once, the first time you run injection, by inserting it into the existing `<style>` block immediately after the `.stats-pending` rule:

```css
    .stat-updated { font-family: 'Barlow Condensed', sans-serif; font-size: 10px; font-style: italic; color: rgba(255,255,255,0.35); letter-spacing: 0.04em; margin-top: 10px; }
```

Indentation: 4 spaces, matching surrounding rules. On every subsequent run, check whether `.stat-updated` already exists in the file. If yes, skip the addition.

This CSS addition gets its own commit, separate from the first stats injection. See Section 9.1.

---

## 6. Staging copy

Never modify the live `alignement.html` directly during the build. Work order:

1. Copy `alignement.html` → `preview/alignement.html`.
2. Apply all stats injections to the staging copy.
3. All validation in Section 7 runs against the staging copy.
4. Only after Jay approves does the staging copy replace the live file (Section 9).

The `preview/` folder is gitignored.

---

## 7. Structural validation

Run these checks against `preview/alignement.html` after injection. ALL must pass before showing Jay the preview.

| # | Check | Method |
|---|---|---|
| 1 | File parses as HTML | Use `node-html-parser` or similar. Catch any parse errors. |
| 2 | All three team panels present | Confirm `id="panel-u15"`, `id="panel-u17d1"`, `id="panel-u17d2"` all present. |
| 3 | All original `drawer-<id>` rows still exist | Compare list of drawer IDs in pre-edit file vs post-edit file. Counts and IDs must match exactly. |
| 4 | Every injected drawer has both `<id>-bat` and `<id>-pit` panels | Search for both. |
| 5 | Language toggle classes intact | Every injected `.stat-label` and `.stat-updated` has both `fr-text` and `en-text` versions. |
| 6 | No orphan placeholders | Grep for `{GP}`, `{AB}`, `{TB2}`, `{ERA}`, `<DATE_`, `<SEASON>`, `{` followed by uppercase letters — all must return zero matches. |
| 7 | Historical blocks survived | For every player who had a `<div class="historical-block">` in the pre-edit file, that block is still present in the post-edit file, byte-identical. Hash each historical block pre/post and compare. |
| 8 | File size sanity | Post-edit file is at least 90% of pre-edit size and at most 200%. (Catches accidental truncation or pathological duplication.) |
| 9 | Region containment | Every byte difference between pre-edit and post-edit lives inside a `<div class="stat-panel">…</div>` block, OR inside the `<style>` block on the one-time CSS addition commit. No drift outside those regions. |
| 10 | No raw HTML in injected values | Grep injected values for `<`, `>`, `&` characters that are not part of `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`. (Catches escaping failures.) |

If any check fails, **abort**. Report to Jay which check failed, what was found, and which player(s) it concerned. Do not proceed to preview prompt.

Implement these checks in `scripts/validate-injection.js`. The script exits non-zero on any failure. Document this script in `docs/build-notes.md`.

---

## 8. Preview prompt

When all validation passes, tell Jay:

> *"Stats injected into staging. Preview at: `preview/alignement.html`. Open it in your browser (right-click → Open With → Chrome) and verify:*
>
> *1. The team(s) you updated have stats showing in the player drawers.*
> *2. The language toggle (FR/EN buttons) still works.*
> *3. Every player you approved is showing data, with `—` only where the JSON had null.*
> *4. Returning players (Biasone, Faucher) still show their 2025 historical block below the 2026 stats.*
> *5. No players' drawers are broken or missing.*
> *6. CSS layout looks intact (grid alignment, sky-blue accents, navy backgrounds).*
>
> *Reply 'approved' to push live, 'reject' to abort and roll back, or describe specific issues to address. I will not modify the live file or commit until you reply."*

Wait for Jay's reply. Do not push, commit, or modify the live file based on assumed approval, urgency, or any in-conversation hint short of an explicit "approved."

---

## 9. Promote to live, commit, push

### 9.1 First-ever run only — CSS addition commit

If `.stat-updated` does not yet exist in the live `alignement.html`, the first run of this directive produces **two commits**:

1. **First commit — CSS only:**
   - Add the `.stat-updated` rule to the `<style>` block (Section 5.9).
   - Stage and commit:
     ```powershell
     git add alignement.html
     git commit -m "css: add .stat-updated rule for stats injection timestamps"
     git push origin main
     ```
2. **Second commit — stats injection:** proceed with Section 9.2.

This separation keeps the diff history clean and lets the structural validation's "region containment" check apply unambiguously to the stats commit.

On all subsequent runs, skip 9.1 and go straight to 9.2.

### 9.2 Stats injection commit

Only after Jay replies with `approved`:

1. Copy `preview/alignement.html` → `alignement.html` (overwrite).
2. Run `git diff --quiet alignement.html`. If it returns 0 (no changes), abort with: *"No-op injection: file unchanged from current HEAD. Nothing to commit."* Do not push an empty commit.
3. Otherwise, verify with `git diff alignement.html` that the diff is contained within `<div class="stat-panel">` blocks (matches Section 7 check #9). If any diff appears outside those regions, abort.
4. Stage and commit:
   ```powershell
   git add alignement.html
   git commit -m "stats: update <team-slugs> from <YYYY-MM-DD> extraction"
   ```
   Commit message format: list which team(s) were updated and the extraction date.
5. Push to main:
   ```powershell
   git push origin main
   ```
6. Confirm to Jay: *"Live. Commit `<short-sha>` pushed to main. Cloudflare Pages should auto-deploy within ~60 seconds. Verify at https://canonniersdequebec.ca/alignement.html (hard-refresh with Ctrl+Shift+R). Backup at `backups/alignement.html.bak-<timestamp>` if rollback is needed."*

### 9.3 .gitignore additions

On first run, ensure `.gitignore` contains:

```
backups/
preview/
stats-input/*.json
!stats-input/.gitkeep
node_modules/
*.log
```

Create `stats-input/.gitkeep` as an empty committed file so the folder exists in the repo. The actual JSON files are not committed because they live in the other project's audit trail.

---

## 10. Notes — keep current

This project follows the same notes pattern as `claude-android-control`. Maintain three files in `docs/`:

- `docs/build-notes.md` — system/script changes (e.g., adding the validation script, CSS additions to `alignement.html`)
- `docs/version-notes.md` — versions of any tooling (Node, git, any npm packages)
- `docs/project-notes.md` — running session log (date, what was updated, which teams, any issues)

Append to `docs/project-notes.md` after every successful stats push:

```
## YYYY-MM-DD — Stats update

- **Teams updated:** <list>
- **Players approved:** <count per team>
- **Players skipped:** <count per team>
- **Source extraction date:** <date>
- **Commit:** <short-sha>
- **Issues encountered:** <any>
```

---

## 11. Rollback procedure

If Jay says "roll back" or "revert" within the same session:

1. Identify the most recent backup in `backups/`.
2. Copy it back over `alignement.html`.
3. Show Jay the diff vs current HEAD.
4. If a bad commit was already pushed, additionally:
   ```powershell
   git revert HEAD --no-edit
   git push origin main
   ```
5. Update `docs/project-notes.md` with the rollback reason.

Always confirm before running `git revert`. Never use `--force` or `--force-with-lease` without explicit Jay approval and explicit reasoning.

---

## 12. When to stop and ask Jay

- The JSON file fails validation (Section 1) or schema mismatch with `STATS_SCHEMA.md`.
- A player's `html_id` doesn't match any drawer in the HTML.
- Structural validation fails (Section 7).
- The diff shows changes outside expected regions.
- Any git operation produces an unexpected error.
- Jay's intent is unclear ("update the stats" without specifying which team, when multiple files are in `stats-input/`).
- A second stats file in `stats-input/` is dated older than what's already injected (potential rollback request, or out-of-order update).
- A player has a `historical-block` and the splice logic in Section 5.8 cannot cleanly identify the boundary.

---

## 13. What this directive does NOT do

- Does not extract stats from any source (that's `claude-android-control`).
- Does not edit roster info (jersey, name, position, B/T, height, weight).
- Does not modify player rows or team tabs or staff tables.
- Does not handle other pages (`index.html`, `calendrier.html`, `diffusion.html`).
- Does not deploy beyond `git push` — Cloudflare Pages auto-deploy from `main` is downstream and outside this directive's scope.

If Jay asks for any of the above, treat it as a separate request, out of scope for this directive.

---

*End of stats update directive.*
