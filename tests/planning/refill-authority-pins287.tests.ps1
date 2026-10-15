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
function Refill288Fn([string]$Kind) { if ($Kind -ceq 'PIN') { 'AssertRefillPin287' } else { 'AssertRefillBasisPin287' } }
function Refill288Cat([string]$Kind, $v) { try { $null = & (Refill288Fn $Kind) -Value $v; 'OK' } catch { if ($_.Exception.Message -cmatch '\AREFILL287_INVALID:(PIN|BASIS):(SHAPE|TYPE|PATH|UNICODE|HASH|ROLE|VERSION)\z') { $Matches[1] + ':' + $Matches[2] } else { 'UNEXPECTED' } } }
function Refill288Pairs([string]$Kind) {
  $p = @(@('path', 'C:\work\one'), @('sha256', ('a' * 64)))
  if ($Kind -ceq 'BASIS') { $p += @(,@('role', 'PLAN')); $p += @(,@('observedVersion', 'v1')) }
  $p
}
function Refill288Raw([object[]]$Pairs, $ScriptName, $Counter) {
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
function Refill288Bad([string]$Kind, [string]$Field, $Raw, [string]$Cat) {
  $o = Refill288Raw (Refill288Pairs $Kind) $null $null
  $o.$Field = $Raw
  $exp = $Kind + ':' + $Cat
  (Throws { & (Refill288Fn $Kind) -Value $o } ('REFILL287_INVALID:' + $exp)) -and ((Refill288Cat $Kind $o) -ceq $exp)
}
$hi288 = [string][char]0xD800
$lo288 = [string][char]0xDC00

Check 'pin: exactly two NoteProperty fields accepted' {
  $o = Refill288Raw (Refill288Pairs 'PIN') $null $null
  $m = @($o.PSObject.Properties)
  ($m.Count -eq 2) -and (@($m | Where-Object { $_.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty }).Count -eq 2) -and ((Refill288Cat 'PIN' $o) -ceq 'OK')
}
Check 'pin: literal drive root C:\ accepted' {
  $root = [string]::new([char[]]@([char]0x43, [char]0x3A, [char]0x5C))
  $o = Refill288Raw (Refill288Pairs 'PIN') $null $null
  $o.path = $root
  ($root.Length -eq 3) -and ((Refill288Cat 'PIN' $o) -ceq 'OK')
}
Check 'pin: strict caller gets exactly one bool true' {
  $r = @(AssertRefillPin287 -Value (Refill288Raw (Refill288Pairs 'PIN') $null $null))
  $r.Count -eq 1 -and $r[0] -is [bool] -and $r[0]
}
Check 'basis: exactly four NoteProperty fields accepted' {
  $o = Refill288Raw (Refill288Pairs 'BASIS') $null $null
  $m = @($o.PSObject.Properties)
  ($m.Count -eq 4) -and (@($m | Where-Object { $_.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty }).Count -eq 4) -and ((Refill288Cat 'BASIS' $o) -ceq 'OK')
}
foreach ($role in 'CHECKPOINT', 'PLAN', 'BACKLOG', 'WATCH') {
  Check ('basis: role ' + $role + ' accepted') {
    $o = Refill288Raw (Refill288Pairs 'BASIS') $null $null
    $o.role = $role
    (Refill288Cat 'BASIS' $o) -ceq 'OK'
  }
}
foreach ($len in 1, 256) {
  Check ('basis: version length ' + $len + ' accepted') {
    $o = Refill288Raw (Refill288Pairs 'BASIS') $null $null
    $o.observedVersion = 'v' * $len
    (Refill288Cat 'BASIS' $o) -ceq 'OK'
  }
}
Check 'basis: strict caller gets exactly one bool true' {
  $r = @(AssertRefillBasisPin287 -Value (Refill288Raw (Refill288Pairs 'BASIS') $null $null))
  $r.Count -eq 1 -and $r[0] -is [bool] -and $r[0]
}

if ($Group -ceq 'ALL') {
  foreach ($k in 'PIN', 'BASIS') {
    $kl = $k.ToLowerInvariant()
    $cases = @(
      @('hash null', 'sha256', $null, 'TYPE'),
      @('hash bool', 'sha256', $true, 'TYPE'),
      @('hash integer', 'sha256', 5, 'TYPE'),
      @('hash array', 'sha256', [object[]]@('a'), 'TYPE'),
      @('hash uppercase', 'sha256', ('A' * 64), 'HASH'),
      @('hash nonhex', 'sha256', ('g' * 64), 'HASH'),
      @('hash 63 chars', 'sha256', ('a' * 63), 'HASH'),
      @('hash 65 chars', 'sha256', ('a' * 65), 'HASH'),
      @('hash empty', 'sha256', '', 'HASH'),
      @('path null', 'path', $null, 'TYPE'),
      @('path bool', 'path', $true, 'TYPE'),
      @('path integer', 'path', 5, 'TYPE'),
      @('path array', 'path', [object[]]@('C:\work\one'), 'TYPE'),
      @('path relative', 'path', 'work\one', 'PATH'),
      @('path lone surrogate', 'path', ('C:\work\a' + $hi288 + 'b'), 'UNICODE')
    )
    foreach ($c in $cases) {
      Check ($kl + ': ' + $c[0] + ' refused ' + $c[3]) { Refill288Bad $k $c[1] $c[2] $c[3] }
    }
  }
  $bcases = @(
    @('role null', 'role', $null, 'TYPE'),
    @('role bool', 'role', $true, 'TYPE'),
    @('role integer', 'role', 5, 'TYPE'),
    @('role unknown', 'role', 'OTHER', 'ROLE'),
    @('role wrong case', 'role', 'plan', 'ROLE'),
    @('version null', 'observedVersion', $null, 'TYPE'),
    @('version bool', 'observedVersion', $true, 'TYPE'),
    @('version integer', 'observedVersion', 5, 'TYPE'),
    @('version empty', 'observedVersion', '', 'VERSION'),
    @('version blank', 'observedVersion', '   ', 'VERSION'),
    @('version 257 chars', 'observedVersion', ('v' * 257), 'VERSION'),
    @('version lone high surrogate', 'observedVersion', ('v' + $hi288 + 'x'), 'UNICODE'),
    @('version lone low surrogate', 'observedVersion', ('v' + $lo288 + 'x'), 'UNICODE')
  )
  foreach ($c in $bcases) {
    Check ('basis: ' + $c[0] + ' refused ' + $c[3]) { Refill288Bad 'BASIS' $c[1] $c[2] $c[3] }
  }

  foreach ($k in 'PIN', 'BASIS') {
    $kl = $k.ToLowerInvariant()
    $names = if ($k -ceq 'PIN') { @('path', 'sha256') } else { @('path', 'sha256', 'role', 'observedVersion') }
    Check ('metadata: ' + $kl + ' raw NoteProperty baseline accepted') { (Refill288Cat $k (Refill288Raw (Refill288Pairs $k) $null $null)) -ceq 'OK' }
    foreach ($f in $names) {
      Check ('metadata: ' + $kl + ' ScriptProperty ' + $f + ' refused SHAPE with zero getter calls') {
        $cn = @{ n = 0 }
        $o = Refill288Raw (Refill288Pairs $k) $f $cn
        ((Refill288Cat $k $o) -ceq ($k + ':SHAPE')) -and ($cn.n -eq 0)
      }
      Check ('metadata: ' + $kl + ' missing ' + $f + ' refused SHAPE') {
        $p = @(Refill288Pairs $k | Where-Object { $_[0] -cne $f })
        (Refill288Cat $k (Refill288Raw $p $null $null)) -ceq ($k + ':SHAPE')
      }
      Check ('metadata: ' + $kl + ' wrong-case ' + $f + ' refused SHAPE') {
        $p = @(foreach ($e in (Refill288Pairs $k)) { if ($e[0] -ceq $f) { ,@(($f.Substring(0, 1).ToUpperInvariant() + $f.Substring(1)), $e[1]) } else { ,$e } })
        (Refill288Cat $k (Refill288Raw $p $null $null)) -ceq ($k + ':SHAPE')
      }
    }
    Check ('metadata: ' + $kl + ' extra field refused SHAPE') {
      $p = @(Refill288Pairs $k) + @(,@('extra', 1))
      (Refill288Cat $k (Refill288Raw $p $null $null)) -ceq ($k + ':SHAPE')
    }
    Check ('metadata: ' + $kl + ' hashtable dictionary refused SHAPE') {
      $h = @{}
      foreach ($e in (Refill288Pairs $k)) { $h[$e[0]] = $e[1] }
      (Refill288Cat $k $h) -ceq ($k + ':SHAPE')
    }
    Check ('metadata: ' + $kl + ' ordered dictionary refused SHAPE') {
      $h = [ordered]@{}
      foreach ($e in (Refill288Pairs $k)) { $h[$e[0]] = $e[1] }
      (Refill288Cat $k $h) -ceq ($k + ':SHAPE')
    }
    Check ('metadata: ' + $kl + ' adapted non-custom object refused SHAPE') {
      (Refill288Cat $k ([System.Management.Automation.PSObject]::AsPSObject([version]'1.0'))) -ceq ($k + ':SHAPE')
    }
    Check ('metadata: ' + $kl + ' null refused SHAPE') { (Refill288Cat $k $null) -ceq ($k + ':SHAPE') }
  }
}

[void][System.IO.Directory]::CreateDirectory($anchored)
$failed = @($results | Where-Object { -not $_.pass })
$gm = [ordered]@{ PIN = 'pin:'; BASIS = 'basis:'; METADATA = 'metadata:' }
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
$receipt = [pscustomobject]@{ schema = 'PinBasisTargetedResult288/v1'; scope = 'isolated pin/basis lexical validator test evidence only; no Factory, codec, Options, transaction, runtime, eligibility, hash/IO evidence or authority claimed'; group = $Group; implemented = @('PIN', 'BASIS', 'METADATA'); executed = @($gx); groupsPassed = @($gp); groupsFailed = @($gf); missing = @($miss); groupAssertionCounts = $cnt; sourceSha256 = (Get-Sha $srcFull); harnessSha256 = (Get-Sha $PSCommandPath); fullAcceptance = $full; reusedEvidenceRefs = @('AB56 helper AST identity to CB45: Refill287PathCategory/Refill287TestUnicode shared lexical matrix', 'actual accepted OwnerEAC83 and PlannerE240 fingerprints: helper-only lexical matrix reuse, not counted in fresh assertions'); total = $results.Count; failed = $failed.Count; results = $results.ToArray() }
[System.IO.File]::WriteAllText((Join-Path $anchored 'receipt.json'), (ConvertTo-Json -InputObject $receipt -Depth 6), [System.Text.UTF8Encoding]::new($false))
foreach ($x in $results) { $tag = if ($x.pass) { 'PASS' } else { 'FAIL' }; Write-Host ('{0} {1} {2}' -f $tag, $x.name, $x.detail) }
if ($failed.Count -gt 0) { exit 1 }
if ($Group -ceq 'ALL' -and -not $full) { exit 1 }
exit 0
