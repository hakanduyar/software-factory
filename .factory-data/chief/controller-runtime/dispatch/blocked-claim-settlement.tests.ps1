param(
  [Parameter(Mandatory)][string]$StepPath,
  [Parameter(Mandatory)][string]$FixtureRoot,
  [Parameter(Mandatory)][string]$OutputDir
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Equal($Actual, $Expected, [string]$Name) {
  if ($Actual -ne $Expected) { throw "ASSERT FAILED ${Name}: expected '$Expected' actual '$Actual'" }
}
function Get-Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Read-Json([string]$Path) {
  Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -DateKind String -NoEnumerate
}

. $StepPath

$fxState = Join-Path $FixtureRoot 'continuation-state.json'
$fxAck = Join-Path $FixtureRoot 'host-dispatch-acknowledgements.json'
$fxSelected = Join-Path $FixtureRoot 'selected.json'
$fxTerminal = Join-Path $FixtureRoot 'terminal.json'
$fxExpected = Join-Path $FixtureRoot 'expected.json'
$fixturePaths = @($fxState, $fxAck, $fxSelected, $fxTerminal, $fxExpected)
$fixtureBefore = @{}
foreach ($p in $fixturePaths) { $fixtureBefore[$p] = Get-Sha $p }

# Disposable owned case under OutputDir; fixture is never written.
$case = Join-Path $OutputDir ('case-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $case | Out-Null
$ownedState = Join-Path $case 'continuation-state.json'
$ownedAck = Join-Path $case 'host-dispatch-acknowledgements.json'
Copy-Item -LiteralPath $fxState -Destination $ownedState
Copy-Item -LiteralPath $fxAck -Destination $ownedAck

$selected = (Read-Json $fxSelected).selected
$selected = ($selected | ConvertTo-Json -Depth 20) | ConvertFrom-Json -DateKind String
$selected.statePath = $ownedState
$expected = Read-Json $fxExpected
$terminalSha = Get-Sha $fxTerminal

$ownedStateBefore = Get-Sha $ownedState
$ownedAckBefore = Get-Sha $ownedAck

$first = Complete-ContinuationClaim -StateDir $case -SelectedClaim $selected -TerminalReceiptPath $fxTerminal -TerminalSha256 $terminalSha -ExpectedBlockedReview $expected
Assert-Equal $first.status 'SETTLED' 'first.status'
Assert-Equal ($first.replay -is [bool]) $true 'first.replay is Boolean'
Assert-Equal $first.replay $false 'first.replay'

$state = Read-Json $ownedState
$entry = $state.entries.PSObject.Properties[$selected.intentId].Value
Assert-Equal $entry.status 'SETTLED' 'entry.status'
Assert-Equal $entry.settlement.status 'BLOCKED' 'settlement.status'
Assert-Equal $entry.settlement.receiptSchemaVersion 'OperationalRunReceipt/v2' 'settlement.receiptSchemaVersion'
Assert-Equal $entry.settlement.reviewedDispositionReviewSha256 $expected.reviewSha256 'settlement.reviewSha256'
Assert-Equal $entry.settlement.reviewedDispositionEvidenceSha256 $expected.evidenceSha256 'settlement.evidenceSha256'

$receipt = Read-Json $fxTerminal
Assert-Equal $receipt.reviewedDisposition.providerClassification 'SUCCESS' 'providerClassification'
Assert-Equal $receipt.artifact.complete $false 'artifact.complete'
Assert-Equal ($null -eq $receipt.artifact.path) $true 'artifact.path null'
Assert-Equal ($null -eq $receipt.artifact.sha256) $true 'artifact.sha256 null'

$ownedStateSettled = Get-Sha $ownedState
$ownedAckSettled = Get-Sha $ownedAck

$second = Complete-ContinuationClaim -StateDir $case -SelectedClaim $selected -TerminalReceiptPath $fxTerminal -TerminalSha256 $terminalSha -ExpectedBlockedReview $expected
Assert-Equal $second.status 'SETTLED' 'second.status'
Assert-Equal ($second.replay -is [bool]) $true 'second.replay is Boolean'
Assert-Equal $second.replay $true 'second.replay'
Assert-Equal (Get-Sha $ownedState) $ownedStateSettled 'owned state unchanged on replay'
Assert-Equal (Get-Sha $ownedAck) $ownedAckSettled 'owned ACK unchanged on replay'
foreach ($p in $fixturePaths) { Assert-Equal (Get-Sha $p) $fixtureBefore[$p] "fixture unchanged $p" }

$result = [ordered]@{
  schema = 'BlockedClaimSettlementPositiveResult/v1'
  passed = $true
  case = $case
  firstStatus = $first.status
  firstReplay = $first.replay
  secondStatus = $second.status
  secondReplay = $second.replay
  ownedStateShaBefore = $ownedStateBefore
  ownedStateShaSettled = $ownedStateSettled
  ownedAckShaBefore = $ownedAckBefore
  ownedAckShaSettled = $ownedAckSettled
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDir 'blocked-claim-settlement.result.json') -Encoding utf8
Write-Output 'PASS blocked-claim-settlement positive'
exit 0
