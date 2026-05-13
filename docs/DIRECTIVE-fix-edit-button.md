# Directive: Fix broken Edit button in Roster Editor

**Target file:** `EditRoster/index.html` (or wherever the roster editor `index.html` lives — NOT the homepage `index.html`)

**Repo:** `canonniers-website`, branch: `main`

---

## Symptom (reported by Jay)

After editing a player at least once, clicking the "Éditer / Edit" button on that player's row no longer scrolls the form to the top and populates it with the player's data. The button appears clickable but does nothing. New / unedited players may still work. Live site: canonniersdequebec.ca.

---

## Hypothesis (verify before fixing)

The row template at approximately **line 684** uses:

```html
onclick='editPlayer(${JSON.stringify(p)})'
```

`JSON.stringify(p)` produces a string containing double quotes. It is injected into a single-quoted `onclick` attribute. As soon as any field on the player object contains a character that breaks the attribute string — most likely an **apostrophe** (`O'Brien`, `L'Ancienne-Lorette`, `L'Île-Bizard`), a backslash, `</`, or an unescaped `&` — the HTML attribute terminates early, the `onclick` becomes invalid, and the browser silently drops the handler. Click is dead.

This explains "after editing": the freshly saved value re-renders into the row with the breaking character that wasn't in the original seed data, or the editor introduces it.

---

## Required pre-flight verification

**Do not start patching until you have done all of these:**

1. **Read the entire file**, not just the section around line 684. The fix touches:
   - The row template inside `renderPlayers` (or whatever the render function is called)
   - The `loadPlayers` function (need to know where the player list array is created/assigned)
   - The top of the `<script>` block (need to know existing module-scope variables and naming conventions)
   - The `editPlayer` and `openDeleteModal` function signatures (confirm they match what the patch below assumes)

2. **Confirm the bug class** by inspecting actual data. Look at the live API response from `/api/players` (or whatever the endpoint is — find it in the file) for any player with an apostrophe in `name`, `hometown`, or any other string field. If you cannot reach the API, search the codebase for known player names that contain `'` or accented characters that could be HTML-problematic.

3. **Confirm there isn't a different root cause** that the symptom also fits, including but not limited to:
   - An event listener attached once to a tbody that gets replaced wholesale on re-render (re-render-without-rebind)
   - A guard inside `editPlayer` that bails when `player-id` is already populated
   - A `form.reset()` call that clears `player-id` after `editPlayer` runs but before the user sees the form
   - Stale state in a module-scope `currentEditId` variable
   - CSS putting the form off-screen so the smooth scroll appears to do nothing

   If the actual cause is one of these and not the inline-onclick injection bug, **stop and tell Jay** — do not apply the patch below blindly.

4. **Confirm where on disk the file lives** in the local UPDATE directory before editing.

---

## Proposed patch (apply only if pre-flight confirms the hypothesis)

The fix replaces inline `onclick='...JSON.stringify(p)...'` with `data-id` attributes plus event delegation, and HTML-escapes all rendered player fields.

### 1. Add a module-scope cache

Near the top of the `<script>` block, alongside existing state variables (e.g. `currentSort`, `deleteId`), add:

```javascript
let playersCache = [];
```

### 2. Add an HTML-escape helper

Anywhere in the `<script>` block:

```javascript
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

### 3. Populate the cache when player data is loaded

In `loadPlayers` (or whatever the data-fetch function is named), wherever the fetched player array is assigned to a local `list` (or equivalent) before being passed to render, also assign it to the cache:

```javascript
playersCache = list;
```

This must run **after** the fetch resolves and **before** the render call.

### 4. Replace the row template

In the render function, replace the existing `tr.innerHTML = \`...\`` block (around lines 677–691) with:

```javascript
tr.innerHTML = `
  <td><img src="${photoUrl}" class="player-photo" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22></svg>'"></td>
  <td>${escapeHtml(p.number || '—')}</td>
  <td style="font-weight: 700;">${escapeHtml(p.name)}</td>
  <td>${escapeHtml(p.position || '—')}</td>
  <td><span style="font-size: 10px; background: rgba(106,176,212,0.2); padding: 2px 6px; border-radius: 3px;">${escapeHtml(p.team_category.toUpperCase())}</span></td>
  <td class="actions">
    <button class="btn-ghost edit-btn" data-id="${p.id}" style="color: var(--sky); border: 1px solid var(--border); background: none; padding: 4px 8px; border-radius: 3px; cursor: pointer;">
      <span class="fr-text">Éditer</span><span class="en-text">Edit</span>
    </button>
    <button class="btn-danger delete-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}">
      <span class="fr-text">Suppr.</span><span class="en-text">Del</span>
    </button>
  </td>
`;
```

Note: `photoUrl` keeps its existing construction. Do not escape it as HTML — it's a URL going into a `src` attribute and the existing code already controls its origin.

### 5. Bind clicks via delegation, once

Immediately after the `list.forEach` loop closes (after the row append loop in the render function), add:

```javascript
const body = document.getElementById('roster-body');
body.onclick = (e) => {
  const editBtn = e.target.closest('.edit-btn');
  const delBtn = e.target.closest('.delete-btn');
  if (editBtn) {
    const p = playersCache.find(x => String(x.id) === editBtn.dataset.id);
    if (p) editPlayer(p);
  } else if (delBtn) {
    openDeleteModal(Number(delBtn.dataset.id), delBtn.dataset.name);
  }
};
```

If `body` is already declared earlier in the same function, do not re-declare — reuse the existing reference.

`body.onclick = ...` clobbers any prior handler. If something else in the file is already listening on `#roster-body`, use `addEventListener` instead and ensure idempotency (set a flag like `body.dataset.bound === '1'` before adding).

---

## Verification after patching

1. Hard refresh (Ctrl+Shift+R) the live admin page after Cloudflare Pages deploys.
2. Open DevTools console — confirm no errors on page load.
3. Edit a player whose name/hometown contains an apostrophe (or temporarily edit one to add `O'Test`). Save. Confirm the Edit button on that row still scrolls to top and populates the form.
4. Edit the same player twice in a row. Confirm Edit still works the second time.
5. Confirm Delete still works (the openDeleteModal call signature is preserved).
6. Confirm the form's Save button label flips correctly between "Enregistrer le joueur / Save Player" and "Mettre à jour / Update".

---

## Open questions for Claude Code

If anything below is unclear from the file contents, **ask Jay before guessing:**

- Does `loadPlayers` already use a variable named `list`, or something else? Adapt the cache assignment accordingly.
- Is there an existing module-scope variable already serving the role of `playersCache`? If so, reuse it instead of adding a duplicate.
- Are there other inline `onclick='...JSON.stringify(...)...'` patterns elsewhere in the file (e.g. on stat-drawer rows, position assignments, etc.)? If yes, flag them — they have the same latent bug and should be fixed in the same PR.
- Does the project have any existing escape/sanitize utility (e.g. in a shared `<script>` import)? Prefer reusing it over adding `escapeHtml` if one exists.

If during reading you find a different, more likely root cause than the inline-onclick injection bug, **stop and report it.** Do not apply this patch on top of a different bug.

---

## Commit message (suggested)

```
fix(admin/roster): edit button silently breaks on players with apostrophes

Replace inline onclick='editPlayer(${JSON.stringify(p)})' with data-id +
event delegation. JSON.stringify in a single-quoted attribute breaks as
soon as any field contains an apostrophe (O'Brien, L'Ancienne-Lorette),
a backslash, or </, dropping the click handler. HTML-escape all rendered
player fields. Closes the secondary stored-XSS sink in the same path.
```
