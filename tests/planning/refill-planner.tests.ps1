[CmdletBinding()]
param([Parameter(Mandatory)][string]$PlannerPath,[Parameter(Mandatory)][string]$ExpectedPlannerSha256,[Parameter(Mandatory)][string]$EvidenceRoot)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ic = [System.StringComparison]::OrdinalIgnoreCase
$sep = [System.IO.Path]::DirectorySeparatorChar
$pc = if ($sep -eq '\') { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd($sep)
$anchored = [System.IO.Path]::GetFullPath($EvidenceRoot).TrimEnd($sep)
if (-not [string]::Equals($EvidenceRoot.TrimEnd($sep), $anchored, [System.StringComparison]::Ordinal)) { throw 'EVIDENCE_ROOT_NOT_CANONICAL' }
if (-not [string]::Equals([System.IO.Path]::GetDirectoryName($anchored), $tempRoot, $pc)) { throw 'EVIDENCE_ROOT_NOT_ANCHORED' }
if ([System.IO.Path]::GetFileName($anchored) -cnotmatch '\Asoftware-factory-refill-[0-9a-f]{32}\z') { throw 'EVIDENCE_ROOT_NOT_ANCHORED' }
if ([System.IO.Directory]::Exists($anchored) -or [System.IO.File]::Exists($anchored)) { throw 'EVIDENCE_ROOT_NOT_ABSENT' }
$walk = $tempRoot
while (-not [string]::IsNullOrEmpty($walk)) {
  if ([System.IO.Directory]::Exists($walk) -and (([int]([System.IO.File]::GetAttributes($walk) -band [System.IO.FileAttributes]::ReparsePoint)) -ne 0)) { throw 'EVIDENCE_ROOT_REPARSE_ANCESTOR' }
  $walk = [System.IO.Path]::GetDirectoryName($walk)
}
$null = [System.IO.Directory]::CreateDirectory($anchored)
function Get-Sha([string]$Path) {
  if (-not [System.IO.File]::Exists($Path)) { throw 'PIN_FILE_MISSING' }
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { [System.BitConverter]::ToString($h.ComputeHash([System.IO.File]::ReadAllBytes($Path))).Replace('-', '') } finally { $h.Dispose() }
}
$depPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/planning/backlog-dependency-projection.ps1'))
if (-not [string]::Equals((Get-Sha $depPath), '1DFAC70A2EA2E2F584EF01393F461C901D4950FE9F2C02CE14831C9CD7FD1F5D', $ic)) { throw 'DEPENDENCY_PIN_MISMATCH' }
if ($ExpectedPlannerSha256 -isnot [string] -or $ExpectedPlannerSha256 -cnotmatch '\A[0-9A-Fa-f]{64}\z') { throw 'EXPECTED_PLANNER_SHA_INVALID' }
if (-not [string]::Equals((Get-Sha $PlannerPath), $ExpectedPlannerSha256, $ic)) { throw 'PLANNER_PIN_MISMATCH' }
$plannerDir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($PlannerPath))
$siblingDep = [System.IO.Path]::Combine($plannerDir, 'backlog-dependency-projection.ps1')
if (-not [string]::Equals((Get-Sha $siblingDep), '1DFAC70A2EA2E2F584EF01393F461C901D4950FE9F2C02CE14831C9CD7FD1F5D', $ic)) { throw 'DEPENDENCY_PIN_MISMATCH' }
function Test-ImportRefuses([string]$Dir, [string]$Expected) {
  $p = Join-Path $Dir 'refill-planner.ps1'
  try { & { . $p } | Out-Null } catch { return [string]::Equals($_.Exception.Message, $Expected, [System.StringComparison]::Ordinal) }
  return $false
}
$fxMissing = Join-Path (Join-Path $anchored 'fixtures') 'missing'
$fxChanged = Join-Path (Join-Path $anchored 'fixtures') 'changed'
$null = [System.IO.Directory]::CreateDirectory($fxMissing)
$null = [System.IO.Directory]::CreateDirectory($fxChanged)
[System.IO.File]::Copy($PlannerPath, (Join-Path $fxMissing 'refill-planner.ps1'))
[System.IO.File]::Copy($PlannerPath, (Join-Path $fxChanged 'refill-planner.ps1'))
$depBytes = [System.IO.File]::ReadAllBytes($siblingDep)
$changedBytes = [byte[]]::new($depBytes.Length + 1)
[System.Array]::Copy($depBytes, $changedBytes, $depBytes.Length)
$changedBytes[$depBytes.Length] = 10
[System.IO.File]::WriteAllBytes((Join-Path $fxChanged 'backlog-dependency-projection.ps1'), $changedBytes)
$portMissing = Test-ImportRefuses $fxMissing 'REFILL_DEPENDENCY_PIN_MISSING'
$portChanged = Test-ImportRefuses $fxChanged 'REFILL_DEPENDENCY_PIN_MISMATCH'
. $PlannerPath

$results = [System.Collections.Generic.List[object]]::new()
$proposals = [System.Collections.Generic.List[object]]::new()
function Check([string]$Name, [scriptblock]$Body) {
  $ok = $false; $detail = ''
  try { $out = @(& $Body); $ok = ($out.Count -gt 0) -and ($out[$out.Count - 1] -is [bool]) -and $out[$out.Count - 1] } catch { $detail = $_.Exception.Message }
  $results.Add([pscustomobject]@{ name = $Name; pass = [bool]$ok; detail = $detail })
}
function Throws([scriptblock]$Blk, [string]$Expected) {
  try { & $Blk | Out-Null } catch { return [string]::Equals($_.Exception.Message, $Expected, [System.StringComparison]::Ordinal) }
  return $false
}
function Tk($id, $deps = @(), $ext = $null, $req = $null) { [pscustomobject]@{ id = $id; dependencies = [object[]]@($deps); externalBlocker = $ext; requiredAcceptance = $req } }
function Sn($tasks, $acc = @(), $ver = 'v1') { [pscustomobject]@{ schema = 'BacklogDependencyProjectionInput/v1'; planVersion = $ver; planSha256 = ('a' * 64); tasks = [object[]]@($tasks); accepted = [object[]]@($acc) } }
function Wp($s) { 'C:\work\' + $s }
function New-TaskFact207($id, $paths, $el = 'VERIFIED_ELIGIBLE') { [pscustomobject]@{ taskId = $id; ownedCanonicalPaths = [object[]]@($paths); eligibility = $el } }
function Ow($id, $paths) { [pscustomobject]@{ ownerId = $id; ownedCanonicalPaths = [object[]]@($paths) } }
function Facts($tasks, $owners = @(), $max = 10, $paused = $false, $snapVer = 'v1', $pauseVer = 'p1', $eligVer = 'e1') {
  [pscustomobject]@{ schema = 'RefillPlannerFacts/v1'; snapshotVersion = $snapVer; pauseVersion = $pauseVer; paused = $paused; ownershipVersion = 'o1'; eligibilityVersion = $eligVer; maxCandidates = $max; tasks = [object[]]@($tasks); activeOwners = [object[]]@($owners) }
}
function Pr($s, $f) { $r = Get-ContinuityRefillProposal175 -BacklogSnapshot $s -ControllerFacts $f; $proposals.Add($r); $r }
function Ids($r) { (@($r.proposedCandidates | ForEach-Object { $_.taskId }) -join ',') }
function Reasons($r, $id) { foreach ($b in $r.blocked) { if ($b.taskId -ceq $id) { return ($b.reasons -join '|') } }; return $null }
function J($o) { ConvertTo-Json -InputObject $o -Depth 8 -Compress }
function AccSnap($cand) {
  $req = [pscustomobject]@{ taskId = 'T1'; candidateSha256 = ('b' * 64); reviewSha256 = ('c' * 64) }
  $acc = [pscustomobject]@{ taskId = 'T1'; candidateSha256 = $cand; reviewSha256 = ('c' * 64); status = 'ACCEPTED_SCOPED' }
  Sn @((Tk 'T1' @() $null $req), (Tk 'T2' @('T1'))) @($acc)
}
$names = 'schema,basis,proposedCandidates,blocked,nextTrigger,grantsAuthority'

Check 'baseline: one task, one path, no active owner' {
  $r = Pr (Sn @(Tk 'T1')) (Facts @(New-TaskFact207 'T1' (Wp 'one')))
  $b = $r.basis
  $r.schema -ceq 'RefillPlannerProposal/v1' -and (($r.PSObject.Properties.Name) -join ',') -ceq $names -and (($b.PSObject.Properties.Name) -join ',') -ceq 'planVersion,planSha256,snapshotVersion,pauseVersion,ownershipVersion,eligibilityVersion' -and $b.planVersion -ceq 'v1' -and $b.planSha256 -ceq ('a' * 64) -and $b.snapshotVersion -ceq 'v1' -and $b.pauseVersion -ceq 'p1' -and $b.ownershipVersion -ceq 'o1' -and $b.eligibilityVersion -ceq 'e1' -and (Ids $r) -ceq 'T1' -and $r.proposedCandidates[0].ownedCanonicalPaths[0] -ceq (Wp 'one') -and @($r.blocked).Count -eq 0 -and $r.nextTrigger -ceq 'CONTROLLER_FACTS_OR_PLAN_CHANGED'
}
Check 'refuse: scalar path list' { $f = Facts @(New-TaskFact207 'T1' (Wp 'one')); $f.tasks[0].ownedCanonicalPaths = (Wp 'one'); Throws { Pr (Sn @(Tk 'T1')) $f } 'INVALID_FACTS:task.ownedCanonicalPaths' }
Check 'refuse: nonstring facts schema' { $f = Facts @(New-TaskFact207 'T1' (Wp 'one')); $f.schema = 5; Throws { Pr (Sn @(Tk 'T1')) $f } 'INVALID_FACTS:schema' }
Check 'refuse: nonstring snapshot schema' { $s = Sn @(Tk 'T1'); $s.schema = 5; Throws { Pr $s (Facts @(New-TaskFact207 'T1' (Wp 'one'))) } 'BACKLOG_PROJECTION_INVALID' }
Check 'refuse: relative path, unknown id, duplicate id, maxCandidates bounds' {
  (Throws { Pr (Sn @(Tk 'T1')) (Facts @(New-TaskFact207 'T1' 'rel\x')) } 'INVALID_PATH:task') -and (Throws { Pr (Sn @(Tk 'T1')) (Facts @(New-TaskFact207 'ZZ' (Wp 'z'))) } 'UNKNOWN_TASK_ID') -and (Throws { Pr (Sn @(Tk 'T1')) (Facts @((New-TaskFact207 'T1' (Wp 'a')), (New-TaskFact207 'T1' (Wp 'b')))) } 'DUPLICATE_TASK_ID') -and (Throws { Pr (Sn @(Tk 'T1')) (Facts @(New-TaskFact207 'T1' (Wp 'a')) -max 0) } 'INVALID_FACTS:maxCandidates') -and (Throws { Pr (Sn @(Tk 'T1')) (Facts @(New-TaskFact207 'T1' (Wp 'a')) -max 33) } 'INVALID_FACTS:maxCandidates')
}
Check 'mixed snapshot: blockers retained, ordered, bounded' {
  $s = Sn @((Tk 'T1'), (Tk 'T2' @('T1')), (Tk 'T3' @() 'WAIT'), (Tk 'T4'), (Tk 'T5'), (Tk 'T6'), (Tk 'T7'), (Tk 'T8'), (Tk 'T9'))
  $f = Facts @((New-TaskFact207 'T1' (Wp 'alpha')), (New-TaskFact207 'T4' (Wp 'four') 'UNKNOWN'), (New-TaskFact207 'T6' (Wp 'Owned\child')), (New-TaskFact207 'T7' (Wp 'alpha\sub')), (New-TaskFact207 'T8' (Wp 'alphabet')), (New-TaskFact207 'T9' (Wp 'nine') 'INELIGIBLE')) @((Ow 'own1' 'c:\WORK\owned'))
  $r = Pr $s $f
  (Ids $r) -ceq 'T1,T8' -and (($r.blocked | ForEach-Object { $_.taskId }) -join ',') -ceq 'T2,T3,T4,T5,T6,T7,T9' -and (Reasons $r 'T2') -ceq 'DEPENDENCY_NOT_ACCEPTED:T1' -and (Reasons $r 'T3') -ceq 'EXTERNAL:WAIT' -and (Reasons $r 'T4') -ceq 'ELIGIBILITY_UNKNOWN' -and (Reasons $r 'T5') -ceq 'ELIGIBILITY_UNKNOWN' -and (Reasons $r 'T6') -ceq 'OWNERSHIP_COLLISION:own1' -and (Reasons $r 'T7') -ceq 'CANDIDATE_COLLISION:T1' -and (Reasons $r 'T9') -ceq 'ELIGIBILITY_INELIGIBLE' -and $r.proposedCandidates.Count -le 10
}
Check 'acceptance fingerprint: current releases dependent, stale does not' {
  $f = Facts @((New-TaskFact207 'T1' (Wp 'one')), (New-TaskFact207 'T2' (Wp 'two')))
  $cur = Pr (AccSnap ('b' * 64)) $f
  $stale = Pr (AccSnap ('d' * 64)) $f
  (Ids $cur) -ceq 'T2' -and @($cur.blocked).Count -eq 0 -and (Ids $stale) -ceq 'T1' -and (Reasons $stale 'T2') -ceq 'DEPENDENCY_NOT_ACCEPTED:T1'
}
Check 'expected snapshot version mismatch refused' { Throws { Pr (Sn @(Tk 'T1')) (Facts @(New-TaskFact207 'T1' (Wp 'one')) -snapVer 'v2') } 'STALE_SNAPSHOT_VERSION' }
Check 'pause sequence: quota refresh stays zero until new resume version' {
  $s = Sn @(Tk 'T1')
  $ft = @(New-TaskFact207 'T1' (Wp 'one'))
  $a = Pr $s (Facts $ft -paused $true -pauseVer 'p1' -eligVer 'e1')
  $b = Pr $s (Facts $ft -paused $true -pauseVer 'p1' -eligVer 'e2')
  $c = Pr $s (Facts $ft -paused $false -pauseVer 'p2' -eligVer 'e2')
  @($a.proposedCandidates).Count -eq 0 -and @($b.proposedCandidates).Count -eq 0 -and (Reasons $a 'T1') -ceq 'PAUSED' -and $a.nextTrigger -ceq 'HUMAN_RESUME_REQUIRED' -and $b.nextTrigger -ceq 'HUMAN_RESUME_REQUIRED' -and $b.basis.eligibilityVersion -ceq 'e2' -and $b.basis.pauseVersion -ceq 'p1' -and (Ids $c) -ceq 'T1' -and $c.basis.pauseVersion -ceq 'p2' -and $c.nextTrigger -ceq 'CONTROLLER_FACTS_OR_PLAN_CHANGED'
}
Check 'deterministic, inputs unmutated' {
  $s = Sn @((Tk 'T1'), (Tk 'T2')); $f = Facts @((New-TaskFact207 'T1' (Wp 'one')), (New-TaskFact207 'T2' (Wp 'two')))
  $before = (J $s) + (J $f)
  $x = J (Pr $s $f)
  $y = J (Pr $s $f)
  $x -ceq $y -and $before -ceq ((J $s) + (J $f))
}
Check 'maxCandidates boundary' {
  $s = Sn @((Tk 'T1'), (Tk 'T2'), (Tk 'T3'))
  $ft = @((New-TaskFact207 'T1' (Wp 'one')), (New-TaskFact207 'T2' (Wp 'two')), (New-TaskFact207 'T3' (Wp 'three')))
  $r = Pr $s (Facts $ft -max 2)
  $m = Pr $s (Facts $ft -max 32)
  (Ids $r) -ceq 'T1,T2' -and (Reasons $r 'T3') -ceq 'MAX_CANDIDATES_REACHED' -and (Ids $m) -ceq 'T1,T2,T3'
}
Check 'authority false and exact fields on every result' {
  $ok = $proposals.Count -ge 8
  foreach ($x in $proposals) { if ($x.grantsAuthority -isnot [bool] -or $x.grantsAuthority -or (($x.PSObject.Properties.Name) -join ',') -cne $names) { $ok = $false } }
  $ok
}

Check 'portability: missing sibling dependency refuses before import' { [bool]$portMissing }
Check 'portability: changed sibling dependency refuses before import' { [bool]$portChanged }

[void][System.IO.Directory]::CreateDirectory($anchored)
$failed = @($results | Where-Object { -not $_.pass })
$receipt = [pscustomobject]@{ schema = 'Continuity175FocusedTestReceipt/v1'; scope = 'isolated test evidence only; no factory or runtime authority claimed'; total = $results.Count; failed = $failed.Count; results = $results.ToArray() }
[System.IO.File]::WriteAllText((Join-Path $anchored 'receipt.json'), (ConvertTo-Json -InputObject $receipt -Depth 6), [System.Text.UTF8Encoding]::new($false))
foreach ($x in $results) { $tag = if ($x.pass) { 'PASS' } else { 'FAIL' }; Write-Host ('{0} {1} {2}' -f $tag, $x.name, $x.detail) }
if ($failed.Count -gt 0) { exit 1 }
exit 0
