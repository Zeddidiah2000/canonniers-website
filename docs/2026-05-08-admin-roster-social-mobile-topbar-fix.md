# Directive — Fix admin-roster.html and admin-social.html topbar overflow on mobile

**Date:** 2026-05-08
**Files touched:** `admin-roster.html`, `admin-social.html`
**Scope:** CSS-only patch in each file's `<style>` block (responsive section only).
**Risk:** Low. No HTML changes, no JS changes, no schema changes.
**Rollback:** Single commit revert.

**Context:** Follow-up to `2026-05-08-admin-photos-mobile-topbar-fix.md` (already applied).
`admin-coaches.html` was inspected and has a completely different layout — no standard topbar — so it is out of scope.

---

## Problem

On mobile (≤620px), the sticky topbar in both pages packs several elements on one 56px row:
`[Badge] [← Admin Portal] [Logout]`

Neither page has tab buttons in the topbar (unlike admin-photos), so the two-row tab treatment from admin-photos does **not** apply here. The fix is simpler: allow the topbar to wrap and tighten the ghost/logout buttons so French labels ("← Portail admin", "Déconnexion") never clip or overflow.

---

## Pre-flight verification

Run from `repo-working\`:

```bash
# 1. Clean tree on main
git status
git pull --ff-only

# 2. Confirm responsive block locations
grep -n "@media (max-width: 620px)" admin-roster.html
grep -n "@media (max-width: 620px)" admin-social.html
```

Expected for **admin-roster.html**: one `@media (max-width: 620px)` near line 489.
Expected for **admin-social.html**: one `@media (max-width: 620px)` near line 545.

If either is missing or materially diverged, STOP and re-sync before patching.

---

## Patch A — admin-roster.html

**Find (exact match, near line 489):**
```css
    @media (max-width: 620px) {
      .topbar { padding: 0 16px; }
      .topbar-title { display: none; }
      .container { padding: 24px 16px 60px; }
      .field-grid-2 { grid-template-columns: 1fr; }
      .filter-bar { flex-wrap: wrap; gap: 8px; }
      table { font-size: 12px; }
      .card { padding: 16px; }
    }
```

**Replace with:**
```css
    @media (max-width: 620px) {
      /* Topbar: allow wrap so ghost + logout never crush the badge */
      .topbar {
        height: auto;
        min-height: 56px;
        padding: 8px 14px;
        flex-wrap: wrap;
        gap: 8px 10px;
        row-gap: 8px;
      }
      .topbar-title { display: none; }
      .topbar-left  { flex: 1 1 auto; min-width: 0; gap: 8px; }
      .topbar-right { flex: 0 0 auto; gap: 6px; }

      /* Tighten right-side controls to fit FR labels without truncation */
      .btn-ghost {
        padding: 7px 10px;
        font-size: 11px;
        letter-spacing: 0.06em;
        gap: 4px;
      }
      .logout-btn {
        padding: 6px 10px;
        font-size: 10px;
        letter-spacing: 0.08em;
      }

      /* Existing mobile rules (unchanged) */
      .container { padding: 24px 16px 60px; }
      .field-grid-2 { grid-template-columns: 1fr; }
      .filter-bar { flex-wrap: wrap; gap: 8px; }
      table { font-size: 12px; }
      .card { padding: 16px; }
    }

    /* Extra-tight viewports (≤380px) */
    @media (max-width: 380px) {
      .btn-ghost { padding: 7px 8px; font-size: 10.5px; }
    }
```

---

## Patch B — admin-social.html

**Find (exact match, near line 545):**
```css
    @media (max-width: 620px) {
      .field-row { grid-template-columns: 1fr; }
      .topbar { padding: 0 16px; }
      .topbar-title { display: none; }
      .topbar-site-link { display: none; }
      .admin-content { padding: 24px 12px 60px; }
      .post-actions { flex-direction: column; align-items: stretch; }
      .char-count { margin-left: 0; }
      .game-card { flex-wrap: wrap; }
      .tone-pills { gap: 6px; }
      .card { padding: 16px; }
      canvas { max-width: 100% !important; height: auto !important; }
    }
```

**Replace with:**
```css
    @media (max-width: 620px) {
      /* Topbar: allow wrap so ghost + logout never crush the badge */
      .topbar {
        height: auto;
        min-height: 56px;
        padding: 8px 14px;
        flex-wrap: wrap;
        gap: 8px 10px;
        row-gap: 8px;
      }
      .topbar-title { display: none; }
      .topbar-site-link { display: none; }
      .topbar-left  { flex: 1 1 auto; min-width: 0; gap: 8px; }
      .topbar-right { flex: 0 0 auto; gap: 6px; }

      /* Tighten right-side controls to fit FR labels without truncation */
      .btn-ghost {
        padding: 7px 10px;
        font-size: 11px;
        letter-spacing: 0.06em;
        gap: 4px;
      }
      .logout-btn {
        padding: 6px 10px;
        font-size: 10px;
        letter-spacing: 0.08em;
      }

      /* Existing mobile rules (unchanged) */
      .field-row { grid-template-columns: 1fr; }
      .admin-content { padding: 24px 12px 60px; }
      .post-actions { flex-direction: column; align-items: stretch; }
      .char-count { margin-left: 0; }
      .game-card { flex-wrap: wrap; }
      .tone-pills { gap: 6px; }
      .card { padding: 16px; }
      canvas { max-width: 100% !important; height: auto !important; }
    }

    /* Extra-tight viewports (≤380px) */
    @media (max-width: 380px) {
      .btn-ghost { padding: 7px 8px; font-size: 10.5px; }
    }
```

---

## Commit

```bash
git add admin-roster.html admin-social.html
git commit -m "fix(admin-roster,admin-social): wrap topbar on mobile so ghost/logout don't overflow

- flex-wrap on <=620px; topbar-left grows, topbar-right stays pinned right
- Ghost button + logout tightened to fit FR labels without truncation
- Adds <=380px breakpoint for very narrow viewports
- No HTML or JS changes; no tab-row treatment needed (neither page has topbar tabs)
- Mirrors fix already applied to admin-photos in prior commit"
git push origin main
```

---

## Post-deploy verification

After Cloudflare Pages auto-deploys (~1–2 min), test both pages on a real mobile device or DevTools mobile emulator:

**admin-roster.html:**
1. Row shows `[ROSTER ADMIN badge]` on left, `[← ADMIN PORTAL] [LOGOUT]` on right — no clipping.
2. FR: `[← PORTAIL ADMIN]` and `[DÉCONNEXION]` fully readable, no overlap.
3. Scroll — topbar stays sticky.
4. ≥1024px desktop — single-row topbar, 56px height, unchanged.

**admin-social.html:**
1. Same topbar row checks as above.
2. Rest of page (post generator, game day card, canvas) unchanged.
3. FR label check same as above.

---

## Rollback plan

```bash
git revert HEAD
git push origin main
```

Cloudflare Pages redeploys previous version within ~60s. Presentation-only change — no DB, no Worker, no data impact.

---

## Out of scope (deliberately)

- `admin-coaches.html` — inspected; has a completely different layout with no standard admin topbar. Not affected.
- `admin-photos.html` — already patched in prior directive.
- Consolidating topbar CSS into a shared `admin-shell.css` — valid long-term improvement, separate decision.
