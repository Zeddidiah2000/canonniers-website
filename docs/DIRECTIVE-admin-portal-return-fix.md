# Directive: Fix "Return to Portal" Welcome Screen Loop

## Problem

Tool pages (`admin-roster.html`, `admin-photos.html`, `admin-social.html`) link back to `/admin.html`, which always shows the welcome/identity screen first. User must click "Enter →" every time they return to the portal from a tool. The browser back button is unaffected — only the in-page "Admin Portal" return link triggers this.

## Fix

Combined hash + `sessionStorage` skip:

- Tool pages link to `/admin.html#portal` instead of `/admin.html`.
- `admin.html` skips the welcome screen when `location.hash === '#portal'` OR `sessionStorage.getItem('adminEntered') === '1'`.
- `enterPortal()` sets the `sessionStorage` flag.
- `doLogout()` clears the flag before redirect.

No `history.pushState`. No special hash promotion beyond the simple OR.

---

## Pre-flight verification

Before applying any patch, read the actual current state of these files from the working tree and confirm the strings below exist verbatim. Do NOT assume; if any string differs, stop and report the discrepancy.

**File: `admin.html`**

1. Confirm function `initAuth()` exists and contains the call `showIdentityInfo(email, roleData.role);` after a successful role lookup.
2. Confirm function `enterPortal()` exists and consists of:
   ```js
   function enterPortal() {
     document.getElementById('identity-screen').style.display = 'none';
     document.getElementById('admin-screen').style.display    = 'block';
     renderTiles();
   }
   ```
3. Confirm function `doLogout()` exists and consists of:
   ```js
   function doLogout() {
     window.location.href = '/';
   }
   ```

**Files: `admin-roster.html`, `admin-photos.html`, `admin-social.html`**

4. Confirm each contains exactly one occurrence of `href="/admin.html"` on the return-to-portal link (around lines 524, 463, 587 respectively per current state).

If any of the above differs, stop and ask before patching.

---

## Patches

### Patch 1: `admin.html` — gate welcome screen on hash/flag

**Location:** inside `initAuth()`, replace the line:

```js
    showIdentityInfo(email, roleData.role);
```

with:

```js
    const skipWelcome = location.hash === '#portal'
                     || sessionStorage.getItem('adminEntered') === '1';
    if (skipWelcome) {
      enterPortal();
    } else {
      showIdentityInfo(email, roleData.role);
    }
```

### Patch 2: `admin.html` — set flag in `enterPortal()`

**Location:** function `enterPortal()`. Replace the entire function body with:

```js
function enterPortal() {
  sessionStorage.setItem('adminEntered', '1');
  document.getElementById('identity-screen').style.display = 'none';
  document.getElementById('admin-screen').style.display    = 'block';
  renderTiles();
}
```

### Patch 3: `admin.html` — clear flag on logout

**Location:** function `doLogout()`. Replace the entire function body with:

```js
function doLogout() {
  sessionStorage.removeItem('adminEntered');
  window.location.href = '/';
}
```

### Patch 4: tool pages — update return link

In each of `admin-roster.html`, `admin-photos.html`, `admin-social.html`, change:

```html
<a href="/admin.html" class="btn-ghost"
```

to:

```html
<a href="/admin.html#portal" class="btn-ghost"
```

There is exactly one such occurrence per file. Do not edit other instances of `admin.html` (e.g., nav menus elsewhere on the page) — they should continue to point at the bare URL so the welcome screen still shows on cold entry from public nav.

---

## Commit structure

Single commit. The four patches are interdependent and a partial deploy leaves the bug half-fixed.

Suggested commit message:

```
admin: skip welcome screen on return from tools

Use #portal hash + sessionStorage flag so "Admin Portal" return links
from tool pages land directly on the tile view instead of forcing a
re-click of "Enter →".

- admin.html: initAuth checks hash/flag and calls enterPortal() if either set
- admin.html: enterPortal sets sessionStorage flag
- admin.html: doLogout clears sessionStorage flag
- admin-{roster,photos,social}.html: return link now points to /admin.html#portal
```

---

## Post-deploy verification

After Cloudflare Pages deploy completes, hard-refresh and walk through these scenarios. All must pass.

1. **Cold entry from public nav (welcome should show):**
   - Open a fresh incognito window, sign in via Cloudflare Access, land on `/admin.html`.
   - Expected: welcome screen with email + role, "Enter →" button.

2. **Enter portal:**
   - Click "Enter →".
   - Expected: tile view. In DevTools → Application → Session Storage, confirm `adminEntered = "1"`.

3. **Open tool, return via in-page link (the bug fix):**
   - Click any active tile (e.g., Roster).
   - On the tool page, click the "← Admin Portal" / "← Portail admin" link.
   - Expected: lands directly on tile view. URL shows `/admin.html#portal`. No welcome screen flash.

4. **Browser back button (regression check):**
   - From a tool page, press browser Back.
   - Expected: lands on tile view (works because flag is set).

5. **Reload mid-session:**
   - On the tile view, hit Cmd/Ctrl-R.
   - Expected: tile view re-renders directly. No welcome screen.

6. **Sign out clears flag:**
   - Click "Déconnexion / Sign out".
   - Lands on `/`. Open DevTools → Session Storage for the origin → confirm `adminEntered` is gone.
   - Navigate back to `/admin.html`.
   - Expected: welcome screen shows again (cold-entry path).

7. **New tab does not inherit:**
   - With portal entered in tab A, open `/admin.html` in tab B.
   - Expected: tab B shows welcome screen (`sessionStorage` is per-tab).

8. **Bilingual check:**
   - On the tile view, toggle FR ↔ EN. All labels render in both languages.
   - Click return link from a tool page in each language. Tile view renders correctly.

---

## Open questions for Claude Code

Ask before proceeding if any apply:

- If any of the four files has been edited since this directive was drafted (the verification strings don't match), report the actual current state before patching.
- If `sessionStorage` is already used elsewhere in `admin.html` for an unrelated key, note it but proceed — `adminEntered` is a new key, no conflict expected.
- If the return link in any tool page wraps differently (e.g., extra attributes between `href` and `class`), apply the patch by changing only the `href` value, not the surrounding markup.

---

## Rollback plan

Single revert commit restores prior behavior:

```
git revert <commit-sha>
git push origin main
```

The revert is safe at any point: the `sessionStorage` key becomes orphaned in users' tabs but causes no errors (nothing reads it post-revert), and clears on tab close. Tool page return links revert to bare `/admin.html`, restoring the original (buggy) behavior without breaking anything.

If only one of the four files needs to be rolled back (unlikely — they're interdependent), revert all four together. A partial revert leaves the system in an inconsistent state where return links point to `#portal` but `admin.html` ignores the hash.

---

## Threat model / attack vectors

- `sessionStorage.adminEntered` is a UI hint, not an auth token. The Cloudflare Access identity check + Worker role lookup runs unconditionally on every `admin.html` load. Setting the flag manually only skips the welcome cosmetic; it does not bypass auth.
- `#portal` hash is in the URL — an unauthenticated user landing on `/admin.html#portal` still hits the auth gate and gets the error state. No bypass.
- No new exfiltration surface: flag is a single boolean, no PII or credentials stored.
- XSS that could set the flag would already have full DOM access — this change adds zero attack surface.
