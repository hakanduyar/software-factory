#Requires -Version 7.6
param([Parameter(Mandatory)][string]$EvidenceRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'sync-runtime-status.ps1')

$root = Join-Path ([IO.Path]::GetFullPath($EvidenceRoot)) 'sync-tests'
[IO.Directory]::CreateDirectory($root) | Out-Null
$script:results = [System.Collections.Generic.List[object]]::new()

function Assert-That([string]$Name, [bool]$Ok, [string]$Detail = '') {
    $script:results.Add([pscustomobject]@{ name = $Name; pass = $Ok; detail = $Detail })
}
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
function Hold([string]$p) { [IO.File]::Open($p, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
function New-Case([string]$Name) {
    $d = Join-Path $root ($Name + '-' + [guid]::NewGuid().ToString('N'))
    $c = [pscustomobject]@{
        dir = $d; vault = (Join-Path $d 'vault'); state = (Join-Path $d 'state'); ev = (Join-Path $d 'evidence')
        cp = (Join-Path $d 'checkpoint.json'); note = (Join-Path $d 'vault/Current Runtime.md')
        statef = (Join-Path $d 'state/runtime-status-sync.state.json')
    }
    foreach ($p in $c.vault, $c.state, $c.ev) { [IO.Directory]::CreateDirectory($p) | Out-Null }
    return $c
}
function Write-Cp($c, [int]$Minute, [int64]$Reported = 0, [string]$Id = 'task-1', [string]$Status = 'active') {
    $base = [datetime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    $cp = [ordered]@{
        updatedAt = $base.AddMinutes($Minute).ToString('yyyy-MM-ddTHH:mm:ss') + 'Z'
        currentActiveWork = [ordered]@{ id = $Id; status = $Status; providerActive = $true; owner = 'worker-a' }
        operationalContinuation = [ordered]@{ status = 'accepted'; fingerprint = ('0' * 64); reportedOutput = $Reported; reservedUnknownOutput = 0; accountedOutput = $Reported }
    }
    [IO.File]::WriteAllText($c.cp, ($cp | ConvertTo-Json -Depth 5))
}
function Sync-Case($c) {
    Invoke-DurableRuntimeStatusSync -CheckpointPath $c.cp -VaultPath $c.vault -EvidenceRoot $c.ev -StateDir $c.state
}
function Read-State($c) { [IO.File]::ReadAllText($c.statef) | ConvertFrom-Json -AsHashtable -DateKind String }
function Note-Has($c, [string]$Id, [string]$Status, [string]$CpSha) {
    $t = [IO.File]::ReadAllText($c.note)
    return ($t.Contains('- Selected task: `' + $Id + '` status `' + $Status + '`') -and $t.Contains('sha256 `' + $CpSha + '`'))
}

try {
    # 1. Delivery, own-serialized-integer reload, replay with unchanged note bytes.
    $m = New-Case 'main'
    Write-Cp $m 0 0
    $sha1 = Sha $m.cp
    $r = Sync-Case $m
    Assert-That 'deliver: DELIVERED' ($r.status -eq 'DELIVERED' -and -not $r.replay) "$($r.status)/$($r.code)"
    Assert-That 'deliver: note has exact id/status/source sha' (Note-Has $m 'task-1' 'active' $sha1)
    $noteHash1 = Sha $m.note
    $r = Sync-Case $m
    Assert-That 'replay: DELIVERED replay true' ($r.status -eq 'DELIVERED' -and $r.replay -eq $true) "$($r.status)/$($r.code)"
    Assert-That 'replay: note bytes unchanged' ((Sha $m.note) -eq $noteHash1)

    # 2. Real sink failure on a new version keeps PENDING and prior note; release then same-version retry.
    Write-Cp $m 1 5
    $sha2 = Sha $m.cp
    $h = Hold (Join-Path $m.vault '.runtime.lock')
    try { $r = Sync-Case $m } finally { $h.Dispose() }
    Assert-That 'sink failure: PENDING' ($r.status -eq 'PENDING') "$($r.status)/$($r.code)"
    Assert-That 'sink failure: prior note preserved' ((Sha $m.note) -eq $noteHash1)
    $s = Read-State $m
    Assert-That 'sink failure: durable PENDING entry, history kept' ((@($s.versions.Values | Where-Object { $_.state -ceq 'PENDING' }).Count -eq 1) -and $s.latestDeliveredUpdatedAt -ne $null)
    $r = Sync-Case $m
    Assert-That 'retry after restore: DELIVERED, new sha in note' ($r.status -eq 'DELIVERED' -and (Note-Has $m 'task-1' 'active' $sha2)) "$($r.status)/$($r.code)"

    # 3. Stale older version and ambiguous same-updatedAt differing sha cannot replace newer note.
    $noteHash2 = Sha $m.note
    Write-Cp $m (-1) 9
    $r = Sync-Case $m
    Assert-That 'stale: STALE and note unchanged' ($r.status -eq 'STALE' -and (Sha $m.note) -eq $noteHash2) "$($r.status)/$($r.code)"
    Write-Cp $m 1 99
    $r = Sync-Case $m
    Assert-That 'ambiguous same updatedAt: refused, note unchanged' ($r.status -eq 'REFUSED' -and (Sha $m.note) -eq $noteHash2) "$($r.status)/$($r.code)"

    # 4. Historical delivered entry demoted by invalid note, real projector failure twice, no STATE_CORRUPT.
    $hc = New-Case 'history'
    Write-Cp $hc 0 0
    $hsha = Sha $hc.cp
    $null = Sync-Case $hc
    $origNote = [IO.File]::ReadAllText($hc.note)
    $deliveredAt = @((Read-State $hc).versions.Values)[0].deliveredAt
    [IO.File]::WriteAllText($hc.note, $origNote.Replace($hsha, ('f' * 64)))
    $h = Hold (Join-Path $hc.vault '.runtime.lock')
    try { $r1 = Sync-Case $hc; $r2 = Sync-Case $hc } finally { $h.Dispose() }
    Assert-That 'history: first demoted retry PENDING' ($r1.status -eq 'PENDING') "$($r1.status)/$($r1.code)"
    Assert-That 'history: second call not STATE_CORRUPT' ($r2.status -eq 'PENDING' -and $r2.code -cne 'STATE_CORRUPT') "$($r2.status)/$($r2.code)"
    $he = @((Read-State $hc).versions.Values)[0]
    Assert-That 'history: deliveredAt preserved, entry PENDING' ($he.state -ceq 'PENDING' -and $he.deliveredAt -ceq $deliveredAt)
    [IO.File]::WriteAllText($hc.note, $origNote)
    $r = Sync-Case $hc
    Assert-That 'history: restored note retry delivers' ($r.status -eq 'DELIVERED') "$($r.status)/$($r.code)"

    # 5. Managed-region readback: duplicate/outside lines cannot satisfy success.
    $variants = [ordered]@{
        'dup source in region' = { param($t, $sha) $l = ($t -split "`n" | Where-Object { $_.StartsWith('- Source checkpoint:') } | Select-Object -First 1); $t.Replace($l, $l + "`n" + $l) }
        'dup selected in region' = { param($t, $sha) $l = ($t -split "`n" | Where-Object { $_.StartsWith('- Selected task:') } | Select-Object -First 1); $t.Replace($l, $l + "`n" + $l) }
        'correct source only outside region' = { param($t, $sha) $l = ($t -split "`n" | Where-Object { $_.StartsWith('- Source checkpoint:') } | Select-Object -First 1).TrimEnd("`r"); $t.Replace($l, $l.Replace($sha, ('e' * 64))) + "`n" + $l + "`n" }
    }
    foreach ($vn in $variants.Keys) {
        [IO.File]::WriteAllText($hc.note, $origNote)
        $tampered = & $variants[$vn] $origNote $hsha
        [IO.File]::WriteAllText($hc.note, $tampered)
        $r = Sync-Case $hc
        $repaired = ($r.status -eq 'DELIVERED' -and (Sha $hc.note) -ne (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($tampered))) -Algorithm SHA256).Hash.ToLowerInvariant())
        Assert-That "readback: $vn not counted as success" ($r.status -eq 'PENDING' -or $repaired) "$($r.status)/$($r.code)"
    }
    [IO.File]::WriteAllText($hc.note, $origNote)

    # 6. Corruption variants, one at a time from a valid baseline: refuse with state and note unchanged.
    $mutators = [ordered]@{
        'schema string' = { param($s) $s['schema'] = '1' }
        'attempts string' = { param($s) @($s['versions'].Values)[0]['attempts'] = '1' }
        'wrong version key' = { param($s) @($s['versions'].Values)[0]['taskId'] = 'other-task' }
        'latest binding' = { param($s) $s['latestDeliveredKey'] = ('a' * 64) }
    }
    foreach ($mn in $mutators.Keys) {
        $cc = New-Case 'corrupt'
        Write-Cp $cc 0 0
        $null = Sync-Case $cc
        $s = Read-State $cc
        & $mutators[$mn] $s
        [IO.File]::WriteAllText($cc.statef, ($s | ConvertTo-Json -Depth 6))
        $stateBefore = Sha $cc.statef; $noteBefore = Sha $cc.note
        $r = Sync-Case $cc
        Assert-That "corruption: $mn refused unchanged" ($r.status -eq 'REFUSED' -and $r.code -ceq 'STATE_CORRUPT' -and (Sha $cc.statef) -eq $stateBefore -and (Sha $cc.note) -eq $noteBefore) "$($r.status)/$($r.code)"
    }

    # 7. Lexical path collision refuses before overwriting the input.
    $pc = New-Case 'collision'
    $pc.cp = $pc.statef
    Write-Cp $pc 0 0
    $before = Sha $pc.cp
    $r = Sync-Case $pc
    Assert-That 'collision: checkpoint==state refused, bytes unchanged' ($r.status -eq 'REFUSED' -and $r.code -ceq 'PATH_COLLISION' -and (Sha $pc.cp) -eq $before) "$($r.status)/$($r.code)"

    # 8. Exclusive state lock held elsewhere: LOCKED, no writes.
    $lc = New-Case 'locked'
    Write-Cp $lc 0 0
    $h = Hold (Join-Path $lc.state 'runtime-status-sync.lock')
    try { $r = Sync-Case $lc } finally { $h.Dispose() }
    Assert-That 'lock: LOCKED, no state and no note written' ($r.status -eq 'LOCKED' -and -not (Test-Path -LiteralPath $lc.statef) -and -not (Test-Path -LiteralPath $lc.note)) "$($r.status)/$($r.code)"
} catch {
    Assert-That 'test harness completed without exception' $false $_.Exception.GetType().Name
}

$failed = @($script:results | Where-Object { -not $_.pass })
$out = [ordered]@{ total = $script:results.Count; failed = $failed.Count; results = $script:results }
[IO.File]::WriteAllText((Join-Path $root 'results.json'), ($out | ConvertTo-Json -Depth 5))
foreach ($x in $script:results) { Write-Host (('{0} {1} {2}' -f $(if ($x.pass) { 'PASS' } else { 'FAIL' }), $x.name, $x.detail).Trim()) }
if ($failed.Count -gt 0) { exit 1 }
exit 0
