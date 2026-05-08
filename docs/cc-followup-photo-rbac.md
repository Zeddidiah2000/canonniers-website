# Follow-up directive — Photo RBAC + Delete (responses to pre-flight)

This addresses your blockers A–E and resequences the commits.

---

## A) ROLE_MAP — confirmed clean

Jay verified: every entry in `env.ROLE_MAP` is either `jay@canonniers.ca` OR matches `^(coach|manager|social|photo|treasurer)(15u|17d1|17d2)@canonniers\.ca$`.

**Replace ROLE_MAP lookup with the regex resolver cleanly.** No defensive fallback needed. The new resolver becomes the single source of truth. After commit 1 deploys and is verified, the `ROLE_MAP` secret can be deleted from worker config in a follow-up cleanup (don't delete it in commit 1 — leave it as dead-but-harmless config until commit 1 is confirmed working in production for at least one full session).

```js
const ALL_TEAMS = ['u15', 'u17d1', 'u17d2'];

const TEAM_SUFFIX_MAP = {
  '15u':  'u15',
  '17d1': 'u17d1',
  '17d2': 'u17d2',
};

const ROLE_PATTERN = /^(coach|manager|social|photo|treasurer)(15u|17d1|17d2)@canonniers\.ca$/;

function resolveIdentity(emailRaw) {
  const email = String(emailRaw || '').toLowerCase().trim();

  if (email === 'jay@canonniers.ca') {
    return { role: 'admin', teams: ALL_TEAMS };
  }

  const m = email.match(ROLE_PATTERN);
  if (m) {
    const team = TEAM_SUFFIX_MAP[m[2]];
    if (team) return { role: m[1], teams: [team] };
  }

  return { role: 'unknown', teams: [] };
}
```

## B) Access protection — not needed

Confirmed by Jay: Cloudflare Access is enforced at the page layer with an `@canonniers.ca` allowlist. To reach any admin page that calls auth-worker or photo-worker, the user must already be authenticated via Access. The `*.workers.dev` URLs being directly reachable doesn't matter for this threat model — outsiders can't forge a valid Access JWT for the `canonniersdequebec.ca` zone, and insiders are bounded by the RBAC the workers themselves will enforce after commits 2/3/4.

**No commit 0. No DNS work. No new Access Applications. Proceed with the original directive's RBAC enforcement.**

## C) Deploy ordering — resequenced

You called out the gap correctly. Here's the new order. Old "commit 2" and "commit 3" merge into the new commit 4. Old "commit 4" splits into 2 (Pages proxy + galerie URL change) and 3 (admin-photos UI changes).

| New # | Old # | What | Risk if alone |
|---|---|---|---|
| 1 | 1 | auth-worker: add `teams[]` to response | Zero — additive, no callers consume it yet |
| 2 | part of 4c | Pages Function proxy + galerie.html WORKER_URL change | Zero — gallery still works, proxy is transparent |
| 3 | 4 (rest) | admin-photos.html: proxy URL + manage view + team gating | Zero — still bearer-only at worker, just routed differently |
| 4 | 2+3 | photo-worker: require JWT, add team RBAC, replace DELETE endpoint | Hard cutover — but commits 2 and 3 must already be deployed so all clients route through the proxy |
| 5 | 5 | galerie.html `onerror` + reconciler script | Zero — defensive cleanup |

**Why this works:** by the time commit 4 lands and the worker starts requiring `CF-Access-Jwt-Assertion`, both `galerie.html` (via commit 2) and `admin-photos.html` (via commit 3) are routing through `/api/photo-worker` on the same origin as the Access cookie. JWT flows automatically. No client-side JWT handling needed.

## D) Existing DELETE endpoint — replace it intentionally

Confirmed: rip out the existing `DELETE /api/photos/:id?mode=unpublish|purge` and replace with the new D1-first + RBAC version from the original directive's commit 3 spec.

If grep finds any callers of the old `?mode=` query param anywhere in the repo, fix them in the same commit (new endpoint takes no `mode` param — it always hard-deletes). If no callers exist, no caller updates needed.

## E) Env var name — use `PHOTO_UPLOAD_TOKEN`

Use the existing name throughout. Do NOT rename. The directive's references to `env.PHOTO_TOKEN` were my error — substitute `env.PHOTO_UPLOAD_TOKEN` everywhere it appears in the worker code.

---

## Parallel work you can start immediately

These don't depend on anything else and can ship anytime:

- **Commit 1** (auth-worker `teams[]`) — additive, no consumers yet
- **Commit 5a** (galerie.html `onerror` handler) — purely defensive client-side
- **`scripts/reconcile-ghost-photos.js`** — one-shot tool, run by Jay manually after commit 4 is live (the reconciler hits the new DELETE endpoint, so the *script* can land anytime but Jay won't *run* it until commit 4)
- **D1 backup** — take it now: `wrangler d1 export canonniers-db --output=backups/$(date +%Y%m%d-%H%M)-pre-photo-rbac.sql --remote`

Then 2 → 3 → 4 in sequence with verification between each.

---

## Two open questions you flagged that I should answer explicitly

**On the manage view placement:** embed it in `admin-photos.html` as a tab (per the mockup Jay approved). Don't create a separate `admin-photo-manage.html` page.

**On the manage tab UX:** when a user lands on `admin-photos.html`, default to the **Téléverser (upload)** tab (preserves existing flow). They click **Gérer** to switch. Don't auto-select the manage tab.

---

## Verification checklist between each commit

After every commit deploys to production, confirm before moving on:

1. Jay can still load `/admin.html` and see the photos tile
2. Jay can still load `/admin-photos.html` and upload a test photo
3. `/galerie.html` still renders photos for U15
4. No console errors on any of the three pages
5. (After commit 4) a test coach account can only see/upload to their own team

If any of those fail, stop and surface to Jay before continuing the chain.

---

## Rollback per commit

Each commit is independently `git revert`-able. The only commit that needs a D1 restore is anything that runs the reconciler — if Jay runs `--execute` and it deletes rows that shouldn't have been deleted, restore from the pre-flight backup.

Workers redeploy on revert push. Pages redeploys on revert push. No manual `wrangler deploy` needed unless something gets stuck.

---

Ready when you are. Start with the D1 backup, then commit 1.
