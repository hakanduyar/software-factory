#Requires -Version 7.6
<#
Fixed entrypoint for the projected-status consumer (src/adapters/github/workItemStatusSync.ts).
Reads ONE strict JSON envelope from stdin, then calls the unchanged durable engine
(sibling sync-github-task-status.ps1) with the default transport and emits ONE JSON result.

The envelope is DATA. It carries no script text, scriptblock, argv, environment, executable or
transport selection. Exit codes: 0 = the engine returned an ordinary result (of ANY status; exit
0 never means DELIVERED, read `status`), 2 = envelope refused before anything ran, 3 = engine
could not be loaded, 4 = engine produced no single well-formed result. Failures write one fixed
code to stderr and nothing to stdout; no input, path or environment value is ever echoed.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Exit-Entry([int]$Code, [string]$Reason) {
    [Console]::Error.WriteLine($Reason)
    exit $Code
}

# Exactly $Names as ordinal keys: no extras, no case aliases, no duplicates. Returns name -> JsonElement or $null.
function Read-ExactObject([System.Text.Json.JsonElement]$El, [string[]]$Names) {
    if ($El.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { return $null }
    $found = @{}
    $count = 0
    foreach ($p in $El.EnumerateObject()) {
        $count++
        $n = [string]$p.Name
        if (($Names -cnotcontains $n) -or $found.ContainsKey($n)) { return $null }
        $found[$n] = $p.Value
    }
    if ($count -ne $Names.Count -or $found.Count -ne $Names.Count) { return $null }
    return $found
}

function Get-StrictString([System.Text.Json.JsonElement]$El, [int]$Max) {
    if ($El.ValueKind -ne [System.Text.Json.JsonValueKind]::String) { return $null }
    $s = $El.GetString()
    if ($null -eq $s -or $s.Length -eq 0 -or $s.Length -gt $Max) { return $null }
    return [string]$s
}

function Get-StrictPath([System.Text.Json.JsonElement]$El) {
    $s = Get-StrictString $El 4096
    if ($null -eq $s) { return $null }
    if ($s -cmatch '[\x00-\x1f\x7f]') { return $null }
    if (-not [System.IO.Path]::IsPathRooted($s)) { return $null }
    try { $null = [System.Text.UTF8Encoding]::new($false, $true).GetBytes($s) } catch { return $null }
    return $s
}

# Returns @{ checkpointPath; mapping; stateDir; publicStatus; nextAction } or $null. Never throws.
function ConvertFrom-StrictEnvelope([byte[]]$Bytes) {
    $doc = $null
    try {
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
        $opts = [System.Text.Json.JsonDocumentOptions]::new()
        $opts.MaxDepth = 4
        $doc = [System.Text.Json.JsonDocument]::Parse($text, $opts)
        $top = Read-ExactObject $doc.RootElement @('checkpointPath', 'mapping', 'stateDir', 'publicStatus', 'nextAction')
        if ($null -eq $top) { return $null }
        $m = Read-ExactObject $top['mapping'] @('taskId', 'repo', 'issueNumber', 'stableMarker')
        if ($null -eq $m) { return $null }

        $cp = Get-StrictPath $top['checkpointPath']
        $sd = Get-StrictPath $top['stateDir']
        $ps = Get-StrictString $top['publicStatus'] 32
        $na = Get-StrictString $top['nextAction'] 32
        $tid = Get-StrictString $m['taskId'] 128
        $repo = Get-StrictString $m['repo'] 140
        $marker = Get-StrictString $m['stableMarker'] 128
        if ($null -eq $cp -or $null -eq $sd -or $null -eq $ps -or $null -eq $na -or $null -eq $tid -or $null -eq $repo -or $null -eq $marker) { return $null }
        if (@('IN_PROGRESS', 'WAITING_FOR_REVIEW', 'BLOCKED', 'ACCEPTED_SCOPED') -cnotcontains $ps) { return $null }
        if (@('RUN_FOCUSED_CHECKS', 'INDEPENDENT_REVIEW', 'RESUME_AUTHORIZED_WORK', 'WAIT_FOR_DEPENDENCY') -cnotcontains $na) { return $null }
        # \z, not $: .NET '$' also matches before a trailing newline.
        if ($tid -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z') { return $null }
        if ($repo -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}\z') { return $null }
        if ($marker -cnotmatch '^[A-Za-z0-9._-]{1,128}\z') { return $null }

        $nEl = [System.Text.Json.JsonElement]$m['issueNumber']
        if ($nEl.ValueKind -ne [System.Text.Json.JsonValueKind]::Number) { return $null }
        if ($nEl.GetRawText() -cnotmatch '^[1-9][0-9]{0,9}\z') { return $null }
        $num = [int]0
        if (-not $nEl.TryGetInt32([ref]$num) -or $num -lt 1) { return $null }

        return @{
            checkpointPath = $cp
            stateDir       = $sd
            publicStatus   = $ps
            nextAction     = $na
            mapping        = @{ taskId = $tid; repo = $repo; issueNumber = $num; stableMarker = $marker }
        }
    } catch {
        return $null
    } finally {
        if ($null -ne $doc) { $doc.Dispose() }
    }
}

# 1. Read and validate the envelope BEFORE loading or invoking anything else.
$max = 65536
$bytes = $null
try {
    $in = [Console]::OpenStandardInput()
    $ms = [System.IO.MemoryStream]::new()
    $buf = [byte[]]::new(8192)
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $ms.Write($buf, 0, $n)
        if ($ms.Length -gt $max) { break }
    }
    $bytes = $ms.ToArray()
} catch {
    Exit-Entry 2 'ENVELOPE_UNREADABLE'
}
if ($bytes.Length -eq 0 -or $bytes.Length -gt $max) { Exit-Entry 2 'ENVELOPE_INVALID' }
$env0 = ConvertFrom-StrictEnvelope $bytes
if ($null -eq $env0) { Exit-Entry 2 'ENVELOPE_INVALID' }

# 2. Dot-source ONLY the fixed sibling engine.
try {
    . (Join-Path $PSScriptRoot 'sync-github-task-status.ps1')
} catch {
    Exit-Entry 3 'ENGINE_LOAD_FAILED'
}

# 3. The engine runs with its built-in default transport; no transport argument exists here.
$res = $null
try {
    $res = @(Invoke-DurableGitHubTaskStatusSync `
            -CheckpointPath $env0.checkpointPath `
            -Mapping $env0.mapping `
            -StateDir $env0.stateDir `
            -PublicStatus $env0.publicStatus `
            -NextAction $env0.nextAction)
} catch {
    Exit-Entry 4 'ENGINE_UNEXPECTED'
}

# 4. Exactly one ordinary result, forwarded field-for-field.
if ($res.Count -ne 1 -or $null -eq $res[0]) { Exit-Entry 4 'RESULT_SHAPE' }
$r = $res[0]
$expected = @('status', 'code', 'key', 'taskId', 'attempt', 'replay')
$names = @($r.PSObject.Properties.Name)
if ($names.Count -ne $expected.Count) { Exit-Entry 4 'RESULT_SHAPE' }
foreach ($e in $expected) { if ($names -cnotcontains $e) { Exit-Entry 4 'RESULT_SHAPE' } }
if ($r.status -isnot [string] -or $r.code -isnot [string] -or $r.replay -isnot [bool] -or
    -not ($r.attempt -is [int] -or $r.attempt -is [long])) { Exit-Entry 4 'RESULT_SHAPE' }

$out = [ordered]@{ status = $r.status; code = $r.code; key = $r.key; taskId = $r.taskId; attempt = $r.attempt; replay = $r.replay }
[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 3))
[Console]::Out.Write([string][char]10)
exit 0
