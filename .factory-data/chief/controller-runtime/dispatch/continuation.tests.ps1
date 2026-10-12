# continuation.tests.ps1
param(
    [switch]$Worker,
    [string]$WorkerStateDir,
    [string]$WorkerReceiptPath,
    [string]$WorkerPlanPath,
    [string]$WorkerOwner,
    [switch]$WorkerClaim,
    [string]$WorkerBarrier
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'continuation-step.ps1')

if ($Worker) {
    try {
if (-not [string]::IsNullOrWhiteSpace($WorkerBarrier)) {
            $readyFile = Join-Path $WorkerBarrier "$WorkerOwner.ready"
            Set-Content -LiteralPath $readyFile -Value 'ready' -NoNewline -Encoding utf8
            $goFile = Join-Path $WorkerBarrier 'go'
            $barrierDeadline = (Get-Date).AddSeconds(8)
            while (-not (Test-Path -LiteralPath $goFile)) {
                if ((Get-Date) -ge $barrierDeadline) { throw "Timed out waiting for barrier 'go' file." }
                Start-Sleep -Milliseconds 25
            }
        }

        $r = Invoke-ContinuationStep -StateDir $WorkerStateDir -ReceiptPath $WorkerReceiptPath -PlanPath $WorkerPlanPath -Owner $WorkerOwner -Claim:$WorkerClaim
        $r | ConvertTo-Json -Depth 10 | Write-Output
        exit 0
    } catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}

$failCount = 0
function Assert($cond, $msg) {
    if (-not $cond) { $script:failCount++; Write-Host "FAIL: $msg" -ForegroundColor Red }
}

function New-TestCase([string]$tag) {
    $dir = Join-Path $PSScriptRoot ("test-runs/" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $base = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'receipts/watcher-06.json') -Raw | ConvertFrom-Json -DateKind String
    $base.runId = "run-$tag-$([Guid]::NewGuid().ToString('N'))"
    $base.taskId = "task-$tag-$([Guid]::NewGuid().ToString('N'))"
    $receiptPath = Join-Path $dir 'receipt.json'
    ($base | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $receiptPath -NoNewline -Encoding utf8
    $receiptSha = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [PSCustomObject]@{ Dir = $dir; ReceiptPath = $receiptPath; Receipt = $base; ReceiptSha = $receiptSha }
}

function New-Plan($case, [hashtable]$overrides) {
    $plan = [ordered]@{
        receiptSha256   = $case.ReceiptSha
        actionId        = "action-$([Guid]::NewGuid().ToString('N'))"
        kind            = 'DIAGNOSE_REPLAN'
        ownedPaths      = @((Join-Path $case.Dir 'owned'))
        failures        = 0
        diagnosisSha256 = $null
        budgetKnown     = $true
        ownershipKnown  = $true
        quotaAllowed    = $true
        reviewDenied    = $false
        maxAdditionalOutput = 2000
        cumulativeOutput    = $case.Receipt.budget.usedOutputTokens
        aggregateCeiling    = 91048
    }
    foreach ($k in $overrides.Keys) { $plan[$k] = $overrides[$k] }
    $planPath = Join-Path $case.Dir 'plan.json'
    ([PSCustomObject]$plan | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $planPath -NoNewline -Encoding utf8
    $planPath
}

function Invoke-Worker([string]$stateDir, [string]$receiptPath, [string]$planPath, [string]$owner, [bool]$claim) {
    $argsList = @('-NoProfile', '-File', $PSCommandPath, '-Worker', '-WorkerStateDir', $stateDir, '-WorkerReceiptPath', $receiptPath, '-WorkerPlanPath', $planPath, '-WorkerOwner', $owner)
    if ($claim) { $argsList += '-WorkerClaim' }
    $p = Start-Process -FilePath 'pwsh' -ArgumentList $argsList -NoNewWindow -PassThru -RedirectStandardOutput "$stateDir.out.txt" -RedirectStandardError "$stateDir.err.txt"
    if (-not $p.WaitForExit(10000)) { $p.Kill(); throw "worker timed out" }
    [PSCustomObject]@{ ExitCode = $p.ExitCode; Out = Get-Content "$stateDir.out.txt" -Raw -ErrorAction SilentlyContinue; Err = Get-Content "$stateDir.err.txt" -Raw -ErrorAction SilentlyContinue }
}

Write-Host "--- Group 1: claim lifecycle ---"
$c1 = New-TestCase 'g1'
$plan1 = New-Plan $c1 @{}
$r1a = Invoke-ContinuationStep -StateDir $c1.Dir -ReceiptPath $c1.ReceiptPath -PlanPath $plan1 -Owner 'ownerA' -Claim
Assert ($r1a.claimResult -eq 'NEW_CLAIM') "first claim should be NEW_CLAIM"
$claim1 = $r1a.claimId
$r1b = Invoke-ContinuationStep -StateDir $c1.Dir -ReceiptPath $c1.ReceiptPath -PlanPath $plan1 -Owner 'ownerA' -Claim
Assert ($r1b.claimResult -eq 'EXISTING_CLAIM' -and $r1b.claimId -eq $claim1) "repeat same owner EXISTING_CLAIM same GUID"
$w1 = Invoke-Worker -stateDir $c1.Dir -receiptPath $c1.ReceiptPath -planPath $plan1 -owner 'ownerB' -claim $true
Assert ($w1.ExitCode -eq 0 -and $w1.Out -match 'RECONCILE_CLAIM') "restart different owner yields RECONCILE_CLAIM not NEW_CLAIM"

Write-Host "--- Group 2: shared state eligibility ---"
$sharedStateDir = (New-TestCase 'g2').Dir

$c2a = New-TestCase 'g2a'
$planDenied = New-Plan $c2a @{ kind = 'NORMAL_REVIEW_DISPATCH'; reviewDenied = $true }
$r2a = Invoke-ContinuationStep -StateDir $sharedStateDir -ReceiptPath $c2a.ReceiptPath -PlanPath $planDenied -Owner 'ownerA' -Claim
Assert ($r2a.status -eq 'BLOCKED') "reviewDenied model action BLOCKED"

$c2b = New-TestCase 'g2b'
$claimedPath = Join-Path $c2b.Dir 'disjoint'
$planLocal = New-Plan $c2b @{ ownedPaths = @($claimedPath) }
$r2b = Invoke-ContinuationStep -StateDir $sharedStateDir -ReceiptPath $c2b.ReceiptPath -PlanPath $planLocal -Owner 'ownerA' -Claim
Assert ($r2b.claimResult -eq 'NEW_CLAIM') "disjoint local action gets NEW_CLAIM"

$c2c = New-TestCase 'g2c'
$planOverlap = New-Plan $c2c @{ ownedPaths = @($claimedPath) }
$r2c = Invoke-ContinuationStep -StateDir $sharedStateDir -ReceiptPath $c2c.ReceiptPath -PlanPath $planOverlap -Owner 'ownerC' -Claim
Assert ($r2c.claimResult -ne 'NEW_CLAIM') "overlapping owned path must not get NEW_CLAIM"

$c2d = New-TestCase 'g2d'
$planUnknown = New-Plan $c2d @{ ownershipKnown = $false }
$r2d = Invoke-ContinuationStep -StateDir $sharedStateDir -ReceiptPath $c2d.ReceiptPath -PlanPath $planUnknown -Owner 'ownerD' -Claim
Assert ($r2d.status -eq 'BLOCKED') "unknown ownership BLOCKED"

$c2e = New-TestCase 'g2e'
$planOverBudget = New-Plan $c2e @{ kind = 'NORMAL_REVIEW_DISPATCH'; maxAdditionalOutput = 90000 }
$r2e = Invoke-ContinuationStep -StateDir $sharedStateDir -ReceiptPath $c2e.ReceiptPath -PlanPath $planOverBudget -Owner 'ownerE' -Claim
Assert ($r2e.status -eq 'BLOCKED') "dispatch budget overflow BLOCKED"

$c2f = New-TestCase 'g2f'
$planFail2 = New-Plan $c2f @{ kind = 'NORMAL_REVIEW_DISPATCH'; failures = 2 }
$r2f = Invoke-ContinuationStep -StateDir $sharedStateDir -ReceiptPath $c2f.ReceiptPath -PlanPath $planFail2 -Owner 'ownerF' -Claim
Assert ($r2f.kind -eq 'DIAGNOSE_REPLAN') "two failures without diagnosis reroutes NORMAL_REVIEW_DISPATCH to DIAGNOSE_REPLAN"


Write-Host "--- Group 3: concurrent claim race ---"
$c3 = New-TestCase 'g3'
$planRace = New-Plan $c3 @{}
$barrierDir = Join-Path $c3.Dir 'barrier'
New-Item -ItemType Directory -Path $barrierDir -Force | Out-Null
$outA = Join-Path $c3.Dir 'racer0.out.txt'
$errA = Join-Path $c3.Dir 'racer0.err.txt'
$outB = Join-Path $c3.Dir 'racer1.out.txt'
$errB = Join-Path $c3.Dir 'racer1.err.txt'
$argsA = @('-NoProfile', '-File', "`"$PSCommandPath`"", '-Worker', '-WorkerStateDir', "`"$($c3.Dir)`"", '-WorkerReceiptPath', "`"$($c3.ReceiptPath)`"", '-WorkerPlanPath', "`"$planRace`"", '-WorkerOwner', 'racer0', '-WorkerClaim', '-WorkerBarrier', "`"$barrierDir`"")
$argsB = @('-NoProfile', '-File', "`"$PSCommandPath`"", '-Worker', '-WorkerStateDir', "`"$($c3.Dir)`"", '-WorkerReceiptPath', "`"$($c3.ReceiptPath)`"", '-WorkerPlanPath', "`"$planRace`"", '-WorkerOwner', 'racer1', '-WorkerClaim', '-WorkerBarrier', "`"$barrierDir`"")
$procA = Start-Process -FilePath 'pwsh' -ArgumentList $argsA -WindowStyle Hidden -PassThru -RedirectStandardOutput $outA -RedirectStandardError $errA
$procB = Start-Process -FilePath 'pwsh' -ArgumentList $argsB -WindowStyle Hidden -PassThru -RedirectStandardOutput $outB -RedirectStandardError $errB
try {
    $readyDeadline = (Get-Date).AddSeconds(8)
    while (-not ((Test-Path (Join-Path $barrierDir 'racer0.ready')) -and (Test-Path (Join-Path $barrierDir 'racer1.ready')))) {
        if ((Get-Date) -ge $readyDeadline) { throw "Timed out waiting for both racers to reach barrier." }
        Start-Sleep -Milliseconds 25
    }
    Set-Content -LiteralPath (Join-Path $barrierDir 'go') -Value 'go' -NoNewline -Encoding utf8
    if (-not $procA.WaitForExit(10000)) { throw "racer0 did not exit in time." }
    if (-not $procB.WaitForExit(10000)) { throw "racer1 did not exit in time." }
    if ($procA.ExitCode -ne 0) { throw "racer0 failed: $(Get-Content $errA -Raw)" }
    if ($procB.ExitCode -ne 0) { throw "racer1 failed: $(Get-Content $errB -Raw)" }
    $resA = (Get-Content $outA -Raw) | ConvertFrom-Json
    $resB = (Get-Content $outB -Raw) | ConvertFrom-Json
    $results = @($resA, $resB)
    $newClaims = @($results | Where-Object { $_.claimResult -eq 'NEW_CLAIM' })
    $others = @($results | Where-Object { $_.claimResult -ne 'NEW_CLAIM' })
    Assert ($newClaims.Count -eq 1) "exactly one NEW_CLAIM across the two racers"
    Assert ($others.Count -eq 1 -and @('EXISTING_CLAIM', 'RECONCILE_CLAIM') -contains $others[0].claimResult) "the other racer gets EXISTING_CLAIM or RECONCILE_CLAIM"
    Assert ($newClaims.Count -eq 1 -and $others.Count -eq 1 -and $newClaims[0].claimId -eq $others[0].claimId -and -not [string]::IsNullOrWhiteSpace($newClaims[0].claimId)) "both racers agree on the same nonempty claimId"
} finally {
    foreach ($proc in @($procA, $procB)) {
        if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit() }
        $proc.Dispose()
    }
}
$rAfter = Invoke-ContinuationStep -StateDir $c3.Dir -ReceiptPath $c3.ReceiptPath -PlanPath $planRace -Owner 'racer-late' -Claim
Assert ($rAfter.claimResult -ne 'NEW_CLAIM') "post-race retry does not yield a new claim"


Write-Host "--- Group 4: durability guards ---"
$c4 = New-TestCase 'g4'
$plan4 = New-Plan $c4 @{}
Invoke-ContinuationStep -StateDir $c4.Dir -ReceiptPath $c4.ReceiptPath -PlanPath $plan4 -Owner 'ownerA' -Claim | Out-Null
$statePath4 = Join-Path $c4.Dir 'continuation-state.json'
Set-Content -LiteralPath $statePath4 -Value '{"schema":"bogus","entries":{}}' -NoNewline -Encoding utf8
try {
    Invoke-ContinuationStep -StateDir $c4.Dir -ReceiptPath $c4.ReceiptPath -PlanPath $plan4 -Owner 'ownerA' -Claim | Out-Null
    Assert $false "corrupt schema state should throw, not reset"
} catch { Assert $true "corrupt schema state correctly throws" }

$c5 = New-TestCase 'g5'
$plan5a = New-Plan $c5 @{}
Invoke-ContinuationStep -StateDir $c5.Dir -ReceiptPath $c5.ReceiptPath -PlanPath $plan5a -Owner 'ownerA' | Out-Null
$plan5b = New-Plan $c5 @{ kind = 'VALIDATE' }
try {
    Invoke-ContinuationStep -StateDir $c5.Dir -ReceiptPath $c5.ReceiptPath -PlanPath $plan5b -Owner 'ownerA' | Out-Null
    Assert $false "changed plan for same receipt+actionId should be refused"
} catch { Assert $true "changed plan correctly refused" }

if ($failCount -eq 0) {
    Write-Host "PASS" -ForegroundColor Green
    exit 0
} else {
    Write-Host "FAIL: $failCount assertion(s) failed" -ForegroundColor Red
    exit 1
}
