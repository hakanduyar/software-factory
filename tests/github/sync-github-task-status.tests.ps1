#Requires -Version 7.6
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
        $p = $Base
        while (-not [string]::IsNullOrEmpty($p)) {
            $i = [IO.DirectoryInfo]::new($p)
            if ($i.Exists -and (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $null -ne $i.LinkTarget)) { return $false }
            $p = [IO.Path]::GetDirectoryName($p)
        }
        $true
    } catch { $false }
}
$TmpBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char]47, [char]92)
$AdapterSha = '068655CAE7C6AA7D849711B83ABF4000ACA5D51B86F9CA1332B597394519AAB1'
$AdapterPath = Join-Path $PSScriptRoot '../../scripts/github/sync-github-task-status.ps1'
if (-not (Test-SafeRoot $EvidenceRoot $TmpBase)) { [Console]::Error.WriteLine('EVIDENCE_ROOT_UNSAFE'); exit 2 }
if ([Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($AdapterPath))) -cne $AdapterSha) { [Console]::Error.WriteLine('ADAPTER_SHA_MISMATCH'); exit 4 }
. $AdapterPath

$root = $EvidenceRoot.TrimEnd([char]47, [char]92)
[IO.Directory]::CreateDirectory($root) | Out-Null
$script:results = [System.Collections.Generic.List[object]]::new()
$ExpectedUrl = 'https://github.com/hakanduyar/software-factory/issues/5'
$Orig = "Intro text`nKeep me exactly`n`nSF-OP-CONTINUATION-119-122 stable marker line`n"
$Sentinel = 'PRIVATE_SENTINEL_9f3a'

function Assert-That([string]$Name, [bool]$Ok, [string]$Detail = '') { $script:results.Add([pscustomobject]@{ name = $Name; pass = $Ok; detail = $Detail }) }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
function New-Map { @{ taskId = 'PHASE7-122'; repo = 'hakanduyar/software-factory'; issueNumber = 5; stableMarker = 'SF-OP-CONTINUATION-119-122' } }
function Get-Region([string]$S = 'IN_PROGRESS', [string]$A = 'RUN_FOCUSED_CHECKS') {
    "<!-- factory-task-status:start -->`nTask: PHASE7-122`nStatus: $S`nNext action: $A`n<!-- factory-task-status:end -->"
}
function Get-CpJson([int]$Minute, [string]$Id = 'PHASE7-122') {
    $base = [datetime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    ([ordered]@{
        updatedAt = $base.AddMinutes($Minute).ToString('yyyy-MM-ddTHH:mm:ss') + 'Z'
        currentActiveWork = [ordered]@{ id = $Id; status = 'active'; providerActive = $true; owner = 'worker-a' }
        providerLog = $Sentinel
    } | ConvertTo-Json -Depth 5)
}
function New-Case([string]$Name, [int]$Minute = 0, [string]$Id = 'PHASE7-122') {
    $d = Join-Path $root ($Name + '-' + [guid]::NewGuid().ToString('N'))
    $c = [pscustomobject]@{ dir = $d; cp = (Join-Path $d 'checkpoint.json'); state = (Join-Path $d 'state'); statef = (Join-Path $d 'state/runtime-github-sync.state.json') }
    [IO.Directory]::CreateDirectory($c.state) | Out-Null
    [IO.File]::WriteAllText($c.cp, (Get-CpJson $Minute $Id))
    return $c
}
function New-Remote($c, [string]$Body = $Orig) {
    @{ body = $Body; state = 'OPEN'; url = $ExpectedUrl; number = 5; reads = 0; writes = 0; lastMap = $null; stateAtWrite = $null
       onRead = $null; onWrite = $null; failWrite = $false; storeOnFail = $false; mode = ''; statePath = $c.statef }
}
function New-Transport($r) {
    {
        param($op, $m, $b)
        if ($op -ceq 'READ') {
            $r.reads++
            if ($null -ne $r.onRead) { & $r.onRead $m }
            $url = $r.url; $body = $r.body
            if ($r.writes -gt 0) {
                if ($r.mode -ceq 'wrongUrl') { $url = 'https://github.com/other/repo/issues/5' }
                elseif ($r.mode -ceq 'dup') { $body = $body + "`n<!-- factory-task-status:start -->" }
            }
            return [pscustomobject]@{ ok = $true; number = $r.number; url = $url; state = $r.state; body = $body }
        }
        $r.writes++
        $r.lastMap = @{ taskId = $m['taskId']; repo = $m['repo']; issueNumber = $m['issueNumber']; stableMarker = $m['stableMarker'] }
        $r.stateAtWrite = if (Test-Path -LiteralPath $r.statePath) { [IO.File]::ReadAllText($r.statePath) } else { $null }
        if ($r.failWrite) {
            if ($r.storeOnFail) { $r.body = $b }
            return [pscustomobject]@{ ok = $false }
        }
        $r.body = $b
        if ($null -ne $r.onWrite) { & $r.onWrite }
        return [pscustomobject]@{ ok = $true }
    }.GetNewClosure()
}
function Sync-Case($c, $r, $Map = $null, [string]$S = 'IN_PROGRESS', [string]$A = 'RUN_FOCUSED_CHECKS') {
    if ($null -eq $Map) { $Map = New-Map }
    Invoke-DurableGitHubTaskStatusSync -CheckpointPath $c.cp -Mapping $Map -StateDir $c.state -PublicStatus $S -NextAction $A -Transport (New-Transport $r)
}
function Read-State($c) { [IO.File]::ReadAllText($c.statef) | ConvertFrom-Json -AsHashtable -DateKind String }

try {
    # 1. First delivery: PENDING before WRITE, exact public region only, replay with zero new WRITE.
    $c = New-Case 'deliver'; $r = New-Remote $c
    $res = Sync-Case $c $r
    Assert-That 'deliver: DELIVERED with one WRITE' ($res.status -eq 'DELIVERED' -and $r.writes -eq 1) "$($res.status)/$($res.code) writes=$($r.writes)"
    $atWrite = if ($null -ne $r.stateAtWrite) { $r.stateAtWrite | ConvertFrom-Json -AsHashtable -DateKind String } else { $null }
    Assert-That 'deliver: persisted PENDING observed at WRITE' ($null -ne $atWrite -and @($atWrite.versions.Values | Where-Object { $_.state -ceq 'PENDING' }).Count -eq 1)
    Assert-That 'deliver: remote body = original preserved + exact public region' ($r.body -ceq ($Orig + "`n" + (Get-Region)))
    $cpSha = Sha $c.cp
    Assert-That 'deliver: no private field, hash or path in remote body' (-not $r.body.Contains($Sentinel) -and -not $r.body.Contains($cpSha) -and -not $r.body.Contains($c.cp))
    $res = Sync-Case $c $r
    Assert-That 'replay: DELIVERED replay, zero new WRITE' ($res.status -eq 'DELIVERED' -and $res.replay -eq $true -and $r.writes -eq 1) "$($res.status)/$($res.code) writes=$($r.writes)"

    # 2a. Ambiguous WRITE (stored but reported failed) reconciled by READ with no repeat WRITE.
    $c = New-Case 'ambiguous'; $r = New-Remote $c; $r.failWrite = $true; $r.storeOnFail = $true
    $res = Sync-Case $c $r
    Assert-That 'ambiguous: PENDING after failed WRITE report' ($res.status -eq 'PENDING' -and $r.writes -eq 1) "$($res.status)/$($res.code)"
    $r.failWrite = $false
    $res = Sync-Case $c $r
    Assert-That 'ambiguous: next READ reconciles, no repeated WRITE' ($res.status -eq 'DELIVERED' -and $r.writes -eq 1) "$($res.status)/$($res.code) writes=$($r.writes)"

    # 2b. Bad readback stays PENDING; recovery from the valid same baseline.
    $c = New-Case 'readback'; $r = New-Remote $c; $r.mode = 'wrongUrl'
    $res = Sync-Case $c $r
    Assert-That 'readback wrong destination: PENDING not DELIVERED' ($res.status -eq 'PENDING') "$($res.status)/$($res.code)"
    $r.mode = 'dup'
    $res = Sync-Case $c $r
    Assert-That 'readback duplicate region: not DELIVERED' ($res.status -ne 'DELIVERED') "$($res.status)/$($res.code)"
    $r.mode = ''
    $res = Sync-Case $c $r
    Assert-That 'readback recovery: DELIVERED without extra WRITE' ($res.status -eq 'DELIVERED' -and $r.writes -eq 1) "$($res.status)/$($res.code) writes=$($r.writes)"

    # 3a. Callback mutation of caller mapping and passed table cannot redirect WRITE.
    $c = New-Case 'capture'; $r = New-Remote $c
    $callerMap = New-Map
    $r.onRead = { param($m) $m['repo'] = 'evil/repo'; $m['issueNumber'] = 999; $m['taskId'] = 'EVIL'; $callerMap['repo'] = 'evil/repo'; $callerMap['issueNumber'] = 7 }.GetNewClosure()
    $res = Sync-Case $c $r $callerMap
    $lm = $r.lastMap
    Assert-That 'capture: WRITE got original validated destination' ($res.status -eq 'DELIVERED' -and $null -ne $lm -and $lm.repo -ceq 'hakanduyar/software-factory' -and $lm.issueNumber -eq 5 -and $lm.taskId -ceq 'PHASE7-122' -and $lm.stableMarker -ceq 'SF-OP-CONTINUATION-119-122') "$($res.status)/$($res.code)"

    # 3b. Snapshot mutated during initial READ: CHECKPOINT_CHANGED, no WRITE, state unchanged.
    $c = New-Case 'snap-read'; $r = New-Remote $c
    $alt = Get-CpJson 5; $p = $c.cp
    $r.onRead = { [IO.File]::WriteAllText($p, $alt) }.GetNewClosure()
    $res = Sync-Case $c $r
    Assert-That 'snapshot change during READ: refused, WRITE 0, no state' ($res.code -ceq 'CHECKPOINT_CHANGED' -and $r.writes -eq 0 -and -not (Test-Path -LiteralPath $c.statef)) "$($res.status)/$($res.code)"

    # 3c. Snapshot mutated during WRITE/readback: PENDING, then new version recovers by READ.
    $c = New-Case 'snap-write'; $r = New-Remote $c
    $alt = Get-CpJson 5; $p = $c.cp
    $r.onWrite = { [IO.File]::WriteAllText($p, $alt) }.GetNewClosure()
    $res = Sync-Case $c $r
    Assert-That 'snapshot change during WRITE: PENDING, no false DELIVERED' ($res.status -eq 'PENDING' -and $r.writes -eq 1) "$($res.status)/$($res.code)"
    $r.onWrite = $null
    $res = Sync-Case $c $r
    Assert-That 'snapshot change: new version recovers without second WRITE' ($res.status -eq 'DELIVERED' -and $r.writes -eq 1) "$($res.status)/$($res.code) writes=$($r.writes)"

    # 4a. Ledger corruption variants from a valid delivered baseline.
    $mutators = [ordered]@{
        'schema string' = { param($s) $s['schema'] = '1' }
        'attempts string' = { param($s) @($s['versions'].Values)[0]['attempts'] = '1' }
        'task binding' = { param($s) @($s['versions'].Values)[0]['taskId'] = 'OTHER-TASK' }
        'latest binding' = { param($s) $s['latestDeliveredKey'] = ('a' * 64) }
        'history deliveredAt' = { param($s) @($s['versions'].Values)[0]['deliveredAt'] = $null }
    }
    foreach ($mn in $mutators.Keys) {
        $c = New-Case 'corrupt'; $r = New-Remote $c
        $null = Sync-Case $c $r
        $s = Read-State $c
        & $mutators[$mn] $s
        [IO.File]::WriteAllText($c.statef, ($s | ConvertTo-Json -Depth 6))
        $before = Sha $c.statef; $w = $r.writes
        $res = Sync-Case $c $r
        Assert-That "corruption: $mn refused, state unchanged, no WRITE" ($res.code -ceq 'STATE_CORRUPT' -and (Sha $c.statef) -eq $before -and $r.writes -eq $w) "$($res.status)/$($res.code)"
    }

    # 4b. Stale older version after delivery: no WRITE, remote untouched.
    $c = New-Case 'stale' 10; $r = New-Remote $c
    $null = Sync-Case $c $r
    $bodyAfter = $r.body; $w = $r.writes
    [IO.File]::WriteAllText($c.cp, (Get-CpJson 0))
    $res = Sync-Case $c $r
    Assert-That 'stale: STALE, no WRITE, remote body untouched' ($res.status -eq 'STALE' -and $r.writes -eq $w -and $r.body -ceq $bodyAfter) "$($res.status)/$($res.code)"

    # 4c. Canonical id mismatch: refused before any transport call.
    $c = New-Case 'idmismatch' 0 'PHASE7-123'; $r = New-Remote $c
    $res = Sync-Case $c $r
    Assert-That 'id mismatch: REFUSED, no transport calls' ($res.status -eq 'REFUSED' -and $r.reads -eq 0 -and $r.writes -eq 0) "$($res.status)/$($res.code)"

    # 4d. Remote destination problems refuse without WRITE or state.
    $remoteCases = [ordered]@{
        'missing marker' = { param($r) $r.body = "No marker here`n" }
        'wrong URL' = { param($r) $r.url = 'https://github.com/other/repo/issues/5' }
        'closed issue' = { param($r) $r.state = 'CLOSED' }
        'duplicate managed region' = { param($r) $r.body = $Orig + (Get-Region) + "`n" + (Get-Region) }
    }
    foreach ($rn in $remoteCases.Keys) {
        $c = New-Case 'remote'; $r = New-Remote $c
        & $remoteCases[$rn] $r
        $res = Sync-Case $c $r
        Assert-That "remote: $rn refused, no WRITE, no state" ($res.status -eq 'REFUSED' -and $r.writes -eq 0 -and -not (Test-Path -LiteralPath $c.statef)) "$($res.status)/$($res.code)"
    }
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
