# Directive: Refactor admin into tile-grid landing + per-tool pages

**Repo:** `canonniers-website`, branch: `main`
**Scope:** HTML/JS/CSS only. No D1 schema changes. No Worker changes.

---

## Goal

Convert `admin.html` from a multi-tool single page into a tile-grid landing hub. Each tool becomes its own page at the repo root, prefixed `admin-*.html`. Add role-based tile gating with a `?role=` URL parameter for pre-Access testing. Add `noindex` and `robots.txt` Disallow entries for all admin pages. Delete the old `EditRoster/` directory entirely.

---

## End state

Files at repo root:
- `admin.html` — tile-grid landing only. No embedded tools.
- `admin-social.html` — Facebook post generator + Game Day card generator (both kept together).
- `admin-roster.html` — roster editor (formerly `EditRoster/index.html`).
- `robots.txt` — Disallow `/admin-*` entries.

Deleted:
- `EditRoster/` directory (entirely).

Untouched:
- All public pages (`index.html`, `calendrier.html`, `diffusion.html`, `alignement.html`, `faq.html`, `guide-diffusion-streaming.html`, `joueur.html`).
- Worker source (`src/index.js`).
- Schema files.

---

## Three-commit sequence

Each commit must be independently testable and rollbackable. Do not combine.

### Commit 1 — Create `admin-social.html`

**This commit must not modify `admin.html`.** Goal is to produce a working `admin-social.html` that can be tested live before anything is removed from the existing admin.

Steps:

1. Copy `admin.html` to `admin-social.html`.
2. In `admin-social.html`:
   - Update `<title>` to `Social Admin — Canonniers de Québec`.
   - Add `<meta name="robots" content="noindex, nofollow">` inside `<head>`.
   - Remove the entire "Coming Soon Modules" section (the block starting at `<!-- ── COMING SOON MODULES ── -->`, around line 1099).
   - Update the page header / eyebrow text from "Admin" to "Social Admin" (FR: "Admin Social"). Keep both bilingual.
   - Add a "← Back to admin" link at the top of the page, linking to `/admin.html`. Use the existing button styling (e.g. `.btn-ghost` if it exists, or match the navigation back-link pattern used elsewhere).
3. Verify the file works standalone:
   - Push to a feature branch first if you want, or push directly to `main` since `admin.html` is unchanged. Cloudflare Pages will deploy `admin-social.html` as a new accessible URL.
   - Hard-refresh `https://canonniersdequebec.ca/admin-social.html`.
   - Log in. Confirm post generator and game day card generator both work end-to-end (generate a real post for a real game, generate a card with a real opponent).
   - **Stop and report to Jay** before proceeding to commit 2.

Commit message:
```
refactor(admin): split social tools into admin-social.html

Copy of admin.html with the Coming Soon Modules section removed and
header updated to "Social Admin". admin.html is unchanged in this
commit so existing flows keep working. Next commit reduces admin.html
to the tile-grid landing.
```

---

### Commit 2 — Reduce `admin.html` to tile-grid landing

**Pre-flight:** Jay has confirmed commit 1's `admin-social.html` works end-to-end on the live site.

Steps:

1. In `admin.html`, replace everything between the existing login screen and the closing `</body>` tag with the tile grid (see "Tile grid implementation" below). Keep:
   - The existing `<!DOCTYPE html>`, `<head>`, fonts, CSS variables (`:root`).
   - The login screen (`#login-screen`).
   - The auth functions (`doLogin`, `doLogout`, session restore).
   - The `ADMIN_PASSWORD` constant.
   - The bilingual lang toggle (`setLang`, `lang-toggle`, the `fr-text` / `en-text` system).
2. Remove from `admin.html`:
   - The entire post-generator UI and JS (everything from team selector, game list, tone picker, generate button, output, copy-to-clipboard).
   - The entire game day card generator UI and JS (canvas, hero photo upload, remove.bg call, download).
   - The "Coming Soon Modules" section.
   - The `WORKER_URL`, `STREAM_PAGE`, `TEAM_CONFIG`, `MONTHS_FR/EN`, `DAYS_FR/EN` constants — these belong only to `admin-social.html` now.
   - The `selectedGame`, `selectedTone`, `selectedLangOpt`, `scheduleCache` state variables.
   - All Spordle game-loading functions, all post-generation functions, all card-rendering functions.
3. Add `<meta name="robots" content="noindex, nofollow">` inside `<head>`.
4. After login succeeds, the tile grid is the entire admin screen. No automatic data fetches on login (the old code called `loadGames('u15')` — remove this).

Commit message:
```
refactor(admin): admin.html is now the tile-grid landing only

Removes post generator, game day cards, and coming-soon section from
admin.html. All those tools now live at admin-social.html. admin.html
contains only: auth, lang toggle, and the tile grid.

Tile grid uses ?role= URL param for testing role-based gating before
Cloudflare Access is configured. See "Future Cloudflare Access
integration" in the directive for the migration path.
```

---

### Commit 3 — Move roster editor to `admin-roster.html`, delete `EditRoster/`

**Pre-flight:** Jay has confirmed commit 2's `admin.html` tile grid renders, all tiles link correctly, locked-state preview works via `?role=coach`.

Steps:

1. Copy `EditRoster/index.html` to `admin-roster.html` at repo root.
2. In `admin-roster.html`:
   - Update `<title>` to `Roster Editor — Canonniers de Québec`.
   - Add `<meta name="robots" content="noindex, nofollow">` inside `<head>`.
   - Update the page header / eyebrow text to "Roster Editor" (FR: "Éditeur d'alignement"). Bilingual.
   - Add a "← Back to admin" link at the top, linking to `/admin.html`. Match `admin-social.html`'s back-link styling for consistency.
3. **Delete the entire `EditRoster/` directory** from the repo. No redirect — Jay confirmed nobody saw the old URL live, no need to preserve it.
4. Verify:
   - `https://canonniersdequebec.ca/admin-roster.html` loads, login works, roster editor functions identically to before.
   - `https://canonniersdequebec.ca/EditRoster/` returns 404 (Pages handles this automatically once the folder is gone).

Commit message:
```
refactor(admin): roster editor → admin-roster.html, delete EditRoster/

Promote EditRoster/index.html to /admin-roster.html at repo root.
Delete the EditRoster/ directory entirely. No redirect — the old URL
was never shared publicly.

Adds noindex meta tag and back-link to admin landing.
```

---

## Tile grid implementation (for commit 2)

### Tile metadata

Inline in `admin.html`'s `<script>` block, after the auth functions:

```javascript
const TILES = [
  {
    id: 'social',
    href: '/admin-social.html',
    icon: 'megaphone',
    titleFr: 'Outils sociaux',
    titleEn: 'Social Tools',
    descFr: 'Générateur de publications Facebook et cartes graphiques de match.',
    descEn: 'Facebook post generator and game day card generator.',
    allowed: ['admin', 'coach'],
    status: 'active',
    phase: null
  },
  {
    id: 'roster',
    href: '/admin-roster.html',
    icon: 'user',
    titleFr: 'Éditeur d\'alignement',
    titleEn: 'Roster Editor',
    descFr: 'Ajouter, modifier ou supprimer des joueurs. Photos, positions, statistiques.',
    descEn: 'Add, edit, or remove players. Photos, positions, stats.',
    allowed: ['admin', 'coach'],
    status: 'active',
    phase: null
  },
  {
    id: 'photos',
    href: null,
    icon: 'camera',
    titleFr: 'Galerie photos',
    titleEn: 'Photo Gallery',
    descFr: 'Téléverser des photos de matchs par équipe et par date.',
    descEn: 'Upload game photos by team and date. Powers /galerie.html.',
    allowed: ['admin', 'manager'],
    status: 'coming-soon',
    phase: 'Phase 3'
  },
  {
    id: 'replays',
    href: null,
    icon: 'video',
    titleFr: 'Gestion des rediffusions',
    titleEn: 'Replay Manager',
    descFr: 'Lier les UIDs Cloudflare Stream aux matchs terminés.',
    descEn: 'Link Cloudflare Stream UIDs to completed games.',
    allowed: ['admin', 'coach'],
    status: 'coming-soon',
    phase: 'Phase 3'
  },
  {
    id: 'finance',
    href: null,
    icon: 'wallet',
    titleFr: 'Finances d\'équipe',
    titleEn: 'Team Finance',
    descFr: 'Suivre les fonds, dons, dépenses. Stockage de documents.',
    descEn: 'Track funds, donations, expenses. Document storage.',
    allowed: ['admin', 'treasurer'],
    status: 'coming-soon',
    phase: 'Phase 4'
  }
];

const ROLE_LABELS = {
  admin: { fr: 'Admin', en: 'Admin' },
  coach: { fr: 'Entraîneur', en: 'Coach' },
  manager: { fr: 'Gérant', en: 'Manager' },
  treasurer: { fr: 'Trésorier', en: 'Treasurer' }
};
```

### Role detection (pre-Access scaffolding)

```javascript
function getCurrentRole() {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('role');
  if (param && ROLE_LABELS[param]) return param;
  return 'admin'; // default until Cloudflare Access is wired up
}
```

This function is the **only** place role is read. When Access is configured later, replace its body with a fetch to `/cdn-cgi/access/get-identity` (see "Future Cloudflare Access integration" below). The rest of the gating code stays unchanged.

### Tile rendering

```javascript
function renderTiles() {
  const role = getCurrentRole();
  const grid = document.getElementById('tile-grid');
  grid.innerHTML = '';

  // Split active vs coming-soon for mobile readability
  const active = TILES.filter(t => t.status === 'active');
  const upcoming = TILES.filter(t => t.status === 'coming-soon');

  document.getElementById('current-role-fr').textContent = ROLE_LABELS[role].fr;
  document.getElementById('current-role-en').textContent = ROLE_LABELS[role].en;

  renderTileSection('section-active', active, role);
  renderTileSection('section-upcoming', upcoming, role);
}

function renderTileSection(containerId, tiles, role) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  for (const tile of tiles) {
    const allowed = tile.allowed.includes(role);
    const isActive = tile.status === 'active';
    const div = document.createElement('div');
    div.className = 'tile' + (allowed ? '' : ' tile-locked') + (isActive ? '' : ' tile-coming-soon');

    const roleTagsHtml = tile.allowed.map(r =>
      `<span class="role-tag role-${r}">
        <span class="fr-text">${ROLE_LABELS[r].fr}</span><span class="en-text">${ROLE_LABELS[r].en}</span>
      </span>`
    ).join('');

    div.innerHTML = `
      <div class="tile-header">
        <div class="tile-icon">${getIconSvg(tile.icon)}</div>
        <div class="role-tags">${roleTagsHtml}</div>
      </div>
      <div class="tile-title">
        <span class="fr-text">${escapeHtml(tile.titleFr)}</span>
        <span class="en-text">${escapeHtml(tile.titleEn)}</span>
      </div>
      <div class="tile-desc">
        <span class="fr-text">${escapeHtml(tile.descFr)}</span>
        <span class="en-text">${escapeHtml(tile.descEn)}</span>
      </div>
      <div class="tile-cta">
        ${
          isActive && allowed
            ? `<span class="fr-text">Ouvrir →</span><span class="en-text">Open →</span>`
            : !allowed
              ? `<span class="tile-lock-msg">
                  <span class="fr-text">Accès restreint</span>
                  <span class="en-text">Access restricted</span>
                </span>`
              : `<span class="fr-text">Bientôt · ${escapeHtml(tile.phase)}</span>
                 <span class="en-text">Coming soon · ${escapeHtml(tile.phase)}</span>`
        }
      </div>
    `;

    if (isActive && allowed) {
      div.style.cursor = 'pointer';
      div.addEventListener('click', () => { window.location.href = tile.href; });
    } else if (!allowed) {
      div.style.cursor = 'not-allowed';
    }

    container.appendChild(div);
  }
}
```

### Icons

Use inline SVG. **No emoji.** Pick simple monochrome line icons matching the existing aesthetic. Suggested set (24×24 viewBox, `stroke="currentColor"`, `fill="none"`):

- `megaphone` — for social
- `user` — for roster
- `camera` — for photos
- `video` — for replays
- `wallet` — for finance

Implement as a `getIconSvg(name)` function returning the SVG string. Source from a free icon set (Lucide, Heroicons, Tabler) — copy the SVG markup inline. Do NOT load an icon library from CDN.

### CSS additions

Add to `admin.html`'s `<style>` block:

```css
.tile-grid-container { max-width: 1100px; margin: 0 auto; padding: 24px; }

.tile-grid-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}

.tile-grid-header h1 {
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 32px;
  font-weight: 700;
  color: var(--white);
  margin: 0;
}

.tile-grid-subhead {
  font-size: 13px;
  color: var(--text-mid);
  margin-bottom: 32px;
}

.tile-section-title {
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 14px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin: 24px 0 12px;
}

.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.tile {
  background: var(--surface-2);
  border: 1.5px solid var(--border);
  border-radius: 8px;
  padding: 18px 20px;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s, transform 0.15s;
}

.tile:not(.tile-locked):not(.tile-coming-soon):hover {
  border-color: var(--sky);
  transform: translateY(-2px);
}

.tile-locked, .tile-coming-soon {
  opacity: 0.55;
}

.tile-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.tile-icon {
  color: var(--sky);
  width: 28px;
  height: 28px;
}

.tile-icon svg {
  width: 100%;
  height: 100%;
}

.role-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: flex-end;
}

.role-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 99px;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.role-tag.role-admin     { background: rgba(106,176,212,0.2);  color: var(--sky-light); }
.role-tag.role-coach     { background: rgba(106,176,212,0.15); color: var(--sky); }
.role-tag.role-manager   { background: rgba(168,212,236,0.1);  color: var(--text-mid); }
.role-tag.role-treasurer { background: rgba(250,200,100,0.15); color: #facb70; }

.tile-title {
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 20px;
  font-weight: 700;
  color: var(--white);
}

.tile-desc {
  font-size: 13px;
  color: var(--text-mid);
  flex: 1;
  line-height: 1.5;
}

.tile-cta {
  font-size: 13px;
  color: var(--sky);
  font-weight: 700;
  margin-top: 4px;
}

.tile-locked .tile-cta, .tile-coming-soon .tile-cta {
  color: var(--text-dim);
}

.tile-lock-msg { font-style: italic; }

@media (max-width: 600px) {
  .tile-grid-container { padding: 16px; }
  .tile-grid { grid-template-columns: 1fr; }
  .tile-grid-header { flex-direction: column; align-items: flex-start; gap: 4px; }
}
```

### HTML structure (replaces removed admin tools)

```html
<div id="admin-screen" style="display: none;">
  <div class="tile-grid-container">

    <div class="tile-grid-header">
      <h1>
        <span class="fr-text">Portail admin</span>
        <span class="en-text">Admin Portal</span>
      </h1>
      <div style="font-size: 13px; color: var(--text-mid);">
        <span class="fr-text">Connecté · Rôle : <span id="current-role-fr">Admin</span></span>
        <span class="en-text">Signed in · Role: <span id="current-role-en">Admin</span></span>
        <button onclick="doLogout()" class="btn-ghost" style="margin-left: 12px;">
          <span class="fr-text">Déconnexion</span><span class="en-text">Sign out</span>
        </button>
      </div>
    </div>

    <p class="tile-grid-subhead">
      <span class="fr-text">Canonniers de Québec · Non-officiel · outils administrateurs</span>
      <span class="en-text">Canonniers de Québec · Unofficial · admin tools</span>
    </p>

    <div class="tile-section-title">
      <span class="fr-text">Outils actifs</span>
      <span class="en-text">Active Tools</span>
    </div>
    <div id="section-active" class="tile-grid"></div>

    <div class="tile-section-title">
      <span class="fr-text">Bientôt disponibles</span>
      <span class="en-text">Coming Soon</span>
    </div>
    <div id="section-upcoming" class="tile-grid"></div>

  </div>
</div>
```

Call `renderTiles()` when the admin screen is shown — both on successful login and on session-restore.

---

## `robots.txt`

If `robots.txt` does not exist at repo root, create it. If it exists, add the disallows.

```
User-agent: *
Disallow: /admin.html
Disallow: /admin-social.html
Disallow: /admin-roster.html

Sitemap: https://canonniersdequebec.ca/sitemap.xml
```

The wildcard pattern `/admin-*` is not standard `robots.txt` syntax, so list each page explicitly. Add new admin pages to this file as they're created.

---

## Verification per commit

### After commit 1
- `https://canonniersdequebec.ca/admin-social.html` loads.
- Login works.
- Generate a real Facebook post for an upcoming game. Confirm output matches what `admin.html` produces.
- Generate a real game day card. Confirm output is identical.
- Hard-refresh and confirm session persists.
- `https://canonniersdequebec.ca/admin.html` is **unchanged** — still works exactly as before.

### After commit 2
- `https://canonniersdequebec.ca/admin.html` shows the tile grid after login.
- Active section shows: Social Tools, Roster Editor.
- Coming Soon section shows: Photo Gallery, Replay Manager, Team Finance.
- Each tile has correct role tags.
- Click "Social Tools" tile → navigates to `admin-social.html` and works.
- Click "Roster Editor" tile → goes to `/admin-roster.html` (will 404 until commit 3 — expected at this stage).
- `?role=coach` URL param: all tiles still appear (coach is in admin/coach allow list for active tiles, so they remain unlocked; coach is NOT in manager/treasurer allow lists, so Photo Gallery and Team Finance appear as locked).
- `?role=treasurer` URL param: Social Tools and Roster Editor appear locked, Team Finance is unlocked (still coming soon).
- `?role=admin` URL param: everything unlocked (active or coming soon).
- FR/EN toggle works on all tile content including role tags.
- Mobile view: grid collapses to one column, sections separated with eyebrow headings.
- View source: confirm `<meta name="robots" content="noindex, nofollow">` is present.

### After commit 3
- `https://canonniersdequebec.ca/admin-roster.html` loads.
- Login works.
- Edit Noah Chisholm: confirm height shows 5'11", BT shows R/R, all the prior fixes still work.
- Add a new test player end-to-end. Save. Edit again. Delete.
- `https://canonniersdequebec.ca/EditRoster/` returns 404.
- `https://canonniersdequebec.ca/admin-roster.html` view source: confirm `<meta name="robots" content="noindex, nofollow">` present.
- `robots.txt` accessible at `https://canonniersdequebec.ca/robots.txt` and contains all three Disallow lines.

---

## Future Cloudflare Access integration

When Jay is ready to migrate from JS-password gating to Cloudflare Access:

1. **Cloudflare dashboard setup:**
   - Zero Trust → Access → Applications → Add `canonniersdequebec.ca/admin*` as a Self-Hosted Application.
   - Identity Provider: Google (or email-with-magic-link OTP).
   - Policies: define one per role. E.g.:
     - "Admin" → emails: `jay@example.com`
     - "Coach" → emails: `jp@example.com`, `jay@example.com`
     - "Manager" → email list TBD
     - "Treasurer" → email list TBD
   - Note: groups in Access are how roles get attached to identities.

2. **Code changes (estimate ~30 lines):**
   - In each `admin-*.html`, remove the JS login screen entirely (Access blocks the page before it loads, so unauthenticated users never see it).
   - Remove the `ADMIN_PASSWORD` constant.
   - Replace `getCurrentRole()` with:
     ```javascript
     async function getCurrentRole() {
       try {
         const res = await fetch('/cdn-cgi/access/get-identity');
         const identity = await res.json();
         // identity.groups is an array of Access group names — map to role
         const groups = (identity.groups || []).map(g => g.toLowerCase());
         if (groups.includes('admin')) return 'admin';
         if (groups.includes('coach')) return 'coach';
         if (groups.includes('manager')) return 'manager';
         if (groups.includes('treasurer')) return 'treasurer';
         return 'coach'; // safe default — minimum privilege
       } catch (e) {
         console.error('Could not read identity', e);
         return 'coach';
       }
     }
     ```
   - Update worker to require `Cf-Access-Jwt-Assertion` header instead of `Bearer canonniersdequebec2026`. Validate the JWT against your Access app's public key (Cloudflare provides example code).
   - Remove the `Bearer canonniersdequebec2026` header from all client-side fetches in roster editor and social tools.

3. **Custom-branded login page (Jay's stated future preference):**
   - Cloudflare Access does NOT directly support a custom login page on your own domain. The login flow always goes through `*.cloudflareaccess.com`.
   - To make it look like canonniersdequebec.ca handles auth: Cloudflare Access supports **custom login page branding** (logo, colors, app name, custom CSS to a degree) via Zero Trust dashboard → Settings → Custom Pages. This achieves "branded but Cloudflare-hosted" — URL bar still briefly shows `canonniersdequebec.cloudflareaccess.com`.
   - For a fully white-labeled flow with no Cloudflare URL ever visible, an alternative is **Cloudflare Workers + Access JWT validation** with a custom `/login` page that captures email, calls Cloudflare's API to issue a one-time PIN, and sets the JWT cookie directly. This is multiple weeks of work and is not recommended for the user count (5–10).
   - Recommendation: ship with branded-but-Cloudflare-hosted login first, gather feedback, defer the fully-white-labeled flow until there's evidence users care.

4. **Authentication vs authorization:**
   - Cloudflare Access handles **authentication** (proving identity).
   - The tile metadata `allowed` array handles **authorization** (which tools each role sees).
   - These are separate. Adding a new tool means adding a new tile entry — no Access reconfiguration needed unless adding a new role.

---

## Open questions for Claude Code

If anything below is unclear from the file contents, **ask Jay before guessing:**

1. **Existing back-link styling** — does `admin.html` have a pattern for "back to home" links, or is this the first time we're adding one? If first time, propose a simple text-link style and confirm with Jay before applying.
2. **Icon choices** — confirm the five suggested icons (megaphone, user, camera, video, wallet) work for Jay, or substitute. Do not improvise — ask if uncertain.
3. **Existing CSS variables** — confirm `--surface-2`, `--border`, `--sky-light`, `--text-mid`, `--text-dim` all exist in the current `admin.html`. The directive's CSS uses them; if any are missing, add them or substitute existing equivalents.
4. **Login screen layout** — both `admin-social.html` and `admin-roster.html` will have their own login screens (copies of admin.html's). After Cloudflare Access goes in, all three login screens get removed. Confirm this is acceptable, or whether to consolidate now.
5. **`escapeHtml` function** — confirm it exists in the new `admin.html` (it should be carried over from the existing admin.html or roster editor). If missing, add the standard implementation already in use elsewhere.

If pre-flight reading reveals a structural issue this directive doesn't account for, stop and report.

---

## Rollback per commit

- Commit 1: `git revert <hash>` — removes `admin-social.html`. `admin.html` is untouched, so nothing breaks.
- Commit 2: `git revert <hash>` — restores all the post-generator and game-day-card code in `admin.html`. `admin-social.html` still works as a duplicate. Acceptable temporary state until decision.
- Commit 3: `git revert <hash>` — restores `EditRoster/` directory and removes `admin-roster.html`. `EditRoster/index.html` works again.

Each commit is independently revertable. The system is in a working state after every commit.
