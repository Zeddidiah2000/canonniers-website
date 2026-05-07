<#
.SYNOPSIS
    Bulk-manage Cloudflare Email Routing destinations and rules for canonniers.ca.

.DESCRIPTION
    Idempotent script. Safe to run multiple times.

    Phase 1 (default): Adds all volunteer destination addresses (triggers verification
    emails) and creates routing rules for canonniers.ca custom addresses, all initially
    pointing to chisholm2000@gmail.com (Jay's inbox).

    Phase 2: Re-run with -Phase 2. For each rule where all assigned volunteers have
    verified, updates the rule to forward to BOTH chisholm2000@gmail.com AND the
    volunteer(s). Rules with multiple volunteers wait until all are verified.

.PARAMETER Phase
    1 = create destinations + rules (default)
    2 = swap verified volunteer destinations into their rules

.PARAMETER ApiToken
    Cloudflare API token with Account -> Email Routing Addresses -> Edit AND
    Zone -> Email Routing Rules -> Edit + Zone -> Zone -> Read, scoped to canonniers.ca.
    If not passed, reads from $env:CLOUDFLARE_API_TOKEN.

.PARAMETER ZoneName
    Defaults to canonniers.ca. Override only if testing on a different zone.

.PARAMETER ZoneId
    Cloudflare zone ID for canonniers.ca. If provided, skips the zone lookup API call.
    canonniers.ca zone ID: 44570aa6a783eab41938a9516ee24716

.PARAMETER AccountId
    Cloudflare account ID. If provided, skips the account ID lookup API call.
    canonniers.ca account ID: db90db1d80338194e2994306da649f90

.PARAMETER WhatIf
    Show what would happen without making changes.

.EXAMPLE
    # Phase 1 dry run
    .\canonniers-email-routing.ps1 -WhatIf -ZoneId 44570aa6a783eab41938a9516ee24716 -AccountId db90db1d80338194e2994306da649f90

.EXAMPLE
    # Phase 1 (first run / add new volunteers)
    .\canonniers-email-routing.ps1 -ZoneId 44570aa6a783eab41938a9516ee24716 -AccountId db90db1d80338194e2994306da649f90

.EXAMPLE
    # Phase 2 (after volunteers verify)
    .\canonniers-email-routing.ps1 -Phase 2 -ZoneId 44570aa6a783eab41938a9516ee24716 -AccountId db90db1d80338194e2994306da649f90
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet(1, 2)]
    [int]$Phase = 1,

    [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN,

    [string]$ZoneName = 'canonniers.ca',

    [string]$ZoneId = '',

    [string]$AccountId = ''
)

$ErrorActionPreference = 'Stop'

# ============================================================================
# Configuration
# ============================================================================

$PrimaryDestination = 'chisholm2000@gmail.com'

# Volunteer destinations: address -> friendly label
$VolunteerDestinations = [ordered]@{
    # 15U AAA
    'ddufour@canonniersdequebec.com' = 'Dave Dufour (15U Coach)'
    'sebas14faucher@gmail.com'       = 'Sebastien Faucher (15U Manager)'
    'manulavoie08@hotmail.com'       = 'Emmanuel Lavoie (15U Social)'
    'c_apple60@hotmail.com'          = 'Caroline (15U Social)'
    # 17U Division 1
    'jlandry@canonniersdequebec.com' = 'Jonathan Landry (17 D1 Coach)'
    'carlbis@hotmail.com'            = 'Carl Bisaillon (17 D1 Manager)'
    'mariobouchard@gmail.com'        = 'Mario Bouchard (17 D1 Social)'
    'dianeracine15@gmail.com'        = 'Diane Racine (17 D1 Photo)'
    # 17U Division 2
    'mdeschenes@canonniersdequebec.com' = 'Mathieu Deschesne (17 D2 Coach)'
    'all_68@hotmail.com'                = 'Francis Allard (17 D2 Manager)'
    'myriamgagne17@hotmail.com'         = 'Myriam Gagne (17 D2 Social)'
    'davidcote1626@hotmail.com'         = 'David Cote (17 D2 Photo)'
}

# Routing rules: local-part -> array of volunteer destination addresses for Phase 2.
# Empty array = no volunteer assigned yet (rule stays at PrimaryDestination only).
# Multiple addresses = all must verify before the rule is updated.
# Phase 1 always points rules to $PrimaryDestination only.
# Phase 2 points to $PrimaryDestination + all volunteers (Jay stays CC'd).
$RoutingRules = [ordered]@{
    'contact'       = @()
    'treasurer15u'  = @()
    'treasurer17d1' = @()
    'treasurer17d2' = @()
    'coach15u'      = @('ddufour@canonniersdequebec.com')
    'coach17d1'     = @('jlandry@canonniersdequebec.com')
    'coach17d2'     = @('mdeschenes@canonniersdequebec.com')
    'manager15u'    = @('sebas14faucher@gmail.com')
    'manager17d1'   = @('carlbis@hotmail.com')
    'manager17d2'   = @('all_68@hotmail.com')
    'social15u'     = @('manulavoie08@hotmail.com', 'c_apple60@hotmail.com')
    'social17d1'    = @('mariobouchard@gmail.com')
    'social17d2'    = @('myriamgagne17@hotmail.com')
    'photo15u'      = @()
    'photo17d1'     = @('dianeracine15@gmail.com')
    'photo17d2'     = @('davidcote1626@hotmail.com')
}

# Addresses that already exist and should be skipped entirely
$SkipAddresses = @('info', 'jay')

# ============================================================================
# Pre-flight
# ============================================================================

if (-not $ApiToken) {
    Write-Error @"
No Cloudflare API token found.

Pass via -ApiToken, or set the environment variable:
  `$env:CLOUDFLARE_API_TOKEN = 'your-token-here'

Token requirements:
  - Account -> Email Routing Addresses -> Edit
  - Zone -> Email Routing Rules -> Edit
  - Zone -> Zone -> Read
  - Zone Resources: Include -> Specific zone -> canonniers.ca
  - Recommended: TTL = 24 hours (auto-expire), no Start date
"@
    exit 1
}

$Headers = @{
    'Authorization' = "Bearer $ApiToken"
    'Content-Type'  = 'application/json'
}

$ApiBase = 'https://api.cloudflare.com/client/v4'

function Invoke-CfApi {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        [object]$Body
    )
    $uri = "$ApiBase$Path"
    $params = @{
        Method  = $Method
        Uri     = $uri
        Headers = $Headers
    }
    if ($Body) {
        $params['Body'] = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }
    try {
        return Invoke-RestMethod @params
    }
    catch {
        $errorBody = $_.ErrorDetails.Message
        Write-Error "Cloudflare API error: $Method $Path`n$errorBody"
        throw
    }
}

# ============================================================================
# Resolve zone and account IDs
# ============================================================================

if ($ZoneId -and $AccountId) {
    Write-Host "[+] Using provided Zone ID: $ZoneId" -ForegroundColor Cyan
    Write-Host "    Account ID: $AccountId" -ForegroundColor DarkGray
} else {
    Write-Host "[+] Looking up zone '$ZoneName'..." -ForegroundColor Cyan
    $zoneResp = Invoke-CfApi -Method GET -Path "/zones?name=$ZoneName"
    if (-not $zoneResp.success -or $zoneResp.result.Count -eq 0) {
        Write-Error "Zone '$ZoneName' not found or token lacks access. If your token lacks Zone:Read, pass -ZoneId and -AccountId directly."
        exit 1
    }
    $ZoneId = $zoneResp.result[0].id
    Write-Host "    Zone ID: $ZoneId" -ForegroundColor DarkGray

    $zoneDetail = Invoke-CfApi -Method GET -Path "/zones/$ZoneId"
    $AccountId = $zoneDetail.result.account.id
    Write-Host "    Account ID: $AccountId" -ForegroundColor DarkGray
}

# ============================================================================
# Verify Email Routing is enabled (skipped when ZoneId/AccountId provided directly)
# ============================================================================

if (-not ($ZoneId -and $AccountId)) {
    Write-Host "[+] Checking Email Routing status..." -ForegroundColor Cyan
    $emailStatus = Invoke-CfApi -Method GET -Path "/zones/$ZoneId/email/routing"
    if ($emailStatus.result.status -ne 'ready') {
        Write-Error "Email Routing is not in 'ready' state on $ZoneName (status: $($emailStatus.result.status)). Enable it in the Cloudflare dashboard first."
        exit 1
    }
    Write-Host "    Status: ready" -ForegroundColor DarkGray
} else {
    Write-Host "[+] Email Routing status check skipped (IDs provided directly — assumed ready)" -ForegroundColor DarkGray
}

# ============================================================================
# Fetch existing destinations and rules (so we can be idempotent)
# ============================================================================

Write-Host "[+] Fetching existing destinations..." -ForegroundColor Cyan
$destResp = Invoke-CfApi -Method GET -Path "/accounts/$AccountId/email/routing/addresses?per_page=50"
$ExistingDestinations = @{}
foreach ($d in $destResp.result) {
    $ExistingDestinations[$d.email] = @{
        verified = $null -ne $d.verified
        tag      = $d.tag
    }
}
Write-Host "    Found $($ExistingDestinations.Count) existing destination(s)" -ForegroundColor DarkGray

Write-Host "[+] Fetching existing routing rules..." -ForegroundColor Cyan
$ruleResp = Invoke-CfApi -Method GET -Path "/zones/$ZoneId/email/routing/rules?per_page=50"
$ExistingRules = @{}
foreach ($r in $ruleResp.result) {
    $matcher = $r.matchers | Where-Object { $_.field -eq 'to' } | Select-Object -First 1
    if ($matcher) {
        $ExistingRules[$matcher.value] = $r
    }
}
Write-Host "    Found $($ExistingRules.Count) existing rule(s)" -ForegroundColor DarkGray

# ============================================================================
# PHASE 1
# ============================================================================

if ($Phase -eq 1) {
    Write-Host "`n=== PHASE 1: Create destinations and routes ===" -ForegroundColor Yellow

    # --- Add volunteer destinations ---
    Write-Host "`n[Phase 1.1] Adding volunteer destinations..." -ForegroundColor Cyan

    $destSummary = @()
    foreach ($email in $VolunteerDestinations.Keys) {
        $label = $VolunteerDestinations[$email]
        if ($ExistingDestinations.ContainsKey($email)) {
            $verified = $ExistingDestinations[$email].verified
            $status = if ($verified) { 'verified' } else { 'pending' }
            Write-Host "    [skip] $email already exists ($status) - $label" -ForegroundColor DarkGray
            $destSummary += [pscustomobject]@{ Email = $email; Owner = $label; Status = "$status (existed)" }
            continue
        }

        if ($PSCmdlet.ShouldProcess($email, 'Add destination address')) {
            try {
                $body = @{ email = $email }
                $resp = Invoke-CfApi -Method POST -Path "/accounts/$AccountId/email/routing/addresses" -Body $body
                Write-Host "    [add]  $email -> verification email sent ($label)" -ForegroundColor Green
                $destSummary += [pscustomobject]@{ Email = $email; Owner = $label; Status = 'pending verification (created)' }
                $ExistingDestinations[$email] = @{ verified = $false; tag = $resp.result.tag }
            }
            catch {
                Write-Host "    [FAIL] $email - $_" -ForegroundColor Red
                $destSummary += [pscustomobject]@{ Email = $email; Owner = $label; Status = 'FAILED' }
            }
        }
        else {
            $destSummary += [pscustomobject]@{ Email = $email; Owner = $label; Status = 'WHATIF: would create' }
        }
    }

    # --- Create routing rules ---
    Write-Host "`n[Phase 1.2] Creating routing rules (all -> $PrimaryDestination)..." -ForegroundColor Cyan

    $ruleSummary = @()
    foreach ($localPart in $RoutingRules.Keys) {
        $fullAddr = "$localPart@$ZoneName"

        if ($SkipAddresses -contains $localPart) {
            Write-Host "    [skip] $fullAddr (in skip list)" -ForegroundColor DarkGray
            $ruleSummary += [pscustomobject]@{ Address = $fullAddr; Action = 'skipped (preserve existing)'; Destinations = '(unchanged)' }
            continue
        }

        if ($ExistingRules.ContainsKey($fullAddr)) {
            Write-Host "    [skip] $fullAddr already has a rule" -ForegroundColor DarkGray
            $existingDests = ($ExistingRules[$fullAddr].actions | Where-Object { $_.type -eq 'forward' }).value -join ', '
            $ruleSummary += [pscustomobject]@{ Address = $fullAddr; Action = 'already exists'; Destinations = $existingDests }
            continue
        }

        if ($PSCmdlet.ShouldProcess($fullAddr, 'Create routing rule')) {
            try {
                $body = @{
                    name     = "Auto: $fullAddr -> $PrimaryDestination"
                    enabled  = $true
                    matchers = @(@{ type = 'literal'; field = 'to'; value = $fullAddr })
                    actions  = @(@{ type = 'forward'; value = @($PrimaryDestination) })
                    priority = 0
                }
                $resp = Invoke-CfApi -Method POST -Path "/zones/$ZoneId/email/routing/rules" -Body $body
                Write-Host "    [add]  $fullAddr -> $PrimaryDestination" -ForegroundColor Green
                $ruleSummary += [pscustomobject]@{ Address = $fullAddr; Action = 'created'; Destinations = $PrimaryDestination }
            }
            catch {
                Write-Host "    [FAIL] $fullAddr - $_" -ForegroundColor Red
                $ruleSummary += [pscustomobject]@{ Address = $fullAddr; Action = 'FAILED'; Destinations = '-' }
            }
        }
        else {
            $ruleSummary += [pscustomobject]@{ Address = $fullAddr; Action = 'WHATIF: would create'; Destinations = $PrimaryDestination }
        }
    }

    # --- Summary ---
    Write-Host "`n=== PHASE 1 SUMMARY ===" -ForegroundColor Yellow
    Write-Host "`nDestinations:" -ForegroundColor Cyan
    $destSummary | Format-Table -AutoSize
    Write-Host "Routing rules:" -ForegroundColor Cyan
    $ruleSummary | Format-Table -AutoSize

    $pending = $destSummary | Where-Object { $_.Status -like '*pending*' }
    if ($pending) {
        Write-Host "`n[!] $($pending.Count) destination(s) await verification:" -ForegroundColor Yellow
        foreach ($p in $pending) {
            Write-Host "    - $($p.Email)  ($($p.Owner))" -ForegroundColor Yellow
        }
        Write-Host "`nNotify them to click the verification link from Cloudflare." -ForegroundColor Yellow
        Write-Host "Once they verify, re-run with: .\canonniers-email-routing.ps1 -Phase 2 -ZoneId $ZoneId -AccountId $AccountId" -ForegroundColor Yellow
    }
}

# ============================================================================
# PHASE 2
# ============================================================================

if ($Phase -eq 2) {
    Write-Host "`n=== PHASE 2: Swap verified volunteers into rules ===" -ForegroundColor Yellow

    $swapSummary = @()
    foreach ($localPart in $RoutingRules.Keys) {
        $fullAddr = "$localPart@$ZoneName"
        [string[]]$volunteers = @($RoutingRules[$localPart])

        if ($volunteers.Count -eq 0) {
            continue  # No volunteers assigned for this address
        }

        # Check each volunteer exists and is verified
        $allVerified = $true
        foreach ($vol in $volunteers) {
            if (-not $ExistingDestinations.ContainsKey($vol)) {
                Write-Host "    [skip] $fullAddr - destination $vol not in Cloudflare yet" -ForegroundColor DarkGray
                $swapSummary += [pscustomobject]@{ Address = $fullAddr; Volunteer = $vol; Action = 'destination missing' }
                $allVerified = $false
            }
            elseif (-not $ExistingDestinations[$vol].verified) {
                Write-Host "    [wait] $fullAddr - $vol not yet verified" -ForegroundColor Yellow
                $swapSummary += [pscustomobject]@{ Address = $fullAddr; Volunteer = $vol; Action = 'awaiting verification' }
                $allVerified = $false
            }
        }
        if (-not $allVerified) { continue }

        # Check rule exists
        if (-not $ExistingRules.ContainsKey($fullAddr)) {
            Write-Host "    [FAIL] $fullAddr - rule does not exist (run Phase 1 first)" -ForegroundColor Red
            foreach ($vol in $volunteers) {
                $swapSummary += [pscustomobject]@{ Address = $fullAddr; Volunteer = $vol; Action = 'rule missing' }
            }
            continue
        }

        $existingRule = $ExistingRules[$fullAddr]
        $forwardAction = $existingRule.actions | Where-Object { $_.type -eq 'forward' } | Select-Object -First 1
        [string[]]$currentDests = @($forwardAction.value | ForEach-Object { "$_".Trim() })
        [string[]]$targetDests  = $volunteers

        # Explicit set-equality: same count AND every target is present
        $alreadyCorrect = ($currentDests.Count -eq $targetDests.Count) -and
                          ($targetDests | Where-Object { $currentDests -notcontains $_ }).Count -eq 0
        if ($alreadyCorrect) {
            Write-Host "    [ok]   $fullAddr already routes to $($targetDests -join ' + ')" -ForegroundColor DarkGray
            foreach ($vol in $volunteers) {
                $swapSummary += [pscustomobject]@{ Address = $fullAddr; Volunteer = $vol; Action = 'already correct' }
            }
            continue
        }

        if ($PSCmdlet.ShouldProcess($fullAddr, "Update rule to forward to $($targetDests -join ' + ')")) {
            try {
                $body = @{
                    name     = "Auto: $fullAddr -> $PrimaryDestination + volunteer(s)"
                    enabled  = $true
                    matchers = @(@{ type = 'literal'; field = 'to'; value = $fullAddr })
                    actions  = @(@{ type = 'forward'; value = $targetDests })
                    priority = 0
                }
                Invoke-CfApi -Method PUT -Path "/zones/$ZoneId/email/routing/rules/$($existingRule.tag)" -Body $body | Out-Null
                Write-Host "    [upd]  $fullAddr -> $($targetDests -join ' + ')" -ForegroundColor Green
                foreach ($vol in $volunteers) {
                    $swapSummary += [pscustomobject]@{ Address = $fullAddr; Volunteer = $vol; Action = 'updated' }
                }
            }
            catch {
                Write-Host "    [FAIL] $fullAddr - $_" -ForegroundColor Red
                foreach ($vol in $volunteers) {
                    $swapSummary += [pscustomobject]@{ Address = $fullAddr; Volunteer = $vol; Action = 'FAILED' }
                }
            }
        }
    }

    Write-Host "`n=== PHASE 2 SUMMARY ===" -ForegroundColor Yellow
    $swapSummary | Format-Table -AutoSize

    $stillWaiting = $swapSummary | Where-Object { $_.Action -eq 'awaiting verification' }
    if ($stillWaiting) {
        Write-Host "`n[!] Still waiting on verification for:" -ForegroundColor Yellow
        $stillWaiting | ForEach-Object { Write-Host "    - $($_.Volunteer) ($($_.Address))" -ForegroundColor Yellow }
        Write-Host "`nRe-run Phase 2 once they click their verification links." -ForegroundColor Yellow
    }
}

Write-Host "`n[done]" -ForegroundColor Green
