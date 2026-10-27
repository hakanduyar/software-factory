#Requires -Version 7.6
# Entry-level checks for scripts/github/invoke-projected-task-status.ps1.
# The child runs with PATH pointing at an EMPTY directory, so no gh of any kind is reachable:
# reaching the transport would surface as READ_FAILED, never as a delivery. Full delivery
# behaviour against a fake gh is covered by tests/workItemStatusSync.test.ts.
param([Parameter(Mandatory)][string]$EvidenceRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Test-SafeRoot([string]$Raw, [string]$Base) {
    try {
        $r = $Raw.TrimEnd([char]47, [char]92)
        if (-not [IO.Path]::IsPathRooted($r) -or [IO.Path]::GetFullPath($r) -cne $r) { return $false }
        if ([IO.Path]::GetFileName($r) -cnotmatch '^software-factory-github-[0-9a-f]{32}\z') { return $false }
        if (-not ([IO.Path]::GetDirectoryName($r) -ieq $Base)) { return $false }
        if ([IO.Directory]::Exists($r) -or [IO.File]::Exists($r)) { return $false }
        $true
    } catch { $false }
}
$TmpBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char]47, [char]92)
if (-not (Test-SafeRoot $EvidenceRoot $TmpBase)) { [Console]::Error.WriteLine('EVIDENCE_ROOT_UNSAFE'); exit 2 }
$Entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/github/invoke-projected-task-status.ps1'))
$Pwsh = (Get-Process -Id $PID).Path
$root = $EvidenceRoot.TrimEnd([char]47, [char]92)
$emptyBin = Join-Path $root 'empty-bin'
$home0 = Join-Path $root 'home'
$tmp0 = Join-Path $root 'tmp'
foreach ($d in @($root, $emptyBin, $home0, $tmp0)) { [IO.Directory]::CreateDirectory($d) | Out-Null }
$script:results = [System.Collections.Generic.List[object]]::new()
function Assert-That([string]$Name, [bool]$Ok, [string]$Detail = '') { $script:results.Add([pscustomobject]@{ name = $Name; pass = $Ok; detail = $Detail }) }

function Invoke-Entry([byte[]]$Stdin) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new($Pwsh)
    foreach ($a in @('-NoProfile', '-File', $Entry)) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false; $psi.WorkingDirectory = $root
    $psi.Environment.Clear()
    $psi.Environment['PATH'] = $emptyBin; $psi.Environment['HOME'] = $home0; $psi.Environment['TMPDIR'] = $tmp0
    $p = [System.Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
    $p.StandardInput.BaseStream.Write($Stdin, 0, $Stdin.Length)
    $p.StandardInput.Close()
    if (-not $p.WaitForExit(120000)) { $p.Kill($true); return [pscustomobject]@{ exit = -1; out = ''; err = 'TIMEOUT' } }
    [pscustomobject]@{ exit = $p.ExitCode; out = $o.GetAwaiter().GetResult(); err = $e.GetAwaiter().GetResult() }
}
function ToBytes([string]$s) { [System.Text.UTF8Encoding]::new($false).GetBytes($s) }

$cp = Join-Path $root 'checkpoint.json'
$state = Join-Path $root 'state'
function New-Env([hashtable]$Over = @{}, [hashtable]$MapOver = @{}) {
    $m = [ordered]@{ taskId = 'T-1'; repo = 'hakanduyar/software-factory'; issueNumber = 5; stableMarker = 'SF-OP-CONTINUATION-119-122' }
    foreach ($k in $MapOver.Keys) { if ($null -eq $MapOver[$k]) { $m.Remove($k) } else { $m[$k] = $MapOver[$k] } }
    $e = [ordered]@{ checkpointPath = $cp; mapping = $m; stateDir = $state; publicStatus = 'IN_PROGRESS'; nextAction = 'RUN_FOCUSED_CHECKS' }
    foreach ($k in $Over.Keys) { if ($null -eq $Over[$k]) { $e.Remove($k) } else { $e[$k] = $Over[$k] } }
    $e | ConvertTo-Json -Depth 5 -Compress
}

try {
    # 1. Source discipline: no executing text, no transport selection, fixed sibling only.
    $src = [IO.File]::ReadAllText($Entry)
    Assert-That 'source: no Invoke-Expression / iex / scriptblock creation' ($src -cnotmatch '(?i)invoke-expression|\biex\b|\[scriptblock\]::create|-Transport') 'static'
    Assert-That 'source: dot-sources only the fixed sibling engine' ([regex]::Matches($src, '(?m)^\s*\.\s+\(').Count -eq 1 -and $src.Contains("'sync-github-task-status.ps1'")) 'static'

    # 2. Envelope refusals: exit 2, empty stdout, nothing invoked.
    $bad = [ordered]@{
        'empty'              = [byte[]]@()
        'not json'           = (ToBytes 'not json')
        'trailing garbage'   = (ToBytes ((New-Env) + 'x'))
        'utf8 bom'           = ([byte[]](0xEF, 0xBB, 0xBF) + (ToBytes (New-Env)))
        'invalid utf8'       = ([byte[]](0x7B, 0xC3, 0x28, 0x7D))
        'extra top key'      = (ToBytes ((New-Env) -replace '^\{', '{"extra":1,'))
        'wrong-case top key' = (ToBytes ((New-Env) -replace '"stateDir"', '"StateDir"'))
        'duplicate top key'  = (ToBytes ((New-Env) -replace '^\{', '{"stateDir":"/x",'))
        'duplicate map key'  = (ToBytes ((New-Env) -replace '"taskId":"T-1"', '"taskId":"T-1","taskId":"T-1"'))
        'extra map key'      = (ToBytes ((New-Env) -replace '"taskId"', '"extra":1,"taskId"'))
        'missing map key'    = (ToBytes (New-Env @{} @{ stableMarker = $null }))
        'wrong-case map key' = (ToBytes ((New-Env) -replace '"repo"', '"Repo"'))
        'issue as string'    = (ToBytes (New-Env @{} @{ issueNumber = '5' }))
        'issue zero'         = (ToBytes (New-Env @{} @{ issueNumber = 0 }))
        'issue fractional'   = (ToBytes ((New-Env) -replace '"issueNumber":5', '"issueNumber":5.0'))
        'issue too large'    = (ToBytes (New-Env @{} @{ issueNumber = 3000000000 }))
        'bad status enum'    = (ToBytes (New-Env @{ publicStatus = 'in_progress' }))
        'bad action enum'    = (ToBytes (New-Env @{ nextAction = 'RUN_EVERYTHING' }))
        'relative path'      = (ToBytes (New-Env @{ checkpointPath = 'cp.json' }))
        'path not string'    = (ToBytes (New-Env @{ stateDir = 5 }))
        'injection taskId'   = (ToBytes (New-Env @{} @{ taskId = 'T-1; Remove-Item -Recurse /' }))
        'newline taskId'     = (ToBytes (New-Env @{} @{ taskId = "T-1`n" }))
        'injection repo'     = (ToBytes (New-Env @{} @{ repo = 'a/b$(touch PWNED)' }))
        'injection marker'   = (ToBytes (New-Env @{} @{ stableMarker = '`touch PWNED`' }))
        'transport field'    = (ToBytes (New-Env @{ transport = '{ param($o) }' }))
    }
    foreach ($n in $bad.Keys) {
        $r = Invoke-Entry $bad[$n]
        Assert-That "envelope refused: $n" ($r.exit -eq 2 -and $r.out -ceq '' -and $r.err.Trim() -cmatch '^ENVELOPE_[A-Z]+$') "exit=$($r.exit) err=$($r.err.Trim())"
    }
    Assert-That 'envelope refusals created no state and ran nothing' (-not (Test-Path -LiteralPath $state) -and -not (Test-Path -LiteralPath (Join-Path $root 'PWNED'))) 'fs'

    # 3. Valid envelope, engine refuses before any transport: ordinary six-field result, exit 0, not DELIVERED.
    $r = Invoke-Entry (ToBytes (New-Env))
    $j = $null; try { $j = $r.out | ConvertFrom-Json -AsHashtable -DateKind String } catch { }
    $keys = if ($j -is [hashtable]) { @($j.Keys | Sort-Object) -join ',' } else { '' }
    Assert-That 'missing checkpoint: one JSON result, exact six fields' ($r.exit -eq 0 -and $keys -ceq 'attempt,code,key,replay,status,taskId') "exit=$($r.exit) keys=$keys"
    Assert-That 'missing checkpoint: REFUSED/CHECKPOINT_MISSING, not DELIVERED' ($j -is [hashtable] -and $j['status'] -ceq 'REFUSED' -and $j['code'] -ceq 'CHECKPOINT_MISSING' -and $j['taskId'] -ceq 'T-1') "$($r.out.Trim())"
    Assert-That 'missing checkpoint: single line on stdout' ($r.out.TrimEnd("`n").IndexOf("`n") -lt 0) 'stdout'

    $cpJson = '{"updatedAt":"2026-01-01T00:00:00Z","currentActiveWork":{"id":"OTHER-TASK"}}'
    [IO.File]::WriteAllText($cp, $cpJson)
    $r = Invoke-Entry (ToBytes (New-Env))
    $j = $null; try { $j = $r.out | ConvertFrom-Json -AsHashtable -DateKind String } catch { }
    Assert-That 'mismatched checkpoint task: REFUSED/TASK_MISMATCH with exit 0' ($r.exit -eq 0 -and $j -is [hashtable] -and $j['status'] -ceq 'REFUSED' -and $j['code'] -ceq 'TASK_MISMATCH') "$($r.out.Trim())"

    # 4. Matching checkpoint, no gh reachable: transport failure is a REFUSED READ_FAILED, never DELIVERED or a hang.
    [IO.File]::WriteAllText($cp, '{"updatedAt":"2026-01-01T00:00:00Z","currentActiveWork":{"id":"T-1"}}')
    $r = Invoke-Entry (ToBytes (New-Env))
    $j = $null; try { $j = $r.out | ConvertFrom-Json -AsHashtable -DateKind String } catch { }
    Assert-That 'unreachable gh: exit 0 does not mean DELIVERED' ($r.exit -eq 0 -and $j -is [hashtable] -and $j['status'] -cne 'DELIVERED' -and $j['status'] -ceq 'REFUSED') "$($r.out.Trim())"
} catch {
    Assert-That 'test harness completed without exception' $false $_.Exception.GetType().Name
}

$failed = @($script:results | Where-Object { -not $_.pass })
$out = [ordered]@{ total = $script:results.Count; passed = ($script:results.Count - $failed.Count); failed = $failed.Count; results = $script:results }
[IO.File]::WriteAllText((Join-Path $root 'results.json'), ($out | ConvertTo-Json -Depth 5))
foreach ($x in $script:results) { Write-Host (('{0} {1} {2}' -f $(if ($x.pass) { 'PASS' } else { 'FAIL' }), $x.name, $x.detail).Trim()) }
Write-Host ('passed={0} failed={1}' -f $out.passed, $out.failed)
if ($failed.Count -gt 0 -or $script:results.Count -eq 0) { exit 1 }
exit 0
