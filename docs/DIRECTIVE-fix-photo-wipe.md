# Directive: Fix photo-wipe bug — convert PUT handler to partial updates

**Target:** Cloudflare Worker source — `src/index.js` in the `canonniers-website` repo
**Worker:** `canonniers-roster-worker`
**Scope:** Worker-only change. No HTML, no schema, no Pages deploy. Just `wrangler deploy`.

---

## Symptom (reported by Jay)

When editing a player who already has a photo, if Jay updates any field (position, height, etc.) without uploading a new photo, **the existing photo gets wiped** on save. The player then displays with no photo on `alignement.html`.

---

## Root cause

The client (`EditRoster/index.html`, `savePlayer` function around line 750) deliberately **omits** `photo_url` from the JSON payload when no new photo is uploaded:

```javascript
const payload = { name, number, position, bats_throws, height_inches, weight, birthdate, hometown, team_category };
if (photo_url) payload.photo_url = photo_url;  // only added if a new photo was uploaded
```

This is the correct "don't send the field, don't update it" pattern.

The worker's PUT handler defeats this by destructuring **every** field from the payload and writing it to the row, defaulting missing fields to `null`:

```javascript
const { name, number, position, bats_throws, height, weight, photo_url, team_category, ... } = data;
await env.DB.prepare(
  'UPDATE players SET name=?, ..., photo_url=?, ... WHERE id=?'
).bind(name || null, ..., photo_url || null, ...).run();
```

When the client omits `photo_url`, `data.photo_url === undefined`. Then `undefined || null === null`. The worker writes `photo_url = NULL` to D1, wiping the existing photo.

**This is a class bug, not a one-off.** The same pattern affects every other field in the PUT handler. It's also why the legacy `height` column (which we kept as a rollback safety net) gets wiped to NULL the moment anyone re-saves Noah Chisholm.

---

## Fix — convert PUT to a true partial update

Build the UPDATE statement dynamically from only the fields the client actually sent. Use an allow-list to prevent writing to columns that don't exist or shouldn't be writable.

### Pre-flight verification

1. **Read the current `src/index.js`** end-to-end. Confirm the PUT handler matches the structure described above. If it has been modified since the last commit, stop and report.
2. **Confirm the column allow-list matches the actual D1 schema.** Run `npx wrangler d1 execute canonniers-db --command="PRAGMA table_info(players);" --remote` to list the actual columns. The `allowed` array in the patch below must match exactly. If columns differ from what's listed, stop and ask.
3. **Confirm the POST handler does NOT need this change.** POST is for creating new players. Missing fields on create should default to NULL (current behavior). Only PUT semantics change.

### Patch — replace the PUT handler

Find the existing PUT block (currently around line 95–106 of the post-validation `src/index.js`):

```javascript
if (path.startsWith('/api/players/') && request.method === 'PUT') {
  const id = path.split('/').pop();
  const data = await request.json();
  const err = validatePlayer(data);
  if (err) return new Response(JSON.stringify({ error: err }), {
    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });

  const { name, number, position, bats_throws, height, weight, photo_url, team_category, stats_json, birthdate, hometown, height_inches } = data;
  await env.DB.prepare(
    'UPDATE players SET name=?, number=?, position=?, bats_throws=?, height=?, weight=?, photo_url=?, team_category=?, stats_json=?, birthdate=?, hometown=?, height_inches=? WHERE id=?'
  ).bind(name || null, number || null, position || null, bats_throws || null, height || null, weight || null, photo_url || null, team_category || null, stats_json || null, birthdate || null, hometown || null, height_inches ?? null, id).run();
  return new Response('OK', { headers: corsHeaders });
}
```

Replace it with:

```javascript
if (path.startsWith('/api/players/') && request.method === 'PUT') {
  const id = path.split('/').pop();
  const data = await request.json();
  const err = validatePlayer(data);
  if (err) return new Response(JSON.stringify({ error: err }), {
    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });

  // Partial update: only update fields the client actually sent.
  // Empty string is treated as "clear this field" (-> NULL in D1).
  // Undefined / missing key means "leave this column alone".
  const allowed = [
    'name', 'number', 'position', 'bats_throws', 'height', 'weight',
    'photo_url', 'team_category', 'stats_json', 'birthdate', 'hometown',
    'height_inches'
  ];

  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key}=?`);
      // Convert empty string to null. Preserve 0 for numeric fields.
      const v = data[key];
      values.push(v === '' ? null : v);
    }
  }

  if (fields.length === 0) {
    return new Response(JSON.stringify({ error: 'No fields to update' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  values.push(id);
  await env.DB.prepare(
    `UPDATE players SET ${fields.join(', ')} WHERE id=?`
  ).bind(...values).run();

  return new Response('OK', { headers: corsHeaders });
}
```

### Do NOT change the POST handler

POST creates new rows. Missing fields should still default to NULL there. Leave it alone.

---

## Security notes

- The `allowed` array is the authorization boundary. Any field name not in this list is silently ignored. This prevents a malicious payload from writing to arbitrary columns (e.g. `id`, or future columns like `is_admin` if anyone ever adds one).
- The dynamic SQL is **safe from injection** because field names come from a hardcoded allow-list (never from user input) and values are bound with `?` placeholders. Do not concatenate user input into the SQL string at any point.
- `validatePlayer(data)` still runs on the full payload before the update. All existing validation (B/T enum, weight range, position codes, height range, birthdate format) still applies to whatever fields are present.

---

## Verification after deploy

1. **Deploy the worker:**
   ```
   npx wrangler deploy
   ```

2. **Test the photo persistence (the original bug):**
   - In `EditRoster`, click Edit on a player who has a photo (e.g. Noah).
   - Change one field (position, height, anything except photo).
   - Save without uploading a new photo.
   - Reload `alignement.html`. **Photo must still be there.**
   - Repeat with at least one other player who has a photo, to confirm it's not specific to one row.

3. **Test that photo updates still work:**
   - Edit a player. Upload a new photo. Save.
   - Confirm the new photo appears on `alignement.html`.

4. **Test legacy-column protection (the secondary bug):**
   - In D1, before testing: `SELECT id, name, height, height_inches FROM players WHERE id = 4;` — confirm Noah has both `height = '5'11"'` and `height_inches = 71`.
   - In `EditRoster`, edit Noah, change something trivial (e.g. add a position), save.
   - Re-run the SELECT. **`height` must still be `5'11"`** (the legacy column should no longer get wiped).

5. **Test that explicit field-clearing still works:**
   - Edit a player who has a hometown. Open DevTools, set `document.getElementById('p-hometown').value = ''`. Save.
   - Confirm `hometown` is now NULL in D1. (This proves empty-string-clears-field still functions.)

6. **Test validation still works:**
   - In DevTools, modify the position hidden input to `INVALID` and submit.
   - Confirm a 400 response with the validation error toast.

7. **Test that an empty payload is rejected:**
   - In DevTools console: `fetch('https://canonniers-roster-worker.chisholm2000.workers.dev/api/players/4', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer canonniers2026' }, body: '{}' }).then(r => r.json()).then(console.log)`
   - Expect `{ error: 'No fields to update' }` with status 400.

If any verification step fails, **stop and report.** Do not patch around a failure without diagnosing the cause.

---

## Rollback

If the deploy goes wrong: Cloudflare Dashboard → Workers → `canonniers-roster-worker` → Deployments → click "Rollback" on the previous deployment. Takes 30 seconds.

---

## Open questions for Claude Code

- Are there any consumers of the PUT endpoint other than `EditRoster/index.html`? If yes, they may have been relying on the old "send everything, missing = NULL" behavior. Check `admin.html`, `alignement.html`, and any other file that does a PUT to `/api/players/`. If any other consumer exists, flag it before deploying.
- Does `validatePlayer` need to handle the new partial-update case where some fields are absent? Re-read it — fields that aren't present in `data` should naturally pass validation (the function destructures them as `undefined` and the existing checks all gate on `!= null && !== ''`). Confirm this is true; if any check fires on `undefined`, fix it.

---

## Commit message (suggested)

```
fix(worker): PUT now does true partial updates instead of overwriting all fields

Previous PUT handler destructured every field from the payload and wrote
it to the row, defaulting missing fields to NULL. This silently wiped
photo_url on every edit that didn't include a new photo upload, and
similarly nulled the legacy height TEXT column on edits to players
who'd been migrated to height_inches.

Replace with a dynamic UPDATE built from an allow-list of fields the
client actually sent. Empty string still clears a field (sets NULL),
but a missing key now leaves the column untouched. POST handler is
unchanged — new rows still default missing fields to NULL.

Allow-list is the authorization boundary for which columns are writable.
SQL injection-safe: field names come only from the hardcoded list,
values are still parameterized.
```
