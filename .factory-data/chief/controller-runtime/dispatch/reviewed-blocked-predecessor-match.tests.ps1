param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$FixturePath,
    [Parameter(Mandatory = $true)][string]$OutputDir
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stableCode = 'REVIEWED_BLOCKED_PREDECESSOR_MATCH_INVALID'
$sourceFull = [System.IO.Path]::GetFullPath($SourcePath)
$fixtureFull = [System.IO.Path]::GetFullPath($FixturePath)
$outputFull = [System.IO.Path]::GetFullPath($OutputDir)

function Get-BytesSha256([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-TextSha256([string]$Text) {
    return Get-BytesSha256 ([System.Text.UTF8Encoding]::new($false).GetBytes($Text))
}
function Get-FileSha256([string]$Path) {
    return Get-BytesSha256 ([System.IO.File]::ReadAllBytes($Path))
}
function Read-Fixture {
    return (Get-Content -LiteralPath $fixtureFull -Raw -Encoding UTF8) | ConvertFrom-Json -DateKind String -NoEnumerate
}
function Get-Json($Value) { return ($Value | ConvertTo-Json -Depth 100 -Compress) }

$sourceShaBefore = Get-FileSha256 $sourceFull
$fixtureShaBefore = Get-FileSha256 $fixtureFull

. $sourceFull

$fx = Read-Fixture
$inputNames = @('capturedPredecessor', 'verifiedBlockedInputs', 'stateEntry', 'ackEntry')
$inputJsonBefore = [ordered]@{}
foreach ($n in $inputNames) { $inputJsonBefore[$n] = Get-TextSha256 (Get-Json $fx.$n) }

function Invoke-Match($Captured, $Verified, $State, $Ack) {
    try {
        $r = Get-ReviewedBlockedPredecessorMatch -CapturedPredecessor88 $Captured -VerifiedBlockedInputs77 $Verified -StateEntry $State -AckEntry $Ack
        return [pscustomobject]@{ ok = $true; result = $r; error = $null }
    }
    catch {
        return [pscustomobject]@{ ok = $false; result = $null; error = [string]$_.Exception.Message }
    }
}
function Invoke-Clone([scriptblock]$Mutate) {
    $c = Read-Fixture
    & $Mutate $c
    return Invoke-Match $c.capturedPredecessor $c.verifiedBlockedInputs $c.stateEntry $c.ackEntry
}
function Test-StableInvalid($Outcome) {
    return (-not $Outcome.ok) -and ($Outcome.error -like "*$stableCode*")
}

$groups = [System.Collections.Generic.List[object]]::new()
function Add-Group([string]$Name, [scriptblock]$Check) {
    $pass = $false
    $detail = $null
    try { $pass = [bool](& $Check) } catch { $detail = [string]$_.Exception.Message }
    $groups.Add([ordered]@{ name = $Name; passed = $pass; detail = $detail })
}

$hex64 = '^[0-9a-f]{64}$'
$baseline = Invoke-Match $fx.capturedPredecessor $fx.verifiedBlockedInputs $fx.stateEntry $fx.ackEntry

Add-Group 'baseline' {
    if (-not $baseline.ok) { throw "baseline failed: $($baseline.error)" }
    $r = $baseline.result
    $names = @($r.PSObject.Properties.Name)
    $selected = $fx.capturedPredecessor.previousSelectedClaim
    $terminalSha = $fx.verifiedBlockedInputs.terminalSha256
    $strict64 = '\A[0-9a-f]{64}\z'
    ($r -is [System.Management.Automation.PSCustomObject]) -and
    ($r.schema -is [string]) -and
    ($r.fingerprintSha256 -is [string]) -and
    ($r.entrySha256 -is [string]) -and
    ($r.ackSha256 -is [string]) -and
    ($r.predecessorIntentId -is [string]) -and
    ($r.fingerprintSha256.Length -eq 64) -and ($r.fingerprintSha256 -cmatch $strict64) -and
    ($r.entrySha256.Length -eq 64) -and ($r.entrySha256 -cmatch $strict64) -and
    ($r.ackSha256.Length -eq 64) -and ($r.ackSha256 -cmatch $strict64) -and
    ($names.Count -eq 5) -and
    ($r.schema -ceq 'ReviewedBlockedPredecessorMatch/v1') -and
    ($r.fingerprintSha256 -cmatch $hex64) -and
    ($r.entrySha256 -cmatch $hex64) -and
    ($r.ackSha256 -cmatch $hex64) -and
    ($r.predecessorIntentId -ceq $selected.intentId) -and
    ($selected.receiptSha -cne $terminalSha) -and
    ($selected.planSha -cne $terminalSha)
}

Add-Group 'replay' {
    $again = Invoke-Match $fx.capturedPredecessor $fx.verifiedBlockedInputs $fx.stateEntry $fx.ackEntry
    $baseline.ok -and $again.ok -and ((Get-Json $baseline.result) -ceq (Get-Json $again.result))
}

Add-Group 'status-claimed' {
    Test-StableInvalid (Invoke-Clone { param($c) $c.stateEntry.status = 'CLAIMED' })
}

Add-Group 'review-hash-mismatch' {
    $other = '0' * 64
    Test-StableInvalid (Invoke-Clone { param($c) $c.stateEntry.settlement.reviewedDispositionReviewSha256 = $other })
}

Add-Group 'native-pid-mismatch' {
    Test-StableInvalid (Invoke-Clone { param($c) $c.ackEntry.executionBinding.identity.pid = [int]$c.ackEntry.executionBinding.identity.pid + 1 })
}

Add-Group 'receipt-selection-substitution' {
    Test-StableInvalid (Invoke-Clone { param($c) $c.stateEntry.receiptSha256 = $c.verifiedBlockedInputs.terminalSha256 })
}

Add-Group 'integrity' {
    $fxAfter = Read-Fixture
    $same = $true
    foreach ($n in $inputNames) {
        if ((Get-TextSha256 (Get-Json $fx.$n)) -cne $inputJsonBefore[$n]) { $same = $false }
        if ((Get-TextSha256 (Get-Json $fxAfter.$n)) -cne $inputJsonBefore[$n]) { $same = $false }
    }
    $same -and ((Get-FileSha256 $sourceFull) -ceq $sourceShaBefore) -and ((Get-FileSha256 $fixtureFull) -ceq $fixtureShaBefore)
}

$allPassed = (@($groups | Where-Object { -not $_.passed }).Count -eq 0) -and ($groups.Count -eq 7)
$result = [ordered]@{
    schema = 'CapturePublicTestsResult/v1'
    passed = [bool]$allPassed
    actualSourceSha256 = $sourceShaBefore
    fixtureSha256 = $fixtureShaBefore
    inputSha256 = $inputJsonBefore
    groups = @($groups)
}
[System.IO.Directory]::CreateDirectory($outputFull) | Out-Null
$outPath = Join-Path $outputFull 'reviewed-blocked-predecessor-match.tests.result.json'
[System.IO.File]::WriteAllText($outPath, ($result | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 20
if (-not $allPassed) { exit 1 }