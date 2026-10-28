. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-decoded-buffers.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-basis.ps1')

function Get-VerifiedReviewedBlockedFacts {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$InputBuffers
    )

    $refusal = 'REVIEWED_BLOCKED_FACTS_INVALID'
    try {
        $rawFields = @('status', 'pid', 'startUtc', 'endUtc', 'exit', 'session', 'historicalOutput', 'additionalCap', 'observedOutput', 'stopReason')

        $shapeOk = {
            param($Candidate, [string[]]$Names)
            if ($null -eq $Candidate) { return $false }
            if ($Candidate -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $props = @($Candidate.PSObject.Properties)
            if ($props.Count -ne $Names.Count) { return $false }
            $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
            foreach ($p in $props) {
                if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
                if (-not $seen.Add([string]$p.Name)) { return $false }
            }
            foreach ($n in $Names) {
                if (-not $seen.Contains($n)) { return $false }
            }
            return $true
        }
        $isInt = { param($Value) return ($Value -is [int]) -or ($Value -is [long]) }
        $isText = { param($Value) return ($Value -is [string]) -and -not [string]::IsNullOrWhiteSpace($Value) }
        $getProp = {
            param($Object, [string]$Name)
            if ($null -eq $Object -or $Object -isnot [System.Management.Automation.PSCustomObject]) { throw $refusal }
            $p = $Object.PSObject.Properties[$Name]
            if ($null -eq $p -or $p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $refusal }
            return $p.Value
        }
        $utc = {
            param($Value)
            if ($Value -isnot [string] -or -not $Value.EndsWith('Z', [System.StringComparison]::Ordinal)) { throw $refusal }
            $d = [datetime]::MinValue
            $ok = [datetime]::TryParseExact($Value, 'o', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$d)
            if (-not $ok -or $d.Kind -ne [System.DateTimeKind]::Utc) { throw $refusal }
            return $d
        }

        # Accepted A once on the original input, accepted B once on A's captured object.
        $decoded = Get-DecodedReviewedBlockedBuffers -InputBuffers $InputBuffers
        $verified = Get-VerifiedReviewedBlockedBasis -DecodedBuffers $decoded
        if ($null -eq $verified -or $verified -isnot [System.Management.Automation.PSCustomObject]) { throw $refusal }
        $capture = $verified.capture
        $basis = $verified.basis
        $raw = $decoded.raw
        $ticket = $decoded.ticket
        $worker = $decoded.workerResult

        # Metadata phase before value reads.
        if (-not (& $shapeOk $raw $rawFields)) { throw $refusal }
        if ($ticket -isnot [System.Management.Automation.PSCustomObject]) { throw $refusal }
        if ($worker -isnot [System.Management.Automation.PSCustomObject]) { throw $refusal }

        # Raw terminal facts.
        $r = @{}
        foreach ($n in $rawFields) { $r[$n] = $raw.PSObject.Properties[$n].Value }
        if ($r['status'] -isnot [string] -or -not ($r['status'] -ceq 'TERMINAL')) { throw $refusal }
        if ($r['stopReason'] -isnot [string] -or -not ($r['stopReason'] -ceq 'end_turn')) { throw $refusal }
        foreach ($n in @('pid', 'exit', 'historicalOutput', 'additionalCap', 'observedOutput')) {
            if (-not (& $isInt $r[$n])) { throw $refusal }
        }
        if ([decimal]$r['exit'] -ne 0) { throw $refusal }
        if ($r['session'] -isnot [string] -or -not ($r['session'] -ceq [string]$basis.sessionId)) { throw $refusal }
        if ([decimal]$r['pid'] -ne [decimal]$basis.pid) { throw $refusal }
        if ($r['startUtc'] -isnot [string] -or -not ($r['startUtc'] -ceq [string]$basis.startIdentity)) { throw $refusal }
        $start = & $utc $r['startUtc']
        $end = & $utc $r['endUtc']
        if ($end -lt $start) { throw $refusal }
        if ([decimal]$r['historicalOutput'] -ne [decimal]$basis.historicalOutputTokens) { throw $refusal }
        if ([decimal]$r['observedOutput'] -ne [decimal]$basis.sdkOutputTokens) { throw $refusal }
        if ([decimal]$r['additionalCap'] -ne [decimal]$basis.additionalOutputMax) { throw $refusal }

        # Ticket facts.
        $tSchema = & $getProp $ticket 'schema'
        if ($tSchema -isnot [string] -or -not ($tSchema -ceq 'WorkerTicket/v1')) { throw $refusal }
        foreach ($pair in @(@('id', 'taskId'), @('sessionId', 'sessionId'), @('payloadSha256', 'payloadSha256'))) {
            $tv = & $getProp $ticket $pair[0]
            if ($tv -isnot [string] -or -not ($tv -ceq [string]$basis.($pair[1]))) { throw $refusal }
        }
        $budget = & $getProp $ticket 'budget'
        $bMap = @{
            historicalOutputTokens = [decimal]$basis.historicalOutputTokens
            additionalOutputMax    = [decimal]$basis.additionalOutputMax
            phaseAggregateCeiling  = [decimal]$basis.phaseAggregateCeiling
            maxAttempts            = [decimal]$basis.maxAttempts
            elapsedMs              = [decimal]$basis.maxElapsedMs
        }
        foreach ($n in $bMap.Keys) {
            $bv = & $getProp $budget $n
            if (-not (& $isInt $bv)) { throw $refusal }
            if ([decimal]$bv -ne $bMap[$n]) { throw $refusal }
            if ($n -eq 'historicalOutputTokens') {
                if ([decimal]$bv -lt 0) { throw $refusal }
            }
            elseif ([decimal]$bv -le 0) { throw $refusal }
        }
        if ([decimal]$basis.attempt -gt [decimal]$basis.maxAttempts) { throw $refusal }

        # Budget arithmetic in decimal; never grants.
        $sdk = [decimal]$basis.sdkOutputTokens
        $hist = [decimal]$basis.historicalOutputTokens
        $sum = $sdk + $hist
        if ($sum -ne [decimal]$basis.cumulativeOutputTokens) { throw $refusal }
        if ($sum -gt [decimal]$basis.phaseAggregateCeiling) { throw $refusal }
        if ($sdk -gt [decimal]$basis.additionalOutputMax) { throw $refusal }

        # Recorded WorkerResult view.
        $wSchema = & $getProp $worker 'schema'
        if ($wSchema -isnot [string] -or -not ($wSchema -ceq 'RecordedWorkerResultView/v1')) { throw $refusal }
        foreach ($pair in @(@('taskId', 'taskId'), @('runId', 'runId'), @('streamSha', 'usageSha256'))) {
            $wv = & $getProp $worker $pair[0]
            if ($wv -isnot [string] -or -not ($wv -ceq [string]$basis.($pair[1]))) { throw $refusal }
        }
        $subtype = & $getProp $worker 'providerSubtype'
        if ($subtype -isnot [string] -or -not ($subtype -ceq 'success')) { throw $refusal }
        $actual = & $getProp $worker 'actualResult'
        if (-not (& $isText $actual)) { throw $refusal }

        return [pscustomobject][ordered]@{
            schema        = 'VerifiedReviewedBlockedFacts/v1'
            capture       = $capture
            raw           = $raw
            ticket        = $ticket
            reviewedBasis = $basis
        }
    }
    catch {
        throw $refusal
    }
}
