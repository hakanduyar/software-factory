Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'reconcile.ps1')

function Assert-True { param($cond,$msg) if (-not $cond) { throw "ASSERTION FAILED: $msg" } }

function New-Receipt {
    param($Dir,$Name,$TaskId='t1',$Sha=('a'*64),$RunId='r1',$Status='COMPLETED',$Attempt=1,$Dest='d1',$Provider=@{},$Updated)
    if ([string]::IsNullOrWhiteSpace($Name)) { throw "New-Receipt requires -Name" }
    if (-not $Updated) { $Updated = (Get-Date).ToUniversalTime().ToString('o') }
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
    $mergedProvider = @{ pid=123; startIdentity='fake-start'; sessionId='s1'; terminalReason=$terminalReason }
    foreach ($k in $Provider.Keys) { $mergedProvider[$k] = $Provider[$k] }
    $o = [PSCustomObject]@{
        schemaVersion='OperationalRunReceipt/v1'; runId=$RunId; taskId=$TaskId; payloadSha256=$Sha
        destination=$Dest; status=$Status; attempt=$Attempt; sessionId='s1'; historyVerified=$true
        budget=@{ maxOutputTokens=1000; maxElapsedMs=60000; maxAttempts=10; softFraction=0.75; usedElapsedMs=1; usedOutputTokens=1; attemptsUsed=$Attempt }
        provider=$mergedProvider
        artifact=@{ complete=$artifactComplete; path=$artifactPath; sha256=$artifactSha }
        updatedAt=$Updated
    }
    ($o | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath (Join-Path $Dir $Name) -Encoding UTF8
}

$failures = @()
$base = Join-Path ([System.IO.Path]::GetTempPath()) "lanec_lock_$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $base -Force | Out-Null

# Lock contention: child must fail closed while parent holds transaction lock
try {
    $dir = Join-Path $base 'r1'; New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $outbox = Join-Path $dir 'outbox.json'
    New-Receipt -Dir $dir -Name 'a.json' -Status 'COMPLETED'
    $lockPath = "$outbox.transaction.lock"
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $child = $null
    try {
        $recon = (Join-Path $PSScriptRoot 'reconcile.ps1').Replace("'", "''")
        $dirEsc = $dir.Replace("'", "''")
        $outboxEsc = $outbox.Replace("'", "''")
        $cmd = ". '$recon'; try { Invoke-ReceiptReconciliation -ReceiptDir '$dirEsc' -OutboxPath '$outboxEsc' | Out-Null; exit 0 } catch { exit 13 }"
        $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
        $outFile = Join-Path $base 'child.out.txt'; $errFile = Join-Path $base 'child.err.txt'
        $child = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$enc) -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
        $exited = $child.WaitForExit(15000)
        Assert-True $exited 'child must exit within timeout'
        Assert-True ($child.ExitCode -eq 13) "child must exit 13 on lock contention, got $($child.ExitCode)"
        Assert-True (-not (Test-Path -LiteralPath $outbox)) 'outbox must not exist while lock held and child blocked'
        Assert-True (Test-Path -LiteralPath $lockPath) 'stable transaction lock file must remain present'
    } finally {
        if ($child -and -not $child.HasExited) { $child.Kill() }
        $lockStream.Dispose()
    }

    $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True (Test-Path -LiteralPath $outbox) 'outbox must be created after lock release'
    Assert-True ($r.newEvents -eq 1) 'first reconcile after release must add event'

    $reacquire = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $reacquire.Dispose()

    $r2 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True ($r2.newEvents -eq 0) 'dedupe must hold on repeated reconcile after lock cycle'
} catch { $failures += "LockBoundary: $_" }

# Status mapping / malformed receipt handling
try {
    $dir = Join-Path $base 'r2'; New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $outbox = Join-Path $dir 'custom_outbox_name.json'
    New-Receipt -Dir $dir -Name 'prep.json' -TaskId 'tp' -Status 'PREPARED' -Provider @{}
    New-Receipt -Dir $dir -Name 'unknown.json' -TaskId 'tu' -Status 'NOPE'
    '{ not json' | Set-Content -LiteralPath (Join-Path $dir 'bad.json') -Encoding UTF8
    'null' | Set-Content -LiteralPath (Join-Path $dir 'nulljson.json') -Encoding UTF8
    New-Receipt -Dir $dir -Name 'badpid.json' -TaskId 'tr' -Status 'RUNNING' -Provider @{ pid='notapid'; startIdentity='x' }
    New-Receipt -Dir $dir -Name 'outbox_named.json' -Name2 $null
    Copy-Item (Join-Path $dir 'prep.json') $outbox -ErrorAction SilentlyContinue
    '[]' | Set-Content -LiteralPath $outbox -Encoding UTF8

    $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    Assert-True ($r.laneStatuses['tp'] -eq 'PREPARING') 'PREPARED must map to PREPARING'
    Assert-True ($r.invalidReceipts -ge 4) "unknown/malformed/null/badpid must count invalid, got $($r.invalidReceipts)"
    Assert-True ($r.overallComplete -eq $false) 'invalid receipts must prevent overall completion'
} catch { $failures += "StatusMapping: $_" }

if ($failures.Count -gt 0) {
    throw "TEST FAILURES ($($failures.Count)):`n" + ($failures -join "`n")
}

Write-Output "ALL TESTS PASSED"