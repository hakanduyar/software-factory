#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\projection\publish-runtime.ps1')
. (Join-Path $PSScriptRoot '..\dispatch\receipt-adapter.ps1')

function Test-IsoUtcString {
    param([Parameter(Mandatory)][AllowNull()]$Value)
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { return $false }
    $parsed = [DateTime]::MinValue
    return [DateTime]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)
}

function ConvertTo-UtcDateTime {
    param([Parameter(Mandatory)][string]$Value)
    $parsed = [DateTime]::MinValue
    [DateTime]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed) | Out-Null
    return $parsed.ToUniversalTime()
}

function Test-QuotaShape {
    param(
        [Parameter(Mandatory)][AllowNull()]$Quota,
        [Parameter(Mandatory)][bool]$IsCloud
    )
    if ($null -eq $Quota -or $Quota -isnot [PSCustomObject]) { return @{ ok = $false; reason = 'Quota is missing or not an object.' } }
    foreach ($b in @('verified', 'eligible')) {
        if (-not ($Quota.PSObject.Properties.Name -contains $b) -or $Quota.$b -isnot [bool]) {
            return @{ ok = $false; reason = "Quota field '$b' missing or not boolean." }
        }
    }
    if (-not ($Quota.PSObject.Properties.Name -contains 'reason') -or $Quota.reason -isnot [string] -or [string]::IsNullOrWhiteSpace($Quota.reason)) {
        return @{ ok = $false; reason = 'Quota reason missing or not a nonblank string.' }
    }
    foreach ($f in @('observedAt', 'freshUntilUtc')) {
        if (-not ($Quota.PSObject.Properties.Name -contains $f) -or -not (Test-IsoUtcString $Quota.$f)) {
            return @{ ok = $false; reason = "Quota field '$f' missing or not a valid ISO UTC string." }
        }
    }
    if (-not ($Quota.PSObject.Properties.Name -contains 'nextTrigger') -or $Quota.nextTrigger -isnot [string] -or [string]::IsNullOrWhiteSpace($Quota.nextTrigger)) {
        return @{ ok = $false; reason = 'Quota nextTrigger missing or not a nonblank string.' }
    }
    if ($IsCloud) {
        foreach ($b in @('budgetCompliant', 'promotionalOnly', 'creditsEnabled')) {
            if (-not ($Quota.PSObject.Properties.Name -contains $b) -or $Quota.$b -isnot [bool]) {
                return @{ ok = $false; reason = "Cloud quota field '$b' missing or not boolean." }
            }
        }
    }
    $freshUntil = ConvertTo-UtcDateTime $Quota.freshUntilUtc
    if ((Get-Date).ToUniversalTime() -gt $freshUntil) {
        return @{ ok = $false; reason = 'Quota freshUntilUtc has expired.' }
    }
    return @{ ok = $true; reason = $null }
}

function Resolve-RouteDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()]$NormalQuota,
        [Parameter(Mandatory)][AllowNull()]$CloudQuota
    )
    $normalCheck = Test-QuotaShape -Quota $NormalQuota -IsCloud $false
    if (-not $normalCheck.ok) {
        return @{ route = $null; reason = "Normal quota invalid: $($normalCheck.reason)"; nextTrigger = 'next-dispatch-or-quota-change' }
    }

    if ($NormalQuota.verified -and $NormalQuota.eligible) {
        return @{ route = 'normal'; reason = 'Normal quota verified, fresh and eligible.'; nextTrigger = $NormalQuota.nextTrigger }
    }

    $normalUnavailableForQuota = $NormalQuota.verified -and (-not $NormalQuota.eligible) -and ($NormalQuota.reason -eq 'quota')
    if (-not $normalUnavailableForQuota) {
        return @{ route = $null; reason = "Normal quota status does not authorize Cloud (verified=$($NormalQuota.verified), eligible=$($NormalQuota.eligible), reason=$($NormalQuota.reason))."; nextTrigger = $NormalQuota.nextTrigger }
    }

    if ($null -eq $CloudQuota) {
        $fallback = if ($NormalQuota.nextTrigger) { $NormalQuota.nextTrigger } else { 'next-dispatch-or-quota-change' }
        return @{ route = $null; reason = 'Normal quota unavailable (quota) and no Cloud quota provided.'; nextTrigger = $fallback }
    }

    $cloudCheck = Test-QuotaShape -Quota $CloudQuota -IsCloud $true
    if (-not $cloudCheck.ok) {
        return @{ route = $null; reason = "Cloud quota invalid: $($cloudCheck.reason)"; nextTrigger = $NormalQuota.nextTrigger }
    }

    if (-not $CloudQuota.verified -or -not $CloudQuota.eligible) {
        return @{ route = $null; reason = "Cloud quota not verified/eligible (verified=$($CloudQuota.verified), eligible=$($CloudQuota.eligible))."; nextTrigger = $CloudQuota.nextTrigger }
    }
    if (-not $CloudQuota.budgetCompliant) {
        return @{ route = $null; reason = 'Cloud quota not budgetCompliant.'; nextTrigger = $CloudQuota.nextTrigger }
    }
    if (-not $CloudQuota.promotionalOnly) {
        return @{ route = $null; reason = 'Cloud quota promotionalOnly must be true.'; nextTrigger = $CloudQuota.nextTrigger }
    }
    if ($CloudQuota.creditsEnabled) {
        return @{ route = $null; reason = 'Cloud quota creditsEnabled must be false.'; nextTrigger = $CloudQuota.nextTrigger }
    }

    return @{ route = 'cloud'; reason = 'Normal quota-unavailable; Cloud quota verified/fresh/eligible, budget-compliant, promotional-only, credits disabled.'; nextTrigger = $CloudQuota.nextTrigger }
}

function Test-QueueEntryShape {
    param([Parameter(Mandatory)][AllowNull()]$Entry)
    if ($null -eq $Entry -or $Entry -isnot [PSCustomObject]) { return @{ ok = $false; reason = 'Queue entry is missing or not an object.' } }
    foreach ($f in @('id', 'receiptPath', 'planPath', 'owner', 'provider')) {
        if (-not ($Entry.PSObject.Properties.Name -contains $f) -or $Entry.$f -isnot [string] -or [string]::IsNullOrWhiteSpace($Entry.$f)) {
            return @{ ok = $false; reason = "Queue entry field '$f' missing or not a nonblank string." }
        }
    }
    if (-not ($Entry.PSObject.Properties.Name -contains 'enabled') -or $Entry.enabled -isnot [bool]) {
        return @{ ok = $false; reason = 'Queue entry field enabled missing or not boolean.' }
    }
    if (@('independent', 'claude') -notcontains $Entry.provider) {
        return @{ ok = $false; reason = "Queue entry provider must be 'independent' or 'claude'." }
    }
    return @{ ok = $true; reason = $null }
}

function Resolve-HostQueue {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$QueuePath)

    $queueFull = [System.IO.Path]::GetFullPath($QueuePath)
    if (-not (Test-Path -LiteralPath $queueFull -PathType Leaf)) {
        return @{ ok = $false; reason = "Queue file not found: $queueFull"; entries = $null }
    }
    $raw = Get-Content -LiteralPath $queueFull -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @{ ok = $false; reason = 'Queue file is empty.'; entries = $null }
    }
    try {
        $queue = $raw | ConvertFrom-Json -DateKind String
    } catch {
        return @{ ok = $false; reason = 'Queue file is not valid JSON.'; entries = $null }
    }
    if ($null -eq $queue -or $queue -isnot [PSCustomObject]) {
        return @{ ok = $false; reason = 'Queue root is not an object.'; entries = $null }
    }
    if (-not ($queue.PSObject.Properties.Name -contains 'schema') -or $queue.schema -ne 'version1') {
        return @{ ok = $false; reason = "Queue schema missing or not 'version1'."; entries = $null }
    }
    if (-not ($queue.PSObject.Properties.Name -contains 'entries') -or $queue.entries -isnot [array]) {
        return @{ ok = $false; reason = 'Queue entries missing or not an array.'; entries = $null }
    }
    if ($queue.entries.Count -gt 32) {
        return @{ ok = $false; reason = 'Queue entries exceed max of 32.'; entries = $null }
    }
    $seenIds = @{}
    $validated = @()
    foreach ($e in $queue.entries) {
        $shape = Test-QueueEntryShape -Entry $e
        if (-not $shape.ok) {
            return @{ ok = $false; reason = "Invalid queue entry: $($shape.reason)"; entries = $null }
        }
        if ($seenIds.ContainsKey($e.id)) {
            return @{ ok = $false; reason = "Duplicate queue entry id: $($e.id)"; entries = $null }
        }
        $seenIds[$e.id] = $true
        $validated += $e
    }
    return @{ ok = $true; reason = $null; entries = $validated }
}

function Resolve-FrozenPlanGate {
    param([Parameter(Mandatory)][string]$PlanPath)

    $planFull = [System.IO.Path]::GetFullPath($PlanPath)
    if (-not (Test-Path -LiteralPath $planFull -PathType Leaf)) {
        return @{ ok = $false; reason = "Plan file not found: $planFull" }
    }
    $raw = Get-Content -LiteralPath $planFull -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @{ ok = $false; reason = 'Plan file is empty.' }
    }
    try {
        $plan = $raw | ConvertFrom-Json -DateKind String
    } catch {
        return @{ ok = $false; reason = 'Plan file is not valid JSON.' }
    }
    if ($null -eq $plan -or $plan -isnot [PSCustomObject]) {
        return @{ ok = $false; reason = 'Plan root is not an object.' }
    }
    foreach ($b in @('dependenciesReady', 'ownershipKnown', 'budgetKnown', 'quotaAllowed')) {
        if (-not ($plan.PSObject.Properties.Name -contains $b) -or $plan.$b -isnot [bool] -or $plan.$b -ne $true) {
            return @{ ok = $false; reason = "Plan field '$b' missing, not boolean, or not true." }
        }
    }
    if (-not ($plan.PSObject.Properties.Name -contains 'reviewDenied') -or $plan.reviewDenied -isnot [bool] -or $plan.reviewDenied -ne $false) {
        return @{ ok = $false; reason = "Plan field 'reviewDenied' missing, not boolean, or not false." }
    }
    return @{ ok = $true; reason = $null }
}

function Invoke-ReadyHostContinuation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$QueuePath,
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$NormalQuotaPath,
        [string]$CloudQuotaPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner
    )

    $stateDirFull = [System.IO.Path]::GetFullPath($StateDir)
    if (-not (Test-Path -LiteralPath $stateDirFull -PathType Container)) {
        New-Item -ItemType Directory -Path $stateDirFull -Force | Out-Null
    }

    $normalQuotaFull = [System.IO.Path]::GetFullPath($NormalQuotaPath)
    $normalQuota = $null
    if (Test-Path -LiteralPath $normalQuotaFull -PathType Leaf) {
        $normalRaw = Get-Content -LiteralPath $normalQuotaFull -Raw
        try {
            $normalQuota = if ([string]::IsNullOrWhiteSpace($normalRaw)) { $null } else { $normalRaw | ConvertFrom-Json -DateKind String }
        } catch {
            $normalQuota = $null
        }
    }

    $cloudQuota = $null
    if ($CloudQuotaPath) {
        $cloudQuotaFull = [System.IO.Path]::GetFullPath($CloudQuotaPath)
        if (Test-Path -LiteralPath $cloudQuotaFull -PathType Leaf) {
            $cloudRaw = Get-Content -LiteralPath $cloudQuotaFull -Raw
            try {
                $cloudQuota = if ([string]::IsNullOrWhiteSpace($cloudRaw)) { $null } else { $cloudRaw | ConvertFrom-Json -DateKind String }
            } catch {
                $cloudQuota = $null
            }
        }
    }

    $routeDecision = Resolve-RouteDecision -NormalQuota $normalQuota -CloudQuota $cloudQuota
    $normalDisabled = $routeDecision.route -ne 'normal' -and $routeDecision.route -ne 'cloud'

    $queueResolution = Resolve-HostQueue -QueuePath $QueuePath
    if (-not $queueResolution.ok) {
        $decision = [PSCustomObject]@{
            status      = 'NO_ELIGIBLE'
            selected    = $null
            perEntry    = @()
            owner       = $Owner
            nextTrigger = $routeDecision.nextTrigger
            reason      = $queueResolution.reason
        }
        Write-HostContinuationDecision -StateDir $stateDirFull -Decision $decision | Out-Null
        return $decision
    }

    $perEntry = @()
    $selected = $null

    foreach ($entry in $queueResolution.entries) {
        if ($null -ne $selected) {
            $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = 'Not evaluated; a prior entry was already selected this cycle.'; nextTrigger = $null }
            continue
        }

        if (-not $entry.enabled) {
            $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = 'Entry disabled.'; nextTrigger = $null }
            continue
        }

        if ($entry.provider -eq 'claude' -and $normalDisabled) {
            $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = $routeDecision.reason; nextTrigger = $routeDecision.nextTrigger }
            continue
        }

        $receiptFull = [System.IO.Path]::GetFullPath($entry.receiptPath)
        if (-not (Test-Path -LiteralPath $receiptFull -PathType Leaf)) {
            $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = "Receipt file not found: $receiptFull"; nextTrigger = $null }
            continue
        }
        $planFull = [System.IO.Path]::GetFullPath($entry.planPath)
        $gate = Resolve-FrozenPlanGate -PlanPath $planFull
        if (-not $gate.ok) {
            $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = $gate.reason; nextTrigger = $null }
            continue
        }

        $claimOutcome = $null
        try {
            $claimOutcome = Invoke-ContinuationStep -StateDir $stateDirFull -ReceiptPath $receiptFull -PlanPath $planFull -Owner $entry.owner -Claim
        } catch {
            $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = 'Entry admission refused by continuation engine.'; nextTrigger = 'readiness-change' }
            continue
        }

        if ($claimOutcome.status -ne 'READY' -and $claimOutcome.status -ne 'CLAIMED') {
            $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = "Continuation step status '$($claimOutcome.status)' is not READY/CLAIMED."; nextTrigger = $null }
            continue
        }

        if ($claimOutcome.claimResult -ne 'NEW_CLAIM') {
            $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = "Claim not newly acquired (claimResult=$($claimOutcome.claimResult)); pending reconciliation, no redispatch."; nextTrigger = 'claim-ack-reconciliation' }
            continue
        }

        $route = if ($entry.provider -eq 'independent') { 'independent' } else { $routeDecision.route }
        $selected = [PSCustomObject]@{
            id       = $entry.id
            owner    = $entry.owner
            provider = $entry.provider
            route    = $route
            claimId  = $claimOutcome.claimId
            intentId = $claimOutcome.intentId
            kind     = $claimOutcome.kind
            receiptSha = $claimOutcome.receiptSha
            planSha    = $claimOutcome.planSha
            statePath  = $claimOutcome.statePath
        }
        $perEntry += [PSCustomObject]@{ id = $entry.id; owner = $entry.owner; reason = 'Selected via NEW_CLAIM.'; nextTrigger = $null }
    }

    if ($null -ne $selected) {
        $decision = [PSCustomObject]@{
            status      = 'SELECTED'
            selected    = $selected
            perEntry    = $perEntry
            owner       = $selected.owner
            nextTrigger = $null
            reason      = $null
        }
        Write-HostContinuationDecision -StateDir $stateDirFull -Decision $decision | Out-Null
        return $decision
    }

    $pendingReconciliation = $perEntry | Where-Object { $_.nextTrigger -eq 'claim-ack-reconciliation' } | Select-Object -First 1
    $fallbackTrigger = if ($pendingReconciliation) { 'claim-ack-reconciliation' } elseif ($routeDecision.nextTrigger) { $routeDecision.nextTrigger } else { 'next-dispatch-or-quota-change' }
    $fallbackReason = if ($perEntry.Count -gt 0) { 'No eligible entry; see perEntry for individual reasons.' } else { 'Queue has no entries.' }
    $decision = [PSCustomObject]@{
        status      = 'NO_ELIGIBLE'
        selected    = $null
        perEntry    = $perEntry
        owner       = $Owner
        nextTrigger = $fallbackTrigger
        reason      = $fallbackReason
    }
    Write-HostContinuationDecision -StateDir $stateDirFull -Decision $decision | Out-Null
    return $decision
}

function Write-HostContinuationDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$Decision
    )

    $stateDirFull = [System.IO.Path]::GetFullPath($StateDir)
    if (-not (Test-Path -LiteralPath $stateDirFull -PathType Container)) {
        New-Item -ItemType Directory -Path $stateDirFull -Force | Out-Null
    }
    $decisionPath = Join-Path $stateDirFull 'host-continuation-decision.json'
    $lockPath = Join-Path $stateDirFull 'host-continuation-decision.lock'

    $fs = $null
    $deadline = (Get-Date).AddSeconds(2)
    while ($null -eq $fs) {
        try {
            $fs = [System.IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch {
            if ((Get-Date) -ge $deadline) { throw "Could not acquire host-continuation decision lock within 2s." }
            Start-Sleep -Milliseconds 25
        }
    }
    try {
        $record = [PSCustomObject]@{
            schema      = 'host-continuation-decision/v1'
            recordedAt  = (Get-Date).ToUniversalTime().ToString('o')
            status      = $Decision.status
            owner       = $Decision.owner
            nextTrigger = $Decision.nextTrigger
            reason      = $Decision.reason
            selected    = $Decision.selected
            perEntry    = $Decision.perEntry
        }
        $tmpPath = Join-Path $stateDirFull ('host-continuation-decision.' + [Guid]::NewGuid().ToString('N') + '.tmp')
        ($record | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $tmpPath -NoNewline
        Move-Item -LiteralPath $tmpPath -Destination $decisionPath -Force
    } finally {
        $fs.Close()
    }
}

function Record-HostDispatchAcknowledgement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$SelectedClaim,
        [Parameter(Mandatory)][PSCustomObject]$Acknowledgement,
        [PSCustomObject]$ExecutionBinding
    )

    if ($null -eq $SelectedClaim -or $SelectedClaim -isnot [PSCustomObject]) { throw "SelectedClaim must be a non-null object." }
    foreach ($f in @('id', 'owner', 'claimId', 'intentId')) {
        if (-not ($SelectedClaim.PSObject.Properties.Name -contains $f) -or $SelectedClaim.$f -isnot [string] -or [string]::IsNullOrWhiteSpace($SelectedClaim.$f)) {
            throw "SelectedClaim.$f missing or not a nonblank string."
        }
    }
    if (-not ($SelectedClaim.PSObject.Properties.Name -contains 'receiptSha') -or $SelectedClaim.receiptSha -notmatch '^[0-9a-f]{64}$') { throw "SelectedClaim.receiptSha missing or not 64hex." }
    if (-not ($SelectedClaim.PSObject.Properties.Name -contains 'planSha') -or $SelectedClaim.planSha -notmatch '^[0-9a-f]{64}$') { throw "SelectedClaim.planSha missing or not 64hex." }

    if ($null -eq $Acknowledgement -or $Acknowledgement -isnot [PSCustomObject]) { throw "Acknowledgement must be a non-null object." }
    foreach ($f in @('claimId', 'owner', 'intentId', 'dispatchedAt')) {
        if (-not ($Acknowledgement.PSObject.Properties.Name -contains $f) -or $Acknowledgement.$f -isnot [string] -or [string]::IsNullOrWhiteSpace($Acknowledgement.$f)) {
            throw "Acknowledgement.$f missing or not a nonblank string."
        }
    }
    if ($Acknowledgement.claimId -cne $SelectedClaim.claimId) { throw "Acknowledgement.claimId does not match selected claim; refusing to record." }
    if ($Acknowledgement.owner -cne $SelectedClaim.owner) { throw "Acknowledgement.owner does not match selected claim; refusing to record." }
    if ($Acknowledgement.intentId -cne $SelectedClaim.intentId) { throw "Acknowledgement.intentId does not match selected claim; refusing to record." }
    $parsedDate = [DateTime]::MinValue
    if (-not [DateTime]::TryParse($Acknowledgement.dispatchedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedDate)) {
        throw "Acknowledgement.dispatchedAt is not a valid ISO date string."
    }

    $stateDirFullForCanonical = [System.IO.Path]::GetFullPath($StateDir)
    $canonicalStatePath = Join-Path $stateDirFullForCanonical 'continuation-state.json'
    $statePath = $SelectedClaim.statePath
    if ($statePath -isnot [string] -or [string]::IsNullOrWhiteSpace($statePath)) {
        throw "SelectedClaim.statePath missing; refusing to record."
    }
    if ([System.IO.Path]::GetFullPath($statePath) -cne $canonicalStatePath) {
        throw "SelectedClaim.statePath does not match canonical StateDir continuation-state.json; refusing to record."
    }
    if (-not (Test-Path -LiteralPath $canonicalStatePath -PathType Leaf)) {
        throw "Canonical continuation state file not found; refusing to record."
    }
    $stateRaw = Get-Content -LiteralPath $canonicalStatePath -Raw
    if ([string]::IsNullOrWhiteSpace($stateRaw)) { throw "Continuation state file is empty; refusing to record." }
    try { $state = $stateRaw | ConvertFrom-Json -DateKind String } catch { throw "Continuation state file is not valid JSON; refusing to record." }
    if ($null -eq $state -or $state -isnot [PSCustomObject] -or -not ($state.PSObject.Properties.Name -contains 'schema') -or $state.schema -isnot [string] -or $state.schema -cne 'continuation-state/v1' -or $null -eq $state.entries -or $state.entries -isnot [PSCustomObject]) {
        throw "Continuation state is malformed or has wrong schema; refusing to record."
    }
    $matchedEntry = $null
    foreach ($p in $state.entries.PSObject.Properties) {
        if ($p.Name -ceq $SelectedClaim.intentId) { $matchedEntry = $p.Value; break }
    }
    if ($null -eq $matchedEntry) { throw "No persisted continuation-state entry matches intentId; refusing to record." }
    if ($matchedEntry.status -ne 'CLAIMED' -or $null -eq $matchedEntry.claim) { throw "Persisted continuation-state entry is not CLAIMED; refusing to record." }
    if ($matchedEntry.claim.claimId -cne $SelectedClaim.claimId) { throw "Persisted claimId mismatch; refusing to record." }
    if ($matchedEntry.claim.owner -cne $SelectedClaim.owner) { throw "Persisted claim owner mismatch; refusing to record." }
    if ($matchedEntry.receiptSha256 -cne $SelectedClaim.receiptSha) { throw "Persisted receiptSha256 mismatch; refusing to record." }
    if ($matchedEntry.planSha256 -cne $SelectedClaim.planSha) { throw "Persisted planSha256 mismatch; refusing to record." }

    $decisionPathForAck = Join-Path $stateDirFullForCanonical 'host-continuation-decision.json'
    if (-not (Test-Path -LiteralPath $decisionPathForAck -PathType Leaf)) { throw "No persisted host-continuation decision; refusing to record." }
    $decisionRaw = Get-Content -LiteralPath $decisionPathForAck -Raw
    if ([string]::IsNullOrWhiteSpace($decisionRaw)) { throw "Host-continuation decision file is empty; refusing to record." }
    try { $decision = $decisionRaw | ConvertFrom-Json -DateKind String } catch { throw "Host-continuation decision file is not valid JSON; refusing to record." }
    if ($null -eq $decision -or $decision -isnot [PSCustomObject] -or -not ($decision.PSObject.Properties.Name -contains 'schema') -or $decision.schema -isnot [string] -or $decision.schema -cne 'host-continuation-decision/v1' -or $decision.status -ne 'SELECTED' -or $null -eq $decision.selected -or $decision.selected -isnot [PSCustomObject]) {
        throw "Persisted decision is not a valid SELECTED record or has wrong schema; refusing to record."
    }
    $ds = $decision.selected
    foreach ($f in @('id', 'intentId', 'claimId', 'owner', 'receiptSha', 'planSha', 'statePath')) {
        if (-not ($ds.PSObject.Properties.Name -contains $f) -or $ds.$f -isnot [string] -or [string]::IsNullOrWhiteSpace($ds.$f)) {
            throw "Persisted decision.selected.$f missing or not a nonblank string; refusing to record."
        }
    }
    if ($ds.id -cne $SelectedClaim.id -or $ds.intentId -cne $SelectedClaim.intentId -or $ds.claimId -cne $SelectedClaim.claimId -or $ds.owner -cne $SelectedClaim.owner -or $ds.receiptSha -cne $SelectedClaim.receiptSha -or $ds.planSha -cne $SelectedClaim.planSha) {
        throw "Persisted decision.selected does not match SelectedClaim; refusing to record."
    }
    if ([System.IO.Path]::GetFullPath($ds.statePath) -cne $canonicalStatePath) {
        throw "Persisted decision.selected.statePath does not match canonical state path; refusing to record."
    }

    if ($null -ne $ExecutionBinding) {
        Test-ExecutionBinding -Binding $ExecutionBinding
        if ($ExecutionBinding.receiptSha -cne $SelectedClaim.receiptSha) { throw "ExecutionBinding.receiptSha must match SelectedClaim.receiptSha." }
        if ($ExecutionBinding.planSha -cne $SelectedClaim.planSha) { throw "ExecutionBinding.planSha must match SelectedClaim.planSha." }
    }

    $stateDirFull = [System.IO.Path]::GetFullPath($StateDir)
    if (-not (Test-Path -LiteralPath $stateDirFull -PathType Container)) {
        New-Item -ItemType Directory -Path $stateDirFull -Force | Out-Null
    }
    $ackPath = Join-Path $stateDirFull 'host-dispatch-acknowledgements.json'
    $lockPath = Join-Path $stateDirFull 'host-dispatch-acknowledgements.lock'

    $fs = $null
    $deadline = (Get-Date).AddSeconds(2)
    while ($null -eq $fs) {
        try {
            $fs = [System.IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch {
            if ((Get-Date) -ge $deadline) { throw "Could not acquire dispatch acknowledgement lock within 2s." }
            Start-Sleep -Milliseconds 25
        }
    }
    try {
        $ackState = $null
        if (Test-Path -LiteralPath $ackPath -PathType Leaf) {
            $ackRaw = Get-Content -LiteralPath $ackPath -Raw
            if (-not [string]::IsNullOrWhiteSpace($ackRaw)) {
                try { $ackState = $ackRaw | ConvertFrom-Json -DateKind String } catch { throw "Corrupt acknowledgement file; refusing to proceed." }
            }
        }
        if (-not (Test-Path -LiteralPath $ackPath -PathType Leaf)) {
            $ackState = [PSCustomObject]@{ schema = 'host-dispatch-acknowledgement/v1'; acknowledgements = [PSCustomObject]@{} }
        }
        try {
            $ackHash = Test-HostDispatchAcknowledgementEnvelope -AckState $ackState
        } catch {
            throw "Existing acknowledgement file is empty, malformed, or has wrong schema/shape; refusing to overwrite. $($_.Exception.Message)"
        }

        $ackKey = "$($SelectedClaim.intentId)|$($SelectedClaim.claimId)"
        $existing = if ($ackHash.Contains($ackKey)) { $ackHash[$ackKey] } else { $null }
        if ($existing) {
            if ($existing.schema -cne 'host-dispatch-acknowledgement/v1' -or $existing.entryId -cne $SelectedClaim.id -or $existing.owner -cne $SelectedClaim.owner -or $existing.claimId -cne $SelectedClaim.claimId -or $existing.intentId -cne $SelectedClaim.intentId -or $existing.owner -cne $Acknowledgement.owner -or $existing.dispatchedAt -cne $Acknowledgement.dispatchedAt) {
                throw "A different acknowledgement already exists for this intent/claim; refusing to overwrite."
            }
            $existingBinding = if ($existing.PSObject.Properties.Name -contains 'executionBinding') { $existing.executionBinding } else { $null }
            $existingBindingJson = if ($null -ne $existingBinding) { ($existingBinding | ConvertTo-Json -Depth 20 -Compress) } else { $null }
            $newBindingJson = if ($null -ne $ExecutionBinding) { ($ExecutionBinding | ConvertTo-Json -Depth 20 -Compress) } else { $null }
            if ($existingBindingJson -cne $newBindingJson) {
                throw "An acknowledgement with a different executionBinding already exists for this intent/claim; replay may not alter binding."
            }
            return [PSCustomObject]@{
                schema           = 'host-dispatch-acknowledgement/v1'
                recordedAt       = $existing.recordedAt
                entryId          = $existing.entryId
                owner            = $existing.owner
                claimId          = $existing.claimId
                intentId         = $existing.intentId
                dispatchedAt     = $existing.dispatchedAt
                executionBinding = $existingBinding
            }
        }

        $record = [PSCustomObject]@{
            schema           = 'host-dispatch-acknowledgement/v1'
            recordedAt       = (Get-Date).ToUniversalTime().ToString('o')
            entryId          = $SelectedClaim.id
            owner            = $Acknowledgement.owner
            claimId          = $Acknowledgement.claimId
            intentId         = $SelectedClaim.intentId
            dispatchedAt     = $Acknowledgement.dispatchedAt
            executionBinding = $ExecutionBinding
        }
        $ackHash[$ackKey] = $record
        $ackState.acknowledgements = $ackHash
        $tmpPath = Join-Path $stateDirFull ('host-dispatch-acknowledgements.' + [Guid]::NewGuid().ToString('N') + '.tmp')
        ($ackState | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $tmpPath -NoNewline
        Move-Item -LiteralPath $tmpPath -Destination $ackPath -Force
        return $record
    } finally {
        $fs.Close()
    }
}

function Invoke-SettledHostContinuation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$PreviousSelectedClaim,
        [Parameter(Mandatory)][string]$TerminalReceiptPath,
        [Parameter(Mandatory)][string]$TerminalSha256,
        [Parameter(Mandatory)][string]$QueuePath,
        [Parameter(Mandatory)][string]$NormalQuotaPath,
        [string]$CloudQuotaPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner,
        [Parameter(Mandatory)][scriptblock]$Dispatch
    )

    # Settle the exact prior terminal first; validation errors propagate before selection or dispatch.
    $settlement = Complete-ContinuationClaim -StateDir $StateDir -SelectedClaim $PreviousSelectedClaim `
        -TerminalReceiptPath $TerminalReceiptPath -TerminalSha256 $TerminalSha256

    $readyArgs = @{
        QueuePath       = $QueuePath
        StateDir        = $StateDir
        NormalQuotaPath = $NormalQuotaPath
        Owner           = $Owner
    }
    if (-not [string]::IsNullOrWhiteSpace($CloudQuotaPath)) { $readyArgs['CloudQuotaPath'] = $CloudQuotaPath }
    $decision = Invoke-ReadyHostContinuation @readyArgs

    $status = $null
    if ($null -ne $decision -and $null -ne $decision.PSObject.Properties['status']) { $status = [string]$decision.status }

    if ($status -ne 'SELECTED') {
        $nextTrigger = $null
        if ($null -ne $decision -and $null -ne $decision.PSObject.Properties['nextTrigger']) { $nextTrigger = $decision.nextTrigger }
        return [PSCustomObject]@{
            status      = 'WAITING'
            dispatched  = $false
            settlement  = $settlement
            decision    = $decision
            nextTrigger = $nextTrigger
        }
    }

    $selected = $null
    if ($null -ne $decision.PSObject.Properties['selected']) { $selected = $decision.selected }
    $selectionValid = $selected -is [PSCustomObject]
    if ($selectionValid) {
        foreach ($field in @('id', 'owner', 'provider', 'route', 'claimId', 'intentId', 'kind', 'receiptSha', 'planSha', 'statePath')) {
            if ($null -eq $selected.PSObject.Properties[$field] -or $null -eq $selected.$field) { $selectionValid = $false; break }
        }
    }
    if ($selectionValid) {
        foreach ($field in @('id', 'owner', 'claimId', 'intentId')) {
            if ([string]::IsNullOrWhiteSpace([string]$selected.$field)) { $selectionValid = $false; break }
        }
    }
    if (-not $selectionValid) {
        return [PSCustomObject]@{
            status            = 'RECONCILIATION_REQUIRED'
            reason            = 'SELECTION_INVALID'
            dispatchAttempted = $false
            dispatched        = $false
            claimKept         = $true
            settlement        = $settlement
            decision          = $decision
        }
    }

    # Bounded status only: the new claim stays retained; no release, cancel, retry or synthesized success.
    $reconcile = {
        param([string]$Code)
        [PSCustomObject]@{
            status     = 'RECONCILIATION_REQUIRED'
            reason     = $Code
            dispatchAttempted = $true
            dispatched = $null
            claimKept  = $true
            settlement = $settlement
            decision   = $decision
        }
    }

    $result = $null
    try {
        $result = & $Dispatch $selected
    } catch {
        return (& $reconcile 'DISPATCH_CALLBACK_FAILED')
    }

    if ($result -isnot [PSCustomObject] `
        -or $null -eq $result.PSObject.Properties['Acknowledgement'] -or $null -eq $result.Acknowledgement `
        -or $null -eq $result.PSObject.Properties['ExecutionBinding'] -or $null -eq $result.ExecutionBinding) {
        return (& $reconcile 'DISPATCH_RESULT_INVALID')
    }

    $acknowledged = $null
    try {
        $acknowledged = Record-HostDispatchAcknowledgement -StateDir $StateDir -SelectedClaim $selected `
            -Acknowledgement $result.Acknowledgement -ExecutionBinding $result.ExecutionBinding
    } catch {
        return (& $reconcile 'ACKNOWLEDGEMENT_REJECTED')
    }

    return [PSCustomObject]@{
        status       = 'DISPATCHED'
        dispatched   = $true
        settlement   = $settlement
        decision     = $decision
        acknowledged = $acknowledged
    }
}

function Invoke-HostPublishedSupervisedTerminal {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$TerminalArguments,
        [Parameter(Mandatory)][string]$CheckpointPath,
        [Parameter(Mandatory)][string]$VaultPath,
        [Parameter(Mandatory)][string]$EvidenceRoot,
        [Parameter(Mandatory)][string]$QueuePath,
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$NormalQuotaPath,
        [string]$CloudQuotaPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner
    )

    $coreResult = Invoke-PublishedSupervisedTerminal -TerminalArguments $TerminalArguments -CheckpointPath $CheckpointPath -VaultPath $VaultPath -EvidenceRoot $EvidenceRoot

    $hostSelection = $null
    try {
        $hostSelection = Invoke-ReadyHostContinuation -QueuePath $QueuePath -StateDir $StateDir -NormalQuotaPath $NormalQuotaPath -CloudQuotaPath $CloudQuotaPath -Owner $Owner
    } catch {
        $hostSelection = [PSCustomObject]@{
            status      = 'NO_ELIGIBLE'
            selected    = $null
            perEntry    = @()
            owner       = $Owner
            nextTrigger = 'next-dispatch-or-quota-change'
            reason      = 'HOST_SELECTOR_FAILURE'
        }
        try {
            Write-HostContinuationDecision -StateDir $StateDir -Decision $hostSelection | Out-Null
        } catch {
        }
    }

    [PSCustomObject]@{
        coreResult    = $coreResult
        hostSelection = $hostSelection
    }
}

function Invoke-PublishedSettledHostContinuation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$TerminalArguments,
        [Parameter(Mandatory)][PSCustomObject]$PreviousSelectedClaim,
        [Parameter(Mandatory)][scriptblock]$Dispatch,
        [Parameter(Mandatory)][string]$CheckpointPath,
        [Parameter(Mandatory)][string]$VaultPath,
        [Parameter(Mandatory)][string]$EvidenceRoot,
        [Parameter(Mandatory)][string]$QueuePath,
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$NormalQuotaPath,
        [string]$CloudQuotaPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner
    )

    $mandatoryKeys = @('RawPath', 'TicketPath', 'UsagePath', 'RunId', 'Attempt', 'MaxAttempts', 'PriorElapsedMs', 'MaxElapsedMs', 'ReceiptPath')
    $adapterArgs = @{}
    foreach ($key in $mandatoryKeys) {
        if (-not $TerminalArguments.ContainsKey($key)) {
            return [PSCustomObject]@{
                status     = 'RECONCILIATION_REQUIRED'
                reason     = 'RECEIPT_INVALID'
                dispatched = $false
            }
        }
        $adapterArgs[$key] = $TerminalArguments[$key]
    }
    if ($TerminalArguments.ContainsKey('CompletedNativeEvidence')) {
        $adapterArgs['CompletedNativeEvidence'] = $TerminalArguments['CompletedNativeEvidence']
    }

    $adapterResult = $null
    try {
        $adapterResult = ConvertTo-TerminalReceipt @adapterArgs
    } catch {
        return [PSCustomObject]@{
            status     = 'RECONCILIATION_REQUIRED'
            reason     = 'RECEIPT_INVALID'
            dispatched = $false
        }
    }

    if ($adapterResult -isnot [PSCustomObject] -or $null -eq $adapterResult.PSObject.Properties['valid'] -or $adapterResult.valid -ne $true `
        -or $null -eq $adapterResult.PSObject.Properties['receiptPath'] -or [string]::IsNullOrWhiteSpace("$($adapterResult.receiptPath)") `
        -or $null -eq $adapterResult.PSObject.Properties['receiptSha256'] -or [string]::IsNullOrWhiteSpace("$($adapterResult.receiptSha256)")) {
        return [PSCustomObject]@{
            status     = 'RECONCILIATION_REQUIRED'
            reason     = 'RECEIPT_INVALID'
            dispatched = $false
        }
    }

    $coreResult = Invoke-SettledHostContinuation -StateDir $StateDir -PreviousSelectedClaim $PreviousSelectedClaim `
        -TerminalReceiptPath $adapterResult.receiptPath -TerminalSha256 $adapterResult.receiptSha256 `
        -QueuePath $QueuePath -NormalQuotaPath $NormalQuotaPath -CloudQuotaPath $CloudQuotaPath -Owner $Owner -Dispatch $Dispatch

    try {
        if (Test-Path -LiteralPath $CheckpointPath -PathType Leaf) {
            Invoke-RuntimeProjection -CheckpointPath $CheckpointPath -VaultPath $VaultPath -EvidenceRoot $EvidenceRoot | Out-Null
        }
    } catch { }

    return $coreResult
}
