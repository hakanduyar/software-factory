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
