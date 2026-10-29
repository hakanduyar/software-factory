#Requires -Version 7.5
# SOURCE-ONLY supervised source job launcher, integrated with the source job queue core.
#
# Derived from the C2 source-only execution path; the guards, the single native process, the
# streaming raw capture and the natural wait are unchanged. What is new is that the launch is
# bound to one queue reservation: after every guard has passed, and immediately before the
# process is created, Consume-SourceJobReservation durably records the one-time consumption.
# NEWLY_CONSUMED is launch permission only inside that same call. Any other outcome (replay,
# conflict, refusal) launches nothing. Consumption is never undone, retried or reused: if
# anything fails after it, the reservation stays DISPATCH_UNCERTAIN (or an authenticated
# not-started terminal record is written) and a human or the owner reconciles it.
#
# The queue lease is held only inside the core call, never while the author runs. This launcher
# does not submit observed-start/terminal events, review, deliver or accept anything; the run
# directory (invocation/start/terminal/raw files) is the evidence for the existing event APIs.
# It grants no Factory claim, operational receipt, continuity or successor authority.
#
# There is no author wallclock, output, token or turn cap and no automatic process kill.
# The only time bound is the prelaunch admission expiry.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$IndexPath,
    [Parameter(Mandatory)][long]$ExpectedVersion,
    [Parameter(Mandatory)][string]$JobId,
    [Parameter(Mandatory)][string]$ReservationId,
    [Parameter(Mandatory)][string]$PlanPath,
    [Parameter(Mandatory)][string]$ExpectedPlanSha256,
    [Parameter(Mandatory)][string]$AdmissionPath,
    [Parameter(Mandatory)][string]$ExpectedAdmissionSha256,
    [Parameter(Mandatory)][string]$UsagePath,
    [Parameter(Mandatory)][string]$ExpectedUsageSha256
)
Set-StrictMode -Version Latest
$script:SsjOperatorPath = $PSCommandPath

function Get-SsjSha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Assert-SsjPin([string]$Path, [string]$Sha256) {
    if ($Sha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-SsjSha $Path) -cne $Sha256) { throw 'PIN_DRIFT' }
}

# One read feeds both the hash and the text, so a pinned file cannot change between check and use.
function Get-SsjPinnedText([string]$Path, [string]$Sha256) {
    if ($Sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'PIN_DRIFT' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $Sha256) { throw 'PIN_DRIFT' }
    [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
}

function Read-SsjPinnedJson([string]$Path, [string]$Sha256, [switch]$AsHashtable) {
    $text = Get-SsjPinnedText $Path $Sha256
    if ($AsHashtable) { ConvertFrom-Json -InputObject $text -AsHashtable -Depth 100 -DateKind String }
    else { ConvertFrom-Json -InputObject $text -Depth 100 -DateKind String }
}

function Assert-SsjOrdinary([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'CANONICAL_PATH' }
    $walk = $Path
    while ($walk) {
        if ((Test-Path -LiteralPath $walk) -and ([IO.File]::GetAttributes($walk)).HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'REPARSE' }
        $walk = [IO.Path]::GetDirectoryName($walk)
    }
}

function Save-SsjJson([string]$Path, $Value) {
    $file = [IO.File]::Open($Path, 'CreateNew', 'Write', 'None')
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 100))
        $file.Write($bytes)
        $file.Flush($true)
    }
    finally { $file.Dispose() }
}

# ---------- dependency boundaries ----------
# Only a harness that dot-sources this file can replace these; the public parameters expose no seam.

function Assert-SsjNativeSignature([string]$Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Anthropic') { throw 'NATIVE_IDENTITY' }
}

function Get-SsjClaudeCommandSource { @(Get-Command claude -CommandType ExternalScript)[0].Source }

# Fresh receipt validation plus the 100% included-week exhaustion refusal; Assert-HGReceipt comes from the pinned validator.
function Assert-SsjUsage($Usage) {
    $null = Assert-HGReceipt $Usage ([DateTimeOffset]::UtcNow)
    if ($Usage.accountUsage.weekAllModelsUsedPercent -ge 100) { throw 'INCLUDED_WEEK_EXHAUSTED' }
}

# Run files are CreateNew only: an existing run directory or file is never reused.
function Open-SsjRunFiles([string]$RunDirectory) {
    if ([IO.Directory]::Exists($RunDirectory) -or [IO.File]::Exists($RunDirectory)) { throw 'RUN_EXISTS_NO_RETRY' }
    [void][IO.Directory]::CreateDirectory($RunDirectory)
    $lock = [IO.File]::Open((Join-Path $RunDirectory 'run.lock'), 'CreateNew', 'ReadWrite', 'None')
    $out = [IO.File]::Open((Join-Path $RunDirectory 'stdout.bin'), 'CreateNew', 'Write', 'Read')
    $err = [IO.File]::Open((Join-Path $RunDirectory 'stderr.bin'), 'CreateNew', 'Write', 'Read')
    [pscustomobject]@{ Lock = $lock; Out = $out; Err = $err }
}

function Invoke-SsjMain {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath,
        [Parameter(Mandatory)][long]$ExpectedVersion,
        [Parameter(Mandatory)][string]$JobId,
        [Parameter(Mandatory)][string]$ReservationId,
        [Parameter(Mandatory)][string]$PlanPath,
        [Parameter(Mandatory)][string]$ExpectedPlanSha256,
        [Parameter(Mandatory)][string]$AdmissionPath,
        [Parameter(Mandatory)][string]$ExpectedAdmissionSha256,
        [Parameter(Mandatory)][string]$UsagePath,
        [Parameter(Mandatory)][string]$ExpectedUsageSha256
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest

    # ----- original guards, applied before any consumption -----
    $p = Read-SsjPinnedJson $PlanPath $ExpectedPlanSha256
    $a = Read-SsjPinnedJson $AdmissionPath $ExpectedAdmissionSha256
    $usage = Read-SsjPinnedJson $UsagePath $ExpectedUsageSha256 -AsHashtable
    $operatorSha = Get-SsjSha $script:SsjOperatorPath
    if ($p.schema -cne 'SupervisedCodeSourceOnlyTask/v1' -or $a.decision -cne 'ADMIT_SOURCE_ONLY_ONCE' -or $a.planSha256 -cne $ExpectedPlanSha256 -or $a.operatorSha256 -cne $operatorSha -or $a.taskId -cne $p.taskId -or $a.maximumNativeProcesses -ne 1 -or $a.reviewer -ceq '/root/bounded_state_check' -or [string]::IsNullOrWhiteSpace($a.reviewer)) { throw 'EXACT_INDEPENDENT_ADMISSION' }
    $expiry = [DateTimeOffset]::Parse($a.expiresUtc)
    if ([DateTimeOffset]::UtcNow -ge $expiry -or $expiry -gt [DateTimeOffset]::Parse($p.qualificationExpiresUtc)) { throw 'PRELAUNCH_EXPIRED' }

    # The queue core is part of the admitted closure: pinned by the plan, hashed, then loaded from those exact bytes.
    $core = $p.queueCore
    Assert-SsjOrdinary $core.path
    . ([scriptblock]::Create((Get-SsjPinnedText $core.path $core.sha256)))

    foreach ($x in @($p.protectedPins) + @($p.editablePins)) { Assert-SsjOrdinary $x.path; Assert-SsjPin $x.path $x.sha256 }
    Assert-SsjOrdinary $p.runDirectory
    Assert-SsjOrdinary $p.workingDirectory
    if (Test-Path -LiteralPath $p.runDirectory) { throw 'RUN_EXISTS_NO_RETRY' }

    Assert-SsjOrdinary $p.qualificationPath
    $prov = Get-Content -LiteralPath $p.qualificationPath -Raw | ConvertFrom-Json -Depth 100 -DateKind String
    Assert-SsjOrdinary $prov.nativePath
    Assert-SsjPin $prov.nativePath $prov.nativeSha256
    Assert-SsjNativeSignature $prov.nativePath
    $inventoryPath = Join-Path (Split-Path -Parent $p.qualificationPath) 'fresh-settings-inventory.json'
    Assert-SsjOrdinary $inventoryPath
    $inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json -Depth 100 -DateKind String
    foreach ($source in $inventory.sources) {
        if ($source.status -ceq 'PRESENT_PINNED') { Assert-SsjOrdinary $source.path; Assert-SsjPin $source.path $source.sha256 }
        elseif (Test-Path -LiteralPath $source.path) { throw 'SETTINGS_ABSENCE_DRIFT' }
    }

    # The usage validator must be one of the plan's protected pins; it is loaded from its pinned bytes.
    $validator = @($p.protectedPins | Where-Object { $_.path -ceq $p.usageValidatorPath })
    if ($validator.Count -ne 1) { throw 'UNPINNED_USAGE_VALIDATOR' }
    . ([scriptblock]::Create((Get-SsjPinnedText $validator[0].path $validator[0].sha256)))
    Assert-SsjUsage $usage
    Assert-SsjPin (Get-SsjClaudeCommandSource) $usage.resolvedCommand.fileContentSha256

    foreach ($name in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', 'MAX_THINKING_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_STRUCTURED_OUTPUT_RETRIES')) {
        if ($null -ne [Environment]::GetEnvironmentVariable($name, 'Process')) { throw 'AMBIENT_OVERRIDE_OR_CAP' }
    }

    # This independently admitted source job grants no Factory claim/receipt/continuity.
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $prov.nativePath
    $psi.WorkingDirectory = $p.workingDirectory
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $psi.Environment.Clear()
    foreach ($name in $p.environmentAllowlist) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $value) { $psi.Environment[$name] = $value }
    }
    foreach ($arg in $p.arguments) { $psi.ArgumentList.Add([string]$arg) }
    $payload = [IO.File]::ReadAllText($p.payloadPath, [Text.UTF8Encoding]::new($false, $true))

    # ----- final freshness, then the one durable consumption -----
    foreach ($x in @($p.protectedPins) + @($p.editablePins)) { Assert-SsjPin $x.path $x.sha256 }
    Assert-SsjPin $core.path $core.sha256
    $usage = Read-SsjPinnedJson $UsagePath $ExpectedUsageSha256 -AsHashtable
    Assert-SsjUsage $usage
    if ([DateTimeOffset]::UtcNow -ge $expiry) { throw 'PRESTART_EXPIRED' }

    $attemptId = 'attempt-' + [guid]::NewGuid().ToString('N')
    $consumedUtc = [DateTime]::UtcNow.ToString('o')
    $consume = Consume-SourceJobReservation -IndexPath $IndexPath -ExpectedVersion $ExpectedVersion -JobId $JobId -ReservationId $ReservationId `
        -PlanPath $PlanPath -ExpectedPlanSha256 $ExpectedPlanSha256 -AdmissionPath $AdmissionPath -ExpectedAdmissionSha256 $ExpectedAdmissionSha256 `
        -TaskId $p.taskId -SessionId $p.sessionId -OperatorSha256 $operatorSha -RunDirectory $p.runDirectory -AttemptId $attemptId -ConsumedUtc $consumedUtc
    if ($consume.Status -cne 'NEWLY_CONSUMED' -or $consume.LaunchPermitted -ne $true) { throw "SSJ_REFUSED:NOT_NEWLY_CONSUMED:$($consume.Status)" }
    [ordered]@{ status = 'RESERVATION_NEWLY_CONSUMED'; jobId = $JobId; reservationId = $ReservationId; attemptId = $attemptId; indexVersion = $consume.Version } | ConvertTo-Json -Compress | Write-Output

    # ----- from here on the consumption is permanent: nothing below resets, retries or reuses it -----
    $files = Open-SsjRunFiles $p.runDirectory
    $lock = $files.Lock; $out = $files.Out; $err = $files.Err
    $child = $null; $started = $false; $start = $null; $end = $null; $exit = $null; $failure = $null; $drained = $false
    try {
        Save-SsjJson (Join-Path $p.runDirectory 'invocation.json') ([ordered]@{
                schema = 'SupervisedSourceOnlyInvocation/v1'; planSha256 = $ExpectedPlanSha256; admissionSha256 = $ExpectedAdmissionSha256; usageReceiptSha256 = $ExpectedUsageSha256
                arguments = $p.arguments; workingDirectory = $p.workingDirectory; environmentNames = @($psi.Environment.Keys); history = $p.history
                factoryClaim = $false; operationalReceipt = $false; continuityGrant = $false
                queueBinding = [ordered]@{ schema = 'SourceJobQueueBinding/v1'; jobId = $JobId; reservationId = $ReservationId; attemptId = $attemptId; consumedUtc = $consumedUtc; runDirectory = $p.runDirectory }
            })
        $child = [Diagnostics.Process]::new()
        $child.StartInfo = $psi
        if (-not $child.Start()) { throw 'PROCESS_START_FALSE' }
        $started = $true
        $start = $child.StartTime.ToUniversalTime().ToString('o')
        Save-SsjJson (Join-Path $p.runDirectory 'start.json') ([ordered]@{ schema = 'SupervisedSourceOnlyStart/v1'; pid = $child.Id; sessionId = $p.sessionId; startUtc = $start; observedUtc = [datetime]::UtcNow.ToString('o'); noFactoryClaim = $true })
        [ordered]@{ status = 'ACTUAL_SOURCE_AUTHOR_STARTED'; pid = $child.Id; sessionId = $p.sessionId; startUtc = $start; runDirectory = $p.runDirectory } | ConvertTo-Json -Compress | Write-Output
        $copyOut = $child.StandardOutput.BaseStream.CopyToAsync($out)
        $copyErr = $child.StandardError.BaseStream.CopyToAsync($err)
        $child.StandardInput.Write($payload)
        $child.StandardInput.Close()
        # Natural wait only. User cancellation remains available; real provider/error exits are preserved.
        $child.WaitForExit()
        $exit = $child.ExitCode
        $end = $child.ExitTime.ToUniversalTime().ToString('o')
        $copyOut.GetAwaiter().GetResult()
        $copyErr.GetAwaiter().GetResult()
        $drained = $true
    }
    catch {
        $failure = $_.Exception.GetType().FullName
        if ($started -and $null -ne $child -and -not $child.HasExited) {
            [ordered]@{ status = 'OWNED_PROCESS_REQUIRES_RECONCILIATION'; pid = $child.Id; runDirectory = $p.runDirectory } | ConvertTo-Json -Compress | Write-Output
            throw
        }
    }
    finally {
        if (-not $started -or ($null -ne $child -and $child.HasExited)) {
            $out.Flush($true); $err.Flush($true); $out.Dispose(); $err.Dispose()
            $post = @(foreach ($x in $p.protectedPins) { [ordered]@{ path = $x.path; unchanged = ((Get-SsjSha $x.path) -ceq $x.sha256) } })
            $stdoutPath = Join-Path $p.runDirectory 'stdout.bin'
            $stderrPath = Join-Path $p.runDirectory 'stderr.bin'
            Save-SsjJson (Join-Path $p.runDirectory 'terminal.json') ([ordered]@{
                    schema = 'SupervisedSourceOnlyTerminal/v1'; providerStarted = $started; pid = $(if ($started) { $child.Id } else { $null }); sessionId = $p.sessionId
                    startUtc = $start; endUtc = $end; exitCode = $exit; errorType = $failure; rawDrained = $drained
                    stdoutSha256 = Get-SsjSha $stdoutPath; stdoutBytes = (Get-Item -LiteralPath $stdoutPath).Length
                    stderrSha256 = Get-SsjSha $stderrPath; stderrBytes = (Get-Item -LiteralPath $stderrPath).Length
                    editableAfter = @(foreach ($x in $p.editablePins) { [ordered]@{ path = $x.path; sha256 = Get-SsjSha $x.path } })
                    protectedPostPins = $post; history = $p.history; globalUsage = 'UNKNOWN'; taskAcceptance = 'NOT_EVALUATED'
                    factoryClaim = $false; operationalCompletion = $false; successorAuthority = $false
                })
            $terminalPath = Join-Path $p.runDirectory 'terminal.json'
            [ordered]@{ status = 'ACTUAL_SOURCE_AUTHOR_TERMINAL'; exitCode = $exit; rawDrained = $drained; terminalPath = $terminalPath; terminalSha256 = Get-SsjSha $terminalPath } | ConvertTo-Json -Compress | Write-Output
            $lock.Dispose()
            if ($null -ne $child) { $child.Dispose() }
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-SsjMain -IndexPath $IndexPath -ExpectedVersion $ExpectedVersion -JobId $JobId -ReservationId $ReservationId `
        -PlanPath $PlanPath -ExpectedPlanSha256 $ExpectedPlanSha256 -AdmissionPath $AdmissionPath -ExpectedAdmissionSha256 $ExpectedAdmissionSha256 `
        -UsagePath $UsagePath -ExpectedUsageSha256 $ExpectedUsageSha256
}
