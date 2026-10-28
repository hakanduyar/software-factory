# continuation-step.ps1
# Operational continuation transaction: validates a single receipt+plan pair via C3,
# records a classification/budget decision into durable StateDir state, and optionally
# claims a READY intent for a controller-owned owner. Never launches work, never approves.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\continuity\reconcile.ps1')
. (Join-Path $PSScriptRoot 'controller-allocation-input.p03-stage18.ps1')
. (Join-Path $PSScriptRoot 'controller-allocation-planscope.p03-stage19.ps1')
. (Join-Path $PSScriptRoot 'controller-allocation-prestate.p03-stage27.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-predecessor-capture.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-predecessor-match.ps1')

function Test-ContinuationStateEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][PSCustomObject]$Entry
    )
    $e = $Entry
    $k = $Key
    if ($null -eq $e -or $e -isnot [PSCustomObject]) { throw "Corrupt state entry; refusing to proceed." }
    $validKindsAll = @('DIAGNOSE_REPLAN', 'VALIDATE', 'REVIEW', 'NORMAL_REVIEW_DISPATCH', 'NORMAL_AUTHOR_DISPATCH')
    $validStatuses = @('READY', 'BLOCKED', 'CLAIMED', 'SETTLED')
    foreach ($field in @('receiptSha256', 'runId', 'attempt', 'actionId', 'planSha256', 'kind', 'status', 'claim', 'ownedPaths', 'receiptPath', 'planPath', 'cumulativeOutput', 'aggregateCeiling', 'maxAdditionalOutput')) {
        if (-not ($e.PSObject.Properties.Name -contains $field)) { throw "Corrupt state entry missing field '$field'; refusing to proceed." }
    }
    if ($e.receiptSha256 -notmatch '^[0-9a-f]{64}$') { throw "Corrupt state entry: bad receiptSha256." }
    if ($e.planSha256 -notmatch '^[0-9a-f]{64}$') { throw "Corrupt state entry: bad planSha256." }
    if ($e.actionId -isnot [string] -or [string]::IsNullOrWhiteSpace($e.actionId)) { throw "Corrupt state entry: bad actionId." }
    if ($e.runId -isnot [string] -or [string]::IsNullOrWhiteSpace($e.runId)) { throw "Corrupt state entry: bad runId." }
    if (-not ($e.attempt -is [int] -or $e.attempt -is [long]) -or $e.attempt -le 0) { throw "Corrupt state entry: bad attempt." }
    if ($validKindsAll -notcontains $e.kind) { throw "Corrupt state entry: bad kind." }
    if ($validStatuses -notcontains $e.status) { throw "Corrupt state entry: bad status." }
    if ($e.receiptPath -isnot [string] -or [string]::IsNullOrWhiteSpace($e.receiptPath)) { throw "Corrupt state entry: bad receiptPath." }
    if ($e.planPath -isnot [string] -or [string]::IsNullOrWhiteSpace($e.planPath)) { throw "Corrupt state entry: bad planPath." }
    if (-not ($e.cumulativeOutput -is [int] -or $e.cumulativeOutput -is [long]) -or $e.cumulativeOutput -lt 0) { throw "Corrupt state entry: bad cumulativeOutput." }
    # Exact-ordinal outputStopMode selects the OBSERVE_ONLY shape (both ceilings null); any alias or other value refuses and never reads as legacy.
    $modeProps = @($e.PSObject.Properties | Where-Object { [string]::Equals($_.Name, 'outputStopMode', [System.StringComparison]::OrdinalIgnoreCase) })
    if ($modeProps.Count -gt 0) {
        if ($modeProps.Count -ne 1 -or $modeProps[0].Name -cne 'outputStopMode' -or $modeProps[0].Value -isnot [string] -or $modeProps[0].Value -cne 'OBSERVE_ONLY') { throw "Corrupt state entry: bad outputStopMode." }
        if ($null -ne $e.aggregateCeiling -or $null -ne $e.maxAdditionalOutput) { throw "Corrupt state entry: OBSERVE_ONLY entry must carry null output ceilings." }
    } else {
        if (-not ($e.aggregateCeiling -is [int] -or $e.aggregateCeiling -is [long]) -or $e.aggregateCeiling -le 0) { throw "Corrupt state entry: bad aggregateCeiling." }
        if (-not ($e.maxAdditionalOutput -is [int] -or $e.maxAdditionalOutput -is [long]) -or $e.maxAdditionalOutput -le 0) { throw "Corrupt state entry: bad maxAdditionalOutput." }
    }
    if ($e.ownedPaths -isnot [array] -or $e.ownedPaths.Count -eq 0) { throw "Corrupt state entry: bad ownedPaths." }
    foreach ($op in $e.ownedPaths) {
        if ($op -isnot [string] -or [string]::IsNullOrWhiteSpace($op) -or -not [System.IO.Path]::IsPathRooted($op)) { throw "Corrupt state entry: bad ownedPaths element." }
        $opItem = Get-Item -LiteralPath $op -Force -ErrorAction SilentlyContinue
        if ($opItem -and ($opItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Corrupt state entry: ownedPaths reparse point." }
        $opDir = Split-Path -Path $op -Parent
        while ($opDir) {
            $opAnc = Get-Item -LiteralPath $opDir -Force -ErrorAction SilentlyContinue
            if ($opAnc -and ($opAnc.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Corrupt state entry: ownedPaths ancestor reparse point." }
            $opParent = Split-Path -Path $opDir -Parent
            if ($opParent -eq $opDir -or [string]::IsNullOrEmpty($opParent)) { break }
            $opDir = $opParent
        }
    }
    if ($null -eq $e.claim) {
        if ($e.status -eq 'CLAIMED' -or $e.status -eq 'SETTLED') { throw "Corrupt state entry: $($e.status) status with null claim." }
    } else {
        if ($e.status -ne 'CLAIMED' -and $e.status -ne 'SETTLED') { throw "Corrupt state entry: claim present without CLAIMED/SETTLED status." }
        if ($e.claim -isnot [PSCustomObject]) { throw "Corrupt state entry: claim must be an object." }
        if ($e.claim.owner -isnot [string] -or [string]::IsNullOrWhiteSpace($e.claim.owner)) { throw "Corrupt state entry: bad claim.owner." }
        $parsedGuid = [Guid]::Empty
        if ($e.claim.claimId -isnot [string] -or -not [Guid]::TryParse($e.claim.claimId, [ref]$parsedGuid) -or $parsedGuid -eq [Guid]::Empty) { throw "Corrupt state entry: bad claim.claimId." }
        $parsedDate = [DateTime]::MinValue
        if ($e.claim.claimedAt -isnot [string] -or -not [DateTime]::TryParse($e.claim.claimedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedDate)) { throw "Corrupt state entry: bad claim.claimedAt." }
    }
    if ($e.status -eq 'SETTLED') {
        if (-not ($e.PSObject.Properties.Name -contains 'settlement') -or $null -eq $e.settlement -or $e.settlement -isnot [PSCustomObject]) { throw "Corrupt state entry: SETTLED without settlement." }
        foreach ($sf in @('terminalReceiptPath', 'terminalSha256', 'taskId', 'runId', 'attempt', 'payloadSha256', 'ticketSha256', 'settledAt')) {
            if (-not ($e.settlement.PSObject.Properties.Name -contains $sf)) { throw "Corrupt state entry: settlement missing '$sf'." }
        }
        if ($e.settlement.terminalSha256 -notmatch '^[0-9a-f]{64}$') { throw "Corrupt state entry: bad settlement.terminalSha256." }
        if ($e.settlement.ticketSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Corrupt state entry: bad settlement.ticketSha256." }
    } elseif (($e.PSObject.Properties.Name -contains 'settlement') -and $null -ne $e.settlement) {
        throw "Corrupt state entry: settlement present without SETTLED status."
    }
    $expectedKey = "$($e.receiptSha256)|$($e.runId)|$($e.attempt)|$($e.actionId)"
    if ($k -cne $expectedKey) { throw "Corrupt state entry: key mismatch for '$k'." }
}

function Test-ExecutionBinding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][PSCustomObject]$Binding
    )
    if ($null -eq $Binding -or $Binding -isnot [PSCustomObject]) { throw "ExecutionBinding must be a non-null object." }
    foreach ($bf in @('schema', 'taskId', 'ticketSha256', 'payloadSha256', 'runId', 'attempt', 'identity', 'receiptSha', 'planSha')) {
        if (-not ($Binding.PSObject.Properties.Name -contains $bf)) { throw "ExecutionBinding missing field '$bf'; refusing to proceed." }
    }
    if ($Binding.schema -cne 'host-dispatch-execution-binding/v1') { throw "ExecutionBinding has unexpected schema; refusing to proceed." }
    foreach ($sf in @('taskId', 'runId')) {
        if ($Binding.$sf -isnot [string] -or [string]::IsNullOrWhiteSpace($Binding.$sf)) { throw "ExecutionBinding.$sf must be a nonblank string." }
    }
    if ($Binding.ticketSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "ExecutionBinding.ticketSha256 must be 64hex." }
    if ($Binding.payloadSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "ExecutionBinding.payloadSha256 must be 64hex." }
    if ($Binding.attempt -isnot [int] -and $Binding.attempt -isnot [long]) { throw "ExecutionBinding.attempt must be an integer." }
    if ([int64]$Binding.attempt -le 0) { throw "ExecutionBinding.attempt must be positive." }
    if ($Binding.receiptSha -notmatch '^[0-9a-f]{64}$') { throw "ExecutionBinding.receiptSha must be 64hex." }
    if ($Binding.planSha -notmatch '^[0-9a-f]{64}$') { throw "ExecutionBinding.planSha must be 64hex." }
    $identity = $Binding.identity
    if ($null -eq $identity -or $identity -isnot [PSCustomObject]) { throw "ExecutionBinding.identity must be an object." }
    if (-not ($identity.PSObject.Properties.Name -contains 'kind') -or @('native', 'session') -notcontains $identity.kind) { throw "ExecutionBinding.identity.kind must be 'native' or 'session'." }
    if ($identity.kind -eq 'native') {
        if (-not ($identity.PSObject.Properties.Name -contains 'pid') -or ($identity.pid -isnot [int] -and $identity.pid -isnot [long]) -or [int64]$identity.pid -le 0) { throw "ExecutionBinding.identity.pid must be a positive integer for native identity." }
        if (-not ($identity.PSObject.Properties.Name -contains 'startIdentity') -or $identity.startIdentity -isnot [string] -or [string]::IsNullOrWhiteSpace($identity.startIdentity)) { throw "ExecutionBinding.identity.startIdentity must be a nonblank string for native identity." }
    } else {
        if (-not ($identity.PSObject.Properties.Name -contains 'sessionId') -or $identity.sessionId -isnot [string] -or [string]::IsNullOrWhiteSpace($identity.sessionId)) { throw "ExecutionBinding.identity.sessionId must be a nonblank string for session identity." }
    }
}

function Test-HostDispatchAcknowledgementEnvelope {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][PSCustomObject]$AckState
    )
    if ($null -eq $AckState -or $AckState -isnot [PSCustomObject] -or -not ($AckState.PSObject.Properties.Name -contains 'schema') -or $AckState.schema -isnot [string] -or $AckState.schema -cne 'host-dispatch-acknowledgement/v1' -or -not ($AckState.PSObject.Properties.Name -contains 'acknowledgements') -or $null -eq $AckState.acknowledgements -or $AckState.acknowledgements -isnot [PSCustomObject]) {
        throw "Dispatch acknowledgement envelope malformed; refusing to proceed."
    }
    $ackHash = [System.Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
    foreach ($p in $AckState.acknowledgements.PSObject.Properties) {
        $kv = $p.Value
        if ($null -eq $kv -or $kv -isnot [PSCustomObject]) { throw "Existing keyed acknowledgement '$($p.Name)' is null or not an object; refusing to proceed." }
        if (-not ($kv.PSObject.Properties.Name -contains 'schema') -or $kv.schema -isnot [string] -or $kv.schema -cne 'host-dispatch-acknowledgement/v1') { throw "Existing keyed acknowledgement '$($p.Name)' has wrong or missing schema; refusing to proceed." }
        foreach ($kf in @('entryId', 'owner', 'claimId', 'intentId', 'recordedAt', 'dispatchedAt')) {
            if (-not ($kv.PSObject.Properties.Name -contains $kf) -or $kv.$kf -isnot [string] -or [string]::IsNullOrWhiteSpace($kv.$kf)) { throw "Existing keyed acknowledgement '$($p.Name)' field $kf missing or not a nonblank string; refusing to proceed." }
        }
        $kvGuid = [Guid]::Empty
        if (-not [Guid]::TryParse($kv.claimId, [ref]$kvGuid) -or $kvGuid -eq [Guid]::Empty) { throw "Existing keyed acknowledgement '$($p.Name)' claimId is not a valid nonempty GUID; refusing to proceed." }
        $kvRecordedDate = [DateTime]::MinValue
        if (-not [DateTime]::TryParse($kv.recordedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$kvRecordedDate)) { throw "Existing keyed acknowledgement '$($p.Name)' recordedAt is not a valid date; refusing to proceed." }
        $kvDispatchedDate = [DateTime]::MinValue
        if (-not [DateTime]::TryParse($kv.dispatchedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$kvDispatchedDate)) { throw "Existing keyed acknowledgement '$($p.Name)' dispatchedAt is not a valid date; refusing to proceed." }
        $kvExpectedKey = "$($kv.intentId)|$($kv.claimId)"
        if ($p.Name -cne $kvExpectedKey) { throw "Existing keyed acknowledgement '$($p.Name)' key does not match its own intentId|claimId; refusing to proceed." }
        if ($kv.PSObject.Properties.Name -contains 'executionBinding' -and $null -ne $kv.executionBinding) {
            try {
                Test-ExecutionBinding -Binding $kv.executionBinding
            } catch {
                throw "Existing keyed acknowledgement '$($p.Name)' has a malformed executionBinding; refusing to proceed. $($_.Exception.Message)"
            }
        }
        $ackHash[$p.Name] = $kv
    }
    return $ackHash
}

function Invoke-ContinuationStep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [Parameter(Mandatory)][string]$PlanPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Owner,
        [switch]$Claim,
        [AllowNull()][object]$AllocationSnapshot,
        [AllowNull()][object]$ExpectedAllocationOrigin,
        [AllowNull()][object]$NextTicketPath,
        [AllowNull()][object]$NextPayloadPath,
        [AllowNull()][object]$ExpectedAllocationTarget,
        [AllowNull()][object]$PreviousSelectedClaim,
        [AllowNull()][object]$ExpectedBlockedReview
    )

    $predFail = 'REVIEWED_BLOCKED_PREDECESSOR_INVALID'
    $hasPredPrev = $PSBoundParameters.ContainsKey('PreviousSelectedClaim')
    $hasPredReview = $PSBoundParameters.ContainsKey('ExpectedBlockedReview')
    $predCapture = $null
    if ($hasPredPrev -or $hasPredReview) {
        if (-not ($hasPredPrev -and $hasPredReview) -or $null -eq $PreviousSelectedClaim -or $null -eq $ExpectedBlockedReview) { throw $predFail }
        $predCapture = Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $PreviousSelectedClaim -ExpectedBlockedReview $ExpectedBlockedReview -StateDir $StateDir
        if ($null -eq $predCapture -or $predCapture.schema -cne 'ReviewedBlockedPredecessorCapture/v1') { throw $predFail }
        foreach ($an in @('AllocationSnapshot', 'ExpectedAllocationOrigin', 'NextTicketPath', 'NextPayloadPath', 'ExpectedAllocationTarget')) {
            if (-not $PSBoundParameters.ContainsKey($an) -or $null -eq $PSBoundParameters[$an]) { throw 'CONTROLLER_ALLOCATION_INVALID' }
        }
    }

    $stateDirFull = [System.IO.Path]::GetFullPath($StateDir)
    $receiptFull = [System.IO.Path]::GetFullPath($ReceiptPath)
    $planFull = [System.IO.Path]::GetFullPath($PlanPath)
    # Defined for later integration; not invoked here. Read-only: no mkdir/copy/write/C3/claim completion.
    $getBlockedMatch = {
        try {
            if ($null -eq $predCapture) { throw $predFail }
            $freshSha = (Get-FileHash -LiteralPath $receiptFull -Algorithm SHA256).Hash.ToLowerInvariant()
            $verified = Get-VerifiedBlockedSettlementInputs -ExpectedBlockedReview $predCapture.expectedReview -TerminalReceiptPath $receiptFull -TerminalSha256 $freshSha
            if ($null -eq $verified -or $verified.schema -cne 'VerifiedBlockedSettlementInputs/v1') { throw $predFail }
            $intentId = $predCapture.previousSelectedClaim.intentId
            $claimId = $predCapture.previousSelectedClaim.claimId
            $capStateDir = $predCapture.stateDirFull

            $stPath = Join-Path $capStateDir 'continuation-state.json'
            if (-not (Test-Path -LiteralPath $stPath -PathType Leaf)) { throw $predFail }
            $stRaw = Get-Content -LiteralPath $stPath -Raw
            if ([string]::IsNullOrWhiteSpace($stRaw)) { throw $predFail }
            $stObj = $stRaw | ConvertFrom-Json -DateKind String -NoEnumerate
            if ($null -eq $stObj -or $stObj -isnot [PSCustomObject] -or $stObj.schema -cne 'continuation-state/v1' -or $null -eq $stObj.entries -or $stObj.entries -isnot [PSCustomObject]) { throw $predFail }
            $selEntry = $null
            $selCount = 0
            foreach ($sp in $stObj.entries.PSObject.Properties) {
                Test-ContinuationStateEntry -Key $sp.Name -Entry $sp.Value
                if ([string]::Equals($sp.Name, $intentId, [System.StringComparison]::Ordinal)) { $selEntry = $sp.Value; $selCount++ }
            }
            if ($selCount -ne 1) { throw $predFail }

            $akPath = Join-Path $capStateDir 'host-dispatch-acknowledgements.json'
            if (-not (Test-Path -LiteralPath $akPath -PathType Leaf)) { throw $predFail }
            $akRaw = Get-Content -LiteralPath $akPath -Raw
            if ([string]::IsNullOrWhiteSpace($akRaw)) { throw $predFail }
            $akObj = $akRaw | ConvertFrom-Json -DateKind String -NoEnumerate
            $akMap = Test-HostDispatchAcknowledgementEnvelope -AckState $akObj
            $akKey = "$intentId|$claimId"
            if (-not $akMap.Contains($akKey)) { throw $predFail }
            $akEntry = $akMap[$akKey]
            if ($null -eq $akEntry -or -not ($akEntry.PSObject.Properties.Name -contains 'executionBinding') -or $null -eq $akEntry.executionBinding) { throw $predFail }
            Test-ExecutionBinding -Binding $akEntry.executionBinding

            return (Get-ReviewedBlockedPredecessorMatch -CapturedPredecessor88 $predCapture -VerifiedBlockedInputs77 $verified -StateEntry $selEntry -AckEntry $akEntry)
        } catch {
            throw $predFail
        }
    }
    $allocFail = 'CONTROLLER_ALLOCATION_INVALID'
    $optNames = 'AllocationSnapshot', 'ExpectedAllocationOrigin', 'NextTicketPath', 'NextPayloadPath', 'ExpectedAllocationTarget'
    $optIn = $false
    foreach ($n in $optNames) { if ($PSBoundParameters.ContainsKey($n)) { $optIn = $true } }
    $capture = $null
    $hasMarker = $false
    $plannedMarker = $null
    $blockedAdmit = $false
    $initialBlockedMatch = $null
    if ($optIn) {
        $helperArgs = @{ StateDir = $stateDirFull; ReceiptPath = $receiptFull; PlanPath = $planFull; Owner = $Owner }
        foreach ($n in $optNames) { if ($PSBoundParameters.ContainsKey($n)) { $helperArgs[$n] = $PSBoundParameters[$n] } }
        $capture = Get-ControllerAllocationPrestate @helperArgs
        if ($null -eq $capture -or $capture.enabled -ne $true) { throw $allocFail }
        $bmk = $capture.plan.PSObject.Properties['reviewedBlockedPredecessorSha256']
        if ($null -ne $bmk) { $hasMarker = $true; $plannedMarker = $bmk.Value }
    } elseif (Test-Path -LiteralPath $planFull -PathType Leaf) {
        $probe = $null
        try { $probe = (Get-Content -LiteralPath $planFull -Raw) | ConvertFrom-Json -DateKind String } catch { $probe = $null }
        if ($null -ne $probe) {
            $mk = $probe.PSObject.Properties['allocationBindingSha256']
            if ($null -ne $mk -and $mk.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $allocFail }
            $bmk = $probe.PSObject.Properties['reviewedBlockedPredecessorSha256']
            if ($null -ne $bmk -and $bmk.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $predFail }
            if (@($probe.PSObject.Properties | Where-Object { [string]::Equals($_.Name, 'outputStopMode', [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { throw $allocFail }
        }
    }
    if ($null -ne $predCapture) {
        if (-not $optIn -or -not $hasMarker) { throw $predFail }
        if ($plannedMarker -isnot [string] -or $plannedMarker.Length -ne 64 -or $plannedMarker -cnotmatch '^[0-9a-f]{64}$') { throw $predFail }
        $initialBlockedMatch = & $getBlockedMatch
        if ($null -eq $initialBlockedMatch -or $initialBlockedMatch.fingerprintSha256 -isnot [string] -or $initialBlockedMatch.fingerprintSha256 -cne $plannedMarker) { throw $predFail }
        $blockedAdmit = $true
    } elseif ($hasMarker) {
        throw $predFail
    }
    $assertCapture = {
        if (-not $optIn) { return }
        try {
            $ap = (Get-FileHash -LiteralPath $planFull -Algorithm SHA256).Hash.ToLowerInvariant()
            $ar = (Get-FileHash -LiteralPath $receiptFull -Algorithm SHA256).Hash.ToLowerInvariant()
        } catch { throw $allocFail }
        if ($ap -cne $capture.planSha256 -or $ar -cne $capture.receiptSha256) { throw $allocFail }
    }
    & $assertCapture
    # OBSERVE_ONLY is reachable only through the full opt-in; a v3 receipt or a plan marker alone refuses before any state IO.
    $receiptIsV3 = $false
    if (Test-Path -LiteralPath $receiptFull -PathType Leaf) {
        $rp = $null
        try { $rp = (Get-Content -LiteralPath $receiptFull -Raw) | ConvertFrom-Json -DateKind String } catch { $rp = $null }
        if ($null -ne $rp) {
            $rsv = $rp.PSObject.Properties['schemaVersion']
            if ($null -ne $rsv -and $rsv.Value -is [string] -and $rsv.Value -ilike 'OperationalRunReceipt/v3*') { $receiptIsV3 = $true }
            if (@($rp.PSObject.Properties | Where-Object { @('observePendingAccountingEvidence', 'observePendingAccounting', 'outputStopMode') -contains [string]$_.Name }).Count -gt 0) { $receiptIsV3 = $true }
        }
    }
    $observeMode = $false
    if ($optIn -and $null -ne $capture.binding.allocation.PSObject.Properties['outputStopMode']) { $observeMode = $true }
    if ($observeMode) {
        $planMode = $capture.plan.PSObject.Properties['outputStopMode']
        if (-not $receiptIsV3 -or $null -ne $predCapture -or $null -eq $planMode -or $planMode.Value -isnot [string] -or $planMode.Value -cne 'OBSERVE_ONLY' -or $capture.binding.allocation.outputStopMode -cne 'OBSERVE_ONLY') { throw $allocFail }
    } elseif ($receiptIsV3) {
        throw $allocFail
    }
    if (-not (Test-Path -LiteralPath $stateDirFull -PathType Container)) {
        New-Item -ItemType Directory -Path $stateDirFull -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $receiptFull -PathType Leaf)) { throw "Receipt not found: $receiptFull" }
    if (-not (Test-Path -LiteralPath $planFull -PathType Leaf)) { throw "Plan not found: $planFull" }

    if (-not $observeMode) {
    $receiptDir = Join-Path $stateDirFull ("c3-receipt-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $receiptDir -Force | Out-Null
    try {
        Copy-Item -LiteralPath $receiptFull -Destination (Join-Path $receiptDir 'receipt.json') -Force
        $outboxPath = Join-Path $stateDirFull 'c3-outbox.json'
$sw = [Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            try {
                $reconciliation = Invoke-ReceiptReconciliation -ReceiptDir $receiptDir -OutboxPath $outboxPath
                break
            } catch {
                $inner = $_.Exception
                $isSharingViolation = $false
                while ($inner) {
                    if ($inner -is [System.IO.IOException] -and (($inner.HResult -band 0xFFFF) -eq 32 -or ($inner.HResult -band 0xFFFF) -eq 33)) { $isSharingViolation = $true; break }
                    $inner = $inner.InnerException
                }
                if (-not $isSharingViolation -or $sw.ElapsedMilliseconds -ge 2000) { throw }
                Start-Sleep -Milliseconds 25
            }
        }
        if ($reconciliation.invalidReceipts -gt 0) {
            throw "C3 rejected receipt as invalid."
        }
    } finally {
        Remove-Item -LiteralPath $receiptDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    }

    $receiptJson = Get-Content -LiteralPath $receiptFull -Raw
    $receipt = $receiptJson | ConvertFrom-Json -DateKind String
    if (-not (Test-OperationalReceipt $receipt)) { throw "Receipt failed C3 validator." }
    if ($observeMode) {
        # The pending v3 receipt is validated directly (strict v3 validator + shared pending facts); it never enters general reconciliation.
        . (Join-Path $PSScriptRoot 'managed-native-receipt.ps1')
        if ($receipt.schemaVersion -cne 'OperationalRunReceipt/v3' -or $receipt.status -cne 'AWAITING_CONTROLLER' -or $receipt.outputStopMode -cne 'OBSERVE_ONLY') { throw "OBSERVE_ONLY requires a pending v3 AWAITING_CONTROLLER receipt." }
        if ($receipt.historyVerified -isnot [bool] -or $receipt.historyVerified -or $receipt.artifact.complete -isnot [bool] -or $receipt.artifact.complete) { throw "OBSERVE_ONLY receipt must be pending-only." }
        $pendingFacts = Get-ManagedObservePendingAccountingFacts -Evidence $receipt.observePendingAccountingEvidence
        if ($null -eq $pendingFacts -or $pendingFacts.Valid -isnot [bool] -or -not $pendingFacts.Valid -or $null -eq $pendingFacts.Facts) { throw "OBSERVE_ONLY pending accounting facts not verified." }
        $usedFacts = $pendingFacts.Facts.accounting.usedOutputTokens
        if (-not ($usedFacts -is [int] -or $usedFacts -is [long]) -or [long]$usedFacts -ne [long]$receipt.budget.usedOutputTokens -or [long]$usedFacts -ne [long]$capture.binding.cumulativeOutput) { throw "OBSERVE_ONLY cumulative output mismatch." }
    }
    if ($receipt.status -ne 'AWAITING_CONTROLLER') {
        if (-not ($blockedAdmit -and $receipt.schemaVersion -ceq 'OperationalRunReceipt/v2' -and $receipt.status -ceq 'BLOCKED')) { throw "Receipt status must be AWAITING_CONTROLLER." }
    }

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $receiptSha = (Get-FileHash -LiteralPath $receiptFull -Algorithm SHA256).Hash.ToLowerInvariant()

    if ($optIn) {
        $planJson = $capture.json
        $plan = $capture.plan
        $planSha = $capture.planSha256
    } else {
    $planJson = Get-Content -LiteralPath $planFull -Raw
    $plan = $planJson | ConvertFrom-Json -DateKind String
    $planSha = (Get-FileHash -LiteralPath $planFull -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    if ($plan.receiptSha256 -cne $receiptSha) { throw "Plan does not reference this receipt." }
    if ([string]::IsNullOrWhiteSpace($plan.actionId)) { throw "actionId required." }
    $validKinds = @('DIAGNOSE_REPLAN', 'VALIDATE', 'REVIEW', 'NORMAL_REVIEW_DISPATCH', 'NORMAL_AUTHOR_DISPATCH')
    if ($validKinds -notcontains $plan.kind) { throw "Invalid plan kind." }
    if (-not ($plan.failures -is [int] -or $plan.failures -is [long]) -or $plan.failures -lt 0) { throw "failures must be nonnegative int." }
    if ($null -ne $plan.diagnosisSha256 -and $plan.diagnosisSha256 -notmatch '^[0-9a-f]{64}$') { throw "diagnosisSha256 must be null or 64hex." }
    foreach ($b in @('budgetKnown', 'ownershipKnown', 'quotaAllowed', 'reviewDenied')) {
        if (-not ($plan.$b -is [bool])) { throw "$b must be boolean." }
    }
if ($observeMode) {
        if ($null -ne $plan.maxAdditionalOutput -or $null -ne $plan.aggregateCeiling) { throw "OBSERVE_ONLY plan must carry null output ceilings." }
        if ($plan.outputStopMode -isnot [string] -or $plan.outputStopMode -cne 'OBSERVE_ONLY') { throw "OBSERVE_ONLY plan marker mismatch." }
    }
    if (-not $observeMode -and (-not ($plan.maxAdditionalOutput -is [int] -or $plan.maxAdditionalOutput -is [long]) -or $plan.maxAdditionalOutput -le 0)) { throw "maxAdditionalOutput must be positive int." }
    if (-not ($plan.cumulativeOutput -is [int] -or $plan.cumulativeOutput -is [long]) -or $plan.cumulativeOutput -lt 0) { throw "cumulativeOutput must be nonnegative int." }
    if (-not $observeMode -and (-not ($plan.aggregateCeiling -is [int] -or $plan.aggregateCeiling -is [long]) -or $plan.aggregateCeiling -le 0)) { throw "aggregateCeiling must be positive int." }
    if ($plan.cumulativeOutput -ne $receipt.budget.usedOutputTokens) { throw "cumulativeOutput mismatch vs receipt.budget.usedOutputTokens." }

if ($plan.ownedPaths -isnot [array] -or $plan.ownedPaths.Count -eq 0) { throw "ownedPaths must be a nonempty array." }
    $ownedPaths = $plan.ownedPaths
    $canonicalOwned = @()
    foreach ($p in $ownedPaths) {
        if ($p -isnot [string] -or [string]::IsNullOrWhiteSpace($p) -or -not [System.IO.Path]::IsPathRooted($p)) { throw "ownedPaths must be absolute nonblank strings." }
        $full = [System.IO.Path]::GetFullPath($p).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        if ($full.Length -eq 0) { $full = [System.IO.Path]::GetFullPath($p) }
        $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "ownedPaths must not be reparse points." }
        $dir = Split-Path -Path $full -Parent
        while ($dir) {
            $ancestor = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
            if ($ancestor -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "ownedPaths ancestor must not be reparse point." }
            $parent = Split-Path -Path $dir -Parent
            if ($parent -eq $dir -or [string]::IsNullOrEmpty($parent)) { break }
            $dir = $parent
        }
        $canonicalOwned += $full
    }
    if ($plan.failures -ge 2 -and $null -eq $plan.diagnosisSha256 -and $plan.kind -ne 'DIAGNOSE_REPLAN') {
        $plan.kind = 'DIAGNOSE_REPLAN'
    }

$knownOk = $plan.budgetKnown -and $plan.ownershipKnown
    if ($plan.kind -eq 'NORMAL_REVIEW_DISPATCH' -or $plan.kind -eq 'NORMAL_AUTHOR_DISPATCH') {
        $dispatchBudgetOk = $observeMode -or (($plan.cumulativeOutput -le $plan.aggregateCeiling) -and ($plan.maxAdditionalOutput -le ($plan.aggregateCeiling - $plan.cumulativeOutput)))
        $blocked = (-not $knownOk) -or $plan.reviewDenied -or (-not $plan.quotaAllowed) -or (-not $dispatchBudgetOk)
        $status = if ($blocked) { 'BLOCKED' } else { 'READY' }
    } else {
        $blocked = -not $knownOk
        $status = if ($blocked) { 'BLOCKED' } else { 'READY' }
    }

    & $assertCapture
    $statePath = Join-Path $stateDirFull 'continuation-state.json'
    $lockPath = Join-Path $stateDirFull 'continuation-state.lock'
    $fs = $null
    $deadline = (Get-Date).AddSeconds(2)
    while ($null -eq $fs) {
        try {
            $fs = [System.IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch {
            if ((Get-Date) -ge $deadline) { throw "Could not acquire state lock within 2s." }
            Start-Sleep -Milliseconds 25
        }
    }
    try {
        if ($blockedAdmit) {
            $lockedBlockedMatch = & $getBlockedMatch
            if ($null -eq $lockedBlockedMatch -or $lockedBlockedMatch.fingerprintSha256 -isnot [string] -or $lockedBlockedMatch.fingerprintSha256 -cne $initialBlockedMatch.fingerprintSha256 -or $lockedBlockedMatch.fingerprintSha256 -cne $plannedMarker) { throw $predFail }
        }
$state = $null
        if (Test-Path -LiteralPath $statePath) {
            $raw = Get-Content -LiteralPath $statePath -Raw
            if ([string]::IsNullOrWhiteSpace($raw)) { throw "Corrupt state file (empty); refusing to proceed." }
            try { $state = $raw | ConvertFrom-Json -DateKind String } catch { throw "Corrupt state file; refusing to proceed." }
            if ($null -eq $state -or $state -isnot [PSCustomObject]) { throw "Corrupt state file (not an object); refusing to proceed." }
            if ($state.schema -ne 'continuation-state/v1') { throw "Corrupt state file (unexpected schema); refusing to proceed." }
            if ($null -eq $state.entries -or $state.entries -isnot [PSCustomObject]) { throw "Corrupt state file (entries not an object); refusing to proceed." }
foreach ($p in $state.entries.PSObject.Properties) {
                Test-ContinuationStateEntry -Key $p.Name -Entry $p.Value
            }
        } else {
            $state = [PSCustomObject]@{ schema = 'continuation-state/v1'; entries = [PSCustomObject]@{}; overallComplete = $false }
        }
        $entriesHash = [System.Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
        foreach ($p in $state.entries.PSObject.Properties) { $entriesHash[$p.Name] = $p.Value }

        $key = "$receiptSha|$($receipt.runId)|$($receipt.attempt)|$($plan.actionId)"
        $existing = if ($entriesHash.Contains($key)) { $entriesHash[$key] } else { $null }

        if ($existing) {
            if ($existing.planSha256 -cne $planSha) { throw "Receipt already consumed with a different plan (amendment requires distinct actionId and resolved prior claim)." }
            # Recheck mode/plan/receipt/binding parity before reuse or claim: a persisted marker neither grants nor reinterprets anything.
            $existingMode = @($existing.PSObject.Properties | Where-Object { [string]::Equals($_.Name, 'outputStopMode', [System.StringComparison]::OrdinalIgnoreCase) })
            if ($observeMode) {
                if ($existingMode.Count -ne 1 -or $existingMode[0].Name -cne 'outputStopMode' -or $existingMode[0].Value -cne 'OBSERVE_ONLY') { throw "Persisted entry mode does not match the OBSERVE_ONLY plan." }
                if ($null -ne $existing.aggregateCeiling -or $null -ne $existing.maxAdditionalOutput) { throw "Persisted OBSERVE_ONLY entry carries output ceilings." }
                if ($existing.receiptSha256 -cne $receiptSha -or $existing.actionId -cne $plan.actionId -or [long]$existing.cumulativeOutput -ne [long]$capture.binding.cumulativeOutput -or [long]$existing.cumulativeOutput -ne [long]$plan.cumulativeOutput) { throw "Persisted OBSERVE_ONLY entry does not match receipt/plan/binding." }
                $persistedOwned = @($existing.ownedPaths)
                if ($persistedOwned.Count -ne $canonicalOwned.Count) { throw "Persisted OBSERVE_ONLY entry ownedPaths mismatch." }
                for ($oi = 0; $oi -lt $canonicalOwned.Count; $oi++) { if ($persistedOwned[$oi] -cne $canonicalOwned[$oi]) { throw "Persisted OBSERVE_ONLY entry ownedPaths mismatch." } }
            } elseif ($existingMode.Count -ne 0) {
                throw "Persisted OBSERVE_ONLY entry cannot be reinterpreted by a legacy plan."
            }
            $entry = $existing
        } else {
            $alreadyKeyed = $entriesHash.Keys | Where-Object { $entriesHash[$_].receiptSha256 -ceq $receiptSha -and $entriesHash[$_].actionId -cne $plan.actionId }
            if ($alreadyKeyed) { throw "Receipt already consumed under a different actionId (replay rejected)." }
            $entry = [PSCustomObject]@{
                receiptSha256   = $receiptSha
                receiptPath     = $receiptFull
                planPath        = $planFull
                cumulativeOutput = $plan.cumulativeOutput
                aggregateCeiling = $plan.aggregateCeiling
                maxAdditionalOutput = $plan.maxAdditionalOutput
                runId           = $receipt.runId
                attempt         = $receipt.attempt
                actionId        = $plan.actionId
                planSha256      = $planSha
                kind            = $plan.kind
                ownedPaths      = $canonicalOwned
                status          = $status
                claim           = $null
                nextWake        = [PSCustomObject]@{ reason = $status; status = $status }
            }
            if ($observeMode) { $entry | Add-Member -NotePropertyName 'outputStopMode' -NotePropertyValue 'OBSERVE_ONLY' }
            $entriesHash[$key] = $entry
        }

        $resultStatus = $entry.status
        $claimResult = $null
        if ($Claim) {
            if ($entry.claim) {
                $claimResult = 'EXISTING_CLAIM'
                if ($entry.claim.owner -cne $Owner -and $entry.status -eq 'CLAIMED') { $claimResult = 'RECONCILE_CLAIM' }
            } elseif ($entry.status -ne 'READY') {
                $claimResult = 'EXISTING_CLAIM'
            } else {
                $otherOwned = $entriesHash.Keys | Where-Object { $entriesHash[$_].status -eq 'CLAIMED' } | ForEach-Object { $entriesHash[$_].ownedPaths }
                $overlap = $false
                foreach ($mine in $canonicalOwned) {
                    foreach ($other in @($otherOwned)) {
                        if ($mine -ieq $other -or $mine.StartsWith($other + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $other.StartsWith($mine + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                            $overlap = $true
                        }
                    }
                }
                if ($overlap) {
                    $claimResult = 'EXISTING_CLAIM'
                } else {
                    $entry.claim = [PSCustomObject]@{ owner = $Owner; claimId = [Guid]::NewGuid().ToString(); claimedAt = (Get-Date).ToUniversalTime().ToString('o') }
                    $entry.status = 'CLAIMED'
                    $claimResult = 'NEW_CLAIM'
                }
            }
            $resultStatus = $entry.status
        }

        $state.entries = $entriesHash
        $state.overallComplete = $false
        $tmpPath = Join-Path $stateDirFull ("continuation-state." + [Guid]::NewGuid().ToString('N') + '.tmp')
        ($state | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $tmpPath -NoNewline
        Move-Item -LiteralPath $tmpPath -Destination $statePath -Force

        [PSCustomObject]@{
            status      = $resultStatus
            intentId    = $key
            kind        = $entry.kind
            claimId     = if ($entry.claim) { $entry.claim.claimId } else { $null }
            claimResult = $claimResult
            receiptSha  = $receiptSha
            planSha     = $planSha
            statePath   = $statePath
        }
    } finally {
        $fs.Close()
    }
}

. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-settlement-inputs.ps1')

function Complete-ContinuationClaim {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][PSCustomObject]$SelectedClaim,
        [Parameter(Mandatory)][string]$TerminalReceiptPath,
        [Parameter(Mandatory)][string]$TerminalSha256,
        [AllowNull()][object]$ExpectedBlockedReview
    )

    # Opt-in v2 BLOCKED path: capture once, before any StateDir IO; only returned values are used afterwards.
    $hasBlocked = $PSBoundParameters.ContainsKey('ExpectedBlockedReview')
    $blockedInputs = $null
    if ($hasBlocked) {
        $blockedInputs = Get-VerifiedBlockedSettlementInputs -ExpectedBlockedReview $ExpectedBlockedReview -TerminalReceiptPath ([System.IO.Path]::GetFullPath($TerminalReceiptPath)) -TerminalSha256 $TerminalSha256.ToLowerInvariant()
        if ($null -eq $blockedInputs -or $blockedInputs.schema -cne 'VerifiedBlockedSettlementInputs/v1') { throw "Blocked settlement inputs not verified; refusing to settle." }
    }

    foreach ($f in @('id', 'owner', 'claimId', 'intentId', 'receiptSha', 'planSha', 'statePath')) {
        if (-not ($SelectedClaim.PSObject.Properties.Name -contains $f) -or $SelectedClaim.$f -isnot [string] -or [string]::IsNullOrWhiteSpace($SelectedClaim.$f)) {
            throw "SelectedClaim.$f missing or not a nonblank string."
        }
    }
    if ($SelectedClaim.receiptSha -notmatch '^[0-9a-f]{64}$') { throw "SelectedClaim.receiptSha not 64hex." }
    if ($SelectedClaim.planSha -notmatch '^[0-9a-f]{64}$') { throw "SelectedClaim.planSha not 64hex." }
    if ($TerminalSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "TerminalSha256 must be 64hex." }

    $stateDirFull = [System.IO.Path]::GetFullPath($StateDir)
    $canonicalStatePath = Join-Path $stateDirFull 'continuation-state.json'
    if ([System.IO.Path]::GetFullPath($SelectedClaim.statePath) -cne $canonicalStatePath) {
        throw "SelectedClaim.statePath does not match canonical StateDir continuation-state.json; refusing to settle."
    }

    if ($hasBlocked) {
        $terminalFull = $blockedInputs.receiptPath
        $terminal = $blockedInputs.terminal
        if ($terminal.schemaVersion -cne 'OperationalRunReceipt/v2') { throw "Terminal receipt is not OperationalRunReceipt/v2; refusing to settle." }
        if ($terminal.status -cne 'BLOCKED') { throw "Verified blocked terminal status must be BLOCKED; refusing to settle." }
        if ([string]::IsNullOrWhiteSpace("$($terminal.provider.terminalReason)")) { throw "Terminal receipt missing terminalReason; refusing to settle." }
        if ([string]::IsNullOrWhiteSpace("$($terminal.provider.startIdentity)") -or $null -eq $terminal.provider.pid) { throw "Blocked terminal requires native (pid/startIdentity) identity; refusing to settle." }
    } else {
    $terminalFull = [System.IO.Path]::GetFullPath($TerminalReceiptPath)
    if (-not (Test-Path -LiteralPath $terminalFull -PathType Leaf)) { throw "Terminal receipt not found: $terminalFull" }
    $actualHash = (Get-FileHash -LiteralPath $terminalFull -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $TerminalSha256.ToLowerInvariant()) { throw "TerminalSha256 does not match actual file hash; refusing to settle." }

    $terminalRaw = Get-Content -LiteralPath $terminalFull -Raw
    if ([string]::IsNullOrWhiteSpace($terminalRaw)) { throw "Terminal receipt is empty; refusing to settle." }
    try { $terminal = $terminalRaw | ConvertFrom-Json -DateKind String } catch { throw "Terminal receipt is not valid JSON; refusing to settle." }
    if (-not (Test-OperationalReceipt $terminal)) { throw "Terminal receipt failed C3 validator; refusing to settle." }
    if (@('COMPLETED', 'FAILED') -notcontains $terminal.status) { throw "Terminal receipt status must be a definite terminal (COMPLETED or FAILED); AWAITING_CONTROLLER/deadline are not terminal." }
    if ([string]::IsNullOrWhiteSpace("$($terminal.provider.terminalReason)")) { throw "Terminal receipt missing terminalReason; refusing to settle." }
    }

    $identityKind = $null
    if (-not [string]::IsNullOrWhiteSpace("$($terminal.provider.startIdentity)") -and $null -ne $terminal.provider.pid) {
        $identityKind = 'native'
    } elseif (-not [string]::IsNullOrWhiteSpace("$($terminal.sessionId)")) {
        $identityKind = 'session'
    } else {
        throw "Terminal receipt lacks a tagged native(pid/startIdentity) or session(sessionId) execution identity; refusing to settle."
    }

    $ticketSha = "$($terminal.evidence.ticketSha256)"
    if ($ticketSha -notmatch '^[0-9a-fA-F]{64}$') { throw "Terminal receipt evidence.ticketSha256 missing or not 64hex; refusing to settle." }

    $ackPath = Join-Path $stateDirFull 'host-dispatch-acknowledgements.json'
    if (-not (Test-Path -LiteralPath $ackPath -PathType Leaf)) { throw "No dispatch acknowledgement recorded; refusing to settle." }
    $ackRaw = Get-Content -LiteralPath $ackPath -Raw
    if ([string]::IsNullOrWhiteSpace($ackRaw)) { throw "Dispatch acknowledgement file is empty; refusing to settle." }
    try { $ackState = $ackRaw | ConvertFrom-Json -DateKind String } catch { throw "Dispatch acknowledgement file is not valid JSON; refusing to settle." }
    try {
        $ackHash = Test-HostDispatchAcknowledgementEnvelope -AckState $ackState
    } catch {
        throw "Dispatch acknowledgement file malformed; refusing to settle. $($_.Exception.Message)"
    }
    $ackKey = "$($SelectedClaim.intentId)|$($SelectedClaim.claimId)"
    $ackEntry = if ($ackHash.Contains($ackKey)) { $ackHash[$ackKey] } else { $null }
    if ($null -eq $ackEntry) { throw "No acknowledgement found for this intent/claim; refusing to settle." }
    if ($ackEntry.owner -cne $SelectedClaim.owner -or $ackEntry.claimId -cne $SelectedClaim.claimId -or $ackEntry.intentId -cne $SelectedClaim.intentId) {
        throw "Acknowledgement does not match SelectedClaim owner/claim/intent; refusing to settle."
    }
    if (-not ($ackEntry.PSObject.Properties.Name -contains 'executionBinding') -or $null -eq $ackEntry.executionBinding) {
        throw "Acknowledgement has no executionBinding (legacy ACK); cannot settle."
    }
    $binding = $ackEntry.executionBinding
    try {
        Test-ExecutionBinding -Binding $binding
    } catch {
        throw "Acknowledgement executionBinding failed strict validation; refusing to settle. $($_.Exception.Message)"
    }
    if ($binding.receiptSha -cne $SelectedClaim.receiptSha -or $binding.planSha -cne $SelectedClaim.planSha) { throw "Acknowledgement executionBinding does not match SelectedClaim receipt/plan; refusing to settle." }

    # Window 1 (v2 only): capture verified scalars and the full keyed ACK entry before taking the lock.
    $capExpectedReview = $null; $capExpectedEvidence = $null; $capTerminalSha = $null; $capReceiptPath = $null; $capAckJson = $null
    if ($hasBlocked) {
        $capExpectedReview = [string]$blockedInputs.expected.reviewSha256
        $capExpectedEvidence = [string]$blockedInputs.expected.evidenceSha256
        $capTerminalSha = [string]$blockedInputs.terminalSha256
        $capReceiptPath = [string]$blockedInputs.receiptPath
        $capAckJson = $ackEntry | ConvertTo-Json -Depth 20 -Compress
    }

    if ($binding.taskId -cne "$($terminal.taskId)") { throw "Terminal receipt taskId does not match bound execution identity; refusing to settle." }
    if ($binding.runId -cne "$($terminal.runId)") { throw "Terminal receipt runId does not match bound execution identity; refusing to settle." }
    if ([int64]$binding.attempt -ne [int64]$terminal.attempt) { throw "Terminal receipt attempt does not match bound execution identity; refusing to settle." }
    if ($binding.payloadSha256 -cne "$($terminal.payloadSha256)") { throw "Terminal receipt payloadSha256 does not match bound execution identity; refusing to settle." }
    if ($binding.ticketSha256 -cne $ticketSha) { throw "Terminal receipt evidence.ticketSha256 does not match bound executionTicketSha256; refusing to settle." }
    if ($binding.identity.kind -cne $identityKind) { throw "Terminal receipt execution identity kind does not match bound identity kind; refusing to settle." }
    if ($identityKind -eq 'native') {
        if ([int64]$binding.identity.pid -ne [int64]$terminal.provider.pid -or $binding.identity.startIdentity -cne "$($terminal.provider.startIdentity)") {
            throw "Terminal receipt native identity (pid/startIdentity) does not match bound identity; refusing to settle."
        }
    } else {
        if ($binding.identity.sessionId -cne "$($terminal.sessionId)") {
            throw "Terminal receipt sessionId does not match bound identity; refusing to settle."
        }
    }

    $terminalFingerprint = [PSCustomObject]@{
        terminalReceiptPath = $terminalFull
        terminalSha256      = $TerminalSha256.ToLowerInvariant()
        taskId              = "$($terminal.taskId)"
        runId               = "$($terminal.runId)"
        attempt             = [int64]$terminal.attempt
        payloadSha256       = "$($terminal.payloadSha256)"
        ticketSha256        = $ticketSha
        status              = "$($terminal.status)"
        terminalReason      = "$($terminal.provider.terminalReason)"
    }
    if ($hasBlocked) {
        $terminalFingerprint.terminalSha256 = $blockedInputs.terminalSha256
        $terminalFingerprint | Add-Member -NotePropertyName 'receiptSchemaVersion' -NotePropertyValue 'OperationalRunReceipt/v2'
        $terminalFingerprint | Add-Member -NotePropertyName 'reviewedDispositionReviewSha256' -NotePropertyValue "$($blockedInputs.expected.reviewSha256)"
        $terminalFingerprint | Add-Member -NotePropertyName 'reviewedDispositionEvidenceSha256' -NotePropertyValue "$($blockedInputs.expected.evidenceSha256)"
    }

    $lockPath = Join-Path $stateDirFull 'continuation-state.lock'
    $fs = $null
    $deadline = (Get-Date).AddSeconds(2)
    while ($null -eq $fs) {
        try {
            $fs = [System.IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch {
            if ((Get-Date) -ge $deadline) { throw "Could not acquire state lock within 2s." }
            Start-Sleep -Milliseconds 25
        }
    }
    try {
        # Window 2 (v2 only): revalidate under the lock, before any state read, replay return or write.
        if ($hasBlocked) {
            $lockedExpected = [PSCustomObject]@{ reviewSha256 = $capExpectedReview; evidenceSha256 = $capExpectedEvidence }
            $again = Get-VerifiedBlockedSettlementInputs -ExpectedBlockedReview $lockedExpected -TerminalReceiptPath $capReceiptPath -TerminalSha256 $capTerminalSha
            $t0 = $blockedInputs.terminal
            $t1 = if ($null -ne $again) { $again.terminal } else { $null }
            if ($null -eq $again -or $again.schema -cne 'VerifiedBlockedSettlementInputs/v1' -or $null -eq $t1 -or
                $again.terminalSha256 -cne $capTerminalSha -or $again.receiptPath -cne $capReceiptPath -or
                $again.expected.reviewSha256 -cne $capExpectedReview -or $again.expected.evidenceSha256 -cne $capExpectedEvidence -or
                $t1.schemaVersion -cne $t0.schemaVersion -or $t1.status -cne 'BLOCKED' -or $t1.status -cne $t0.status -or
                "$($t1.taskId)" -cne "$($t0.taskId)" -or "$($t1.runId)" -cne "$($t0.runId)" -or [int64]$t1.attempt -ne [int64]$t0.attempt -or
                "$($t1.payloadSha256)" -cne "$($t0.payloadSha256)" -or "$($t1.evidence.ticketSha256)" -cne $ticketSha -or
                [int64]$t1.provider.pid -ne [int64]$t0.provider.pid -or "$($t1.provider.startIdentity)" -cne "$($t0.provider.startIdentity)" -or
                "$($t1.provider.terminalReason)" -cne "$($t0.provider.terminalReason)") {
                throw "Blocked settlement inputs changed before locked closure; refusing to settle."
            }
            if (-not (Test-Path -LiteralPath $ackPath -PathType Leaf)) { throw "Dispatch acknowledgement disappeared before locked closure; refusing to settle." }
            $ackRaw2 = Get-Content -LiteralPath $ackPath -Raw
            if ([string]::IsNullOrWhiteSpace($ackRaw2)) { throw "Dispatch acknowledgement file is empty at locked closure; refusing to settle." }
            try { $ackState2 = $ackRaw2 | ConvertFrom-Json -DateKind String } catch { throw "Dispatch acknowledgement file is not valid JSON at locked closure; refusing to settle." }
            try { $ackHash2 = Test-HostDispatchAcknowledgementEnvelope -AckState $ackState2 } catch { throw "Dispatch acknowledgement file malformed at locked closure; refusing to settle. $($_.Exception.Message)" }
            if (-not $ackHash2.Contains($ackKey)) { throw "Acknowledgement entry missing at locked closure; refusing to settle." }
            $ackEntry2 = $ackHash2[$ackKey]
            if ($null -eq $ackEntry2 -or -not ($ackEntry2.PSObject.Properties.Name -contains 'executionBinding') -or $null -eq $ackEntry2.executionBinding) { throw "Acknowledgement binding missing at locked closure; refusing to settle." }
            try { Test-ExecutionBinding -Binding $ackEntry2.executionBinding } catch { throw "Acknowledgement executionBinding failed strict validation at locked closure; refusing to settle. $($_.Exception.Message)" }
            if (($ackEntry2 | ConvertTo-Json -Depth 20 -Compress) -cne $capAckJson) { throw "Acknowledgement changed before locked closure; refusing to settle." }
        }

        if (-not (Test-Path -LiteralPath $canonicalStatePath -PathType Leaf)) { throw "Continuation state file not found; refusing to settle." }
        $raw = Get-Content -LiteralPath $canonicalStatePath -Raw
        if ([string]::IsNullOrWhiteSpace($raw)) { throw "Corrupt state file (empty); refusing to proceed." }
        try { $state = $raw | ConvertFrom-Json -DateKind String } catch { throw "Corrupt state file; refusing to proceed." }
        if ($null -eq $state -or $state -isnot [PSCustomObject] -or $state.schema -ne 'continuation-state/v1' -or $null -eq $state.entries -or $state.entries -isnot [PSCustomObject]) {
            throw "Corrupt state file; refusing to proceed."
        }

        $entriesHash = [System.Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
        foreach ($p in $state.entries.PSObject.Properties) {
            Test-ContinuationStateEntry -Key $p.Name -Entry $p.Value
            $entriesHash[$p.Name] = $p.Value
        }

        if (-not $entriesHash.Contains($SelectedClaim.intentId)) { throw "No continuation-state entry for this intentId; refusing to settle." }
        $entry = $entriesHash[$SelectedClaim.intentId]

        if ($entry.status -eq 'SETTLED') {
            if ($null -eq $entry.settlement) { throw "Corrupt SETTLED entry (no settlement); refusing to proceed." }
            $sameFingerprint = ($entry.settlement.terminalSha256 -ceq $terminalFingerprint.terminalSha256) -and
                ($entry.settlement.taskId -ceq $terminalFingerprint.taskId) -and
                ($entry.settlement.runId -ceq $terminalFingerprint.runId) -and
                ([int64]$entry.settlement.attempt -eq $terminalFingerprint.attempt) -and
                ($entry.settlement.payloadSha256 -ceq $terminalFingerprint.payloadSha256) -and
                ($entry.settlement.ticketSha256 -ceq $terminalFingerprint.ticketSha256) -and
                ($entry.claim.claimId -ceq $SelectedClaim.claimId) -and
                ($entry.claim.owner -ceq $SelectedClaim.owner)
            if ($sameFingerprint -and $hasBlocked) {
                $sNames = @($entry.settlement.PSObject.Properties.Name)
                $sameFingerprint = ($sNames -ccontains 'receiptSchemaVersion') -and ($sNames -ccontains 'reviewedDispositionReviewSha256') -and ($sNames -ccontains 'reviewedDispositionEvidenceSha256') -and
                    ($entry.settlement.receiptSchemaVersion -ceq $terminalFingerprint.receiptSchemaVersion) -and
                    ($entry.settlement.status -ceq $terminalFingerprint.status) -and
                    ($entry.settlement.reviewedDispositionReviewSha256 -ceq $terminalFingerprint.reviewedDispositionReviewSha256) -and
                    ($entry.settlement.reviewedDispositionEvidenceSha256 -ceq $terminalFingerprint.reviewedDispositionEvidenceSha256)
            }
            if ($sameFingerprint) {
                return [PSCustomObject]@{ status = 'SETTLED'; intentId = $SelectedClaim.intentId; replay = $true; statePath = $canonicalStatePath }
            } else {
                throw "Entry already SETTLED with a conflicting terminal fingerprint; refusing to settle."
            }
        }

        if ($entry.status -ne 'CLAIMED' -or $null -eq $entry.claim) { throw "Entry is not actively CLAIMED; refusing to settle." }
        if ($entry.claim.claimId -cne $SelectedClaim.claimId -or $entry.claim.owner -cne $SelectedClaim.owner) { throw "Entry claim does not match SelectedClaim owner/claimId; refusing to settle." }
        if ($entry.receiptSha256 -cne $SelectedClaim.receiptSha -or $entry.planSha256 -cne $SelectedClaim.planSha) { throw "Entry receipt/plan does not match SelectedClaim; refusing to settle." }

        $entry.status = 'SETTLED'
        $entry | Add-Member -NotePropertyName 'settlement' -NotePropertyValue ([PSCustomObject]@{
            terminalReceiptPath = $terminalFingerprint.terminalReceiptPath
            terminalSha256      = $terminalFingerprint.terminalSha256
            taskId              = $terminalFingerprint.taskId
            runId               = $terminalFingerprint.runId
            attempt             = $terminalFingerprint.attempt
            payloadSha256       = $terminalFingerprint.payloadSha256
            ticketSha256        = $terminalFingerprint.ticketSha256
            status              = $terminalFingerprint.status
            terminalReason      = $terminalFingerprint.terminalReason
            settledAt           = (Get-Date).ToUniversalTime().ToString('o')
        }) -Force
        if ($hasBlocked) {
            $entry.settlement | Add-Member -NotePropertyName 'receiptSchemaVersion' -NotePropertyValue $terminalFingerprint.receiptSchemaVersion -Force
            $entry.settlement | Add-Member -NotePropertyName 'reviewedDispositionReviewSha256' -NotePropertyValue $terminalFingerprint.reviewedDispositionReviewSha256 -Force
            $entry.settlement | Add-Member -NotePropertyName 'reviewedDispositionEvidenceSha256' -NotePropertyValue $terminalFingerprint.reviewedDispositionEvidenceSha256 -Force
        }

        $entriesHash[$SelectedClaim.intentId] = $entry
        $state.entries = $entriesHash
        $tmpPath = Join-Path $stateDirFull ('continuation-state.' + [Guid]::NewGuid().ToString('N') + '.tmp')
        ($state | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $tmpPath -NoNewline
        Move-Item -LiteralPath $tmpPath -Destination $canonicalStatePath -Force

        [PSCustomObject]@{ status = 'SETTLED'; intentId = $SelectedClaim.intentId; replay = $false; statePath = $canonicalStatePath }
    } finally {
        $fs.Close()
    }
}