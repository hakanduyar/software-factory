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

        $cumulative = [long]$binding.cumulativeOutput
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
