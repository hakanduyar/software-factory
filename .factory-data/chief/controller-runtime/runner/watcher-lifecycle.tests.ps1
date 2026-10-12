Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'watcher-06-helpers-recovered.ps1')

function Wait-ForFileContainsShared {
    param([string] $Path, [string] $Needle, [int] $TimeoutMs = 3000, [int] $PollMs = 20)
    $waited = 0
    while ($waited -lt $TimeoutMs) {
        if (Test-Path $Path) {
            try {
                $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
                try {
                    $reader = [System.IO.StreamReader]::new($fs, [System.Text.Encoding]::UTF8)
                    $content = $reader.ReadToEnd()
                    if ($content.Contains($Needle)) { return $true }
                } finally {
                    $fs.Dispose()
                }
            } catch {
            }
        }
        Start-Sleep -Milliseconds $PollMs
        $waited += $PollMs
    }
    return $false
}

$sentinelTransport = $null
$timeoutTransport = $null
$identityTransport = $null

try {
    $sentinelRunDir = New-TestRunDir -Name 'lifecycle-sentinel'
    $sentinelBody = @'
process.stderr.write("SENTINEL_READY\n");
setInterval(() => {}, 1000);
'@
    $sentinelScript = New-NodeFixture -RunDir $sentinelRunDir -ScriptBody $sentinelBody
    $sentinelTransport = Start-TestChild -RunDir $sentinelRunDir -ScriptPath $sentinelScript
    if (-not (Wait-ForFileContainsShared -Path $sentinelTransport.stderrPath -Needle 'SENTINEL_READY' -TimeoutMs 3000)) {
        throw "sentinel did not become ready in time"
    }

    # ---------- Group: timeout owns verified child exit, sentinel unaffected ----------
    try {
        $timeoutRunDir = New-TestRunDir -Name 'lifecycle-timeout'
        $timeoutBody = @'
process.stderr.write("CHILD_READY\n");
setInterval(() => {}, 1000);
'@
        $timeoutScript = New-NodeFixture -RunDir $timeoutRunDir -ScriptBody $timeoutBody
        $timeoutTransport = Start-TestChild -RunDir $timeoutRunDir -ScriptPath $timeoutScript
        if (-not (Wait-ForFileContainsShared -Path $timeoutTransport.stderrPath -Needle 'CHILD_READY' -TimeoutMs 3000)) {
            throw "timeout fixture child did not become ready in time"
        }

        $state = @{}
        $cb = { param($evt) return 'continue' }
        $result = Invoke-OwnedFileTransportWatch -Transport $timeoutTransport -State $state -OnEvent $cb -ElapsedLimitMs 250 -PollIntervalMs 20 -ExitWaitMs 1000

        if ($result.stopReason -ne 'timeout') { throw "expected stopReason timeout, got $($result.stopReason)" }
        if (-not $result.exitConfirmed) { throw "expected exitConfirmed true" }
        if (-not (Test-ProcessIdentityMatches -Process $timeoutTransport.process -ExpectedPid $timeoutTransport.pid -StartIdentity $timeoutTransport.startIdentity) -or -not $timeoutTransport.process.HasExited) {
            throw "expected owned child to have exited"
        }
        if (-not $state.final) { throw "expected cursor final true" }
        if (-not (Test-ChildIsAlive -Transport $sentinelTransport)) { throw "expected sentinel to remain alive" }

        $groupResults.Add("lifecycle-timeout: PASS") | Out-Null
    } finally {
        if ($timeoutTransport) { Stop-VerifiedTestChild -Transport $timeoutTransport }
    }

    # ---------- Group: identity mismatch refuses watch, no termination ----------
    try {
        $identityRunDir = New-TestRunDir -Name 'lifecycle-identity'
        $identityBody = @'
process.stderr.write("CHILD_READY\n");
setInterval(() => {}, 1000);
'@
        $identityScript = New-NodeFixture -RunDir $identityRunDir -ScriptBody $identityBody
        $identityTransport = Start-TestChild -RunDir $identityRunDir -ScriptPath $identityScript
        if (-not (Wait-ForFileContainsShared -Path $identityTransport.stderrPath -Needle 'CHILD_READY' -TimeoutMs 3000)) {
            throw "identity fixture child did not become ready in time"
        }

        $spoofed = $identityTransport.Clone()
        $spoofed.startIdentity = '1999-01-01T00:00:00.0000000Z'

        $refused = $false
        try {
            Invoke-OwnedFileTransportWatch -Transport $spoofed -State @{} -OnEvent { param($evt) return 'continue' } -ElapsedLimitMs 500 -PollIntervalMs 20 -ExitWaitMs 500
        } catch {
            $refused = $true
        }

        if (-not $refused) { throw "expected identity mismatch to refuse watch" }
        if (-not (Test-ChildIsAlive -Transport $identityTransport)) { throw "expected actual child to remain alive after refusal" }
        if (-not (Test-ChildIsAlive -Transport $sentinelTransport)) { throw "expected sentinel to remain alive after refusal" }

        $groupResults.Add("lifecycle-identity: PASS") | Out-Null
    } finally {
        if ($identityTransport) { Stop-VerifiedTestChild -Transport $identityTransport }
    }
} finally {
    if ($sentinelTransport) { Stop-VerifiedTestChild -Transport $sentinelTransport }
}

$groupResults | Write-Output