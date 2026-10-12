Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'file-transport.ps1')

function Assert-True([bool]$Cond, [string]$Msg) { if (-not $Cond) { throw "ASSERT FAILED: $Msg" } }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { $nodeCmd = @{ Source = 'C:/Program Files/nodejs/node.exe' } }
$nodeExe = $nodeCmd.Source
if (-not (Test-Path $nodeExe)) { throw 'Refusing: node.exe not found for offline fixture tests.' }

$scratchRoot = Join-Path $PSScriptRoot 'test-artifacts'
New-Item -ItemType Directory -Force -Path $scratchRoot | Out-Null
$scratch = Join-Path $scratchRoot ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null

$fixturePath = Join-Path $scratch 'fixture.mjs'
$fixtureSrc = @'
let data = Buffer.alloc(0);
process.stdin.on("data", (c) => { data = Buffer.concat([data, c]); });
process.stdin.on("end", () => {
    process.stderr.write("ERRmarker");
    process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: data.toString("utf8"), cap: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || null }));
});
'@
[System.IO.File]::WriteAllText($fixturePath, $fixtureSrc, [System.Text.Encoding]::UTF8)

$emoji = [char]::ConvertFromUtf32(0x1F600)
$promptPath = Join-Path $scratch 'prompt.txt'
$payload = "h`u{e9}llo \no newline $emoji"
[System.IO.File]::WriteAllBytes($promptPath, [System.Text.Encoding]::UTF8.GetBytes($payload))

$runDir = Join-Path $scratch 'run'
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$parentCapBefore = [System.Environment]::GetEnvironmentVariable('CLAUDE_CODE_MAX_OUTPUT_TOKENS')

$userArgs = @('', 'has space', 'em"bed', 'trail\', 'has space and trail\')
$weirdArgs = @($fixturePath) + $userArgs
$result = $null
try {
    $result = Start-FileTransport -Exe $nodeExe -Arguments $weirdArgs -WorkingDirectory $scratch -PromptPath $promptPath -RunDir $runDir -Attempt 1 -RemainingOutputBudget 4096
    Assert-True ($result.pid -gt 0) 'PID must be positive'
    Assert-True ([datetime]::Parse($result.startIdentity).Year -ge 2026) 'startIdentity must be a real UTC timestamp'

    $exited = $result.process.WaitForExit(5000)
    if (-not $exited) { throw 'ASSERT FAILED: fixture did not exit within 5s' }

    Assert-True (Test-Path $result.stdoutPath) 'stdout log must exist'
    Assert-True (Test-Path $result.stderrPath) 'stderr log must exist'

    $stdoutText = [System.IO.File]::ReadAllText($result.stdoutPath, [System.Text.Encoding]::UTF8)
    $stderrText = [System.IO.File]::ReadAllText($result.stderrPath, [System.Text.Encoding]::UTF8)
    Assert-True ($stderrText -eq 'ERRmarker') 'stderr must contain only the fixed ERRmarker, kept separate from stdout'

    $parsed = $stdoutText | ConvertFrom-Json
    Assert-True ($parsed.argv.Count -eq 5) 'argv count must match exactly the 5 user args, excluding node and fixture path'
    Assert-True ($parsed.argv[0] -eq '') 'empty argument must survive quoting'
    Assert-True ($parsed.argv[1] -eq 'has space') 'space-containing argument must survive quoting'
    Assert-True ($parsed.argv[2] -eq 'em"bed') 'embedded quote must survive quoting'
    Assert-True ($parsed.argv[3] -eq 'trail\') 'trailing backslash must survive quoting'
    Assert-True ($parsed.argv[4] -eq 'has space and trail\') 'space-plus-trailing-backslash argument must survive quoting'
    Assert-True ($parsed.stdin -eq $payload) 'stdin bytes must be exact UTF8 payload with no added newline'
    Assert-True ($parsed.cap -eq '4096') 'process-local output cap must propagate to child only'

    $parentCapAfter = [System.Environment]::GetEnvironmentVariable('CLAUDE_CODE_MAX_OUTPUT_TOKENS')
    Assert-True ($parentCapAfter -eq $parentCapBefore) 'parent process environment must remain unchanged by the child-local cap'
} finally {
    if ($result -and $result.process) {
        try {
            if (-not $result.process.HasExited) {
                if (-not $result.process.WaitForExit(2000)) { $result.process.Kill() }
            }
        } catch {}
        $result.process.Dispose()
    }
}

$threwDup = $false
try {
    Start-FileTransport -Exe $nodeExe -Arguments @($fixturePath) -WorkingDirectory $scratch -PromptPath $promptPath -RunDir $runDir -Attempt 1 -RemainingOutputBudget 4096
} catch { $threwDup = $true }
Assert-True $threwDup 'duplicate attempt output paths must be refused before a second spawn'

Write-Output 'ALL TESTS PASSED'
