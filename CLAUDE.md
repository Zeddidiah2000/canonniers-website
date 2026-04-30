# CLAUDE.md — Canonniers de Québec Website

Standing brief for Claude Code. Read this before touching anything.

---

## What this project is

An **unofficial fan site** for the Canonniers de Québec AAA baseball program at **canonniersdequebec.ca**. Three teams: 15U AAA, 17U Division 1, 17U Division 2. Fully bilingual FR/EN. Never imply the site is operated by the association.

**Owner:** Jay (maintainer, all technical decisions). **JP** runs the Facebook page and leads the association.

**GitHub:** `Zeddidiah2000/canonniers-website` (public). Push to `main` → Cloudflare Pages auto-deploys to canonniersdequebec.ca. Drag-and-drop deploy is fully retired — never use it.

---

## Folder structure

Working root: `C:\Users\Potato\Documents\Canonniers Website\`

- `repo-working\` — **the active git repo**. All edits happen here. Run all git commands from this folder.
- `Updates\` — drop zone for directive files and input data. When Jay says he's dropped something in, check here first.
- `Canonniers WEB\` — backup/reference copy. Do not edit.

**Inside `repo-working\`:**
- `docs/` — archived directives, project notes, stats schema. Completed directive files live here.
- `scripts/` — Node.js injection/validation scripts for the stats pipeline.
- `stats-input/` — drop zone for incoming GameChanger JSON (gitignored).
- `backups/` — pre-injection backups (gitignored).
- `src/index.js` — `canonniers-roster-worker` source.
- `photo-worker/src/index.js` — `photo-worker` source (CF Images + D1 photos table).

---

## Tech stack

- **Hosting:** Cloudflare Pages (static HTML)
- **Workers:**
  - `spordle-proxy` → `https://spordle-proxy.chisholm2000.workers.dev` — Spordle schedule proxy + Claude API + remove.bg
  - `canonniers-roster-worker` → D1 CRUD + R2 player photos
  - `photo-worker` → `https://photo-worker.chisholm2000.workers.dev` — CF Images direct upload + D1 photos table
  - `canonniers-ical` → iCal feeds
- **Database:** Cloudflare D1 `canonniers-db` (roster + photos)
- **Storage:** Cloudflare R2 `player-photos` (player headshots)
- **Images:** Cloudflare Images — delivery URL pattern: `https://imagedelivery.net/XuWXX2Hn8HGMN14wNLQAMA/<cf_image_id>/<variant>`
- **Live streaming:** Cloudflare Stream (three live input UIDs for the three teams)

**Spordle team IDs:** 15U AAA = `156779`, 17U D1 = `156780`, 17U D2 = `156781`

---

## Design system — non-negotiable on every page

```css
--navy: #0d1f4e   --navy-mid: #152960   --navy-light: #1e3a8a
--sky: #6ab0d4    --sky-light: #a8d4ec  --sky-pale: #daeef8
--white: #ffffff  --off-white: #f4f7fa  --gray: #6b7280  --gray-light: #e5e7eb
```

- Fonts: `Barlow Condensed` (700–900, uppercase) for headings/UI; `Barlow` for body. Both from Google Fonts.
- Content width breakpoints: **1100px** (default) → **1380px** (`min-width: 1400px`) → **1680px** (`min-width: 1800px`). All three must be wired on every page.
- Shared chrome: lang bar → header (centered logo) → nav → page-header → team tabs → content → footer.
- Nav has sky-blue underline on the active page. Three-tab team structure (`u15` / `u17d1` / `u17d2`) on all multi-team pages.
- Footer: 3-column grid (logo+blurb / Navigation links / Contact address).

**Reference page for chrome conventions:** `alignement.html`.

---

## Bilingual rules

Every user-facing string lives twice in the DOM, toggled by a CSS class on `<body>`:

```html
<span class="fr-text">Accueil</span><span class="en-text">Home</span>
```

```css
.en-text { display: none !important; }
body.lang-en .fr-text { display: none !important; }
body.lang-en .en-text { display: revert !important; }
```

- **No exceptions.** Never deliver a page with French-only or English-only strings.
- French copy must use **québécois register**: "Calendrier" not "Programme", "Alignement" not "Composition", "Matchs" not "Jeux", "Pratiques" not "Entraînements".
- Language preference stored in `localStorage` key `lang`.

---

## Delivery conventions

**Always start from the current file.** Read it fresh before every edit. Never work from memory of a previously generated version.

**Complete files only.** Every response that touches an HTML file must contain the entire file. No diffs, patches, or partial snippets — Jay commits and pushes directly.

**Review before write.** For any non-trivial file (HTML pages, worker JS), output the complete contents in a code block and wait for explicit "approved" or "write it" before calling the Write tool.

**After delivering files**, remind Jay to push to GitHub AND re-upload the updated file to the project so the next session starts from the current source.

---

## Git / deploy protocol (Commits 2+ of any directive)

1. Write files → `git add <specific files>` → `git commit`
2. Show `git show HEAD --stat` + full diff
3. **Wait for explicit "push"** before running `git push`
4. If the commit includes a `wrangler deploy`: show the plan first, **wait for explicit "deploy"** before running it

Never include "Co-Authored-By: Claude" in commit messages.

---

## Updates folder workflow

Jay drops directive files and data inputs into `Updates\`. When he says he's dropped something in, check that folder.

After a directive is **complete**, move its file from `Updates\` to `repo-working\docs\` — always ask Jay first (the answer is always yes, but ask anyway). Commit the move as its own small commit.

---

## Admin pages

All `/admin*.html` pages use:
- Page-level password: `canonniers2026`, stored in `sessionStorage` key `admin_auth`
- Worker-level auth: `Authorization: Bearer <token>` (token varies by worker — check the page's JS constants)
- `noindex` meta tag, `Disallow` entry in `robots.txt`

Admin pages are accessible via `admin.html` tile grid (role-gated by `?role=` URL param — Cloudflare Access migration is on the backlog).

---

## Key pages (current state as of 2026-04-30)

| File | Purpose |
|---|---|
| `index.html` | Bilingual homepage — hero, stats strip, news, upcoming games sidebar |
| `calendrier.html` | Live schedule via Spordle proxy Worker |
| `alignement.html` | Dynamic roster from D1; rows link to `joueur.html?id=` |
| `joueur.html` | Player profile — hero banner, career pills, stats |
| `diffusion.html` | Cloudflare Stream live streaming |
| `galerie.html` | Public photo gallery — CF Images, team tabs, type filter, lightbox |
| `admin.html` | Admin hub — tile grid, role-gated |
| `admin-roster.html` | Roster CRUD + R2 headshot upload |
| `admin-social.html` | FB post generator + Game Day card |
| `admin-photos.html` | Photo upload portal (CF Images direct upload, D1 insert) |
| `faq.html` | FAQ page |

---

## Known gotchas

**Spordle API:** Do NOT include `venue` in the `include` array — causes 500 errors. Read venue from `surface.venue.name`. Required headers include `Origin: https://page.spordle.com` and `X-Page-Type: LEAGUE`. Full details in `docs/DIRECTIVE-photo-vault-v4.2.md` and `docs/project-notes.md`.

**Player photos** must be on a public route in the roster Worker — protected routes = broken images on the site.

**Worker syntax:** `export default { fetch }` (ES module) — not the old `addEventListener('fetch', ...)` style.

**Cloudflare Pages cache:** `cpuTimeMs: 0` in Worker logs means the Worker isn't executing (stale deploy), not a code bug. Re-deploy or check route binding.

**www SSL:** Both `www.canonniersdequebec.ca` as a custom domain in Pages AND a 301 redirect rule to apex must exist — don't remove either.

---

## Active backlog (priority order as of 2026-04-30)

1. Rotate `PHOTO_UPLOAD_TOKEN` and `CF_IMAGES_TOKEN` — both appeared in chat. Directive: `Updates\DIRECTIVE-rotate-photo-tokens.md`
2. Cloudflare Access migration for all admin pages (replacing static password)
3. Auto background removal in `admin-roster.html` upload flow
4. Real-time 2026 stats Worker (replaces manual JSON injection — stats pipeline currently on hold)
5. Fix opponent-name overflow on Game Day cards
6. Wire Contact / Médias Sociaux / YouTube nav links
7. Build out 17U D1/D2 streaming panels with replay data
8. Real Facebook Page integration on homepage
9. Coming-soon admin modules: Replay Manager (Phase 3), Team Finance (Phase 4)

---

## Archived directives (in `docs/`)

Each describes a completed feature in full detail — read them if touching related code.

- `DIRECTIVE-photo-vault-v4.2.md` — Photo Gallery module (photo-worker, admin-photos.html, galerie.html) ✅
- `DIRECTIVE-admin-tile-grid-refactor.md` — admin.html tile grid + Cloudflare Access migration path
- `DIRECTIVE-breakpoint-consistency.md` — content width breakpoint rules
- `DIRECTIVE-roster-form-fields.md` — admin-roster.html form fields
- `DIRECTIVE-roster-show-all-columns.md` — roster table column changes
- `DIRECTIVE-fix-edit-button.md`, `DIRECTIVE-fix-photo-wipe.md`, `DIRECTIVE-joueur-grid-overflow.md` — targeted bug fixes
