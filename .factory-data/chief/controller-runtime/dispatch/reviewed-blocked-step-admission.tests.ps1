param([string]$SourcePath,[string]$FixtureBuilderPath,[string]$FixturePath,[string]$TicketTemplatePath,[string]$PayloadTemplatePath,[string]$OutputDir)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. $SourcePath
. $FixtureBuilderPath

$checks = [ordered]@{}
function Assert-Check([string]$Name, [bool]$Ok) {
    $script:checks[$Name] = $Ok
    if (-not $Ok) { throw "CHECK_FAILED: $Name" }
}
function Read-State([string]$Path) {
    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -DateKind String -NoEnumerate
}
function Get-EntryProperty($Entries, [string]$Name) {
    foreach ($p in $Entries.PSObject.Properties) {
        if ([string]::Equals($p.Name, $Name, [System.StringComparison]::Ordinal)) { return $p }
    }
    return $null
}
function Get-EntryJson($Entries, [string]$Name) {
    $p = Get-EntryProperty $Entries $Name
    if ($null -eq $p) { return $null }
    return (ConvertTo-Json -InputObject $p.Value -Depth 100 -Compress)
}
function Test-ScalarString($V) { return ($V -is [string]) -and $V.Length -gt 0 }

$fx = New-OwnedBlockedStepFixture -SourcePath $SourcePath -FixturePath $FixturePath `
    -TicketTemplatePath $TicketTemplatePath -PayloadTemplatePath $PayloadTemplatePath -OutputDir $OutputDir
$context = $fx.context
$statePath = [string]$fx.generatedPaths.statePath
Assert-Check 'builderContextIsHashtable' ($context -is [hashtable])
Assert-Check 'claimNotSetByBuilder' (-not ($context.ContainsKey('Claim') -and $context.Claim))

$predId = [string]$context.PreviousSelectedClaim.intentId
Assert-Check 'predecessorIntentIdNonEmpty' (Test-ScalarString $predId)

$stateBefore = Read-State $statePath
$entriesBefore = $stateBefore.entries
Assert-Check 'predecessorEntryFound' ($null -ne $entriesBefore -and $null -ne (Get-EntryProperty $entriesBefore $predId))
$predJsonBefore = Get-EntryJson $entriesBefore $predId

$context.Claim = $true
$first  = Invoke-ContinuationStep @context
$second = Invoke-ContinuationStep @context

foreach ($pair in @(@('first',$first), @('replay',$second))) {
    $n = $pair[0]; $r = $pair[1]
    Assert-Check "$n.statusScalarClaimed" ((Test-ScalarString $r.status) -and $r.status -ceq 'CLAIMED')
    Assert-Check "$n.claimIdIsGuid" ((Test-ScalarString $r.claimId) -and [guid]::TryParse($r.claimId, [ref][guid]::Empty))
    Assert-Check "$n.statePathScalar" (Test-ScalarString $r.statePath)
}
Assert-Check 'first.newClaim' ((Test-ScalarString $first.claimResult) -and $first.claimResult -ceq 'NEW_CLAIM')
Assert-Check 'replay.existingClaim' ((Test-ScalarString $second.claimResult) -and $second.claimResult -ceq 'EXISTING_CLAIM')
Assert-Check 'replay.sameClaimId' ($first.claimId -ceq $second.claimId)

$stateAfter = Read-State $statePath
$entriesAfter = $stateAfter.entries
Assert-Check 'predecessorEntryStillFound' ($null -ne $entriesAfter -and $null -ne (Get-EntryProperty $entriesAfter $predId))
$predJsonAfter = Get-EntryJson $entriesAfter $predId
Assert-Check 'predecessorEntryJsonUnchanged' ($predJsonBefore -ceq $predJsonAfter)

$newId = [string]$first.intentId
Assert-Check 'newIntentIdNonEmpty' (Test-ScalarString $newId)
$newProp = Get-EntryProperty $entriesAfter $newId
Assert-Check 'newIntentDirectKeyPresent' ($null -ne $newProp)
$newClaim = $newProp.Value.claim
Assert-Check 'newEntryClaimIsObject' ($newClaim -is [System.Management.Automation.PSCustomObject])
Assert-Check 'newEntryClaimIdScalarString' (Test-ScalarString $newClaim.claimId)
Assert-Check 'newEntryClaimIdMatches' ($newClaim.claimId -ceq $first.claimId)

foreach ($fp in @($fx.originalFingerprints)) {
    $h = (Get-FileHash -LiteralPath $fp.path -Algorithm SHA256).Hash
    Assert-Check ("originalUnchanged:" + (Split-Path -Leaf $fp.path)) ([string]::Equals($h, [string]$fp.sha256, [System.StringComparison]::OrdinalIgnoreCase))
}

$result = [ordered]@{
    status                   = 'PASS'
    checks                   = $checks
    first                    = [ordered]@{ status = $first.status;  claimResult = $first.claimResult;  claimId = $first.claimId;  intentId = $newId }
    replay                   = [ordered]@{ status = $second.status; claimResult = $second.claimResult; claimId = $second.claimId }
    original128              = 'NOT_DONE'
    providerLaunchObservation = 'NOT_MEASURED_BY_THIS_TEST'
    grantsAuthority          = $false
}
if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }
$json = $result | ConvertTo-Json -Depth 6
Set-Content -LiteralPath (Join-Path $OutputDir 'public-step-result.json') -Value $json -Encoding utf8
$json