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
$global:R314 = 0
function E314([hashtable]$o = @{}, [string[]]$drop = @(), [hashtable]$extra = @{}) {
  $d = [ordered]@{ ownedCanonicalPaths = [object[]]@('C:\p\a.json'); classification = 'NONMODEL_SYNTHETIC_FIXTURE'; eligibility = 'VERIFIED_ELIGIBLE'; owner = 'o'; schema = 'IsolatedEligibilityEvidence249/v1'; taskId = 't' }
  foreach ($k in $o.Keys) { $d[$k] = $o[$k] }
  foreach ($k in $drop) { $d.Remove($k) }
  foreach ($k in $extra.Keys) { $d[$k] = $extra[$k] }
  [pscustomobject]$d
}
function Acc314($v) { (AssertRefillEligibilityEvidence311 -Value $v) -eq $true }
function Rej314($v, [string]$c) { Throws ({ AssertRefillEligibilityEvidence311 -Value $v }.GetNewClosure()) ('REFILL311_INVALID:' + $c) }
$F6 = @('ownedCanonicalPaths', 'classification', 'eligibility', 'owner', 'schema', 'taskId')
$Ids = @('owner', 'taskId')
$lone = [string][char]0xD800
$lowlone = [string][char]0xDC00
$pair = [string][char]0xD83D + [string][char]0xDE00

# VALID
foreach ($e in @('VERIFIED_ELIGIBLE', 'INELIGIBLE', 'UNKNOWN')) {
  Check ('VALID:eligibility-' + $e) ({ Acc314 (E314 @{ eligibility = $e }) }.GetNewClosure())
}
Check 'VALID:paths-array-1-and-64' { (Acc314 (E314 @{ ownedCanonicalPaths = [object[]]@('C:\a') })) -and (Acc314 (E314 @{ ownedCanonicalPaths = [object[]]@(1..64 | ForEach-Object { 'C:\p' + $_ }) })) }
Check 'VALID:path-root-literal-3-chars-67-58-92' { $r = [string]::new([char[]]@(67, 58, 92)); ($r.Length -eq 3) -and ([int]$r[0] -eq 67) -and ([int]$r[1] -eq 58) -and ([int]$r[2] -eq 92) -and ($r -ceq 'C:\') -and (Acc314 (E314 @{ ownedCanonicalPaths = [object[]]@($r) })) }
Check 'VALID:id-length-1-and-128' { (Acc314 (E314 @{ owner = 'x'; taskId = 'y' })) -and (Acc314 (E314 @{ owner = ('x' * 128); taskId = ('y' * 128) })) }
Check 'VALID:id-wellformed-surrogate-pair' { Acc314 (E314 @{ owner = ('a' + $pair); taskId = $pair }) }
Check 'VALID:strict-mode-exactly-one-bool-true' { $r = @(AssertRefillEligibilityEvidence311 -Value (E314)); ($r.Count -eq 1) -and ($r[0] -is [bool]) -and $r[0] }

if ($Group -eq 'ALL') {
# METADATA
foreach ($f in $F6) {
  Check ('METADATA:scriptproperty-getter0-' + $f) ({ $global:R314 = 0; $o = E314 @{} @($f); Add-Member -InputObject $o -MemberType ScriptProperty -Name $f -Value { $global:R314++; 'x' }; (Rej314 $o 'SHAPE') -and ($global:R314 -eq 0) }.GetNewClosure())
  Check ('METADATA:missing-' + $f) ({ Rej314 (E314 @{} @($f)) 'SHAPE' }.GetNewClosure())
  Check ('METADATA:wrongcase-' + $f) ({ Rej314 (E314 @{} @($f) @{ ($f.ToUpper()) = 'x' }) 'SHAPE' }.GetNewClosure())
}
Check 'METADATA:extra-field' { Rej314 (E314 @{} @() @{ extra = 'x' }) 'SHAPE' }
Check 'METADATA:later-invalid-before-earlier-read' { $global:R314 = 0; $o = E314 @{} @('ownedCanonicalPaths') @{ bogus = 'x' }; Add-Member -InputObject $o -MemberType ScriptProperty -Name 'ownedCanonicalPaths' -Value { $global:R314++; 'x' }; (Rej314 $o 'SHAPE') -and ($global:R314 -eq 0) }
Check 'METADATA:root-null' { Rej314 $null 'SHAPE' }
Check 'METADATA:root-hashtable' { Rej314 @{ taskId = 'x' } 'SHAPE' }
Check 'METADATA:root-ordered-dictionary' { Rej314 ([ordered]@{ taskId = 'x' }) 'SHAPE' }
Check 'METADATA:root-string' { Rej314 'str' 'SHAPE' }
Check 'METADATA:root-adapted-object' { Rej314 ([System.Version]::new(1, 2)) 'SHAPE' }
Check 'METADATA:raw-int-owner-not-coerced' { Rej314 (E314 @{ owner = 1 }) 'TYPE' }
Check 'METADATA:raw-string-paths-not-coerced' { Rej314 (E314 @{ ownedCanonicalPaths = 'C:\a' }) 'TYPE' }

# FIELDS
foreach ($f in $Ids) {
  $i = 0
  foreach ($v in @($null, 5, $true)) { $i++; Check ('FIELDS:' + $f + ':type-' + $i) ({ Rej314 (E314 @{ $f = $v }) 'TYPE' }.GetNewClosure()) }
  $i = 0
  foreach ($v in @('', '   ', ('x' * 129))) { $i++; Check ('FIELDS:' + $f + ':id-' + $i) ({ Rej314 (E314 @{ $f = $v }) 'ID' }.GetNewClosure()) }
  Check ('FIELDS:' + $f + ':lone-high-surrogate') ({ Rej314 (E314 @{ $f = ('a' + $lone) }) 'UNICODE' }.GetNewClosure())
  Check ('FIELDS:' + $f + ':lone-low-surrogate') ({ Rej314 (E314 @{ $f = ($lowlone + 'a') }) 'UNICODE' }.GetNewClosure())
}
$i = 0
foreach ($v in @($null, 5)) { $i++; Check ('FIELDS:eligibility-type-' + $i) ({ Rej314 (E314 @{ eligibility = $v }) 'TYPE' }.GetNewClosure()) }
$i = 0
foreach ($v in @('verified_eligible', '', 'ELIGIBLE', 'UNKNOWN ')) { $i++; Check ('FIELDS:eligibility-literal-' + $i) ({ Rej314 (E314 @{ eligibility = $v }) 'ELIGIBILITY' }.GetNewClosure()) }
Check 'FIELDS:schema-type' { Rej314 (E314 @{ schema = 5 }) 'TYPE' }
Check 'FIELDS:schema-literal' { Rej314 (E314 @{ schema = 'isolatedeligibilityevidence249/v1' }) 'SCHEMA' }
Check 'FIELDS:classification-type' { Rej314 (E314 @{ classification = 5 }) 'TYPE' }
Check 'FIELDS:classification-literal' { Rej314 (E314 @{ classification = 'nonmodel_synthetic_fixture' }) 'CLASSIFICATION' }
Check 'FIELDS:paths-type-null' { Rej314 (E314 @{ ownedCanonicalPaths = $null }) 'TYPE' }
Check 'FIELDS:paths-cap-empty' { Rej314 (E314 @{ ownedCanonicalPaths = [object[]]@() }) 'CAP' }
Check 'FIELDS:paths-cap-65' { Rej314 (E314 @{ ownedCanonicalPaths = [object[]]@(1..65 | ForEach-Object { 'C:\p' + $_ }) }) 'CAP' }
Check 'FIELDS:paths-element-type' { Rej314 (E314 @{ ownedCanonicalPaths = [object[]]@(5) }) 'TYPE' }
Check 'FIELDS:paths-duplicate-case-insensitive' { Rej314 (E314 @{ ownedCanonicalPaths = [object[]]@('C:\a', 'c:\A') }) 'DUPLICATE' }
Check 'FIELDS:paths-relative' { Rej314 (E314 @{ ownedCanonicalPaths = [object[]]@('a\b') }) 'PATH' }
Check 'FIELDS:paths-forward-slash' { Rej314 (E314 @{ ownedCanonicalPaths = [object[]]@('C:/a') }) 'PATH' }
Check 'FIELDS:paths-lone-surrogate' { Rej314 (E314 @{ ownedCanonicalPaths = [object[]]@('C:\a' + $lone) }) 'UNICODE' }
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
[pscustomobject]@{ group = $Group; sourceSha256 = $ExpectedSourceSha256.ToUpperInvariant(); harnessSha256 = (Get-Sha $PSCommandPath); counts = $rep; total = $results.Count; failedTotal = $totalFail; failedNames = $failed; fullAcceptanceAll3NonemptyZeroFail = $full; reusedEvidenceRefs = [pscustomobject]@{ eligibilitySourceReviewSha256 = '97FD3B5EBBE4DC9D665D33A7559FD43EE502D9EA33AE16AD7312B0D5F7580082'; taskFactSourceReviewSha256 = '069C65010051BC908D14EA00FF85450151516E6A230E9B793F22C077970F5F23'; plannerActualSha256 = 'E24067A63D045DAF978BE0E269DA223D9544CE3A348D8EB36E1A3D6F1A3807B2' } } | ConvertTo-Json -Depth 6 -Compress

[System.IO.Directory]::Delete($anchored, $true)
if ($totalFail -ne 0 -or ($Group -eq 'ALL' -and -not $full)) { exit 1 }
