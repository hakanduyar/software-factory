#requires -Version 7
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\continuity\reconcile.ps1')

function Test-IsPlainInt {
    param($v)
    if ($null -eq $v -or $v -is [bool] -or $v -is [string] -or $v -is [System.Array]) { return $false }
    if ($v -is [double] -or $v -is [float] -or $v -is [decimal]) { if ($v -ne [math]::Truncate($v)) { return $false } }
    try { [void][int64]$v } catch { return $false }
    return $true
}

function ConvertTo-TerminalReceipt {
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [Parameter(Mandatory)][string]$TicketPath,
        [Parameter(Mandatory)][string]$UsagePath,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][int]$Attempt,
        [Parameter(Mandatory)][int]$MaxAttempts,
        [Parameter(Mandatory)][long]$PriorElapsedMs,
        [Parameter(Mandatory)][long]$MaxElapsedMs,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [PSCustomObject]$CompletedNativeEvidence,
        [AllowNull()][object]$ReviewedBlockedEvidence,
        [AllowNull()][object]$ExpectedBlockedReview
    )

    $fail = { param($reason, $rawSha, $ticketSha) [PSCustomObject]@{ valid = $false; reason = $reason; rawSha256 = $rawSha; ticketSha256 = $ticketSha } }

    # Opt-in reviewed BLOCKED v2 branch: presence checks precede all input I/O.
    $hasReviewedEvidence = $PSBoundParameters.ContainsKey('ReviewedBlockedEvidence')
    $hasExpectedReview = $PSBoundParameters.ContainsKey('ExpectedBlockedReview')
    $optIn = $false
    $facts = $null
    $cap = $null
    $capEv = $null
    $basis = $null
    $workerView = $null
    $privateUsageLines = @()
    if ($hasReviewedEvidence -or $hasExpectedReview) {
        if (-not ($hasReviewedEvidence -and $hasExpectedReview)) { return & $fail 'reviewed blocked parameters must be supplied together' $null $null }
        if ($PSBoundParameters.ContainsKey('CompletedNativeEvidence')) { return & $fail 'reviewed blocked parameters incompatible with CompletedNativeEvidence' $null $null }
        if ($null -eq $ReviewedBlockedEvidence -or $null -eq $ExpectedBlockedReview) { return & $fail 'reviewed blocked parameter is null' $null $null }
        $optIn = $true
        try {
            . (Join-Path $PSScriptRoot 'reviewed-blocked-input-buffers.ps1')
            . (Join-Path $PSScriptRoot 'reviewed-blocked-facts.ps1')
            # Byte capture happens before any other data-file I/O; originals are never reread.
            $buffers = Get-ReviewedBlockedInputBuffers -ReviewedBlockedEvidence $ReviewedBlockedEvidence -ExpectedBlockedReview $ExpectedBlockedReview
            $facts = Get-VerifiedReviewedBlockedFacts -InputBuffers $buffers
            $cap = $facts.capture
            $capEv = $cap.evidence
            $basis = $facts.reviewedBasis
            $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
            $workerView = $strictUtf8.GetString($buffers.workerResultBytes) | ConvertFrom-Json -DateKind String -NoEnumerate
            $usageText = $strictUtf8.GetString($buffers.usageBytes)
            if ($usageText.Length -gt 0 -and $usageText[0] -eq [char]0xFEFF) { $usageText = $usageText.Substring(1) }
            $usageReader = New-Object System.IO.StringReader($usageText)
            $usageList = New-Object System.Collections.Generic.List[string]
            while ($null -ne ($usageLine = $usageReader.ReadLine())) { $usageList.Add($usageLine) }
            $privateUsageLines = $usageList.ToArray()
        } catch { return & $fail 'reviewed blocked capture or verification failed' $null $null }
    }

    foreach ($p in @($RawPath, $TicketPath, $UsagePath)) {
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return & $fail "missing input: $p" $null $null }
    }
    if ($Attempt -lt 0 -or $MaxAttempts -le 0 -or $Attempt -gt $MaxAttempts) { return & $fail 'invalid attempt range' $null $null }
    if ($PriorElapsedMs -lt 0 -or $MaxElapsedMs -le 0) { return & $fail 'invalid elapsed bounds' $null $null }

    $verifyFiveInputs = $null
    $fiveInputPaths = @()
    if ($optIn) {
        $rawSha = ([string]$capEv.rawSha256).ToUpperInvariant()
        $ticketSha = ([string]$capEv.ticketSha256).ToLowerInvariant()
        $usageSha = ([string]$capEv.usageSha256).ToUpperInvariant()
        $boundPaths = @{}
        foreach ($pair in @(@($RawPath, 'rawPath'), @($TicketPath, 'ticketPath'), @($UsagePath, 'usagePath'))) {
            $given = $null
            try { $given = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $pair[0] -ErrorAction Stop).ProviderPath) } catch { return & $fail 'input path unresolvable' $rawSha $ticketSha }
            $want = [System.IO.Path]::GetFullPath([string]$capEv.($pair[1]))
            if (-not [string]::Equals($given, $want, [System.StringComparison]::OrdinalIgnoreCase)) { return & $fail "$($pair[1]) does not match captured path" $rawSha $ticketSha }
            $boundPaths[$pair[1]] = $want
        }
        $rawFull = $boundPaths['rawPath']
        $ticketFull = $boundPaths['ticketPath']
        $usageFull = $boundPaths['usagePath']
        $fiveInputPaths = @($rawFull, $ticketFull, $usageFull, [System.IO.Path]::GetFullPath([string]$capEv.workerResultPath), [System.IO.Path]::GetFullPath([string]$capEv.reviewPath))
        $fiveInputHashes = @($capEv.rawSha256, $capEv.ticketSha256, $capEv.usageSha256, $capEv.workerResultSha256, $capEv.reviewSha256)
        $verifyFiveInputs = {
            for ($i = 0; $i -lt 5; $i++) {
                try { $cur = (Get-FileHash -LiteralPath $fiveInputPaths[$i] -Algorithm SHA256 -ErrorAction Stop).Hash } catch { return $false }
                if (-not [string]::Equals($cur, [string]$fiveInputHashes[$i], [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
            }
            return $true
        }
        if (-not (& $verifyFiveInputs)) { return & $fail 'evidence input changed since capture' $rawSha $ticketSha }

        # Binding to the captured basis; first-attempt scope only.
        if (-not [string]::Equals($RunId, [string]$basis.runId, [System.StringComparison]::Ordinal)) { return & $fail 'runId does not match reviewed basis' $rawSha $ticketSha }
        if ($capEv.PSObject.Properties.Name -contains 'runId' -and -not [string]::Equals($RunId, [string]$capEv.runId, [System.StringComparison]::Ordinal)) { return & $fail 'runId does not match capture' $rawSha $ticketSha }
        if ([decimal]$basis.attempt -ne 1 -or [decimal]$Attempt -ne [decimal]$basis.attempt) { return & $fail 'attempt does not match reviewed first attempt' $rawSha $ticketSha }
        if ($PriorElapsedMs -ne 0) { return & $fail 'PriorElapsedMs must be 0 for reviewed first attempt' $rawSha $ticketSha }
        if ([decimal]$MaxAttempts -ne [decimal]$basis.maxAttempts) { return & $fail 'maxAttempts does not match reviewed basis' $rawSha $ticketSha }
        if ([decimal]$MaxElapsedMs -ne [decimal]$basis.maxElapsedMs) { return & $fail 'maxElapsedMs does not match reviewed basis' $rawSha $ticketSha }

        $raw = $facts.raw
        $ticket = $facts.ticket
    } else {
    $rawFull = (Resolve-Path -LiteralPath $RawPath).ProviderPath
    $ticketFull = (Resolve-Path -LiteralPath $TicketPath).ProviderPath
    $usageFull = (Resolve-Path -LiteralPath $UsagePath).ProviderPath
    $rawSha = (Get-FileHash -LiteralPath $rawFull -Algorithm SHA256).Hash
    $ticketSha = (Get-FileHash -LiteralPath $ticketFull -Algorithm SHA256).Hash.ToLowerInvariant()
    $usageSha = (Get-FileHash -LiteralPath $usageFull -Algorithm SHA256).Hash

    try { $raw = Get-Content -LiteralPath $rawFull -Raw | ConvertFrom-Json -DateKind String } catch { return & $fail 'raw not parseable JSON' $rawSha $ticketSha }
    try { $ticket = Get-Content -LiteralPath $ticketFull -Raw | ConvertFrom-Json } catch { return & $fail 'ticket not parseable JSON' $rawSha $ticketSha }
    }

    foreach ($f in @('status','pid','session','startUtc','endUtc','exit','stopReason','historicalOutput','observedOutput','additionalCap')) {
        if (-not ($raw.PSObject.Properties.Name -contains $f)) { return & $fail "raw missing field: $f" $rawSha $ticketSha }
    }
    if (@('AWAITING_CONTROLLER','TERMINAL') -notcontains $raw.status) { return & $fail 'raw status not terminal' $rawSha $ticketSha }
    if (-not (Test-IsPlainInt $raw.pid) -or [int64]$raw.pid -le 0) { return & $fail 'raw pid invalid' $rawSha $ticketSha }
    if ([string]::IsNullOrWhiteSpace("$($raw.session)")) { return & $fail 'raw session missing' $rawSha $ticketSha }
    $startDt = $null; $endDt = $null
    try { $startDt = [datetime]::Parse("$($raw.startUtc)", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) } catch { return & $fail 'raw startUtc unparseable' $rawSha $ticketSha }
    try { $endDt = [datetime]::Parse("$($raw.endUtc)", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) } catch { return & $fail 'raw endUtc unparseable' $rawSha $ticketSha }
    if ($endDt -lt $startDt) { return & $fail 'raw endUtc before startUtc' $rawSha $ticketSha }
    foreach ($f in @('historicalOutput','observedOutput','additionalCap')) {
        if (-not (Test-IsPlainInt $raw.$f) -or [int64]$raw.$f -lt 0) { return & $fail "raw $f invalid" $rawSha $ticketSha }
    }
    if (-not (Test-IsPlainInt $raw.exit)) { return & $fail 'raw exit invalid' $rawSha $ticketSha }
    if ($null -ne $raw.stopReason -and $raw.stopReason -isnot [string]) { return & $fail 'raw stopReason invalid' $rawSha $ticketSha }

    foreach ($f in @('id','payloadSha256','sessionId','budget')) {
        if (-not ($ticket.PSObject.Properties.Name -contains $f)) { return & $fail "ticket missing field: $f" $rawSha $ticketSha }
    }
    foreach ($bf in @('historicalOutputTokens','additionalOutputMax','phaseAggregateCeiling','elapsedMs','contextTokens')) {
        if (-not ($ticket.budget.PSObject.Properties.Name -contains $bf)) { return & $fail "ticket missing field: budget.$bf" $rawSha $ticketSha }
        if (-not (Test-IsPlainInt $ticket.budget.$bf) -or ([int64]$ticket.budget.$bf -le 0 -and -not ($bf -eq 'historicalOutputTokens' -and [int64]$ticket.budget.$bf -ge 0))) { return & $fail "ticket budget.$bf invalid" $rawSha $ticketSha }
    }
    if ("$($ticket.sessionId)" -ne "$($raw.session)") { return & $fail 'session mismatch raw vs ticket' $rawSha $ticketSha }
    if ([int64]$ticket.budget.historicalOutputTokens -ne [int64]$raw.historicalOutput) { return & $fail 'historicalOutput mismatch vs ticket' $rawSha $ticketSha }
    if ([int64]$ticket.budget.additionalOutputMax -ne [int64]$raw.additionalCap) { return & $fail 'additionalCap mismatch vs ticket' $rawSha $ticketSha }

$nativeOutput = 0L
    $thinkingTotal = 0L
    $sawThinking = $false
    $thinking = $null
    $sawMessageStart = $false
    $sawTerminalEvent = $false
    $sawResultAggregate = $false
    $resultAggregate = 0L
    $curMax = 0L
    $curThinking = 0L
    $resultEvents = New-Object System.Collections.ArrayList
    try {
        $usageSource = if ($optIn) { $privateUsageLines } else { [System.IO.File]::ReadLines($usageFull) }
        foreach ($line in $usageSource) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parsed = $line | ConvertFrom-Json
            $evt = if ($parsed.PSObject.Properties.Name -contains 'type' -and $parsed.type -eq 'stream_event' -and $parsed.PSObject.Properties.Name -contains 'event') { $parsed.event } else { $parsed }
            if (-not ($evt.PSObject.Properties.Name -contains 'type')) { continue }
            switch ($evt.type) {
                'message_start' {
                    if ($sawMessageStart) { $nativeOutput += $curMax; $thinkingTotal += $curThinking }
                    $sawMessageStart = $true
                    $curMax = 0L
                    $curThinking = 0L
                }
                'message_delta' {
                    if ($evt.PSObject.Properties.Name -contains 'usage' -and $evt.usage -and $evt.usage.PSObject.Properties.Name -contains 'output_tokens' -and $null -ne $evt.usage.output_tokens) {
                        if (-not (Test-IsPlainInt $evt.usage.output_tokens) -or [int64]$evt.usage.output_tokens -lt 0) { return & $fail 'usage output_tokens invalid' $rawSha $ticketSha }
                        if ([int64]$evt.usage.output_tokens -gt $curMax) { $curMax = [int64]$evt.usage.output_tokens }
                    }
                    if ($evt.PSObject.Properties.Name -contains 'usage' -and $evt.usage -and $evt.usage.PSObject.Properties.Name -contains 'output_tokens_details' -and $evt.usage.output_tokens_details -and $evt.usage.output_tokens_details.PSObject.Properties.Name -contains 'thinking_tokens' -and $null -ne $evt.usage.output_tokens_details.thinking_tokens) {
                        if (-not (Test-IsPlainInt $evt.usage.output_tokens_details.thinking_tokens) -or [int64]$evt.usage.output_tokens_details.thinking_tokens -lt 0) { return & $fail 'usage thinking_tokens invalid' $rawSha $ticketSha }
                        $curThinking = [int64]$evt.usage.output_tokens_details.thinking_tokens
                        $sawThinking = $true
                    }
                    if ($evt.PSObject.Properties.Name -contains 'delta' -and $evt.delta -and $evt.delta.PSObject.Properties.Name -contains 'stop_reason' -and $evt.delta.stop_reason -eq 'max_tokens') { $sawTerminalEvent = $true }
                }
                'result' {
                    $sawTerminalEvent = $true
                    [void]$resultEvents.Add($evt)
                    if ($evt.PSObject.Properties.Name -contains 'usage' -and $evt.usage -and $evt.usage.PSObject.Properties.Name -contains 'output_tokens' -and $null -ne $evt.usage.output_tokens) {
                        if (-not (Test-IsPlainInt $evt.usage.output_tokens) -or [int64]$evt.usage.output_tokens -lt 0) { return & $fail 'usage result output_tokens invalid' $rawSha $ticketSha }
                        $resultAggregate = [int64]$evt.usage.output_tokens
                        $sawResultAggregate = $true
                    }
                }
            }
        }
        if ($sawMessageStart) { $nativeOutput += $curMax; $thinkingTotal += $curThinking }
    } catch { return & $fail 'usage stream not parseable JSONL' $rawSha $ticketSha }

    if (-not $sawMessageStart) { return & $fail 'usage stream missing message_start sequence' $rawSha $ticketSha }
    if (-not $sawTerminalEvent) { return & $fail 'usage stream missing terminal max_tokens or result event' $rawSha $ticketSha }
    if ($sawResultAggregate -and $resultAggregate -ne $nativeOutput) { return & $fail 'result aggregate mismatch vs summed per-message maxima' $rawSha $ticketSha }
    if ($sawThinking) { $thinking = $thinkingTotal }
    if ($nativeOutput -ne [int64]$raw.observedOutput) { return & $fail 'native output mismatch vs raw.observedOutput' $rawSha $ticketSha }

    if ($optIn) {
        $sdkTotal = [decimal]$basis.sdkOutputTokens
        if ($resultEvents.Count -ne 1) { return & $fail 'SDK stream must contain exactly one result event' $rawSha $ticketSha }
        $res = $resultEvents[0]
        $resNames = @($res.PSObject.Properties.Name)
        foreach ($k in @('subtype', 'is_error', 'session_id', 'result', 'usage')) {
            if ($resNames -notcontains $k) { return & $fail "SDK result missing $k" $rawSha $ticketSha }
        }
        if ($res.subtype -isnot [string] -or -not ($res.subtype -ceq 'success')) { return & $fail 'SDK result subtype is not success' $rawSha $ticketSha }
        if ($res.is_error -isnot [bool] -or $res.is_error) { return & $fail 'SDK result is_error is not false' $rawSha $ticketSha }
        if ($res.session_id -isnot [string] -or -not [string]::Equals($res.session_id, [string]$capEv.sessionId, [System.StringComparison]::Ordinal)) { return & $fail 'SDK result session_id does not match capture' $rawSha $ticketSha }
        if ($null -eq $workerView -or $workerView -isnot [System.Management.Automation.PSCustomObject] -or @($workerView.PSObject.Properties.Name) -notcontains 'actualResult') { return & $fail 'WorkerResult actualResult missing' $rawSha $ticketSha }
        $actualResult = $workerView.actualResult
        if ($actualResult -isnot [string] -or [string]::IsNullOrWhiteSpace($actualResult)) { return & $fail 'WorkerResult actualResult invalid' $rawSha $ticketSha }
        if ($res.result -isnot [string] -or [string]::IsNullOrWhiteSpace($res.result) -or -not [string]::Equals($res.result, $actualResult, [System.StringComparison]::Ordinal)) { return & $fail 'SDK result text does not equal WorkerResult actualResult' $rawSha $ticketSha }
        if ($null -eq $res.usage -or @($res.usage.PSObject.Properties.Name) -notcontains 'output_tokens') { return & $fail 'SDK result usage.output_tokens missing' $rawSha $ticketSha }
        $resTokens = $res.usage.output_tokens
        if (($resTokens -isnot [int] -and $resTokens -isnot [long]) -or [int64]$resTokens -lt 0) { return & $fail 'SDK result usage.output_tokens invalid' $rawSha $ticketSha }
        if ([decimal]$resTokens -ne $sdkTotal) { return & $fail 'SDK result output_tokens does not equal basis total' $rawSha $ticketSha }
        if (-not $sawResultAggregate -or [decimal]$resultAggregate -ne $sdkTotal -or [decimal]$nativeOutput -ne $sdkTotal) { return & $fail 'SDK aggregate or summed maxima does not equal basis total' $rawSha $ticketSha }
    }

    $usedElapsedMs = $PriorElapsedMs + [int64][math]::Ceiling(($endDt - $startDt).TotalMilliseconds)
    if ($usedElapsedMs -gt $MaxElapsedMs) { return & $fail 'elapsed budget exceeded' $rawSha $ticketSha }

    $usedOutputTokens = [int64]$raw.historicalOutput + $nativeOutput
    if ($usedOutputTokens -gt [int64]$ticket.budget.phaseAggregateCeiling) {
        $recheckRawSha = (Get-FileHash -LiteralPath $rawFull -Algorithm SHA256).Hash
        $recheckTicketSha = (Get-FileHash -LiteralPath $ticketFull -Algorithm SHA256).Hash.ToLowerInvariant()
        $recheckUsageSha = (Get-FileHash -LiteralPath $usageFull -Algorithm SHA256).Hash
        if ($recheckRawSha -ne $rawSha -or $recheckTicketSha -ne $ticketSha -or $recheckUsageSha -ne $usageSha) {
            return & $fail 'integrity changed before diagnostic emission' $recheckRawSha $recheckTicketSha
        }
        foreach ($idv in @($ticket.id, $ticket.sessionId, $raw.session, $raw.startUtc, $raw.endUtc)) {
            if ($idv -isnot [string] -or [string]::IsNullOrWhiteSpace($idv)) { return & $fail 'diagnostic identity field not a nonempty scalar string' $recheckRawSha $recheckTicketSha }
        }
        if (-not [string]::Equals($ticket.sessionId, $raw.session, [System.StringComparison]::Ordinal)) { return & $fail 'diagnostic session identity mismatch' $recheckRawSha $recheckTicketSha }
        if ($startDt.Kind -ne [System.DateTimeKind]::Utc -or $endDt.Kind -ne [System.DateTimeKind]::Utc) { return & $fail 'diagnostic UTC timestamp not UTC' $recheckRawSha $recheckTicketSha }

        $excessVsAggregate = $usedOutputTokens - [int64]$ticket.budget.phaseAggregateCeiling
        $excessVsAdditional = $nativeOutput - [int64]$raw.additionalCap
        if ($excessVsAdditional -lt 0) { $excessVsAdditional = 0L }
        return [PSCustomObject]@{
            valid          = $false
            diagnosticType = 'BudgetBreach'
            schemaVersion  = 'BudgetBreachDiagnostic/v1'
            runId          = $RunId
            taskId         = $ticket.id
            attempt        = [int64]$Attempt
            sessionId      = $raw.session
            pid            = [int64]$raw.pid
            startUtc       = $raw.startUtc
            endUtc         = $raw.endUtc
            exit           = [int64]$raw.exit
            stopOutcome    = $raw.stopReason
            rawSha256      = $recheckRawSha
            ticketSha256   = $recheckTicketSha
            usageSha256    = $recheckUsageSha
            budget         = [PSCustomObject]@{
                historicalOutputTokens   = [int64]$raw.historicalOutput
                additionalObservedTokens = [int64]$nativeOutput
                additionalCeiling        = [int64]$raw.additionalCap
                totalObservedTokens      = [int64]$usedOutputTokens
                aggregateCeiling         = [int64]$ticket.budget.phaseAggregateCeiling
                excessVsAggregate        = [int64]$excessVsAggregate
                excessVsAdditional       = [int64]$excessVsAdditional
            }
        }
    }

    $classification =
        if ($null -ne $raw.stopReason -and "$($raw.stopReason)" -like '*context*') { 'CONTEXT_CAP' }
        elseif ("$($raw.stopReason)" -eq 'max_tokens' -or [int64]$raw.observedOutput -ge [int64]$raw.additionalCap) { 'OUTPUT_CAP' }
        elseif ($null -ne $raw.exit -and [int64]$raw.exit -ne 0) { 'EXIT_FAILURE' }
        else { 'SUCCESS' }

    $terminalReason = if ($null -ne $raw.stopReason -and -not [string]::IsNullOrWhiteSpace("$($raw.stopReason)")) { "$($raw.stopReason)" }
        elseif ($null -ne $raw.exit) { 'process_exit' }
        else { $null }

    $receipt = [PSCustomObject]@{
        schemaVersion   = 'OperationalRunReceipt/v1'
        runId           = $RunId
        taskId          = "$($ticket.id)"
        payloadSha256   = "$($ticket.payloadSha256)"
        destination     = 'Anthropic Claude'
        status          = 'AWAITING_CONTROLLER'
        attempt         = [int64]$Attempt
        sessionId       = "$($raw.session)"
        historyVerified = $false
        budget          = [PSCustomObject]@{
            maxOutputTokens   = [int64]$ticket.budget.phaseAggregateCeiling
            maxElapsedMs      = [int64]$MaxElapsedMs
            maxAttempts       = [int64]$MaxAttempts
            usedElapsedMs     = [int64]$usedElapsedMs
            usedOutputTokens  = [int64]$usedOutputTokens
            attemptsUsed      = [int64]$Attempt
            softFraction      = 0.75
        }
        provider        = [PSCustomObject]@{
            startIdentity  = $null
            sessionId      = "$($raw.session)"
            terminalReason = $terminalReason
            pid            = [int64]$raw.pid
        }
        artifact        = [PSCustomObject]@{
            complete = $false
            sha256   = $null
            path     = $null
        }
        updatedAt       = "$($raw.endUtc)"
        evidence        = [PSCustomObject]@{
            rawPath            = $rawFull
            rawSha256          = $rawSha
            ticketPath         = $ticketFull
            ticketSha256       = $ticketSha
            usagePath          = $usageFull
            usageSha256        = $usageSha
            nativeThinkingTokens = $thinking
        }
    }

    if ($optIn) {
        if ($classification -cne 'SUCCESS') { return & $fail 'provider classification is not SUCCESS' $rawSha $ticketSha }
        $startIdentity = if ($capEv.PSObject.Properties.Name -contains 'startIdentity') { $capEv.startIdentity } else { $basis.startIdentity }
        if ($startIdentity -isnot [string] -or [string]::IsNullOrWhiteSpace($startIdentity) -or -not [string]::Equals($startIdentity, [string]$raw.startUtc, [System.StringComparison]::Ordinal)) { return & $fail 'captured startIdentity does not equal raw.startUtc' $rawSha $ticketSha }
        $receipt.schemaVersion = 'OperationalRunReceipt/v2'
        $receipt.status = 'BLOCKED'
        $receipt.historyVerified = $false
        $receipt.provider.startIdentity = $startIdentity
        Add-Member -InputObject $receipt -NotePropertyName reviewedDisposition -NotePropertyValue ([PSCustomObject][ordered]@{
            schema                = 'ReviewedBlockedDisposition/v1'
            providerClassification = 'SUCCESS'
            evidence              = $capEv
            reviewSha256          = $cap.reviewSha256
            evidenceSha256        = $cap.evidenceSha256
        })
        if (-not (& $verifyFiveInputs)) { return & $fail 'evidence input changed before validation' $rawSha $ticketSha }
    }

    if ($PSBoundParameters.ContainsKey('CompletedNativeEvidence')) {
        $ev = $CompletedNativeEvidence
        if ($null -eq $ev) { return & $fail 'CompletedNativeEvidence is null' $rawSha $ticketSha }
        $evNames = @($ev.PSObject.Properties.Name)
        foreach ($k in @('pid','startIdentity','artifactPath')) {
            if ($evNames -notcontains $k) { return & $fail "CompletedNativeEvidence missing $k" $rawSha $ticketSha }
        }
        $evPid = $ev.pid
        if (($evPid -isnot [int] -and $evPid -isnot [long]) -or [int64]$evPid -le 0) { return & $fail 'CompletedNativeEvidence.pid invalid' $rawSha $ticketSha }
        if ($ev.startIdentity -isnot [string] -or [string]::IsNullOrWhiteSpace($ev.startIdentity)) { return & $fail 'CompletedNativeEvidence.startIdentity invalid' $rawSha $ticketSha }
        if ($ev.artifactPath -isnot [string] -or [string]::IsNullOrWhiteSpace($ev.artifactPath)) { return & $fail 'CompletedNativeEvidence.artifactPath invalid' $rawSha $ticketSha }
        if (-not ($raw.status -is [string] -and $raw.status -ceq 'TERMINAL')) { return & $fail 'raw status is not TERMINAL' $rawSha $ticketSha }
        if ($classification -cne 'SUCCESS') { return & $fail 'classification is not SUCCESS' $rawSha $ticketSha }
        if (($raw.exit -isnot [int] -and $raw.exit -isnot [long]) -or [int64]$raw.exit -ne 0) { return & $fail 'raw exit is not 0' $rawSha $ticketSha }
        if ($raw.startUtc -isnot [string] -or -not [string]::Equals($ev.startIdentity, $raw.startUtc, [System.StringComparison]::Ordinal)) { return & $fail 'startIdentity does not equal raw.startUtc' $rawSha $ticketSha }
        if (($raw.pid -isnot [int] -and $raw.pid -isnot [long]) -or [int64]$raw.pid -ne [int64]$evPid) { return & $fail 'evidence pid does not equal raw.pid' $rawSha $ticketSha }
        if (-not (Test-Path -LiteralPath $ev.artifactPath -PathType Leaf)) { return & $fail 'artifactPath is not an existing leaf' $rawSha $ticketSha }
        try {
            $evArtifactFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ev.artifactPath -ErrorAction Stop).ProviderPath)
            $evArtifactSha = (Get-FileHash -LiteralPath $evArtifactFull -Algorithm SHA256 -ErrorAction Stop).Hash
        } catch { return & $fail 'artifact resolve/hash failed' $rawSha $ticketSha }
        $evReceiptFull = [System.IO.Path]::GetFullPath($ReceiptPath)
        foreach ($other in @($rawFull, $ticketFull, $usageFull, $evReceiptFull)) {
            if ([string]::Equals($evArtifactFull, $other, [System.StringComparison]::OrdinalIgnoreCase)) { return & $fail 'artifactPath collides with input or receipt path' $rawSha $ticketSha }
        }
        $receipt.status = 'COMPLETED'
        $receipt.provider.startIdentity = $ev.startIdentity
        $receipt.artifact.complete = $true
        $receipt.artifact.path = $evArtifactFull
        $receipt.artifact.sha256 = $evArtifactSha
    }

    if (-not (Test-OperationalReceipt $receipt)) { return & $fail 'receipt failed validator' $rawSha $ticketSha }

    $receiptFull = [System.IO.Path]::GetFullPath($ReceiptPath)
    foreach ($existing in @($rawFull, $ticketFull, $usageFull)) {
        if ($receiptFull -eq $existing) { return & $fail 'receiptPath collides with input path' $rawSha $ticketSha }
    }
    if ($optIn) {
        foreach ($existing in $fiveInputPaths) {
            if ([string]::Equals($receiptFull, $existing, [System.StringComparison]::OrdinalIgnoreCase)) { return & $fail 'receiptPath collides with evidence input path' $rawSha $ticketSha }
        }
        if (-not (& $verifyFiveInputs)) { return & $fail 'evidence input changed before write' $rawSha $ticketSha }
    }

    $dir = Split-Path -Parent $receiptFull
    $tempPath = Join-Path $dir ("." + [System.IO.Path]::GetFileName($receiptFull) + ".tmp-" + [guid]::NewGuid().ToString('N'))
    try {
        $json = $receipt | ConvertTo-Json -Depth 10
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($tempPath, $json, $utf8NoBom)
        Move-Item -LiteralPath $tempPath -Destination $receiptFull -Force
    } catch {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
        return & $fail "failed to write receipt: $($_.Exception.Message)" $rawSha $ticketSha
    }

    $receiptSha256 = (Get-FileHash -LiteralPath $receiptFull -Algorithm SHA256).Hash

    return [PSCustomObject]@{
        valid          = $true
        receiptPath    = $receiptFull
        receiptSha256  = $receiptSha256
        classification = $classification
        receipt        = $receipt
    }
}