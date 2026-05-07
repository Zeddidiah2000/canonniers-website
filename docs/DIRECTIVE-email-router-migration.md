# Directive: Migrate Cloudflare Email Routing to Email Worker

**Date:** 2026-05-07
**Author:** Jay (designed in Claude chat, executed by Claude Code)
**Target repo:** `Zeddidiah2000/canonniers-website` (`main` branch)
**Estimated commits:** 3
**Risk level:** Medium (touches live email routing; rollback plan documented)
**Live impact:** Seamless to volunteers — no behavior change visible to end users during cutover

---

## Why we're doing this

The current Email Routing setup uses 16 per-alias rules managed by a PowerShell script (`scripts/email-routing/canonniers-email-routing.ps1`) running hourly via GitHub Actions. This model has three problems:

1. **Cannot fan out one alias to multiple recipients.** Cloudflare Email Routing's API silently fails (or partially delivers) when a single `forward` action contains multiple addresses in its `value` array. We hit this on 2026-05-06 and patched the script to forward to volunteer-only, dropping the Jay-CC pattern. But `social15u@canonniers.ca` now has TWO verified volunteers (`manulavoie08@hotmail.com` and `c_apple60@hotmail.com`) — there's no way to deliver mail to both with the current rule-based model.

2. **The PowerShell script depends on undocumented API behavior.** The Phase 2 update writes rule actions in shapes Cloudflare's UI doesn't expose. Could break on future API changes with no warning.

3. **Two-phase verification + update flow is brittle.** Phase 1 creates destinations and waits for verification clicks; Phase 2 updates rules. State drift between Cloudflare and the script's view causes silent inconsistencies.

**Solution:** Replace per-alias rules with a single Cloudflare Email Worker that routes inbound mail using a JSON config file in the repo. One rule (catch-all → Worker), one source of truth (`routes.json`), one deploy mechanism (push to main). Multi-recipient routing becomes trivial.

**Trade-off accepted:** Worker uses `message.forward()` which goes through Cloudflare's same outbound IPs that Outlook periodically blocks. This migration does NOT fix the Outlook deliverability problem for Hotmail volunteers. That's a separate problem solved by adding Resend (or similar) as a sender — deferred to a future directive once this migration is stable.

---

## Pre-flight verification

**MANDATORY.** Do not skip these steps. They confirm the current state is what we think it is.

### 1. Confirm git state

```bash
cd /path/to/repo-working
git status                     # Working tree must be clean
git checkout main
git pull origin main           # Must be up to date with origin/main
git log -1 --format='%H %s'    # Note the commit hash for rollback reference
```

If working tree is not clean, STOP and ask Jay how to proceed.

### 2. Confirm token is available

Jay will paste the `EMAIL_FIX` Cloudflare API token into the terminal. Token will have full account access. Use it for this session only — DO NOT write it to any file in the repo. Set it as an environment variable:

```bash
export CF_API_TOKEN="<paste from Jay>"
```

Verify the token works and has the scopes we need:

```bash
curl -s -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CF_API_TOKEN"
```

Expected: `"status":"active"`. If anything else, stop and report to Jay.

### 3. Look up account ID and zone ID

```bash
# Account ID
curl -s "https://api.cloudflare.com/client/v4/accounts" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result[] | {id,name}'

# Zone ID for canonniers.ca
curl -s "https://api.cloudflare.com/client/v4/zones?name=canonniers.ca" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result[] | {id,name}'
```

Save these as shell variables:

```bash
export CF_ACCOUNT_ID="<account id from above>"
export CF_ZONE_ID="<zone id for canonniers.ca>"
```

### 4. Confirm wrangler is installed and working

```bash
cd /path/to/repo-working
npx wrangler --version         # Should print 4.88.0 or later
```

### 5. Authenticate wrangler with the token

```bash
export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
npx wrangler whoami
```

Expected: `wrangler` reports the account associated with the token. If it fails, stop.

### 6. Capture current routing state to backup

This is the rollback artifact. Even before any changes, save it:

```bash
mkdir -p backups
DATE=$(date +%Y-%m-%d-%H%M%S)
BACKUP_FILE="backups/email-routing-state-pre-worker-${DATE}.json"

curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer $CF_API_TOKEN" > "$BACKUP_FILE"

# Verify it's valid JSON and has rules
jq '.result | length' "$BACKUP_FILE"
```

Expected: number of rules (~16). If 0 or the file isn't valid JSON, stop. Do NOT commit the backup yet — it's a local file only at this stage.

### 7. Capture and confirm the current routing table

Run this to extract the live routing into a JSON map. Compare against the "Current live state" from the investigation report below. **If anything differs, STOP and ask Jay before continuing** — the investigation may have been stale.

```bash
jq -r '.result[] | select(.enabled == true) |
  {
    alias: (.matchers[] | select(.field == "to") | .value),
    destinations: [.actions[] | select(.type == "forward") | .value[]]
  }' "$BACKUP_FILE" | jq -s 'map({(.alias): .destinations}) | add'
```

**Expected current live state** (from investigation, 2026-05-06):

```json
{
  "contact@canonniers.ca":      ["chisholm2000@gmail.com"],
  "treasurer15u@canonniers.ca": ["chisholm2000@gmail.com"],
  "treasurer17d1@canonniers.ca":["chisholm2000@gmail.com"],
  "treasurer17d2@canonniers.ca":["chisholm2000@gmail.com"],
  "coach15u@canonniers.ca":     ["ddufour@canonniersdequebec.com"],
  "coach17d1@canonniers.ca":    ["chisholm2000@gmail.com"],
  "coach17d2@canonniers.ca":    ["chisholm2000@gmail.com"],
  "manager15u@canonniers.ca":   ["chisholm2000@gmail.com"],
  "manager17d1@canonniers.ca":  ["carlbis@hotmail.com"],
  "manager17d2@canonniers.ca":  ["all_68@hotmail.com"],
  "social15u@canonniers.ca":    ["chisholm2000@gmail.com"],
  "social17d1@canonniers.ca":   ["chisholm2000@gmail.com"],
  "social17d2@canonniers.ca":   ["myriamgagne17@hotmail.com"],
  "photo15u@canonniers.ca":     ["chisholm2000@gmail.com"],
  "photo17d1@canonniers.ca":    ["dianeracine15@gmail.com"],
  "photo17d2@canonniers.ca":    ["chisholm2000@gmail.com"]
}
```

Note: `info@` and `jay@` may also appear in the actual rules. If they do, include them in `routes.json` (commit 1) — both should forward to `chisholm2000@gmail.com`. **Ask Jay if any other aliases appear that aren't in this list.**

### 8. Capture catch-all configuration

```bash
curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules/catch_all" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq
```

Save this output too — it's part of the rollback state. Note the current catch-all action; we'll be replacing it.

---

## Commit 1: Build the Worker (no live impact)

Goal: Worker exists, deploys cleanly, but **does not yet receive live mail**. Per-alias rules continue to handle mail. This commit can be reverted with zero impact on live email.

### Files to create

#### `workers/canonniers-email-router/wrangler.toml`

```toml
name = "canonniers-email-router"
main = "src/index.js"
compatibility_date = "2026-05-07"
account_id = "<CF_ACCOUNT_ID from pre-flight>"

# No KV, no D1, no secrets needed.
# routes.json is bundled into the worker at deploy time.
```

Use the actual account ID from pre-flight. Do NOT use a placeholder.

#### `workers/canonniers-email-router/package.json`

```json
{
  "name": "canonniers-email-router",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev"
  },
  "devDependencies": {
    "wrangler": "^4.88.0"
  }
}
```

#### `workers/canonniers-email-router/src/routes.json`

Use the **current live state** from pre-flight step 7. NOT the intended final state. We are migrating the substrate, not the data. Volunteer onboarding to real destinations happens later by editing this file.

If `info@` and `jay@` were found in pre-flight, include them. Example:

```json
{
  "_comment": "Source of truth for canonniers.ca email routing. Edit + commit + push to main to deploy. See README.md.",
  "_fallback": ["chisholm2000@gmail.com"],
  "info@canonniers.ca":         ["chisholm2000@gmail.com"],
  "jay@canonniers.ca":          ["chisholm2000@gmail.com"],
  "contact@canonniers.ca":      ["chisholm2000@gmail.com"],
  "treasurer15u@canonniers.ca": ["chisholm2000@gmail.com"],
  "treasurer17d1@canonniers.ca":["chisholm2000@gmail.com"],
  "treasurer17d2@canonniers.ca":["chisholm2000@gmail.com"],
  "coach15u@canonniers.ca":     ["ddufour@canonniersdequebec.com"],
  "coach17d1@canonniers.ca":    ["chisholm2000@gmail.com"],
  "coach17d2@canonniers.ca":    ["chisholm2000@gmail.com"],
  "manager15u@canonniers.ca":   ["chisholm2000@gmail.com"],
  "manager17d1@canonniers.ca":  ["carlbis@hotmail.com"],
  "manager17d2@canonniers.ca":  ["all_68@hotmail.com"],
  "social15u@canonniers.ca":    ["chisholm2000@gmail.com"],
  "social17d1@canonniers.ca":   ["chisholm2000@gmail.com"],
  "social17d2@canonniers.ca":   ["myriamgagne17@hotmail.com"],
  "photo15u@canonniers.ca":     ["chisholm2000@gmail.com"],
  "photo17d1@canonniers.ca":    ["dianeracine15@gmail.com"],
  "photo17d2@canonniers.ca":    ["chisholm2000@gmail.com"]
}
```

Note `_fallback` — used when an alias isn't recognized. Per Jay's decision, this stays as `chisholm2000@gmail.com` (catch unknown aliases, surface them to Jay rather than dropping or rejecting).

#### `workers/canonniers-email-router/src/index.js`

```javascript
import routes from "./routes.json";

/**
 * Cloudflare Email Worker — routing for @canonniers.ca
 *
 * Receives all mail to canonniers.ca via the catch-all rule, looks up the
 * destination(s) in routes.json, and forwards to each. Unknown aliases
 * fall through to _fallback.
 *
 * Deploys via .github/workflows/deploy-email-router.yml on push to main.
 *
 * Source of truth for routing: src/routes.json. Edit + commit to update.
 */

// Hardcoded safety fallback. Used only if routes.json is somehow malformed
// or _fallback key is missing. Never silently drop mail.
const HARDCODED_FALLBACK = "chisholm2000@gmail.com";

export default {
  async email(message, env, ctx) {
    const to = (message.to || "").toLowerCase().trim();

    let destinations;
    try {
      destinations = routes[to];
      if (!destinations || !Array.isArray(destinations) || destinations.length === 0) {
        destinations = routes._fallback;
      }
      if (!destinations || !Array.isArray(destinations) || destinations.length === 0) {
        destinations = [HARDCODED_FALLBACK];
      }
    } catch (err) {
      console.error(`[email-router] routes lookup failed for ${to}:`, err);
      destinations = [HARDCODED_FALLBACK];
    }

    console.log(`[email-router] ${to} -> ${destinations.join(", ")}`);

    // Use Promise.allSettled so one failed forward (e.g. Outlook block on
    // a Hotmail destination) doesn't kill delivery to the others.
    const results = await Promise.allSettled(
      destinations.map((dest) => message.forward(dest))
    );

    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(
          `[email-router] forward to ${destinations[i]} for ${to} failed:`,
          result.reason
        );
      }
    });

    // Note: we do NOT call message.setReject() on partial failures.
    // Cloudflare's mail pipeline expects the worker to either forward, drop,
    // or reject the inbound message. We treat "at least one forward attempted"
    // as success at the worker level. Failed individual forwards are logged.
  }
};
```

#### `workers/canonniers-email-router/README.md`

```markdown
# canonniers-email-router

Cloudflare Email Worker that handles all inbound mail to `@canonniers.ca`.
Replaces the previous per-alias rule + PowerShell-script model.

## How to update routing

1. Edit `src/routes.json` — add/remove aliases or change destinations.
2. Multi-recipient: pass an array with multiple addresses.
3. Commit and push to `main`. GitHub Actions deploys automatically.
4. Changes are live within ~30 seconds of deploy.

## routes.json format

- Top-level keys: full email aliases (`coach17d1@canonniers.ca`)
- Values: arrays of destination email addresses
- `_fallback` (special key): destinations used when alias isn't recognized
- `_comment` (special key, ignored): for human notes

## Adding a new volunteer

The destination email must be verified in Cloudflare first. Either:

- Add it via the Cloudflare dashboard (Email Routing → Destination addresses)
  and click the verify link sent to that address.
- Or use the existing `scripts/email-routing/canonniers-email-routing.ps1 -Phase 1`
  (deprecated but still functional for verification only).

Once verified, edit `routes.json`, commit, push.

## Deployment

GitHub Actions: `.github/workflows/deploy-email-router.yml`. Triggers on
push to `main` when files under `workers/canonniers-email-router/**` change.

Manual deploy:
```bash
cd workers/canonniers-email-router
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
```

## Rollback

If the worker breaks routing, immediate rollback:

1. In Cloudflare dashboard → Email Routing → Rules, change the catch-all
   action back to `Send to an email` → `chisholm2000@gmail.com`.
2. All inbound mail goes to Jay until the worker is fixed.

For full rollback to per-alias rules, see
`backups/email-routing-state-pre-worker-*.json` and the rollback procedure
documented in the migration directive (DIRECTIVE-email-router-migration.md).
```

#### `.github/workflows/deploy-email-router.yml`

```yaml
name: Deploy Email Router Worker

on:
  push:
    branches: [main]
    paths:
      - 'workers/canonniers-email-router/**'
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Validate routes.json
        run: |
          cd workers/canonniers-email-router
          node -e "
            const r = require('./src/routes.json');
            const errors = [];
            for (const [alias, dests] of Object.entries(r)) {
              if (alias.startsWith('_')) continue;
              if (!alias.includes('@canonniers.ca')) {
                errors.push('Bad alias (must end @canonniers.ca): ' + alias);
              }
              if (!Array.isArray(dests) || dests.length === 0) {
                errors.push('Bad destinations (must be non-empty array): ' + alias);
                continue;
              }
              dests.forEach(d => {
                if (typeof d !== 'string' || !d.includes('@')) {
                  errors.push('Bad destination email: ' + alias + ' -> ' + d);
                }
              });
            }
            if (!Array.isArray(r._fallback) || r._fallback.length === 0) {
              errors.push('_fallback must be a non-empty array');
            }
            if (errors.length) {
              console.error('routes.json validation failed:');
              errors.forEach(e => console.error('  - ' + e));
              process.exit(1);
            }
            console.log('routes.json valid:', Object.keys(r).filter(k => !k.startsWith('_')).length, 'aliases');
          "

      - name: Install dependencies
        run: |
          cd workers/canonniers-email-router
          npm install

      - name: Deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_EMAIL_FIX }}
        run: |
          cd workers/canonniers-email-router
          npx wrangler deploy
```

**Note on `CF_EMAIL_FIX` secret:** This secret will be deleted in 3 days when Jay revokes the EMAIL_FIX token. After that, this workflow will fail until either (a) the token is recreated, or (b) the workflow is updated to use a different secret. This is acceptable — Jay will deploy `routes.json` changes manually via `wrangler deploy` from his laptop in the interim. Document this in the README of the worker (already done above) and in commit message.

### Commit 1 actions

```bash
# Add the secret first (or Jay does this manually in GitHub)
# Repo → Settings → Secrets and variables → Actions → New repository secret
# Name: CF_EMAIL_FIX
# Value: <the EMAIL_FIX token>

git checkout -b feat/email-router-worker
mkdir -p workers/canonniers-email-router/src
# ... create all files above ...
mkdir -p .github/workflows
# ... create deploy-email-router.yml ...

git add workers/canonniers-email-router/
git add .github/workflows/deploy-email-router.yml
git commit -m "feat(email): add canonniers-email-router worker (not yet wired)

Adds Cloudflare Email Worker that will replace the per-alias rule + PowerShell
script model. Worker is deployed but NOT yet attached to inbound mail — current
per-alias rules continue to handle routing.

routes.json mirrors current live state from email-routing rules. Future
volunteer routing changes happen by editing routes.json + commit + push.

Cutover happens in commit 2 (catch-all → worker, delete per-alias rules).
PowerShell script deprecation in commit 3.

Note: GH Actions deploy uses CF_EMAIL_FIX token (Jay-provisioned, 3-day TTL).
After token expiry, manual deploy via 'wrangler deploy' from laptop is required
until a permanent token is provisioned. This is intentional for now."

git push origin feat/email-router-worker
```

Then merge to `main` (PR or direct push, Jay's call). The deploy workflow runs and the worker is live in Cloudflare's worker registry — but not handling email yet.

### Commit 1 verification

After deploy:

```bash
# Worker exists in Cloudflare
curl -s "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result[] | select(.id == "canonniers-email-router")'
```

Expected: returns a script object with id `canonniers-email-router`.

```bash
# Email Routing rules unchanged — still 16 per-alias rules active
curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result | length'
```

Expected: 16 (or whatever the current count is — should match pre-flight).

**Send a real test email to `info@canonniers.ca`** from a non-canonniers address. Confirm it arrives at `chisholm2000@gmail.com`. This proves nothing has broken — old rules still working.

If the worker doesn't appear in Cloudflare, or test mail to `info@` doesn't arrive, **STOP** and ask Jay before proceeding to commit 2.

---

## Commit 2: Cutover (live impact, reversible)

**This is the moment of truth.** After this commit, the Worker handles all inbound mail. Old rules are deleted.

### Pre-cutover checks

1. Confirm the worker is deployed (commit 1 verification passed).
2. Confirm `backups/email-routing-state-pre-worker-*.json` exists and has the rules.
3. Confirm `backups/email-routing-catch-all-pre-worker-*.json` exists with the current catch-all state.
4. Confirm Jay is available for the next 30 minutes in case of issues.

### Cutover script

Create a one-shot script at `scripts/email-routing/cutover-to-worker.sh`. **This script is NOT committed yet** — it runs locally during cutover, then gets committed as a record of what was done.

```bash
#!/bin/bash
set -euo pipefail

# Pre-flight
: "${CF_API_TOKEN:?CF_API_TOKEN must be set}"
: "${CF_ZONE_ID:?CF_ZONE_ID must be set}"
: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID must be set}"

WORKER_NAME="canonniers-email-router"
DATE=$(date +%Y-%m-%d-%H%M%S)
BACKUP_DIR="backups"
mkdir -p "$BACKUP_DIR"

echo "==> Step 1: Final backup of current routing rules"
curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  > "${BACKUP_DIR}/email-routing-rules-cutover-${DATE}.json"

curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules/catch_all" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  > "${BACKUP_DIR}/email-routing-catch-all-cutover-${DATE}.json"

echo "==> Step 2: Set catch-all to worker"
# The catch-all rule must have action type 'worker' with the worker name as value
RESPONSE=$(curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules/catch_all" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"enabled\": true,
    \"name\": \"Catch-all to email-router worker\",
    \"matchers\": [{\"type\": \"all\"}],
    \"actions\": [{\"type\": \"worker\", \"value\": [\"${WORKER_NAME}\"]}]
  }")

echo "$RESPONSE" | jq
SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
if [ "$SUCCESS" != "true" ]; then
  echo "ERROR: catch-all update failed. NOT proceeding to delete rules."
  echo "Response: $RESPONSE"
  exit 1
fi

echo "==> Step 3: Verify catch-all is pointing at worker"
sleep 2
curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules/catch_all" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq

echo ""
echo "==> Step 4: Sending test email reminder"
echo "Send a test email NOW to info@canonniers.ca from an external address."
echo "Confirm delivery to chisholm2000@gmail.com before continuing."
echo ""
read -p "Did the test email arrive? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "ABORTING. Reverting catch-all to previous state."
  PREV_CATCH_ALL=$(cat "${BACKUP_DIR}/email-routing-catch-all-cutover-${DATE}.json" | jq '.result | {enabled, name, matchers, actions}')
  curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules/catch_all" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PREV_CATCH_ALL" | jq
  echo "Catch-all reverted. Per-alias rules still in place. Investigate worker."
  exit 1
fi

echo "==> Step 5: Delete all per-alias rules"
RULE_IDS=$(jq -r '.result[] | select(.matchers[] | .type == "literal") | .tag' \
  "${BACKUP_DIR}/email-routing-rules-cutover-${DATE}.json")

for ID in $RULE_IDS; do
  echo "Deleting rule $ID"
  curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules/${ID}" \
    -H "Authorization: Bearer $CF_API_TOKEN" | jq -r '.success'
done

echo "==> Step 6: Verify only catch-all remains"
curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result[] | {tag, name, enabled, matchers, actions}'

echo ""
echo "==> Cutover complete. Worker is now handling all inbound mail."
echo "Test by sending mail to multiple aliases:"
echo "  - info@canonniers.ca (should reach chisholm2000@gmail.com)"
echo "  - manager17d1@canonniers.ca (should reach carlbis@hotmail.com)"
echo "  - random-nonexistent@canonniers.ca (should reach chisholm2000@gmail.com via _fallback)"
```

Make executable and run:

```bash
chmod +x scripts/email-routing/cutover-to-worker.sh
./scripts/email-routing/cutover-to-worker.sh
```

The script is interactive — it pauses for Jay to confirm test mail delivery before deleting old rules. This is the safety gate.

### After successful cutover

```bash
# The cutover script and the backup files become the audit trail
git add scripts/email-routing/cutover-to-worker.sh
git add backups/email-routing-rules-cutover-*.json
git add backups/email-routing-catch-all-cutover-*.json

git commit -m "feat(email): cutover to email-router worker

Catch-all email routing rule for canonniers.ca now points at
canonniers-email-router worker. All 16 per-alias rules deleted.

Pre-cutover state backed up to backups/email-routing-*-cutover-*.json
for emergency rollback (see scripts/email-routing/rollback-to-rules.sh
in commit 3, or restore manually via Cloudflare API).

Cutover verified by:
- Test email to info@canonniers.ca confirmed delivered
- Test email to manager17d1@canonniers.ca confirmed delivered
- Test email to nonexistent alias confirmed reached _fallback

Inbound mail behavior unchanged from user perspective. Worker
handles fan-out which the previous rule-based model could not."

git push origin main
```

### Commit 2 verification

After cutover, send these test emails from an external address:

| To | Expected delivery |
|---|---|
| `info@canonniers.ca` | `chisholm2000@gmail.com` |
| `manager17d1@canonniers.ca` | `carlbis@hotmail.com` |
| `photo17d1@canonniers.ca` | `dianeracine15@gmail.com` |
| `nonexistent-test@canonniers.ca` | `chisholm2000@gmail.com` (via `_fallback`) |

For each test, also check the Worker logs in real time:

```bash
cd workers/canonniers-email-router
npx wrangler tail
```

Should see `[email-router] <alias> -> <destinations>` entries for each test.

If any test fails, run the rollback procedure (see below).

### Commit 2 rollback procedure

If something is wrong after cutover and Jay needs to revert immediately:

**Quick rollback (mail flows to Jay only):**
1. Cloudflare dashboard → Email Routing → Rules → Catch-all → Edit
2. Change action from `Send to a Worker` to `Send to an email` → `chisholm2000@gmail.com`
3. Save. All inbound mail now goes to Jay's Gmail.
4. Investigate worker, fix, re-cutover.

**Full rollback to per-alias rules:**
Use `backups/email-routing-rules-cutover-*.json`. Each rule in `result[]` can be POSTed back to `/zones/${CF_ZONE_ID}/email/routing/rules` to recreate it. A helper script is created in commit 3 (`scripts/email-routing/rollback-to-rules.sh`) — but quick rollback is faster and good enough for emergencies.

---

## Commit 3: Deprecate old infrastructure (no live impact)

Now that the worker is handling mail, the PowerShell script and its workflow are obsolete. Mark them deprecated, disable the scheduled run, but DO NOT delete — keep for two weeks as rollback insurance.

### Files to change

#### `scripts/email-routing/canonniers-email-routing.ps1`

Add this header comment at the top of the file (after the existing comment block, if any):

```powershell
# ============================================================
# DEPRECATED 2026-05-07
# ============================================================
# This script is no longer in active use. Email routing for
# @canonniers.ca is now handled by the canonniers-email-router
# Cloudflare Worker (workers/canonniers-email-router/).
#
# Source of truth for routing: workers/canonniers-email-router/src/routes.json
#
# This script is kept for emergency rollback only. To re-activate:
#   1. Recreate per-alias rules from backups/email-routing-rules-cutover-*.json
#   2. Change catch-all back to forward → chisholm2000@gmail.com
#   3. Re-enable .github/workflows/email-routing-phase2.deprecated.yml
#
# Scheduled to be deleted on 2026-05-21 if worker is stable.
# ============================================================
```

#### `.github/workflows/email-routing-phase2.yml` → `.github/workflows/email-routing-phase2.deprecated.yml`

Rename the file. Then:
- Remove the `schedule:` trigger (delete the cron entry)
- Keep `workflow_dispatch:` so it can be run manually if needed for rollback
- Add a comment block at the top:

```yaml
# DEPRECATED 2026-05-07 — see scripts/email-routing/canonniers-email-routing.ps1
# header for context. Workflow kept for emergency rollback only.
# Scheduled trigger removed. Manual dispatch only.

name: Email Routing — Phase 2 Auto-Update (DEPRECATED)

on:
  workflow_dispatch:
    inputs:
      phase:
        description: 'Phase to run (1 or 2)'
        required: true
        default: '2'

# ... rest of workflow unchanged ...
```

#### Add a rollback helper script `scripts/email-routing/rollback-to-rules.sh`

```bash
#!/bin/bash
set -euo pipefail

# Emergency rollback: restore per-alias rules from a cutover backup.
# Usage: ./rollback-to-rules.sh <path-to-backup-json>

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "Usage: $0 <path-to-backup-json>"
  echo "Example: $0 backups/email-routing-rules-cutover-2026-05-07-143022.json"
  exit 1
fi

: "${CF_API_TOKEN:?CF_API_TOKEN must be set}"
: "${CF_ZONE_ID:?CF_ZONE_ID must be set}"

echo "==> Restoring rules from $BACKUP_FILE"
echo "WARNING: This will recreate per-alias rules. Worker-based catch-all"
echo "should be reverted FIRST via Cloudflare dashboard."
read -p "Have you reverted the catch-all? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborting. Revert catch-all first."
  exit 1
fi

jq -c '.result[] | select(.matchers[] | .type == "literal")' "$BACKUP_FILE" | while read -r RULE; do
  CLEAN_RULE=$(echo "$RULE" | jq '{enabled, name, matchers, actions, priority}')
  echo "Recreating: $(echo "$CLEAN_RULE" | jq -r '.name')"
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/email/routing/rules" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$CLEAN_RULE" | jq -r '.success'
done

echo "==> Restore complete. Verify in Cloudflare dashboard."
```

#### Update project memory / docs

If there's a `README.md` at repo root or `docs/` folder mentioning the email routing setup, update it to reference the worker.

### Commit 3 actions

```bash
# Add deprecation header to PS1 script
# Rename and edit the workflow file
git mv .github/workflows/email-routing-phase2.yml .github/workflows/email-routing-phase2.deprecated.yml

# ... apply edits to both files ...

# Add rollback helper
chmod +x scripts/email-routing/rollback-to-rules.sh

git add scripts/email-routing/canonniers-email-routing.ps1
git add scripts/email-routing/rollback-to-rules.sh
git add .github/workflows/email-routing-phase2.deprecated.yml
git rm --cached .github/workflows/email-routing-phase2.yml 2>/dev/null || true

git commit -m "chore(email): deprecate PowerShell-based routing script and workflow

Email routing is now handled by canonniers-email-router worker (commits 1-2).
The PowerShell script and its scheduled GH Actions workflow are obsolete.

- canonniers-email-routing.ps1: deprecation header added, kept for rollback
- email-routing-phase2.yml renamed to .deprecated.yml, schedule removed,
  workflow_dispatch retained for emergency manual runs
- rollback-to-rules.sh added: re-creates per-alias rules from backup JSON
  (emergency use only, requires catch-all reverted first)

Both deprecated files scheduled for full deletion on 2026-05-21 once worker
is confirmed stable."

git push origin main
```

### Commit 3 verification

```bash
# Workflow no longer scheduled
grep -r "schedule" .github/workflows/email-routing-phase2.deprecated.yml
# Expected: no match (or only commented-out lines)

# Script has deprecation header
head -20 scripts/email-routing/canonniers-email-routing.ps1
# Expected: DEPRECATED 2026-05-07 visible
```

Wait one hour. Confirm no GH Actions run for email-routing-phase2 was triggered. (The deprecated workflow won't have a schedule, so this should be silent.)

---

## Open questions for Claude Code

If any of the following come up during execution, **STOP** and ask Jay before proceeding:

1. **Pre-flight step 7 mismatch.** If the live routing state differs from the documented "current live state" (e.g., extra aliases, different destinations, missing rules) — surface the diff to Jay. Don't guess at intent.

2. **Token lacks expected scopes.** If any API call returns 403/authentication error during pre-flight, stop and report the exact error to Jay.

3. **Worker deploy fails.** If `wrangler deploy` errors out during commit 1 — capture the full error output and ask Jay. Common causes: account_id wrong, wrangler version too old, network issue.

4. **Cutover script fails at step 2 (set catch-all).** If the API rejects the catch-all update with `actions[0].type=worker`, the API may have changed shape. The Cloudflare docs at https://developers.cloudflare.com/api/operations/email-routing-routing-rules-update-catch-all-rule are authoritative — verify the current required schema and ask Jay if it differs from this directive.

5. **Test email at cutover step 4 doesn't arrive.** Script will auto-revert the catch-all. Don't proceed. Investigate worker logs (`wrangler tail`) and report findings to Jay.

6. **Rule deletion at cutover step 5 partially fails.** Some rules deleted, some not. Don't try to "fix forward" — report exactly which rules deleted vs remained and ask Jay how to proceed. Do NOT re-run the script blindly.

7. **`_fallback` behavior unclear.** If during testing, mail to a nonexistent alias does NOT reach `chisholm2000@gmail.com`, check worker logs. Could indicate `routes._fallback` isn't being read correctly. Don't try to debug live — report findings.

8. **Anything else surprising.** Ask. The cost of a clarifying message is much lower than the cost of guessing wrong on email routing.

---

## Summary of what changes for Jay

**Before this migration:**
- 16 Email Routing rules in Cloudflare dashboard
- PowerShell script + scheduled GH Action managing rules
- Adding/changing volunteers = run script Phase 1 (verify), Phase 2 (update rules)
- Cannot fan out one alias to multiple recipients
- `social15u@` (two volunteers) is broken

**After this migration:**
- 1 Email Routing rule in Cloudflare dashboard (catch-all → worker)
- 1 file in repo: `workers/canonniers-email-router/src/routes.json`
- Adding/changing volunteers = edit JSON, commit, push
- Multi-recipient just works (`"social15u@canonniers.ca": ["a@x.com", "b@y.com"]`)
- Worker logs visible via `wrangler tail` for debugging

**What's NOT fixed:**
- Outlook/Hotmail intermittent IP blocks on Cloudflare's outbound forwarding IPs. Same problem before and after this migration. Resend integration deferred to future directive.

**What Jay does manually:**
1. Provision EMAIL_FIX token in Cloudflare with full account access (one-time, dashboard)
2. Add `CF_EMAIL_FIX` secret to GitHub repo (one-time, dashboard)
3. Paste token into Claude Code's terminal session when prompted
4. Confirm test email delivery at cutover gate
5. Revoke EMAIL_FIX token in 3 days

**Token expiry consequence:** After day 3, the GH Actions deploy workflow fails with 401. Manual deploy via `wrangler deploy` from Jay's laptop using whatever token he has at that moment is required for `routes.json` changes. Acceptable per Jay's decision.

---

## End of directive

Claude Code: read this entire document before starting. Execute one commit at a time. Verify each commit before moving to the next. If anything is unclear, stop and ask.
