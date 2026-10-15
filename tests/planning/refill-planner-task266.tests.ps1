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
function Valid($id, $paths, $el = 'VERIFIED_ELIGIBLE') { [pscustomobject]@{ taskId = $id; eligibility = $el; ownedCanonicalPaths = [object[]]@($paths) } }
function Refill266Category($v) { try { $null = AssertRefillPlannerTask266 -Value $v; 'OK' } catch { if ($_.Exception.Message -cmatch '\AREFILL266_INVALID:(SHAPE|TYPE|ID|UNICODE|PATH|CAP|DUPLICATE|ELIGIBILITY)\z') { $Matches[1] } else { 'UNEXPECTED' } } }

Check 'valid: three eligibility enums accepted' {
  $ok = $true
  foreach ($e in 'VERIFIED_ELIGIBLE', 'INELIGIBLE', 'UNKNOWN') { if ((Refill266Category (Valid 'T1' @('C:\work\one') $e)) -cne 'OK') { $ok = $false } }
  $ok
}
Check 'valid: singleton path accepted' { (Refill266Category (Valid 'T1' @('C:\work\one'))) -ceq 'OK' }
Check 'valid: 64 distinct paths accepted' {
  $p = foreach ($i in 1..64) { 'C:\work\p' + $i }
  (Refill266Category (Valid 'T1' @($p))) -ceq 'OK'
}
Check 'valid: canonical C:\root path yields exactly one bool true' {
  $r = @(AssertRefillPlannerTask266 -Value (Valid 'T1' @('C:\')))
  $r.Count -eq 1 -and $r[0] -is [bool] -and ($r[0] -eq $true)
}
Check 'valid: strict caller gets exactly one bool true' {
  $r = @(AssertRefillPlannerTask266 -Value (Valid 'T1' @('C:\work\one')))
  $r.Count -eq 1 -and $r[0] -is [bool] -and $r[0]
}


function Refill266Pairs { @(@('taskId', 'T1'), @('eligibility', 'UNKNOWN'), @('ownedCanonicalPaths', [object[]]@('C:\work\one'))) }
function Refill266Raw([object[]]$Pairs, $ScriptName, $Counter) {
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
if ($Group -ceq 'ALL') {
  Check 'metadata: three NoteProperty fields accepted' { (Refill266Category (Refill266Raw (Refill266Pairs) $null $null)) -ceq 'OK' }
  foreach ($f in 'taskId', 'eligibility', 'ownedCanonicalPaths') {
    Check ('metadata: ScriptProperty ' + $f + ' refused SHAPE with zero getter side effects') {
      $c = @{ n = 0 }
      $o = Refill266Raw (Refill266Pairs) $f $c
      ((Refill266Category $o) -ceq 'SHAPE') -and ($c.n -eq 0)
    }
  }
  Check 'metadata: ScriptProperty refusal message is fixed SHAPE without raw exception' {
    $c = @{ n = 0 }
    $o = Refill266Raw (Refill266Pairs) 'taskId' $c
    (Throws { AssertRefillPlannerTask266 -Value $o } 'REFILL266_INVALID:SHAPE') -and ($c.n -eq 0)
  }
  Check 'metadata: wrong-case field name refused SHAPE' {
    $p = Refill266Pairs
    $p[0] = @('TaskId', 'T1')
    (Refill266Category (Refill266Raw $p $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: missing field refused SHAPE' {
    $p = Refill266Pairs
    (Refill266Category (Refill266Raw @($p[0], $p[1]) $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: extra field refused SHAPE' {
    $p = @(Refill266Pairs) + @(,@('extra', 1))
    (Refill266Category (Refill266Raw $p $null $null)) -ceq 'SHAPE'
  }
  Check 'metadata: hashtable refused SHAPE' {
    (Refill266Category @{ taskId = 'T1'; eligibility = 'UNKNOWN'; ownedCanonicalPaths = [object[]]@('C:\work\one') }) -ceq 'SHAPE'
  }
  Check 'metadata: ordered dictionary refused SHAPE' {
    (Refill266Category ([ordered]@{ taskId = 'T1'; eligibility = 'UNKNOWN'; ownedCanonicalPaths = [object[]]@('C:\work\one') })) -ceq 'SHAPE'
  }
  Check 'metadata: adapted .NET object refused SHAPE' {
    (Refill266Category ([System.Management.Automation.PSObject]::AsPSObject([System.Uri]'http://localhost/'))) -ceq 'SHAPE'
  }
}

function Refill266TypesBad([string]$Field, $Raw, [string]$Cat) {
  $o = Valid 'T1' @('C:\work\one')
  $o.$Field = $Raw
  (Throws { AssertRefillPlannerTask266 -Value $o } ('REFILL266_INVALID:' + $Cat)) -and ((Refill266Category $o) -ceq $Cat)
}
if ($Group -ceq 'ALL') {
  $hi = [string][char]0xD800
  $lo = [string][char]0xDC00
  $idTypes = @(@('null', $null), @('bool', $true), @('integer', 5), @('double', 1.5), @('array', @('T1')), @('hashtable', @{ a = 1 }))
  foreach ($c in $idTypes) {
    Check ('types: taskId ' + $c[0] + ' refused TYPE') { Refill266TypesBad 'taskId' $c[1] 'TYPE' }
  }
  $idBad = @(@('empty', ''), @('whitespace', '   '), @('length 129', ('a' * 129)))
  foreach ($c in $idBad) {
    Check ('types: taskId ' + $c[0] + ' refused ID') { Refill266TypesBad 'taskId' $c[1] 'ID' }
  }
  $idUni = @(@('lone high surrogate', ('a' + $hi + 'b')), @('lone low surrogate', ('a' + $lo + 'b')), @('reversed pair', ($lo + $hi)), @('trailing high surrogate', ('a' + $hi)))
  foreach ($c in $idUni) {
    Check ('types: taskId ' + $c[0] + ' refused UNICODE') { Refill266TypesBad 'taskId' $c[1] 'UNICODE' }
  }
  $elTypes = @(@('null', $null), @('bool', $false), @('integer', 1), @('array', @('VERIFIED_ELIGIBLE')), @('hashtable', @{ a = 1 }))
  foreach ($c in $elTypes) {
    Check ('types: eligibility ' + $c[0] + ' refused TYPE') { Refill266TypesBad 'eligibility' $c[1] 'TYPE' }
  }
  $elBad = @(@('unknown spelling', 'BOGUS'), @('empty', ''), @('whitespace', ' '), @('hyphenated', 'VERIFIED-ELIGIBLE'), @('padded', 'UNKNOWN '), @('lowercase verified', 'verified_eligible'), @('title case', 'Unknown'), @('lowercase ineligible', 'ineligible'))
  foreach ($c in $elBad) {
    Check ('types: eligibility ' + $c[0] + ' refused ELIGIBILITY') { Refill266TypesBad 'eligibility' $c[1] 'ELIGIBILITY' }
  }
}

if ($Group -ceq 'ALL') {
  function Refill266PathsBad($Raw, [string]$Cat) {
    $o = Valid 'T1' @('C:\work\one')
    $o.ownedCanonicalPaths = $Raw
    (Throws { AssertRefillPlannerTask266 -Value $o } ('REFILL266_INVALID:' + $Cat)) -and ((Refill266Category $o) -ceq $Cat)
  }
  Check 'paths: null refused TYPE' { Refill266PathsBad $null 'TYPE' }
  Check 'paths: scalar string refused TYPE' { Refill266PathsBad 'C:\work\one' 'TYPE' }
  Check 'paths: scalar integer refused TYPE' { Refill266PathsBad 5 'TYPE' }
  Check 'paths: empty array refused CAP' { Refill266PathsBad ([object[]]@()) 'CAP' }
  Check 'paths: 65 entries refused CAP' { Refill266PathsBad ([object[]]@(foreach ($i in 1..65) { 'C:\work\p' + $i })) 'CAP' }
  Check 'paths: case-insensitive duplicate refused DUPLICATE' { Refill266PathsBad ([object[]]@('C:\work\One', 'c:\work\one')) 'DUPLICATE' }
  $pathBad = @(
    @('relative', 'work\one'), @('UNC', '\\server\share\x'), @('device dot', '\\.\C:\x'), @('device question', '\\?\C:\x'),
    @('ADS', 'C:\work\a:b'), @('dot segment', 'C:\work\.\a'), @('dotdot segment', 'C:\work\..\a'),
    @('trailing dot', 'C:\work\a.'), @('trailing space', 'C:\work\a '),
    @('reserved CON', 'C:\work\CON'), @('reserved nul with extension', 'C:\work\nul.txt'), @('reserved COM1', 'C:\work\COM1'), @('reserved LPT9', 'C:\work\LPT9'),
    @('wildcard star', 'C:\work\a*'), @('wildcard question', 'C:\work\a?'),
    @('NUL character', ('C:\work\a' + [string][char]0))
  )
  foreach ($c in $pathBad) {
    Check ('paths: ' + $c[0] + ' refused PATH') { Refill266PathsBad ([object[]]@($c[1])) 'PATH' }
  }
  $pathUni = @(@('lone high surrogate', ('C:\work\a' + [string][char]0xD800 + 'b')), @('lone low surrogate', ('C:\work\a' + [string][char]0xDC00 + 'b')))
  foreach ($c in $pathUni) {
    Check ('paths: ' + $c[0] + ' refused UNICODE') { Refill266PathsBad ([object[]]@($c[1])) 'UNICODE' }
  }
}

[void][System.IO.Directory]::CreateDirectory($anchored)
$failed = @($results | Where-Object { -not $_.pass })
$gm = [ordered]@{ VALID = 'valid:'; METADATA = 'metadata:'; TYPES = 'types:'; PATHS = 'paths:' }
$gx = @(); $gp = @(); $gf = @(); $miss = @()
$cnt = [ordered]@{}
foreach ($g in $gm.Keys) {
  $m = @($results | Where-Object { $_.name.StartsWith($gm[$g], [System.StringComparison]::Ordinal) })
  $cnt[$g] = $m.Count
  if ($m.Count -eq 0) { $miss += $g; continue }
  $gx += $g
  if (@($m | Where-Object { -not $_.pass }).Count -gt 0) { $gf += $g } else { $gp += $g }
}
$full = ($Group -ceq 'ALL') -and ($gp.Count -eq 4) -and ($miss.Count -eq 0) -and ($gf.Count -eq 0) -and ($failed.Count -eq 0) -and ($results.Count -gt 0)
$receipt = [pscustomobject]@{ schema = 'Refill266FocusedTestReceipt/v1'; scope = 'isolated test evidence only; no factory, runtime or codec authority claimed'; group = $Group; implemented = @('VALID', 'METADATA', 'TYPES', 'PATHS'); executed = @($gx); groupsPassed = @($gp); groupsFailed = @($gf); missing = @($miss); groupAssertionCounts = $cnt; sourceSha256 = (Get-Sha $srcFull); harnessSha256 = (Get-Sha $PSCommandPath); fullAcceptance = $full; total = $results.Count; failed = $failed.Count; results = $results.ToArray() }
[System.IO.File]::WriteAllText((Join-Path $anchored 'receipt.json'), (ConvertTo-Json -InputObject $receipt -Depth 6), [System.Text.UTF8Encoding]::new($false))
foreach ($x in $results) { $tag = if ($x.pass) { 'PASS' } else { 'FAIL' }; Write-Host ('{0} {1} {2}' -f $tag, $x.name, $x.detail) }
if ($failed.Count -gt 0) { exit 1 }
if ($Group -ceq 'ALL' -and -not $full) { exit 1 }
exit 0
