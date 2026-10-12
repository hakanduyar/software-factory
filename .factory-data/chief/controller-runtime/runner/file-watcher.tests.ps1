Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'file-transport.ps1')
. (Join-Path $PSScriptRoot 'file-watcher.ps1')

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "node executable not found on PATH; cannot run offline fixture tests."
}
$nodeExe = $nodeCmd.Source

$artifactsRoot = Join-Path $PSScriptRoot 'test-artifacts'
if (-not (Test-Path $artifactsRoot)) {
    New-Item -ItemType Directory -Path $artifactsRoot -Force | Out-Null
}

$groupResults = [System.Collections.Generic.List[string]]::new()

function New-TestRunDir {
    param([string] $Name)
    $dir = Join-Path $artifactsRoot ("{0}-{1}" -f $Name, [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function New-NodeFixture {
    param([string] $RunDir, [string] $ScriptBody)
    $scriptPath = Join-Path $RunDir 'fixture.js'
    [System.IO.File]::WriteAllText($scriptPath, $ScriptBody, [System.Text.UTF8Encoding]::new($false))
    return $scriptPath
}

function New-PromptFile {
    param([string] $RunDir)
    $promptPath = Join-Path $RunDir 'prompt.txt'
    [System.IO.File]::WriteAllText($promptPath, 'unused', [System.Text.UTF8Encoding]::new($false))
    return $promptPath
}

function Start-TestChild {
    param([string] $RunDir, [string] $ScriptPath, [int] $Attempt = 1)
    return Start-FileTransport -Exe $nodeExe -Arguments @($ScriptPath) -WorkingDirectory $RunDir -PromptPath (New-PromptFile -RunDir $RunDir) -RunDir $RunDir -Attempt $Attempt -RemainingOutputBudget ([int64]1048576)
}

function Test-ProcessIdentityMatches {
    param([System.Diagnostics.Process] $Process, [int] $ExpectedPid, [string] $StartIdentity)
    try {
        if ($Process.Id -ne $ExpectedPid) { return $false }
        return ($Process.StartTime.ToUniversalTime().ToString('o') -eq $StartIdentity)
    } catch {
        return $false
    }
}

function Stop-VerifiedTestChild {
    param([hashtable] $Transport, [int] $WaitMs = 1000)
    try {
        $proc = $Transport.process
        if (-not (Test-ProcessIdentityMatches -Process $proc -ExpectedPid $Transport.pid -StartIdentity $Transport.startIdentity)) {
            return
        }
        $exited = $false
        try { $exited = $proc.HasExited } catch { $exited = $false }
        if (-not $exited) {
            try { $proc.Kill() } catch { }
        }
        $waited = 0
        while ($waited -lt $WaitMs) {
            try { if ($proc.HasExited) { break } } catch { break }
            Start-Sleep -Milliseconds 20
            $waited += 20
        }
    } finally {
        if ($Transport.process) {
            try { $Transport.process.Dispose() } catch { }
        }
    }
}

function Test-ChildIsAlive {
    param([hashtable] $Transport)
    try {
        return (Test-ProcessIdentityMatches -Process $Transport.process -ExpectedPid $Transport.pid -StartIdentity $Transport.startIdentity) -and (-not $Transport.process.HasExited)
    } catch {
        return $false
    }
}

function Wait-ForFileContains {
    param([string] $Path, [string] $Needle, [int] $TimeoutMs = 3000, [int] $PollMs = 20)
    $waited = 0
    while ($waited -lt $TimeoutMs) {
        if (Test-Path $Path) {
            $content = [System.IO.File]::ReadAllText($Path)
            if ($content.Contains($Needle)) { return $true }
        }
        Start-Sleep -Milliseconds $PollMs
        $waited += $PollMs
    }
    return $false
}

# ---------- Group 1: split UTF8 char, unterminated final tail, early-exit-before-watch ----------
$transport = $null
try {
    $runDir = New-TestRunDir -Name 'group1'
    $fixtureBody = @'
const first = JSON.stringify({type:"test",value:"a\u00e9b"}) + "\n";
const buf = Buffer.from(first, "utf8");
let splitAt = -1;
for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0xC3) { splitAt = i + 1; break; }
}
if (splitAt < 0) { splitAt = Math.floor(buf.length / 2); }
process.stdout.write(buf.slice(0, splitAt));
setTimeout(() => {
    process.stdout.write(buf.slice(splitAt));
    setTimeout(() => {
        process.stderr.write("FIXTURE_STDERR_MARKER\n");
        process.stdout.write('{"type":"final","value":1}');
        process.exit(0);
    }, 120);
}, 120);
'@
    $scriptPath = New-NodeFixture -RunDir $runDir -ScriptBody $fixtureBody
    $transport = Start-TestChild -RunDir $runDir -ScriptPath $scriptPath

    $waited = 0
    while ($waited -lt 5000) {
        try { if ($transport.process.HasExited) { break } } catch { break }
        Start-Sleep -Milliseconds 20
        $waited += 20
    }
    if ($waited -ge 5000) { throw "group1 fixture child did not exit before watch start as expected" }

    $state = @{}
    $captured = [System.Collections.Generic.List[object]]::new()
    $cb = { param($evt) $captured.Add($evt) | Out-Null; return 'continue' }
    $result = Invoke-OwnedFileTransportWatch -Transport $transport -State $state -OnEvent $cb -ElapsedLimitMs 3000 -PollIntervalMs 10 -ExitWaitMs 500

    if ($captured.Count -ne 2) { throw "group1 expected exactly 2 delivered events, got $($captured.Count)" }
    if ($captured[0].type -ne 'test' -or $captured[0].value -ne 'aéb') { throw "group1 first event payload mismatch" }
    if ($captured[1].type -ne 'final' -or $captured[1].value -ne 1) { throw "group1 final event payload mismatch" }
    if ($result.eventsDelivered -ne 2) { throw "group1 eventsDelivered mismatch: $($result.eventsDelivered)" }
    if (-not $result.exitConfirmed) { throw "group1 expected exitConfirmed true" }
    if ($result.exitCode -ne 0) { throw "group1 expected exitCode 0, got $($result.exitCode)" }
    if ($result.stopReason -ne 'process_exit') { throw "group1 expected stopReason process_exit, got $($result.stopReason)" }
    if ($result.stderrPath -ne $transport.stderrPath) { throw "group1 stderrPath not preserved" }
    if (-not (Test-Path $result.stderrPath)) { throw "group1 stderrPath file missing" }
    if (-not $state.final) { throw "group1 expected cursor final true" }

    $groupResults.Add("group1: PASS") | Out-Null
} catch {
    throw "group1 FAILED: $($_.Exception.Message)"
} finally {
    if ($transport) { Stop-VerifiedTestChild -Transport $transport }
}


try {
    $callbackCases = @(
        @{ Name = 'stop'; Callback = { param($evt) return 'stop' }; Expect = 'callback_stop' },
        @{ Name = 'array'; Callback = { param($evt) return @('x','y') }; Expect = 'callback_error' },
        @{ Name = 'throw'; Callback = { param($evt) throw 'boom' }; Expect = 'callback_error' }
    )
    foreach ($case in $callbackCases) {
        $transport3 = $null
        try {
            $runDir3 = New-TestRunDir -Name "group3-$($case.Name)"
            $fixtureBody3 = @'
process.stdout.write(JSON.stringify({type:"first"}) + "\n");
process.stdout.write(JSON.stringify({type:"second"}) + "\n");
process.exit(0);
'@
            $scriptPath3 = New-NodeFixture -RunDir $runDir3 -ScriptBody $fixtureBody3
            $transport3 = Start-TestChild -RunDir $runDir3 -ScriptPath $scriptPath3

            if (-not $transport3.process.WaitForExit(5000)) { throw "group3-$($case.Name) fixture child did not exit in time" }

            $state3 = @{}
            $invocationCounter = @{ count = 0 }
            $userCb = $case.Callback
            $cb3 = { param($evt) $invocationCounter.count++; & $userCb $evt }
            $result3 = Invoke-OwnedFileTransportWatch -Transport $transport3 -State $state3 -OnEvent $cb3 -ElapsedLimitMs 3000 -PollIntervalMs 10 -ExitWaitMs 500

            if ($invocationCounter.count -ne 1) { throw "group3-$($case.Name) expected exactly 1 callback invocation, got $($invocationCounter.count)" }
            if ($result3.stopReason -ne $case.Expect) { throw "group3-$($case.Name) expected stopReason $($case.Expect), got $($result3.stopReason)" }
            if (-not $result3.exitConfirmed) { throw "group3-$($case.Name) expected exitConfirmed true" }
            if (-not $state3.final) { throw "group3-$($case.Name) expected cursor final true" }

            $groupResults.Add("group3-$($case.Name): PASS") | Out-Null
        } catch {
            throw "group3-$($case.Name) FAILED: $($_.Exception.Message)"
        } finally {
            if ($transport3) { Stop-VerifiedTestChild -Transport $transport3 }
        }
    }
} catch {
    throw
}