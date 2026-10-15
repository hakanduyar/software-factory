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
$runAll = [string]::Equals($Group, 'ALL', [System.StringComparison]::Ordinal)
$U = '123e4567-e89b-42d3-a456-426614174000'
function ExpectTrue([string]$v) {
  $o = @(AssertRefillTransactionId296 $v)
  return (($o.Count -eq 1) -and ($o[0] -is [bool]) -and ($o[0] -eq $true))
}
function Mut([int]$i, [string]$c) { return $U.Substring(0, $i) + $c + $U.Substring($i + 1) }

# VALID
$validCases = @(
  ,@('canonical-v4', $U)
  ,@('nil', '00000000-0000-0000-0000-000000000000')
  ,@('all-f', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
  ,@('version0-variant-c', '123e4567-e89b-02d3-c456-426614174000')
  ,@('versionf-variant0', '123e4567-e89b-f2d3-0456-426614174000')
  ,@('version1-variant8', '123e4567-e89b-12d3-8456-426614174000')
)
foreach ($c in $validCases) {
  Check ('VALID:' + $c[0]) { ExpectTrue $c[1] }
}
Check 'VALID:strictmode-latest-exactly-one-bool' { Set-StrictMode -Version Latest; ExpectTrue $U }

if ($runAll) {
  # TYPES
  $typeCases = [ordered]@{
    'null' = $null
    'bool-true' = $true
    'bool-false' = $false
    'int' = 1
    'long' = [long]1
    'guid-object' = [guid]::Parse($U)
    'array-one-string' = @($U)
    'array-empty' = @()
    'array-two' = @($U, $U)
    'pscustomobject' = [pscustomobject]@{ Value = $U }
  }
  foreach ($k in @($typeCases.Keys)) {
    Check ('TYPES:' + $k) { Throws { AssertRefillTransactionId296 $typeCases[$k] } 'REFILL296_INVALID:TYPE' }
  }
  Check 'TYPES:scriptproperty-getter-not-invoked' {
    $script:getterCalls = 0
    $o = [pscustomobject]@{}
    Add-Member -InputObject $o -MemberType ScriptProperty -Name Value -Value { $script:getterCalls++; $script:U }
    $threw = Throws { AssertRefillTransactionId296 $o } 'REFILL296_INVALID:TYPE'
    return ($threw -and ($script:getterCalls -eq 0))
  }

  # FORMAT
  $lf = [string][char]10
  $formatCases = [ordered]@{
    'empty' = ''
    'length35' = $U.Substring(1)
    'length37' = $U + 'a'
    'uppercase' = $U.ToUpperInvariant()
    'no-hyphens' = $U.Replace('-', '')
    'braces' = '{' + $U + '}'
    'parens' = '(' + $U + ')'
    'urn-prefix' = 'urn:uuid:' + $U
    'leading-space-len37' = ' ' + $U
    'leading-space-len36' = ' ' + $U.Substring(1)
    'trailing-space-len36' = $U.Substring(0, 35) + ' '
    'trailing-lf-len37' = $U + $lf
    'trailing-lf-len36' = $U.Substring(0, 35) + $lf
    'nonhex-g' = Mut 0 'g'
    'underscore-for-hyphen' = Mut 8 '_'
    'misplaced-hyphen' = $U.Replace('-', 'a').Insert(7, '-').Substring(0, 36)
    'unicode-arabic-indic-digit' = Mut 0 ([string][char]0x0660)
    'unicode-fullwidth-a' = Mut 1 ([string][char]0xFF41)
    'control-nul' = Mut 5 ([string][char]0)
    'control-tab' = Mut 5 ([string][char]9)
    'control-us' = Mut 5 ([string][char]0x1F)
  }
  foreach ($k in @($formatCases.Keys)) {
    Check ('FORMAT:' + $k) { Throws { AssertRefillTransactionId296 $formatCases[$k] } 'REFILL296_INVALID:UUID' }
  }
}

# Footer
$summary = [ordered]@{}
$missing = @()
$failTotal = 0
$allNonEmpty = $true
foreach ($g in @('VALID', 'TYPES', 'FORMAT')) {
  $rows = @($results | Where-Object { $_.name.StartsWith($g + ':', [System.StringComparison]::Ordinal) })
  $executed = ($rows.Count -gt 0)
  $passed = @($rows | Where-Object { $_.pass }).Count
  $failed = $rows.Count - $passed
  if (-not $executed) { $missing += $g; $allNonEmpty = $false }
  $failTotal += $failed
  $summary[$g] = [ordered]@{ implemented = $true; executed = $executed; total = $rows.Count; passed = $passed; failed = $failed }
}
$fullAcceptance = ($runAll -and $allNonEmpty -and ($failTotal -eq 0))
$receipt = [ordered]@{
  schema = 'RefillTransactionId296Receipt/v1'
  group = $Group
  fullAcceptance = $fullAcceptance
  partial = (-not $runAll)
  missingGroups = @($missing)
  groups = $summary
  totalChecks = $results.Count
  totalFailed = $failTotal
  failedChecks = @($results | Where-Object { -not $_.pass } | ForEach-Object { $_.name })
  sourceSha256 = (Get-Sha $srcFull)
  harnessSha256 = (Get-Sha $PSCommandPath)
}
$json = $receipt | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText([System.IO.Path]::Combine($anchored, 'receipt.json'), $json, [System.Text.UTF8Encoding]::new($false))
Write-Output $json
if ($failTotal -gt 0) { exit 1 }
