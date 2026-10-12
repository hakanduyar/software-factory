Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'file-transport.ps1')
. (Join-Path $PSScriptRoot 'file-watcher.ps1')

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "node executable not found on PATH; cannot run offline fixture tests."
}
$nodeExe = $nodeCmd.Source

$artifactsRoot = Join-Path $PSScriptRoot 'test-artifacts'
if (-not (Test-Path $artifactsRoot)) {
    New-Item -ItemType Directory -Path $artifactsRoot -Force | Out-Null
}

$groupResults = [System.Collections.Generic.List[string]]::new()

function New-TestRunDir {
    param([string] $Name)
    $dir = Join-Path $artifactsRoot ("{0}-{1}" -f $Name, [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function New-NodeFixture {
    param([string] $RunDir, [string] $ScriptBody)
    $scriptPath = Join-Path $RunDir 'fixture.js'
    [System.IO.File]::WriteAllText($scriptPath, $ScriptBody, [System.Text.UTF8Encoding]::new($false))
    return $scriptPath
}

function New-PromptFile {
    param([string] $RunDir)
    $promptPath = Join-Path $RunDir 'prompt.txt'
    [System.IO.File]::WriteAllText($promptPath, 'unused', [System.Text.UTF8Encoding]::new($false))
    return $promptPath
}

function Start-TestChild {
    param([string] $RunDir, [string] $ScriptPath, [int] $Attempt = 1)
    return Start-FileTransport -Exe $nodeExe -Arguments @($ScriptPath) -WorkingDirectory $RunDir -PromptPath (New-PromptFile -RunDir $RunDir) -RunDir $RunDir -Attempt $Attempt -RemainingOutputBudget ([int64]1048576)
}

function Test-ProcessIdentityMatches {
    param([System.Diagnostics.Process] $Process, [int] $ExpectedPid, [string] $StartIdentity)
    try {
        if ($Process.Id -ne $ExpectedPid) { return $false }
        return ($Process.StartTime.ToUniversalTime().ToString('o') -eq $StartIdentity)
    } catch {
        return $false
    }
}

function Stop-VerifiedTestChild {
    param([hashtable] $Transport, [int] $WaitMs = 1000)
    try {
        $proc = $Transport.process
        if (-not (Test-ProcessIdentityMatches -Process $proc -ExpectedPid $Transport.pid -StartIdentity $Transport.startIdentity)) {
            return
        }
        $exited = $false
        try { $exited = $proc.HasExited } catch { $exited = $false }
        if (-not $exited) {
            try { $proc.Kill() } catch { }
        }
        $waited = 0
        while ($waited -lt $WaitMs) {
            try { if ($proc.HasExited) { break } } catch { break }
            Start-Sleep -Milliseconds 20
            $waited += 20
        }
    } finally {
        if ($Transport.process) {
            try { $Transport.process.Dispose() } catch { }
        }
    }
}

function Test-ChildIsAlive {
    param([hashtable] $Transport)
    try {
        return (Test-ProcessIdentityMatches -Process $Transport.process -ExpectedPid $Transport.pid -StartIdentity $Transport.startIdentity) -and (-not $Transport.process.HasExited)
    } catch {
        return $false
    }
}

function Wait-ForFileContains {
    param([string] $Path, [string] $Needle, [int] $TimeoutMs = 3000, [int] $PollMs = 20)
    $waited = 0
    while ($waited -lt $TimeoutMs) {
        if (Test-Path $Path) {
            $content = [System.IO.File]::ReadAllText($Path)
            if ($content.Contains($Needle)) { return $true }
        }
        Start-Sleep -Milliseconds $PollMs
        $waited += $PollMs
    }
    return $false
}

