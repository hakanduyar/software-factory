# managed-native-receipt.ps1 - UNIT A: captured-evidence validator. Dot-source only; defines one function and executes nothing.
# Expected hashes are trusted collector assertions, not OS attestation. Writes no files, calls no collector or adapter.
function Get-ManagedNativeCapturedFacts {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ManifestPath,
        [Parameter(Mandatory)][string]$ExpectedManifestSha256,
        [Parameter(Mandatory)][string]$TerminalPath,
        [Parameter(Mandatory)][string]$ExpectedTerminalSha256,
        [Parameter(Mandatory)][string]$TicketPath,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][int]$Attempt
    )
    Set-StrictMode -Version Latest
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    try {
        $strict = [System.Text.UTF8Encoding]::new($false, $true)
        $ord = [System.StringComparison]::Ordinal
        $inv = [System.Collections.Generic.List[object]]::new()
        $smallMax = [long]1048576; $bigMax = [long]67108864; $streamCeil = [long]536870912
        $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $isHex = { param($v) ($v -is [string]) -and ($v.Length -eq 64) -and ($v -cmatch '^[0-9a-f]{64}$') }
        $hashOf = { param([byte[]]$b) [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
        $prop = {
            param($o, [string]$n)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'NOT_OBJECT' }
            $p = $o.PSObject.Properties[$n]
            if ($null -eq $p) { & $fail ('MISSING_' + $n.ToUpperInvariant()) }
            return , $p.Value
        }
        $str = { param($o, [string]$n) $v = & $prop $o $n; if ($v -isnot [string]) { & $fail ('TYPE_' + $n.ToUpperInvariant()) }; return $v }
        $hex = { param($o, [string]$n) $v = & $str $o $n; if (-not (& $isHex $v)) { & $fail ('HASH_' + $n.ToUpperInvariant()) }; return $v }
        $lng = { param($o, [string]$n) $v = & $prop $o $n; if (-not (& $isInt $v)) { & $fail ('TYPE_' + $n.ToUpperInvariant()) }; return [long]$v }
        $bool = { param($o, [string]$n) $v = & $prop $o $n; if ($v -isnot [bool]) { & $fail ('TYPE_' + $n.ToUpperInvariant()) }; return [bool]$v }
        $utc = {
            param([string]$s, [string]$c)
            if (($s.Length -gt 40) -or (-not $s.EndsWith('Z', $ord)) -or ($s -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,7})?Z$')) { & $fail $c }
            $dt = [datetime]::MinValue
            if (-not [datetime]::TryParse($s, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$dt)) { & $fail $c }
            if (($dt.Kind -ne [DateTimeKind]::Utc) -or ($dt.ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) -cne $s.Substring(0, 19))) { & $fail $c }
            return [long]$dt.Ticks
        }
        $canon = {
            param($p)
            if (($p -isnot [string]) -or ($p.Length -eq 0) -or ($p.Length -gt 1024) -or (-not [IO.Path]::IsPathRooted($p))) { & $fail 'PATH_NOT_CANONICAL' }
            $full = $null
            try { $full = [IO.Path]::GetFullPath($p) } catch { $full = $null }
            if ($full -cne $p) { & $fail 'PATH_NOT_CANONICAL' }
            $last = $p[$p.Length - 1]
            if (($last -eq [IO.Path]::DirectorySeparatorChar) -or ($last -eq [IO.Path]::AltDirectorySeparatorChar)) { & $fail 'PATH_NOT_CANONICAL' }
            if (([IO.Path]::DirectorySeparatorChar -eq [char]92) -and ($p.IndexOf([char]58, 2) -ge 0)) { & $fail 'PATH_NOT_CANONICAL' }
        }
        $chain = {
            param([string]$p)
            $q = $p
            while (($null -ne $q) -and ($q.Length -gt 0)) {
                $a = $null
                try { $a = [IO.File]::GetAttributes($q) } catch { $a = $null }
                if ($null -eq $a) { & $fail 'PATH_UNREADABLE' }
                if (($a -band [IO.FileAttributes]::ReparsePoint) -ne [IO.FileAttributes]0) { & $fail 'PATH_REPARSE' }
                $q = [IO.Path]::GetDirectoryName($q)
            }
        }
        $readLeaf = {
            param([string]$p, [long]$limit)
            & $canon $p
            & $chain $p
            $attr = $null
            try { $attr = [IO.File]::GetAttributes($p) } catch { $attr = $null }
            if ($null -eq $attr) { & $fail 'LEAF_UNREADABLE' }
            $bad = [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Device -bor [IO.FileAttributes]::ReparsePoint
            if (($attr -band $bad) -ne [IO.FileAttributes]0) { & $fail 'LEAF_NOT_ORDINARY' }
            $len = [long]-1
            try { $len = [long][IO.FileInfo]::new($p).Length } catch { $len = [long]-1 }
            if ($len -lt 0) { & $fail 'LEAF_UNREADABLE' }
            if ($len -gt $limit) { & $fail 'LEAF_TOO_LARGE' }
            $bytes = $null
            try { $bytes = [IO.File]::ReadAllBytes($p) } catch { $bytes = $null }
            if (($null -eq $bytes) -or ($bytes.Length -ne $len)) { & $fail 'LEAF_UNREADABLE' }
            return [pscustomobject]@{ Path = $p; Bytes = $bytes; Sha256 = (& $hashOf $bytes); Length = [long]$bytes.Length }
        }
        $take = {
            param([string]$role, [string]$p, [long]$limit)
            $r = & $readLeaf $p $limit
            $inv.Add([pscustomobject]@{ Role = $role; State = 'FILE'; Path = $p; Sha256 = $r.Sha256; Length = $r.Length; Limit = $limit })
            return $r
        }
        $absent = {
            param([string]$p)
            $parent = [IO.Path]::GetDirectoryName($p)
            if ($null -eq $parent) { & $fail 'ARTIFACT_PARENT_INVALID' }
            & $canon $parent
            & $chain $parent
            if (-not [IO.Directory]::Exists($parent)) { & $fail 'ARTIFACT_PARENT_INVALID' }
            if ([IO.File]::Exists($p) -or [IO.Directory]::Exists($p)) { return $false }
            return ($null -eq (Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue))
        }
        $decodeText = {
            param([string]$t, [string]$c)
            $o = $null
            try { $o = ConvertFrom-Json -InputObject $t -DateKind String -ErrorAction Stop } catch { $o = $null }
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
            return $o
        }
        $decodeBytes = {
            param([byte[]]$b, [string]$c)
            $t = $null
            try { $t = $strict.GetString($b) } catch { $t = $null }
            if ($null -eq $t) { & $fail $c }
            if (($t.Length -gt 0) -and ($t[0] -eq [char]0xFEFF)) { $t = $t.Substring(1) }
            return (& $decodeText $t $c)
        }

        if ($Attempt -le 0) { & $fail 'ATTEMPT_INVALID' }
        if ((-not (& $isHex $ExpectedManifestSha256)) -or (-not (& $isHex $ExpectedTerminalSha256))) { & $fail 'EXPECTED_HASH_INVALID' }
        & $canon $ManifestPath
        & $canon $TerminalPath
        & $canon $TicketPath
        $runDir = [IO.Path]::GetDirectoryName($ManifestPath)
        if (($null -eq $runDir) -or ($runDir -cne [IO.Path]::GetDirectoryName($TerminalPath))) { & $fail 'RUNDIR_MISMATCH' }
        & $canon $runDir
        & $chain $runDir
        if (-not [IO.Directory]::Exists($runDir)) { & $fail 'RUNDIR_MISSING' }

        $mf = & $take 'MANIFEST' $ManifestPath $smallMax
        if ($mf.Sha256 -cne $ExpectedManifestSha256) { & $fail 'MANIFEST_HASH_MISMATCH' }
        $manifest = & $decodeBytes $mf.Bytes 'MANIFEST_JSON'
        if ((& $str $manifest 'schema') -cne 'ManagedNativeCollector/v1') { & $fail 'MANIFEST_SCHEMA' }
        $canonText = & $str $manifest 'requestCanonical'
        $reqSha = & $hex $manifest 'requestSha256'
        if ((& $hashOf ($strict.GetBytes($canonText))) -cne $reqSha) { & $fail 'REQUEST_SHA_MISMATCH' }
        if ((& $str $manifest 'gateStatus') -cne 'PASS') { & $fail 'GATE_NOT_PASS' }
        $null = & $hex $manifest 'gateResultSha256'
        $null = & $utc (& $str $manifest 'reservedUtc') 'MANIFEST_RESERVED_UTC'
        $core = & $decodeText $canonText 'CORE_JSON'

        if ((& $str $core 'schema') -cne 'ManagedNativeCollector/v1') { & $fail 'CORE_SCHEMA' }
        if ((& $str $core 'runId') -cne $RunId) { & $fail 'RUNID_MISMATCH' }
        if ((& $lng $core 'attempt') -ne [long]$Attempt) { & $fail 'ATTEMPT_MISMATCH' }
        if ((& $str $core 'runDir') -cne $runDir) { & $fail 'CORE_RUNDIR_MISMATCH' }
        $null = & $str $core 'executable'
        $null = & $str $core 'workingDirectory'
        $argv = & $prop $core 'arguments'
        $maxElapsed = & $lng $core 'maxElapsedMs'
        if ($maxElapsed -le 0) { & $fail 'MAXELAPSED_INVALID' }
        $maxStream = & $lng $core 'maxStreamBytes'
        if (($maxStream -le 0) -or ($maxStream -gt $streamCeil)) { & $fail 'MAXSTREAM_INVALID' }
        $null = & $bool $core 'ackMode'
        $null = & $prop $core 'settingsApplied'
        $null = & $prop $core 'ackContext'
        $tPath = & $str $core 'ticketPath'; $tSha = & $hex $core 'ticketSha256'
        $pPath = & $str $core 'payloadPath'; $pSha = & $hex $core 'payloadSha256'
        $gPath = & $str $core 'gateTicketPath'; $gSha = & $hex $core 'gateTicketSha256'
        $sPath = & $str $core 'settingsPath'; $sSha = & $hex $core 'settingsSha256'
        $artifactPath = & $str $core 'artifactPath'
        & $canon $tPath; & $canon $pPath; & $canon $gPath; & $canon $sPath; & $canon $artifactPath
        if ($tPath -cne $TicketPath) { & $fail 'TICKET_PATH_MISMATCH' }

        $startPath = [IO.Path]::Combine($runDir, 'start.json')
        $outPath = [IO.Path]::Combine($runDir, 'stdout.bin')
        $errPath = [IO.Path]::Combine($runDir, 'stderr.bin')
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($p in @($ManifestPath, $TerminalPath, $startPath, $outPath, $errPath, $tPath, $pPath, $gPath, $sPath, $artifactPath)) {
            if (-not $seen.Add($p)) { & $fail 'PATH_COLLISION' }
        }

        $tk = & $take 'TICKET' $tPath $smallMax
        if ($tk.Sha256 -cne $tSha) { & $fail 'TICKET_HASH_MISMATCH' }
        $pl = & $take 'PAYLOAD' $pPath $bigMax
        if ($pl.Sha256 -cne $pSha) { & $fail 'PAYLOAD_HASH_MISMATCH' }
        $gt = & $take 'GATE' $gPath $bigMax
        if ($gt.Sha256 -cne $gSha) { & $fail 'GATE_HASH_MISMATCH' }
        $st = & $take 'SETTINGS' $sPath $bigMax
        if ($st.Sha256 -cne $sSha) { & $fail 'SETTINGS_HASH_MISMATCH' }

        $ticket = & $decodeBytes $tk.Bytes 'TICKET_JSON'
        $null = & $str $ticket 'id'
        $sessionId = & $str $ticket 'sessionId'
        $g = [guid]::Empty
        if (-not [guid]::TryParseExact($sessionId, 'D', [ref]$g)) { & $fail 'SESSIONID_INVALID' }
        if ((& $hex $ticket 'payloadSha256') -cne $pl.Sha256) { & $fail 'TICKET_PAYLOAD_MISMATCH' }
        if ($argv -isnot [object[]]) { & $fail 'ARGUMENTS_TYPE' }
        foreach ($a in $argv) { if ($a -isnot [string]) { & $fail 'ARGUMENTS_TYPE' } }
        $sidAt = -1; $sidN = 0; $ofN = 0; $ofOk = $false; $hasPrint = $false; $hasPartial = $false
        for ($i = 0; $i -lt $argv.Count; $i++) {
            $a = $argv[$i]
            if ($a -ceq '--session-id') { $sidN++; $sidAt = $i }
            elseif (($a -ceq '--resume') -or ($a -ceq '-r') -or ($a -ceq '--continue') -or ($a -ceq '-c') -or $a.StartsWith('--resume=', $ord) -or $a.StartsWith('--session-id=', $ord)) { & $fail 'ARGUMENTS_RESUME' }
            elseif (($a -ceq '--print') -or ($a -ceq '-p')) { $hasPrint = $true }
            elseif ($a -ceq '--include-partial-messages') { $hasPartial = $true }
            elseif ($a -ceq '--output-format') { $ofN++; if ((($i + 1) -lt $argv.Count) -and ($argv[$i + 1] -ceq 'stream-json')) { $ofOk = $true } }
            elseif ($a.StartsWith('--output-format=', $ord)) { $ofN++; if ($a -ceq '--output-format=stream-json') { $ofOk = $true } }
        }
        if (($sidN -ne 1) -or (($sidAt + 1) -ge $argv.Count) -or ($argv[$sidAt + 1] -cne $sessionId)) { & $fail 'ARGUMENTS_SESSIONID' }
        if ((-not $hasPrint) -or (-not $hasPartial) -or ($ofN -ne 1) -or (-not $ofOk)) { & $fail 'ARGUMENTS_FLAGS' }
        $bsrc = & $prop $ticket 'budget'
        if ($bsrc -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'BUDGET_NOT_OBJECT' }
        $budget = [pscustomobject]@{
            HistoricalOutputTokens = (& $lng $bsrc 'historicalOutputTokens')
            AdditionalOutputMax = (& $lng $bsrc 'additionalOutputMax')
            PhaseAggregateCeiling = (& $lng $bsrc 'phaseAggregateCeiling')
            ElapsedMs = (& $lng $bsrc 'elapsedMs')
            ContextTokens = (& $lng $bsrc 'contextTokens')
        }
        if ($budget.HistoricalOutputTokens -lt 0) { & $fail 'BUDGET_HISTORICAL' }
        if (($budget.AdditionalOutputMax -le 0) -or ($budget.PhaseAggregateCeiling -le 0) -or ($budget.ElapsedMs -le 0) -or ($budget.ContextTokens -le 0)) { & $fail 'BUDGET_INVALID' }

        $tm = & $take 'TERMINAL' $TerminalPath $smallMax
        if ($tm.Sha256 -cne $ExpectedTerminalSha256) { & $fail 'TERMINAL_HASH_MISMATCH' }
        $term = & $decodeBytes $tm.Bytes 'TERMINAL_JSON'
        if ((& $str $term 'schema') -cne 'ManagedNativeTerminal/v1') { & $fail 'TERMINAL_SCHEMA' }
        if ((& $str $term 'runId') -cne $RunId) { & $fail 'TERMINAL_RUNID' }
        if ((& $lng $term 'attempt') -ne [long]$Attempt) { & $fail 'TERMINAL_ATTEMPT' }
        if ((& $hex $term 'requestSha256') -cne $reqSha) { & $fail 'TERMINAL_REQUEST_SHA' }
        if ((& $hex $term 'manifestSha256') -cne $mf.Sha256) { & $fail 'TERMINAL_MANIFEST_SHA' }
        if ((& $hex $term 'ticketSha256') -cne $tk.Sha256) { & $fail 'TERMINAL_TICKET_SHA' }
        if ((& $hex $term 'payloadSha256') -cne $pl.Sha256) { & $fail 'TERMINAL_PAYLOAD_SHA' }
        if ((& $hex $term 'gateTicketSha256') -cne $gt.Sha256) { & $fail 'TERMINAL_GATE_SHA' }
        if ((& $hex $term 'settingsSha256') -cne $st.Sha256) { & $fail 'TERMINAL_SETTINGS_SHA' }
        $pid1 = & $lng $term 'pid'
        if ($pid1 -le 0) { & $fail 'TERMINAL_PID' }
        $startUtc = & $str $term 'startTimeUtc'
        $t0 = & $utc $startUtc 'TERMINAL_START_UTC'
        $t1 = & $utc (& $str $term 'endedUtc') 'TERMINAL_ENDED_UTC'
        if ($t1 -lt $t0) { & $fail 'TERMINAL_TIME_ORDER' }
        if ((& $str $term 'reason') -cne 'NATURAL_EXIT') { & $fail 'TERMINAL_REASON' }
        if ($null -ne (& $prop $term 'errorCode')) { & $fail 'TERMINAL_ERRORCODE' }
        if ((& $bool $term 'definitive') -ne $true) { & $fail 'TERMINAL_NOT_DEFINITIVE' }
        if ((& $bool $term 'exitObserved') -ne $true) { & $fail 'TERMINAL_EXIT_NOT_OBSERVED' }
        if ((& $bool $term 'drainComplete') -ne $true) { & $fail 'TERMINAL_DRAIN_INCOMPLETE' }
        if ((& $bool $term 'stdinError') -ne $false) { & $fail 'TERMINAL_STDIN_ERROR' }
        if ((& $lng $term 'exitCode') -ne 0) { & $fail 'TERMINAL_EXITCODE' }
        $null = & $bool $term 'onStartedAcknowledged'
        $observed = & $lng $term 'observedBytes'
        $retained = & $lng $term 'retainedBytes'
        if (($observed -lt 0) -or ($retained -lt 0) -or ($observed -ne $retained)) { & $fail 'TERMINAL_BYTES' }
        $tOut = & $prop $term 'stdout'
        $tErr = & $prop $term 'stderr'
        if ((& $str $tOut 'file') -cne 'stdout.bin') { & $fail 'TERMINAL_STDOUT_NAME' }
        if ((& $str $tErr 'file') -cne 'stderr.bin') { & $fail 'TERMINAL_STDERR_NAME' }
        $outSha = & $hex $tOut 'sha256'; $errSha = & $hex $tErr 'sha256'
        $outRet = & $lng $tOut 'retainedBytes'; $errRet = & $lng $tErr 'retainedBytes'
        if (($outRet -lt 0) -or ($errRet -lt 0) -or ($outRet -gt $maxStream) -or ($errRet -gt $maxStream)) { & $fail 'TERMINAL_STREAM_BYTES' }
        if ((($outRet + $errRet) -ne $retained) -or ($retained -gt $maxStream)) { & $fail 'TERMINAL_STREAM_SUM' }

        $sf = & $take 'START' $startPath $smallMax
        $start = & $decodeBytes $sf.Bytes 'START_JSON'
        if ((& $str $start 'schema') -cne 'ManagedNativeStart/v1') { & $fail 'START_SCHEMA' }
        if ((& $str $start 'runId') -cne $RunId) { & $fail 'START_RUNID' }
        if ((& $lng $start 'attempt') -ne [long]$Attempt) { & $fail 'START_ATTEMPT' }
        if ((& $hex $start 'requestSha256') -cne $reqSha) { & $fail 'START_REQUEST_SHA' }
        if ((& $lng $start 'pid') -ne $pid1) { & $fail 'START_PID_MISMATCH' }
        if ((& $str $start 'startTimeUtc') -cne $startUtc) { & $fail 'START_TIME_MISMATCH' }
        $null = & $utc (& $str $start 'persistedUtc') 'START_PERSISTED_UTC'

        $so = & $take 'STDOUT' $outPath $maxStream
        if (($so.Sha256 -cne $outSha) -or ($so.Length -ne $outRet)) { & $fail 'STDOUT_MISMATCH' }
        $se = & $take 'STDERR' $errPath $maxStream
        if (($se.Sha256 -cne $errSha) -or ($se.Length -ne $errRet)) { & $fail 'STDERR_MISMATCH' }

        $art = & $prop $term 'artifact'
        if ((& $str $art 'path') -cne $artifactPath) { & $fail 'ARTIFACT_PATH_MISMATCH' }
        $artState = & $str $art 'state'
        $artSha = & $prop $art 'sha256'
        $artLen = & $prop $art 'length'
        if ($artState -ceq 'PRESENT') {
            if (-not (& $isHex $artSha)) { & $fail 'ARTIFACT_SHA_INVALID' }
            if (-not (& $isInt $artLen)) { & $fail 'ARTIFACT_LENGTH_INVALID' }
            $ar = & $take 'ARTIFACT' $artifactPath $maxStream
            if (($ar.Sha256 -cne $artSha) -or ($ar.Length -ne [long]$artLen)) { & $fail 'ARTIFACT_MISMATCH' }
        }
        elseif ($artState -ceq 'ABSENT') {
            if (($null -ne $artSha) -or ($null -ne $artLen)) { & $fail 'ARTIFACT_ABSENT_FIELDS' }
            if (-not (& $absent $artifactPath)) { & $fail 'ARTIFACT_NOT_ABSENT' }
            $inv.Add([pscustomobject]@{ Role = 'ARTIFACT'; State = 'ABSENT'; Path = $artifactPath; Sha256 = $null; Length = $null; Limit = [long]0 })
        }
        else { & $fail 'ARTIFACT_STATE_INADMISSIBLE' }

        foreach ($e in $inv) {
            if ($e.State -ceq 'FILE') {
                $r = & $readLeaf $e.Path $e.Limit
                if (($r.Sha256 -cne $e.Sha256) -or ($r.Length -ne $e.Length)) { & $fail 'STALE_INPUT' }
            }
            elseif (-not (& $absent $e.Path)) { & $fail 'STALE_INPUT' }
        }

        return [pscustomobject]@{
            Valid = $true
            Code = $null
            Facts = [pscustomobject]@{
                RunId = $RunId
                Attempt = [long]$Attempt
                RunDir = $runDir
                Manifest = $manifest
                Core = $core
                Ticket = $ticket
                Terminal = $term
                Start = $start
                Budget = $budget
                Pid = $pid1
                RequestSha256 = $reqSha
                ManifestPath = $ManifestPath
                ManifestSha256 = $mf.Sha256
                ManifestBytes = $mf.Bytes
                TerminalPath = $TerminalPath
                TerminalSha256 = $tm.Sha256
                TerminalBytes = $tm.Bytes
                TicketPath = $tPath
                TicketSha256 = $tk.Sha256
                TicketBytes = $tk.Bytes
                StartPath = $startPath
                StartSha256 = $sf.Sha256
                StartBytes = $sf.Bytes
                StdoutPath = $outPath
                StdoutBytes = $so.Bytes
                StderrPath = $errPath
                StderrBytes = $se.Bytes
                ArtifactPath = $artifactPath
                ArtifactState = $artState
                Inputs = $inv.ToArray()
            }
        }
    }
    catch {
        $m = [string]$_.Exception.Message
        $code = 'UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', [System.StringComparison]::Ordinal) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Facts = $null }
    }
}

function Invoke-ManagedNativePendingReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ManifestPath,
        [Parameter(Mandatory)][string]$ExpectedManifestSha256,
        [Parameter(Mandatory)][string]$TerminalPath,
        [Parameter(Mandatory)][string]$ExpectedTerminalSha256,
        [Parameter(Mandatory)][string]$TicketPath,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$RawPath,
        [Parameter(Mandatory)][string]$UsagePath,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [Parameter(Mandatory)][int]$Attempt,
        [Parameter(Mandatory)][int]$MaxAttempts,
        [Parameter(Mandatory)][long]$PriorElapsedMs,
        [Parameter(Mandatory)][long]$MaxElapsedMs
    )
    # Load the sibling adapter first so nothing it defines can shadow later locals.
    $adapterFile = Join-Path $PSScriptRoot 'receipt-adapter.ps1'
    if (-not (Test-Path -LiteralPath $adapterFile -PathType Leaf)) {
        return [pscustomobject]@{ valid = $false; code = 'ADAPTER_MISSING'; createdPaths = @() }
    }
    try { . $adapterFile } catch {
        return [pscustomobject]@{ valid = $false; code = 'ADAPTER_LOAD_FAILED'; createdPaths = @() }
    }
    if (-not (Get-Command ConvertTo-TerminalReceipt -CommandType Function -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ valid = $false; code = 'ADAPTER_MISSING'; createdPaths = @() }
    }

    $ErrorActionPreference = 'Stop'
    $owned = [System.Collections.Generic.List[string]]::new()
    $created = [System.Collections.Generic.List[string]]::new()
    $rp = [System.IO.FileAttributes]::ReparsePoint
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $refuse = { param($c) [pscustomobject]@{ valid = $false; code = [string]$c; createdPaths = @($created.ToArray()) } }
    $clean = {
        param($c)
        $s = [regex]::Replace([string]$c, '[^A-Za-z0-9_.:-]', '_')
        if ($s.Length -gt 64) { $s = $s.Substring(0, 64) }
        $s
    }
    $prop = {
        param($o, $n)
        if ($null -eq $o) { return $null }
        $pp = $o.PSObject.Properties[$n]
        if ($null -eq $pp) { return $null }
        return $pp.Value
    }
    $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
    $sha = { param([byte[]]$b) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
    $sameP = {
        param($a, $b)
        ($a -is [string]) -and [string]::Equals([System.IO.Path]::GetFullPath($a), [System.IO.Path]::GetFullPath($b), 'OrdinalIgnoreCase')
    }
    $snap = {
        param($paths)
        $sb = [System.Text.StringBuilder]::new()
        foreach ($p in $paths) {
            $cur = [System.IO.Path]::GetFullPath($p)
            [void]$sb.Append('P|' + $cur + '|')
            while ($cur) {
                $it = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
                $r = 0
                if ($null -ne $it -and (($it.Attributes -band $rp) -ne 0)) { $r = 1 }
                if ($null -eq $it) { [void]$sb.Append('-;') }
                elseif ($it.PSIsContainer) { [void]$sb.Append('D' + $r + ';') }
                else {
                    $b = [System.IO.File]::ReadAllBytes($cur)
                    [void]$sb.Append('F' + $b.Length + ':' + (& $sha $b) + ':' + $r + ';')
                }
                $cur = [System.IO.Path]::GetDirectoryName($cur)
            }
            [void]$sb.Append([char]10)
        }
        $sb.ToString()
    }
    $inputState = { try { & $snap $paths } catch { $null } }
    $invChk = {
        param($inv)
        $list = @($inv)
        if ($list.Count -eq 0) { return 'INVENTORY_EMPTY' }
        foreach ($e in $list) {
            $st = & $prop $e 'State'
            $ep = & $prop $e 'Path'
            if ($ep -isnot [string] -or -not [System.IO.Path]::IsPathFullyQualified($ep)) { return 'INVENTORY_PATH' }
            $efull = [System.IO.Path]::GetFullPath($ep)
            $ecur = [System.IO.Path]::GetDirectoryName($efull)
            if (-not $ecur) { return 'INVENTORY_PARENT' }
            $efirst = $true
            while ($ecur) {
                $pi = Get-Item -LiteralPath $ecur -Force -ErrorAction SilentlyContinue
                if ($null -eq $pi -or -not $pi.PSIsContainer -or (($pi.Attributes -band $rp) -ne 0)) { return 'INVENTORY_PARENT' }
                if ($efirst) {
                    try { $null = [System.IO.Directory]::EnumerateFileSystemEntries($ecur).GetEnumerator().MoveNext() } catch { return 'INVENTORY_PARENT' }
                    $efirst = $false
                }
                $ecur = [System.IO.Path]::GetDirectoryName($ecur)
            }
            $leaf = Get-Item -LiteralPath $efull -Force -ErrorAction SilentlyContinue
            if ($st -ceq 'ABSENT') {
                if ($null -ne $leaf -or [System.IO.File]::Exists($efull) -or [System.IO.Directory]::Exists($efull)) { return 'INPUT_STALE' }
                continue
            }
            if ($st -cne 'FILE') { return 'INVENTORY_STATE' }
            if ($null -eq $leaf -or $leaf.PSIsContainer -or (($leaf.Attributes -band $rp) -ne 0)) { return 'INPUT_STALE' }
            $elen = & $prop $e 'Length'
            $ehash = & $prop $e 'Sha256'
            if (-not (& $isInt $elen) -or $elen -lt 0 -or $ehash -isnot [string]) { return 'INVENTORY_FIELDS' }
            try { $edb = [System.IO.File]::ReadAllBytes($efull) } catch { return 'INPUT_STALE' }
            if ($edb.Length -ne $elen -or (& $sha $edb) -cne $ehash) { return 'INPUT_STALE' }
        }
        return $null
    }
    $outChk = {
        param($full)
        if ($null -ne (Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue) -or [System.IO.File]::Exists($full) -or [System.IO.Directory]::Exists($full)) { return 'OUTPUT_EXISTS' }
        $cur = [System.IO.Path]::GetDirectoryName($full)
        if (-not $cur) { return 'OUTPUT_PARENT_INVALID' }
        $first = $true
        while ($cur) {
            $it = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
            if ($null -eq $it -or -not $it.PSIsContainer -or (($it.Attributes -band $rp) -ne 0)) { return 'OUTPUT_PARENT_INVALID' }
            if ($first) {
                try { $null = [System.IO.Directory]::EnumerateFileSystemEntries($cur).GetEnumerator().MoveNext() } catch { return 'OUTPUT_PARENT_UNREADABLE' }
                $first = $false
            }
            $cur = [System.IO.Path]::GetDirectoryName($cur)
        }
        return $null
    }
    $writeNew = {
        param($path, [byte[]]$bytes)
        $fs = [System.IO.FileStream]::new($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $owned.Add($path)
            $fs.Write($bytes, 0, $bytes.Length)
            $fs.Flush($true)
        } finally { $fs.Dispose() }
    }

    try {
        if ($Attempt -lt 1 -or $Attempt -gt $MaxAttempts) { return & $refuse 'INVALID_ATTEMPT' }
        if ($PriorElapsedMs -lt 0) { return & $refuse 'INVALID_PRIOR_ELAPSED' }
        if ($MaxElapsedMs -le 0) { return & $refuse 'INVALID_MAX_ELAPSED' }

        # Single facts call, strictly before any write.
        $fr = Get-ManagedNativeCapturedFacts -ManifestPath $ManifestPath -ExpectedManifestSha256 $ExpectedManifestSha256 -TerminalPath $TerminalPath -ExpectedTerminalSha256 $ExpectedTerminalSha256 -TicketPath $TicketPath -RunId $RunId -Attempt $Attempt
        if ($null -eq $fr -or $fr.Valid -isnot [bool] -or -not $fr.Valid -or $null -eq $fr.Facts) {
            $c = & $clean (& $prop $fr 'Code')
            if (-not $c) { $c = 'FACTS_INVALID' }
            return & $refuse $c
        }
        $f = $fr.Facts
        $tk = $f.Ticket
        $term = $f.Terminal
        $sid = & $prop $tk 'sessionId'
        if ($sid -isnot [string] -or [string]::IsNullOrEmpty($sid)) { return & $refuse 'TICKET_SESSION' }
        $bud = & $prop $tk 'budget'
        $hist = & $prop $bud 'historicalOutputTokens'
        $addCap = & $prop $bud 'additionalOutputMax'
        $aggCeil = & $prop $bud 'phaseAggregateCeiling'
        if (-not (& $isInt $hist) -or $hist -lt 0 -or -not (& $isInt $addCap) -or $addCap -lt 0) { return & $refuse 'TICKET_BUDGET' }
        if (-not (& $isInt $aggCeil) -or $aggCeil -lt 0) { return & $refuse 'TICKET_BUDGET' }
        $ticketId = & $prop $tk 'id'
        if ($ticketId -isnot [string] -or [string]::IsNullOrEmpty($ticketId)) { return & $refuse 'TICKET_ID' }
        $tPid = & $prop $term 'pid'
        $tStart = & $prop $term 'startTimeUtc'
        $tEnd = & $prop $term 'endedUtc'
        $tExit = & $prop $term 'exitCode'
        if ($null -eq $tPid -or $null -eq $tStart -or $null -eq $tEnd -or $null -eq $tExit) { return & $refuse 'TERMINAL_FIELDS' }
        if ([string](& $prop $term 'status') -ceq 'DEADLINE') { return & $refuse 'TERMINAL_DEADLINE' }

        # Strict SDK evidence parse of the full unchanged captured stdout bytes.
        $stdoutBytes = $f.StdoutBytes
        if ($stdoutBytes -isnot [byte[]] -or $stdoutBytes.Length -eq 0) { return & $refuse 'STDOUT_MISSING' }
        try { $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($stdoutBytes) } catch { return & $refuse 'STDOUT_NOT_UTF8' }
        $results = [System.Collections.Generic.List[object]]::new()
        $started = $false
        foreach ($line in $text.Split([char]10)) {
            $l = $line.TrimEnd([char]13)
            if ([string]::IsNullOrWhiteSpace($l)) { continue }
            try { $o = ConvertFrom-Json -InputObject $l -DateKind String -ErrorAction Stop } catch { return & $refuse 'STDOUT_INVALID_JSON' }
            if ($o -isnot [pscustomobject]) { return & $refuse 'STDOUT_NOT_OBJECT' }
            $t = & $prop $o 'type'
            if ($t -isnot [string]) { continue }
            if ($t -ceq 'result') { $results.Add($o) }
            elseif ($t -ceq 'message_start') {
                if ((& $prop $o 'message') -is [pscustomobject]) { $started = $true }
            }
            elseif ($t -ceq 'stream_event') {
                $ev0 = & $prop $o 'event'
                if ($ev0 -is [pscustomobject] -and ((& $prop $ev0 'type') -ceq 'message_start') -and ((& $prop $ev0 'message') -is [pscustomobject])) { $started = $true }
            }
        }
        if ($results.Count -eq 0) { return & $refuse 'NO_SDK_RESULT' }
        if ($results.Count -gt 1) { return & $refuse 'MULTIPLE_SDK_RESULTS' }
        $res = $results[0]
        $ie = & $prop $res 'is_error'
        if ($ie -isnot [bool]) { return & $refuse 'SDK_IS_ERROR_TYPE' }
        if ($ie) { return & $refuse 'SDK_IS_ERROR' }
        $rsid = & $prop $res 'session_id'
        if ($rsid -isnot [string] -or $rsid -cne $sid) { return & $refuse 'SDK_SESSION_MISMATCH' }
        $us = & $prop $res 'usage'
        if ($us -isnot [pscustomobject]) { return & $refuse 'SDK_USAGE' }
        $obs = & $prop $us 'output_tokens'
        if (-not (& $isInt $obs) -or $obs -lt 0) { return & $refuse 'SDK_OUTPUT_TOKENS' }
        if (-not $started) { return & $refuse 'NO_MESSAGE_START' }
        $stop = $null
        $srp = $res.PSObject.Properties['stop_reason']
        if ($null -ne $srp -and $null -ne $srp.Value) {
            if ($srp.Value -isnot [string]) { return & $refuse 'SDK_STOP_REASON' }
            $stop = $srp.Value
        }

        # Output leaves: canonical, distinct, absent, safe parents, no collision with any input.
        foreach ($p in @($RawPath, $UsagePath, $ReceiptPath)) {
            if (-not [System.IO.Path]::IsPathFullyQualified($p)) { return & $refuse 'OUTPUT_NOT_ABSOLUTE' }
        }
        $oRaw = [System.IO.Path]::GetFullPath($RawPath)
        $oUsage = [System.IO.Path]::GetFullPath($UsagePath)
        $oRcpt = [System.IO.Path]::GetFullPath($ReceiptPath)
        $distinct = @(@($oRaw, $oUsage, $oRcpt) | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
        if ($distinct.Count -ne 3) { return & $refuse 'OUTPUT_NOT_DISTINCT' }
        $paths = [System.Collections.Generic.List[string]]::new()
        foreach ($p in @($f.ManifestPath, $f.TerminalPath, $f.TicketPath, $f.StartPath, $f.StdoutPath, $f.StderrPath, $f.ArtifactPath)) {
            if ($p -is [string] -and $p) { $paths.Add($p) }
        }
        foreach ($i in @($f.Inputs)) {
            if ($i -is [string]) { $ip = $i } else { $ip = & $prop $i 'Path' }
            if ($ip -is [string] -and $ip) { $paths.Add($ip) }
        }
        $taken = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($p in $paths) { [void]$taken.Add([System.IO.Path]::GetFullPath($p)) }
        foreach ($o2 in @($oRaw, $oUsage, $oRcpt)) {
            if ($taken.Contains($o2)) { return & $refuse 'OUTPUT_COLLIDES_INPUT' }
            $oc = & $outChk $o2
            if ($oc) { return & $refuse $oc }
        }

        # Input state: facts must still match disk, then stay unchanged until commit.
        $known = @(
            @($f.ManifestPath, $f.ManifestBytes), @($f.TerminalPath, $f.TerminalBytes), @($f.TicketPath, $f.TicketBytes),
            @($f.StartPath, $f.StartBytes), @($f.StdoutPath, $f.StdoutBytes), @($f.StderrPath, $f.StderrBytes)
        )
        foreach ($k in $known) {
            $kb = $k[1]
            if ($k[0] -isnot [string] -or $kb -isnot [byte[]]) { return & $refuse 'FACTS_BYTES' }
            try { $disk = [System.IO.File]::ReadAllBytes($k[0]) } catch { return & $refuse 'INPUT_STALE' }
            if ($disk.Length -ne $kb.Length -or (& $sha $disk) -cne (& $sha $kb)) { return & $refuse 'INPUT_STALE' }
        }
        if ($f.ArtifactPath -is [string] -and $f.ArtifactPath -and [string]$f.ArtifactState -ceq 'ABSENT') {
            if ($null -ne (Get-Item -LiteralPath $f.ArtifactPath -Force -ErrorAction SilentlyContinue)) { return & $refuse 'INPUT_STALE' }
        }
        $ic = & $invChk $f.Inputs
        if ($ic) { return & $refuse $ic }
        $snap0 = & $inputState
        if (-not $snap0) { return & $refuse 'INPUT_UNREADABLE' }
        $ic = & $invChk $f.Inputs
        if ($ic) { return & $refuse $ic }
        if ((& $inputState) -cne $snap0) { return & $refuse 'INPUT_STALE' }

        # Raw terminal record.
        $tv = { param($v) if ($v -is [datetime]) { $v.ToUniversalTime().ToString('o') } else { $v } }
        $rawObj = [pscustomobject]@{
            status           = 'TERMINAL'
            pid              = $tPid
            startUtc         = (& $tv $tStart)
            endUtc           = (& $tv $tEnd)
            exit             = $tExit
            session          = $sid
            historicalOutput = $hist
            additionalCap    = $addCap
            observedOutput   = $obs
            stopReason       = $stop
        }
        $rawBytes = $utf8.GetBytes(($rawObj | ConvertTo-Json -Depth 4))

        $tag = [guid]::NewGuid().ToString('N')
        $stg = { param($full, $k) [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($full), ('.mnpr-' + $tag + '-' + $k + '.stage')) }
        $sRaw = & $stg $oRaw 'raw'
        $sUsage = & $stg $oUsage 'usage'
        $sTicket = & $stg $oRcpt 'ticket'
        $sAdapt = & $stg $oRcpt 'adapter'
        $sRcpt = & $stg $oRcpt 'receipt'

        $stageSet = @($sRaw, $sUsage, $sTicket, $sAdapt, $sRcpt)
        $stageKeys = @($stageSet | ForEach-Object { [System.IO.Path]::GetFullPath($_).ToLowerInvariant() } | Select-Object -Unique)
        if ($stageKeys.Count -ne $stageSet.Count) { return & $refuse 'STAGE_NOT_DISTINCT' }
        foreach ($sp in $stageSet) {
            $spf = [System.IO.Path]::GetFullPath($sp)
            if ($taken.Contains($spf) -or (@($oRaw, $oUsage, $oRcpt) -contains $spf)) { return & $refuse 'STAGE_COLLIDES' }
            $sc = & $outChk $sp
            if ($sc) { return & $refuse 'STAGE_EXISTS' }
        }

        if ((& $inputState) -cne $snap0) { return & $refuse 'INPUT_STALE' }
        & $writeNew $sRaw $rawBytes
        & $writeNew $sUsage $f.StdoutBytes
        & $writeNew $sTicket $f.TicketBytes
        & $writeNew $sAdapt ([byte[]]::new(0))

        try {
            $ar = @(ConvertTo-TerminalReceipt -RawPath $sRaw -TicketPath $sTicket -UsagePath $sUsage -RunId $RunId -Attempt $Attempt -MaxAttempts $MaxAttempts -PriorElapsedMs $PriorElapsedMs -MaxElapsedMs $MaxElapsedMs -ReceiptPath $sAdapt)
        } catch { return & $refuse 'ADAPTER_EXCEPTION' }
        if ($ar.Count -eq 0) { return & $refuse 'ADAPTER_NO_RESULT' }
        $a = $ar[$ar.Count - 1]
        $av = & $prop $a 'valid'
        if ($av -isnot [bool]) { return & $refuse 'ADAPTER_BUDGET_BREACH_MALFORMED' }
        if (-not $av) {
            $dType = & $prop $a 'diagnosticType'
            $dSchema = & $prop $a 'schemaVersion'
            if (($dType -is [string]) -and ($dType -ceq 'BudgetBreach') -and ($dSchema -is [string]) -and ($dSchema -ceq 'BudgetBreachDiagnostic/v1')) {
                $dTv = { param($v) if ($v -is [datetime]) { $v.ToUniversalTime().ToString('o') } else { $v } }
                $expStart = & $dTv $tStart
                $expEnd = & $dTv $tEnd
                $expTotal = [int64]$hist + [int64]$obs
                $expExcessAgg = $expTotal - [int64]$aggCeil
                $expExcessAdd = [int64]$obs - [int64]$addCap
                if ($expExcessAdd -lt 0) { $expExcessAdd = [int64]0 }

                $dRunId = & $prop $a 'runId'
                $dTaskId = & $prop $a 'taskId'
                $dAttempt = & $prop $a 'attempt'
                $dSessionId = & $prop $a 'sessionId'
                $dPid = & $prop $a 'pid'
                $dStart = & $prop $a 'startUtc'
                $dEnd = & $prop $a 'endUtc'
                $dExit = & $prop $a 'exit'
                $dStop = & $prop $a 'stopOutcome'
                $dRawSha = & $prop $a 'rawSha256'
                $dTicketSha = & $prop $a 'ticketSha256'
                $dUsageSha = & $prop $a 'usageSha256'
                $dBudget = & $prop $a 'budget'

                $dMalformed = $false
                if ($dRunId -isnot [string] -or $dRunId -cne $RunId) { $dMalformed = $true }
                if (-not $dMalformed -and ($dTaskId -isnot [string] -or $dTaskId -cne $ticketId)) { $dMalformed = $true }
                if (-not $dMalformed -and (-not (& $isInt $dAttempt) -or [int64]$dAttempt -ne [int64]$Attempt)) { $dMalformed = $true }
                if (-not $dMalformed -and ($dSessionId -isnot [string] -or $dSessionId -cne $sid)) { $dMalformed = $true }
                if (-not $dMalformed -and (-not (& $isInt $dPid) -or [int64]$dPid -ne [int64]$tPid)) { $dMalformed = $true }
                if (-not $dMalformed -and ($dStart -isnot [string] -or $dStart -cne $expStart)) { $dMalformed = $true }
                if (-not $dMalformed -and ($dEnd -isnot [string] -or $dEnd -cne $expEnd)) { $dMalformed = $true }
                if (-not $dMalformed -and (-not (& $isInt $dExit) -or [int64]$dExit -ne [int64]$tExit)) { $dMalformed = $true }
                if (-not $dMalformed) {
                    if ($null -eq $stop) { if ($null -ne $dStop) { $dMalformed = $true } }
                    elseif ($dStop -isnot [string] -or $dStop -cne $stop) { $dMalformed = $true }
                }
                if (-not $dMalformed -and ($dRawSha -isnot [string] -or $dRawSha.Length -ne 64)) { $dMalformed = $true }
                if (-not $dMalformed -and ($dTicketSha -isnot [string] -or $dTicketSha.Length -ne 64)) { $dMalformed = $true }
                if (-not $dMalformed -and ($dUsageSha -isnot [string] -or $dUsageSha.Length -ne 64)) { $dMalformed = $true }
                if (-not $dMalformed -and $dBudget -isnot [pscustomobject]) { $dMalformed = $true }
                $dHist = $null; $dObsAdd = $null; $dAddCeil = $null; $dTotal = $null; $dAggCeil2 = $null; $dExAgg = $null; $dExAdd = $null
                if (-not $dMalformed) {
                    $dHist = & $prop $dBudget 'historicalOutputTokens'
                    $dObsAdd = & $prop $dBudget 'additionalObservedTokens'
                    $dAddCeil = & $prop $dBudget 'additionalCeiling'
                    $dTotal = & $prop $dBudget 'totalObservedTokens'
                    $dAggCeil2 = & $prop $dBudget 'aggregateCeiling'
                    $dExAgg = & $prop $dBudget 'excessVsAggregate'
                    $dExAdd = & $prop $dBudget 'excessVsAdditional'
                    foreach ($bv in @($dHist, $dObsAdd, $dAddCeil, $dTotal, $dAggCeil2, $dExAgg, $dExAdd)) {
                        if (-not (& $isInt $bv)) { $dMalformed = $true }
                    }
                }
                if (-not $dMalformed) {
                    if ([int64]$dHist -ne [int64]$hist) { $dMalformed = $true }
                    elseif ([int64]$dObsAdd -ne [int64]$obs) { $dMalformed = $true }
                    elseif ([int64]$dAddCeil -ne [int64]$addCap) { $dMalformed = $true }
                    elseif ([int64]$dTotal -ne $expTotal) { $dMalformed = $true }
                    elseif ([int64]$dAggCeil2 -ne [int64]$aggCeil) { $dMalformed = $true }
                    elseif ([int64]$dExAgg -ne $expExcessAgg) { $dMalformed = $true }
                    elseif ([int64]$dExAdd -ne $expExcessAdd) { $dMalformed = $true }
                }
                if ($expTotal -le $aggCeil) { $dMalformed = $true }

                if ($dMalformed) { return & $refuse 'ADAPTER_BUDGET_BREACH_MALFORMED' }

                $icB = & $invChk $f.Inputs
                if ($icB) { return & $refuse $icB }
                if ((& $inputState) -cne $snap0) { return & $refuse 'INPUT_STALE' }
                try { $diskRaw = [System.IO.File]::ReadAllBytes($sRaw) } catch { return & $refuse 'STAGE_LOST' }
                if ($diskRaw.Length -ne $rawBytes.Length -or (& $sha $diskRaw) -cne (& $sha $rawBytes)) { return & $refuse 'STAGE_CHANGED' }
                try { $diskTicket = [System.IO.File]::ReadAllBytes($sTicket) } catch { return & $refuse 'STAGE_LOST' }
                if ($diskTicket.Length -ne $f.TicketBytes.Length -or (& $sha $diskTicket) -cne (& $sha $f.TicketBytes)) { return & $refuse 'STAGE_CHANGED' }
                try { $diskUsage = [System.IO.File]::ReadAllBytes($sUsage) } catch { return & $refuse 'STAGE_LOST' }
                if ($diskUsage.Length -ne $f.StdoutBytes.Length -or (& $sha $diskUsage) -cne (& $sha $f.StdoutBytes)) { return & $refuse 'STAGE_CHANGED' }

                $freshRawSha = & $sha $rawBytes
                $freshUsageSha = & $sha $f.StdoutBytes
                $freshTicketSha = $f.TicketSha256
                if ($dRawSha.ToLowerInvariant() -ne $freshRawSha) { return & $refuse 'INPUT_STALE' }
                if ($dTicketSha.ToLowerInvariant() -ne $freshTicketSha.ToLowerInvariant()) { return & $refuse 'INPUT_STALE' }
                if ($dUsageSha.ToLowerInvariant() -ne $freshUsageSha) { return & $refuse 'INPUT_STALE' }

                return [pscustomobject]@{
                    valid           = $false
                    code            = 'ADAPTER_BUDGET_BREACH'
                    createdPaths    = @()
                    diagnosticType  = 'BudgetBreach'
                    schemaVersion   = 'BudgetBreachDiagnostic/v1'
                    runId           = [string]$RunId
                    taskId          = [string]$ticketId
                    attempt         = [int64]$Attempt
                    sessionId       = [string]$sid
                    pid             = [int64]$tPid
                    startUtc        = [string]$expStart
                    endUtc          = [string]$expEnd
                    exit            = [int64]$tExit
                    stopOutcome     = $stop
                    rawSha256       = $freshRawSha
                    ticketSha256    = $freshTicketSha
                    usageSha256     = $freshUsageSha
                    manifestSha256  = $f.ManifestSha256
                    terminalSha256  = $f.TerminalSha256
                    budget          = [pscustomobject]@{
                        historicalOutputTokens   = [int64]$hist
                        additionalObservedTokens = [int64]$obs
                        additionalCeiling        = [int64]$addCap
                        totalObservedTokens      = $expTotal
                        aggregateCeiling         = [int64]$aggCeil
                        excessVsAggregate        = $expExcessAgg
                        excessVsAdditional       = $expExcessAdd
                    }
                }
            }
            $ac = & $clean (& $prop $a 'code')
            if (-not $ac) { $ac = 'REFUSED' }
            return & $refuse ('ADAPTER_' + $ac)
        }
        if ([string](& $prop $a 'classification') -cne 'SUCCESS') { return & $refuse 'ADAPTER_CLASSIFICATION' }
        $rc = & $prop $a 'receipt'
        if ($rc -isnot [pscustomobject]) { return & $refuse 'RECEIPT_SHAPE' }
        $hv = & $prop $rc 'historyVerified'
        $art = & $prop $rc 'artifact'
        $ac2 = & $prop $art 'complete'
        if ([string](& $prop $rc 'status') -cne 'AWAITING_CONTROLLER' -or $hv -isnot [bool] -or $hv -or $ac2 -isnot [bool] -or $ac2) { return & $refuse 'RECEIPT_SEMANTICS' }

        # Evidence must reference exactly the staged bytes; then relocate only the three paths.
        $ev = & $prop $rc 'evidence'
        if ($ev -isnot [pscustomobject]) { return & $refuse 'RECEIPT_EVIDENCE' }
        $evOk = (& $sameP (& $prop $ev 'rawPath') $sRaw) -and (& $sameP (& $prop $ev 'ticketPath') $sTicket) -and (& $sameP (& $prop $ev 'usagePath') $sUsage) -and
            [string]::Equals([string](& $prop $ev 'rawSha256'), (& $sha $rawBytes), 'OrdinalIgnoreCase') -and
            [string]::Equals([string](& $prop $ev 'ticketSha256'), (& $sha $f.TicketBytes), 'OrdinalIgnoreCase') -and
            [string]::Equals([string](& $prop $ev 'usageSha256'), (& $sha $f.StdoutBytes), 'OrdinalIgnoreCase')
        if (-not $evOk) { return & $refuse 'RECEIPT_EVIDENCE_MISMATCH' }
        $ev.rawPath = $oRaw
        $ev.ticketPath = $f.TicketPath
        $ev.usagePath = $oUsage
        $rBytes = $utf8.GetBytes(($rc | ConvertTo-Json -Depth 20))
        $rSha = & $sha $rBytes
        & $writeNew $sRcpt $rBytes

        # Final recheck immediately before commit.
        $ic = & $invChk $f.Inputs
        if ($ic) { return & $refuse $ic }
        if ((& $inputState) -cne $snap0) { return & $refuse 'INPUT_STALE' }
        foreach ($o2 in @($oRaw, $oUsage, $oRcpt)) {
            $oc = & $outChk $o2
            if ($oc) { return & $refuse $oc }
        }
        $stagedChk = @(@($sRaw, $rawBytes), @($sUsage, $f.StdoutBytes), @($sRcpt, $rBytes))
        foreach ($s in $stagedChk) {
            try { $sb2 = [System.IO.File]::ReadAllBytes($s[0]) } catch { return & $refuse 'STAGE_LOST' }
            if ((& $sha $sb2) -cne (& $sha $s[1])) { return & $refuse 'STAGE_CHANGED' }
        }

        # Commit raw, usage, then receipt last; no overwrite.
        try {
            foreach ($m in @(@($sRaw, $oRaw), @($sUsage, $oUsage), @($sRcpt, $oRcpt))) {
                [System.IO.File]::Move($m[0], $m[1])
                $created.Add($m[1])
                [void]$owned.Remove($m[0])
            }
            $cb = [System.IO.File]::ReadAllBytes($oRcpt)
            if ($cb.Length -ne $rBytes.Length -or (& $sha $cb) -cne $rSha) { return & $refuse 'PARTIAL_PUBLICATION' }
            foreach ($fin in @(@($oRaw, $rawBytes), @($oUsage, $f.StdoutBytes))) {
                $fb = [System.IO.File]::ReadAllBytes($fin[0])
                if ($fb.Length -ne $fin[1].Length -or (& $sha $fb) -cne (& $sha $fin[1])) { return & $refuse 'PARTIAL_PUBLICATION' }
            }
            if (& $invChk $f.Inputs) { return & $refuse 'PARTIAL_PUBLICATION' }
        } catch { return & $refuse 'PARTIAL_PUBLICATION' }

        $decoded = ConvertFrom-Json -InputObject $utf8.GetString($cb) -DateKind String
        return [pscustomobject]@{
            valid           = $true
            code            = $null
            committedPath   = $oRcpt
            committedSha256 = $rSha
            rawPath         = $oRaw
            usagePath       = $oUsage
            createdPaths    = @($created.ToArray())
            receipt         = $decoded
            links           = [pscustomobject]@{
                manifest = [pscustomobject]@{ path = $f.ManifestPath; sha256 = $f.ManifestSha256 }
                terminal = [pscustomobject]@{ path = $f.TerminalPath; sha256 = $f.TerminalSha256 }
                request  = [pscustomobject]@{ sha256 = $f.RequestSha256 }
            }
        }
    }
    catch {
        return & $refuse 'UNEXPECTED_EXCEPTION'
    }
    finally {
        foreach ($op in @($owned.ToArray())) {
            try { if ([System.IO.File]::Exists($op)) { [System.IO.File]::Delete($op) } } catch { }
        }
    }
}
