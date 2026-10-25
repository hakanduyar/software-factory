# Static native ticket contract. Declarations only; no IO, process, reservation or authority grant.
# Values remain their original typed values. Requested contextTokens are not measured/enforced usage.
function Test-ManagedNativeTicketContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Ticket,
        [Parameter(Mandatory)][AllowNull()][object]$ExpectedPayloadSha256
    )
    $issues = [System.Collections.Generic.List[string]]::new()
    $values = @{}
    $advisoryResult = $null
    $read = {
        param($o, [string]$name)
        $found = @($o.PSObject.Properties | Where-Object { $_.Name -ceq $name })
        if ($found.Count -ne 1) {
            $issues.Add('MISSING_' + $name.ToUpperInvariant())
            return $null
        }
        return ,$found[0].Value
    }
    if ($Ticket -isnot [System.Management.Automation.PSCustomObject]) {
        $issues.Add('NOT_OBJECT')
    } else {
        foreach ($name in @('id','sessionId','payloadSha256')) {
            $before = $issues.Count
            $v = & $read $Ticket $name
            if ($issues.Count -ne $before) { continue }
            if ($v -isnot [string]) { $issues.Add('TYPE_' + $name.ToUpperInvariant()); continue }
            switch -CaseSensitive ($name) {
                'id' { if ([string]::IsNullOrWhiteSpace($v)) { $issues.Add('ID_INVALID') } }
                'sessionId' {
                    $g = [guid]::Empty
                    if (-not [guid]::TryParseExact($v, 'D', [ref]$g)) { $issues.Add('SESSIONID_INVALID') }
                }
                'payloadSha256' {
                    if ($v -cnotmatch '^[0-9a-f]{64}$') { $issues.Add('HASH_PAYLOADSHA256') }
                    elseif ($ExpectedPayloadSha256 -isnot [string] -or $ExpectedPayloadSha256 -cnotmatch '^[0-9a-f]{64}$' -or $v -cne $ExpectedPayloadSha256) { $issues.Add('TICKET_PAYLOAD_MISMATCH') }
                }
            }
        }
        $before = $issues.Count
        $budget = & $read $Ticket 'budget'
        if ($issues.Count -eq $before) {
            if ($budget -isnot [System.Management.Automation.PSCustomObject]) { $issues.Add('BUDGET_NOT_OBJECT') }
            else {
                foreach ($name in @('historicalOutputTokens','additionalOutputMax','phaseAggregateCeiling','elapsedMs','contextTokens')) {
                    $before = $issues.Count
                    $v = & $read $budget $name
                    if ($issues.Count -ne $before) { continue }
                    if ($v -isnot [int] -and $v -isnot [long]) { $issues.Add('TYPE_' + $name.ToUpperInvariant()); continue }
                    if (($name -ceq 'historicalOutputTokens' -and $v -lt 0) -or ($name -cne 'historicalOutputTokens' -and $v -le 0)) {
                        $issues.Add('RANGE_' + $name.ToUpperInvariant()); continue
                    }
                    $values[$name] = $v
                }
                # Pure structural advisory descriptor; no policy or receipt authentication. Exact-case declared shape required;
                # absence keeps legacy mode. No IO authority granted.
                $advProp = @($budget.PSObject.Properties | Where-Object { $_.Name -ceq 'aggregateAdvisory' })
                if ($advProp.Count -gt 1) { $issues.Add('ADVISORY_DUPLICATE') }
                elseif ($advProp.Count -eq 1 -and $issues.Count -eq 0) {
                    $adv = $advProp[0].Value
                    $ai = [System.Collections.Generic.List[string]]::new()
                    $advFields = @('schema','policyTaskId','advisoryThreshold','warningCode','policyRef','policyReviewRef','historyRuns')
                    $advRuns = [System.Collections.Generic.List[object]]::new()
                    # Shape-only Ref check: a valid {path,sha256} is not verified policy authority.
                    $refOf = {
                        param($x)
                        $n = if ($x -is [System.Management.Automation.PSCustomObject]) { @($x.PSObject.Properties | ForEach-Object { $_.Name }) } else { @() }
                        if ($n.Count -ne 2 -or $n -cnotcontains 'path' -or $n -cnotcontains 'sha256') { return $null }
                        $p = $x.path; $h = $x.sha256
                        if ($p -isnot [string] -or [string]::IsNullOrWhiteSpace($p) -or $p.Length -gt 2048 -or $h -isnot [string] -or $h -cnotmatch '^[0-9a-f]{64}\z') { return $null }
                        return [pscustomobject]@{ Path = [string]$p; Sha256 = [string]$h }
                    }
                    if ($adv -isnot [System.Management.Automation.PSCustomObject]) { $ai.Add('ADVISORY_NOT_OBJECT') }
                    else {
                        $advNames = @($adv.PSObject.Properties | ForEach-Object { $_.Name })
                        if ($advNames.Count -ne $advFields.Count -or @($advFields | Where-Object { $advNames -cnotcontains $_ }).Count -ne 0) { $ai.Add('ADVISORY_FIELDS') }
                        else {
                            $sch = $adv.schema; $tid = $adv.policyTaskId; $wc = $adv.warningCode; $thr = $adv.advisoryThreshold
                            if ($sch -isnot [string] -or $sch -cne 'PhaseAggregateAdvisory/v1') { $ai.Add('ADVISORY_SCHEMA') }
                            if ($tid -isnot [string] -or [string]::IsNullOrWhiteSpace($tid)) { $ai.Add('ADVISORY_POLICY_TASK_ID') }
                            if ($wc -isnot [string] -or [string]::IsNullOrWhiteSpace($wc)) { $ai.Add('ADVISORY_WARNING_CODE') }
                            if (($thr -isnot [int] -and $thr -isnot [long]) -or [long]$thr -le 0) { $ai.Add('ADVISORY_THRESHOLD') }
                            $polRef = & $refOf $adv.policyRef
                            if ($null -eq $polRef) { $ai.Add('ADVISORY_POLICY_REF') }
                            $revRef = & $refOf $adv.policyReviewRef
                            if ($null -eq $revRef) { $ai.Add('ADVISORY_POLICY_REVIEW_REF') }
                            $runs = $adv.historyRuns
                            if ($runs -isnot [System.Array] -or $runs.Count -gt 128) { $ai.Add('ADVISORY_HISTORY_SHAPE') }
                            else {
                                $seenId = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
                                $seenReq = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
                                $seenTh = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
                                $seenTp = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                                $total = [long]0
                                foreach ($r in $runs) {
                                    $rn = if ($r -is [System.Management.Automation.PSCustomObject]) { @($r.PSObject.Properties | ForEach-Object { $_.Name }) } else { @() }
                                    if ($rn.Count -ne 4 -or @('runId','requestSha256','terminalRef','outputTokens' | Where-Object { $rn -cnotcontains $_ }).Count -ne 0) { $ai.Add('ADVISORY_HISTORY_SHAPE'); break }
                                    $rid = $r.runId; $req = $r.requestSha256; $rt = $r.outputTokens
                                    $tref = & $refOf $r.terminalRef
                                    if ($rid -isnot [string] -or $rid -cnotmatch '^[A-Za-z0-9._-]{1,128}\z') { $ai.Add('ADVISORY_HISTORY_RUNID'); break }
                                    if ($req -isnot [string] -or $req -cnotmatch '^[0-9a-f]{64}\z') { $ai.Add('ADVISORY_HISTORY_REQUEST_HASH'); break }
                                    if ($null -eq $tref) { $ai.Add('ADVISORY_HISTORY_TERMINAL_REF'); break }
                                    if (($rt -isnot [int] -and $rt -isnot [long]) -or [long]$rt -lt 0) { $ai.Add('ADVISORY_HISTORY_TOKENS'); break }
                                    if (-not $seenId.Add($rid) -or -not $seenReq.Add($req) -or -not $seenTh.Add($tref.Sha256) -or -not $seenTp.Add($tref.Path)) { $ai.Add('ADVISORY_HISTORY_DUPLICATE'); break }
                                    if ([long]$rt -gt ([long]::MaxValue - $total)) { $ai.Add('ADVISORY_HISTORY_OVERFLOW'); break }
                                    $total = [long]($total + [long]$rt)
                                    $advRuns.Add([pscustomobject]@{ RunId = $rid; RequestSha256 = $req; TerminalRef = $tref; OutputTokens = [long]$rt })
                                }
                                if ($ai.Count -eq 0) {
                                    if ($runs.Count -eq 0 -and [long]$values['historicalOutputTokens'] -ne 0) { $ai.Add('ADVISORY_HISTORY_EMPTY') }
                                    elseif ($total -ne [long]$values['historicalOutputTokens']) { $ai.Add('ADVISORY_HISTORY_SUM') }
                                }
                            }
                        }
                    }
                    if ($ai.Count -gt 0) { foreach ($x in $ai) { $issues.Add($x) } }
                    else {
                        $advisoryResult = [pscustomobject]@{
                            Threshold = [long]$thr
                            WarningCode = [string]$wc
                            PolicyTaskId = [string]$tid
                            PolicyRef = $polRef
                            PolicyReviewRef = $revRef
                            HistoryRuns = $advRuns.ToArray()
                        }
                    }
                }
            }
        }
    }
    $valid = ($issues.Count -eq 0)
    $resultBudget = $null
    if ($valid) {
        $resultBudget = [pscustomobject]@{
            HistoricalOutputTokens = $values['historicalOutputTokens']
            AdditionalOutputMax = $values['additionalOutputMax']
            PhaseAggregateCeiling = $values['phaseAggregateCeiling']
            ElapsedMs = $values['elapsedMs']
            ContextTokens = $values['contextTokens']
        }
    }
    return [pscustomobject]@{
        Valid = $valid
        Code = $(if ($valid) { $null } else { $issues[0] })
        Issues = $issues.ToArray()
        Budget = $resultBudget
        AggregateMode = $(if ($valid -and $null -ne $advisoryResult) { 'ADVISORY_DESCRIPTOR' } else { 'LEGACY_HARDLIMIT' })
        Advisory = $(if ($valid) { $advisoryResult } else { $null })
    }
}