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
        [PSCustomObject]$CompletedNativeEvidence
    )

    $fail = { param($reason, $rawSha, $ticketSha) [PSCustomObject]@{ valid = $false; reason = $reason; rawSha256 = $rawSha; ticketSha256 = $ticketSha } }

    foreach ($p in @($RawPath, $TicketPath, $UsagePath)) {
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return & $fail "missing input: $p" $null $null }
    }
    if ($Attempt -lt 0 -or $MaxAttempts -le 0 -or $Attempt -gt $MaxAttempts) { return & $fail 'invalid attempt range' $null $null }
    if ($PriorElapsedMs -lt 0 -or $MaxElapsedMs -le 0) { return & $fail 'invalid elapsed bounds' $null $null }

    $rawFull = (Resolve-Path -LiteralPath $RawPath).ProviderPath
    $ticketFull = (Resolve-Path -LiteralPath $TicketPath).ProviderPath
    $usageFull = (Resolve-Path -LiteralPath $UsagePath).ProviderPath
    $rawSha = (Get-FileHash -LiteralPath $rawFull -Algorithm SHA256).Hash
    $ticketSha = (Get-FileHash -LiteralPath $ticketFull -Algorithm SHA256).Hash
    $usageSha = (Get-FileHash -LiteralPath $usageFull -Algorithm SHA256).Hash

    try { $raw = Get-Content -LiteralPath $rawFull -Raw | ConvertFrom-Json -DateKind String } catch { return & $fail 'raw not parseable JSON' $rawSha $ticketSha }
    try { $ticket = Get-Content -LiteralPath $ticketFull -Raw | ConvertFrom-Json } catch { return & $fail 'ticket not parseable JSON' $rawSha $ticketSha }

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
    try {
        foreach ($line in [System.IO.File]::ReadLines($usageFull)) {
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

    $usedElapsedMs = $PriorElapsedMs + [int64][math]::Ceiling(($endDt - $startDt).TotalMilliseconds)
    if ($usedElapsedMs -gt $MaxElapsedMs) { return & $fail 'elapsed budget exceeded' $rawSha $ticketSha }

    $usedOutputTokens = [int64]$raw.historicalOutput + $nativeOutput
    if ($usedOutputTokens -gt [int64]$ticket.budget.phaseAggregateCeiling) { return & $fail 'output budget exceeded ceiling' $rawSha $ticketSha }

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