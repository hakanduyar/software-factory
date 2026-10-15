[CmdletBinding()]
param([Parameter(Mandatory)][string]$CandidatePath,[Parameter(Mandatory)][string]$ExpectedSourceSha256,[Parameter(Mandatory)][string]$EvidenceRoot,[Parameter(Mandatory)][ValidateSet('VALID','ALL')][string]$Group)
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
function Get-Sha([string]$Path) {
  if (-not [System.IO.File]::Exists($Path)) { throw 'PIN_FILE_MISSING' }
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { [System.BitConverter]::ToString($h.ComputeHash([System.IO.File]::ReadAllBytes($Path))).Replace('-', '') } finally { $h.Dispose() }
}
if ($ExpectedSourceSha256 -isnot [string] -or $ExpectedSourceSha256 -cnotmatch '\A[0-9A-Fa-f]{64}\z') { throw 'EXPECTED_SOURCE_SHA_INVALID' }
$srcFull = [System.IO.Path]::GetFullPath($CandidatePath)
if (-not [string]::Equals($CandidatePath, $srcFull, [System.StringComparison]::Ordinal) -or $srcFull -cnotmatch '\AC:\\') { throw 'SOURCE_PATH_NOT_CANONICAL' }
if (-not [System.IO.File]::Exists($srcFull)) { throw 'PIN_FILE_MISSING' }
$walk = $srcFull
while (-not [string]::IsNullOrEmpty($walk)) {
  if (([int]([System.IO.File]::GetAttributes($walk) -band [System.IO.FileAttributes]::ReparsePoint)) -ne 0) { throw 'SOURCE_REPARSE' }
  $walk = [System.IO.Path]::GetDirectoryName($walk)
}
if (-not [string]::Equals((Get-Sha $srcFull), $ExpectedSourceSha256, $ic)) { throw 'SOURCE_PIN_MISMATCH' }
$null = [System.IO.Directory]::CreateDirectory($anchored)
. $srcFull

$results = [System.Collections.Generic.List[object]]::new()
function Check([string]$Name, [scriptblock]$Body) {
  $ok = $false; $detail = ''
  try { $out = @(& $Body); $ok = ($out.Count -gt 0) -and ($out[$out.Count - 1] -is [bool]) -and $out[$out.Count - 1] } catch { $detail = 'UNEXPECTED_ERROR' }
  $results.Add([pscustomobject]@{ name = $Name; pass = [bool]$ok; detail = $detail })
}
function Throws([scriptblock]$Blk, [string]$Expected) {
  try { & $Blk | Out-Null } catch { return [string]::Equals($_.Exception.Message, $Expected, [System.StringComparison]::Ordinal) }
  return $false
}
function Refill283Fact($id, $paths) { [pscustomobject]@{ ownerId = $id; ownedCanonicalPaths = [object[]]@($paths) } }
function Refill283Cat($v) { try { $null = AssertRefillOwnerFact283 -Value $v; 'OK' } catch { if ($_.Exception.Message -cmatch '\AREFILL283_INVALID:(SHAPE|TYPE|ID|UNICODE|PATH|CAP|DUPLICATE)\z') { $Matches[1] } else { 'UNEXPECTED' } } }
function Refill283Pairs { @(@('ownerId', 'O1'), @('ownedCanonicalPaths', [object[]]@('C:\work\one'))) }
function Refill283Raw([object[]]$Pairs, $ScriptName, $Counter) {
  $o = New-Object System.Management.Automation.PSObject
  foreach ($pr in $Pairs) {
    $val = $pr[1]
    if ($null -ne $ScriptName -and ([string]$pr[0]) -ceq $ScriptName) {
      $sb = { $Counter.n++; $val }.GetNewClosure()
      Add-Member -InputObject $o -MemberType ScriptProperty -Name $pr[0] -Value $sb
    } else {
      Add-Member -InputObject $o -MemberType NoteProperty -Name $pr[0] -Value $val
    }
  }
  $o
}
function Refill283FieldBad([string]$Field, $Raw, [string]$Cat) {
  $o = Refill283Fact 'O1' @('C:\work\one')
  $o.$Field = $Raw
  (Throws { AssertRefillOwnerFact283 -Value $o } ('REFILL283_INVALID:' + $Cat)) -and ((Refill283Cat $o) -ceq $Cat)
}

Check 'valid: exactly two NoteProperty fields accepted' {
  $o = Refill283Fact 'O1' @('C:\work\one')
  $m = @($o.PSObject.Properties)
  ($m.Count -eq 2) -and (@($m | Where-Object { $_.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty }).Count -eq 2) -and ((Refill283Cat $o) -ceq 'OK')
}
Check 'valid: primitive owner id accepted' { (Refill283Cat (Refill283Fact 'owner-1' @('C:\work\one'))) -ceq 'OK' }
Check 'valid: singleton path accepted' { (Refill283Cat (Refill283Fact 'O1' @('C:\work\one'))) -ceq 'OK' }
Check 'valid: 64 distinct paths accepted' {
  $p = foreach ($i in 1..64) { 'C:\work\p' + $i }
  (Refill283Cat (Refill283Fact 'O1' @($p))) -ceq 'OK'
}
Check 'valid: literal drive root C:\ accepted' {
  $root = [string]::new([char[]]@([char]0x43, [char]0x3A, [char]0x5C))
  ($root.Length -eq 3) -and ((Refill283Cat (Refill283Fact 'O1' @($root))) -ceq 'OK')
}
Check 'valid: strict caller gets exactly one bool true' {
  $r = @(AssertRefillOwnerFact283 -Value (Refill283Fact 'O1' @('C:\work\one')))
  $r.Count -eq 1 -and $r[0] -is [bool] -and $r[0]
}

if ($Group -ceq 'ALL') {
  Check 'metadata: two NoteProperty fields accepted' { (Refill283Cat (Refill283Raw (Refill283Pairs) $null $null)) -ceq 'OK' }
  foreach ($f in 'ownerId', 'ownedCanonicalPaths') {
    Check ('metadata: ScriptProperty ' + $f + ' refused SHAPE with zero getter calls') {
      $c = @{ n = 0 }
      $o = Refill283Raw (Refill283Pairs) $f $c
      ((Refill283Cat $o) -ceq 'SHAPE') -and ($c.n -eq 0)
    }
  }
  Check 'metadata: missing ownedCanonicalPaths refused SHAPE' {
    $p = Refill283Pairs
    (Refill283Cat (Refill283Raw @(,$p[0]) $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: missing ownerId refused SHAPE' {
    $p = Refill283Pairs
    (Refill283Cat (Refill283Raw @(,$p[1]) $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: wrong-case ownerId refused SHAPE' {
    $p = Refill283Pairs
    $p[0] = @('OwnerId', 'O1')
    (Refill283Cat (Refill283Raw $p $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: wrong-case ownedCanonicalPaths refused SHAPE' {
    $p = Refill283Pairs
    $p[1] = @('OwnedCanonicalPaths', [object[]]@('C:\work\one'))
    (Refill283Cat (Refill283Raw $p $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: extra field refused SHAPE' {
    $p = @(Refill283Pairs) + @(,@('extra', 1))
    (Refill283Cat (Refill283Raw $p $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: taskId alias refused SHAPE' {
    $p = Refill283Pairs
    $p[0] = @('taskId', 'O1')
    (Refill283Cat (Refill283Raw $p $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: ambiguous ownerIds name refused SHAPE' {
    $p = Refill283Pairs
    $p[0] = @('ownerIds', 'O1')
    (Refill283Cat (Refill283Raw $p $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: ambiguous ownedPaths name refused SHAPE' {
    $p = Refill283Pairs
    $p[1] = @('ownedPaths', [object[]]@('C:\work\one'))
    (Refill283Cat (Refill283Raw $p $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: hashtable dictionary refused SHAPE' {
    (Refill283Cat @{ ownerId = 'O1'; ownedCanonicalPaths = [object[]]@('C:\work\one') }) -ceq 'SHAPE'
  }
  Check 'metadata: ordered dictionary refused SHAPE' {
    (Refill283Cat ([ordered]@{ ownerId = 'O1'; ownedCanonicalPaths = [object[]]@('C:\work\one') })) -ceq 'SHAPE'
  }
  Check 'metadata: adapted non-custom object refused SHAPE' {
    (Refill283Cat ([System.Management.Automation.PSObject]::AsPSObject([version]'1.0'))) -ceq 'SHAPE'
  }
  Check 'metadata: null refused SHAPE' { (Refill283Cat $null) -ceq 'SHAPE' }
}

if ($Group -ceq 'ALL') {
  foreach ($c in @(@('null', $null), @('bool', $true), @('integer', 5))) {
    Check ('shared: ownerId ' + $c[0] + ' refused TYPE') { Refill283FieldBad 'ownerId' $c[1] 'TYPE' }
  }
  Check 'shared: ownerId empty refused ID' { Refill283FieldBad 'ownerId' '' 'ID' }
  Check 'shared: ownerId whitespace refused ID' { Refill283FieldBad 'ownerId' '   ' 'ID' }
  Check 'shared: ownerId 129 chars refused ID' { Refill283FieldBad 'ownerId' ('a' * 129) 'ID' }
  Check 'shared: ownerId unpaired surrogate refused UNICODE' { Refill283FieldBad 'ownerId' ('a' + [string][char]0xD800 + 'b') 'UNICODE' }
  Check 'shared: paths null refused TYPE' { Refill283FieldBad 'ownedCanonicalPaths' $null 'TYPE' }
  Check 'shared: paths scalar string refused TYPE' { Refill283FieldBad 'ownedCanonicalPaths' 'C:\work\one' 'TYPE' }
  Check 'shared: paths empty array refused CAP' { Refill283FieldBad 'ownedCanonicalPaths' ([object[]]@()) 'CAP' }
  Check 'shared: paths 65 entries refused CAP' { Refill283FieldBad 'ownedCanonicalPaths' ([object[]]@(foreach ($i in 1..65) { 'C:\work\p' + $i })) 'CAP' }
  Check 'shared: paths case-insensitive duplicate refused DUPLICATE' { Refill283FieldBad 'ownedCanonicalPaths' ([object[]]@('C:\work\One', 'c:\work\one')) 'DUPLICATE' }
  Check 'shared: paths relative entry refused PATH' { Refill283FieldBad 'ownedCanonicalPaths' ([object[]]@('work\one')) 'PATH' }
  Check 'shared: paths invalid surrogate entry refused UNICODE' { Refill283FieldBad 'ownedCanonicalPaths' ([object[]]@('C:\work\a' + [string][char]0xDC00 + 'b')) 'UNICODE' }
}

[void][System.IO.Directory]::CreateDirectory($anchored)
$failed = @($results | Where-Object { -not $_.pass })
$gm = [ordered]@{ VALID = 'valid:'; METADATA = 'metadata:'; SHARED = 'shared:' }
$gx = @(); $gp = @(); $gf = @(); $miss = @()
$cnt = [ordered]@{}
foreach ($g in $gm.Keys) {
  $m = @($results | Where-Object { $_.name.StartsWith($gm[$g], [System.StringComparison]::Ordinal) })
  $cnt[$g] = $m.Count
  if ($m.Count -eq 0) { $miss += $g; continue }
  $gx += $g
  if (@($m | Where-Object { -not $_.pass }).Count -gt 0) { $gf += $g } else { $gp += $g }
}
$full = ($Group -ceq 'ALL') -and ($gp.Count -eq 3) -and ($miss.Count -eq 0) -and ($gf.Count -eq 0) -and ($failed.Count -eq 0) -and ($results.Count -gt 0)
$receipt = [pscustomobject]@{ schema = 'OwnerFactTargetedResult285/v1'; scope = 'isolated OwnerFact test evidence only; no Factory, READY, runtime, eligibility or authority claimed'; group = $Group; implemented = @('VALID', 'METADATA', 'SHARED'); executed = @($gx); groupsPassed = @($gp); groupsFailed = @($gf); missing = @($miss); groupAssertionCounts = $cnt; sourceSha256 = (Get-Sha $srcFull); harnessSha256 = (Get-Sha $PSCommandPath); fullAcceptance = $full; reusedEvidenceRefs = @('A794 namespace-normalized AST identity to C732: Refill283PathCategory/Refill283TestUnicode/Refill283Fail helper lexical matrix', 'actual TaskFact9A709 and PlannerE240 fingerprints: helper-only lexical matrix reuse, not counted in fresh assertions'); total = $results.Count; failed = $failed.Count; results = $results.ToArray() }
[System.IO.File]::WriteAllText((Join-Path $anchored 'receipt.json'), (ConvertTo-Json -InputObject $receipt -Depth 6), [System.Text.UTF8Encoding]::new($false))
foreach ($x in $results) { $tag = if ($x.pass) { 'PASS' } else { 'FAIL' }; Write-Host ('{0} {1} {2}' -f $tag, $x.name, $x.detail) }
if ($failed.Count -gt 0) { exit 1 }
if ($Group -ceq 'ALL' -and -not $full) { exit 1 }
exit 0
