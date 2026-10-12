Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-Win32ArgvString {
    param([string[]]$ArgumentsToQuote)
    $parts = foreach ($a in $ArgumentsToQuote) {
        if ($a.Length -eq 0) { '""' }
        elseif ($a -notmatch '[\s"]') { $a }
        else {
            $sb = [System.Text.StringBuilder]::new()
            $sb.Append('"') | Out-Null
            $i = 0
            while ($i -lt $a.Length) {
                $backslashes = 0
                while ($i -lt $a.Length -and $a[$i] -eq '\') { $backslashes++; $i++ }
                if ($i -eq $a.Length) { $sb.Append('\' * ($backslashes * 2)) | Out-Null }
                elseif ($a[$i] -eq '"') { $sb.Append('\' * ($backslashes * 2 + 1)) | Out-Null; $sb.Append('"') | Out-Null; $i++ }
                else { $sb.Append('\' * $backslashes) | Out-Null; $sb.Append($a[$i]) | Out-Null; $i++ }
            }
            $sb.Append('"') | Out-Null
            $sb.ToString()
        }
    }
    return ($parts -join ' ')
}

function Start-FileTransport {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][AllowEmptyString()][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$PromptPath,
        [Parameter(Mandatory)][string]$RunDir,
        [Parameter(Mandatory)][int]$Attempt,
        [Parameter(Mandatory)][int64]$RemainingOutputBudget
    )
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw "Refusing: executable not found: $Exe" }
    if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw "Refusing: working directory not found: $WorkingDirectory" }
    if (-not (Test-Path -LiteralPath $PromptPath -PathType Leaf)) { throw "Refusing: prompt file not found: $PromptPath" }
    if (-not (Test-Path -LiteralPath $RunDir -PathType Container)) { throw "Refusing: run directory not found: $RunDir" }
    if ($Attempt -le 0) { throw 'Refusing: attempt must be positive.' }
    if ($RemainingOutputBudget -le 0) { throw 'Refusing: remaining output budget must be positive.' }

    $stdoutPath = Join-Path $RunDir "attempt-$Attempt-stdout.log"
    $stderrPath = Join-Path $RunDir "attempt-$Attempt-stderr.log"
    if (Test-Path -LiteralPath $stdoutPath) { throw "Refusing: stdout evidence path already exists: $stdoutPath" }
    if (Test-Path -LiteralPath $stderrPath) { throw "Refusing: stderr evidence path already exists: $stderrPath" }

    $commandLine = ConvertTo-Win32ArgvString -ArgumentsToQuote $Arguments
    $childEnv = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($e in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) { $childEnv[[string]$e.Key] = [string]$e.Value }
    $childEnv['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = [string]$RemainingOutputBudget

    $proc = $null
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList $commandLine -WorkingDirectory $WorkingDirectory `
            -RedirectStandardInput $PromptPath -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath `
            -Environment $childEnv -WindowStyle Hidden -PassThru
        if (-not $proc -or $proc.Id -le 0) { throw 'Refusing: process did not report an actual PID.' }
        return @{ process = $proc; pid = $proc.Id; startIdentity = $proc.StartTime.ToUniversalTime().ToString('o'); stdoutPath = $stdoutPath; stderrPath = $stderrPath }
    } catch {
        if ($proc -and -not $proc.HasExited) { try { $proc.Kill() } catch {} }
        throw
    }
}
