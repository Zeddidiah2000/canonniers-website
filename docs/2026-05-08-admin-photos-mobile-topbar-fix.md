# Directive — Fix admin-photos.html topbar overflow on mobile

**File:** `admin-photos.html`
**Scope:** CSS-only patch in the `<style>` block (responsive section near line ~493).
**Risk:** Low. No HTML changes, no JS changes, no schema changes.
**Rollback:** Single commit revert.

---

## Problem

On mobile (≤620px), the sticky topbar packs 5 elements on one 56px row:
`[Badge] [Upload | Manage tabs] [← Admin Portal] [Logout]`

The "Manage / Gérer" tab gets visually crushed by the "← Admin Portal / Portail admin" pill — and French labels ("Galerie photos", "Téléverser", "Gérer", "Portail admin", "Déconnexion") make it worse. See attached screenshots from Jay.

---

## Pre-flight verification

Before applying, run from repo root:

```bash
# 1. Confirm working tree is clean and on main
git status
git pull --ff-only

# 2. Confirm we're editing the live version (no drift since last session)
git log -1 --format="%h %s" -- admin-photos.html

# 3. Confirm the responsive block we're targeting still exists at the expected location
grep -n "@media (max-width: 620px)" admin-photos.html
grep -n "\.topbar {" admin-photos.html
```

Expected: one `@media (max-width: 620px)` near line 494; one `.topbar {` near line 118. If either is missing or has materially diverged, **STOP** and re-sync with Jay before proceeding.

---

## Patch

Replace the existing mobile responsive block (currently around lines 493–505):

```css
    /* ── RESPONSIVE ──────────────────────────────────────────────── */
    @media (max-width: 620px) {
      .topbar { padding: 0 16px; }
      .topbar-title { display: none; }
      .tab-btn { padding: 10px 14px; font-size: 12px; }
      .container { padding: 24px 16px 60px; }
      .seg-control { width: 100%; }
      .seg-btn { flex: 1; text-align: center; padding: 10px 8px; }
      .field-grid-2 { grid-template-columns: 1fr; }
      .file-captions.visible { grid-template-columns: 1fr; }
      .manage-row { grid-template-columns: 60px 1fr auto; gap: 10px; }
      .manage-thumb { width: 60px; height: 60px; }
    }
```

…with this expanded block:

```css
    /* ── RESPONSIVE ──────────────────────────────────────────────── */
    @media (max-width: 620px) {
      /* Topbar: wrap to 2 rows so tabs get their own row at full width */
      .topbar {
        height: auto;
        min-height: 56px;
        padding: 8px 14px;
        flex-wrap: wrap;
        gap: 8px 10px;
        row-gap: 8px;
      }
      .topbar-title { display: none; }

      /* Row 1: badge takes remaining space, ghost + logout sit on the right */
      .topbar-left  { flex: 1 1 auto; min-width: 0; gap: 8px; }
      .topbar-right { flex: 0 0 auto; gap: 6px; }

      /* Row 2: tabs span the full topbar width as a segmented control */
      .tab-nav {
        order: 99;            /* push to second row */
        flex: 1 1 100%;
        width: 100%;
      }
      .tab-btn {
        flex: 1 1 0;          /* equal halves */
        padding: 11px 8px;    /* ~40px tall — meets WCAG AA tap target */
        font-size: 12px;
        letter-spacing: 0.06em;
      }

      /* Right-side controls: tighten to fit FR labels without truncation */
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
      .seg-control { width: 100%; }
      .seg-btn { flex: 1; text-align: center; padding: 10px 8px; }
      .field-grid-2 { grid-template-columns: 1fr; }
      .file-captions.visible { grid-template-columns: 1fr; }
      .manage-row { grid-template-columns: 60px 1fr auto; gap: 10px; }
      .manage-thumb { width: 60px; height: 60px; }
    }

    /* Extra-tight viewports (≤380px) — drop the arrow glyph from the ghost button
       so "Portail admin" + "Déconnexion" never wrap. */
    @media (max-width: 380px) {
      .btn-ghost { padding: 7px 8px; font-size: 10.5px; }
      .btn-ghost .fr-text::before,
      .btn-ghost .en-text::before { content: ""; }
    }
```

> Note: the `::before` rule is a safety hatch — currently the arrow is hard-coded inside the span text (`← Portail admin`), so it has no effect today. Leaving it in costs nothing and lets us swap to a pseudo-element approach later without revisiting this file. **If Claude Code prefers to omit it for cleanliness, that's fine — flag in commit message.**

---

## Post-deploy verification

After Cloudflare Pages auto-deploys, on a real mobile device or DevTools mobile emulator:

1. **Visual check (EN):** load `/admin-photos.html`, confirm:
   - Row 1 shows `[PHOTO GALLERY badge]` on the left, `[← ADMIN PORTAL] [LOGOUT]` on the right, no clipping.
   - Row 2 shows `[UPLOAD] [MANAGE]` as two equal-width buttons spanning the full width.
   - "MANAGE" is fully visible, not cut off behind anything.

2. **Visual check (FR):** click `FR`, confirm same layout with `[GALERIE PHOTOS]`, `[← PORTAIL ADMIN]`, `[DÉCONNEXION]`, `[TÉLÉVERSER]`, `[GÉRER]` — all readable, no overlap.

3. **Tap target audit:** in DevTools, hover/inspect `.tab-btn`. Computed height should be ≥40px. `.btn-ghost` and `.logout-btn` should be ≥32px (acceptable — they're secondary).

4. **Sticky behaviour:** scroll the page on mobile. Topbar should stay pinned to the top; backdrop-filter blur should still apply. iOS Safari is the riskiest target — test there if available.

5. **Desktop regression check:** load on a ≥1024px viewport. Layout must be unchanged from current state (single-row topbar, fixed 56px height).

6. **Narrow viewport (≤380px):** open DevTools, set width to 360px, confirm `[← PORTAIL ADMIN]` does not wrap or clip.

---

## Open questions for Claude Code

1. **Should the same fix be ported to `admin-roster.html`, `admin-coaches.html`, and `admin-social.html`?** They almost certainly have the same topbar pattern. Recommend a follow-up directive that consolidates the topbar CSS into a single shared block (or a separate `admin-shell.css` file) rather than copy-pasting four times. **Do not bundle that work into this commit.**

2. **Is the `::before` safety hatch worth keeping?** If you'd rather strip it, do so — note in commit message.

---

## Rollback plan

If anything breaks:

```bash
git revert <commit-sha>
git push origin main
```

Cloudflare Pages will redeploy the previous version within ~60s. No data migration involved; this is presentation-only.

---

## Commit message

```
fix(admin-photos): wrap topbar to 2 rows on mobile so Manage tab is no longer clipped

- Topbar becomes flex-wrap on ≤620px; tabs move to their own full-width row
- Tab buttons grow to ~40px tall (meets WCAG 2.5.5 AA tap-target)
- Ghost button + logout tightened to fit FR labels without overlap
- Adds ≤380px breakpoint for very narrow viewports
- No HTML or JS changes; rollback is a single revert

Reported via screenshot from Jay (FR + EN both showed Manage/Gérer crushed).
```
