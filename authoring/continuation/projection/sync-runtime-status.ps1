#Requires -Version 7.6
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'project-runtime.ps1')

function Invoke-DurableRuntimeStatusSync {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CheckpointPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$VaultPath,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$EvidenceRoot,
        [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$StateDir
    )

    $script:dsKey = $null; $script:dsTask = $null; $script:dsSha = $null; $script:dsAttempt = 0
    $mk = {
        param([string]$Status, [string]$Code, [bool]$Replay)
        [pscustomobject]@{
            status = $Status; code = $Code; key = $script:dsKey; taskId = $script:dsTask
            sourceSha = $script:dsSha; attempt = $script:dsAttempt; replay = $Replay
        }
    }
    $hexRx = '^[0-9a-f]{64}$'
    $parseTs = {
        param($s)
        $out = [datetimeoffset]::MinValue
        if ($s -isnot [string] -or $s.Length -lt 20 -or $s.Length -gt 40 -or -not $s.EndsWith('Z')) { return $null }
        if ([datetimeoffset]::TryParse($s, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$out)) { return $out.UtcTicks }
        return $null
    }
    $hashFile = {
        param([string]$p)
        $b = [System.IO.File]::ReadAllBytes($p)
        [pscustomobject]@{ bytes = $b; sha = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($b)).Replace('-', '').ToLowerInvariant() }
    }
    $noteOk = {
        param([string]$p, $id, $st, $sha, [string]$cpPath)
        if (-not [System.IO.File]::Exists($p)) { return 'NOTE_MISSING' }
        $txt = [System.IO.File]::ReadAllText($p)
        $selPre = '- Selected task: `' + $id + '` status `' + $st + '` providerActive `'
        $srcLine = '- Source checkpoint: `' + $cpPath + '` sha256 `' + $sha + '`'
        $lines = $txt -split "`r?`n"
        $ms = @(); $me = @()
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -ceq '<!-- factory-runtime:start -->') { $ms += $i }
            if ($lines[$i] -ceq '<!-- factory-runtime:end -->') { $me += $i }
        }
        if ($ms.Count -ne 1 -or $me.Count -ne 1 -or $ms[0] -ge $me[0]) { return 'REGION_INVALID' }
        $selLines = @(); $srcLines = @()
        for ($i = $ms[0] + 1; $i -lt $me[0]; $i++) {
            if ($lines[$i].StartsWith('- Selected task:', [System.StringComparison]::Ordinal)) { $selLines += $lines[$i] }
            if ($lines[$i].StartsWith('- Source checkpoint:', [System.StringComparison]::Ordinal)) { $srcLines += $lines[$i] }
        }
        if ($srcLines.Count -ne 1 -or $srcLines[0] -cne $srcLine) { return 'HASH_MISMATCH' }
        if ($selLines.Count -ne 1 -or -not $selLines[0].StartsWith($selPre, [System.StringComparison]::Ordinal)) { return 'READBACK_MISMATCH' }
        return 'OK'
    }

    $lock = $null
    try {
        $cpFull = [System.IO.Path]::GetFullPath($CheckpointPath)
        $vaultFull = [System.IO.Path]::GetFullPath($VaultPath)
        $stateFull = [System.IO.Path]::GetFullPath($StateDir)
        $notePath = Join-Path $vaultFull 'Current Runtime.md'
        $statePath = Join-Path $stateFull 'runtime-status-sync.state.json'
        $lockPath = Join-Path $stateFull 'runtime-status-sync.lock'
        $paths = @($cpFull, $notePath, $statePath, $lockPath) | ForEach-Object { [System.IO.Path]::GetFullPath($_).ToLowerInvariant() }
        if (($paths | Select-Object -Unique).Count -ne 4) { return (& $mk 'REFUSED' 'PATH_COLLISION' $false) }
        if (-not [System.IO.File]::Exists($cpFull)) { return (& $mk 'REFUSED' 'CHECKPOINT_MISSING' $false) }

        # Read and validate the checkpoint before any sink delivery.
        $cp = & $hashFile $cpFull
        $doc = $null
        try { $doc = [System.Text.Json.JsonDocument]::Parse([string][System.Text.UTF8Encoding]::new($false, $true).GetString($cp.bytes)) } catch { return (& $mk 'REFUSED' 'CHECKPOINT_MALFORMED' $false) }
        $id = $null; $st = $null; $upd = $null
        try {
            $caw = $doc.RootElement.GetProperty('currentActiveWork')
            $id = $caw.GetProperty('id').GetString()
            $st = $caw.GetProperty('status').GetString()
            $upd = $doc.RootElement.GetProperty('updatedAt').GetString()
        } catch { return (& $mk 'REFUSED' 'CHECKPOINT_MALFORMED' $false) } finally { $doc.Dispose() }
        if ($id -isnot [string] -or $id -notmatch '^[A-Za-z0-9._:-]{1,128}$' -or $st -isnot [string] -or $st -notmatch '^[A-Za-z0-9_.-]{1,64}$') {
            return (& $mk 'REFUSED' 'CHECKPOINT_FIELDS_INVALID' $false)
        }
        $ticks = & $parseTs $upd
        if ($null -eq $ticks) { return (& $mk 'REFUSED' 'CHECKPOINT_TIMESTAMP_INVALID' $false) }

        $sha = $cp.sha
        $kb = [System.Text.Encoding]::UTF8.GetBytes($sha + '|' + $id + '|' + $st + '|' + $upd)
        $key = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($kb)).Replace('-', '').ToLowerInvariant()
        $script:dsKey = $key; $script:dsTask = $id; $script:dsSha = $sha

        [System.IO.Directory]::CreateDirectory($stateFull) | Out-Null
        try {
            $lock = [System.IO.FileStream]::new($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch [System.IO.IOException] { return (& $mk 'LOCKED' 'LOCKED' $false) }

        # Load state; corruption refuses without touching it.
        $state = $null
        if ([System.IO.File]::Exists($statePath)) {
            try {
                $state = [System.IO.File]::ReadAllText($statePath) | ConvertFrom-Json -AsHashtable -DateKind String
                if ($state -isnot [hashtable] -or $state['schema'] -ne 1 -or $state['versions'] -isnot [hashtable]) { throw 'shape' }
                $topKeys = @('schema', 'latestDeliveredUpdatedAt', 'latestDeliveredKey', 'versions')
                if ($state.Keys.Count -ne 4) { throw 'keys' }
                foreach ($tk in $topKeys) { if (-not $state.ContainsKey($tk)) { throw 'keys' } }
                if (($state['schema'] -isnot [int] -and $state['schema'] -isnot [long]) -or $state['schema'] -ne 1) { throw 'schema' }
                $entryKeys = @('taskId', 'status', 'sourceSha', 'updatedAt', 'state', 'attempts', 'errorCode', 'deliveredAt')
                $keyOf = {
                    param([string]$a, [string]$b, [string]$c, [string]$d)
                    [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($a + '|' + $b + '|' + $c + '|' + $d))).Replace('-', '').ToLowerInvariant()
                }
                $maxDelivered = $null
                foreach ($vk in @($state['versions'].Keys)) {
                    $v = $state['versions'][$vk]
                    if ($v -isnot [hashtable] -or $v.Keys.Count -ne 8) { throw 'entry' }
                    foreach ($ek in $entryKeys) { if (-not $v.ContainsKey($ek)) { throw 'entry' } }
                    if ($vk -isnot [string] -or $vk -notmatch $hexRx) { throw 'entry' }
                    if ($v['taskId'] -isnot [string] -or $v['taskId'] -notmatch '^[A-Za-z0-9._:-]{1,128}$') { throw 'entry' }
                    if ($v['status'] -isnot [string] -or $v['status'] -notmatch '^[A-Za-z0-9_.-]{1,64}$') { throw 'entry' }
                    if ($v['sourceSha'] -isnot [string] -or $v['sourceSha'] -notmatch $hexRx) { throw 'entry' }
                    if ($v['updatedAt'] -isnot [string]) { throw 'entry' }
                    $vt = & $parseTs $v['updatedAt']
                    if ($null -eq $vt) { throw 'entry' }
                    if ($v['state'] -isnot [string] -or $v['state'] -cnotin @('PENDING', 'DELIVERED')) { throw 'entry' }
                    if (($v['attempts'] -isnot [int] -and $v['attempts'] -isnot [long]) -or $v['attempts'] -lt 0 -or $v['attempts'] -ge 9007199254740990) { throw 'entry' }
                    if ($null -ne $v['errorCode'] -and ($v['errorCode'] -isnot [string] -or $v['errorCode'] -notmatch '^[A-Z_]{1,40}$')) { throw 'entry' }
                    if ($null -ne $v['deliveredAt'] -and ($v['deliveredAt'] -isnot [string] -or $null -eq (& $parseTs $v['deliveredAt']))) { throw 'entry' }
                    if ($v['state'] -ceq 'DELIVERED' -and $null -eq $v['deliveredAt']) { throw 'entry' }
                    if ($vk -cne (& $keyOf $v['sourceSha'] $v['taskId'] $v['status'] $v['updatedAt'])) { throw 'entry' }
                    if ($null -ne $v['deliveredAt'] -and ($null -eq $maxDelivered -or $vt -gt $maxDelivered)) { $maxDelivered = $vt }
                }
                $lu = $state['latestDeliveredUpdatedAt']; $lk = $state['latestDeliveredKey']
                if ($null -eq $lu -and $null -eq $lk) {
                    if ($null -ne $maxDelivered) { throw 'latest' }
                } else {
                    if ($lu -isnot [string] -or $lk -isnot [string] -or -not $state['versions'].ContainsKey($lk)) { throw 'latest' }
                    $le = $state['versions'][$lk]
                    if ($null -eq $le['deliveredAt'] -or $le['updatedAt'] -cne $lu -or $null -eq (& $parseTs $lu) -or (& $parseTs $lu) -ne $maxDelivered) { throw 'latest' }
                }
            } catch { return (& $mk 'REFUSED' 'STATE_CORRUPT' $false) }
        } else {
            $state = @{ schema = 1; latestDeliveredUpdatedAt = $null; latestDeliveredKey = $null; versions = @{} }
        }
        $save = {
            $tmp = Join-Path $stateFull ('runtime-status-sync.' + [guid]::NewGuid().ToString('N') + '.tmp')
            try {
                [System.IO.File]::WriteAllText($tmp, ($state | ConvertTo-Json -Depth 6))
                [System.IO.File]::Move($tmp, $statePath, $true)
            } finally { if ([System.IO.File]::Exists($tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }
        }

        # Ordering rules against the latest successfully delivered version.
        if ($null -ne $state['latestDeliveredUpdatedAt']) {
            $latest = & $parseTs $state['latestDeliveredUpdatedAt']
            if ($ticks -lt $latest) { return (& $mk 'STALE' 'STALE' $false) }
        }
        foreach ($vk in $state['versions'].Keys) {
            $v = $state['versions'][$vk]
            if ($vk -ne $key -and (& $parseTs $v['updatedAt']) -eq $ticks) { return (& $mk 'REFUSED' 'AMBIGUOUS_SAME_UPDATEDAT' $false) }
        }

        $entry = $state['versions'][$key]
        if ($null -ne $entry) { $script:dsAttempt = $entry['attempts'] }
        if ($null -ne $entry -and $entry['state'] -eq 'DELIVERED') {
            if ((& $noteOk $notePath $id $st $sha $cpFull) -eq 'OK') { return (& $mk 'DELIVERED' 'REPLAY' $true) }
        }

        # Persist PENDING before the projector is invoked.
        if ($null -eq $entry) {
            $entry = @{ taskId = $id; status = $st; updatedAt = $upd; sourceSha = $sha; state = 'PENDING'; attempts = 0; errorCode = $null; deliveredAt = $null }
        }
        $entry['state'] = 'PENDING'
        $entry['attempts'] = [long]$entry['attempts'] + 1
        $entry['errorCode'] = $null
        $state['versions'][$key] = $entry
        $script:dsAttempt = $entry['attempts']
        & $save

        $fail = {
            param([string]$Code)
            $entry['state'] = 'PENDING'; $entry['errorCode'] = $Code
            $state['versions'][$key] = $entry
            & $save
            return (& $mk 'PENDING' $Code $false)
        }

        if ((& $hashFile $cpFull).sha -ne $sha) { return (& $fail 'CHECKPOINT_CHANGED') }
        $res = $null
        try {
            $res = Invoke-RuntimeProjection -CheckpointPath $cpFull -VaultPath $vaultFull -EvidenceRoot $EvidenceRoot
        } catch { return (& $fail 'PROJECTOR_THROW') }
        $rs = $null
        try { $rs = [string]$res.status } catch { $rs = $null }
        if ($rs -notin @('UPDATED', 'UNCHANGED')) { return (& $fail 'PROJECTOR_ERROR') }
        if ((& $hashFile $cpFull).sha -ne $sha) { return (& $fail 'CHECKPOINT_CHANGED') }
        $chk = & $noteOk $notePath $id $st $sha $cpFull
        if ($chk -ne 'OK') { return (& $fail $chk) }

        $entry['state'] = 'DELIVERED'; $entry['errorCode'] = $null
        $entry['deliveredAt'] = [datetime]::UtcNow.ToString('o')
        $state['versions'][$key] = $entry
        $state['latestDeliveredUpdatedAt'] = $upd
        $state['latestDeliveredKey'] = $key
        & $save
        return (& $mk 'DELIVERED' 'OK' $false)
    } catch {
        return (& $mk 'REFUSED' 'UNEXPECTED_FAILURE' $false)
    } finally {
        if ($null -ne $lock) { $lock.Dispose() }
    }
}
