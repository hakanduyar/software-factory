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

function Get-NativeStructuredOutputObservation {
    param($Evidence, [string]$RawPath, [string]$TicketPath, [string]$UsagePath, [string]$RunId, [int]$Attempt, $CompletedEvidence)
    # This argument belongs to the trusted controller, like the existing captured-facts pins.
    # It never accepts a profile asserted by a worker or inferred from stdout.
    $fields = @('schema','manifestPath','manifestSha256','terminalPath','terminalSha256','expectedModel')
    if ($Evidence -isnot [PSCustomObject]) { throw 'native evidence DTO invalid' }
    $props = @($Evidence.PSObject.Properties)
    if ($props.Count -ne $fields.Count) { throw 'native evidence DTO fields invalid' }
    foreach ($p in $props) {
        if ($p.MemberType -ne [Management.Automation.PSMemberTypes]::NoteProperty -or $fields -cnotcontains $p.Name -or $p.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($p.Value)) { throw 'native evidence DTO field invalid' }
    }
    if ($Evidence.schema -cne 'NativeStructuredOutputEvidence/v1') { throw 'native evidence schema invalid' }
    foreach ($pin in @($Evidence.manifestSha256, $Evidence.terminalSha256)) {
        if ($pin -cnotmatch '^[0-9a-f]{64}$') { throw 'native evidence pin invalid' }
    }
    . (Join-Path $PSScriptRoot 'metadata-completeness.ps1')
    . (Join-Path $PSScriptRoot 'managed-native-receipt.ps1')
    $capture = Get-ManagedNativeCapturedFacts -ManifestPath $Evidence.manifestPath -ExpectedManifestSha256 $Evidence.manifestSha256 -TerminalPath $Evidence.terminalPath -ExpectedTerminalSha256 $Evidence.terminalSha256 -TicketPath $TicketPath -RunId $RunId -Attempt $Attempt
    if (-not $capture.Valid) { throw ('native capture binding: ' + $capture.Code) }
    $f = $capture.Facts
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $hash = { param([byte[]]$b) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
    $rawFull = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $RawPath).ProviderPath)
    $usageFull = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $UsagePath).ProviderPath)
    if ((Get-Item -LiteralPath $rawFull).Length -gt 131072) { throw 'native raw input bound' }
    $rawBytes = [IO.File]::ReadAllBytes($rawFull)
    $rawText = $utf8.GetString($rawBytes)
    $usageSha = & $hash $f.StdoutBytes
    if ((Get-FileHash -LiteralPath $usageFull).Hash.ToLowerInvariant() -cne $usageSha) { throw 'native usage source hash mismatch' }
    $docs = [Collections.Generic.List[object]]::new()
    try {
        foreach ($text in @($utf8.GetString($f.ManifestBytes), $f.Manifest.requestCanonical, $utf8.GetString($f.TicketBytes), $utf8.GetString($f.TerminalBytes), $utf8.GetString($f.StartBytes), $rawText)) {
            $docs.Add((ConvertTo-StrictMetadataDocument -JsonText $text -MaxUtf8Bytes 131072))
        }
        $core = $docs[1].RootElement
        try { $descriptor = $core.GetProperty('nativeStructuredOutput') } catch { throw 'native profile descriptor missing' }
        if ($descriptor.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'native profile descriptor missing' }
        $dp = @($descriptor.EnumerateObject())
        if ($dp.Count -ne 2 -or @($dp.Name) -cnotcontains 'profileId' -or @($dp.Name) -cnotcontains 'schemaSha256') { throw 'native profile descriptor shape invalid' }
        $digest = 'fd655794f2298daf88877d652f94736ed2e74cf520b3278f694b141d492b8cfa'
        if ($descriptor.GetProperty('profileId').ValueKind -ne [Text.Json.JsonValueKind]::String -or $descriptor.GetProperty('profileId').GetString() -cne 'canonical8-v1') { throw 'native profile invalid' }
        if ($descriptor.GetProperty('schemaSha256').ValueKind -ne [Text.Json.JsonValueKind]::String -or $descriptor.GetProperty('schemaSha256').GetString() -cne $digest) { throw 'native schema digest invalid' }
        try { $ticketPin = $docs[2].RootElement.GetProperty('nativeOutputSchemaSha256') } catch { throw 'native ticket schema pin missing' }
        if ($ticketPin.ValueKind -ne [Text.Json.JsonValueKind]::String -or $ticketPin.GetString() -cne $digest) { throw 'native ticket schema pin invalid' }
        $argv = @($f.Core.arguments)
        $schemaIndices = @(); $modelIndices = @()
        for ($i = 0; $i -lt $argv.Count; $i++) {
            if ($argv[$i] -ceq '--json-schema') { $schemaIndices += $i }
            if ($argv[$i] -ceq '--model') { $modelIndices += $i }
        }
        if ($schemaIndices.Count -ne 1 -or $schemaIndices[0] + 1 -ge $argv.Count -or (& $hash $utf8.GetBytes($argv[$schemaIndices[0]+1])) -cne $digest) { throw 'native argv schema binding invalid' }
        if ($modelIndices.Count -ne 1 -or $modelIndices[0] + 1 -ge $argv.Count -or $argv[$modelIndices[0]+1] -cne $Evidence.expectedModel) { throw 'native model binding invalid' }
        $raw = $rawText | ConvertFrom-Json -DateKind String
        if ($raw.status -cne 'TERMINAL' -or $raw.session -cne $f.Ticket.sessionId -or $raw.pid -ne $f.Pid -or $raw.startUtc -cne $f.Terminal.startTimeUtc -or $raw.endUtc -cne $f.Terminal.endedUtc -or $raw.exit -ne 0) { throw 'native raw identity mismatch' }
        if ($CompletedEvidence.pid -ne $f.Pid -or $CompletedEvidence.startIdentity -cne $f.Terminal.startTimeUtc) { throw 'native completed identity mismatch' }
        $artifactFull = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $CompletedEvidence.artifactPath).ProviderPath)
        if ($f.ArtifactState -cne 'PRESENT' -or -not [string]::Equals($artifactFull, $f.ArtifactPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'native completed artifact binding mismatch' }
        $sourceText = $utf8.GetString($f.StdoutBytes)
        $lines = [Collections.Generic.List[string]]::new()
        $resultCount = 0; $modelCount = 0; $observation = $null; $lineStart = 0
        while ($lineStart -lt $sourceText.Length) {
            $lineEnd = $sourceText.IndexOf("`n", $lineStart)
            if ($lineEnd -lt 0) { $lineEnd = $sourceText.Length }
            $line = $sourceText.Substring($lineStart, $lineEnd - $lineStart)
            $jsonStart = $lineStart
            if ($lineStart -eq 0 -and $line.Length -gt 0 -and $line[0] -eq [char]0xFEFF) { $line = $line.Substring(1); $jsonStart++ }
            $lines.Add($line)
            if (-not [string]::IsNullOrWhiteSpace($line)) {
                $doc = ConvertTo-StrictMetadataDocument -JsonText $line -MaxUtf8Bytes 131072
                try {
                    $root = $doc.RootElement
                    if ($root.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'native stream event must be object' }
                    $type = $root.GetProperty('type').GetString()
                    # Ordinary stream_event envelopes carry message events; result must be top-level.
                    $event = $root
                    if ($type -ceq 'stream_event') { $event = $root.GetProperty('event'); $type = $event.GetProperty('type').GetString() }
                    if ($type -ceq 'message_start') {
                        $model = $event.GetProperty('message').GetProperty('model')
                        if ($model.ValueKind -ne [Text.Json.JsonValueKind]::String -or $model.GetString() -cne $Evidence.expectedModel) { throw 'native stream model mismatch' }
                        $modelCount++
                    }
                    if ($type -ceq 'result') {
                        $resultCount++
                        if ($root.GetProperty('type').GetString() -cne 'result') { throw 'native result envelope invalid' }
                        if ($root.GetProperty('subtype').GetString() -cne 'success' -or $root.GetProperty('is_error').ValueKind -ne [Text.Json.JsonValueKind]::False) { throw 'native result rejected or retry limit' }
                        if ($root.GetProperty('session_id').GetString() -cne $f.Ticket.sessionId) { throw 'native result session mismatch' }
                        $resultTokens = 0L
                        try { $resultUsage = $root.GetProperty('usage').GetProperty('output_tokens') } catch { throw 'native result usage.output_tokens missing' }
                        if ($resultUsage.ValueKind -ne [Text.Json.JsonValueKind]::Number -or -not $resultUsage.TryGetInt64([ref]$resultTokens) -or $resultTokens -lt 0 -or $resultTokens -ne $raw.observedOutput) { throw 'native result usage output_tokens mismatch' }
                        try { $value = $root.GetProperty('structured_output') } catch { throw 'native structured_output missing' }
                        if ($value.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'native structured_output must be object' }
                        $required = @('summary','changedPaths','commandsRun','validationResults','fingerprint','checkpointRef','blockers','recommendedNextAction')
                        $valueProps = @($value.EnumerateObject())
                        if ($valueProps.Count -ne $required.Count) { throw 'native structured_output exact keys required' }
                        foreach ($p in $valueProps) {
                            if ($required -cnotcontains $p.Name) { throw 'native structured_output unexpected key' }
                            if (@('summary','recommendedNextAction') -ccontains $p.Name) {
                                if ($p.Value.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw 'native structured_output string type invalid' }
                            } elseif (@('fingerprint','checkpointRef') -ccontains $p.Name) {
                                if ($p.Value.ValueKind -ne [Text.Json.JsonValueKind]::String -and $p.Value.ValueKind -ne [Text.Json.JsonValueKind]::Null) { throw 'native structured_output nullable string type invalid' }
                            } else {
                                if ($p.Value.ValueKind -ne [Text.Json.JsonValueKind]::Array) { throw 'native structured_output array type invalid' }
                                foreach ($item in $p.Value.EnumerateArray()) { if ($item.ValueKind -ne [Text.Json.JsonValueKind]::String) { throw 'native structured_output array item type invalid' } }
                            }
                        }
                        $valueText = $value.GetRawText()
                        $valueBytes = $utf8.GetBytes($valueText)
                        if ($valueBytes.Length -gt 2048) { throw 'native structured_output exceeds 2048 UTF8 bytes' }
                        # JsonProperty.ToString preserves its original key/colon/value whitespace.
                        # Walk root properties in order so an equal nested value cannot steal the offset.
                        $propertyCursor = 0; $valueOffset = -1
                        foreach ($p in $root.EnumerateObject()) {
                            $propertyText = $p.ToString()
                            $propertyAt = $line.IndexOf($propertyText, $propertyCursor, [StringComparison]::Ordinal)
                            if ($propertyAt -lt 0) { throw 'native source range unavailable' }
                            if ($p.Name -ceq 'structured_output') { $valueOffset = $propertyAt + $propertyText.Length - $valueText.Length; break }
                            $propertyCursor = $propertyAt + $propertyText.Length
                        }
                        if ($valueOffset -lt 0) { throw 'native source range unavailable' }
                        $observation = [pscustomobject]@{
                            value = ($valueText | ConvertFrom-Json -DateKind String -NoEnumerate)
                            rawText = $valueText; utf8Bytes = $valueBytes.Length
                            sourceOffset = [long]$utf8.GetByteCount($sourceText.Substring(0, $jsonStart + $valueOffset))
                            sourceLength = $valueBytes.Length; sourceSha256 = $usageSha; valueSha256 = (& $hash $valueBytes)
                        }
                    }
                } finally { $doc.Dispose() }
            }
            $lineStart = $lineEnd + 1
        }
        if ($resultCount -ne 1 -or $modelCount -lt 1 -or $null -eq $observation) { throw 'native stream requires unique result and model evidence' }
        return [pscustomobject]@{ observation = $observation; facts = $f; raw = $raw; rawFull = $rawFull; usageFull = $usageFull; rawSha256 = (& $hash $rawBytes); usageSha256 = $usageSha; usageLines = $lines.ToArray() }
    } finally { foreach ($doc in $docs) { $doc.Dispose() } }
}

function ConvertTo-ObserveOnlyPendingReceipt {
    # Explicit OBSERVE_ONLY branch: shared authenticated pending-accounting facts -> OperationalRunReceipt/v3 (AWAITING_CONTROLLER only).
    # Grants no completion, ACK or dispatch; never runs the whole-stream parser or numeric output-limit casts.
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [Parameter(Mandatory)][string]$TicketPath,
        [Parameter(Mandatory)][string]$UsagePath,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][int]$Attempt,
        [Parameter(Mandatory)][int]$MaxAttempts,
        [Parameter(Mandatory)][long]$PriorElapsedMs,
        [Parameter(Mandatory)][AllowNull()][Nullable[long]]$MaxElapsedMs,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [AllowNull()][object]$Evidence,
        [Parameter(Mandatory)][bool]$Conflict
    )
    $fail = { param($reason) [PSCustomObject]@{ valid = $false; reason = $reason; rawSha256 = $null; ticketSha256 = $null } }
    $ord = [System.StringComparison]::OrdinalIgnoreCase
    $rp = [System.IO.FileAttributes]::ReparsePoint
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $sha = { param([byte[]]$b) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
    $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
    if ($Conflict) { return & $fail 'observe-only accounting evidence incompatible with other evidence parameters' }
    if ($null -eq $Evidence) { return & $fail 'ObserveOnlyAccountingEvidence is null' }
    $temp = $null
    try {
        # Trusted stage sibling only; every identity/count below comes from the authenticated facts, never from caller numbers.
        . (Join-Path $PSScriptRoot 'managed-native-receipt.ps1')
        $vf = Get-ManagedObservePendingAccountingFacts -Evidence $Evidence
        if (($null -eq $vf) -or ($vf.Valid -isnot [bool]) -or (-not $vf.Valid) -or ($null -eq $vf.Facts)) {
            $vc = if (($null -ne $vf) -and ($vf.PSObject.Properties['Code']) -and ($vf.Code -is [string])) { $vf.Code } else { 'UNKNOWN' }
            return & $fail ('observe-only pending accounting refused: ' + $vc)
        }
        $f = $vf.Facts
        $id = $f.identity; $lim = $f.limits; $acct = $f.accounting

        foreach ($p in @($RawPath, $TicketPath, $UsagePath)) {
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return & $fail "missing input: $p" }
        }
        if (($Attempt -lt 1) -or ($MaxAttempts -le 0) -or ($Attempt -gt $MaxAttempts)) { return & $fail 'invalid attempt range' }
        if (-not [string]::Equals($RunId, [string]$id.runId, [System.StringComparison]::Ordinal)) { return & $fail 'runId does not match authenticated capture' }
        if (([long]$Attempt -ne [long]$id.attempt) -or ([long]$MaxAttempts -ne [long]$lim.maxAttempts)) { return & $fail 'attempt or maxAttempts does not match authenticated capture' }
        if ((($null -eq $MaxElapsedMs) -ne ($null -eq $lim.maxElapsedMs)) -or (($null -ne $lim.maxElapsedMs) -and ([long]$MaxElapsedMs -ne [long]$lim.maxElapsedMs)) -or ([long]$PriorElapsedMs -ne [long]$lim.priorElapsedMs)) { return & $fail 'elapsed limits do not match authenticated capture' }
        $ticketFull = [System.IO.Path]::GetFullPath($TicketPath)
        $usageFull = [System.IO.Path]::GetFullPath($UsagePath)
        $rawFull = [System.IO.Path]::GetFullPath($RawPath)
        $receiptFull = [System.IO.Path]::GetFullPath($ReceiptPath)
        if (-not [string]::Equals($ticketFull, [string]$f.references.ticket.path, $ord)) { return & $fail 'TicketPath is not the authenticated ticket path' }
        # The usage source must be the actual verified STDOUT path, not a byte-equivalent copy.
        if (-not [string]::Equals($usageFull, [string]$f.stdout.path, $ord)) { return & $fail 'UsagePath is not the verified STDOUT path' }
        foreach ($ip in @($f.inputPaths) + @($rawFull)) {
            if ([string]::Equals($receiptFull, [System.IO.Path]::GetFullPath([string]$ip), $ord)) { return & $fail 'receiptPath collides with evidence path' }
        }
        if ([string]::Equals($rawFull, $usageFull, $ord) -or [string]::Equals($rawFull, $ticketFull, $ord)) { return & $fail 'raw path collides with evidence path' }

        # Caller raw DTO is cross-checked only (shared with the v3 validator); it supplies no number that reaches the receipt.
        $rv = Test-ManagedObservePendingRawDto -RawPath $rawFull -ExpectedSha256 $null -Facts $f
        if (($null -eq $rv) -or ($rv.Valid -isnot [bool]) -or (-not $rv.Valid)) { return & $fail ('raw cross-check refused: ' + $(if ($null -ne $rv) { $rv.Code } else { 'UNKNOWN' })) }
        $rawSha = $rv.Sha256

        $receipt = [PSCustomObject]([ordered]@{
            schemaVersion   = 'OperationalRunReceipt/v3'
            runId           = [string]$id.runId
            taskId          = [string]$id.taskId
            payloadSha256   = [string]$id.payloadSha256
            destination     = 'Anthropic Claude'
            status          = 'AWAITING_CONTROLLER'
            attempt         = [int64]$id.attempt
            sessionId       = [string]$id.sessionId
            historyVerified = $false
            budget          = [PSCustomObject]([ordered]@{
                maxOutputTokens  = $null
                maxElapsedMs     = $(if ($null -eq $lim.maxElapsedMs) { $null } else { [int64]$lim.maxElapsedMs })
                maxAttempts      = [int64]$lim.maxAttempts
                usedElapsedMs    = [int64]$f.timing.usedElapsedMs
                usedOutputTokens = [int64]$acct.usedOutputTokens
                attemptsUsed     = [int64]$id.attempt
                softFraction     = $null
            })
            provider        = [PSCustomObject]([ordered]@{
                startIdentity  = $null
                sessionId      = [string]$id.sessionId
                terminalReason = [string]$id.terminalReason
                pid            = [int64]$id.pid
            })
            artifact        = [PSCustomObject]([ordered]@{ complete = $false; sha256 = $null; path = $null })
            updatedAt       = [string]$f.timing.endedUtc
            evidence        = [PSCustomObject]([ordered]@{
                rawPath              = $rawFull
                rawSha256            = $rawSha
                ticketPath           = [string]$f.references.ticket.path
                ticketSha256         = [string]$f.references.ticket.verifiedSha256
                usagePath            = [string]$f.stdout.path
                usageSha256          = [string]$f.stdout.sha256
                nativeThinkingTokens = $null
            })
            outputStopMode                   = 'OBSERVE_ONLY'
            observePendingAccountingEvidence = $f.evidence
            observePendingAccounting         = $acct
        })

        # The strict validator independently reruns the shared verifier, so it also proves capture/predecessor stability up to here.
        if (-not (Test-OperationalReceipt $receipt)) { return & $fail 'receipt failed validator' }
        $rv2 = Test-ManagedObservePendingRawDto -RawPath $rawFull -ExpectedSha256 $rawSha -Facts $f
        if (($null -eq $rv2) -or ($rv2.Valid -isnot [bool]) -or (-not $rv2.Valid)) { return & $fail 'raw input changed before write' }

        $json = $receipt | ConvertTo-Json -Depth 10
        $bytes = $utf8.GetBytes($json)
        $receiptSha = & $sha $bytes
        $dir = [System.IO.Path]::GetDirectoryName($receiptFull)
        $dirItem = if ($dir) { Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue } else { $null }
        if (($null -eq $dirItem) -or (-not $dirItem.PSIsContainer) -or (($dirItem.Attributes -band $rp) -ne 0)) { return & $fail 'receipt parent directory invalid' }
        $idempotent = $false
        if ([System.IO.Directory]::Exists($receiptFull)) { return & $fail 'receipt path is a directory' }
        if ([System.IO.File]::Exists($receiptFull)) {
            $exItem = Get-Item -LiteralPath $receiptFull -Force
            if (($exItem.Attributes -band $rp) -ne 0) { return & $fail 'existing receipt is a reparse point' }
            $ex = [System.IO.File]::ReadAllBytes($receiptFull)
            if ((& $sha $ex) -cne $receiptSha) { return & $fail 'receipt output exists with different content' }
            $idempotent = $true
        }
        else {
            $temp = Join-Path $dir ('.' + [System.IO.Path]::GetFileName($receiptFull) + '.tmp-' + [guid]::NewGuid().ToString('N'))
            $fs = [System.IO.FileStream]::new($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
            # Move without overwrite: a concurrently created different output is never replaced.
            [System.IO.File]::Move($temp, $receiptFull)
            $temp = $null
            $back = [System.IO.File]::ReadAllBytes($receiptFull)
            if ((& $sha $back) -cne $receiptSha) { return & $fail 'receipt readback mismatch' }
        }
        return [PSCustomObject]@{
            valid          = $true
            receiptPath    = $receiptFull
            receiptSha256  = $receiptSha
            classification = 'OBSERVE_ONLY_PENDING'
            idempotent     = $idempotent
            receipt        = $receipt
        }
    }
    catch { return & $fail ('observe-only pending receipt failed: ' + $_.Exception.Message) }
    finally { if (($null -ne $temp) -and [System.IO.File]::Exists($temp)) { try { [System.IO.File]::Delete($temp) } catch { } } }
}

function ConvertTo-ObserveOnlyReviewedCompletionReceipt {
    # Explicit OBSERVE_ONLY reviewed-completion branch: shared authenticated facts -> OperationalRunReceipt/v4 (COMPLETED only).
    # The completion proof is derived internally from the registered records; no caller flag, handler or SDK success establishes it.
    # Grants no dispatch and no outbox publication; never runs the whole-stream parser or numeric output-limit casts.
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [Parameter(Mandatory)][string]$TicketPath,
        [Parameter(Mandatory)][string]$UsagePath,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][int]$Attempt,
        [Parameter(Mandatory)][int]$MaxAttempts,
        [Parameter(Mandatory)][long]$PriorElapsedMs,
        [Parameter(Mandatory)][AllowNull()][Nullable[long]]$MaxElapsedMs,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [AllowNull()][object]$Evidence,
        [Parameter(Mandatory)][bool]$Conflict
    )
    $fail = { param($reason) [PSCustomObject]@{ valid = $false; reason = $reason; rawSha256 = $null; ticketSha256 = $null } }
    $ord = [System.StringComparison]::OrdinalIgnoreCase
    $rp = [System.IO.FileAttributes]::ReparsePoint
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $sha = { param([byte[]]$b) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
    if ($Conflict) { return & $fail 'observe-only reviewed completion evidence incompatible with other evidence parameters' }
    if ($null -eq $Evidence) { return & $fail 'ObserveOnlyReviewedCompletionEvidence is null' }
    $temp = $null
    try {
        . (Join-Path $PSScriptRoot 'managed-native-receipt.ps1')
        $vf = Get-ManagedObserveReviewedCompletionFacts -Evidence $Evidence
        if (($null -eq $vf) -or ($vf.Valid -isnot [bool]) -or (-not $vf.Valid) -or ($null -eq $vf.Facts)) {
            $vc = if (($null -ne $vf) -and ($vf.PSObject.Properties['Code']) -and ($vf.Code -is [string])) { $vf.Code } else { 'UNKNOWN' }
            return & $fail ('observe-only reviewed completion refused: ' + $vc)
        }
        $f = $vf.Facts
        $p = $f.pending
        $pr = $f.proof
        $id = $p.identity; $lim = $p.limits; $acct = $p.accounting

        foreach ($x in @($RawPath, $TicketPath, $UsagePath)) {
            if (-not (Test-Path -LiteralPath $x -PathType Leaf)) { return & $fail "missing input: $x" }
        }
        if (($Attempt -lt 1) -or ($MaxAttempts -le 0) -or ($Attempt -gt $MaxAttempts)) { return & $fail 'invalid attempt range' }
        if (-not [string]::Equals($RunId, [string]$id.runId, [System.StringComparison]::Ordinal)) { return & $fail 'runId does not match authenticated capture' }
        if (([long]$Attempt -ne [long]$id.attempt) -or ([long]$MaxAttempts -ne [long]$lim.maxAttempts)) { return & $fail 'attempt or maxAttempts does not match authenticated capture' }
        if ((($null -eq $MaxElapsedMs) -ne ($null -eq $lim.maxElapsedMs)) -or (($null -ne $lim.maxElapsedMs) -and ([long]$MaxElapsedMs -ne [long]$lim.maxElapsedMs)) -or ([long]$PriorElapsedMs -ne [long]$lim.priorElapsedMs)) { return & $fail 'elapsed limits do not match authenticated capture' }
        $ticketFull = [System.IO.Path]::GetFullPath($TicketPath)
        $usageFull = [System.IO.Path]::GetFullPath($UsagePath)
        $rawFull = [System.IO.Path]::GetFullPath($RawPath)
        $receiptFull = [System.IO.Path]::GetFullPath($ReceiptPath)
        if (-not [string]::Equals($ticketFull, [string]$p.references.ticket.path, $ord)) { return & $fail 'TicketPath is not the authenticated ticket path' }
        if (-not [string]::Equals($usageFull, [string]$p.stdout.path, $ord)) { return & $fail 'UsagePath is not the verified STDOUT path' }
        foreach ($ip in @($f.inputPaths) + @($rawFull)) {
            if ([string]::Equals($receiptFull, [System.IO.Path]::GetFullPath([string]$ip), $ord)) { return & $fail 'receiptPath collides with evidence path' }
        }
        if ([string]::Equals($rawFull, $usageFull, $ord) -or [string]::Equals($rawFull, $ticketFull, $ord)) { return & $fail 'raw path collides with evidence path' }

        # Caller raw DTO is cross-checked only; it supplies no number that reaches the receipt.
        $rv = Test-ManagedObserveReviewedRawDto -RawPath $rawFull -ExpectedSha256 $null -Facts $f
        if (($null -eq $rv) -or ($rv.Valid -isnot [bool]) -or (-not $rv.Valid)) { return & $fail ('raw cross-check refused: ' + $(if ($null -ne $rv) { $rv.Code } else { 'UNKNOWN' })) }
        $rawSha = $rv.Sha256

        $receipt = [PSCustomObject]([ordered]@{
            schemaVersion   = 'OperationalRunReceipt/v4'
            runId           = [string]$id.runId
            taskId          = [string]$id.taskId
            payloadSha256   = [string]$id.payloadSha256
            destination     = 'Anthropic Claude'
            status          = 'COMPLETED'
            attempt         = [int64]$id.attempt
            sessionId       = [string]$id.sessionId
            historyVerified = $false
            budget          = [PSCustomObject]([ordered]@{
                maxOutputTokens  = $null
                maxElapsedMs     = $(if ($null -eq $lim.maxElapsedMs) { $null } else { [int64]$lim.maxElapsedMs })
                maxAttempts      = [int64]$lim.maxAttempts
                usedElapsedMs    = [int64]$p.timing.usedElapsedMs
                usedOutputTokens = [int64]$acct.usedOutputTokens
                attemptsUsed     = [int64]$id.attempt
                softFraction     = $null
            })
            provider        = [PSCustomObject]([ordered]@{
                startIdentity  = [string]$pr.startIdentity
                sessionId      = [string]$id.sessionId
                terminalReason = [string]$id.terminalReason
                pid            = [int64]$id.pid
            })
            artifact        = [PSCustomObject]([ordered]@{ complete = $true; sha256 = [string]$pr.candidateSha256; path = [string]$pr.candidatePath })
            updatedAt       = [string]$p.timing.endedUtc
            evidence        = [PSCustomObject]([ordered]@{
                rawPath              = $rawFull
                rawSha256            = $rawSha
                ticketPath           = [string]$p.references.ticket.path
                ticketSha256         = [string]$p.references.ticket.verifiedSha256
                usagePath            = [string]$p.stdout.path
                usageSha256          = [string]$p.stdout.sha256
                nativeThinkingTokens = $null
            })
            outputStopMode                    = 'OBSERVE_ONLY'
            observeReviewedCompletionEvidence = $f.evidence
            observePendingAccounting          = $acct
            observeReviewedCompletion         = $pr
        })

        # The strict public validator independently reauthenticates the whole proof, so it also proves record/capture stability up to here.
        if (-not (Test-OperationalReceipt $receipt)) { return & $fail 'receipt failed validator' }
        $rv2 = Test-ManagedObserveReviewedRawDto -RawPath $rawFull -ExpectedSha256 $rawSha -Facts $f
        if (($null -eq $rv2) -or ($rv2.Valid -isnot [bool]) -or (-not $rv2.Valid)) { return & $fail 'raw input changed before write' }

        $json = $receipt | ConvertTo-Json -Depth 10
        $bytes = $utf8.GetBytes($json)
        $receiptSha = & $sha $bytes
        $dir = [System.IO.Path]::GetDirectoryName($receiptFull)
        $dirItem = if ($dir) { Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue } else { $null }
        if (($null -eq $dirItem) -or (-not $dirItem.PSIsContainer) -or (($dirItem.Attributes -band $rp) -ne 0)) { return & $fail 'receipt parent directory invalid' }
        $idempotent = $false
        if ([System.IO.Directory]::Exists($receiptFull)) { return & $fail 'receipt path is a directory' }
        if ([System.IO.File]::Exists($receiptFull)) {
            $exItem = Get-Item -LiteralPath $receiptFull -Force
            if (($exItem.Attributes -band $rp) -ne 0) { return & $fail 'existing receipt is a reparse point' }
            $ex = [System.IO.File]::ReadAllBytes($receiptFull)
            if ((& $sha $ex) -cne $receiptSha) { return & $fail 'receipt output exists with different content' }
            $idempotent = $true
        }
        else {
            $temp = Join-Path $dir ('.' + [System.IO.Path]::GetFileName($receiptFull) + '.tmp-' + [guid]::NewGuid().ToString('N'))
            $fs = [System.IO.FileStream]::new($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
            # Move without overwrite: a concurrently created different output is never replaced.
            [System.IO.File]::Move($temp, $receiptFull)
            $temp = $null
            $back = [System.IO.File]::ReadAllBytes($receiptFull)
            if ((& $sha $back) -cne $receiptSha) { return & $fail 'receipt readback mismatch' }
        }
        return [PSCustomObject]@{
            valid          = $true
            receiptPath    = $receiptFull
            receiptSha256  = $receiptSha
            classification = 'OBSERVE_ONLY_REVIEWED_COMPLETION'
            idempotent     = $idempotent
            receipt        = $receipt
        }
    }
    catch { return & $fail ('observe-only reviewed completion receipt failed: ' + $_.Exception.Message) }
    finally { if (($null -ne $temp) -and [System.IO.File]::Exists($temp)) { try { [System.IO.File]::Delete($temp) } catch { } } }
}

function ConvertTo-ObserveOnlyFailedTransportReceipt {
    # Explicit OBSERVE_ONLY failed-transport branch: shared authenticated failed-transport facts -> OperationalRunReceipt/v5 (FAILED only).
    # HUMAN-SELECTED narrow disposition: preserves the actual DEADLINE failure and the last verified parent total; current and cumulative counts stay
    # UNKNOWN (null, never 0). Grants no completion, no dispatch, no retry and no successor; never runs the whole-stream parser or numeric output-limit casts.
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
        [AllowNull()][object]$Evidence,
        [Parameter(Mandatory)][bool]$Conflict
    )
    $fail = { param($reason) [PSCustomObject]@{ valid = $false; reason = $reason; rawSha256 = $null; ticketSha256 = $null } }
    $ord = [System.StringComparison]::OrdinalIgnoreCase
    $rp = [System.IO.FileAttributes]::ReparsePoint
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $sha = { param([byte[]]$b) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
    if ($Conflict) { return & $fail 'observe-only failed transport evidence incompatible with other evidence parameters' }
    if ($null -eq $Evidence) { return & $fail 'ObserveOnlyFailedTransportEvidence is null' }
    $temp = $null
    try {
        . (Join-Path $PSScriptRoot 'managed-native-receipt.ps1')
        $vf = Get-ManagedObserveFailedTransportFacts -Evidence $Evidence
        if (($null -eq $vf) -or ($vf.Valid -isnot [bool]) -or (-not $vf.Valid) -or ($null -eq $vf.Facts)) {
            $vc = if (($null -ne $vf) -and ($vf.PSObject.Properties['Code']) -and ($vf.Code -is [string])) { $vf.Code } else { 'UNKNOWN' }
            return & $fail ('observe-only failed transport refused: ' + $vc)
        }
        $f = $vf.Facts
        $id = $f.identity; $lim = $f.limits; $acct = $f.accounting

        foreach ($x in @($RawPath, $TicketPath, $UsagePath)) {
            if (-not (Test-Path -LiteralPath $x -PathType Leaf)) { return & $fail "missing input: $x" }
        }
        if (($Attempt -lt 1) -or ($MaxAttempts -le 0) -or ($Attempt -gt $MaxAttempts)) { return & $fail 'invalid attempt range' }
        if (-not [string]::Equals($RunId, [string]$id.runId, [System.StringComparison]::Ordinal)) { return & $fail 'runId does not match authenticated capture' }
        if (([long]$Attempt -ne [long]$id.attempt) -or ([long]$MaxAttempts -ne [long]$lim.maxAttempts)) { return & $fail 'attempt or maxAttempts does not match authenticated capture' }
        if (([long]$MaxElapsedMs -ne [long]$lim.maxElapsedMs) -or ([long]$PriorElapsedMs -ne [long]$lim.priorElapsedMs)) { return & $fail 'elapsed limits do not match authenticated capture' }
        $ticketFull = [System.IO.Path]::GetFullPath($TicketPath)
        $usageFull = [System.IO.Path]::GetFullPath($UsagePath)
        $rawFull = [System.IO.Path]::GetFullPath($RawPath)
        $receiptFull = [System.IO.Path]::GetFullPath($ReceiptPath)
        if (-not [string]::Equals($ticketFull, [string]$acct.references.ticket.path, $ord)) { return & $fail 'TicketPath is not the authenticated ticket path' }
        # The usage source must be the actual verified STDOUT path, not a byte-equivalent copy.
        if (-not [string]::Equals($usageFull, [string]$f.stdout.path, $ord)) { return & $fail 'UsagePath is not the verified STDOUT path' }
        foreach ($ip in @($f.inputPaths) + @($rawFull)) {
            if ([string]::Equals($receiptFull, [System.IO.Path]::GetFullPath([string]$ip), $ord)) { return & $fail 'receiptPath collides with evidence path' }
        }
        if ([string]::Equals($rawFull, $usageFull, $ord) -or [string]::Equals($rawFull, $ticketFull, $ord)) { return & $fail 'raw path collides with evidence path' }
        foreach ($ip in @($f.inputPaths)) {
            if ([string]::Equals($rawFull, [System.IO.Path]::GetFullPath([string]$ip), $ord)) { return & $fail 'raw path collides with evidence path' }
        }

        # Caller raw DTO is cross-checked only (re-read and bound to the derived facts); it supplies no number that reaches the receipt.
        $rv = Test-ManagedObserveFailedTransportRawDto -RawPath $rawFull -ExpectedSha256 $null -Facts $f
        if (($null -eq $rv) -or ($rv.Valid -isnot [bool]) -or (-not $rv.Valid)) { return & $fail ('raw cross-check refused: ' + $(if ($null -ne $rv) { $rv.Code } else { 'UNKNOWN' })) }
        $rawSha = $rv.Sha256

        $receipt = [PSCustomObject]([ordered]@{
            schemaVersion   = 'OperationalRunReceipt/v5'
            runId           = [string]$id.runId
            taskId          = [string]$id.taskId
            payloadSha256   = [string]$id.payloadSha256
            destination     = 'Anthropic Claude'
            status          = 'FAILED'
            attempt         = [int64]$id.attempt
            sessionId       = [string]$id.sessionId
            historyVerified = $false
            budget          = [PSCustomObject]([ordered]@{
                maxOutputTokens  = $null
                maxElapsedMs     = [int64]$lim.maxElapsedMs
                maxAttempts      = [int64]$lim.maxAttempts
                usedElapsedMs    = [int64]$f.timing.usedElapsedMs
                usedOutputTokens = $null
                attemptsUsed     = [int64]$id.attempt
                softFraction     = $null
            })
            provider        = [PSCustomObject]([ordered]@{
                startIdentity  = [string]$id.startIdentity
                sessionId      = [string]$id.sessionId
                terminalReason = [string]$id.terminalReason
                pid            = [int64]$id.pid
            })
            artifact        = [PSCustomObject]([ordered]@{ complete = $false; sha256 = $null; path = $null })
            updatedAt       = [string]$f.timing.endedUtc
            evidence        = [PSCustomObject]([ordered]@{
                rawPath              = $rawFull
                rawSha256            = $rawSha
                ticketPath           = [string]$acct.references.ticket.path
                ticketSha256         = [string]$acct.references.ticket.verifiedSha256
                usagePath            = [string]$f.stdout.path
                usageSha256          = [string]$f.stdout.sha256
                nativeThinkingTokens = $null
            })
            outputStopMode                   = 'OBSERVE_ONLY'
            observeFailedTransportEvidence   = $f.evidence
            observeFailedTransportAccounting = $acct
            observeFailedTransport           = $f.proof
        })

        # The strict public validator independently reauthenticates the whole proof (parent, capture, registration, claim, ACK, raw DTO).
        if (-not (Test-OperationalReceipt $receipt)) { return & $fail 'receipt failed validator' }

        # Recapture immediately before the write: the facts rederived from scratch and the raw input must be unchanged.
        $vf2 = Get-ManagedObserveFailedTransportFacts -Evidence $Evidence
        if (($null -eq $vf2) -or ($vf2.Valid -isnot [bool]) -or (-not $vf2.Valid) -or ($null -eq $vf2.Facts)) { return & $fail 'failed transport evidence changed before write' }
        if ((ConvertTo-Json -InputObject $vf2.Facts -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $f -Depth 12 -Compress)) { return & $fail 'failed transport evidence changed before write' }
        $rv2 = Test-ManagedObserveFailedTransportRawDto -RawPath $rawFull -ExpectedSha256 $rawSha -Facts $f
        if (($null -eq $rv2) -or ($rv2.Valid -isnot [bool]) -or (-not $rv2.Valid)) { return & $fail 'raw input changed before write' }

        $json = $receipt | ConvertTo-Json -Depth 12
        $bytes = $utf8.GetBytes($json)
        $receiptSha = & $sha $bytes
        $dir = [System.IO.Path]::GetDirectoryName($receiptFull)
        $dirItem = if ($dir) { Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue } else { $null }
        if (($null -eq $dirItem) -or (-not $dirItem.PSIsContainer) -or (($dirItem.Attributes -band $rp) -ne 0)) { return & $fail 'receipt parent directory invalid' }
        # Only a NEW owned output is ever created; an existing path (any content) is never read as success and never overwritten.
        if ([System.IO.Directory]::Exists($receiptFull) -or [System.IO.File]::Exists($receiptFull) -or ($null -ne (Get-Item -LiteralPath $receiptFull -Force -ErrorAction SilentlyContinue))) { return & $fail 'receipt output already exists' }
        $temp = Join-Path $dir ('.' + [System.IO.Path]::GetFileName($receiptFull) + '.tmp-' + [guid]::NewGuid().ToString('N'))
        $fs = [System.IO.FileStream]::new($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
        # Move without overwrite: a concurrently created output is never replaced.
        [System.IO.File]::Move($temp, $receiptFull)
        $temp = $null
        $back = [System.IO.File]::ReadAllBytes($receiptFull)
        if ((& $sha $back) -cne $receiptSha) { return & $fail 'receipt readback mismatch' }
        return [PSCustomObject]@{
            valid          = $true
            receiptPath    = $receiptFull
            receiptSha256  = $receiptSha
            classification = 'OBSERVE_ONLY_FAILED_TRANSPORT'
            idempotent     = $false
            receipt        = $receipt
        }
    }
    catch { return & $fail ('observe-only failed transport receipt failed: ' + $_.Exception.Message) }
    finally { if (($null -ne $temp) -and [System.IO.File]::Exists($temp)) { try { [System.IO.File]::Delete($temp) } catch { } } }
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
        [Parameter(Mandatory)][AllowNull()][Nullable[long]]$MaxElapsedMs,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [PSCustomObject]$CompletedNativeEvidence,
        [AllowNull()][object]$ReviewedBlockedEvidence,
        [AllowNull()][object]$ExpectedBlockedReview,
        [AllowNull()][object]$NativeStructuredOutputEvidence,
        [AllowNull()][object]$AggregateAdvisoryEvidence,
        [AllowNull()][object]$ObserveOnlyAccountingEvidence,
        [AllowNull()][object]$ObserveOnlyReviewedCompletionEvidence,
        [AllowNull()][object]$ObserveOnlyFailedTransportEvidence
    )

    $fail = { param($reason, $rawSha, $ticketSha) [PSCustomObject]@{ valid = $false; reason = $reason; rawSha256 = $rawSha; ticketSha256 = $ticketSha } }
    if ($PSBoundParameters.ContainsKey('ObserveOnlyFailedTransportEvidence')) {
        # Explicit opt-in; mutually exclusive with every other observe-only and legacy evidence input. Checked first so a combination can never
        # fall through to another branch. Absence leaves every branch below untouched.
        $ftConflict = $PSBoundParameters.ContainsKey('ObserveOnlyReviewedCompletionEvidence') -or $PSBoundParameters.ContainsKey('ObserveOnlyAccountingEvidence') -or $PSBoundParameters.ContainsKey('CompletedNativeEvidence') -or $PSBoundParameters.ContainsKey('ReviewedBlockedEvidence') -or $PSBoundParameters.ContainsKey('ExpectedBlockedReview') -or $PSBoundParameters.ContainsKey('NativeStructuredOutputEvidence') -or $PSBoundParameters.ContainsKey('AggregateAdvisoryEvidence')
        return ConvertTo-ObserveOnlyFailedTransportReceipt -RawPath $RawPath -TicketPath $TicketPath -UsagePath $UsagePath -RunId $RunId -Attempt $Attempt -MaxAttempts $MaxAttempts -PriorElapsedMs $PriorElapsedMs -MaxElapsedMs $MaxElapsedMs -ReceiptPath $ReceiptPath -Evidence $ObserveOnlyFailedTransportEvidence -Conflict $ftConflict
    }
    if ($PSBoundParameters.ContainsKey('ObserveOnlyReviewedCompletionEvidence')) {
        # Explicit opt-in; mutually exclusive with pending accounting and every legacy evidence input. Checked first so a combination can
        # never fall through to the pending branch. Absence leaves every branch below untouched.
        $cmpConflict = $PSBoundParameters.ContainsKey('ObserveOnlyAccountingEvidence') -or $PSBoundParameters.ContainsKey('CompletedNativeEvidence') -or $PSBoundParameters.ContainsKey('ReviewedBlockedEvidence') -or $PSBoundParameters.ContainsKey('ExpectedBlockedReview') -or $PSBoundParameters.ContainsKey('NativeStructuredOutputEvidence') -or $PSBoundParameters.ContainsKey('AggregateAdvisoryEvidence')
        return ConvertTo-ObserveOnlyReviewedCompletionReceipt -RawPath $RawPath -TicketPath $TicketPath -UsagePath $UsagePath -RunId $RunId -Attempt $Attempt -MaxAttempts $MaxAttempts -PriorElapsedMs $PriorElapsedMs -MaxElapsedMs $MaxElapsedMs -ReceiptPath $ReceiptPath -Evidence $ObserveOnlyReviewedCompletionEvidence -Conflict $cmpConflict
    }
    if ($PSBoundParameters.ContainsKey('ObserveOnlyAccountingEvidence')) {
        # Explicit opt-in; mutually exclusive with every legacy evidence input. Absence leaves all branches below untouched.
        $obsConflict = $PSBoundParameters.ContainsKey('CompletedNativeEvidence') -or $PSBoundParameters.ContainsKey('ReviewedBlockedEvidence') -or $PSBoundParameters.ContainsKey('ExpectedBlockedReview') -or $PSBoundParameters.ContainsKey('NativeStructuredOutputEvidence') -or $PSBoundParameters.ContainsKey('AggregateAdvisoryEvidence')
        return ConvertTo-ObserveOnlyPendingReceipt -RawPath $RawPath -TicketPath $TicketPath -UsagePath $UsagePath -RunId $RunId -Attempt $Attempt -MaxAttempts $MaxAttempts -PriorElapsedMs $PriorElapsedMs -MaxElapsedMs $MaxElapsedMs -ReceiptPath $ReceiptPath -Evidence $ObserveOnlyAccountingEvidence -Conflict $obsConflict
    }
    $advMode = $PSBoundParameters.ContainsKey('AggregateAdvisoryEvidence')
    $advFacts = $null
    $advCap = $null
    if ($advMode) {
        if ($null -eq $AggregateAdvisoryEvidence) { return & $fail 'AggregateAdvisoryEvidence is null' $null $null }
        if ($PSBoundParameters.ContainsKey('ReviewedBlockedEvidence') -or $PSBoundParameters.ContainsKey('ExpectedBlockedReview')) { return & $fail 'aggregate advisory incompatible with reviewed blocked parameters' $null $null }
        try {
            # Trusted stage sibling only; identity fields come from the authenticated capture, never from caller numbers.
            . (Join-Path $PSScriptRoot 'managed-native-receipt.ps1')
            $advFacts = Get-ManagedNativeAdvisoryBudgetFacts -Evidence $AggregateAdvisoryEvidence
            if ($null -eq $advFacts -or $advFacts.Valid -isnot [bool] -or -not $advFacts.Valid) { return & $fail 'aggregate advisory evidence refused' $null $null }
            if ($advFacts.Facts.mode -isnot [string] -or $advFacts.Facts.mode -cne 'AUTHENTICATED_ADVISORY') { return & $fail 'aggregate advisory evidence is not AUTHENTICATED_ADVISORY' $null $null }
            $e0 = $advFacts.Facts.evidence
            $advCap = Get-ManagedNativeCapturedFacts -ManifestPath $e0.manifestPath -ExpectedManifestSha256 $e0.manifestSha256 -TerminalPath $e0.terminalPath -ExpectedTerminalSha256 $e0.terminalSha256 -TicketPath $e0.ticketPath -RunId $e0.runId -Attempt ([int]$e0.attempt)
            if ($null -eq $advCap -or $advCap.Valid -isnot [bool] -or -not $advCap.Valid) { return & $fail 'aggregate advisory capture refused' $null $null }
        } catch { return & $fail 'aggregate advisory verification failed' $null $null }
    }
    $nativeMode = $PSBoundParameters.ContainsKey('NativeStructuredOutputEvidence')
    $nativeCapture = $null
    if ($nativeMode) {
        if ($null -eq $NativeStructuredOutputEvidence) { return & $fail 'NativeStructuredOutputEvidence is null' $null $null }
        if (-not $PSBoundParameters.ContainsKey('CompletedNativeEvidence') -or $null -eq $CompletedNativeEvidence) { return & $fail 'native structured output requires CompletedNativeEvidence' $null $null }
        if ($PSBoundParameters.ContainsKey('ReviewedBlockedEvidence') -or $PSBoundParameters.ContainsKey('ExpectedBlockedReview')) { return & $fail 'native structured output incompatible with reviewed blocked parameters' $null $null }
    }

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
    if ($PriorElapsedMs -lt 0 -or $null -eq $MaxElapsedMs -or $MaxElapsedMs -le 0) { return & $fail 'invalid elapsed bounds' $null $null }

    $verifyFiveInputs = $null
    $fiveInputPaths = @()
    if ($nativeMode) {
        try {
            $nativeCapture = Get-NativeStructuredOutputObservation -Evidence $NativeStructuredOutputEvidence -RawPath $RawPath -TicketPath $TicketPath -UsagePath $UsagePath -RunId $RunId -Attempt $Attempt -CompletedEvidence $CompletedNativeEvidence
            $rawFull = $nativeCapture.rawFull; $ticketFull = $nativeCapture.facts.TicketPath; $usageFull = $nativeCapture.usageFull
            $rawSha = $nativeCapture.rawSha256; $ticketSha = $nativeCapture.facts.TicketSha256; $usageSha = $nativeCapture.usageSha256
            $raw = $nativeCapture.raw; $ticket = $nativeCapture.facts.Ticket
            $privateUsageLines = $nativeCapture.usageLines
        } catch { return & $fail ('native structured output: ' + $_.Exception.Message) $null $null }
    } elseif ($optIn) {
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
        $usageSource = if ($optIn -or $nativeMode) { $privateUsageLines } else { [System.IO.File]::ReadLines($usageFull) }
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

    $maxOutputTokens = [int64]$ticket.budget.phaseAggregateCeiling
    if ($advMode) {
        $af = $advFacts.Facts
        $cf = $advCap.Facts
        $pick = { param($o, [string[]]$names) foreach ($n in $names) { $pp = $o.PSObject.Properties[$n]; if ($null -ne $pp -and $pp.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty) { return , $pp.Value } }; return , $null }
        $isNum = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $cTid = & $pick $cf.Ticket @('id')
        $cPay = & $pick $cf.Core @('payloadSha256')
        $cSes = & $pick $cf.Ticket @('sessionId')
        $cRun = & $pick $cf.Core @('runId')
        $cAtt = & $pick $cf.Core @('attempt')
        $cMaxEl = & $pick $cf.Core @('maxElapsedMs')
        $cMaxAt = & $pick $cf.Ticket.budget @('maxAttempts')
        $cStart = & $pick $cf.Start @('startTimeUtc')
        $cEnd = & $pick $cf.Terminal @('endedUtc')
        if ($cTid -isnot [string] -or -not [string]::Equals($cTid, "$($ticket.id)", [System.StringComparison]::Ordinal)) { return & $fail 'advisory capture ticket id mismatch' $rawSha $ticketSha }
        if ($cPay -isnot [string] -or -not [string]::Equals($cPay, "$($ticket.payloadSha256)", [System.StringComparison]::OrdinalIgnoreCase)) { return & $fail 'advisory capture payload mismatch' $rawSha $ticketSha }
        if ($cSes -isnot [string] -or -not [string]::Equals($cSes, "$($raw.session)", [System.StringComparison]::Ordinal) -or -not [string]::Equals($cSes, "$($ticket.sessionId)", [System.StringComparison]::Ordinal)) { return & $fail 'advisory capture session mismatch' $rawSha $ticketSha }
        if (-not (& $isNum $cf.Pid) -or [int64]$cf.Pid -le 0 -or -not (& $isNum $raw.pid) -or [int64]$raw.pid -ne [int64]$cf.Pid) { return & $fail 'advisory capture pid mismatch' $rawSha $ticketSha }
        if (-not (& $isNum $cMaxEl) -or [int64]$cMaxEl -le 0 -or [int64]$MaxElapsedMs -ne [int64]$cMaxEl) { return & $fail 'advisory max elapsed mismatch' $rawSha $ticketSha }
        if (-not (& $isNum $cMaxAt) -or [int64]$cMaxAt -le 0 -or [int64]$MaxAttempts -ne [int64]$cMaxAt) { return & $fail 'advisory max attempts mismatch' $rawSha $ticketSha }
        if ([int64]$PriorElapsedMs -ne 0) { return & $fail 'advisory prior elapsed must be zero' $rawSha $ticketSha }
        try {
            $cStartDt = ([datetime]$cStart).ToUniversalTime(); $cEndDt = ([datetime]$cEnd).ToUniversalTime()
            if ($cStartDt.Ticks -ne $startDt.ToUniversalTime().Ticks -or $cEndDt.Ticks -ne $endDt.ToUniversalTime().Ticks) { return & $fail 'advisory raw times do not match capture' $rawSha $ticketSha }
            $capElapsed = [int64][math]::Ceiling(($cEndDt - $cStartDt).TotalMilliseconds)
        } catch { return & $fail 'advisory capture times invalid' $rawSha $ticketSha }
        if ($capElapsed -lt 0 -or $capElapsed -gt [int64]$cMaxEl -or [int64]$usedElapsedMs -ne $capElapsed) { return & $fail 'advisory used elapsed mismatch' $rawSha $ticketSha }
        if ($cRun -isnot [string] -or -not [string]::Equals($cRun, $RunId, [System.StringComparison]::Ordinal) -or -not [string]::Equals($af.evidence.runId, $RunId, [System.StringComparison]::Ordinal)) { return & $fail 'advisory run identity mismatch' $rawSha $ticketSha }
        if (-not (& $isNum $cAtt) -or [int64]$cAtt -ne [int64]$Attempt -or [int64]$af.evidence.attempt -ne [int64]$Attempt) { return & $fail 'advisory attempt identity mismatch' $rawSha $ticketSha }
        try { $evTicketFull = [System.IO.Path]::GetFullPath([string]$af.evidence.ticketPath) } catch { return & $fail 'advisory ticket path invalid' $rawSha $ticketSha }
        if (-not [string]::Equals($evTicketFull, $ticketFull, [System.StringComparison]::OrdinalIgnoreCase)) { return & $fail 'advisory source ticket mismatch' $rawSha $ticketSha }
        if (-not (& $isNum $raw.historicalOutput) -or -not (& $isNum $raw.additionalCap)) { return & $fail 'advisory raw cap fields invalid' $rawSha $ticketSha }
        if ([int64]$raw.historicalOutput -ne [int64]$af.historical -or [int64]$raw.additionalCap -ne [int64]$af.admittedAdditional) { return & $fail 'advisory historical/cap does not match raw' $rawSha $ticketSha }
        if ([int64]$nativeOutput -gt [int64]$af.admittedAdditional) { return & $fail 'observed output exceeds admitted additional cap' $rawSha $ticketSha }
        if ([int64]$raw.historicalOutput -gt ([long]::MaxValue - [int64]$nativeOutput)) { return & $fail 'advisory cumulative overflow' $rawSha $ticketSha }
        if (([int64]$raw.historicalOutput + [int64]$nativeOutput) -ne [int64]$af.actualUsed) { return & $fail 'SDK recount does not equal advisory actualUsed' $rawSha $ticketSha }
        $maxOutputTokens = [int64]$af.finiteCarrier
    }
    if ([int64]$raw.historicalOutput -gt ([long]::MaxValue - [int64]$nativeOutput)) { return & $fail 'cumulative output overflow' $rawSha $ticketSha }
    $usedOutputTokens = [int64]$raw.historicalOutput + $nativeOutput
    if ($usedOutputTokens -gt $maxOutputTokens) {
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
            maxOutputTokens   = [int64]$maxOutputTokens
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

    if ($advMode) {
        Add-Member -InputObject $receipt -NotePropertyName aggregateAdvisoryEvidence -NotePropertyValue $advFacts.Facts.evidence
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

    if ($nativeMode) {
        foreach ($entry in $nativeCapture.facts.Inputs) {
            if ([string]::Equals($receiptFull, $entry.Path, [StringComparison]::OrdinalIgnoreCase)) { return & $fail 'receiptPath collides with native evidence path' $rawSha $ticketSha }
            if ($entry.State -ceq 'FILE') {
                try { $currentHash = (Get-FileHash -LiteralPath $entry.Path -ErrorAction Stop).Hash.ToLowerInvariant() } catch { return & $fail 'native evidence input changed before write' $rawSha $ticketSha }
                if ($currentHash -cne $entry.Sha256) { return & $fail 'native evidence input changed before write' $rawSha $ticketSha }
            } elseif (Test-Path -LiteralPath $entry.Path) { return & $fail 'native evidence input changed before write' $rawSha $ticketSha }
        }
        foreach ($pair in @(@($rawFull,$rawSha),@($usageFull,$usageSha))) {
            if ((Get-FileHash -LiteralPath $pair[0]).Hash.ToLowerInvariant() -cne $pair[1].ToLowerInvariant()) { return & $fail 'native adapter input changed before write' $rawSha $ticketSha }
        }
    }
    if ($advMode) {
        foreach ($entry in $advCap.Facts.Inputs) {
            if ([string]::Equals($receiptFull, $entry.Path, [StringComparison]::OrdinalIgnoreCase)) { return & $fail 'receiptPath collides with advisory evidence path' $rawSha $ticketSha }
            if ($entry.State -ceq 'FILE') {
                try { $currentHash = (Get-FileHash -LiteralPath $entry.Path -ErrorAction Stop).Hash.ToLowerInvariant() } catch { return & $fail 'advisory evidence input changed before write' $rawSha $ticketSha }
                if ($currentHash -cne $entry.Sha256) { return & $fail 'advisory evidence input changed before write' $rawSha $ticketSha }
            } elseif (Test-Path -LiteralPath $entry.Path) { return & $fail 'advisory evidence input changed before write' $rawSha $ticketSha }
        }
        foreach ($pair in @(@($rawFull,$rawSha),@($usageFull,$usageSha))) {
            if ((Get-FileHash -LiteralPath $pair[0]).Hash.ToLowerInvariant() -cne $pair[1].ToLowerInvariant()) { return & $fail 'advisory adapter input changed before write' $rawSha $ticketSha }
        }
    }
    $dir = Split-Path -Parent $receiptFull
    $tempPath = Join-Path $dir ("." +[System.IO.Path]::GetFileName($receiptFull) + ".tmp-" + [guid]::NewGuid().ToString('N'))
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

    $adapterResult = [PSCustomObject]@{
        valid          = $true
        receiptPath    = $receiptFull
        receiptSha256  = $receiptSha256
        classification = $classification
        receipt        = $receipt
    }
    if ($nativeMode) { $adapterResult | Add-Member -NotePropertyName 'nativeStructuredOutput' -NotePropertyValue $nativeCapture.observation }
    return $adapterResult
}
