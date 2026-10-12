#Requires -Version 7.6
param(
    [string]$EvidenceRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
. (Join-Path $here 'select-next-ready.ps1')
$here = $PSScriptRoot

if (-not $EvidenceRoot) {
    $EvidenceRoot = Join-Path $here ("test-runs\run-" + [Guid]::NewGuid().ToString('N'))
}
$EvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null

$sourceReceiptPath = Join-Path $here '..\dispatch\receipts\watcher-06.json'
$sourceReceiptPath = [System.IO.Path]::GetFullPath($sourceReceiptPath)
$sourceReceiptRaw = Get-Content -LiteralPath $sourceReceiptPath -Raw
$sourceReceipt = $sourceReceiptRaw | ConvertFrom-Json -DateKind String

$script:results = @()
$script:failCount = 0

function Add-Result([string]$Group, [string]$Criterion, [string]$Observed, [string]$Outcome) {
    $script:results += [PSCustomObject]@{
        group     = $Group
        criterion = $Criterion
        observed  = $Observed
        outcome   = $Outcome
    }
    if ($Outcome -ne 'PASS') { $script:failCount++ }
}

function Assert-True([bool]$Condition, [string]$Group, [string]$Criterion, [string]$Observed) {
    Add-Result -Group $Group -Criterion $Criterion -Observed $Observed -Outcome ($(if ($Condition) { 'PASS' } else { 'FAIL' }))
}

function New-FixtureDir([string]$Tag) {
    $dir = Join-Path $EvidenceRoot ($Tag + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $dir
}

function New-Receipt([string]$Dir, [string]$RunId, [string]$TaskId) {
    $clone = $sourceReceiptRaw | ConvertFrom-Json -DateKind String
    $clone.runId = $RunId
    $clone.taskId = $TaskId
    $receiptPath = Join-Path $Dir ('receipt-' + $RunId + '.json')
    ($clone | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $receiptPath -NoNewline -Encoding utf8
    $sha = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [PSCustomObject]@{ Dir = $Dir; ReceiptPath = $receiptPath; Receipt = $clone; ReceiptSha = $sha }
}

function New-Plan2($case, [string]$Tag, [hashtable]$overrides) {
    $plan = [ordered]@{
        receiptSha256       = $case.ReceiptSha
        actionId            = "action-$Tag-$([Guid]::NewGuid().ToString('N'))"
        kind                = 'DIAGNOSE_REPLAN'
        ownedPaths          = @((Join-Path $case.Dir ('owned-' + $Tag)))
        failures            = 0
        diagnosisSha256     = $null
        dependenciesReady   = $true
        budgetKnown         = $true
        ownershipKnown      = $true
        quotaAllowed        = $true
        reviewDenied        = $false
        maxAdditionalOutput = $case.Receipt.budget.maxOutputTokens
        cumulativeOutput    = $case.Receipt.budget.usedOutputTokens
        aggregateCeiling    = $case.Receipt.budget.maxOutputTokens
    }
    foreach ($k in $overrides.Keys) { $plan[$k] = $overrides[$k] }
    $planPath = Join-Path $case.Dir ('plan-' + $Tag + '.json')
    ([PSCustomObject]$plan | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $planPath -NoNewline -Encoding utf8
    $planPath
}

function New-QueueFile([string]$Dir, [array]$Entries) {
    $queue = [PSCustomObject]@{
        schema  = 'version1'
        entries = $Entries
    }
    $queuePath = Join-Path $Dir 'queue.json'
    ($queue | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $queuePath -NoNewline -Encoding utf8
    $queuePath
}

function New-QuotaFile([string]$Path, [hashtable]$Fields) {
    $now = (Get-Date).ToUniversalTime()
    $base = [ordered]@{
        verified     = $true
        eligible     = $true
        reason       = 'ok'
        observedAt   = $now.ToString('o')
        freshUntilUtc = $now.AddHours(1).ToString('o')
        nextTrigger  = 'next-dispatch-or-quota-change'
    }
    foreach ($k in $Fields.Keys) { $base[$k] = $Fields[$k] }
    ([PSCustomObject]$base | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $Path -NoNewline -Encoding utf8
    $Path
}

function New-MalformedQuotaFile([string]$Path, [string]$Raw) {
    Set-Content -LiteralPath $Path -Value $Raw -NoNewline -Encoding utf8
    $Path
}

# ---------------------------------------------------------------------------
# Group A: Claude-blocked + independent eligible; missing/malformed normal quota
# ---------------------------------------------------------------------------
Write-Host "--- Group A: blocked Claude + independent disjoint ---"
$groupA = 'A-blocked-claude-plus-independent'

function Invoke-GroupACase([string]$Tag, [string]$NormalQuotaPath) {
    $dir = New-FixtureDir $Tag
    $rid1 = "watcher-06-$Tag-claude"
    $rid2 = "watcher-06-$Tag-indep"
    $c1 = New-Receipt -Dir $dir -RunId $rid1 -TaskId ("TASK-$Tag-CLAUDE")
    $c2 = New-Receipt -Dir $dir -RunId $rid2 -TaskId ("TASK-$Tag-INDEP")
    $plan1 = New-Plan2 $c1 'claude' @{}
    $plan2 = New-Plan2 $c2 'indep' @{}
    $stateDir = Join-Path $dir 'state'
    $queuePath = New-QueueFile $dir @(
        [PSCustomObject]@{ id = "$Tag-claude-entry"; receiptPath = $c1.ReceiptPath; planPath = $plan1; owner = "owner-$Tag-claude"; provider = 'claude'; enabled = $true },
        [PSCustomObject]@{ id = "$Tag-indep-entry"; receiptPath = $c2.ReceiptPath; planPath = $plan2; owner = "owner-$Tag-indep"; provider = 'independent'; enabled = $true }
    )
    $decision = Invoke-ReadyHostContinuation -QueuePath $queuePath -StateDir $stateDir -NormalQuotaPath $NormalQuotaPath -Owner "owner-$Tag"
    [PSCustomObject]@{ Decision = $decision; StateDir = $stateDir; ClaudeEntryId = "$Tag-claude-entry"; IndepEntryId = "$Tag-indep-entry" }
}

$normalUnavailableQuota = Join-Path (New-FixtureDir 'quota-unavail') 'normal-quota.json'
New-QuotaFile $normalUnavailableQuota @{ verified = $true; eligible = $false; reason = 'quota' } | Out-Null
$rA1 = Invoke-GroupACase 'a1' $normalUnavailableQuota
Assert-True ($rA1.Decision.status -eq 'SELECTED') $groupA 'normal-unavailable-quota-selects-independent' "status=$($rA1.Decision.status)"
Assert-True ($rA1.Decision.selected.id -eq $rA1.IndepEntryId) $groupA 'selected-is-independent-entry' "selectedId=$($rA1.Decision.selected.id)"
$claudePerEntryA1 = $rA1.Decision.perEntry | Where-Object { $_.id -eq $rA1.ClaudeEntryId }
Assert-True ($claudePerEntryA1.reason -notmatch 'Selected') $groupA 'claude-entry-not-consumed' "reason=$($claudePerEntryA1.reason)"
$ackFileA1 = Join-Path $rA1.StateDir 'host-continuation-decision.json'
Assert-True (Test-Path -LiteralPath $ackFileA1 -PathType Leaf) $groupA 'durable-selected-owner-persisted' "exists=$(Test-Path $ackFileA1)"

$missingNormalQuota = Join-Path (New-FixtureDir 'quota-missing') 'absent-normal-quota.json'
$rA2 = Invoke-GroupACase 'a2' $missingNormalQuota
Assert-True ($rA2.Decision.status -eq 'SELECTED' -and $rA2.Decision.selected.id -eq $rA2.IndepEntryId) $groupA 'missing-normal-quota-still-allows-independent' "status=$($rA2.Decision.status) selected=$($rA2.Decision.selected.id)"

$malformedNormalQuota = Join-Path (New-FixtureDir 'quota-malformed') 'malformed-normal-quota.json'
New-MalformedQuotaFile $malformedNormalQuota '{ not valid json' | Out-Null
$rA3 = Invoke-GroupACase 'a3' $malformedNormalQuota
Assert-True ($rA3.Decision.status -eq 'SELECTED' -and $rA3.Decision.selected.id -eq $rA3.IndepEntryId) $groupA 'malformed-normal-quota-still-allows-independent' "status=$($rA3.Decision.status) selected=$($rA3.Decision.selected.id)"

# invalid receipt ahead of valid independent candidate must not suppress latter
$dirA4 = New-FixtureDir 'a4'
$c4claude = New-Receipt -Dir $dirA4 -RunId 'watcher-06-a4-claude' -TaskId 'TASK-A4-CLAUDE'
$c4indep = New-Receipt -Dir $dirA4 -RunId 'watcher-06-a4-indep' -TaskId 'TASK-A4-INDEP'
$plan4claude = New-Plan2 $c4claude 'claude' @{}
$plan4indep = New-Plan2 $c4indep 'indep' @{}
$invalidReceiptPathA4 = Join-Path $dirA4 'invalid-receipt.json'
Set-Content -LiteralPath $invalidReceiptPathA4 -Value 'not json at all' -NoNewline -Encoding utf8
$stateDirA4 = Join-Path $dirA4 'state'
$queueA4 = New-QueueFile $dirA4 @(
    [PSCustomObject]@{ id = 'a4-invalid-entry'; receiptPath = $invalidReceiptPathA4; planPath = $plan4claude; owner = 'owner-a4-invalid'; provider = 'independent'; enabled = $true },
    [PSCustomObject]@{ id = 'a4-indep-entry'; receiptPath = $c4indep.ReceiptPath; planPath = $plan4indep; owner = 'owner-a4-indep'; provider = 'independent'; enabled = $true }
)
$decisionA4 = Invoke-ReadyHostContinuation -QueuePath $queueA4 -StateDir $stateDirA4 -NormalQuotaPath $missingNormalQuota -Owner 'owner-a4'
Assert-True ($decisionA4.status -eq 'SELECTED' -and $decisionA4.selected.id -eq 'a4-indep-entry') $groupA 'invalid-receipt-does-not-suppress-valid-independent' "status=$($decisionA4.status) selected=$($decisionA4.selected.id)"

# ---------------------------------------------------------------------------
# Group B: two disjoint ready candidates - cycle isolation + restart replay
# ---------------------------------------------------------------------------
Write-Host "--- Group B: disjoint candidates, restart replay ---"
$groupB = 'B-disjoint-cycles-restart'
$dirB = New-FixtureDir 'b1'
$cB1 = New-Receipt -Dir $dirB -RunId 'watcher-06-b1-first' -TaskId 'TASK-B1-FIRST'
$cB2 = New-Receipt -Dir $dirB -RunId 'watcher-06-b1-second' -TaskId 'TASK-B1-SECOND'
$planB1 = New-Plan2 $cB1 'first' @{}
$planB2 = New-Plan2 $cB2 'second' @{}
$stateDirB = Join-Path $dirB 'state'
$queueB = New-QueueFile $dirB @(
    [PSCustomObject]@{ id = 'b1-first-entry'; receiptPath = $cB1.ReceiptPath; planPath = $planB1; owner = 'owner-b1-first'; provider = 'independent'; enabled = $true },
    [PSCustomObject]@{ id = 'b1-second-entry'; receiptPath = $cB2.ReceiptPath; planPath = $planB2; owner = 'owner-b1-second'; provider = 'independent'; enabled = $true }
)
$normalQuotaB = Join-Path $dirB 'normal-quota.json'
New-QuotaFile $normalQuotaB @{} | Out-Null

$decisionB_cycle1 = Invoke-ReadyHostContinuation -QueuePath $queueB -StateDir $stateDirB -NormalQuotaPath $normalQuotaB -Owner 'owner-b1'
Assert-True ($decisionB_cycle1.status -eq 'SELECTED' -and $decisionB_cycle1.selected.id -eq 'b1-first-entry') $groupB 'cycle1-claims-only-first' "status=$($decisionB_cycle1.status) selected=$($decisionB_cycle1.selected.id)"
$secondPerEntryCycle1 = $decisionB_cycle1.perEntry | Where-Object { $_.id -eq 'b1-second-entry' }
Assert-True ($secondPerEntryCycle1.reason -match 'Not evaluated') $groupB 'cycle1-second-remains-unevaluated-available' "reason=$($secondPerEntryCycle1.reason)"

# pre-ACK: the pending unacknowledged singleton must not be overwritten by a same-group cycle
$bStateBeforeRefusal = (@(Get-ChildItem -LiteralPath $stateDirB -Recurse -File | Sort-Object FullName | ForEach-Object { "$($_.FullName)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }) -join "`n")
$preAckResult = $null
$preAckRefusal = $null
try { $preAckResult = Invoke-ReadyHostContinuation -QueuePath $queueB -StateDir $stateDirB -NormalQuotaPath $normalQuotaB -Owner 'owner-b1' } catch { $preAckRefusal = $_.Exception.Message }
$bStateAfterRefusal = (@(Get-ChildItem -LiteralPath $stateDirB -Recurse -File | Sort-Object FullName | ForEach-Object { "$($_.FullName)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }) -join "`n")
Assert-True ($bStateAfterRefusal -ceq $bStateBeforeRefusal) $groupB 'pre-ack-cycle2-refused-no-decision-or-continuation-state-mutation' "refusal=$preAckRefusal"
Assert-True (-not ($preAckResult -and $preAckResult.selected -and $preAckResult.selected.id -eq 'b1-second-entry')) $groupB 'pre-ack-cycle2-does-not-select-second' "refusal=$preAckRefusal status=$($preAckResult.status)"

# public ACK of cycle1 using the exact returned selected tuple (legacy ExecutionBinding honestly omitted)
$ackB1 = [PSCustomObject]@{ claimId = $decisionB_cycle1.selected.claimId; owner = $decisionB_cycle1.selected.owner; intentId = $decisionB_cycle1.selected.intentId; dispatchedAt = [DateTime]::UtcNow.ToString('o') }
Record-HostDispatchAcknowledgement -StateDir $stateDirB -SelectedClaim $decisionB_cycle1.selected -Acknowledgement $ackB1 | Out-Null

$decisionB_cycle2 = Invoke-ReadyHostContinuation -QueuePath $queueB -StateDir $stateDirB -NormalQuotaPath $normalQuotaB -Owner 'owner-b1'
Assert-True ($decisionB_cycle2.status -eq 'SELECTED' -and $decisionB_cycle2.selected.id -eq 'b1-second-entry') $groupB 'cycle2-selects-second-not-first' "status=$($decisionB_cycle2.status) selected=$($decisionB_cycle2.selected.id)"
$firstPerEntryCycle2 = $decisionB_cycle2.perEntry | Where-Object { $_.id -eq 'b1-first-entry' }
Assert-True ($firstPerEntryCycle2.reason -notmatch 'Selected') $groupB 'cycle2-first-not-reclaimed-or-redispatched' "reason=$($firstPerEntryCycle2.reason)"

# public ACK of cycle2 using the exact returned selected tuple; claims remain CLAIMED
$ackB2 = [PSCustomObject]@{ claimId = $decisionB_cycle2.selected.claimId; owner = $decisionB_cycle2.selected.owner; intentId = $decisionB_cycle2.selected.intentId; dispatchedAt = [DateTime]::UtcNow.ToString('o') }
Record-HostDispatchAcknowledgement -StateDir $stateDirB -SelectedClaim $decisionB_cycle2.selected -Acknowledgement $ackB2 | Out-Null

# restart/replay: fresh invocation against persisted state produces no NEW_CLAIM for consumed entries
$decisionB_restart = Invoke-ReadyHostContinuation -QueuePath $queueB -StateDir $stateDirB -NormalQuotaPath $normalQuotaB -Owner 'owner-b1-restart'
Assert-True ($decisionB_restart.status -eq 'NO_ELIGIBLE') $groupB 'restart-replay-no-new-claim-for-consumed-entries' "status=$($decisionB_restart.status)"
$firstReasonRestart = $decisionB_restart.perEntry | Where-Object { $_.id -eq 'b1-first-entry' }
$secondReasonRestart = $decisionB_restart.perEntry | Where-Object { $_.id -eq 'b1-second-entry' }
Assert-True ($firstReasonRestart.reason -match 'pending reconciliation' -and $secondReasonRestart.reason -match 'pending reconciliation') $groupB 'restart-durable-pending-claim-ack-reconciliation-trigger' "firstReason=$($firstReasonRestart.reason) secondReason=$($secondReasonRestart.reason) nextTrigger=$($decisionB_restart.nextTrigger)"
Assert-True ($decisionB_restart.nextTrigger -eq 'claim-ack-reconciliation') $groupB 'restart-next-trigger-is-claim-ack-reconciliation' "nextTrigger=$($decisionB_restart.nextTrigger)"

# ---------------------------------------------------------------------------
# Group C: no eligible / missing quota; restored normal; stale/denied gates
# ---------------------------------------------------------------------------
Write-Host "--- Group C: no eligible/quota gates ---"
$groupC = 'C-no-eligible-and-quota-gates'
$dirC1 = New-FixtureDir 'c1'
$queueC1 = New-QueueFile $dirC1 @()
$normalQuotaC1 = Join-Path $dirC1 'normal-quota.json'
New-QuotaFile $normalQuotaC1 @{} | Out-Null
$stateDirC1 = Join-Path $dirC1 'state'
$decisionC1 = Invoke-ReadyHostContinuation -QueuePath $queueC1 -StateDir $stateDirC1 -NormalQuotaPath $normalQuotaC1 -Owner 'owner-c1'
Assert-True ($decisionC1.status -eq 'NO_ELIGIBLE') $groupC 'empty-queue-exactly-one-result' "status=$($decisionC1.status)"
Assert-True (-not [string]::IsNullOrWhiteSpace($decisionC1.owner) -and -not [string]::IsNullOrWhiteSpace($decisionC1.reason) -and -not [string]::IsNullOrWhiteSpace($decisionC1.nextTrigger)) $groupC 'persisted-nonblank-owner-reason-trigger' "owner=$($decisionC1.owner) reason=$($decisionC1.reason) nextTrigger=$($decisionC1.nextTrigger)"

$dirC2 = New-FixtureDir 'c2'
$cC2 = New-Receipt -Dir $dirC2 -RunId 'watcher-06-c2-claude' -TaskId 'TASK-C2-CLAUDE'
$planC2 = New-Plan2 $cC2 'claude' @{}
$queueC2 = New-QueueFile $dirC2 @(
    [PSCustomObject]@{ id = 'c2-claude-entry'; receiptPath = $cC2.ReceiptPath; planPath = $planC2; owner = 'owner-c2'; provider = 'claude'; enabled = $true }
)
$normalQuotaC2_blocked = Join-Path $dirC2 'normal-quota-blocked.json'
New-QuotaFile $normalQuotaC2_blocked @{ verified = $true; eligible = $false; reason = 'quota' } | Out-Null
$stateDirC2 = Join-Path $dirC2 'state'
$decisionC2_blocked = Invoke-ReadyHostContinuation -QueuePath $queueC2 -StateDir $stateDirC2 -NormalQuotaPath $normalQuotaC2_blocked -Owner 'owner-c2'
Assert-True ($decisionC2_blocked.status -eq 'NO_ELIGIBLE') $groupC 'claude-only-blocked-no-cloud-no-eligible' "status=$($decisionC2_blocked.status)"

$normalQuotaC2_restored = Join-Path $dirC2 'normal-quota-restored.json'
New-QuotaFile $normalQuotaC2_restored @{ verified = $true; eligible = $true } | Out-Null
$cloudQuotaC2_present = Join-Path $dirC2 'cloud-quota-present.json'
New-QuotaFile $cloudQuotaC2_present @{ budgetCompliant = $true; promotionalOnly = $true; creditsEnabled = $false } | Out-Null
$stateDirC2b = Join-Path $dirC2 'state-restored'
$decisionC2_restored = Invoke-ReadyHostContinuation -QueuePath $queueC2 -StateDir $stateDirC2b -NormalQuotaPath $normalQuotaC2_restored -CloudQuotaPath $cloudQuotaC2_present -Owner 'owner-c2-restored'
Assert-True ($decisionC2_restored.status -eq 'SELECTED' -and $decisionC2_restored.selected.route -eq 'normal') $groupC 'restored-normal-routes-claude-normal-even-with-cloud-record' "status=$($decisionC2_restored.status) route=$($decisionC2_restored.selected.route)"

$dirC3 = New-FixtureDir 'c3'
$cC3 = New-Receipt -Dir $dirC3 -RunId 'watcher-06-c3-claude' -TaskId 'TASK-C3-CLAUDE'
$planC3 = New-Plan2 $cC3 'claude' @{}
$queueC3 = New-QueueFile $dirC3 @(
    [PSCustomObject]@{ id = 'c3-claude-entry'; receiptPath = $cC3.ReceiptPath; planPath = $planC3; owner = 'owner-c3'; provider = 'claude'; enabled = $true }
)
$normalQuotaC3_stale = Join-Path $dirC3 'normal-quota-stale.json'
$staleNow = (Get-Date).ToUniversalTime()
New-QuotaFile $normalQuotaC3_stale @{ verified = $true; eligible = $true; observedAt = $staleNow.AddHours(-5).ToString('o'); freshUntilUtc = $staleNow.AddHours(-4).ToString('o') } | Out-Null
$stateDirC3_stale = Join-Path $dirC3 'state-stale'
$decisionC3_stale = Invoke-ReadyHostContinuation -QueuePath $queueC3 -StateDir $stateDirC3_stale -NormalQuotaPath $normalQuotaC3_stale -Owner 'owner-c3-stale'
Assert-True ($decisionC3_stale.status -eq 'NO_ELIGIBLE') $groupC 'stale-normal-quota-does-not-authorize-claude' "status=$($decisionC3_stale.status)"

$normalQuotaC3_unknown = Join-Path $dirC3 'normal-quota-unknown.json'
New-QuotaFile $normalQuotaC3_unknown @{ verified = $false; eligible = $true } | Out-Null
$stateDirC3_unknown = Join-Path $dirC3 'state-unknown'
$decisionC3_unknown = Invoke-ReadyHostContinuation -QueuePath $queueC3 -StateDir $stateDirC3_unknown -NormalQuotaPath $normalQuotaC3_unknown -Owner 'owner-c3-unknown'
Assert-True ($decisionC3_unknown.status -eq 'NO_ELIGIBLE') $groupC 'unknown-verified-false-normal-quota-does-not-authorize-claude' "status=$($decisionC3_unknown.status)"

$dirC3b = New-FixtureDir 'c3b'
$cC3b = New-Receipt -Dir $dirC3b -RunId 'watcher-06-c3b-claude' -TaskId 'TASK-C3B-CLAUDE'
$planC3b_reviewDenied = New-Plan2 $cC3b 'claude-reviewdenied' @{ reviewDenied = $true }
$queueC3b_reviewDenied = New-QueueFile $dirC3b @(
    [PSCustomObject]@{ id = 'c3b-reviewdenied-entry'; receiptPath = $cC3b.ReceiptPath; planPath = $planC3b_reviewDenied; owner = 'owner-c3b-rd'; provider = 'claude'; enabled = $true }
)
$normalQuotaC3b = Join-Path $dirC3b 'normal-quota.json'
New-QuotaFile $normalQuotaC3b @{} | Out-Null
$stateDirC3b_rd = Join-Path $dirC3b 'state-reviewdenied'
$decisionC3b_reviewDenied = Invoke-ReadyHostContinuation -QueuePath $queueC3b_reviewDenied -StateDir $stateDirC3b_rd -NormalQuotaPath $normalQuotaC3b -Owner 'owner-c3b-rd'
Assert-True ($decisionC3b_reviewDenied.status -eq 'NO_ELIGIBLE') $groupC 'reviewdenied-plan-does-not-claim-with-normal-available' "status=$($decisionC3b_reviewDenied.status)"

$cC3c = New-Receipt -Dir $dirC3b -RunId 'watcher-06-c3c-claude' -TaskId 'TASK-C3C-CLAUDE'
$planC3c_depsNotReady = New-Plan2 $cC3c 'claude-depsnotready' @{ dependenciesReady = $false }
$queueC3c_depsNotReady = New-QueueFile $dirC3b @(
    [PSCustomObject]@{ id = 'c3c-depsnotready-entry'; receiptPath = $cC3c.ReceiptPath; planPath = $planC3c_depsNotReady; owner = 'owner-c3c-dnr'; provider = 'claude'; enabled = $true }
)
$stateDirC3c_dnr = Join-Path $dirC3b 'state-depsnotready'
$decisionC3c_depsNotReady = Invoke-ReadyHostContinuation -QueuePath $queueC3c_depsNotReady -StateDir $stateDirC3c_dnr -NormalQuotaPath $normalQuotaC3b -Owner 'owner-c3c-dnr'
Assert-True ($decisionC3c_depsNotReady.status -eq 'NO_ELIGIBLE') $groupC 'dependenciesnotready-plan-does-not-claim-with-normal-available' "status=$($decisionC3c_depsNotReady.status)"

Write-Host "--- Group C: model-dispatch baseline/denial budget overrides ---"
$dirC3d = New-FixtureDir 'c3d'
$cC3d_base = New-Receipt -Dir $dirC3d -RunId 'watcher-06-c3d-base' -TaskId 'TASK-C3D-BASE'
$baseBudgetOverrides = @{
    kind                = 'NORMAL_REVIEW_DISPATCH'
    maxAdditionalOutput = 2000
    aggregateCeiling    = ($cC3d_base.Receipt.budget.usedOutputTokens + 2000)
}
$planC3d_base = New-Plan2 $cC3d_base 'base' $baseBudgetOverrides
$queueC3d_base = New-QueueFile $dirC3d @(
    [PSCustomObject]@{ id = 'c3d-base-entry'; receiptPath = $cC3d_base.ReceiptPath; planPath = $planC3d_base; owner = 'owner-c3d-base'; provider = 'claude'; enabled = $true }
)
$normalQuotaC3d = Join-Path $dirC3d 'normal-quota.json'
New-QuotaFile $normalQuotaC3d @{} | Out-Null
$stateDirC3d_base = Join-Path $dirC3d 'state-base'
$decisionC3d_base = Invoke-ReadyHostContinuation -QueuePath $queueC3d_base -StateDir $stateDirC3d_base -NormalQuotaPath $normalQuotaC3d -Owner 'owner-c3d-base'
Assert-True ($decisionC3d_base.status -eq 'SELECTED' -and $decisionC3d_base.selected.id -eq 'c3d-base-entry') $groupC 'model-dispatch-baseline-budget-eligible-selects' "status=$($decisionC3d_base.status) selected=$($decisionC3d_base.selected.id)"

$cC3d_denyStale = New-Receipt -Dir $dirC3d -RunId 'watcher-06-c3d-denystale' -TaskId 'TASK-C3D-DENYSTALE'
$planC3d_denyStale = New-Plan2 $cC3d_denyStale 'denystale' $baseBudgetOverrides
$queueC3d_denyStale = New-QueueFile $dirC3d @(
    [PSCustomObject]@{ id = 'c3d-denystale-entry'; receiptPath = $cC3d_denyStale.ReceiptPath; planPath = $planC3d_denyStale; owner = 'owner-c3d-denystale'; provider = 'claude'; enabled = $true }
)
$stateDirC3d_denyStale = Join-Path $dirC3d 'state-denystale'
$decisionC3d_denyStale = Invoke-ReadyHostContinuation -QueuePath $queueC3d_denyStale -StateDir $stateDirC3d_denyStale -NormalQuotaPath $normalQuotaC3_stale -Owner 'owner-c3d-denystale'
Assert-True ($decisionC3d_denyStale.status -eq 'NO_ELIGIBLE') $groupC 'model-dispatch-stale-quota-denies-otherwise-eligible-budget' "status=$($decisionC3d_denyStale.status)"

$cC3d_denyUnknown = New-Receipt -Dir $dirC3d -RunId 'watcher-06-c3d-denyunknown' -TaskId 'TASK-C3D-DENYUNKNOWN'
$planC3d_denyUnknown = New-Plan2 $cC3d_denyUnknown 'denyunknown' $baseBudgetOverrides
$queueC3d_denyUnknown = New-QueueFile $dirC3d @(
    [PSCustomObject]@{ id = 'c3d-denyunknown-entry'; receiptPath = $cC3d_denyUnknown.ReceiptPath; planPath = $planC3d_denyUnknown; owner = 'owner-c3d-denyunknown'; provider = 'claude'; enabled = $true }
)
$stateDirC3d_denyUnknown = Join-Path $dirC3d 'state-denyunknown'
$decisionC3d_denyUnknown = Invoke-ReadyHostContinuation -QueuePath $queueC3d_denyUnknown -StateDir $stateDirC3d_denyUnknown -NormalQuotaPath $normalQuotaC3_unknown -Owner 'owner-c3d-denyunknown'
Assert-True ($decisionC3d_denyUnknown.status -eq 'NO_ELIGIBLE') $groupC 'model-dispatch-unknown-quota-denies-otherwise-eligible-budget' "status=$($decisionC3d_denyUnknown.status)"

$cC3d_denyReview = New-Receipt -Dir $dirC3d -RunId 'watcher-06-c3d-denyreview' -TaskId 'TASK-C3D-DENYREVIEW'
$denyReviewOverrides = @{
    kind                = 'NORMAL_REVIEW_DISPATCH'
    maxAdditionalOutput = 2000
    aggregateCeiling    = ($cC3d_denyReview.Receipt.budget.usedOutputTokens + 2000)
    reviewDenied        = $true
}
$planC3d_denyReview = New-Plan2 $cC3d_denyReview 'denyreview' $denyReviewOverrides
$queueC3d_denyReview = New-QueueFile $dirC3d @(
    [PSCustomObject]@{ id = 'c3d-denyreview-entry'; receiptPath = $cC3d_denyReview.ReceiptPath; planPath = $planC3d_denyReview; owner = 'owner-c3d-denyreview'; provider = 'claude'; enabled = $true }
)
$stateDirC3d_denyReview = Join-Path $dirC3d 'state-denyreview'
$decisionC3d_denyReview = Invoke-ReadyHostContinuation -QueuePath $queueC3d_denyReview -StateDir $stateDirC3d_denyReview -NormalQuotaPath $normalQuotaC3d -Owner 'owner-c3d-denyreview'
Assert-True ($decisionC3d_denyReview.status -eq 'NO_ELIGIBLE') $groupC 'model-dispatch-reviewdenied-denies-otherwise-eligible-budget' "status=$($decisionC3d_denyReview.status)"

$cC3d_denyDeps = New-Receipt -Dir $dirC3d -RunId 'watcher-06-c3d-denydeps' -TaskId 'TASK-C3D-DENYDEPS'
$denyDepsOverrides = @{
    kind                = 'NORMAL_REVIEW_DISPATCH'
    maxAdditionalOutput = 2000
    aggregateCeiling    = ($cC3d_denyDeps.Receipt.budget.usedOutputTokens + 2000)
    dependenciesReady   = $false
}
$planC3d_denyDeps = New-Plan2 $cC3d_denyDeps 'denydeps' $denyDepsOverrides
$queueC3d_denyDeps = New-QueueFile $dirC3d @(
    [PSCustomObject]@{ id = 'c3d-denydeps-entry'; receiptPath = $cC3d_denyDeps.ReceiptPath; planPath = $planC3d_denyDeps; owner = 'owner-c3d-denydeps'; provider = 'claude'; enabled = $true }
)
$stateDirC3d_denyDeps = Join-Path $dirC3d 'state-denydeps'
$decisionC3d_denyDeps = Invoke-ReadyHostContinuation -QueuePath $queueC3d_denyDeps -StateDir $stateDirC3d_denyDeps -NormalQuotaPath $normalQuotaC3d -Owner 'owner-c3d-denydeps'
Assert-True ($decisionC3d_denyDeps.status -eq 'NO_ELIGIBLE') $groupC 'model-dispatch-depsnotready-denies-otherwise-eligible-budget' "status=$($decisionC3d_denyDeps.status)"

# ---------------------------------------------------------------------------
# Group D: real fixture acknowledgement recording and refusal
# ---------------------------------------------------------------------------
Write-Host "--- Group D: Record-HostDispatchAcknowledgement ---"
$groupD = 'D-acknowledgement-recording'

function New-SelectedClaimAndState([string]$Dir, [string]$Tag) {
    $cD = New-Receipt -Dir $Dir -RunId ("watcher-06-$Tag") -TaskId ("TASK-$Tag")
    $planD = New-Plan2 $cD $Tag @{}
    $stateDirD = Join-Path $Dir ("state-$Tag")
    $queueD = New-QueueFile $Dir @(
        [PSCustomObject]@{ id = "$Tag-entry"; receiptPath = $cD.ReceiptPath; planPath = $planD; owner = "owner-$Tag"; provider = 'independent'; enabled = $true }
    )
    $normalQuotaD = Join-Path $Dir ("normal-quota-$Tag.json")
    New-QuotaFile $normalQuotaD @{} | Out-Null
    $decisionD = Invoke-ReadyHostContinuation -QueuePath $queueD -StateDir $stateDirD -NormalQuotaPath $normalQuotaD -Owner "owner-$Tag"
    [PSCustomObject]@{ Decision = $decisionD; StateDir = $stateDirD }
}

$dirD1 = New-FixtureDir 'd1'
$d1 = New-SelectedClaimAndState $dirD1 'd1'
$d1Selected = $d1.Decision.selected
$d1Ack = [PSCustomObject]@{
    claimId      = $d1Selected.claimId
    owner        = $d1Selected.owner
    intentId     = $d1Selected.intentId
    dispatchedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$d1Record = Record-HostDispatchAcknowledgement -StateDir $d1.StateDir -SelectedClaim $d1Selected -Acknowledgement $d1Ack
Assert-True ($d1Record.claimId -eq $d1Ack.claimId -and $d1Record.owner -eq $d1Ack.owner -and $d1Record.intentId -eq $d1Ack.intentId -and $d1Record.dispatchedAt -eq $d1Ack.dispatchedAt) $groupD 'real-fixture-ack-recorded-matching-passed-fields' "entryId=$($d1Record.entryId) claimId=$($d1Record.claimId) owner=$($d1Record.owner) intentId=$($d1Record.intentId) dispatchedAt=$($d1Record.dispatchedAt)"

$ackPathD1 = Join-Path $d1.StateDir 'host-dispatch-acknowledgements.json'
$ackRawBefore = Get-Content -LiteralPath $ackPathD1 -Raw
$ackWriteTimeBefore = (Get-Item -LiteralPath $ackPathD1).LastWriteTimeUtc
$d1RecordReplay = Record-HostDispatchAcknowledgement -StateDir $d1.StateDir -SelectedClaim $d1Selected -Acknowledgement $d1Ack
$ackRawAfter = Get-Content -LiteralPath $ackPathD1 -Raw
$ackWriteTimeAfter = (Get-Item -LiteralPath $ackPathD1).LastWriteTimeUtc
Assert-True ($ackRawBefore -ceq $ackRawAfter -and $ackWriteTimeBefore -eq $ackWriteTimeAfter) $groupD 'matching-replay-no-byte-or-time-churn' "bytesEqual=$($ackRawBefore -ceq $ackRawAfter) timeEqual=$($ackWriteTimeBefore -eq $ackWriteTimeAfter)"

$dirD2 = New-FixtureDir 'd2'
$d2a = New-SelectedClaimAndState $dirD2 'd2a'
$d2aSelected = $d2a.Decision.selected
$d2aAck = [PSCustomObject]@{ claimId = $d2aSelected.claimId; owner = $d2aSelected.owner; intentId = $d2aSelected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
Record-HostDispatchAcknowledgement -StateDir $d2a.StateDir -SelectedClaim $d2aSelected -Acknowledgement $d2aAck | Out-Null

$queueD2b = New-QueueFile $dirD2 @(
    [PSCustomObject]@{ id = 'd2b-entry'; receiptPath = $d2a.Decision.selected.statePath; planPath = (New-Plan2 (New-Receipt -Dir $dirD2 -RunId 'watcher-06-d2b' -TaskId 'TASK-D2B') 'd2b' @{}); owner = 'owner-d2b'; provider = 'independent'; enabled = $true }
)
$cD2b = New-Receipt -Dir $dirD2 -RunId 'watcher-06-d2b-second' -TaskId 'TASK-D2B-SECOND'
$planD2b = New-Plan2 $cD2b 'd2bsecond' @{}
$queueD2b2 = New-QueueFile $dirD2 @(
    [PSCustomObject]@{ id = 'd2b-entry'; receiptPath = $cD2b.ReceiptPath; planPath = $planD2b; owner = 'owner-d2b'; provider = 'independent'; enabled = $true }
)
$decisionD2b = Invoke-ReadyHostContinuation -QueuePath $queueD2b2 -StateDir $d2a.StateDir -NormalQuotaPath (Join-Path $dirD2 'normal-quota-d2a.json') -Owner 'owner-d2b'
$d2bSelected = $decisionD2b.selected
$d2bAck = [PSCustomObject]@{ claimId = $d2bSelected.claimId; owner = $d2bSelected.owner; intentId = $d2bSelected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
Record-HostDispatchAcknowledgement -StateDir $d2a.StateDir -SelectedClaim $d2bSelected -Acknowledgement $d2bAck | Out-Null
$ackMapD2 = (Get-Content -LiteralPath (Join-Path $d2a.StateDir 'host-dispatch-acknowledgements.json') -Raw) | ConvertFrom-Json -DateKind String
$ackKeyD2a = "$($d2aSelected.intentId)|$($d2aSelected.claimId)"
$ackKeyD2b = "$($d2bSelected.intentId)|$($d2bSelected.claimId)"
Assert-True (($ackMapD2.acknowledgements.PSObject.Properties.Name -contains $ackKeyD2a) -and ($ackMapD2.acknowledgements.PSObject.Properties.Name -contains $ackKeyD2b)) $groupD 'two-claims-keep-both-keyed-records' "keys=$($ackMapD2.acknowledgements.PSObject.Properties.Name -join ',')"

$dirD3 = New-FixtureDir 'd3'
$d3 = New-SelectedClaimAndState $dirD3 'd3'
$d3Selected = $d3.Decision.selected

$d3ForgedClaim = $d3Selected.PSObject.Copy()
$d3ForgedClaim.claimId = [Guid]::NewGuid().ToString()
$d3ForgedAck = [PSCustomObject]@{ claimId = $d3ForgedClaim.claimId; owner = $d3Selected.owner; intentId = $d3Selected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
$threwForgedClaim = $false
try { Record-HostDispatchAcknowledgement -StateDir $d3.StateDir -SelectedClaim $d3ForgedClaim -Acknowledgement $d3ForgedAck | Out-Null } catch { $threwForgedClaim = $true }
Assert-True $threwForgedClaim $groupD 'forged-claimid-refused-no-write' "threw=$threwForgedClaim"

$d3ForgedOwner = $d3Selected.PSObject.Copy()
$d3ForgedOwner.owner = 'forged-owner-xyz'
$d3ForgedOwnerAck = [PSCustomObject]@{ claimId = $d3Selected.claimId; owner = $d3ForgedOwner.owner; intentId = $d3Selected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
$threwForgedOwner = $false
try { Record-HostDispatchAcknowledgement -StateDir $d3.StateDir -SelectedClaim $d3ForgedOwner -Acknowledgement $d3ForgedOwnerAck | Out-Null } catch { $threwForgedOwner = $true }
Assert-True $threwForgedOwner $groupD 'forged-owner-refused-no-write' "threw=$threwForgedOwner"

$foreignStateDirD3 = Join-Path $dirD3 'foreign-state'
New-Item -ItemType Directory -Path $foreignStateDirD3 -Force | Out-Null
$d3ForeignPathClaim = $d3Selected.PSObject.Copy()
$d3ForeignPathClaim.statePath = Join-Path $foreignStateDirD3 'continuation-state.json'
$d3Ack = [PSCustomObject]@{ claimId = $d3Selected.claimId; owner = $d3Selected.owner; intentId = $d3Selected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
$threwForeignPath = $false
try { Record-HostDispatchAcknowledgement -StateDir $d3.StateDir -SelectedClaim $d3ForeignPathClaim -Acknowledgement $d3Ack | Out-Null } catch { $threwForeignPath = $true }
Assert-True $threwForeignPath $groupD 'foreign-canonical-statepath-refused-no-write' "threw=$threwForeignPath"

$d3ChangedFingerprintClaim = $d3Selected.PSObject.Copy()
$d3ChangedFingerprintClaim.receiptSha = ('0' * 64)
$d3ChangedFingerprintAck = [PSCustomObject]@{ claimId = $d3Selected.claimId; owner = $d3Selected.owner; intentId = $d3Selected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
$threwChangedFingerprint = $false
try { Record-HostDispatchAcknowledgement -StateDir $d3.StateDir -SelectedClaim $d3ChangedFingerprintClaim -Acknowledgement $d3ChangedFingerprintAck | Out-Null } catch { $threwChangedFingerprint = $true }
Assert-True $threwChangedFingerprint $groupD 'changed-selected-fingerprint-refused-no-write' "threw=$threwChangedFingerprint"

$dirD4 = New-FixtureDir 'd4'
$d4 = New-SelectedClaimAndState $dirD4 'd4'
$d4Selected = $d4.Decision.selected
$d4Ack = [PSCustomObject]@{ claimId = $d4Selected.claimId; owner = $d4Selected.owner; intentId = $d4Selected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }

$continuationStatePathD4 = Join-Path $d4.StateDir 'continuation-state.json'
$continuationStateBytesD4 = [System.IO.File]::ReadAllBytes($continuationStatePathD4)
$continuationStateRawD4 = Get-Content -LiteralPath $continuationStatePathD4 -Raw
$continuationStateObjD4 = $continuationStateRawD4 | ConvertFrom-Json -DateKind String
$continuationStateObjD4.schema = 'wrong-continuation-schema/v1'
($continuationStateObjD4 | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $continuationStatePathD4 -NoNewline -Encoding utf8
$threwWrongContinuationSchema = $false
try { Record-HostDispatchAcknowledgement -StateDir $d4.StateDir -SelectedClaim $d4Selected -Acknowledgement $d4Ack | Out-Null } catch { $threwWrongContinuationSchema = $true }
Assert-True $threwWrongContinuationSchema $groupD 'wrong-continuation-state-schema-refused' "threw=$threwWrongContinuationSchema"
[System.IO.File]::WriteAllBytes($continuationStatePathD4, $continuationStateBytesD4)

$decisionPathD4 = Join-Path $d4.StateDir 'host-continuation-decision.json'
$decisionBytesD4 = [System.IO.File]::ReadAllBytes($decisionPathD4)
$decisionRawD4b = Get-Content -LiteralPath $decisionPathD4 -Raw
$decisionObjD4b = $decisionRawD4b | ConvertFrom-Json -DateKind String
$decisionObjD4b.schema = 'wrong-decision-schema/v1'
($decisionObjD4b | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $decisionPathD4 -NoNewline -Encoding utf8
$threwWrongDecisionSchema = $false
try { Record-HostDispatchAcknowledgement -StateDir $d4.StateDir -SelectedClaim $d4Selected -Acknowledgement $d4Ack | Out-Null } catch { $threwWrongDecisionSchema = $true }
Assert-True $threwWrongDecisionSchema $groupD 'wrong-decision-schema-refused' "threw=$threwWrongDecisionSchema"
[System.IO.File]::WriteAllBytes($decisionPathD4, $decisionBytesD4)

$dirD5 = New-FixtureDir 'd5'
$d5 = New-SelectedClaimAndState $dirD5 'd5'
$d5Selected = $d5.Decision.selected
$d5Ack = [PSCustomObject]@{ claimId = $d5Selected.claimId; owner = $d5Selected.owner; intentId = $d5Selected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
Record-HostDispatchAcknowledgement -StateDir $d5.StateDir -SelectedClaim $d5Selected -Acknowledgement $d5Ack | Out-Null
$ackPathD5 = Join-Path $d5.StateDir 'host-dispatch-acknowledgements.json'
$ackBytesD5 = [System.IO.File]::ReadAllBytes($ackPathD5)

[System.IO.File]::WriteAllText($ackPathD5, 'null', [System.Text.Encoding]::UTF8)
$ackHashD5BeforeNull = (Get-FileHash -LiteralPath $ackPathD5 -Algorithm SHA256).Hash
$threwNullAck = $false
try { Record-HostDispatchAcknowledgement -StateDir $d5.StateDir -SelectedClaim $d5Selected -Acknowledgement $d5Ack | Out-Null } catch { $threwNullAck = $true }
$ackHashD5AfterNull = (Get-FileHash -LiteralPath $ackPathD5 -Algorithm SHA256).Hash
Assert-True $threwNullAck $groupD 'corrupt-ack-map-null-refused-no-overwrite' "threw=$threwNullAck"
Assert-True ($ackHashD5BeforeNull -eq $ackHashD5AfterNull) $groupD 'corrupt-ack-map-null-bytes-unchanged-by-refusal' "beforeHash=$ackHashD5BeforeNull afterHash=$ackHashD5AfterNull"
[System.IO.File]::WriteAllBytes($ackPathD5, $ackBytesD5)

$wrongSchemaRawD5 = '{ "schema": "wrong-schema/v1", "acknowledgements": {} }'
[System.IO.File]::WriteAllText($ackPathD5, $wrongSchemaRawD5, [System.Text.Encoding]::UTF8)
$ackHashD5BeforeWrongSchema = (Get-FileHash -LiteralPath $ackPathD5 -Algorithm SHA256).Hash
$threwWrongAckSchema = $false
try { Record-HostDispatchAcknowledgement -StateDir $d5.StateDir -SelectedClaim $d5Selected -Acknowledgement $d5Ack | Out-Null } catch { $threwWrongAckSchema = $true }
$ackHashD5AfterWrongSchema = (Get-FileHash -LiteralPath $ackPathD5 -Algorithm SHA256).Hash
Assert-True $threwWrongAckSchema $groupD 'corrupt-ack-map-wrong-schema-refused-no-overwrite' "threw=$threwWrongAckSchema"
Assert-True ($ackHashD5BeforeWrongSchema -eq $ackHashD5AfterWrongSchema) $groupD 'corrupt-ack-map-wrong-schema-bytes-unchanged-by-refusal' "beforeHash=$ackHashD5BeforeWrongSchema afterHash=$ackHashD5AfterWrongSchema"
[System.IO.File]::WriteAllBytes($ackPathD5, $ackBytesD5)

$ackObjD5 = (Get-Content -LiteralPath $ackPathD5 -Raw) | ConvertFrom-Json -DateKind String
$realKeyD5 = "$($d5Selected.intentId)|$($d5Selected.claimId)"
$wrongKeyHash = [System.Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
$entryD5 = $ackObjD5.acknowledgements.$realKeyD5
$wrongKeyHash['wrong-key-not-matching'] = $entryD5
$ackObjD5.acknowledgements = [PSCustomObject]$wrongKeyHash
($ackObjD5 | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $ackPathD5 -NoNewline -Encoding utf8
$ackHashD5BeforeWrongKey = (Get-FileHash -LiteralPath $ackPathD5 -Algorithm SHA256).Hash
$threwWrongKey = $false
try { Record-HostDispatchAcknowledgement -StateDir $d5.StateDir -SelectedClaim $d5Selected -Acknowledgement $d5Ack | Out-Null } catch { $threwWrongKey = $true }
$ackHashD5AfterWrongKey = (Get-FileHash -LiteralPath $ackPathD5 -Algorithm SHA256).Hash
Assert-True $threwWrongKey $groupD 'corrupt-ack-map-wrong-key-refused-no-overwrite' "threw=$threwWrongKey"
Assert-True ($ackHashD5BeforeWrongKey -eq $ackHashD5AfterWrongKey) $groupD 'corrupt-ack-map-wrong-key-bytes-unchanged-by-refusal' "beforeHash=$ackHashD5BeforeWrongKey afterHash=$ackHashD5AfterWrongKey"
[System.IO.File]::WriteAllBytes($ackPathD5, $ackBytesD5)

$ackObjD5b = (Get-Content -LiteralPath $ackPathD5 -Raw) | ConvertFrom-Json -DateKind String
$entryD5b = $ackObjD5b.acknowledgements.$realKeyD5
$entryD5b.owner = 'different-target-owner'
($ackObjD5b | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $ackPathD5 -NoNewline -Encoding utf8
$ackHashD5BeforeWrongTarget = (Get-FileHash -LiteralPath $ackPathD5 -Algorithm SHA256).Hash
$threwWrongTargetIdentity = $false
try { Record-HostDispatchAcknowledgement -StateDir $d5.StateDir -SelectedClaim $d5Selected -Acknowledgement $d5Ack | Out-Null } catch { $threwWrongTargetIdentity = $true }
$ackHashD5AfterWrongTarget = (Get-FileHash -LiteralPath $ackPathD5 -Algorithm SHA256).Hash
Assert-True $threwWrongTargetIdentity $groupD 'corrupt-ack-map-wrong-target-identity-refused-no-overwrite' "threw=$threwWrongTargetIdentity"
Assert-True ($ackHashD5BeforeWrongTarget -eq $ackHashD5AfterWrongTarget) $groupD 'corrupt-ack-map-wrong-target-bytes-unchanged-by-refusal' "beforeHash=$ackHashD5BeforeWrongTarget afterHash=$ackHashD5AfterWrongTarget"
[System.IO.File]::WriteAllBytes($ackPathD5, $ackBytesD5)

$dirD6 = New-FixtureDir 'd6'
$d6 = New-SelectedClaimAndState $dirD6 'd6'
$d6Selected = $d6.Decision.selected
$d6Ack = [PSCustomObject]@{ claimId = $d6Selected.claimId; owner = $d6Selected.owner; intentId = $d6Selected.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
Record-HostDispatchAcknowledgement -StateDir $d6.StateDir -SelectedClaim $d6Selected -Acknowledgement $d6Ack | Out-Null
$ackPathD6 = Join-Path $d6.StateDir 'host-dispatch-acknowledgements.json'
$ackRawD6Before = Get-Content -LiteralPath $ackPathD6 -Raw

$d6OriginalReceiptPath = Join-Path $dirD6 'receipt-watcher-06-d6.json'
$d6OriginalPlanPath = Join-Path $dirD6 'plan-d6.json'
$queueD6restart = New-QueueFile $dirD6 @(
    [PSCustomObject]@{ id = 'd6-entry'; receiptPath = $d6OriginalReceiptPath; planPath = $d6OriginalPlanPath; owner = 'owner-d6'; provider = 'independent'; enabled = $true }
)
$decisionD6restart = Invoke-ReadyHostContinuation -QueuePath $queueD6restart -StateDir $d6.StateDir -NormalQuotaPath (Join-Path $dirD6 'normal-quota-d6.json') -Owner 'owner-d6-restart'
Assert-True ($decisionD6restart.status -eq 'NO_ELIGIBLE') $groupD 'restart-replays-original-frozen-receipt-plan-no-new-claim' "status=$($decisionD6restart.status)"
$ackRawD6After = Get-Content -LiteralPath $ackPathD6 -Raw
Assert-True ($ackRawD6Before -ceq $ackRawD6After) $groupD 'restart-preserves-existing-ack-record' "bytesEqual=$($ackRawD6Before -ceq $ackRawD6After)"

# ---------------------------------------------------------------------------
# Group E: fault isolation wrapper
# ---------------------------------------------------------------------------
Write-Host "--- Group E: HOST_SELECTOR_FAILURE isolation ---"
$groupE = 'E-fault-isolation-wrapper'

$originalInvokeReadyHostContinuation = Get-Item Function:\Invoke-ReadyHostContinuation
$originalWriteHostContinuationDecision = Get-Item Function:\Write-HostContinuationDecision
$originalInvokePublishedSupervisedTerminal = Get-Item Function:\Invoke-PublishedSupervisedTerminal
$coreSentinelE1 = [PSCustomObject]@{ sentinel = 'GroupE-core-sentinel'; id = [Guid]::NewGuid().ToString() }
try {
    function Invoke-ReadyHostContinuation {
        [CmdletBinding()]
        param([string]$QueuePath, [string]$StateDir, [string]$NormalQuotaPath, [string]$CloudQuotaPath, [string]$Owner)
        throw 'INJECTED_SELECTOR_FAULT_FOR_GROUP_E_ONLY'
    }
    function Invoke-PublishedSupervisedTerminal {
        [CmdletBinding()]
        param([hashtable]$TerminalArguments, [string]$CheckpointPath, [string]$VaultPath, [string]$EvidenceRoot)
        return $coreSentinelE1
    }

    $dirE1 = New-FixtureDir 'e1'
    $checkpointE1 = Join-Path $dirE1 'checkpoint.json'
    $vaultE1 = Join-Path $dirE1 'vault'
    New-Item -ItemType Directory -Path $vaultE1 -Force | Out-Null
    $evidenceE1 = Join-Path $dirE1 'evidence'
    $queueE1 = New-QueueFile $dirE1 @()
    $stateDirE1 = Join-Path $dirE1 'state'

    $wrapped = Invoke-HostPublishedSupervisedTerminal -TerminalArguments @{} -CheckpointPath $checkpointE1 -VaultPath $vaultE1 -EvidenceRoot $evidenceE1 -QueuePath $queueE1 -StateDir $stateDirE1 -NormalQuotaPath (Join-Path $dirE1 'normal-quota.json') -Owner 'owner-e1'

    Assert-True ([object]::ReferenceEquals($wrapped.coreResult, $coreSentinelE1)) $groupE 'core-result-object-retained-through-selector-failure' "sameInstance=$([object]::ReferenceEquals($wrapped.coreResult, $coreSentinelE1))"
    Assert-True ($wrapped.hostSelection.status -eq 'NO_ELIGIBLE' -and $wrapped.hostSelection.reason -eq 'HOST_SELECTOR_FAILURE') $groupE 'one-generic-host-selector-failure-observed' "status=$($wrapped.hostSelection.status) reason=$($wrapped.hostSelection.reason)"
    Assert-True (-not [string]::IsNullOrWhiteSpace($wrapped.hostSelection.owner) -and -not [string]::IsNullOrWhiteSpace($wrapped.hostSelection.reason) -and -not [string]::IsNullOrWhiteSpace($wrapped.hostSelection.nextTrigger)) $groupE 'persisted-owner-reason-trigger-nonblank-on-fault' "owner=$($wrapped.hostSelection.owner) reason=$($wrapped.hostSelection.reason) nextTrigger=$($wrapped.hostSelection.nextTrigger)"
    Assert-True ($wrapped.hostSelection.reason -notmatch 'INJECTED_SELECTOR_FAULT_FOR_GROUP_E_ONLY') $groupE 'no-injected-raw-marker-exposed' "reason=$($wrapped.hostSelection.reason)"

    $decisionPathE1 = Join-Path $stateDirE1 'host-continuation-decision.json'
    Assert-True (Test-Path -LiteralPath $decisionPathE1 -PathType Leaf) $groupE 'fault-decision-persisted-to-state' "exists=$(Test-Path $decisionPathE1)"
} finally {
    Set-Item Function:\Invoke-ReadyHostContinuation $originalInvokeReadyHostContinuation
    Set-Item Function:\Write-HostContinuationDecision $originalWriteHostContinuationDecision
    Set-Item Function:\Invoke-PublishedSupervisedTerminal $originalInvokePublishedSupervisedTerminal
}

# ---------------------------------------------------------------------------
# Final summary / publication
# ---------------------------------------------------------------------------
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $here ("test-runs\run-" + [Guid]::NewGuid().ToString('N')) }
$resultsPath = Join-Path $EvidenceRoot 'results.json'
$summary = [PSCustomObject]@{
    schema    = 'host-continuation-test-results/v1'
    ranAt     = (Get-Date).ToUniversalTime().ToString('o')
    total     = $script:results.Count
    failCount = $script:failCount
    results   = $script:results
}
($summary | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $resultsPath -NoNewline -Encoding utf8

Write-Host "--- Summary: $($script:results.Count) checks, $($script:failCount) failures ---"
foreach ($r in $script:results) {
    if ($r.outcome -ne 'PASS') {
        Write-Host "FAIL [$($r.group)] $($r.criterion): $($r.observed)"
    }
}

if ($script:failCount -gt 0) { exit 1 } else { exit 0 }
