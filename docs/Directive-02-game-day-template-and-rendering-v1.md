# Directive 02 v1: Game-Day Template + Browser Rendering Integration

**Phase:** 2 of 5 (Card Generator Overhaul)
**Depends on:** Directive 01 v2 deployed and verified (cards-worker, D1 table, R2 bucket all live)
**Estimated work:** ~4-6 hours for Claude Code
**Risk level:** Medium — first integration with Browser Rendering binding; introduces external rendering dependency. Independently rollbackable.

---

## Goal

Make the cards-worker actually render cards. Specifically:

1. Implement the `game-day` template in both variants (`with-cutout` and `graphic-only`) at 1080×1080
2. Integrate Cloudflare Browser Rendering via the Workers Binding pattern (`@cloudflare/puppeteer`)
3. Implement the `POST /render` endpoint with mandatory D1 content-hash caching
4. Self-host `Barlow Condensed` WOFF2 in R2 for deterministic font rendering
5. Commit a hardcoded test cutout PNG so the `with-cutout` variant can be exercised end-to-end with hardcoded test payloads

**Explicitly NOT in this directive:**
- Compose stage UI (Directive 03)
- Real cutout sourcing pipeline / remove.bg integration (Directive 03 or later)
- Score-result and schedule templates (Directive 04)
- Any UI changes in `admin-social.html` or `galerie.html` (Directive 03 / 05)
- Story format 1080×1920 (deferred indefinitely)
- Tournament/playoff badges, doubleheader handling, game numbers (deferred)

After this directive: a developer can `curl POST /render` with a JSON payload and receive back an R2 URL pointing to a valid 1080×1080 PNG. No human-facing UI exists yet.

---

## Pre-Flight Verification

Halt and report on any failure. Do not proceed past a failed check.

### 1. Confirm Directive 01 baseline

Fetch raw GitHub URLs to confirm the cards-worker exists in repo:

```bash
curl -sI https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/workers/canonniers-cards-worker/wrangler.toml
curl -sI https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/workers/canonniers-cards-worker/src/index.ts
```

Both must return `200 OK`. If either 404s, halt — Directive 01 wasn't merged or files are elsewhere.

### 2. Confirm Worker is currently healthy

```bash
curl -s https://canonniers-cards-worker.chisholm2000.workers.dev/health
# Expected: {"status":"ok"}
```

If this fails, fix the existing deployment before adding new functionality.

### 3. Confirm D1 cache table is empty

```bash
wrangler d1 execute canonniers-db --remote --command "SELECT COUNT(*) FROM generated_cards;"
```

Expected: `0`. If non-zero, that's anomalous — Directive 01 only created the table; nothing should have written to it. Halt and investigate.

### 4. Confirm Workers Paid plan is still active

```bash
wrangler whoami
```

Browser Rendering binding requires Workers Paid (the user upgraded specifically for this directive). If Paid plan is inactive, halt — billing issue must be resolved first.

### 5. Confirm R2 bucket is reachable and writable

```bash
# Reachable
curl -sI https://cards.canonniersdequebec.ca/anything
# Expected: 404 (empty bucket, no listing) — confirms domain routes to bucket

# Writable from wrangler
echo "preflight" | wrangler r2 object put canonniers-cards/_preflight.txt --pipe
wrangler r2 object delete canonniers-cards/_preflight.txt
```

Both write and delete must succeed.

### 6. Confirm Browser Rendering is available on this account

```bash
# This will fail with 404 if Browser Rendering hasn't been provisioned on the account.
# Workers Paid auto-includes it, but the account may need a one-time enable click.
wrangler browser list
```

If this errors with "Browser Rendering not enabled" or similar, halt — Jay must enable it via the Cloudflare dashboard (Compute → Browser Rendering → Get Started). This is a one-click action. Do not attempt to bypass.

### 7. Take a fresh D1 backup

```bash
mkdir -p ../canonniers-backups
wrangler d1 export canonniers-db --remote \
  --output ../canonniers-backups/canonniers-db-pre-d02-$(date +%Y%m%d-%H%M%S).sql
```

Backup is outside the repo per project convention.

### 8. Verify Barlow Condensed WOFF2 is obtainable

We need a self-hostable WOFF2 of Barlow Condensed. Options:

- **Preferred:** Download from Google Fonts via `google-webfonts-helper` (https://gwfh.mranftl.com/fonts/barlow-condensed) — gives a self-hostable WOFF2 with the correct subset.
- **Fallback:** Download from the official Barlow GitHub repo (https://github.com/jpt/barlow), which ships TTF; convert to WOFF2 with `woff2_compress` (Ubuntu: `apt install woff2`).

Get **Regular (400)** and **Bold (700)** weights only. Latin subset is sufficient — French uses Latin. Do not bundle weights we don't use.

License: Barlow is OFL 1.1 (free for self-hosting and embedding). No license action needed beyond noting the source in a sibling `LICENSE.txt`.

---

## Open Questions for Claude Code

Resolve these before applying. Halt and report; don't guess.

1. **Did Directive 01 ship `/render` as a `501 Not Implemented` stub or as `404`?** This directive replaces that handler. If it's `404`, we're adding a new route; if it's `501`, we're swapping the implementation. Either is fine but the diff differs.

2. **Existing rate-limit rule for `/render`:** Directive 01 mentions a pre-configured rate limit rule for `/render`. Confirm it's still in place and what its threshold is. The synchronous render endpoint will take 2-5 seconds; if the rate limit is too tight (e.g., 1 req/min) it will block legitimate retry behavior during dev. If unsure of value, dump the rule via API and report.

3. **CF Access scope on `/render`:** Directive 01's worker enforces CF Access JWT on all non-health endpoints. Confirm `/render` is in the protected set. If it's currently exempt for any reason, halt — it must be authenticated.

4. **Puppeteer package version:** Use `@cloudflare/puppeteer` (NOT `puppeteer` or `puppeteer-core`). Pin to the latest stable version at time of implementation. If the package's API has shifted from the patterns documented below, follow the package's current docs and report any deviations.

5. **R2 path for fonts and test assets:** This directive proposes `templates/cards/_shared/fonts/` and `templates/cards/game-day/test-assets/` as paths inside the R2 bucket `canonniers-cards`. If a different convention emerged during Directive 01 (e.g., a separate R2 bucket for static assets), match that. Otherwise use the proposed paths.

---

## Part A — Repo Structure

Create the template directory structure in the repo. **Templates live in the repo for version control; their compiled HTML is fetched at render time from R2 (uploaded as part of this directive).** This separation lets us redeploy templates without redeploying the Worker.

```
workers/canonniers-cards-worker/
  templates/
    cards/
      _shared/
        fonts/
          barlow-condensed-400.woff2          # downloaded in pre-flight #8
          barlow-condensed-700.woff2
          LICENSE.txt                          # OFL 1.1 text + source attribution
        css/
          base.css                             # @font-face declarations + CSS variables
      game-day/
        with-cutout.html                       # Mustache-style template
        graphic-only.html
        test-assets/
          test-cutout.png                      # transparent-bg test player image
          test-opponent-logo.png               # transparent-bg test opponent shield
        layout.json                            # safe zones, info panel box, cutout presets
```

`layout.json` is consumed by Directive 03's compose UI to know where elements snap. Define it now so we don't refactor later.

### `templates/cards/game-day/layout.json`

```json
{
  "version": 1,
  "canvas": { "width": 1080, "height": 1080 },
  "safe_zones": {
    "outer": { "top": 60, "right": 60, "bottom": 60, "left": 60 },
    "inner": { "top": 120, "right": 120, "bottom": 120, "left": 120 }
  },
  "fixed_elements": {
    "info_panel": { "x": 60, "y": 280, "w": 380, "h": 520 },
    "hero_text":  { "x": 60, "y": 380, "w": 960, "h": 320 },
    "logo":       { "x": 920, "y": 60,  "w": 100, "h": 100 }
  },
  "cutout_presets": {
    "bottom-right":  { "x": 540, "y": 540, "scale": 1.00, "rotation": 0,  "anchor": "bottom-left" },
    "bottom-center": { "x": 340, "y": 540, "scale": 1.00, "rotation": 0,  "anchor": "bottom-left" },
    "right-tall":    { "x": 600, "y": 200, "scale": 1.10, "rotation": 0,  "anchor": "top-left"    },
    "right-action":  { "x": 480, "y": 280, "scale": 1.05, "rotation": -3, "anchor": "top-left"    }
  },
  "constraints": {
    "cutout_max_count": 2,
    "cutout_bounding_x_min_pct": 0.50,
    "opponent_name_tier_breakpoints": [18, 32]
  }
}
```

The `cutout_bounding_x_min_pct: 0.50` constraint encodes "cutouts must stay in the right half of the canvas to avoid overlapping the info panel." Directive 03's compose UI will enforce this.

---

## Part B — Template HTML

Two HTML files under `templates/cards/game-day/`. Both are self-contained (CSS in `<style>`), reference fonts via `@font-face` from R2, and use a deterministic Mustache-style placeholder syntax: `{{key}}` for substitution, `{{#if key}}...{{/if}}` for conditional blocks.

**Why Mustache-style not real Mustache:** real Mustache adds a runtime dependency. We need only literal substitution and one conditional pattern. A 30-line custom renderer in the Worker handles both. Do not pull in Handlebars/Mustache npm packages.

### Template variable contract

The Worker passes these variables to the template renderer. Every variable below MUST be present (use empty string or `false` for unset values; never `undefined`):

| Variable | Type | Description |
|---|---|---|
| `lang` | `"fr"` \| `"en"` | Language for labels |
| `label_game_day` | string | Pre-translated: "JOUR DE MATCH" or "GAME DAY" |
| `label_vs` | string | "VS." or "@" depending on `is_home` |
| `label_tbd` | string | "À DÉTERMINER" or "TBD" |
| `opponent_name` | string | Verbatim from payload, HTML-escaped |
| `opponent_name_class` | string | `tier1`, `tier2`, or `tier3` (computed from char count) |
| `opponent_logo_url` | string | Full R2 URL or empty string (template uses fallback shield SVG inline) |
| `has_opponent_logo` | bool | For `{{#if}}` block |
| `date_formatted` | string | Pre-formatted: "SAMEDI 15 MAI" / "SATURDAY MAY 15" |
| `time_formatted` | string | Pre-formatted: "19:00" or label_tbd |
| `venue_name` | string | Verbatim, HTML-escaped, or empty |
| `has_venue` | bool | For `{{#if}}` block |
| `cutouts_html` | string | Pre-rendered HTML for cutouts (computed by Worker, see Part D) |

**Why pre-format strings in the Worker, not in the template:** keeps locale logic in one place (testable JavaScript), keeps template a dumb renderer. No Date manipulation in HTML.

### `templates/cards/_shared/css/base.css`

```css
@font-face {
  font-family: 'Barlow Condensed';
  font-weight: 400;
  font-style: normal;
  font-display: block;
  src: url('https://cards.canonniersdequebec.ca/templates/cards/_shared/fonts/barlow-condensed-400.woff2') format('woff2');
}

@font-face {
  font-family: 'Barlow Condensed';
  font-weight: 700;
  font-style: normal;
  font-display: block;
  src: url('https://cards.canonniersdequebec.ca/templates/cards/_shared/fonts/barlow-condensed-700.woff2') format('woff2');
}

:root {
  --canvas-w: 1080px;
  --canvas-h: 1080px;
  --color-bg-deep: #0A1628;
  --color-bg-mid:  #122340;
  --color-cyan:    #38BDF8;
  --color-cyan-glow: rgba(56, 189, 248, 0.45);
  --color-text:    #FFFFFF;
  --color-text-mute: rgba(255, 255, 255, 0.70);
  --font-display:  'Barlow Condensed', sans-serif;
  --font-mono:     ui-monospace, 'SF Mono', Menlo, monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  width: var(--canvas-w);
  height: var(--canvas-h);
  overflow: hidden;
  font-family: var(--font-display);
  color: var(--color-text);
  background: radial-gradient(ellipse at center top, var(--color-bg-mid) 0%, var(--color-bg-deep) 70%);
}
```

### `templates/cards/game-day/with-cutout.html`

This template is intentionally verbose. Inline everything so a single GET retrieves the full document.

```html
<!doctype html>
<html lang="{{lang}}">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://cards.canonniersdequebec.ca/templates/cards/_shared/css/base.css">
  <style>
    /* Blueprint geometric layer */
    .blueprint {
      position: absolute; inset: 0;
      pointer-events: none;
      z-index: 1;
    }
    .blueprint svg {
      width: 100%; height: 100%;
      filter: drop-shadow(0 0 6px var(--color-cyan-glow));
    }

    /* Hero CANONNIERS text — outline-only */
    .hero {
      position: absolute;
      left: 60px; top: 380px;
      width: 960px; height: 320px;
      display: flex; align-items: center; justify-content: center;
      z-index: 2;
    }
    .hero-text {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 280px;
      letter-spacing: -8px;
      line-height: 1;
      color: transparent;
      -webkit-text-stroke: 4px var(--color-text);
      text-stroke: 4px var(--color-text);
      white-space: nowrap;
    }

    /* Info panel */
    .info-panel {
      position: absolute;
      left: 60px; top: 280px;
      width: 380px; height: 520px;
      background: rgba(56, 189, 248, 0.08);
      z-index: 3;
      padding: 32px 24px;
      display: flex; flex-direction: column; gap: 16px;
    }
    /* Corner brackets — drawn with pseudo-elements to avoid full border */
    .info-panel::before, .info-panel::after {
      content: ''; position: absolute;
      width: 24px; height: 24px;
      border: 1.5px solid var(--color-cyan);
    }
    .info-panel::before {
      top: 0; left: 0;
      border-right: none; border-bottom: none;
    }
    .info-panel::after {
      bottom: 0; right: 0;
      border-left: none; border-top: none;
    }
    .info-panel .corner-tr, .info-panel .corner-bl {
      position: absolute; width: 24px; height: 24px;
      border: 1.5px solid var(--color-cyan);
    }
    .info-panel .corner-tr {
      top: 0; right: 0;
      border-left: none; border-bottom: none;
    }
    .info-panel .corner-bl {
      bottom: 0; left: 0;
      border-right: none; border-top: none;
    }

    .panel-header {
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 400;
      color: var(--color-cyan);
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    .opponent-block { display: flex; gap: 12px; align-items: flex-start; }
    .opponent-logo  { width: 60px; height: 60px; flex-shrink: 0; object-fit: contain; }
    .opponent-meta  { flex: 1; min-width: 0; }
    .vs-label       {
      font-family: var(--font-mono);
      font-size: 14px; color: var(--color-cyan);
      letter-spacing: 1px; margin-bottom: 4px;
    }
    .opponent-name {
      font-family: var(--font-display);
      font-weight: 700;
      color: var(--color-text);
      line-height: 1.05;
      word-wrap: break-word;
    }
    .opponent-name.tier1 { font-size: 36px; }
    .opponent-name.tier2 { font-size: 28px; }
    .opponent-name.tier3 {
      font-size: 24px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .divider { height: 1px; background: var(--color-cyan); opacity: 0.12; width: 80%; }

    .date-text {
      font-family: var(--font-display);
      font-weight: 400;
      font-size: 22px;
      letter-spacing: 1px;
      text-transform: uppercase;
    }
    .time-text {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 28px;
    }
    .venue-text {
      font-family: var(--font-display);
      font-weight: 400;
      font-size: 16px;
      color: var(--color-text-mute);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* Cutout layer — always above hero text per Directive 02 spec */
    .cutout-layer {
      position: absolute; inset: 0;
      pointer-events: none;
      z-index: 4;
    }
    .cutout {
      position: absolute;
      filter: drop-shadow(0 0 12px var(--color-cyan-glow));
    }

    /* Logo — top right */
    .brand-logo {
      position: absolute;
      top: 60px; right: 60px;
      width: 100px; height: 100px;
      z-index: 5;
    }
  </style>
</head>
<body>
  <div class="blueprint">
    <svg viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#38BDF8" stroke-width="1.5">
      <!-- Architectural blueprint frame -->
      <rect x="200" y="200" width="680" height="680" stroke-opacity="0.30"/>
      <rect x="280" y="280" width="520" height="520" stroke-opacity="0.20"/>
      <!-- Dimension lines -->
      <line x1="200" y1="180" x2="880" y2="180" stroke-opacity="0.40"/>
      <line x1="200" y1="170" x2="200" y2="190" stroke-opacity="0.40"/>
      <line x1="880" y1="170" x2="880" y2="190" stroke-opacity="0.40"/>
      <!-- Arc accent -->
      <path d="M 540 540 m -200 0 a 200 200 0 0 1 400 0" stroke-opacity="0.35"/>
      <!-- Small tick marks -->
      <line x1="540" y1="200" x2="540" y2="240" stroke-opacity="0.25"/>
      <line x1="540" y1="840" x2="540" y2="880" stroke-opacity="0.25"/>
    </svg>
  </div>

  <div class="hero">
    <div class="hero-text">CANONNIERS</div>
  </div>

  <div class="info-panel">
    <span class="corner-tr"></span>
    <span class="corner-bl"></span>
    <div class="panel-header">{{label_game_day}}</div>

    <div class="opponent-block">
      {{#if has_opponent_logo}}
        <img class="opponent-logo" src="{{opponent_logo_url}}" alt="">
      {{/if}}
      {{#if not_has_opponent_logo}}
        <svg class="opponent-logo" viewBox="0 0 60 60" fill="none" stroke="#38BDF8" stroke-width="1.5">
          <path d="M30 6 L52 16 L52 36 C52 46 42 54 30 56 C18 54 8 46 8 36 L8 16 Z"/>
        </svg>
      {{/if}}
      <div class="opponent-meta">
        <div class="vs-label">{{label_vs}}</div>
        <div class="opponent-name {{opponent_name_class}}">{{opponent_name}}</div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="date-text">{{date_formatted}}</div>
    <div class="time-text">{{time_formatted}}</div>

    {{#if has_venue}}
      <div class="venue-text">{{venue_name}}</div>
    {{/if}}
  </div>

  <div class="cutout-layer">{{{cutouts_html}}}</div>

  <!-- Brand logo: inline SVG of Canonniers cannon, white version. Replace with actual SVG path data. -->
  <svg class="brand-logo" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <!-- TODO: paste actual Canonniers cannon SVG path data here. Placeholder circle for now. -->
    <circle cx="50" cy="50" r="45" fill="none" stroke="#FFFFFF" stroke-width="3"/>
    <text x="50" y="58" text-anchor="middle" font-family="serif" font-size="32" font-weight="700" fill="#FFFFFF">C</text>
  </svg>
</body>
</html>
```

**Note on `{{{triple-brace}}}`:** Mustache convention for "raw HTML, do not escape." `cutouts_html` is generated by the Worker (which controls escaping internally), so triple-brace is correct. All other `{{...}}` substitutions MUST be HTML-escaped.

**Note on `{{#if not_has_opponent_logo}}`:** the simple template engine doesn't support `{{else}}`. Use a paired negated boolean. The Worker computes both `has_opponent_logo` and `not_has_opponent_logo` and includes both in the variable bag.

### `templates/cards/game-day/graphic-only.html`

Identical to `with-cutout.html` except:
- Remove the entire `<div class="cutout-layer">...</div>` block
- The `cutouts_html` template variable is unused (still passed; template ignores it)

The Worker selects the template file by variant; both share 95% of code. Resist the urge to refactor into a shared partial in v1 — once we have 3+ templates, extract a partials system.

---

## Part C — Worker Code Changes

Working directory: `workers/canonniers-cards-worker/`.

### C.1 — `package.json`

Add dependencies. Pin versions; do not use `^` ranges.

```json
{
  "dependencies": {
    "@cloudflare/puppeteer": "0.0.14"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "4.20260101.0",
    "wrangler": "3.99.0",
    "typescript": "5.6.3"
  }
}
```

Run `npm install` and commit `package-lock.json`.

If `@cloudflare/puppeteer` has shipped a newer version at time of implementation, use that and report. The API has been stable since 0.0.10.

### C.2 — `wrangler.toml`

Add the Browser Rendering binding. Keep all existing bindings (D1, R2, AUTH_WORKER service binding, secrets) untouched.

```toml
# Existing config above this line — DO NOT modify

[browser]
binding = "BROWSER"
```

The binding does not require a service name or version — Browser Rendering is a Cloudflare-managed singleton.

### C.3 — `src/render.ts` (NEW)

The main render handler. Pull this out of `src/index.ts` to keep the entry-point file readable.

```typescript
import puppeteer from '@cloudflare/puppeteer';
import { Env } from './types';
import { Buffer } from 'node:buffer';

// ---------- Types ----------

interface RenderRequest {
  template: 'game-day';
  variant: 'with-cutout' | 'graphic-only';
  team_id: 'u15' | 'u17d1' | 'u17d2';
  game_id?: number | null;
  content: {
    opponent_name: string;
    opponent_logo_url?: string | null;
    game_date: string;       // ISO date "2026-05-15"
    game_time?: string | null; // "HH:MM" 24h
    venue_name?: string | null;
    is_home?: boolean;
    language: 'fr' | 'en';
    cutouts?: Array<{
      image_url: string;
      preset: 'bottom-right' | 'bottom-center' | 'right-tall' | 'right-action';
      x_offset?: number;       // pixels, applied after preset
      y_offset?: number;
      scale_override?: number; // multiplied with preset scale
    }>;
  };
}

// ---------- Validation ----------

function validateRenderRequest(body: any): { ok: true; data: RenderRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object' };

  if (body.template !== 'game-day') return { ok: false, error: 'Unsupported template' };
  if (!['with-cutout', 'graphic-only'].includes(body.variant)) return { ok: false, error: 'Invalid variant' };
  if (!['u15', 'u17d1', 'u17d2'].includes(body.team_id)) return { ok: false, error: 'Invalid team_id' };

  const c = body.content;
  if (!c || typeof c !== 'object') return { ok: false, error: 'content required' };
  if (typeof c.opponent_name !== 'string' || !c.opponent_name.trim()) {
    return { ok: false, error: 'opponent_name required' };
  }
  if (c.opponent_name.length > 80) return { ok: false, error: 'opponent_name too long (max 80)' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.game_date)) return { ok: false, error: 'game_date must be YYYY-MM-DD' };
  if (c.game_time != null && !/^\d{2}:\d{2}$/.test(c.game_time)) {
    return { ok: false, error: 'game_time must be HH:MM' };
  }
  if (!['fr', 'en'].includes(c.language)) return { ok: false, error: 'language must be fr or en' };

  if (c.cutouts) {
    if (!Array.isArray(c.cutouts)) return { ok: false, error: 'cutouts must be an array' };
    if (c.cutouts.length > 2) return { ok: false, error: 'cutouts max length is 2' };
    if (body.variant === 'graphic-only' && c.cutouts.length > 0) {
      return { ok: false, error: 'graphic-only variant cannot have cutouts' };
    }
    if (body.variant === 'with-cutout' && c.cutouts.length === 0) {
      return { ok: false, error: 'with-cutout variant requires at least one cutout' };
    }
    const validPresets = ['bottom-right', 'bottom-center', 'right-tall', 'right-action'];
    for (const co of c.cutouts) {
      if (typeof co.image_url !== 'string' || !co.image_url.startsWith('https://')) {
        return { ok: false, error: 'cutout image_url must be https URL' };
      }
      if (!validPresets.includes(co.preset)) return { ok: false, error: 'invalid cutout preset' };
    }
  }

  if (c.opponent_logo_url != null && typeof c.opponent_logo_url === 'string'
      && !c.opponent_logo_url.startsWith('https://')) {
    return { ok: false, error: 'opponent_logo_url must be https URL' };
  }

  return { ok: true, data: body as RenderRequest };
}

// ---------- Content hashing for cache key ----------

async function computeContentHash(req: RenderRequest): Promise<string> {
  // Canonical JSON: stable key order, no whitespace, no extraneous fields
  const canonical = canonicalize({
    template: req.template,
    variant: req.variant,
    team_id: req.team_id,
    content: {
      opponent_name: req.content.opponent_name.trim(),
      opponent_logo_url: req.content.opponent_logo_url || null,
      game_date: req.content.game_date,
      game_time: req.content.game_time || null,
      venue_name: req.content.venue_name || null,
      is_home: req.content.is_home !== false, // default true
      language: req.content.language,
      cutouts: (req.content.cutouts || []).map(c => ({
        image_url: c.image_url,
        preset: c.preset,
        x_offset: c.x_offset || 0,
        y_offset: c.y_offset || 0,
        scale_override: c.scale_override || 1
      }))
    }
  });
  const data = new TextEncoder().encode(canonical);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function canonicalize(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

// ---------- HTML escaping & template rendering ----------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTemplate(html: string, vars: Record<string, any>): string {
  // Handle {{#if key}}...{{/if}} blocks first
  html = html.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => {
    return vars[key] ? body : '';
  });
  // Handle {{{key}}} (raw, no escape)
  html = html.replace(/\{\{\{(\w+)\}\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
  // Handle {{key}} (escaped)
  html = html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : escapeHtml(String(v));
  });
  return html;
}

// ---------- Localization ----------

const DAYS_FR = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
const DAYS_EN = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS_FR = ['JANVIER','FÉVRIER','MARS','AVRIL','MAI','JUIN','JUILLET','AOÛT','SEPTEMBRE','OCTOBRE','NOVEMBRE','DÉCEMBRE'];
const MONTHS_EN = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];

function formatDate(isoDate: string, lang: 'fr' | 'en'): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  // Use UTC to avoid timezone drift; baseball dates aren't time-of-day sensitive at midnight
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayIdx = dt.getUTCDay();
  if (lang === 'fr') {
    return `${DAYS_FR[dayIdx]} ${d} ${MONTHS_FR[m - 1]}`;
  }
  return `${DAYS_EN[dayIdx]} ${MONTHS_EN[m - 1]} ${d}`;
}

const LABELS = {
  fr: { game_day: 'JOUR DE MATCH', vs_home: 'VS.', vs_away: '@', tbd: 'À DÉTERMINER' },
  en: { game_day: 'GAME DAY',     vs_home: 'VS.', vs_away: '@', tbd: 'TBD' }
};

// ---------- Opponent name tiering ----------

function opponentNameClass(name: string): string {
  const len = name.length;
  if (len <= 18) return 'tier1';
  if (len <= 32) return 'tier2';
  return 'tier3';
}

// ---------- Cutout HTML generation ----------

const CUTOUT_PRESETS: Record<string, { x: number; y: number; scale: number; rotation: number; anchor: string }> = {
  'bottom-right':  { x: 540, y: 540, scale: 1.00, rotation: 0,  anchor: 'bottom-left' },
  'bottom-center': { x: 340, y: 540, scale: 1.00, rotation: 0,  anchor: 'bottom-left' },
  'right-tall':    { x: 600, y: 200, scale: 1.10, rotation: 0,  anchor: 'top-left'    },
  'right-action':  { x: 480, y: 280, scale: 1.05, rotation: -3, anchor: 'top-left'    }
};

function renderCutoutsHtml(cutouts: NonNullable<RenderRequest['content']['cutouts']>): string {
  return cutouts.map(co => {
    const preset = CUTOUT_PRESETS[co.preset];
    const x = preset.x + (co.x_offset || 0);
    const y = preset.y + (co.y_offset || 0);
    const scale = preset.scale * (co.scale_override || 1);
    // Anchor translation: bottom-left = (0%, -100%), top-left = (0%, 0%)
    const translateY = preset.anchor.startsWith('bottom') ? '-100%' : '0';
    const transform = `translate(0, ${translateY}) scale(${scale}) rotate(${preset.rotation}deg)`;
    // Cutouts are constrained to right half via CSS max-width on container; add img with transform
    return `<img class="cutout" src="${escapeHtml(co.image_url)}"
      style="left: ${x}px; top: ${y}px; transform: ${transform}; transform-origin: top left; max-height: 800px;">`;
  }).join('\n');
}

// ---------- Build the full template variable bag ----------

async function buildTemplateVars(req: RenderRequest, env: Env): Promise<Record<string, any>> {
  const lang = req.content.language;
  const isHome = req.content.is_home !== false;
  const labels = LABELS[lang];
  const hasLogo = !!(req.content.opponent_logo_url && req.content.opponent_logo_url.trim());
  const hasVenue = !!(req.content.venue_name && req.content.venue_name.trim());
  const time = req.content.game_time || labels.tbd;

  return {
    lang,
    label_game_day: labels.game_day,
    label_vs: isHome ? labels.vs_home : labels.vs_away,
    label_tbd: labels.tbd,
    opponent_name: req.content.opponent_name.trim(),
    opponent_name_class: opponentNameClass(req.content.opponent_name.trim()),
    opponent_logo_url: req.content.opponent_logo_url || '',
    has_opponent_logo: hasLogo,
    not_has_opponent_logo: !hasLogo,
    date_formatted: formatDate(req.content.game_date, lang),
    time_formatted: time,
    venue_name: req.content.venue_name || '',
    has_venue: hasVenue,
    cutouts_html: req.variant === 'with-cutout' && req.content.cutouts
                  ? renderCutoutsHtml(req.content.cutouts)
                  : ''
  };
}

// ---------- Template fetching (from R2, cached at module level) ----------

const templateCache = new Map<string, { html: string; fetched_at: number }>();
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes; templates change rarely

async function fetchTemplate(env: Env, templateName: string, variant: string): Promise<string> {
  const key = `templates/cards/${templateName}/${variant}.html`;
  const cached = templateCache.get(key);
  if (cached && Date.now() - cached.fetched_at < TEMPLATE_CACHE_TTL_MS) {
    return cached.html;
  }
  const obj = await env.CARDS_BUCKET.get(key);
  if (!obj) throw new Error(`Template not found in R2: ${key}`);
  const html = await obj.text();
  templateCache.set(key, { html, fetched_at: Date.now() });
  return html;
}

// ---------- Main render handler ----------

export async function handleRender(request: Request, env: Env, callerEmail: string): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' });
  }

  const validation = validateRenderRequest(body);
  if (!validation.ok) {
    return jsonResponse(400, { error: validation.error });
  }
  const req = validation.data;

  // Cache lookup
  const contentHash = await computeContentHash(req);
  const cached = await env.DB.prepare(
    `SELECT id, r2_url FROM generated_cards WHERE content_hash = ? AND status = 'ready' LIMIT 1`
  ).bind(contentHash).first<{ id: number; r2_url: string }>();

  if (cached) {
    return jsonResponse(200, {
      url: cached.r2_url,
      cached: true,
      card_id: cached.id
    });
  }

  // Cache miss — render
  const startedAt = Date.now();
  let pngBuffer: ArrayBuffer;
  try {
    pngBuffer = await renderToPng(env, req);
  } catch (err) {
    console.error('Render failed', { contentHash, err: String(err) });
    return jsonResponse(500, { error: 'Render failed', detail: String(err) });
  }
  const renderMs = Date.now() - startedAt;

  // Upload to R2
  const filename = `${req.template}/${req.variant}/${contentHash.slice(0, 16)}.png`;
  await env.CARDS_BUCKET.put(`generated/${filename}`, pngBuffer, {
    httpMetadata: { contentType: 'image/png' }
  });
  const r2Url = `https://cards.canonniersdequebec.ca/generated/${filename}`;

  // Insert cache row
  const insertResult = await env.DB.prepare(
    `INSERT INTO generated_cards
      (content_hash, template, variant, team_id, game_id, r2_url, status, render_ms, payload_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, datetime('now'))`
  ).bind(
    contentHash,
    req.template,
    req.variant,
    req.team_id,
    req.game_id || null,
    r2Url,
    renderMs,
    JSON.stringify(req),
    callerEmail
  ).run();

  return jsonResponse(200, {
    url: r2Url,
    cached: false,
    card_id: insertResult.meta.last_row_id,
    render_ms: renderMs
  });
}

// ---------- Browser Rendering integration ----------

async function renderToPng(env: Env, req: RenderRequest): Promise<ArrayBuffer> {
  const templateHtml = await fetchTemplate(env, req.template, req.variant);
  const vars = await buildTemplateVars(req, env);
  const finalHtml = renderTemplate(templateHtml, vars);

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
    await page.setContent(finalHtml, { waitUntil: 'networkidle0', timeout: 15000 });
    // Extra wait to ensure web fonts have rendered (font-display: block should already block, but belt-and-suspenders)
    await page.evaluate(() => (document as any).fonts?.ready);
    const screenshot = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 1080, height: 1080 },
      omitBackground: false
    });
    return screenshot.buffer.slice(screenshot.byteOffset, screenshot.byteOffset + screenshot.byteLength) as ArrayBuffer;
  } finally {
    await browser.close();
  }
}

// ---------- Response helper ----------

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
```

### C.4 — `src/index.ts` modification

Wire the new render handler into the routing. Reuse the existing CF Access JWT verification pattern from Directive 01.

```typescript
// Existing imports + auth setup unchanged

import { handleRender } from './render';

// Inside the main fetch handler, after JWT verification + email extraction:
if (url.pathname === '/render' && request.method === 'POST') {
  return handleRender(request, env, callerEmail);
}
```

Do not duplicate the JWT verification code; the route resolution must happen *after* authentication, same as `/list` and `/delete`.

### C.5 — `src/types.ts` (extend)

Add the `BROWSER` binding type:

```typescript
import type { BrowserWorker } from '@cloudflare/puppeteer';

export interface Env {
  // ...existing bindings
  BROWSER: BrowserWorker;
}
```

---

## Part D — Asset Upload to R2

The Worker reads templates and fonts from R2 at runtime. Upload them.

### D.1 — Upload fonts

```bash
cd workers/canonniers-cards-worker

wrangler r2 object put canonniers-cards/templates/cards/_shared/fonts/barlow-condensed-400.woff2 \
  --file=./templates/cards/_shared/fonts/barlow-condensed-400.woff2 \
  --content-type=font/woff2

wrangler r2 object put canonniers-cards/templates/cards/_shared/fonts/barlow-condensed-700.woff2 \
  --file=./templates/cards/_shared/fonts/barlow-condensed-700.woff2 \
  --content-type=font/woff2

wrangler r2 object put canonniers-cards/templates/cards/_shared/fonts/LICENSE.txt \
  --file=./templates/cards/_shared/fonts/LICENSE.txt \
  --content-type=text/plain
```

### D.2 — Upload shared CSS

```bash
wrangler r2 object put canonniers-cards/templates/cards/_shared/css/base.css \
  --file=./templates/cards/_shared/css/base.css \
  --content-type=text/css
```

### D.3 — Upload templates

```bash
wrangler r2 object put canonniers-cards/templates/cards/game-day/with-cutout.html \
  --file=./templates/cards/game-day/with-cutout.html \
  --content-type=text/html

wrangler r2 object put canonniers-cards/templates/cards/game-day/graphic-only.html \
  --file=./templates/cards/game-day/graphic-only.html \
  --content-type=text/html

wrangler r2 object put canonniers-cards/templates/cards/game-day/layout.json \
  --file=./templates/cards/game-day/layout.json \
  --content-type=application/json
```

### D.4 — Upload test assets

For Directive 02 verification we need a real transparent-PNG cutout. Source options:
- Existing player photo from Cloudflare Images that's already cutout, exported as PNG
- A free placeholder (e.g., a generic baseball player silhouette) — only acceptable for development, must NOT be used in production cards

```bash
wrangler r2 object put canonniers-cards/templates/cards/game-day/test-assets/test-cutout.png \
  --file=./templates/cards/game-day/test-assets/test-cutout.png \
  --content-type=image/png

wrangler r2 object put canonniers-cards/templates/cards/game-day/test-assets/test-opponent-logo.png \
  --file=./templates/cards/game-day/test-assets/test-opponent-logo.png \
  --content-type=image/png
```

### D.5 — Verify CORS headers on font requests

The fonts will be loaded by Chromium *inside the Browser Rendering instance*. Since both the rendering page and the font are served from `cards.canonniersdequebec.ca`, this is same-origin and CORS doesn't apply. **However**, if `font-display: block` ever times out and falls back to system fonts, the rendered card will look wrong with no error. Verify directly:

```bash
curl -sI https://cards.canonniersdequebec.ca/templates/cards/_shared/fonts/barlow-condensed-400.woff2
```

Expected: `200 OK`, `content-type: font/woff2`, `access-control-allow-origin: *` or matching origin per Directive 01 CORS config.

---

## Part E — Deploy Worker

```bash
cd workers/canonniers-cards-worker
npm install
wrangler deploy
```

Confirm deploy summary lists the `[browser]` binding under "Bindings."

If deploy succeeds but the binding doesn't appear, the wrangler version may be too old — upgrade `wrangler` and redeploy.

---

## Post-Deploy Verification

Each step is independently confirmable. Halt at the first failure and rollback per the rollback plan.

### 1. Health check still works

```bash
curl -s https://canonniers-cards-worker.chisholm2000.workers.dev/health
# Expected: {"status":"ok"}
```

If this fails after deploy, the Worker is broken — rollback immediately.

### 2. Render endpoint requires auth

```bash
curl -s -X POST https://canonniers-cards-worker.chisholm2000.workers.dev/render \
  -H 'content-type: application/json' \
  -d '{}'
# Expected: 401 or 403 (CF Access challenge), NOT 200
```

If this returns 200 or 400 (validation error), CF Access enforcement is broken on `/render`. Halt — security issue.

### 3. Render endpoint with auth, minimal payload (graphic-only)

Get a `CF_Authorization` cookie value via browser session as in Directive 01 verification. Then:

```javascript
// Run in browser console at https://canonniersdequebec.ca/admin
const payload = {
  template: 'game-day',
  variant: 'graphic-only',
  team_id: 'u15',
  content: {
    opponent_name: 'Tyrans',
    game_date: '2026-05-15',
    game_time: '19:00',
    venue_name: 'Stade Canonniers',
    is_home: true,
    language: 'fr'
  }
};
const r = await fetch('https://canonniers-cards-worker.chisholm2000.workers.dev/render', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
});
console.log(r.status, await r.json());
```

Expected: `200`, JSON body with `{ url: "https://cards.canonniersdequebec.ca/generated/...", cached: false, card_id: <int>, render_ms: <number> }`.

Open the returned URL in a browser. Confirm:
- ✅ Image is 1080×1080 PNG
- ✅ "CANONNIERS" hero text renders in Barlow Condensed (NOT system fallback — verify by char shapes)
- ✅ Info panel shows "JOUR DE MATCH", "VS. Tyrans", "JEUDI 15 MAI" (15 May 2026 is a Friday — verify date math; if wrong, the formatDate function has a UTC bug)
- ✅ Time "19:00" visible
- ✅ Venue "Stade Canonniers" visible
- ✅ Blueprint geometric lines visible
- ✅ No cutout (graphic-only variant)

Self-correction note: 2026-05-15 is a **Friday**. If the rendered card says SAMEDI/SATURDAY, your date arithmetic is wrong by one day — likely a timezone issue. Fix before proceeding.

### 4. Cache hit on identical second call

Re-run the exact same payload. Expected: `cached: true`, response time well under 500ms (no browser launched).

```bash
# Confirm in D1
wrangler d1 execute canonniers-db --remote --command "SELECT COUNT(*) FROM generated_cards;"
# Expected: 1 (only one row even after two calls)
```

### 5. Render with-cutout variant

Replace the test cutout URL with the actual one uploaded in D.4:

```javascript
const payload = {
  template: 'game-day',
  variant: 'with-cutout',
  team_id: 'u15',
  content: {
    opponent_name: 'Tyrans',
    opponent_logo_url: 'https://cards.canonniersdequebec.ca/templates/cards/game-day/test-assets/test-opponent-logo.png',
    game_date: '2026-05-15',
    game_time: '19:00',
    venue_name: 'Stade Canonniers',
    is_home: true,
    language: 'fr',
    cutouts: [{
      image_url: 'https://cards.canonniersdequebec.ca/templates/cards/game-day/test-assets/test-cutout.png',
      preset: 'bottom-right'
    }]
  }
};
// ... fetch as above
```

Expected: 200, new card_id (different content_hash from graphic-only). Open URL, confirm:
- ✅ Cutout visible bottom-right
- ✅ Cutout is layered ABOVE the "CANONNIERS" hero text (per locked spec)
- ✅ Cutout has cyan glow drop-shadow
- ✅ Info panel still readable (cutout doesn't overlap it)

### 6. Long opponent name handling

```javascript
// Tier 1
content.opponent_name = 'Tyrans'; // 6 chars → tier1, 36px
// Tier 2
content.opponent_name = 'Académie Baseball Canada'; // 24 chars → tier2, 28px, may wrap
// Tier 3
content.opponent_name = 'Académie Baseball Canada Lanaudière'; // 35 chars → tier3, 24px, 2-line clamp
```

Render each and visually confirm the opponent name fits within the info panel without breaking layout.

### 7. Missing data fallbacks

Test each null/missing case:

```javascript
// No game_time
content.game_time = null; // expect "À DÉTERMINER" displayed

// No venue
content.venue_name = null; // expect venue block omitted, no empty space

// No opponent logo
content.opponent_logo_url = null; // expect cyan shield silhouette fallback

// Away game
content.is_home = false; // expect "@" instead of "VS."

// English
content.language = 'en'; // expect "GAME DAY", "FRIDAY MAY 15", "TBD"
```

### 8. Validation rejections

Each of these MUST return 400:

```javascript
// Missing opponent_name
{ template: 'game-day', variant: 'graphic-only', team_id: 'u15', content: { game_date: '2026-05-15', language: 'fr' } }

// Bad date format
{ ..., content: { ..., game_date: '15/05/2026' } }

// Cutout on graphic-only
{ ..., variant: 'graphic-only', content: { ..., cutouts: [{...}] } }

// Three cutouts
{ ..., variant: 'with-cutout', content: { ..., cutouts: [{...}, {...}, {...}] } }

// Non-https cutout URL
{ ..., content: { ..., cutouts: [{ image_url: 'http://example.com/x.png', preset: 'bottom-right' }] } }

// Invalid team_id
{ ..., team_id: 'u20' }
```

### 9. Browser Rendering quota check

After verification, dump current month usage:

```bash
wrangler browser usage
```

Expected: well under 10 hours/month (we should have used minutes, not hours, during verification). If verification consumed >30 minutes of browser time, something is wrong — likely a hung render or runaway cache miss. Investigate before declaring directive complete.

### 10. Rate limit rule still effective

Trigger the rate limit deliberately:

```bash
# 30 rapid requests should hit whatever threshold was set in Directive 01
for i in {1..30}; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    https://canonniers-cards-worker.chisholm2000.workers.dev/render \
    -H 'content-type: application/json' \
    -H "cf-access-jwt-assertion: $JWT" \
    -d '{"template":"game-day","variant":"graphic-only","team_id":"u15","content":{"opponent_name":"x","game_date":"2026-05-15","language":"fr"}}'
done | sort | uniq -c
```

Expected: at least some `429` responses. If none, the rate limit isn't applying — escalate to Jay (this isn't a Directive 02 blocker but should be flagged).

### 11. Existing systems untouched

- `admin-photos.html` still loads, auth still resolves, photos still list
- `admin-roster.html` still loads
- `admin-social.html` still loads
- Public site loads
- `wrangler d1 execute canonniers-db --remote --command "SELECT COUNT(*) FROM players;"` matches pre-directive count
- `wrangler d1 execute canonniers-db --remote --command "SELECT COUNT(*) FROM photos;"` matches pre-directive count

---

## Rollback Plan

Each part rolls back independently. Execute in reverse order.

### Rollback Worker code

```bash
cd workers/canonniers-cards-worker
git revert <commit-sha-of-directive-02>
wrangler deploy
```

This reverts to the Directive 01 stub `/render` handler. Existing cached cards in D1 remain (harmless — they just won't be served until re-deployed).

### Rollback R2 assets

```bash
# Templates and fonts can stay; they're inert without the Worker reading them.
# But if you want a clean slate:
wrangler r2 object delete canonniers-cards/templates/cards/game-day/with-cutout.html
wrangler r2 object delete canonniers-cards/templates/cards/game-day/graphic-only.html
wrangler r2 object delete canonniers-cards/templates/cards/game-day/layout.json
wrangler r2 object delete canonniers-cards/templates/cards/_shared/css/base.css
wrangler r2 object delete canonniers-cards/templates/cards/_shared/fonts/barlow-condensed-400.woff2
wrangler r2 object delete canonniers-cards/templates/cards/_shared/fonts/barlow-condensed-700.woff2
# Generated cards are safe to delete:
wrangler r2 bucket list-objects canonniers-cards --prefix=generated/ | \
  jq -r '.objects[].key' | xargs -I{} wrangler r2 object delete canonniers-cards/{}
```

### Rollback D1 cache rows

```bash
wrangler d1 execute canonniers-db --remote --command "DELETE FROM generated_cards;"
```

The table itself stays (Directive 01 created it). Just clears any cached rows.

### Rollback Browser Rendering binding

If the binding itself is causing issues:
```bash
# Edit wrangler.toml, remove the [browser] block, redeploy
wrangler deploy
```

### Catastrophic rollback

Restore D1 from the backup taken in Pre-Flight #7:
```bash
# DESTRUCTIVE — confirms with Jay before running
wrangler d1 execute canonniers-db --remote --file=../canonniers-backups/canonniers-db-pre-d02-<timestamp>.sql
```

---

## What Ships After This Directive

- ✅ Game-day template, both variants, rendered server-side at 1080×1080
- ✅ `POST /render` endpoint live, authenticated, rate-limited, cached
- ✅ Browser Rendering binding integrated and operational
- ✅ Self-hosted Barlow Condensed fonts in R2, loaded with `font-display: block`
- ✅ D1 content-hash cache active (identical re-renders return cached URL in <500ms)
- ✅ Test cutout assets uploaded; with-cutout variant fully exercisable end-to-end
- ✅ Layout JSON committed for Directive 03 compose UI to consume
- ✅ All existing systems untouched

**No human-facing UI yet — that's Directive 03.** A developer with auth can render a card via curl/console.

---

## Attack Vectors (How to Break This)

Threat-modeling pass. None of these are unfixed; they're things to be aware of.

1. **Cache poisoning via collision.** `content_hash` is SHA-256 of canonical JSON. Collision is computationally infeasible. ✅
2. **R2 path traversal in cutout URLs.** Worker validates `image_url` starts with `https://` but does NOT restrict it to canonniersdequebec.ca domains. **Risk:** an authenticated user could pass a cutout URL pointing to an arbitrary external image (e.g., an image with a malicious filename, an image hosted on a personal domain). Browser Rendering will fetch and embed it. **Mitigation deferred to Directive 03:** restrict cutout URLs to `^https://(cards|images)\.canonniersdequebec\.ca/` once the cutout pipeline is real. For Directive 02, only authenticated coaches/admins can call `/render`, and they can already upload anything to R2 via admin tools, so the threat surface is limited. **Document this as a known gap.**
3. **Render endpoint as unbounded compute amplifier.** Each call costs ~2-5s of browser time. Authenticated user could burn the 10hr/mo quota. Mitigations: (a) rate limit rule from Directive 01, (b) D1 cache makes spammed identical requests free, (c) Workers Paid cost guardrails alert on overage. ✅
4. **HTML injection via opponent_name.** All `{{...}}` substitutions HTML-escape. Triple-brace `{{{cutouts_html}}}` is generated by the Worker (which controls escaping) — never from user input directly. ✅
5. **Cutout image as XSS vector.** Cutout images are `<img src>`, not embedded inline. SVG cutouts could contain `<script>`, but the request validation rejects non-PNG cutouts implicitly (Browser Rendering renders the SVG as-is, but it runs in a sandboxed Chromium with no access back to the Worker). Risk is low but non-zero. **Hardening for Directive 03:** content-type sniffing on cutout fetches, reject non-image content-types. For Directive 02: known gap, authenticated users only.
6. **D1 unbounded growth.** Cache rows accumulate forever. `generated_cards` schema includes `created_at`; future maintenance can prune old entries. Not a Directive 02 issue.
7. **Race condition on cache miss.** Two simultaneous identical requests both miss the cache, both render, both insert. `content_hash` should be UNIQUE on the table. **Verify Directive 01 schema includes UNIQUE constraint on content_hash.** If not, add it now or accept duplicate-row possibility (last-write-wins on D1 reads).

---

## Estimated Time

- Pre-flight: 15 minutes
- Part A (template files): 30 minutes
- Part B (HTML templates, including iteration): 90 minutes — bulk of the work
- Part C (Worker code): 90 minutes
- Part D (R2 uploads): 15 minutes
- Part E (deploy): 5 minutes
- Post-deploy verification: 60 minutes — many cases to walk through
- Buffer for first-render debugging (font loading, date math, layout overflow): 30-60 minutes

**Total: ~5-6 hours of focused work, possibly more on first iteration of HTML/CSS to match the mockup.**

---

## Approval

Awaiting Jay's review of this directive. Once approved, deliver to Claude Code's UPDATE directory.
