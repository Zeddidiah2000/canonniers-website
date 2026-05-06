# Directive — Canonniers Email Routing Bulk Setup

**Type:** One-shot infrastructure config (Cloudflare API), not a website code change.
**Repo impact:** Adds one file to `scripts/` (or wherever Jay prefers utility scripts). No commits to `main` for site code.
**Reusable:** Yes — script is idempotent, safe to re-run, designed for a Phase 1 + Phase 2 split.

---

## Goal

Bulk-create Cloudflare Email Routing destinations and rules on the `canonniers.ca` zone, supporting a two-phase rollout:

- **Phase 1 (today):** Create 8 volunteer destinations (triggers verification emails) and 15 routing rules. All rules initially forward to `info@canonniers.ca` only.
- **Phase 2 (later, possibly multiple times):** As volunteers click their verification links, re-run the script to update each rule to forward to **both** `info@canonniers.ca` AND the volunteer's address (Option B: Jay stays CC'd for oversight).

---

## Pre-flight verification

Before running the script, Claude Code must confirm:

### 1. API token availability

The script requires an API token with these exact permissions:

- **Zone → Email Routing Addresses → Edit**
- **Zone → Email Routing Rules → Edit**
- **Zone Resources:** Include → Specific zone → `canonniers.ca`

Check in this order:

1. Is `$env:CLOUDFLARE_API_TOKEN` already set in Claude Code's environment? Test with:
   ```powershell
   if ($env:CLOUDFLARE_API_TOKEN) { "set, length: $($env:CLOUDFLARE_API_TOKEN.Length)" } else { "not set" }
   ```

2. If set, validate it has the right scope by hitting the zone lookup:
   ```powershell
   $token = $env:CLOUDFLARE_API_TOKEN
   Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/zones?name=canonniers.ca' `
     -Headers @{ Authorization = "Bearer $token" }
   ```
   Expected: `success: True` and one zone in `result`. If the call fails with 403/401, the token is missing the Email Routing scope or doesn't include the `canonniers.ca` zone.

3. **If the existing token lacks the scope**, do not proceed silently. Stop and ask Jay to either:
   - Generate a new token with the correct permissions (steps below), OR
   - Confirm we should use the existing token and accept that the script will fail at the Email Routing API calls.

#### Token generation steps (if needed)

1. Cloudflare Dashboard → profile icon → **My Profile** → **API Tokens**
2. **Create Token** → "Custom token" → **Get started**
3. Name: `Canonniers Email Routing Bulk`
4. Permissions:
   - Row 1: `Zone` / `Email Routing Addresses` / `Edit`
   - Row 2: `Zone` / `Email Routing Rules` / `Edit`
5. Zone Resources: `Include` / `Specific zone` / `canonniers.ca`
6. **TTL:** Start = today, End = today + 1 day (auto-expire — defense against leaked tokens)
7. Continue → Create → copy the token (shown once)
8. Set in environment: `$env:CLOUDFLARE_API_TOKEN = '<paste token here>'`

### 2. Working directory

Place `canonniers-email-routing.ps1` in `scripts/email-routing/` within the repo. Create the directory if missing. This is a utility script, not site code — it does not need to be served by Cloudflare Pages.

### 3. Cloudflare Email Routing must be enabled on the zone

The script verifies this via API and exits early if not. No action needed unless it errors.

---

## What the script does

### Idempotent by design

- Fetches all existing destinations and rules first
- Skips anything already in place
- `info@canonniers.ca` and `jay@canonniers.ca` are explicitly skipped (already configured per Jay's confirmation)
- `jp@canonniers.ca` is **not** in the rule list — JP removed per decision

### Phase 1 actions

**Volunteer destinations to add (8):**

| Email | Owner |
|---|---|
| mdeschenes@canonniersdequebec.com | Mathieu Deschesne (17 D2 Coach) |
| all_68@hotmail.com | Francis Allard (17 D2 Manager) |
| myriamgagne17@hotmail.com | Myriam Gagné (17 D2 Social) |
| davidcote1626@hotmail.com | David Côté (17 D2 Photo) |
| jlandry@canonniersdequebec.com | Jonathan Landry (17 D1 Coach) |
| carlbis@hotmail.com | Carl Bisaillon (17 D1 Manager) |
| mariobouchard@gmail.com | Mario Bouchard (17 D1 Social) |
| dianeracine15@gmail.com | Diane Racine (17 D1 Photo) |

**Routing rules to create (15):**

`contact@`, `treasurer15u@`, `treasurer17d1@`, `treasurer17d2@`, `coach15u@`, `coach17d1@`, `coach17d2@`, `manager15u@`, `manager17d1@`, `manager17d2@`, `social15u@`, `social17d1@`, `social17d2@`, `photo15u@`, `photo17d1@`, `photo17d2@`

(That's 16 local parts; one of them — `contact@` — is the only "general" address being created, the rest are role-based. Total rule creations: 16 minus 1 if `contact@` already exists from earlier setup.)

All rules initially forward to **`info@canonniers.ca` only**.

**Skipped:**
- `info@canonniers.ca` — already exists, leave alone
- `jay@canonniers.ca` — already exists, leave alone
- `jp@canonniers.ca` — not created (JP no longer admin)

### Phase 2 actions

For each volunteer destination that has been verified, update the matching rule to forward to:
- `info@canonniers.ca` (Jay's oversight inbox)
- AND the volunteer's address

Volunteer-to-rule mapping:

| Address | Volunteer destination |
|---|---|
| `coach17d1@canonniers.ca` | jlandry@canonniersdequebec.com |
| `coach17d2@canonniers.ca` | mdeschenes@canonniersdequebec.com |
| `manager17d1@canonniers.ca` | carlbis@hotmail.com |
| `manager17d2@canonniers.ca` | all_68@hotmail.com |
| `social17d1@canonniers.ca` | mariobouchard@gmail.com |
| `social17d2@canonniers.ca` | myriamgagne17@hotmail.com |
| `photo17d1@canonniers.ca` | dianeracine15@gmail.com |
| `photo17d2@canonniers.ca` | davidcote1626@hotmail.com |

If a destination is in the script but not yet verified, Phase 2 reports "awaiting verification" for that address and leaves the rule unchanged.

### What does not happen in either phase

- No 15U volunteer addresses are configured (none provided yet) — those rules sit at `info@` indefinitely
- No treasurer destination addresses are configured (none provided yet) — those rules sit at `info@` indefinitely
- DNS records are not touched (Email Routing manages MX/SPF automatically when Routing was first enabled)

---

## Execution steps

### Phase 1 (run today)

```powershell
# From repo root
cd scripts/email-routing

# Dry run first (no changes made)
.\canonniers-email-routing.ps1 -WhatIf

# If the dry run output matches the expected destinations + rules, run for real
.\canonniers-email-routing.ps1
```

### Phase 2 (run when volunteers verify)

```powershell
cd scripts/email-routing
.\canonniers-email-routing.ps1 -Phase 2 -WhatIf
.\canonniers-email-routing.ps1 -Phase 2
```

Phase 2 can be run repeatedly. Each run swaps in any newly-verified volunteers and reports who is still pending.

---

## Post-execution verification

After Phase 1 completes, confirm:

1. Cloudflare dashboard → `canonniers.ca` → Email → Email Routing → **Destination addresses**
   - Expected: 9 entries total (`info@canonniers.ca` verified, plus 8 volunteer addresses in pending state)
2. Cloudflare dashboard → Email Routing → **Routing rules**
   - Expected: rules for `info@`, `contact@`, `jay@`, plus 15 newly created role-based addresses
   - All new rules should show destination = `info@canonniers.ca`
3. Send test emails:
   ```
   To: contact@canonniers.ca       → should arrive in Jay's Gmail
   To: coach17d1@canonniers.ca     → should arrive in Jay's Gmail
   To: treasurer15u@canonniers.ca  → should arrive in Jay's Gmail
   ```
   All three should land in Jay's personal inbox via the `info@canonniers.ca` forward chain.

---

## Open questions for Claude Code to ask if uncertain

1. If the API token is set but lacks Email Routing scope — stop and ask Jay before generating a new one.
2. If any destination address fails to add (e.g., Cloudflare returns "invalid email format" or similar) — stop, surface the error, do not skip silently.
3. If Email Routing is reported as not "ready" — stop. Don't try to enable it via API; this should be Jay's manual decision in the dashboard.
4. If `info@canonniers.ca` is somehow not present as a verified destination — stop. The whole script depends on this as the staging destination. Don't proceed without it.

---

## Rollback plan

This script makes additive changes only. There is nothing destructive in either phase.

To roll back manually if needed:

- **Remove a rule:** Cloudflare dashboard → Email Routing → Routing rules → click the rule → Delete
- **Remove a destination:** Email Routing → Destination addresses → delete (cannot delete if referenced by an active rule — remove the rule first)

A future enhancement could add a `-Rollback` flag that deletes everything the script created, but for a one-time setup this is overkill.

---

## Threat model

**Token compromise during run:** Token is scoped to one zone, two API permissions, with 24h TTL. Worst case, attacker can manipulate Email Routing on `canonniers.ca` for under a day. Detection: Jay would see unfamiliar destinations or rules in the Cloudflare UI.

**Verification email phishing concern:** The 8 volunteers will receive an email from Cloudflare asking them to click a verification link. Some may treat it as suspicious. Mitigation: Jay sends a heads-up message before the script runs (see "Volunteer heads-up" section below).

**Destination mailbox compromise (downstream):** If a volunteer's personal email is compromised (e.g., `myriamgagne17@hotmail.com` taken over), the attacker receives all mail forwarded to that role. Outside the scope of this script — same risk as any email forwarding setup. Mitigation is volunteer-side (2FA on their personal accounts).

---

## Volunteer heads-up message (optional, draft)

Before running Phase 1, Jay may want to send something like this to the 8 volunteers:

> **(EN)** Hi — I'm setting up role-based email addresses for the Canonniers fan website. You'll receive an email from **Cloudflare** asking you to verify your address (e.g., `youremail@example.com`). This lets the site forward mail addressed to your role on the team (coach/manager/social/photo) to your inbox. Please click the link to confirm. Let me know if you don't receive it within a day. — Jay
>
> **(FR)** Salut — Je configure des adresses courriel par rôle pour le site web des Canonniers. Tu vas recevoir un courriel de **Cloudflare** te demandant de vérifier ton adresse (par exemple, `tonadresse@exemple.com`). Cela permet au site de transférer les courriels destinés à ton rôle dans l'équipe (entraîneur/gérant/social/photo) vers ta boîte de réception. Clique sur le lien pour confirmer. Fais-moi savoir si tu ne le reçois pas d'ici un jour. — Jay
