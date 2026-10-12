# reviewed-blocked-step-fixture.ps1
# Standalone owned fixture builder for the actual44 reviewed-BLOCKED admission context.
# Builds only under OutputDir; originals are read-only. Never calls Invoke-ContinuationStep, claims, or launches providers.

Set-StrictMode -Version Latest

function New-OwnedBlockedStepFixture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$FixturePath,
        [Parameter(Mandatory)][string]$TicketTemplatePath,
        [Parameter(Mandatory)][string]$PayloadTemplatePath,
        [Parameter(Mandatory)][string]$OutputDir
    )
    $ErrorActionPreference = 'Stop'

    # Accepted helpers (allocation binding, 88 capture, 77 verification, 90 matcher, entry/ACK validators).
    . $SourcePath

    $sha = { param($p) (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
    $fixture = (Get-Content -LiteralPath $FixturePath -Raw) | ConvertFrom-Json -DateKind String -NoEnumerate
    $srcState = [string]$fixture.sourceReferences[0]
    $srcAck = [string]$fixture.sourceReferences[1]
    $receiptPath = [string]$fixture.sourceReferences[2]
    $originalPaths = @($FixturePath, $srcState, $srcAck, $receiptPath, $TicketTemplatePath, $SourcePath, $PayloadTemplatePath)
    $originalFingerprints = @(foreach ($p in $originalPaths) { [pscustomobject][ordered]@{ path = $p; sha256 = (& $sha $p) } })

    $out = [IO.Path]::GetFullPath($OutputDir)
    $stateDir = Join-Path $out 'state'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $statePath = Join-Path $stateDir 'continuation-state.json'
    $ackPath = Join-Path $stateDir 'host-dispatch-acknowledgements.json'
    Copy-Item -LiteralPath $srcState -Destination $statePath -Force
    Copy-Item -LiteralPath $srcAck -Destination $ackPath -Force

    $ticketPath = Join-Path $out 'ticket.json'
    $payloadPath = Join-Path $out 'payload.txt'
    $planPath = Join-Path $out 'plan.json'
    $ownedFixturePath = Join-Path $out 'owned-fixture-target.txt'

    $ticket = (Get-Content -LiteralPath $TicketTemplatePath -Raw) | ConvertFrom-Json -DateKind String
    $ticket.id = 'OWNED_BLOCKED_ADMISSION113'
    $ticket.owner = [string]$fixture.stateEntry.claim.owner
    $ticket.ownedPaths = [object[]]@($ownedFixturePath)
    $ticket.budget = [pscustomobject][ordered]@{ historicalOutputTokens = 6428; additionalOutputMax = 1000; phaseAggregateCeiling = 16000; maxAttempts = 1; elapsedMs = 120000 }
    $ticket | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ticketPath -Encoding utf8
    Copy-Item -LiteralPath $PayloadTemplatePath -Destination $payloadPath -Force

    # Actual v2 terminal receipt identity.
    $receiptSha = & $sha $receiptPath
    if ($receiptSha -cne [string]$fixture.verifiedBlockedInputs.terminalSha256) { throw 'FIXTURE_RECEIPT_SHA_MISMATCH' }

    $origin = [pscustomobject][ordered]@{
        issuerId = $ticket.owner
        authoritySha256 = (& $sha $FixturePath)
        phaseId = 'OWNED_FIXTURE_ONLY'
        predecessorReceiptSha256 = $receiptSha
        nextTicketSha256 = (& $sha $ticketPath)
        nextPayloadSha256 = (& $sha $payloadPath)
    }
    $allocation = [pscustomobject][ordered]@{
        taskId = $ticket.id; owner = $ticket.owner; ownedPaths = [object[]]$ticket.ownedPaths
        maxAdditionalOutput = 1000; aggregateCeiling = 16000; maxAttempts = 1; maxElapsedMs = 120000
    }
    $root = [ordered]@{}
    foreach ($p in $origin.PSObject.Properties) { $root[$p.Name] = $p.Value }
    $root.cumulativeOutput = 6428
    $root.allocation = $allocation
    $snapshot = [pscustomobject]$root
    $binding = Get-ControllerAllocationBinding $snapshot $origin
    $allocMarker = ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($binding | ConvertTo-Json -Depth 12 -Compress))))).ToLowerInvariant()

    # Predecessor fingerprint from the copied state/ACK, mirroring the step's read-only matcher path.
    $prev = [ordered]@{}
    foreach ($p in $fixture.capturedPredecessor.previousSelectedClaim.PSObject.Properties) { $prev[$p.Name] = $p.Value }
    $prev.statePath = $statePath
    $previousSelectedClaim = [pscustomobject]$prev
    $expectedReview = [pscustomobject][ordered]@{
        reviewSha256 = [string]$fixture.capturedPredecessor.expectedReview.reviewSha256
        evidenceSha256 = [string]$fixture.capturedPredecessor.expectedReview.evidenceSha256
    }
    $capture88 = Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $previousSelectedClaim -ExpectedBlockedReview $expectedReview -StateDir $stateDir
    $verified77 = Get-VerifiedBlockedSettlementInputs -ExpectedBlockedReview $capture88.expectedReview -TerminalReceiptPath $receiptPath -TerminalSha256 $receiptSha
    $intentId = $previousSelectedClaim.intentId
    $stObj = (Get-Content -LiteralPath $statePath -Raw) | ConvertFrom-Json -DateKind String -NoEnumerate
    $selEntry = $null
    foreach ($sp in $stObj.entries.PSObject.Properties) {
        Test-ContinuationStateEntry -Key $sp.Name -Entry $sp.Value
        if ([string]::Equals($sp.Name, $intentId, [StringComparison]::Ordinal)) { $selEntry = $sp.Value }
    }
    $akObj = (Get-Content -LiteralPath $ackPath -Raw) | ConvertFrom-Json -DateKind String -NoEnumerate
    $akMap = Test-HostDispatchAcknowledgementEnvelope -AckState $akObj
    $akEntry = $akMap["$intentId|$($previousSelectedClaim.claimId)"]
    $match = Get-ReviewedBlockedPredecessorMatch -CapturedPredecessor88 $capture88 -VerifiedBlockedInputs77 $verified77 -StateEntry $selEntry -AckEntry $akEntry
    $blockedMarker = [string]$match.fingerprintSha256

    $plan = [pscustomobject][ordered]@{
        allocationBindingSha256 = $allocMarker
        reviewedBlockedPredecessorSha256 = $blockedMarker
        receiptSha256 = $receiptSha
        actionId = $ticket.id
        cumulativeOutput = 6428
        maxAdditionalOutput = 1000
        aggregateCeiling = 16000
        ownedPaths = [object[]]$ticket.ownedPaths
        nextInvocation = [pscustomobject][ordered]@{ maxAttempts = 1; maxElapsedMs = 120000 }
        kind = 'NORMAL_REVIEW_DISPATCH'
        failures = 0
        diagnosisSha256 = $null
        budgetKnown = $true
        ownershipKnown = $true
        quotaAllowed = $true
        reviewDenied = $false
    }
    $plan | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $planPath -Encoding utf8
    $target = [pscustomobject][ordered]@{ stateDir = $stateDir; planSha256 = (& $sha $planPath) }

    $context = @{
        StateDir = $stateDir
        ReceiptPath = $receiptPath
        PlanPath = $planPath
        Owner = $ticket.owner
        AllocationSnapshot = $snapshot
        ExpectedAllocationOrigin = $origin
        NextTicketPath = $ticketPath
        NextPayloadPath = $payloadPath
        ExpectedAllocationTarget = $target
        PreviousSelectedClaim = $previousSelectedClaim
        ExpectedBlockedReview = $expectedReview
    }
    [pscustomobject][ordered]@{
        context = $context
        originalFingerprints = $originalFingerprints
        generatedPaths = [pscustomobject][ordered]@{ stateDir = $stateDir; statePath = $statePath; ackPath = $ackPath; ticketPath = $ticketPath; payloadPath = $payloadPath; planPath = $planPath }
    }
}
