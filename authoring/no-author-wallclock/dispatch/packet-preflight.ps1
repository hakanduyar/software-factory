#Requires -Version 7.0
Set-StrictMode -Version Latest

# Read-only packet preflight gate (PacketPreflightTicket/v1 -> PacketPreflightResult/v1).
# Performs no writes, launches no provider, and never echoes file contents:
# the verdict carries only a status, a reason code, a count and a payload hash.

function Get-PfLimits {
    return @{ Ticket = 262144; Payload = 1048576; Source = 1048576; Requirements = 64; Excerpt = 4096; Id = 128; Path = 1024 }
}

function Stop-PacketPreflight {
    param([string]$Code)
    throw [System.InvalidOperationException]::new('preflight:' + $Code)
}

function Get-PfSha256 {
    param([byte[]]$Bytes)
    return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Read-PfBytes {
    param([string]$Path, [int]$Max, [string]$Code)
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains([char]0)) { Stop-PacketPreflight ($Code + '_path') }
    if (-not [System.IO.File]::Exists($Path)) { Stop-PacketPreflight ($Code + '_missing') }
    if (([System.IO.FileInfo]::new($Path)).Length -gt $Max) { Stop-PacketPreflight ($Code + '_too_large') }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -gt $Max) { Stop-PacketPreflight ($Code + '_too_large') }
    return , $bytes
}

function ConvertFrom-PfUtf8 {
    param([byte[]]$Bytes, [string]$Code)
    try {
        return [System.Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
    }
    catch {
        Stop-PacketPreflight ($Code + '_not_utf8')
    }
}

function Get-PfString {
    param($Obj, [string]$Name, [int]$Max, [string]$Code)
    $p = $Obj.PSObject.Properties[$Name]
    if ($null -eq $p -or $p.Value -isnot [string] -or $p.Value.Length -eq 0 -or $p.Value.Length -gt $Max) { Stop-PacketPreflight $Code }
    return [string]$p.Value
}

function Get-PfHex {
    param($Obj, [string]$Name, [string]$Code)
    $v = Get-PfString $Obj $Name 64 $Code
    if ($v.Length -ne 64 -or -not [regex]::IsMatch($v, '^[0-9a-fA-F]{64}$')) { Stop-PacketPreflight $Code }
    return $v.ToLowerInvariant()
}

function Resolve-PfSourcePath {
    param([string]$Root, [string]$SourcePath)
    $limits = Get-PfLimits
    if ([string]::IsNullOrWhiteSpace($SourcePath) -or $SourcePath.Length -gt $limits.Path -or $SourcePath.Contains([char]0)) { Stop-PacketPreflight 'source_path_invalid' }
    foreach ($seg in ($SourcePath.Replace([string][char]92, '/') -split '/')) {
        if ($seg -eq '..') { Stop-PacketPreflight 'path_escape' }
    }
    if ([System.IO.Path]::IsPathRooted($SourcePath)) {
        $full = [System.IO.Path]::GetFullPath($SourcePath)
    }
    else {
        $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $SourcePath))
    }
    if ($IsWindows) { $cmp = [System.StringComparison]::OrdinalIgnoreCase } else { $cmp = [System.StringComparison]::Ordinal }
    $prefix = $Root + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, $cmp)) { Stop-PacketPreflight 'path_escape' }
    $cur = $full
    while ($cur.Length -gt $Root.Length) {
        try { $attrs = [System.IO.File]::GetAttributes($cur) }
        catch { Stop-PacketPreflight 'source_missing' }
        if ($attrs.HasFlag([System.IO.FileAttributes]::ReparsePoint)) { Stop-PacketPreflight 'source_reparse' }
        $cur = [System.IO.Path]::GetDirectoryName($cur)
    }
    return $full
}

function New-PacketPreflightResult {
    param([string]$Status, [string]$Reason, [int]$Count, [string]$Sha)
    return [pscustomobject][ordered]@{
        schema           = 'PacketPreflightResult/v1'
        status           = $Status
        reason           = $Reason
        requirementCount = $Count
        payloadSha256    = $Sha
    }
}

# PacketPreflightTicket/v2 source-only example gate. The validator dependency is fixed relative to this
# file, pinned by hash, checked for reparse points and loaded from the hashed bytes (no caller-controlled path).
function Get-PfExampleValidatorText {
    $pin = 'cc5197aa83e93170f79face5a84df072e8636d90dcd8eb1cf4395ebe04c63f2f'
    $base = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..', 'control', 'continuity175'))
    $path = [System.IO.Path]::Combine($base, 'source-author-result-example321.ps1')
    $runtimeRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..')).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if ($IsWindows) { $cmp = [System.StringComparison]::OrdinalIgnoreCase } else { $cmp = [System.StringComparison]::Ordinal }
    if (-not $path.StartsWith($runtimeRoot + [System.IO.Path]::DirectorySeparatorChar, $cmp)) { Stop-PacketPreflight 'dependency_missing' }
    $cur = $path
    while ($null -ne $cur) {
        try { $attrs = [System.IO.File]::GetAttributes($cur) }
        catch { Stop-PacketPreflight 'dependency_missing' }
        if ($attrs.HasFlag([System.IO.FileAttributes]::ReparsePoint)) { Stop-PacketPreflight 'dependency_reparse' }
        $cur = [System.IO.Path]::GetDirectoryName($cur)
    }
    $bytes = Read-PfBytes -Path $path -Max 262144 -Code 'dependency'
    if ((Get-PfSha256 -Bytes $bytes) -ne $pin) { Stop-PacketPreflight 'dependency_drift' }
    return (ConvertFrom-PfUtf8 -Bytes $bytes -Code 'dependency')
}

function Test-PfSourceOnlyExample {
    param($Ticket, [string]$PacketText)
    $dp = $Ticket.PSObject.Properties['sourceOnlyExample']
    if ($null -eq $dp -or $dp.Value -isnot [pscustomobject]) { Stop-PacketPreflight 'example_descriptor' }
    $want = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($k in 'phase', 'exampleStart', 'exampleLength', 'exampleSha256', 'expectedChangedPaths') { [void]$want.Add($k) }
    $vals = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    foreach ($prop in $dp.Value.PSObject.Properties) {
        if (-not $want.Contains($prop.Name) -or $vals.ContainsKey($prop.Name)) { Stop-PacketPreflight 'example_descriptor' }
        $vals.Add($prop.Name, $prop.Value)
    }
    if ($vals.Count -ne 5) { Stop-PacketPreflight 'example_descriptor' }

    $phase = $vals['phase']
    if ($phase -isnot [string] -or -not [string]::Equals($phase, 'SOURCE_ONLY_NOT_RUN', [System.StringComparison]::Ordinal)) { Stop-PacketPreflight 'example_phase' }
    $start = $vals['exampleStart']
    $len = $vals['exampleLength']
    if (($start -isnot [int] -and $start -isnot [long]) -or ($len -isnot [int] -and $len -isnot [long])) { Stop-PacketPreflight 'example_range' }
    $s = [long]$start
    $l = [long]$len
    $total = [long]$PacketText.Length
    if ($s -lt 0 -or $l -lt 1 -or $l -gt 2048 -or $s -gt $total -or $l -gt ($total - $s)) { Stop-PacketPreflight 'example_range' }
    $sha = $vals['exampleSha256']
    if ($sha -isnot [string] -or -not [regex]::IsMatch($sha, '\A[0-9a-f]{64}\z')) { Stop-PacketPreflight 'example_hash_invalid' }
    $paths = $vals['expectedChangedPaths']
    if ($paths -isnot [object[]] -or $paths.Count -lt 1 -or $paths.Count -gt 32) { Stop-PacketPreflight 'example_paths' }
    $uniq = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($p in $paths) {
        if ($p -isnot [string] -or [string]::IsNullOrWhiteSpace($p) -or $p.Length -gt 2048 -or -not $uniq.Add($p)) { Stop-PacketPreflight 'example_paths' }
    }

    $example = $PacketText.Substring([int]$s, [int]$l)
    try { $exBytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes($example) }
    catch { Stop-PacketPreflight 'example_not_utf8' }
    if ((Get-PfSha256 -Bytes $exBytes) -ne $sha) { Stop-PacketPreflight 'example_hash_mismatch' }

    $depText = Get-PfExampleValidatorText
    . ([scriptblock]::Create($depText))
    $ok = $false
    try {
        $res = @(AssertSourceAuthorResultExample321 -ExampleJson $example -PacketText $PacketText -ExpectedChangedPaths $paths)
        $ok = ($res.Count -eq 1 -and $res[0] -is [bool] -and $res[0])
    }
    catch { $ok = $false }
    if (-not $ok) { Stop-PacketPreflight 'example_refused' }
}

function Invoke-PacketPreflight {
    param([string]$TicketPath = '', [string]$PayloadPath = '', [string]$EvidenceRoot = '')
    $count = 0
    $payloadSha = ''
    try {
        $limits = Get-PfLimits
        if ([string]::IsNullOrWhiteSpace($EvidenceRoot) -or $EvidenceRoot.Contains([char]0)) { Stop-PacketPreflight 'root_invalid' }
        $root = [System.IO.Path]::GetFullPath($EvidenceRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        if ($root.Length -lt 2 -or [regex]::IsMatch($root, '^[A-Za-z]:$')) { Stop-PacketPreflight 'root_invalid' }
        if (-not [System.IO.Directory]::Exists($root)) { Stop-PacketPreflight 'root_missing' }
        if ([System.IO.File]::GetAttributes($root).HasFlag([System.IO.FileAttributes]::ReparsePoint)) { Stop-PacketPreflight 'root_reparse' }

        $ticketBytes = Read-PfBytes -Path $TicketPath -Max $limits.Ticket -Code 'ticket'
        $ticketText = ConvertFrom-PfUtf8 -Bytes $ticketBytes -Code 'ticket'
        try { $ticket = $ticketText | ConvertFrom-Json -Depth 8 -ErrorAction Stop }
        catch { Stop-PacketPreflight 'ticket_malformed' }
        if ($ticket -isnot [pscustomobject]) { Stop-PacketPreflight 'ticket_malformed' }

        $schemaProp = $ticket.PSObject.Properties['schema']
        $isV2 = $false
        if ($null -eq $schemaProp -or $schemaProp.Value -isnot [string]) { Stop-PacketPreflight 'ticket_schema' }
        if ([string]::Equals($schemaProp.Value, 'PacketPreflightTicket/v2', [System.StringComparison]::Ordinal)) { $isV2 = $true }
        elseif (-not [string]::Equals($schemaProp.Value, 'PacketPreflightTicket/v1', [System.StringComparison]::Ordinal)) { Stop-PacketPreflight 'ticket_schema' }
        $wantPayloadSha = Get-PfHex $ticket 'payloadSha256' 'ticket_payload_hash_invalid'

        $reqProp = $ticket.PSObject.Properties['requirements']
        if ($null -eq $reqProp -or $reqProp.Value -isnot [array]) { Stop-PacketPreflight 'requirements_invalid' }
        $reqs = @($reqProp.Value)
        if ($reqs.Count -eq 0) { Stop-PacketPreflight 'requirements_empty' }
        if ($reqs.Count -gt $limits.Requirements) { Stop-PacketPreflight 'requirements_too_many' }

        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        $parsed = [System.Collections.Generic.List[object]]::new()
        foreach ($r in $reqs) {
            if ($r -isnot [pscustomobject]) { Stop-PacketPreflight 'requirement_invalid' }
            $id = Get-PfString $r 'id' $limits.Id 'requirement_id_invalid'
            if (-not $seen.Add($id)) { Stop-PacketPreflight 'requirement_duplicate' }
            $parsed.Add([pscustomobject]@{
                    SourcePath   = Get-PfString $r 'sourcePath' $limits.Path 'requirement_source_path_invalid'
                    SourceSha    = Get-PfHex $r 'sourceSha256' 'requirement_source_hash_invalid'
                    Excerpt      = Get-PfString $r 'excerpt' $limits.Excerpt 'requirement_excerpt_invalid'
                    ExcerptSha   = Get-PfHex $r 'excerptSha256' 'requirement_excerpt_hash_invalid'
                })
        }
        $count = $parsed.Count

        $payloadBytes = Read-PfBytes -Path $PayloadPath -Max $limits.Payload -Code 'payload'
        $payloadSha = Get-PfSha256 -Bytes $payloadBytes
        if ($payloadSha -ne $wantPayloadSha) { Stop-PacketPreflight 'payload_hash_mismatch' }
        $payloadText = ConvertFrom-PfUtf8 -Bytes $payloadBytes -Code 'payload'

        foreach ($q in $parsed) {
            $exBytes = [System.Text.Encoding]::UTF8.GetBytes($q.Excerpt)
            if ((Get-PfSha256 -Bytes $exBytes) -ne $q.ExcerptSha) { Stop-PacketPreflight 'excerpt_hash_mismatch' }
            if ($payloadText.IndexOf($q.Excerpt, [System.StringComparison]::Ordinal) -lt 0) { Stop-PacketPreflight 'excerpt_absent_payload' }
            $srcPath = Resolve-PfSourcePath -Root $root -SourcePath $q.SourcePath
            $srcBytes = Read-PfBytes -Path $srcPath -Max $limits.Source -Code 'source'
            if ((Get-PfSha256 -Bytes $srcBytes) -ne $q.SourceSha) { Stop-PacketPreflight 'source_hash_mismatch' }
            $srcText = ConvertFrom-PfUtf8 -Bytes $srcBytes -Code 'source'
            if ($srcText.IndexOf($q.Excerpt, [System.StringComparison]::Ordinal) -lt 0) { Stop-PacketPreflight 'excerpt_absent_source' }
        }
        if ($isV2) { Test-PfSourceOnlyExample -Ticket $ticket -PacketText $payloadText }
    }
    catch {
        $m = $_.Exception.Message
        if ($m.Length -le 64 -and [regex]::IsMatch($m, '^preflight:[a-z_]{1,48}$')) { $reason = $m.Substring(10) }
        else { $reason = 'unexpected_error' }
        return New-PacketPreflightResult -Status 'REFUSED' -Reason $reason -Count $count -Sha $payloadSha
    }
    return New-PacketPreflightResult -Status 'PASS' -Reason 'ok' -Count $count -Sha $payloadSha
}
