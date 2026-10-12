#Requires -Version 7.6
Set-StrictMode -Version Latest

function Invoke-DefaultGitHubTaskTransport {
    param([string]$Operation, [hashtable]$Mapping, [string]$Body)
    $n = [string]$Mapping['issueNumber']
    $repo = [string]$Mapping['repo']
    if ($Operation -ceq 'READ') {
        $out = & gh issue view $n --repo $repo --json 'number,url,state,body' 2>$null
        if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ ok = $false } }
        $j = ($out -join "`n") | ConvertFrom-Json -DateKind String
        return [pscustomobject]@{ ok = $true; number = $j.number; url = $j.url; state = $j.state; body = $j.body }
    }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $Body, [System.Text.UTF8Encoding]::new($false))
        & gh issue edit $n --repo $repo --body-file $tmp 2>$null | Out-Null
        return [pscustomobject]@{ ok = ($LASTEXITCODE -eq 0) }
    } finally {
        if ([System.IO.File]::Exists($tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-DurableGitHubTaskStatusSync {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CheckpointPath,
        [Parameter(Mandatory)][hashtable]$Mapping,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$StateDir,
        [Parameter(Mandatory)][ValidateSet('IN_PROGRESS', 'WAITING_FOR_REVIEW', 'BLOCKED', 'ACCEPTED_SCOPED')][string]$PublicStatus,
        [Parameter(Mandatory)][ValidateSet('RUN_FOCUSED_CHECKS', 'INDEPENDENT_REVIEW', 'RESUME_AUTHORIZED_WORK', 'WAIT_FOR_DEPENDENCY')][string]$NextAction,
        [scriptblock]$Transport
    )

    $script:gsKey = $null; $script:gsTask = $null; $script:gsAttempt = 0
    $mk = {
        param([string]$Status, [string]$Code, [bool]$Replay)
        [pscustomobject]@{ status = $Status; code = $Code; key = $script:gsKey; taskId = $script:gsTask; attempt = $script:gsAttempt; replay = $Replay }
    }
    $hexRx = '^[0-9a-f]{64}$'
    $cpSame = { try { (& $sha256 ([System.IO.File]::ReadAllBytes($cpFull))) -ceq $snapSha } catch { $false } }
    $sha256 = {
        param([byte[]]$b)
        [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($b)).Replace('-', '').ToLowerInvariant()
    }
    $shaStr = { param([string]$s) & $sha256 ([System.Text.Encoding]::UTF8.GetBytes($s)) }
    $parseTs = {
        param($s)
        $out = [datetimeoffset]::MinValue
        if ($s -isnot [string] -or $s.Length -lt 20 -or $s.Length -gt 40 -or -not $s.EndsWith('Z')) { return $null }
        if ([datetimeoffset]::TryParse($s, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$out)) { return $out.UtcTicks }
        return $null
    }
    $isInt = { param($v) ($v -is [int] -or $v -is [long]) }
    $keyOf = { param([string]$t, [string]$s, [string]$u, [string]$m, [string]$p) & $shaStr ($t + '|' + $s + '|' + $u + '|' + $m + '|' + $p) }

    # Strictly typed mapping.
    $mapKeys = @('taskId', 'repo', 'issueNumber', 'stableMarker')
    if ($Mapping.Keys.Count -ne 4) { return (& $mk 'REFUSED' 'MAPPING_INVALID' $false) }
    foreach ($k in $mapKeys) { if (-not $Mapping.ContainsKey($k)) { return (& $mk 'REFUSED' 'MAPPING_INVALID' $false) } }
    $mTask = $Mapping['taskId']; $mRepo = $Mapping['repo']; $mNum = $Mapping['issueNumber']; $mMarker = $Mapping['stableMarker']
    if ($mTask -isnot [string] -or $mTask -notmatch '^[A-Za-z0-9._:-]{1,128}$' -or
        $mRepo -isnot [string] -or $mRepo -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$' -or
        -not (& $isInt $mNum) -or $mNum -lt 1 -or $mNum -gt 2147483647 -or
        $mMarker -isnot [string] -or $mMarker -notmatch '^[A-Za-z0-9._-]{1,128}$') {
        return (& $mk 'REFUSED' 'MAPPING_INVALID' $false)
    }
    $script:gsTask = $mTask
    $mapDigest = & $shaStr ($mTask + '|' + $mRepo + '|' + [string]$mNum + '|' + $mMarker)
    $expectedUrl = 'https://github.com/' + $mRepo + '/issues/' + [string]$mNum

    $lock = $null
    try {
        $cpFull = [System.IO.Path]::GetFullPath($CheckpointPath)
        $stateFull = [System.IO.Path]::GetFullPath($StateDir)
        $statePath = Join-Path $stateFull 'runtime-github-sync.state.json'
        $lockPath = Join-Path $stateFull 'runtime-github-sync.lock'
        $paths = @($cpFull, $statePath, $lockPath) | ForEach-Object { [System.IO.Path]::GetFullPath($_).ToLowerInvariant() }
        if (($paths | Select-Object -Unique).Count -ne 3) { return (& $mk 'REFUSED' 'PATH_COLLISION' $false) }
        if (-not [System.IO.File]::Exists($cpFull)) { return (& $mk 'REFUSED' 'CHECKPOINT_MISSING' $false) }

        # Immutable strict-UTF8 snapshot.
        $bytes = [System.IO.File]::ReadAllBytes($cpFull)
        $snapSha = & $sha256 $bytes
        $id = $null; $upd = $null; $doc = $null
        try {
            $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
            $doc = [System.Text.Json.JsonDocument]::Parse([string]$text)
            $upd = $doc.RootElement.GetProperty('updatedAt').GetString()
            $id = $doc.RootElement.GetProperty('currentActiveWork').GetProperty('id').GetString()
        } catch { return (& $mk 'REFUSED' 'CHECKPOINT_MALFORMED' $false) } finally { if ($null -ne $doc) { $doc.Dispose() } }
        if ($id -isnot [string] -or $id -notmatch '^[A-Za-z0-9._:-]{1,128}$') { return (& $mk 'REFUSED' 'CHECKPOINT_FIELDS_INVALID' $false) }
        $ticks = & $parseTs $upd
        if ($null -eq $ticks) { return (& $mk 'REFUSED' 'CHECKPOINT_TIMESTAMP_INVALID' $false) }
        if ($id -cne $mTask) { return (& $mk 'REFUSED' 'TASK_MISMATCH' $false) }

        # Public-only payload.
        $region = "<!-- factory-task-status:start -->`nTask: $mTask`nStatus: $PublicStatus`nNext action: $NextAction`n<!-- factory-task-status:end -->"
        $payloadDigest = & $shaStr $region
        $key = & $keyOf $mTask $snapSha $upd $mapDigest $payloadDigest
        $script:gsKey = $key

        [System.IO.Directory]::CreateDirectory($stateFull) | Out-Null
        try {
            $lock = [System.IO.FileStream]::new($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch [System.IO.IOException] { return (& $mk 'LOCKED' 'LOCKED' $false) }

        # Load and fully validate persisted state.
        $state = $null
        if ([System.IO.File]::Exists($statePath)) {
            try {
                $state = [System.IO.File]::ReadAllText($statePath) | ConvertFrom-Json -AsHashtable -DateKind String
                if ($state -isnot [hashtable] -or $state.Keys.Count -ne 4) { throw 'keys' }
                foreach ($tk in @('schema', 'latestDeliveredUpdatedAt', 'latestDeliveredKey', 'versions')) { if (-not $state.ContainsKey($tk)) { throw 'keys' } }
                if (-not (& $isInt $state['schema']) -or $state['schema'] -ne 1) { throw 'schema' }
                if ($state['versions'] -isnot [hashtable]) { throw 'versions' }
                $entryKeys = @('taskId', 'updatedAt', 'snapshotSha', 'mapDigest', 'payloadDigest', 'state', 'attempts', 'errorCode', 'deliveredAt')
                $maxDelivered = $null
                foreach ($vk in @($state['versions'].Keys)) {
                    $v = $state['versions'][$vk]
                    if ($v -isnot [hashtable] -or $v.Keys.Count -ne 9) { throw 'entry' }
                    foreach ($ek in $entryKeys) { if (-not $v.ContainsKey($ek)) { throw 'entry' } }
                    if ($vk -isnot [string] -or $vk -notmatch $hexRx) { throw 'entry' }
                    if ($v['taskId'] -isnot [string] -or $v['taskId'] -notmatch '^[A-Za-z0-9._:-]{1,128}$') { throw 'entry' }
                    foreach ($hk in @('snapshotSha', 'mapDigest', 'payloadDigest')) { if ($v[$hk] -isnot [string] -or $v[$hk] -notmatch $hexRx) { throw 'entry' } }
                    if ($v['updatedAt'] -isnot [string]) { throw 'entry' }
                    $vt = & $parseTs $v['updatedAt']
                    if ($null -eq $vt) { throw 'entry' }
                    if ($v['state'] -isnot [string] -or $v['state'] -cnotin @('PENDING', 'DELIVERED')) { throw 'entry' }
                    if (-not (& $isInt $v['attempts']) -or $v['attempts'] -lt 0 -or $v['attempts'] -ge 9007199254740990) { throw 'entry' }
                    if ($null -ne $v['errorCode'] -and ($v['errorCode'] -isnot [string] -or $v['errorCode'] -notmatch '^[A-Z_]{1,40}$')) { throw 'entry' }
                    if ($null -ne $v['deliveredAt'] -and ($v['deliveredAt'] -isnot [string] -or $null -eq (& $parseTs $v['deliveredAt']))) { throw 'entry' }
                    if ($v['state'] -ceq 'DELIVERED' -and $null -eq $v['deliveredAt']) { throw 'entry' }
                    if ($vk -cne (& $keyOf $v['taskId'] $v['snapshotSha'] $v['updatedAt'] $v['mapDigest'] $v['payloadDigest'])) { throw 'entry' }
                    if ($null -ne $v['deliveredAt'] -and ($null -eq $maxDelivered -or $vt -gt $maxDelivered)) { $maxDelivered = $vt }
                }
                $lu = $state['latestDeliveredUpdatedAt']; $lk = $state['latestDeliveredKey']
                if ($null -eq $lu -and $null -eq $lk) {
                    if ($null -ne $maxDelivered) { throw 'latest' }
                } else {
                    if ($lu -isnot [string] -or $lk -isnot [string] -or -not $state['versions'].ContainsKey($lk)) { throw 'latest' }
                    $le = $state['versions'][$lk]
                    if ($null -eq $le['deliveredAt'] -or $le['updatedAt'] -cne $lu -or (& $parseTs $lu) -ne $maxDelivered) { throw 'latest' }
                }
            } catch { return (& $mk 'REFUSED' 'STATE_CORRUPT' $false) }
        } else {
            $state = @{ schema = 1; latestDeliveredUpdatedAt = $null; latestDeliveredKey = $null; versions = @{} }
        }
        $save = {
            $tmp = Join-Path $stateFull ('runtime-github-sync.' + [guid]::NewGuid().ToString('N') + '.tmp')
            try {
                [System.IO.File]::WriteAllText($tmp, ($state | ConvertTo-Json -Depth 6))
                [System.IO.File]::Move($tmp, $statePath, $true)
            } finally { if ([System.IO.File]::Exists($tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }
        }

        # Stale / ambiguous refusals leave bytes unchanged.
        if ($null -ne $state['latestDeliveredUpdatedAt'] -and $ticks -lt (& $parseTs $state['latestDeliveredUpdatedAt'])) { return (& $mk 'STALE' 'STALE' $false) }
        foreach ($vk in $state['versions'].Keys) {
            if ($vk -cne $key -and (& $parseTs $state['versions'][$vk]['updatedAt']) -eq $ticks) { return (& $mk 'REFUSED' 'AMBIGUOUS_SAME_UPDATEDAT' $false) }
        }
        $entry = $state['versions'][$key]
        if ($null -ne $entry) { $script:gsAttempt = $entry['attempts'] }

        $tp = if ($null -ne $Transport) { $Transport } else { { param($o, $m, $b) Invoke-DefaultGitHubTaskTransport -Operation $o -Mapping $m -Body $b } }
        # READ validator: returns a code and, on OK, the body.
        $readIssue = {
            try { $r = & $tp 'READ' @{ taskId = $mTask; repo = $mRepo; issueNumber = $mNum; stableMarker = $mMarker } $null } catch { return @('READ_FAILED', $null) }
            if (-not (& $cpSame)) { return @('CHECKPOINT_CHANGED', $null) }
            try {
                if ($r.ok -isnot [bool] -or -not $r.ok) { return @('READ_FAILED', $null) }
                if (-not (& $isInt $r.number) -or $r.number -ne $mNum -or $r.url -isnot [string] -or $r.url -cne $expectedUrl) { return @('DESTINATION_MISMATCH', $null) }
                if ($r.state -isnot [string] -or $r.state -cne 'OPEN') { return @('ISSUE_CLOSED', $null) }
                if ($r.body -isnot [string] -or -not $r.body.Contains($mMarker, [System.StringComparison]::Ordinal)) { return @('MARKER_MISSING', $null) }
                return @('OK', [string]$r.body)
            } catch { return @('READ_FAILED', $null) }
        }
        # Region locator: returns @(code, startIndex, endExclusive).
        $startM = '<!-- factory-task-status:start -->'; $endM = '<!-- factory-task-status:end -->'
        $locate = {
            param([string]$body)
            $s = @(); $e = @(); $i = 0
            while (($i = $body.IndexOf($startM, $i, [System.StringComparison]::Ordinal)) -ge 0) { $s += $i; $i += $startM.Length }
            $i = 0
            while (($i = $body.IndexOf($endM, $i, [System.StringComparison]::Ordinal)) -ge 0) { $e += $i; $i += $endM.Length }
            if ($s.Count -eq 0 -and $e.Count -eq 0) { return @('NONE', -1, -1) }
            if ($s.Count -ne 1 -or $e.Count -ne 1 -or $s[0] -ge $e[0]) { return @('REGION_MALFORMED', -1, -1) }
            return @('ONE', $s[0], ($e[0] + $endM.Length))
        }
        $isDesired = {
            param([string]$body)
            $loc = & $locate $body
            return ($loc[0] -ceq 'ONE' -and $body.Substring($loc[1], $loc[2] - $loc[1]) -ceq $region)
        }

        # Every attempt READs first.
        $rd = & $readIssue
        if ($rd[0] -cne 'OK') { return (& $mk 'REFUSED' $rd[0] $false) }
        $body0 = $rd[1]
        $loc = & $locate $body0
        if ($loc[0] -ceq 'REGION_MALFORMED') { return (& $mk 'REFUSED' 'REGION_MALFORMED' $false) }

        $deliver = {
            if ($null -eq $entry) {
                $entry = @{ taskId = $mTask; updatedAt = $upd; snapshotSha = $snapSha; mapDigest = $mapDigest; payloadDigest = $payloadDigest; state = 'PENDING'; attempts = 0; errorCode = $null; deliveredAt = $null }
            }
            $entry['state'] = 'DELIVERED'; $entry['errorCode'] = $null
            $entry['deliveredAt'] = [datetime]::UtcNow.ToString('o')
            $state['versions'][$key] = $entry
            $state['latestDeliveredUpdatedAt'] = $upd
            $state['latestDeliveredKey'] = $key
            & $save
        }

        if (& $isDesired $body0) {
            if (-not (& $cpSame)) { return (& $mk 'REFUSED' 'CHECKPOINT_CHANGED' $false) }
            if ($null -ne $entry -and $entry['state'] -ceq 'DELIVERED') { return (& $mk 'DELIVERED' 'REPLAY' $true) }
            & $deliver
            return (& $mk 'DELIVERED' 'RECONCILED' $false)
        }

        # Compose the new body, preserving every byte outside the managed region.
        if ($loc[0] -ceq 'ONE') {
            $newBody = $body0.Substring(0, $loc[1]) + $region + $body0.Substring($loc[2])
        } else {
            $sep = if ($body0.Length -eq 0) { '' } elseif ($body0.EndsWith("`n")) { "`n" } else { "`n`n" }
            $newBody = $body0 + $sep + $region
        }

        # Durable PENDING before WRITE.
        if ($null -eq $entry) {
            $entry = @{ taskId = $mTask; updatedAt = $upd; snapshotSha = $snapSha; mapDigest = $mapDigest; payloadDigest = $payloadDigest; state = 'PENDING'; attempts = 0; errorCode = $null; deliveredAt = $null }
        }
        $entry['state'] = 'PENDING'
        $entry['attempts'] = [long]$entry['attempts'] + 1
        $entry['errorCode'] = $null
        $state['versions'][$key] = $entry
        $script:gsAttempt = $entry['attempts']
        & $save

        $fail = {
            param([string]$Code)
            $entry['state'] = 'PENDING'; $entry['errorCode'] = $Code
            $state['versions'][$key] = $entry
            & $save
            return (& $mk 'PENDING' $Code $false)
        }

        $wr = $null
        if (-not (& $cpSame)) { return (& $fail 'CHECKPOINT_CHANGED') }
        try { $wr = & $tp 'WRITE' @{ taskId = $mTask; repo = $mRepo; issueNumber = $mNum; stableMarker = $mMarker } $newBody } catch { return (& $fail 'WRITE_FAILED') }
        try { if ($wr.ok -isnot [bool] -or -not $wr.ok) { return (& $fail 'WRITE_FAILED') } } catch { return (& $fail 'WRITE_FAILED') }

        $rb = & $readIssue
        if ($rb[0] -cne 'OK') { return (& $fail 'READBACK_FAILED') }
        if (-not (& $isDesired $rb[1])) { return (& $fail 'READBACK_MISMATCH') }

        & $deliver
        return (& $mk 'DELIVERED' 'OK' $false)
    } catch {
        return (& $mk 'REFUSED' 'UNEXPECTED_FAILURE' $false)
    } finally {
        if ($null -ne $lock) { $lock.Dispose() }
    }
}
