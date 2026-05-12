# Directive Addendum: Photo Library Access Pivot

**Author:** Jay + Claude (planning session 2026-05-12)
**Target executor:** Claude Code
**Parent directive:** `DIRECTIVE-photo-library.md`
**Applies to:** Commits 3 and 4 (commits 1, 2, 2.5 unchanged)
**Read before:** starting commit 3

---

## Why this addendum exists

Original directive granted library access to admin / coach / manager / photo roles. Jay decided post-bootstrap that the library management UI should be admin-only for now, BUT coaches still need to pull photos FROM the library when editing their roster. This addendum reconciles those two requirements without rebuilding from scratch.

## Net effect

- `admin-photo-library.html` = Jay-only management surface (browse all 306, bulk upload, push to gallery, delete)
- `admin-roster.html` = unchanged access (admin/coach/manager), but now offers two parallel paths to give a player a photo:
  - **Path A:** Choose from library (NEW — uses lazy classification stamping)
  - **Path B:** Upload from device (EXISTING — preserved, does NOT touch library)

The 306 unsorted photos get classified over time as coaches do their normal roster work via Path A. Jay never has to manually sort them.

---

## Pre-flight before starting commit 3

Confirm bootstrap cleanup from commit 2.5 actually completed:

```bash
cd workers/library
wrangler secret list                          # BOOTSTRAP_TOKEN must be absent
grep -i "bootstrap" src/index.js              # must return nothing
curl -s -X POST https://canonniers-library-worker.chisholm2000.workers.dev/api/library/upload \
  -H "X-Bootstrap-Token: anything" \
  --data ""                                   # expect 401, not anything else
```

If any check fails, fix bootstrap cleanup FIRST. Do not proceed.

---

## Changes to commit 3

### Change 1: Tile visibility in `admin.html`

Library tile `allowed` array changes from:
```javascript
allowed: ['admin', 'coach', 'manager', 'photo'],
```
to:
```javascript
allowed: ['admin'],
```

Strict admin only. No delegation to `photo` role for now.

### Change 2: Page identity gate in `admin-photo-library.html`

In the `loadIdentity()` function, the role check changes from:
```javascript
if (!identity.role || !['admin','coach','manager','photo'].includes(identity.role)) {
  return window.location.href = '/admin.html';
}
```
to:
```javascript
if (identity.role !== 'admin') {
  return window.location.href = '/admin.html';
}
```

Any non-admin who types the URL directly gets bounced.

### Change 3: Worker endpoint role scoping

In `workers/library/src/index.js`, endpoints split into two tiers.

**Open to admin / coach / manager** (with `CALLER_TEAMS` filtering as already designed):
- `GET /api/library` — picker needs this for the listing
- `GET /api/library/file/:id` — picker needs this for thumb + full image
- `POST /api/library/:id/assign-player` — picker calls this to assign

**Admin-only** — add an early check at the top of each handler:
```javascript
if (caller.role !== 'admin') return json({ error: 'Admin only' }, 403, origin);
```
- `POST /api/library/upload`
- `POST /api/library/:id/push-to-gallery`
- `DELETE /api/library/:id` (already admin-only per directive — confirm enforcement is at handler level, not just UI)

---

## Changes to commit 4

### Change 4: Roster editor presents TWO photo input paths

`admin-roster.html` keeps BOTH ways to assign a player photo. Both visible to admin / coach / manager.

**Path A — Choose from library** (NEW)
- Button: "Choisir depuis la bibliothèque / Choose from library"
- Opens picker modal showing caller's team(s) + unsorted (E4a scope from parent directive)
- On pick: `POST /api/library/:id/assign-player` on `canonniers-library-worker`
- Library worker copies bytes to public bucket, stamps `linked_teams` + `linked_player_ids`, updates `players.photo_url`
- This is how the 306 unsorted media-day photos get classified — coaches sort the library FOR Jay just by doing their normal roster work

**Path B — Upload from device** (EXISTING, preserve exactly)
- The existing `<input type="file" id="p-photo">` field stays
- The existing upload flow via `canonniers-roster-worker`'s `/api/upload` endpoint stays
- Coach uploads phone photo → bytes go directly to public bucket → `players.photo_url` updates
- **Does NOT touch `photo_library` table**
- Library stays curated (only intentional bulk uploads land there)

Both paths produce a player photo. Difference is whether the library gets a row.

**UI presentation:** Show side-by-side or as labelled tabs in the player edit form:
- "Choisir depuis la bibliothèque (recommandé) / Choose from library (recommended)"
- "Téléverser depuis l'appareil / Upload from device"

Path A should be the primary/default option since most near-term assignments will pull from the 306 media-day photos.

### Change 5: Historical link policy (no code, documenting intent)

If a coach uses Path A to assign library photo #87 to player 12, then LATER uses Path B to upload a phone photo for the same player 12:

- `players.photo_url` updates to point at the new phone photo (Path B overwrites)
- Library row #87 keeps `linked_player_ids: [12]` and its `linked_teams` stamp
- We do NOT unlink. The stamp is a true historical statement.
- Library row #87 stays in its team tab forever — correct, since it WAS used for that team once.

No worker logic needed. Falls out naturally because Path B doesn't call the library worker at all.

---

## Verification matrix updates

### Modify row 3:
> | 3 | Visit `https://canonniersdequebec.ca/admin-photo-library.html` | coach-u15 test account | **Redirect to /admin.html (page is admin-only)** |

(was: "3 tabs visible, Delete tab hidden")

### Insert new row 6.5 (between current rows 6 and 7):
> | 6.5 | In admin-roster.html, edit u15 player, use Path B (file upload) instead of Path A | coach-u15 | **Photo uploads via existing flow, `players.photo_url` updates, `photo_library` table unchanged (verify: `SELECT COUNT(*) FROM photo_library` still returns 306)** |

### Row 19 unchanged:
> | 19 | All 306 media-day photos imported and visible | admin in Library tab | **306 tiles, all in `Non triées`, sorted by filename ascending** |

---

## Rollback

If pivot causes problems, the rollback is reverting commits 3 and 4 only:

```bash
git revert HEAD~1                # revert commit 4 first
git revert HEAD~1                # then commit 3
git push origin main
```

Commits 1, 2, 2.5 are unaffected — the worker, schema, R2 bucket, and 306 uploaded photos all persist.

---

## Summary of work

| Commit | Status | Changes from original directive |
|---|---|---|
| 1 | Done | None |
| 2 | Done | None |
| 2.5 | Done | None |
| **3** | **Modified** | Tile admin-only, identity gate strict admin, worker endpoint role checks added |
| **4** | **Modified** | Keep Path B (file upload) AND add Path A (library picker) as parallel options |
| 5 | Unchanged | robots.txt + noindex sweep |
