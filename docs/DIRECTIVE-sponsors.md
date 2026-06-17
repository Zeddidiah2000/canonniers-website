# DIRECTIVE — Sponsors / Commanditaires

Standing directive for the sponsor-placement feature. Self-contained: a visual mockup exists
(design study built separately) but **you will not see it** — every spec needed is below.

---

## 1. What we're building

Sponsors (commanditaires) need a home on the site. There are **three complementary
placements** — they do different jobs and are *not* an either/or. Build all three eventually;
they all read **one shared data source** so they never drift.

| # | Placement | Where | Job |
|---|---|---|---|
| 1 | **Partners page** (`partenaires.html`) | New page, in nav + footer | Full directory. The only spot that scales 5 → 20+ logos and shows the tier hierarchy. The canonical home everything else links to. |
| 2 | **"Presented by" lockup** | Game cards (`index.html`) + live stream (`diffusion.html`) | One top-tier (Gold) presenting sponsor on the highest-visibility, best-monetized moment. |
| 3 | **Footer band** | Above the footer, every page | Compact "Team Partners" strip. Steady low-key exposure for the whole roster, never dominates. |

**Build order:** (1) Partners page first — it's the canonical home everything links to →
(2) Footer band — links into it → (3) Presented-by — premium, only matters once a Gold
sponsor is actually sold.

---

## 2. The most important constraint right now

**Only the 15U AAA team has sponsors today.** 17U D1 and 17U D2 have none yet.

And within 15U, **only one logo is real and confirmed: Les Voyages Simon Pelletier** (Gold tier).
Everything else is TBD — Jay will drop the real 15U list (names, tiers, logo files, URLs) into
`Updates\`. Do not invent sponsor names.

Because of this, **every placement must handle the empty/sparse case gracefully:**

- **A team with zero sponsors** → the footer band and presented-by lockup are **omitted entirely**
  for that team (no empty shell). The Partners page still renders for that team but shows a
  bilingual "sponsorship available" empty state instead of empty grids (copy in §6).
- **A tier with zero sponsors** → that tier group is **not rendered** (no empty "Silver" heading).
- The data model is fully team-aware from day one even though only 15U is populated, so adding
  17U sponsors later is a data edit, not a code change.

---

## 3. Data model — one shared source

All three placements read the same config so they can never disagree. For v1 keep it dead simple:
a single committed file, no worker/KV/D1 (sponsor data is tiny and low-churn — graduate to KV + an
admin page later only if churn justifies it).

**Proposed:** `sponsors.js` at repo root (or `assets/sponsors/sponsors.js`), logos in
`assets/sponsors/`. Shape:

```js
// sponsors.js
window.CDQ_SPONSORS = {
  u15: {
    gold:   [ { name: "Les Voyages Simon Pelletier", logo: "assets/sponsors/lvsp.jpg", url: "https://…" } ],
    silver: [],
    bronze: []
  },
  u17d1: { gold: [], silver: [], bronze: [] },
  u17d2: { gold: [], silver: [], bronze: [] }
};
```

- `name` — required (used as `alt` and as the fallback well label).
- `logo` — path to the logo image. If omitted, render the **faux well** (name in Barlow
  Condensed 700 on white) so a sponsor with no logo yet still shows.
- `url` — optional. When present the well is a clickable `<a target="_blank" rel="noopener">`;
  when absent it's a plain `<div>`.

Seed it with **Les Voyages Simon Pelletier only** under `u15.gold`. Leave the rest as empty arrays.

> Team keys are the site's existing `u15` / `u17d1` / `u17d2`. Reuse them everywhere.

---

## 4. The universal "logo well" (used by all three placements)

One shared treatment so every sponsor logo looks consistent:

- White fill, `1px solid var(--gray-light)` border, `border-radius: var(--r-lg)` (5px).
- Logo: `object-fit: contain`, `max-width/max-height: 100%`, padding ~14px.
- Clickable wells (`<a class="well">`) lift on hover: `translateY(-2px)`, soft navy shadow
  (`var(--shadow-card-hover)`), border → `var(--border-sky)`. Transition ~0.18s. Non-clickable
  wells don't lift.
- **Faux well** (no logo yet): centered column — a small navy glyph + the sponsor name in
  `Barlow Condensed` 700 uppercase, `var(--navy-mid)`. This is a temporary placeholder; real
  logos replace it automatically once `logo` is set.

Never recolor or restyle the logos themselves — the white well is the only chrome around them.

---

## 5. Placement specs

### Placement 1 — Partners page (`partenaires.html`)

- New page using the **shared chrome** (lang bar → header → nav → page-header → content → footer).
  Add **Partenaires / Partners** to the main nav and to the footer Navigation column. Use
  `alignement.html` as the chrome reference.
- **Team tabs** (`u15` / `u17d1` / `u17d2`) like the roster page; switching tabs swaps the
  sponsor set. Persist nothing special — follow whatever the other multi-team pages do.
- Page-header: **Nos partenaires / Our partners**, sub-line `<team label> · Merci à nos
  commanditaires / Thank you to our sponsors`.
- Then tiered grids, **Gold → Silver → Bronze**, each as a group with a header row:
  colored dot + uppercase tier name + a hairline rule filling the row.
  - Tier dot colors: Gold `#c8a23c`, Silver `#9aa7b4`, Bronze `#b07a4e` (each with a soft
    same-hue 3px ring). These are the **only** non-palette colors allowed, and only as the
    tiny tier dots — everything else stays on the navy/sky tokens.
  - Grid + well sizing (desktop): **Gold** = 2 columns, wells ~138px tall, big logos.
    **Silver** = 3 columns, ~104px. **Bronze** = 4 columns, ~80px.
  - Mobile reflow: Gold 1-col, Silver 2-col, Bronze 2-col.
- Empty tiers are skipped. A team with **no sponsors at all** shows the empty state from §6
  instead of grids.

### Placement 2 — "Presented by" lockup (`index.html` game cards + `diffusion.html`)

- Uses **one sponsor: the team's first Gold sponsor** (`CDQ_SPONSORS[team].gold[0]`).
  If the team has no Gold sponsor, **render nothing** — no label, no empty pill.
- **On the next-up / game cards (`index.html`):** a thin strip across the bottom of the card,
  separated by a `1px` sky-alpha top border, containing a tiny uppercase label
  **Présenté par / Presented by** (`var(--font-display)`, ~9px, white at 0.55 alpha on the
  navy card) + a small white well (~30px tall, logo or faux).
- **On the live stream (`diffusion.html`):** the same lockup sits in the stream's title bar,
  next to the stream title.
- Keep it to **one** sponsor only — this placement's value is that it stays uncluttered and
  premium.

### Placement 3 — Footer band (above the footer, every page)

- A `.partners-band` panel directly above the existing footer: navy gradient
  (`var(--grad-navy-panel)`) with the soft top-right sky radial glow, `3px solid var(--sky)`
  top border.
- Centered: eyebrow **Partenaires de l'équipe / Team partners · `<team label>`** → a flex-wrap
  row of logo wells (~64px tall, up to ~8 logos, Gold+Silver+Bronze in order, truncate the
  rest) → a **Voir tous nos partenaires / See all our partners →** link to `partenaires.html`.
- **Team context:** the band reflects whichever team the page is about. On single-team pages use
  that team; on the homepage follow the page's existing team selection (or default `u15`).
- If the resolved team has **no sponsors**, omit the entire band.
- Mobile: wells reflow to ~2 per row.

---

## 6. Copy (bilingual — FR default, mirrored EN)

Every string twice in the DOM (`.fr-text` / `.en-text`), québécois register. Key strings:

| Context | FR | EN |
|---|---|---|
| Nav / footer link | Partenaires | Partners |
| Page title | Nos **partenaires** | Our **partners** |
| Page sub | Merci à nos commanditaires | Thank you to our sponsors |
| Page intro | Les commanditaires des Canonniers `<team>` rendent la saison possible. Cliquez un logo pour visiter le partenaire. | The Canonniers `<team>` sponsors make the season possible. Click a logo to visit the partner. |
| Tier headings | Partenaires Or / Partenaires Argent / Partenaires Bronze | Gold Partners / Silver Partners / Bronze Partners |
| Presented-by label | Présenté par | Presented by |
| Footer band eyebrow | Partenaires de l'équipe · `<team>` | Team partners · `<team>` |
| Footer band link | Voir tous nos partenaires → | See all our partners → |
| **Empty state** (team w/ no sponsors) | Cette équipe n'a pas encore de commanditaires. Vous aimeriez soutenir les Canonniers `<team>`? | This team has no sponsors yet. Want to support the Canonniers `<team>`? |
| Empty-state CTA | Devenir partenaire | Become a partner |

(`<team>` = the team label: "15U AAA", "17U D1", "17U D2".) Highlight one word per heading in
`--sky` / `--sky-light` per the house heading trick.

---

## 7. House rules that apply (from CLAUDE.md — restating the load-bearing ones)

- **Tokens only**, no hard-coded hexes except the three tier-dot colors in §5. Wire all three
  content-width breakpoints (1100 → 1380 → 1680) on the new page.
- **Bilingual, no exceptions** — mirrored FR/EN, FR default, québécois register, `localStorage`
  key `lang`. This is a legal requirement, not optional.
- **Complete files only**, read each file fresh before editing, **review before write** (show
  full file, wait for approval) unless trust-mode is active.
- This is an **unofficial fan site** — sponsor copy must never imply the association itself sells
  or endorses these placements.

---

## 8. What Jay still owes you

1. The real **15U sponsor list**: names, tier (Gold/Silver/Bronze), logo files, and URLs. Until
   then, seed with **Les Voyages Simon Pelletier** (Gold) only.
2. Confirmation of the **`sponsors.js` location + logo folder** (proposal in §3 — fine to proceed
   with it under trust-mode).
3. 17U D1 / D2 sponsor lists whenever those teams sign partners (data edit only).
