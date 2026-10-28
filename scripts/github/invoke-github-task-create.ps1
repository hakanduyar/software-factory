#Requires -Version 7.6
<#
Fixed entrypoint for `sf github task-create` (src/cli/githubTaskCreate.ts).
Reads ONE strict JSON envelope from stdin, validates it BEFORE loading anything, then calls the
unchanged durable CREATE engine (sibling github-task-lifecycle.ps1) with the real pinned gh
transport (sibling github-cli-transport216.ps1, no ProcessRunner override) and emits ONE JSON result.

The envelope is DATA. It carries no script text, scriptblock, argv, environment or transport
selection. Exit codes: 0 = the engine returned an ordinary result (of ANY status; exit 0 never
means MAPPED, read `status`), 2 = envelope refused before anything ran, 3 = engine could not be
loaded, 4 = engine produced no single well-formed result, 5 = pinned transport refused. Failures
write one fixed code to stderr and nothing to stdout; no input, path or environment value is echoed.
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

# Returns the validated request hashtable or $null. Never throws.
function ConvertFrom-StrictEnvelope([byte[]]$Bytes) {
    $doc = $null
    try {
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
        $opts = [System.Text.Json.JsonDocumentOptions]::new()
        $opts.MaxDepth = 4
        $doc = [System.Text.Json.JsonDocument]::Parse($text, $opts)
        $top = Read-ExactObject $doc.RootElement @('eventPath', 'configuration', 'stateDir', 'ghPath', 'expectedGhSha256', 'tempRoot')
        if ($null -eq $top) { return $null }
        $c = Read-ExactObject $top['configuration'] @('repo', 'markerNamespace')
        if ($null -eq $c) { return $null }

        $ev = Get-StrictPath $top['eventPath']
        $sd = Get-StrictPath $top['stateDir']
        $gh = Get-StrictPath $top['ghPath']
        $tr = Get-StrictPath $top['tempRoot']
        $sha = Get-StrictString $top['expectedGhSha256'] 64
        $repo = Get-StrictString $c['repo'] 140
        $ns = Get-StrictString $c['markerNamespace'] 64
        if ($null -eq $ev -or $null -eq $sd -or $null -eq $gh -or $null -eq $tr -or $null -eq $sha -or $null -eq $repo -or $null -eq $ns) { return $null }
        # \z, not $: .NET '$' also matches before a trailing newline.
        if ($sha -cnotmatch '^[0-9a-f]{64}\z') { return $null }
        if ($repo -cne 'hakanduyar/software-factory' -or $ns -cne 'factory-task') { return $null }

        return @{
            eventPath     = $ev
            stateDir      = $sd
            ghPath        = $gh
            ghSha256      = $sha
            tempRoot      = $tr
            configuration = @{ repo = $repo; markerNamespace = $ns }
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
$req = ConvertFrom-StrictEnvelope $bytes
if ($null -eq $req) { Exit-Entry 2 'ENVELOPE_INVALID' }

# 2. Dot-source ONLY the two fixed sibling scripts.
try {
    . (Join-Path $PSScriptRoot 'github-task-lifecycle.ps1')
    . (Join-Path $PSScriptRoot 'github-cli-transport216.ps1')
} catch {
    Exit-Entry 3 'ENGINE_LOAD_FAILED'
}

# 3. The real pinned transport. No ProcessRunner override and no stub path exists here.
$transport = $null
try {
    $transport = New-GitHubCliLifecycleTransport216 `
        -GhPath $req.ghPath `
        -ExpectedGhSha256 $req.ghSha256 `
        -Repository $req.configuration.repo `
        -TempRoot $req.tempRoot
} catch {
    Exit-Entry 5 'TRANSPORT_REFUSED'
}

$res = $null
try {
    $res = @(Invoke-DurableGitHubTaskCreate `
            -EventPath $req.eventPath `
            -Configuration $req.configuration `
            -StateDir $req.stateDir `
            -Transport $transport)
} catch {
    Exit-Entry 4 'ENGINE_UNEXPECTED'
}

# 4. Exactly one ordinary result, forwarded field-for-field.
if ($res.Count -ne 1 -or $null -eq $res[0]) { Exit-Entry 4 'RESULT_SHAPE' }
$r = $res[0]
$names = @($r.PSObject.Properties.Name)
$base = @('status', 'code', 'taskId', 'eventKey', 'attempt', 'replay')
$hasMap = $names -ccontains 'mapping'
$expected = if ($hasMap) { $base + 'mapping' } else { $base }
if ($names.Count -ne $expected.Count) { Exit-Entry 4 'RESULT_SHAPE' }
foreach ($e in $expected) { if ($names -cnotcontains $e) { Exit-Entry 4 'RESULT_SHAPE' } }
if ($r.status -isnot [string] -or $r.code -isnot [string] -or $r.replay -isnot [bool] -or
    -not ($r.attempt -is [int] -or $r.attempt -is [long])) { Exit-Entry 4 'RESULT_SHAPE' }

$out = [ordered]@{ status = $r.status; code = $r.code; taskId = $r.taskId; eventKey = $r.eventKey; attempt = $r.attempt; replay = $r.replay }
if ($hasMap) {
    $m = $r.mapping
    $out['mapping'] = [ordered]@{ taskId = $m['taskId']; repo = $m['repo']; issueNumber = $m['issueNumber']; stableMarker = $m['stableMarker'] }
}
[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 4))
[Console]::Out.Write([string][char]10)
exit 0
