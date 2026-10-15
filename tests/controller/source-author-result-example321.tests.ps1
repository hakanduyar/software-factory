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
function Ex327Json([string[]]$Order = @('summary','changedPaths','commandsRun','validationResults','fingerprint','checkpointRef','blockers','recommendedNextAction'), [string[]]$Exp = @('a/b.txt')) {
  $vals = @{ summary = '"s"'; changedPaths = ('[' + (($Exp | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']'); commandsRun = '[]'; validationResults = '["NOT_RUN"]'; fingerprint = 'null'; checkpointRef = 'null'; blockers = '[]'; recommendedNextAction = '"n"' }
  '{' + (($Order | ForEach-Object { '"' + $_ + '":' + $vals[$_] }) -join ',') + '}'
}
function Ex327Acc([string]$Json, [string]$Packet, [object[]]$Exp) {
  $r = @(AssertSourceAuthorResultExample321 -ExampleJson $Json -PacketText $Packet -ExpectedChangedPaths $Exp)
  ($r.Count -eq 1) -and ($r[0] -is [bool]) -and $r[0]
}

# VALID
Check 'VALID:example-exactly-one-bool-strict-literal-packet' { $j = Ex327Json; Ex327Acc $j ('p ' + $j + ' q') @('a/b.txt') }
Check 'VALID:expected-pathset-permutation' { $j = Ex327Json -Exp @('a', 'b', 'c'); Ex327Acc $j $j @('c', 'a', 'b') }
Check 'VALID:key-order-permutation' { $j = Ex327Json -Order @('recommendedNextAction', 'blockers', 'checkpointRef', 'fingerprint', 'validationResults', 'commandsRun', 'changedPaths', 'summary'); Ex327Acc $j $j @('a/b.txt') }

Check 'VALID:expected-32-distinct-short-paths' { $p = @(1..32 | ForEach-Object { 'p' + $_ }); $j = Ex327Json -Exp $p; Ex327Acc $j $j $p }
Check 'VALID:multibyte-summary-exact-literal-in-packet' { $s = ('a' + [string][char]0x00E9 + [string][char]0x4E2D) * 100; $j = (Ex327Json).Replace('"summary":"s"', '"summary":"' + $s + '"'); $ok = ($j -match '[^\x00-\x7F]') -and ($s.Length -le 512) -and ([Text.Encoding]::UTF8.GetByteCount($j) -le 2048); $ok -and (Ex327Acc $j ('p ' + $j + ' q') @('a/b.txt')) }
if ($Group -eq 'ALL') {
  function Ex330Keys { 'summary', 'changedPaths', 'commandsRun', 'validationResults', 'fingerprint', 'checkpointRef', 'blockers', 'recommendedNextAction' }
  function Ex330Rej([string]$Json, [string]$Code, [object]$Exp = @('a/b.txt')) {
    Throws { AssertSourceAuthorResultExample321 -ExampleJson $Json -PacketText $Json -ExpectedChangedPaths $Exp } ('SOURCE_EXAMPLE321_INVALID:' + $Code)
  }
  Check 'METADATA:missing-each-key-shape' { $ok = $true; foreach ($k in (Ex330Keys)) { $o = @(Ex330Keys | Where-Object { $_ -ne $k }); if (-not (Ex330Rej (Ex327Json -Order $o) 'SHAPE')) { $ok = $false } }; $ok }
  Check 'METADATA:case-variant-key-shape' { $b = Ex327Json; $ok = $true; foreach ($k in (Ex330Keys)) { if (-not (Ex330Rej ($b.Replace('"' + $k + '"', '"' + $k.ToUpperInvariant() + '"')) 'SHAPE')) { $ok = $false } }; $ok }
  Check 'METADATA:raw-duplicate-key-shape' { $b = Ex327Json; $ok = $true; foreach ($k in (Ex330Keys)) { if (-not (Ex330Rej ('{"' + $k + '":null,' + $b.Substring(1)) 'SHAPE')) { $ok = $false } }; $ok }
  Check 'METADATA:extra-key-shape' { $b = Ex327Json; $t = $b.Substring(0, $b.Length - 1); (Ex330Rej ($t + ',"extra":1}') 'SHAPE') -and (Ex330Rej ($t + ',"summary2":"s"}') 'SHAPE') }
  Check 'METADATA:strict-primitive-inputs-type' { $j = Ex327Json; $t = 'SOURCE_EXAMPLE321_INVALID:TYPE'; (Throws { AssertSourceAuthorResultExample321 -ExampleJson $null -PacketText $j -ExpectedChangedPaths @('a/b.txt') } $t) -and (Throws { AssertSourceAuthorResultExample321 -ExampleJson 5 -PacketText $j -ExpectedChangedPaths @('a/b.txt') } $t) -and (Throws { AssertSourceAuthorResultExample321 -ExampleJson $j -PacketText $null -ExpectedChangedPaths @('a/b.txt') } $t) -and (Throws { AssertSourceAuthorResultExample321 -ExampleJson $j -PacketText 5 -ExpectedChangedPaths @('a/b.txt') } $t) -and (Throws { AssertSourceAuthorResultExample321 -ExampleJson $j -PacketText $j -ExpectedChangedPaths 'a/b.txt' } $t) -and (Throws { AssertSourceAuthorResultExample321 -ExampleJson $j -PacketText $j -ExpectedChangedPaths $null } $t) -and (Throws { AssertSourceAuthorResultExample321 -ExampleJson $j -PacketText $j -ExpectedChangedPaths @(1) } $t) }
  Check 'METADATA:json-root-types-shape' { $ok = $true; foreach ($r in '[]', '"s"', '1', 'null', 'true') { if (-not (Ex330Rej $r 'SHAPE')) { $ok = $false } }; $ok }
  Check 'METADATA:field-types-shape' { $b = Ex327Json; $ok = $true; $m = @(@('"summary":"s"', '"summary":1', 'SHAPE'), @('"summary":"s"', '"summary":""', 'SHAPE'), @('"summary":"s"', '"summary":" "', 'SHAPE'), @('"recommendedNextAction":"n"', '"recommendedNextAction":null', 'SHAPE'), @('"commandsRun":[]', '"commandsRun":{}', 'SHAPE'), @('"blockers":[]', '"blockers":"x"', 'SHAPE'), @('"validationResults":["NOT_RUN"]', '"validationResults":"NOT_RUN"', 'SHAPE'), @('"changedPaths":["a/b.txt"]', '"changedPaths":{}', 'SHAPE'), @('"changedPaths":["a/b.txt"]', '"changedPaths":[1]', 'SHAPE'), @('"changedPaths":["a/b.txt"]', '"changedPaths":[""]', 'BOUND')); foreach ($p in $m) { if (-not (Ex330Rej ($b.Replace($p[0], $p[1])) $p[2])) { $ok = $false } }; $ok }
  Check 'METADATA:false-execution-claims' { $b = Ex327Json; $ok = $true; $m = @(@('"commandsRun":[]', '"commandsRun":["x"]'), @('"blockers":[]', '"blockers":["x"]'), @('"fingerprint":null', '"fingerprint":"f"'), @('"checkpointRef":null', '"checkpointRef":"c"'), @('"validationResults":["NOT_RUN"]', '"validationResults":["PASSED"]'), @('"validationResults":["NOT_RUN"]', '"validationResults":[]'), @('"validationResults":["NOT_RUN"]', '"validationResults":["NOT_RUN","NOT_RUN"]'), @('"validationResults":["NOT_RUN"]', '"validationResults":["not_run"]'), @('"validationResults":["NOT_RUN"]', '"validationResults":[1]')); foreach ($p in $m) { if (-not (Ex330Rej ($b.Replace($p[0], $p[1])) 'CLAIM')) { $ok = $false } }; $ok }
  Check 'METADATA:pathset-ordinal-refusals' { (Ex330Rej (Ex327Json -Exp @('a', 'a')) 'PATHS' @('a')) -and (Ex330Rej (Ex327Json -Exp @('a')) 'PATHS' @('a', 'a')) -and (Ex330Rej (Ex327Json -Exp @('a')) 'PATHS' @('z')) -and (Ex330Rej (Ex327Json -Exp @('A')) 'PATHS' @('a')) -and (Ex330Rej (Ex327Json -Exp @('a', 'b')) 'PATHS' @('a')) -and (Ex330Rej (Ex327Json -Exp @('a')) 'PATHS' @('a', 'b')) -and (Ex330Rej (Ex327Json -Exp @('a')) 'BOUND' @()) }
  Check 'METADATA:direct-public-call-object-sentinel' { $j = Ex327Json; $c = @{ n = 0 }; $o = [pscustomobject]@{}; $o | Add-Member -MemberType ScriptProperty -Name S -Value ({ $c.n++; 's' }.GetNewClosure()); $t = 'SOURCE_EXAMPLE321_INVALID:TYPE'; (Throws { AssertSourceAuthorResultExample321 -ExampleJson $o -PacketText $j -ExpectedChangedPaths @('a/b.txt') } $t) -and (Throws { AssertSourceAuthorResultExample321 -ExampleJson $j -PacketText $o -ExpectedChangedPaths @('a/b.txt') } $t) -and (Throws { AssertSourceAuthorResultExample321 -ExampleJson $j -PacketText $j -ExpectedChangedPaths $o } $t) -and ($c.n -eq 0) }
  function Fld340Pad([string]$J, [int]$N) { $J + (' ' * ($N - [System.Text.Encoding]::UTF8.GetByteCount($J))) }
  function Fld340Bad([string]$Pkt, [string]$Json, [string]$Code, [object]$Exp = @('a/b.txt')) {
    Throws { AssertSourceAuthorResultExample321 -ExampleJson $Json -PacketText $Pkt -ExpectedChangedPaths $Exp } ('SOURCE_EXAMPLE321_INVALID:' + $Code)
  }
  Check 'FIELDS:malformed-json-refused' { $b = Ex327Json; $t = $b.Substring(0, $b.Length - 1); $ok = $true; foreach ($x in @($t, ($t + ',}'), ('/*c*/' + $b), ($b + ' x'), ($b + $b), '{', '')) { if (-not (Ex330Rej $x 'JSON')) { $ok = $false } }; $ok }
  Check 'FIELDS:json-depth-bound' { $b = Ex327Json; $t = $b.Substring(0, $b.Length - 1); (Ex330Rej ($t + ',"x":{"a":{"b":{"c":{}}}}}') 'JSON') -and (Ex330Rej ($t + ',"x":{"a":{"b":{"c":1}}}}') 'SHAPE') }
  Check 'FIELDS:unpaired-surrogate-json' { $b = Ex327Json; $u = '"\ud800"'; $m = @(@('"summary":"s"', ('"summary":' + $u)), @('"recommendedNextAction":"n"', ('"recommendedNextAction":' + $u)), @('"validationResults":["NOT_RUN"]', ('"validationResults":[' + $u + ']')), @('"a/b.txt"', $u)); $ok = $true; foreach ($p in $m) { if (-not (Ex330Rej ($b.Replace($p[0], $p[1])) 'JSON')) { $ok = $false } }; $ok }
  Check 'FIELDS:example-utf8-bound' { $b = Ex327Json; $p = Fld340Pad $b 2048; $q = Fld340Pad $b 2049; $s = ([string][char]0x4E2D) * 500; $m = $b.Replace('"summary":"s"', ('"summary":"' + $s + '"')); $mp = Fld340Pad $m 2048; $mq = Fld340Pad $m 2049; (Ex327Acc $p $p @('a/b.txt')) -and (Ex330Rej $q 'EXAMPLE_BOUND') -and ($mq.Length -lt 2048) -and (Ex327Acc $mp $mp @('a/b.txt')) -and (Ex330Rej $mq 'EXAMPLE_BOUND') }
  Check 'FIELDS:packet-utf8-bound' { $j = Ex327Json; $pre = ([string][char]0x00E9) * 1000; $a = $pre + $j; $pa = Fld340Pad $a 131072; $pb = Fld340Pad $a 131073; $big = Fld340Pad $j 2049; (Ex327Acc $j $pa @('a/b.txt')) -and ($pb.Length -lt 131073) -and (Fld340Bad $pb $j 'BOUND') -and (Fld340Bad $pb $big 'BOUND') }
  Check 'FIELDS:summary-next-length-512' { $b = Ex327Json; $x = 'x' * 512; $y = 'x' * 513; $ok = $true; foreach ($k in @(@('summary', 's'), @('recommendedNextAction', 'n'))) { $o = '"' + $k[0] + '":"' + $k[1] + '"'; $v = $b.Replace($o, ('"' + $k[0] + '":"' + $x + '"')); $w = $b.Replace($o, ('"' + $k[0] + '":"' + $y + '"')); if (-not (Ex327Acc $v $v @('a/b.txt'))) { $ok = $false }; if (-not (Ex330Rej $w 'SHAPE')) { $ok = $false } }; $ok }
  Check 'FIELDS:path-count-bounds' { $p33 = @(1..33 | ForEach-Object { 'p' + $_ }); $p32 = @(1..32 | ForEach-Object { 'p' + $_ }); (Ex330Rej (Ex327Json -Exp $p33) 'BOUND' $p33) -and (Ex330Rej (Ex327Json -Exp @()) 'BOUND') -and (Ex330Rej (Ex327Json -Exp $p33) 'BOUND' $p32) }
  Check 'FIELDS:expected-path-length-bound' { $j = Ex327Json; $a = 'a' * 2048; $b = 'a' * 2049; (Ex330Rej $j 'BOUND' @($b)) -and (Ex330Rej $j 'PATHS' @($a)) }
  Check 'FIELDS:literal-membership-shape' { $j = Ex327Json; (Fld340Bad 'unrelated' $j 'SHAPE') -and (Fld340Bad ($j.Replace(',', ', ')) $j 'SHAPE') -and (Fld340Bad ($j.ToUpperInvariant()) $j 'SHAPE') }
}

$gs = @('VALID', 'METADATA', 'FIELDS')
$rep = [ordered]@{}
foreach ($g in $gs) {
  $sel = @($results | Where-Object { $_.name.StartsWith($g + ':') })
  $pass = @($sel | Where-Object { $_.pass }).Count
  $rep[$g] = [ordered]@{ implemented = $sel.Count; executed = $sel.Count; passed = $pass; failed = ($sel.Count - $pass); missing = $(if ($sel.Count -eq 0) { 'NOT_IMPLEMENTED' } else { 0 }) }
}
$totalFail = @($results | Where-Object { -not $_.pass }).Count
$full = ($Group -eq 'ALL') -and ($totalFail -eq 0) -and (@($gs | Where-Object { $rep[$_].executed -eq 0 }).Count -eq 0)
$failed = @($results | Where-Object { -not $_.pass } | ForEach-Object { $_.name })
[pscustomobject]@{ group = $Group; sourceSha256 = $ExpectedSourceSha256.ToUpperInvariant(); harnessSha256 = (Get-Sha $PSCommandPath); counts = $rep; total = $results.Count; failedTotal = $totalFail; failedNames = $failed; fullAcceptanceAll3NonemptyZeroFail = $full; reusedEvidenceRefs = [pscustomobject]@{ acceptedScaffoldPreflightShaPrefix = '6F63'; sourceReviewShaPrefix = '941EFF' } } | ConvertTo-Json -Depth 6 -Compress

[System.IO.Directory]::Delete($anchored, $true)
if ($totalFail -ne 0 -or ($Group -eq 'ALL' -and -not $full)) { exit 1 }
