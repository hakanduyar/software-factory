# Lane C tests: no Pester, no network. Throws on failure.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'reconcile.ps1')

function Assert-True { param($cond,$msg) if (-not $cond) { throw "ASSERTION FAILED: $msg" } }

function New-TempDir {
    $p = Join-Path ([System.IO.Path]::GetTempPath()) "lanec_$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $p -Force | Out-Null
    return $p
}

function Write-Receipt {
    param($Dir,$Name,$TaskId='t1',$PayloadSha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$RunId='r1',$Status='COMPLETED',$Attempt=1,$Destination='dest1',$UpdatedAt)
    if (-not $UpdatedAt) { $UpdatedAt = (Get-Date).ToUniversalTime().ToString('o') }
    $terminalReason = $null
    $artifactComplete = $false
    $artifactPath = $null
    $artifactSha = $null
    if ($Status -eq 'COMPLETED') {
        $terminalReason = 'success'
        $artifactPath = Join-Path $Dir "$Name.artifact.txt"
        'fake-artifact-bytes' | Set-Content -LiteralPath $artifactPath -Encoding UTF8 -NoNewline
        $artifactSha = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash
        $artifactComplete = $true
    }
    $obj = [PSCustomObject]@{
        schemaVersion='OperationalRunReceipt/v1'; runId=$RunId; taskId=$TaskId; payloadSha256=$PayloadSha
        destination=$Destination; status=$Status; attempt=$Attempt; sessionId='s1'; historyVerified=$true
        budget=@{ maxOutputTokens=1000; maxElapsedMs=60000; maxAttempts=10; softFraction=0.75; usedElapsedMs=1; usedOutputTokens=1; attemptsUsed=$Attempt }
        provider=@{ pid=123; startIdentity='fake-start'; sessionId='s1'; terminalReason=$terminalReason }
        artifact=@{ complete=$artifactComplete; path=$artifactPath; sha256=$artifactSha }
        updatedAt=$UpdatedAt
    }
    ($obj | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath (Join-Path $Dir $Name) -Encoding UTF8
}

$failures = @()

# Test 1: dedupe - identical receipt twice yields one event
try {
    $dir = New-TempDir; $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'r1.json' -TaskId 't1' -PayloadSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -RunId 'run1' -Status 'COMPLETED' -Attempt 1
    $r1 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True ($r1.newEvents -eq 1) 'first run should add one event'
    $r2 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True ($r2.newEvents -eq 0) 'repeated identical receipt must not create new event'
} catch { $failures += "Dedupe: $_" }

# Test 2: restart continuity - outbox persists across invocations from disk state alone
try {
    $dir = New-TempDir; $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'r1.json' -TaskId 't1' -PayloadSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -RunId 'run1' -Status 'FAILED' -Attempt 1
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox | Out-Null
    $events = @(Get-Content -LiteralPath $outbox -Raw | ConvertFrom-Json)
    Assert-True ($events.Count -eq 1) 'outbox should persist one event to disk'
    $r2 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True ($r2.pendingCount -eq 1) 'restart must read persisted outbox state'
} catch { $failures += "RestartContinuity: $_" }

# Test 3: claim expiry - retains PENDING, signals reconciliation, no owner-death assertion
try {
    $dir = New-TempDir; $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'r1.json' -TaskId 't1' -PayloadSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -RunId 'run1' -Status 'AWAITING_CONTROLLER' -Attempt 1
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox | Out-Null
    $events = @(Get-Content -LiteralPath $outbox -Raw | ConvertFrom-Json)
    $key = $events[0].key
    $claimedAt = (Get-Date).ToUniversalTime().AddSeconds(-200).ToString('o')
    $claims = @(@{ key = $key; owner = 'ownerA'; claimedAt = $claimedAt })
    $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -Claims $claims
    Assert-True ($r.claimsExpired -eq 1) 'expired claim must be counted'
    Assert-True ($r.pendingCount -eq 1) 'expired claim must remain PENDING, not auto-delivered'
    $events2 = Get-Content -LiteralPath $outbox -Raw | ConvertFrom-Json
    Assert-True ($events2[0].reconciliationSignal -eq $true) 'reconciliation signal must be set on expiry'
    Assert-True ($events2[0].deliveryStatus -eq 'PENDING') 'status must stay PENDING on claim expiry'
} catch { $failures += "ClaimExpiry: $_" }

# Test 4: queued != delivered - no evidence means PENDING forever
try {
    $dir = New-TempDir; $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'r1.json' -TaskId 't1' -PayloadSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -RunId 'run1' -Status 'SOFT_LIMIT' -Attempt 1
    $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True ($r.pendingCount -eq 1 -and $r.deliveredCount -eq 0) 'queued event without evidence must not be DELIVERED'
    $r2 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -DeliveryEvidence @(@{ key = 'bogus:key'; proof = 'x' })
    Assert-True ($r2.deliveredCount -eq 0) 'mismatched key evidence must not deliver'
} catch { $failures += "QueuedNotDelivered: $_" }

# Test 5: consent != start - exact binding yields NORMAL_REVIEW_ELIGIBLE only, never RUNNING
try {
    $dir = New-TempDir; $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'r1.json' -TaskId 't1' -PayloadSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -RunId 'run1' -Status 'FAILED' -Attempt 1 -Destination 'dest1'
    $consent = @(@{ taskId = 't1'; payloadSha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; destination = 'dest1' })
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -ConsentRecords $consent | Out-Null
    $events = @(Get-Content -LiteralPath $outbox -Raw | ConvertFrom-Json)
    Assert-True ($events[0].consentEligibility -eq 'NORMAL_REVIEW_ELIGIBLE') 'exact consent binding must mark eligibility'
    Assert-True ($events[0].status -ne 'RUNNING') 'consent must never imply RUNNING/autolaunch'
} catch { $failures += "ConsentNotStart: $_" }

# Test 6: changed payload must not reuse consent binding
try {
    $dir = New-TempDir; $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'r1.json' -TaskId 't1' -PayloadSha 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' -RunId 'run1' -Status 'FAILED' -Attempt 1 -Destination 'dest1'
    $consent = @(@{ taskId = 't1'; payloadSha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; destination = 'dest1' })
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -ConsentRecords $consent | Out-Null
    $events = @(Get-Content -LiteralPath $outbox -Raw | ConvertFrom-Json)
    Assert-True ($null -eq $events[0].consentEligibility) 'changed payload must not reuse prior consent binding'
} catch { $failures += "ChangedPayloadNoReuse: $_" }

# Test 7: latest terminal overrides historical RUNNING in lane status
try {
    $dir = New-TempDir; $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'r1.json' -TaskId 't1' -PayloadSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -RunId 'run1' -Status 'RUNNING' -Attempt 1 -UpdatedAt '2026-01-01T00:00:00Z'
    Write-Receipt -Dir $dir -Name 'r2.json' -TaskId 't1' -PayloadSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -RunId 'run1' -Status 'COMPLETED' -Attempt 2 -UpdatedAt '2026-01-01T00:05:00Z'
    $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True ($r.laneStatuses['t1'] -eq 'READY') 'latest terminal receipt must override historical RUNNING in lane status'
} catch { $failures += "TerminalOverride: $_" }

# Test 8: independent lane status - one blocked task does not affect unrelated READY task or fake overall completion
try {
    $dir = New-TempDir; $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'r1.json' -TaskId 't1' -PayloadSha 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -RunId 'run1' -Status 'COMPLETED' -Attempt 1
    Write-Receipt -Dir $dir -Name 'r2.json' -TaskId 't2' -PayloadSha ('c' * 64) -RunId 'run2' -Status 'FAILED' -Attempt 1
    $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True ($r.laneStatuses['t1'] -eq 'READY') 't1 lane must remain READY independent of t2'
    Assert-True ($r.laneStatuses['t2'] -eq 'BLOCKED') 't2 lane must be BLOCKED'
    Assert-True ($r.overallComplete -eq $false) 'overall completion must not be faked when any lane is blocked'
} catch { $failures += "IndependentLanes: $_" }

if ($failures.Count -gt 0) {
    throw "TEST FAILURES ($($failures.Count)):`n" + ($failures -join "`n")
}

Write-Output "ALL TESTS PASSED"