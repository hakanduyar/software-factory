# Operational runner (Lane B). Dot-source only; no auto-execution.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:PinnedExecutable = 'C:/Users/hakan/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
$Script:AllowedDestination = 'Anthropic Claude'
$Script:SoftFraction = 0.75

function Assert-NoAmbientProviderOverride {
    $forbidden = @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','CLAUDE_API_KEY','OPENAI_API_KEY')
    foreach ($name in $forbidden) {
        if (Test-Path "env:$name") {
            throw "Refusing to run: ambient provider override env var '$name' is set. Remove it before launching (value not printed)."
        }
    }
}

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '' }
    finally { $sha.Dispose() }
}

function Get-Sha256OfString([string]$Text) {
    Get-Sha256Hex([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function Write-AtomicFile([string]$Path, [string]$Content) {
    $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    [System.IO.File]::WriteAllText($tmp, $Content, [System.Text.Encoding]::UTF8)
    [System.IO.File]::Move($tmp, $Path, $true)
}

function Lock-RunDirectory([string]$RunDir) {
    New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
    $lockPath = Join-Path $RunDir 'run.lock'
    try {
        $fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        return $fs
    } catch {
        throw "Refusing: another active claimant holds the run lock for '$RunDir'."
    }
}

function Lock-ExclusiveFile([string]$Path) {
    try {
        return [System.IO.File]::Open($Path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch {
        throw "Refusing: another active claimant holds the exclusive lock for '$Path'."
    }
}

function New-OperationalRunReceipt {
    param(
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$TaskId,
        [Parameter(Mandatory)][string]$PayloadSha256,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][int64]$MaxOutputTokens,
        [Parameter(Mandatory)][int64]$MaxElapsedMs,
        [Parameter(Mandatory)][int]$MaxAttempts
    )
    if ($Destination -ne $Script:AllowedDestination) {
        throw "Refusing: destination '$Destination' is not the verified Anthropic Claude destination."
    }
    [ordered]@{
        schemaVersion    = 'OperationalRunReceipt/v1'
        runId            = $RunId
        taskId           = $TaskId
        payloadSha256    = $PayloadSha256
        destination      = $Destination
        status           = 'PREPARED'
        attempt          = 0
        sessionId        = $SessionId
        historyVerified  = $false
        budget           = [ordered]@{
            maxOutputTokens = $MaxOutputTokens
            maxElapsedMs    = $MaxElapsedMs
            softFraction    = $Script:SoftFraction
            usedElapsedMs   = 0
            maxAttempts     = $MaxAttempts
            usedOutputTokens = 0
            attemptsUsed    = 0
        }
        provider = [ordered]@{
            startIdentity  = $null
            sessionId      = $SessionId
            terminalReason = $null
            pid            = $null
        }
        artifact = [ordered]@{
            complete = $false
            sha256   = $null
            path     = $null
        }
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Save-Receipt([hashtable]$Receipt, [string]$RunDir) {
    $Receipt.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    $path = Join-Path $RunDir 'receipt.json'
    Write-AtomicFile -Path $path -Content ($Receipt | ConvertTo-Json -Depth 12)
    return $path
}

function Apply-ProviderEvent {
    param([Parameter(Mandatory)][hashtable]$Receipt, [Parameter(Mandatory)][hashtable]$Event)
    $budget = $Receipt.budget
    switch ($Event.type) {
        'spawn' {
            if (-not $Event.ContainsKey('pid') -or [int64]$Event.pid -le 0) { throw 'Refusing: spawn event missing actual PID.' }
            $Receipt.provider.pid = $Event.pid
            $Receipt.provider.startIdentity = 'spawned'
            $Receipt.status = 'RUNNING'
        }
        'delta' {
            if ($Receipt.status -notin @('RUNNING','SOFT_LIMIT')) { throw 'Refusing: delta event without actual RUNNING/SOFT_LIMIT process.' }
            if (-not $Event.ContainsKey('outputTokensDelta')) { throw 'Refusing: malformed delta event missing outputTokensDelta.' }
            $d = [int64]$Event.outputTokensDelta
            if ($d -lt 0) { throw 'Refusing: negative output delta would violate monotonic counter.' }
            $budget.usedOutputTokens += $d
            if ($Event.ContainsKey('elapsedMsDelta')) {
                $e = [int64]$Event.elapsedMsDelta
                if ($e -lt 0) { throw 'Refusing: negative elapsed delta would violate monotonic counter.' }
                $budget.usedElapsedMs += $e
            }
        }
        'terminal_usage' {
            if (-not $Event.ContainsKey('finalOutputTokensForAttempt')) { throw 'Refusing: terminal_usage missing authoritative totals.' }
            $candidate = [int64]$Event.priorCumulativeOutputTokens + [int64]$Event.finalOutputTokensForAttempt
            if ($candidate -gt $budget.usedOutputTokens) { $budget.usedOutputTokens = $candidate }
            if ($Event.ContainsKey('finalElapsedMsForAttempt')) {
                $candE = [int64]$Event.priorCumulativeElapsedMs + [int64]$Event.finalElapsedMsForAttempt
                if ($candE -gt $budget.usedElapsedMs) { $budget.usedElapsedMs = $candE }
            }
            $Receipt.provider.terminalReason = $Event.terminalReason
        }
    }

    $hardCapHit = ($budget.usedOutputTokens -ge $budget.maxOutputTokens) -or ($budget.usedElapsedMs -ge $budget.maxElapsedMs)
    $softCapHit = ($budget.usedOutputTokens -ge ($budget.maxOutputTokens * $Script:SoftFraction))

    if ($hardCapHit -and $Receipt.status -ne 'COMPLETED') {
        $Receipt.status = 'AWAITING_CONTROLLER'
        $Receipt.provider.terminalReason = if ($Event.ContainsKey('terminalReason')) { $Event.terminalReason } else { 'HARD_CAP_REACHED' }
        $Receipt.artifact.complete = $false; $Receipt.artifact.path = $null; $Receipt.artifact.sha256 = $null
    } elseif ($softCapHit -and $Receipt.status -eq 'RUNNING') {
        $Receipt.status = 'SOFT_LIMIT'
    }

    if ($Event.ContainsKey('final') -and $Event.final -and -not $hardCapHit) {
        if ($Event.ContainsKey('completeArtifactPath') -and $Event.completeArtifactPath -and $Event.ContainsKey('completeArtifactSha256') -and $Event.completeArtifactSha256) {
            $Receipt.status = 'COMPLETED'
            $Receipt.artifact.complete = $true
            $Receipt.artifact.path = $Event.completeArtifactPath
            $Receipt.artifact.sha256 = $Event.completeArtifactSha256
        } else {
            $Receipt.status = 'FAILED'
            $Receipt.artifact.complete = $false
        }
    }
    return $Receipt
}

function Test-ResumeEligibility {
    param(
        [Parameter(Mandatory)][hashtable]$PriorReceipt,
        [Parameter(Mandatory)][string]$TaskId,
        [Parameter(Mandatory)][string]$PayloadSha256,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][bool]$NormalReviewApproved,
        [Parameter(Mandatory)][bool]$CanaryVerified,
        [string]$RunId,
        [string]$HistoryEvidencePath,
        [string]$HistoryEvidenceSha256
    )
    if ($PriorReceipt.status -in @('COMPLETED')) { return @{ eligible = $false; reason = 'Prior run already terminal-complete; nothing to resume.' } }
    if ($PriorReceipt.status -notin @('AWAITING_CONTROLLER','SOFT_LIMIT','FAILED')) {
        return @{ eligible = $false; reason = "Prior run status '$($PriorReceipt.status)' is not an eligible resumable state." }
    }
    if ($PriorReceipt.taskId -ne $TaskId -or $PriorReceipt.payloadSha256 -ne $PayloadSha256 -or $PriorReceipt.destination -ne $Destination -or $PriorReceipt.sessionId -ne $SessionId) {
        return @{ eligible = $false; reason = 'Refusing: task/payload/destination/session identity changed from prior run.' }
    }
    if ($RunId -and $PriorReceipt.runId -ne $RunId) {
        return @{ eligible = $false; reason = 'Refusing: runId changed from prior run.' }
    }
    if (-not $HistoryEvidencePath -or -not $HistoryEvidenceSha256 -or -not (Test-Path $HistoryEvidencePath)) {
        return @{ eligible = $false; reason = 'Refusing: missing same-session history evidence path/hash.' }
    }
    $histBytes = [System.IO.File]::ReadAllBytes($HistoryEvidencePath)
    $histActualSha = Get-Sha256Hex $histBytes
    if ($histActualSha -ne $HistoryEvidenceSha256) {
        return @{ eligible = $false; reason = 'Refusing: history evidence SHA256 mismatch.' }
    }
    $histText = [System.Text.Encoding]::UTF8.GetString($histBytes)
    $histLines = $histText -split "`n" | Where-Object { $_.Trim().Length -gt 0 }
    $sawMatchingSession = $false
    foreach ($line in $histLines) {
        try { $rec = $line | ConvertFrom-Json -Depth 10 }
        catch { return @{ eligible = $false; reason = 'Refusing: malformed JSONL line in history evidence.' } }
        if (-not $rec.PSObject.Properties.Match('sessionId').Count) {
            return @{ eligible = $false; reason = 'Refusing: history evidence record missing sessionId field.' }
        }
        if ($rec.sessionId -eq $SessionId) { $sawMatchingSession = $true }
    }
    if (-not $sawMatchingSession) {
        return @{ eligible = $false; reason = 'Refusing: no valid JSONL record found for exact sessionId.' }
    }
    if (-not $CanaryVerified) {
        return @{ eligible = $false; reason = 'Refusing: canary verifies capability only, not history; required but not sufficient.' }
    }
    $budget = $PriorReceipt.budget
    if ($null -eq $budget.usedOutputTokens -or $null -eq $budget.usedElapsedMs -or $null -eq $budget.attemptsUsed) {
        return @{ eligible = $false; reason = 'Refusing: incomplete/unknown usage accounting; cannot resume.' }
    }
    $usedOut = [int64]$budget.usedOutputTokens
    $usedElapsed = [int64]$budget.usedElapsedMs
    $attemptsUsed = [int64]$budget.attemptsUsed
    if ($usedOut -lt 0 -or $usedElapsed -lt 0 -or $attemptsUsed -lt 0 -or [double]::IsNaN($usedOut) -or [double]::IsNaN($usedElapsed)) {
        return @{ eligible = $false; reason = 'Refusing: non-finite or negative cumulative counters.' }
    }
    if ($usedOut -ge $budget.maxOutputTokens -or $usedElapsed -ge $budget.maxElapsedMs) {
        return @{ eligible = $false; reason = 'Refusing: cumulative budget already exhausted.' }
    }
    if ($attemptsUsed -ge $budget.maxAttempts) {
        return @{ eligible = $false; reason = 'Refusing: attempt budget exhausted; no strictly remaining attempts.' }
    }
    if (-not $NormalReviewApproved) {
        return @{ eligible = $false; reason = 'Refusing: controller-supplied normalReviewApproved flag is false. This flag is not native approval and this script never synthesizes native markers.' }
    }
    return @{ eligible = $true; reason = 'Eligible for resume.' }
}

function Invoke-OperationalRun {
    param(
        [Parameter(Mandatory)][hashtable]$RequestMetadata,
        [Parameter(Mandatory)][string]$RunDir,
        [Parameter(Mandatory)][scriptblock]$ProcessRunner,
        [hashtable]$PriorReceipt = $null,
        [bool]$IsResume = $false
    )
    Assert-NoAmbientProviderOverride

    if ($RequestMetadata.destination -ne $Script:AllowedDestination) {
        throw "Refusing: unverified destination '$($RequestMetadata.destination)'."
    }
    if ($RequestMetadata.executable -ne $Script:PinnedExecutable) {
        throw "Refusing: executable path does not match pinned native executable."
    }
    $expectedSha = Get-Sha256OfString $RequestMetadata.payload
    if ($expectedSha -ne $RequestMetadata.payloadSha256) {
        throw 'Refusing: prompt/payload SHA256 verification failed.'
    }

    $lockHandle = Lock-RunDirectory -RunDir $RunDir
    try {
        if ($IsResume) {
            if (-not $PriorReceipt) { throw 'Refusing: resume requested without prior receipt.' }
            $receipt = $PriorReceipt
            $receipt.attempt = $receipt.attempt + 1
        } else {
            $receipt = New-OperationalRunReceipt -RunId $RequestMetadata.runId -TaskId $RequestMetadata.taskId `
                -PayloadSha256 $RequestMetadata.payloadSha256 -Destination $RequestMetadata.destination `
                -SessionId $RequestMetadata.sessionId -MaxOutputTokens $RequestMetadata.budget.maxOutputTokens `
                -MaxElapsedMs $RequestMetadata.budget.maxElapsedMs -MaxAttempts $RequestMetadata.budget.maxAttempts
            $receipt.attempt = 1
        }
        Save-Receipt -Receipt $receipt -RunDir $RunDir | Out-Null

        $remainingOutputBudget = $receipt.budget.maxOutputTokens - $receipt.budget.usedOutputTokens
        $remainingElapsedBudget = $receipt.budget.maxElapsedMs - $receipt.budget.usedElapsedMs
        if ($remainingOutputBudget -le 0 -or $remainingElapsedBudget -le 0) {
            throw 'Refusing: no remaining cumulative budget for this run.'
        }

        $args = @(
            '--print','--safe-mode','--restricted','--strict-mcp-config',
            '--setting-sources','', '--tools','',
            '--no-chrome','--disable-slash-commands','--max-turns','1',
            '--output-format','stream-json','--verbose','--include-partial-messages'
        )
        if ($IsResume) { $args += @('--resume', $receipt.sessionId) }
        else { $args += @('--session-id', $receipt.sessionId) }

        $result = & $ProcessRunner $Script:PinnedExecutable $args $RequestMetadata $remainingOutputBudget $remainingElapsedBudget

        if (-not $result.ContainsKey('pid') -or [int64]$result.pid -le 0) {
            throw 'Refusing: ProcessRunner did not report an actual PID; cannot mark RUNNING.'
        }
        $receipt = Apply-ProviderEvent -Receipt $receipt -Event @{ type = 'spawn'; pid = $result.pid }
        Save-Receipt -Receipt $receipt -RunDir $RunDir | Out-Null

        foreach ($evt in $result.events) {
            $receipt = Apply-ProviderEvent -Receipt $receipt -Event $evt
        }
        $receipt.budget.attemptsUsed = $receipt.budget.attemptsUsed + 1

        if ($result.ContainsKey('rawStdout')) {
            Write-AtomicFile -Path (Join-Path $RunDir "attempt-$($receipt.attempt)-stdout.log") -Content $result.rawStdout
        }
        if ($result.ContainsKey('rawStderr')) {
            Write-AtomicFile -Path (Join-Path $RunDir "attempt-$($receipt.attempt)-stderr.log") -Content $result.rawStderr
        }

        if ($receipt.artifact.complete -and $receipt.artifact.path) {
            $bytes = [System.IO.File]::ReadAllBytes($receipt.artifact.path)
            $actualSha = Get-Sha256Hex $bytes
            if ($actualSha -ne $receipt.artifact.sha256) {
                $receipt.status = 'FAILED'
                $receipt.artifact.complete = $false
                $receipt.artifact.path = $null
                $receipt.artifact.sha256 = $null
            }
        }

        Save-Receipt -Receipt $receipt -RunDir $RunDir | Out-Null
        return $receipt
    } finally {
        $lockHandle.Close()
    }
}

# Opt-in managed native collector. Grants no scope/approval/quota; the caller owns Arguments.
# Limitations: TerminalProjection is a synchronous trusted callback; local filesystem and OS calls are not hard-stall preemptible (stream and run deadlines are enforced between calls);
# no provider parser, no outer wake/watchdog; a crash between reservation/start and terminal yields RECONCILE_REQUIRED, never a respawn.
function Assert-NativeStructuredOutputBinding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Request,
        [Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$CapturedTicket,
        [AllowNull()][AllowEmptyString()][string]$SchemaArgument,
        [Parameter(Mandatory)][bool]$HasSchemaArgument
    )
    if (-not $Request.ContainsKey('StructuredOutputProfile')) {
        if ($HasSchemaArgument) { throw 'Refusing: bare schema requires StructuredOutputProfile.' }
        return
    }
    $profile = $Request['StructuredOutputProfile']
    if ($profile -isnot [string] -or $profile -cne 'canonical8-v1') { throw 'Refusing: unknown structured output profile.' }
    if (-not $HasSchemaArgument) { throw 'Refusing: structured output profile requires --json-schema.' }
    # Internal registry entry: callers cannot supply a schema path or assert their own digest.
    $registeredSchema = '{"type":"object","properties":{"summary":{"type":"string"},"changedPaths":{"items":{"type":"string"},"type":"array"},"commandsRun":{"items":{"type":"string"},"type":"array"},"validationResults":{"items":{"type":"string"},"type":"array"},"fingerprint":{"type":["string","null"]},"checkpointRef":{"type":["string","null"]},"blockers":{"items":{"type":"string"},"type":"array"},"recommendedNextAction":{"type":"string"}},"required":["summary","changedPaths","commandsRun","validationResults","fingerprint","checkpointRef","blockers","recommendedNextAction"],"additionalProperties":false}'
    $registeredDigest = 'fd655794f2298daf88877d652f94736ed2e74cf520b3278f694b141d492b8cfa'
    if ((Get-Sha256OfString $registeredSchema) -cne $registeredDigest -or $SchemaArgument -cne $registeredSchema) { throw 'Refusing: schema does not match the registered schema.' }
    try {
        $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
        $ticket = $strictUtf8.GetString($CapturedTicket) | ConvertFrom-Json
    } catch { throw 'Refusing: schema ticket must be valid UTF-8 JSON.' }
    if ($ticket -isnot [PSCustomObject]) { throw 'Refusing: schema ticket must be a JSON object.' }
    $pins = @($ticket.PSObject.Properties | Where-Object { $_.Name -ceq 'nativeOutputSchemaSha256' })
    if ($pins.Count -ne 1 -or $pins[0].Value -isnot [string] -or $pins[0].Value -cne $registeredDigest) { throw 'Refusing: captured ticket schema pin is missing or mismatched.' }
}

function Read-ManagedPinnedEvidenceJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Reference,
        [Parameter(Mandatory)][string]$ControlRoot
    )
    # Safe evidence reader only: verifies one pinned file and returns its parsed JSON; makes no authority decision.
    $maxBytes = 1048576
    $localDrive = '^[A-Za-z]:\\'
    if ($Reference -isnot [PSCustomObject]) { throw 'EVIDENCE_REF: reference must be an object.' }
    $names = @($Reference.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names.Count -ne 2 -or ($names -cnotcontains 'path') -or ($names -cnotcontains 'sha256')) { throw 'EVIDENCE_REF: reference must have exactly path and sha256.' }
    $refPath = $Reference.path
    $refHash = $Reference.sha256
    if ($refPath -isnot [string] -or [string]::IsNullOrWhiteSpace($refPath) -or $refHash -isnot [string] -or $refHash -cnotmatch '\A[0-9a-f]{64}\z') { throw 'EVIDENCE_REF: path or sha256 is malformed.' }
    foreach ($p in @($refPath, $ControlRoot)) {
        if ($p -notmatch $localDrive -or $p.IndexOf(':', 2) -ge 0 -or $p.Contains('/') -or $p.Contains([char]0)) { throw 'EVIDENCE_PATH: path must be a local drive-rooted canonical path.' }
        try { $full = [System.IO.Path]::GetFullPath($p) } catch { throw 'EVIDENCE_PATH: path is not valid.' }
        if ($full -cne $p -and -not [string]::Equals($full, $p, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'EVIDENCE_PATH: path is not canonical.' }
        if ($full.Length -ne $p.Length) { throw 'EVIDENCE_PATH: path is not canonical.' }
    }
    $rootPrefix = $ControlRoot.TrimEnd('\') + '\'
    if ($refPath.Length -le $rootPrefix.Length -or -not $refPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'EVIDENCE_PATH: reference must be a strict descendant of ControlRoot.' }
    if (-not [System.IO.Directory]::Exists($ControlRoot)) { throw 'EVIDENCE_MISSING: ControlRoot is not an existing directory.' }
    foreach ($start in @($ControlRoot, $refPath)) {
        $cursor = $start
        while (-not [string]::IsNullOrEmpty($cursor)) {
            if ([System.IO.File]::Exists($cursor) -or [System.IO.Directory]::Exists($cursor)) {
                if (([System.IO.File]::GetAttributes($cursor) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'EVIDENCE_REPARSE: reparse point in path.' }
            }
            $cursor = [System.IO.Path]::GetDirectoryName($cursor)
        }
    }
    if (-not [System.IO.File]::Exists($refPath)) { throw 'EVIDENCE_MISSING: evidence file is missing or not a file.' }
    $buffer = [byte[]]::new($maxBytes + 1)
    $length = 0
    $stream = $null
    try {
        $stream = [System.IO.FileStream]::new($refPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        while ($length -lt $buffer.Length) {
            $n = $stream.Read($buffer, $length, $buffer.Length - $length)
            if ($n -le 0) { break }
            $length += $n
        }
    } catch { throw 'EVIDENCE_MISSING: evidence file could not be read.' } finally { if ($null -ne $stream) { $stream.Dispose() } }
    if ($length -gt $maxBytes) { throw 'EVIDENCE_SIZE: evidence exceeds 1 MiB.' }
    $raw = [byte[]]::new($length)
    [System.Array]::Copy($buffer, $raw, $length)
    $actualHash = ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($raw)).Replace('-', '')).ToLowerInvariant()
    if ($actualHash -cne $refHash) { throw 'EVIDENCE_HASH: evidence hash does not match the reference.' }
    $offset = 0
    if ($length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) { $offset = 3 }
    try { $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($raw, $offset, $length - $offset) } catch { throw 'EVIDENCE_UTF8: evidence is not valid UTF-8.' }
    $doc = $null
    try {
        $options = [System.Text.Json.JsonDocumentOptions]::new()
        $options.MaxDepth = 64
        $options.AllowTrailingCommas = $false
        $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
        try { $doc = [System.Text.Json.JsonDocument]::Parse($text, $options) } catch { throw 'EVIDENCE_JSON: evidence is not strict JSON.' }
        if ($doc.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'EVIDENCE_JSON: root must be a JSON object.' }
        $pending = [System.Collections.Generic.Stack[System.Text.Json.JsonElement]]::new()
        $pending.Push($doc.RootElement)
        while ($pending.Count -gt 0) {
            $element = $pending.Pop()
            if ($element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                foreach ($property in $element.EnumerateObject()) {
                    if (-not $seen.Add($property.Name)) { throw 'EVIDENCE_DUPLICATE: duplicate property name.' }
                    $pending.Push($property.Value)
                }
            } elseif ($element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
                foreach ($item in $element.EnumerateArray()) { $pending.Push($item) }
            }
        }
    } finally { if ($null -ne $doc) { $doc.Dispose() } }
    try { $value = $text | ConvertFrom-Json -DateKind String -Depth 64 } catch { throw 'EVIDENCE_JSON: evidence could not be converted.' }
    [PSCustomObject]@{ Path = $refPath; Sha256 = $actualHash; Length = $length; Value = $value }
}

function Resolve-ManagedAggregateAdvisory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$TicketContract,
        [Parameter(Mandatory)][byte[]]$CapturedTicket,
        [Parameter(Mandatory)][string]$ControlRoot
    )
    # Authenticates the advisory descriptor against pinned governance and admitted terminal JSON; completeness is relative to the independently admitted list.
    $isCount = { param($v) ($v -is [int] -or $v -is [long]) -and [long]$v -ge 0 }
    $hasNames = { param($o, [string[]]$names) $p = @($o.PSObject.Properties.Name); $p.Count -eq $names.Count -and @($names | Where-Object { $p -cnotcontains $_ }).Count -eq 0 }
    $samePath = {
        param($a, $b)
        $cmp = if ([System.OperatingSystem]::IsWindows()) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
        $a -is [string] -and $b -is [string] -and [string]::Equals($a, $b, $cmp)
    }

    $hasProp = {
        param($o, [string[]]$names)
        if ($null -eq $o) { return $false }
        $p = if ($o -is [System.Collections.IDictionary]) { @($o.Keys) } else { @($o.PSObject.Properties.Name) }
        @($names | Where-Object { $p -cnotcontains $_ }).Count -eq 0
    }

    if ($null -eq $TicketContract -or -not (& $hasProp $TicketContract @('Valid', 'AggregateMode', 'Advisory')) -or $TicketContract.Valid -isnot [bool] -or $TicketContract.Valid -ne $true) { throw 'ADVISORY_CONTRACT: ticket contract is not valid.' }
    $mode = $TicketContract.AggregateMode
    if ($mode -ceq 'LEGACY_HARDLIMIT') {
        if ($null -ne $TicketContract.Advisory) { throw 'ADVISORY_CONTRACT: legacy mode must not carry an advisory descriptor.' }
        return $null
    }
    if ($mode -cne 'ADVISORY_DESCRIPTOR' -or $null -eq $TicketContract.Advisory) { throw 'ADVISORY_CONTRACT: unknown aggregate mode or missing descriptor.' }
    if (-not (& $hasProp $TicketContract @('Budget'))) { throw 'ADVISORY_CONTRACT: ticket contract budget is missing.' }
    $adv = $TicketContract.Advisory

    # Captured ticket: strict decode, then recompute the native contract and compare.
    if ($CapturedTicket.Length -gt 1048576) { throw 'ADVISORY_TICKET: captured ticket exceeds 1 MiB.' }
    $offset = 0
    if ($CapturedTicket.Length -ge 3 -and $CapturedTicket[0] -eq 0xEF -and $CapturedTicket[1] -eq 0xBB -and $CapturedTicket[2] -eq 0xBF) { $offset = 3 }
    try { $ticketText = [System.Text.UTF8Encoding]::new($false, $true).GetString($CapturedTicket, $offset, $CapturedTicket.Length - $offset) } catch { throw 'ADVISORY_TICKET: captured ticket is not valid UTF-8.' }
    $doc = $null
    try {
        $options = [System.Text.Json.JsonDocumentOptions]::new()
        $options.MaxDepth = 64
        $options.AllowTrailingCommas = $false
        $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
        try { $doc = [System.Text.Json.JsonDocument]::Parse($ticketText, $options) } catch { throw 'ADVISORY_TICKET: captured ticket is not strict JSON.' }
        if ($doc.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'ADVISORY_TICKET: root must be a JSON object.' }
        $pending = [System.Collections.Generic.Stack[System.Text.Json.JsonElement]]::new()
        $pending.Push($doc.RootElement)
        while ($pending.Count -gt 0) {
            $element = $pending.Pop()
            if ($element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                foreach ($property in $element.EnumerateObject()) {
                    if (-not $seen.Add($property.Name)) { throw 'ADVISORY_TICKET: duplicate or case-ambiguous property name.' }
                    $pending.Push($property.Value)
                }
            } elseif ($element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
                foreach ($item in $element.EnumerateArray()) { $pending.Push($item) }
            }
        }
    } finally { if ($null -ne $doc) { $doc.Dispose() } }
    try { $ticket = $ticketText | ConvertFrom-Json -DateKind String -Depth 64 } catch { throw 'ADVISORY_TICKET: captured ticket could not be converted.' }
    if ($ticket -isnot [PSCustomObject] -or -not (& $hasProp $ticket @('payloadSha256')) -or $ticket.payloadSha256 -isnot [string]) { throw 'ADVISORY_TICKET: payloadSha256 is missing.' }
    $recomputed = Test-ManagedNativeTicketContract -Ticket $ticket -ExpectedPayloadSha256 $ticket.payloadSha256
    if ((ConvertTo-Json -InputObject $recomputed -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $TicketContract -Depth 12 -Compress)) { throw 'ADVISORY_CONTRACT: supplied contract differs from the recomputed contract.' }

    # Independently admitted cumulative history list.
    if (-not (& $hasProp $ticket @('requiredReads')) -or $ticket.requiredReads -isnot [System.Array]) { throw 'ADVISORY_HISTORY_BINDING: requiredReads must be an array.' }
    $rawReads = $ticket.requiredReads
    if (@($rawReads | Where-Object { $_ -isnot [PSCustomObject] -or -not (& $hasProp $_ @('route')) -or $_.route -isnot [string] }).Count -ne 0) { throw 'ADVISORY_HISTORY_BINDING: requiredReads entries must be objects with a route.' }
    $reads = @($rawReads | Where-Object { $_.route -ceq 'FULL_ADMITTED_CUMULATIVE_HISTORY' })
    if ($reads.Count -ne 1 -or -not (& $hasNames $reads[0] @('ref', 'sha256', 'route'))) { throw 'ADVISORY_HISTORY_BINDING: exactly one admitted cumulative history read is required.' }
    $listRef = [PSCustomObject]@{ path = $reads[0].ref; sha256 = $reads[0].sha256 }
    $listRead = Read-ManagedPinnedEvidenceJson -Reference $listRef -ControlRoot $ControlRoot
    $list = $listRead.Value

    # Governance anchors.
    $govDir = $ControlRoot.TrimEnd('\') + '\resume-20261020\phase-aggregate-advisory-policy-20261025-1\'
    $policyPath = $govDir + 'governing-policy-amendment-candidate.json'
    $reviewPath = $govDir + 'independent-review\verdict.json'
    $policyHash = '45305c5d5366d519226b870f85e9c39ae854aae7590d814cf596193f9996bdbf'
    $reviewHash = '32a347303c519c7eb9ad2117d4503bf4f7bfe6bb89ff9174bd35be101067f70b'
    if (-not (& $samePath $adv.PolicyRef.Path $policyPath) -or $adv.PolicyRef.Sha256 -cne $policyHash -or -not (& $samePath $adv.PolicyReviewRef.Path $reviewPath) -or $adv.PolicyReviewRef.Sha256 -cne $reviewHash) { throw 'ADVISORY_POLICY_BINDING: policy references are not the trusted governance anchors.' }
    $policyRead = Read-ManagedPinnedEvidenceJson -Reference ([PSCustomObject]@{ path = $adv.PolicyRef.Path; sha256 = $adv.PolicyRef.Sha256 }) -ControlRoot $ControlRoot
    $reviewRead = Read-ManagedPinnedEvidenceJson -Reference ([PSCustomObject]@{ path = $adv.PolicyReviewRef.Path; sha256 = $adv.PolicyReviewRef.Sha256 }) -ControlRoot $ControlRoot
    $policy = $policyRead.Value
    $review = $reviewRead.Value
    if ($review.decision -cne 'POLICY_SEMANTICS_ACCEPTED_RUNTIME_ADOPTION_PENDING' -or $review.amendmentSha256 -cne $policyRead.Sha256) { throw 'ADVISORY_POLICY_BINDING: review does not accept the pinned policy.' }
    $threshold = $adv.Threshold
    $seed = $policy.scope.observedHistoricalOutputTokens
    if ($adv.PolicyTaskId -cne $policy.taskId -or $adv.WarningCode -cne $policy.scope.warning -or $policy.scope.aggregateExceededAloneMayBlock -isnot [bool] -or $policy.scope.aggregateExceededAloneMayBlock -ne $false) { throw 'ADVISORY_POLICY_BINDING: descriptor does not match the policy.' }
    if (-not (& $isCount $threshold) -or [long]$threshold -le 0 -or -not (& $isCount $policy.scope.advisoryThreshold) -or [long]$policy.scope.advisoryThreshold -ne [long]$threshold) { throw 'ADVISORY_POLICY_BINDING: threshold is not a matching positive integer.' }
    if (-not (& $isCount $seed)) { throw 'ADVISORY_POLICY_BINDING: policy seed is not a nonnegative integer.' }
    $seed = [long]$seed

    # Admitted list versus descriptor.
    if ($list -isnot [PSCustomObject] -or -not (& $hasProp $list @('historicalOutputTokens', 'rows')) -or $list.rows -isnot [array]) { throw 'ADVISORY_HISTORY_BINDING: list is missing historicalOutputTokens or rows array.' }
    if (-not (& $isCount $list.historicalOutputTokens)) { throw 'ADVISORY_HISTORY_BINDING: list historicalOutputTokens is not a nonnegative integer.' }
    $rows = @($list.rows)
    $descRuns = @($adv.HistoryRuns)
    if ($list.rows -isnot [array] -or $rows.Count -gt 128 -or $rows.Count -ne $descRuns.Count) { throw 'ADVISORY_HISTORY_BINDING: list rows are not an array matching the descriptor count.' }
    $required = @('runId', 'requestSha256', 'path', 'sha256', 'observedOutputTokens')
    $running = [long]0
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $row = $rows[$i]
        $d = $descRuns[$i]
        if ($row -isnot [PSCustomObject] -or @($required | Where-Object { @($row.PSObject.Properties.Name) -cnotcontains $_ }).Count -ne 0) { throw "ADVISORY_HISTORY_BINDING: row $i has missing fields." }
        if ($row.runId -isnot [string] -or $row.requestSha256 -isnot [string] -or $row.path -isnot [string] -or $row.sha256 -isnot [string] -or -not (& $isCount $row.observedOutputTokens)) { throw "ADVISORY_HISTORY_BINDING: row $i has wrong field types." }
        if ($d.RunId -cne $row.runId -or $d.RequestSha256 -cne $row.requestSha256 -or -not (& $samePath $d.TerminalRef.Path $row.path) -or $d.TerminalRef.Sha256 -cne $row.sha256 -or -not (& $isCount $d.OutputTokens) -or [long]$d.OutputTokens -ne [long]$row.observedOutputTokens) { throw "ADVISORY_HISTORY_BINDING: row $i differs from the descriptor." }

        $term = (Read-ManagedPinnedEvidenceJson -Reference ([PSCustomObject]@{ path = $row.path; sha256 = $row.sha256 }) -ControlRoot $ControlRoot).Value
        if ($term -isnot [PSCustomObject] -or -not (& $hasProp $term @('schema', 'runId', 'requestSha256', 'definitive', 'exitObserved', 'tokenAccounting'))) { throw "ADVISORY_TERMINAL: row $i terminal identity or state is invalid." }
        $acct = $term.tokenAccounting
        if ($term.schema -cne 'ManagedNativeTerminal/v1' -or $term.runId -cne $row.runId -or $term.requestSha256 -cne $row.requestSha256 -or $term.definitive -isnot [bool] -or $term.definitive -ne $true -or $term.exitObserved -isnot [bool] -or $term.exitObserved -ne $true) { throw "ADVISORY_TERMINAL: row $i terminal identity or state is invalid." }
        if ($acct -isnot [PSCustomObject] -or -not (& $hasProp $acct @('schema', 'invalid', 'observedOutputTokens'))) { throw "ADVISORY_TERMINAL: row $i token accounting is invalid or differs." }
        if ($null -eq $acct -or $acct.schema -cne 'ManagedTokenAccounting/v1' -or $acct.invalid -isnot [bool] -or $acct.invalid -ne $false -or -not (& $isCount $acct.observedOutputTokens) -or [long]$acct.observedOutputTokens -ne [long]$row.observedOutputTokens) { throw "ADVISORY_TERMINAL: row $i token accounting is invalid or differs." }
        $count = [long]$acct.observedOutputTokens
        if (-not (& $hasProp $acct @('policy')) -or $acct.policy -isnot [PSCustomObject] -or -not (& $hasProp $acct.policy @('HistoricalOutputTokens'))) { throw "ADVISORY_HISTORY_CHAIN: row $i receipt history is not a nonnegative integer." }
        $receiptHistory = $acct.policy.HistoricalOutputTokens
        if (-not (& $isCount $receiptHistory)) { throw "ADVISORY_HISTORY_CHAIN: row $i receipt history is not a nonnegative integer." }
        if ($count -gt [long]::MaxValue - $running) { throw 'ADVISORY_HISTORY_OVERFLOW: cumulative output tokens overflow Int64.' }
        if ($running -lt $seed) {
            if ([long]$receiptHistory -ne 0 -or $running + $count -gt $seed) { throw "ADVISORY_HISTORY_CHAIN: row $i breaks the seed prefix." }
        } elseif ([long]$receiptHistory -ne $running) {
            throw "ADVISORY_HISTORY_CHAIN: row $i history does not equal the preceding sum."
        }
        $running += $count
    }
    if ($running -lt $seed) { throw 'ADVISORY_HISTORY_CHAIN: history does not reach the policy seed.' }
    if ($running -ne [long]$list.historicalOutputTokens -or $running -ne [long]$TicketContract.Budget.HistoricalOutputTokens) { throw 'ADVISORY_HISTORY_SUM: terminal sum differs from the admitted list or contract budget.' }

    [PSCustomObject]@{
        Mode                = 'AUTHENTICATED_ADVISORY'
        HistoricalOutputTokens = $running
        Threshold           = [long]$threshold
        WarningCode         = $adv.WarningCode
        Exceeded            = ($running -gt [long]$threshold)
        PolicyRef           = [PSCustomObject]@{ Path = $policyRead.Path; Sha256 = $policyRead.Sha256 }
        PolicyReviewRef     = [PSCustomObject]@{ Path = $reviewRead.Path; Sha256 = $reviewRead.Sha256 }
        HistoryListRef      = [PSCustomObject]@{ Path = $listRead.Path; Sha256 = $listRead.Sha256 }
        HistoryRunCount     = $rows.Count
        EvidenceScope       = 'ADMITTED_TERMINAL_JSON_COUNTS_NO_STREAM_RECOUNT'
        Completeness        = 'RELATIVE_TO_INDEPENDENTLY_ADMITTED_LIST'
    }
}

function Invoke-ManagedNativeCollector {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Request,
        [Parameter(Mandatory)][string]$RunDir,
        [hashtable]$StartAcknowledgementContext,
        [scriptblock]$TerminalProjection
    )
    $projectionCallback = $TerminalProjection
    $runnerDir = $PSScriptRoot
    $exePath = [string]$Script:PinnedExecutable
    $ctx = $null
    if ($PSBoundParameters.ContainsKey('StartAcknowledgementContext')) {
        $c = $StartAcknowledgementContext
        if ($null -eq $c) { throw 'Refusing: StartAcknowledgementContext is null.' }
        foreach ($k in @($c.Keys)) {
            if ($k -isnot [string] -or @('StateDir','SelectedClaim','TaskId') -cnotcontains $k) { throw 'Refusing: unknown StartAcknowledgementContext key.' }
        }
        foreach ($k in 'StateDir','SelectedClaim','TaskId') {
            if (-not $c.ContainsKey($k)) { throw ('Refusing: missing StartAcknowledgementContext key ' + $k + '.') }
        }
        $sd = $c['StateDir']; $tid = $c['TaskId']; $sc = $c['SelectedClaim']
        if ($sd -isnot [string] -or [string]::IsNullOrWhiteSpace($sd) -or -not [System.IO.Path]::IsPathRooted($sd)) { throw 'Refusing: StateDir must be a nonblank absolute path.' }
        if ($tid -isnot [string] -or [string]::IsNullOrWhiteSpace($tid)) { throw 'Refusing: TaskId must be a nonblank string.' }
        if ($sc -isnot [PSCustomObject]) { throw 'Refusing: SelectedClaim must be a PSCustomObject.' }
        $scNames = @($sc.PSObject.Properties.Name)
        $scFields = @('id','owner','claimId','intentId','receiptSha','planSha','statePath')
        if ($scNames.Count -ne $scFields.Count) { throw 'Refusing: SelectedClaim must carry exactly the declared fields.' }
        $claim = [ordered]@{}
        foreach ($f in $scFields) {
            if ($scNames -cnotcontains $f) { throw ('Refusing: SelectedClaim.' + $f + ' missing.') }
            $fv = $sc.$f
            if ($fv -isnot [string] -or [string]::IsNullOrWhiteSpace($fv)) { throw ('Refusing: SelectedClaim.' + $f + ' must be a nonblank string.') }
            if (($f -ceq 'receiptSha' -or $f -ceq 'planSha') -and $fv -cnotmatch '^[0-9a-f]{64}$') { throw ('Refusing: SelectedClaim.' + $f + ' must be lower-case 64hex.') }
            $claim[$f] = $fv
        }
        $stateDirFull = [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($sd))
        if (-not [System.IO.Path]::IsPathRooted($claim['statePath']) -or [System.IO.Path]::GetFullPath($claim['statePath']) -ine (Join-Path $stateDirFull 'continuation-state.json')) { throw 'Refusing: SelectedClaim.statePath is not the canonical StateDir continuation-state.json.' }
        $ctx = [ordered]@{ stateDir = $stateDirFull; taskId = $tid; claim = $claim }
    }
    $allowed = @('RunId','Attempt','TicketPath','PayloadPath','GateTicketPath','SettingsPath','ArtifactPath','WorkingDirectory','Arguments','MaxElapsedMs','MaxStreamBytes')
    $optionalAllowed = @('TokenAccountingPolicy','StructuredOutputProfile','OutputStopProfile')
    $knownKeys = @($allowed + $optionalAllowed)
    foreach ($k in @($Request.Keys)) {
        if ($k -isnot [string] -or $knownKeys -cnotcontains $k) { throw 'Refusing: unknown request key.' }
    }
    foreach ($k in $allowed) {
        if (-not $Request.ContainsKey($k)) { throw ('Refusing: missing request key ' + $k + '.') }
    }
    # Optional TokenAccountingPolicy: exact-case key only; primitive clone captured before any child.
    $tokenAccountingPolicy = $null
    $tokenPolicyPresent = $false
    foreach ($k in @($Request.Keys)) {
        if ($k -ceq 'TokenAccountingPolicy') { $tokenPolicyPresent = $true }
    }
    if ($tokenPolicyPresent) {
        $tapRaw = $Request['TokenAccountingPolicy']
        if ($null -eq $tapRaw -or $tapRaw -isnot [hashtable]) { throw 'Refusing: TokenAccountingPolicy must be a hashtable.' }
        $tapNames = @('MaxMessages','MaxEvents','MaxLineBytes','MaxInputBytes')
        $tapKeys = @($tapRaw.Keys)
        if ($tapKeys.Count -ne 4) { throw 'Refusing: TokenAccountingPolicy must have exactly four keys.' }
        foreach ($tk in $tapKeys) {
            if ($tk -isnot [string] -or $tapNames -cnotcontains $tk) { throw 'Refusing: unknown TokenAccountingPolicy field.' }
        }
        $tapClone = @{}
        foreach ($tn in $tapNames) {
            if (-not $tapRaw.ContainsKey($tn)) { throw ('Refusing: missing TokenAccountingPolicy field ' + $tn + '.') }
            $tv = $tapRaw[$tn]
            if ($tv -isnot [int] -and $tv -isnot [long]) { throw ('Refusing: TokenAccountingPolicy ' + $tn + ' must be an integer.') }
            $tapClone[$tn] = [long]$tv
        }
        if ($tapClone['MaxMessages'] -lt 1 -or $tapClone['MaxMessages'] -gt 10000) { throw 'Refusing: TokenAccountingPolicy MaxMessages out of range.' }
        if ($tapClone['MaxEvents'] -lt 1 -or $tapClone['MaxEvents'] -gt 100000) { throw 'Refusing: TokenAccountingPolicy MaxEvents out of range.' }
        if ($tapClone['MaxLineBytes'] -lt 1 -or $tapClone['MaxLineBytes'] -gt 1048576) { throw 'Refusing: TokenAccountingPolicy MaxLineBytes out of range.' }
        if ($tapClone['MaxInputBytes'] -lt 1) { throw 'Refusing: TokenAccountingPolicy MaxInputBytes out of range.' }
        $tapRawStream = $Request['MaxStreamBytes']
        if (($tapRawStream -is [int] -or $tapRawStream -is [long]) -and $tapClone['MaxInputBytes'] -gt [long]$tapRawStream) {
            throw 'Refusing: TokenAccountingPolicy MaxInputBytes exceeds MaxStreamBytes.'
        }
        $tokenAccountingPolicy = $tapClone
    }
    # Optional OutputStopProfile: exact-case selector only (not authority). Authority is authenticated below from captured bytes.
    $noStop = $false
    foreach ($k in @($Request.Keys)) {
        if ($k -ceq 'OutputStopProfile') {
            $osRaw = $Request['OutputStopProfile']
            if ($osRaw -isnot [string] -or $osRaw -cne 'observe-only-v1') { throw 'Refusing: OutputStopProfile must be exactly observe-only-v1.' }
            $noStop = $true
        }
    }
    if ($noStop -and ($tokenPolicyPresent -or $Request.ContainsKey('StructuredOutputProfile'))) { throw 'Refusing: OutputStopProfile cannot combine with TokenAccountingPolicy or StructuredOutputProfile.' }
    $runId = $Request['RunId']
    if ($runId -isnot [string] -or $runId -cnotmatch '^[A-Za-z0-9._-]{1,128}$') { throw 'Refusing: invalid RunId.' }
    $num = @{}
    foreach ($k in 'Attempt','MaxElapsedMs','MaxStreamBytes') {
        $v = $Request[$k]
        if ($noStop -and $k -ceq 'MaxStreamBytes') {
            if ($null -ne $v) { throw 'Refusing: MaxStreamBytes must be null in OutputStopProfile mode.' }
            $num[$k] = $null
            continue
        }
        if (($v -isnot [int] -and $v -isnot [long]) -or $v -le 0) { throw ('Refusing: ' + $k + ' must be a positive typed integer.') }
        $num[$k] = [long]$v
    }
    $resolve = { param($p) $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p) }
    $paths = @{}
    foreach ($k in 'TicketPath','PayloadPath','GateTicketPath','SettingsPath','ArtifactPath','WorkingDirectory') {
        $v = $Request[$k]
        if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v)) { throw ('Refusing: ' + $k + ' must be a non-empty string.') }
        $paths[$k] = [System.IO.Path]::TrimEndingDirectorySeparator((& $resolve $v))
    }
    $runDirFull = [System.IO.Path]::TrimEndingDirectorySeparator((& $resolve $RunDir))
    $rawArgs = $Request['Arguments']
    if ($rawArgs -isnot [System.Array]) { throw 'Refusing: Arguments must be an array of strings.' }
    $argList = [string[]]::new($rawArgs.Count)
    for ($i = 0; $i -lt $rawArgs.Count; $i++) {
        if ($rawArgs[$i] -isnot [string]) { throw 'Refusing: every argument must be a string.' }
        $argList[$i] = $rawArgs[$i]
    }
    # Supported native argv contract: narrow author flags, or observational --help/--version alone. Refused before any reservation or spawn.
    $settingsApplied = $false
    $bytes = @{}
    $sha = @{}
    $schemaArgument = $null
    $hasSchemaArgument = $false
    if ($argList.Count -eq 1 -and ($argList[0] -ceq '--help' -or $argList[0] -ceq '--version')) {
        if ($noStop) { throw 'Refusing: OutputStopProfile requires author mode.' }
        $settingsApplied = $false
    } else {
        $optVal = { param($idx) if ($idx -ge $argList.Count -or $argList[$idx] -clike '--*') { throw 'Refusing: option value missing.' }; return $argList[$idx] }
        $seenOpt = @{}
        $hasPrint = $false
        $cliMaxTurns = $null
        $ai = 0
        while ($ai -lt $argList.Count) {
            $opt = $argList[$ai]
            if ($opt -imatch 'permission|dangerous') { throw 'Refusing: permission override option.' }
            if ($opt -cnotmatch '^--[A-Za-z][A-Za-z-]*$') { throw 'Refusing: unsupported or unknown argument.' }
            if ($seenOpt.ContainsKey($opt)) { throw 'Refusing: duplicate option.' }
            $seenOpt[$opt] = $true
            $ai++
            switch -CaseSensitive ($opt) {
                '--print' { $hasPrint = $true }
                '--verbose' { }
                '--output-format' { if ((& $optVal $ai) -cne 'stream-json') { throw 'Refusing: unsupported output format.' }; $ai++ }
                '--model' { if ((& $optVal $ai) -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]*$') { throw 'Refusing: invalid model.' }; $ai++ }
                '--effort' { if (@('low','medium','high') -cnotcontains (& $optVal $ai)) { throw 'Refusing: invalid effort.' }; $ai++ }
                '--max-turns' { if ($noStop) { throw 'Refusing: --max-turns is not permitted in OutputStopProfile mode.' }; $mtVal = & $optVal $ai; if ($mtVal -cnotmatch '^[1-9][0-9]{0,3}$') { throw 'Refusing: invalid max-turns.' }; $cliMaxTurns = [long]::Parse($mtVal, [Globalization.CultureInfo]::InvariantCulture); $ai++ }
                '--resume' { if ($seenOpt.ContainsKey('--session-id')) { throw 'Refusing: --resume cannot combine with --session-id.' }; if ((& $optVal $ai) -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Refusing: invalid resume session.' }; $ai++ }
                '--session-id' {
                    if ($seenOpt.ContainsKey('--resume')) { throw 'Refusing: --session-id cannot combine with --resume.' }
                    $sidVal = & $optVal $ai
                    $parsedGuid = [Guid]::Empty
                    if (-not [Guid]::TryParseExact($sidVal, 'D', [ref]$parsedGuid)) { throw 'Refusing: invalid session-id UUID.' }
                    if (-not $bytes.ContainsKey('TicketPath')) {
                        try { $bytes['TicketPath'] = [System.IO.File]::ReadAllBytes($paths['TicketPath']) } catch { throw 'Refusing: TicketPath is not readable.' }
                        $sha['TicketPath'] = Get-Sha256Hex $bytes['TicketPath']
                    }
                    $ticketJson = $null
                    try { $ticketJson = [System.Text.Encoding]::UTF8.GetString($bytes['TicketPath']) | ConvertFrom-Json } catch { throw 'Refusing: ticket is not valid JSON.' }
                    if ($ticketJson -isnot [PSCustomObject]) { throw 'Refusing: ticket must be a JSON object.' }
                    $ticketSessionId = $ticketJson.sessionId
                    if ($ticketSessionId -isnot [string] -or -not [string]::Equals($ticketSessionId, $sidVal, [System.StringComparison]::Ordinal)) { throw 'Refusing: ticket sessionId does not match --session-id.' }
                    $ai++
                }
                '--json-schema' {
                    if ($noStop) { throw 'Refusing: --json-schema is not permitted in OutputStopProfile mode.' }
                    $schemaArgument = & $optVal $ai
                    $hasSchemaArgument = $true
                    $ai++
                }
                '--include-partial-messages' { }
                '--settings' {
                    $sv = & $optVal $ai
                    if ([System.IO.Path]::TrimEndingDirectorySeparator((& $resolve $sv)) -ine $paths['SettingsPath']) { throw 'Refusing: --settings must equal the captured SettingsPath.' }
                    $settingsJson = $null
                    try { $settingsJson = [System.IO.File]::ReadAllText($paths['SettingsPath']) | ConvertFrom-Json } catch { throw 'Refusing: settings file is not valid JSON.' }
                    if ($settingsJson -isnot [PSCustomObject]) { throw 'Refusing: settings must be a JSON object.' }
                    if ($noStop) {
                        # No-output-stop mode: settings must be exactly an empty object; no output-cap, permission or ambient keys.
                        if (@($settingsJson.PSObject.Properties).Count -ne 0) { throw 'Refusing: OutputStopProfile settings must be exactly an empty JSON object.' }
                    } else {
                    $topNames = @($settingsJson.PSObject.Properties.Name)
                    if ($topNames.Count -ne 1 -or $topNames[0] -cne 'env') { throw 'Refusing: settings must contain only the env key; no permissions/defaultMode/ambient keys.' }
                    $envObj = $settingsJson.env
                    if ($envObj -isnot [PSCustomObject]) { throw 'Refusing: settings env must be a JSON object.' }
                    $envNames = @($envObj.PSObject.Properties.Name)
                    if ($envNames.Count -ne 1 -or $envNames[0] -cne 'CLAUDE_CODE_MAX_OUTPUT_TOKENS') { throw 'Refusing: settings env must contain only CLAUDE_CODE_MAX_OUTPUT_TOKENS.' }
                    $capVal = $envObj.CLAUDE_CODE_MAX_OUTPUT_TOKENS
                    $capOk = $false
                    if ($capVal -is [string] -and $capVal -cmatch '^[1-9][0-9]*$') {
                        $parsedCap = [long]0
                        if ([long]::TryParse($capVal, [ref]$parsedCap) -and $parsedCap -gt 0) { $capOk = $true }
                    } elseif (($capVal -is [int] -or $capVal -is [long]) -and $capVal -gt 0) { $capOk = $true }
                    if (-not $capOk) { throw 'Refusing: settings CLAUDE_CODE_MAX_OUTPUT_TOKENS must be a positive finite token cap.' }
                    }
                    $settingsApplied = $true
                    $argList[$ai] = $paths['SettingsPath']
                    $ai++
                }
                '--tools' { if ((& $optVal $ai) -cne 'Read,Edit') { throw 'Refusing: tools must be exactly Read,Edit.' }; $ai++ }
                '--allowedTools' {
                    $cnt = 0
                    while ($ai -lt $argList.Count -and $argList[$ai] -cnotlike '--*') {
                        if ($argList[$ai] -cnotmatch '^(Read|Edit)[(][^*?<>|]+[)]$') { throw 'Refusing: allowedTools value is not a literal scoped Read/Edit grant.' }
                        $cnt++; $ai++
                    }
                    if ($cnt -eq 0) { throw 'Refusing: allowedTools requires scoped values.' }
                }
                default { throw 'Refusing: unsupported or unknown option.' }
            }
        }
        if (-not $hasPrint -or -not $settingsApplied -or -not $seenOpt.ContainsKey('--tools') -or -not $seenOpt.ContainsKey('--allowedTools')) { throw 'Refusing: author mode requires --print, the exact captured --settings, --tools, and --allowedTools.' }
        if ($noStop -and (-not $seenOpt.ContainsKey('--verbose') -or -not $seenOpt.ContainsKey('--output-format'))) { throw 'Refusing: OutputStopProfile requires --print, --verbose and --output-format stream-json.' }
        if ($seenOpt.ContainsKey('--include-partial-messages') -and (-not $hasPrint -or -not $seenOpt.ContainsKey('--output-format'))) { throw 'Refusing: --include-partial-messages requires --print and --output-format stream-json.' }
    }
    $reserved = '^(run[.]lock|manifest[.]json|start[.]json|stdout[.]bin|stderr[.]bin|terminal[.]json|projection[.]json|projection[.]lock)([.]tmp-.*)?$'
    $seen = @{}
    foreach ($k in 'TicketPath','PayloadPath','GateTicketPath','SettingsPath','ArtifactPath') {
        $norm = $paths[$k].ToLowerInvariant()
        if ($seen.ContainsKey($norm)) { throw 'Refusing: request paths collide.' }
        $seen[$norm] = $true
        if (([System.IO.Path]::GetDirectoryName($paths[$k]) -ieq $runDirFull) -and ([System.IO.Path]::GetFileName($paths[$k]) -imatch $reserved)) {
            throw 'Refusing: request path collides with a reserved RunDir output name.'
        }
    }
    foreach ($k in 'TicketPath','PayloadPath','GateTicketPath','SettingsPath') {
        if (-not (Test-Path -LiteralPath $paths[$k] -PathType Leaf)) { throw ('Refusing: ' + $k + ' is not a readable file.') }
    }
    if (-not (Test-Path -LiteralPath $paths['WorkingDirectory'] -PathType Container)) { throw 'Refusing: WorkingDirectory is not a directory.' }
    foreach ($k in 'TicketPath','PayloadPath','GateTicketPath','SettingsPath') {
        if ($bytes.ContainsKey($k)) { continue }
        try { $bytes[$k] = [System.IO.File]::ReadAllBytes($paths[$k]) } catch { throw ('Refusing: ' + $k + ' is not readable.') }
        $sha[$k] = Get-Sha256Hex $bytes[$k]
    }
    Assert-NativeStructuredOutputBinding -Request $Request -CapturedTicket $bytes['TicketPath'] -SchemaArgument $schemaArgument -HasSchemaArgument $hasSchemaArgument
    # canonical8 is the strict native receipt path. Legacy requests keep their existing contract.
    # Captured bytes only: validate before any lock, reservation, replay, callback or provider transition.
    $nativeTicketContract = $null
    $aggregateAuthority = $null
    $outputStopAuthority = $null
    if ($Request.ContainsKey('StructuredOutputProfile') -or $noStop) {
        . (Join-Path $runnerDir '../dispatch/native-ticket-contract.ps1')
        if ($noStop) { . (Join-Path $runnerDir '../dispatch/managed-output-stop-authority.ps1') }
        try {
            $nativeText = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes['TicketPath'])
            $nativeTicket = $nativeText.TrimStart([char]0xFEFF) | ConvertFrom-Json -DateKind String -ErrorAction Stop
        } catch { throw 'Refusing: native ticket must be strict UTF-8 JSON.' }
        $nativeTicketContract = Test-ManagedNativeTicketContract -Ticket $nativeTicket -ExpectedPayloadSha256 $sha['PayloadPath']
        if (-not $nativeTicketContract.Valid) { throw ('Refusing: native ticket contract: ' + ($nativeTicketContract.Issues -join ',')) }
        if ($nativeTicketContract.Budget.ElapsedMs -ne $num['MaxElapsedMs']) { throw 'Refusing: native ticket budget.elapsedMs must equal request MaxElapsedMs.' }
        # Refuses (throws) on malformed/unauthenticated advisory before any lock, reservation or process.
        $osControlRoot = Join-Path $paths['WorkingDirectory'] '.factory-data/chief/controller-runtime/control'
        $contractMode = $null
        if ($null -ne $nativeTicketContract.PSObject.Properties['OutputStopMode']) { $contractMode = $nativeTicketContract.OutputStopMode }
        if ($noStop) {
            # Selector is not authority: the descriptor must be present and authenticated by the trusted sibling helper before any reservation.
            if ($contractMode -isnot [string] -or $contractMode -cne 'OBSERVE_ONLY_DESCRIPTOR') { throw 'Refusing: OutputStopProfile selector requires an OBSERVE_ONLY_DESCRIPTOR ticket contract.' }
            $osAuth = Resolve-ManagedOutputStopAuthority -TicketContract $nativeTicketContract -CapturedTicket ([byte[]]($bytes['TicketPath'].Clone())) -ControlRoot $osControlRoot
            if ($null -eq $osAuth -or $osAuth.Mode -isnot [string] -or $osAuth.Mode -cne 'OBSERVE_ONLY') { throw 'Refusing: output stop authority is not OBSERVE_ONLY.' }
            $outputStopAuthority = $osAuth
        } elseif ($contractMode -ceq 'OBSERVE_ONLY_DESCRIPTOR') {
            throw 'Refusing: ticket carries a no-output-stop descriptor but the request has no OutputStopProfile selector.'
        }
        $aggAdv = Resolve-ManagedAggregateAdvisory -TicketContract $nativeTicketContract -CapturedTicket ([byte[]]($bytes['TicketPath'].Clone())) -ControlRoot $osControlRoot
        if ($null -ne $aggAdv -and $aggAdv.Mode -ceq 'AUTHENTICATED_ADVISORY') {
            if ($null -eq $tokenAccountingPolicy -and -not $noStop) { throw 'Refusing: authenticated aggregate advisory requires a TokenAccountingPolicy.' }
            $aggregateAuthority = $aggAdv
        }
    }
    $tokenAccountingState = $null
    $tokenStdoutTruncated = $false
    $tokenAccountingSnapshot = $null
    $tapCore = $null
    if ($null -ne $tokenAccountingPolicy) {
        # Opt-in only: validated from captured ticket bytes and captured policy clone; ticket file is never re-read.
        if ($settingsApplied -ne $true) { throw 'Refusing: TokenAccountingPolicy requires actual author mode.' }
        $tapArgs = @($argList)
        foreach ($tf in @('--print','--include-partial-messages')) {
            if (-not $seenOpt.ContainsKey($tf)) { throw ('Refusing: TokenAccountingPolicy requires ' + $tf + '.') }
            if (@($tapArgs | Where-Object { $_ -is [string] -and $_ -ceq $tf }).Count -ne 1) { throw ('Refusing: TokenAccountingPolicy requires exactly one ' + $tf + ' in arguments.') }
        }
        if (-not $seenOpt.ContainsKey('--output-format')) { throw 'Refusing: TokenAccountingPolicy requires --output-format.' }
        $tapFmtIdx = -1
        $tapFmtCount = 0
        for ($ti = 0; $ti -lt $tapArgs.Count; $ti++) {
            if ($tapArgs[$ti] -is [string] -and $tapArgs[$ti] -ceq '--output-format') { $tapFmtCount++; $tapFmtIdx = $ti }
        }
        if ($tapFmtCount -ne 1 -or ($tapFmtIdx + 1) -ge $tapArgs.Count -or $tapArgs[$tapFmtIdx + 1] -isnot [string] -or $tapArgs[$tapFmtIdx + 1] -cne 'stream-json') {
            throw 'Refusing: TokenAccountingPolicy requires --output-format stream-json.'
        }
        if ($tokenAccountingPolicy['MaxInputBytes'] -gt [long]$num['MaxStreamBytes']) { throw 'Refusing: TokenAccountingPolicy MaxInputBytes exceeds MaxStreamBytes.' }
        $tapTicketBytes = [byte[]]($bytes['TicketPath'].Clone())
        $tapOffset = 0
        if ($tapTicketBytes.Length -ge 3 -and $tapTicketBytes[0] -eq 0xEF -and $tapTicketBytes[1] -eq 0xBB -and $tapTicketBytes[2] -eq 0xBF) { $tapOffset = 3 }
        try {
            $tapStrict = [System.Text.UTF8Encoding]::new($false, $true)
            $tapText = $tapStrict.GetString($tapTicketBytes, $tapOffset, $tapTicketBytes.Length - $tapOffset)
        } catch { throw 'Refusing: ticket is not strict UTF-8.' }
        try { $tapDoc = $tapText | ConvertFrom-Json } catch { throw 'Refusing: ticket is not valid JSON.' }
        if ($tapDoc -isnot [System.Management.Automation.PSCustomObject]) { throw 'Refusing: ticket JSON root must be an object.' }
        if ($null -ne $nativeTicketContract) {
            $tapHist = $nativeTicketContract.Budget.HistoricalOutputTokens
            $tapAdd = $nativeTicketContract.Budget.AdditionalOutputMax
            $tapCeil = $nativeTicketContract.Budget.PhaseAggregateCeiling
        } else {
        # Assumption: nested budget object is the exact-case root property 'budget'.
        $tapBudgetProp = @($tapDoc.PSObject.Properties | Where-Object { $_.Name -ceq 'budget' })
        if ($tapBudgetProp.Count -ne 1) { throw 'Refusing: ticket budget object missing.' }
        $tapBudget = $tapBudgetProp[0].Value
        if ($tapBudget -isnot [System.Management.Automation.PSCustomObject]) { throw 'Refusing: ticket budget must be an object.' }
        $tapBv = @{}
        foreach ($bn in @('historicalOutputTokens','additionalOutputMax','phaseAggregateCeiling')) {
            $bp = @($tapBudget.PSObject.Properties | Where-Object { $_.Name -ceq $bn })
            if ($bp.Count -ne 1) { throw ('Refusing: ticket budget field ' + $bn + ' missing.') }
            $bvv = $bp[0].Value
            if ($bvv -isnot [int] -and $bvv -isnot [long]) { throw ('Refusing: ticket budget field ' + $bn + ' must be an integer.') }
            $tapBv[$bn] = [long]$bvv
        }
        $tapHist = [long]$tapBv['historicalOutputTokens']
        $tapAdd = [long]$tapBv['additionalOutputMax']
        $tapCeil = [long]$tapBv['phaseAggregateCeiling']
        }
        if ($tapHist -lt 0) { throw 'Refusing: historicalOutputTokens must be >= 0.' }
        if ($tapAdd -le 0) { throw 'Refusing: additionalOutputMax must be > 0.' }
        if ($tapCeil -le 0 -or ($null -eq $aggregateAuthority -and $tapCeil -le $tapHist)) { throw 'Refusing: phaseAggregateCeiling must exceed historicalOutputTokens.' }
        if ($null -ne $aggregateAuthority) {
            $tapRemaining = [long]$tapAdd
        } else {
            $tapRoom = [long]($tapCeil - $tapHist)
            $tapRemaining = [long]([Math]::Min($tapAdd, $tapRoom))
        }
        if ($tapRemaining -le 0) { throw 'Refusing: no remaining token budget.' }
        $tapMaxMessages = [long]$tokenAccountingPolicy['MaxMessages']
        $tapMaxEvents = [long]$tokenAccountingPolicy['MaxEvents']
        $tapMaxLineBytes = [long]$tokenAccountingPolicy['MaxLineBytes']
        $tapMaxInputBytes = [long]$tokenAccountingPolicy['MaxInputBytes']
        $tapCore = [ordered]@{
            MaxMessages = $tapMaxMessages; MaxEvents = $tapMaxEvents; MaxLineBytes = $tapMaxLineBytes; MaxInputBytes = $tapMaxInputBytes
            RemainingTokens = $tapRemaining; HistoricalOutputTokens = $tapHist; AdditionalOutputMax = $tapAdd; PhaseAggregateCeiling = $tapCeil
        }
        $tokenAccountingState = New-ManagedTokenAccountingState -RemainingTokens $tapRemaining -MaxMessages $tapMaxMessages -MaxEvents $tapMaxEvents -MaxLineBytes $tapMaxLineBytes -MaxInputBytes $tapMaxInputBytes
    }
    $core = [ordered]@{
        schema = 'ManagedNativeCollector/v1'; runId = $runId; attempt = $num['Attempt']
        executable = $exePath; arguments = $argList; workingDirectory = $paths['WorkingDirectory']
        ticketPath = $paths['TicketPath']; ticketSha256 = $sha['TicketPath']
        payloadPath = $paths['PayloadPath']; payloadSha256 = $sha['PayloadPath']
        gateTicketPath = $paths['GateTicketPath']; gateTicketSha256 = $sha['GateTicketPath']
        settingsPath = $paths['SettingsPath']; settingsSha256 = $sha['SettingsPath']
        artifactPath = $paths['ArtifactPath']
        maxElapsedMs = $num['MaxElapsedMs']; maxStreamBytes = $num['MaxStreamBytes']; runDir = $runDirFull
        settingsApplied = $settingsApplied; ackMode = ($null -ne $ctx); ackContext = $ctx
    }
    if ($Request.ContainsKey('StructuredOutputProfile')) {
        # The profile and captured ticket pin have already passed the binding above.
        $core['nativeStructuredOutput'] = [ordered]@{
            profileId = 'canonical8-v1'
            schemaSha256 = 'fd655794f2298daf88877d652f94736ed2e74cf520b3278f694b141d492b8cfa'
        }
    }
    if ($null -ne $tapCore) { $core['tokenAccountingPolicy'] = $tapCore }
    if ($null -ne $aggregateAuthority) { $core['aggregateAdvisory'] = $aggregateAuthority }
    if ($noStop) {
        $core['outputStopProfile'] = 'observe-only-v1'
        $core['outputStopAuthority'] = $outputStopAuthority
    }
    $canonical = ConvertTo-Json -InputObject $core -Compress -Depth 4
    $requestSha = Get-Sha256OfString $canonical
    $manifestPath = Join-Path $runDirFull 'manifest.json'
    $startPath = Join-Path $runDirFull 'start.json'
    $outPath = Join-Path $runDirFull 'stdout.bin'
    $errPath = Join-Path $runDirFull 'stderr.bin'
    $terminalPath = Join-Path $runDirFull 'terminal.json'
    $projPath = Join-Path $runDirFull 'projection.json'
    $readJson = { param($path, $what) try { [System.IO.File]::ReadAllText($path) | ConvertFrom-Json } catch { throw ('Refusing: persisted ' + $what + ' is malformed.') } }
    $hasProp = {
        param($o, $names)
        if ($null -eq $o) { return $false }
        foreach ($n in $names) { if ($null -eq $o.PSObject.Properties[$n]) { return $false } }
        return $true
    }
    $hashOf = { param($f) if (Test-Path -LiteralPath $f -PathType Leaf) { (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null } }

    # F2 shared strict persisted-evidence validator. Rereads every persisted record from disk under the
    # caller's already-held lock and validates the full frozen field set (manifest/start/terminal tuple/
    # stream leaves/artifact/keyed acknowledgement/projection) before any return, save or callback.
    # Pure verification: it never spawns, acknowledges, writes or respawns, and is reusable unchanged
    # under fresh projection ownership.
    $stepScriptPath = [System.IO.Path]::GetFullPath((Join-Path $runnerDir '../dispatch/continuation-step.ps1'))
    $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
    $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}$') }
    $isUtc = {
        param($v)
        if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v)) { return $false }
        $parsed = [DateTime]::MinValue
        if (-not [DateTime]::TryParse($v, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) { return $false }
        return ($parsed.Kind -eq [DateTimeKind]::Utc)
    }
    $readRecord = { param($path, $what) try { [System.IO.File]::ReadAllText($path) | ConvertFrom-Json -DateKind String } catch { throw ('Refusing: persisted ' + $what + ' is malformed.') } }
    $validatePersistedEvidence = {
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Refusing: persisted manifest is absent.' }
        $vMan = & $readRecord $manifestPath 'manifest'
        if ($vMan -isnot [PSCustomObject] -or -not (& $hasProp $vMan @('schema','requestCanonical','requestSha256','reservedUtc','gateStatus','gateResultSha256'))) { throw 'Refusing: persisted manifest is malformed.' }
        if ($vMan.schema -isnot [string] -or $vMan.schema -cne 'ManagedNativeCollector/v1') { throw 'Refusing: persisted manifest schema is not ManagedNativeCollector/v1.' }
        if ($vMan.requestCanonical -isnot [string] -or $vMan.requestCanonical -cne $canonical) { throw 'Refusing: changed request for an already reserved run directory.' }
        if (-not (& $isHex $vMan.requestSha256) -or $vMan.requestSha256 -cne $requestSha -or $vMan.requestSha256 -cne (Get-Sha256OfString $vMan.requestCanonical)) { throw 'Refusing: persisted manifest request hash is not the actual canonical request hash.' }
        if (-not (& $isUtc $vMan.reservedUtc)) { throw 'Refusing: persisted manifest reservedUtc is not a UTC date string.' }
        if ($vMan.gateStatus -isnot [string] -or $vMan.gateStatus -cne 'PASS') { throw 'Refusing: persisted manifest does not record a PASS gate.' }
        if (-not (& $isHex $vMan.gateResultSha256)) { throw 'Refusing: persisted manifest gateResultSha256 is not lower-case 64hex.' }
        $vManSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($manifestPath))

        $vStart = $null
        if (Test-Path -LiteralPath $startPath -PathType Leaf) {
            $vStart = & $readRecord $startPath 'start'
            if ($vStart -isnot [PSCustomObject] -or -not (& $hasProp $vStart @('schema','runId','attempt','requestSha256','pid','startTimeUtc','persistedUtc'))) { throw 'Refusing: persisted start record is malformed.' }
            if ($vStart.schema -isnot [string] -or $vStart.schema -cne 'ManagedNativeStart/v1') { throw 'Refusing: persisted start schema is not ManagedNativeStart/v1.' }
            if ($vStart.runId -isnot [string] -or $vStart.runId -cne $runId) { throw 'Refusing: persisted start runId does not match the captured run.' }
            if (-not (& $isInt $vStart.attempt) -or [long]$vStart.attempt -le 0 -or [long]$vStart.attempt -ne $num['Attempt']) { throw 'Refusing: persisted start attempt is not the captured positive attempt.' }
            if (-not (& $isHex $vStart.requestSha256) -or $vStart.requestSha256 -cne $requestSha) { throw 'Refusing: persisted start is bound to another request.' }
            if (-not (& $isInt $vStart.pid) -or [long]$vStart.pid -le 0) { throw 'Refusing: persisted start pid is not a positive typed integer.' }
            if (-not (& $isUtc $vStart.startTimeUtc) -or -not (& $isUtc $vStart.persistedUtc)) { throw 'Refusing: persisted start times are not UTC date strings.' }
        }
        $vTerm = $null; $vTermSha = $null; $vReconcile = $null
        if (Test-Path -LiteralPath $terminalPath -PathType Leaf) {
            $vTerm = & $readRecord $terminalPath 'terminal'
            if ($vTerm -isnot [PSCustomObject] -or -not (& $hasProp $vTerm @('schema','runId','attempt','requestSha256','ticketSha256','payloadSha256','gateTicketSha256','settingsSha256','manifestSha256','pid','startTimeUtc','endedUtc','reason','errorCode','definitive','exitObserved','exitCode','onStartedAcknowledged','observedBytes','retainedBytes','drainComplete','stdinError','stdout','stderr','artifact'))) {
                throw 'Refusing: persisted terminal is malformed.'
            }
            if ($vTerm.schema -isnot [string] -or $vTerm.schema -cne 'ManagedNativeTerminal/v1') { throw 'Refusing: persisted terminal schema is not ManagedNativeTerminal/v1.' }
            if ($vTerm.runId -isnot [string] -or $vTerm.runId -cne $runId) { throw 'Refusing: persisted terminal runId does not match the captured run.' }
            if (-not (& $isInt $vTerm.attempt) -or [long]$vTerm.attempt -le 0 -or [long]$vTerm.attempt -ne $num['Attempt']) { throw 'Refusing: persisted terminal attempt is not the captured positive attempt.' }
            if (-not (& $isHex $vTerm.requestSha256) -or $vTerm.requestSha256 -cne $requestSha) { throw 'Refusing: persisted terminal is bound to another request.' }
            foreach ($bind in @(@('ticketSha256','TicketPath'), @('payloadSha256','PayloadPath'), @('gateTicketSha256','GateTicketPath'), @('settingsSha256','SettingsPath'))) {
                if (-not (& $isHex $vTerm.($bind[0])) -or $vTerm.($bind[0]) -cne $sha[$bind[1]]) { throw ('Refusing: persisted terminal ' + $bind[0] + ' does not match the captured input hash.') }
            }
            if (-not (& $isHex $vTerm.manifestSha256) -or $vTerm.manifestSha256 -cne $vManSha) { throw 'Refusing: persisted terminal manifestSha256 does not match the actual manifest file.' }
            if (-not (& $isUtc $vTerm.endedUtc)) { throw 'Refusing: persisted terminal endedUtc is not a UTC date string.' }
            $vReasons = @('NATURAL_EXIT','DEADLINE','EXIT_WAIT_TIMEOUT','STREAM_BYTE_OVERFLOW','START_FAILED','START_PERSIST_FAILED','ONSTARTED_FAILED','COLLECTOR_FAULT','TOKEN_ACCOUNTING_STOP')
            if ($vTerm.reason -isnot [string] -or $vReasons -cnotcontains $vTerm.reason) { throw 'Refusing: persisted terminal reason is not a produced terminal reason.' }
            if ($null -ne $vTerm.errorCode -and ($vTerm.errorCode -isnot [string] -or [string]::IsNullOrWhiteSpace($vTerm.errorCode))) { throw 'Refusing: persisted terminal errorCode must be null or a nonblank string.' }
            foreach ($bf in 'definitive','exitObserved','onStartedAcknowledged','drainComplete','stdinError') {
                if ($vTerm.$bf -isnot [bool]) { throw ('Refusing: persisted terminal ' + $bf + ' is not a typed boolean.') }
            }
            if (& $hasProp $vTerm 'onStartedFailureStage') {
                $vOfs = $vTerm.onStartedFailureStage
                if ($null -ne $vOfs) {
                    $vOfsStages = @('ACK_PREPARATION','PRE_ACK_ALIVE_CHECK','BUILD_VALIDATE_ACK','RECORD_ACK','VALIDATE_ACK_RESULT','POST_ACK_ALIVE_CHECK')
                    if ($vOfs -isnot [string] -or $vOfsStages -cnotcontains $vOfs) { throw 'Refusing: persisted terminal onStartedFailureStage is not a recognized failure stage.' }
                    if ($vTerm.reason -cne 'ONSTARTED_FAILED') { throw 'Refusing: persisted terminal onStartedFailureStage is set without reason ONSTARTED_FAILED.' }
                    if ($vTerm.onStartedAcknowledged) { throw 'Refusing: persisted terminal onStartedFailureStage is inconsistent with onStartedAcknowledged true.' }
                } elseif ($vTerm.reason -ceq 'ONSTARTED_FAILED') {
                    throw 'Refusing: persisted terminal reason ONSTARTED_FAILED with a null onStartedFailureStage.'
                }
            }
            if ($vTerm.exitObserved) {
                if (-not (& $isInt $vTerm.exitCode)) { throw 'Refusing: persisted terminal observed an exit without a typed integer exitCode.' }
            } elseif ($null -ne $vTerm.exitCode) {
                throw 'Refusing: persisted terminal reports an exitCode without an observed exit.'
            }
            foreach ($cf in 'observedBytes','retainedBytes') {
                if (-not (& $isInt $vTerm.$cf) -or [long]$vTerm.$cf -lt 0) { throw ('Refusing: persisted terminal ' + $cf + ' is not a nonnegative typed integer.') }
            }
            if ([long]$vTerm.retainedBytes -gt [long]$vTerm.observedBytes) { throw 'Refusing: persisted terminal retained more bytes than it observed.' }
            if (-not $noStop -and [long]$vTerm.retainedBytes -gt $num['MaxStreamBytes']) { throw 'Refusing: persisted terminal retained bytes exceed the captured stream cap.' }
            $osHasV = [bool](& $hasProp $vTerm @('outputStopProfile','outputStopAuthority','usageTelemetry'))
            $osAnyV = [bool](& $hasProp $vTerm @('outputStopProfile')) -or [bool](& $hasProp $vTerm @('outputStopAuthority')) -or [bool](& $hasProp $vTerm @('usageTelemetry'))
            if (-not $noStop) {
                if ($osAnyV) { throw 'Refusing: terminal carries output stop metadata without a captured OutputStopProfile.' }
            } else {
                if (-not $osHasV) { throw 'Refusing: terminal is missing the required output stop metadata.' }
                if ($vTerm.outputStopProfile -isnot [string] -or $vTerm.outputStopProfile -cne 'observe-only-v1') { throw 'Refusing: terminal outputStopProfile does not equal the captured profile.' }
                if ((ConvertTo-Json -InputObject $vTerm.outputStopAuthority -Compress -Depth 4) -cne (ConvertTo-Json -InputObject $outputStopAuthority -Compress -Depth 4)) { throw 'Refusing: terminal outputStopAuthority does not equal the captured authenticated authority.' }
                if (@('STREAM_BYTE_OVERFLOW','TOKEN_ACCOUNTING_STOP') -ccontains $vTerm.reason) { throw 'Refusing: terminal carries an artificial output stop reason in OutputStopProfile mode.' }
                $ut = $vTerm.usageTelemetry
                $utFields = @('schema','status','outputTokens','stdoutBytes','stdoutSha256','stderrBytes','stderrSha256')
                if ($ut -isnot [PSCustomObject] -or @($ut.PSObject.Properties).Count -ne $utFields.Count) { throw 'Refusing: terminal usageTelemetry field set is not exact.' }
                $utNames = @($ut.PSObject.Properties | ForEach-Object { $_.Name }); foreach ($utn in $utFields) { if ($utNames -cnotcontains $utn) { throw 'Refusing: terminal usageTelemetry field set is not exact.' } }
                if ($ut.schema -isnot [string] -or $ut.schema -cne 'ManagedUsageTelemetry/v1' -or $ut.status -isnot [string] -or $ut.status -cne 'RAW_SDK_RESULT_PENDING' -or $null -ne $ut.outputTokens) { throw 'Refusing: terminal usageTelemetry must be RAW_SDK_RESULT_PENDING with null outputTokens.' }
                if (-not (& $isInt $ut.stdoutBytes) -or [long]$ut.stdoutBytes -ne [long]$vTerm.stdout.retainedBytes -or -not (& $isInt $ut.stderrBytes) -or [long]$ut.stderrBytes -ne [long]$vTerm.stderr.retainedBytes) { throw 'Refusing: terminal usageTelemetry byte counts do not match the raw stream leaves.' }
                foreach ($utp in @(@('stdoutSha256','stdout'), @('stderrSha256','stderr'))) {
                    if ($null -ne $ut.($utp[0]) -and -not (& $isHex $ut.($utp[0]))) { throw 'Refusing: terminal usageTelemetry hash is not lower-case 64hex.' }
                    if (($null -eq $ut.($utp[0])) -ne ($null -eq $vTerm.($utp[1]).sha256) -or ($null -ne $ut.($utp[0]) -and $ut.($utp[0]) -cne $vTerm.($utp[1]).sha256)) { throw 'Refusing: terminal usageTelemetry hash does not match the raw stream leaf.' }
                }
            }
            $taReasonV = $null
            if (& $hasProp $vTerm @('reason')) { $taReasonV = $vTerm.reason }
            $taHasV = [bool](& $hasProp $vTerm @('tokenAccounting'))
            $taStopV = ($taReasonV -is [string] -and $taReasonV -ceq 'TOKEN_ACCOUNTING_STOP')
            $aaHasV = [bool](& $hasProp $vTerm @('aggregateAdvisory'))
            if ($null -eq $aggregateAuthority) {
                if ($aaHasV) { throw 'Refusing: terminal aggregateAdvisory present without an authenticated captured advisory.' }
            } else {
                if (-not $aaHasV) { throw 'Refusing: terminal is missing the required aggregateAdvisory record.' }
                if ((ConvertTo-Json -InputObject $vTerm.aggregateAdvisory -Compress -Depth 4) -cne (ConvertTo-Json -InputObject $aggregateAuthority -Compress -Depth 4)) { throw 'Refusing: terminal aggregateAdvisory does not equal the captured advisory snapshot.' }
            }
            if ($null -eq $tapCore) {
                if ($taHasV -or $taStopV) { throw 'Refusing: terminal tokenAccounting or TOKEN_ACCOUNTING_STOP present without a captured token accounting policy.' }
            } else {
                if (-not $taHasV) { throw 'Refusing: terminal is missing the required tokenAccounting record.' }
                $ta = $vTerm.tokenAccounting
                if ($ta -isnot [System.Management.Automation.PSCustomObject]) { throw 'Refusing: terminal tokenAccounting must be an object record.' }
                $taFields = @('schema','policy','observedOutputTokens','messageCount','firstTrigger','invalid','resultAggregate','resultConsistent','inputBytes','bufferedLineBytes','parseComplete','stdoutEof','stdoutTruncated')
                $taNames = @($ta.PSObject.Properties | ForEach-Object { [string]$_.Name })
                if ($taNames.Count -ne 13) { throw 'Refusing: terminal tokenAccounting must have exactly 13 fields.' }
                foreach ($taN in $taFields) { if ($taNames -cnotcontains $taN) { throw 'Refusing: terminal tokenAccounting field set is not exact.' } }
                if ($ta.schema -isnot [string] -or $ta.schema -cne 'ManagedTokenAccounting/v1') { throw 'Refusing: terminal tokenAccounting schema is invalid.' }
                $taPol = $ta.policy
                if ($taPol -isnot [System.Management.Automation.PSCustomObject]) { throw 'Refusing: terminal tokenAccounting policy must be an object record.' }
                $taPolFields = @('MaxMessages','MaxEvents','MaxLineBytes','MaxInputBytes','RemainingTokens','HistoricalOutputTokens','AdditionalOutputMax','PhaseAggregateCeiling')
                $taPolNames = @($taPol.PSObject.Properties | ForEach-Object { [string]$_.Name })
                if ($taPolNames.Count -ne 8) { throw 'Refusing: terminal tokenAccounting policy must have exactly 8 keys.' }
                for ($taI = 0; $taI -lt 8; $taI++) {
                    if ($taPolNames -cnotcontains $taPolFields[$taI]) { throw 'Refusing: terminal tokenAccounting policy keys are not exact.' }
                    $taPv = $taPol.($taPolFields[$taI])
                    if (-not (& $isInt $taPv) -or [long]$taPv -ne [long]$tapCore[$taI]) { throw 'Refusing: terminal tokenAccounting policy does not match the captured policy.' }
                }
                foreach ($taC in @('observedOutputTokens','messageCount','inputBytes','bufferedLineBytes')) {
                    $taCv = $ta.$taC
                    if (-not (& $isInt $taCv) -or [long]$taCv -lt 0) { throw 'Refusing: terminal tokenAccounting counters must be nonnegative integers.' }
                }
                foreach ($taB in @('invalid','parseComplete','stdoutEof','stdoutTruncated')) {
                    if ($ta.$taB -isnot [bool]) { throw 'Refusing: terminal tokenAccounting flags must be booleans.' }
                }
                if ($null -ne $ta.firstTrigger) {
                    if ($ta.firstTrigger -isnot [string] -or @('MAX_TOKENS','TOKEN_LIMIT','PARSE_INVALID','STATE_LIMIT','INPUT_LIMIT') -cnotcontains $ta.firstTrigger) { throw 'Refusing: terminal tokenAccounting firstTrigger is invalid.' }
                }
                if ($null -ne $ta.resultAggregate) {
                    if (-not (& $isInt $ta.resultAggregate) -or [long]$ta.resultAggregate -lt 0) { throw 'Refusing: terminal tokenAccounting resultAggregate is invalid.' }
                }
                if ($null -ne $ta.resultConsistent -and $ta.resultConsistent -isnot [bool]) { throw 'Refusing: terminal tokenAccounting resultConsistent is invalid.' }
                $taRetV = $vTerm.stdout.retainedBytes
                if (-not (& $isInt $taRetV)) { throw 'Refusing: terminal stdout retainedBytes is not an integer.' }
                if ([long]$ta.messageCount -gt [long]$tapCore[0]) { throw 'Refusing: terminal tokenAccounting messageCount exceeds the policy.' }
                if ([long]$ta.inputBytes -gt [long]$tapCore[3] -or [long]$ta.inputBytes -gt [long]$taRetV) { throw 'Refusing: terminal tokenAccounting inputBytes exceeds the policy or retained stdout.' }
                if ([long]$ta.bufferedLineBytes -gt ([long]$tapCore[2] + 1)) { throw 'Refusing: terminal tokenAccounting bufferedLineBytes exceeds the policy.' }
                if ($ta.parseComplete) {
                    if (-not $ta.stdoutEof -or $ta.stdoutTruncated -or $ta.invalid -or [long]$ta.inputBytes -ne [long]$taRetV -or [long]$ta.bufferedLineBytes -ne 0) { throw 'Refusing: terminal tokenAccounting parseComplete is inconsistent with stdout evidence.' }
                }
                if (($null -eq $ta.resultAggregate) -ne ($null -eq $ta.resultConsistent)) { throw 'Refusing: terminal tokenAccounting resultAggregate and resultConsistent must both be null or both be present.' }
                if ($null -ne $ta.resultConsistent -and -not $ta.resultConsistent -and -not $ta.invalid) { throw 'Refusing: terminal tokenAccounting resultConsistent false requires invalid accounting.' }
                if ($null -ne $ta.firstTrigger -and @('PARSE_INVALID','STATE_LIMIT','INPUT_LIMIT') -ccontains $ta.firstTrigger -and -not $ta.invalid) { throw 'Refusing: terminal tokenAccounting firstTrigger requires invalid accounting.' }
                if ($ta.invalid -and $null -eq $ta.firstTrigger) { throw 'Refusing: terminal tokenAccounting invalid accounting requires a recorded firstTrigger.' }
                if ($null -ne $ta.firstTrigger -and $ta.firstTrigger -ceq 'TOKEN_LIMIT' -and [long]$ta.observedOutputTokens -lt [long]$tapCore[4]) { throw 'Refusing: terminal tokenAccounting TOKEN_LIMIT requires observedOutputTokens to reach the captured RemainingTokens.' }
                if ($taStopV -and $null -eq $ta.firstTrigger -and -not $ta.invalid) { throw 'Refusing: TOKEN_ACCOUNTING_STOP requires a recorded trigger or invalid accounting.' }
            }
            if ($null -ne $vStart) {
                if (-not (& $isInt $vTerm.pid) -or [long]$vTerm.pid -ne [long]$vStart.pid) { throw 'Refusing: persisted terminal pid does not match the actual persisted start record.' }
                if (-not (& $isUtc $vTerm.startTimeUtc) -or $vTerm.startTimeUtc -cne $vStart.startTimeUtc) { throw 'Refusing: persisted terminal startTimeUtc does not match the actual persisted start record.' }
            } elseif ($null -eq $vTerm.pid -and $null -eq $vTerm.startTimeUtc) {
                if ($vTerm.reason -cne 'START_FAILED') { throw 'Refusing: persisted terminal has no start identity without a declared failed start.' }
            } else {
                if ($vTerm.reason -cne 'START_PERSIST_FAILED') { throw 'Refusing: persisted terminal claims a start identity with no persisted start record.' }
                if (-not (& $isInt $vTerm.pid) -or [long]$vTerm.pid -le 0 -or -not (& $isUtc $vTerm.startTimeUtc)) { throw 'Refusing: persisted terminal start identity is not an actual positive pid and UTC start.' }
            }
            if (& $hasProp $vTerm 'stopFacts') { $sf = $vTerm.stopFacts; if ($null -eq $sf) { if ($null -ne $vTerm.pid -or $null -ne $vTerm.startTimeUtc) { throw 'terminal stopFacts null with started identity' } } else { if ($sf -isnot [pscustomobject]) { throw 'terminal stopFacts not an object' }; $sfNames = @('pid','startTimeUtc','deadlineObservedUtc','elapsedMs','alive','aliveAtStop','killAttempted','killErrorCode'); if (@($sf.PSObject.Properties).Count -ne $sfNames.Count) { throw 'terminal stopFacts member set mismatch' }; foreach ($sfn in $sfNames) { if (-not (& $hasProp $sf $sfn)) { throw ('terminal stopFacts missing member ' + $sfn) }; if ($sf.$sfn -is [array]) { throw ('terminal stopFacts array member ' + $sfn) } }; if ($null -eq $vTerm.pid -or $null -eq $vTerm.startTimeUtc) { throw 'terminal stopFacts without started identity' }; if (-not (& $isInt $sf.pid) -or -not (& $isInt $vTerm.pid) -or $sf.pid -le 0 -or $sf.pid -ne $vTerm.pid) { throw 'terminal stopFacts pid mismatch' }; if (-not (& $isUtc $sf.startTimeUtc) -or -not (& $isUtc $vTerm.startTimeUtc) -or $sf.startTimeUtc -cne $vTerm.startTimeUtc) { throw 'terminal stopFacts startTimeUtc mismatch' }; if (($null -eq $sf.deadlineObservedUtc) -ne ($null -eq $sf.elapsedMs)) { throw 'terminal stopFacts deadline tuple partial' }; if ($null -ne $sf.deadlineObservedUtc) { if (-not (& $isUtc $sf.deadlineObservedUtc) -or -not (& $isInt $sf.elapsedMs) -or $sf.elapsedMs -lt 0) { throw 'terminal stopFacts deadline tuple invalid' } }; if ($null -eq $sf.deadlineObservedUtc -and $null -ne $sf.alive) { throw 'terminal stopFacts alive without deadline observation' }; if ($null -ne $sf.deadlineObservedUtc -and ($vTerm.reason -cne 'DEADLINE' -or $sf.elapsedMs -lt $num['MaxElapsedMs'])) { throw 'terminal stopFacts deadline tuple inconsistent with reason or limit' }; if ($null -ne $sf.alive -and $sf.alive -isnot [bool]) { throw 'terminal stopFacts alive not boolean' }; if ($null -ne $sf.aliveAtStop -and $sf.aliveAtStop -isnot [bool]) { throw 'terminal stopFacts aliveAtStop not boolean' }; if ($sf.killAttempted -isnot [bool]) { throw 'terminal stopFacts killAttempted not boolean' }; if ($sf.killAttempted -and ($sf.aliveAtStop -isnot [bool] -or -not $sf.aliveAtStop)) { throw 'terminal stopFacts kill attempted without alive-at-stop' }; if ($null -ne $sf.killErrorCode) { if ($sf.killErrorCode -isnot [string] -or [string]::IsNullOrWhiteSpace($sf.killErrorCode) -or -not $sf.killAttempted) { throw 'terminal stopFacts killErrorCode invalid' } } } }
            if ($vTerm.reason -ceq 'START_FAILED') {
                if ($null -ne $vTerm.pid -or $null -ne $vTerm.startTimeUtc -or $vTerm.exitObserved -or $null -ne $vTerm.exitCode -or $vTerm.onStartedAcknowledged) {
                    throw 'Refusing: START_FAILED terminal must carry no start identity, no observed exit and no acknowledgement.'
                }
            }
            if ($vTerm.definitive -and -not ($vTerm.exitObserved -or ($vTerm.reason -ceq 'START_FAILED'))) {
                throw 'Refusing: persisted terminal is definitive without an observed exit or an explicitly failed start.'
            }
            # A genuine observed-exit START_PERSIST_FAILED keeps its real definitive/exit facts; the
            # missing persisted start still forces reconciliation below, never a TERMINAL projection.
            $vReconcile = if ($vTerm.reason -ceq 'START_PERSIST_FAILED') { 'START_PERSIST_FAILED' } else { $null }
            $vLeafSum = [long]0
            foreach ($leaf in @(@('stdout', $outPath, 'stdout.bin'), @('stderr', $errPath, 'stderr.bin'))) {
                $lv = $vTerm.($leaf[0])
                if ($lv -isnot [PSCustomObject] -or -not (& $hasProp $lv @('file','sha256','retainedBytes'))) { throw ('Refusing: persisted terminal ' + $leaf[0] + ' leaf record is malformed.') }
                if ($lv.file -isnot [string] -or $lv.file -cne $leaf[2]) { throw ('Refusing: persisted terminal ' + $leaf[0] + ' leaf name is not the reserved output name.') }
                if (-not (& $isInt $lv.retainedBytes) -or [long]$lv.retainedBytes -lt 0) { throw ('Refusing: persisted terminal ' + $leaf[0] + ' retainedBytes is not a nonnegative typed integer.') }
                $vLeafSum += [long]$lv.retainedBytes
                $vLeafHash = & $hashOf $leaf[1]
                if ($null -eq $lv.sha256) {
                    if ($null -ne $vLeafHash) { throw ('Refusing: persisted terminal declares no ' + $leaf[0] + ' hash but the leaf file is present.') }
                    if ([long]$lv.retainedBytes -ne 0) { throw ('Refusing: persisted terminal declares retained ' + $leaf[0] + ' bytes with no stream evidence.') }
                } else {
                    if (-not (& $isHex $lv.sha256)) { throw ('Refusing: persisted terminal ' + $leaf[0] + ' sha256 is not lower-case 64hex.') }
                    if ($null -eq $vLeafHash -or $vLeafHash -cne $lv.sha256) { throw ('Refusing: persisted ' + $leaf[0] + ' stream evidence does not match terminal.') }
                    if ((Get-Item -LiteralPath $leaf[1]).Length -ne [long]$lv.retainedBytes) { throw ('Refusing: actual ' + $leaf[0] + ' leaf length does not match the persisted retainedBytes.') }
                }
            }
            if ($vLeafSum -ne [long]$vTerm.retainedBytes) { throw 'Refusing: persisted stream leaf retained bytes do not sum to the terminal retained total.' }

            $vArt = $vTerm.artifact
            if ($vArt -isnot [PSCustomObject] -or -not (& $hasProp $vArt @('path','state','sha256','length'))) { throw 'Refusing: persisted terminal artifact record is malformed.' }
            if ($vArt.path -isnot [string] -or $vArt.path -cne $paths['ArtifactPath']) { throw 'Refusing: persisted terminal artifact path is not the captured ArtifactPath.' }
            if ($vArt.state -isnot [string]) { throw 'Refusing: persisted terminal artifact state is not a typed string.' }
            $vArtExists = Test-Path -LiteralPath $paths['ArtifactPath']
            $vArtLeaf = Test-Path -LiteralPath $paths['ArtifactPath'] -PathType Leaf
            switch -CaseSensitive ([string]$vArt.state) {
                'PRESENT' {
                    if (-not $vArtLeaf) { throw 'Refusing: persisted terminal declares a present artifact but no actual artifact leaf exists.' }
                    if (-not (& $isHex $vArt.sha256) -or (& $hashOf $paths['ArtifactPath']) -cne $vArt.sha256) { throw 'Refusing: persisted artifact evidence does not match the actual artifact leaf.' }
                    if (-not (& $isInt $vArt.length) -or [long]$vArt.length -lt 0 -or (Get-Item -LiteralPath $paths['ArtifactPath']).Length -ne [long]$vArt.length) { throw 'Refusing: persisted artifact length does not match the actual artifact leaf.' }
                }
                'ABSENT' {
                    if ($vArtExists) { throw 'Refusing: persisted terminal declares artifact absent but the artifact path is present.' }
                    if ($null -ne $vArt.sha256 -or $null -ne $vArt.length) { throw 'Refusing: an absent artifact cannot carry hash or length metadata.' }
                }
                'NOT_A_FILE' {
                    if (-not $vArtExists -or $vArtLeaf) { throw 'Refusing: persisted terminal declares a non-file artifact but the actual path is absent or a leaf.' }
                    if ($null -ne $vArt.sha256 -or $null -ne $vArt.length) { throw 'Refusing: a non-file artifact cannot carry hash or length metadata.' }
                }
                'UNREADABLE' {
                    if (-not $vArtLeaf) { throw 'Refusing: persisted terminal declares an unreadable artifact but no actual artifact leaf exists.' }
                    if ($null -ne $vArt.sha256 -or $null -ne $vArt.length) { throw 'Refusing: an unreadable artifact cannot carry trusted hash or length metadata.' }
                    $vProbe = $false
                    try { $vFs = [System.IO.File]::Open($paths['ArtifactPath'], [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); $vFs.Dispose(); $vProbe = $true } catch { }
                    if ($vProbe) { throw 'Refusing: persisted terminal declares an unreadable artifact that is actually readable.' }
                }
                default { throw 'Refusing: persisted terminal has an unrecognized artifact state.' }
            }
            $vTermSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($terminalPath))
        }
        $vAck = $null
        $vAcked = ($null -ne $vTerm) -and ($vTerm.onStartedAcknowledged -eq $true)
        if ($vAcked) {
            if ($null -eq $ctx) { throw 'Refusing: persisted terminal claims an acknowledgement without a captured acknowledgement context.' }
            if (-not (Test-Path -LiteralPath $stepScriptPath -PathType Leaf)) { throw 'Refusing: the acknowledgement validator source is not a readable file.' }
            . $stepScriptPath
            foreach ($fn in 'Test-HostDispatchAcknowledgementEnvelope','Test-ExecutionBinding') {
                if ($null -eq (Get-Command -Name $fn -CommandType Function -ErrorAction SilentlyContinue)) { throw ('Refusing: required declaration ' + $fn + ' is not available.') }
            }
            $vClaim = $ctx['claim']
            $vAckPath = Join-Path $ctx['stateDir'] 'host-dispatch-acknowledgements.json'
            if (-not (Test-Path -LiteralPath $vAckPath -PathType Leaf)) { throw 'Refusing: no recorded dispatch acknowledgement state exists; no acknowledgement is manufactured.' }
            $vAckState = & $readRecord $vAckPath 'acknowledgement state'
            $vAckHash = Test-HostDispatchAcknowledgementEnvelope -AckState $vAckState
            $vAckKey = $vClaim['intentId'] + '|' + $vClaim['claimId']
            if (-not $vAckHash.Contains($vAckKey)) { throw 'Refusing: no recorded acknowledgement for the captured intent and claim.' }
            $vAck = $vAckHash[$vAckKey]
            if ($vAck.entryId -cne $vClaim['id'] -or $vAck.owner -cne $vClaim['owner'] -or $vAck.claimId -cne $vClaim['claimId'] -or $vAck.intentId -cne $vClaim['intentId']) { throw 'Refusing: recorded acknowledgement does not match the captured claim owner/claim/intent.' }
            if ($vAck.dispatchedAt -cne $vTerm.startTimeUtc) { throw 'Refusing: recorded acknowledgement dispatch time does not match the actual persisted start.' }
            if (-not ($vAck.PSObject.Properties.Name -contains 'executionBinding') -or $null -eq $vAck.executionBinding) { throw 'Refusing: recorded acknowledgement carries no execution binding.' }
            $vBind = $vAck.executionBinding
            Test-ExecutionBinding -Binding $vBind
            if ($vBind.taskId -cne $ctx['taskId']) { throw 'Refusing: acknowledgement binding taskId does not match the captured task.' }
            if ($vBind.runId -cne $runId -or [long]$vBind.attempt -ne $num['Attempt']) { throw 'Refusing: acknowledgement binding run/attempt does not match the captured run.' }
            if ($vBind.receiptSha -cne $vClaim['receiptSha'] -or $vBind.planSha -cne $vClaim['planSha']) { throw 'Refusing: acknowledgement binding receipt/plan does not match the captured claim.' }
            if ($vBind.ticketSha256 -cne $sha['TicketPath'] -or $vBind.payloadSha256 -cne $sha['PayloadPath']) { throw 'Refusing: acknowledgement binding ticket/payload does not match the captured inputs.' }
            if ($vBind.identity.kind -cne 'native') { throw 'Refusing: acknowledgement binding is not the native execution identity.' }
            if ([long]$vBind.identity.pid -ne [long]$vTerm.pid -or $vBind.identity.startIdentity -cne $vTerm.startTimeUtc) { throw 'Refusing: acknowledgement binding native identity does not match the actual persisted start.' }
        } elseif ($null -eq $ctx -and $null -ne $vTerm -and $vTerm.onStartedAcknowledged -ne $false) {
            throw 'Refusing: a collector run without acknowledgement context must record a false acknowledgement.'
        }

        $vProj = $null
        if (Test-Path -LiteralPath $projPath -PathType Leaf) {
            if (-not $vAcked) { throw 'Refusing: projection state exists without an acknowledged terminal execution.' }
            if ($vTerm.definitive -ne $true) { throw 'Refusing: projection state exists for a non-definitive terminal.' }
            $vProj = & $readRecord $projPath 'projection'
            if ($vProj -isnot [PSCustomObject] -or -not (& $hasProp $vProj @('schema','runId','attempt','requestSha256','status','attempts','terminalSha256','lastErrorCode','result'))) { throw 'Refusing: persisted projection state is malformed.' }
            if ($vProj.schema -isnot [string] -or $vProj.schema -cne 'ManagedNativeProjection/v1') { throw 'Refusing: persisted projection schema is not ManagedNativeProjection/v1.' }
            if ($vProj.runId -isnot [string] -or $vProj.runId -cne $runId) { throw 'Refusing: persisted projection runId does not match the captured run.' }
            if (-not (& $isInt $vProj.attempt) -or [long]$vProj.attempt -le 0 -or [long]$vProj.attempt -ne $num['Attempt']) { throw 'Refusing: persisted projection attempt is not the captured positive attempt.' }
            if (-not (& $isHex $vProj.requestSha256) -or $vProj.requestSha256 -cne $requestSha) { throw 'Refusing: persisted projection state is bound to another request.' }
            if ($vProj.status -isnot [string] -or @('PENDING','DONE') -cnotcontains $vProj.status) { throw 'Refusing: persisted projection status is not PENDING or DONE.' }
            if (-not (& $isInt $vProj.attempts) -or [long]$vProj.attempts -lt 0) { throw 'Refusing: persisted projection attempts is not a nonnegative typed integer.' }
            if ($null -eq $vProj.terminalSha256) {
                if ($vProj.status -cne 'PENDING' -or [long]$vProj.attempts -ne 0 -or $null -ne $vProj.lastErrorCode -or $null -ne $vProj.result) { throw 'Refusing: an unbound projection record is not the original pending initialization.' }
            } elseif (-not (& $isHex $vProj.terminalSha256) -or $vProj.terminalSha256 -cne $vTermSha) {
                throw 'Refusing: projection binding does not match terminal.'
            }
            foreach ($sf in 'lastErrorCode','result') {
                if ($null -ne $vProj.$sf -and $vProj.$sf -isnot [string]) { throw ('Refusing: persisted projection ' + $sf + ' must be null or a string.') }
            }
            if ($null -ne $vProj.result -and $vProj.result.Length -gt 2048) { throw 'Refusing: persisted projection result exceeds the bounded result size.' }
        }
        [ordered]@{
            manifest = $vMan; manifestSha256 = $vManSha; start = $vStart; terminal = $vTerm; terminalSha256 = $vTermSha
            acknowledged = $vAcked; acknowledgement = $vAck; projection = $vProj; reconcile = $vReconcile
        }
    }

    $state = $null; $terminal = $null; $terminalSha = $null; $manifestSha = $null; $projRecord = $null; $reconcile = $null
    # Prospective author-only binding: CLI --max-turns must equal the captured ticket budget.maxTurns (captured bytes; no reread).
    $assertTurnBinding = {
        param($ticketJson)
        if ($settingsApplied -eq $true -and $noStop) {
            # No-output-stop mode has no turn ceiling: refuse leftover nonnull ceilings or aliases instead of applying a default.
            if ($null -ne $cliMaxTurns) { throw 'Refusing: OutputStopProfile mode must not carry a CLI --max-turns.' }
            $mtBudgetNs = @($ticketJson.PSObject.Properties | Where-Object { $_.Name -ceq 'budget' })
            if ($mtBudgetNs.Count -ne 1 -or $mtBudgetNs[0].Value -isnot [PSCustomObject]) { throw 'Refusing: ticket budget object missing for no-output-stop turn check.' }
            foreach ($mtNs in @($mtBudgetNs[0].Value.PSObject.Properties)) {
                if ($mtNs.Name -imatch '^max[_-]?(turns?|messages?)$' -and $null -ne $mtNs.Value) { throw 'Refusing: OutputStopProfile ticket carries a numeric turn or message ceiling.' }
            }
        } elseif ($settingsApplied -eq $true) {
            if ($null -eq $cliMaxTurns) { throw 'Refusing: author mode requires --max-turns.' }
            $mtBudgetProp = @($ticketJson.PSObject.Properties | Where-Object { $_.Name -ceq 'budget' })
            if ($mtBudgetProp.Count -ne 1 -or $mtBudgetProp[0].Value -isnot [PSCustomObject]) { throw 'Refusing: ticket budget object missing for max-turns binding.' }
            $mtProp = @($mtBudgetProp[0].Value.PSObject.Properties | Where-Object { $_.Name -ceq 'maxTurns' })
            if ($mtProp.Count -ne 1) { throw 'Refusing: ticket budget.maxTurns missing.' }
            $mtTicket = $mtProp[0].Value
            if (($mtTicket -isnot [int] -and $mtTicket -isnot [long]) -or [long]$mtTicket -le 0) { throw 'Refusing: ticket budget.maxTurns must be a positive typed integer.' }
            if ([long]$mtTicket -ne [long]$cliMaxTurns) { throw 'Refusing: CLI --max-turns does not equal ticket budget.maxTurns.' }
        }
    }
    # New manifest-absent path: refuse before Lock-RunDirectory can create the run directory.
    if ($settingsApplied -eq $true -and -not (Test-Path -LiteralPath $manifestPath)) {
        # Capped legacy author starts are retired; legacy terminal replay (manifest present) is handled below and never launches a child.
        if (-not $noStop) { throw 'Refusing: capped legacy author starts are retired; use OutputStopProfile observe-only-v1.' }
        $preTicket = $null
        try { $preTicket = [System.Text.Encoding]::UTF8.GetString($bytes['TicketPath']).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { throw 'Refusing: ticket is not valid JSON.' }
        if ($null -eq $preTicket) { throw 'Refusing: ticket is not valid JSON.' }
        & $assertTurnBinding $preTicket
    }
    $lock = Lock-RunDirectory $runDirFull
    $lockOpen = $true
    try {
        if (Test-Path -LiteralPath $manifestPath) {
            $m = & $readJson $manifestPath 'manifest'
            if (-not (& $hasProp $m @('schema','requestCanonical','requestSha256')) -or $m.schema -cne 'ManagedNativeCollector/v1' -or $m.requestCanonical -isnot [string] -or $m.requestSha256 -cne (Get-Sha256OfString $m.requestCanonical)) {
                throw 'Refusing: persisted manifest is malformed.'
            }
            if ($m.requestCanonical -cne $canonical) { throw 'Refusing: changed request for an already reserved run directory.' }
            $manifestSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($manifestPath))
            if (Test-Path -LiteralPath $terminalPath) {
                $terminal = & $readJson $terminalPath 'terminal'
                if (-not (& $hasProp $terminal @('schema','requestSha256','definitive','onStartedAcknowledged','reason','stdout','stderr')) -or $terminal.requestSha256 -cne $requestSha) {
                    throw 'Refusing: persisted terminal is malformed or bound to another request.'
                }
                foreach ($pair in @(@($terminal.stdout, $outPath), @($terminal.stderr, $errPath))) {
                    if (-not (& $hasProp $pair[0] @('sha256'))) { throw 'Refusing: persisted terminal is malformed.' }
                    $actualLeafHash = & $hashOf $pair[1]
                    if ($null -ne $pair[0].sha256) {
                        if ($actualLeafHash -cne $pair[0].sha256) { throw 'Refusing: persisted stream evidence does not match terminal.' }
                    } elseif ($null -ne $actualLeafHash) {
                        throw 'Refusing: persisted terminal declares no stream output but the leaf file is present.'
                    }
                }
                if (-not (& $hasProp $terminal @('artifact')) -or -not (& $hasProp $terminal.artifact @('path','state','sha256','length'))) { throw 'Refusing: persisted terminal is malformed.' }
                $actualArtifactPresent = Test-Path -LiteralPath $paths['ArtifactPath'] -PathType Leaf
                switch -CaseSensitive ([string]$terminal.artifact.state) {
                    'PRESENT' {
                        if (-not $actualArtifactPresent -or (& $hashOf $paths['ArtifactPath']) -cne $terminal.artifact.sha256 -or (Get-Item -LiteralPath $paths['ArtifactPath']).Length -ne $terminal.artifact.length) {
                            throw 'Refusing: persisted artifact evidence does not match the actual artifact leaf.'
                        }
                    }
                    'ABSENT' {
                        if ($actualArtifactPresent) { throw 'Refusing: persisted terminal declares artifact absent but the artifact leaf is present.' }
                    }
                    'NOT_A_FILE' {}
                    'UNREADABLE' {}
                    default { throw 'Refusing: persisted terminal has an unrecognized artifact state.' }
                }
                $terminalSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($terminalPath))
                if ($terminal.definitive -eq $true) {
                    $state = 'TERMINAL'
                } else {
                    $state = 'RECONCILE_REQUIRED'; $reconcile = 'TERMINAL_NOT_DEFINITIVE'
                }
            } else {
                $state = 'RECONCILE_REQUIRED'
                $reconcile = if (Test-Path -LiteralPath $startPath) { 'START_RECORDED_NO_TERMINAL' } else { 'RESERVED_NO_START_RECORD' }
            }
            if (Test-Path -LiteralPath $projPath) {
                $projRecord = & $readJson $projPath 'projection'
                if (-not (& $hasProp $projRecord @('schema','requestSha256','status','attempts','terminalSha256')) -or $projRecord.requestSha256 -cne $requestSha) {
                    throw 'Refusing: persisted projection state is malformed or bound to another request.'
                }
                if ($null -ne $projRecord.terminalSha256 -and $projRecord.terminalSha256 -cne $terminalSha) { throw 'Refusing: projection binding does not match terminal.' }
            }
            # Full strict contract validation of the persisted replay evidence, under the held run lock,
            # before this call returns, saves or projects anything. Malformed evidence refuses with the
            # bytes unchanged; a reserved, partial or non-definitive run still only reconciles.
            $validated = & $validatePersistedEvidence
            $manifestSha = $validated['manifestSha256']
            $terminal = $validated['terminal']
            $terminalSha = $validated['terminalSha256']
            $projRecord = $validated['projection']
            if ($null -eq $terminal) {
                $state = 'RECONCILE_REQUIRED'
                $reconcile = if ($null -ne $validated['start']) { 'START_RECORDED_NO_TERMINAL' } else { 'RESERVED_NO_START_RECORD' }
            } elseif ($validated['reconcile']) {
                $state = 'RECONCILE_REQUIRED'; $reconcile = $validated['reconcile']
            } elseif ($terminal.definitive -eq $true) {
                $state = 'TERMINAL'; $reconcile = $null
            } else {
                $state = 'RECONCILE_REQUIRED'; $reconcile = 'TERMINAL_NOT_DEFINITIVE'
            }
        } else {
            foreach ($f in @($startPath, $outPath, $errPath, $terminalPath, $projPath)) {
                if (Test-Path -LiteralPath $f) { throw 'Refusing: orphan evidence without a manifest.' }
            }
            if ($settingsApplied -eq $true -and -not $noStop) { throw 'Refusing: capped legacy author starts are retired; use OutputStopProfile observe-only-v1.' }
            Assert-NoAmbientProviderOverride
            if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw 'Refusing: pinned executable is not present.' }
            $ticketJson = $null
            try { $ticketJson = [System.Text.Encoding]::UTF8.GetString($bytes['TicketPath']).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { throw 'Refusing: ticket is not valid JSON.' }
            if ($null -eq $ticketJson -or $null -eq $ticketJson.PSObject.Properties['payloadSha256'] -or $ticketJson.payloadSha256 -isnot [string] -or $ticketJson.payloadSha256 -inotmatch '^[0-9a-f]{64}$' -or $ticketJson.payloadSha256 -ine $sha['PayloadPath']) {
                throw 'Refusing: ticket payloadSha256 does not match the actual payload.'
            }
            # Race-safe repeat under lock immediately before the new reservation/spawn.
            & $assertTurnBinding $ticketJson
            if ($null -ne $ctx) {
                $claimC = $ctx['claim']
                if ($null -eq $ticketJson.PSObject.Properties['id'] -or $ticketJson.id -isnot [string] -or [string]::IsNullOrWhiteSpace($ticketJson.id) -or $ticketJson.id -cne $ctx['taskId']) { throw 'Refusing: TaskId does not match the captured ticket id.' }
                . (Join-Path $runnerDir '../dispatch/continuation-step.ps1')
                . (Join-Path $runnerDir '../host-continuation/select-next-ready.ps1')
                foreach ($fn in 'Test-ContinuationStateEntry','Test-ExecutionBinding','Record-HostDispatchAcknowledgement') {
                    if ($null -eq (Get-Command -Name $fn -CommandType Function -ErrorAction SilentlyContinue)) { throw ('Refusing: required declaration ' + $fn + ' is not available.') }
                }
                $csPath = Join-Path $ctx['stateDir'] 'continuation-state.json'
                $cdPath = Join-Path $ctx['stateDir'] 'host-continuation-decision.json'
                foreach ($f in @($csPath, $cdPath)) {
                    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw 'Refusing: canonical claim state is absent; no claim is manufactured.' }
                }
                try {
                    $cs = [System.IO.File]::ReadAllText($csPath) | ConvertFrom-Json -DateKind String
                    $cd = [System.IO.File]::ReadAllText($cdPath) | ConvertFrom-Json -DateKind String
                } catch { throw 'Refusing: canonical claim state is malformed.' }
                if (-not (& $hasProp $cs @('schema','entries')) -or $cs.schema -cne 'continuation-state/v1' -or $cs.entries -isnot [PSCustomObject]) { throw 'Refusing: canonical continuation-state is malformed.' }
                $matched = $null
                foreach ($prop in $cs.entries.PSObject.Properties) {
                    $vr = Test-ContinuationStateEntry -Key $prop.Name -Entry $prop.Value
                    if ($vr -is [bool] -and -not $vr) { throw 'Refusing: canonical continuation-state entry is invalid.' }
                    if ($prop.Name -ceq $claimC['intentId']) { $matched = $prop.Value }
                }
                if ($null -eq $matched) { throw 'Refusing: no canonical continuation-state entry for the selected intent.' }
                if ($matched.status -cne 'CLAIMED' -or $null -eq $matched.claim -or $matched.claim.claimId -cne $claimC['claimId'] -or $matched.claim.owner -cne $claimC['owner'] -or $matched.receiptSha256 -cne $claimC['receiptSha'] -or $matched.planSha256 -cne $claimC['planSha']) { throw 'Refusing: canonical continuation-state entry does not match SelectedClaim.' }
                if (-not (& $hasProp $cd @('schema','status','selected')) -or $cd.schema -cne 'host-continuation-decision/v1' -or $cd.status -cne 'SELECTED' -or $cd.selected -isnot [PSCustomObject] -or -not (& $hasProp $cd.selected @('id','intentId','claimId','owner','receiptSha','planSha','statePath'))) { throw 'Refusing: canonical host decision is not SELECTED or is malformed.' }
                foreach ($f in 'id','intentId','claimId','owner','receiptSha','planSha') {
                    if ($cd.selected.$f -cne $claimC[$f]) { throw 'Refusing: canonical host decision does not match SelectedClaim.' }
                }
                if ($cd.selected.statePath -isnot [string] -or [System.IO.Path]::GetFullPath($cd.selected.statePath) -ine $csPath) { throw 'Refusing: canonical host decision statePath mismatch.' }
            }
            . (Join-Path (Split-Path -Parent $runnerDir) 'dispatch/packet-preflight.ps1')
            $gate = Invoke-PacketPreflight -TicketPath $paths['GateTicketPath'] -PayloadPath $paths['PayloadPath'] -EvidenceRoot (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
            if ($null -eq $gate -or $gate.status -ne 'PASS') { throw 'Refusing: packet preflight did not PASS.' }
            $manifest = [ordered]@{
                schema = 'ManagedNativeCollector/v1'; requestCanonical = $canonical; requestSha256 = $requestSha
                reservedUtc = (Get-Date).ToUniversalTime().ToString('o'); gateStatus = 'PASS'
                gateResultSha256 = (Get-Sha256OfString (ConvertTo-Json -InputObject $gate -Compress -Depth 6))
            }
            Write-AtomicFile $manifestPath (ConvertTo-Json -InputObject $manifest -Compress)
            $manifestSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($manifestPath))

            $maxElapsed = $num['MaxElapsedMs']; $maxBytes = $num['MaxStreamBytes']
            $payloadBytes = $bytes['PayloadPath']
            $bufSize = 8192; $drainGraceMs = 3000; $exitWaitMs = 10000
            $psi = [System.Diagnostics.ProcessStartInfo]::new()
            $psi.FileName = $exePath
            $psi.WorkingDirectory = $paths['WorkingDirectory']
            $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
            $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
            foreach ($a in $argList) { [void]$psi.ArgumentList.Add($a) }
            $p = [System.Diagnostics.Process]::new()
            $p.StartInfo = $psi
            $sw = [System.Diagnostics.Stopwatch]::new()
            $phase = 'START'; $started = $false; $acked = $false; $reason = $null; $errorCode = $null
            $onStartedOperation = $null; $onStartedFailureStage = $null
            $procId = $null; $startUtc = $null; $outFs = $null; $errFs = $null; $deadlineObservedUtc = $null; $deadlineElapsedMs = $null; $deadlineAlive = $null; $aliveAtStop = $null; $killAttempted = $false; $killErrorCode = $null
            $streams = $null; $sinks = $null; $bufs = $null; $tasks = $null; $drainReady = $false
            $eof = @($false, $false); $ret = @([long]0, [long]0); $observed = [long]0; $retained = [long]0
            $readFault = $false; $stdinError = $false
            $prestartEnvPath = Join-Path $runDirFull 'prestart-environment.json'
            $allowedKeys = @('CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING','MAX_THINKING_TOKENS','CLAUDE_CODE_MAX_OUTPUT_TOKENS')
            $parentEnv = [ordered]@{}
            $parentPresence = [ordered]@{}
            $psiEnv = [ordered]@{}
            $psiPresence = [ordered]@{}
            foreach ($k in $allowedKeys) {
                $parentVal = [System.Environment]::GetEnvironmentVariable($k)
                $parentPresent = $null -ne $parentVal
                $parentPresence[$k] = $parentPresent
                $parentEnv[$k] = $parentVal
                $psiPresent = $psi.Environment.ContainsKey($k)
                $psiPresence[$k] = $psiPresent
                $psiEnv[$k] = if ($psiPresent) { $psi.Environment[$k] } else { $null }
                if ($parentPresent -ne $psiPresent) {
                    throw "Refusing: environment variable '$k' presence mismatch: parent=$parentPresent psi=$psiPresent"
                }
                if ($parentPresent -and -not [string]::Equals($parentVal, $psiEnv[$k], [StringComparison]::Ordinal)) {
                    throw "Refusing: environment variable '$k' value mismatch: parent='$parentVal' psi='$($psiEnv[$k])'"
                }
            }
            $childEnvRemoved = @()
            if ($noStop) {
                # Child-only: ProcessStartInfo.Environment is a private copy; the parent/global environment is never mutated.
                foreach ($rk in @('CLAUDE_CODE_MAX_OUTPUT_TOKENS','MAX_THINKING_TOKENS','CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING','MAX_STRUCTURED_OUTPUT_RETRIES')) {
                    if ($psi.Environment.ContainsKey($rk)) { [void]$psi.Environment.Remove($rk); $childEnvRemoved += $rk }
                }
            }
            $funcInfo = Get-Command -Name Invoke-ManagedNativeCollector -CommandType Function -ErrorAction Stop
            $definingFile = $funcInfo.ScriptBlock.File
            if ([string]::IsNullOrWhiteSpace($definingFile)) { throw 'Refusing: loaded function has no defining file metadata.' }
            $definingPath = & $resolve $definingFile
            if (-not (Test-Path -LiteralPath $definingPath -PathType Leaf)) { throw "Refusing: defining file unresolvable: $definingFile" }
            $naturalPath = & $resolve $PSCommandPath
            if (-not [string]::Equals($definingPath, $naturalPath, [StringComparison]::Ordinal)) {
                throw "Refusing: loaded function defining file '$definingPath' does not match natural context '$naturalPath'"
            }
            $candidatePath = $definingPath
            $candidateSha = & $hashOf $candidatePath
            if ($candidateSha -isnot [string] -or $candidateSha.Length -ne 64) { throw 'Refusing: digest null, non-string or wrong length.' }
            if ($candidateSha -cne $candidateSha.ToLowerInvariant()) { throw 'Refusing: digest contains uppercase characters.' }
            if ($candidateSha -notmatch '^[0-9a-f]{64}$') { throw 'Refusing: digest is not valid lowercase hex.' }
            $prestartCapture = [ordered]@{
                schema = 'ManagedNativePreStartEnvironment/v1'
                runId = $runId; attempt = $num['Attempt']; requestSha256 = $requestSha; manifestSha256 = $manifestSha
                candidatePath = $candidatePath; candidateSha256 = $candidateSha
                capturedUtc = (Get-Date).ToUniversalTime().ToString('o')
                parentPresence = $parentPresence
                parentEnvironment = $parentEnv
                psiPresence = $psiPresence
                psiEnvironment = $psiEnv
                comparisonResult = 'PASSED'
            }
            if ($noStop) {
                $prestartCapture['childEnvironmentRemoved'] = @($childEnvRemoved)
                $prestartCapture['psiFieldsScope'] = 'INHERITED_PRE_REMOVAL'
                $launchPresence = [ordered]@{}; $launchEnv = [ordered]@{}
                foreach ($lk in @('CLAUDE_CODE_EFFORT_LEVEL','CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING','MAX_THINKING_TOKENS','CLAUDE_CODE_MAX_OUTPUT_TOKENS','MAX_STRUCTURED_OUTPUT_RETRIES')) {
                    $lp = $psi.Environment.ContainsKey($lk)
                    $launchPresence[$lk] = $lp
                    $launchEnv[$lk] = if ($lp) { $psi.Environment[$lk] } else { $null }
                }
                $prestartCapture['launchPresencePostRemoval'] = $launchPresence
                $prestartCapture['launchEnvironmentPostRemoval'] = $launchEnv
            }
            if ([System.IO.File]::Exists($prestartEnvPath)) { throw "Refusing: prestart-environment.json already exists; run isolation violated." }
            Write-AtomicFile $prestartEnvPath (ConvertTo-Json -InputObject $prestartCapture -Compress)
            try {
                if (-not $p.Start()) { throw [System.InvalidOperationException]::new('start returned false') }
                $started = $true
                $sw.Restart()
                $procId = $p.Id
                $startUtc = $p.StartTime.ToUniversalTime().ToString('o')
                $phase = 'PERSIST'
                $startRecord = [ordered]@{
                    schema = 'ManagedNativeStart/v1'; runId = $runId; attempt = $num['Attempt']; requestSha256 = $requestSha
                    pid = $procId; startTimeUtc = $startUtc; persistedUtc = (Get-Date).ToUniversalTime().ToString('o')
                }
                Write-AtomicFile $startPath (ConvertTo-Json -InputObject $startRecord -Compress)
                $startSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($startPath))
                $outFs = [System.IO.FileStream]::new($outPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
                $errFs = [System.IO.FileStream]::new($errPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
                $streams = @($p.StandardOutput.BaseStream, $p.StandardError.BaseStream)
                $sinks = @($outFs, $errFs)
                $bufs = @([byte[]]::new($bufSize), [byte[]]::new($bufSize))
                $tasks = @($streams[0].ReadAsync($bufs[0], 0, $bufSize), $streams[1].ReadAsync($bufs[1], 0, $bufSize))
                $phase = 'CALLBACK'; $consumed = @($false, $false); $drainReady = $true
                $onStartedOperation = 'ACK_PREPARATION'
                $identity = [pscustomobject]@{
                    RunId = $runId; Attempt = $num['Attempt']; Pid = $procId; StartTime = $startUtc
                    TicketSha256 = $sha['TicketPath']; PayloadSha256 = $sha['PayloadPath']
                    GateTicketSha256 = $sha['GateTicketPath']; SettingsSha256 = $sha['SettingsPath']
                    RequestSha256 = $requestSha; ManifestPath = $manifestPath; ManifestSha256 = $manifestSha
                    StartPath = $startPath; StartSha256 = $startSha
                }
                if ($null -ne $ctx) {
                    $onStartedOperation = 'PRE_ACK_ALIVE_CHECK'
                    if ($p.HasExited) { throw 'Child exited before acknowledgement.' }
                    $onStartedOperation = 'BUILD_VALIDATE_ACK'
                    $claimC = $ctx['claim']
                    $selected = [PSCustomObject]@{ id = $claimC['id']; owner = $claimC['owner']; claimId = $claimC['claimId']; intentId = $claimC['intentId']; receiptSha = $claimC['receiptSha']; planSha = $claimC['planSha']; statePath = $claimC['statePath'] }
                    $ackObj = [PSCustomObject]@{ claimId = $claimC['claimId']; owner = $claimC['owner']; intentId = $claimC['intentId']; dispatchedAt = $startUtc }
                    $binding = [PSCustomObject]@{
                        schema = 'host-dispatch-execution-binding/v1'; taskId = $ctx['taskId']
                        ticketSha256 = $sha['TicketPath']; payloadSha256 = $sha['PayloadPath']
                        runId = $runId; attempt = $num['Attempt']; receiptSha = $claimC['receiptSha']; planSha = $claimC['planSha']
                        identity = [PSCustomObject]@{ kind = 'native'; pid = $procId; startIdentity = $startUtc }
                    }
                    $bv = Test-ExecutionBinding -Binding $binding
                    if ($bv -is [bool] -and -not $bv) { throw 'ExecutionBinding invalid.' }
                    $onStartedOperation = 'RECORD_ACK'
                    $recOut = @(Record-HostDispatchAcknowledgement -StateDir $ctx['stateDir'] -SelectedClaim $selected -Acknowledgement $ackObj -ExecutionBinding $binding)
                    $rec = if ($recOut.Count -eq 1) { $recOut[0] } else { $null }
                    $onStartedOperation = 'VALIDATE_ACK_RESULT'
                    if ($rec -isnot [PSCustomObject] -or -not (& $hasProp $rec @('schema','entryId','owner','claimId','intentId','dispatchedAt','executionBinding')) -or $rec.schema -cne 'host-dispatch-acknowledgement/v1' -or $rec.entryId -cne $claimC['id'] -or $rec.owner -cne $claimC['owner'] -or $rec.claimId -cne $claimC['claimId'] -or $rec.intentId -cne $claimC['intentId'] -or $rec.dispatchedAt -cne $startUtc -or (ConvertTo-Json -InputObject $rec.executionBinding -Compress -Depth 4) -cne (ConvertTo-Json -InputObject $binding -Compress -Depth 4)) {
                        throw 'Acknowledgement record invalid.'
                    }
                    $onStartedOperation = 'POST_ACK_ALIVE_CHECK'
                    if ($p.HasExited) { throw 'Child exited after acknowledgement.' }
                    $acked = $true
                }
                $phase = 'RUN'
                $stdinWriter = $p.StandardInput
                $inTask = $stdinWriter.BaseStream.WriteAsync($payloadBytes, 0, $payloadBytes.Length)
                $inClosed = $false
                $exitSeenMs = $null
                while (-not ($eof[0] -and $eof[1])) {
                    if ($sw.ElapsedMilliseconds -ge $maxElapsed) { $reason = 'DEADLINE'; if ($null -eq $deadlineObservedUtc) { $deadlineElapsedMs = [long]$sw.ElapsedMilliseconds; $deadlineObservedUtc = (Get-Date).ToUniversalTime().ToString('o'); $deadlineAlive = try { -not $p.HasExited } catch { $null } }; break }
                    if ($p.HasExited) {
                        if ($null -eq $exitSeenMs) { $exitSeenMs = $sw.ElapsedMilliseconds }
                        elseif (($sw.ElapsedMilliseconds - $exitSeenMs) -ge $drainGraceMs) { break }
                    }
                    if (-not $inClosed -and $inTask.IsCompleted) {
                        if ($inTask.IsFaulted) { [void]$inTask.Exception; $stdinError = $true } else { try { $stdinWriter.BaseStream.Flush() } catch { $stdinError = $true } }
                        try { $stdinWriter.Close() } catch { $stdinError = $true }
                        $inClosed = $true
                    }
                    $pending = @(for ($i = 0; $i -lt 2; $i++) { if (-not $eof[$i]) { $tasks[$i] } })
                    [void][System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]$pending, 100)
                    for ($i = 0; $i -lt 2; $i++) {
                        if ($eof[$i] -or -not $tasks[$i].IsCompleted) { continue }
                        if ($tasks[$i].IsFaulted -or $tasks[$i].IsCanceled) { [void]$tasks[$i].Exception; $eof[$i] = $true; $readFault = $true; continue }
                        $n = [int]$tasks[$i].Result
                        if ($n -le 0) { $eof[$i] = $true; continue }
                        $observed += $n; $consumed[$i] = $true
                        $take = if ($noStop) { $n } else { [int][Math]::Min([long]$n, $maxBytes - $retained) }
                        if ($take -gt 0) { $sinks[$i].Write($bufs[$i], 0, $take); $sinks[$i].Flush(); $ret[$i] += $take; $retained += $take }
                        if ($i -eq 0) { if ($take -lt $n) { $tokenStdoutTruncated = $true }; if ($null -ne $tokenAccountingState -and $take -gt 0) { $tokenFeedBytes = New-Object byte[] $take; [System.Buffer]::BlockCopy($bufs[0], 0, $tokenFeedBytes, 0, $take); $tokenAccountingSnapshot = Add-ManagedTokenAccountingBytes -State $tokenAccountingState -Bytes $tokenFeedBytes -Final $false } }
                        if (-not $noStop -and $observed -gt $maxBytes) { $reason = 'STREAM_BYTE_OVERFLOW'; break }
                        if ($null -eq $reason -and $i -eq 0 -and $null -ne $tokenAccountingSnapshot -and ($tokenAccountingSnapshot.invalid -eq $true -or $null -ne $tokenAccountingSnapshot.firstTrigger)) { $reason = 'TOKEN_ACCOUNTING_STOP'; break }
                        $tasks[$i] = $streams[$i].ReadAsync($bufs[$i], 0, $bufSize); $consumed[$i] = $false
                    }
                    if ($null -ne $reason) { break }
                }
            } catch {
                $errorCode = $_.Exception.GetType().FullName
                $reason = switch ($phase) { 'START' { 'START_FAILED' } 'PERSIST' { 'START_PERSIST_FAILED' } 'CALLBACK' { 'ONSTARTED_FAILED' } default { 'COLLECTOR_FAULT' } }
                if ($phase -ceq 'CALLBACK') { $onStartedFailureStage = $onStartedOperation }
            }
            $exitObserved = $false; $exitCode = $null
            if ($started) {
                try {
                    if ($null -eq $reason -and -not $p.HasExited) { [void]$p.WaitForExit([int][Math]::Max(0, [Math]::Min([long]$exitWaitMs, $maxElapsed - $sw.ElapsedMilliseconds))) }
                    if ($null -eq $reason) { $hx = $p.HasExited; $el = [long]$sw.ElapsedMilliseconds; $reason = if ($hx) { 'NATURAL_EXIT' } elseif ($el -ge $maxElapsed) { 'DEADLINE' } else { 'EXIT_WAIT_TIMEOUT' }; if ($reason -ceq 'DEADLINE' -and $null -eq $deadlineObservedUtc) { $deadlineElapsedMs = $el; $deadlineObservedUtc = (Get-Date).ToUniversalTime().ToString('o'); $deadlineAlive = -not $hx } }
                    $aliveAtStop = $null; $hx2 = $p.HasExited; $aliveAtStop = -not $hx2; if (-not $hx2) { $killAttempted = $true; try { $p.Kill($true) } catch { $killErrorCode = $_.Exception.GetType().FullName; throw } }
                    $exitObserved = $p.WaitForExit($exitWaitMs)
                    if ($exitObserved) { $exitCode = $p.ExitCode }
                } catch {
                    if ($null -eq $errorCode) { $errorCode = $_.Exception.GetType().FullName }
                }
            }
            if ($started -and $exitObserved -and $drainReady) {
                try {
                    $drainSw = [System.Diagnostics.Stopwatch]::StartNew()
                    while (-not ($eof[0] -and $eof[1]) -and -not $readFault -and $drainSw.ElapsedMilliseconds -lt $drainGraceMs) {
                        for ($i = 0; $i -lt 2; $i++) {
                            if ($eof[$i] -or -not $consumed[$i]) { continue }
                            $tasks[$i] = $streams[$i].ReadAsync($bufs[$i], 0, $bufSize); $consumed[$i] = $false
                        }
                        $pending = @(for ($i = 0; $i -lt 2; $i++) { if (-not $eof[$i]) { $tasks[$i] } })
                        if ($pending.Count -eq 0) { break }
                        [void][System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]$pending, 50)
                        for ($i = 0; $i -lt 2; $i++) {
                            if ($eof[$i] -or $consumed[$i] -or -not $tasks[$i].IsCompleted) { continue }
                            if ($tasks[$i].IsFaulted -or $tasks[$i].IsCanceled) { [void]$tasks[$i].Exception; $readFault = $true; break }
                            $n = [int]$tasks[$i].Result
                            if ($n -le 0) { $eof[$i] = $true; continue }
                            $observed += $n; $consumed[$i] = $true
                            $take = if ($noStop) { $n } else { [int][Math]::Min([long]$n, [Math]::Max([long]0, $maxBytes - $retained)) }
                            if ($take -gt 0) { $sinks[$i].Write($bufs[$i], 0, $take); $sinks[$i].Flush(); $ret[$i] += $take; $retained += $take }
                            if ($i -eq 0) { if ($take -lt $n) { $tokenStdoutTruncated = $true }; if ($null -ne $tokenAccountingState -and $take -gt 0) { $tokenFeedBytes = New-Object byte[] $take; [System.Buffer]::BlockCopy($bufs[0], 0, $tokenFeedBytes, 0, $take); $tokenAccountingSnapshot = Add-ManagedTokenAccountingBytes -State $tokenAccountingState -Bytes $tokenFeedBytes -Final $false } }
                        }
                    }
                } catch {
                    $readFault = $true
                }
                $drainReady = $false
            }
            if ($null -ne $tokenAccountingState) {
                $taFinal = [bool]([bool]$eof[0] -and -not [bool]$readFault -and -not [bool]$tokenStdoutTruncated)
                $tokenAccountingSnapshot = Add-ManagedTokenAccountingBytes -State $tokenAccountingState -Bytes ([byte[]]::new(0)) -Final:$taFinal
            }
            $endUtc = (Get-Date).ToUniversalTime().ToString('o')
            foreach ($s in @($outFs, $errFs)) { if ($null -ne $s) { try { $s.Dispose() } catch { } } }
            try { $p.Dispose() } catch { }
            $definitive = ($started -and $exitObserved) -or ((-not $started) -and $reason -ceq 'START_FAILED')
            $artifact = [ordered]@{ path = $paths['ArtifactPath']; state = 'ABSENT'; sha256 = $null; length = $null }
            if (Test-Path -LiteralPath $paths['ArtifactPath'] -PathType Leaf) {
                try {
                    $artifact['sha256'] = & $hashOf $paths['ArtifactPath']
                    $artifact['length'] = (Get-Item -LiteralPath $paths['ArtifactPath']).Length
                    $artifact['state'] = 'PRESENT'
                } catch { $artifact['state'] = 'UNREADABLE' }
            } elseif (Test-Path -LiteralPath $paths['ArtifactPath']) {
                $artifact['state'] = 'NOT_A_FILE'
            }
            $stopFacts = if ($started) { [ordered]@{ pid = $procId; startTimeUtc = $startUtc; deadlineObservedUtc = $deadlineObservedUtc; elapsedMs = $deadlineElapsedMs; alive = $deadlineAlive; aliveAtStop = $aliveAtStop; killAttempted = $killAttempted; killErrorCode = $killErrorCode } } else { $null }; $terminalObj = [ordered]@{
                schema = 'ManagedNativeTerminal/v1'; runId = $runId; attempt = $num['Attempt']; requestSha256 = $requestSha
                ticketSha256 = $sha['TicketPath']; payloadSha256 = $sha['PayloadPath']; gateTicketSha256 = $sha['GateTicketPath']
                settingsSha256 = $sha['SettingsPath']; manifestSha256 = $manifestSha
                pid = $procId; startTimeUtc = $startUtc; endedUtc = $endUtc
                reason = $reason; errorCode = $errorCode; definitive = $definitive
                exitObserved = $exitObserved; exitCode = $exitCode; stopFacts = $stopFacts
                onStartedAcknowledged = $acked; onStartedFailureStage = $onStartedFailureStage
                observedBytes = $observed; retainedBytes = $retained
                drainComplete = ($eof[0] -and $eof[1] -and -not $readFault); stdinError = $stdinError
                stdout = [ordered]@{ file = 'stdout.bin'; sha256 = (& $hashOf $outPath); retainedBytes = $ret[0] }
                stderr = [ordered]@{ file = 'stderr.bin'; sha256 = (& $hashOf $errPath); retainedBytes = $ret[1] }
                artifact = $artifact
            }
            if ($null -ne $aggregateAuthority) { $terminalObj['aggregateAdvisory'] = $aggregateAuthority }
            if ($noStop) {
                # Transport completion only: SDK outcome and usage stay pending until an authenticated consumer reads the raw result. No inferred zero or success.
                $terminalObj['outputStopProfile'] = 'observe-only-v1'
                $terminalObj['outputStopAuthority'] = $outputStopAuthority
                $terminalObj['usageTelemetry'] = [ordered]@{
                    schema = 'ManagedUsageTelemetry/v1'; status = 'RAW_SDK_RESULT_PENDING'; outputTokens = $null
                    stdoutBytes = [long]$ret[0]; stdoutSha256 = $terminalObj['stdout']['sha256']
                    stderrBytes = [long]$ret[1]; stderrSha256 = $terminalObj['stderr']['sha256']
                }
            }
            if ($null -ne $tapCore) {
                if ($null -eq $tokenAccountingSnapshot) { throw 'Refusing: token accounting policy is present but no accounting snapshot was captured.' }
                $taSnap = $tokenAccountingSnapshot
                $taPolicyOut = [ordered]@{
                    MaxMessages = [long]$tapCore[0]
                    MaxEvents = [long]$tapCore[1]
                    MaxLineBytes = [long]$tapCore[2]
                    MaxInputBytes = [long]$tapCore[3]
                    RemainingTokens = [long]$tapCore[4]
                    HistoricalOutputTokens = [long]$tapCore[5]
                    AdditionalOutputMax = [long]$tapCore[6]
                    PhaseAggregateCeiling = [long]$tapCore[7]
                }
                $taTriggerOut = $null
                if ($null -ne $taSnap.firstTrigger) { $taTriggerOut = [string]$taSnap.firstTrigger.ToString() }
                $taAggOut = $null
                if ($null -ne $taSnap.resultAggregate) { $taAggOut = [long]$taSnap.resultAggregate }
                $taConsOut = $null
                if ($null -ne $taSnap.resultConsistent) { $taConsOut = [bool]$taSnap.resultConsistent }
                $terminalObj['tokenAccounting'] = [ordered]@{
                    schema = 'ManagedTokenAccounting/v1'
                    policy = $taPolicyOut
                    observedOutputTokens = [long]$taSnap.observedOutputTokens
                    messageCount = [long]$taSnap.messageCount
                    firstTrigger = $taTriggerOut
                    invalid = [bool]$taSnap.invalid
                    resultAggregate = $taAggOut
                    resultConsistent = $taConsOut
                    inputBytes = [long]$taSnap.inputBytes
                    bufferedLineBytes = [long]$taSnap.bufferedLineBytes
                    parseComplete = [bool]$taSnap.parseComplete
                    stdoutEof = [bool]$eof[0]
                    stdoutTruncated = [bool]$tokenStdoutTruncated
                }
            }
            if ($null -ne $projectionCallback -and $acked -and $definitive -and $reason -cne 'START_PERSIST_FAILED') {
                $projInit = [ordered]@{
                    schema = 'ManagedNativeProjection/v1'; runId = $runId; attempt = $num['Attempt']; requestSha256 = $requestSha
                    status = 'PENDING'; attempts = 0; terminalSha256 = $null; lastErrorCode = $null; result = $null
                }
                Write-AtomicFile $projPath (ConvertTo-Json -InputObject $projInit -Compress)
                $projRecord = [System.IO.File]::ReadAllText($projPath) | ConvertFrom-Json
            }
            Write-AtomicFile $terminalPath (ConvertTo-Json -InputObject $terminalObj -Compress -Depth 6)
            $terminalSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($terminalPath))
            $terminal = & $readRecord $terminalPath 'terminal'
            if ($reason -ceq 'START_PERSIST_FAILED') { $state = 'RECONCILE_REQUIRED'; $reconcile = 'START_PERSIST_FAILED' }
            elseif ($definitive) { $state = 'TERMINAL' }
            else { $state = 'RECONCILE_REQUIRED'; $reconcile = 'EXIT_NOT_OBSERVED' }
        }
    } finally {
        if ($lockOpen) { $lock.Dispose(); $lockOpen = $false }
    }

    $projectionStatus = if ($null -eq $projRecord) { 'NONE' } else { [string]$projRecord.status }
    $projectionResult = $null
    if ($state -eq 'TERMINAL' -and $null -ne $projectionCallback -and $null -ne $projRecord -and $terminal.onStartedAcknowledged -eq $true) {
        $projectionLockPath = Join-Path $runDirFull 'projection.lock'
        $projLock = Lock-ExclusiveFile $projectionLockPath
        try {
            # Fresh strict reread under projection ownership; no reliance on the run-lock-scoped
            # $terminal/$terminalSha/$manifestSha captured above.
            $pre = & $validatePersistedEvidence
            $preProj = $pre['projection']
            if ($null -eq $preProj -or $preProj.status -cne 'PENDING') {
                $projectionStatus = if ($null -eq $preProj) { 'NONE' } else { [string]$preProj.status }
            } elseif ($null -eq $pre['terminal'] -or $null -eq $pre['start'] -or -not $pre['acknowledged'] -or $pre['terminal'].definitive -ne $true -or $pre['reconcile']) {
                throw 'Refusing: projection ownership requires an actual complete start, acknowledged definitive non-reconciling terminal.'
            } else {
                $preTerminalSha = $pre['terminalSha256']
                $preManifestSha = $pre['manifestSha256']
                if ($null -eq $preProj.terminalSha256) {
                    $boundRec = [ordered]@{
                        schema = $preProj.schema; runId = $runId; attempt = $num['Attempt']; requestSha256 = $requestSha
                        status = 'PENDING'; attempts = $preProj.attempts; terminalSha256 = $preTerminalSha
                        lastErrorCode = $null; result = $null
                    }
                    Write-AtomicFile $projPath (ConvertTo-Json -InputObject $boundRec -Compress)
                }
                $preProjBytesSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($projPath))
                $attemptsIn = [int64]$preProj.attempts
                if ($attemptsIn -ge [int64]::MaxValue) { throw 'Refusing: projection attempts counter is at its maximum; refusing to overflow.' }
                $attemptsNext = $attemptsIn + [int64]1

                $ref = [pscustomobject]@{
                    RunId = $runId; Attempt = $num['Attempt']; RunDir = $runDirFull; RequestSha256 = $requestSha
                    ManifestPath = $manifestPath; ManifestSha256 = $preManifestSha; StartPath = $startPath
                    TerminalPath = $terminalPath; TerminalSha256 = $preTerminalSha; Terminal = $pre['terminal']
                }
                $newStatus = 'PENDING'; $errCode = $null; $resText = $null
                try {
                    $cbOut = @(& $projectionCallback $ref)
                    try { $resText = ConvertTo-Json -InputObject $cbOut -Compress -Depth 3 } catch { $resText = 'UNSERIALIZABLE_RESULT' }
                    if ($resText.Length -gt 2048) { $resText = $resText.Substring(0, 2048) }
                    $newStatus = 'DONE'
                } catch {
                    $errCode = $_.Exception.GetType().FullName
                }
                # Reread and recompare before saving; a callback already ran, so on mismatch the
                # outcome is left recorded as unpersisted rather than claiming exactly-once success.
                $post = & $validatePersistedEvidence
                $postProj = $post['projection']
                $postProjBytesSha = Get-Sha256Hex ([System.IO.File]::ReadAllBytes($projPath))
                $unchanged = ($null -ne $post['terminal']) -and ($post['terminalSha256'] -ceq $preTerminalSha) -and
                    ($post['manifestSha256'] -ceq $preManifestSha) -and (-not $post['reconcile']) -and
                    ($null -ne $postProj) -and ($postProj.status -ceq 'PENDING') -and
                    ($postProj.terminalSha256 -ceq $preTerminalSha) -and ([int64]$postProj.attempts -eq $attemptsIn) -and
                    ($postProjBytesSha -ceq $preProjBytesSha)
                if (-not $unchanged) {
                    $projectionStatus = 'RESULT_UNPERSISTED_' + $newStatus
                } else {
                    $rec = [ordered]@{
                        schema = $postProj.schema; runId = $runId; attempt = $num['Attempt']; requestSha256 = $requestSha
                        status = $newStatus; attempts = $attemptsNext; terminalSha256 = $preTerminalSha
                        lastErrorCode = $errCode; result = $resText
                    }
                    try {
                        Write-AtomicFile $projPath (ConvertTo-Json -InputObject $rec -Compress)
                        $projectionStatus = $newStatus
                    } catch {
                        $projectionStatus = 'RESULT_UNPERSISTED_' + $newStatus
                    }
                }
                $projectionResult = $resText
            }
        } finally {
            $projLock.Dispose()
        }
    }
    return [pscustomobject]@{
        State = $state; RunId = $runId; Attempt = $num['Attempt']; RunDir = $runDirFull
        TerminalPath = $terminalPath; TerminalSha256 = $terminalSha; Terminal = $terminal
        Reconciliation = $reconcile; ProjectionStatus = $projectionStatus; ProjectionResult = $projectionResult
    }
}

Set-StrictMode -Version Latest

function New-ManagedTokenEventState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$RemainingTokens,
        [Parameter(Mandatory = $true)][object]$MaxMessages,
        [Parameter(Mandatory = $true)][object]$MaxEvents
    )

    function Convert-StrictInteger {
        param([object]$Value, [Int64]$Min, [Int64]$Max)
        if ($null -eq $Value) { return $null }
        if ($Value -isnot [int] -and $Value -isnot [long]) { return $null }
        $n = [Int64]$Value
        if ($n -lt $Min -or $n -gt $Max) { return $null }
        return $n
    }

    $remaining = Convert-StrictInteger -Value $RemainingTokens -Min 1 -Max ([Int64]::MaxValue)
    $maxMsg = Convert-StrictInteger -Value $MaxMessages -Min 1 -Max 10000
    $maxEvt = Convert-StrictInteger -Value $MaxEvents -Min 1 -Max 100000
    if ($null -eq $remaining) { throw 'Invalid RemainingTokens: must be a positive Int64.' }
    if ($null -eq $maxMsg) { throw 'Invalid MaxMessages: must be a positive Int32 not exceeding 10000.' }
    if ($null -eq $maxEvt) { throw 'Invalid MaxEvents: must be a positive Int32 not exceeding 100000.' }

    $maxima = New-Object 'System.Collections.Generic.Dictionary[string,long]' ([System.StringComparer]::Ordinal)

    $state = [PSCustomObject]@{
        PSTypeName      = 'ManagedTokenEventState'
        RemainingTokens = [Int64]$remaining
        MaxMessages     = [int]$maxMsg
        MaxEvents       = [int]$maxEvt
        Maxima          = $maxima
        CurrentId       = $null
        EventCount      = [int]0
        ObservedSum     = [Int64]0
        FirstTrigger    = $null
        Invalid         = $false
        ResultAggregate = $null
        ResultConsistent = $null
    }
    return $state
}

function Add-ManagedTokenEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$State,
        [Parameter(Mandatory = $true)][object]$Record
    )

    if ($null -eq $State -or $State -isnot [psobject] -or
        $null -eq $State.PSObject.Properties['Maxima'] -or
        $State.Maxima -isnot [System.Collections.Generic.Dictionary[string,long]] -or
        $null -eq $State.PSObject.Properties['ObservedSum'] -or
        $null -eq $State.PSObject.Properties['RemainingTokens'] -or
        $null -eq $State.PSObject.Properties['MaxMessages'] -or
        $null -eq $State.PSObject.Properties['MaxEvents'] -or
        $null -eq $State.PSObject.Properties['EventCount'] -or
        $null -eq $State.PSObject.Properties['FirstTrigger'] -or
        $null -eq $State.PSObject.Properties['Invalid'] -or
        $null -eq $State.PSObject.Properties['CurrentId'] -or
        $null -eq $State.PSObject.Properties['ResultAggregate'] -or
        $null -eq $State.PSObject.Properties['ResultConsistent'] -or
        $State.PSObject.TypeNames -notcontains 'ManagedTokenEventState') {
        throw 'Invalid State: not an owned managed token event state.'
    }
    if ($State.RemainingTokens -isnot [long] -or $State.ObservedSum -isnot [long] -or
        $State.MaxMessages -isnot [int] -or $State.MaxEvents -isnot [int] -or
        $State.EventCount -isnot [int] -or $State.RemainingTokens -lt 1 -or
        $State.ObservedSum -lt 0 -or $State.EventCount -lt 0 -or
        $State.MaxMessages -lt 1 -or $State.MaxMessages -gt 10000 -or
        $State.MaxEvents -lt 1 -or $State.MaxEvents -gt 100000 -or
        $State.EventCount -gt $State.MaxEvents) {
        throw 'Invalid State: counters or policy values are malformed.'
    }

    function Get-Prop {
        param([object]$Obj, [string]$Name)
        if ($null -eq $Obj) { return @{ Has = $false; Value = $null } }
        if ($Obj -isnot [System.Management.Automation.PSCustomObject]) { return @{ Has = $false; Value = $null } }
        $p = $Obj.PSObject.Properties[$Name]
        if ($null -eq $p) { return @{ Has = $false; Value = $null } }
        return @{ Has = $true; Value = $p.Value }
    }

    function Test-NonNegInt {
        param([object]$V)
        if ($null -eq $V) { return $false }
        if ($V -isnot [int] -and $V -isnot [long]) { return $false }
        return ([Int64]$V -ge 0)
    }

    function Set-Trigger {
        param([object]$S, [string]$Name)
        if ($null -eq $S.FirstTrigger) { $S.FirstTrigger = $Name }
    }

    function Set-Bad {
        param([object]$S)
        $S.Invalid = $true
        Set-Trigger -S $S -Name 'PARSE_INVALID'
    }

    function Get-Snapshot {
        param([object]$S)
        $agg = $null
        if ($null -ne $S.ResultAggregate) { $agg = [Int64]$S.ResultAggregate }
        $cons = $null
        if ($null -ne $S.ResultConsistent) { $cons = [bool]$S.ResultConsistent }
        return [PSCustomObject]@{
            observedOutputTokens = [Int64]$S.ObservedSum
            firstTrigger         = $S.FirstTrigger
            messageCount         = [int]$S.Maxima.Count
            invalid              = [bool]$S.Invalid
            resultAggregate      = $agg
            resultConsistent     = $cons
        }
    }

    $outerType = Get-Prop -Obj $Record -Name 'type'
    if (-not $outerType.Has -or $outerType.Value -isnot [string]) {
        if ($Record -is [System.Management.Automation.PSCustomObject]) {
            $null = $null
        }
        return (Get-Snapshot -S $State)
    }
    $ot = [string]$outerType.Value
    if ($ot -ne 'stream_event' -and $ot -ne 'result') { return (Get-Snapshot -S $State) }

    if ($State.EventCount -ge $State.MaxEvents) {
        $State.Invalid = $true
        Set-Trigger -S $State -Name 'STATE_LIMIT'
        return (Get-Snapshot -S $State)
    }
    $State.EventCount = [int]($State.EventCount + 1)

    if ($ot -eq 'result') {
        $usage = Get-Prop -Obj $Record -Name 'usage'
        if (-not $usage.Has -or $usage.Value -isnot [System.Management.Automation.PSCustomObject]) {
            Set-Bad -S $State
            return (Get-Snapshot -S $State)
        }
        $out = Get-Prop -Obj $usage.Value -Name 'output_tokens'
        if (-not $out.Has -or -not (Test-NonNegInt $out.Value)) {
            Set-Bad -S $State
            return (Get-Snapshot -S $State)
        }
        $State.ResultAggregate = [Int64]$out.Value
        if ([Int64]$out.Value -eq [Int64]$State.ObservedSum) {
            $State.ResultConsistent = $true
        } else {
            $State.ResultConsistent = $false
            Set-Bad -S $State
        }
        return (Get-Snapshot -S $State)
    }

    $ev = Get-Prop -Obj $Record -Name 'event'
    if (-not $ev.Has -or $ev.Value -isnot [System.Management.Automation.PSCustomObject]) {
        Set-Bad -S $State
        return (Get-Snapshot -S $State)
    }
    $evType = Get-Prop -Obj $ev.Value -Name 'type'
    if (-not $evType.Has -or $evType.Value -isnot [string]) {
        Set-Bad -S $State
        return (Get-Snapshot -S $State)
    }
    $et = [string]$evType.Value
    if ($et -ne 'message_start' -and $et -ne 'message_delta') { return (Get-Snapshot -S $State) }

    if ($et -eq 'message_start') {
        $msg = Get-Prop -Obj $ev.Value -Name 'message'
        if (-not $msg.Has -or $msg.Value -isnot [System.Management.Automation.PSCustomObject]) {
            Set-Bad -S $State
            return (Get-Snapshot -S $State)
        }
        $idp = Get-Prop -Obj $msg.Value -Name 'id'
        if (-not $idp.Has -or $idp.Value -isnot [string] -or [string]::IsNullOrEmpty([string]$idp.Value)) {
            Set-Bad -S $State
            return (Get-Snapshot -S $State)
        }
        $id = [string]$idp.Value
        if (-not $State.Maxima.ContainsKey($id)) {
            if ($State.Maxima.Count -ge $State.MaxMessages) {
                $State.Invalid = $true
                Set-Trigger -S $State -Name 'STATE_LIMIT'
                return (Get-Snapshot -S $State)
            }
            $State.Maxima.Add($id, [Int64]0)
        }
        $State.CurrentId = $id
        return (Get-Snapshot -S $State)
    }

    # message_delta
    if ($null -eq $State.CurrentId -or -not $State.Maxima.ContainsKey([string]$State.CurrentId)) {
        Set-Bad -S $State
        return (Get-Snapshot -S $State)
    }

    $newMax = $null
    $usageP = Get-Prop -Obj $ev.Value -Name 'usage'
    if ($usageP.Has) {
        if ($usageP.Value -isnot [System.Management.Automation.PSCustomObject]) {
            Set-Bad -S $State
            return (Get-Snapshot -S $State)
        }
        $outP = Get-Prop -Obj $usageP.Value -Name 'output_tokens'
        if ($outP.Has) {
            if (-not (Test-NonNegInt $outP.Value)) {
                Set-Bad -S $State
                return (Get-Snapshot -S $State)
            }
            $newMax = [Int64]$outP.Value
        }
    }

    $isMaxTokens = $false
    $deltaP = Get-Prop -Obj $ev.Value -Name 'delta'
    if ($deltaP.Has) {
        if ($null -ne $deltaP.Value -and $deltaP.Value -isnot [System.Management.Automation.PSCustomObject]) {
            Set-Bad -S $State
            return (Get-Snapshot -S $State)
        }
        if ($null -ne $deltaP.Value) {
            $srP = Get-Prop -Obj $deltaP.Value -Name 'stop_reason'
            if ($srP.Has -and $null -ne $srP.Value) {
                if ($srP.Value -isnot [string]) {
                    Set-Bad -S $State
                    return (Get-Snapshot -S $State)
                }
                if ([string]$srP.Value -ceq 'max_tokens') { $isMaxTokens = $true }
            }
        }
    }

    if ($null -ne $newMax) {
        $cid = [string]$State.CurrentId
        $old = [Int64]$State.Maxima[$cid]
        if ($newMax -gt $old) {
            $diff = [Int64]($newMax - $old)
            if ($State.ObservedSum -gt ([Int64]::MaxValue - $diff)) {
                $State.Invalid = $true
                Set-Trigger -S $State -Name 'STATE_LIMIT'
                return (Get-Snapshot -S $State)
            }
            $State.Maxima[$cid] = $newMax
            $State.ObservedSum = [Int64]($State.ObservedSum + $diff)
        }
    }

    if ($isMaxTokens) {
        Set-Trigger -S $State -Name 'MAX_TOKENS'
    } elseif ($State.ObservedSum -ge $State.RemainingTokens) {
        Set-Trigger -S $State -Name 'TOKEN_LIMIT'
    }

    return (Get-Snapshot -S $State)
}
# UnitB append: bounded raw-byte line carry over the accepted ManagedTokenEvent reducer.
# Limits are parser inputs only. They are never worker budget grants.

if ($null -eq (Get-Variable -Name ManagedTokenAccountingOwners -Scope Script -ErrorAction SilentlyContinue)) {
    # Ownership registry: token -> Tuple(state PSObject, MaxInputBytes, MaxLineBytes).
    # Weak keys, so abandoned states are collectable. Bounds here are the authoritative immutable copy.
    $script:ManagedTokenAccountingOwners = [System.Runtime.CompilerServices.ConditionalWeakTable[object, object]]::new()
}

function New-ManagedTokenAccountingState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$RemainingTokens,
        [Parameter(Mandatory)][AllowNull()][object]$MaxMessages,
        [Parameter(Mandatory)][AllowNull()][object]$MaxEvents,
        [Parameter(Mandatory)][AllowNull()][object]$MaxLineBytes,
        [Parameter(Mandatory)][AllowNull()][object]$MaxInputBytes
    )

    # Strict typing: only real [int]/[long] values; no strings, bools, arrays, doubles.
    if (-not (($MaxLineBytes -is [int]) -or ($MaxLineBytes -is [long])) -or [long]$MaxLineBytes -le 0 -or [long]$MaxLineBytes -gt 1048576) {
        throw [System.ArgumentException]::new('MaxLineBytes must be a strict positive int/long <= 1048576.')
    }
    if (-not (($MaxInputBytes -is [int]) -or ($MaxInputBytes -is [long])) -or [long]$MaxInputBytes -le 0) {
        throw [System.ArgumentException]::new('MaxInputBytes must be a strict positive int/long.')
    }

    # Event policy validation is delegated to the accepted reducer.
    $eventState = New-ManagedTokenEventState -RemainingTokens $RemainingTokens -MaxMessages $MaxMessages -MaxEvents $MaxEvents

    $token = [object]::new()
    $state = [pscustomobject]@{
        PSTypeName   = 'ManagedTokenAccountingState'
        EventState   = $eventState
        Token        = $token
        MaxLineBytes = [int]$MaxLineBytes
        MaxInputBytes = [long]$MaxInputBytes
        Carry        = [byte[]]::new(0)
        LineLen      = [int]0
        InputBytes   = [long]0
        FirstLine    = $true
        Finalized    = $false
        Failed       = $false
        OwnTrigger   = $null
        Snap         = @{
            observedOutputTokens = [long]0
            firstTrigger         = $null
            messageCount         = [int]0
            invalid              = $false
            resultAggregate      = $null
            resultConsistent     = $null
        }
    }
    $record = [System.Tuple[object, long, int]]::new($state.PSObject, [long]$MaxInputBytes, [int]$MaxLineBytes)
    $script:ManagedTokenAccountingOwners.Add($token, $record)
    return $state
}

function Add-ManagedTokenAccountingBytes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$State,
        [Parameter(Mandatory)][AllowNull()][AllowEmptyCollection()][object]$Bytes,
        [object]$Final = $false
    )

    # ---- typed inputs (no coercion) ----
    if ($Bytes -isnot [byte[]]) { throw [System.ArgumentException]::new('Bytes must be an actual byte[].') }
    if ($Final -isnot [bool]) { throw [System.ArgumentException]::new('Final must be a Boolean.') }

    # ---- ownership and shape ----
    $record = $null
    $ok = $false
    if ($State -is [pscustomobject] -and ($State.PSObject.TypeNames -contains 'ManagedTokenAccountingState')) {
        $props = $State.PSObject.Properties
        if ($null -ne $props['Token'] -and $null -ne $State.Token -and $null -ne $props['EventState']) {
            if ($script:ManagedTokenAccountingOwners.TryGetValue($State.Token, [ref]$record) -and
                [object]::ReferenceEquals($record.Item1, $State.PSObject)) {
                $ok = ($State.InputBytes -is [long]) -and ($State.LineLen -is [int]) -and
                      ($State.Carry -is [byte[]]) -and ($State.FirstLine -is [bool]) -and
                      ($State.Finalized -is [bool]) -and ($State.Failed -is [bool]) -and
                      ($State.Snap -is [hashtable]) -and
                      ($State.MaxInputBytes -is [long]) -and ($State.MaxLineBytes -is [int]) -and
                      ($State.MaxInputBytes -eq $record.Item2) -and ($State.MaxLineBytes -eq $record.Item3) -and
                      ($State.EventState -is [pscustomobject]) -and
                      ($State.EventState.PSObject.TypeNames -contains 'ManagedTokenEventState')
                if ($ok) {
                    $ok = ($State.InputBytes -ge 0) -and ($State.InputBytes -le $record.Item2) -and
                          ($State.LineLen -ge 0) -and ($State.LineLen -le ($record.Item3 + 1)) -and
                          ($State.Carry.Length -ge $State.LineLen) -and ($State.Carry.Length -le ($record.Item3 + 1))
                }
            }
        }
    }
    if (-not $ok) { throw [System.ArgumentException]::new('State is not an owned, well-formed ManagedTokenAccountingState.') }

    $maxIn = [long]$record.Item2
    $maxLine = [int]$record.Item3
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)

    # ---- helpers (operate on the owned state via dynamic scope) ----
    $fail = {
        param($trigger)
        $State.Failed = $true
        if ($null -eq $State.OwnTrigger) { $State.OwnTrigger = $trigger }
    }

    $append = {
        param($src, $from, $count)
        if ($count -le 0) { return }
        $need = $State.LineLen + $count
        if ($State.Carry.Length -lt $need) {
            $cap = [Math]::Max([Math]::Max($need, $State.Carry.Length * 2), 256)
            $cap = [Math]::Min($cap, $maxLine + 1)
            $nb = [byte[]]::new($cap)
            if ($State.LineLen -gt 0) { [Array]::Copy($State.Carry, $nb, $State.LineLen) }
            $State.Carry = $nb
        }
        [Array]::Copy($src, $from, $State.Carry, $State.LineLen, $count)
        $State.LineLen = [int]$need
    }

    $procLine = {
        param($arr, $off, $n)
        $text = $null
        try { $text = $utf8.GetString($arr, $off, $n) }   # strict: throws on bad or truncated UTF-8
        catch { & $fail 'PARSE_INVALID'; return }
        if ($State.FirstLine) {
            $State.FirstLine = $false
            if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        }
        if ($text -match '^[ \t\r]*$') { return }          # blank line
        $rec = $null
        try {
            $doc = [System.Text.Json.JsonDocument]::Parse($text, [System.Text.Json.JsonDocumentOptions]::new())  # strict RFC 8259
            $doc.Dispose()
            $rec = ConvertFrom-Json -InputObject $text -ErrorAction Stop
        }
        catch { & $fail 'PARSE_INVALID'; return }
        if ($rec -isnot [pscustomobject]) { & $fail 'PARSE_INVALID'; return }
        $r = Add-ManagedTokenEvent -State $State.EventState -Record $rec
        $State.Snap = @{
            observedOutputTokens = [long]$r.observedOutputTokens
            firstTrigger         = $r.firstTrigger
            messageCount         = [int]$r.messageCount
            invalid              = [bool]$r.invalid
            resultAggregate      = $r.resultAggregate
            resultConsistent     = $r.resultConsistent
        }
        if ($State.Snap.invalid) { $State.Failed = $true }
    }

    $len = $Bytes.Length

    if ($State.Finalized) {
        if ($len -gt 0) { throw [System.InvalidOperationException]::new('Data after final is refused.') }
    }
    elseif (-not ($State.Failed -or $State.Snap.invalid)) {
        $base = [long]$State.InputBytes
        $remaining = $maxIn - $base
        $allowed = if ([long]$len -le $remaining) { $len } else { [int]$remaining }
        $pos = 0
        $stopped = $false

        while ($pos -lt $allowed -and -not $stopped) {
            $lf = [Array]::IndexOf($Bytes, [byte]10, $pos, $allowed - $pos)
            $segEnd = if ($lf -ge 0) { $lf } else { $allowed }
            $k = $segEnd - $pos
            $total = $State.LineLen + $k
            $last = -1
            if ($k -gt 0) { $last = [int]$Bytes[$segEnd - 1] }
            elseif ($State.LineLen -gt 0) { $last = [int]$State.Carry[$State.LineLen - 1] }
            $content = $total - $(if ($last -eq 13) { 1 } else { 0 })   # a trailing CR is delimiter, not payload

            if ($content -gt $maxLine) {
                # Locate the first offending byte so split/whole inputs stay observationally identical.
                $j = 0
                while ($j -lt $k) {
                    $p = $State.LineLen + $j + 1
                    $c = $p - $(if ($Bytes[$pos + $j] -eq 13) { 1 } else { 0 })
                    if ($c -gt $maxLine) { break }
                    $j++
                }
                & $append $Bytes $pos $j
                $State.InputBytes = $base + $pos + $j
                & $fail 'STATE_LIMIT'
                $stopped = $true
                break
            }

            if ($lf -lt 0) {
                & $append $Bytes $pos $k
                $pos = $allowed
            }
            else {
                if ($State.LineLen -eq 0) { $arr = $Bytes; $off = $pos; $n = $k }
                else { & $append $Bytes $pos $k; $arr = $State.Carry; $off = 0; $n = $State.LineLen }
                if ($n -gt 0 -and $arr[$off + $n - 1] -eq 13) { $n-- }
                $State.InputBytes = $base + $lf + 1
                & $procLine $arr $off $n
                $State.LineLen = 0
                $pos = $lf + 1
                if ($State.Failed) { $stopped = $true }
            }
        }

        if (-not $stopped) {
            $State.InputBytes = $base + $allowed
            if ($len -gt $allowed) { & $fail 'INPUT_LIMIT' }
        }
    }

    if ($Final -and -not $State.Finalized) {
        if (-not ($State.Failed -or $State.Snap.invalid) -and $State.LineLen -gt 0) {
            & $procLine $State.Carry 0 $State.LineLen   # unterminated final line, flushed once
            $State.LineLen = 0
        }
        $State.Finalized = $true
    }

    $s = $State.Snap
    $trigger = $s.firstTrigger
    if ($null -eq $trigger) { $trigger = $State.OwnTrigger }   # reducer's first trigger always wins
    $invalid = [bool]($s.invalid -or $State.Failed)
    return [pscustomobject]@{
        observedOutputTokens = [long]$s.observedOutputTokens
        firstTrigger         = $trigger
        messageCount         = [int]$s.messageCount
        invalid              = $invalid
        resultAggregate      = $s.resultAggregate
        resultConsistent     = $s.resultConsistent
        inputBytes           = [long]$State.InputBytes
        bufferedLineBytes    = [int]$State.LineLen
        parseComplete        = [bool]($State.Finalized -and -not $invalid)
    }
}