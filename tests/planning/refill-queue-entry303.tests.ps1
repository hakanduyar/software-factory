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

# Grouped QueueEntry fixtures (303). Raw values, lexical scope only; no filesystem or authority claim.
$bs = [char]92
$names = @('planPath', 'receiptPath', 'provider', 'owner', 'enabled', 'id')
$planOk = 'C:' + $bs + 'Work' + $bs + 'plan.json'
$recOk = 'C:' + $bs + 'Work' + $bs + 'receipt.json'
$hi = [string][char]0xD83D
$lo = [string][char]0xDE00
$lone = [string][char]0xD800
$global:Q303G = 0
$errTag = 'REFILL303_INVALID:'

function New-Q303Entry {
  param($Plan = $planOk, $Receipt = $recOk, $Provider = 'independent', $Owner = 'own', $Enabled = $true, $Id = 'id1')
  [pscustomobject]@{ planPath = $Plan; receiptPath = $Receipt; provider = $Provider; owner = $Owner; enabled = $Enabled; id = $Id }
}
function New-Q303Field {
  param([string]$Name, $Value)
  $e = New-Q303Entry
  $e.PSObject.Properties[$Name].Value = $Value
  $e
}
function New-Q303Named {
  param([string[]]$Keys)
  $o = New-Object psobject
  foreach ($k in $Keys) { Add-Member -InputObject $o -MemberType NoteProperty -Name $k -Value 'x' }
  $o
}
function New-Q303Getter {
  param([string]$Slot)
  $o = New-Object psobject
  foreach ($n in $names) {
    if ($n -ceq $Slot) { Add-Member -InputObject $o -MemberType ScriptProperty -Name $n -Value { $global:Q303G++; 'x' } }
    else { Add-Member -InputObject $o -MemberType NoteProperty -Name $n -Value 'x' }
  }
  $o
}
function Test-Q303Ok {
  param($Entry)
  $o = @(AssertRefillQueueEntry303 -Value $Entry)
  ($o.Count -eq 1) -and ($o[0] -is [bool]) -and ($o[0] -eq $true)
}
function Get-Q303Label {
  param($Item)
  if ($null -eq $Item) { 'null' } else { $Item.GetType().Name + ':' + [string]$Item }
}

$groupDefs = [ordered]@{}

$groupDefs['VALID'] = {
  foreach ($pv in @('independent', 'claude')) {
    foreach ($ev in @($true, $false)) {
      Check ('valid provider ' + $pv + ' enabled ' + $ev) { Test-Q303Ok (New-Q303Entry -Provider $pv -Enabled $ev) }
    }
  }
  Check 'valid canonical drive roots C and D, lexical only' { Test-Q303Ok (New-Q303Entry -Plan ('C:' + $bs) -Receipt ('D:' + $bs)) }
  foreach ($len in @(1, 128)) {
    Check ('valid id and owner length ' + $len) { Test-Q303Ok (New-Q303Entry -Id ('a' * $len) -Owner ('b' * $len)) }
  }
  Check 'valid paired Unicode id and owner, 128 chars' { Test-Q303Ok (New-Q303Entry -Id (($hi + $lo) * 64) -Owner ($hi + $lo + 'x')) }
  Check 'StrictMode first call returns exactly one primitive bool true' { Test-Q303Ok (New-Q303Entry) }
}

$groupDefs['METADATA'] = {
  Check 'raw NoteProperty factory valid with zero getter reads' {
    $global:Q303G = 0
    (Test-Q303Ok (New-Q303Entry)) -and ($global:Q303G -eq 0)
  }
  foreach ($sl in $names) {
    Check ('ScriptProperty slot ' + $sl + ' refused SHAPE, getter count 0') {
      $global:Q303G = 0
      $r = Throws { AssertRefillQueueEntry303 -Value (New-Q303Getter -Slot $sl) } ($errTag + 'SHAPE')
      ($r -eq $true) -and ($global:Q303G -eq 0)
    }
  }
  Check 'earlier getter plus later extra field refused SHAPE before getter read' {
    $global:Q303G = 0
    $o = New-Q303Getter -Slot 'planPath'
    Add-Member -InputObject $o -MemberType NoteProperty -Name 'extra' -Value 'x'
    $r = Throws { AssertRefillQueueEntry303 -Value $o } ($errTag + 'SHAPE')
    ($r -eq $true) -and ($global:Q303G -eq 0)
  }
  foreach ($mn in $names) {
    Check ('missing field ' + $mn + ' SHAPE') {
      $e = New-Q303Entry
      $e.PSObject.Properties.Remove($mn)
      Throws { AssertRefillQueueEntry303 -Value $e } ($errTag + 'SHAPE')
    }
  }
  Check 'wrong-case field name SHAPE' {
    Throws { AssertRefillQueueEntry303 -Value (New-Q303Named -Keys @('PlanPath', 'receiptPath', 'provider', 'owner', 'enabled', 'id')) } ($errTag + 'SHAPE')
  }
  Check 'wrong-case last field name SHAPE' {
    Throws { AssertRefillQueueEntry303 -Value (New-Q303Named -Keys @('planPath', 'receiptPath', 'provider', 'owner', 'enabled', 'ID')) } ($errTag + 'SHAPE')
  }
  Check 'extra seventh field SHAPE' {
    Throws { AssertRefillQueueEntry303 -Value (New-Q303Named -Keys ($names + 'extra')) } ($errTag + 'SHAPE')
  }
  Check 'unknown field replacing a required field SHAPE' {
    Throws { AssertRefillQueueEntry303 -Value (New-Q303Named -Keys @('planPath', 'receiptPath', 'provider', 'owner', 'enabled', 'extra')) } ($errTag + 'SHAPE')
  }
  Check 'hashtable root SHAPE' {
    Throws { AssertRefillQueueEntry303 -Value @{ planPath = $planOk; receiptPath = $recOk; provider = 'claude'; owner = 'o'; enabled = $true; id = 'i' } } ($errTag + 'SHAPE')
  }
  Check 'ordered dictionary root SHAPE' {
    Throws { AssertRefillQueueEntry303 -Value ([ordered]@{ planPath = $planOk; receiptPath = $recOk; provider = 'claude'; owner = 'o'; enabled = $true; id = 'i' }) } ($errTag + 'SHAPE')
  }
  Check 'generic dictionary root SHAPE' {
    $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    $d['id'] = 'i'
    Throws { AssertRefillQueueEntry303 -Value $d } ($errTag + 'SHAPE')
  }
  Check 'adapted non-custom object roots SHAPE' {
    (Throws { AssertRefillQueueEntry303 -Value ([System.Version]'1.2') } ($errTag + 'SHAPE')) -and (Throws { AssertRefillQueueEntry303 -Value 'text' } ($errTag + 'SHAPE')) -and (Throws { AssertRefillQueueEntry303 -Value 7 } ($errTag + 'SHAPE'))
  }
  Check 'null root SHAPE' {
    Throws { AssertRefillQueueEntry303 -Value $null } ($errTag + 'SHAPE')
  }
}

$groupDefs['FIELDS'] = {
  foreach ($fn in @('id', 'owner')) {
    foreach ($tv in @($null, $true, 7)) {
      Check ($fn + ' TYPE ' + (Get-Q303Label $tv)) { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name $fn -Value $tv) } ($errTag + 'TYPE') }
    }
    foreach ($bv in @('', '   ', ('a' * 129))) {
      Check ($fn + ' ID length ' + $bv.Length) { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name $fn -Value $bv) } ($errTag + 'ID') }
    }
    foreach ($uv in @($lone, ('a' + $lone), ($lo + 'x'))) {
      Check ($fn + ' UNICODE unpaired surrogate len ' + $uv.Length) { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name $fn -Value $uv) } ($errTag + 'UNICODE') }
    }
  }
  foreach ($tv in @($null, $true, 7)) {
    Check ('provider TYPE ' + (Get-Q303Label $tv)) { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name 'provider' -Value $tv) } ($errTag + 'TYPE') }
  }
  foreach ($pv in @('Independent', 'CLAUDE', 'codex', '', ' independent')) {
    Check ('provider PROVIDER [' + $pv + ']') { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name 'provider' -Value $pv) } ($errTag + 'PROVIDER') }
  }
  foreach ($tv in @('false', 'true', 0, 1, $null)) {
    Check ('enabled TYPE ' + (Get-Q303Label $tv)) { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name 'enabled' -Value $tv) } ($errTag + 'TYPE') }
  }
  foreach ($pf in @('planPath', 'receiptPath')) {
    foreach ($tv in @($null, $true, 7)) {
      Check ($pf + ' TYPE ' + (Get-Q303Label $tv)) { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name $pf -Value $tv) } ($errTag + 'TYPE') }
    }
    Check ($pf + ' literal root valid') { Test-Q303Ok (New-Q303Field -Name $pf -Value ('C:' + $bs)) }
    foreach ($rv in @(('a' + $bs + 'b'), 'plan.json', '')) {
      Check ($pf + ' PATH [' + $rv + ']') { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name $pf -Value $rv) } ($errTag + 'PATH') }
    }
    Check ($pf + ' UNICODE unpaired surrogate') { Throws { AssertRefillQueueEntry303 -Value (New-Q303Field -Name $pf -Value ('C:' + $bs + $lone)) } ($errTag + 'UNICODE') }
  }
}

$order = if ($Group -ceq 'ALL') { @('VALID', 'METADATA', 'FIELDS') } else { @('VALID') }
$summary = [System.Collections.Generic.List[object]]::new()
foreach ($g in @('VALID', 'METADATA', 'FIELDS')) {
  $start = $results.Count
  $ran = $order -contains $g
  if ($ran) { & $groupDefs[$g] }
  $slice = @($results.GetRange($start, $results.Count - $start))
  $nPass = @($slice | Where-Object { $_.pass }).Count
  $summary.Add([pscustomobject]@{
    group = $g
    implemented = $slice.Count
    executed = $slice.Count
    passed = $nPass
    failed = $slice.Count - $nPass
    missing = if ($ran) { 0 } else { 1 }
    nonempty = ($slice.Count -gt 0)
  })
}
$totalFailed = 0
foreach ($s in $summary) { $totalFailed += $s.failed }
$allNonempty = $true
foreach ($s in $summary) { if (-not $s.nonempty) { $allNonempty = $false } }
$full = ($Group -ceq 'ALL') -and $allNonempty -and ($totalFailed -eq 0)
$report = [ordered]@{
  group = $Group
  sourceSha256 = $ExpectedSourceSha256.ToUpperInvariant()
  groups = $summary
  fullAcceptance = $full
  failedNames = @($results | Where-Object { -not $_.pass } | ForEach-Object { $_.name })
}
$json = $report | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText([System.IO.Path]::Combine($anchored, 'result.json'), $json, [System.Text.UTF8Encoding]::new($false))
Write-Output $json
if ($totalFailed -gt 0 -or (($Group -ceq 'ALL') -and -not $full)) { exit 1 }
exit 0
