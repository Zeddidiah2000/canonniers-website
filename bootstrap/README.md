# Bootstrap: Bulk Media-Day Photo Upload

One-time import of 306 media-day photos into the private photo library.

## Steps

### 1. Drop photos
Place all photos in `bootstrap/media-day-2026/`. Subfolders are fine — the script scans recursively.

### 2. Confirm gitignore
```bash
git status
```
Photo files must **NOT** appear. If they do, stop — the gitignore rule in `.gitignore` should prevent this.

### 3. Install sharp (thumbnail generator — local only, not committed)
```bash
npm install --no-save sharp
```

### 4. Set the bootstrap token on the worker

Generate a random token and store it temporarily:
```bash
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN"    # copy this value — you'll need it in step 5
```

Set it on the deployed worker:
```bash
cd workers/library
echo "$TOKEN" | wrangler secret put BOOTSTRAP_TOKEN
cd ../..
```

### 5. Run the upload
```bash
BOOTSTRAP_TOKEN=<paste-token-from-step-4> node bootstrap/upload-library-photos.js ./bootstrap/media-day-2026/
```

When the script starts it prints `Found N photos in ...`. **If N != 306, press Ctrl+C** and check the folder before proceeding.

### 6. Verify
```bash
npx wrangler d1 execute canonniers-db --remote --command="SELECT COUNT(*) FROM photo_library;"
# Expect: 306

npx wrangler r2 object list player-photos-library --prefix=library/ | wc -l
# Expect: ~612 (306 originals + 306 thumbs)
```

### 7. Remove bootstrap bypass — CRITICAL SECURITY STEP

Delete the secret:
```bash
cd workers/library
wrangler secret delete BOOTSTRAP_TOKEN
```

Remove the bootstrap bypass block from `workers/library/src/index.js` (the block between the two comments
`// ── Bootstrap one-time bypass` and the closing brace), then redeploy:
```bash
wrangler deploy
cd ../..
```

Commit the cleaned worker:
```bash
git add workers/library/src/index.js
git commit -m "feat(library): one-time bulk upload bootstrap

- 306 media-day photos imported as unsorted
- Bootstrap token deleted + bypass code removed post-upload"
```

### 8. Optional cleanup
```bash
git rm bootstrap/upload-library-photos.js bootstrap/README.md
git commit -m "chore(library): remove bootstrap scripts after one-time use"
```

---

## Rollback (if upload went wrong)
```bash
npx wrangler d1 execute canonniers-db --remote --command="DELETE FROM photo_library;"
# Then purge R2 objects manually via the Cloudflare dashboard (R2 → player-photos-library → delete all)
```
