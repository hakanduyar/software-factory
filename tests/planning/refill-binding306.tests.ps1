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
$global:R306 = 0
function B([hashtable]$o = @{}, [string[]]$drop = @(), [hashtable]$extra = @{}) {
  $d = [ordered]@{ planPath = 'C:\p\plan.json'; receiptPath = 'C:\p\receipt.json'; eligibilityEvidenceRef = 'C:\p\elig.json'; planSha256 = ('a' * 64); receiptSha256 = ('0123456789abcdef' * 4); provider = 'claude'; owner = 'o'; enabled = $true; taskId = 't' }
  foreach ($k in $o.Keys) { $d[$k] = $o[$k] }
  foreach ($k in $drop) { $d.Remove($k) }
  foreach ($k in $extra.Keys) { $d[$k] = $extra[$k] }
  [pscustomobject]$d
}
function Acc($v) { (AssertRefillBinding306 -Value $v) -eq $true }
function Rej($v, [string]$c) { Throws ({ AssertRefillBinding306 -Value $v }.GetNewClosure()) ('REFILL306_INVALID:' + $c) }
$F9 = @('planPath', 'receiptPath', 'eligibilityEvidenceRef', 'planSha256', 'receiptSha256', 'provider', 'owner', 'enabled', 'taskId')
$Paths = @('planPath', 'receiptPath', 'eligibilityEvidenceRef')
$Hashes = @('planSha256', 'receiptSha256')
$Ids = @('owner', 'taskId')
$lone = [string][char]0xD800
$lowlone = [string][char]0xDC00
$pair = [string][char]0xD83D + [string][char]0xDE00

# VALID
foreach ($p in @('independent', 'claude')) {
  foreach ($e in @($true, $false)) {
    Check ('VALID:provider-' + $p + '-enabled-' + $e) ({ Acc (B @{ provider = $p; enabled = $e }) }.GetNewClosure())
  }
}
foreach ($root in @('C:\')) {
  Check ('VALID:path-root-' + $root) ({ Acc (B @{ planPath = $root; receiptPath = $root; eligibilityEvidenceRef = $root }) }.GetNewClosure())
}
Check 'VALID:path-direct-unicode' { Acc (B @{ planPath = ('C:\u\' + $pair + '\a.json') }) }
Check 'VALID:id-length-1-and-128' { (Acc (B @{ owner = 'x'; taskId = 'y' })) -and (Acc (B @{ owner = ('x' * 128); taskId = ('y' * 128) })) }
Check 'VALID:id-wellformed-surrogate-pair' { Acc (B @{ owner = ('a' + $pair); taskId = $pair }) }
Check 'VALID:strict-mode-exactly-one-bool-true' { $r = @(AssertRefillBinding306 -Value (B)); ($r.Count -eq 1) -and ($r[0] -is [bool]) -and $r[0] }

if ($Group -eq 'ALL') {
# METADATA
foreach ($f in $F9) {
  Check ('METADATA:scriptproperty-getter0-' + $f) ({ $global:R306 = 0; $o = B @{} @($f); Add-Member -InputObject $o -MemberType ScriptProperty -Name $f -Value { $global:R306++; 'x' }; (Rej $o 'SHAPE') -and ($global:R306 -eq 0) }.GetNewClosure())
  Check ('METADATA:missing-' + $f) ({ Rej (B @{} @($f)) 'SHAPE' }.GetNewClosure())
  Check ('METADATA:wrongcase-' + $f) ({ Rej (B @{} @($f) @{ ($f.ToUpper()) = 'x' }) 'SHAPE' }.GetNewClosure())
}
Check 'METADATA:extra-field' { Rej (B @{} @() @{ extra = 'x' }) 'SHAPE' }
Check 'METADATA:later-invalid-before-earlier-read' { $global:R306 = 0; $o = B @{} @('planPath') @{ bogus = 'x' }; Add-Member -InputObject $o -MemberType ScriptProperty -Name 'planPath' -Value { $global:R306++; 'x' }; (Rej $o 'SHAPE') -and ($global:R306 -eq 0) }
Check 'METADATA:root-null' { Rej $null 'SHAPE' }
Check 'METADATA:root-hashtable' { Rej @{ planPath = 'x' } 'SHAPE' }
Check 'METADATA:root-ordered-dictionary' { Rej ([ordered]@{ planPath = 'x' }) 'SHAPE' }
Check 'METADATA:root-string' { Rej 'str' 'SHAPE' }
Check 'METADATA:root-adapted-object' { Rej ([System.Version]::new(1, 2)) 'SHAPE' }
Check 'METADATA:raw-int-owner-not-coerced' { Rej (B @{ owner = 1 }) 'TYPE' }
Check 'METADATA:raw-string-enabled-not-coerced' { Rej (B @{ enabled = 'true' }) 'TYPE' }

# FIELDS
foreach ($f in $Ids) {
  $i = 0
  foreach ($v in @($null, 5, $true)) { $i++; Check ('FIELDS:' + $f + ':type-' + $i) ({ Rej (B @{ $f = $v }) 'TYPE' }.GetNewClosure()) }
  $i = 0
  foreach ($v in @('', '   ', ('x' * 129))) { $i++; Check ('FIELDS:' + $f + ':id-' + $i) ({ Rej (B @{ $f = $v }) 'ID' }.GetNewClosure()) }
  Check ('FIELDS:' + $f + ':lone-high-surrogate') ({ Rej (B @{ $f = ('a' + $lone) }) 'UNICODE' }.GetNewClosure())
  Check ('FIELDS:' + $f + ':lone-low-surrogate') ({ Rej (B @{ $f = ($lowlone + 'a') }) 'UNICODE' }.GetNewClosure())
}
$i = 0
foreach ($v in @('Claude', 'independent ', '', 'codex', 'CLAUDE')) { $i++; Check ('FIELDS:provider-' + $i) ({ Rej (B @{ provider = $v }) 'PROVIDER' }.GetNewClosure()) }
$i = 0
foreach ($v in @($null, 5)) { $i++; Check ('FIELDS:provider-type-' + $i) ({ Rej (B @{ provider = $v }) 'TYPE' }.GetNewClosure()) }
$i = 0
foreach ($v in @($null, 1, 0, 'true')) { $i++; Check ('FIELDS:enabled-type-' + $i) ({ Rej (B @{ enabled = $v }) 'TYPE' }.GetNewClosure()) }
foreach ($f in $Hashes) {
  $i = 0
  foreach ($v in @(('a' * 63), ('a' * 65), ('A' * 64), ('g' * 64), (('a' * 64) + [string][char]10), (' ' + ('a' * 64)), '')) { $i++; Check ('FIELDS:' + $f + ':sha-' + $i) ({ Rej (B @{ $f = $v }) 'SHA' }.GetNewClosure()) }
  $i = 0
  foreach ($v in @($null, 5)) { $i++; Check ('FIELDS:' + $f + ':type-' + $i) ({ Rej (B @{ $f = $v }) 'TYPE' }.GetNewClosure()) }
}
$pathBad = @('', '   ', 'a\b', 'C:/a', 'C:\a\..\b', 'C:\a\.\b', 'C:\a.', 'C:\a ', 'C:\CON', 'C:\a\\b', '\\s\a\b', 'C:\a*b', 'C:\a:b', ('C:\a' + [string][char]1))
foreach ($f in $Paths) {
  $i = 0
  foreach ($v in $pathBad) { $i++; Check ('FIELDS:' + $f + ':path-' + $i) ({ Rej (B @{ $f = $v }) 'PATH' }.GetNewClosure()) }
  $i = 0
  foreach ($v in @($null, 5)) { $i++; Check ('FIELDS:' + $f + ':type-' + $i) ({ Rej (B @{ $f = $v }) 'TYPE' }.GetNewClosure()) }
  Check ('FIELDS:' + $f + ':lone-surrogate') ({ Rej (B @{ $f = ('C:\a' + $lone) }) 'UNICODE' }.GetNewClosure())
  Check ('FIELDS:' + $f + ':nonexistent-lexical-ok') ({ Acc (B @{ $f = 'C:\no\such\file.json' }) }.GetNewClosure())
}
}

$gs = @('VALID', 'METADATA', 'FIELDS')
$rep = [ordered]@{}
foreach ($g in $gs) {
  $sel = @($results | Where-Object { $_.name.StartsWith($g + ':') })
  $pass = @($sel | Where-Object { $_.pass }).Count
  $rep[$g] = [ordered]@{ implemented = $sel.Count; executed = $sel.Count; passed = $pass; failed = ($sel.Count - $pass); missing = $(if ($Group -eq 'VALID' -and $g -ne 'VALID') { 'NOT_RUN_PARTIAL' } else { 0 }) }
}
$totalFail = @($results | Where-Object { -not $_.pass }).Count
$full = ($Group -eq 'ALL') -and ($totalFail -eq 0) -and (@($gs | Where-Object { $rep[$_].executed -eq 0 }).Count -eq 0)
$failed = @($results | Where-Object { -not $_.pass } | ForEach-Object { $_.name })
[pscustomobject]@{ group = $Group; sourceSha256 = $ExpectedSourceSha256.ToUpperInvariant(); harnessSha256 = (Get-Sha $PSCommandPath); counts = $rep; total = $results.Count; failedTotal = $totalFail; failedNames = $failed; fullAcceptanceAll3NonemptyZeroFail = $full; reusedEvidenceRefs = [pscustomobject]@{ helperSourceReviewSha256 = 'CFE7DD261EF3E6B5C0B8DC3324DA32560A15979605D2D04A30CB5CC8B2B83927'; ownerActualSha256 = 'EAC83F51844C1927A019C3C2D9940BC3353A70AA528B95EC6F5A2A9348F2D171'; queueActualSha256 = 'A26602C9769219C5B5A2265F8376C08686081D02893D336F53ECB3061DC9D2A0' } } | ConvertTo-Json -Depth 6 -Compress
[System.IO.Directory]::Delete($anchored, $true)
if ($totalFail -ne 0 -or ($Group -eq 'ALL' -and -not $full)) { exit 1 }
