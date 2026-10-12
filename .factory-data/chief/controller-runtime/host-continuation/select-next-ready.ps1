#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\projection\publish-runtime.ps1')
. (Join-Path $PSScriptRoot '..\dispatch\receipt-adapter.ps1')
. (Join-Path $PSScriptRoot 'backlog-projection.ps1')

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
        [Parameter(Mandatory)][AllowNull()]$CloudQuota,
        [AllowNull()]$RoutingPreference = 'NORMAL_FIRST'
    )
    if ($RoutingPreference -isnot [string] -or ($RoutingPreference -cne 'NORMAL_FIRST' -and $RoutingPreference -cne 'CLOUD_ONLY')) {
        return @{ route = $null; reason = 'routingPreference must be exactly NORMAL_FIRST or CLOUD_ONLY.'; nextTrigger = 'next-dispatch-or-quota-change' }
    }
    $normalCheck = Test-QuotaShape -Quota $NormalQuota -IsCloud $false
    if (-not $normalCheck.ok) {
        return @{ route = $null; reason = "Normal quota invalid: $($normalCheck.reason)"; nextTrigger = 'next-dispatch-or-quota-change' }
    }

    if ($RoutingPreference -ceq 'CLOUD_ONLY') {
        if ($null -eq $CloudQuota) {
            return @{ route = $null; reason = 'CLOUD_ONLY: no Cloud quota provided.'; nextTrigger = $NormalQuota.nextTrigger }
        }
        $cloudOnlyCheck = Test-QuotaShape -Quota $CloudQuota -IsCloud $true
        if (-not $cloudOnlyCheck.ok) {
            return @{ route = $null; reason = "CLOUD_ONLY: Cloud quota invalid: $($cloudOnlyCheck.reason)"; nextTrigger = $NormalQuota.nextTrigger }
        }
        if (-not $CloudQuota.verified -or -not $CloudQuota.eligible -or -not $CloudQuota.budgetCompliant -or -not $CloudQuota.promotionalOnly -or $CloudQuota.creditsEnabled) {
            return @{ route = $null; reason = 'CLOUD_ONLY: Cloud quota not verified/eligible/budgetCompliant/promotionalOnly with credits disabled.'; nextTrigger = $CloudQuota.nextTrigger }
        }
        return @{ route = 'cloud'; reason = 'CLOUD_ONLY: Cloud quota verified/fresh/eligible, budget-compliant, promotional-only, credits disabled.'; nextTrigger = $CloudQuota.nextTrigger }
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

function Get-HostAdmissionTable {
    [CmdletBinding()]
    param()

    $existing = Get-Variable -Name 'HostAdmissionHeld' -Scope Script -ErrorAction SilentlyContinue
    if ($null -eq $existing -or $existing.Value -isnot [hashtable]) {
        Set-Variable -Name 'HostAdmissionHeld' -Scope Script -Value @{}
        $existing = Get-Variable -Name 'HostAdmissionHeld' -Scope Script
    }
    return $existing.Value
}

function Assert-HostAdmissionPhase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string[]]$Phase
    )

    $table = Get-HostAdmissionTable
    $key = Get-HostAdmissionKey -StateDir $StateDir
    if (-not $table.ContainsKey($key)) {
        throw 'Host admission lease is not held for this StateDir; refusing internal operation.'
    }
    $entry = $table[$key]
    if ($Phase -cnotcontains $entry.Phase) {
        throw 'Host admission is in a protected phase that does not permit this internal operation; refusing.'
    }
    return $entry
}

function Invoke-HostAdmissionCallback {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][scriptblock]$Dispatch,
        [Parameter(Mandatory)]$Selected
    )

    $entry = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('ADMIT')
    $entry.Phase = 'CALLBACK'
    try {
        & $Dispatch $Selected
    } finally {
        $entry.Phase = 'ADMIT'
    }
}

function Test-HostSelectedTupleEqual {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Left,
        [Parameter(Mandatory)]$Right
    )

    foreach ($f in @('id', 'owner', 'provider', 'route', 'claimId', 'intentId', 'kind', 'receiptSha', 'planSha', 'statePath')) {
        if ($null -eq $Left.PSObject.Properties[$f] -or $null -eq $Right.PSObject.Properties[$f]) { return $false }
        if ($Left.$f -isnot [string] -or $Right.$f -isnot [string]) { return $false }
        if ($f -ceq 'statePath') {
            if ([System.IO.Path]::GetFullPath($Left.$f) -cne [System.IO.Path]::GetFullPath($Right.$f)) { return $false }
        } elseif ($Left.$f -cne $Right.$f) {
            return $false
        }
    }
    return $true
}

function Get-HostAdmissionKey {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateDir)

    return [System.IO.Path]::GetFullPath($StateDir).TrimEnd([char]92, [char]47).ToLowerInvariant()
}

function Enter-HostAdmissionLease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [int]$WaitMilliseconds = 30000
    )

    $table = Get-HostAdmissionTable
    $stateDirFull = [System.IO.Path]::GetFullPath($StateDir)
    $key = Get-HostAdmissionKey -StateDir $StateDir
    if ($table.ContainsKey($key)) {
        throw 'Host admission is already held in this process for this StateDir; refusing reentrant admission.'
    }
    if (-not (Test-Path -LiteralPath $stateDirFull -PathType Container)) {
        New-Item -ItemType Directory -Path $stateDirFull -Force | Out-Null
    }
    $lockPath = Join-Path $stateDirFull 'host-continuation-admission.lock'
    $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
    while ($true) {
        $fs = $null
        try {
            $fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw 'Timed out waiting for the host admission lease; refusing without mutation.'
            }
            Start-Sleep -Milliseconds 50
            continue
        }
        $table[$key] = [PSCustomObject]@{ Stream = $fs; Phase = 'ADMIT' }
        return $key
    }
}

function Exit-HostAdmissionLease {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Key)

    $table = Get-HostAdmissionTable
    if (-not $table.ContainsKey($Key)) { return }
    if ($table[$Key].Phase -ceq 'CALLBACK') {
        throw 'Host admission lease cannot be released during the dispatch callback; refusing.'
    }
    $held = $table[$Key]
    $table.Remove($Key)
    try { $held.Stream.Close() } catch { }
}

function Get-HostPendingSelection {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StateDir)

    $stateDirFull = [System.IO.Path]::GetFullPath($StateDir)
    $decisionPath = Join-Path $stateDirFull 'host-continuation-decision.json'
    if (-not (Test-Path -LiteralPath $decisionPath -PathType Leaf)) { return $null }
    $raw = Get-Content -LiteralPath $decisionPath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'Host-continuation decision evidence is empty; failing closed.' }
    try { $dec = $raw | ConvertFrom-Json -DateKind String } catch { throw 'Host-continuation decision evidence is not valid JSON; failing closed.' }
    if ($null -eq $dec -or $dec -isnot [PSCustomObject] -or $null -eq $dec.PSObject.Properties['status'] -or $dec.status -isnot [string] -or [string]::IsNullOrWhiteSpace($dec.status) -or $null -eq $dec.PSObject.Properties['schema'] -or $dec.schema -isnot [string] -or $dec.schema -cne 'host-continuation-decision/v1') {
        throw 'Host-continuation decision evidence is malformed; failing closed.'
    }
    if ($dec.status -cne 'SELECTED' -and $dec.status -cne 'NO_ELIGIBLE') {
        throw 'Host-continuation decision has an unknown status; failing closed.'
    }
    if ($dec.status -cne 'SELECTED') { return $null }
    if ($null -eq $dec.PSObject.Properties['schema'] -or $dec.schema -isnot [string] -or $dec.schema -cne 'host-continuation-decision/v1') {
        throw 'Host-continuation SELECTED decision has wrong schema; failing closed.'
    }
    $sel = $dec.selected
    if ($null -eq $sel -or $sel -isnot [PSCustomObject]) { throw 'Host-continuation SELECTED decision has no selected object; failing closed.' }
    foreach ($f in @('id', 'owner', 'provider', 'route', 'claimId', 'intentId', 'kind', 'receiptSha', 'planSha', 'statePath')) {
        if ($null -eq $sel.PSObject.Properties[$f] -or $sel.$f -isnot [string] -or [string]::IsNullOrWhiteSpace($sel.$f)) {
            throw 'Host-continuation SELECTED decision.selected is malformed; failing closed.'
        }
    }
    if ([System.IO.Path]::GetFullPath($sel.statePath) -cne [System.IO.Path]::GetFullPath((Join-Path $stateDirFull 'continuation-state.json'))) {
        throw 'Host-continuation SELECTED decision.selected.statePath is not the canonical state path; failing closed.'
    }
    $ackPath = Join-Path $stateDirFull 'host-dispatch-acknowledgements.json'
    if (Test-Path -LiteralPath $ackPath -PathType Leaf) {
        $ackRaw = Get-Content -LiteralPath $ackPath -Raw
        try { $ackState = $ackRaw | ConvertFrom-Json -DateKind String } catch { throw 'Acknowledgement evidence is not valid JSON; failing closed.' }
        $ackHash = Test-HostDispatchAcknowledgementEnvelope -AckState $ackState
        $ackKey = $sel.intentId + '|' + $sel.claimId
        if ($ackHash.Contains($ackKey)) {
            $a = $ackHash[$ackKey]
            if ($a.schema -cne 'host-dispatch-acknowledgement/v1' -or $a.entryId -cne $sel.id -or $a.owner -cne $sel.owner -or $a.claimId -cne $sel.claimId -or $a.intentId -cne $sel.intentId) {
                throw 'Acknowledgement evidence for the selected claim is inconsistent with the decision; failing closed.'
            }
            if ($null -ne $a.PSObject.Properties['executionBinding'] -and $null -ne $a.executionBinding) {
                Test-ExecutionBinding -Binding $a.executionBinding
                if ($a.executionBinding.receiptSha -cne $sel.receiptSha -or $a.executionBinding.planSha -cne $sel.planSha) {
                    throw 'Acknowledgement executionBinding does not match the selected decision; failing closed.'
                }
            }
            return $null
        }
    }
    return $dec
}

function Assert-HostDecisionWriteAllowed {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$Decision
    )

    $pending = Get-HostPendingSelection -StateDir $StateDir
    if ($null -eq $pending) { return }
    $same = $null -ne $Decision.PSObject.Properties['status'] -and $Decision.status -ceq 'SELECTED' `
        -and $Decision.selected -is [PSCustomObject] `
        -and (Test-HostSelectedTupleEqual -Left $Decision.selected -Right $pending.selected) -and $Decision.selected.claimId -ceq $pending.selected.claimId `
        -and $Decision.selected.intentId -ceq $pending.selected.intentId
    if (-not $same) {
        throw 'A genuine unacknowledged SELECTED decision is pending; refusing to overwrite it.'
    }
}

. (Join-Path $PSScriptRoot 'allocation-context-capture.ps1')

function Invoke-ReadyHostContinuation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$QueuePath,
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$NormalQuotaPath,
        [string]$CloudQuotaPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner,
        [AllowNull()][object]$AllocationContexts
    )

    $forward = @{}
    foreach ($k in $PSBoundParameters.Keys) { $forward[$k] = $PSBoundParameters[$k] }
    if ($PSBoundParameters.ContainsKey('AllocationContexts')) {
        if ($null -eq $PSBoundParameters['AllocationContexts']) {
            throw 'AllocationContexts must not be null when supplied.'
        }
        $forward['AllocationContexts'] = Get-HostAllocationContextsCapture -AllocationContexts $PSBoundParameters['AllocationContexts'] -StateDir $StateDir
    }

    $leaseKey = Enter-HostAdmissionLease -StateDir $StateDir
    try {
        return (Invoke-ReadyHostContinuationAdmitted @forward)
    } finally {
        Exit-HostAdmissionLease -Key $leaseKey
    }
}

function Invoke-ReadyHostContinuationAdmitted {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$QueuePath,
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$NormalQuotaPath,
        [string]$CloudQuotaPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner,
        [AllowNull()][object]$AllocationContexts
    )

    $forward = @{}
    foreach ($k in $PSBoundParameters.Keys) { $forward[$k] = $PSBoundParameters[$k] }
    if ($PSBoundParameters.ContainsKey('AllocationContexts')) {
        if ($null -eq $PSBoundParameters['AllocationContexts']) {
            throw 'AllocationContexts must not be null when supplied.'
        }
        $forward['AllocationContexts'] = Get-HostAllocationContextsCapture -AllocationContexts $PSBoundParameters['AllocationContexts'] -StateDir $StateDir
    }

    $key =Get-HostAdmissionKey -StateDir $StateDir
    $admitEntry = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('ADMIT')
    if ($null -eq $admitEntry) {
        throw 'Host admission lease is not held; refusing selection.'
    }
    $pending = Get-HostPendingSelection -StateDir $StateDir
    if ($null -ne $pending) {
        return [PSCustomObject]@{
            status      = 'NO_ELIGIBLE'
            selected    = $null
            perEntry    = @()
            owner       = $Owner
            nextTrigger = 'next-dispatch-or-quota-change'
            reason      = 'PENDING_UNACKNOWLEDGED_SELECTION'
        }
    }
    $held = $admitEntry
    $held.Phase = 'SELECT'
    try {
        return (Invoke-ReadyHostContinuationLocked @forward)
    } finally {
        $held.Phase = 'ADMIT'
    }
}

function Invoke-ReadyHostContinuationLocked {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$QueuePath,
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$NormalQuotaPath,
        [string]$CloudQuotaPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner,
        [AllowNull()][object]$AllocationContexts
    )

    $forward = @{}
    foreach ($k in $PSBoundParameters.Keys) { $forward[$k] = $PSBoundParameters[$k] }
    if ($PSBoundParameters.ContainsKey('AllocationContexts')) {
        if ($null -eq $PSBoundParameters['AllocationContexts']) {
            throw 'AllocationContexts must not be null when supplied.'
        }
        $forward['AllocationContexts'] = Get-HostAllocationContextsCapture -AllocationContexts $PSBoundParameters['AllocationContexts'] -StateDir $StateDir
    }

    $null = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('SELECT')
    return (Invoke-ReadyHostContinuationLockedCore @forward)
}

function Invoke-ReadyHostContinuationLockedCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$QueuePath,
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$NormalQuotaPath,
        [string]$CloudQuotaPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner,
        [AllowNull()][object]$AllocationContexts
    )

    $allocationCapture = $null
    $allocationContextsSupplied = $PSBoundParameters.ContainsKey('AllocationContexts')
    if ($allocationContextsSupplied) {
        if ($null -eq $AllocationContexts) { throw 'AllocationContexts must not be null.' }
        $allocationCapture = Get-HostAllocationContextsCapture -StateDir $StateDir -AllocationContexts $AllocationContexts
    }

    $null = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('SELECT')

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

    $routingPreference = 'NORMAL_FIRST'
    if ($normalQuota -is [PSCustomObject] -and ($normalQuota.PSObject.Properties.Name -contains 'routingPreference')) {
        $routingPreference = $normalQuota.routingPreference
    }
    $routeDecision = Resolve-RouteDecision -NormalQuota $normalQuota -CloudQuota $cloudQuota -RoutingPreference $routingPreference
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
            $stepArgs = @{ StateDir = $stateDirFull; ReceiptPath = $receiptFull; PlanPath = $planFull; Owner = $entry.owner; Claim = $true }
            if ($allocationContextsSupplied) {
                $matchedContexts = @($allocationCapture | Where-Object { [string]::Equals($_.EntryId, $entry.id, [StringComparison]::Ordinal) })
                if ($matchedContexts.Count -gt 1) { throw 'Duplicate allocation context for entry.' }
                if ($matchedContexts.Count -eq 1) {
                    $ctx = $matchedContexts[0]
                    $stepArgs['AllocationSnapshot'] = $ctx.AllocationSnapshot
                    $stepArgs['ExpectedAllocationOrigin'] = $ctx.ExpectedAllocationOrigin
                    $stepArgs['NextTicketPath'] = $ctx.NextTicketPath
                    $stepArgs['NextPayloadPath'] = $ctx.NextPayloadPath
                    $stepArgs['ExpectedAllocationTarget'] = $ctx.ExpectedAllocationTarget
                }
            }
            $claimOutcome = Invoke-ContinuationStep @stepArgs
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

    $key = Get-HostAdmissionKey -StateDir $StateDir
    if ((Get-HostAdmissionTable).ContainsKey($key)) {
        if ((Get-HostAdmissionTable)[$key].Phase -ceq 'SELECT') {
            return (Write-HostContinuationDecisionLocked @PSBoundParameters)
        }
        throw 'Host admission is already held in this process for this StateDir; refusing reentrant decision write.'
    }
    $leaseKey = Enter-HostAdmissionLease -StateDir $StateDir
    try {
        $writeEntry = (Get-HostAdmissionTable)[$leaseKey]
        $writeEntry.Phase = 'WRITE'
        Assert-HostDecisionWriteAllowed -StateDir $StateDir -Decision $Decision
        return (Write-HostContinuationDecisionLocked @PSBoundParameters)
    } finally {
        Exit-HostAdmissionLease -Key $leaseKey
    }
}

function Write-HostContinuationDecisionLocked {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$Decision
    )

    $null = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('SELECT', 'WRITE')
    return (Write-HostContinuationDecisionLockedCore @PSBoundParameters)
}

function Write-HostContinuationDecisionLockedCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$Decision
    )

    $null = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('SELECT', 'WRITE')

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

    $leaseKey = Enter-HostAdmissionLease -StateDir $StateDir
    try {
        return (Record-HostDispatchAcknowledgementLocked @PSBoundParameters)
    } finally {
        Exit-HostAdmissionLease -Key $leaseKey
    }
}

function Record-HostDispatchAcknowledgementLocked {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$SelectedClaim,
        [Parameter(Mandatory)][PSCustomObject]$Acknowledgement,
        [PSCustomObject]$ExecutionBinding
    )

    $null = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('ADMIT')
    return (Record-HostDispatchAcknowledgementLockedCore @PSBoundParameters)
}

function Record-HostDispatchAcknowledgementLockedCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$SelectedClaim,
        [Parameter(Mandatory)][PSCustomObject]$Acknowledgement,
        [PSCustomObject]$ExecutionBinding
    )

    $null = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('ADMIT')

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
        [Parameter(Mandatory)][scriptblock]$Dispatch,
        [AllowNull()][object]$AllocationContexts
    )

    $boundArgs = @{} + $PSBoundParameters
    if ($PSBoundParameters.ContainsKey('AllocationContexts')) {
        $boundArgs['AllocationContexts'] = Get-HostAllocationContextsCapture -StateDir $StateDir -AllocationContexts $AllocationContexts
    }

    $leaseKey = Enter-HostAdmissionLease -StateDir $StateDir
    try {
        return (Invoke-SettledHostContinuationAdmitted @boundArgs)
    } finally {
        Exit-HostAdmissionLease -Key $leaseKey
    }
}

function Invoke-SettledHostContinuationAdmitted {
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
        [Parameter(Mandatory)][scriptblock]$Dispatch,
        [AllowNull()][object]$AllocationContexts
    )

    $boundArgs = @{} + $PSBoundParameters
    if ($PSBoundParameters.ContainsKey('AllocationContexts')) {
        $boundArgs['AllocationContexts'] = Get-HostAllocationContextsCapture -StateDir $StateDir -AllocationContexts $AllocationContexts
    }

    $null = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('ADMIT')
    return (Invoke-SettledHostContinuationAdmittedCore @boundArgs)
}

function Invoke-SettledHostContinuationAdmittedCore {
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
        [Parameter(Mandatory)][scriptblock]$Dispatch,
        [AllowNull()][object]$AllocationContexts
    )

    $allocationContextsCapture = $null
    if ($PSBoundParameters.ContainsKey('AllocationContexts')) {
        $allocationContextsCapture = Get-HostAllocationContextsCapture -StateDir $StateDir -AllocationContexts $AllocationContexts
    }

    $null = Assert-HostAdmissionPhase -StateDir $StateDir -Phase @('ADMIT')

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
    if ($PSBoundParameters.ContainsKey('AllocationContexts')) { $readyArgs['AllocationContexts'] = $allocationContextsCapture }
    $decision = Invoke-ReadyHostContinuationAdmitted @readyArgs

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
        $result = Invoke-HostAdmissionCallback -StateDir $StateDir -Dispatch $Dispatch -Selected $selected
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
        $acknowledged = Record-HostDispatchAcknowledgementLocked -StateDir $StateDir -SelectedClaim $selected `
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
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner,
        [scriptblock]$PostCoreStateProducer,
        [hashtable]$LocalSyncConfig,
        [hashtable]$GitHubSyncConfig,
        [AllowNull()][object]$AllocationContexts,
        [AllowNull()][object]$BacklogSnapshot
    )

    # Supplied backlog snapshot is validated and cloned once, before any adapter/producer/core/file I/O; only the clone is forwarded.
    $capBacklog = $PSBoundParameters.ContainsKey('BacklogSnapshot')
    $backlogCapture = $null
    if ($capBacklog) {
        if (-not $PSBoundParameters.ContainsKey('PostCoreStateProducer') -or $null -eq $PostCoreStateProducer) {
            return [PSCustomObject]@{
                status     = 'RECONCILIATION_REQUIRED'
                reason     = 'BACKLOG_PRODUCER_REQUIRED'
                dispatched = $false
            }
        }
        try {
            if ($null -eq $BacklogSnapshot) { throw 'null' }
            Resolve-BacklogDependencyProjection $BacklogSnapshot | Out-Null
            $backlogJson = ConvertTo-Json -InputObject $BacklogSnapshot -Depth 100 -Compress -WarningAction Stop
            $backlogCapture = ConvertFrom-Json -InputObject $backlogJson -NoEnumerate -DateKind String -Depth 100 -WarningAction Stop
            Resolve-BacklogDependencyProjection $backlogCapture | Out-Null
        } catch {
            return [PSCustomObject]@{
                status     = 'RECONCILIATION_REQUIRED'
                reason     = 'BACKLOG_SNAPSHOT_INVALID'
                dispatched = $false
            }
        }
    }

    # Supplied allocation contexts are captured once, directly, before any preflight/adapter/producer/file I/O.
    $capAlloc = $PSBoundParameters.ContainsKey('AllocationContexts')
    $allocCapture = $null
    if ($capAlloc) {
        if ($null -eq $AllocationContexts) {
            return [PSCustomObject]@{
                status     = 'RECONCILIATION_REQUIRED'
                reason     = 'ALLOCATION_CONTEXTS_INVALID'
                dispatched = $false
            }
        }
        try { $allocCapture = Get-HostAllocationContextsCapture -StateDir $StateDir -AllocationContexts $AllocationContexts } catch {
            return [PSCustomObject]@{
                status     = 'RECONCILIATION_REQUIRED'
                reason     = 'ALLOCATION_CONTEXTS_INVALID'
                dispatched = $false
            }
        }
    }

    # Optional post-core publication. All absent => exact legacy behavior and return shape.
    # Producer identity and configs are validated and frozen to primitives BEFORE core/Dispatch runs.
    # Presence is captured from the OUTER function's bound parameters; the dot-sourced block below sees a reset $PSBoundParameters.
    $capProducer = $PSBoundParameters.ContainsKey('PostCoreStateProducer')
    $capLocal = $PSBoundParameters.ContainsKey('LocalSyncConfig')
    $capGh = $PSBoundParameters.ContainsKey('GitHubSyncConfig')
    $optIn = $capProducer -or $capLocal -or $capGh
    $producer = $null; $hasLocal = $false; $hasGh = $false; $fLocalDir = $null; $fGh = $null
    $pubCheckpoint = $null; $pubVault = $null; $pubEvidence = $null; $preRefusal = $null
    if ($optIn) {
        # Preflight is dot-sourced so its 'return' only exits the validation block, never the outer caller.
        # A refusal is captured as a bounded code and appended to the genuine core result after core runs.
        $refuse = { param([string]$Code) $Code }
        $preCode = $null
        try { $preCode = . {
        if (-not $capProducer -or $null -eq $PostCoreStateProducer) { return (& $refuse 'STATE_PRODUCER_REQUIRED') }
        $producer = $PostCoreStateProducer
        if ($capLocal) {
            $lc = $LocalSyncConfig
            if ($null -eq $lc -or $lc.Keys.Count -ne 1 -or -not $lc.ContainsKey('StateDir') -or $lc['StateDir'] -isnot [string] -or [string]::IsNullOrWhiteSpace($lc['StateDir'])) { return (& $refuse 'SYNC_CONFIG_INVALID') }
            $fLocalDir = [string]$lc['StateDir']; $hasLocal = $true
        }
        if ($capGh) {
            $g = $GitHubSyncConfig
            if ($null -eq $g) { return (& $refuse 'SYNC_CONFIG_INVALID') }
            foreach ($k in @($g.Keys)) { if ($k -isnot [string] -or $k -cnotin @('Mapping', 'StateDir', 'PublicStatus', 'NextAction', 'Transport')) { return (& $refuse 'SYNC_CONFIG_INVALID') } }
            foreach ($k in @('Mapping', 'StateDir', 'PublicStatus', 'NextAction')) { if (-not $g.ContainsKey($k)) { return (& $refuse 'SYNC_CONFIG_INVALID') } }
            $m = $g['Mapping']
            if ($m -isnot [hashtable] -or $m.Keys.Count -ne 4) { return (& $refuse 'SYNC_CONFIG_INVALID') }
            foreach ($k in @('taskId', 'repo', 'stableMarker')) { if (-not $m.ContainsKey($k) -or $m[$k] -isnot [string]) { return (& $refuse 'SYNC_CONFIG_INVALID') } }
            if (-not $m.ContainsKey('issueNumber') -or ($m['issueNumber'] -isnot [int] -and $m['issueNumber'] -isnot [long])) { return (& $refuse 'SYNC_CONFIG_INVALID') }
            if ($m['taskId'] -notmatch '^[A-Za-z0-9._:-]{1,128}$' -or $m['repo'] -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$' -or $m['stableMarker'] -notmatch '^[A-Za-z0-9._-]{1,128}$' -or $m['issueNumber'] -lt 1 -or $m['issueNumber'] -gt 2147483647) { return (& $refuse 'SYNC_CONFIG_INVALID') }
            if ($g['StateDir'] -isnot [string] -or [string]::IsNullOrWhiteSpace($g['StateDir'])) { return (& $refuse 'SYNC_CONFIG_INVALID') }
            if ($g['PublicStatus'] -isnot [string] -or $g['PublicStatus'] -cnotin @('IN_PROGRESS', 'WAITING_FOR_REVIEW', 'BLOCKED', 'ACCEPTED_SCOPED')) { return (& $refuse 'SYNC_CONFIG_INVALID') }
            if ($g['NextAction'] -isnot [string] -or $g['NextAction'] -cnotin @('RUN_FOCUSED_CHECKS', 'INDEPENDENT_REVIEW', 'RESUME_AUTHORIZED_WORK', 'WAIT_FOR_DEPENDENCY')) { return (& $refuse 'SYNC_CONFIG_INVALID') }
            $ghTransport = $null
            if ($g.ContainsKey('Transport') -and $null -ne $g['Transport']) {
                if ($g['Transport'] -isnot [scriptblock]) { return (& $refuse 'SYNC_CONFIG_INVALID') }
                $ghTransport = $g['Transport']
            }
            $fGh = @{ taskId = [string]$m['taskId']; repo = [string]$m['repo']; issueNumber = [long]$m['issueNumber']; stableMarker = [string]$m['stableMarker']; StateDir = [string]$g['StateDir']; PublicStatus = [string]$g['PublicStatus']; NextAction = [string]$g['NextAction']; Transport = $ghTransport }
            $hasGh = $true
        }
        $pubCheckpoint = [string]$CheckpointPath; $pubVault = [string]$VaultPath; $pubEvidence = [string]$EvidenceRoot
        } } catch { $preCode = 'SYNC_CONFIG_INVALID' }
        if ($null -ne $preCode) { $preRefusal = [string]$preCode; $producer = $null; $hasLocal = $false; $hasGh = $false }
    }

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

    $settledArgs = @{
        StateDir              = $StateDir
        PreviousSelectedClaim = $PreviousSelectedClaim
        TerminalReceiptPath   = $adapterResult.receiptPath
        TerminalSha256        = $adapterResult.receiptSha256
        QueuePath             = $QueuePath
        NormalQuotaPath       = $NormalQuotaPath
        CloudQuotaPath        = $CloudQuotaPath
        Owner                 = $Owner
        Dispatch              = $Dispatch
    }
    if ($capAlloc) { $settledArgs['AllocationContexts'] = $allocCapture }
    $coreResult = Invoke-SettledHostContinuation @settledArgs

    if (-not $optIn) {
        try {
            if (Test-Path -LiteralPath $CheckpointPath -PathType Leaf) {
                Invoke-RuntimeProjection -CheckpointPath $CheckpointPath -VaultPath $VaultPath -EvidenceRoot $EvidenceRoot | Out-Null
            }
        } catch { }

        return $coreResult
    }

    # Opt-in: the explicit trusted producer runs once with the ACTUAL core result; the accepted publisher
    # then runs once with only the present sink configs. No additional direct projector call.
    $bs = { param($v) try { $t = [string]$v; if ($t.Length -gt 64) { $t.Substring(0, 64) } else { $t } } catch { '' } }
    $pv = { param($o, $n) try { $p = $o.PSObject.Properties[$n]; if ($null -ne $p) { & $bs $p.Value } else { $null } } catch { $null } }
    $sink = {
        param($s)
        if ($null -eq $s) { return $null }
        try { [PSCustomObject]@{ status = (& $pv $s 'status'); code = (& $pv $s 'code'); delivered = [bool](& $pv $s 'delivered' | ForEach-Object { $_ -eq 'True' }); replay = [bool](& $pv $s 'replay' | ForEach-Object { $_ -eq 'True' }) } } catch { $null }
    }
    $po = { param($o, $n) try { $p = $o.PSObject.Properties[$n]; if ($null -ne $p) { $p.Value } else { $null } } catch { $null } }
    $pub = $null
    $produced = $null
    $stateOk = $false
    if ($null -ne $preRefusal) {
        $pub = [PSCustomObject]@{ status = 'REFUSED'; code = $preRefusal }
    } else {
        try {
            $out = @(& $producer $coreResult)
            if ($out.Count -eq 1 -and ($out[0] -is [System.Collections.IDictionary] -or $out[0] -is [PSCustomObject])) { $produced = $out[0]; $stateOk = $true }
        } catch { $pub = [PSCustomObject]@{ status = 'REFUSED'; code = 'STATE_PRODUCER_FAILED' } }
        if ($null -eq $pub -and -not $stateOk) { $pub = [PSCustomObject]@{ status = 'REFUSED'; code = 'STATE_INVALID' } }
    }
    if ($null -eq $pub) {
        try {
            if (-not (Get-Command Publish-RuntimeCheckpoint -ErrorAction SilentlyContinue)) {
                . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'projection') 'publish-runtime.ps1')
            }
            $pubArgs = @{ State = $produced; CheckpointPath = $pubCheckpoint; VaultPath = $pubVault; EvidenceRoot = $pubEvidence }
            if ($capBacklog) { $pubArgs['BacklogSnapshot'] = $backlogCapture }
            if ($hasLocal) { $pubArgs['LocalSyncConfig'] = @{ StateDir = $fLocalDir } }
            if ($hasGh) {
                $ghCfg = @{
                    Mapping = @{ taskId = $fGh['taskId']; repo = $fGh['repo']; issueNumber = $fGh['issueNumber']; stableMarker = $fGh['stableMarker'] }
                    StateDir = $fGh['StateDir']; PublicStatus = $fGh['PublicStatus']; NextAction = $fGh['NextAction']
                }
                if ($null -ne $fGh['Transport']) { $ghCfg['Transport'] = $fGh['Transport'] }
                $pubArgs['GitHubSyncConfig'] = $ghCfg
            }
            $r = Publish-RuntimeCheckpoint @pubArgs
            $pub = [PSCustomObject]@{
                status = (& $pv $r 'status'); code = (& $pv $r 'code'); version = (& $pv $r 'version'); checkpointSha = (& $pv $r 'checkpointSha')
                local = (& $sink (& $po $r 'local')); github = (& $sink (& $po $r 'github'))
            }
        } catch { $pub = [PSCustomObject]@{ status = 'ERROR'; code = 'PUBLISH_ERROR' } }
    }
    try { $coreResult | Add-Member -NotePropertyName publication -NotePropertyValue $pub -Force } catch { }
    return $coreResult
}
