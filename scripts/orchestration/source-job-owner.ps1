#Requires -Version 7.5
# SOURCE-ONLY job owner for one finite, explicitly admitted batch (offline source module).
#
# The owner drives jobs registered in the ONE sourceOnlyJobQueue subset of a supplied index COPY, through the
# existing core APIs only (same lease, CAS version, atomic write, event-id/hash dedup). It keeps no second
# backlog or ledger. Everything it writes under EvidenceRoot (event files, intents, checkpoints, launcher
# output) is an immutable, deterministic record of its own progress; none of it is runtime authority and
# none of it is Factory completion. Reviews, dispositions, admissions, releases and delivery receipts are
# independently supplied INPUTS: this module never issues them.
#
# One Invoke-SourceJobOwnerStep call:
#   reconcile (invocation/start/terminal/raw hashes through the observed-event APIs; exit 0 -> REVIEW_REQUIRED)
#   -> persist review intent (BEFORE any tool call) and return typed actions
#   -> start eligible disjoint jobs through the pinned accepted launcher (one reservation per call, core path
#      conflicts and dependencies respected, launch handshake sequential so index versions stay valid)
#   -> with -AwaitRunning, wait for its own natural process completion (no timeout, no kill) and repeat.
# The step is finite by work: it returns when actions are pending, when nothing is running and nothing changed,
# or when the whole batch reached a released state. It never loops on a clock.
#
# REQUIRED EXTERNAL BROKER CONTRACT (live acceptance). Returning an action object is NOT live batch completion.
# The existing active agent that owns the batch must, for every SEND_REVIEW_HANDOFF action:
#   1. actually call collaboration.followup_task for Action.ReviewerTarget (a supported NONROOT peer) with the
#      intent reference; never a shell-faked acknowledgment, never a root wake, never request=handoff return;
#   2. save the real tool response and write a SourceJobReviewHandoffAck/v1 pinning it (toolResultRef must name
#      tool collaboration.followup_task, the target and the intentId; an offline fixture is labelled
#      "MOCK/NOT_LIVE" and proves nothing about a real handoff);
#   3. pass the saved response and the action to Submit-SourceJobHandoffResult (it writes the correlated ack and
#      imports it), then call Invoke-SourceJobOwnerStep again with -AwaitRunning so the same owner keeps the batch
#      until quiescent or complete. Actions are SEND_REVIEW_HANDOFF (source review) or
#      SEND_FAILURE_DIAGNOSIS_HANDOFF (independent diagnosis of FAILED/REFUSED; never acceptance, retry or release).
# Nothing in this file proves that step 1 happened. A live acceptance must show the real tool call and response.
# A scheduling acknowledgment proves dispatch only, never review acceptance. The returned independent review
# later enters as SourceJobIndependentDisposition/v1 + SourceJobDispositionAdmission/v1
# (Import-SourceJobDisposition) and, separately, SourceJobOwnershipRelease/v1 (Import-SourceJobOwnershipRelease).
# The intent is persisted before the tool call and the action is returned only by the call that persisted it. If the
# agent crashes between the tool call and the ack, later steps report HANDOFF_UNCERTAIN_NO_ACK and never resend;
# explicit tool/recipient evidence for the same intent must be fed as the ack.
# Observation evidence a live acceptance must show: the saved tool response, the ack, the index events, and one batch
# progressing with no root/heartbeat prerequisite.
#
# Refusals throw 'SJQ_REFUSED:<CODE>[:<detail>]' (the core's convention). Per-job problems are reported as
# reasons in the result instead of failing the step.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'source-job-queue.ps1')

$script:SjoDefaultOwner = '/root/bounded_state_check'
$script:SjoChildren = @{}
$script:SjoComplete = @('RELEASED_FAILED', 'DELIVERED_RELEASED')

# ---------- small helpers ----------

function Get-SjoNowUtc { [DateTime]::UtcNow.ToString('o') }

# Local clock dependency for launch gating only. It takes no parameters and grants no authority: it exists so a
# test that dot-sources this file can substitute it. There is no public parameter, switch or environment override.
function Get-SjoLaunchClockUtc { Get-SjoNowUtc }

function Get-SjoSha([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }

function Get-SjoCode($Exception) {
    if ($Exception.Message -cmatch '^SJQ_REFUSED:([A-Za-z0-9_]+)') { return $Matches[1] }
    $null
}

# Reads are lease-free; a concurrent atomic replace can make one read fail, so a few reads are tried.
function Get-SjoSnapshot([string]$IndexPath) {
    for ($attempt = 0; ; $attempt++) {
        # The path assertion is re-run inside every bounded attempt so a transient existence refusal is retried
        # too; the final attempt rethrows the original refusal. Nothing is cached or created.
        try { Assert-SjqIndexPath $IndexPath; return (Read-SjqIndexState $IndexPath) }
        catch { if ($attempt -ge 4) { throw }; Start-Sleep -Milliseconds 100 }
    }
}

function Get-SjoJob([string]$IndexPath, [string]$JobId) {
    $queue = (Get-SjoSnapshot $IndexPath).Queue
    if ($queue['jobs'].Contains($JobId)) { return $queue['jobs'][$JobId] }
    $null
}

# A file still being written by the launcher is held without sharing, so it is simply not ready yet.
function Test-SjoReadyFile([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $false }
    try {
        $stream = [IO.File]::Open($Path, 'Open', 'Read', 'None')
        try { return ($stream.Length -gt 0) } finally { $stream.Dispose() }
    }
    catch { return $false }
}

function Get-SjoFileRef([string]$Path) {
    Assert-SjqOrdinaryFile $Path 'evidence'
    [ordered]@{ path = $Path; sha256 = (Get-SjoSha ([IO.File]::ReadAllBytes($Path))) }
}

# Create-new only. A deterministic record that already exists must be byte-identical (or reused where the
# caller says an earlier writer's bytes win, e.g. an intent persisted before a crash).
function Write-SjoImmutableJson([string]$Path, $Object, [switch]$ReuseExisting) {
    Assert-SjqNormalizedPath $Path 'evidence'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Object -Depth 20) + "`n")
    try {
        $stream = [IO.File]::Open($Path, 'CreateNew', 'Write', 'None')
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    }
    catch [IO.IOException] {
        if (-not [IO.File]::Exists($Path)) { throw }
        $existing = $null
        for ($i = 0; $i -lt 40; $i++) {
            try { $existing = [IO.File]::ReadAllBytes($Path); if ($existing.Length -gt 0) { break } } catch { $existing = $null }
            Start-Sleep -Milliseconds 50
        }
        if ($null -eq $existing -or $existing.Length -eq 0) { Stop-SjqRefused 'EVIDENCE_FILE_UNREADABLE' $Path }
        if (-not $ReuseExisting -and (Get-SjoSha $existing) -cne (Get-SjoSha $bytes)) { Stop-SjqRefused 'EVIDENCE_FILE_CONFLICT' $Path }
        $bytes = $existing
    }
    [ordered]@{ path = $Path; sha256 = (Get-SjoSha $bytes) }
}

# The event file is deterministic per eventId, then applied with the core's own dedup. A stale version is retried.
function Submit-SjoEvent([string]$IndexPath, $Event, [string]$EvidenceRoot, [string]$AtUtc) {
    $ref = Write-SjoImmutableJson (Join-Path (Join-Path $EvidenceRoot 'events') "$($Event['eventId']).json") $Event
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        $version = [long](Get-SjoSnapshot $IndexPath).Queue['version']
        try { return (Invoke-SourceJobQueueEvent -IndexPath $IndexPath -ExpectedVersion $version -EventPath $ref.path -ExpectedEventSha256 $ref.sha256 -AtUtc $AtUtc) }
        catch {
            $code = Get-SjoCode $_.Exception
            if ($attempt -lt 5 -and (@('VERSION_CONFLICT', 'LEASE_BUSY') -ccontains $code)) { Start-Sleep -Milliseconds 100; continue }
            throw
        }
    }
}

function Submit-SjoSafe([string]$IndexPath, $Event, [string]$EvidenceRoot, [string]$AtUtc) {
    try {
        $result = Submit-SjoEvent $IndexPath $Event $EvidenceRoot $AtUtc
        [pscustomobject]@{ Ok = $true; Applied = ($result.Status -ceq 'APPLIED'); Code = $null }
    }
    catch {
        $code = Get-SjoCode $_.Exception
        if ($null -eq $code) { throw }
        [pscustomobject]@{ Ok = $false; Applied = $false; Code = $code }
    }
}

# ---------- explicit evidence import operations ----------

function Import-SjoEvidence([string]$IndexPath, [string]$JobId, [string]$Type, [string]$EventPrefix, [string]$IdKey, [hashtable]$Refs, [string]$EvidenceRoot, [string]$AtUtc) {
    $first = $null
    foreach ($ref in $Refs.Values) { if ($null -eq $first) { $first = $ref } }
    $doc = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $Refs[$IdKey].path $Refs[$IdKey].sha256 $IdKey) $IdKey
    $idField = switch -CaseSensitive ($Type) { 'REVIEW_HANDOFF_ACK' { 'ackId' } 'SOURCE_DISPOSITION' { 'dispositionId' } default { 'releaseId' } }
    $docId = Get-SjqString $doc $idField $IdKey $script:SjqIdPattern
    $event = [ordered]@{ schema = 'SourceJobQueueEvent/v1'; eventId = "$EventPrefix-$docId"; type = $Type; jobId = $JobId }
    foreach ($key in $Refs.Keys) { $event[$key] = [ordered]@{ path = $Refs[$key].path; sha256 = $Refs[$key].sha256 } }
    Submit-SjoEvent $IndexPath $event $EvidenceRoot $AtUtc
}

# Feeds the saved collaboration.followup_task response (via its ack) for the exact persisted intent.
function Import-SourceJobReviewAck {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath, [Parameter(Mandatory)][string]$JobId, [Parameter(Mandatory)][string]$AckPath,
        [Parameter(Mandatory)][string]$ExpectedAckSha256, [Parameter(Mandatory)][string]$EvidenceRoot, [string]$AtUtc = (Get-SjoNowUtc)
    )
    Import-SjoEvidence $IndexPath $JobId 'REVIEW_HANDOFF_ACK' 'evt-ack' 'ackRef' @{ ackRef = @{ path = $AckPath; sha256 = $ExpectedAckSha256 } } $EvidenceRoot $AtUtc
}

function Import-SourceJobDisposition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath, [Parameter(Mandatory)][string]$JobId,
        [Parameter(Mandatory)][string]$DispositionPath, [Parameter(Mandatory)][string]$ExpectedDispositionSha256,
        [Parameter(Mandatory)][string]$DispositionAdmissionPath, [Parameter(Mandatory)][string]$ExpectedDispositionAdmissionSha256,
        [Parameter(Mandatory)][string]$EvidenceRoot, [string]$AtUtc = (Get-SjoNowUtc)
    )
    Import-SjoEvidence $IndexPath $JobId 'SOURCE_DISPOSITION' 'evt-disp' 'dispositionRef' @{
        dispositionRef          = @{ path = $DispositionPath; sha256 = $ExpectedDispositionSha256 }
        dispositionAdmissionRef = @{ path = $DispositionAdmissionPath; sha256 = $ExpectedDispositionAdmissionSha256 }
    } $EvidenceRoot $AtUtc
}

function Import-SourceJobOwnershipRelease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath, [Parameter(Mandatory)][string]$JobId, [Parameter(Mandatory)][string]$ReleasePath,
        [Parameter(Mandatory)][string]$ExpectedReleaseSha256, [Parameter(Mandatory)][string]$EvidenceRoot, [string]$AtUtc = (Get-SjoNowUtc)
    )
    Import-SjoEvidence $IndexPath $JobId 'SOURCE_OWNERSHIP_RELEASE' 'evt-rel' 'releaseRef' @{ releaseRef = @{ path = $ReleasePath; sha256 = $ExpectedReleaseSha256 } } $EvidenceRoot $AtUtc
}

# Broker re-entry point. The active agent saves the REAL collaboration.followup_task response to a file and passes it
# here with the action it answers; this writes the correlated ack pinning that file and imports it. Nothing here calls
# the tool or can substitute for it: if no real response exists there is nothing valid to pass. The core refuses an
# ack whose saved response does not name the tool, destination and intent of the persisted intent.
function Submit-SourceJobHandoffResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath, [Parameter(Mandatory)]$Action, [Parameter(Mandatory)][string]$ToolResultPath,
        [Parameter(Mandatory)][string]$ExpectedToolResultSha256, [Parameter(Mandatory)][string]$EvidenceRoot, [string]$AtUtc = (Get-SjoNowUtc)
    )
    $null = Get-SjqPinnedBytes $ToolResultPath $ExpectedToolResultSha256 'toolResult'
    # The caller's Action is not authority. Before anything immutable is written it must match the intent that is
    # actually persisted for that job in the index (same job, intent id, destination and exact intent ref).
    $field = {
        param($Name)
        if ($Action -is [System.Collections.IDictionary]) { if ($Action.Contains($Name)) { $Action[$Name] } else { $null } }
        elseif ($null -ne $Action.PSObject.Properties[$Name]) { $Action.PSObject.Properties[$Name].Value }
        else { $null }
    }
    foreach ($name in 'JobId', 'IntentId', 'ReviewerTarget') {
        $value = & $field $name
        if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { Stop-SjqRefused 'BAD_TYPE' "action.$name" }
    }
    $actionRef = Get-SjqRef (& $field 'IntentRef') 'action.IntentRef'
    $actionJob = Get-SjoJob $IndexPath (& $field 'JobId')
    if ($null -eq $actionJob) { Stop-SjqRefused 'JOB_NOT_REGISTERED' (& $field 'JobId') }
    $registeredReview = $actionJob['review']
    $registeredIntent = if ($registeredReview -is [System.Collections.IDictionary]) { $registeredReview['intent'] } else { $null }
    if ($registeredIntent -isnot [System.Collections.IDictionary]) { Stop-SjqRefused 'NO_INTENT' (& $field 'JobId') }
    if ((& $field 'IntentId') -cne [string]$registeredIntent['intentId']) { Stop-SjqRefused 'ACK_CORRELATION' 'action.IntentId' }
    if ((& $field 'ReviewerTarget') -cne [string]$registeredIntent['reviewerTarget']) { Stop-SjqRefused 'ACK_CORRELATION' 'action.ReviewerTarget' }
    if (-not (Test-SjqRefEqual $actionRef $registeredIntent['ref'])) { Stop-SjqRefused 'ACK_CORRELATION' 'action.IntentRef' }
    # The ack identity includes the pinned response, so a refused response can never poison a later genuine one.
    $ackId = "ack-$(& $field 'IntentId')-$($ExpectedToolResultSha256.Substring(0, 12))"
    $ack = [ordered]@{
        schema = 'SourceJobReviewHandoffAck/v1'; ackId = $ackId; intentRef = $actionRef; reviewerTarget = (& $field 'ReviewerTarget')
        acknowledgedUtc = $AtUtc; toolResultRef = [ordered]@{ path = $ToolResultPath; sha256 = $ExpectedToolResultSha256 }
    }
    $ackRef = Write-SjoImmutableJson (Join-Path (Join-Path $EvidenceRoot 'acks') "$ackId.json") $ack -ReuseExisting
    Import-SourceJobReviewAck -IndexPath $IndexPath -JobId (& $field 'JobId') -AckPath $ackRef.path -ExpectedAckSha256 $ackRef.sha256 -EvidenceRoot $EvidenceRoot -AtUtc $AtUtc
}

# ---------- batch, packet and process helpers ----------

function ConvertTo-SjoBatch($Batch) {
    $result = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Batch)) {
        Assert-SjqKeys $entry @('jobId', 'runDirectory', 'usageRef') 'batch'
        $id = Get-SjqString $entry 'jobId' 'batch' $script:SjqIdPattern
        if (-not $seen.Add($id)) { Stop-SjqRefused 'DUPLICATE_ITEM' 'batch.jobId' }
        $run = Get-SjqString $entry 'runDirectory' 'batch'
        Assert-SjqNormalizedPath $run 'batch.runDirectory'
        $usage = $null
        if ($null -ne $entry['usageRef']) { $usage = Get-SjqRef $entry['usageRef'] 'batch.usageRef' }
        $result.Add([ordered]@{ jobId = $id; runDirectory = $run; usageRef = $usage })
    }
    if ($result.Count -eq 0) { Stop-SjqRefused 'EMPTY_LIST' 'batch' }
    , $result.ToArray()
}

# The launcher re-validates the receipt authoritatively; this only avoids dispatching on a packet that is
# visibly missing, drifted or expired, and stops NEW launches (never evidence or review work) at 100% included usage.
function Read-SjoUsagePacket($Ref) {
    $bad = { param($why) [pscustomobject]@{ Valid = $false; Why = $why; Captured = $null; Expires = $null; Stop = $null } }
    if ($null -eq $Ref) { return (& $bad 'USAGE_PACKET_MISSING') }
    try { $usage = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $Ref.path $Ref.sha256 'usageRef') 'usage' }
    catch { return (& $bad 'USAGE_PACKET_DRIFT') }
    try {
        $captured = ConvertTo-SjqUtc $usage['capturedAtUtc'] 'usage.capturedAtUtc'
        $expires = ConvertTo-SjqUtc $usage['expiresAtUtc'] 'usage.expiresAtUtc'
        $account = $usage['accountUsage']
        $week = $account['weekAllModelsUsedPercent']
        $session = $account['sessionUsedPercent']
        if (($week -isnot [int] -and $week -isnot [long]) -or ($session -isnot [int] -and $session -isnot [long]) -or $account['usageCredits'] -isnot [string]) { return (& $bad 'USAGE_PACKET_SHAPE') }
    }
    catch { return (& $bad 'USAGE_PACKET_SHAPE') }
    # Stop rules (current human policy): weekly >= 75, session/backend at 100, or credits not OFF. A session between
    # 75 and 99 is NOT a stop. Paid fallback never exists.
    $stop = $null
    if ($week -ge 75) { $stop = 'WEEKLY_AT_OR_ABOVE_75' }
    elseif ($session -ge 100) { $stop = 'SESSION_BACKEND_EXHAUSTED' }
    elseif ($account['usageCredits'] -cne 'OFF') { $stop = 'PAID_NOT_OFF' }
    [pscustomobject]@{ Valid = $true; Why = $null; Captured = $captured; Expires = $expires; Stop = $stop }
}

# Per-job packet freshness. Account exhaustion is decided batch-wide by Get-SjoAccountGate, not here.
function Get-SjoPacketStatus($Entry, [DateTimeOffset]$At) {
    $packet = Read-SjoUsagePacket $Entry['usageRef']
    if (-not $packet.Valid) { return "PREPARE_OR_REFRESH:$($packet.Why)" }
    if ($At -ge $packet.Expires -or $At -lt $packet.Captured) { return 'PREPARE_OR_REFRESH:USAGE_PACKET_EXPIRED' }
    # A job whose own packet records a stop is never launched with it, even when a newer packet reopened the gate.
    if ($null -ne $packet.Stop) { return 'PREPARE_OR_REFRESH:USAGE_PACKET_ACCOUNT_STOP' }
    'READY'
}

# One account, one gate for ALL new launches in the batch. The newest observation wins: an exhausted observation
# is lifted only by a strictly newer, still-fresh, available one (a genuine reset), never by an older READY packet
# or by an advertised reset time. With no usable observation the answer is REFRESH_NEEDED, never an inferred pool.
# This reads supplied packets only; it is not a provider probe, and the launcher keeps its own authority checks.
function Get-SjoAccountGate($Batch, [DateTimeOffset]$At) {
    $latestStop = $null
    $newestFresh = $null
    foreach ($entry in $Batch) {
        if ($null -eq $entry['usageRef']) { continue }
        $packet = Read-SjoUsagePacket $entry['usageRef']
        if (-not $packet.Valid) { continue }
        if ($null -ne $packet.Stop) { if ($null -eq $latestStop -or $packet.Captured -gt $latestStop.Captured) { $latestStop = $packet } }
        elseif ($At -lt $packet.Expires -and $At -ge $packet.Captured) { if ($null -eq $newestFresh -or $packet.Captured -gt $newestFresh.Captured) { $newestFresh = $packet } }
    }
    if ($null -ne $newestFresh -and ($null -eq $latestStop -or $newestFresh.Captured -gt $latestStop.Captured)) { return [pscustomobject]@{ State = 'AVAILABLE'; Reason = $null } }
    if ($null -ne $latestStop) { return [pscustomobject]@{ State = 'EXHAUSTED'; Reason = $latestStop.Stop } }
    [pscustomobject]@{ State = 'REFRESH_NEEDED'; Reason = 'NO_FRESH_ACCOUNT_EVIDENCE' }
}

function Complete-SjoChildren {
    foreach ($id in @($script:SjoChildren.Keys)) {
        $child = $script:SjoChildren[$id]
        if (-not $child.Process.HasExited) { continue }
        # Both real drains are still awaited; the (void-task) results are discarded so they cannot leak into the pipeline.
        try { $null = $child.CopyOut.GetAwaiter().GetResult(); $null = $child.CopyErr.GetAwaiter().GetResult() } catch { $null = $_ }
        $child.Out.Dispose(); $child.Err.Dispose(); $child.Process.Dispose()
        $script:SjoChildren.Remove($id)
    }
}

# A separate real process per job. Its streams go to files so a full pipe can never stall it.
function Start-SjoLauncher($Ctx, $Job, [string]$ReservationId, [long]$Version, $Entry) {
    $id = [string]$Job['jobId']
    $directory = Join-Path $Ctx.EvidenceRoot 'launcher'
    [void][IO.Directory]::CreateDirectory($directory)
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $arguments = @('-NoProfile', '-File', $Ctx.LauncherPath, '-IndexPath', $Ctx.IndexPath, '-ExpectedVersion', [string]$Version, '-JobId', $id, '-ReservationId', $ReservationId,
        '-PlanPath', [string]$Job['plan']['ref']['path'], '-ExpectedPlanSha256', [string]$Job['plan']['ref']['sha256'],
        '-AdmissionPath', [string]$Job['admission']['ref']['path'], '-ExpectedAdmissionSha256', [string]$Job['admission']['ref']['sha256'],
        '-UsagePath', [string]$Entry['usageRef']['path'], '-ExpectedUsageSha256', [string]$Entry['usageRef']['sha256'])
    foreach ($argument in $arguments) { $psi.ArgumentList.Add($argument) }
    $errPath = Join-Path $directory "$id.err.txt"
    $out = [IO.File]::Open((Join-Path $directory "$id.out.txt"), 'Append', 'Write', 'Read')
    $err = [IO.File]::Open($errPath, 'Append', 'Write', 'Read')
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $psi
    if (-not $process.Start()) { $out.Dispose(); $err.Dispose(); Stop-SjqRefused 'LAUNCHER_NOT_STARTED' $id }
    $process.StandardInput.Close()
    $child = @{ Process = $process; Out = $out; Err = $err; ErrPath = $errPath; CopyOut = $process.StandardOutput.BaseStream.CopyToAsync($out); CopyErr = $process.StandardError.BaseStream.CopyToAsync($err) }
    $script:SjoChildren[$id] = $child
    $child
}

# Brief launcher handshake (guards -> the one durable consume). It ends as soon as the reservation is consumed or
# the launcher exits; it never waits for, limits or kills the author run itself.
function Wait-SjoConsumption($Ctx, [string]$JobId, $Child) {
    while ($true) {
        $reservation = (Get-SjoJob $Ctx.IndexPath $JobId)['reservation']
        if (($reservation -is [System.Collections.IDictionary]) -and (Test-SjqHasKey $reservation 'consumed') -and ($reservation['consumed'] -eq $true)) { return $true }
        if ($Child.Process.WaitForExit(200)) {
            $reservation = (Get-SjoJob $Ctx.IndexPath $JobId)['reservation']
            return (($reservation -is [System.Collections.IDictionary]) -and (Test-SjqHasKey $reservation 'consumed') -and ($reservation['consumed'] -eq $true))
        }
    }
}

# Evaluated immediately before EVERY reservation and EVERY actual launcher start (including a VERSION_CONFLICT
# retry): current UTC, the batch-wide account gate and this job's packet, all re-read from the original pinned refs.
# Returns $null when launching is allowed, otherwise the actionable Next/Reason.
function Get-SjoLaunchBlock($Ctx, $Entry) {
    $at = ConvertTo-SjqUtc (Get-SjoLaunchClockUtc) 'launchClock'
    $gate = Get-SjoAccountGate $Ctx.Batch $at
    if ($gate.State -cne 'AVAILABLE') {
        return [pscustomobject]@{ Next = $(if ($gate.State -ceq 'EXHAUSTED') { 'NO_NEW_LAUNCH_ACCOUNT_STOP' } else { 'PREPARE_OR_REFRESH' }); Reason = "LAUNCH_GATE:$($gate.State):$($gate.Reason)" }
    }
    $packet = Get-SjoPacketStatus $Entry $at
    if ($packet -cne 'READY') { return [pscustomobject]@{ Next = 'PREPARE_OR_REFRESH'; Reason = "LAUNCH_GATE:$packet" } }
    $null
}

# Returns $true when the launch consumed its reservation. A launcher refusal before the consume leaves the
# reservation uncertain-but-unconsumed; a stale-version loss is the only case retried within one step.
function Invoke-SjoLaunch($Ctx, $Job, [string]$ReservationId, $Entry, $Slot) {
    $id = [string]$Job['jobId']
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        # A block here launches nothing: an existing reservation stays safely unconsumed (uncertain), never reset or reissued.
        $block = Get-SjoLaunchBlock $Ctx $Entry
        if ($null -ne $block) { $Slot.Next = $block.Next; $Slot.Reasons.Add($block.Reason); return $false }
        $Ctx.Attempts[$id] = 1 + [int]$Ctx.Attempts[$id]
        $version = [long](Get-SjoSnapshot $Ctx.IndexPath).Queue['version']
        $child = Start-SjoLauncher $Ctx $Job $ReservationId $version $Entry
        $Ctx.Launched.Add([ordered]@{ jobId = $id; reservationId = $ReservationId; launcherPid = $child.Process.Id })
        if (Wait-SjoConsumption $Ctx $id $child) { return $true }
        Complete-SjoChildren
        $errText = if ([IO.File]::Exists($child.ErrPath)) { [IO.File]::ReadAllText($child.ErrPath) } else { '' }
        if ($errText -cnotmatch 'VERSION_CONFLICT') { break }
    }
    $Slot.Reasons.Add('LAUNCHER_EXITED_BEFORE_CONSUME')
    $false
}

function Get-SjoLiveProcess($Job) {
    $start = $Job['start']
    if (($start -isnot [System.Collections.IDictionary]) -or $null -eq $start['pid']) { return $null }
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$start['pid'])
        if ($process.HasExited) { $process.Dispose(); return $null }
        $delta = [math]::Abs(([DateTimeOffset]$process.StartTime - (ConvertTo-SjqUtc ([string]$start['startUtc']) 'startUtc')).TotalSeconds)
        if ($delta -gt 2) { $process.Dispose(); return $null }
        $process
    }
    catch { $null }
}

function Select-SjoReviewerTarget($Targets, [string]$Owner, $Job) {
    foreach ($target in @($Targets)) {
        if ($target -is [string] -and $target -cmatch $script:SjqNonrootPattern -and $target -cne $Owner -and $target -cne $script:SjqOwnerIdentity -and $target -cne [string]$Job['plan']['sessionId']) { return $target }
    }
    $null
}

# ---------- review / diagnosis handoff stage ----------

# Persists the intent BEFORE any tool call and returns an action only from the call that persisted it. Returns
# $true when an index event was applied. $Purpose is SOURCE_REVIEW or FAILURE_DIAGNOSIS (same correlated contract).
function Invoke-SjoHandoffStage($Ctx, $Job, $Slot, [string]$NowText, $Actions, [string]$Purpose) {
    $id = [string]$Job['jobId']
    $review = $Job['review']
    $diagnosis = $Purpose -ceq 'FAILURE_DIAGNOSIS'
    $waiting = if ($diagnosis) { 'AWAIT_INDEPENDENT_DIAGNOSIS' } else { 'AWAIT_INDEPENDENT_REVIEW' }
    if ($null -ne $review -and $null -ne $review['intent']) {
        if ($null -eq $review['handoff']) {
            # The send opportunity belongs only to the call that persisted the intent; no blind resend.
            $Slot.Next = 'RECONCILE_HANDOFF_EVIDENCE'; $Slot.Reasons.Add('HANDOFF_UNCERTAIN_NO_ACK')
        }
        else {
            $Slot.Next = $waiting
            $Slot.Reasons.Add($(if ($review['handoff']['mock'] -eq $true) { "${waiting}:HANDOFF_MOCK_NOT_LIVE" } else { $waiting }))
        }
        return $false
    }
    $target = Select-SjoReviewerTarget $Ctx.ReviewerTargets $Ctx.Owner $Job
    if ($null -eq $target) { $Slot.Next = 'REVIEWER_UNAVAILABLE'; $Slot.Reasons.Add('REVIEWER_UNAVAILABLE'); return $false }
    $intentId = 'intent-' + (Get-SjoSha ([Text.Encoding]::UTF8.GetBytes("$id`n$($Job['terminal']['ref']['sha256'])"))).Substring(0, 32)
    $intent = [ordered]@{
        schema = 'SourceJobReviewIntent/v1'; intentId = $intentId; jobId = $id; taskId = [string]$Job['plan']['taskId']
        planRef = $Job['plan']['ref']; admissionRef = $Job['admission']['ref']; terminalRef = $Job['terminal']['ref']
        candidatePins = (Get-SjqTerminalPins $Job); sourceHead = $null; owner = $Ctx.Owner; reviewerTarget = $target; createdUtc = $NowText
    }
    $intentRef = Write-SjoImmutableJson (Join-Path (Join-Path $Ctx.EvidenceRoot 'intents') "$intentId.json") $intent -ReuseExisting
    $event = [ordered]@{ schema = 'SourceJobQueueEvent/v1'; eventId = "evt-$intentId"; type = 'REVIEW_INTENT'; jobId = $id; intentRef = $intentRef }
    $result = Submit-SjoSafe $Ctx.IndexPath $event $Ctx.EvidenceRoot $NowText
    if ($result.Applied) {
        $Slot.Next = $(if ($diagnosis) { 'SEND_FAILURE_DIAGNOSIS_HANDOFF' } else { 'SEND_REVIEW_HANDOFF' })
        $Slot.Reasons.Add('HANDOFF_SEND_REQUIRED')
        $Actions.Add([pscustomobject]@{
                Type = $Slot.Next; Purpose = $Purpose; JobId = $id; IntentId = $intentId; IntentRef = $intentRef; ReviewerTarget = $target; Owner = $Ctx.Owner
                Tool = 'collaboration.followup_task'; Reentry = 'Submit-SourceJobHandoffResult then Invoke-SourceJobOwnerStep again'
                Contract = 'ACTIVE_AGENT_MUST_CALL_TOOL_THEN_Submit-SourceJobHandoffResult_WITH_SAVED_RESULT;SCHEDULING_ACK_PROVES_DISPATCH_ONLY;DIAGNOSIS_IS_NEVER_ACCEPTANCE_OR_RETRY'
            })
        return $true
    }
    if ($result.Ok) { $Slot.Next = 'RECONCILE_HANDOFF_EVIDENCE'; $Slot.Reasons.Add('HANDOFF_UNCERTAIN_NO_ACK') }
    else { $Slot.Next = 'FIX_INTENT_INPUT'; $Slot.Reasons.Add("INTENT_REFUSED:$($result.Code)") }
    $false
}

# ---------- one pass ----------

function Invoke-SjoPass($Ctx) {
    $changed = $false
    $actions = [Collections.Generic.List[object]]::new()
    $waitables = [Collections.Generic.List[object]]::new()
    $info = [ordered]@{}
    $nowText = Get-SjoNowUtc
    $at = ConvertTo-SjqUtc (Get-SjoLaunchClockUtc) 'now'
    Complete-SjoChildren
    foreach ($entry in $Ctx.Batch) {
        $info[$entry['jobId']] = @{ State = 'NOT_REGISTERED'; Next = 'REGISTER_OR_REMOVE_FROM_BATCH'; Reasons = [Collections.Generic.List[string]]::new() }
    }

    # --- reconcile evidence and drive the review handoff, per job ---
    foreach ($entry in $Ctx.Batch) {
        $id = $entry['jobId']
        $slot = $info[$id]
        $job = Get-SjoJob $Ctx.IndexPath $id
        if ($null -eq $job) { $slot.Reasons.Add('NOT_REGISTERED'); continue }
        $run = [string]$job['plan']['runDirectory']
        $state = [string]$job['state']
        $reservation = $job['reservation']
        $consumed = ($reservation -is [System.Collections.IDictionary]) -and (Test-SjqHasKey $reservation 'consumed') -and ($reservation['consumed'] -eq $true)
        $startFile = Join-Path $run 'start.json'
        $terminalFile = Join-Path $run 'terminal.json'
        $invocationFile = Join-Path $run 'invocation.json'

        if ($state -ceq 'DISPATCH_UNCERTAIN' -and $consumed -and (Test-SjoReadyFile $startFile) -and (Test-SjoReadyFile $invocationFile)) {
            $startRef = Get-SjoFileRef $startFile
            $event = [ordered]@{
                schema = 'SourceJobQueueEvent/v1'; eventId = "evt-start-$id-$($startRef['sha256'].Substring(0, 12))"; type = 'OBSERVED_START'; jobId = $id
                reservationId = [string]$reservation['reservationId']; startRef = $startRef; invocationRef = (Get-SjoFileRef $invocationFile)
            }
            $result = Submit-SjoSafe $Ctx.IndexPath $event $Ctx.EvidenceRoot $nowText
            if ($result.Applied) { $changed = $true } elseif (-not $result.Ok) { $slot.Reasons.Add("RECONCILE_REFUSED:START:$($result.Code)") }
            $job = Get-SjoJob $Ctx.IndexPath $id
            $state = [string]$job['state']
        }
        if (($state -ceq 'RUNNING' -or ($state -ceq 'DISPATCH_UNCERTAIN' -and $consumed)) -and (Test-SjoReadyFile $terminalFile) -and (Test-SjoReadyFile $invocationFile)) {
            $terminalRef = Get-SjoFileRef $terminalFile
            $event = [ordered]@{
                schema = 'SourceJobQueueEvent/v1'; eventId = "evt-term-$id-$($terminalRef['sha256'].Substring(0, 12))"; type = 'OBSERVED_TERMINAL'; jobId = $id
                terminalRef = $terminalRef; invocationRef = (Get-SjoFileRef $invocationFile)
            }
            $result = Submit-SjoSafe $Ctx.IndexPath $event $Ctx.EvidenceRoot $nowText
            if ($result.Applied) { $changed = $true } elseif (-not $result.Ok) { $slot.Reasons.Add("RECONCILE_REFUSED:TERMINAL:$($result.Code)") }
            $job = Get-SjoJob $Ctx.IndexPath $id
            $state = [string]$job['state']
        }

        $review = $job['review']
        if ($state -ceq 'DISPATCH_UNCERTAIN') {
            if ($consumed) { $slot.Next = 'AWAIT_START_EVIDENCE'; $slot.Reasons.Add('DISPATCH_UNCERTAIN_CONSUMED_NO_START_EVIDENCE_YET') }
            else { $slot.Next = 'LAUNCH'; $slot.Reasons.Add('RESERVED_NOT_CONSUMED') }
        }
        elseif ($state -ceq 'RUNNING') {
            $own = if ($script:SjoChildren.ContainsKey($id)) { $script:SjoChildren[$id].Process } else { $null }
            if ($null -ne $own -and -not $own.HasExited) { $waitables.Add(@{ Process = $own; External = $false }); $slot.Next = 'AWAIT_NATURAL_COMPLETION' }
            else {
                $live = Get-SjoLiveProcess $job
                if ($null -ne $live) { $waitables.Add(@{ Process = $live; External = $true }); $slot.Next = 'AWAIT_NATURAL_COMPLETION' }
                else {
                    # The process is gone; the launcher may still be finishing its terminal record, so settle briefly.
                    for ($i = 0; $i -lt 30 -and -not (Test-SjoReadyFile $terminalFile); $i++) { Start-Sleep -Milliseconds 100 }
                    if (Test-SjoReadyFile $terminalFile) { $changed = $true; $slot.Reasons.Add('TERMINAL_EVIDENCE_APPEARED_RECONCILE_NEXT_PASS') }
                    else { $slot.Next = 'RECONCILE_MANUALLY'; $slot.Reasons.Add('RUNNING_NO_PROCESS_NO_TERMINAL_EVIDENCE') }
                }
            }
        }
        elseif ($state -ceq 'REVIEW_REQUIRED') {
            if (Invoke-SjoHandoffStage $Ctx $job $slot $nowText $actions 'SOURCE_REVIEW') { $changed = $true }
        }
        elseif (@('FAILED', 'REFUSED', 'RECONCILIATION_REQUIRED') -ccontains $state) {
            foreach ($reason in @($job['reasons'])) { $slot.Reasons.Add("EVIDENCE:$reason") }
            if ($null -ne $review -and $null -ne $review['disposition']) { $slot.Next = 'AWAIT_RELEASE'; $slot.Reasons.Add('AWAITING_RELEASE') }
            elseif ($state -ceq 'RECONCILIATION_REQUIRED') {
                # Contradictory or incomplete evidence is reconciled explicitly; no candidate review is fabricated from it.
                $slot.Next = 'EXPLICIT_RECONCILIATION_REQUIRED'; $slot.Reasons.Add('EVIDENCE_RECONCILIATION_REQUIRED_BEFORE_DIAGNOSIS')
            }
            else {
                # The failure stays FAILED/REFUSED. A correlated independent diagnosis never accepts, retries or releases.
                if (Invoke-SjoHandoffStage $Ctx $job $slot $nowText $actions 'FAILURE_DIAGNOSIS') { $changed = $true }
                $slot.Reasons.Add('AWAITING_FAILURE_DISPOSITION')
            }
        }
        elseif ($state -ceq 'SOURCE_REJECTED' -or $state -ceq 'DELIVERED_PENDING_RELEASE') { $slot.Next = 'AWAIT_RELEASE'; $slot.Reasons.Add('AWAITING_RELEASE') }
        elseif ($state -ceq 'SOURCE_REVIEW_ACCEPTED') { $slot.Next = 'AWAIT_DELIVERY_EVIDENCE'; $slot.Reasons.Add('AWAITING_DELIVERY_EVIDENCE') }
        elseif ($script:SjoComplete -ccontains $state) { $slot.Next = 'NONE'; $slot.Reasons.Add($state) }
    }

    # --- launch eligible, disjoint, fresh-packet jobs (core owns path/dependency/expiry eligibility) ---
    $packets = @{}
    $prepared = [Collections.Generic.List[string]]::new()
    # Decided once, before any launch: a known account stop (or missing fresh evidence) gates EVERY new launch in the batch.
    $gate = Get-SjoAccountGate $Ctx.Batch $at
    $exhausted = $gate.State -ceq 'EXHAUSTED'
    foreach ($entry in $Ctx.Batch) {
        $id = $entry['jobId']
        $job = Get-SjoJob $Ctx.IndexPath $id
        if ($null -eq $job) { continue }
        $state = [string]$job['state']
        $reservation = $job['reservation']
        $unconsumed = $state -ceq 'DISPATCH_UNCERTAIN' -and -not (($reservation -is [System.Collections.IDictionary]) -and (Test-SjqHasKey $reservation 'consumed') -and ($reservation['consumed'] -eq $true))
        if ($state -cne 'SOURCE_PREPARED' -and -not $unconsumed) { continue }
        if ($gate.State -cne 'AVAILABLE') {
            $info[$id].Next = $(if ($exhausted) { 'NO_NEW_LAUNCH_ACCOUNT_STOP' } else { 'PREPARE_OR_REFRESH' })
            $info[$id].Reasons.Add("ACCOUNT_GATE:$($gate.State):$($gate.Reason)")
            continue
        }
        $packet = Get-SjoPacketStatus $entry $at
        $packets[$id] = $packet
        if ($packet -cne 'READY') { $info[$id].Next = 'PREPARE_OR_REFRESH'; $info[$id].Reasons.Add($packet); continue }
        if ($unconsumed) {
            # A reservation without a consume can only be completed by the launcher's own one-time consume.
            if ($script:SjoChildren.ContainsKey($id) -or [int]$Ctx.Attempts[$id] -ge 3) { continue }
            if (Invoke-SjoLaunch $Ctx $job ([string]$reservation['reservationId']) $entry $info[$id]) { $changed = $true; $info[$id].Reasons.Add('LAUNCHED_AWAITING_START_EVIDENCE') }
        }
        else { $prepared.Add($id) }
    }
    $entries = @{}
    foreach ($entry in $Ctx.Batch) { $entries[$entry['jobId']] = $entry }
    for ($guard = 0; $prepared.Count -gt 0 -and $guard -lt ($prepared.Count + 6); $guard++) {
        # Fresh decision before every reservation: a candidate that is no longer launchable is neither reserved nor launched.
        $stillReady = [Collections.Generic.List[string]]::new()
        foreach ($candidate in $prepared) {
            $block = Get-SjoLaunchBlock $Ctx $entries[$candidate]
            if ($null -ne $block) { $info[$candidate].Next = $block.Next; $info[$candidate].Reasons.Add($block.Reason) } else { $stillReady.Add($candidate) }
        }
        $prepared = $stillReady
        if ($prepared.Count -eq 0) { break }
        $version =[long](Get-SjoSnapshot $Ctx.IndexPath).Queue['version']
        $sorted = [Collections.Generic.List[string]]::new($prepared)
        $sorted.Sort([StringComparer]::Ordinal)
        $reservationId = 'ores-' + (Get-SjoSha ([Text.Encoding]::UTF8.GetBytes(($sorted -join "`n") + "|$version"))).Substring(0, 32)
        try { $reserved = Reserve-NextSourceJob -IndexPath $Ctx.IndexPath -ExpectedVersion $version -CandidateJobIds $prepared.ToArray() -ReservationId $reservationId -AtUtc (Get-SjoNowUtc) }
        catch {
            $code = Get-SjoCode $_.Exception
            if ($null -eq $code) { throw }
            if (@('VERSION_CONFLICT', 'LEASE_BUSY') -ccontains $code) { Start-Sleep -Milliseconds 100; continue }
            foreach ($id in $prepared) { $info[$id].Reasons.Add("RESERVE_REFUSED:$code") }
            break
        }
        if ($reserved.Status -cne 'RESERVED') { break }
        $changed = $true
        $winner = [string]$reserved.JobId
        [void]$prepared.Remove($winner)
        if (Invoke-SjoLaunch $Ctx (Get-SjoJob $Ctx.IndexPath $winner) $reservationId $entries[$winner] $info[$winner]) { $info[$winner].Reasons.Add('LAUNCHED_AWAITING_START_EVIDENCE') }
        elseif ($info[$winner].Next -ceq 'REGISTER_OR_REMOVE_FROM_BATCH') { $info[$winner].Next = 'LAUNCH' }
    }

    # --- final per-job picture (state is read back from the index) ---
    $final = (Get-SjoSnapshot $Ctx.IndexPath).Queue
    foreach ($entry in $Ctx.Batch) {
        $id = $entry['jobId']
        $slot = $info[$id]
        if (-not $final['jobs'].Contains($id)) { continue }
        $job = $final['jobs'][$id]
        $slot.State = [string]$job['state']
        if ($slot.State -ceq 'SOURCE_PREPARED') {
            foreach ($reason in (Get-SjqSkipReasons $final $job $at)) {
                if (-not $slot.Reasons.Contains($reason)) { $slot.Reasons.Add($reason) }
                if ($reason -cmatch '^REFRESH_REQUIRED:' -and $slot.Next -cne 'NO_NEW_LAUNCH_ACCOUNT_STOP') { $slot.Next = 'PREPARE_OR_REFRESH' }
            }
            if ($slot.Next -ceq 'REGISTER_OR_REMOVE_FROM_BATCH') { $slot.Next = $(if ($slot.Reasons -match '^(PATH_CONFLICT|UNRESOLVED_DEPENDENCY)') { 'BLOCKED_BY_OTHER_JOB' } else { 'WAIT_NEXT_PASS' }) }
        }
        elseif ($slot.Next -ceq 'REGISTER_OR_REMOVE_FROM_BATCH') { $slot.Next = 'WAIT_NEXT_PASS' }
    }
    foreach ($child in $script:SjoChildren.Values) {
        if (-not $child.Process.HasExited -and -not @($waitables | Where-Object { $_.Process.Id -eq $child.Process.Id })) { $waitables.Add(@{ Process = $child.Process; External = $false }) }
    }
    [pscustomobject]@{ Changed = $changed; Actions = $actions; Waitables = $waitables; Info = $info; Exhausted = $exhausted; Version = [long]$final['version'] }
}

# ---------- public step ----------

function Invoke-SourceJobOwnerStep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath,
        [Parameter(Mandatory)]$Batch,
        [Parameter(Mandatory)][string]$EvidenceRoot,
        [Parameter(Mandatory)][string]$LauncherPath,
        [Parameter(Mandatory)][string]$ExpectedLauncherSha256,
        [string[]]$ReviewerTargets = @('/root/git_delivery_audit'),
        [string]$Owner = $script:SjoDefaultOwner,
        [switch]$AwaitRunning
    )
    $ErrorActionPreference = 'Stop'
    Assert-SjqIndexPath $IndexPath
    Assert-SjqNormalizedPath $EvidenceRoot 'EvidenceRoot'
    if ($Owner -cnotmatch $script:SjqActorPattern -or $Owner -ceq '/root') { Stop-SjqRefused 'BAD_VALUE' 'Owner' }
    # The launcher is the accepted, pinned one; its bytes are hashed here and again by the OS-level run of that file.
    $null = Get-SjqPinnedBytes $LauncherPath $ExpectedLauncherSha256 'launcher'
    $normalized = ConvertTo-SjoBatch $Batch
    $queue = (Get-SjoSnapshot $IndexPath).Queue
    foreach ($entry in $normalized) {
        if ($queue['jobs'].Contains($entry['jobId']) -and $queue['jobs'][$entry['jobId']]['plan']['runDirectory'] -cne $entry['runDirectory']) { Stop-SjqRefused 'BATCH_RUN_DIRECTORY_MISMATCH' $entry['jobId'] }
    }
    $ctx = @{
        IndexPath = $IndexPath; Batch = $normalized; EvidenceRoot = $EvidenceRoot; LauncherPath = $LauncherPath; ReviewerTargets = $ReviewerTargets; Owner = $Owner
        Attempts = @{}; Launched = [Collections.Generic.List[object]]::new()
    }
    $actions = [Collections.Generic.List[object]]::new()
    while ($true) {
        $pass = Invoke-SjoPass $ctx
        foreach ($action in $pass.Actions) { $actions.Add($action) }
        if ($actions.Count -gt 0) { break }
        if ($pass.Changed) { foreach ($w in $pass.Waitables) { if ($w.External) { $w.Process.Dispose() } }; continue }
        if ($pass.Waitables.Count -gt 0 -and $AwaitRunning) {
            # Natural completion only: no timeout and no kill.
            $tasks = [Threading.Tasks.Task[]]@($pass.Waitables | ForEach-Object { $_.Process.WaitForExitAsync() })
            [void][Threading.Tasks.Task]::WaitAny($tasks)
            foreach ($w in $pass.Waitables) { if ($w.External) { $w.Process.Dispose() } }
            continue
        }
        break
    }
    foreach ($w in $pass.Waitables) { if ($w.External) { $w.Process.Dispose() } }

    $jobs = [ordered]@{}
    foreach ($id in $pass.Info.Keys) { $jobs[$id] = [ordered]@{ State = $pass.Info[$id].State; Next = $pass.Info[$id].Next; Reasons = $pass.Info[$id].Reasons.ToArray() } }
    $complete = $true
    foreach ($id in $jobs.Keys) { if ($script:SjoComplete -cnotcontains $jobs[$id].State) { $complete = $false } }
    $status = if ($complete) { 'BATCH_COMPLETE' } elseif ($actions.Count -gt 0) { 'ACTIONS_PENDING' } elseif ($pass.Waitables.Count -gt 0) { 'RUNNING' } else { 'QUIESCENT_ACTIONABLE' }
    $checkpointBody = [ordered]@{
        schema = 'SourceJobOwnerCheckpoint/v1'; owner = $Owner; status = $status; indexVersion = $pass.Version; jobs = $jobs
        note = 'OWNER_PROGRESS_RECORD_NOT_RUNTIME_AUTHORITY_NOT_FACTORY_COMPLETE'
    }
    $name = (Get-SjoSha ([Text.Encoding]::UTF8.GetBytes((ConvertTo-SjqCanonical $checkpointBody)))).Substring(0, 32)
    $checkpoint = Write-SjoImmutableJson (Join-Path (Join-Path $EvidenceRoot 'checkpoints') "$name.json") $checkpointBody -ReuseExisting
    [pscustomobject]@{
        Status = $status; Version = $pass.Version; Actions = $actions.ToArray(); Jobs = $jobs; Launched = $ctx.Launched.ToArray(); LaunchesStopped = $pass.Exhausted
        Checkpoint = $checkpoint; Note = 'MODULE_RETURN_IS_NOT_LIVE_BATCH_COMPLETION_ACTIVE_AGENT_MUST_CONSUME_ACTIONS'
    }
}
