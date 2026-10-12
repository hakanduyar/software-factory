. (Join-Path $PSScriptRoot 'stream-cursor.ps1')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-OwnedFileTransportWatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [hashtable] $Transport,
        [Parameter(Mandatory = $true)] [hashtable] $State,
        [Parameter(Mandatory = $true)] [scriptblock] $OnEvent,
        [Parameter(Mandatory = $true)] [int] $ElapsedLimitMs,
        [int] $PollIntervalMs = 20,
        [int] $ExitWaitMs = 1000
    )

    if (-not ([double]::IsFinite([double]$ElapsedLimitMs)) -or $ElapsedLimitMs -le 0) {
        throw "ElapsedLimitMs must be a positive finite value."
    }
    if (-not ([double]::IsFinite([double]$PollIntervalMs)) -or $PollIntervalMs -lt 1 -or $PollIntervalMs -gt 1000) {
        throw "PollIntervalMs must be between 1 and 1000."
    }
    if (-not ([double]::IsFinite([double]$ExitWaitMs)) -or $ExitWaitMs -lt 1 -or $ExitWaitMs -gt 5000) {
        throw "ExitWaitMs must be between 1 and 5000."
    }
    foreach ($key in @('process', 'pid', 'startIdentity', 'stdoutPath', 'stderrPath')) {
        if (-not $Transport.ContainsKey($key)) {
            throw "Transport is missing required key '$key'."
        }
    }

    $proc = $Transport.process
    $expectedPid = [int]$Transport.pid
    $expectedIdentity = [string]$Transport.startIdentity
    $stdoutPath = [string]$Transport.stdoutPath
    $stderrPath = [string]$Transport.stderrPath

    function Test-OwnedProcessIdentity {
        param([System.Diagnostics.Process] $Process, [int] $ExpectedPid, [string] $ExpectedIdentity)
        try {
            if ($null -eq $Process) { return $false }
            if ($Process.Id -ne $ExpectedPid) { return $false }
            $actualIdentity = $Process.StartTime.ToUniversalTime().ToString('o')
            return ($actualIdentity -eq $ExpectedIdentity)
        } catch {
            return $false
        }
    }

    function Test-OwnedProcessLiveness {
        param([System.Diagnostics.Process] $Process)
        try {
            if ($Process.HasExited) { return 'exited' }
            return 'live'
        } catch {
            return 'unknown'
        }
    }

    if (-not (Test-OwnedProcessIdentity -Process $proc -ExpectedPid $expectedPid -ExpectedIdentity $expectedIdentity)) {
        throw "Owned process identity verification failed before watch start; refusing to watch."
    }

    $ctx = @{
        stopReason      = $null
        eventsDelivered = 0
        errors          = [System.Collections.Generic.List[string]]::new()
    }

    function Set-LatchedStop {
        param([hashtable] $Ctx, [string] $Reason, [string] $ErrorText)
        if ($null -eq $Ctx.stopReason) {
            $Ctx.stopReason = $Reason
        }
        if ($ErrorText) {
            $Ctx.errors.Add($ErrorText) | Out-Null
        }
    }

    function Invoke-DeliverEvents {
        param([hashtable] $Ctx, [object[]] $Events, [scriptblock] $Callback, [bool] $Suppress)
        foreach ($evt in $Events) {
            if ($Suppress -or $null -ne $Ctx.stopReason) { return }
            try {
                $result = & $Callback $evt
            } catch {
                Set-LatchedStop -Ctx $Ctx -Reason 'callback_error' -ErrorText 'callback threw an exception'
                return
            }
            if ($result -is [string] -and $result -eq 'continue') {
                $Ctx.eventsDelivered++
                continue
            } elseif ($result -is [string] -and $result -eq 'stop') {
                $Ctx.eventsDelivered++
                Set-LatchedStop -Ctx $Ctx -Reason 'callback_stop' -ErrorText $null
                return
            } else {
                Set-LatchedStop -Ctx $Ctx -Reason 'callback_error' -ErrorText 'callback returned invalid result'
                return
            }
        }
    }

    function Read-CursorSafe {
        param([hashtable] $Ctx, [string] $Path, [hashtable] $CursorState, [bool] $Final)
        try {
            if ($Final) {
                return Read-AppendedJsonLines -Path $Path -State $CursorState -Final
            }
            return Read-AppendedJsonLines -Path $Path -State $CursorState
        } catch {
            Set-LatchedStop -Ctx $Ctx -Reason 'stream_error' -ErrorText 'cursor read failed'
            return $null
        }
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    while ($null -eq $ctx.stopReason) {
        if ($sw.ElapsedMilliseconds -ge $ElapsedLimitMs) {
            Set-LatchedStop -Ctx $ctx -Reason 'timeout' -ErrorText $null
            break
        }

        $read = Read-CursorSafe -Ctx $ctx -Path $stdoutPath -CursorState $State -Final $false
        if ($null -eq $read) { break }
        if ($read.ContainsKey('errors') -and $read.errors) {
            foreach ($e in $read.errors) { $ctx.errors.Add([string]$e) | Out-Null }
        }
        if ($read.ContainsKey('hasError') -and $read.hasError) {
            Set-LatchedStop -Ctx $ctx -Reason 'stream_error' -ErrorText $null
            break
        }
        if ($read.events -and $read.events.Count -gt 0) {
            Invoke-DeliverEvents -Ctx $ctx -Events $read.events -Callback $OnEvent -Suppress $false
            if ($null -ne $ctx.stopReason) { break }
        }

        $liveness = Test-OwnedProcessLiveness -Process $proc
        if ($liveness -eq 'exited') { break }

        Start-Sleep -Milliseconds $PollIntervalMs
    }

    $preKillLatched = $ctx.stopReason
    if ($null -ne $preKillLatched -and $preKillLatched -in @('callback_stop', 'timeout', 'stream_error', 'callback_error')) {
        if (Test-OwnedProcessIdentity -Process $proc -ExpectedPid $expectedPid -ExpectedIdentity $expectedIdentity) {
            $liveness = Test-OwnedProcessLiveness -Process $proc
            if ($liveness -eq 'live') {
                try {
                    $proc.Kill()
                } catch {
                    $ctx.errors.Add('failed to terminate owned process') | Out-Null
                }
            }
        } else {
            $ctx.errors.Add('identity verification failed before termination; process not killed') | Out-Null
        }
    }

    $waited = 0
    while ($waited -lt $ExitWaitMs) {
        if ((Test-OwnedProcessLiveness -Process $proc) -eq 'exited') { break }
        $step = [Math]::Min($PollIntervalMs, $ExitWaitMs - $waited)
        if ($step -le 0) { break }
        Start-Sleep -Milliseconds $step
        $waited += $step
    }

    $finalLiveness = Test-OwnedProcessLiveness -Process $proc
    $exitConfirmed = $false
    $exitCode = $null

    if ($finalLiveness -eq 'exited') {
        $exitConfirmed = $true
        try {
            $exitCode = $proc.ExitCode
        } catch {
            $exitCode = $null
        }

        $suppressFinal = ($null -ne $ctx.stopReason -and $ctx.stopReason -in @('callback_stop', 'callback_error'))
        $finalRead = Read-CursorSafe -Ctx $ctx -Path $stdoutPath -CursorState $State -Final $true
        if ($null -ne $finalRead) {
            if ($finalRead.ContainsKey('errors') -and $finalRead.errors) {
                foreach ($e in $finalRead.errors) { $ctx.errors.Add([string]$e) | Out-Null }
            }
            if ($finalRead.ContainsKey('hasError') -and $finalRead.hasError) {
                Set-LatchedStop -Ctx $ctx -Reason 'stream_error' -ErrorText $null
            }
            if ($finalRead.events -and $finalRead.events.Count -gt 0) {
                Invoke-DeliverEvents -Ctx $ctx -Events $finalRead.events -Callback $OnEvent -Suppress $suppressFinal
            }
        }

        if ($null -eq $ctx.stopReason) {
            $ctx.stopReason = 'process_exit'
        }
    } else {
        $exitConfirmed = $false
        if ($null -eq $ctx.stopReason) {
            $ctx.stopReason = 'timeout'
        }
    }

    return @{
        stopReason      = $ctx.stopReason
        exitConfirmed   = $exitConfirmed
        exitCode        = $exitCode
        pid             = $expectedPid
        startIdentity   = $expectedIdentity
        eventsDelivered = $ctx.eventsDelivered
        cursorState     = $State
        errors          = $ctx.errors.ToArray()
        stderrPath      = $stderrPath
    }
}