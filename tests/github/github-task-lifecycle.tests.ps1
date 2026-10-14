#Requires -Version 7.6
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CandidatePath,
  [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{64}$')][string]$ExpectedSourceSha256,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$EvidenceRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$nl = [string][char]10
$q = [string][char]34
$AdapterSha = '068655CAE7C6AA7D849711B83ABF4000ACA5D51B86F9CA1332B597394519AAB1'
$C0 = @{ repo = 'hakanduyar/software-factory'; markerNamespace = 'factory-task' }
function GhLcSha([byte[]]$b) { [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)) }
function GhLcShaStr([string]$s) { (GhLcSha ([System.Text.Encoding]::UTF8.GetBytes($s))).ToLowerInvariant() }
$root = [System.IO.Path]::GetFullPath($EvidenceRoot).TrimEnd([char]47, [char]92)
function GhLcSafeRoot([string]$Raw, [string]$Base) {
  try {
    $r = $Raw.TrimEnd([char]47, [char]92)
    if (-not [System.IO.Path]::IsPathRooted($r) -or [System.IO.Path]::GetFullPath($r) -cne $r) { return $false }
    if ([System.IO.Path]::GetFileName($r) -cnotmatch '^software-factory-github-[0-9a-f]{32}\z') { return $false }
    if (-not ([System.IO.Path]::GetDirectoryName($r) -ieq $Base)) { return $false }
    if ([System.IO.Directory]::Exists($r) -or [System.IO.File]::Exists($r)) { return $false }
    $p = $Base
    while (-not [string]::IsNullOrEmpty($p)) {
      $i = [System.IO.DirectoryInfo]::new($p)
      if ($i.Exists -and (($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $null -ne $i.LinkTarget)) { return $false }
      $p = [System.IO.Path]::GetDirectoryName($p)
    }
    $true
  } catch { $false }
}
$tmpBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char]47, [char]92)
$cand = [System.IO.Path]::GetFullPath($CandidatePath)
$adapter = Join-Path $PSScriptRoot '../../scripts/github/sync-github-task-status.ps1'
if (-not (GhLcSafeRoot $EvidenceRoot $tmpBase)) { [Console]::Error.WriteLine('EVIDENCE_ROOT_MISMATCH'); exit 2 }
if ((GhLcSha ([System.IO.File]::ReadAllBytes($cand))) -cne $ExpectedSourceSha256.ToUpperInvariant()) { [Console]::Error.WriteLine('CANDIDATE_SHA_MISMATCH'); exit 3 }
if ((GhLcSha ([System.IO.File]::ReadAllBytes($adapter))) -cne $AdapterSha) { [Console]::Error.WriteLine('ADAPTER_SHA_MISMATCH'); exit 4 }
[System.IO.Directory]::CreateDirectory($root) | Out-Null
$run = Join-Path $root ([guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($run) | Out-Null
. $cand
. $adapter
$Results = [System.Collections.Generic.List[object]]::new()
function GhLcRec([string]$Name, [bool]$Pass, [string]$Detail = '') { $Results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail }) }
function GhLcCheck([string]$Name, [scriptblock]$Fn) {
  $glMsg = ''
  try { $glLast = @(& $Fn) | Select-Object -Last 1; $glOk = ($glLast -is [bool]) -and $glLast } catch { $glOk = $false; $glMsg = $_.Exception.Message }
  GhLcRec $Name $glOk $glMsg
}
function GhLcDir { $p = Join-Path $run ([guid]::NewGuid().ToString('N')); [System.IO.Directory]::CreateDirectory($p) | Out-Null; $p }
function GhLcNewFx { @{ issues = [System.Collections.Generic.List[object]]::new(); calls = [System.Collections.Generic.List[string]]::new(); hooks = @{}; mode = 'ok'; find = $null; readBody = $null } }
function GhLcSeed($Fx, [string]$Body, [string]$Title = 'Add focused tests', [string]$State = 'OPEN', [int]$N = 7) { $Fx.issues.Add([pscustomobject]@{ number = $N; title = $Title; body = $Body; state = $State }) }
function GhLcTransport($Fx) {
  {
    param([string]$op, [hashtable]$rq)
    $Fx.calls.Add($op)
    if ($Fx.hooks.ContainsKey($op)) { $h = $Fx.hooks[$op]; $Fx.hooks.Remove($op); & $h }
    $u = 'https://github.com/hakanduyar/software-factory/issues/'
    if ($op -ceq 'FIND') {
      if ($null -ne $Fx.find) { return (& $Fx.find) }
      $hit = @($Fx.issues | Where-Object { @($_.body.Split([char]10)) -ccontains $rq.renderedMarker })
      return [pscustomobject]@{ ok = $true; complete = $true; issues = @($hit | ForEach-Object { [pscustomobject]@{ number = $_.number; url = $u + $_.number } }) }
    }
    if ($op -ceq 'CREATE') {
      if ($Fx.mode -ceq 'throw') { throw 'CREATE_FAULT' }
      $n = 100 + $Fx.issues.Count
      $Fx.issues.Add([pscustomobject]@{ number = $n; title = $rq.title; body = $rq.body; state = 'OPEN' })
      if ($Fx.mode -ceq 'storethrow') { throw 'CREATE_FAULT' }
      return [pscustomobject]@{ ok = $true; number = $n; url = $u + $n }
    }
    if ($op -ceq 'READ') {
      $i = $Fx.issues | Where-Object { $_.number -eq $rq.issueNumber } | Select-Object -First 1
      if ($null -eq $i) { return [pscustomobject]@{ ok = $false } }
      $bd = if ($null -ne $Fx.readBody) { $Fx.readBody } else { $i.body }
      return [pscustomobject]@{ ok = $true; number = $i.number; url = $u + $i.number; state = $i.state; title = $i.title; body = $bd }
    }
    throw 'UNSUPPORTED_OPERATION'
  }.GetNewClosure()
}
function GhLcEvent([string]$Dir, [hashtable]$O = @{}) {
  $e = [ordered]@{ schema = 'GitHubCreateEvent/v1'; taskId = 'T-1'; canonicalVersion = 1; publicTitle = 'Add focused tests'; publicSummary = 'Initial summary'; publicStatus = 'IN_PROGRESS'; nextAction = 'RUN_FOCUSED_CHECKS' }
  foreach ($k in $O.Keys) { if ($null -eq $O[$k]) { $e.Remove($k) } else { $e[$k] = $O[$k] } }
  $p = Join-Path $Dir ('ev-' + [guid]::NewGuid().ToString('N') + '.json')
  [System.IO.File]::WriteAllText($p, ($e | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
  $p
}
function GhLcMutateEvent([string]$Ev) { [System.IO.File]::WriteAllText($Ev, [System.IO.File]::ReadAllText($Ev).Replace('canonicalVersion' + $q + ':1', 'canonicalVersion' + $q + ':2')) }
function GhLcBody([string]$Id, [int]$V = 1, [string]$Sum = 'Initial summary', [string]$St = 'IN_PROGRESS', [string]$Nx = 'RUN_FOCUSED_CHECKS') {
  '<!-- factory-task-' + (GhLcShaStr $Id) + ' -->' + $nl + $nl + '<!-- factory-task-status:start -->' + $nl + 'Task: ' + $Id + $nl + 'Version: ' + $V + $nl + 'Status: ' + $St + $nl + 'Next action: ' + $Nx + $nl + 'Summary: ' + $Sum + $nl + '<!-- factory-task-status:end -->'
}
function GhLcRun($Fx, [string]$Ev, [string]$Sd, $Cfg = $C0) { Invoke-DurableGitHubTaskCreate -EventPath $Ev -Configuration $Cfg -StateDir $Sd -Transport (GhLcTransport $Fx) }
function GhLcN($Fx, [string]$Op) { @($Fx.calls | Where-Object { $_ -ceq $Op }).Count }
function GhLcState([string]$Sd) { [System.IO.File]::ReadAllText((Join-Path $Sd 'github-task-lifecycle.state.json')) | ConvertFrom-Json -AsHashtable -DateKind String }
function GhLcTasks([string]$Sd) { if (-not [System.IO.File]::Exists((Join-Path $Sd 'github-task-lifecycle.state.json'))) { return 0 }; (GhLcState $Sd)['tasks'].Count }
function GhLcPhase([string]$Sd) { @((GhLcState $Sd)['tasks'].Values)[0]['phase'] }
function GhLcBase([string]$Mode = 'ok') {
  $d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx; $fx.mode = $Mode; $ev = GhLcEvent $d
  $r = GhLcRun $fx $ev $sd
  [pscustomobject]@{ d = $d; sd = $sd; fx = $fx; ev = $ev; r = $r }
}
function GhLcRefuse([string]$Name, [string]$Cat, [hashtable]$EvO = @{}, $Cfg = $null, [scriptblock]$Seed = $null, [scriptblock]$Mut = $null) {
  $d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx; $ev = GhLcEvent $d $EvO
  if ($null -ne $Seed) { $null = & $Seed $fx }
  if ($null -ne $Mut) { [System.IO.File]::WriteAllText($ev, [string](& $Mut ([System.IO.File]::ReadAllText($ev)))) }
  if ($null -eq $Cfg) { $Cfg = $C0 }
  try {
    $r = GhLcRun $fx $ev $sd $Cfg
    $good = $r.status -ceq 'REFUSED' -and $r.code -cmatch '^[A-Z][A-Z_]*$' -and ($Cat.Length -eq 0 -or $r.code -ceq $Cat) -and -not $r.PSObject.Properties['mapping'] -and (GhLcN $fx 'CREATE') -eq 0 -and (GhLcTasks $sd) -eq 0
    $det = [string]$r.code
  } catch { $good = $false; $det = $_.Exception.Message }
  GhLcRec $Name $good $det
}
function GhLcCorrupt([string]$Name, [string]$Mode, [scriptblock]$Edit) {
  $bs = GhLcBase $Mode
  try {
    $s = GhLcState $bs.sd; $out = & $Edit $s
    [System.IO.File]::WriteAllText((Join-Path $bs.sd 'github-task-lifecycle.state.json'), $(if ($out -is [string]) { $out } else { $s | ConvertTo-Json -Depth 6 -Compress }))
    $f2 = GhLcNewFx; $r = GhLcRun $f2 $bs.ev $bs.sd
    $good = $r.status -ceq 'REFUSED' -and $f2.calls.Count -eq 0; $det = [string]$r.code
  } catch { $good = $false; $det = $_.Exception.Message }
  GhLcRec $Name $good $det
}

# 1 create -> read -> durable mapped -> same-event replay
$d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx; $ev = GhLcEvent $d
$r1 = GhLcRun $fx $ev $sd; $r2 = GhLcRun $fx $ev $sd
$tok = 'factory-task-' + (GhLcShaStr 'T-1'); $rm = '<!-- ' + $tok + ' -->'
GhLcCheck 'create-read-mapped-replay' {
  $i = $fx.issues[0]
  $r1.status -ceq 'MAPPED' -and $tok.Length -eq 77 -and @($r1.mapping.Keys).Count -eq 4 -and $r1.mapping.stableMarker -ceq $tok -and
  $r1.mapping.issueNumber -eq $i.number -and $r1.mapping.repo -ceq $C0.repo -and $r1.mapping.taskId -ceq 'T-1' -and
  $i.title -ceq 'Add focused tests' -and $i.body -ceq (GhLcBody 'T-1') -and @($i.body.Split($nl) | Where-Object { $_ -ceq $rm }).Count -eq 1 -and
  $r2.status -ceq 'MAPPED' -and $r2.replay -eq $true -and (GhLcN $fx 'CREATE') -eq 1 -and @($fx.calls | Where-Object { $_ -cnotin @('FIND', 'CREATE', 'READ') }).Count -eq 0
}
$t160 = ('ab ' * 54).Substring(0, 160)
GhLcCheck 'public-text-boundaries-accepted' {
  $f = GhLcNewFx
  $x = GhLcRun $f (GhLcEvent $d @{ publicTitle = $t160; publicSummary = '' }) (Join-Path $d 's2')
  $y = GhLcRun $f (GhLcEvent $d @{ taskId = 'T-2'; publicTitle = 'Caf' + [char]233 + ' ok (1), done.' }) (Join-Path $d 's3')
  $x.status -ceq 'MAPPED' -and $y.status -ceq 'MAPPED'
}

# 2 existing OPEN adoption, colon task id, actual mapped-status adapter
$tid = 'TASK:a-1.2'
$d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx; GhLcSeed $fx (GhLcBody $tid); $ev = GhLcEvent $d @{ taskId = $tid }
$a1 = GhLcRun $fx $ev $sd; $a2 = GhLcRun $fx $ev $sd
$fx.issues[0].body = $fx.issues[0].body + $nl + $nl + 'Human note'
$cp = Join-Path $d 'cp.json'
[System.IO.File]::WriteAllText($cp, (@{ updatedAt = '2026-10-14T00:00:00Z'; currentActiveWork = @{ id = $tid } } | ConvertTo-Json -Compress))
$at = {
  param($o, $m, $b)
  $i = $fx.issues | Where-Object { $_.number -eq $m['issueNumber'] } | Select-Object -First 1
  if ($o -ceq 'WRITE') { $i.body = $b; return [pscustomobject]@{ ok = $true } }
  [pscustomobject]@{ ok = $true; number = $i.number; url = 'https://github.com/' + $m['repo'] + '/issues/' + $i.number; state = $i.state; body = $i.body }
}.GetNewClosure()
$ad = Invoke-DurableGitHubTaskStatusSync -CheckpointPath $cp -Mapping $a1.mapping -StateDir (Join-Path $d 'as') -PublicStatus 'BLOCKED' -NextAction 'WAIT_FOR_DEPENDENCY' -Transport $at
$trm = '<!-- factory-task-' + (GhLcShaStr $tid) + ' -->'
GhLcCheck 'adoption-zero-create-and-adapter-preserves-external-marker' {
  $bd = $fx.issues[0].body
  $a1.status -ceq 'MAPPED' -and $a2.status -ceq 'MAPPED' -and $a2.replay -eq $true -and (GhLcN $fx 'CREATE') -eq 0 -and $a1.mapping.issueNumber -eq 7 -and
  $ad.status -ceq 'DELIVERED' -and $bd.StartsWith($trm + $nl, [System.StringComparison]::Ordinal) -and @($bd.Split($nl) | Where-Object { $_ -ceq $trm }).Count -eq 1 -and
  $bd.Contains('Status: BLOCKED') -and $bd.EndsWith('Human note', [System.StringComparison]::Ordinal)
}

# 3 refusals before mutation
$i = 0
foreach ($c in @(@{ repo = 'hakanduyar/software-factory' }, @{ repo = 'other/repo'; markerNamespace = 'factory-task' }, @{ repo = 'Hakanduyar/Software-Factory'; markerNamespace = 'factory-task' }, @{ repo = $C0.repo; markerNamespace = 'other' }, @{ repo = $C0.repo; markerNamespace = 'factory-task'; extra = 'x' })) { $i++; GhLcRefuse ('config-' + $i) '' @{} $c }
$i = 0
foreach ($o in @(@{ extra = 'x' }, @{ nextAction = $null }, @{ schema = 'GitHubCreateEvent/v2' }, @{ taskId = 'bad id' }, @{ taskId = 'a/b' }, @{ taskId = ('a' * 129) }, @{ canonicalVersion = 0 }, @{ canonicalVersion = -1 }, @{ canonicalVersion = '1' }, @{ canonicalVersion = 1.5 }, @{ publicStatus = 'DONE' }, @{ nextAction = 'CLOSE' })) { $i++; GhLcRefuse ('event-' + $i) '' $o }
GhLcRefuse 'event-malformed-json' '' -Mut { param($t) '{' }
GhLcRefuse 'event-array-root' '' -Mut { param($t) '[]' }
GhLcRefuse 'event-duplicate-key' '' -Mut { param($t) $t.TrimEnd([char]125) + ',' + $q + 'taskId' + $q + ':' + $q + 'T-2' + $q + '}' }
$ab = 'ab ' * 200
$bad = @(
  @('LENGTH', ''), @('LENGTH', $ab.Substring(0, 161)), @('TYPE', 5),
  @('CHARACTERS', 'a/b'), @('CHARACTERS', ('a' + [char]92 + 'b')), @('CHARACTERS', 'a:b'), @('CHARACTERS', 'a@b'), @('CHARACTERS', 'a_b'), @('CHARACTERS', ' lead'), @('CHARACTERS', 'trail '), @('CHARACTERS', ('a' + $nl + 'b')), @('CHARACTERS', 'a<b'), @('CHARACTERS', 'a#b'),
  @('CREDENTIAL_PATTERN', 'Use sk-abcd1234 now'), @('CREDENTIAL_PATTERN', 'The BEARER value'), @('CREDENTIAL_PATTERN', 'my password'), @('CREDENTIAL_PATTERN', 'ghp reference'), @('CREDENTIAL_PATTERN', 'api key here'), @('CREDENTIAL_PATTERN', 'access token'), @('CREDENTIAL_PATTERN', 'see .factory-data'), @('CREDENTIAL_PATTERN', 'in users home'), @('CREDENTIAL_PATTERN', ('a' * 32))
)
$i = 0
foreach ($b in $bad) {
  $i++
  GhLcRefuse ('title-' + $i) ('PUBLIC_TEXT_' + $b[0]) @{ publicTitle = $b[1] }
  if ($b[0] -cne 'LENGTH') { GhLcRefuse ('summary-' + $i) ('PUBLIC_TEXT_' + $b[0]) @{ publicSummary = $b[1] } }
}
GhLcRefuse 'summary-length' 'PUBLIC_TEXT_LENGTH' @{ publicSummary = $ab.Substring(1, 513) }
$B1 = GhLcBody 'T-1'; $RM1 = '<!-- factory-task-' + (GhLcShaStr 'T-1') + ' -->'
GhLcRefuse 'find-incomplete-or-capped' '' -Seed { param($f) $f.find = { [pscustomobject]@{ ok = $true; complete = $false; issues = @() } } }
GhLcRefuse 'find-not-ok' '' -Seed { param($f) $f.find = { [pscustomobject]@{ ok = $false } } }
GhLcRefuse 'find-throws' '' -Seed { param($f) $f.find = { throw 'x' } }
GhLcRefuse 'find-wrong-url' '' -Seed { param($f) GhLcSeed $f $B1; $f.find = { [pscustomobject]@{ ok = $true; complete = $true; issues = @([pscustomobject]@{ number = 7; url = 'https://example.com/7' }) } } }
GhLcRefuse 'duplicate-match' '' -Seed { param($f) GhLcSeed $f $B1; GhLcSeed $f $B1 -N 8 }
GhLcRefuse 'closed-issue' '' -Seed { param($f) GhLcSeed $f $B1 -State 'CLOSED' }
GhLcRefuse 'wrong-title' '' -Seed { param($f) GhLcSeed $f $B1 -Title 'Other title' }
GhLcRefuse 'wrong-task-identity' '' -Seed { param($f) GhLcSeed $f $B1.Replace('Task: T-1', 'Task: T-9') }
GhLcRefuse 'marker-twice' '' -Seed { param($f) GhLcSeed $f ($B1 + $nl + $RM1) }
GhLcRefuse 'marker-after-region' '' -Seed { param($f) GhLcSeed $f ($B1.Substring($B1.IndexOf('<!-- factory-task-status:start')) + $nl + $nl + $RM1) }
GhLcRefuse 'marker-inside-region' '' -Seed { param($f) GhLcSeed $f $B1.Replace('Version: 1', 'Version: ' + $RM1) }

# 4 ambiguous CREATE
$d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx; $ev = GhLcEvent $d
$fx.mode = 'throw'; $u1 = GhLcRun $fx $ev $sd; $ph1 = GhLcPhase $sd
$fx.mode = 'ok'; $u2 = GhLcRun $fx $ev $sd
GhLcCheck 'ambiguous-throw-empty-find-never-recreates' {
  $u1.status -ceq 'UNKNOWN_SEND' -and -not $u1.PSObject.Properties['mapping'] -and $ph1 -ceq 'CREATE_MAY_HAVE_SENT' -and $u2.status -ceq 'REFUSED' -and -not $u2.PSObject.Properties['mapping'] -and (GhLcN $fx 'CREATE') -eq 1 -and $fx.issues.Count -eq 0 -and (GhLcPhase $sd) -ceq 'CREATE_MAY_HAVE_SENT'
}
$d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx; $ev = GhLcEvent $d
$fx.mode = 'storethrow'; $s1 = GhLcRun $fx $ev $sd; $fx.mode = 'ok'; $s2 = GhLcRun $fx $ev $sd; $s3 = GhLcRun $fx $ev $sd
GhLcCheck 'ambiguous-stored-create-adopted-no-second-create' {
  $s1.status -ceq 'UNKNOWN_SEND' -and $s2.status -ceq 'MAPPED' -and $s2.mapping.issueNumber -eq $fx.issues[0].number -and $s3.replay -eq $true -and (GhLcN $fx 'CREATE') -eq 1 -and $fx.issues.Count -eq 1
}
foreach ($wb in @('garbage', (GhLcBody 'T-9'))) {
  $d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx; $ev = GhLcEvent $d
  $fx.readBody = $wb; $w1 = GhLcRun $fx $ev $sd; $wph = GhLcPhase $sd; $fx.readBody = $null; $w2 = GhLcRun $fx $ev $sd
  GhLcCheck 'wrong-read-yields-no-ack' {
    $w1.status -ceq 'UNKNOWN_SEND' -and -not $w1.PSObject.Properties['mapping'] -and $wph -ceq 'CREATE_MAY_HAVE_SENT' -and $w2.status -ceq 'MAPPED' -and (GhLcN $fx 'CREATE') -eq 1
  }
}

# 5 snapshot changed by transport
foreach ($op in 'FIND', 'CREATE', 'READ') {
  $d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx; $ev = GhLcEvent $d
  $fx.hooks[$op] = { GhLcMutateEvent $ev }.GetNewClosure()
  $sr = GhLcRun $fx $ev $sd
  GhLcCheck ('snapshot-change-during-' + $op) {
    if ($op -ceq 'FIND') { $sr.status -ceq 'REFUSED' -and (GhLcN $fx 'CREATE') -eq 0 -and (GhLcTasks $sd) -eq 0 }
    else { $sr.status -ceq 'UNKNOWN_SEND' -and -not $sr.PSObject.Properties['mapping'] -and (GhLcN $fx 'CREATE') -eq 1 -and (GhLcPhase $sd) -ceq 'CREATE_MAY_HAVE_SENT' }
  }
}
$bs = GhLcBase; $e2 = $bs.ev
$bs.fx.hooks['READ'] = { GhLcMutateEvent $e2 }.GetNewClosure()
$sp = GhLcRun $bs.fx $e2 $bs.sd
GhLcCheck 'snapshot-change-during-mapped-replay-refuses-ack' { $sp.status -ceq 'REFUSED' -and -not $sp.PSObject.Properties['mapping'] -and (GhLcN $bs.fx 'CREATE') -eq 1 }
$d = GhLcDir; $fx = GhLcNewFx; GhLcSeed $fx $B1; $ev = GhLcEvent $d
$fx.hooks['READ'] = { GhLcMutateEvent $ev }.GetNewClosure()
$sa = GhLcRun $fx $ev (Join-Path $d 's')
GhLcCheck 'snapshot-change-during-existing-adoption-refuses-ack' { $sa.status -ceq 'REFUSED' -and -not $sa.PSObject.Properties['mapping'] -and (GhLcN $fx 'CREATE') -eq 0 }

# 6 corrupt state and lock before provider
GhLcCorrupt 'corrupt-orphan-event' 'ok' { param($s) $s['tasks'].Clear() }
GhLcCorrupt 'corrupt-orphan-event-throw' 'throw' { param($s) $s['tasks'].Clear() }
GhLcCorrupt 'corrupt-task-key' 'ok' { param($s) $k = @($s['tasks'].Keys)[0]; $t = $s['tasks'][$k]; $s['tasks'].Remove($k); $s['tasks'][('f' * 64)] = $t }
GhLcCorrupt 'corrupt-event-key' 'ok' { param($s) $k = @($s['events'].Keys)[0]; $e = $s['events'][$k]; $s['events'].Remove($k); $s['events'][('0' * 64)] = $e }
GhLcCorrupt 'corrupt-event-digest' 'ok' { param($s) $e = @($s['events'].Values)[0]; $e['payloadDigest'] = '1' * 64 }
GhLcCorrupt 'corrupt-event-version-ahead-of-task' 'ok' { param($s) $k = @($s['events'].Keys)[0]; $e = $s['events'][$k]; $s['events'].Remove($k); $e['canonicalVersion'] = 5; $s['events'][(GhLcShaStr ('T-1|5|' + $e['payloadDigest']))] = $e }
GhLcCorrupt 'corrupt-event-phase-ahead-of-task' 'throw' { param($s) $e = @($s['events'].Values)[0]; $e['phase'] = 'MAPPED' }
GhLcCorrupt 'corrupt-event-attempts-ahead-of-task' 'ok' { param($s) $e = @($s['events'].Values)[0]; $e['attempts'] = 3 }
GhLcCorrupt 'corrupt-intent-zero-attempts' 'throw' { param($s) $e = @($s['events'].Values)[0]; $e['attempts'] = 0 }
GhLcCorrupt 'corrupt-malformed-state' 'ok' { param($s) '{bad' }
GhLcCorrupt 'corrupt-schema' 'ok' { param($s) $s['schema'] = 2 }
GhLcCorrupt 'corrupt-extra-key' 'ok' { param($s) $s['extra'] = 1 }
$d = GhLcDir; $sd = Join-Path $d 's'; [System.IO.Directory]::CreateDirectory($sd) | Out-Null
$lk = [System.IO.FileStream]::new((Join-Path $sd 'github-task-lifecycle.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try { $fx = GhLcNewFx; $lr = GhLcRun $fx (GhLcEvent $d) $sd } finally { $lk.Dispose() }
GhLcCheck 'lock-contention-refuses-before-provider' { $lr.status -ceq 'LOCKED' -and $fx.calls.Count -eq 0 }

# 7 monotonic versions, stale controls, outside-region preservation
$bs = GhLcBase; $fx = $bs.fx; $s2t = 'Second summary'
$fx.issues[0].body = GhLcBody 'T-1' 2 $s2t
$ev2 = GhLcEvent $bs.d @{ canonicalVersion = 2; publicSummary = $s2t }
$v1 = GhLcRun $fx $ev2 $bs.sd; $v2 = GhLcRun $fx $ev2 $bs.sd
$n0 = $fx.calls.Count
$old = GhLcRun $fx $bs.ev $bs.sd
$cf = GhLcRun $fx (GhLcEvent $bs.d @{ canonicalVersion = 2; publicSummary = $s2t; publicTitle = 'Other title' }) $bs.sd
GhLcCheck 'version-advance-keeps-history-valid-stale-and-conflict-refused' {
  $v1.status -ceq 'MAPPED' -and $v2.status -ceq 'MAPPED' -and $v2.replay -eq $true -and (GhLcState $bs.sd)['events'].Count -eq 2 -and
  $old.status -ceq 'REFUSED' -and $cf.status -ceq 'REFUSED' -and $fx.calls.Count -eq $n0 -and (GhLcN $fx 'CREATE') -eq 1
}
$bs = GhLcBase
$nu = GhLcRun $bs.fx (GhLcEvent $bs.d @{ canonicalVersion = 2; publicSummary = 'Second summary' }) $bs.sd
GhLcCheck 'higher-version-with-old-remote-needs-update-no-create' {
  $nu.status -ceq 'MAPPED_NEEDS_UPDATE' -and $nu.replay -eq $false -and (GhLcN $bs.fx 'CREATE') -eq 1 -and @((GhLcState $bs.sd)['tasks'].Values)[0]['canonicalVersion'] -eq 1
}
$bs = GhLcBase
$keep = $bs.fx.issues[0].body + $nl + $nl + 'Human after'
$bs.fx.issues[0].body = $keep
$ou = GhLcRun $bs.fx $bs.ev $bs.sd
GhLcCheck 'outside-managed-region-bytes-preserved' { $ou.status -cin @('MAPPED', 'MAPPED_NEEDS_UPDATE') -and $bs.fx.issues[0].body -ceq $keep -and (GhLcN $bs.fx 'CREATE') -eq 1 }
$d = GhLcDir; $sd = Join-Path $d 's'; $fx = GhLcNewFx
$t1 = GhLcRun $fx (GhLcEvent $d) $sd; $t2 = GhLcRun $fx (GhLcEvent $d @{ taskId = 'T-2' }) $sd
$t1r = GhLcRun $fx (GhLcEvent $d) $sd; $t2r = GhLcRun $fx (GhLcEvent $d @{ taskId = 'T-2' }) $sd
GhLcCheck 'two-tasks-same-version-independent' {
  $t1.status -ceq 'MAPPED' -and $t2.status -ceq 'MAPPED' -and $t1.mapping.stableMarker -cne $t2.mapping.stableMarker -and $t1.mapping.issueNumber -ne $t2.mapping.issueNumber -and $t1r.replay -eq $true -and $t2r.replay -eq $true -and (GhLcN $fx 'CREATE') -eq 2
}

$failed = @($Results | Where-Object { -not $_.pass })
[System.IO.File]::WriteAllText((Join-Path $run 'receipt.json'), ([ordered]@{ candidateSha256 = $ExpectedSourceSha256.ToUpperInvariant(); adapterSha256 = $AdapterSha; total = $Results.Count; failed = $failed.Count; results = $Results } | ConvertTo-Json -Depth 4))
foreach ($x in $Results) { $tag = if ($x.pass) { 'PASS' } else { 'FAIL' }; Write-Host ($tag + ' ' + $x.name + ' ' + $x.detail) }
if ($failed.Count -eq 0 -and $Results.Count -gt 0) { exit 0 }
exit 1
