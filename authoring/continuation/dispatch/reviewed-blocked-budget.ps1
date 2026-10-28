# Reviewed blocked budget comparator: pure scalar numerical/UTC comparison; not authority.
function Test-ReviewedBlockedSettlementBudget {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)][AllowNull()][object]$Budget,
        [Parameter(Position = 1)][AllowNull()][object]$ExpectedBudget,
        [Parameter(Position = 2)][AllowNull()][object]$StartUtc,
        [Parameter(Position = 3)][AllowNull()][object]$EndUtc
    )
    $refusal = 'REVIEWED_BLOCKED_BUDGET_INVALID'
    try {
        if ($null -eq $Budget -or $null -eq $ExpectedBudget -or $null -eq $StartUtc -or $null -eq $EndUtc) { throw $refusal }

        # Inspect metadata only (no getter execution) and clone scalar values.
        $readNotes = {
            param($Obj, [string[]]$Names, [bool]$Exact)
            $props = @($Obj.PSObject.Properties)
            $out = @{}
            foreach ($n in $Names) {
                $m = @($props | Where-Object { [string]::Equals($_.Name,$n,[StringComparison]::Ordinal) })
                if ($m.Count -ne 1 -or $m[0].MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $refusal }
                $out[$n] = $m[0]
            }
            if ($Exact) {
                if ($props.Count -ne $Names.Count) { throw $refusal }
                foreach ($p in $props) {
                    if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $refusal }
                }
            }
            $vals = @{}
            foreach ($n in $Names) {
                $v = $out[$n].Value
                if (-not ($v -is [int] -or $v -is [long])) { throw $refusal }
                $c = [int64]$v
                if ($c -lt 0) { throw $refusal }
                $vals[$n] = $c
            }
            return $vals
        }

        $b = & $readNotes $Budget @('maxOutputTokens', 'maxElapsedMs', 'maxAttempts', 'usedElapsedMs', 'usedOutputTokens', 'attemptsUsed') $false
        $e = & $readNotes $ExpectedBudget @('cumulativeOutputTokens', 'phaseAggregateCeiling', 'maxAttempts', 'maxElapsedMs', 'attempt') $true

        if ($e['attempt'] -ne 1 -or $e['maxAttempts'] -lt 1) { throw $refusal }
        if ($b['usedOutputTokens'] -ne $e['cumulativeOutputTokens']) { throw $refusal }
        if ($b['maxOutputTokens'] -ne $e['phaseAggregateCeiling']) { throw $refusal }
        if ($b['maxAttempts'] -ne $e['maxAttempts']) { throw $refusal }
        if ($b['maxElapsedMs'] -ne $e['maxElapsedMs']) { throw $refusal }
        if ($b['attemptsUsed'] -ne $e['attempt']) { throw $refusal }

        $parseUtc = {
            param($S)
            if ($S -isnot [string] -or -not $S.EndsWith('Z', [System.StringComparison]::Ordinal)) { throw $refusal }
            $d = [datetime]::MinValue
            $ok = [datetime]::TryParseExact([string]$S, 'o', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$d)
            if (-not $ok -or $d.Kind -ne [System.DateTimeKind]::Utc) { throw $refusal }
            return $d
        }
        $start = & $parseUtc $StartUtc
        $end = & $parseUtc $EndUtc
        if ($end -lt $start) { throw $refusal }

        [int64]$ticks = $end.Ticks - $start.Ticks
        [int64]$rem = 0
        [int64]$ms = [math]::DivRem($ticks, [int64]10000, [ref]$rem)
        if ($rem -ne 0) { $ms = $ms + 1 }
        if ($b['usedElapsedMs'] -ne $ms) { throw $refusal }

        return $true
    }
    catch {
        throw $refusal
    }
}
