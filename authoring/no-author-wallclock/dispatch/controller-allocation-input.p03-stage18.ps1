. (Join-Path $PSScriptRoot 'controller-allocation-binding.ps1')

function Get-ControllerAllocationInputBinding {
    # ControllerActualInputContract/v1: read-only actual-bytes check of captured hashes and ticket budget.
    # Not authority, READY, receipt or live-cost guarantee; no writes, state or provider access.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Snapshot,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $ExpectedOrigin,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $ReceiptPath,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $NextTicketPath,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $NextPayloadPath
    )

    $fail = { throw 'CONTROLLER_ALLOCATION_INVALID' }
    $maxBytes = 1048576
    $isInteger = { param($v) ($v -is [int] -or $v -is [long]) }

    try {
        $binding = Get-ControllerAllocationBinding -Snapshot $Snapshot -ExpectedOrigin $ExpectedOrigin

        $files = @(
            @{ Path = $ReceiptPath; Hash = $binding.predecessorReceiptSha256 },
            @{ Path = $NextTicketPath; Hash = $binding.nextTicketSha256 },
            @{ Path = $NextPayloadPath; Hash = $binding.nextPayloadSha256 }
        )
        $bytesList = @()
        foreach ($f in $files) {
            if ($f.Path -isnot [string] -or [string]::IsNullOrWhiteSpace($f.Path)) { & $fail }
            $stream = [System.IO.File]::Open($f.Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            try {
                if ($stream.Length -gt $maxBytes) { & $fail }
                $bytes = New-Object 'byte[]' ([int]$stream.Length)
                $offset = 0
                while ($offset -lt $bytes.Length) {
                    $n = $stream.Read($bytes, $offset, $bytes.Length - $offset)
                    if ($n -le 0) { & $fail }
                    $offset += $n
                }
            }
            finally { $stream.Dispose() }
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $hex = ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
            if (-not [string]::Equals($hex, $f.Hash, [System.StringComparison]::Ordinal)) { & $fail }
            $bytesList += , $bytes
        }

        $strict = New-Object System.Text.UTF8Encoding($false, $true)
        $docs = @()
        foreach ($i in 0, 1) {
            $b = $bytesList[$i]
            $start = 0
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $start = 3 }
            $text = $strict.GetString($b, $start, $b.Length - $start)
            $doc = $text | ConvertFrom-Json -DateKind String
            if ($doc -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
            $docs += $doc
        }
        $receipt = $docs[0]
        $ticket = $docs[1]

        # An exact null cumulative output exists only in the explicit UNKNOWN-history shape (proven by the binding); it is never cast to 0.
        $cumulative = $(if ($null -eq $binding.cumulativeOutput) { $null } else { [long]$binding.cumulativeOutput })
        if ($null -ne $binding.allocation.PSObject.Properties['outputStopMode']) {
            # OBSERVE_ONLY: the caller's marker and null fields decide nothing. The actual pending v3 receipt, the shared pending-accounting
            # verifier, the actual next ticket contract and the anchored policy decide the mode. Trusted staged siblings only; read-only.
            $dispatchDir = $PSScriptRoot
            $factoryDir = Split-Path -Parent $dispatchDir
            . (Join-Path (Join-Path $factoryDir 'continuity') 'reconcile.ps1')
            . (Join-Path (Join-Path $factoryDir 'runner') 'launch.ps1')
            . (Join-Path $dispatchDir 'native-ticket-contract.ps1')
            . (Join-Path $dispatchDir 'managed-output-stop-authority.ps1')
            . (Join-Path $dispatchDir 'managed-native-receipt.ps1')
            $ord = [System.StringComparison]::Ordinal
            $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
            $cget = {
                param($o, [string]$n)
                if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
                $m = @($o.PSObject.Properties | Where-Object { [string]::Equals($_.Name, $n, $ord) })
                if ($m.Count -ne 1 -or $m[0].MemberType -ne $note) { & $fail }
                return , $m[0].Value
            }

            if ($null -ne $binding.allocation.PSObject.Properties['accountingStatus']) {
                # UNKNOWN-history: the caller's tags decide nothing. The ACTUAL receipt (the failed v5 root or a v6 pending receipt), the actual next ticket, the fixed human
                # direction and the authenticated parent chain are rederived from pinned bytes here, then compared to the captured tags, subtotal and nulls. Read-only.
                if ($null -ne $cumulative) { & $fail }
                $unkAlloc = $binding.allocation
                $unkSchema = & $cget $receipt 'schemaVersion'
                $unkIsV5 = ($unkSchema -is [string]) -and ($unkSchema -ceq 'OperationalRunReceipt/v5')
                $unkIsV6 = ($unkSchema -is [string]) -and ($unkSchema -ceq 'OperationalRunReceipt/v6')
                $unkIsV7 = ($unkSchema -is [string]) -and ($unkSchema -ceq 'OperationalRunReceipt/v7')
                if (-not ($unkIsV5 -or $unkIsV6 -or $unkIsV7)) { & $fail }
                if (-not (Test-OperationalReceipt $receipt)) { & $fail }
                if ((& $cget $receipt 'outputStopMode') -cne 'OBSERVE_ONLY') { & $fail }
                $historyVerified = & $cget $receipt 'historyVerified'
                if ($historyVerified -isnot [bool] -or $historyVerified) { & $fail }
                $artifactComplete = & $cget (& $cget $receipt 'artifact') 'complete'
                if ($artifactComplete -isnot [bool] -or $artifactComplete) { & $fail }
                if ($null -ne (& $cget (& $cget $receipt 'budget') 'usedOutputTokens')) { & $fail }
                if ($unkIsV5) {
                    if ((& $cget $receipt 'status') -cne 'FAILED') { & $fail }
                    $unkRes = Get-ManagedObserveFailedTransportFacts -Evidence (& $cget $receipt 'observeFailedTransportEvidence')
                    if ($null -eq $unkRes -or $unkRes.Valid -isnot [bool] -or -not $unkRes.Valid -or $null -eq $unkRes.Facts) { & $fail }
                    $unkFacts = $unkRes.Facts
                    $unkSubtotal = $unkFacts.accounting.lastVerifiedParentOutputTokens
                    $unkFailurePath = [System.IO.Path]::GetFullPath([string]$ReceiptPath)
                    $unkFailureSha = [string]$binding.predecessorReceiptSha256
                    $unkCur = $unkFacts.evidence.current
                    $unkRecapture = Get-ManagedNativeCapturedFacts -ManifestPath $unkCur.manifestPath -ExpectedManifestSha256 $unkCur.manifestSha256 -TerminalPath $unkCur.terminalPath -ExpectedTerminalSha256 $unkCur.terminalSha256 -TicketPath $unkCur.ticketPath -RunId $unkCur.runId -Attempt ([int][long]$unkCur.attempt) -ForFailedTransportObservation
                    $unkWantCode = 'OBSERVE_ONLY_FAILED_TRANSPORT_CAPTURE'
                } elseif ($unkIsV7) {
                    # An authenticated v7 FAILED receipt is a valid immediate parent as admitted; it stays failed evidence and keeps the original unresolved failed root.
                    if ((& $cget $receipt 'status') -cne 'FAILED') { & $fail }
                    $unkRes = Get-ManagedObserveUnknownFailedFacts -Evidence (& $cget $receipt 'observeUnknownFailedEvidence')
                    if ($null -eq $unkRes -or $unkRes.Valid -isnot [bool] -or -not $unkRes.Valid -or $null -eq $unkRes.Facts) { & $fail }
                    $unkFacts = $unkRes.Facts
                    $unkSubtotal = $unkFacts.accounting.lastVerifiedSubtotal
                    $unkFailurePath = [string]$unkFacts.accounting.unresolvedFailure.receipt.path
                    $unkFailureSha = [string]$unkFacts.accounting.unresolvedFailure.receipt.sha256
                    $unkCur = $unkFacts.evidence.current
                    $unkRecapture = Get-ManagedNativeCapturedFacts -ManifestPath $unkCur.manifestPath -ExpectedManifestSha256 $unkCur.manifestSha256 -TerminalPath $unkCur.terminalPath -ExpectedTerminalSha256 $unkCur.terminalSha256 -TicketPath $unkCur.ticketPath -RunId $unkCur.runId -Attempt ([int][long]$unkCur.attempt) -ForUnknownFailedObservation
                    $unkWantCode = 'OBSERVE_ONLY_UNKNOWN_FAILED_CAPTURE'
                } else {
                    if ((& $cget $receipt 'status') -cne 'AWAITING_CONTROLLER') { & $fail }
                    $unkRes = Get-ManagedObserveUnknownContinuationFacts -Evidence (& $cget $receipt 'observeUnknownContinuationEvidence')
                    if ($null -eq $unkRes -or $unkRes.Valid -isnot [bool] -or -not $unkRes.Valid -or $null -eq $unkRes.Facts) { & $fail }
                    $unkFacts = $unkRes.Facts
                    $unkSubtotal = $unkFacts.accounting.lastVerifiedSubtotal
                    $unkFailurePath = [string]$unkFacts.accounting.unresolvedFailure.receipt.path
                    $unkFailureSha = [string]$unkFacts.accounting.unresolvedFailure.receipt.sha256
                    $unkCur = $unkFacts.evidence.current
                    $unkRecapture = Get-ManagedNativeCapturedFacts -ManifestPath $unkCur.manifestPath -ExpectedManifestSha256 $unkCur.manifestSha256 -TerminalPath $unkCur.terminalPath -ExpectedTerminalSha256 $unkCur.terminalSha256 -TicketPath $unkCur.ticketPath -RunId $unkCur.runId -Attempt ([int][long]$unkCur.attempt) -ForOutputObservation
                    $unkWantCode = 'OBSERVE_ONLY_TRANSPORT_CAPTURE'
                }
                if (-not (& $isInteger $unkSubtotal) -or [long]$unkSubtotal -lt 0 -or [long]$unkSubtotal -ne [long]$unkAlloc.lastVerifiedSubtotal) { & $fail }
                if (-not [string]::Equals($unkFailurePath, [string]$unkAlloc.unresolvedFailureReceipt.path, [System.StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($unkFailureSha, [string]$unkAlloc.unresolvedFailureReceipt.sha256, $ord)) { & $fail }

                # ControlRoot comes only from the authenticated recapture of the receipt's own pinned evidence, never from the caller.
                if (@($unkRecapture).Count -ne 1 -or $unkRecapture -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
                if ((& $cget $unkRecapture 'Valid') -isnot [bool] -or (& $cget $unkRecapture 'Valid') -or $null -ne (& $cget $unkRecapture 'Facts') -or (& $cget $unkRecapture 'Code') -cne $unkWantCode) { & $fail }
                $unkOc = & $cget $unkRecapture 'ObservationCapture'
                if ((& $cget $unkOc 'RunId') -cne [string]$unkFacts.identity.runId) { & $fail }
                $unkWd = & $cget (& $cget $unkOc 'Core') 'workingDirectory'
                if ($unkWd -isnot [string] -or $unkWd.Length -eq 0 -or $unkWd.Length -gt 1024 -or -not [System.IO.Path]::IsPathRooted($unkWd)) { & $fail }
                if (-not [string]::Equals([System.IO.Path]::GetFullPath($unkWd), $unkWd, $ord)) { & $fail }
                $unkLast = $unkWd[$unkWd.Length - 1]
                if ($unkLast -eq [System.IO.Path]::DirectorySeparatorChar -or $unkLast -eq [System.IO.Path]::AltDirectorySeparatorChar) { & $fail }
                $unkControlRoot = [System.IO.Path]::Combine($unkWd, '.factory-data', 'chief', 'controller-runtime', 'control')

                # Next ticket: the captured bytes decide the mode through the native contract; the shared prelaunch verifier rederives the direction, the parent chain, the
                # unresolved failed root and the lineage from pinned bytes and proves the next session is new.
                $unkPre = Test-ManagedObserveUnknownContinuationPrelaunch -Ticket $ticket -PayloadSha256 ([string]$binding.nextPayloadSha256) -ControlRoot $unkControlRoot -ExpectedParentSha256 ([string]$binding.predecessorReceiptSha256) -ExpectedParentPath ([System.IO.Path]::GetFullPath([string]$ReceiptPath))
                if ($null -eq $unkPre -or $unkPre.Valid -isnot [bool] -or -not $unkPre.Valid -or $null -eq $unkPre.Contract -or $null -eq $unkPre.Chain) { & $fail }
                $unkContract = $unkPre.Contract
                $unkAc = $unkContract.AccountingContinuation
                if ([long]$unkAc.LastVerifiedSubtotal -ne [long]$unkAlloc.lastVerifiedSubtotal -or [long]$unkAc.LastVerifiedSubtotal -ne [long]$unkSubtotal) { & $fail }
                if (-not [string]::Equals([string]$unkAc.UnresolvedFailureReceipt.Path, [string]$unkAlloc.unresolvedFailureReceipt.path, [System.StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals([string]$unkAc.UnresolvedFailureReceipt.Sha256, [string]$unkAlloc.unresolvedFailureReceipt.sha256, $ord)) { & $fail }
                if (-not [string]::Equals([string]$unkPre.Chain.Parent.receiptSha256, [string]$binding.predecessorReceiptSha256, $ord)) { & $fail }
                $unkAuthority = Resolve-ManagedOutputStopAuthority -TicketContract $unkContract -CapturedTicket ([byte[]]($bytesList[1].Clone())) -ControlRoot $unkControlRoot
                if ($null -eq $unkAuthority -or $unkAuthority -isnot [System.Management.Automation.PSCustomObject] -or $unkAuthority.Schema -cne 'ManagedOutputStopAuthority/v1' -or $unkAuthority.Mode -cne 'OBSERVE_ONLY') { & $fail }
                $unkElapsed = $unkContract.Budget.ElapsedMs
                $unkAttempts = & $cget $ticket 'maxAttempts'
                if (($null -ne $unkElapsed) -and (-not (& $isInteger $unkElapsed) -or [long]$unkElapsed -le 0)) { & $fail }
                if (-not (& $isInteger $unkAttempts) -or [long]$unkAttempts -le 0) { & $fail }
                $unkScope = Get-ControllerAllocationScope -CumulativeOutput $null -Scope ([pscustomobject][ordered]@{
                        taskId                   = & $cget $ticket 'id'
                        owner                    = & $cget $ticket 'owner'
                        ownedPaths               = & $cget $ticket 'ownedPaths'
                        outputStopMode           = 'OBSERVE_ONLY'
                        accountingStatus         = 'UNKNOWN'
                        lastVerifiedSubtotal     = [long]$unkAc.LastVerifiedSubtotal
                        unresolvedFailureReceipt = [pscustomobject][ordered]@{ path = [string]$unkAc.UnresolvedFailureReceipt.Path; sha256 = [string]$unkAc.UnresolvedFailureReceipt.Sha256 }
                        maxAdditionalOutput      = $null
                        aggregateCeiling         = $null
                        maxAttempts              = $unkAttempts
                        maxElapsedMs             = $unkElapsed
                    })
                if ((ConvertTo-Json -InputObject $unkScope -Depth 6 -Compress) -cne (ConvertTo-Json -InputObject $unkAlloc -Depth 6 -Compress)) { & $fail }
                return $binding
            }

            # Current pending receipt: strict v3 validator (reruns the shared verifier) and the same shared facts; no other mode or COMPLETED shortcut.
            if (-not (Test-OperationalReceipt $receipt)) { & $fail }
            if ((& $cget $receipt 'schemaVersion') -cne 'OperationalRunReceipt/v3' -or (& $cget $receipt 'status') -cne 'AWAITING_CONTROLLER' -or (& $cget $receipt 'outputStopMode') -cne 'OBSERVE_ONLY') { & $fail }
            $historyVerified = & $cget $receipt 'historyVerified'
            if ($historyVerified -isnot [bool] -or $historyVerified) { & $fail }
            $artifactComplete = & $cget (& $cget $receipt 'artifact') 'complete'
            if ($artifactComplete -isnot [bool] -or $artifactComplete) { & $fail }
            $pending = Get-ManagedObservePendingAccountingFacts -Evidence (& $cget $receipt 'observePendingAccountingEvidence')
            if ($null -eq $pending -or $pending.Valid -isnot [bool] -or -not $pending.Valid -or $null -eq $pending.Facts) { & $fail }
            $facts = $pending.Facts
            $factsUsed = $facts.accounting.usedOutputTokens
            $receiptUsed = (& $cget (& $cget $receipt 'budget') 'usedOutputTokens')
            if (-not (& $isInteger $factsUsed) -or -not (& $isInteger $receiptUsed) -or [long]$factsUsed -lt 0 -or [long]$factsUsed -ne [long]$receiptUsed -or [long]$factsUsed -ne $cumulative) { & $fail }

            # ControlRoot comes only from the authenticated recapture of the current run's own pinned evidence, never from the caller.
            $cur = $facts.evidence.current
            $recapture = Get-ManagedNativeCapturedFacts -ManifestPath $cur.manifestPath -ExpectedManifestSha256 $cur.manifestSha256 -TerminalPath $cur.terminalPath -ExpectedTerminalSha256 $cur.terminalSha256 -TicketPath $cur.ticketPath -RunId $cur.runId -Attempt ([int][long]$cur.attempt) -ForOutputObservation
            if (@($recapture).Count -ne 1 -or $recapture -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
            if ((& $cget $recapture 'Valid') -isnot [bool] -or (& $cget $recapture 'Valid') -or $null -ne (& $cget $recapture 'Facts') -or (& $cget $recapture 'Code') -cne 'OBSERVE_ONLY_TRANSPORT_CAPTURE') { & $fail }
            $oc = & $cget $recapture 'ObservationCapture'
            if ((& $cget $oc 'RunId') -cne [string]$facts.identity.runId -or (& $cget $oc 'ManifestSha256') -cne [string]$facts.references.manifest.verifiedSha256 -or (& $cget $oc 'TicketSha256') -cne [string]$facts.references.ticket.verifiedSha256) { & $fail }
            $wd = & $cget (& $cget $oc 'Core') 'workingDirectory'
            if ($wd -isnot [string] -or $wd.Length -eq 0 -or $wd.Length -gt 1024 -or -not [System.IO.Path]::IsPathRooted($wd)) { & $fail }
            if (-not [string]::Equals([System.IO.Path]::GetFullPath($wd), $wd, $ord)) { & $fail }
            $lastChar = $wd[$wd.Length - 1]
            if ($lastChar -eq [System.IO.Path]::DirectorySeparatorChar -or $lastChar -eq [System.IO.Path]::AltDirectorySeparatorChar) { & $fail }
            $controlRoot = [System.IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')

            # Next ticket: the captured bytes decide the mode through the native contract and the anchored policy authority.
            $ticketBytes = $bytesList[1]
            $contract = Test-ManagedNativeTicketContract -Ticket $ticket -ExpectedPayloadSha256 $binding.nextPayloadSha256
            if ($null -eq $contract -or $contract.Valid -isnot [bool] -or -not $contract.Valid) { & $fail }
            if ($contract.OutputStopMode -isnot [string] -or $contract.OutputStopMode -cne 'OBSERVE_ONLY_DESCRIPTOR' -or $null -eq $contract.OutputStops) { & $fail }
            if ($null -ne $contract.Budget.AdditionalOutputMax -or $null -ne $contract.Budget.PhaseAggregateCeiling) { & $fail }
            $authority = Resolve-ManagedOutputStopAuthority -TicketContract $contract -CapturedTicket ([byte[]]($ticketBytes.Clone())) -ControlRoot $controlRoot
            if ($null -eq $authority -or $authority -isnot [System.Management.Automation.PSCustomObject] -or $authority.Schema -cne 'ManagedOutputStopAuthority/v1' -or $authority.Mode -cne 'OBSERVE_ONLY') { & $fail }

            $history = $contract.Budget.HistoricalOutputTokens
            if (-not (& $isInteger $history) -or [long]$history -ne $cumulative) { & $fail }
            $elapsed = $contract.Budget.ElapsedMs
            $attempts = & $cget $ticket 'maxAttempts'
            # Exact null elapsed (authenticated observe-only descriptor) = no total author deadline; a finite value must be a positive typed integer. Never cast null to 0.
            if (($null -ne $elapsed) -and (-not (& $isInteger $elapsed) -or [long]$elapsed -le 0)) { & $fail }
            if (-not (& $isInteger $attempts) -or [long]$attempts -le 0) { & $fail }

            $scope = Get-ControllerAllocationScope -CumulativeOutput $history -Scope ([pscustomobject][ordered]@{
                    taskId              = & $cget $ticket 'id'
                    owner               = & $cget $ticket 'owner'
                    ownedPaths          = & $cget $ticket 'ownedPaths'
                    outputStopMode      = 'OBSERVE_ONLY'
                    maxAdditionalOutput = $null
                    aggregateCeiling    = $null
                    maxAttempts         = $attempts
                    maxElapsedMs        = $elapsed
                })
            $captured = $binding.allocation
            if ((ConvertTo-Json -InputObject $scope -Depth 6 -Compress) -cne (ConvertTo-Json -InputObject $captured -Depth 6 -Compress)) { & $fail }
            return $binding
        }
        $rb = $receipt.PSObject.Properties['budget']
        if ($null -eq $rb -or $rb.Value -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
        $used = $rb.Value.PSObject.Properties['usedOutputTokens']
        if ($null -eq $used -or -not (& $isInteger $used.Value) -or [long]$used.Value -lt 0 -or [long]$used.Value -ne $cumulative) { & $fail }

        $ts = $ticket.PSObject.Properties['schema']
        if ($null -eq $ts -or $ts.Value -isnot [string] -or -not [string]::Equals($ts.Value, 'WorkerTicket/v1', [System.StringComparison]::Ordinal)) { & $fail }
        $tb = $ticket.PSObject.Properties['budget']
        if ($null -eq $tb -or $tb.Value -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
        $budget = $tb.Value
        foreach ($n in 'id', 'owner', 'ownedPaths') { if ($null -eq $ticket.PSObject.Properties[$n]) { & $fail } }
        foreach ($n in 'historicalOutputTokens', 'additionalOutputMax', 'phaseAggregateCeiling', 'maxAttempts', 'elapsedMs') {
            if ($null -eq $budget.PSObject.Properties[$n]) { & $fail }
        }
        $history = $budget.historicalOutputTokens
        if (-not (& $isInteger $history) -or [long]$history -ne $cumulative) { & $fail }

        $scope = Get-ControllerAllocationScope -CumulativeOutput $history -Scope ([pscustomobject][ordered]@{
                taskId              = $ticket.id
                owner               = $ticket.owner
                ownedPaths          = $ticket.ownedPaths
                maxAdditionalOutput = $budget.additionalOutputMax
                aggregateCeiling    = $budget.phaseAggregateCeiling
                maxAttempts         = $budget.maxAttempts
                maxElapsedMs        = $budget.elapsedMs
            })

        $captured = $binding.allocation
        foreach ($n in 'taskId', 'owner') {
            if (-not [string]::Equals($scope.$n, $captured.$n, [System.StringComparison]::Ordinal)) { & $fail }
        }
        foreach ($n in 'maxAdditionalOutput', 'aggregateCeiling', 'maxAttempts', 'maxElapsedMs') {
            if ([long]$scope.$n -ne [long]$captured.$n) { & $fail }
        }
        if ($scope.ownedPaths.Count -ne $captured.ownedPaths.Count) { & $fail }
        for ($i = 0; $i -lt $scope.ownedPaths.Count; $i++) {
            if (-not [string]::Equals($scope.ownedPaths[$i], $captured.ownedPaths[$i], [System.StringComparison]::Ordinal)) { & $fail }
        }
    }
    catch { throw 'CONTROLLER_ALLOCATION_INVALID' }

    return $binding
}
