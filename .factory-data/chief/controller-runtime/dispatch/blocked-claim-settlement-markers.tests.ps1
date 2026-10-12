param([Parameter(Mandatory)][string]$StepPath,[Parameter(Mandatory)][string]$FixtureRoot,[Parameter(Mandatory)][string]$PositiveResultPath,[Parameter(Mandatory)][string]$OutputDir)
# RESUME-P07-BLOCKED-INTEGRITY-84: replay must refuse altered settlement markers; no writes on refusal.
$ErrorActionPreference = 'Stop'
. $StepPath

$ids = 'selected.json', 'expected.json', 'terminal.json', 'continuation-state.json', 'host-dispatch-acknowledgements.json'
$origHash = @{}
foreach ($n in $ids) { $origHash[$n] = (Get-FileHash -LiteralPath (Join-Path $FixtureRoot $n) -Algorithm SHA256).Hash }

$pos = Get-Content -LiteralPath $PositiveResultPath -Raw | ConvertFrom-Json -DateKind String
if ($pos.passed -isnot [bool] -or $pos.passed -ne $true) { throw 'Accepted82 positive proof.passed must be Boolean true.' }
$settled = [string]$pos.case
if (-not (Test-Path -LiteralPath $settled -PathType Container)) { throw "Settled case path missing: $settled" }
$posBefore = @{}
foreach ($n in 'continuation-state.json', 'host-dispatch-acknowledgements.json') { $posBefore[$n] = (Get-FileHash -LiteralPath (Join-Path $settled $n) -Algorithm SHA256).Hash }

$selectedBase = (Get-Content -LiteralPath (Join-Path $FixtureRoot 'selected.json') -Raw | ConvertFrom-Json -DateKind String).selected
$expected = Get-Content -LiteralPath (Join-Path $FixtureRoot 'expected.json') -Raw | ConvertFrom-Json -DateKind String
$terminalPath = Join-Path $FixtureRoot 'terminal.json'
$terminalSha = (Get-FileHash -LiteralPath $terminalPath -Algorithm SHA256).Hash.ToLowerInvariant()

$mutations = @(
    @{ name = 'delete-receiptSchemaVersion'; apply = { param($s) $s.PSObject.Properties.Remove('receiptSchemaVersion') } },
    @{ name = 'change-reviewSha'; apply = { param($s) $s.reviewedDispositionReviewSha256 = ('0' * 64) } }
)

$results = @()
foreach ($m in $mutations) {
    $case = Join-Path $OutputDir ("case-" + $m.name)
    New-Item -ItemType Directory -Path $case -Force | Out-Null
    foreach ($n in 'continuation-state.json', 'host-dispatch-acknowledgements.json') { Copy-Item -LiteralPath (Join-Path $settled $n) -Destination (Join-Path $case $n) -Force }
    $statePath = Join-Path $case 'continuation-state.json'
    $ackPath = Join-Path $case 'host-dispatch-acknowledgements.json'

    $selected = ($selectedBase | ConvertTo-Json -Depth 20 -Compress) | ConvertFrom-Json -DateKind String
    $selected.statePath = $statePath

    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -DateKind String
    $entry = $state.entries.PSObject.Properties[$selected.intentId].Value
    & $m.apply $entry.settlement
    ($state | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $statePath -NoNewline

    $stateBefore = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
    $ackBefore = (Get-FileHash -LiteralPath $ackPath -Algorithm SHA256).Hash

    $refused = $false; $message = ''
    try {
        Complete-ContinuationClaim -StateDir $case -SelectedClaim $selected -TerminalReceiptPath $terminalPath -TerminalSha256 $terminalSha -ExpectedBlockedReview $expected | Out-Null
    } catch { $refused = $true; $message = $_.Exception.Message }

    $stateAfter = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
    $ackAfter = (Get-FileHash -LiteralPath $ackPath -Algorithm SHA256).Hash
    $intended = $refused -and $message -like '*Entry already SETTLED with a conflicting terminal fingerprint*'
    $results += [ordered]@{
        name = $m.name; case = $case; refused = $refused; intendedRefusal = $intended; message = $message
        stateShaBefore = $stateBefore; stateShaAfter = $stateAfter; ackShaBefore = $ackBefore; ackShaAfter = $ackAfter
        noWrites = ($stateBefore -eq $stateAfter -and $ackBefore -eq $ackAfter)
    }
}

$fixtureUnchanged = $true
foreach ($n in $ids) { if ((Get-FileHash -LiteralPath (Join-Path $FixtureRoot $n) -Algorithm SHA256).Hash -ne $origHash[$n]) { $fixtureUnchanged = $false } }
$positiveUnchanged = $true
foreach ($n in $posBefore.Keys) { if ((Get-FileHash -LiteralPath (Join-Path $settled $n) -Algorithm SHA256).Hash -ne $posBefore[$n]) { $positiveUnchanged = $false } }

$passed = $fixtureUnchanged -and $positiveUnchanged -and (@($results | Where-Object { -not ($_.intendedRefusal -and $_.noWrites) }).Count -eq 0)
$out = [ordered]@{
    schema = 'BlockedClaimSettlementMarkersResult/v1'; id = 'RESUME-P07-BLOCKED-INTEGRITY-84'
    passed = $passed; fixtureUnchanged = $fixtureUnchanged; positiveCaseUnchanged = $positiveUnchanged; cases = $results
}
$resultPath = Join-Path $OutputDir 'blocked-claim-settlement-markers.result.json'
($out | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $resultPath
if (-not $passed) { throw "Marker integrity test failed; see $resultPath" }