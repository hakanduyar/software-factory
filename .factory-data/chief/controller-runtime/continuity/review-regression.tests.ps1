Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'tests.ps1') | Out-Null

function Assert-Throws {
    param([scriptblock]$Block,[string]$Msg)
    $threw = $false
    try { & $Block | Out-Null } catch { $threw = $true }
    if (-not $threw) { throw "ASSERTION FAILED (expected throw): $Msg" }
}

$failures = @()

function Mutate-And-Check {
    param($Mutator,$Msg)
    try {
        $dir = New-TempDir
        Write-Receipt -Dir $dir -Name 'r.json' -TaskId 't1' -PayloadSha ('a'*64) -RunId 'run1' -Status 'COMPLETED' -Attempt 1
        $path = Join-Path $dir 'r.json'
        $obj = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        & $Mutator $obj
        ($obj | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $path -Encoding UTF8
        $outbox = Join-Path $dir 'outbox.json'
        $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
        if ($r.invalidReceipts -ne 1) { throw "$Msg : expected invalidReceipts=1, got $($r.invalidReceipts)" }
        if ($r.overallComplete -ne $false) { throw "$Msg : expected overallComplete=false" }
    } catch { $script:failures += "$Msg : $_" }
}

Mutate-And-Check { param($o) $o.attempt = $null } 'AttemptNull'
Mutate-And-Check { param($o) $o.attempt = 1.5 } 'AttemptFractional'
Mutate-And-Check { param($o) $o.attempt = '1' } 'AttemptString'
Mutate-And-Check { param($o) $o.budget = @{} } 'BudgetEmpty'
Mutate-And-Check { param($o) $o.artifact = @{} } 'ArtifactEmpty'
Mutate-And-Check { param($o) $o.artifact.complete = $false } 'ArtifactCompleteFalse'
Mutate-And-Check { param($o) $o.artifact.sha256 = ('f'*64) } 'ArtifactHashMismatch'
Mutate-And-Check { param($o) $o.provider.pid = 'notapid' } 'ProviderPidBad'
Mutate-And-Check { param($o) $o.provider.sessionId = 'different-session' } 'ProviderSessionIdMismatch'
Mutate-And-Check { param($o) $o.runId = 12345 } 'NumericRunId'
Mutate-And-Check { param($o) $o.budget.softFraction = '0.75' } 'StringSoftFraction'

try {
    $dir = New-TempDir
    Write-Receipt -Dir $dir -Name 'ok.json' -TaskId 't1' -PayloadSha ('a'*64) -RunId 'run1' -Status 'COMPLETED' -Attempt 1
    $outbox = Join-Path $dir 'outbox.json'
    $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    if ($r.invalidReceipts -ne 0) { throw "expected invalidReceipts=0, got $($r.invalidReceipts)" }
    if ($r.laneStatuses['t1'] -ne 'READY') { throw "expected lane READY" }
    if ($r.overallComplete -ne $true) { throw "expected overallComplete=true" }
} catch { $failures += "PositiveValidReceipt : $_" }

try {
    $receiptDir = New-TempDir
    $otherDir = New-TempDir
    Write-Receipt -Dir $receiptDir -Name 'shared.json' -TaskId 't1' -PayloadSha ('a'*64) -RunId 'run1' -Status 'COMPLETED' -Attempt 1
    $externalOutbox = Join-Path $otherDir 'shared.json'
    '[]' | Set-Content -LiteralPath $externalOutbox -Encoding UTF8
    $r = Invoke-ReceiptReconciliation -ReceiptDir $receiptDir -OutboxPath $externalOutbox
    if ($r.totalReceipts -ne 1) { throw "expected shared.json counted as receipt, got totalReceipts=$($r.totalReceipts)" }
} catch { $failures += "ExternalOutboxSameBasename : $_" }

try {
    $dir = New-TempDir
    Write-Receipt -Dir $dir -Name 'r.json' -TaskId 't1' -PayloadSha ('a'*64) -RunId 'run1' -Status 'COMPLETED' -Attempt 1
    $path = Join-Path $dir 'r.json'
    $before = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    Assert-Throws { Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $path } 'OutboxEqualsValidReceiptPath'
    $after = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($before -ne $after) { throw "receipt bytes mutated after refused reconcile" }
} catch { $failures += "OutboxEqualsReceiptPath : $_" }

try {
    $dir = New-TempDir
    Write-Receipt -Dir $dir -Name 'f.json' -TaskId 't1' -PayloadSha ('a'*64) -RunId 'run1' -Status 'FAILED' -Attempt 1
    $outbox = Join-Path $dir 'outbox.json'
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox | Out-Null
    $events = @(Get-Content -LiteralPath $outbox -Raw | ConvertFrom-Json)
    $events[0].deliveryStatus = 'DELIVERED'
    $events[0].proof = $null
    (ConvertTo-Json -InputObject @($events) -Depth 10) | Set-Content -LiteralPath $outbox -Encoding UTF8
    Assert-Throws { Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox } 'DeliveredWithNullProofMustThrow'
} catch { $failures += "DeliveredNullProof : $_" }

try {
    $dir = New-TempDir
    Write-Receipt -Dir $dir -Name 'f.json' -TaskId 't1' -PayloadSha ('a'*64) -RunId 'run1' -Status 'FAILED' -Attempt 1
    $outbox = Join-Path $dir 'outbox.json'
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox | Out-Null
    $events = @(Get-Content -LiteralPath $outbox -Raw | ConvertFrom-Json)
    $events[0].key = 'mismatched:key:value:FAILED:1'
    (ConvertTo-Json -InputObject @($events) -Depth 10) | Set-Content -LiteralPath $outbox -Encoding UTF8
    Assert-Throws { Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox } 'MismatchedKeyMustThrow'
} catch { $failures += "MismatchedKey : $_" }

if ($failures.Count -gt 0) {
    throw "REGRESSION FAILURES ($($failures.Count)):`n" + ($failures -join "`n")
}

Write-Output "ALL REGRESSION TESTS PASSED"