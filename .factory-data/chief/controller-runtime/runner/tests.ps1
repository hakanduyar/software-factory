# Fail-closed tests for launch.ps1. No network, no live provider. Throws on failure.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'launch.ps1')

function Assert-True([bool]$Cond, [string]$Msg) { if (-not $Cond) { throw "ASSERT FAILED: $Msg" } }

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "opruntest-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

$payload = 'hello world payload'
$payloadSha = Get-Sha256OfString $payload
$meta = @{
    runId = 'run-1'; taskId = 'task-1'; payload = $payload; payloadSha256 = $payloadSha
    destination = 'Anthropic Claude'; sessionId = '11111111-1111-1111-1111-111111111111'
    executable = 'C:/Users/hakan/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    budget = @{ maxOutputTokens = 1000; maxElapsedMs = 60000; maxAttempts = 3 }
}

# Test 1: interrupted/incomplete -> no complete artifact
$runDir1 = Join-Path $tmpRoot 'r1'
$runner1 = { param($exe,$args,$m,$remOut,$remElapsed)
    @{ pid = 4242; rawStdout='partial'; rawStderr=''; events = @(
        @{ type='delta'; outputTokensDelta=10; elapsedMsDelta=100 }
        @{ type='terminal_usage'; priorCumulativeOutputTokens=0; priorCumulativeElapsedMs=0; finalOutputTokensForAttempt=10; finalElapsedMsForAttempt=100; terminalReason='interrupted'; final=$true }
    ) }
}
$r1 = Invoke-OperationalRun -RequestMetadata $meta -RunDir $runDir1 -ProcessRunner $runner1
Assert-True ($r1.artifact.complete -eq $false) 'Test1: incomplete run must not have complete artifact'
Assert-True ($r1.status -eq 'FAILED') 'Test1: interrupted run should be FAILED status'

# Test 2: missing history refusal on resume
$elig2 = Test-ResumeEligibility -PriorReceipt $r1 -TaskId 'task-1' -PayloadSha256 $payloadSha -Destination 'Anthropic Claude' -SessionId $meta.sessionId -NormalReviewApproved $true -CanaryVerified $true -HistoryEvidencePath '' -HistoryEvidenceSha256 ''
Assert-True ($elig2.eligible -eq $false) 'Test2: missing history evidence must refuse resume'

# Test 3: exact identity changed refusal
$elig3 = Test-ResumeEligibility -PriorReceipt $r1 -TaskId 'task-DIFFERENT' -PayloadSha256 $payloadSha -Destination 'Anthropic Claude' -SessionId $meta.sessionId -NormalReviewApproved $true -CanaryVerified $true -HistoryEvidencePath $tmpRoot -HistoryEvidenceSha256 'abc'
Assert-True ($elig3.eligible -eq $false) 'Test3: changed taskId must refuse resume'

# Test 4: cumulative cap enforcement after resume (hard cap hit mid-attempt)
$runDir4 = Join-Path $tmpRoot 'r4'
$meta4 = $meta.Clone(); $meta4.budget = @{ maxOutputTokens = 50; maxElapsedMs = 60000; maxAttempts = 3 }
$runner4 = { param($exe,$args,$m,$remOut,$remElapsed)
    @{ pid = 555; rawStdout=''; rawStderr=''; events = @(
        @{ type='delta'; outputTokensDelta=60; elapsedMsDelta=10 }
    ) }
}
$r4 = Invoke-OperationalRun -RequestMetadata $meta4 -RunDir $runDir4 -ProcessRunner $runner4
Assert-True ($r4.status -eq 'AWAITING_CONTROLLER') 'Test4: exceeding cumulative output cap must set AWAITING_CONTROLLER'
Assert-True ($r4.budget.usedOutputTokens -ge $r4.budget.maxOutputTokens) 'Test4: usedOutputTokens must reflect hard cap breach'

# Test 5: duplicate claim refusal (lock held)
$runDir5 = Join-Path $tmpRoot 'r5'
New-Item -ItemType Directory -Force -Path $runDir5 | Out-Null
$heldLock = Lock-RunDirectory -RunDir $runDir5
try {
    $threw = $false
    try { Lock-RunDirectory -RunDir $runDir5 | Out-Null } catch { $threw = $true }
    Assert-True $threw 'Test5: duplicate active claimant on same run dir must be refused'
} finally { $heldLock.Close() }

# Test 6: 75% soft-limit warning while continuing
$runDir6 = Join-Path $tmpRoot 'r6'
$meta6 = $meta.Clone(); $meta6.budget = @{ maxOutputTokens = 100; maxElapsedMs = 60000; maxAttempts = 3 }
$runner6 = { param($exe,$args,$m,$remOut,$remElapsed)
    @{ pid = 777; rawStdout=''; rawStderr=''; events = @(
        @{ type='delta'; outputTokensDelta=80; elapsedMsDelta=10 }
    ) }
}
$r6 = Invoke-OperationalRun -RequestMetadata $meta6 -RunDir $runDir6 -ProcessRunner $runner6
Assert-True ($r6.status -eq 'SOFT_LIMIT') 'Test6: 75pct output usage must set SOFT_LIMIT status'

# Test 7: terminal without actual spawn cannot claim RUNNING
$receiptNoSpawn = New-OperationalRunReceipt -RunId 'r7' -TaskId 't7' -PayloadSha256 $payloadSha -Destination 'Anthropic Claude' -SessionId $meta.sessionId -MaxOutputTokens 100 -MaxElapsedMs 1000 -MaxAttempts 1
$threw7 = $false
try { Apply-ProviderEvent -Receipt $receiptNoSpawn -Event @{ type='delta'; outputTokensDelta=5 } } catch { $threw7 = $true }
Assert-True $threw7 'Test7: delta event without prior spawn/RUNNING must be refused'

# Test 8: truncated JSON fail-closed (bad event shape)
$receipt8 = New-OperationalRunReceipt -RunId 'r8' -TaskId 't8' -PayloadSha256 $payloadSha -Destination 'Anthropic Claude' -SessionId $meta.sessionId -MaxOutputTokens 100 -MaxElapsedMs 1000 -MaxAttempts 1
$receipt8 = Apply-ProviderEvent -Receipt $receipt8 -Event @{ type='spawn'; pid=999 }
$threw8 = $false
try { Apply-ProviderEvent -Receipt $receipt8 -Event @{ type='delta' } } catch { $threw8 = $true }
Assert-True $threw8 'Test8: malformed/truncated delta event must fail closed'

# Test 9: pinned CLI version capture - actual identity + stream hash/length evidence, no ACK/projection
$runDir9 = Join-Path $tmpRoot 'native-capture'
$artifactPath9 = Join-Path $tmpRoot 'native-artifact-9.bin'
$request9 = @{
    RunId = 'native-cap-9'
    Attempt = [int]1
    TicketPath = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\product-slice-128\observational-fixture\ticket.json'
    PayloadPath = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\product-slice-128\observational-fixture\payload.txt'
    GateTicketPath = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\product-slice-128\observational-fixture\gate-ticket.json'
    SettingsPath = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\product-slice-128\observational-fixture\settings.json'
    ArtifactPath = $artifactPath9
    WorkingDirectory = $PWD.Path
    Arguments = [string[]]@('--version')
    MaxElapsedMs = [int]60000
    MaxStreamBytes = [int]65536
}
$cap9 = Invoke-ManagedNativeCollector -Request $request9 -RunDir $runDir9
Assert-True ($cap9.State -eq 'TERMINAL') 'Test9: observational capture must reach TERMINAL state'
Assert-True ($cap9.Terminal.exitObserved -eq $true) 'Test9: terminal record must observe actual exit'
Assert-True ($cap9.Terminal.definitive -eq $true) 'Test9: terminal record must be definitive, not inferred'
Assert-True ($cap9.Terminal.onStartedAcknowledged -eq $false) 'Test9: collector-only path must not perform onStarted ACK'
Assert-True ($cap9.ProjectionStatus -eq 'NONE') 'Test9: collector-only path must not perform terminal projection'
Assert-True ($cap9.Terminal.pid -gt 0) 'Test9: terminal record must carry the actual observed pid'
Assert-True (-not [string]::IsNullOrEmpty($cap9.Terminal.startTimeUtc)) 'Test9: terminal record must carry the actual observed start time'
Assert-True ($cap9.Terminal.stdout.retainedBytes -ge 0 -and $cap9.Terminal.stderr.retainedBytes -ge 0) 'Test9: retained stream byte counts must be observed, non-negative'
$stdoutBytes9 = [System.IO.File]::ReadAllBytes((Join-Path $runDir9 $cap9.Terminal.stdout.file))
$stderrBytes9 = [System.IO.File]::ReadAllBytes((Join-Path $runDir9 $cap9.Terminal.stderr.file))
Assert-True ((Get-Sha256Hex $stdoutBytes9) -eq $cap9.Terminal.stdout.sha256) 'Test9: stdout.bin content must hash to the recorded stdout sha256'
Assert-True ((Get-Sha256Hex $stderrBytes9) -eq $cap9.Terminal.stderr.sha256) 'Test9: stderr.bin content must hash to the recorded stderr sha256'
Assert-True ($stdoutBytes9.Length -eq $cap9.Terminal.stdout.retainedBytes) 'Test9: stdout.bin length must equal recorded retainedBytes'
Assert-True ($stderrBytes9.Length -eq $cap9.Terminal.stderr.retainedBytes) 'Test9: stderr.bin length must equal recorded retainedBytes'
Assert-True (($stdoutBytes9.Length + $stderrBytes9.Length) -eq $cap9.Terminal.observedBytes) 'Test9: observedBytes must equal the sum of actual retained stream lengths'
Assert-True (Test-Path $cap9.TerminalPath) 'Test9: terminal manifest file must actually exist on disk'
$manifestBytes9 = [System.IO.File]::ReadAllBytes($cap9.TerminalPath)
Assert-True ((Get-Sha256Hex $manifestBytes9) -eq $cap9.TerminalSha256) 'Test9: emitted TerminalSha256 must match the actual manifest file bytes'
$manifest9 = Get-Content -Raw -Path (Join-Path $runDir9 'manifest.json') | ConvertFrom-Json
$requestCanonical9 = $manifest9.requestCanonical | ConvertFrom-Json
Assert-True ($requestCanonical9.settingsApplied -eq $false) 'Test9: observational fixture settings must not be applied to the pinned run'
Assert-True ($cap9.Terminal.artifact.state -eq 'ABSENT' -and $cap9.Terminal.artifact.path -eq $artifactPath9 -and -not (Test-Path $artifactPath9) -and $null -eq $cap9.Terminal.artifact.sha256 -and $null -eq $cap9.Terminal.artifact.length) 'Test9: no artifact produced for --version run; state must be ABSENT retaining the captured artifactPath with no file on disk and null hash/length'

# Save bounded actual identity/hash evidence as emitted proof before replay/cleanup
$evidence9 = @{
    runId = $cap9.RunId
    attempt = $cap9.Attempt
    terminalPath = $cap9.TerminalPath
    terminalSha256 = $cap9.TerminalSha256
    pid = $cap9.Terminal.pid
    startTimeUtc = $cap9.Terminal.startTimeUtc
    stdoutSha256 = $cap9.Terminal.stdout.sha256
    stderrSha256 = $cap9.Terminal.stderr.sha256
    observedBytes = $cap9.Terminal.observedBytes
}
$evidencePath9 = Join-Path $tmpRoot 'native-capture-evidence.json'
$evidence9 | ConvertTo-Json -Depth 6 | Set-Content -Path $evidencePath9 -Encoding utf8

# Test 10: exact same request replayed must reuse the same captured identity/terminal bytes, no respawn/re-projection
$cap10 = Invoke-ManagedNativeCollector -Request $request9 -RunDir $runDir9
Assert-True ($cap10.State -eq 'TERMINAL') 'Test10: replay of an already-terminal run must still report TERMINAL state'
Assert-True ($cap10.Terminal.pid -eq $cap9.Terminal.pid) 'Test10: replay must not respawn - observed pid must be identical'
Assert-True ($cap10.Terminal.startTimeUtc -eq $cap9.Terminal.startTimeUtc) 'Test10: replay must not respawn - observed start time must be identical'
Assert-True ($cap10.TerminalSha256 -eq $cap9.TerminalSha256) 'Test10: replay must reproduce the exact same terminal manifest bytes'
Assert-True ($cap10.Terminal.stdout.sha256 -eq $cap9.Terminal.stdout.sha256) 'Test10: replay must reproduce the exact same stdout bytes'
Assert-True ($cap10.Terminal.stderr.sha256 -eq $cap9.Terminal.stderr.sha256) 'Test10: replay must reproduce the exact same stderr bytes'
Assert-True ($cap10.Terminal.onStartedAcknowledged -eq $false) 'Test10: replay must not perform onStarted ACK'
Assert-True ($cap10.ProjectionStatus -eq 'NONE') 'Test10: replay must not perform terminal projection'
$replayEvidence10 = Get-Content -Raw -Path $evidencePath9 | ConvertFrom-Json
Assert-True ($replayEvidence10.terminalSha256 -eq $cap10.TerminalSha256) 'Test10: saved pre-replay evidence must match the replayed terminal sha256'

# Persist bounded capture/replay identity evidence and the actual capture leaves before the temp tree is removed
$evidenceOutputDir9 = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\product-slice-128\validation02-native-evidence'
New-Item -ItemType Directory -Force -Path $evidenceOutputDir9 | Out-Null
$finalEvidence9 = @{
    runId = $cap10.RunId
    attempt = $cap10.Attempt
    terminalPath = $cap10.TerminalPath
    terminalSha256 = $cap10.TerminalSha256
    pid = $cap10.Terminal.pid
    startTimeUtc = $cap10.Terminal.startTimeUtc
    stdoutSha256 = $cap10.Terminal.stdout.sha256
    stderrSha256 = $cap10.Terminal.stderr.sha256
    observedBytes = $cap10.Terminal.observedBytes
}
$finalEvidence9 | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $evidenceOutputDir9 'native-capture-evidence.json') -Encoding utf8
foreach ($leaf9 in @('manifest.json','start.json','terminal.json','stdout.bin','stderr.bin')) {
    $leafSrc9 = Join-Path $runDir9 $leaf9
    if (Test-Path $leafSrc9) { Copy-Item -Path $leafSrc9 -Destination (Join-Path $evidenceOutputDir9 $leaf9) -Force }
}

# Test 11: byte-capped stream overflow - retained <= 1, observed > 1, exact STREAM_BYTE_OVERFLOW reason
$runDir11 = Join-Path $tmpRoot 'native-overflow'
$request11 = $request9.Clone()
$request11.RunId = 'native-overflow'
$request11.MaxStreamBytes = [int]1
$cap11 = Invoke-ManagedNativeCollector -Request $request11 -RunDir $runDir11
Assert-True ($cap11.State -eq 'TERMINAL') 'Test11: byte-capped capture must still reach TERMINAL state'
Assert-True ($cap11.Terminal.exitObserved -eq $true) 'Test11: byte-capped terminal record must observe actual exit'
Assert-True ($cap11.Terminal.definitive -eq $true) 'Test11: byte-capped terminal record must be definitive, not inferred'
Assert-True ($cap11.Terminal.observedBytes -gt 1) 'Test11: observedBytes must exceed the 1-byte cap'
Assert-True (($cap11.Terminal.stdout.retainedBytes + $cap11.Terminal.stderr.retainedBytes) -le 1) 'Test11: combined retainedBytes must not exceed the configured cap'
Assert-True ($cap11.Terminal.reason -eq 'STREAM_BYTE_OVERFLOW') 'Test11: overflow terminal reason must be exactly STREAM_BYTE_OVERFLOW'

# Persist overflow identity proof before cleanup
$overflowEvidenceDir = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\product-slice-128\validation05-overflow-evidence'
New-Item -ItemType Directory -Force -Path $overflowEvidenceDir | Out-Null
$overflowEvidence = @{
    runId = $cap11.RunId
    attempt = $cap11.Attempt
    pid = $cap11.Terminal.pid
    exitObserved = $cap11.Terminal.exitObserved
    definitive = $cap11.Terminal.definitive
    reason = $cap11.Terminal.reason
    observedBytes = $cap11.Terminal.observedBytes
    stdoutRetainedBytes = $cap11.Terminal.stdout.retainedBytes
    stderrRetainedBytes = $cap11.Terminal.stderr.retainedBytes
}
$overflowEvidence | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $overflowEvidenceDir 'overflow-evidence.json') -Encoding utf8
foreach ($leaf11 in @('manifest.json','start.json','terminal.json','stdout.bin','stderr.bin')) {
    $leafSrc11 = Join-Path $runDir11 $leaf11
    if (Test-Path $leafSrc11) { Copy-Item -Path $leafSrc11 -Destination (Join-Path $overflowEvidenceDir $leaf11) -Force }
}

# PHASE7-128 persisted-record schema typed-coercion refusal (manifest/start/terminal)
$schemaCases128 = @(
    @{ Name = 'manifest.json'; Expected = 'Refusing: persisted manifest schema is not ManagedNativeCollector/v1.' },
    @{ Name = 'start.json'; Expected = 'Refusing: persisted start schema is not ManagedNativeStart/v1.' },
    @{ Name = 'terminal.json'; Expected = 'Refusing: persisted terminal schema is not ManagedNativeTerminal/v1.' }
)
function Get-LeafSnapshot128 {
    param([string]$Dir)
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Recurse -Force -File | Sort-Object FullName)) {
        $rel = $f.FullName.Substring($Dir.Length).TrimStart([char]92, [char]47)
        $lines.Add($rel + '=' + (Get-Sha256Hex ([byte[]][System.IO.File]::ReadAllBytes($f.FullName))))
    }
    return ($lines.ToArray() -join ';')
}
$utf8NoBom128 = New-Object System.Text.UTF8Encoding($false)
$pre128 = Get-LeafSnapshot128 -Dir $runDir9
foreach ($leafName128 in @('manifest.json', 'start.json', 'terminal.json', 'stdout.bin', 'stderr.bin')) {
    Assert-True ($pre128.Contains($leafName128 + '=')) ('PHASE7-128 precondition: evidence leaf missing: ' + $leafName128)
}
foreach ($case128 in $schemaCases128) {
    $leaf128 = Join-Path $runDir9 $case128.Name
    $orig128 = [byte[]][System.IO.File]::ReadAllBytes($leaf128)
    try {
        $text128 = $utf8NoBom128.GetString($orig128).TrimStart([char]0xFEFF)
        $obj128 = ConvertFrom-Json -InputObject $text128 -DateKind String
        Assert-True ($obj128.schema -is [string]) ('PHASE7-128 ' + $case128.Name + ': original schema is not a string.')
        $obj128.schema = @([string]$obj128.schema)
        $json128 = ConvertTo-Json -InputObject $obj128 -Depth 100 -Compress
        [System.IO.File]::WriteAllBytes($leaf128, [byte[]]$utf8NoBom128.GetBytes($json128))
        $chk128 = ConvertFrom-Json -InputObject $utf8NoBom128.GetString([byte[]][System.IO.File]::ReadAllBytes($leaf128)) -DateKind String
        Assert-True (($chk128.schema -is [System.Array]) -and (@($chk128.schema).Count -eq 1)) ('PHASE7-128 ' + $case128.Name + ': corrupted schema is not a one-element array.')
        $corruptedBytes128 = [byte[]][System.IO.File]::ReadAllBytes($leaf128)
        $corruptedSha128 = Get-Sha256Hex $corruptedBytes128
        $snapBefore128 = Get-LeafSnapshot128 -Dir $runDir9
        $threw128 = $false
        $msg128 = ''
        try {
            $null = Invoke-ManagedNativeCollector -Request $request9 -RunDir $runDir9
        } catch {
            $threw128 = $true
            $msg128 = [string]$_.Exception.Message
        }
        Assert-True $threw128 ('PHASE7-128 ' + $case128.Name + ': collector did not refuse array-wrapped schema.')
        Assert-True ($msg128.Contains($case128.Expected)) ('PHASE7-128 ' + $case128.Name + ': refusal was not the schema refusal; got: ' + $msg128)
        $snapAfter128 = Get-LeafSnapshot128 -Dir $runDir9
        Assert-True ($snapAfter128 -ceq $snapBefore128) ('PHASE7-128 ' + $case128.Name + ': evidence leaves changed, added or removed during refusal.')
        Assert-True ((Get-Sha256Hex ([byte[]][System.IO.File]::ReadAllBytes($leaf128))) -ceq $corruptedSha128) ('PHASE7-128 ' + $case128.Name + ': corrupted leaf bytes were modified.')
    } finally {
        [System.IO.File]::WriteAllBytes($leaf128, $orig128)
    }
    Assert-True ((Get-Sha256Hex ([byte[]][System.IO.File]::ReadAllBytes($leaf128))) -ceq (Get-Sha256Hex $orig128)) ('PHASE7-128 ' + $case128.Name + ': original bytes were not restored.')
}
Assert-True ((Get-LeafSnapshot128 -Dir $runDir9) -ceq $pre128) 'PHASE7-128: evidence tree not restored to pre-corruption state.'
Write-Host 'PASS PHASE7-128 schema typed-coercion refusal: manifest/start/terminal refused, bytes unchanged, originals restored'
# PHASE7-128 settings/tool pre-spawn author-mode refusal (three variants, no reservation/spawn)
$testSelfPath128 = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'tests.ps1'))
$authorArgvBase128 = @('--print', '--verbose', '--output-format', 'stream-json', '--model', 'sonnet', '--effort', 'low', '--max-turns', '1')
$toolsArgv128 = @('--tools', 'Read,Edit', '--allowedTools', "Read($testSelfPath128)", "Edit($testSelfPath128)")

function Write-AuthorSettings128 {
    param([string]$Path, [hashtable]$Content)
    $json = $Content | ConvertTo-Json -Depth 6 -Compress
    Set-Content -Path $Path -Value $json -Encoding utf8
}

$settingsLeafCases128 = @(
    @{
        Name = 'root-key'
        Settings = @{ permissions = @{ defaultMode = 'bypassPermissions' } }
        IncludeToolsArgv = $true
        Expected = 'Refusing: settings must contain only the env key; no permissions/defaultMode/ambient keys.'
    },
    @{
        Name = 'token-cap-overflow'
        Settings = @{ env = @{ CLAUDE_CODE_MAX_OUTPUT_TOKENS = '9223372036854775808' } }
        IncludeToolsArgv = $true
        Expected = 'Refusing: settings CLAUDE_CODE_MAX_OUTPUT_TOKENS must be a positive finite token cap.'
    },
    @{
        Name = 'missing-tools-flags'
        Settings = @{ env = @{ CLAUDE_CODE_MAX_OUTPUT_TOKENS = '100' } }
        IncludeToolsArgv = $false
        Expected = 'Refusing: author mode requires --print, the exact captured --settings, --tools, and --allowedTools.'
    }
)

foreach ($case128b in $settingsLeafCases128) {
    $variantSettingsPath128 = Join-Path $tmpRoot ("settings-leaf-" + $case128b.Name + ".json")
    Write-AuthorSettings128 -Path $variantSettingsPath128 -Content $case128b.Settings

    $variantRunId128 = 'settings-leaf-' + $case128b.Name
    $variantRunDir128 = Join-Path $tmpRoot ('native-' + $case128b.Name)
    Assert-True (-not (Test-Path $variantRunDir128)) ('PHASE7-128 ' + $case128b.Name + ': RunDir must not exist before the refused run.')

    $variantRequest128 = $request9.Clone()
    $variantRequest128.RunId = $variantRunId128
    $variantRequest128.SettingsPath = $variantSettingsPath128
    $variantArgv128 = [string[]]($authorArgvBase128 + @('--settings', $variantSettingsPath128))
    if ($case128b.IncludeToolsArgv) { $variantArgv128 = [string[]]($variantArgv128 + $toolsArgv128) }
    $variantRequest128.Arguments = $variantArgv128

    $threw128b = $false
    $msg128b = ''
    try {
        $null = Invoke-ManagedNativeCollector -Request $variantRequest128 -RunDir $variantRunDir128
    } catch {
        $threw128b = $true
        $msg128b = [string]$_.Exception.Message
    }
    Assert-True $threw128b ('PHASE7-128 ' + $case128b.Name + ': author argv did not refuse before reservation/spawn.')
    Assert-True ($msg128b.Contains($case128b.Expected)) ('PHASE7-128 ' + $case128b.Name + ': refusal was not the intended refusal; got: ' + $msg128b)
    Assert-True (-not (Test-Path $variantRunDir128)) ('PHASE7-128 ' + $case128b.Name + ': RunDir must not exist after the refused run.')
}
Write-Host 'PASS PHASE7-128 settings/tool pre-spawn author-mode refusal: root-key, token-cap-overflow, missing-tools-flags'

$tmpRootResolved = [System.IO.Path]::GetFullPath($tmpRoot)
$tempRootBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if ($tmpRootResolved.StartsWith($tempRootBase, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $tmpRootResolved) -like 'opruntest-*') {
    Remove-Item -Recurse -Force $tmpRootResolved -ErrorAction SilentlyContinue
}
Write-Output 'ALL TESTS PASSED'
