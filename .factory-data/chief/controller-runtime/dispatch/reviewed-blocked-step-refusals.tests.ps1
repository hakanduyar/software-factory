# reviewed-blocked-step-refusals.tests.ps1
# Frozen106 refusal matrix for the reviewed-BLOCKED admission step. Test-owned fixture writes only under OutputDir.
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$FixtureBuilderPath,
    [Parameter(Mandatory)][string]$FixturePath,
    [Parameter(Mandatory)][string]$TicketTemplatePath,
    [Parameter(Mandatory)][string]$PayloadTemplatePath,
    [Parameter(Mandatory)][string]$OutputDir
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. $SourcePath
. $FixtureBuilderPath

$predFail = 'REVIEWED_BLOCKED_PREDECESSOR_INVALID'
$sha = { param($p) (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
$assert = { param($ok, $msg) if (-not $ok) { throw "ASSERT_FAILED: $msg" } }

$fx = New-OwnedBlockedStepFixture -SourcePath $SourcePath -FixturePath $FixturePath -TicketTemplatePath $TicketTemplatePath -PayloadTemplatePath $PayloadTemplatePath -OutputDir $OutputDir
$base = $fx.context
$base.Claim = $true
$paths = $fx.generatedPaths
$intentId = [string]$base.PreviousSelectedClaim.intentId
$claimId = [string]$base.PreviousSelectedClaim.claimId

# Real valid baseline: must claim through the actual public step before any negative runs.
$baseline = Invoke-ContinuationStep @base
& $assert ($baseline -isnot [array]) 'baseline result must be scalar'
& $assert ($baseline -is [pscustomobject]) 'baseline must be PSCustomObject'
& $assert (($baseline.status -is [string]) -and ($baseline.claimResult -is [string]) -and ($baseline.claimId -is [string])) 'baseline status/claimResult/claimId must be scalar strings'
& $assert (-not [string]::IsNullOrWhiteSpace($baseline.claimId)) 'baseline claimId must be nonblank'
& $assert ($baseline.status -ceq 'CLAIMED') 'baseline status must be CLAIMED'
& $assert ($baseline.claimResult -ceq 'NEW_CLAIM') 'baseline claimResult must be NEW_CLAIM'
$g = [Guid]::Empty
& $assert ([Guid]::TryParse($baseline.claimId, [ref]$g) -and $g -ne [Guid]::Empty) 'baseline claimId must be a nonempty GUID'

$expectRefusal = {
    param([hashtable]$ctx)
    $threw = $false
    $msg = $null
    try { $null = Invoke-ContinuationStep @ctx } catch { $threw = $true; $msg = $_.Exception.Message }
    & $assert $threw 'step must refuse'
    & $assert ($msg -ceq $predFail) "expected $predFail but got: $msg"
}
$bytesOf = { param($p) [IO.File]::ReadAllBytes($p) }
$sameBytes = { param([byte[]]$a, [byte[]]$b) [Convert]::ToHexString($a) -ceq [Convert]::ToHexString($b) }

$groups = @()

# Group 1: omit PreviousSelectedClaim and ExpectedBlockedReview, all five allocation contexts preserved, sealed marker present.
$plan0 = (Get-Content -LiteralPath $paths.planPath -Raw) | ConvertFrom-Json -DateKind String
& $assert ($null -ne $plan0.PSObject.Properties['reviewedBlockedPredecessorSha256']) 'sealed marker must exist in plan'
$ctx1 = @{} + $base
$ctx1.Remove('PreviousSelectedClaim')
$ctx1.Remove('ExpectedBlockedReview')
foreach ($k in 'AllocationSnapshot', 'ExpectedAllocationOrigin', 'NextTicketPath', 'NextPayloadPath', 'ExpectedAllocationTarget') { & $assert ($ctx1.ContainsKey($k)) "context1 keeps $k" }
$st0 = & $bytesOf $paths.statePath
$ak0 = & $bytesOf $paths.ackPath
& $expectRefusal $ctx1
& $assert (& $sameBytes $st0 (& $bytesOf $paths.statePath)) 'group1 state bytes unchanged'
& $assert (& $sameBytes $ak0 (& $bytesOf $paths.ackPath)) 'group1 ACK bytes unchanged'
$groups += 'omitPredecessorInputs'

# Group 2: plan marker replaced by another lowercase 64hex; target planSha256 follows the new plan.
$planBytes0 = & $bytesOf $paths.planPath
$marker0 = [string]$plan0.reviewedBlockedPredecessorSha256
$marker1 = $(if ($marker0[0] -ceq '0') { '1' } else { '0' }) + $marker0.Substring(1)
try {
    $plan0.reviewedBlockedPredecessorSha256 = $marker1
    $plan0 | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $paths.planPath -Encoding utf8
    $ctx2 = @{} + $base
    $ctx2.ExpectedAllocationTarget = [pscustomobject][ordered]@{ stateDir = $base.ExpectedAllocationTarget.stateDir; planSha256 = (& $sha $paths.planPath) }
    $st1 = & $bytesOf $paths.statePath
    $ak1 = & $bytesOf $paths.ackPath
    & $expectRefusal $ctx2
    & $assert (& $sameBytes $st1 (& $bytesOf $paths.statePath)) 'group2 state bytes unchanged'
    & $assert (& $sameBytes $ak1 (& $bytesOf $paths.ackPath)) 'group2 ACK bytes unchanged'
} finally {
    [IO.File]::WriteAllBytes($paths.planPath, $planBytes0)
}
& $assert ((& $sha $paths.planPath) -ceq $base.ExpectedAllocationTarget.planSha256) 'plan restored to expected target hash'
$groups += 'planMarkerMismatch'

# Group 3: keyed ACK native pid + 1 (still valid numeric shape) mismatches the captured predecessor.
$ackBytes0 = & $bytesOf $paths.ackPath
try {
    $akObj = (Get-Content -LiteralPath $paths.ackPath -Raw) | ConvertFrom-Json -DateKind String -NoEnumerate
    $akProp = $akObj.acknowledgements.PSObject.Properties["$intentId|$claimId"]
    & $assert ($null -ne $akProp) 'keyed ACK entry must exist'
    $ident = $akProp.Value.executionBinding.identity
    & $assert ($ident.kind -ceq 'native') 'ACK identity must be native'
    $ident.pid = [int64]$ident.pid + 1
    $akObj | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $paths.ackPath -Encoding utf8
    $st2 = & $bytesOf $paths.statePath
    $ak2 = & $bytesOf $paths.ackPath
    & $expectRefusal ($base.Clone())
    & $assert (& $sameBytes $st2 (& $bytesOf $paths.statePath)) 'group3 state bytes unchanged'
    & $assert (& $sameBytes $ak2 (& $bytesOf $paths.ackPath)) 'group3 ACK bytes unchanged relative to mutated snapshot'
} finally {
    [IO.File]::WriteAllBytes($paths.ackPath, $ackBytes0)
}
& $assert (& $sameBytes $ackBytes0 (& $bytesOf $paths.ackPath)) 'ACK restored'
$groups += 'ackPidMismatch'

# Originals must be untouched.
foreach ($o in $fx.originalFingerprints) {
    & $assert ((& $sha $o.path) -ceq $o.sha256) "original changed: $($o.path)"
}

$result = [pscustomobject][ordered]@{
    status = 'PASS'
    groups = $groups
    priorBaseline = [pscustomobject][ordered]@{ status = $baseline.status; claimResult = $baseline.claimResult }
    unchangedOriginals = @($fx.originalFingerprints).Count
}
$json = $result | ConvertTo-Json -Depth 6
$json | Set-Content -LiteralPath (Join-Path $OutputDir 'refusals-result.json') -Encoding utf8
$json
