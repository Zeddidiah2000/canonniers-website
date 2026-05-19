# Directive — "Résultat à venir" pill on past games

**Scope:** `calendrier.html` only. Display a sky-blue "Résultat à venir / Result pending" pill on game cards whose `startTime + 4 hours` is in the past. No D1, no worker, no admin tool. Single commit, fully reversible.

---

## Pre-flight

1. Fetch raw current state of the file from GitHub. Do **not** trust local copies:
   ```powershell
   curl.exe https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/calendrier.html -o calendrier.html.current
   ```
2. Confirm three anchor strings exist exactly once each (used as `old_str` for str_replace below):
   - `--green:      #15803d;`
   - `function fmtTime(g) {`
   - `<span class="meta-time">${time ? \`🕐 ${time}\` : ''}</span>`
3. If any anchor is missing or duplicated, **stop** and report. Do not proceed.

---

## Patch 1 — Add pill CSS

**Find** (in `:root` block, last line before `}`):
```
--green:      #15803d;
```

**Replace with:**
```
--green:      #15803d;
      --pending-bg:    #f0f4fa;
      --pending-bd:    #c9d7e8;
      --pending-dot:   #6ba8d9;
```

**Then find** (the `.spordle-link` block, line ~72):
```
.spordle-link { display: inline-flex; align-items: center; gap: 6px; font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gray); text-decoration: none; padding: 6px 12px; border: 1px solid var(--gray-light); border-radius: 3px; background: var(--white); transition: all 0.18s; }
```

**Insert immediately after that line:**
```
    .meta-pending { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; background: var(--pending-bg); border: 1px solid var(--pending-bd); color: var(--navy); font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    .meta-pending::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--pending-dot); }
```

---

## Patch 2 — Add `isPastGame()` helper

**Find:**
```
    function fmtTime(g) {
```

**Insert immediately before that line:**
```
    function isPastGame(g) {
      const raw = g.startTime || g.date;
      if (!raw) return false;
      const start = new Date(raw);
      if (isNaN(start)) return false;
      return (Date.now() - start.getTime()) > 4 * 60 * 60 * 1000;
    }

```

---

## Patch 3 — Conditional render in game card

**Find** the meta-row line in `renderGames()`:
```
                  <span class="meta-time">${time ? `🕐 ${time}` : ''}</span>
                  <span class="meta-location badge ${isHome ? 'badge-home' : 'badge-away'} fr-text">${isHome ? 'Domicile' : 'Visiteur'}</span>
                  <span class="meta-location badge ${isHome ? 'badge-home' : 'badge-away'} en-text">${isHome ? 'Home' : 'Away'}</span>
                  ${park.name ? mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener">📍 ${park.name}</a>` : `<span>📍 ${park.name}</span>` : ''}
```

**Replace with:**
```
                  ${isPastGame(g)
                    ? `<span class="meta-pending fr-text">Résultat à venir</span>
                       <span class="meta-pending en-text">Result pending</span>`
                    : `<span class="meta-time">${time ? `🕐 ${time}` : ''}</span>
                       <span class="meta-location badge ${isHome ? 'badge-home' : 'badge-away'} fr-text">${isHome ? 'Domicile' : 'Visiteur'}</span>
                       <span class="meta-location badge ${isHome ? 'badge-home' : 'badge-away'} en-text">${isHome ? 'Home' : 'Away'}</span>
                       ${park.name ? mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener">📍 ${park.name}</a>` : `<span>📍 ${park.name}</span>` : ''}`}
```

---

## Commit

Single commit, message:
```
calendrier: show "Résultat à venir" pill on past games

Games with startTime + 4h in the past now display a sky-blue pill
in place of time/home-away/venue. Bilingual (FR/EN). Right-side
home/away badge column unchanged. iCal feed unchanged.
```

---

## Post-deploy verification

After Cloudflare Pages deploys (~1 min from push):

1. Visit `https://canonniersdequebec.ca/calendrier.html`.
2. Click the **17U D2** tab — known past games on 2026-05-14 and 2026-05-16.
3. Confirm:
   - May 14 games: pill visible, no time/venue/Home-Away in meta row.
   - Future games (May 21+): unchanged, still show time/venue/Home-Away.
   - Right-side `AWAY`/`HOME` badge column still shows on all games.
4. Toggle EN language: pill text switches to "Result pending".
5. View page source briefly to confirm no console errors.
6. Click **DOWNLOAD .ICS** — open the file, confirm event SUMMARY lines are unchanged (no "Résultat à venir" in titles).

---

## Open questions for Claude Code

None. If any anchor string fails to match exactly, stop and report — do not improvise.

---

## Rollback

```powershell
git revert HEAD
git push origin main
```

That's it. Single commit, additive change, no schema, no worker, no dependencies. Revert restores prior state in ~60 sec.
