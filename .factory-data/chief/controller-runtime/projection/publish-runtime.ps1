#Requires -Version 7.6
Set-StrictMode -Version Latest
$script:ProjectorRoot = $PSScriptRoot
. (Join-Path $script:ProjectorRoot 'project-runtime.ps1')
$script:CoreDispatchRoot = Join-Path (Split-Path -Parent $script:ProjectorRoot) 'dispatch'
. (Join-Path $script:CoreDispatchRoot 'invoke-supervised.ps1')

function Publish-HomePointer {
    param([Parameter(Mandatory)][string]$VaultPath, [Parameter(Mandatory)][string]$TargetRelPath)
    $vaultFull = [System.IO.Path]::GetFullPath($VaultPath)
    $homePath = Join-Path $vaultFull 'Home.md'
    $prevPath = Join-Path $vaultFull 'Home.previous.md'
    $lockPath = Join-Path $vaultFull '.home.lock'
    foreach ($p in @($homePath, $prevPath, $lockPath)) {
        if (Test-Path -LiteralPath $p) {
            $attr = [System.IO.File]::GetAttributes($p)
            if ($attr -band [System.IO.FileAttributes]::ReparsePoint) { return }
        }
    }
    $lockStream = $null
    try {
        $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $start = '<!-- factory-runtime-home:start -->'
        $end   = '<!-- factory-runtime-home:end -->'
        $existing = ''
        $had = Test-Path -LiteralPath $homePath -PathType Leaf
        $homeEncoding = New-Object System.Text.UTF8Encoding($false)
        if ($had) {
            $strictUtf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)
            $reader = New-Object System.IO.StreamReader($homePath, $strictUtf8NoBom, $true)
            try {
                $existing = $reader.ReadToEnd()
                $homeEncoding = $reader.CurrentEncoding
            } finally {
                $reader.Dispose()
            }
        }
        $starts = @(); $pos = 0
        while (($i = $existing.IndexOf($start, $pos, [System.StringComparison]::Ordinal)) -ge 0) { $starts += $i; $pos = $i + 1 }
        $ends = @(); $pos = 0
        while (($i = $existing.IndexOf($end, $pos, [System.StringComparison]::Ordinal)) -ge 0) { $ends += $i; $pos = $i + 1 }
        if ($starts.Count -gt 1 -or $ends.Count -gt 1 -or ($starts.Count -ne $ends.Count)) { return }
        $inner = "`n- Runtime: [[$TargetRelPath]]`n"
        if ($starts.Count -eq 1) {
            if ($ends[0] -lt $starts[0]) { return }
            $prefix = $existing.Substring(0, $starts[0])
            $suffix = $existing.Substring($ends[0] + $end.Length)
            $newContent = $prefix + $start + $inner + $end + $suffix
        } else {
            $prefix = if ($had) { $existing } else { '# Home' + "`n" }
            $sep = if ($prefix.Length -gt 0 -and -not $prefix.EndsWith("`n")) { "`n" } else { '' }
            $newContent = $prefix + $sep + $start + $inner + $end
        }
        if ($had -and $newContent -eq $existing) { return }
        $tmp = Join-Path $vaultFull ('Home.md.' + [guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::WriteAllText($tmp, $newContent, $homeEncoding)
        if ($had) {
            [System.IO.File]::Replace($tmp, $homePath, $prevPath)
        } else {
            Move-Item -LiteralPath $tmp -Destination $homePath -Force
        }
    } finally {
        if ($null -ne $lockStream) { $lockStream.Dispose() }
    }
}

function Publish-RuntimeCheckpoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$State,
        [Parameter(Mandatory)][string]$CheckpointPath,
        [Parameter(Mandatory)][string]$VaultPath,
        [Parameter(Mandatory)][string]$EvidenceRoot,
        [hashtable]$LocalSyncConfig,
        [hashtable]$GitHubSyncConfig
    )
    # Optional explicit durable sinks. Both absent => exact legacy behavior. Everything is validated and
    # frozen to primitives here, before any callback or any root write.
    $optIn = $PSBoundParameters.ContainsKey('LocalSyncConfig') -or $PSBoundParameters.ContainsKey('GitHubSyncConfig')
    $hasLc = $false; $hasGh = $false; $lcState = $null
    $ghMap = $null; $ghState = $null; $ghStatus = $null; $ghAction = $null; $ghTransport = $null
    if ($optIn) {
        $bad = { [pscustomobject]@{ status = 'REFUSED'; code = 'SYNC_CONFIG_INVALID'; materialFingerprint = $null } }
        if ($PSBoundParameters.ContainsKey('LocalSyncConfig')) {
            $lc = $LocalSyncConfig
            if ($null -eq $lc -or $lc.Keys.Count -ne 1 -or -not $lc.ContainsKey('StateDir') -or $lc['StateDir'] -isnot [string] -or [string]::IsNullOrWhiteSpace($lc['StateDir'])) { return (& $bad) }
            $lcState = [string]$lc['StateDir']; $hasLc = $true
        }
        if ($PSBoundParameters.ContainsKey('GitHubSyncConfig')) {
            $g = $GitHubSyncConfig
            if ($null -eq $g) { return (& $bad) }
            $allowedKeys = @('Mapping', 'StateDir', 'PublicStatus', 'NextAction', 'Transport')
            foreach ($k in @($g.Keys)) { if ($k -isnot [string] -or $k -cnotin $allowedKeys) { return (& $bad) } }
            foreach ($k in @('Mapping', 'StateDir', 'PublicStatus', 'NextAction')) { if (-not $g.ContainsKey($k)) { return (& $bad) } }
            $m = $g['Mapping']
            if ($m -isnot [hashtable] -or $m.Keys.Count -ne 4) { return (& $bad) }
            foreach ($k in @('taskId', 'repo', 'stableMarker')) { if (-not $m.ContainsKey($k) -or $m[$k] -isnot [string]) { return (& $bad) } }
            if (-not $m.ContainsKey('issueNumber') -or ($m['issueNumber'] -isnot [int] -and $m['issueNumber'] -isnot [long])) { return (& $bad) }
            if ($m['taskId'] -notmatch '^[A-Za-z0-9._:-]{1,128}$' -or $m['repo'] -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$' -or $m['stableMarker'] -notmatch '^[A-Za-z0-9._-]{1,128}$' -or $m['issueNumber'] -lt 1 -or $m['issueNumber'] -gt 2147483647) { return (& $bad) }
            if ($g['StateDir'] -isnot [string] -or [string]::IsNullOrWhiteSpace($g['StateDir'])) { return (& $bad) }
            if ($g['PublicStatus'] -isnot [string] -or $g['PublicStatus'] -cnotin @('IN_PROGRESS', 'WAITING_FOR_REVIEW', 'BLOCKED', 'ACCEPTED_SCOPED')) { return (& $bad) }
            if ($g['NextAction'] -isnot [string] -or $g['NextAction'] -cnotin @('RUN_FOCUSED_CHECKS', 'INDEPENDENT_REVIEW', 'RESUME_AUTHORIZED_WORK', 'WAIT_FOR_DEPENDENCY')) { return (& $bad) }
            if ($g.ContainsKey('Transport') -and $null -ne $g['Transport'] -and $g['Transport'] -isnot [scriptblock]) { return (& $bad) }
            $ghMap = @{ taskId = [string]$m['taskId']; repo = [string]$m['repo']; issueNumber = [long]$m['issueNumber']; stableMarker = [string]$m['stableMarker'] }
            $ghState = [string]$g['StateDir']; $ghStatus = [string]$g['PublicStatus']; $ghAction = [string]$g['NextAction']
            if ($g.ContainsKey('Transport')) { $ghTransport = $g['Transport'] }
            $hasGh = $true
        }
    }
    $dir = Split-Path -Parent $CheckpointPath
    $hadCheckpoint = Test-Path -LiteralPath $CheckpointPath -PathType Leaf
    $tmp = Join-Path $dir ((Split-Path -Leaf $CheckpointPath) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $json = $State | ConvertTo-Json -Depth 100
    # Opt-in only: bind version and hash to THIS publisher's own serialized bytes before any root write.
    $wSha = $null; $ver = $null
    if ($optIn) {
        try {
            $ownBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
            $wSha = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($ownBytes)).Replace('-', '').ToLowerInvariant()
            $odoc = [System.Text.Json.JsonDocument]::Parse([string]$json)
            try {
                $uv = $odoc.RootElement.GetProperty('updatedAt')
                if ($uv.ValueKind -ne [System.Text.Json.JsonValueKind]::String) { throw 'version' }
                $ver = $uv.GetString()
            } finally { $odoc.Dispose() }
        } catch { return [pscustomobject]@{ status = 'REFUSED'; code = 'SYNC_VERSION_UNBOUND'; materialFingerprint = $null } }
        if ([string]::IsNullOrWhiteSpace($ver)) { return [pscustomobject]@{ status = 'REFUSED'; code = 'SYNC_VERSION_UNBOUND'; materialFingerprint = $null } }
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmp, $json, $utf8)
    if ($hadCheckpoint) {
        $prev = Join-Path $dir ((Split-Path -Leaf $CheckpointPath) + '.previous')
        [System.IO.File]::Replace($tmp, $CheckpointPath, $prev)
    } else {
        Move-Item -LiteralPath $tmp -Destination $CheckpointPath -Force
    }
    if ($optIn) {
        # Bind the actually written checkpoint bytes; each sink is independent and reported separately.
        # $wSha and $ver were bound to this publisher's own serialized bytes before the root write.
        $same = {
            try { $null -ne $wSha -and ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData([System.IO.File]::ReadAllBytes($CheckpointPath))).Replace('-', '').ToLowerInvariant() -ceq $wSha) } catch { $false }
        }
        $mkSink = {
            param([string]$St, [string]$Cd, $At, $Rp)
            [pscustomobject]@{ status = $St; code = $Cd; attempt = $At; replay = $Rp; delivered = ($St -ceq 'DELIVERED') }
        }
        $norm = {
            param($r)
            try {
                $st = ([string]$r.status); if ($st.Length -gt 40) { $st = $st.Substring(0, 40) }
                $cd = ([string]$r.code); if ($cd.Length -gt 40) { $cd = $cd.Substring(0, 40) }
                $at = $null; try { $at = [long]$r.attempt } catch { }
                $rp = $false; try { $rp = [bool]$r.replay } catch { }
                & $mkSink $st $cd $at $rp
            } catch { & $mkSink 'ERROR' 'SINK_RESULT_INVALID' $null $false }
        }
        $proj = $null
        if (-not $hasLc) {
            try {
                if (-not (& $same)) {
                    $proj = [pscustomobject]@{ status = 'ERROR'; code = 'CHECKPOINT_CHANGED'; materialFingerprint = $null }
                } else {
                    $proj = Invoke-RuntimeProjection -CheckpointPath $CheckpointPath -VaultPath $VaultPath -EvidenceRoot $EvidenceRoot
                    if (-not (& $same)) {
                        $proj = [pscustomobject]@{ status = 'ERROR'; code = 'CHECKPOINT_CHANGED'; materialFingerprint = $null }
                    } elseif ($proj.status -eq 'UPDATED' -or $proj.status -eq 'UNCHANGED') {
                        try { Publish-HomePointer -VaultPath $VaultPath -TargetRelPath 'Current Runtime' } catch { }
                    }
                }
            } catch { $proj = [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null } }
        }
        $locRes = & $mkSink 'ABSENT' 'NOT_CONFIGURED' $null $false
        if ($hasLc) {
            if ($null -eq $wSha) { $locRes = & $mkSink 'SKIPPED' 'CHECKPOINT_UNREADABLE' $null $false }
            elseif (-not (& $same)) { $locRes = & $mkSink 'SKIPPED' 'CHECKPOINT_CHANGED' $null $false }
            else {
                try {
                    . (Join-Path $PSScriptRoot 'sync-runtime-status.ps1')
                    $locRes = & $norm (Invoke-DurableRuntimeStatusSync -CheckpointPath $CheckpointPath -VaultPath $VaultPath -EvidenceRoot $EvidenceRoot -StateDir $lcState)
                    if (-not (& $same)) { $locRes = & $mkSink 'ERROR' 'CHECKPOINT_CHANGED' $locRes.attempt $false }
                    elseif ($locRes.delivered) { try { Publish-HomePointer -VaultPath $VaultPath -TargetRelPath 'Current Runtime' } catch { } }
                } catch { $locRes = & $mkSink 'ERROR' 'SINK_ERROR' $null $false }
            }
        }
        $ghRes = & $mkSink 'ABSENT' 'NOT_CONFIGURED' $null $false
        if ($hasGh) {
            if ($null -eq $wSha) { $ghRes = & $mkSink 'SKIPPED' 'CHECKPOINT_UNREADABLE' $null $false }
            elseif (-not (& $same)) { $ghRes = & $mkSink 'SKIPPED' 'CHECKPOINT_CHANGED' $null $false }
            else {
                try {
                    . (Join-Path $PSScriptRoot 'sync-github-task-status.ps1')
                    $ghArgs = @{
                        CheckpointPath = $CheckpointPath
                        Mapping = @{ taskId = $ghMap['taskId']; repo = $ghMap['repo']; issueNumber = $ghMap['issueNumber']; stableMarker = $ghMap['stableMarker'] }
                        StateDir = $ghState; PublicStatus = $ghStatus; NextAction = $ghAction
                    }
                    if ($null -ne $ghTransport) { $ghArgs['Transport'] = $ghTransport }
                    $ghRes = & $norm (Invoke-DurableGitHubTaskStatusSync @ghArgs)
                    if (-not (& $same)) { $ghRes = & $mkSink 'ERROR' 'CHECKPOINT_CHANGED' $ghRes.attempt $false }
                } catch { $ghRes = & $mkSink 'ERROR' 'SINK_ERROR' $null $false }
            }
        }
        return [pscustomobject]@{
            status = 'ROOT_WRITTEN'; materialFingerprint = $null; version = $ver; checkpointSha = $wSha
            projection = $proj; local = $locRes; github = $ghRes
        }
    }
    try {
        $projResult = Invoke-RuntimeProjection -CheckpointPath $CheckpointPath -VaultPath $VaultPath -EvidenceRoot $EvidenceRoot
        if ($projResult.status -eq 'UPDATED' -or $projResult.status -eq 'UNCHANGED') {
            try { Publish-HomePointer -VaultPath $VaultPath -TargetRelPath 'Current Runtime' } catch { }
        }
        return $projResult
    } catch {
        return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
    }
}

function Invoke-PublishedSupervisedTerminal {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$TerminalArguments,
        [Parameter(Mandatory)][string]$CheckpointPath,
        [Parameter(Mandatory)][string]$VaultPath,
        [Parameter(Mandatory)][string]$EvidenceRoot
    )
    $coreResult = Invoke-SupervisedTerminal @TerminalArguments
    try {
        if (Test-Path -LiteralPath $CheckpointPath -PathType Leaf) {
            Invoke-RuntimeProjection -CheckpointPath $CheckpointPath -VaultPath $VaultPath -EvidenceRoot $EvidenceRoot | Out-Null
        }
    } catch { }
    return $coreResult
}
