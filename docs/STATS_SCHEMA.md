# Stats JSON Schema — Canonniers Website

> **This file is the single source of truth for the JSON contract between `claude-android-control` (the scraper) and `canonniers-website` (the consumer).**
>
> If the scraper changes its output, this file changes first. If this file changes, the scraper updates next, then `website-stats-directive.md` updates. No other order is acceptable.

---

## 1. File location and naming

Stats files live at:

```
canonniers-website/stats-input/<team-slug>-stats-<YYYY-MM-DD>.json
```

Where:
- `<team-slug>` ∈ `{ "u15", "u17d1", "u17d2" }`
- `<YYYY-MM-DD>` is the UTC calendar date of extraction

Examples:
- `u15-stats-2026-04-28.json`
- `u17d1-stats-2026-04-28.json`
- `u17d2-stats-2026-04-28.json`

One file per team per extraction. Multiple teams → multiple files.

---

## 2. Top-level structure

```json
{
  "team_name":    "string (display name from GameChanger)",
  "team_slug":    "u15 | u17d1 | u17d2",
  "season":       "string (e.g., \"2026\")",
  "source":       "GameChanger mobile app",
  "extracted_at": "ISO 8601 UTC datetime (e.g., \"2026-04-28T14:30:00Z\")",
  "players":      [ <PlayerRecord>, ... ]
}
```

### Required keys (top level)

| Key | Type | Required | Notes |
|---|---|---|---|
| `team_name` | string | yes | Display only; not used for matching. |
| `team_slug` | string | yes | Must match the filename slug. Validation: re-derive from filename and compare. |
| `season` | string | yes | Rendered into `<SEASON>` in the HTML templates. |
| `source` | string | yes | Currently always `"GameChanger mobile app"`. |
| `extracted_at` | string | yes | ISO 8601 UTC. Used for `<DATE_FR>` / `<DATE_EN>`. |
| `players` | array | yes | May be empty (validates as zero-player update; nothing happens). |

Any unrecognized top-level key → log a warning, do not abort, do not use.

---

## 3. PlayerRecord

```json
{
  "gc_name":      "string (GameChanger display name — used for human review only)",
  "jersey":       "string (e.g., \"57\") — used for human review only, NOT for matching",
  "html_id":      "string (must equal an existing drawer-<id> in alignement.html, sans the 'drawer-' prefix)",
  "status":       "approved | rejected | pending",
  "extracted_at": "ISO 8601 UTC datetime",
  "notes":        "string (may be empty)",
  "batting":      <BattingStats>,
  "pitching":     <PitchingStats>
}
```

### Required keys (PlayerRecord)

| Key | Type | Required | Notes |
|---|---|---|---|
| `gc_name` | string | yes | Not used for matching; logged for human review and audit. |
| `jersey` | string | yes | Not used for matching; logged. String, not int (preserves leading zeros). |
| `html_id` | string | yes | **The matching key.** Must be a non-empty string. Must correspond to an existing `drawer-<html_id>` in `alignement.html`. If no match, abort entire run. |
| `status` | string | yes | Must be one of `"approved"`, `"rejected"`, `"pending"`. Only `"approved"` records are injected; others are skipped silently with a count reported to Jay. |
| `extracted_at` | string | yes | Per-player timestamp (may differ from top-level if extraction was incremental). The injection uses the **top-level** `extracted_at` for the rendered date, not this one. This field is for audit only. |
| `notes` | string | yes | May be empty (`""`). Stored in audit log; not rendered in HTML. |
| `batting` | object | yes | See Section 4. |
| `pitching` | object | yes | See Section 5. |

`html_id` is the ONLY field used to match a JSON record to an HTML drawer. Names and jerseys are for human review.

---

## 4. BattingStats

All 15 keys are required. Every value is either an integer, a decimal number, or `null`.

```json
{
  "GP":  <int | null>,
  "PA":  <int | null>,
  "AB":  <int | null>,
  "H":   <int | null>,
  "2B":  <int | null>,
  "3B":  <int | null>,
  "HR":  <int | null>,
  "RBI": <int | null>,
  "R":   <int | null>,
  "BB":  <int | null>,
  "SO":  <int | null>,
  "AVG": <decimal | null>,
  "OBP": <decimal | null>,
  "SLG": <decimal | null>,
  "OPS": <decimal | null>
}
```

### Field reference

| Key | Stat | Type | Range / format |
|---|---|---|---|
| `GP` | Games Played | integer | ≥ 0 |
| `PA` | Plate Appearances | integer | ≥ 0 |
| `AB` | At Bats | integer | ≥ 0 |
| `H` | Hits | integer | ≥ 0 |
| `2B` | Doubles | integer | ≥ 0 |
| `3B` | Triples | integer | ≥ 0 |
| `HR` | Home Runs | integer | ≥ 0 |
| `RBI` | Runs Batted In | integer | ≥ 0 |
| `R` | Runs Scored | integer | ≥ 0 |
| `BB` | Walks | integer | ≥ 0 |
| `SO` | Strikeouts (batter) | integer | ≥ 0 |
| `AVG` | Batting Average | decimal | typical 0.000–1.000; rendered as `.NNN` |
| `OBP` | On-Base Percentage | decimal | typical 0.000–1.000; rendered as `.NNN` |
| `SLG` | Slugging Percentage | decimal | typical 0.000–4.000; values ≥ 1.000 keep leading digit |
| `OPS` | On-Base Plus Slugging | decimal | OBP + SLG; values ≥ 1.000 keep leading digit |

### Null semantics

- `null` means "no data available" and renders as `—`.
- `0` means "stat is zero" (e.g., player has 5 PA and 0 hits) and renders as `0`.
- `null` and `0` are not interchangeable. Scraper must distinguish.
- An entirely-null `batting` object (all 15 keys `null`) is valid — typical for a pure pitcher. The grid still renders, with all `—`.

### Decimal precision

- Send 3 decimal places where possible (`0.333`, not `0.33`).
- Renderer drops the leading zero for values < 1 (per baseball convention).
- IP is in the pitching object, not here.

---

## 5. PitchingStats

All 14 keys are required. Every value is either an integer, a decimal number, or `null`.

```json
{
  "GP":   <int | null>,
  "GS":   <int | null>,
  "IP":   <decimal | null>,
  "BF":   <int | null>,
  "W":    <int | null>,
  "L":    <int | null>,
  "SV":   <int | null>,
  "ERA":  <decimal | null>,
  "SO":   <int | null>,
  "BB":   <int | null>,
  "WHIP": <decimal | null>,
  "H":    <int | null>,
  "R":    <int | null>,
  "ER":   <int | null>
}
```

### Field reference

| Key | Stat | Type | Range / format |
|---|---|---|---|
| `GP` | Games Pitched | integer | ≥ 0 |
| `GS` | Games Started | integer | ≥ 0 |
| `IP` | Innings Pitched | decimal | thirds: `.0`, `.1` (one out), `.2` (two outs). **Never reformat.** `12.2` stays `12.2`, NOT `12.67`. |
| `BF` | Batters Faced | integer | ≥ 0 |
| `W` | Wins | integer | ≥ 0 |
| `L` | Losses | integer | ≥ 0 |
| `SV` | Saves | integer | ≥ 0 |
| `ERA` | Earned Run Average | decimal | typical 0.00–99.99; 2 decimals |
| `SO` | Strikeouts (pitcher) | integer | ≥ 0 |
| `BB` | Walks Allowed | integer | ≥ 0 |
| `WHIP` | Walks + Hits per IP | decimal | typical 0.00–10.00; 2 decimals |
| `H` | Hits Allowed | integer | ≥ 0 |
| `R` | Runs Allowed | integer | ≥ 0 |
| `ER` | Earned Runs | integer | ≥ 0 |

### Null semantics

Same as batting: `null` = no data, renders as `—`. `0` = zero, renders as `0`. Distinct.

An entirely-null `pitching` object (all 14 keys `null`) is valid — typical for a position player. The grid still renders, with all `—`.

### Strikeouts naming

The pitching stat is `SO`, not `K`. Both are common in baseball; we standardize on `SO` to match the batting stat for consistency. Scraper must emit `SO`. If `K` appears, abort.

---

## 6. Stat keys NOT in the schema

The scraper may surface other GameChanger stats (e.g., `SB`, `CS`, `HBP`, `SF`, `K/9`, `BB/9`). These are not currently rendered.

- The consumer ignores any stat key not listed in Sections 4 and 5.
- The scraper is free to include extras in the JSON; they will not break injection.
- If a future stat is added to the rendered grid, this schema gets updated first, then `website-stats-directive.md`, then the scraper.

---

## 7. Validation summary

The consumer's `scripts/validate-injection.js` (per directive Section 7) runs the following schema checks at minimum:

1. JSON parses.
2. Top-level required keys all present, types correct.
3. `team_slug` matches filename.
4. `players` is an array.
5. Every player has all required keys at the player level.
6. Every player has a non-null, non-empty `html_id`.
7. Every player's `status` is one of the three allowed values.
8. Every player's `batting` has all 15 keys; every value is `null`, integer, or finite number.
9. Every player's `pitching` has all 14 keys; every value is `null`, integer, or finite number.
10. No unexpected stat keys (warn, don't fail).
11. Every `html_id` resolves to a `drawer-<id>` in the live `alignement.html`.

Any failure → abort entire run. Report which check failed and on which player.

---

## 8. Schema version

```
schema_version: 1
last_updated:   2026-04-28
maintained_by:  Jay (Zeddidiah2000)
```

When the schema changes, increment `schema_version` and update `last_updated`. Both the scraper and consumer should read this header at the start of every run and abort if the schemas they expect don't match.

A future iteration may make this a JSON Schema (`schema.json`) for machine validation. For now, this Markdown file is canonical.

---

*End of stats schema.*
