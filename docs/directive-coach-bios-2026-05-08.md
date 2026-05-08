# Directive — Add Coach Bios + Schema Drift Cleanup

**Date:** 2026-05-08
**Author:** Jay (drafted with Claude)
**Branch strategy:** All changes on `main` (single source of truth per repo convention)
**Estimated commits:** 3 (one per logical change — independently revertable)

---

## Goal

1. Render the 12 coaches across all three teams on `alignement.html`, with each coach row linking to a new `coach.html?id=<slug>` bio page.
2. Build `coach.html` — a bilingual coach bio page mirroring the visual schema of `joueur.html`. All bio content is hardcoded in JS; empty fields render bilingual `Information à venir` / `Coming soon` placeholders.
3. Fix three pre-existing schema drift bugs caught during this work:
   - `alignement.html` footer is unilingual French and missing FAQ + Galerie links
   - `alignement.html` had an empty `personnel-placeholder` div with no rendering logic for coaches
   - `joueur.html` footer Navigation column is missing the Galerie link

---

## Why this approach

- **Hardcoded bios over D1.** Coach data turns over once a year; players' stats turn over weekly. Building a `staff` table + worker endpoints + admin editor for a static-ish dataset is debt-heavy. If turnover increases or non-technical edits become a pain point, migrate to D1 then.
- **Slug-based IDs, not numeric.** Coaches don't have a DB so there's no auto-increment. Slugs (`dave-dufour`, `loic-masse`) are stable, readable, and survive renames better than positional indexes.
- **Schema parity is enforced by reading the canonical pattern from existing pages**, not from memory. The footer pattern was confirmed by reading `index.html`, `calendrier.html`, `diffusion.html`, `faq.html`, and `galerie.html`. All five agree. `alignement.html` and `joueur.html` are the outliers being fixed.

---

## Files in this directive

Two new files to drop in (replace) and one targeted edit:

| File | Action | Source |
|---|---|---|
| `alignement.html` | **Replace entirely** | Provided in this drop |
| `coach.html` | **Create new** | Provided in this drop |
| `joueur.html` | **Targeted edit** | One footer line addition |

---

## Pre-flight verification

Run these checks before applying any changes. **Stop and surface to Jay if any check fails.**

### 1. Confirm the working tree is clean

```bash
cd <repo root>
git status
```

Expected: `nothing to commit, working tree clean`. If there are uncommitted changes, stop and ask.

### 2. Confirm GitHub `main` matches local

```bash
git fetch origin main
git rev-parse HEAD
git rev-parse origin/main
```

Expected: both SHAs identical. If not, `git pull --ff-only` first.

### 3. Diff the directive's expected baseline against current `main`

The patches below assume specific current content in `alignement.html` and `joueur.html`. Verify these strings exist in the current files **before** patching:

**`alignement.html` — must currently contain (the drifted footer):**

```html
        <h4 class="footer-col-title">Navigation</h4>
        <a href="index.html">Accueil</a>
```

```bash
grep -F '<h4 class="footer-col-title">Navigation</h4>' alignement.html
```

If grep returns nothing, **stop**. The footer has already been patched or has drifted differently. Surface to Jay.

**`alignement.html` — must currently contain the empty placeholder line:**

```bash
grep -F 'roster-section personnel-placeholder' alignement.html
```

If grep returns nothing, **stop**. Surface to Jay.

**`joueur.html` — must currently contain the FAQ-but-no-Galerie footer block:**

```bash
grep -A1 -F '<a href="faq.html"><span class="fr-text">FAQ</span><span class="en-text">FAQ</span></a>' joueur.html | head -20
```

Expected: the `<a href="faq.html">` line followed immediately by `</div>` (closing the footer-col), **not** by a Galerie link. If a Galerie link is already there, skip Step 3 (joueur.html edit) entirely and note the skip in the commit log.

### 4. Confirm no `coach.html` already exists

```bash
ls coach.html 2>/dev/null && echo "EXISTS — STOP" || echo "OK — does not exist"
```

If it exists, stop and surface to Jay.

---

## Patches

### Step 1 — Replace `alignement.html`

Drop the new `alignement.html` file from this directive's payload over the existing file.

**What changed inside the file:**
- Added `STAFF` constant: 12 coaches across `u15` / `u17d1` / `u17d2`, each with `slug`, `number`, `name`, `role_fr`, `role_en`. Head coach is the first entry per team.
- Added `buildStaffSection(teamId)` renderer that produces a `Personnel d'entraîneurs / Coaching Staff` table styled with the existing `.personnel-table` CSS class. Rows are clickable (`window.location.href='coach.html?id=<slug>'`) with `cursor: pointer`.
- Replaced the empty `<div class="roster-section personnel-placeholder" data-team="${teamId}"></div>` with `html += buildStaffSection(teamId);`.
- Footer fully replaced with the canonical bilingual pattern (matches `index.html`, `calendrier.html`, `diffusion.html`, `faq.html`, `galerie.html`). The previous footer was unilingual French, used `<h4>` instead of `<div class="footer-col-title">`, was missing FAQ + Galerie nav links, and had a stale Stade Canac contact block.

**Bilingual audit result:** 25 FR / 25 EN spans (parity).

**Verification after applying:**

```bash
# 1. JS still parses
node -e "const fs=require('fs');const html=fs.readFileSync('alignement.html','utf8');const scripts=[...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]);scripts.forEach((s,i)=>{try{new Function(s);console.log('script #'+i+': OK')}catch(e){console.log('script #'+i+': '+e.message);process.exit(1)}});"

# 2. Bilingual parity
fr=$(grep -o 'class="fr-text"' alignement.html | wc -l)
en=$(grep -o 'class="en-text"' alignement.html | wc -l)
echo "fr=$fr en=$en"
# Expect: fr=25 en=25 (or equal numbers — counts may shift slightly with line-ending normalization)

# 3. Drifted footer is gone
! grep -F '<h4 class="footer-col-title">Navigation</h4>' alignement.html && echo "OK: drifted footer removed"

# 4. Coach data is present
grep -c "'dave-dufour'" alignement.html  # expect 1
grep -c "'mathieu-deschenes'" alignement.html  # expect 1
```

**Commit:**
```
git add alignement.html
git commit -m "alignement: add coaching staff section + canonical footer

- Render coaches per team with click-through to coach.html
- Replace drifted unilingual footer with canonical bilingual pattern
- Adds FAQ and Galerie to footer nav (parity with other pages)"
```

### Step 2 — Create `coach.html`

Drop the new `coach.html` file from this directive's payload at the repo root.

**What it does:**
- Visual shell mirrors `joueur.html`: lang bar, header, nav, breadcrumb header, two-column layout (240px profile card on the left, content stack on the right), canonical footer.
- Reads `?id=<slug>` from URL. If the slug isn't in the local `COACHES` object, redirects back to `alignement.html`.
- Renders 5 profile rows: Role, Number, Team, "With the organization", "Coaching since".
- Renders two content sections: Biography (paragraph text, supports `\n\n` paragraph breaks) and Playing Background (list of level / where / years).
- Falls back to bilingual `Information à venir` / `Coming soon` placeholders for any unfilled scalar field.
- Falls back to `Biographie à venir` / `Biography coming soon` for empty bio sections.
- Falls back to `<div class="initials-circle">` (coach initials) when no `photo_url` is set.
- All 12 coach slugs are pre-populated as stub entries with empty bios. Jay will fill them in over time by editing the `COACHES` object directly.

**Bilingual audit result:** 34 FR / 34 EN spans (parity).

**Verification after applying:**

```bash
# 1. File exists and JS parses
test -f coach.html && echo "OK: file exists"
node -e "const fs=require('fs');const html=fs.readFileSync('coach.html','utf8');const scripts=[...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]);scripts.forEach((s,i)=>{try{new Function(s);console.log('script #'+i+': OK')}catch(e){console.log('script #'+i+': '+e.message);process.exit(1)}});"

# 2. Bilingual parity
fr=$(grep -o 'class="fr-text"' coach.html | wc -l)
en=$(grep -o 'class="en-text"' coach.html | wc -l)
echo "fr=$fr en=$en"  # expect equal counts

# 3. All 12 slugs present
for slug in dave-dufour mathieu-fontaine jean-christophe-masson vincent-leveille \
            jonathan-landry jean-pierre-chamberland mathieu-vachon loic-masse \
            mathieu-deschenes arthur-perrois laurent-savard francis-verge; do
  count=$(grep -c "'$slug'" coach.html)
  echo "$slug: $count"
  [ "$count" -ge 1 ] || { echo "MISSING: $slug"; exit 1; }
done
```

**Slug parity check across both files** — these slugs MUST match exactly between `alignement.html` and `coach.html`, otherwise the click-through redirects back to alignement:

```bash
# Extract slugs from each file and diff
grep -oE "'[a-z-]+(?=': \{)" coach.html | sort -u > /tmp/coach-slugs.txt
grep -oE "slug: '[a-z-]+'" alignement.html | sed "s/slug: '//;s/'//" | sort -u > /tmp/align-slugs.txt
diff /tmp/coach-slugs.txt /tmp/align-slugs.txt && echo "OK: slugs match" || { echo "MISMATCH — fix before deploy"; exit 1; }
```

**Commit:**
```
git add coach.html
git commit -m "coach: new bilingual coach bio page

- Mirrors joueur.html visual schema
- 12 coach stubs with empty bios; bilingual 'Information à venir' placeholders
- Reachable via alignement.html roster click-through"
```

### Step 3 — Patch `joueur.html` footer (drift fix)

Add the missing Galerie link to the footer Navigation column. Single-line addition, between the FAQ link and the closing `</div>`.

**Find:**
```html
        <a href="faq.html"><span class="fr-text">FAQ</span><span class="en-text">FAQ</span></a>
      </div>
      <div class="footer-col">
        <div class="footer-col-title">Contact</div>
```

**Replace with:**
```html
        <a href="faq.html"><span class="fr-text">FAQ</span><span class="en-text">FAQ</span></a>
        <a href="galerie.html"><span class="fr-text">Galerie</span><span class="en-text">Gallery</span></a>
      </div>
      <div class="footer-col">
        <div class="footer-col-title">Contact</div>
```

**Verification:**

```bash
# Galerie now in footer
grep -c '<a href="galerie.html">' joueur.html
# expect 0 in nav (joueur is a profile page, no top nav galerie active class)
# but at least 1 in footer — total 1
```

```bash
# Total link count in footer Navigation column should now be 6 (Accueil, Calendrier, Alignement, Diffusion, FAQ, Galerie)
awk '/<div class="footer-col-title fr-text">Navigation<\/div>/,/<\/div>$/' joueur.html | grep -c '<a href='
# expect 6
```

**Commit:**
```
git add joueur.html
git commit -m "joueur: add Galerie to footer nav (schema parity)"
```

---

## Push and verify deploy

```bash
git push origin main
```

Cloudflare Pages will auto-deploy. Wait ~60–90s for the build, then verify live:

### Live smoke checks

1. Visit `https://canonniersdequebec.ca/alignement.html`
   - Confirm three teams tab. For each team, scroll past Joueurs to the **Personnel d'entraîneurs / Coaching Staff** section.
   - Confirm 4 coaches per team. Toggle FR/EN — labels and roles switch.
   - Confirm head coach is first row in each team (Dufour for u15, Landry for u17d1, Deschênes for u17d2).
   - Hover a coach row — cursor turns to pointer, row highlights `--sky-pale`.
   - Click any coach row — should land on `coach.html?id=<slug>`.

2. On `coach.html` for any coach (e.g., `https://canonniersdequebec.ca/coach.html?id=dave-dufour`):
   - Breadcrumb shows `Alignement › Dave Dufour`.
   - Headline shows `10` in jersey circle, `DAVE DUFOUR` as h1, `ENTRAÎNEUR-CHEF` tag.
   - Profile card shows initials placeholder (no photo set), Role, Number 10, Team `Canonniers 15U AAA`, "Avec l'organisation" = `Information à venir`, "Entraîneur depuis" = `Information à venir`.
   - Biography section shows `Biographie à venir.` (centered, italic gray).
   - Playing background section shows `Information à venir.` (centered, italic gray).
   - Toggle FR → EN. All placeholders flip to English. Profile-card row labels flip to English. Section headings flip.
   - Click breadcrumb "Alignement / Roster" — returns to `alignement.html`.

3. Visit `coach.html?id=NOT-A-REAL-SLUG` — should redirect to `alignement.html`.

4. Visit `coach.html` (no `?id=`) — should redirect to `alignement.html`.

5. Visit any player profile (e.g., `joueur.html?id=1`) — scroll to footer. Confirm Galerie link is now present alongside FAQ.

6. Footer parity check on `alignement.html`: Navigation column now bilingual, contains Accueil, Calendrier, Alignement, Diffusion en direct, FAQ, Galerie.

---

## Rollback plan

Each change is in its own commit, so they revert independently.

### Full rollback (all 3 commits)

```bash
git revert <commit-3-sha> <commit-2-sha> <commit-1-sha> --no-edit
git push origin main
```

Cloudflare Pages auto-deploys the revert.

### Partial rollbacks

- **Coach bios broken on live but alignement is fine** → revert only the `coach.html` commit. The roster page will still link to `coach.html` (404 instead of redirect, since the file is gone). To prevent 404s, also revert the `alignement.html` commit, OR push a follow-up that wraps the click handler in a feature flag.

- **Want to keep coaches but undo footer fixes** → not recommended (the footers are net improvements), but possible: `git revert` only the `joueur.html` commit and use `git checkout HEAD~N -- alignement.html` to selectively restore the old footer block, then re-commit. This is more work than it's worth — the fixed footers are correct.

### Hard rollback (worst case — one of the commits broke the build)

If Cloudflare Pages reports a build failure:

```bash
git reset --hard <last-known-good-sha>
git push origin main --force-with-lease
```

`--force-with-lease` is safer than `--force`; it refuses to push if `origin/main` advanced since you fetched. Last known good SHA is whatever `origin/main` was before this directive ran (capture it in pre-flight Step 2).

### Cloudflare Pages instant rollback

If you don't want to touch git: in the Cloudflare dashboard → Pages → canonniers-website → Deployments, click "..." on the previous successful deployment → "Rollback to this deployment". This is the fastest revert path and doesn't require local git operations. Use this if a commit is bad and you need the site green in <60 seconds.

---

## Open questions for Claude Code (answer in the commit messages or surface back to Jay)

1. **Line endings.** The repo's existing files appear to use `\r\n` (CRLF) line endings on most pages and `\n` (LF) on a few (`galerie.html`, `alignement.html`). The `coach.html` and `alignement.html` payloads in this drop use LF. Confirm whether your environment normalizes line endings on commit (via `.gitattributes` or autocrlf). If a line-ending churn is going to flood the diff, normalize the new files to match the surrounding pages before committing — but do **not** change line endings on files you're not otherwise touching in this directive.

2. **`AAACanonLogo.png` path.** The payload uses `AAACanonLogo.png` (relative, repo-root) for both the header and footer logo, matching the existing pattern in `joueur.html` and `alignement.html`. Confirm this resolves on the deployed site and isn't `/AAACanonLogo.png` or `/assets/...` somewhere. If wrong, fix before commit.

3. **Existing `joueur.html` footer formatting.** The diff in Step 3 will look minimal in the GitHub diff view (one line added). Confirm no whitespace or indentation regressions in the surrounding lines.

4. **Skip Step 3 if Galerie is already there.** If the pre-flight check finds Galerie already in `joueur.html`'s footer, skip Step 3 entirely. Note the skip in the final summary back to Jay.

---

## Threat model — quick pass

- **Stored XSS via coach bio fields.** All bio fields go through `escapeHtml()` before rendering. Photo URLs go through `escapeHtml()` when interpolated into `src`/`alt`. Bilingual placeholders are static strings, not user input. No `innerHTML` accepts unescaped data. Risk: low. The `paragraphsToHtml()` helper escapes per-paragraph before wrapping in `<p>`.
- **DOM-based XSS via `?id=` URL param.** The `id` param is used as an object key lookup (`COACHES[id]`) and never written to the DOM. Unknown keys redirect to `alignement.html`. Risk: none.
- **Open redirect.** The unknown-slug branch redirects to a hardcoded relative path (`alignement.html`), not a URL-derived value. Risk: none.
- **Broken-link surface area increases.** Each new coach row is a clickable link. If a slug mismatch between `alignement.html` and `coach.html` slips past the slug parity check, users get a redirect loop back to alignement. The pre-flight slug parity diff catches this.
- **Privacy.** Real names of real people are now on the public site with bilingual placeholders. The names were already visible on the printable rosters (the source images), so this isn't new exposure. Bios, photos, and playing backgrounds are NOT in this drop — Jay fills them in only after coach consent.

---

## Summary back to Jay (post-deploy template)

When done, reply to Jay with a short summary using this template:

```
Deployed coach bios + schema fixes to canonniersdequebec.ca.

✓ alignement.html: 12 coaches rendered across 3 teams, click-through to coach.html
✓ coach.html: new bio page, 12 stubs with bilingual "Information à venir" placeholders
✓ alignement.html: footer aligned to canonical bilingual pattern (was unilingual French, missing FAQ + Galerie)
✓ joueur.html: Galerie added to footer nav (drift fix)

Commits: <sha1>, <sha2>, <sha3>
Live: https://canonniersdequebec.ca/alignement.html
Live coach example: https://canonniersdequebec.ca/coach.html?id=dave-dufour

Next: fill in COACHES object in coach.html with bio text per coach as content lands.
```

If a step was skipped (e.g., joueur.html footer already had Galerie), call that out instead of marking it ✓.
