#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'watcher-06-helpers-recovered.ps1')

$originalTransport = $null
$runDir = New-TestRunDir -Name 'watcher-livepoll'
$gate1 = Join-Path $runDir 'gate1.marker'
$gate2 = Join-Path $runDir 'gate2.marker'
$ready = Join-Path $runDir 'ready.marker'
$outFile = Join-Path $runDir 'out.dat'

$gate1Json = ($gate1 -replace '\\', '\\\\')
$gate2Json = ($gate2 -replace '\\', '\\\\')
$readyJson = ($ready -replace '\\', '\\\\')
$outJson = ($outFile -replace '\\', '\\\\')

$scriptBody = @"
const fs = require('fs');
const gate1 = '$gate1Json';
const gate2 = '$gate2Json';
const ready = '$readyJson';
const fd = 1;
const readyRecord = Buffer.from(JSON.stringify({type:'ready'}) + '\n', 'utf8');
const prefix = Buffer.from('{"type":"value","v":"a-', 'utf8');
const leadByte = Buffer.from('\u00e9', 'utf8').slice(0,1);
fs.writeSync(fd, Buffer.concat([readyRecord, prefix, leadByte]));
fs.writeFileSync(ready, 'r');
function waitFor(p) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(p)) {
    if (Date.now() > deadline) { process.exit(2); }
  }
}
waitFor(gate1);
const restByte = Buffer.from('\u00e9', 'utf8').slice(1);
const suffix = Buffer.from('-b"}\n', 'utf8');
fs.writeSync(fd, Buffer.concat([restByte, suffix]));
waitFor(gate2);
fs.writeSync(fd, Buffer.from(JSON.stringify({type:'final', done:true})));
process.exit(0);
"@

$observations = [hashtable]::Synchronized(@{})
$observations.Sequence = [System.Collections.Generic.List[string]]::new()
$observations.PartialSeen = $false
$observations.ValueCorrect = $false
$observations.FinalSeen = $false
$observations.ChildAliveAtReady = $false
$observations.ChildAliveAtValue = $false

try {
    $scriptPath = New-NodeFixture -RunDir $runDir -ScriptBody $scriptBody
    $cjsScriptPath = Join-Path $runDir 'child.cjs'
    Move-Item -LiteralPath $scriptPath -Destination $cjsScriptPath -Force
    $child = Start-TestChild -RunDir $runDir -ScriptPath $cjsScriptPath
    $originalTransport = $child

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path $ready)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw "ready marker not observed" }
        Start-Sleep -Milliseconds 20
    }

    $watchState = @{}
    $onEvent = {
        param($evt)
        if ($evt.type -eq 'ready') {
            $observations.Sequence.Add('ready')
            $pending = $watchState.pendingBytes
            if ($pending -and $pending.Count -gt 0 -and $pending[$pending.Count - 1] -eq 0xC3) {
                $observations.PartialSeen = $true
            }
            $observations.ChildAliveAtReady = Test-ChildIsAlive -Transport $originalTransport
            New-Item -ItemType File -Path $gate1 -Force | Out-Null
        }
        elseif ($evt.type -eq 'value') {
            $observations.Sequence.Add('value')
            if ($evt.v -eq "a-$([char]0xE9)-b") {
                $observations.ValueCorrect = $true
            }
            $observations.ChildAliveAtValue = Test-ChildIsAlive -Transport $originalTransport
            New-Item -ItemType File -Path $gate2 -Force | Out-Null
        }
        elseif ($evt.type -eq 'final') {
            $observations.Sequence.Add('final')
            $observations.FinalSeen = $true
        }
        return 'continue'
    }

    $result = Invoke-OwnedFileTransportWatch -Transport $originalTransport -State $watchState -OnEvent $onEvent -ElapsedLimitMs 15000 -PollIntervalMs 20 -ExitWaitMs 1000

    $expectedSeq = @('ready', 'value', 'final')
    if (@(Compare-Object $observations.Sequence $expectedSeq -SyncWindow 0).Count -ne 0) {
        throw "Unexpected callback sequence: $($observations.Sequence -join ',')"
    }
    if (-not $observations.PartialSeen) { throw "Did not observe partial UTF8 lead byte retained in pendingBytes" }
    if (-not $observations.ValueCorrect) { throw "Unicode value not reassembled correctly" }
    if (-not $observations.FinalSeen) { throw "Final record not delivered" }
    if (-not $observations.ChildAliveAtReady) { throw "Child not alive at ready callback" }
    if (-not $observations.ChildAliveAtValue) { throw "Child not alive at value callback" }
    if ($result.stopReason -ne 'process_exit') { throw "Expected stopReason process_exit, got $($result.stopReason)" }
    if (-not $result.exitConfirmed) { throw "exitConfirmed was not true" }
    if ($result.exitCode -ne 0) { throw "Expected exitCode 0, got $($result.exitCode)" }
    if (-not $result.cursorState.final) { throw "cursorState.final was not true" }
    if ($result.eventsDelivered -ne 3) { throw "Expected 3 eventsDelivered, got $($result.eventsDelivered)" }

    Write-Host "PASS"
}
finally {
    if ($originalTransport) {
        Stop-VerifiedTestChild -Transport $originalTransport
    }
}