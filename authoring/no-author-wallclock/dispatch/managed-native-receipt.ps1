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
        [Parameter(Mandatory)][int]$Attempt,
        [switch]$ForFailedAccounting,
        [ValidateSet('ERROR_MAX_TURNS','TOKEN_ACCOUNTING_STOP')][string]$FailureKind = 'ERROR_MAX_TURNS',
        [switch]$ForOutputObservation,
        [switch]$ForFailedTransportObservation,
        [switch]$ForUnknownFailedObservation
    )
    Set-StrictMode -Version Latest
    $ticketIssues = @()
    # Explicit failed-transport opt-in: same observe-only authentication and raw-stream reads, but only an authenticated DEADLINE terminal with a nonzero typed exit.
    $fto = $ForFailedTransportObservation.IsPresent
    $sfv = $null
    $onAck = $false
    # UNKNOWN-history failed observation (v7): the same observe-only authentication, but the terminal reason is reason-specific. DEADLINE keeps the finite-deadline
    # stopFacts rules; NATURAL_EXIT requires a nonzero typed exit with the collector's own null deadline tuple and no total author duration. Any other reason refuses.
    $ufo = $ForUnknownFailedObservation.IsPresent
    $ufoDeadline = $false
    $obs = $ForOutputObservation.IsPresent -or $fto -or $ufo
    $obsDeclared = [System.Collections.Generic.List[object]]::new()
    $obsVerified = [System.Collections.Generic.List[object]]::new()
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    $unknown = { param([string]$c) throw [System.InvalidOperationException]::new('UNKNOWN:' + $c) }
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
        # Observation selectors must be exact ordinal NoteProperty names; the shared lookup above is case-insensitive.
        $exactName = {
            param($o, [string]$n)
            foreach ($q in $o.PSObject.Properties) { if (($q.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty) -and [string]::Equals($q.Name, $n, $ord)) { return $true } }
            return $false
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
        # Observe-only raw leaf: fixed 64 KiB buffer, incremental SHA-256, checked running length, no length ceiling, never written.
        $streamLeaf = {
            param([string]$p)
            & $canon $p
            & $chain $p
            $attr = $null
            try { $attr = [IO.File]::GetAttributes($p) } catch { $attr = $null }
            if ($null -eq $attr) { & $fail 'LEAF_UNREADABLE' }
            $bad = [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Device -bor [IO.FileAttributes]::ReparsePoint
            if (($attr -band $bad) -ne [IO.FileAttributes]0) { & $fail 'LEAF_NOT_ORDINARY' }
            $fs = $null
            try { $fs = [IO.FileStream]::new($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 4096, [IO.FileOptions]::SequentialScan) } catch { $fs = $null }
            if ($null -eq $fs) { & $unknown 'RAW_OPEN_UNAVAILABLE' }
            $buf = [byte[]]::new(65536)
            $total = [long]0
            $overflow = $false
            $readOk = $true
            $digest = $null
            $ih = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA256)
            try {
                try {
                    while ($true) {
                        $n = $fs.Read($buf, 0, $buf.Length)
                        if ($n -le 0) { break }
                        if ([long]$n -gt ([long]::MaxValue - $total)) { $overflow = $true; break }
                        $total = [long]($total + [long]$n)
                        $ih.AppendData($buf, 0, $n)
                    }
                    if (-not $overflow) { $digest = [Convert]::ToHexString($ih.GetHashAndReset()).ToLowerInvariant() }
                }
                catch { $readOk = $false }
            }
            finally { $fs.Dispose(); $ih.Dispose() }
            if (-not $readOk) { & $unknown 'RAW_READ_UNAVAILABLE' }
            if ($overflow) { & $fail 'LEAF_LENGTH_OVERFLOW' }
            return [pscustomobject]@{ Path = $p; Sha256 = $digest; Length = $total }
        }
        $invStream = [System.Collections.Generic.List[object]]::new()
        $takeStream = {
            param([string]$role, [string]$p)
            $r = & $streamLeaf $p
            $invStream.Add([pscustomobject]@{ Role = $role; Path = $p; Sha256 = $r.Sha256; Length = $r.Length })
            return $r
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
        if ($fto -and ($ForOutputObservation.IsPresent -or $ForFailedAccounting.IsPresent -or $PSBoundParameters.ContainsKey('FailureKind'))) { & $fail 'FAILED_TRANSPORT_SELECTOR_CONFLICT' }
        if ($ufo -and ($fto -or $ForOutputObservation.IsPresent -or $ForFailedAccounting.IsPresent -or $PSBoundParameters.ContainsKey('FailureKind'))) { & $fail 'UNKNOWN_FAILED_SELECTOR_CONFLICT' }
        # The FailureKind default alone is not a binding; only an explicitly bound FailureKind conflicts with observation.
        if ($obs -and ($ForFailedAccounting.IsPresent -or $PSBoundParameters.ContainsKey('FailureKind'))) { & $fail 'OBSERVE_SELECTOR_CONFLICT' }
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
        # Observe-only capture may carry an exact null maxElapsedMs (NO TOTAL AUTHOR DEADLINE); it is bound to the authenticated ticket below. Otherwise a positive typed integer is required.
        if ($obs -and (& $exactName $core 'maxElapsedMs') -and ($null -eq (& $prop $core 'maxElapsedMs'))) { $maxElapsed = $null }
        else {
            $maxElapsed = & $lng $core 'maxElapsedMs'
            if ($maxElapsed -le 0) { & $fail 'MAXELAPSED_INVALID' }
        }
        $maxStream = [long]0
        if ($obs) {
            foreach ($sel in @('outputStopProfile', 'outputStopAuthority', 'maxStreamBytes')) { if (-not (& $exactName $core $sel)) { & $fail ('MISSING_' + $sel.ToUpperInvariant()) } }
            if ((& $str $core 'outputStopProfile') -cne 'observe-only-v1') { & $fail 'OBS_CORE_PROFILE' }
            if ($null -ne (& $prop $core 'maxStreamBytes')) { & $fail 'OBS_MAXSTREAM_NOT_NULL' }
        }
        else {
            foreach ($sel in @('outputStopProfile', 'outputStopAuthority')) { if ($null -ne $core.PSObject.Properties[$sel]) { & $fail 'OBS_OPT_IN_REQUIRED' } }
            $maxStream = & $lng $core 'maxStreamBytes'
            if (($maxStream -le 0) -or ($maxStream -gt $streamCeil)) { & $fail 'MAXSTREAM_INVALID' }
        }
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
        . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
        $contract = Test-ManagedNativeTicketContract -Ticket $ticket -ExpectedPayloadSha256 $pl.Sha256
        if (-not $contract.Valid) {
            $ticketIssues = @($contract.Issues)
            & $fail $contract.Code
        }
        $contractMode = $contract.OutputStopMode
        if ($obs) { if ($contractMode -cne 'OBSERVE_ONLY_DESCRIPTOR') { & $fail 'OBS_CONTRACT_MODE' } }
        elseif ($contractMode -cne 'LEGACY_HARDLIMIT') { & $fail 'OBS_OPT_IN_REQUIRED' }
        # A null total author ceiling must be independently derived from the authenticated ticket, never from the core marker alone; a null ticket with a finite core is also refused.
        if (($null -eq $maxElapsed) -ne ($null -eq $contract.Budget.ElapsedMs)) { & $fail 'ELAPSED_NULL_BINDING' }
        if (($null -eq $maxElapsed) -and $fto) { & $fail 'FAILED_STOPFACTS_ELAPSED' }
        $sessionId = $ticket.sessionId
        $budget = $contract.Budget
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
        if (($FailureKind -ceq 'TOKEN_ACCOUNTING_STOP') -and (-not $ForFailedAccounting)) { & $fail 'TERMINAL_FAILUREKIND' }
        $wantReason = if ($fto) { 'DEADLINE' } elseif ($FailureKind -ceq 'TOKEN_ACCOUNTING_STOP') { 'TOKEN_ACCOUNTING_STOP' } else { 'NATURAL_EXIT' }
        if ($ufo) {
            # Only the two reasons with exact reason-specific authentication are supported; anything else is refused as unsupported, never relabelled.
            $ufoReason = & $str $term 'reason'
            if (($ufoReason -cne 'DEADLINE') -and ($ufoReason -cne 'NATURAL_EXIT')) { & $fail 'FAILED_REASON_UNSUPPORTED' }
            $ufoDeadline = ($ufoReason -ceq 'DEADLINE')
            if ($ufoDeadline -and ($null -eq $maxElapsed)) { & $fail 'FAILED_STOPFACTS_ELAPSED' }
            $wantReason = $ufoReason
        }
        if ((& $str $term 'reason') -cne $wantReason) { & $fail 'TERMINAL_REASON' }
        if ($null -ne (& $prop $term 'errorCode')) { & $fail 'TERMINAL_ERRORCODE' }
        if ((& $bool $term 'definitive') -ne $true) { & $fail 'TERMINAL_NOT_DEFINITIVE' }
        if ((& $bool $term 'exitObserved') -ne $true) { & $fail 'TERMINAL_EXIT_NOT_OBSERVED' }
        if ((& $bool $term 'drainComplete') -ne $true) { & $fail 'TERMINAL_DRAIN_INCOMPLETE' }
        if ((& $bool $term 'stdinError') -ne $false) { & $fail 'TERMINAL_STDIN_ERROR' }
        $termExit = & $lng $term 'exitCode'
        if ($ForFailedAccounting -or $fto -or $ufo) { if ($termExit -eq 0) { & $fail 'TERMINAL_EXITCODE' } }
        elseif ($termExit -ne 0) { & $fail 'TERMINAL_EXITCODE' }
        $onAck = & $bool $term 'onStartedAcknowledged'
        $observed = & $lng $term 'observedBytes'
        $retained = & $lng $term 'retainedBytes'
        if (($observed -lt 0) -or ($retained -lt 0) -or ($observed -ne $retained)) { & $fail 'TERMINAL_BYTES' }
        $tOut = & $prop $term 'stdout'
        $tErr = & $prop $term 'stderr'
        if ((& $str $tOut 'file') -cne 'stdout.bin') { & $fail 'TERMINAL_STDOUT_NAME' }
        if ((& $str $tErr 'file') -cne 'stderr.bin') { & $fail 'TERMINAL_STDERR_NAME' }
        $outSha = & $hex $tOut 'sha256'; $errSha = & $hex $tErr 'sha256'
        $outRet = & $lng $tOut 'retainedBytes'; $errRet = & $lng $tErr 'retainedBytes'
        if ($obs) {
            if (($outRet -lt 0) -or ($errRet -lt 0)) { & $fail 'TERMINAL_STREAM_BYTES' }
            if ($outRet -gt ([long]::MaxValue - $errRet)) { & $fail 'TERMINAL_STREAM_SUM' }
            if (($outRet + $errRet) -ne $retained) { & $fail 'TERMINAL_STREAM_SUM' }
            $obsDeclared.Add([pscustomobject]@{ Role = 'STDOUT'; Path = $outPath; DeclaredSha256 = $outSha; DeclaredLength = $outRet })
            $obsDeclared.Add([pscustomobject]@{ Role = 'STDERR'; Path = $errPath; DeclaredSha256 = $errSha; DeclaredLength = $errRet })
        }
        else {
            foreach ($sel in @('outputStopProfile', 'outputStopAuthority', 'usageTelemetry')) { if ($null -ne $term.PSObject.Properties[$sel]) { & $fail 'OBS_OPT_IN_REQUIRED' } }
            if (($outRet -lt 0) -or ($errRet -lt 0) -or ($outRet -gt $maxStream) -or ($errRet -gt $maxStream)) { & $fail 'TERMINAL_STREAM_BYTES' }
            if ((($outRet + $errRet) -ne $retained) -or ($retained -gt $maxStream)) { & $fail 'TERMINAL_STREAM_SUM' }
        }

        $sf = & $take 'START' $startPath $smallMax
        $start = & $decodeBytes $sf.Bytes 'START_JSON'
        if ((& $str $start 'schema') -cne 'ManagedNativeStart/v1') { & $fail 'START_SCHEMA' }
        if ((& $str $start 'runId') -cne $RunId) { & $fail 'START_RUNID' }
        if ((& $lng $start 'attempt') -ne [long]$Attempt) { & $fail 'START_ATTEMPT' }
        if ((& $hex $start 'requestSha256') -cne $reqSha) { & $fail 'START_REQUEST_SHA' }
        if ((& $lng $start 'pid') -ne $pid1) { & $fail 'START_PID_MISMATCH' }
        if ((& $str $start 'startTimeUtc') -cne $startUtc) { & $fail 'START_TIME_MISMATCH' }
        $null = & $utc (& $str $start 'persistedUtc') 'START_PERSISTED_UTC'

        # Failed-transport opt-in: the captured stopFacts must be exact, coherent with the started identity and with the actual finite deadline.
        if ($ufo -and (-not $ufoDeadline)) {
            # NATURAL_EXIT nonzero: the collector's own stopFacts must show NO deadline observation and no kill; nothing is fabricated or relabelled.
            if (-not (& $exactName $term 'stopFacts')) { & $fail 'MISSING_STOPFACTS' }
            $sfv = & $prop $term 'stopFacts'
            if ($sfv -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'FAILED_STOPFACTS_SHAPE' }
            $sfNames = @('pid', 'startTimeUtc', 'deadlineObservedUtc', 'elapsedMs', 'alive', 'aliveAtStop', 'killAttempted', 'killErrorCode')
            $sfProps = @($sfv.PSObject.Properties)
            if ($sfProps.Count -ne $sfNames.Count) { & $fail 'FAILED_STOPFACTS_SHAPE' }
            foreach ($q in $sfProps) { if (($q.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) -or ($sfNames -cnotcontains [string]$q.Name)) { & $fail 'FAILED_STOPFACTS_SHAPE' } }
            if ((& $lng $sfv 'pid') -ne $pid1) { & $fail 'FAILED_STOPFACTS_PID' }
            if ((& $str $sfv 'startTimeUtc') -cne $startUtc) { & $fail 'FAILED_STOPFACTS_START' }
            foreach ($nn in @('deadlineObservedUtc', 'elapsedMs', 'alive', 'aliveAtStop', 'killErrorCode')) { if ($null -ne (& $prop $sfv $nn)) { & $fail 'FAILED_STOPFACTS_NATURAL' } }
            $sfKillN = & $prop $sfv 'killAttempted'
            if (($sfKillN -isnot [bool]) -or $sfKillN) { & $fail 'FAILED_STOPFACTS_NATURAL' }
        }
        if ($fto -or ($ufo -and $ufoDeadline)) {
            if (-not (& $exactName $term 'stopFacts')) { & $fail 'MISSING_STOPFACTS' }
            $sfv = & $prop $term 'stopFacts'
            if ($sfv -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'FAILED_STOPFACTS_SHAPE' }
            $sfNames = @('pid', 'startTimeUtc', 'deadlineObservedUtc', 'elapsedMs', 'alive', 'aliveAtStop', 'killAttempted', 'killErrorCode')
            $sfProps = @($sfv.PSObject.Properties)
            if ($sfProps.Count -ne $sfNames.Count) { & $fail 'FAILED_STOPFACTS_SHAPE' }
            foreach ($q in $sfProps) { if (($q.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) -or ($sfNames -cnotcontains [string]$q.Name)) { & $fail 'FAILED_STOPFACTS_SHAPE' } }
            if ((& $lng $sfv 'pid') -ne $pid1) { & $fail 'FAILED_STOPFACTS_PID' }
            if ((& $str $sfv 'startTimeUtc') -cne $startUtc) { & $fail 'FAILED_STOPFACTS_START' }
            $sfDeadline = & $prop $sfv 'deadlineObservedUtc'
            $sfElapsed = & $prop $sfv 'elapsedMs'
            if (($sfDeadline -isnot [string]) -or (-not (& $isInt $sfElapsed)) -or ([long]$sfElapsed -lt 0)) { & $fail 'FAILED_STOPFACTS_DEADLINE' }
            $tDeadline = & $utc $sfDeadline 'FAILED_STOPFACTS_DEADLINE'
            if ([long]$sfElapsed -lt $maxElapsed) { & $fail 'FAILED_STOPFACTS_ELAPSED' }
            if (($tDeadline -lt $t0) -or ($tDeadline -gt $t1)) { & $fail 'FAILED_STOPFACTS_ORDER' }
            $sfAlive = & $prop $sfv 'alive'
            $sfAliveStop = & $prop $sfv 'aliveAtStop'
            $sfKill = & $prop $sfv 'killAttempted'
            $sfKillErr = & $prop $sfv 'killErrorCode'
            if (($sfAlive -isnot [bool]) -or ($sfAliveStop -isnot [bool]) -or ($sfKill -isnot [bool])) { & $fail 'FAILED_STOPFACTS_TYPE' }
            if ($sfKill -and (-not $sfAliveStop)) { & $fail 'FAILED_STOPFACTS_TREE' }
            if ($sfAlive -and (-not $sfKill)) { & $fail 'FAILED_STOPFACTS_TREE' }
            if ($null -ne $sfKillErr) { if (($sfKillErr -isnot [string]) -or [string]::IsNullOrWhiteSpace($sfKillErr) -or (-not $sfKill)) { & $fail 'FAILED_STOPFACTS_KILLERROR' } }
        }

        # Observation: complete selector, artifact-metadata, authentication and declared-telemetry admissibility before any raw stream or artifact read.
        if ($obs) {
            $eArt = & $prop $term 'artifact'
            if ((& $str $eArt 'path') -cne $artifactPath) { & $fail 'ARTIFACT_PATH_MISMATCH' }
            $eState = & $str $eArt 'state'
            $eSha = & $prop $eArt 'sha256'
            $eLen = & $prop $eArt 'length'
            if ($eState -ceq 'PRESENT') {
                if (-not (& $isHex $eSha)) { & $fail 'ARTIFACT_SHA_INVALID' }
                if ((-not (& $isInt $eLen)) -or ([long]$eLen -lt 0)) { & $fail 'ARTIFACT_LENGTH_INVALID' }
            }
            elseif ($eState -ceq 'ABSENT') {
                if (($null -ne $eSha) -or ($null -ne $eLen)) { & $fail 'ARTIFACT_ABSENT_FIELDS' }
                if (-not (& $absent $artifactPath)) { & $fail 'ARTIFACT_NOT_ABSENT' }
            }
            else { & $fail 'ARTIFACT_STATE_INADMISSIBLE' }
        }
        $obsAuth = $null
        if ($obs) {
            # Trusted sibling declarations only; nothing is loaded from the captured workingDirectory.
            try {
                . (Join-Path $PSScriptRoot 'managed-output-stop-authority.ps1')
                . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
            } catch { & $fail 'OBS_SIBLING_UNAVAILABLE' }
            $wd = & $str $core 'workingDirectory'
            & $canon $wd
            $controlRoot = [IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')
            try { $obsAuth = Resolve-ManagedOutputStopAuthority -TicketContract $contract -CapturedTicket ([byte[]]($tk.Bytes.Clone())) -ControlRoot $controlRoot } catch { $obsAuth = $null; & $fail 'OBS_AUTH_FAILED' }
            if (($null -eq $obsAuth) -or ($obsAuth -isnot [System.Management.Automation.PSCustomObject]) -or ($obsAuth.Schema -cne 'ManagedOutputStopAuthority/v1') -or ($obsAuth.Mode -cne 'OBSERVE_ONLY')) { & $fail 'OBS_AUTH_NOT_OBSERVE_ONLY' }
            $authJson = ConvertTo-Json -InputObject $obsAuth -Compress -Depth 4
            foreach ($sel in @('outputStopProfile', 'outputStopAuthority', 'usageTelemetry')) { if (-not (& $exactName $term $sel)) { & $fail ('MISSING_' + $sel.ToUpperInvariant()) } }
            if ((& $str $term 'outputStopProfile') -cne 'observe-only-v1') { & $fail 'OBS_TERMINAL_PROFILE' }
            foreach ($holder in @($core, $term)) {
                $held = & $prop $holder 'outputStopAuthority'
                if (($held -isnot [System.Management.Automation.PSCustomObject]) -or ((ConvertTo-Json -InputObject $held -Compress -Depth 4) -cne $authJson)) { & $fail 'OBS_AUTHORITY_MISMATCH' }
            }
            $ut = & $prop $term 'usageTelemetry'
            if ($ut -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBS_TELEMETRY_SHAPE' }
            $utWant = @('schema', 'status', 'outputTokens', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256')
            $utHave = @($ut.PSObject.Properties | ForEach-Object { $_.Name })
            if ($utHave.Count -ne $utWant.Count) { & $fail 'OBS_TELEMETRY_FIELDS' }
            foreach ($n in $utWant) { if ($utHave -cnotcontains $n) { & $fail 'OBS_TELEMETRY_FIELDS' } }
            if ((& $str $ut 'schema') -cne 'ManagedUsageTelemetry/v1') { & $fail 'OBS_TELEMETRY_SCHEMA' }
            if ((& $str $ut 'status') -cne 'RAW_SDK_RESULT_PENDING') { & $fail 'OBS_TELEMETRY_STATUS' }
            if ($null -ne (& $prop $ut 'outputTokens')) { & $fail 'OBS_TELEMETRY_TOKENS' }
            if ((& $lng $ut 'stdoutBytes') -ne $outRet) { & $fail 'OBS_TELEMETRY_STDOUT' }
            if ((& $lng $ut 'stderrBytes') -ne $errRet) { & $fail 'OBS_TELEMETRY_STDERR' }
            if ((& $hex $ut 'stdoutSha256') -cne $outSha) { & $fail 'OBS_TELEMETRY_STDOUT' }
            if ((& $hex $ut 'stderrSha256') -cne $errSha) { & $fail 'OBS_TELEMETRY_STDERR' }
        }

        if ($obs) {
            $so = & $takeStream 'STDOUT' $outPath
            if (($so.Sha256 -cne $outSha) -or ($so.Length -ne $outRet)) { & $fail 'STDOUT_MISMATCH' }
            $obsVerified.Add([pscustomobject]@{ Role = 'STDOUT'; Path = $outPath; VerifiedSha256 = $so.Sha256; VerifiedLength = $so.Length })
            $se = & $takeStream 'STDERR' $errPath
            if (($se.Sha256 -cne $errSha) -or ($se.Length -ne $errRet)) { & $fail 'STDERR_MISMATCH' }
            $obsVerified.Add([pscustomobject]@{ Role = 'STDERR'; Path = $errPath; VerifiedSha256 = $se.Sha256; VerifiedLength = $se.Length })
        }
        else {
            $so = & $take 'STDOUT' $outPath $maxStream
            if (($so.Sha256 -cne $outSha) -or ($so.Length -ne $outRet)) { & $fail 'STDOUT_MISMATCH' }
            $se = & $take 'STDERR' $errPath $maxStream
            if (($se.Sha256 -cne $errSha) -or ($se.Length -ne $errRet)) { & $fail 'STDERR_MISMATCH' }
        }

        $art = & $prop $term 'artifact'
        if ((& $str $art 'path') -cne $artifactPath) { & $fail 'ARTIFACT_PATH_MISMATCH' }
        $artState = & $str $art 'state'
        $artSha = & $prop $art 'sha256'
        $artLen = & $prop $art 'length'
        if ($artState -ceq 'PRESENT') {
            if (-not (& $isHex $artSha)) { & $fail 'ARTIFACT_SHA_INVALID' }
            if (-not (& $isInt $artLen)) { & $fail 'ARTIFACT_LENGTH_INVALID' }
            if ($obs) {
                if ([long]$artLen -lt 0) { & $fail 'ARTIFACT_LENGTH_INVALID' }
                $obsDeclared.Add([pscustomobject]@{ Role = 'ARTIFACT'; Path = $artifactPath; DeclaredSha256 = $artSha; DeclaredLength = [long]$artLen })
                $ar = & $takeStream 'ARTIFACT' $artifactPath
                if (($ar.Sha256 -cne $artSha) -or ($ar.Length -ne [long]$artLen)) { & $fail 'ARTIFACT_MISMATCH' }
                $obsVerified.Add([pscustomobject]@{ Role = 'ARTIFACT'; Path = $artifactPath; VerifiedSha256 = $ar.Sha256; VerifiedLength = $ar.Length })
            }
            else {
                $ar = & $take 'ARTIFACT' $artifactPath $maxStream
                if (($ar.Sha256 -cne $artSha) -or ($ar.Length -ne [long]$artLen)) { & $fail 'ARTIFACT_MISMATCH' }
            }
        }
        elseif ($artState -ceq 'ABSENT') {
            if (($null -ne $artSha) -or ($null -ne $artLen)) { & $fail 'ARTIFACT_ABSENT_FIELDS' }
            if (-not (& $absent $artifactPath)) { & $fail 'ARTIFACT_NOT_ABSENT' }
            $inv.Add([pscustomobject]@{ Role = 'ARTIFACT'; State = 'ABSENT'; Path = $artifactPath; Sha256 = $null; Length = $null; Limit = [long]0 })
        }
        else { & $fail 'ARTIFACT_STATE_INADMISSIBLE' }

        if ($obs) {
            $ut = & $prop $term 'usageTelemetry'
            if ((& $lng $ut 'stdoutBytes') -ne $so.Length) { & $fail 'OBS_TELEMETRY_STDOUT' }
            if ((& $lng $ut 'stderrBytes') -ne $se.Length) { & $fail 'OBS_TELEMETRY_STDERR' }
            if ((& $hex $ut 'stdoutSha256') -cne $so.Sha256) { & $fail 'OBS_TELEMETRY_STDOUT' }
            if ((& $hex $ut 'stderrSha256') -cne $se.Sha256) { & $fail 'OBS_TELEMETRY_STDERR' }
        }

        foreach ($e in $inv) {
            if ($e.State -ceq 'FILE') {
                $r = & $readLeaf $e.Path $e.Limit
                if (($r.Sha256 -cne $e.Sha256) -or ($r.Length -ne $e.Length)) { & $fail 'STALE_INPUT' }
            }
            elseif (-not (& $absent $e.Path)) { & $fail 'STALE_INPUT' }
        }
        foreach ($e in $invStream) {
            $r = & $streamLeaf $e.Path
            if (($r.Sha256 -cne $e.Sha256) -or ($r.Length -ne $e.Length)) { & $fail 'STALE_INPUT' }
        }

        if ($obs) {
            $obsCapture = [pscustomobject]@{
                RunId = $RunId
                Attempt = [long]$Attempt
                RunDir = $runDir
                SessionId = $sessionId
                Manifest = $manifest
                Core = $core
                Ticket = $ticket
                Terminal = $term
                Start = $start
                Budget = $budget
                Authority = $obsAuth
                Pid = $pid1
                RequestSha256 = $reqSha
                ManifestPath = $ManifestPath
                ManifestSha256 = $mf.Sha256
                TerminalPath = $TerminalPath
                TerminalSha256 = $tm.Sha256
                TicketPath = $tPath
                TicketSha256 = $tk.Sha256
                StartPath = $startPath
                StartSha256 = $sf.Sha256
                ArtifactPath = $artifactPath
                ArtifactState = $artState
                DeclaredReferences = $obsDeclared.ToArray()
                VerifiedReferences = $obsVerified.ToArray()
                StdoutLength = $so.Length
                StderrLength = $se.Length
                TransportExitCode = $termExit
                SDKOutcome = $(if ($fto -or $ufo) { 'UNKNOWN' } else { 'PENDING' })
                ObservedOutputTokens = $null
                Inputs = $inv.ToArray()
                StreamedInputs = $invStream.ToArray()
            }
            if ($fto) {
                # Distinct non-success capture: the terminal facts are preserved verbatim; no usage, completion or success is implied.
                Add-Member -InputObject $obsCapture -NotePropertyName 'TerminalReason' -NotePropertyValue ([string](& $str $term 'reason'))
                Add-Member -InputObject $obsCapture -NotePropertyName 'StopFacts' -NotePropertyValue $sfv
                Add-Member -InputObject $obsCapture -NotePropertyName 'OnStartedAcknowledged' -NotePropertyValue $onAck
                return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_ONLY_FAILED_TRANSPORT_CAPTURE'; Facts = $null; ObservationCapture = $obsCapture; TicketIssues = $ticketIssues }
            }
            if ($ufo) {
                # Distinct non-success capture: the actual terminal facts (reason, exit, stopFacts as written by the collector) are preserved verbatim.
                Add-Member -InputObject $obsCapture -NotePropertyName 'TerminalReason' -NotePropertyValue ([string](& $str $term 'reason'))
                Add-Member -InputObject $obsCapture -NotePropertyName 'StopFacts' -NotePropertyValue $sfv
                Add-Member -InputObject $obsCapture -NotePropertyName 'OnStartedAcknowledged' -NotePropertyValue $onAck
                return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_ONLY_UNKNOWN_FAILED_CAPTURE'; Facts = $null; ObservationCapture = $obsCapture; TicketIssues = $ticketIssues }
            }
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_ONLY_TRANSPORT_CAPTURE'; Facts = $null; ObservationCapture = $obsCapture; TicketIssues = $ticketIssues }
        }

        $capFacts = [pscustomobject]@{
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
        if ($ForFailedAccounting -and ($FailureKind -ceq 'TOKEN_ACCOUNTING_STOP')) {
            return [pscustomobject]@{ Valid = $false; Code = 'TOKENSTOP_ACCOUNTING_CAPTURE_ONLY'; Facts = $null; FailureCapture = $capFacts; TicketIssues = $ticketIssues }
        }
        if ($ForFailedAccounting) {
            return [pscustomobject]@{ Valid = $false; Code = 'FAILED_ACCOUNTING_CAPTURE_ONLY'; Facts = $null; FailureCapture = $capFacts; TicketIssues = $ticketIssues }
        }
        return [pscustomobject]@{ Valid = $true; Code = $null; Facts = $capFacts }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($obs -and $m.StartsWith('UNKNOWN:', [System.StringComparison]::Ordinal) -and ($m.Length -le 56) -and ($m.Substring(8) -cmatch '^[A-Z0-9_]{1,48}$')) {
            # Observational inability is UNKNOWN, not invalid evidence and never a completed capture; declared references are not verified ones.
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_ONLY_CAPTURE_UNKNOWN'; Result = 'UNKNOWN'; Reason = $m.Substring(8); Facts = $null; ObservationCapture = $null; DeclaredReferences = $obsDeclared.ToArray(); VerifiedReferences = $obsVerified.ToArray(); TicketIssues = $ticketIssues }
        }
        $code = 'UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', [System.StringComparison]::Ordinal) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Facts = $null; TicketIssues = $ticketIssues }
    }
}

function Get-ManagedNativeAdvisoryBudgetFacts {
    # Read-only. Expected SHA pins are trusted controller assertions, not OS attestation. Terminal counts are not an independent SDK recount.
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Evidence)
    Set-StrictMode -Version Latest
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    $get = {
        param($o, [string]$n)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'ADV_NOT_OBJECT' }
        $p = $o.PSObject.Properties[$n]
        if ($null -eq $p) { & $fail 'ADV_MISSING_FIELD' }
        return , $p.Value
    }
    $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
    $count = { param($v) if (-not (& $isInt $v) -or ([long]$v -lt 0)) { & $fail 'ADV_COUNT_INVALID' }; return [long]$v }
    $flag = { param($o, [string]$n, [bool]$want) $v = & $get $o $n; if (($v -isnot [bool]) -or ($v -ne $want)) { & $fail 'ADV_TERMINAL_STATE' } }
    $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
    try {
        $names = @('schema', 'manifestPath', 'manifestSha256', 'terminalPath', 'terminalSha256', 'ticketPath', 'runId', 'attempt')
        if ($Evidence -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'ADV_EVIDENCE_SHAPE' }
        $have = @($Evidence.PSObject.Properties | ForEach-Object { if ($_.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { '!' + $_.Name } else { $_.Name } })
        if (($have.Count -ne $names.Count) -or (@($names | Where-Object { $have -cnotcontains $_ }).Count -ne 0)) { & $fail 'ADV_EVIDENCE_SHAPE' }
        foreach ($n in @('schema', 'manifestPath', 'terminalPath', 'ticketPath', 'runId')) { if ((& $get $Evidence $n) -isnot [string]) { & $fail 'ADV_EVIDENCE_TYPE' } }
        if ($Evidence.schema -cne 'ManagedNativeAdvisoryEvidence/v1') { & $fail 'ADV_EVIDENCE_SCHEMA' }
        if (-not (& $isHex $Evidence.manifestSha256) -or -not (& $isHex $Evidence.terminalSha256)) { & $fail 'ADV_EVIDENCE_PIN' }
        $att = $Evidence.attempt
        if (-not (& $isInt $att) -or ([long]$att -le 0) -or ([long]$att -gt [int]::MaxValue)) { & $fail 'ADV_EVIDENCE_ATTEMPT' }
        $ev = [pscustomobject]@{
            schema = [string]$Evidence.schema; manifestPath = [string]$Evidence.manifestPath; manifestSha256 = [string]$Evidence.manifestSha256
            terminalPath = [string]$Evidence.terminalPath; terminalSha256 = [string]$Evidence.terminalSha256
            ticketPath = [string]$Evidence.ticketPath; runId = [string]$Evidence.runId; attempt = [long]$att
        }

        $cap = Get-ManagedNativeCapturedFacts -ManifestPath $ev.manifestPath -ExpectedManifestSha256 $ev.manifestSha256 -TerminalPath $ev.terminalPath -ExpectedTerminalSha256 $ev.terminalSha256 -TicketPath $ev.ticketPath -RunId $ev.runId -Attempt ([int]$ev.attempt)
        if (($cap.Valid -isnot [bool]) -or (-not $cap.Valid)) { & $fail 'ADV_CAPTURE_REFUSED' }
        $f = $cap.Facts

        # Trusted sibling declarations only; nothing is loaded from the captured workingDirectory.
        . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
        . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
        $contract = Test-ManagedNativeTicketContract -Ticket $f.Ticket -ExpectedPayloadSha256 ([string](& $get $f.Core 'payloadSha256'))
        if (-not $contract.Valid) { & $fail 'ADV_CONTRACT_INVALID' }

        $wd = & $get $f.Core 'workingDirectory'
        $full = $null
        if (($wd -is [string]) -and ($wd.Length -gt 0) -and ($wd.Length -le 1024) -and [IO.Path]::IsPathRooted($wd)) { try { $full = [IO.Path]::GetFullPath($wd) } catch { $full = $null } }
        if (($null -eq $full) -or ($full -cne $wd) -or $wd.EndsWith([string][IO.Path]::DirectorySeparatorChar) -or $wd.EndsWith([string][IO.Path]::AltDirectorySeparatorChar)) { & $fail 'ADV_WORKDIR_INVALID' }
        $controlRoot = [IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')

        $snap = $null
        try { $snap = Resolve-ManagedAggregateAdvisory -TicketContract $contract -CapturedTicket $f.TicketBytes -ControlRoot $controlRoot } catch { & $fail 'ADV_AUTH_FAILED' }

        $term = $f.Terminal
        $acct = & $get $term 'tokenAccounting'
        if ((& $get $acct 'schema') -cne 'ManagedTokenAccounting/v1') { & $fail 'ADV_TERMINAL_SCHEMA' }
        $observed = & $count (& $get $acct 'observedOutputTokens')
        & $flag $acct 'invalid' $false
        & $flag $acct 'resultConsistent' $true
        & $flag $acct 'parseComplete' $true
        & $flag $acct 'stdoutEof' $true
        & $flag $acct 'stdoutTruncated' $false
        if ((& $count (& $get $acct 'resultAggregate')) -ne $observed) { & $fail 'ADV_RESULT_AGGREGATE' }
        $pol = & $get $acct 'policy'
        $historical = & $count (& $get $pol 'HistoricalOutputTokens')
        $admitted = & $count (& $get $pol 'AdditionalOutputMax')
        $ceiling = & $count (& $get $pol 'PhaseAggregateCeiling')
        $bud = $contract.Budget
        if (($historical -ne [long]$bud.HistoricalOutputTokens) -or ($admitted -ne [long]$bud.AdditionalOutputMax) -or ($ceiling -ne [long]$bud.PhaseAggregateCeiling)) { & $fail 'ADV_BUDGET_BINDING' }
        $historical = [long]$bud.HistoricalOutputTokens
        $admitted = [long]$bud.AdditionalOutputMax
        $carrier = $null

        $coreAdv = $f.Core.PSObject.Properties['aggregateAdvisory']
        $termAdv = $term.PSObject.Properties['aggregateAdvisory']
        $mode = 'LEGACY_HARDLIMIT'
        $threshold = $null
        if ($null -eq $snap) {
            if (($null -ne $coreAdv) -or ($null -ne $termAdv)) { & $fail 'ADV_LEGACY_ANNOTATION' }
            if (($historical -gt $ceiling) -or ($observed -gt [Math]::Min($admitted, ($ceiling - $historical)))) { & $fail 'ADV_LEGACY_BUDGET' }
            $carrier = $ceiling
        }
        else {
            $mode = 'AUTHENTICATED_ADVISORY'
            $snapNames = @('Mode', 'HistoricalOutputTokens', 'Threshold', 'WarningCode', 'Exceeded', 'PolicyRef', 'PolicyReviewRef', 'HistoryListRef', 'HistoryRunCount', 'EvidenceScope', 'Completeness')
            $sn = @($snap.PSObject.Properties.Name)
            if (($snap -isnot [System.Management.Automation.PSCustomObject]) -or ($sn.Count -ne 11) -or (@($snapNames | Where-Object { $sn -cnotcontains $_ }).Count -ne 0)) { & $fail 'ADV_SNAPSHOT_SHAPE' }
            if (($null -eq $coreAdv) -or ($null -eq $termAdv)) { & $fail 'ADV_SNAPSHOT_MISSING' }
            $want = ConvertTo-Json -InputObject $snap -Depth 12 -Compress
            if ((ConvertTo-Json -InputObject $coreAdv.Value -Depth 12 -Compress) -cne $want) { & $fail 'ADV_SNAPSHOT_CORE' }
            if ((ConvertTo-Json -InputObject $termAdv.Value -Depth 12 -Compress) -cne $want) { & $fail 'ADV_SNAPSHOT_TERMINAL' }
            if ((-not (& $isInt $snap.HistoricalOutputTokens)) -or ([long]$snap.HistoricalOutputTokens -ne $historical)) { & $fail 'ADV_HISTORY_MISMATCH' }
            $threshold = & $count $snap.Threshold
        }

        if ($observed -gt $admitted) { & $fail 'ADV_OBSERVED_EXCEEDS_CAP' }
        if ($historical -gt ([long]::MaxValue - $observed)) { & $fail 'ADV_OVERFLOW' }
        if ($null -eq $carrier) {
            if ($historical -gt ([long]::MaxValue - $admitted)) { & $fail 'ADV_OVERFLOW' }
            $carrier = [long]($historical + $admitted)
        }
        return [pscustomobject]@{
            Valid = $true
            Code = $null
            Facts = [pscustomobject]@{
                mode = $mode
                historical = $historical
                actualUsed = [long]($historical + $observed)
                admittedAdditional = $admitted
                finiteCarrier = $carrier
                threshold = $threshold
                evidence = $ev
            }
        }
    }
    catch {
        $m = [string]$_.Exception.Message
        $code = 'ADV_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', [System.StringComparison]::Ordinal) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Facts = $null }
    }
}

function Get-ManagedNativeFailedAccountingJoin {
    # Read-only. Joins one failed (nonzero NATURAL_EXIT) managed run onto an authenticated successful predecessor for accounting only.
    # Grants no dispatch, no completion and no success receipt; pins are trusted controller assertions, not OS attestation.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$PredecessorReceiptPath,
        [Parameter(Mandatory)][string]$ExpectedPredecessorReceiptSha256,
        [Parameter(Mandatory)][AllowNull()]$FailedEvidence,
        [ValidateSet('ERROR_MAX_TURNS','TOKEN_ACCOUNTING_STOP')][string]$FailureKind = 'ERROR_MAX_TURNS'
    )
    Set-StrictMode -Version Latest
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    $ord = [System.StringComparison]::Ordinal
    $strict = [System.Text.UTF8Encoding]::new($false, $true)
    $g = {
        param($o, [string]$n, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        $p = $o.PSObject.Properties[$n]
        if ($null -eq $p) { & $fail $c }
        return , $p.Value
    }
    $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
    $cnt = { param($v, [string]$c) if (-not (& $isInt $v) -or ([long]$v -lt 0)) { & $fail $c }; return [long]$v }
    $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
    $add = { param([long]$a, [long]$b, [string]$c) if (($a -lt 0) -or ($b -lt 0) -or ($a -gt ([long]::MaxValue - $b))) { & $fail $c }; return [long]($a + $b) }
    $flag = { param($o, [string]$n, [bool]$want) $v = & $g $o $n 'FAILED_JOIN_ACCOUNTING_STATE'; if (($v -isnot [bool]) -or ($v -ne $want)) { & $fail 'FAILED_JOIN_ACCOUNTING_STATE' } }
    $histOf = {
        param($ticket, [string]$c)
        $b = & $g $ticket 'budget' $c
        $a = & $g $b 'aggregateAdvisory' $c
        if (($a -is [System.Management.Automation.PSCustomObject]) -and ($null -ne $a.PSObject.Properties['descriptor'])) { $a = $a.descriptor }
        $h = & $g $a 'historyRuns' $c
        if ($h -isnot [object[]]) { & $fail $c }
        return , $h
    }
    $norm = {
        param($r, [string]$c)
        $t = & $g $r 'terminalRef' $c
        $o = [pscustomobject]@{
            run = & $g $r 'runId' $c; req = & $g $r 'requestSha256' $c
            path = & $g $t 'path' $c; sha = & $g $t 'sha256' $c; out = & $g $r 'outputTokens' $c
        }
        if (($o.run -isnot [string]) -or ($o.run.Length -eq 0) -or ($o.path -isnot [string]) -or ($o.path.Length -eq 0) -or -not (& $isHex $o.req) -or -not (& $isHex $o.sha)) { & $fail $c }
        $o.out = & $cnt $o.out $c
        return $o
    }
    $inventory = {
        param($cf)
        return @($cf.Inputs | ForEach-Object { [string]$_.Role + '|' + [string]$_.State + '|' + [string]$_.Path + '|' + [string]$_.Sha256 + '|' + [string]$_.Length }) -join "`n"
    }
    try {
        $names = @('schema', 'manifestPath', 'manifestSha256', 'terminalPath', 'terminalSha256', 'ticketPath', 'runId', 'attempt')
        if (-not (& $isHex $ExpectedPredecessorReceiptSha256)) { & $fail 'FAILED_JOIN_PIN' }
        if ($FailedEvidence -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'FAILED_JOIN_EVIDENCE_SHAPE' }
        $have = @($FailedEvidence.PSObject.Properties | ForEach-Object { if ($_.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { '!' + $_.Name } else { $_.Name } })
        if (($have.Count -ne $names.Count) -or (@($names | Where-Object { $have -cnotcontains $_ }).Count -ne 0)) { & $fail 'FAILED_JOIN_EVIDENCE_SHAPE' }
        foreach ($n in @('schema', 'manifestPath', 'terminalPath', 'ticketPath', 'runId')) { if ($FailedEvidence.$n -isnot [string]) { & $fail 'FAILED_JOIN_EVIDENCE_SHAPE' } }
        if ($FailedEvidence.schema -cne 'ManagedNativeAdvisoryEvidence/v1') { & $fail 'FAILED_JOIN_EVIDENCE_SHAPE' }
        if (-not (& $isHex $FailedEvidence.manifestSha256) -or -not (& $isHex $FailedEvidence.terminalSha256)) { & $fail 'FAILED_JOIN_PIN' }
        $fAtt = $FailedEvidence.attempt
        if (-not (& $isInt $fAtt) -or ([long]$fAtt -le 0) -or ([long]$fAtt -gt [int]::MaxValue)) { & $fail 'FAILED_JOIN_EVIDENCE_SHAPE' }

        $capArgs = @{
            ManifestPath = [string]$FailedEvidence.manifestPath; ExpectedManifestSha256 = [string]$FailedEvidence.manifestSha256
            TerminalPath = [string]$FailedEvidence.terminalPath; ExpectedTerminalSha256 = [string]$FailedEvidence.terminalSha256
            TicketPath = [string]$FailedEvidence.ticketPath; RunId = [string]$FailedEvidence.runId; Attempt = [int]$fAtt; FailureKind = $FailureKind
        }
        $isTok = ($FailureKind -ceq 'TOKEN_ACCOUNTING_STOP')
        $capCode = if ($isTok) { 'TOKENSTOP_ACCOUNTING_CAPTURE_ONLY' } else { 'FAILED_ACCOUNTING_CAPTURE_ONLY' }
        $fcap = Get-ManagedNativeCapturedFacts @capArgs -ForFailedAccounting
        if (($fcap.Valid -isnot [bool]) -or $fcap.Valid -or ($fcap.Code -cne $capCode) -or ($null -ne $fcap.Facts) -or ($null -eq $fcap.FailureCapture)) { & $fail 'FAILED_JOIN_CAPTURE_REFUSED' }
        $f = $fcap.FailureCapture

        # Trusted sibling declarations only; nothing is loaded from the captured workingDirectory.
        . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
        . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
        . (Join-Path (Split-Path -Parent $PSScriptRoot) 'continuity\reconcile.ps1')
        $contract = Test-ManagedNativeTicketContract -Ticket $f.Ticket -ExpectedPayloadSha256 ([string](& $g $f.Core 'payloadSha256' 'FAILED_JOIN_CONTRACT'))
        if (-not $contract.Valid) { & $fail 'FAILED_JOIN_CONTRACT' }

        $wd = & $g $f.Core 'workingDirectory' 'FAILED_JOIN_WORKDIR'
        $full = $null
        if (($wd -is [string]) -and ($wd.Length -gt 0) -and ($wd.Length -le 1024) -and [IO.Path]::IsPathRooted($wd)) { try { $full = [IO.Path]::GetFullPath($wd) } catch { $full = $null } }
        if (($null -eq $full) -or ($full -cne $wd) -or $wd.EndsWith([string][IO.Path]::DirectorySeparatorChar) -or $wd.EndsWith([string][IO.Path]::AltDirectorySeparatorChar)) { & $fail 'FAILED_JOIN_WORKDIR' }
        $controlRoot = [IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')

        $snap = $null
        try { $snap = Resolve-ManagedAggregateAdvisory -TicketContract $contract -CapturedTicket $f.TicketBytes -ControlRoot $controlRoot } catch { & $fail 'FAILED_JOIN_AUTH' }
        if ($null -eq $snap) { & $fail 'FAILED_JOIN_AUTH' }
        $snapNames = @('Mode', 'HistoricalOutputTokens', 'Threshold', 'WarningCode', 'Exceeded', 'PolicyRef', 'PolicyReviewRef', 'HistoryListRef', 'HistoryRunCount', 'EvidenceScope', 'Completeness')
        $sn = @($snap.PSObject.Properties.Name)
        if (($snap -isnot [System.Management.Automation.PSCustomObject]) -or ($sn.Count -ne 11) -or (@($snapNames | Where-Object { $sn -cnotcontains $_ }).Count -ne 0)) { & $fail 'FAILED_JOIN_SNAPSHOT' }
        $term = $f.Terminal
        $coreAdv = $f.Core.PSObject.Properties['aggregateAdvisory']
        $termAdv = $term.PSObject.Properties['aggregateAdvisory']
        if (($null -eq $coreAdv) -or ($null -eq $termAdv)) { & $fail 'FAILED_JOIN_SNAPSHOT' }
        $want = ConvertTo-Json -InputObject $snap -Depth 12 -Compress
        if (((ConvertTo-Json -InputObject $coreAdv.Value -Depth 12 -Compress) -cne $want) -or ((ConvertTo-Json -InputObject $termAdv.Value -Depth 12 -Compress) -cne $want)) { & $fail 'FAILED_JOIN_SNAPSHOT' }

        $acct = & $g $term 'tokenAccounting' 'FAILED_JOIN_ACCOUNTING'
        if ((& $g $acct 'schema' 'FAILED_JOIN_ACCOUNTING') -cne 'ManagedTokenAccounting/v1') { & $fail 'FAILED_JOIN_ACCOUNTING' }
        $observed = & $cnt (& $g $acct 'observedOutputTokens' 'FAILED_JOIN_ACCOUNTING') 'FAILED_JOIN_ACCOUNTING'
        & $flag $acct 'invalid' $false
        if ($isTok) { if ($null -ne (& $g $acct 'resultConsistent' 'FAILED_JOIN_ACCOUNTING')) { & $fail 'FAILED_JOIN_ACCOUNTING_STATE' } } else { & $flag $acct 'resultConsistent' $true }
        & $flag $acct 'parseComplete' $true
        & $flag $acct 'stdoutEof' $true
        & $flag $acct 'stdoutTruncated' $false
        if ((& $cnt (& $g $acct 'bufferedLineBytes' 'FAILED_JOIN_ACCOUNTING') 'FAILED_JOIN_ACCOUNTING') -ne 0) { & $fail 'FAILED_JOIN_ACCOUNTING_STATE' }
        if ($isTok) { if ($null -ne (& $g $acct 'resultAggregate' 'FAILED_JOIN_ACCOUNTING')) { & $fail 'FAILED_JOIN_ACCOUNTING_STATE' } }
        elseif ((& $cnt (& $g $acct 'resultAggregate' 'FAILED_JOIN_ACCOUNTING') 'FAILED_JOIN_ACCOUNTING') -ne $observed) { & $fail 'FAILED_JOIN_ACCOUNTING_COUNT' }
        $pol = & $g $acct 'policy' 'FAILED_JOIN_ACCOUNTING'
        $bud = $contract.Budget
        $historical = & $cnt (& $g $pol 'HistoricalOutputTokens' 'FAILED_JOIN_BUDGET') 'FAILED_JOIN_BUDGET'
        $admitted = & $cnt (& $g $pol 'AdditionalOutputMax' 'FAILED_JOIN_BUDGET') 'FAILED_JOIN_BUDGET'
        $ceiling = & $cnt (& $g $pol 'PhaseAggregateCeiling' 'FAILED_JOIN_BUDGET') 'FAILED_JOIN_BUDGET'
        if (($historical -ne [long]$bud.HistoricalOutputTokens) -or ($admitted -ne [long]$bud.AdditionalOutputMax) -or ($ceiling -ne [long]$bud.PhaseAggregateCeiling)) { & $fail 'FAILED_JOIN_BUDGET' }
        if ((-not (& $isInt $snap.HistoricalOutputTokens)) -or ([long]$snap.HistoricalOutputTokens -ne $historical)) { & $fail 'FAILED_JOIN_BUDGET' }
        $overshoot = 0L
        $firstTrig = $null
        if ($isTok) {
            $firstTrig = & $g $acct 'firstTrigger' 'FAILED_JOIN_ACCOUNTING'
            if (($firstTrig -isnot [string]) -or ($firstTrig -cne 'MAX_TOKENS')) { & $fail 'FAILED_JOIN_ACCOUNTING_STATE' }
            $remaining = & $cnt (& $g $pol 'RemainingTokens' 'FAILED_JOIN_BUDGET') 'FAILED_JOIN_BUDGET'
            if (($remaining -ne $admitted) -or ($observed -lt $remaining)) { & $fail 'FAILED_JOIN_CAP' }
            $overshoot = $observed - $admitted
            $cp = $f.Core.tokenAccountingPolicy
            $pNames = @('MaxMessages', 'MaxEvents', 'MaxLineBytes', 'MaxInputBytes', 'RemainingTokens', 'HistoricalOutputTokens', 'AdditionalOutputMax', 'PhaseAggregateCeiling')
            $polNames = @($pol.PSObject.Properties.Name)
            $cpNames = @($cp.PSObject.Properties.Name)
            if (($polNames.Count -ne 8) -or ($cpNames.Count -ne 8)) { & $fail 'FAILED_JOIN_BUDGET' }
            foreach ($pn in $pNames) {
                if (($polNames -cnotcontains $pn) -or ($cpNames -cnotcontains $pn)) { & $fail 'FAILED_JOIN_BUDGET' }
                $pv = $pol.$pn
                $cv = $cp.$pn
                if ((-not (& $isInt $pv)) -or (-not (& $isInt $cv)) -or ([long]$pv -ne [long]$cv)) { & $fail 'FAILED_JOIN_BUDGET' }
                $isCarry = ($pn -ceq 'HistoricalOutputTokens') -or ($pn -ceq 'PhaseAggregateCeiling')
                if (($isCarry -and ([long]$pv -lt 0)) -or ((-not $isCarry) -and ([long]$pv -le 0))) { & $fail 'FAILED_JOIN_BUDGET' }
            }
        }
        elseif ($observed -gt $admitted) { & $fail 'FAILED_JOIN_CAP' }

        $failedExit = & $g $term 'exitCode' 'FAILED_JOIN_EXIT'
        if ((-not (& $isInt $failedExit)) -or ([long]$failedExit -eq 0)) { & $fail 'FAILED_JOIN_EXIT' }
        $failedReason = & $g $term 'reason' 'FAILED_JOIN_EXIT'
        if ($failedReason -cne $(if ($isTok) { 'TOKEN_ACCOUNTING_STOP' } else { 'NATURAL_EXIT' })) { & $fail 'FAILED_JOIN_EXIT' }
        $sessionId = $f.Ticket.sessionId
        if (($sessionId -isnot [string]) -or ($sessionId.Length -eq 0)) { & $fail 'FAILED_JOIN_SESSION' }

        # Independent strict-UTF8 JSONL recount: sum each message's maximum once; no failure kind other than error_max_turns.
        $text = $null
        try { $text = $strict.GetString($f.StdoutBytes) } catch { $text = $null }
        if ($null -eq $text) { & $fail 'FAILED_JOIN_STREAM_UTF8' }
        $native = 0L; $curMax = 0L; $sawStart = $false; $resultCount = 0; $resultEvt = $null; $starts = 0L; $initCount = 0; $initSid = $null
        foreach ($line in $text.Split([char]10)) {
            $ln = $line.TrimEnd([char]13)
            if ([string]::IsNullOrWhiteSpace($ln)) { continue }
            if ($resultCount -gt 0) { & $fail 'FAILED_JOIN_STREAM_ORDER' }
            # Strict parse; reject duplicate property names (case-insensitive) recursively before ConvertFrom-Json.
            $dupBad = $false; $jd = $null
            try {
                $jd = [System.Text.Json.JsonDocument]::Parse($ln)
                $stk = [System.Collections.Generic.Stack[System.Text.Json.JsonElement]]::new()
                $stk.Push($jd.RootElement)
                while (($stk.Count -gt 0) -and (-not $dupBad)) {
                    $el = $stk.Pop()
                    if ($el.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                        foreach ($jp in $el.EnumerateObject()) {
                            if (-not $seen.Add($jp.Name)) { $dupBad = $true; break }
                            $stk.Push($jp.Value)
                        }
                    }
                    elseif ($el.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
                        foreach ($ji in $el.EnumerateArray()) { $stk.Push($ji) }
                    }
                }
            } catch { $dupBad = $true } finally { if ($null -ne $jd) { $jd.Dispose() } }
            if ($dupBad) { & $fail 'FAILED_JOIN_STREAM_JSON' }
            $parsed = $null
            try { $parsed = ConvertFrom-Json -InputObject $ln -DateKind String -ErrorAction Stop } catch { $parsed = $null }
            if ($parsed -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'FAILED_JOIN_STREAM_JSON' }
            $evt = $parsed
            $tp = $parsed.PSObject.Properties['type']
            if (($null -eq $tp) -or ($tp.Value -isnot [string])) { & $fail 'FAILED_JOIN_STREAM_TYPE' }
            if ($tp.Value -ceq 'stream_event') {
                $ep = $parsed.PSObject.Properties['event']
                if ($null -eq $ep) { & $fail 'FAILED_JOIN_STREAM_TYPE' }
                $evt = $ep.Value
            }
            if ($evt -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'FAILED_JOIN_STREAM_JSON' }
            $et = $evt.PSObject.Properties['type']
            if (($null -eq $et) -or ($et.Value -isnot [string])) { & $fail 'FAILED_JOIN_STREAM_TYPE' }
            if (($et.Value -is [string]) -and ($et.Value -ceq 'message_start')) {
                if ($sawStart) { $native = & $add $native $curMax 'FAILED_JOIN_OVERFLOW' }
                $sawStart = $true
                $starts = & $add $starts 1L 'FAILED_JOIN_OVERFLOW'
                $curMax = 0L
            }
            elseif (($et.Value -is [string]) -and ($et.Value -ceq 'message_delta')) {
                if (-not $sawStart) { & $fail 'FAILED_JOIN_STREAM_ORDER' }
                $up = $evt.PSObject.Properties['usage']
                if (($null -ne $up) -and ($up.Value -is [System.Management.Automation.PSCustomObject])) {
                    $op = $up.Value.PSObject.Properties['output_tokens']
                    if (($null -ne $op) -and ($null -ne $op.Value)) {
                        $ov = & $cnt $op.Value 'FAILED_JOIN_STREAM_USAGE'
                        if ($ov -gt $curMax) { $curMax = $ov }
                    }
                }
                $dp = $evt.PSObject.Properties['delta']
                if (($null -ne $dp) -and ($dp.Value -is [System.Management.Automation.PSCustomObject])) {
                    $sr = $dp.Value.PSObject.Properties['stop_reason']
                    if (($null -ne $sr) -and ($sr.Value -is [string]) -and ($sr.Value -ceq 'max_tokens') -and (-not $isTok)) { & $fail 'FAILED_JOIN_TRUNCATED' }
                }
            }
            elseif (($et.Value -is [string]) -and ($et.Value -ceq 'system')) {
                $stp = $evt.PSObject.Properties['subtype']
                if (($null -ne $stp) -and ($stp.Value -is [string]) -and ($stp.Value -ceq 'init')) {
                    $initCount++
                    $sip = $evt.PSObject.Properties['session_id']
                    if (($null -eq $sip) -or ($sip.Value -isnot [string])) { & $fail 'FAILED_JOIN_SESSION' }
                    $initSid = $sip.Value
                }
            }
            elseif (($et.Value -is [string]) -and ($et.Value -ceq 'result')) {
                $resultCount++
                $resultEvt = $evt
            }
        }
        if (-not $sawStart) { & $fail 'FAILED_JOIN_STREAM_ORDER' }
        $native = & $add $native $curMax 'FAILED_JOIN_OVERFLOW'
        $tMsgCount = & $g $acct 'messageCount' 'FAILED_JOIN_ACCOUNTING_COUNT'
        $tInBytes = & $g $acct 'inputBytes' 'FAILED_JOIN_ACCOUNTING_COUNT'
        if ((-not (& $isInt $tMsgCount)) -or ([long]$tMsgCount -lt 0) -or ([long]$tMsgCount -ne $starts)) { & $fail 'FAILED_JOIN_ACCOUNTING_COUNT' }
        if ((-not (& $isInt $tInBytes)) -or ([long]$tInBytes -lt 0) -or ([long]$tInBytes -ne $f.StdoutBytes.LongLength)) { & $fail 'FAILED_JOIN_ACCOUNTING_COUNT' }
        if ($isTok) {
            if ($resultCount -ne 0) { & $fail 'FAILED_JOIN_RESULT' }
            if (($initCount -ne 1) -or ($initSid -cne $sessionId)) { & $fail 'FAILED_JOIN_SESSION' }
            if ($native -ne $observed) { & $fail 'FAILED_JOIN_ACCOUNTING_COUNT' }
            $sdkSubtype = 'TOKEN_ACCOUNTING_STOP'
        }
        else {
        if ($resultCount -ne 1) { & $fail 'FAILED_JOIN_RESULT' }
        $sdkSubtype =& $g $resultEvt 'subtype' 'FAILED_JOIN_RESULT'
        if (($sdkSubtype -isnot [string]) -or ($sdkSubtype -cne 'error_max_turns')) { & $fail 'FAILED_JOIN_FAILURE_KIND' }
        $isErr = & $g $resultEvt 'is_error' 'FAILED_JOIN_RESULT'
        if (($isErr -isnot [bool]) -or (-not $isErr)) { & $fail 'FAILED_JOIN_RESULT' }
        $rsid = & $g $resultEvt 'session_id' 'FAILED_JOIN_RESULT'
        if (($rsid -isnot [string]) -or ($rsid -cne $sessionId)) { & $fail 'FAILED_JOIN_SESSION' }
        $ru = & $g $resultEvt 'usage' 'FAILED_JOIN_RESULT'
        $rOut = & $cnt (& $g $ru 'output_tokens' 'FAILED_JOIN_RESULT') 'FAILED_JOIN_RESULT'
        if (($rOut -ne $native) -or ($native -ne $observed)) { & $fail 'FAILED_JOIN_ACCOUNTING_COUNT' }
        }

        # Predecessor: bounded pinned read, strict receipt validation, recaptured successful advisory facts.
        $ref = [pscustomobject]@{ path = $PredecessorReceiptPath; sha256 = $ExpectedPredecessorReceiptSha256 }
        $pr = Read-ManagedPinnedEvidenceJson -Reference $ref -ControlRoot $controlRoot
        if (($null -eq $pr) -or ($pr.Sha256 -cne $ExpectedPredecessorReceiptSha256)) { & $fail 'FAILED_JOIN_PREDECESSOR' }
        $rcpt = $pr.Value
        if ($rcpt -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'FAILED_JOIN_PREDECESSOR' }
        $sv = $rcpt.PSObject.Properties['schemaVersion']
        $pa = $rcpt.PSObject.Properties['aggregateAdvisoryEvidence']
        if (($null -eq $sv) -or ($sv.Value -isnot [string]) -or ($sv.Value -cne 'OperationalRunReceipt/v1') -or ($null -eq $pa) -or ($null -eq $pa.Value)) { & $fail 'FAILED_JOIN_PREDECESSOR_UNSUPPORTED' }
        if ((Test-OperationalReceipt $rcpt) -isnot [bool] -or -not (Test-OperationalReceipt $rcpt)) { & $fail 'FAILED_JOIN_PREDECESSOR_RECEIPT' }
        $pEv = $pa.Value
        $pf = Get-ManagedNativeAdvisoryBudgetFacts -Evidence $pEv
        if (($pf.Valid -isnot [bool]) -or (-not $pf.Valid) -or ($pf.Facts.mode -cne 'AUTHENTICATED_ADVISORY')) { & $fail 'FAILED_JOIN_PREDECESSOR_FACTS' }
        $pcap = Get-ManagedNativeCapturedFacts -ManifestPath ([string]$pEv.manifestPath) -ExpectedManifestSha256 ([string]$pEv.manifestSha256) -TerminalPath ([string]$pEv.terminalPath) -ExpectedTerminalSha256 ([string]$pEv.terminalSha256) -TicketPath ([string]$pEv.ticketPath) -RunId ([string]$pEv.runId) -Attempt ([int]$pEv.attempt)
        if (($pcap.Valid -isnot [bool]) -or (-not $pcap.Valid)) { & $fail 'FAILED_JOIN_PREDECESSOR_FACTS' }
        $pc = $pcap.Facts
        $priorUsed = [long]$pf.Facts.actualUsed
        $pAcct = & $g $pc.Terminal 'tokenAccounting' 'FAILED_JOIN_PREDECESSOR_FACTS'
        $pObserved = & $cnt (& $g $pAcct 'observedOutputTokens' 'FAILED_JOIN_PREDECESSOR_FACTS') 'FAILED_JOIN_PREDECESSOR_FACTS'
        if (($priorUsed -ne [long]$rcpt.budget.usedOutputTokens) -or ([string]$rcpt.runId -cne [string]$pEv.runId) -or ([long]$rcpt.attempt -ne [long]$pEv.attempt) -or ([string]$pc.RunId -cne [string]$pEv.runId)) { & $fail 'FAILED_JOIN_PREDECESSOR_COUNT' }
        if ([long]$pf.Facts.historical -gt $priorUsed) { & $fail 'FAILED_JOIN_PREDECESSOR_COUNT' }

        # Ordered history: failed descriptor must be exactly predecessor history plus the predecessor terminal; failed identity must be absent.
        $pHist = & $histOf $pc.Ticket 'FAILED_JOIN_PREDECESSOR_HISTORY'
        $fHist = & $histOf $f.Ticket 'FAILED_JOIN_HISTORY'
        $expect = [System.Collections.Generic.List[object]]::new()
        foreach ($r in $pHist) { $expect.Add((& $norm $r 'FAILED_JOIN_PREDECESSOR_HISTORY')) }
        $expect.Add([pscustomobject]@{ run = [string]$pEv.runId; req = [string]$pc.RequestSha256; path = [string]$pc.TerminalPath; sha = [string]$pc.TerminalSha256; out = $pObserved })
        $actual = [System.Collections.Generic.List[object]]::new()
        foreach ($r in $fHist) { $actual.Add((& $norm $r 'FAILED_JOIN_HISTORY')) }
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $seenPath = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($a in $actual) {
            if ((-not $seen.Add('run:' + $a.run)) -or (-not $seen.Add('req:' + $a.req)) -or (-not $seen.Add('sha:' + $a.sha)) -or (-not $seenPath.Add($a.path))) { & $fail 'FAILED_JOIN_DUPLICATE' }
        }
        $fRun = [string]$FailedEvidence.runId
        $fReq = [string]$f.RequestSha256
        if ($seen.Contains('run:' + $fRun) -or $seen.Contains('req:' + $fReq) -or $seen.Contains('sha:' + [string]$f.TerminalSha256) -or $seenPath.Contains([string]$f.TerminalPath)) { & $fail 'FAILED_JOIN_DUPLICATE' }
        if (($fRun -ceq [string]$pEv.runId) -and ([long]$fAtt -eq [long]$pEv.attempt)) { & $fail 'FAILED_JOIN_DUPLICATE' }
        if ($actual.Count -ne $expect.Count) { & $fail 'FAILED_JOIN_PREFIX' }
        for ($i = 0; $i -lt $expect.Count; $i++) {
            $x = $expect[$i]; $y = $actual[$i]
            if (($x.run -cne $y.run) -or ($x.req -cne $y.req) -or ($x.path -cne $y.path) -or ($x.sha -cne $y.sha) -or ($x.out -ne $y.out)) { & $fail 'FAILED_JOIN_PREFIX' }
        }
        if (([long]$snap.HistoryRunCount -ne [long]$actual.Count) -or ($historical -ne $priorUsed)) { & $fail 'FAILED_JOIN_HISTORY' }

        $newUnique = $observed
        $actualUsed = & $add $priorUsed $newUnique 'FAILED_JOIN_OVERFLOW'
        $uniqueCount = [long]$actual.Count + 1

        # Recheck predecessor bytes and failed captured inventory before returning.
        $pr2 = Read-ManagedPinnedEvidenceJson -Reference $ref -ControlRoot $controlRoot
        if (($null -eq $pr2) -or ($pr2.Sha256 -cne $pr.Sha256) -or ($pr2.Length -ne $pr.Length)) { & $fail 'FAILED_JOIN_STALE' }
        $fcap2 = Get-ManagedNativeCapturedFacts @capArgs -ForFailedAccounting
        if (($fcap2.Valid -isnot [bool]) -or $fcap2.Valid -or ($fcap2.Code -cne $capCode) -or ($null -eq $fcap2.FailureCapture)) { & $fail 'FAILED_JOIN_STALE' }
        if ((& $inventory $fcap2.FailureCapture) -cne (& $inventory $f)) { & $fail 'FAILED_JOIN_STALE' }

        $joinResult = [pscustomobject]@{
            Joined = $true
            Code = $null
            Join = [pscustomobject]@{
                schema = 'FailedNativeAccountingJoin/v1'
                status = 'FAILED_ACCOUNTING_ONLY'
                noDispatch = $true
                noCompletion = $true
                priorUsed = $priorUsed
                newUniqueOutput = $newUnique
                actualUsed = $actualUsed
                uniqueManagedTerminalCount = $uniqueCount
                failedExitCode = [long]$failedExit
                failedReason = [string]$failedReason
                SDKSubtype = [string]$sdkSubtype
                predecessor = [pscustomobject]@{ receiptPath = [string]$pr.Path; receiptSha256 = [string]$pr.Sha256; runId = [string]$pEv.runId; attempt = [long]$pEv.attempt; terminalPath = [string]$pc.TerminalPath; terminalSha256 = [string]$pc.TerminalSha256 }
                failed = [pscustomobject]@{ runId = $fRun; attempt = [long]$fAtt; requestSha256 = $fReq; manifestPath = [string]$f.ManifestPath; manifestSha256 = [string]$f.ManifestSha256; terminalPath = [string]$f.TerminalPath; terminalSha256 = [string]$f.TerminalSha256; ticketPath = [string]$f.TicketPath; ticketSha256 = [string]$f.TicketSha256 }
            }
        }
        if ($isTok) {
            $joinResult.Join.schema = 'TokenStoppedNativeAccountingJoin/v1'
            $joinResult.Join | Add-Member -NotePropertyName reason -NotePropertyValue ([string]$failedReason)
            $joinResult.Join | Add-Member -NotePropertyName firstTrigger -NotePropertyValue ([string]$firstTrig)
            $joinResult.Join | Add-Member -NotePropertyName admittedAdditional -NotePropertyValue ([long]$admitted)
            $joinResult.Join | Add-Member -NotePropertyName overshoot -NotePropertyValue ([long]$overshoot)
        }
        return $joinResult
    }
    catch {
        $m = [string]$_.Exception.Message
        $code = 'FAILED_JOIN_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', [System.StringComparison]::Ordinal) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Joined = $false; Code = $code; Join = $null }
    }
}

function Get-ManagedObservePendingAccountingFacts {
    # Read-only. Derives pending accounting for one OBSERVE_ONLY managed run joined to one selected parent receipt.
    # SELECTED_ACCOUNTING_ANCHOR: the trusted host selects the parent in its outer packet. A legacy OperationalRunReceipt/v1 parent is the
    # anchor itself and, as for the accepted root, claims no prelaunch lineage. A v3 parent is accepted only when the ACTUAL captured current
    # ticket already carried observePredecessorReceipt {path,sha256} naming it; the chain is then authenticated bottom-up to a legacy v1 anchor,
    # whose original postlaunch SELECTED_ACCOUNTING_ANCHOR provenance is preserved at the root. This verifier authenticates referenced data
    # only, never operator authorization, and grants no completion, ACK, acceptance or dispatch.
    # -FailedTransportCurrent (internal to Get-ManagedObserveFailedTransportFacts): the CURRENT node is an authenticated DEADLINE failed transport
    # capture instead of a successful observation; the parent/ancestry authentication is the same code and the result is a base for the failed facts.
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Evidence, [switch]$FailedTransportCurrent)
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    $unknown = { param([string]$c) throw [System.InvalidOperationException]::new('UNKNOWN:' + $c) }
    $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
    $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
    $clean = { param($v, [string]$d) if (($v -is [string]) -and ($v -cmatch '^[A-Z0-9_]{1,48}\z')) { return $v }; return $d }
    # Exact-ordinal NoteProperty lookup; a missing or non-object holder refuses.
    $get = {
        param($o, [string]$n, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        foreach ($q in $o.PSObject.Properties) { if (($q.MemberType -eq $note) -and [string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }
        & $fail $c
    }
    $exact = {
        param($o, [string[]]$names, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        $ps = @($o.PSObject.Properties)
        if ($ps.Count -ne $names.Count) { & $fail $c }
        foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { & $fail $c } }
    }
    $str = { param($o, [string]$n, [string]$c) $v = & $get $o $n $c; if (($v -isnot [string]) -or ($v.Length -eq 0)) { & $fail $c }; return $v }
    $lng = { param($o, [string]$n, [string]$c) $v = & $get $o $n $c; if (-not (& $isInt $v)) { & $fail $c }; return [long]$v }
    $cnt = { param($v, [string]$c) if ((-not (& $isInt $v)) -or ([long]$v -lt 0)) { & $fail $c }; return [long]$v }
    $add = { param([long]$a, [long]$b, [string]$c) if (($a -lt 0) -or ($b -lt 0) -or ($a -gt ([long]::MaxValue - $b))) { & $fail $c }; return [long]($a + $b) }
    $ticks = {
        param([string]$s, [string]$c)
        if (($s.Length -gt 40) -or ($s -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,7})?Z\z')) { & $fail $c }
        $dt = [datetime]::MinValue
        if (-not [datetime]::TryParse($s, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$dt)) { & $fail $c }
        if ($dt.Kind -ne [DateTimeKind]::Utc) { & $fail $c }
        return [long]$dt.Ticks
    }
    $inventory = {
        param($cf)
        return @($cf.Inputs | ForEach-Object { [string]$_.Role + '|' + [string]$_.State + '|' + [string]$_.Path + '|' + [string]$_.Sha256 + '|' + [string]$_.Length }) -join "`n"
    }
    $histOf = {
        param($t)
        $b = & $get $t 'budget' 'OBSPA_PREDECESSOR_HISTORY'
        $a = & $get $b 'aggregateAdvisory' 'OBSPA_PREDECESSOR_HISTORY'
        if (($a -is [System.Management.Automation.PSCustomObject]) -and ($null -ne $a.PSObject.Properties['descriptor'])) { $a = $a.descriptor }
        $h = & $get $a 'historyRuns' 'OBSPA_PREDECESSOR_HISTORY'
        if ($h -isnot [object[]]) { & $fail 'OBSPA_PREDECESSOR_HISTORY' }
        return , $h
    }
    $sig = {
        param($c)
        $sb = [System.Text.StringBuilder]::new()
        foreach ($f in @('RunId', 'Attempt', 'SessionId', 'Pid', 'TransportExitCode', 'ManifestPath', 'ManifestSha256', 'TerminalPath', 'TerminalSha256', 'TicketPath', 'TicketSha256', 'StartPath', 'StartSha256', 'RequestSha256', 'StdoutLength', 'StderrLength', 'ArtifactPath', 'ArtifactState')) {
            [void]$sb.Append($f).Append('=').Append([string](& $get $c $f 'OBSPA_CAPTURE_FIELD')).Append([char]10)
        }
        foreach ($e in @($c.Inputs)) { [void]$sb.Append('I|' + [string]$e.Role + '|' + [string]$e.State + '|' + [string]$e.Path + '|' + [string]$e.Sha256 + '|' + [string]$e.Length).Append([char]10) }
        foreach ($e in @($c.StreamedInputs)) { [void]$sb.Append('S|' + [string]$e.Role + '|' + [string]$e.Path + '|' + [string]$e.Sha256 + '|' + [string]$e.Length).Append([char]10) }
        foreach ($e in @($c.VerifiedReferences)) { [void]$sb.Append('V|' + [string]$e.Role + '|' + [string]$e.Path + '|' + [string]$e.VerifiedSha256 + '|' + [string]$e.VerifiedLength).Append([char]10) }
        return $sb.ToString()
    }

    # Exact ordinal parse of one ManagedObservePendingAccountingEvidence/v1 DTO (caller evidence or a stored v3 receipt's embedded evidence).
    $parseEv = {
        param($Ev)
        & $exact $Ev @('schema', 'current', 'predecessorReceipt') 'OBSPA_EVIDENCE_SHAPE'
        $evSchema = & $get $Ev 'schema' 'OBSPA_EVIDENCE_SHAPE'
        if (($evSchema -isnot [string]) -or ($evSchema -cne 'ManagedObservePendingAccountingEvidence/v1')) { & $fail 'OBSPA_EVIDENCE_SCHEMA' }
        $cur = & $get $Ev 'current' 'OBSPA_EVIDENCE_SHAPE'
        & $exact $cur @('schema', 'manifestPath', 'manifestSha256', 'terminalPath', 'terminalSha256', 'ticketPath', 'runId', 'attempt') 'OBSPA_CURRENT_SHAPE'
        if ((& $get $cur 'schema' 'OBSPA_CURRENT_SHAPE') -cne 'ManagedNativeAdvisoryEvidence/v1') { & $fail 'OBSPA_CURRENT_SCHEMA' }
        $mp = & $str $cur 'manifestPath' 'OBSPA_CURRENT_FIELD'
        $tp = & $str $cur 'terminalPath' 'OBSPA_CURRENT_FIELD'
        $kp = & $str $cur 'ticketPath' 'OBSPA_CURRENT_FIELD'
        $rid = & $str $cur 'runId' 'OBSPA_CURRENT_FIELD'
        $ms = & $get $cur 'manifestSha256' 'OBSPA_CURRENT_PIN'
        $ts = & $get $cur 'terminalSha256' 'OBSPA_CURRENT_PIN'
        if ((-not (& $isHex $ms)) -or (-not (& $isHex $ts))) { & $fail 'OBSPA_CURRENT_PIN' }
        $at = & $get $cur 'attempt' 'OBSPA_CURRENT_ATTEMPT'
        if ((-not (& $isInt $at)) -or ([long]$at -lt 1) -or ([long]$at -gt [long][int]::MaxValue)) { & $fail 'OBSPA_CURRENT_ATTEMPT' }
        $pre = & $get $Ev 'predecessorReceipt' 'OBSPA_EVIDENCE_SHAPE'
        & $exact $pre @('path', 'sha256') 'OBSPA_PREDECESSOR_SHAPE'
        $pp = & $str $pre 'path' 'OBSPA_PREDECESSOR_SHAPE'
        $ps = & $get $pre 'sha256' 'OBSPA_PREDECESSOR_PIN'
        if (-not (& $isHex $ps)) { & $fail 'OBSPA_PREDECESSOR_PIN' }
        return @{ mPath = $mp; mSha = $ms; tPath = $tp; tSha = $ts; kPath = $kp; runId = $rid; attempt = [int][long]$at; prePath = $pp; preSha = $ps }
    }
    $mkCurOf = { param($pe) [pscustomobject]([ordered]@{ schema = 'ManagedNativeAdvisoryEvidence/v1'; manifestPath = $pe.mPath; manifestSha256 = $pe.mSha; terminalPath = $pe.tPath; terminalSha256 = $pe.tSha; ticketPath = $pe.kPath; runId = $pe.runId; attempt = [long]$pe.attempt }) }
    $selectionOf = { param($pe) [pscustomobject]([ordered]@{ schema = 'ManagedObservePendingAccountingEvidence/v1'; current = (& $mkCurOf $pe); predecessorReceipt = [pscustomobject]([ordered]@{ path = $pe.prePath; sha256 = $pe.preSha }) }) }
    # Optional exact-ordinal predecessor reference carried by the ACTUAL captured ticket; absent => $null. Present-but-malformed (or case-aliased) refuses.
    $ticketRefOf = {
        param($tk)
        if ($tk -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSPA_TICKET_PREDECESSOR' }
        $found = $null
        foreach ($q in $tk.PSObject.Properties) {
            if ([string]::Equals([string]$q.Name, 'observePredecessorReceipt', $ord)) {
                if (($q.MemberType -ne $note) -or ($null -ne $found)) { & $fail 'OBSPA_TICKET_PREDECESSOR' }
                $found = $q
            }
            elseif ([string]::Equals([string]$q.Name, 'observePredecessorReceipt', [System.StringComparison]::OrdinalIgnoreCase)) { & $fail 'OBSPA_TICKET_PREDECESSOR' }
        }
        if ($null -eq $found) { return , $null }
        $rv = $found.Value
        & $exact $rv @('path', 'sha256') 'OBSPA_TICKET_PREDECESSOR'
        $rp = & $get $rv 'path' 'OBSPA_TICKET_PREDECESSOR'
        $rs = & $get $rv 'sha256' 'OBSPA_TICKET_PREDECESSOR'
        if (($rp -isnot [string]) -or ($rp.Length -eq 0) -or (-not (& $isHex $rs))) { & $fail 'OBSPA_TICKET_PREDECESSOR' }
        return , @{ path = [string]$rp; sha256 = [string]$rs }
    }
    $ticketBound = {
        param($tk, [string]$path, [string]$sha, [bool]$required)
        $r = & $ticketRefOf $tk
        if ($null -eq $r) { if ($required) { & $fail 'OBSPA_TICKET_PREDECESSOR_MISSING' }; return }
        if (($r.path -cne $path) -or ($r.sha256 -cne $sha)) { & $fail 'OBSPA_TICKET_PREDECESSOR_MISMATCH' }
    }

    $F = $FailedTransportCurrent.IsPresent
    try {
        $pe0 = & $parseEv $Evidence
        $mPath = $pe0.mPath; $mSha = $pe0.mSha; $tPath = $pe0.tPath; $tSha = $pe0.tSha; $kPath = $pe0.kPath; $runId = $pe0.runId
        $attempt = $pe0.attempt; $prePath = $pe0.prePath; $preSha = $pe0.preSha
        $mkCur = { & $mkCurOf $pe0 }
        $selection = & $selectionOf $pe0

        # ---- trusted sibling declarations only; nothing is loaded from the captured workingDirectory ----
        try {
            . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-sdk-observation.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-output-observation.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'continuity\reconcile.ps1')
        } catch { & $fail 'OBSPA_SIBLING_UNAVAILABLE' }

        $captureFor = {
            param($pe, [bool]$failedCur = $false)
            if ($failedCur) {
                $r = Get-ManagedNativeCapturedFacts -ManifestPath $pe.mPath -ExpectedManifestSha256 $pe.mSha -TerminalPath $pe.tPath -ExpectedTerminalSha256 $pe.tSha -TicketPath $pe.kPath -RunId $pe.runId -Attempt $pe.attempt -ForFailedTransportObservation
            } else {
                $r = Get-ManagedNativeCapturedFacts -ManifestPath $pe.mPath -ExpectedManifestSha256 $pe.mSha -TerminalPath $pe.tPath -ExpectedTerminalSha256 $pe.tSha -TicketPath $pe.kPath -RunId $pe.runId -Attempt $pe.attempt -ForOutputObservation
            }
            if ((@($r).Count -ne 1) -or ($r -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSPA_CAPTURE_SHAPE' }
            $valid = & $get $r 'Valid' 'OBSPA_CAPTURE_SHAPE'
            $code = & $get $r 'Code' 'OBSPA_CAPTURE_SHAPE'
            $facts = & $get $r 'Facts' 'OBSPA_CAPTURE_SHAPE'
            if (($valid -isnot [bool]) -or $valid -or ($null -ne $facts)) { & $fail (& $clean $code 'OBSPA_CAPTURE_REFUSED') }
            if ($code -ceq 'OBSERVE_ONLY_CAPTURE_UNKNOWN') { & $unknown 'CAPTURE_UNKNOWN' }
            $wantCode = if ($failedCur) { 'OBSERVE_ONLY_FAILED_TRANSPORT_CAPTURE' } else { 'OBSERVE_ONLY_TRANSPORT_CAPTURE' }
            if ($code -cne $wantCode) { & $fail (& $clean $code 'OBSPA_CAPTURE_REFUSED') }
            $oc = & $get $r 'ObservationCapture' 'OBSPA_CAPTURE_SHAPE'
            if ($oc -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSPA_CAPTURE_SHAPE' }
            return , $oc
        }

        # Identity, limits and timing of one captured node (verbatim derivation, parameterised so ancestry nodes reuse it).
        $bindNode = {
            param($c, $pe, [bool]$failedCur = $false)
            $runId = $pe.runId; $attempt = $pe.attempt; $mPath = $pe.mPath; $mSha = $pe.mSha; $tPath = $pe.tPath; $tSha = $pe.tSha; $kPath = $pe.kPath
        if (((& $get $c 'RunId' 'OBSPA_CAPTURE_FIELD') -cne $runId) -or ((& $lng $c 'Attempt' 'OBSPA_CAPTURE_FIELD') -ne [long]$attempt)) { & $fail 'OBSPA_IDENTITY_MISMATCH' }
        foreach ($p in @(@('ManifestPath', $mPath), @('ManifestSha256', $mSha), @('TerminalPath', $tPath), @('TerminalSha256', $tSha), @('TicketPath', $kPath))) {
            if ((& $get $c $p[0] 'OBSPA_CAPTURE_FIELD') -cne $p[1]) { & $fail 'OBSPA_IDENTITY_MISMATCH' }
        }
        $ticket = & $get $c 'Ticket' 'OBSPA_CAPTURE_FIELD'
        $core = & $get $c 'Core' 'OBSPA_CAPTURE_FIELD'
        $term = & $get $c 'Terminal' 'OBSPA_CAPTURE_FIELD'
        $start = & $get $c 'Start' 'OBSPA_CAPTURE_FIELD'
        $cbud = & $get $c 'Budget' 'OBSPA_CAPTURE_FIELD'
        $auth = & $get $c 'Authority' 'OBSPA_CAPTURE_FIELD'
        if (((& $get $auth 'Schema' 'OBSPA_AUTHORITY') -cne 'ManagedOutputStopAuthority/v1') -or ((& $get $auth 'Mode' 'OBSPA_AUTHORITY') -cne 'OBSERVE_ONLY')) { & $fail 'OBSPA_AUTHORITY' }
        if (((& $str $core 'outputStopProfile' 'OBSPA_CORE_PROFILE') -cne 'observe-only-v1') -or ($null -ne (& $get $core 'maxStreamBytes' 'OBSPA_CORE_PROFILE'))) { & $fail 'OBSPA_CORE_PROFILE' }
        $taskId = & $str $ticket 'id' 'OBSPA_TICKET_FIELD'
        $payloadSha = & $get $ticket 'payloadSha256' 'OBSPA_TICKET_FIELD'
        $sessionId = & $str $ticket 'sessionId' 'OBSPA_TICKET_FIELD'
        if ((-not (& $isHex $payloadSha)) -or ($payloadSha -cne (& $get $core 'payloadSha256' 'OBSPA_CORE_FIELD')) -or ($sessionId -cne (& $get $c 'SessionId' 'OBSPA_CAPTURE_FIELD'))) { & $fail 'OBSPA_TICKET_BINDING' }
        if (((& $get $core 'runId' 'OBSPA_CORE_FIELD') -cne $runId) -or ((& $lng $core 'attempt' 'OBSPA_CORE_FIELD') -ne [long]$attempt)) { & $fail 'OBSPA_IDENTITY_MISMATCH' }
        # Actual ticket carries top-level maxAttempts; no budget alias is assumed.
        $maxAttempts = & $lng $ticket 'maxAttempts' 'OBSPA_MAXATTEMPTS'
        if (($maxAttempts -le 0) -or ([long]$attempt -gt $maxAttempts)) { & $fail 'OBSPA_ATTEMPT_LIMIT' }
        # Exact null core ceiling = NO TOTAL AUTHOR DEADLINE; valid only when the independently authenticated capture Budget.ElapsedMs is also null and never for a failed (DEADLINE) current.
        $meRaw = & $get $core 'maxElapsedMs' 'OBSPA_MAXELAPSED'
        if ($null -eq $meRaw) {
            if ($failedCur -or ($null -ne (& $get $cbud 'ElapsedMs' 'OBSPA_MAXELAPSED'))) { & $fail 'OBSPA_MAXELAPSED' }
            $maxElapsed = $null
        } else {
            if (($null -ne (& $get $cbud 'ElapsedMs' 'OBSPA_MAXELAPSED')) -ne $true) { & $fail 'OBSPA_MAXELAPSED' }
            $maxElapsed = & $lng $core 'maxElapsedMs' 'OBSPA_MAXELAPSED'
            if ($maxElapsed -le 0) { & $fail 'OBSPA_MAXELAPSED' }
        }
        $pid1 = & $lng $c 'Pid' 'OBSPA_CAPTURE_FIELD'
        if (($pid1 -le 0) -or ((& $lng $term 'pid' 'OBSPA_TERMINAL_FIELD') -ne $pid1) -or ((& $lng $start 'pid' 'OBSPA_START_FIELD') -ne $pid1)) { & $fail 'OBSPA_PID_MISMATCH' }
        $startUtc = & $str $term 'startTimeUtc' 'OBSPA_TERMINAL_FIELD'
        $endUtc = & $str $term 'endedUtc' 'OBSPA_TERMINAL_FIELD'
        if ((& $str $start 'startTimeUtc' 'OBSPA_START_FIELD') -cne $startUtc) { & $fail 'OBSPA_START_MISMATCH' }
        $termReason = & $str $term 'reason' 'OBSPA_TERMINAL_FIELD'
        $termExit = & $lng $term 'exitCode' 'OBSPA_TERMINAL_FIELD'
        if ($failedCur) {
            if (($termReason -cne 'DEADLINE') -or ($termExit -eq 0) -or ((& $lng $c 'TransportExitCode' 'OBSPA_CAPTURE_FIELD') -ne $termExit)) { & $fail 'OBSPA_TERMINAL_STATE' }
        }
        elseif (($termReason -cne 'NATURAL_EXIT') -or ($termExit -ne 0) -or ((& $lng $c 'TransportExitCode' 'OBSPA_CAPTURE_FIELD') -ne 0)) { & $fail 'OBSPA_TERMINAL_STATE' }
        $t0 = & $ticks $startUtc 'OBSPA_START_UTC'
        $t1 = & $ticks $endUtc 'OBSPA_END_UTC'
        if ($t1 -lt $t0) { & $fail 'OBSPA_TIME_ORDER' }
        $dTicks = [long]($t1 - $t0)
        $usedElapsed = [long](($dTicks - ($dTicks % 10000L)) / 10000L)
        if (($dTicks % 10000L) -ne 0) { $usedElapsed = & $add $usedElapsed 1L 'OBSPA_ELAPSED_OVERFLOW' }
        if ((-not $failedCur) -and ($null -ne $maxElapsed) -and ($usedElapsed -gt $maxElapsed)) { & $fail 'OBSPA_ELAPSED_EXCEEDS' }
        $reqSha = & $get $c 'RequestSha256' 'OBSPA_CAPTURE_FIELD'
        if (-not (& $isHex $reqSha)) { & $fail 'OBSPA_CAPTURE_FIELD' }
        if (($null -ne (& $get $cbud 'AdditionalOutputMax' 'OBSPA_BUDGET')) -or ($null -ne (& $get $cbud 'PhaseAggregateCeiling' 'OBSPA_BUDGET'))) { & $fail 'OBSPA_BUDGET' }
        $curHist = & $cnt (& $get $cbud 'HistoricalOutputTokens' 'OBSPA_BUDGET') 'OBSPA_BUDGET'
            return @{ ticket = $ticket; core = $core; term = $term; start = $start; cbud = $cbud; taskId = $taskId; payloadSha = $payloadSha; sessionId = $sessionId; maxAttempts = $maxAttempts; maxElapsed = $maxElapsed; pid1 = $pid1; startUtc = $startUtc; endUtc = $endUtc; termReason = $termReason; termExit = [long]$termExit; usedElapsed = $usedElapsed; reqSha = $reqSha; curHist = $curHist }
        }

        # Shared read-only SDK observation of one captured node; null/UNKNOWN never becomes zero.
        $observeNode = {
            param($c, $pe, [long]$curHist)
            $curDto = & $mkCurOf $pe
        $obs = Get-ManagedNativeOutputObservation -Evidence $curDto
        if ((@($obs).Count -ne 1) -or ($obs -isnot [System.Management.Automation.PSCustomObject]) -or ((& $get $obs 'Schema' 'OBSPA_OBSERVATION_SHAPE') -cne 'ManagedNativeOutputObservation/v1')) { & $fail 'OBSPA_OBSERVATION_SHAPE' }
        foreach ($fl in @('NoAcceptedUsage', 'NoReceipt', 'NoCompletion', 'NoDispatch')) {
            $fv = & $get $obs $fl 'OBSPA_OBSERVATION_SHAPE'
            if (($fv -isnot [bool]) -or (-not $fv)) { & $fail 'OBSPA_OBSERVATION_SHAPE' }
        }
        $oStatus = & $get $obs 'Status' 'OBSPA_OBSERVATION_SHAPE'
        $oCode = & $get $obs 'Code' 'OBSPA_OBSERVATION_SHAPE'
        if ($oStatus -ceq 'UNKNOWN') { & $unknown (& $clean $oCode 'OBSERVATION_UNKNOWN') }
        if ($oStatus -ceq 'INVALID') { & $fail (& $clean $oCode 'OBSPA_OBSERVATION_INVALID') }
        if ($oStatus -cne 'OBSERVED') { & $fail 'OBSPA_OBSERVATION_SHAPE' }
        $oEv = & $get $obs 'Evidence' 'OBSPA_OBSERVATION_SHAPE'
        if ((ConvertTo-Json -InputObject $oEv -Compress -Depth 4) -cne (ConvertTo-Json -InputObject $curDto -Compress -Depth 4)) { & $fail 'OBSPA_OBSERVATION_EVIDENCE' }
        $sdk = & $get $obs 'SdkObservation' 'OBSPA_OBSERVATION_SHAPE'
        if (((& $get $sdk 'Schema' 'OBSPA_SDK_SHAPE') -cne 'ManagedNativeSdkObservation/v1') -or ((& $get $sdk 'Status' 'OBSPA_SDK_SHAPE') -cne 'OBSERVED')) { & $fail 'OBSPA_SDK_SHAPE' }
        foreach ($fl in @('NoAcceptedUsage', 'NoReceipt', 'NoCompletion', 'NoDispatch')) {
            $fv = & $get $sdk $fl 'OBSPA_SDK_SHAPE'
            if (($fv -isnot [bool]) -or (-not $fv)) { & $fail 'OBSPA_SDK_SHAPE' }
        }
        if ((& $get $sdk 'SdkOutcome' 'OBSPA_SDK_SHAPE') -cne 'SUCCESS') { & $fail 'OBSPA_SDK_NOT_SUCCESS' }
        $recStatus = & $get $sdk 'RecountStatus' 'OBSPA_SDK_SHAPE'
        $consistency = & $get $sdk 'Consistency' 'OBSPA_SDK_SHAPE'
        $reported = & $get $sdk 'SdkReportedOutputTokens' 'OBSPA_SDK_SHAPE'
        $recount = & $get $sdk 'RecountedOutputTokens' 'OBSPA_SDK_SHAPE'
        # Incomplete observation is UNKNOWN with null counts, never zero.
        if (($recStatus -ceq 'UNAVAILABLE') -or ($consistency -ceq 'UNAVAILABLE') -or ($null -eq $reported) -or ($null -eq $recount)) { & $unknown 'RECOUNT_INCOMPLETE' }
        if (($recStatus -cne 'COMPLETE') -or ($consistency -cne 'MATCH')) { & $fail 'OBSPA_SDK_RECOUNT' }
        $observed = & $cnt $recount 'OBSPA_SDK_RECOUNT'
        if ((& $cnt $reported 'OBSPA_SDK_RECOUNT') -ne $observed) { & $fail 'OBSPA_SDK_RECOUNT' }
        $starts = & $cnt (& $get $sdk 'MessageStarts' 'OBSPA_SDK_SHAPE') 'OBSPA_SDK_SHAPE'
        if ($starts -lt 1) { & $fail 'OBSPA_SDK_RECOUNT' }
        $vr = & $get $sdk 'VerifiedRaw' 'OBSPA_SDK_SHAPE'
        $leaf = @(@($c.VerifiedReferences) | Where-Object { $_.Role -ceq 'STDOUT' })
        # The ordinal getter returns the reference array as one object; enumerate the array itself, then filter by exact Role.
        $oRefs = & $get $obs 'VerifiedReferences' 'OBSPA_OBSERVATION_SHAPE'
        if ($oRefs -isnot [object[]]) { & $fail 'OBSPA_STDOUT_LEAF' }
        $oLeaf = @($oRefs | Where-Object { ($_ -is [System.Management.Automation.PSCustomObject]) -and ($_.Role -ceq 'STDOUT') })
        if (($leaf.Count -ne 1) -or ($oLeaf.Count -ne 1) -or ($null -eq $vr)) { & $fail 'OBSPA_STDOUT_LEAF' }
        $leaf = $leaf[0]
        if (($oLeaf[0].Path -cne $leaf.Path) -or ($oLeaf[0].VerifiedSha256 -cne $leaf.VerifiedSha256) -or ([long]$oLeaf[0].VerifiedLength -ne [long]$leaf.VerifiedLength) -or ((& $get $vr 'Path' 'OBSPA_STDOUT_LEAF') -cne $leaf.Path) -or ((& $get $vr 'Sha256' 'OBSPA_STDOUT_LEAF') -cne $leaf.VerifiedSha256) -or ((& $lng $vr 'Length' 'OBSPA_STDOUT_LEAF') -ne [long]$leaf.VerifiedLength)) { & $fail 'OBSPA_STDOUT_LEAF' }
        $used = & $add $curHist $observed 'OBSPA_OVERFLOW'
            return @{ observed = $observed; leaf = $leaf; used = $used }
        }
        $sameCapture = { param($x, $y) (& $sig $x) -ceq (& $sig $y) }

        $c = & $captureFor $pe0 $F
        $b = & $bindNode $c $pe0 $F
        $ticket = $b.ticket; $core = $b.core; $term = $b.term; $taskId = $b.taskId; $payloadSha = $b.payloadSha; $sessionId = $b.sessionId
        $maxAttempts = $b.maxAttempts; $maxElapsed = $b.maxElapsed; $pid1 = $b.pid1; $startUtc = $b.startUtc; $endUtc = $b.endUtc
        $termReason = $b.termReason; $usedElapsed = $b.usedElapsed; $reqSha = $b.reqSha; $curHist = $b.curHist

        # ---- selected parent: pinned receipt, authenticated through its own recapture ----
        $wd = & $str $core 'workingDirectory' 'OBSPA_CORE_FIELD'
        $controlRoot = [IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')
        $readRef = {
            param([string]$rp, [string]$rs)
            $x = $null
            try { $x = Read-ManagedPinnedEvidenceJson -Reference ([pscustomobject]@{ path = $rp; sha256 = $rs }) -ControlRoot $controlRoot } catch { $x = $null }
            if (($null -eq $x) -or ($x.Sha256 -cne $rs) -or ($x.Path -cne $rp)) { & $fail 'OBSPA_PREDECESSOR_UNREADABLE' }
            return , $x
        }
        $readPre = { & $readRef $prePath $preSha }
        $pr = & $readPre
        $rcpt0 = $pr.Value
        if ($rcpt0 -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSPA_PREDECESSOR_UNREADABLE' }
        $sv0 = & $get $rcpt0 'schemaVersion' 'OBSPA_PREDECESSOR_UNSUPPORTED'
        $isV3 = ($sv0 -is [string]) -and ($sv0 -ceq 'OperationalRunReceipt/v3')
        # Parent binding exists only if the ACTUAL captured current ticket already carried it. A v3 parent requires it; a legacy anchor may omit it.
        & $ticketBound $ticket $prePath $preSha ($isV3 -or $F)

        # Legacy v1 advisory anchor authentication (unchanged logic), parameterised by one pinned read.
        $authAnchor = {
            param($pr)
            $rcpt = $pr.Value
            if ($rcpt -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSPA_PREDECESSOR_UNREADABLE' }
            $sv = & $get $rcpt 'schemaVersion' 'OBSPA_PREDECESSOR_UNSUPPORTED'
            $pa = & $get $rcpt 'aggregateAdvisoryEvidence' 'OBSPA_PREDECESSOR_UNSUPPORTED'
            if (($sv -isnot [string]) -or ($sv -cne 'OperationalRunReceipt/v1') -or ($null -eq $pa)) { & $fail 'OBSPA_PREDECESSOR_UNSUPPORTED' }
            foreach ($q in $rcpt.PSObject.Properties) {
                if (@('observePendingAccountingEvidence', 'observePendingAccounting', 'outputStopMode') -contains [string]$q.Name) { & $fail 'OBSPA_PREDECESSOR_UNSUPPORTED' }
            }
            $pv = Test-OperationalReceipt $rcpt
            if (($pv -isnot [bool]) -or (-not $pv)) { & $fail 'OBSPA_PREDECESSOR_RECEIPT' }
            $pf = Get-ManagedNativeAdvisoryBudgetFacts -Evidence $pa
            if (($pf.Valid -isnot [bool]) -or (-not $pf.Valid) -or ($pf.Facts.mode -cne 'AUTHENTICATED_ADVISORY')) { & $fail 'OBSPA_PREDECESSOR_FACTS' }
            $pEv = $pf.Facts.evidence
            $pcapArgs = @{ ManifestPath = [string]$pEv.manifestPath; ExpectedManifestSha256 = [string]$pEv.manifestSha256; TerminalPath = [string]$pEv.terminalPath; ExpectedTerminalSha256 = [string]$pEv.terminalSha256; TicketPath = [string]$pEv.ticketPath; RunId = [string]$pEv.runId; Attempt = [int]$pEv.attempt }
            $pcap = Get-ManagedNativeCapturedFacts @pcapArgs
            if (($pcap.Valid -isnot [bool]) -or (-not $pcap.Valid)) { & $fail 'OBSPA_PREDECESSOR_FACTS' }
            $pc = $pcap.Facts
            $priorUsed = & $cnt $pf.Facts.actualUsed 'OBSPA_PREDECESSOR_COUNT'
            $pAcct = & $get $pc.Terminal 'tokenAccounting' 'OBSPA_PREDECESSOR_COUNT'
            $pObserved = & $cnt (& $get $pAcct 'observedOutputTokens' 'OBSPA_PREDECESSOR_COUNT') 'OBSPA_PREDECESSOR_COUNT'
            $rBud = & $get $rcpt 'budget' 'OBSPA_PREDECESSOR_COUNT'
            if (($priorUsed -ne (& $cnt (& $get $rBud 'usedOutputTokens' 'OBSPA_PREDECESSOR_COUNT') 'OBSPA_PREDECESSOR_COUNT')) -or ([string](& $get $rcpt 'runId' 'OBSPA_PREDECESSOR_COUNT') -cne [string]$pEv.runId) -or ((& $lng $rcpt 'attempt' 'OBSPA_PREDECESSOR_COUNT') -ne [long]$pEv.attempt) -or ([string]$pc.RunId -cne [string]$pEv.runId)) { & $fail 'OBSPA_PREDECESSOR_COUNT' }
            if ((& $add ([long]$pf.Facts.historical) $pObserved 'OBSPA_OVERFLOW') -ne $priorUsed) { & $fail 'OBSPA_PREDECESSOR_COUNT' }
            return @{ rcpt = $rcpt; pf = $pf; pEv = $pEv; pc = $pc; pcapArgs = $pcapArgs; priorUsed = $priorUsed }
        }
        # Authenticated history sessions: pinned bytes only (verbatim).
        $histSession = {
            param($h)
            $rid = [string](& $get $h 'runId' 'OBSPA_HISTORY_SESSION')
            $hreq = [string](& $get $h 'requestSha256' 'OBSPA_HISTORY_SESSION')
            $htr = & $get $h 'terminalRef' 'OBSPA_HISTORY_SESSION'
            $htp = [string](& $get $htr 'path' 'OBSPA_HISTORY_SESSION')
            $hts = [string](& $get $htr 'sha256' 'OBSPA_HISTORY_SESSION')
            $sha = { param([string]$t) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.UTF8Encoding]::new($false, $true).GetBytes($t))).ToLowerInvariant() }
            # Pinned bytes only: terminal by its history pin, manifest by the terminal's pin, ticket by the core's pin; no scan, no added DTO property.
            $rd = {
                param([string]$p, [string]$s)
                if (-not (& $isHex $s)) { & $fail 'OBSPA_HISTORY_SESSION' }
                $x = $null
                try { $x = Read-ManagedPinnedEvidenceJson -Reference ([pscustomobject]@{ path = $p; sha256 = $s }) -ControlRoot $controlRoot } catch { $x = $null }
                if (($null -eq $x) -or ($x.Sha256 -cne $s) -or ($x.Value -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSPA_HISTORY_SESSION' }
                return $x.Value
            }
            $t = & $rd $htp $hts
            if (((& $get $t 'schema' 'OBSPA_HISTORY_SESSION') -cne 'ManagedNativeTerminal/v1') -or ((& $get $t 'runId' 'OBSPA_HISTORY_SESSION') -cne $rid) -or ((& $get $t 'requestSha256' 'OBSPA_HISTORY_SESSION') -cne $hreq)) { & $fail 'OBSPA_HISTORY_SESSION' }
            $mp = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($htp), 'manifest.json')
            $m = & $rd $mp ([string](& $get $t 'manifestSha256' 'OBSPA_HISTORY_SESSION'))
            if (((& $get $m 'schema' 'OBSPA_HISTORY_SESSION') -cne 'ManagedNativeCollector/v1') -or ((& $get $m 'requestSha256' 'OBSPA_HISTORY_SESSION') -cne $hreq)) { & $fail 'OBSPA_HISTORY_SESSION' }
            $canon = & $get $m 'requestCanonical' 'OBSPA_HISTORY_SESSION'
            if (($canon -isnot [string]) -or ((& $sha $canon) -cne $hreq)) { & $fail 'OBSPA_HISTORY_SESSION' }
            $hcore = $null
            try { $hcore = ConvertFrom-Json -InputObject $canon -DateKind String -ErrorAction Stop } catch { $hcore = $null }
            if (($hcore -isnot [System.Management.Automation.PSCustomObject]) -or ((& $get $hcore 'runId' 'OBSPA_HISTORY_SESSION') -cne $rid)) { & $fail 'OBSPA_HISTORY_SESSION' }
            $ks = [string](& $get $hcore 'ticketSha256' 'OBSPA_HISTORY_SESSION')
            if ((& $get $t 'ticketSha256' 'OBSPA_HISTORY_SESSION') -cne $ks) { & $fail 'OBSPA_HISTORY_SESSION' }
            $tk = & $rd ([string](& $get $hcore 'ticketPath' 'OBSPA_HISTORY_SESSION')) $ks
            $sid = & $get $tk 'sessionId' 'OBSPA_HISTORY_SESSION'
            $g = [guid]::Empty
            if (($sid -isnot [string]) -or (-not [guid]::TryParseExact($sid, 'D', [ref]$g))) { & $fail 'OBSPA_HISTORY_SESSION' }
            return [string]$sid
        }

        $inventoryOfInputs = {
            param($cf)
            $l = [System.Collections.Generic.List[string]]::new()
            foreach ($e in @($cf.Inputs) + @($cf.StreamedInputs)) { if (([string]$e.Path).Length -gt 0) { $l.Add([string]$e.Path) } }
            return , $l
        }
        # Facts for one node: shared by the current node and every ancestry node so receipt comparison uses exactly one derivation.
        $buildFacts = {
            param($n)
            $c = $n.c; $b = $n.b; $o = $n.o; $pe = $n.pe
            $leaf = $o.leaf
            $declared = @(@($c.DeclaredReferences))
            $verified = @(@($c.VerifiedReferences))
            $refOf = {
                param([string]$role)
                $d = @($declared | Where-Object { $_.Role -ceq $role }); $v = @($verified | Where-Object { $_.Role -ceq $role })
                if (($d.Count -ne 1) -or ($v.Count -ne 1)) { & $fail 'OBSPA_REFERENCE' }
                return [pscustomobject]([ordered]@{ path = [string]$v[0].Path; declaredSha256 = [string]$d[0].DeclaredSha256; declaredLength = [long]$d[0].DeclaredLength; verifiedSha256 = [string]$v[0].VerifiedSha256; verifiedLength = [long]$v[0].VerifiedLength })
            }
            $accounting = [pscustomobject]([ordered]@{
                schema = 'ManagedObservePendingAccounting/v1'
                anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
                anchor = [pscustomobject]([ordered]@{ receiptPath = [string]$n.anchorPr.Path; receiptSha256 = [string]$n.anchorPr.Sha256; runId = [string]$n.anchorEv.runId; attempt = [long]$n.anchorEv.attempt; terminalPath = [string]$n.anchorPc.TerminalPath; terminalSha256 = [string]$n.anchorPc.TerminalSha256; usedOutputTokens = [long]$n.anchorUsed })
                historicalOutputTokens = [long]$b.curHist
                observedOutputTokens = [long]$o.observed
                usedOutputTokens = [long]$o.used
                requestSha256 = [string]$b.reqSha
                startUtc = $b.startUtc
                endedUtc = $b.endUtc
                noAcceptedUsage = $true; noCompletion = $true; noAck = $true; noDispatch = $true
            })
            $facts = [pscustomobject]([ordered]@{
                schema = 'ManagedObservePendingAccountingFacts/v1'
                evidence = (& $selectionOf $pe)
                anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
                identity = [pscustomobject]([ordered]@{ taskId = $b.taskId; payloadSha256 = [string]$b.payloadSha; runId = $pe.runId; attempt = [long]$pe.attempt; sessionId = $b.sessionId; pid = $b.pid1; terminalReason = $b.termReason })
                limits = [pscustomobject]([ordered]@{ maxElapsedMs = $b.maxElapsed; maxAttempts = $b.maxAttempts; priorElapsedMs = 0L; maxOutputTokens = $null; softFraction = $null })
                timing = [pscustomobject]([ordered]@{ startUtc = $b.startUtc; endedUtc = $b.endUtc; usedElapsedMs = $b.usedElapsed })
                accounting = $accounting
                stdout = [pscustomobject]([ordered]@{ path = [string]$leaf.Path; sha256 = [string]$leaf.VerifiedSha256; length = [long]$leaf.VerifiedLength })
                references = [pscustomobject]([ordered]@{
                    manifest = [pscustomobject]([ordered]@{ path = $pe.mPath; expectedSha256 = $pe.mSha; verifiedSha256 = [string]$c.ManifestSha256 })
                    terminal = [pscustomobject]([ordered]@{ path = $pe.tPath; expectedSha256 = $pe.tSha; verifiedSha256 = [string]$c.TerminalSha256 })
                    ticket = [pscustomobject]([ordered]@{ path = $pe.kPath; expectedSha256 = [string](& $get $b.core 'ticketSha256' 'OBSPA_CORE_FIELD'); verifiedSha256 = [string]$c.TicketSha256 })
                    predecessorReceipt = [pscustomobject]([ordered]@{ path = $pe.prePath; expectedSha256 = $pe.preSha; verifiedSha256 = [string]$n.parentPr.Sha256 })
                    stdout = (& $refOf 'STDOUT')
                    stderr = (& $refOf 'STDERR')
                    artifactState = [string]$c.ArtifactState
                })
                inputPaths = @($n.inPaths)
                noAcceptedUsage = $true; noCompletion = $true; noAck = $true; noDispatch = $true
            })
            return $facts
        }


        $mkInPaths = {
            param($cc, $extra, $receiptPaths)
            $l = [System.Collections.Generic.List[string]]::new()
            foreach ($e in @($cc.Inputs) + @($cc.StreamedInputs) + @($extra)) { if (([string]$e.Path).Length -gt 0) { $l.Add([string]$e.Path) } }
            foreach ($rp in @($receiptPaths)) { $l.Add([string]$rp) }
            return , $l
        }
        $chainReads = [System.Collections.Generic.List[object]]::new()

        if (-not $isV3) {
            # ---- selected legacy v1 advisory anchor (unchanged semantics) ----
            $an = & $authAnchor $pr
            $rcpt = $an.rcpt; $pf = $an.pf; $pEv = $an.pEv; $pc = $an.pc; $pcapArgs = $an.pcapArgs; $priorUsed = $an.priorUsed
            # Current ticket history must equal the anchor's authenticated used total; no history list is fabricated for the current ticket.
            if ($curHist -ne $priorUsed) { & $fail 'OBSPA_ANCHOR_HISTORY_MISMATCH' }

        # Current identity must be absent from authenticated predecessor history plus the predecessor terminal.
        $runs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $reqs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $shas = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $paths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $sessions = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($h in (& $histOf $pc.Ticket)) {
            $ht = & $get $h 'terminalRef' 'OBSPA_PREDECESSOR_HISTORY'
            [void]$sessions.Add((& $histSession $h))
            [void]$runs.Add([string](& $get $h 'runId' 'OBSPA_PREDECESSOR_HISTORY'))
            [void]$reqs.Add([string](& $get $h 'requestSha256' 'OBSPA_PREDECESSOR_HISTORY'))
            [void]$shas.Add([string](& $get $ht 'sha256' 'OBSPA_PREDECESSOR_HISTORY'))
            [void]$paths.Add([string](& $get $ht 'path' 'OBSPA_PREDECESSOR_HISTORY'))
        }
        [void]$runs.Add([string]$pEv.runId); [void]$reqs.Add([string]$pc.RequestSha256); [void]$shas.Add([string]$pc.TerminalSha256); [void]$paths.Add([string]$pc.TerminalPath)
        $curTermSha = & $get $c 'TerminalSha256' 'OBSPA_CAPTURE_FIELD'
        $curTermPath = & $get $c 'TerminalPath' 'OBSPA_CAPTURE_FIELD'
        if ($runs.Contains($runId) -or $reqs.Contains($reqSha) -or $shas.Contains($curTermSha) -or $paths.Contains($curTermPath)) { & $fail 'OBSPA_DUPLICATE_IDENTITY' }
        if (([string]$pEv.runId -ceq $runId) -and ([long]$pEv.attempt -eq [long]$attempt)) { & $fail 'OBSPA_DUPLICATE_IDENTITY' }
        [void]$sessions.Add([string](& $get $pc.Ticket 'sessionId' 'OBSPA_PREDECESSOR_COUNT'))
        if ($sessions.Contains($sessionId)) { & $fail 'OBSPA_DUPLICATE_SESSION' }
        if (((& $get $c 'ManifestSha256' 'OBSPA_CAPTURE_FIELD') -ceq [string]$pc.ManifestSha256) -or ((& $get $c 'TicketSha256' 'OBSPA_CAPTURE_FIELD') -ceq [string]$pc.TicketSha256)) { & $fail 'OBSPA_DUPLICATE_IDENTITY' }


            $anchorPr = $pr; $anchorEv = $pEv; $anchorPc = $pc; $anchorUsed = $priorUsed
            $chainReads.Add($pr)
            $extraObjs = @($pc.Inputs)
        }
        else {
            # ---- selected v3 parent: bottom-up ancestry to an authenticated legacy v1 anchor ----
            $chain = [System.Collections.Generic.List[object]]::new()
            $seenSha = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $seenPath = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            $walk = $pr
            while ($true) {
                if ($chain.Count -ge 64) { & $fail 'OBSPA_CHAIN_TOO_DEEP' }
                if ((-not $seenSha.Add([string]$walk.Sha256)) -or (-not $seenPath.Add([string]$walk.Path))) { & $fail 'OBSPA_CHAIN_CYCLE' }
                $wr = $walk.Value
                if ($wr -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSPA_PREDECESSOR_UNREADABLE' }
                $ws = & $get $wr 'schemaVersion' 'OBSPA_PREDECESSOR_UNSUPPORTED'
                if (($ws -is [string]) -and ($ws -ceq 'OperationalRunReceipt/v1')) { $chain.Add(@{ pr = $walk; pe = $null }); break }
                if (($ws -isnot [string]) -or ($ws -cne 'OperationalRunReceipt/v3')) { & $fail 'OBSPA_PREDECESSOR_UNSUPPORTED' }
                if (-not (Test-ManagedObservePendingReceiptV3Shape $wr)) { & $fail 'OBSPA_ANCESTOR_RECEIPT' }
                $ape = & $parseEv (& $get $wr 'observePendingAccountingEvidence' 'OBSPA_ANCESTOR_RECEIPT')
                $chain.Add(@{ pr = $walk; pe = $ape })
                $walk = & $readRef $ape.prePath $ape.preSha
            }
            foreach ($q in $chain) { $chainReads.Add($q.pr) }
            $rootPr = $chain[$chain.Count - 1].pr
            $an = & $authAnchor $rootPr
            $pEv = $an.pEv; $pc = $an.pc; $pcapArgs = $an.pcapArgs; $priorUsed = $an.priorUsed
            # The original postlaunch SELECTED_ACCOUNTING_ANCHOR provenance stays with the root of the chain; later bound edges never relabel it.
            $anchorPr = $rootPr; $anchorEv = $pEv; $anchorPc = $pc; $anchorUsed = $priorUsed

            $runs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $runAtt = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $reqs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $shas = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $mans = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $tkts = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $paths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            $sessions = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            $register = {
                param($idn, $hist)
                if ($runs.Contains($idn.runId) -or $runAtt.Contains($idn.runId + '|' + [string]$idn.attempt) -or $reqs.Contains($idn.req) -or $shas.Contains($idn.termSha) -or $paths.Contains($idn.termPath) -or $mans.Contains($idn.manSha) -or $tkts.Contains($idn.tkSha)) { & $fail 'OBSPA_DUPLICATE_IDENTITY' }
                if ($sessions.Contains($idn.session)) { & $fail 'OBSPA_DUPLICATE_SESSION' }
                foreach ($hh in @($hist)) {
                    if (([string]$hh.runId -ceq $idn.runId) -or ([string]$hh.req -ceq $idn.req) -or ([string]$hh.sha -ceq $idn.termSha) -or [string]::Equals([string]$hh.path, $idn.termPath, [StringComparison]::OrdinalIgnoreCase)) { & $fail 'OBSPA_DUPLICATE_IDENTITY' }
                    if ([string]::Equals([string]$hh.session, $idn.session, [StringComparison]::OrdinalIgnoreCase)) { & $fail 'OBSPA_DUPLICATE_SESSION' }
                }
                [void]$runs.Add($idn.runId); [void]$runAtt.Add($idn.runId + '|' + [string]$idn.attempt); [void]$reqs.Add($idn.req); [void]$shas.Add($idn.termSha)
                [void]$paths.Add($idn.termPath); [void]$mans.Add($idn.manSha); [void]$tkts.Add($idn.tkSha); [void]$sessions.Add($idn.session)
                foreach ($hh in @($hist)) { [void]$runs.Add([string]$hh.runId); [void]$reqs.Add([string]$hh.req); [void]$shas.Add([string]$hh.sha); [void]$paths.Add([string]$hh.path); [void]$sessions.Add([string]$hh.session) }
            }
            # Declared history of a ticket: strictly required for the legacy anchor; for observe nodes an absent aggregateAdvisory means no history
            # (never invented from counts), a present one must be well-formed. Identities are authenticated through pinned bytes only.
            $histOptOf = {
                param($t)
                $tb = & $get $t 'budget' 'OBSPA_PREDECESSOR_HISTORY'
                $has = $false
                foreach ($q in $tb.PSObject.Properties) { if ([string]::Equals([string]$q.Name, 'aggregateAdvisory', $ord)) { $has = $true } }
                if (-not $has) { return , $null }
                return , (& $histOf $t)
            }
            $lineMap = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
            $aliasReq = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
            $aliasSha = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
            $aliasPath = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
            $aliasSess = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
            # One run identity maps to exactly one set of pins/session across the whole lineage; repeats must agree exactly, aliases refuse.
            $bindEntry = {
                param($e)
                if ($lineMap.ContainsKey($e.runId)) {
                    $x = $lineMap[$e.runId]
                    if (([string]$x.req -cne [string]$e.req) -or ([string]$x.sha -cne [string]$e.sha) -or (-not [string]::Equals([string]$x.path, [string]$e.path, [StringComparison]::OrdinalIgnoreCase)) -or (-not [string]::Equals([string]$x.session, [string]$e.session, [StringComparison]::OrdinalIgnoreCase))) { & $fail 'OBSPA_HISTORY_CONFLICT' }
                    return
                }
                if ($aliasReq.ContainsKey([string]$e.req) -or $aliasSha.ContainsKey([string]$e.sha) -or $aliasPath.ContainsKey([string]$e.path) -or $aliasSess.ContainsKey([string]$e.session)) { & $fail 'OBSPA_HISTORY_CONFLICT' }
                $lineMap[$e.runId] = $e
                $aliasReq[[string]$e.req] = $e.runId; $aliasSha[[string]$e.sha] = $e.runId; $aliasPath[[string]$e.path] = $e.runId; $aliasSess[[string]$e.session] = $e.runId
            }
            $histCache = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
            $histKeep = [System.Collections.Generic.List[object]]::new()
            $registerNode = {
                param($idn, $tkt, [bool]$strict)
                $hs = $null
                if ($strict) { $hs = & $histOf $tkt } else { $hs = & $histOptOf $tkt }
                $he = [System.Collections.Generic.List[object]]::new()
                foreach ($h in $(if ($null -eq $hs) { @() } else { @($hs) })) {
                    if ($null -eq $h) { & $fail 'OBSPA_HISTORY_SESSION' }
                    $ht = & $get $h 'terminalRef' 'OBSPA_PREDECESSOR_HISTORY'
                    $e = @{ runId = [string](& $get $h 'runId' 'OBSPA_PREDECESSOR_HISTORY'); req = [string](& $get $h 'requestSha256' 'OBSPA_PREDECESSOR_HISTORY'); sha = [string](& $get $ht 'sha256' 'OBSPA_PREDECESSOR_HISTORY'); path = [string](& $get $ht 'path' 'OBSPA_PREDECESSOR_HISTORY') }
                    $key = $e.runId + '|' + $e.req + '|' + $e.sha + '|' + $e.path
                    if (-not $histCache.ContainsKey($key)) {
                        $histCache[$key] = [string](& $histSession $h)
                        $histKeep.Add(@{ h = $h; session = $histCache[$key] })
                    }
                    $e.session = $histCache[$key]
                    $he.Add($e)
                }
                & $register $idn $he
                & $bindEntry @{ runId = $idn.runId; req = $idn.req; sha = $idn.termSha; path = $idn.termPath; session = $idn.session }
                foreach ($e in $he) { & $bindEntry $e }
            }
            & $registerNode @{ runId = [string]$pEv.runId; attempt = [long]$pEv.attempt; req = [string]$pc.RequestSha256; termSha = [string]$pc.TerminalSha256; termPath = [string]$pc.TerminalPath; session = [string](& $get $pc.Ticket 'sessionId' 'OBSPA_PREDECESSOR_COUNT'); manSha = [string]$pc.ManifestSha256; tkSha = [string]$pc.TicketSha256 } $pc.Ticket $true

            $extraList = [System.Collections.Generic.List[object]]::new()
            $kept = [System.Collections.Generic.List[object]]::new()
            foreach ($e in @($pc.Inputs)) { $extraList.Add($e) }
            $parentUsed = $priorUsed
            for ($i = $chain.Count - 2; $i -ge 0; $i--) {
                $nd = $chain[$i]
                $ape = $nd.pe
                $parentRead = $chain[$i + 1].pr
                $nc = & $captureFor $ape
                $nb = & $bindNode $nc $ape
                # Only an edge whose parent is itself a v3 receipt must already be bound inside this node's launch ticket.
                & $ticketBound $nb.ticket $ape.prePath $ape.preSha ($i + 1 -lt $chain.Count - 1)
                if ($nb.curHist -ne $parentUsed) { & $fail 'OBSPA_ANCHOR_HISTORY_MISMATCH' }
                $no = & $observeNode $nc $ape $nb.curHist
                $nc2 = & $captureFor $ape
                if (-not (& $sameCapture $nc2 $nc)) { & $fail 'OBSPA_STALE_ANCESTOR' }
                & $registerNode @{ runId = $ape.runId; attempt = [long]$ape.attempt; req = [string]$nb.reqSha; termSha = [string]$nc.TerminalSha256; termPath = [string]$nc.TerminalPath; session = [string]$nb.sessionId; manSha = [string]$nc.ManifestSha256; tkSha = [string]$nc.TicketSha256 } $nb.ticket $false
                $rp = [System.Collections.Generic.List[string]]::new()
                for ($j = $i + 1; $j -lt $chain.Count; $j++) { $rp.Add([string]$chain[$j].pr.Path) }
                $nf = & $buildFacts @{ c = $nc; b = $nb; o = $no; pe = $ape; anchorPr = $anchorPr; anchorEv = $anchorEv; anchorPc = $anchorPc; anchorUsed = $anchorUsed; parentPr = $parentRead; inPaths = (& $mkInPaths $nc $extraList $rp) }
                $rcv = $nd.pr.Value
                if (-not (Compare-ManagedObservePendingReceiptV3ToFacts $rcv $nf)) { & $fail 'OBSPA_ANCESTOR_RECEIPT' }
                $rEv = & $get $rcv 'evidence' 'OBSPA_ANCESTOR_RECEIPT'
                $rawRef = Test-ManagedObservePendingRawDto -RawPath ([string](& $get $rEv 'rawPath' 'OBSPA_ANCESTOR_RAW')) -ExpectedSha256 ([string](& $get $rEv 'rawSha256' 'OBSPA_ANCESTOR_RAW')) -Facts $nf
                if (($null -eq $rawRef) -or ($rawRef.Valid -isnot [bool]) -or (-not $rawRef.Valid) -or ($rawRef.Path -cne [string](& $get $rEv 'rawPath' 'OBSPA_ANCESTOR_RAW'))) { & $fail 'OBSPA_ANCESTOR_RAW' }
                foreach ($e in @($nc.Inputs) + @($nc.StreamedInputs)) { $extraList.Add($e) }
                $kept.Add(@{ pe = $ape; nc = $nc; nf = $nf; rawPath = [string](& $get $rEv 'rawPath' 'OBSPA_ANCESTOR_RAW'); rawSha = [string](& $get $rEv 'rawSha256' 'OBSPA_ANCESTOR_RAW') })
                $parentUsed = [long]$no.used
            }
            if ($curHist -ne $parentUsed) { & $fail 'OBSPA_ANCHOR_HISTORY_MISMATCH' }
            & $registerNode @{ runId = $runId; attempt = [long]$attempt; req = [string]$reqSha; termSha = [string](& $get $c 'TerminalSha256' 'OBSPA_CAPTURE_FIELD'); termPath = [string](& $get $c 'TerminalPath' 'OBSPA_CAPTURE_FIELD'); session = [string]$sessionId; manSha = [string](& $get $c 'ManifestSha256' 'OBSPA_CAPTURE_FIELD'); tkSha = [string](& $get $c 'TicketSha256' 'OBSPA_CAPTURE_FIELD') } $ticket $false
            $extraObjs = @($extraList.ToArray())
        }

        # ---- shared read-only observation over the captured stdout leaf (a failed transport has no SDK success to observe; its usage stays UNKNOWN) ----
        $o = $null
        if (-not $F) { $o = & $observeNode $c $pe0 $curHist }

        # ---- stability: recapture current, re-read every pinned receipt and recapture the legacy anchor ----
        $c2 = & $captureFor $pe0 $F
        if (-not (& $sameCapture $c2 $c)) { & $fail 'OBSPA_STALE_CURRENT' }
        foreach ($q in $chainReads) {
            $q2 = & $readRef ([string]$q.Path) ([string]$q.Sha256)
            if (($q2.Sha256 -cne $q.Sha256) -or ($q2.Length -ne $q.Length)) { & $fail 'OBSPA_STALE_PREDECESSOR' }
        }
        if ($isV3) {
            # Final coverage after all later processing: every retained ancestor capture and raw DTO, and every history identity read, must be unchanged.
            foreach ($k in $kept) {
                $kc = & $captureFor $k.pe
                if (-not (& $sameCapture $kc $k.nc)) { & $fail 'OBSPA_STALE_ANCESTOR' }
                $kr = Test-ManagedObservePendingRawDto -RawPath $k.rawPath -ExpectedSha256 $k.rawSha -Facts $k.nf
                if (($null -eq $kr) -or ($kr.Valid -isnot [bool]) -or (-not $kr.Valid) -or ($kr.Path -cne $k.rawPath)) { & $fail 'OBSPA_ANCESTOR_RAW' }
            }
            foreach ($hk in $histKeep) {
                if ([string](& $histSession $hk.h) -cne [string]$hk.session) { & $fail 'OBSPA_STALE_HISTORY' }
            }
        }
        $pcap2 = Get-ManagedNativeCapturedFacts @pcapArgs
        if (($pcap2.Valid -isnot [bool]) -or (-not $pcap2.Valid) -or ((& $inventory $pcap2.Facts) -cne (& $inventory $anchorPc))) { & $fail 'OBSPA_STALE_PREDECESSOR' }

        $receiptPaths = @($chainReads | ForEach-Object { [string]$_.Path })
        if (-not $isV3) { $receiptPaths = @([string]$pr.Path) }
        if ($F) {
            # Failed-transport base: authenticated parent lineage and current capture only. No count is derived for the current node.
            $parentRunId = if ($isV3) { [string]$chain[0].pe.runId } else { [string]$anchorEv.runId }
            $parentAttempt = if ($isV3) { [long]$chain[0].pe.attempt } else { [long]$anchorEv.attempt }
            # Additive lineage identity export (embedded by no failed-transport fact or receipt): every run/request/terminal/manifest/ticket/session identity registered
            # across the authenticated parent chain plus this current node, so a later UNKNOWN continuation can prove that it duplicates none of them.
            $exportOf = {
                param($src, $extra)
                $l = [System.Collections.Generic.List[string]]::new()
                foreach ($x in (@($src) + @($extra))) { if ($null -ne $x) { $l.Add([string]$x) } }
                $a = [string[]]$l.ToArray()
                [System.Array]::Sort($a, [System.StringComparer]::Ordinal)
                return , $a
            }
            $curManL = [string](& $get $c 'ManifestSha256' 'OBSPA_CAPTURE_FIELD')
            $curTkL = [string](& $get $c 'TicketSha256' 'OBSPA_CAPTURE_FIELD')
            $linMans = if ($isV3) { & $exportOf $mans @($curManL) } else { & $exportOf @([string]$pc.ManifestSha256) @($curManL) }
            $linTkts = if ($isV3) { & $exportOf $tkts @($curTkL) } else { & $exportOf @([string]$pc.TicketSha256) @($curTkL) }
            $lineage = [pscustomobject]([ordered]@{
                runIds = (& $exportOf $runs @($runId))
                requestSha256 = (& $exportOf $reqs @($reqSha))
                terminalSha256 = (& $exportOf $shas @([string](& $get $c 'TerminalSha256' 'OBSPA_CAPTURE_FIELD')))
                terminalPaths = (& $exportOf $paths @([string](& $get $c 'TerminalPath' 'OBSPA_CAPTURE_FIELD')))
                manifestSha256 = $linMans
                ticketSha256 = $linTkts
                sessionIds = (& $exportOf $sessions @([string]$sessionId))
            })
            $fbase = [pscustomobject]([ordered]@{
                Selection = (& $selectionOf $pe0)
                Capture = $c
                Bound = [pscustomobject]([ordered]@{ taskId = [string]$b.taskId; payloadSha256 = [string]$b.payloadSha; sessionId = [string]$b.sessionId; pid = [long]$b.pid1; startUtc = [string]$b.startUtc; endUtc = [string]$b.endUtc; terminalReason = [string]$b.termReason; exitCode = [long]$b.termExit; maxAttempts = [long]$b.maxAttempts; maxElapsedMs = $(if ($null -eq $b.maxElapsed) { $null } else { [long]$b.maxElapsed }); usedElapsedMs = [long]$b.usedElapsed; requestSha256 = [string]$b.reqSha; ticketSha256 = [string](& $get $b.core 'ticketSha256' 'OBSPA_CORE_FIELD') })
                ParentReceipt = [pscustomobject]([ordered]@{ path = [string]$pr.Path; sha256 = [string]$pr.Sha256; schemaVersion = [string]$sv0; runId = $parentRunId; attempt = $parentAttempt })
                Anchor = [pscustomobject]([ordered]@{ receiptPath = [string]$anchorPr.Path; receiptSha256 = [string]$anchorPr.Sha256; runId = [string]$anchorEv.runId; attempt = [long]$anchorEv.attempt; terminalPath = [string]$anchorPc.TerminalPath; terminalSha256 = [string]$anchorPc.TerminalSha256; usedOutputTokens = [long]$anchorUsed })
                LastVerifiedParentOutputTokens = [long]$curHist
                InPaths = @((& $mkInPaths $c $extraObjs $receiptPaths).ToArray())
                Lineage = $lineage
            })
            return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'FAILED_TRANSPORT_BASE'; Facts = $null; Base = $fbase }
        }
        $facts = & $buildFacts @{ c = $c; b = $b; o = $o; pe = $pe0; anchorPr = $anchorPr; anchorEv = $anchorEv; anchorPc = $anchorPc; anchorUsed = $anchorUsed; parentPr = $pr; inPaths = (& $mkInPaths $c $extraObjs $receiptPaths) }
        return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'PENDING_ACCOUNTING'; Facts = $facts }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($m.StartsWith('UNKNOWN:', $ord) -and ($m.Length -le 56) -and ($m.Substring(8) -cmatch '^[A-Z0-9_]{1,48}$')) {
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_PENDING_UNKNOWN'; Result = 'NONRECEIPT'; Status = 'UNKNOWN'; Reason = $m.Substring(8); ObservedOutputTokens = $null; UsedOutputTokens = $null; Facts = $null }
        }
        $code = 'OBSPA_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', $ord) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Result = 'REFUSED'; Facts = $null }
    }
}

function Test-ManagedObservePendingReceiptV3Shape {
    # Pure structural check of a stored OperationalRunReceipt/v3 DTO (raw shape, modes, null limits, incomplete artifact, no completion fields).
    # It derives nothing, authenticates nothing and confers no receipt validity or authority by itself.
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
        $ord = [System.StringComparison]::Ordinal
        $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
        $exact = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $ps = @($o.PSObject.Properties)
            if ($ps.Count -ne $names.Count) { return $false }
            foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { return $false } }
            return $true
        }
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $isStr = { param($v) ($v -is [string]) -and ($v.Length -gt 0) }

        if (-not (& $exact $obj @('schemaVersion', 'runId', 'taskId', 'payloadSha256', 'destination', 'status', 'attempt', 'sessionId', 'historyVerified', 'budget', 'provider', 'artifact', 'updatedAt', 'evidence', 'outputStopMode', 'observePendingAccountingEvidence', 'observePendingAccounting'))) { return $false }
        if (((& $val $obj 'schemaVersion') -isnot [string]) -or ((& $val $obj 'schemaVersion') -cne 'OperationalRunReceipt/v3')) { return $false }
        if (((& $val $obj 'status') -isnot [string]) -or ((& $val $obj 'status') -cne 'AWAITING_CONTROLLER')) { return $false }
        if (((& $val $obj 'outputStopMode') -isnot [string]) -or ((& $val $obj 'outputStopMode') -cne 'OBSERVE_ONLY')) { return $false }
        if (((& $val $obj 'destination') -isnot [string]) -or ((& $val $obj 'destination') -cne 'Anthropic Claude')) { return $false }
        $hv = & $val $obj 'historyVerified'
        if (($hv -isnot [bool]) -or $hv) { return $false }
        foreach ($n in @('runId', 'taskId', 'sessionId', 'updatedAt')) { if (-not (& $isStr (& $val $obj $n))) { return $false } }
        if (-not (& $isHex (& $val $obj 'payloadSha256'))) { return $false }
        $attempt = & $val $obj 'attempt'
        if ((-not (& $isInt $attempt)) -or ([long]$attempt -lt 1)) { return $false }

        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $a = & $val $obj 'artifact'
        $e = & $val $obj 'evidence'
        if (-not ((& $exact $b @('maxOutputTokens', 'maxElapsedMs', 'maxAttempts', 'usedElapsedMs', 'usedOutputTokens', 'attemptsUsed', 'softFraction')) -and (& $exact $p @('startIdentity', 'sessionId', 'terminalReason', 'pid')) -and (& $exact $a @('complete', 'sha256', 'path')) -and (& $exact $e @('rawPath', 'rawSha256', 'ticketPath', 'ticketSha256', 'usagePath', 'usageSha256', 'nativeThinkingTokens')))) { return $false }
        # No output ceiling or soft fraction exists in observe-only mode; nothing is clamped or carried as a finite number.
        if (($null -ne (& $val $b 'maxOutputTokens')) -or ($null -ne (& $val $b 'softFraction'))) { return $false }
        foreach ($n in @('maxAttempts', 'usedElapsedMs', 'usedOutputTokens', 'attemptsUsed')) { if (-not (& $isInt (& $val $b $n))) { return $false } }
        # maxElapsedMs: exact null = no total author deadline (compared to authenticated facts elsewhere); otherwise a positive typed integer.
        if (($null -ne (& $val $b 'maxElapsedMs')) -and (-not (& $isInt (& $val $b 'maxElapsedMs')))) { return $false }
        if ((($null -ne (& $val $b 'maxElapsedMs')) -and ([long](& $val $b 'maxElapsedMs') -le 0)) -or ([long](& $val $b 'maxAttempts') -le 0) -or ([long](& $val $b 'usedElapsedMs') -lt 0) -or ([long](& $val $b 'usedOutputTokens') -lt 0)) { return $false }
        if (([long](& $val $b 'attemptsUsed') -ne [long]$attempt) -or ([long]$attempt -gt [long](& $val $b 'maxAttempts')) -or (($null -ne (& $val $b 'maxElapsedMs')) -and ([long](& $val $b 'usedElapsedMs') -gt [long](& $val $b 'maxElapsedMs')))) { return $false }
        if ($null -ne (& $val $p 'startIdentity')) { return $false }
        if ((-not (& $isStr (& $val $p 'sessionId'))) -or ((& $val $p 'sessionId') -cne (& $val $obj 'sessionId')) -or (-not (& $isStr (& $val $p 'terminalReason')))) { return $false }
        if ((-not (& $isInt (& $val $p 'pid'))) -or ([long](& $val $p 'pid') -le 0)) { return $false }
        $ac = & $val $a 'complete'
        if (($ac -isnot [bool]) -or $ac -or ($null -ne (& $val $a 'sha256')) -or ($null -ne (& $val $a 'path'))) { return $false }
        foreach ($n in @('rawPath', 'ticketPath', 'usagePath')) { if (-not (& $isStr (& $val $e $n))) { return $false } }
        foreach ($n in @('rawSha256', 'ticketSha256', 'usageSha256')) { if (-not (& $isHex (& $val $e $n))) { return $false } }
        if ($null -ne (& $val $e 'nativeThinkingTokens')) { return $false }
        return $true
    } catch { return $false }
}

function Compare-ManagedObservePendingReceiptV3ToFacts {
    # STRUCTURAL ONLY: compares one stored v3 receipt DTO to facts the CALLER derived itself from raw authenticated captures.
    # It never reads evidence, never authenticates and confers no receipt validity, completion, ACK or dispatch authority; callers must
    # derive the facts internally and reauthenticate the raw DTO themselves. Shared by the v3 validator and the ancestry verifier.
    param($obj, $f)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        if (($null -eq $f) -or ($f -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
        $ord = [System.StringComparison]::Ordinal
        $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
        $exact = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $ps = @($o.PSObject.Properties)
            if ($ps.Count -ne $names.Count) { return $false }
            foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { return $false } }
            return $true
        }
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $isStr = { param($v) ($v -is [string]) -and ($v.Length -gt 0) }

        $attempt = & $val $obj 'attempt'
        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $e = & $val $obj 'evidence'
        $id = $f.identity; $lim = $f.limits; $acct = $f.accounting
        if (($f.anchorLabel -cne 'SELECTED_ACCOUNTING_ANCHOR') -or ($acct.anchorLabel -cne 'SELECTED_ACCOUNTING_ANCHOR')) { return $false }
        foreach ($pair in @(@('runId', 'runId'), @('taskId', 'taskId'), @('payloadSha256', 'payloadSha256'), @('sessionId', 'sessionId'))) {
            if ((& $val $obj $pair[0]) -cne [string]$id.($pair[1])) { return $false }
        }
        if (([long]$attempt -ne [long]$id.attempt) -or ([long](& $val $p 'pid') -ne [long]$id.pid) -or ((& $val $p 'terminalReason') -cne [string]$id.terminalReason)) { return $false }
        if ((& $val $obj 'updatedAt') -cne [string]$f.timing.endedUtc) { return $false }
        if ((($null -eq (& $val $b 'maxElapsedMs')) -ne ($null -eq $lim.maxElapsedMs)) -or (($null -ne $lim.maxElapsedMs) -and ([long](& $val $b 'maxElapsedMs') -ne [long]$lim.maxElapsedMs)) -or ([long](& $val $b 'maxAttempts') -ne [long]$lim.maxAttempts) -or ([long]$lim.priorElapsedMs -ne 0)) { return $false }
        if ([long](& $val $b 'usedElapsedMs') -ne [long]$f.timing.usedElapsedMs) { return $false }
        if ([long](& $val $b 'usedOutputTokens') -ne [long]$acct.usedOutputTokens) { return $false }
        if (([string](& $val $e 'ticketPath') -cne [string]$f.references.ticket.path) -or ((& $val $e 'ticketSha256') -cne [string]$f.references.ticket.verifiedSha256)) { return $false }
        if (([string](& $val $e 'usagePath') -cne [string]$f.stdout.path) -or ((& $val $e 'usageSha256') -cne [string]$f.stdout.sha256)) { return $false }
        if ((ConvertTo-Json -InputObject (& $val $obj 'observePendingAccounting') -Depth 8 -Compress) -cne (ConvertTo-Json -InputObject $acct -Depth 8 -Compress)) { return $false }
        return $true
    } catch { return $false }
}

function Test-ManagedObservePendingRawDto {
    # Read-only. Cross-checks one caller raw DTO against derived authenticated pending-accounting facts; shared by the adapter and the v3 validator.
    # The raw DTO is crosschecked input, not provider attestation and not the captured terminal. The read bound below is an observation constraint
    # for this small metadata file only; it never limits or stops author output.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [AllowNull()][AllowEmptyString()][string]$ExpectedSha256,
        [Parameter(Mandatory)]$Facts,
        [switch]$FailedTransport,
        [switch]$UnknownContinuation
    )
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
    $maxBytes = 1048576
    $readRaw = {
        param([string]$p)
        $q = $p
        while (-not [string]::IsNullOrEmpty($q)) {
            $a = $null
            try { $a = [System.IO.File]::GetAttributes($q) } catch { $a = $null }
            if ($null -eq $a) { & $fail 'OBSPA_RAW_UNREADABLE' }
            if (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne [System.IO.FileAttributes]0) { & $fail 'OBSPA_RAW_REPARSE' }
            if (($q -ceq $p) -and (($a -band [System.IO.FileAttributes]::Directory) -ne [System.IO.FileAttributes]0)) { & $fail 'OBSPA_RAW_NOT_FILE' }
            $q = [System.IO.Path]::GetDirectoryName($q)
        }
        $buf = [byte[]]::new($maxBytes + 1)
        $n = 0
        $fs = $null
        try {
            $fs = [System.IO.FileStream]::new($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            while ($n -lt $buf.Length) {
                $r = $fs.Read($buf, $n, $buf.Length - $n)
                if ($r -le 0) { break }
                $n += $r
            }
        } catch { & $fail 'OBSPA_RAW_UNREADABLE' } finally { if ($null -ne $fs) { $fs.Dispose() } }
        if ($n -gt $maxBytes) { & $fail 'OBSPA_RAW_TOO_LARGE' }
        $out = [byte[]]::new($n)
        [System.Array]::Copy($buf, $out, $n)
        return , $out
    }
    $shaOf = { param([byte[]]$b) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
    try {
        if (-not [System.IO.Path]::IsPathFullyQualified($RawPath)) { & $fail 'OBSPA_RAW_PATH' }
        $full = [System.IO.Path]::GetFullPath($RawPath)
        foreach ($ip in @($Facts.inputPaths)) {
            if ([string]::Equals($full, [System.IO.Path]::GetFullPath([string]$ip), [System.StringComparison]::OrdinalIgnoreCase)) { & $fail 'OBSPA_RAW_COLLIDES' }
        }
        $bytes = & $readRaw $full
        $sha = & $shaOf $bytes
        if ((-not [string]::IsNullOrEmpty($ExpectedSha256)) -and ($sha -cne $ExpectedSha256)) { & $fail 'OBSPA_RAW_PIN' }
        $off = 0
        if (($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)) { $off = 3 }
        $text = $null
        try { $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes, $off, $bytes.Length - $off) } catch { $text = $null }
        if ($null -eq $text) { & $fail 'OBSPA_RAW_UTF8' }
        $jd = $null
        try {
            $opt = [System.Text.Json.JsonDocumentOptions]::new()
            $opt.MaxDepth = 64
            $opt.AllowTrailingCommas = $false
            $opt.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
            try { $jd = [System.Text.Json.JsonDocument]::Parse($text, $opt) } catch { & $fail 'OBSPA_RAW_JSON' }
            if ($jd.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { & $fail 'OBSPA_RAW_JSON' }
            $stk = [System.Collections.Generic.Stack[System.Text.Json.JsonElement]]::new()
            $stk.Push($jd.RootElement)
            while ($stk.Count -gt 0) {
                $el = $stk.Pop()
                if ($el.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                    foreach ($jp in $el.EnumerateObject()) { if (-not $seen.Add($jp.Name)) { & $fail 'OBSPA_RAW_DUPLICATE' }; $stk.Push($jp.Value) }
                }
                elseif ($el.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) { foreach ($ji in $el.EnumerateArray()) { $stk.Push($ji) } }
            }
        } finally { if ($null -ne $jd) { $jd.Dispose() } }
        $raw = $null
        try { $raw = ConvertFrom-Json -InputObject $text -DateKind String -ErrorAction Stop } catch { $raw = $null }
        if ($raw -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSPA_RAW_JSON' }
        $rn = @($raw.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($k in @('status', 'pid', 'session', 'startUtc', 'endUtc', 'exit', 'observedOutput')) { if ($rn -cnotcontains $k) { & $fail 'OBSPA_RAW_FIELD' } }
        $id = $Facts.identity; $acct = $Facts.accounting
        if (($raw.status -isnot [string]) -or (@('AWAITING_CONTROLLER', 'TERMINAL') -cnotcontains $raw.status)) { & $fail 'OBSPA_RAW_STATUS' }
        if ((-not (& $isInt $raw.pid)) -or ([long]$raw.pid -ne [long]$id.pid)) { & $fail 'OBSPA_RAW_PID' }
        if (($raw.session -isnot [string]) -or ($raw.session -cne [string]$id.sessionId)) { & $fail 'OBSPA_RAW_SESSION' }
        if (($raw.startUtc -isnot [string]) -or ($raw.startUtc -cne [string]$Facts.timing.startUtc) -or ($raw.endUtc -isnot [string]) -or ($raw.endUtc -cne [string]$Facts.timing.endedUtc)) { & $fail 'OBSPA_RAW_TIMES' }
        if ($FailedTransport) {
            # Failed transport: the raw record carries the actual nonzero native exit; observed output stays null (UNKNOWN), never a number.
            if ((-not (& $isInt $raw.exit)) -or ([long]$raw.exit -eq 0) -or ([long]$raw.exit -ne [long]$id.exitCode)) { & $fail 'OBSPA_RAW_EXIT' }
            if ($null -ne $raw.observedOutput) { & $fail 'OBSPA_RAW_OBSERVED' }
            if ($UnknownContinuation) {
                # UNKNOWN history: a raw history figure is never a number here; it may only be absent or an exact null.
                if (($rn -ccontains 'historicalOutput') -and ($null -ne $raw.historicalOutput)) { & $fail 'OBSPA_RAW_HISTORY' }
            }
            elseif (($rn -ccontains 'historicalOutput') -and ((-not (& $isInt $raw.historicalOutput)) -or ([long]$raw.historicalOutput -ne [long]$acct.lastVerifiedParentOutputTokens))) { & $fail 'OBSPA_RAW_HISTORY' }
        }
        elseif ($UnknownContinuation) {
            # Pending UNKNOWN continuation: only the labelled per-child SDK count is compared; history and totals stay null.
            if ((-not (& $isInt $raw.exit)) -or ([long]$raw.exit -ne 0)) { & $fail 'OBSPA_RAW_EXIT' }
            if ((-not (& $isInt $raw.observedOutput)) -or ([long]$raw.observedOutput -ne [long]$acct.childObservedOutputTokens)) { & $fail 'OBSPA_RAW_OBSERVED' }
            if (($rn -ccontains 'historicalOutput') -and ($null -ne $raw.historicalOutput)) { & $fail 'OBSPA_RAW_HISTORY' }
        }
        else {
        if ((-not (& $isInt $raw.exit)) -or ([long]$raw.exit -ne 0)) { & $fail 'OBSPA_RAW_EXIT' }
        if ((-not (& $isInt $raw.observedOutput)) -or ([long]$raw.observedOutput -ne [long]$acct.observedOutputTokens)) { & $fail 'OBSPA_RAW_OBSERVED' }
        if (($rn -ccontains 'historicalOutput') -and ((-not (& $isInt $raw.historicalOutput)) -or ([long]$raw.historicalOutput -ne [long]$acct.historicalOutputTokens))) { & $fail 'OBSPA_RAW_HISTORY' }
        }
        if (($rn -ccontains 'additionalCap') -and ($null -ne $raw.additionalCap)) { & $fail 'OBSPA_RAW_CAP' }
        # Stability through validation: the same bytes must still be on disk.
        $again = & $readRaw $full
        if ((& $shaOf $again) -cne $sha) { & $fail 'OBSPA_RAW_STALE' }
        return [pscustomobject]@{ Valid = $true; Code = $null; Path = $full; Sha256 = $sha }
    }
    catch {
        $m = [string]$_.Exception.Message
        $code = 'OBSPA_RAW_UNEXPECTED'
        if ($m.StartsWith('REFUSE:', $ord) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Path = $null; Sha256 = $null }
    }
}

function Get-ManagedObserveReviewedCompletionFacts {
    # Read-only. Authenticates ONE registered, independently reviewed OBSERVE_ONLY completion for an already-captured pending-accounting run.
    # The pending accounting facts (strict readers, captured SDK recount) are derived by Get-ManagedObservePendingAccountingFacts; the registered
    # records (registration18, terminalBinding16, reviewCompletion9, request/core/ACK/artifact/projection) are authenticated by the installed
    # Get-RegisteredReviewReplayContext predicate. That predicate only type-checks its handler argument; the placeholder passed here is never
    # invoked for authentication and throws if anything ever does. No caller fact, PASS string, artifact presence or SDK success alone completes
    # a task. Refs outside the controller evidence boundary, stale refs, ACK-false runs, absent artifacts and mismatched identities refuse; an
    # unobservable resource state is UNKNOWN, never zero usage. Grants no dispatch, no outbox publication and no approval.
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Evidence)
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    $ordIc = [System.StringComparison]::OrdinalIgnoreCase
    $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    $unknown = { param([string]$c) throw [System.InvalidOperationException]::new('UNKNOWN:' + $c) }
    $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
    $clean = { param($v, [string]$d) if (($v -is [string]) -and ($v -cmatch '^[A-Z0-9_]{1,48}\z')) { return $v }; return $d }
    $get = {
        param($o, [string]$n, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        foreach ($q in $o.PSObject.Properties) { if (($q.MemberType -eq $note) -and [string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }
        & $fail $c
    }
    $exact = {
        param($o, [string[]]$names, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        $ps = @($o.PSObject.Properties)
        if ($ps.Count -ne $names.Count) { & $fail $c }
        foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { & $fail $c } }
    }
    $same = { param($a, $b) ($a -is [string]) -and ($b -is [string]) -and [string]::Equals($a, $b, $ord) }
    $sameIc = { param($a, $b) ($a -is [string]) -and ($b -is [string]) -and [string]::Equals($a, $b, $ordIc) }
    $refOf = {
        param($r)
        & $exact $r @('path', 'sha256') 'OBSRC_REF_SHAPE'
        $p = & $get $r 'path' 'OBSRC_REF_SHAPE'
        $s = & $get $r 'sha256' 'OBSRC_REF_PIN'
        if (($p -isnot [string]) -or ($p.Length -eq 0) -or ($p.IndexOf([char]0) -ge 0) -or (-not [System.IO.Path]::IsPathFullyQualified($p)) -or (-not [string]::Equals([System.IO.Path]::GetFullPath($p), $p, $ord))) { & $fail 'OBSRC_REF_PATH' }
        if (-not (& $isHex $s)) { & $fail 'OBSRC_REF_PIN' }
        return @{ path = [string]$p; sha256 = [string]$s }
    }
    $refDto = { param($r) [pscustomobject]([ordered]@{ path = [string]$r.path; sha256 = [string]$r.sha256 }) }

    try {
        & $exact $Evidence @('schema', 'accountingEvidence', 'registrationRef', 'terminalBindingRef', 'reviewCompletionRef') 'OBSRC_EVIDENCE_SHAPE'
        $evSchema = & $get $Evidence 'schema' 'OBSRC_EVIDENCE_SHAPE'
        if (($evSchema -isnot [string]) -or ($evSchema -cne 'ManagedObserveReviewedCompletionEvidence/v1')) { & $fail 'OBSRC_EVIDENCE_SCHEMA' }
        $acctEvidence = & $get $Evidence 'accountingEvidence' 'OBSRC_EVIDENCE_SHAPE'
        $regRef = & $refOf (& $get $Evidence 'registrationRef' 'OBSRC_EVIDENCE_SHAPE')
        $tbRef = & $refOf (& $get $Evidence 'terminalBindingRef' 'OBSRC_EVIDENCE_SHAPE')
        $rcRef = & $refOf (& $get $Evidence 'reviewCompletionRef' 'OBSRC_EVIDENCE_SHAPE')
        # Three distinct records: the same path or pin can never stand in for another role.
        if (($regRef.path -ieq $tbRef.path) -or ($regRef.path -ieq $rcRef.path) -or ($tbRef.path -ieq $rcRef.path)) { & $fail 'OBSRC_REF_DUPLICATE' }

        # ---- trusted sibling declarations only ----
        try {
            . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-sdk-observation.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-output-observation.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'continuity\reconcile.ps1')
            . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'host-continuation') 'registered-review-replay-context.ps1')
        } catch { & $fail 'OBSRC_SIBLING_UNAVAILABLE' }

        # Pending accounting: authenticated strict readers + captured SDK recount. UNKNOWN stays UNKNOWN.
        $pendingOf = {
            $r = Get-ManagedObservePendingAccountingFacts -Evidence $acctEvidence
            if ((@($r).Count -ne 1) -or ($r -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSRC_PENDING_SHAPE' }
            $valid = & $get $r 'Valid' 'OBSRC_PENDING_SHAPE'
            if ($valid -isnot [bool]) { & $fail 'OBSRC_PENDING_SHAPE' }
            if (-not $valid) {
                if (($null -ne $r.PSObject.Properties['Status']) -and ($r.Status -ceq 'UNKNOWN')) { & $unknown (& $clean $r.Reason 'PENDING_UNKNOWN') }
                & $fail (& $clean (& $get $r 'Code' 'OBSRC_PENDING_SHAPE') 'OBSRC_PENDING_REFUSED')
            }
            $facts = & $get $r 'Facts' 'OBSRC_PENDING_SHAPE'
            if ($facts -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSRC_PENDING_SHAPE' }
            return , $facts
        }
        $captureOf = {
            param($cur)
            $r = Get-ManagedNativeCapturedFacts -ManifestPath ([string]$cur.manifestPath) -ExpectedManifestSha256 ([string]$cur.manifestSha256) -TerminalPath ([string]$cur.terminalPath) -ExpectedTerminalSha256 ([string]$cur.terminalSha256) -TicketPath ([string]$cur.ticketPath) -RunId ([string]$cur.runId) -Attempt ([int][long]$cur.attempt) -ForOutputObservation
            if ((@($r).Count -ne 1) -or ($r -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSRC_CAPTURE_SHAPE' }
            $code = & $get $r 'Code' 'OBSRC_CAPTURE_SHAPE'
            if ($code -ceq 'OBSERVE_ONLY_CAPTURE_UNKNOWN') { & $unknown 'CAPTURE_UNKNOWN' }
            if (($code -cne 'OBSERVE_ONLY_TRANSPORT_CAPTURE') -or ((& $get $r 'Valid' 'OBSRC_CAPTURE_SHAPE') -isnot [bool]) -or (& $get $r 'Valid' 'OBSRC_CAPTURE_SHAPE')) { & $fail (& $clean $code 'OBSRC_CAPTURE_REFUSED') }
            $oc = & $get $r 'ObservationCapture' 'OBSRC_CAPTURE_SHAPE'
            if ($oc -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSRC_CAPTURE_SHAPE' }
            return , $oc
        }

        $pf = & $pendingOf
        $cur = $pf.evidence.current
        $cap1 = & $captureOf $cur
        $core1 = & $get $cap1 'Core' 'OBSRC_CAPTURE_SHAPE'
        $wd = & $get $core1 'workingDirectory' 'OBSRC_CAPTURE_SHAPE'
        if (($wd -isnot [string]) -or ($wd.Length -eq 0)) { & $fail 'OBSRC_CAPTURE_SHAPE' }
        $controlRoot = [IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')

        # Every ref must be a pinned ordinary file inside the controller evidence boundary (strict descendant of ControlRoot, no reparse point).
        $readRefs = {
            foreach ($rf in @($regRef, $tbRef, $rcRef)) {
                $x = $null
                try { $x = Read-ManagedPinnedEvidenceJson -Reference ([pscustomobject]@{ path = $rf.path; sha256 = $rf.sha256 }) -ControlRoot $controlRoot } catch { $x = $null }
                if (($null -eq $x) -or ($x.Sha256 -cne $rf.sha256) -or ($x.Path -cne $rf.path)) { & $fail 'OBSRC_REF_UNREADABLE' }
            }
        }
        & $readRefs

        $noHandler = { throw 'OBSRC_HANDLER_NOT_AUTHORITY' }
        $ctxOf = {
            $c = $null
            try {
                $c = Get-RegisteredReviewReplayContext -RegistrationPath $regRef.path -ExpectedRegistrationSha256 $regRef.sha256 -ExpectedTerminalBindingSha256 $tbRef.sha256 -ExpectedReviewCompletionSha256 $rcRef.sha256 -OnReviewedTerminal $noHandler
            } catch {
                if ([string]::Equals([string]$_.Exception.Message, 'REVIEW_PENDING', $ord)) { & $fail 'OBSRC_REVIEW_PENDING' }
                & $fail 'OBSRC_REGISTERED_RECORD'
            }
            if (($c -isnot [System.Management.Automation.PSCustomObject]) -or ((& $get $c 'schema' 'OBSRC_CONTEXT_SHAPE') -cne 'RegisteredReviewReplayContext/v1')) { & $fail 'OBSRC_CONTEXT_SHAPE' }
            return , $c
        }
        $ctx = & $ctxOf
        $binding = & $get $ctx 'binding' 'OBSRC_CONTEXT_SHAPE'
        $reg = $binding.prelaunch.registration
        $tb = $binding.terminalBinding
        $rc = $binding.reviewCompletion
        $request = $ctx.request
        $ackCtx = $ctx.startAcknowledgementContext
        $claim = $ackCtx.SelectedClaim

        # Refs bind exactly the records the registration names; the pins are the verified whole-file hashes.
        if (-not ((& $same $binding.registrationFileSha256 $regRef.sha256) -and (& $same $binding.terminalBindingFileSha256 $tbRef.sha256) -and (& $same $binding.reviewCompletionFileSha256 $rcRef.sha256))) { & $fail 'OBSRC_REF_PIN_MISMATCH' }
        if (-not ((& $same $reg.terminalBindingPath $tbRef.path) -and (& $same $reg.reviewCompletionPath $rcRef.path))) { & $fail 'OBSRC_REF_PATH_MISMATCH' }

        # Observe-only request profile with exact null stream cap; no token policy and no structured-output enforcement.
        if ((-not $request.ContainsKey('OutputStopProfile')) -or (-not (& $same $request['OutputStopProfile'] 'observe-only-v1'))) { & $fail 'OBSRC_REQUEST_PROFILE' }
        if ((-not $request.ContainsKey('MaxStreamBytes')) -or ($null -ne $request['MaxStreamBytes'])) { & $fail 'OBSRC_REQUEST_STREAM' }
        if ($request.ContainsKey('TokenAccountingPolicy') -or $request.ContainsKey('StructuredOutputProfile')) { & $fail 'OBSRC_REQUEST_PROFILE' }

        # Same current8 / same captured request-core as the accounting; raw request-file SHA and canonical request SHA stay distinct.
        $id = $pf.identity
        $refs = $pf.references
        if (-not ((& $same ([string]$id.runId) $reg.taskId) -and ([long]$id.attempt -eq [long]$reg.attempt))) { & $fail 'OBSRC_IDENTITY_MISMATCH' }
        if (-not ((& $same ([string]$id.taskId) $ackCtx.TaskId) -and (& $same ([string]$id.payloadSha256) $reg.payloadSha256))) { & $fail 'OBSRC_IDENTITY_MISMATCH' }
        if (-not ((& $sameIc ([string]$refs.ticket.path) $reg.ticketPath) -and (& $same ([string]$refs.ticket.verifiedSha256) $reg.ticketSha256))) { & $fail 'OBSRC_TICKET_MISMATCH' }
        if (-not ((& $sameIc ([string]$refs.manifest.path) $tb.manifestPath) -and (& $same ([string]$refs.manifest.verifiedSha256) $tb.manifestSha256) -and (& $same ([string]$refs.manifest.expectedSha256) $tb.manifestSha256))) { & $fail 'OBSRC_MANIFEST_MISMATCH' }
        if (-not ((& $sameIc ([string]$refs.terminal.path) $tb.terminalPath) -and (& $same ([string]$refs.terminal.verifiedSha256) $tb.terminalSha256) -and (& $same ([string]$refs.terminal.expectedSha256) $tb.terminalSha256))) { & $fail 'OBSRC_TERMINAL_MISMATCH' }
        if (-not (& $same ([string]$pf.accounting.requestSha256) $tb.requestSha256)) { & $fail 'OBSRC_REQUEST_MISMATCH' }
        if (-not (& $same ([string]$cap1.RequestSha256) $tb.requestSha256)) { & $fail 'OBSRC_REQUEST_MISMATCH' }
        if (-not (& $same ([string]$cap1.StartSha256) $tb.startSha256)) { & $fail 'OBSRC_START_MISMATCH' }
        if (-not (& $same ([string]$pf.timing.startUtc) ([string]$cap1.Start.startTimeUtc))) { & $fail 'OBSRC_START_MISMATCH' }
        if (([long]$cap1.Pid -ne [long]$id.pid) -or ([long]$cap1.Start.pid -ne [long]$id.pid)) { & $fail 'OBSRC_START_MISMATCH' }
        # Present artifact: the captured terminal artifact is the registered candidate, hash-pinned by the verified terminal binding.
        if (-not ((& $same ([string]$refs.artifactState) 'PRESENT') -and (& $same ([string]$cap1.ArtifactState) 'PRESENT') -and (& $sameIc ([string]$cap1.ArtifactPath) $tb.candidatePath) -and (& $sameIc $tb.candidatePath $reg.candidatePath))) { & $fail 'OBSRC_ARTIFACT_MISMATCH' }
        if (-not ((& $same $rc.candidateSha256 $tb.candidateSha256) -and (& $same $rc.terminalSha256 $tb.terminalSha256) -and (& $same $rc.terminalBindingSha256 $tbRef.sha256) -and (& $same $rc.registrationSha256 $regRef.sha256))) { & $fail 'OBSRC_REVIEW_BINDING' }
        if (-not (& $same $rc.verdict 'PASS_SCOPED')) { & $fail 'OBSRC_REVIEW_VERDICT' }
        $stateFile = [IO.Path]::Combine([string]$ackCtx.StateDir, 'continuation-state.json')
        if (-not (& $sameIc ([IO.Path]::GetFullPath([string]$claim.statePath)) $stateFile)) { & $fail 'OBSRC_CLAIM_STATE' }

        # ---- stability: registered records, refs, accounting and artifact are re-read after every other read ----
        $ctx2 = & $ctxOf
        if (-not (& $same ([string]$ctx2.fingerprint) ([string]$ctx.fingerprint))) { & $fail 'OBSRC_STALE_PROOF' }
        & $readRefs
        $pf2 = & $pendingOf
        if ((ConvertTo-Json -InputObject $pf2 -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $pf -Depth 12 -Compress)) { & $fail 'OBSRC_STALE_ACCOUNTING' }
        $cap2 = & $captureOf $pf2.evidence.current
        if (-not ((& $same ([string]$cap2.ArtifactState) ([string]$cap1.ArtifactState)) -and (& $same ([string]$cap2.ArtifactPath) ([string]$cap1.ArtifactPath)) -and (& $same ([string]$cap2.TerminalSha256) ([string]$cap1.TerminalSha256)) -and (& $same ([string]$cap2.StartSha256) ([string]$cap1.StartSha256)))) { & $fail 'OBSRC_STALE_CAPTURE' }

        $claimDto = [pscustomobject]([ordered]@{ id = [string]$claim.id; owner = [string]$claim.owner; claimId = [string]$claim.claimId; intentId = [string]$claim.intentId; receiptSha = [string]$claim.receiptSha; planSha = [string]$claim.planSha; statePath = [string]$claim.statePath })
        $proof = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveReviewedCompletion/v1'
            registrationRef = (& $refDto $regRef)
            terminalBindingRef = (& $refDto $tbRef)
            reviewCompletionRef = (& $refDto $rcRef)
            registrationId = [string]$reg.registrationId
            claim = $claimDto
            stateDir = [string]$ackCtx.StateDir
            taskId = [string]$id.taskId
            runId = [string]$id.runId
            attempt = [long]$id.attempt
            pid = [long]$id.pid
            startIdentity = [string]$pf.timing.startUtc
            requestRawSha256 = [string]$reg.requestSha256
            requestSha256 = [string]$tb.requestSha256
            ticketSha256 = [string]$reg.ticketSha256
            payloadSha256 = [string]$reg.payloadSha256
            manifestSha256 = [string]$tb.manifestSha256
            startSha256 = [string]$tb.startSha256
            terminalSha256 = [string]$tb.terminalSha256
            candidatePath = [string]$tb.candidatePath
            candidateSha256 = [string]$tb.candidateSha256
            reviewPath = [string]$rc.reviewPath
            reviewSha256 = [string]$rc.reviewSha256
            verdict = 'PASS_SCOPED'
            ackSnapshotPath = [string]$tb.ackPath
            ackSnapshotSha256 = [string]$tb.ackSha256
            ackMode = $true
            onStartedAcknowledged = $true
            fingerprint = [string]$ctx.fingerprint
            noDispatch = $true
            noOutboxPublication = $true
        })
        $normEvidence = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveReviewedCompletionEvidence/v1'
            accountingEvidence = $pf.evidence
            registrationRef = (& $refDto $regRef)
            terminalBindingRef = (& $refDto $tbRef)
            reviewCompletionRef = (& $refDto $rcRef)
        })
        $paths = [System.Collections.Generic.List[string]]::new()
        foreach ($ip in @($pf.inputPaths)) { $paths.Add([string]$ip) }
        foreach ($ip in @($regRef.path, $tbRef.path, $rcRef.path, [string]$tb.candidatePath, [string]$rc.reviewPath, [string]$tb.ackPath, [string]$reg.requestPath, [string]$tb.startPath)) { $paths.Add($ip) }
        $facts = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveReviewedCompletionFacts/v1'
            evidence = $normEvidence
            pending = $pf
            proof = $proof
            inputPaths = @($paths.ToArray())
            noDispatch = $true; noOutboxPublication = $true
        })
        return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'REVIEWED_COMPLETION'; Facts = $facts }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($m.StartsWith('UNKNOWN:', $ord) -and ($m.Length -le 56) -and ($m.Substring(8) -cmatch '^[A-Z0-9_]{1,48}$')) {
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_COMPLETION_UNKNOWN'; Result = 'NONRECEIPT'; Status = 'UNKNOWN'; Reason = $m.Substring(8); Facts = $null }
        }
        $code = 'OBSRC_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', $ord) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Result = 'REFUSED'; Facts = $null }
    }
}

function Test-ManagedObserveReviewedReceiptV4Shape {
    # Pure structural check of a stored OperationalRunReceipt/v4 DTO. It derives nothing, authenticates nothing and confers no validity.
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
        $ord = [System.StringComparison]::Ordinal
        $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
        $exact = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $ps = @($o.PSObject.Properties)
            if ($ps.Count -ne $names.Count) { return $false }
            foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { return $false } }
            return $true
        }
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $isStr = { param($v) ($v -is [string]) -and ($v.Length -gt 0) }

        if (-not (& $exact $obj @('schemaVersion', 'runId', 'taskId', 'payloadSha256', 'destination', 'status', 'attempt', 'sessionId', 'historyVerified', 'budget', 'provider', 'artifact', 'updatedAt', 'evidence', 'outputStopMode', 'observeReviewedCompletionEvidence', 'observePendingAccounting', 'observeReviewedCompletion'))) { return $false }
        if (((& $val $obj 'schemaVersion') -isnot [string]) -or ((& $val $obj 'schemaVersion') -cne 'OperationalRunReceipt/v4')) { return $false }
        if (((& $val $obj 'status') -isnot [string]) -or ((& $val $obj 'status') -cne 'COMPLETED')) { return $false }
        if (((& $val $obj 'outputStopMode') -isnot [string]) -or ((& $val $obj 'outputStopMode') -cne 'OBSERVE_ONLY')) { return $false }
        if (((& $val $obj 'destination') -isnot [string]) -or ((& $val $obj 'destination') -cne 'Anthropic Claude')) { return $false }
        # Selected accounting lineage is not a universal history certification.
        $hv = & $val $obj 'historyVerified'
        if (($hv -isnot [bool]) -or $hv) { return $false }
        foreach ($n in @('runId', 'taskId', 'sessionId', 'updatedAt')) { if (-not (& $isStr (& $val $obj $n))) { return $false } }
        if (-not (& $isHex (& $val $obj 'payloadSha256'))) { return $false }
        $attempt = & $val $obj 'attempt'
        if ((-not (& $isInt $attempt)) -or ([long]$attempt -lt 1)) { return $false }

        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $a = & $val $obj 'artifact'
        $e = & $val $obj 'evidence'
        if (-not ((& $exact $b @('maxOutputTokens', 'maxElapsedMs', 'maxAttempts', 'usedElapsedMs', 'usedOutputTokens', 'attemptsUsed', 'softFraction')) -and (& $exact $p @('startIdentity', 'sessionId', 'terminalReason', 'pid')) -and (& $exact $a @('complete', 'sha256', 'path')) -and (& $exact $e @('rawPath', 'rawSha256', 'ticketPath', 'ticketSha256', 'usagePath', 'usageSha256', 'nativeThinkingTokens')))) { return $false }
        if (($null -ne (& $val $b 'maxOutputTokens')) -or ($null -ne (& $val $b 'softFraction'))) { return $false }
        foreach ($n in @('maxAttempts', 'usedElapsedMs', 'usedOutputTokens', 'attemptsUsed')) { if (-not (& $isInt (& $val $b $n))) { return $false } }
        # maxElapsedMs: exact null = no total author deadline (compared to authenticated facts elsewhere); otherwise a positive typed integer.
        if (($null -ne (& $val $b 'maxElapsedMs')) -and (-not (& $isInt (& $val $b 'maxElapsedMs')))) { return $false }
        if ((($null -ne (& $val $b 'maxElapsedMs')) -and ([long](& $val $b 'maxElapsedMs') -le 0)) -or ([long](& $val $b 'maxAttempts') -le 0) -or ([long](& $val $b 'usedElapsedMs') -lt 0) -or ([long](& $val $b 'usedOutputTokens') -lt 0)) { return $false }
        if (([long](& $val $b 'attemptsUsed') -ne [long]$attempt) -or ([long]$attempt -gt [long](& $val $b 'maxAttempts')) -or (($null -ne (& $val $b 'maxElapsedMs')) -and ([long](& $val $b 'usedElapsedMs') -gt [long](& $val $b 'maxElapsedMs')))) { return $false }
        if (-not (& $isStr (& $val $p 'startIdentity'))) { return $false }
        if ((-not (& $isStr (& $val $p 'sessionId'))) -or ((& $val $p 'sessionId') -cne (& $val $obj 'sessionId')) -or (-not (& $isStr (& $val $p 'terminalReason')))) { return $false }
        if ((-not (& $isInt (& $val $p 'pid'))) -or ([long](& $val $p 'pid') -le 0)) { return $false }
        $ac = & $val $a 'complete'
        if (($ac -isnot [bool]) -or (-not $ac) -or (-not (& $isHex (& $val $a 'sha256'))) -or (-not (& $isStr (& $val $a 'path')))) { return $false }
        foreach ($n in @('rawPath', 'ticketPath', 'usagePath')) { if (-not (& $isStr (& $val $e $n))) { return $false } }
        foreach ($n in @('rawSha256', 'ticketSha256', 'usageSha256')) { if (-not (& $isHex (& $val $e $n))) { return $false } }
        if ($null -ne (& $val $e 'nativeThinkingTokens')) { return $false }
        $ce = & $val $obj 'observeReviewedCompletionEvidence'
        if (-not (& $exact $ce @('schema', 'accountingEvidence', 'registrationRef', 'terminalBindingRef', 'reviewCompletionRef'))) { return $false }
        if (((& $val $ce 'schema') -isnot [string]) -or ((& $val $ce 'schema') -cne 'ManagedObserveReviewedCompletionEvidence/v1')) { return $false }
        foreach ($n in @('registrationRef', 'terminalBindingRef', 'reviewCompletionRef')) {
            $rf = & $val $ce $n
            if ((-not (& $exact $rf @('path', 'sha256'))) -or (-not (& $isStr (& $val $rf 'path'))) -or (-not (& $isHex (& $val $rf 'sha256')))) { return $false }
        }
        if (((& $val $obj 'observePendingAccounting') -isnot [System.Management.Automation.PSCustomObject]) -or ((& $val $obj 'observeReviewedCompletion') -isnot [System.Management.Automation.PSCustomObject]) -or ((& $val $ce 'accountingEvidence') -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        return $true
    } catch { return $false }
}

function Compare-ManagedObserveReviewedReceiptV4ToFacts {
    # STRUCTURAL ONLY: compares one stored v4 receipt DTO to facts the CALLER derived itself from raw authenticated captures and records.
    # It never reads evidence, never authenticates and confers no receipt validity, settlement or dispatch authority; callers must derive the
    # facts internally (Get-ManagedObserveReviewedCompletionFacts) and reauthenticate the raw DTO themselves.
    param($obj, $f)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        if (($null -eq $f) -or ($f -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        $ord = [System.StringComparison]::Ordinal
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $p = $f.pending
        $pr = $f.proof
        # Shared identity, limits, accounting and evidence comparison with the v3 pending facts the proof is bound to.
        if (-not (Compare-ManagedObservePendingReceiptV3ToFacts $obj $p)) { return $false }
        $prov = & $val $obj 'provider'
        $art = & $val $obj 'artifact'
        if (((& $val $prov 'startIdentity') -cne [string]$p.timing.startUtc) -or ((& $val $prov 'startIdentity') -cne [string]$pr.startIdentity)) { return $false }
        if (((& $val $art 'complete') -isnot [bool]) -or (-not (& $val $art 'complete'))) { return $false }
        if (((& $val $art 'path') -cne [string]$pr.candidatePath) -or ((& $val $art 'sha256') -cne [string]$pr.candidateSha256)) { return $false }
        if ((ConvertTo-Json -InputObject (& $val $obj 'observeReviewedCompletionEvidence') -Depth 8 -Compress) -cne (ConvertTo-Json -InputObject $f.evidence -Depth 8 -Compress)) { return $false }
        if ((ConvertTo-Json -InputObject (& $val $obj 'observeReviewedCompletion') -Depth 8 -Compress) -cne (ConvertTo-Json -InputObject $pr -Depth 8 -Compress)) { return $false }
        return $true
    } catch { return $false }
}

function Test-ManagedObserveReviewedRawDto {
    # Read-only. Same raw-DTO cross-check as the pending path, additionally refusing any collision with the registered proof paths.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [AllowNull()][AllowEmptyString()][string]$ExpectedSha256,
        [Parameter(Mandatory)]$Facts
    )
    $p = $Facts.pending
    $shim = [pscustomobject]([ordered]@{ identity = $p.identity; timing = $p.timing; accounting = $p.accounting; inputPaths = @($Facts.inputPaths) })
    return Test-ManagedObservePendingRawDto -RawPath $RawPath -ExpectedSha256 $ExpectedSha256 -Facts $shim
}

function Get-ManagedObserveFailedTransportFacts {
    # Read-only. Authenticates ONE failed OBSERVE_ONLY native transport (terminal DEADLINE, nonzero typed exit) joined to its selected parent receipt,
    # its registration, its selected claim and its actual keyed start ACK. HUMAN-SELECTED narrow disposition AUTHENTICATED_FAILED_TERMINAL: the facts
    # preserve the actual failure and the last VERIFIED parent total; the current and cumulative counts stay UNKNOWN (null, never zero) and no SDK
    # success, completion, dispatch, retry or successor authority is derived. The parent chain is authenticated by the same machinery as pending
    # accounting (SELECTED_ACCOUNTING_ANCHOR lineage preserved). This verifier authenticates referenced data only, never external human authority.
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Evidence)
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    $ordIc = [System.StringComparison]::OrdinalIgnoreCase
    $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    $unknown = { param([string]$c) throw [System.InvalidOperationException]::new('UNKNOWN:' + $c) }
    $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
    $clean = { param($v, [string]$d) if (($v -is [string]) -and ($v -cmatch '^[A-Z0-9_]{1,48}\z')) { return $v }; return $d }
    $get = {
        param($o, [string]$n, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        foreach ($q in $o.PSObject.Properties) { if (($q.MemberType -eq $note) -and [string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }
        & $fail $c
    }
    $exact = {
        param($o, [string[]]$names, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        $ps = @($o.PSObject.Properties)
        if ($ps.Count -ne $names.Count) { & $fail $c }
        foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { & $fail $c } }
    }
    $same = { param($a, $b) ($a -is [string]) -and ($b -is [string]) -and [string]::Equals($a, $b, $ord) }
    $samePath = {
        param($a, $b)
        if (($a -isnot [string]) -or ($b -isnot [string]) -or ($a.Length -eq 0) -or ($b.Length -eq 0)) { return $false }
        return [string]::Equals([System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($a)), [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($b)), $ordIc)
    }
    $json = { param($o) ConvertTo-Json -InputObject $o -Depth 12 -Compress }
    $shaText = { param([string]$t) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.UTF8Encoding]::new($false).GetBytes($t))).ToLowerInvariant() }
    $str = { param($o, [string]$n, [string]$c) $v = & $get $o $n $c; if (($v -isnot [string]) -or ($v.Length -eq 0) -or ([string]::IsNullOrWhiteSpace($v))) { & $fail $c }; return $v }
    $posInt = { param($v, [string]$c) if ((($v -isnot [int]) -and ($v -isnot [long])) -or ([long]$v -le 0)) { & $fail $c }; return [long]$v }
    $refOf = {
        param($r)
        & $exact $r @('path', 'sha256') 'OBSFT_REF_SHAPE'
        $p = & $get $r 'path' 'OBSFT_REF_SHAPE'
        $s = & $get $r 'sha256' 'OBSFT_REF_PIN'
        if (($p -isnot [string]) -or ($p.Length -eq 0) -or ($p.IndexOf([char]0) -ge 0) -or (-not [System.IO.Path]::IsPathFullyQualified($p)) -or (-not [string]::Equals([System.IO.Path]::GetFullPath($p), $p, $ord))) { & $fail 'OBSFT_REF_PATH' }
        if (-not (& $isHex $s)) { & $fail 'OBSFT_REF_PIN' }
        return @{ path = [string]$p; sha256 = [string]$s }
    }
    $refDto = { param($r) [pscustomobject]([ordered]@{ path = [string]$r.path; sha256 = [string]$r.sha256 }) }

    try {
        & $exact $Evidence @('schema', 'current', 'predecessorReceipt', 'registrationRef', 'selectedClaimRef', 'acknowledgementsRef') 'OBSFT_EVIDENCE_SHAPE'
        $evSchema = & $get $Evidence 'schema' 'OBSFT_EVIDENCE_SHAPE'
        if (($evSchema -isnot [string]) -or ($evSchema -cne 'ManagedObserveFailedTransportEvidence/v1')) { & $fail 'OBSFT_EVIDENCE_SCHEMA' }
        $curDto = & $get $Evidence 'current' 'OBSFT_EVIDENCE_SHAPE'
        $preDto = & $get $Evidence 'predecessorReceipt' 'OBSFT_EVIDENCE_SHAPE'
        $preRef = & $refOf $preDto
        $regRef = & $refOf (& $get $Evidence 'registrationRef' 'OBSFT_EVIDENCE_SHAPE')
        $claimRef = & $refOf (& $get $Evidence 'selectedClaimRef' 'OBSFT_EVIDENCE_SHAPE')
        $ackRef = & $refOf (& $get $Evidence 'acknowledgementsRef' 'OBSFT_EVIDENCE_SHAPE')
        # Four distinct records: the same path can never stand in for another role.
        $roleRefs = @($preRef, $regRef, $claimRef, $ackRef)
        for ($i = 0; $i -lt $roleRefs.Count; $i++) {
            for ($j = $i + 1; $j -lt $roleRefs.Count; $j++) {
                if ([string]::Equals([string]$roleRefs[$i].path, [string]$roleRefs[$j].path, $ordIc)) { & $fail 'OBSFT_REF_DUPLICATE' }
            }
        }
        $pendEv = [pscustomobject]([ordered]@{ schema = 'ManagedObservePendingAccountingEvidence/v1'; current = $curDto; predecessorReceipt = $preDto })

        # ---- trusted sibling declarations only; nothing is loaded from the captured workingDirectory ----
        try {
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
            . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'host-continuation') 'registered-review-record-reader.ps1')
            . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'host-continuation') 'registered-review-prelaunch-capture.ps1')
        } catch { & $fail 'OBSFT_SIBLING_UNAVAILABLE' }

        # Parent lineage + failed current capture: the shared pending-accounting derivation in its failed-transport mode.
        $baseOf = {
            $r = Get-ManagedObservePendingAccountingFacts -Evidence $pendEv -FailedTransportCurrent
            if ((@($r).Count -ne 1) -or ($r -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSFT_BASE_SHAPE' }
            $valid = & $get $r 'Valid' 'OBSFT_BASE_SHAPE'
            if ($valid -isnot [bool]) { & $fail 'OBSFT_BASE_SHAPE' }
            if (-not $valid) {
                if (($null -ne $r.PSObject.Properties['Status']) -and ($r.Status -ceq 'UNKNOWN')) { & $unknown (& $clean $r.Reason 'BASE_UNKNOWN') }
                & $fail (& $clean (& $get $r 'Code' 'OBSFT_BASE_SHAPE') 'OBSFT_BASE_REFUSED')
            }
            $bs = & $get $r 'Base' 'OBSFT_BASE_SHAPE'
            if ($bs -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSFT_BASE_SHAPE' }
            return , $bs
        }

        $claimNames = @('id', 'owner', 'claimId', 'intentId', 'receiptSha', 'planSha', 'statePath')
        $reqNames = @('RunId', 'Attempt', 'TicketPath', 'PayloadPath', 'GateTicketPath', 'SettingsPath', 'ArtifactPath', 'WorkingDirectory', 'Arguments', 'MaxElapsedMs', 'MaxStreamBytes', 'OutputStopProfile')
        $noHandler = { throw 'OBSFT_HANDLER_NOT_AUTHORITY' }

        # Registration, selected claim and keyed ACK bound to the authenticated base. Run twice (before and after the second base) and compared.
        $bindAll = {
            param($bs)
            $cap = & $get $bs 'Capture' 'OBSFT_BASE_SHAPE'
            $bnd = & $get $bs 'Bound' 'OBSFT_BASE_SHAPE'
            $par = & $get $bs 'ParentReceipt' 'OBSFT_BASE_SHAPE'
            $core = & $get $cap 'Core' 'OBSFT_BASE_SHAPE'
            $term = & $get $cap 'Terminal' 'OBSFT_BASE_SHAPE'
            $wd = & $str $core 'workingDirectory' 'OBSFT_BASE_SHAPE'
            $controlRoot = [System.IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')
            $readCtl = {
                param($rf)
                $x = $null
                try { $x = Read-ManagedPinnedEvidenceJson -Reference ([pscustomobject]@{ path = $rf.path; sha256 = $rf.sha256 }) -ControlRoot $controlRoot } catch { $x = $null }
                if (($null -eq $x) -or ($x.Sha256 -cne $rf.sha256) -or ($x.Path -cne $rf.path) -or ($x.Value -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSFT_REF_UNREADABLE' }
                return , $x
            }
            if (-not ((& $get $term 'onStartedAcknowledged' 'OBSFT_TERMINAL') -is [bool])) { & $fail 'OBSFT_TERMINAL' }
            if ((& $get $term 'onStartedAcknowledged' 'OBSFT_TERMINAL') -ne $true) { & $fail 'OBSFT_START_NOT_ACKNOWLEDGED' }
            $ackMode = & $get $core 'ackMode' 'OBSFT_CORE_ACK'
            if (($ackMode -isnot [bool]) -or (-not $ackMode)) { & $fail 'OBSFT_CORE_ACK' }

            # ---- registration: pinned control record naming the same captured request, ticket, payload, run directory and run ----
            $regX = & $readCtl $regRef
            $pre = $null
            try { $pre = Get-RegisteredReviewPrelaunchCapture -Registration $regX.Value -ExpectedRegistrationSha256 $regRef.sha256 -OnReviewedTerminal $noHandler } catch { $pre = $null }
            if (($null -eq $pre) -or ($pre.registration -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSFT_REGISTRATION' }
            $reg = $pre.registration
            if (-not (& $same ([string]$reg.taskId) ([string]$cap.RunId))) { & $fail 'OBSFT_REG_IDENTITY' }
            if ([long]$reg.attempt -ne [long]$cap.Attempt) { & $fail 'OBSFT_REG_IDENTITY' }
            if (-not ((& $samePath ([string]$reg.ticketPath) ([string]$cap.TicketPath)) -and (& $same ([string]$reg.ticketSha256) ([string]$cap.TicketSha256)))) { & $fail 'OBSFT_REG_TICKET' }
            if (-not ((& $same ([string]$reg.payloadSha256) ([string]$bnd.payloadSha256)) -and (& $samePath ([string]$reg.payloadPath) ([string](& $get $core 'payloadPath' 'OBSFT_BASE_SHAPE'))))) { & $fail 'OBSFT_REG_PAYLOAD' }
            if (-not (& $samePath ([string]$reg.candidatePath) ([string]$cap.ArtifactPath))) { & $fail 'OBSFT_REG_ARTIFACT' }
            if (-not (& $samePath ([string]$reg.runDir) ([string]$cap.RunDir))) { & $fail 'OBSFT_REG_RUNDIR' }
            if ([string]::IsNullOrWhiteSpace([string]$reg.registeredActionId)) { & $fail 'OBSFT_REG_ACTION' }

            # ---- raw request file named by the registration (raw-file SHA stays distinct from the canonical request SHA) ----
            $reqRead = $null
            try { $reqRead = Read-RegisteredReviewRecord -Path ([string]$reg.requestPath) -ExpectedSha256 ([string]$reg.requestSha256) } catch { $reqRead = $null }
            if ($null -eq $reqRead) { & $fail 'OBSFT_REQUEST_UNREADABLE' }
            $rq = $reqRead.record
            & $exact $rq $reqNames 'OBSFT_REQUEST_SHAPE'
            if (-not (& $same ([string](& $get $rq 'RunId' 'OBSFT_REQUEST_SHAPE')) ([string]$reg.taskId))) { & $fail 'OBSFT_REQUEST_BINDING' }
            if ((& $posInt (& $get $rq 'Attempt' 'OBSFT_REQUEST_SHAPE') 'OBSFT_REQUEST_BINDING') -ne [long]$reg.attempt) { & $fail 'OBSFT_REQUEST_BINDING' }
            if (-not ((& $same ([string](& $get $rq 'TicketPath' 'OBSFT_REQUEST_SHAPE')) ([string]$reg.ticketPath)) -and (& $same ([string](& $get $rq 'PayloadPath' 'OBSFT_REQUEST_SHAPE')) ([string]$reg.payloadPath)) -and (& $same ([string](& $get $rq 'ArtifactPath' 'OBSFT_REQUEST_SHAPE')) ([string]$reg.candidatePath)))) { & $fail 'OBSFT_REQUEST_BINDING' }
            if (-not ((& $samePath ([string](& $get $rq 'GateTicketPath' 'OBSFT_REQUEST_SHAPE')) ([string](& $get $core 'gateTicketPath' 'OBSFT_BASE_SHAPE'))) -and (& $samePath ([string](& $get $rq 'SettingsPath' 'OBSFT_REQUEST_SHAPE')) ([string](& $get $core 'settingsPath' 'OBSFT_BASE_SHAPE'))) -and (& $samePath ([string](& $get $rq 'WorkingDirectory' 'OBSFT_REQUEST_SHAPE')) $wd))) { & $fail 'OBSFT_REQUEST_BINDING' }
            $rqElapsed = & $get $rq 'MaxElapsedMs' 'OBSFT_REQUEST_SHAPE'
            if ((($rqElapsed -isnot [int]) -and ($rqElapsed -isnot [long])) -or ([long]$rqElapsed -ne [long]$bnd.maxElapsedMs)) { & $fail 'OBSFT_REQUEST_BINDING' }
            if (($null -ne (& $get $rq 'MaxStreamBytes' 'OBSFT_REQUEST_SHAPE')) -or (-not (& $same ([string](& $get $rq 'OutputStopProfile' 'OBSFT_REQUEST_SHAPE')) 'observe-only-v1'))) { & $fail 'OBSFT_REQUEST_PROFILE' }
            $rqArgs = & $get $rq 'Arguments' 'OBSFT_REQUEST_SHAPE'
            $coreArgs = & $get $core 'arguments' 'OBSFT_BASE_SHAPE'
            if (($rqArgs -isnot [object[]]) -or ($coreArgs -isnot [object[]]) -or ($rqArgs.Length -ne $coreArgs.Length)) { & $fail 'OBSFT_REQUEST_BINDING' }
            for ($ai = 0; $ai -lt $rqArgs.Length; $ai++) { if (-not (& $same ([string]$rqArgs[$ai]) ([string]$coreArgs[$ai]))) { & $fail 'OBSFT_REQUEST_BINDING' } }

            # ---- selected claim: pinned immutable selection evidence equal to the claim the ACTUAL captured core launched under ----
            $ackCtx = & $get $core 'ackContext' 'OBSFT_CORE_ACK'
            & $exact $ackCtx @('stateDir', 'taskId', 'claim') 'OBSFT_CORE_ACK'
            $coreClaim = & $get $ackCtx 'claim' 'OBSFT_CORE_ACK'
            & $exact $coreClaim $claimNames 'OBSFT_CORE_ACK'
            $claimX = & $readCtl $claimRef
            $selClaim = $claimX.Value
            # The selected record is the exact-10 registered selection (identity seven + kind/provider/route); the captured core carries only the exact-7.
            # The seven identity fields are compared; kind/provider/route are typed and retained as metadata, never used as authority.
            & $exact $selClaim ($claimNames + @('kind', 'provider', 'route')) 'OBSFT_CLAIM_SHAPE'
            $claimOut = [ordered]@{}
            foreach ($n in $claimNames) {
                $cv = & $str $selClaim $n 'OBSFT_CLAIM_SHAPE'
                if (-not (& $same $cv ([string](& $get $coreClaim $n 'OBSFT_CORE_ACK')))) { & $fail 'OBSFT_CLAIM_BINDING' }
                if ((($n -ceq 'receiptSha') -or ($n -ceq 'planSha')) -and (-not (& $isHex $cv))) { & $fail 'OBSFT_CLAIM_SHAPE' }
                $claimOut[$n] = $cv
            }
            $selMeta = [pscustomobject]([ordered]@{ kind = (& $str $selClaim 'kind' 'OBSFT_CLAIM_SHAPE'); provider = (& $str $selClaim 'provider' 'OBSFT_CLAIM_SHAPE'); route = (& $str $selClaim 'route' 'OBSFT_CLAIM_SHAPE') })
            $claim = [pscustomobject]$claimOut
            $stateDir = & $str $ackCtx 'stateDir' 'OBSFT_CORE_ACK'
            $ctxTaskId = & $str $ackCtx 'taskId' 'OBSFT_CORE_ACK'
            if (-not (& $same $ctxTaskId ([string]$bnd.taskId))) { & $fail 'OBSFT_CLAIM_BINDING' }
            if (-not (& $samePath $claim.statePath ([System.IO.Path]::Combine($stateDir, 'continuation-state.json')))) { & $fail 'OBSFT_CLAIM_STATE' }
            # Parent hash, parent run/attempt and original action are all inside the claim's intent key.
            if (-not (& $same $claim.receiptSha ([string]$par.sha256))) { & $fail 'OBSFT_CLAIM_PARENT' }
            # The ORIGINAL action is the claim/task action (claim.id == task); the registered review action is a different, separately retained identity.
            if (-not (& $same $claim.id $ctxTaskId)) { & $fail 'OBSFT_CLAIM_ACTION' }
            $wantIntent = $claim.receiptSha + '|' + [string]$par.runId + '|' + [string]$par.attempt + '|' + $claim.id
            if (-not (& $same $claim.intentId $wantIntent)) { & $fail 'OBSFT_CLAIM_INTENT' }

            # ---- keyed start ACK snapshot: exact envelope, exactly one keyed entry, native binding equal to the actual started process ----
            $ackX = & $readCtl $ackRef
            $ackRoot = $ackX.Value
            & $exact $ackRoot @('schema', 'acknowledgements') 'OBSFT_ACK_SHAPE'
            if (-not (& $same ([string](& $get $ackRoot 'schema' 'OBSFT_ACK_SHAPE')) 'host-dispatch-acknowledgement/v1')) { & $fail 'OBSFT_ACK_SHAPE' }
            $acks = & $get $ackRoot 'acknowledgements' 'OBSFT_ACK_SHAPE'
            if ($acks -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSFT_ACK_SHAPE' }
            $ackKey = $claim.intentId + '|' + $claim.claimId
            $found = [System.Collections.Generic.List[object]]::new()
            foreach ($ap in @($acks.PSObject.Properties)) { if ([string]::Equals([string]$ap.Name, $ackKey, $ord)) { $found.Add($ap.Value) } }
            if ($found.Count -ne 1) { & $fail 'OBSFT_ACK_ENTRY' }
            $entry = $found[0]
            & $exact $entry @('schema', 'recordedAt', 'entryId', 'owner', 'claimId', 'intentId', 'dispatchedAt', 'executionBinding') 'OBSFT_ACK_SHAPE'
            if (-not (& $same ([string](& $get $entry 'schema' 'OBSFT_ACK_SHAPE')) 'host-dispatch-acknowledgement/v1')) { & $fail 'OBSFT_ACK_SHAPE' }
            $parsedAt = [datetime]::MinValue
            foreach ($tf in @('recordedAt', 'dispatchedAt')) {
                $tv = & $str $entry $tf 'OBSFT_ACK_SHAPE'
                if (-not [datetime]::TryParse($tv, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedAt)) { & $fail 'OBSFT_ACK_SHAPE' }
            }
            if (-not (& $same ([string](& $get $entry 'dispatchedAt' 'OBSFT_ACK_SHAPE')) ([string]$bnd.startUtc))) { & $fail 'OBSFT_ACK_START' }
            if (-not ((& $same ([string](& $get $entry 'entryId' 'OBSFT_ACK_SHAPE')) $claim.id) -and (& $same ([string](& $get $entry 'owner' 'OBSFT_ACK_SHAPE')) $claim.owner) -and (& $same ([string](& $get $entry 'claimId' 'OBSFT_ACK_SHAPE')) $claim.claimId) -and (& $same ([string](& $get $entry 'intentId' 'OBSFT_ACK_SHAPE')) $claim.intentId))) { & $fail 'OBSFT_ACK_CLAIM' }
            $eb = & $get $entry 'executionBinding' 'OBSFT_ACK_SHAPE'
            & $exact $eb @('schema', 'taskId', 'ticketSha256', 'payloadSha256', 'runId', 'attempt', 'receiptSha', 'planSha', 'identity') 'OBSFT_ACK_BINDING'
            if (-not (& $same ([string](& $get $eb 'schema' 'OBSFT_ACK_BINDING')) 'host-dispatch-execution-binding/v1')) { & $fail 'OBSFT_ACK_BINDING' }
            if (-not ((& $same ([string](& $get $eb 'taskId' 'OBSFT_ACK_BINDING')) ([string]$bnd.taskId)) -and (& $same ([string](& $get $eb 'ticketSha256' 'OBSFT_ACK_BINDING')) ([string]$cap.TicketSha256)) -and (& $same ([string](& $get $eb 'payloadSha256' 'OBSFT_ACK_BINDING')) ([string]$bnd.payloadSha256)) -and (& $same ([string](& $get $eb 'runId' 'OBSFT_ACK_BINDING')) ([string]$cap.RunId)) -and (& $same ([string](& $get $eb 'receiptSha' 'OBSFT_ACK_BINDING')) $claim.receiptSha) -and (& $same ([string](& $get $eb 'planSha' 'OBSFT_ACK_BINDING')) $claim.planSha))) { & $fail 'OBSFT_ACK_BINDING' }
            if ((& $posInt (& $get $eb 'attempt' 'OBSFT_ACK_BINDING') 'OBSFT_ACK_BINDING') -ne [long]$cap.Attempt) { & $fail 'OBSFT_ACK_BINDING' }
            $ident = & $get $eb 'identity' 'OBSFT_ACK_BINDING'
            & $exact $ident @('kind', 'pid', 'startIdentity') 'OBSFT_ACK_IDENTITY'
            if (-not (& $same ([string](& $get $ident 'kind' 'OBSFT_ACK_IDENTITY')) 'native')) { & $fail 'OBSFT_ACK_IDENTITY' }
            if ((& $posInt (& $get $ident 'pid' 'OBSFT_ACK_IDENTITY') 'OBSFT_ACK_IDENTITY') -ne [long]$bnd.pid) { & $fail 'OBSFT_ACK_IDENTITY' }
            if (-not (& $same ([string](& $get $ident 'startIdentity' 'OBSFT_ACK_IDENTITY')) ([string]$bnd.startUtc))) { & $fail 'OBSFT_ACK_IDENTITY' }

            return [pscustomobject]([ordered]@{
                schema = 'ManagedObserveFailedTransportProof/v1'
                registrationRef = (& $refDto $regRef)
                selectedClaimRef = (& $refDto $claimRef)
                acknowledgementsRef = (& $refDto $ackRef)
                registrationId = [string]$reg.registrationId
                registeredActionId = [string]$reg.registeredActionId
                claim = $claim
                selectedClaimMetadata = $selMeta
                originalActionId = [string]$claim.id
                stateDir = $stateDir
                taskId = [string]$bnd.taskId
                runId = [string]$cap.RunId
                attempt = [long]$cap.Attempt
                pid = [long]$bnd.pid
                startIdentity = [string]$bnd.startUtc
                requestRawSha256 = [string]$reg.requestSha256
                requestSha256 = [string]$cap.RequestSha256
                ticketSha256 = [string]$cap.TicketSha256
                payloadSha256 = [string]$bnd.payloadSha256
                manifestSha256 = [string]$cap.ManifestSha256
                startSha256 = [string]$cap.StartSha256
                terminalSha256 = [string]$cap.TerminalSha256
                parentReceiptSha256 = [string]$par.sha256
                parentRunId = [string]$par.runId
                parentAttempt = [long]$par.attempt
                ackKey = $ackKey
                ackEntrySha256 = (& $shaText (ConvertTo-Json -InputObject $entry -Depth 20 -Compress))
                ackMode = $true
                onStartedAcknowledged = $true
                requestPath = [string]$reg.requestPath
                noDispatch = $true; noRetry = $true
            })
        }

        $base1 = & $baseOf
        $proof1 = & $bindAll $base1
        # ---- stability: the whole parent/capture derivation and every registered record are reauthenticated after all other reads ----
        $base2 = & $baseOf
        if ((& $json $base2) -cne (& $json $base1)) { & $fail 'OBSFT_STALE_BASE' }
        $proof2 = & $bindAll $base2
        if ((& $json $proof2) -cne (& $json $proof1)) { & $fail 'OBSFT_STALE_PROOF' }

        $cap = $base1.Capture
        $bnd = $base1.Bound
        $par = $base1.ParentReceipt
        $anchor = $base1.Anchor
        $term = $cap.Terminal
        $sfv = $cap.StopFacts
        $refRole = {
            param([string]$role)
            $d = @(@($cap.DeclaredReferences) | Where-Object { $_.Role -ceq $role })
            $v = @(@($cap.VerifiedReferences) | Where-Object { $_.Role -ceq $role })
            if (($d.Count -ne 1) -or ($v.Count -ne 1)) { & $fail 'OBSFT_REFERENCE' }
            return [pscustomobject]([ordered]@{ path = [string]$v[0].Path; declaredSha256 = [string]$d[0].DeclaredSha256; declaredLength = [long]$d[0].DeclaredLength; verifiedSha256 = [string]$v[0].VerifiedSha256; verifiedLength = [long]$v[0].VerifiedLength })
        }
        $stdoutRef = & $refRole 'STDOUT'
        $stderrRef = & $refRole 'STDERR'
        $stopOut = [pscustomobject]([ordered]@{
            pid = [long](& $get $sfv 'pid' 'OBSFT_STOPFACTS')
            startTimeUtc = [string](& $get $sfv 'startTimeUtc' 'OBSFT_STOPFACTS')
            deadlineObservedUtc = [string](& $get $sfv 'deadlineObservedUtc' 'OBSFT_STOPFACTS')
            elapsedMs = [long](& $get $sfv 'elapsedMs' 'OBSFT_STOPFACTS')
            alive = [bool](& $get $sfv 'alive' 'OBSFT_STOPFACTS')
            aliveAtStop = [bool](& $get $sfv 'aliveAtStop' 'OBSFT_STOPFACTS')
            killAttempted = [bool](& $get $sfv 'killAttempted' 'OBSFT_STOPFACTS')
            killErrorCode = $(if ($null -eq (& $get $sfv 'killErrorCode' 'OBSFT_STOPFACTS')) { $null } else { [string](& $get $sfv 'killErrorCode' 'OBSFT_STOPFACTS') })
        })
        $failure = [pscustomobject]([ordered]@{
            reason = 'DEADLINE'
            exitCode = [long]$bnd.exitCode
            definitive = $true; exitObserved = $true; drainComplete = $true; stdinError = $false
            onStartedAcknowledged = $true
            errorCode = $null
            stopFacts = $stopOut
        })
        $identity = [pscustomobject]([ordered]@{ taskId = [string]$bnd.taskId; payloadSha256 = [string]$bnd.payloadSha256; runId = [string]$cap.RunId; attempt = [long]$cap.Attempt; sessionId = [string]$bnd.sessionId; pid = [long]$bnd.pid; terminalReason = 'DEADLINE'; exitCode = [long]$bnd.exitCode; startIdentity = [string]$bnd.startUtc })
        $references = [pscustomobject]([ordered]@{
            manifest = [pscustomobject]([ordered]@{ path = [string]$cap.ManifestPath; expectedSha256 = [string]$cap.ManifestSha256; verifiedSha256 = [string]$cap.ManifestSha256 })
            terminal = [pscustomobject]([ordered]@{ path = [string]$cap.TerminalPath; expectedSha256 = [string]$cap.TerminalSha256; verifiedSha256 = [string]$cap.TerminalSha256 })
            start = [pscustomobject]([ordered]@{ path = [string]$cap.StartPath; verifiedSha256 = [string]$cap.StartSha256 })
            ticket = [pscustomobject]([ordered]@{ path = [string]$cap.TicketPath; expectedSha256 = [string]$bnd.ticketSha256; verifiedSha256 = [string]$cap.TicketSha256 })
            predecessorReceipt = [pscustomobject]([ordered]@{ path = [string]$preRef.path; expectedSha256 = [string]$preRef.sha256; verifiedSha256 = [string]$par.sha256 })
            stdout = $stdoutRef
            stderr = $stderrRef
            artifactState = [string]$cap.ArtifactState
        })
        $accounting = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveFailedTransportAccounting/v1'
            disposition = 'AUTHENTICATED_FAILED_TERMINAL'
            anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
            anchor = $anchor
            parent = [pscustomobject]([ordered]@{ receiptPath = [string]$par.path; receiptSha256 = [string]$par.sha256; schemaVersion = [string]$par.schemaVersion; runId = [string]$par.runId; attempt = [long]$par.attempt; verifiedOutputTokens = [long]$base1.LastVerifiedParentOutputTokens })
            lastVerifiedParentOutputTokens = [long]$base1.LastVerifiedParentOutputTokens
            currentOutputTokens = $null
            cumulativeOutputTokens = $null
            accountingStatus = 'UNKNOWN'
            sdkOutcome = 'UNKNOWN'
            accountingUnresolved = $true
            requestSha256 = [string]$bnd.requestSha256
            startUtc = [string]$bnd.startUtc
            endedUtc = [string]$bnd.endUtc
            identity = $identity
            failure = $failure
            references = $references
            noAcceptedUsage = $true; noCompletion = $true; noDispatch = $true; noRetry = $true
        })
        $normEvidence = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveFailedTransportEvidence/v1'
            current = $base1.Selection.current
            predecessorReceipt = $base1.Selection.predecessorReceipt
            registrationRef = (& $refDto $regRef)
            selectedClaimRef = (& $refDto $claimRef)
            acknowledgementsRef = (& $refDto $ackRef)
        })
        $paths = [System.Collections.Generic.List[string]]::new()
        foreach ($ip in @($base1.InPaths)) { $paths.Add([string]$ip) }
        foreach ($ip in @($regRef.path, $claimRef.path, $ackRef.path, [string]$proof1.requestPath)) { $paths.Add([string]$ip) }
        $facts = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveFailedTransportFacts/v1'
            evidence = $normEvidence
            anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
            identity = $identity
            limits = [pscustomobject]([ordered]@{ maxElapsedMs = [long]$bnd.maxElapsedMs; maxAttempts = [long]$bnd.maxAttempts; priorElapsedMs = 0L; maxOutputTokens = $null; softFraction = $null })
            timing = [pscustomobject]([ordered]@{ startUtc = [string]$bnd.startUtc; endedUtc = [string]$bnd.endUtc; usedElapsedMs = [long]$bnd.usedElapsedMs })
            accounting = $accounting
            proof = $proof1
            stdout = [pscustomobject]([ordered]@{ path = [string]$stdoutRef.path; sha256 = [string]$stdoutRef.verifiedSha256; length = [long]$stdoutRef.verifiedLength })
            inputPaths = @($paths.ToArray())
            noCompletion = $true; noDispatch = $true; noRetry = $true
        })
        return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'FAILED_TRANSPORT'; Facts = $facts; Lineage = $base1.Lineage }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($m.StartsWith('UNKNOWN:', $ord) -and ($m.Length -le 56) -and ($m.Substring(8) -cmatch '^[A-Z0-9_]{1,48}$')) {
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_FAILED_TRANSPORT_UNKNOWN'; Result = 'NONRECEIPT'; Status = 'UNKNOWN'; Reason = $m.Substring(8); Facts = $null }
        }
        $code = 'OBSFT_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', $ord) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Result = 'REFUSED'; Facts = $null }
    }
}

function Test-ManagedObserveFailedTransportReceiptV5Shape {
    # Pure structural check of a stored OperationalRunReceipt/v5 DTO (FAILED only, null counts, incomplete artifact). It derives nothing,
    # authenticates nothing and confers no receipt validity, settlement or dispatch authority by itself.
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
        $ord = [System.StringComparison]::Ordinal
        $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
        $exact = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $ps = @($o.PSObject.Properties)
            if ($ps.Count -ne $names.Count) { return $false }
            foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { return $false } }
            return $true
        }
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $isStr = { param($v) ($v -is [string]) -and ($v.Length -gt 0) }

        if (-not (& $exact $obj @('schemaVersion', 'runId', 'taskId', 'payloadSha256', 'destination', 'status', 'attempt', 'sessionId', 'historyVerified', 'budget', 'provider', 'artifact', 'updatedAt', 'evidence', 'outputStopMode', 'observeFailedTransportEvidence', 'observeFailedTransportAccounting', 'observeFailedTransport'))) { return $false }
        if (((& $val $obj 'schemaVersion') -isnot [string]) -or ((& $val $obj 'schemaVersion') -cne 'OperationalRunReceipt/v5')) { return $false }
        if (((& $val $obj 'status') -isnot [string]) -or ((& $val $obj 'status') -cne 'FAILED')) { return $false }
        if (((& $val $obj 'outputStopMode') -isnot [string]) -or ((& $val $obj 'outputStopMode') -cne 'OBSERVE_ONLY')) { return $false }
        if (((& $val $obj 'destination') -isnot [string]) -or ((& $val $obj 'destination') -cne 'Anthropic Claude')) { return $false }
        $hv = & $val $obj 'historyVerified'
        if (($hv -isnot [bool]) -or $hv) { return $false }
        foreach ($n in @('runId', 'taskId', 'sessionId', 'updatedAt')) { if (-not (& $isStr (& $val $obj $n))) { return $false } }
        if (-not (& $isHex (& $val $obj 'payloadSha256'))) { return $false }
        $attempt = & $val $obj 'attempt'
        if ((-not (& $isInt $attempt)) -or ([long]$attempt -lt 1)) { return $false }

        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $a = & $val $obj 'artifact'
        $e = & $val $obj 'evidence'
        if (-not ((& $exact $b @('maxOutputTokens', 'maxElapsedMs', 'maxAttempts', 'usedElapsedMs', 'usedOutputTokens', 'attemptsUsed', 'softFraction')) -and (& $exact $p @('startIdentity', 'sessionId', 'terminalReason', 'pid')) -and (& $exact $a @('complete', 'sha256', 'path')) -and (& $exact $e @('rawPath', 'rawSha256', 'ticketPath', 'ticketSha256', 'usagePath', 'usageSha256', 'nativeThinkingTokens')))) { return $false }
        # Unknown stays null: no ceiling, no soft fraction and, unlike the pending/completed shapes, no used-output count at all (never 0).
        if (($null -ne (& $val $b 'maxOutputTokens')) -or ($null -ne (& $val $b 'softFraction')) -or ($null -ne (& $val $b 'usedOutputTokens'))) { return $false }
        foreach ($n in @('maxElapsedMs', 'maxAttempts', 'usedElapsedMs', 'attemptsUsed')) { if (-not (& $isInt (& $val $b $n))) { return $false } }
        if (([long](& $val $b 'maxElapsedMs') -le 0) -or ([long](& $val $b 'maxAttempts') -le 0) -or ([long](& $val $b 'usedElapsedMs') -lt 0)) { return $false }
        if (([long](& $val $b 'attemptsUsed') -ne [long]$attempt) -or ([long]$attempt -gt [long](& $val $b 'maxAttempts'))) { return $false }
        if (-not (& $isStr (& $val $p 'startIdentity'))) { return $false }
        if ((-not (& $isStr (& $val $p 'sessionId'))) -or ((& $val $p 'sessionId') -cne (& $val $obj 'sessionId')) -or ((& $val $p 'terminalReason') -isnot [string]) -or ((& $val $p 'terminalReason') -cne 'DEADLINE')) { return $false }
        if ((-not (& $isInt (& $val $p 'pid'))) -or ([long](& $val $p 'pid') -le 0)) { return $false }
        $ac = & $val $a 'complete'
        if (($ac -isnot [bool]) -or $ac -or ($null -ne (& $val $a 'sha256')) -or ($null -ne (& $val $a 'path'))) { return $false }
        foreach ($n in @('rawPath', 'ticketPath', 'usagePath')) { if (-not (& $isStr (& $val $e $n))) { return $false } }
        foreach ($n in @('rawSha256', 'ticketSha256', 'usageSha256')) { if (-not (& $isHex (& $val $e $n))) { return $false } }
        if ($null -ne (& $val $e 'nativeThinkingTokens')) { return $false }
        $ce = & $val $obj 'observeFailedTransportEvidence'
        if (-not (& $exact $ce @('schema', 'current', 'predecessorReceipt', 'registrationRef', 'selectedClaimRef', 'acknowledgementsRef'))) { return $false }
        if (((& $val $ce 'schema') -isnot [string]) -or ((& $val $ce 'schema') -cne 'ManagedObserveFailedTransportEvidence/v1')) { return $false }
        foreach ($n in @('predecessorReceipt', 'registrationRef', 'selectedClaimRef', 'acknowledgementsRef')) {
            $rf = & $val $ce $n
            if ((-not (& $exact $rf @('path', 'sha256'))) -or (-not (& $isStr (& $val $rf 'path'))) -or (-not (& $isHex (& $val $rf 'sha256')))) { return $false }
        }
        if (((& $val $ce 'current') -isnot [System.Management.Automation.PSCustomObject]) -or ((& $val $obj 'observeFailedTransportAccounting') -isnot [System.Management.Automation.PSCustomObject]) -or ((& $val $obj 'observeFailedTransport') -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        return $true
    } catch { return $false }
}

function Compare-ManagedObserveFailedTransportReceiptV5ToFacts {
    # STRUCTURAL ONLY: compares one stored v5 receipt DTO to facts the CALLER derived itself from raw authenticated captures and records.
    # It never reads evidence, never authenticates and confers no receipt validity, settlement or dispatch authority; callers must derive the
    # facts internally (Get-ManagedObserveFailedTransportFacts) and reauthenticate the raw DTO themselves.
    param($obj, $f)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        if (($null -eq $f) -or ($f -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        $ord = [System.StringComparison]::Ordinal
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $json = { param($o) ConvertTo-Json -InputObject $o -Depth 12 -Compress }
        $id = $f.identity; $lim = $f.limits; $acct = $f.accounting
        if (($f.anchorLabel -cne 'SELECTED_ACCOUNTING_ANCHOR') -or ($acct.anchorLabel -cne 'SELECTED_ACCOUNTING_ANCHOR')) { return $false }
        if (($acct.accountingStatus -cne 'UNKNOWN') -or ($acct.sdkOutcome -cne 'UNKNOWN') -or ($acct.accountingUnresolved -ne $true) -or ($null -ne $acct.currentOutputTokens) -or ($null -ne $acct.cumulativeOutputTokens)) { return $false }
        $attempt = & $val $obj 'attempt'
        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $e = & $val $obj 'evidence'
        foreach ($pair in @(@('runId', 'runId'), @('taskId', 'taskId'), @('payloadSha256', 'payloadSha256'), @('sessionId', 'sessionId'))) {
            if ((& $val $obj $pair[0]) -cne [string]$id.($pair[1])) { return $false }
        }
        if (([long]$attempt -ne [long]$id.attempt) -or ([long](& $val $p 'pid') -ne [long]$id.pid) -or ((& $val $p 'terminalReason') -cne [string]$id.terminalReason) -or ((& $val $p 'startIdentity') -cne [string]$id.startIdentity)) { return $false }
        if ((& $val $obj 'updatedAt') -cne [string]$f.timing.endedUtc) { return $false }
        if (([long](& $val $b 'maxElapsedMs') -ne [long]$lim.maxElapsedMs) -or ([long](& $val $b 'maxAttempts') -ne [long]$lim.maxAttempts) -or ([long]$lim.priorElapsedMs -ne 0)) { return $false }
        if ([long](& $val $b 'usedElapsedMs') -ne [long]$f.timing.usedElapsedMs) { return $false }
        if (([string](& $val $e 'ticketPath') -cne [string]$acct.references.ticket.path) -or ((& $val $e 'ticketSha256') -cne [string]$acct.references.ticket.verifiedSha256)) { return $false }
        if (([string](& $val $e 'usagePath') -cne [string]$f.stdout.path) -or ((& $val $e 'usageSha256') -cne [string]$f.stdout.sha256)) { return $false }
        if ((& $json (& $val $obj 'observeFailedTransportAccounting')) -cne (& $json $acct)) { return $false }
        if ((& $json (& $val $obj 'observeFailedTransportEvidence')) -cne (& $json $f.evidence)) { return $false }
        if ((& $json (& $val $obj 'observeFailedTransport')) -cne (& $json $f.proof)) { return $false }
        return $true
    } catch { return $false }
}

function Test-ManagedObserveFailedTransportRawDto {
    # Read-only. Same raw-DTO cross-check as the pending path, with the failed-transport rules (actual nonzero exit, observed output null).
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [AllowNull()][AllowEmptyString()][string]$ExpectedSha256,
        [Parameter(Mandatory)]$Facts
    )
    return Test-ManagedObservePendingRawDto -RawPath $RawPath -ExpectedSha256 $ExpectedSha256 -Facts $Facts -FailedTransport
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
        [Parameter(Mandatory)][AllowNull()][Nullable[long]]$MaxElapsedMs
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
        if (($null -ne $MaxElapsedMs) -and ($MaxElapsedMs -le 0)) { return & $refuse 'INVALID_MAX_ELAPSED' }

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

        # Pure trusted-sibling aggregate mode; unknown or refused mode fails closed.
        if (-not (Get-Command Test-ManagedNativeTicketContract -CommandType Function -ErrorAction SilentlyContinue)) {
            $contractFile = Join-Path $PSScriptRoot 'native-ticket-contract.ps1'
            if (-not (Test-Path -LiteralPath $contractFile -PathType Leaf)) { return & $refuse 'CONTRACT_MISSING' }
            try { . $contractFile } catch { return & $refuse 'CONTRACT_LOAD_FAILED' }
            if (-not (Get-Command Test-ManagedNativeTicketContract -CommandType Function -ErrorAction SilentlyContinue)) { return & $refuse 'CONTRACT_MISSING' }
        }
        try { $tc = Test-ManagedNativeTicketContract -Ticket $f.Ticket -ExpectedPayloadSha256 $f.Core.payloadSha256 } catch { return & $refuse 'AGGREGATE_MODE_EXCEPTION' }
        $aggMode = [string](& $prop $tc 'AggregateMode')
        $tcValid = & $prop $tc 'Valid'
        if ($tcValid -isnot [bool] -or -not $tcValid -or ($aggMode -cne 'ADVISORY_DESCRIPTOR' -and $aggMode -cne 'LEGACY_HARDLIMIT')) { return & $refuse 'AGGREGATE_MODE' }
        $advEv = $null
        if ($aggMode -ceq 'ADVISORY_DESCRIPTOR') {
            if (-not (Get-Command Get-ManagedNativeAdvisoryBudgetFacts -CommandType Function -ErrorAction SilentlyContinue)) { return & $refuse 'ADVISORY_VERIFIER_MISSING' }
            $advEv = [pscustomobject]@{
                schema         = 'ManagedNativeAdvisoryEvidence/v1'
                manifestPath   = $f.ManifestPath
                manifestSha256 = $f.ManifestSha256
                terminalPath   = $f.TerminalPath
                terminalSha256 = $f.TerminalSha256
                ticketPath     = $f.TicketPath
                runId          = $f.RunId
                attempt        = $f.Attempt
            }
            try { $av0 = Get-ManagedNativeAdvisoryBudgetFacts -Evidence $advEv } catch { return & $refuse 'ADVISORY_EXCEPTION' }
            $av0v = & $prop $av0 'Valid'
            if ($av0v -isnot [bool] -or -not $av0v -or [string](& $prop (& $prop $av0 'Facts') 'mode') -cne 'AUTHENTICATED_ADVISORY') { return & $refuse 'ADVISORY_NOT_AUTHENTICATED' }
        }

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

        $expTicket = $sTicket
        try {
            if ($aggMode -ceq 'ADVISORY_DESCRIPTOR') {
                $expTicket = $f.TicketPath
                $ar = @(ConvertTo-TerminalReceipt -RawPath $sRaw -TicketPath $f.TicketPath -UsagePath $sUsage -RunId $RunId -Attempt $Attempt -MaxAttempts $MaxAttempts -PriorElapsedMs $PriorElapsedMs -MaxElapsedMs $MaxElapsedMs -ReceiptPath $sAdapt -AggregateAdvisoryEvidence $advEv)
            } else {
                $ar = @(ConvertTo-TerminalReceipt -RawPath $sRaw -TicketPath $sTicket -UsagePath $sUsage -RunId $RunId -Attempt $Attempt -MaxAttempts $MaxAttempts -PriorElapsedMs $PriorElapsedMs -MaxElapsedMs $MaxElapsedMs -ReceiptPath $sAdapt)
            }
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
        $evOk = (& $sameP (& $prop $ev 'rawPath') $sRaw) -and (& $sameP (& $prop $ev 'ticketPath') $expTicket) -and (& $sameP (& $prop $ev 'usagePath') $sUsage) -and
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

# ======================================================================================================================================================
# UNKNOWN-history continuation (human-authorized): verification for OperationalRunReceipt/v6 (pending-only) and OperationalRunReceipt/v7 (FAILED-only).
# A child that follows an authenticated failed v5 root whose usage stayed UNKNOWN keeps every current/cumulative/history total null (never zero, never inferred)
# and carries the last VERIFIED fully known subtotal separately; a measured per-child SDK count, when genuinely observed, is labelled as child-only.
# Everything below authenticates referenced data only. It derives from pinned bytes and recaptures, accepts no caller facts, and grants no completion,
# dispatch, ACK, retry or successor authority. The human direction is authenticated by the fixed anchored hash in Assert-ManagedUnknownContinuationDirective.
# ======================================================================================================================================================

function Invoke-ManagedUnkRefuse {
    param([string]$Code)
    throw [System.InvalidOperationException]::new('REFUSE:' + $Code)
}

function Invoke-ManagedUnkUnknown {
    param([string]$Code)
    throw [System.InvalidOperationException]::new('UNKNOWN:' + $Code)
}

function Get-ManagedUnkClean {
    param($Value, [string]$Default)
    if (($Value -is [string]) -and ($Value -cmatch '^[A-Z0-9_]{1,48}\z')) { return $Value }
    return $Default
}

# Exact-ordinal NoteProperty lookup; a missing member or a non-object holder refuses.
function Get-ManagedUnkMember {
    param($Holder, [string]$Name, [string]$Code)
    if ($Holder -isnot [System.Management.Automation.PSCustomObject]) { Invoke-ManagedUnkRefuse $Code }
    foreach ($q in $Holder.PSObject.Properties) {
        if (($q.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty) -and [string]::Equals($q.Name, $Name, [System.StringComparison]::Ordinal)) { return , $q.Value }
    }
    Invoke-ManagedUnkRefuse $Code
}

function Get-ManagedUnkString {
    param($Holder, [string]$Name, [string]$Code)
    $v = Get-ManagedUnkMember $Holder $Name $Code
    if (($v -isnot [string]) -or ($v.Length -eq 0)) { Invoke-ManagedUnkRefuse $Code }
    return $v
}

function Get-ManagedUnkLong {
    param($Holder, [string]$Name, [string]$Code)
    $v = Get-ManagedUnkMember $Holder $Name $Code
    if (($v -isnot [int]) -and ($v -isnot [long])) { Invoke-ManagedUnkRefuse $Code }
    return [long]$v
}

function Assert-ManagedUnkExact {
    param($Holder, [string[]]$Names, [string]$Code)
    if ($Holder -isnot [System.Management.Automation.PSCustomObject]) { Invoke-ManagedUnkRefuse $Code }
    $ps = @($Holder.PSObject.Properties)
    if ($ps.Count -ne $Names.Count) { Invoke-ManagedUnkRefuse $Code }
    foreach ($q in $ps) {
        if (($q.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) -or ($Names -cnotcontains [string]$q.Name)) { Invoke-ManagedUnkRefuse $Code }
    }
}

function Test-ManagedUnkHex {
    param($Value)
    return (($Value -is [string]) -and ($Value -cmatch '^[0-9a-f]{64}\z'))
}

function Add-ManagedUnkLong {
    param([long]$A, [long]$B, [string]$Code)
    if (($A -lt 0) -or ($B -lt 0) -or ($A -gt ([long]::MaxValue - $B))) { Invoke-ManagedUnkRefuse $Code }
    return [long]($A + $B)
}

function ConvertTo-ManagedUnkTicks {
    param([string]$Text, [string]$Code)
    if (($Text.Length -gt 40) -or ($Text -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,7})?Z\z')) { Invoke-ManagedUnkRefuse $Code }
    $dt = [datetime]::MinValue
    if (-not [datetime]::TryParse($Text, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$dt)) { Invoke-ManagedUnkRefuse $Code }
    if ($dt.Kind -ne [System.DateTimeKind]::Utc) { Invoke-ManagedUnkRefuse $Code }
    return [long]$dt.Ticks
}

# Exact {path,sha256} reference: fully qualified canonical path and lower-case 64hex pin. Returns a hashtable {path, sha256}.
function ConvertTo-ManagedUnkRef {
    param($Ref, [string]$Code)
    Assert-ManagedUnkExact $Ref @('path', 'sha256') $Code
    $p = Get-ManagedUnkMember $Ref 'path' $Code
    $s = Get-ManagedUnkMember $Ref 'sha256' $Code
    if (($p -isnot [string]) -or ($p.Length -eq 0) -or ($p.IndexOf([char]0) -ge 0) -or (-not [System.IO.Path]::IsPathFullyQualified($p)) -or (-not [string]::Equals([System.IO.Path]::GetFullPath($p), $p, [System.StringComparison]::Ordinal))) { Invoke-ManagedUnkRefuse $Code }
    if (-not (Test-ManagedUnkHex $s)) { Invoke-ManagedUnkRefuse $Code }
    return @{ path = [string]$p; sha256 = [string]$s }
}

function New-ManagedUnkRefDto {
    param($Ref)
    return [pscustomobject]([ordered]@{ path = [string]$Ref.path; sha256 = [string]$Ref.sha256 })
}

# Pinned strict read of one control record (hash, canonical path, ControlRoot descendant, strict JSON object).
function Read-ManagedUnkPinned {
    param($Ref, [string]$ControlRoot, [string]$Code)
    $x = $null
    try { $x = Read-ManagedPinnedEvidenceJson -Reference ([pscustomobject]@{ path = [string]$Ref.path; sha256 = [string]$Ref.sha256 }) -ControlRoot $ControlRoot } catch { $x = $null }
    if (($null -eq $x) -or ($x.Sha256 -cne [string]$Ref.sha256) -or ($x.Path -cne [string]$Ref.path) -or ($x.Value -isnot [System.Management.Automation.PSCustomObject])) { Invoke-ManagedUnkRefuse $Code }
    return , $x
}

# Exact ordinal parse of one ManagedObserveUnknownContinuationEvidence/v1 DTO (caller evidence or a stored v6 receipt's embedded evidence).
function ConvertTo-ManagedUnkEvidence {
    param($Ev)
    Assert-ManagedUnkExact $Ev @('schema', 'current', 'predecessorReceipt', 'unresolvedFailureReceipt', 'humanDirectionRef') 'UNK_EVIDENCE_SHAPE'
    $evSchema = Get-ManagedUnkMember $Ev 'schema' 'UNK_EVIDENCE_SHAPE'
    if (($evSchema -isnot [string]) -or ($evSchema -cne 'ManagedObserveUnknownContinuationEvidence/v1')) { Invoke-ManagedUnkRefuse 'UNK_EVIDENCE_SCHEMA' }
    $cur = Get-ManagedUnkMember $Ev 'current' 'UNK_EVIDENCE_SHAPE'
    Assert-ManagedUnkExact $cur @('schema', 'manifestPath', 'manifestSha256', 'terminalPath', 'terminalSha256', 'ticketPath', 'runId', 'attempt') 'UNK_CURRENT_SHAPE'
    if ((Get-ManagedUnkMember $cur 'schema' 'UNK_CURRENT_SHAPE') -cne 'ManagedNativeAdvisoryEvidence/v1') { Invoke-ManagedUnkRefuse 'UNK_CURRENT_SCHEMA' }
    $mp = Get-ManagedUnkString $cur 'manifestPath' 'UNK_CURRENT_FIELD'
    $tp = Get-ManagedUnkString $cur 'terminalPath' 'UNK_CURRENT_FIELD'
    $kp = Get-ManagedUnkString $cur 'ticketPath' 'UNK_CURRENT_FIELD'
    $rid = Get-ManagedUnkString $cur 'runId' 'UNK_CURRENT_FIELD'
    $ms = Get-ManagedUnkMember $cur 'manifestSha256' 'UNK_CURRENT_PIN'
    $ts = Get-ManagedUnkMember $cur 'terminalSha256' 'UNK_CURRENT_PIN'
    if ((-not (Test-ManagedUnkHex $ms)) -or (-not (Test-ManagedUnkHex $ts))) { Invoke-ManagedUnkRefuse 'UNK_CURRENT_PIN' }
    $at = Get-ManagedUnkMember $cur 'attempt' 'UNK_CURRENT_ATTEMPT'
    if ((($at -isnot [int]) -and ($at -isnot [long])) -or ([long]$at -lt 1) -or ([long]$at -gt [long][int]::MaxValue)) { Invoke-ManagedUnkRefuse 'UNK_CURRENT_ATTEMPT' }
    $pre = ConvertTo-ManagedUnkRef (Get-ManagedUnkMember $Ev 'predecessorReceipt' 'UNK_EVIDENCE_SHAPE') 'UNK_PREDECESSOR_REF'
    $fai = ConvertTo-ManagedUnkRef (Get-ManagedUnkMember $Ev 'unresolvedFailureReceipt' 'UNK_EVIDENCE_SHAPE') 'UNK_FAILURE_REF'
    $dir = ConvertTo-ManagedUnkRef (Get-ManagedUnkMember $Ev 'humanDirectionRef' 'UNK_EVIDENCE_SHAPE') 'UNK_DIRECTION_REF'
    return @{ mPath = $mp; mSha = $ms; tPath = $tp; tSha = $ts; kPath = $kp; runId = $rid; attempt = [int][long]$at; prePath = $pre.path; preSha = $pre.sha256; failPath = $fai.path; failSha = $fai.sha256; dirPath = $dir.path; dirSha = $dir.sha256 }
}

function New-ManagedUnkEvidenceDto {
    param([hashtable]$Pe)
    return [pscustomobject]([ordered]@{
        schema = 'ManagedObserveUnknownContinuationEvidence/v1'
        current = [pscustomobject]([ordered]@{ schema = 'ManagedNativeAdvisoryEvidence/v1'; manifestPath = $Pe.mPath; manifestSha256 = $Pe.mSha; terminalPath = $Pe.tPath; terminalSha256 = $Pe.tSha; ticketPath = $Pe.kPath; runId = $Pe.runId; attempt = [long]$Pe.attempt })
        predecessorReceipt = [pscustomobject]([ordered]@{ path = $Pe.prePath; sha256 = $Pe.preSha })
        unresolvedFailureReceipt = [pscustomobject]([ordered]@{ path = $Pe.failPath; sha256 = $Pe.failSha })
        humanDirectionRef = [pscustomobject]([ordered]@{ path = $Pe.dirPath; sha256 = $Pe.dirSha })
    })
}

# Identity registry: one run, request, terminal, manifest, ticket and session identity may appear exactly once across the whole lineage.
function New-ManagedUnkRegistry {
    param($Lineage)
    $o = [System.StringComparer]::Ordinal
    $ic = [System.StringComparer]::OrdinalIgnoreCase
    $r = @{
        runs = [System.Collections.Generic.HashSet[string]]::new($o)
        reqs = [System.Collections.Generic.HashSet[string]]::new($o)
        shas = [System.Collections.Generic.HashSet[string]]::new($o)
        mans = [System.Collections.Generic.HashSet[string]]::new($o)
        tkts = [System.Collections.Generic.HashSet[string]]::new($o)
        paths = [System.Collections.Generic.HashSet[string]]::new($ic)
        sessions = [System.Collections.Generic.HashSet[string]]::new($ic)
    }
    if ($null -eq $Lineage) { Invoke-ManagedUnkRefuse 'UNK_LINEAGE_MISSING' }
    foreach ($pair in @(@('runs', 'runIds'), @('reqs', 'requestSha256'), @('shas', 'terminalSha256'), @('mans', 'manifestSha256'), @('tkts', 'ticketSha256'), @('paths', 'terminalPaths'), @('sessions', 'sessionIds'))) {
        $src = Get-ManagedUnkMember $Lineage $pair[1] 'UNK_LINEAGE_MISSING'
        foreach ($x in @($src)) { [void]$r[$pair[0]].Add([string]$x) }
    }
    return $r
}

function Register-ManagedUnkIdentity {
    param([hashtable]$Registry, [hashtable]$Id)
    if ($Registry.runs.Contains([string]$Id.runId) -or $Registry.reqs.Contains([string]$Id.req) -or $Registry.shas.Contains([string]$Id.termSha) -or $Registry.paths.Contains([string]$Id.termPath) -or $Registry.mans.Contains([string]$Id.manSha) -or $Registry.tkts.Contains([string]$Id.tkSha)) { Invoke-ManagedUnkRefuse 'UNK_DUPLICATE_IDENTITY' }
    if ($Registry.sessions.Contains([string]$Id.session)) { Invoke-ManagedUnkRefuse 'UNK_DUPLICATE_SESSION' }
    [void]$Registry.runs.Add([string]$Id.runId)
    [void]$Registry.reqs.Add([string]$Id.req)
    [void]$Registry.shas.Add([string]$Id.termSha)
    [void]$Registry.paths.Add([string]$Id.termPath)
    [void]$Registry.mans.Add([string]$Id.manSha)
    [void]$Registry.tkts.Add([string]$Id.tkSha)
    [void]$Registry.sessions.Add([string]$Id.session)
}

# Recapture of one node's own pinned evidence (observation capture; a failed node uses the failed-transport capture).
function Get-ManagedUnkCapture {
    param([hashtable]$Pe, [bool]$Failed)
    if ($Failed) {
        $r = Get-ManagedNativeCapturedFacts -ManifestPath $Pe.mPath -ExpectedManifestSha256 $Pe.mSha -TerminalPath $Pe.tPath -ExpectedTerminalSha256 $Pe.tSha -TicketPath $Pe.kPath -RunId $Pe.runId -Attempt ([int]$Pe.attempt) -ForUnknownFailedObservation
    } else {
        $r = Get-ManagedNativeCapturedFacts -ManifestPath $Pe.mPath -ExpectedManifestSha256 $Pe.mSha -TerminalPath $Pe.tPath -ExpectedTerminalSha256 $Pe.tSha -TicketPath $Pe.kPath -RunId $Pe.runId -Attempt ([int]$Pe.attempt) -ForOutputObservation
    }
    if ((@($r).Count -ne 1) -or ($r -isnot [System.Management.Automation.PSCustomObject])) { Invoke-ManagedUnkRefuse 'UNK_CAPTURE_SHAPE' }
    $valid = Get-ManagedUnkMember $r 'Valid' 'UNK_CAPTURE_SHAPE'
    $code = Get-ManagedUnkMember $r 'Code' 'UNK_CAPTURE_SHAPE'
    $facts = Get-ManagedUnkMember $r 'Facts' 'UNK_CAPTURE_SHAPE'
    if (($valid -isnot [bool]) -or $valid -or ($null -ne $facts)) { Invoke-ManagedUnkRefuse (Get-ManagedUnkClean $code 'UNK_CAPTURE_REFUSED') }
    if ($code -ceq 'OBSERVE_ONLY_CAPTURE_UNKNOWN') { Invoke-ManagedUnkUnknown 'CAPTURE_UNKNOWN' }
    $wantCode = if ($Failed) { 'OBSERVE_ONLY_UNKNOWN_FAILED_CAPTURE' } else { 'OBSERVE_ONLY_TRANSPORT_CAPTURE' }
    if ($code -cne $wantCode) { Invoke-ManagedUnkRefuse (Get-ManagedUnkClean $code 'UNK_CAPTURE_REFUSED') }
    $oc = Get-ManagedUnkMember $r 'ObservationCapture' 'UNK_CAPTURE_SHAPE'
    if ($oc -isnot [System.Management.Automation.PSCustomObject]) { Invoke-ManagedUnkRefuse 'UNK_CAPTURE_SHAPE' }
    return , $oc
}

function Get-ManagedUnkSignature {
    param($Capture)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($f in @('RunId', 'Attempt', 'SessionId', 'Pid', 'TransportExitCode', 'ManifestPath', 'ManifestSha256', 'TerminalPath', 'TerminalSha256', 'TicketPath', 'TicketSha256', 'StartPath', 'StartSha256', 'RequestSha256', 'StdoutLength', 'StderrLength', 'ArtifactPath', 'ArtifactState')) {
        [void]$sb.Append($f).Append('=').Append([string](Get-ManagedUnkMember $Capture $f 'UNK_CAPTURE_FIELD')).Append([char]10)
    }
    foreach ($e in @($Capture.Inputs)) { [void]$sb.Append('I|' + [string]$e.Role + '|' + [string]$e.State + '|' + [string]$e.Path + '|' + [string]$e.Sha256 + '|' + [string]$e.Length).Append([char]10) }
    foreach ($e in @($Capture.StreamedInputs)) { [void]$sb.Append('S|' + [string]$e.Role + '|' + [string]$e.Path + '|' + [string]$e.Sha256 + '|' + [string]$e.Length).Append([char]10) }
    foreach ($e in @($Capture.VerifiedReferences)) { [void]$sb.Append('V|' + [string]$e.Role + '|' + [string]$e.Path + '|' + [string]$e.VerifiedSha256 + '|' + [string]$e.VerifiedLength).Append([char]10) }
    return $sb.ToString()
}

# Identity, limits and timing of one captured node (ported from the pending-accounting node binding). The ticket history is an exact null here.
function Get-ManagedUnkNodeBinding {
    param($Capture, [hashtable]$Pe, [bool]$Failed)
    $c = $Capture
    if (((Get-ManagedUnkString $c 'RunId' 'UNK_CAPTURE_FIELD') -cne $Pe.runId) -or ((Get-ManagedUnkLong $c 'Attempt' 'UNK_CAPTURE_FIELD') -ne [long]$Pe.attempt)) { Invoke-ManagedUnkRefuse 'UNK_IDENTITY_MISMATCH' }
    foreach ($p in @(@('ManifestPath', $Pe.mPath), @('ManifestSha256', $Pe.mSha), @('TerminalPath', $Pe.tPath), @('TerminalSha256', $Pe.tSha), @('TicketPath', $Pe.kPath))) {
        if ((Get-ManagedUnkMember $c $p[0] 'UNK_CAPTURE_FIELD') -cne $p[1]) { Invoke-ManagedUnkRefuse 'UNK_IDENTITY_MISMATCH' }
    }
    $ticket = Get-ManagedUnkMember $c 'Ticket' 'UNK_CAPTURE_FIELD'
    $core = Get-ManagedUnkMember $c 'Core' 'UNK_CAPTURE_FIELD'
    $term = Get-ManagedUnkMember $c 'Terminal' 'UNK_CAPTURE_FIELD'
    $start = Get-ManagedUnkMember $c 'Start' 'UNK_CAPTURE_FIELD'
    $cbud = Get-ManagedUnkMember $c 'Budget' 'UNK_CAPTURE_FIELD'
    $auth = Get-ManagedUnkMember $c 'Authority' 'UNK_CAPTURE_FIELD'
    if (((Get-ManagedUnkMember $auth 'Schema' 'UNK_AUTHORITY') -cne 'ManagedOutputStopAuthority/v1') -or ((Get-ManagedUnkMember $auth 'Mode' 'UNK_AUTHORITY') -cne 'OBSERVE_ONLY')) { Invoke-ManagedUnkRefuse 'UNK_AUTHORITY' }
    if (((Get-ManagedUnkString $core 'outputStopProfile' 'UNK_CORE_PROFILE') -cne 'observe-only-v1') -or ($null -ne (Get-ManagedUnkMember $core 'maxStreamBytes' 'UNK_CORE_PROFILE'))) { Invoke-ManagedUnkRefuse 'UNK_CORE_PROFILE' }
    $taskId = Get-ManagedUnkString $ticket 'id' 'UNK_TICKET_FIELD'
    $payloadSha = Get-ManagedUnkMember $ticket 'payloadSha256' 'UNK_TICKET_FIELD'
    $sessionId = Get-ManagedUnkString $ticket 'sessionId' 'UNK_TICKET_FIELD'
    if ((-not (Test-ManagedUnkHex $payloadSha)) -or ($payloadSha -cne (Get-ManagedUnkMember $core 'payloadSha256' 'UNK_CORE_FIELD')) -or ($sessionId -cne (Get-ManagedUnkMember $c 'SessionId' 'UNK_CAPTURE_FIELD'))) { Invoke-ManagedUnkRefuse 'UNK_TICKET_BINDING' }
    if (((Get-ManagedUnkMember $core 'runId' 'UNK_CORE_FIELD') -cne $Pe.runId) -or ((Get-ManagedUnkLong $core 'attempt' 'UNK_CORE_FIELD') -ne [long]$Pe.attempt)) { Invoke-ManagedUnkRefuse 'UNK_IDENTITY_MISMATCH' }
    $maxAttempts = Get-ManagedUnkLong $ticket 'maxAttempts' 'UNK_MAXATTEMPTS'
    if (($maxAttempts -le 0) -or ([long]$Pe.attempt -gt $maxAttempts)) { Invoke-ManagedUnkRefuse 'UNK_ATTEMPT_LIMIT' }
    # Exact null core ceiling = NO TOTAL AUTHOR DEADLINE: valid only when the independently authenticated capture Budget.ElapsedMs is also null and never for a failed (DEADLINE) node.
    $meRaw = Get-ManagedUnkMember $core 'maxElapsedMs' 'UNK_MAXELAPSED'
    $cbElapsed = Get-ManagedUnkMember $cbud 'ElapsedMs' 'UNK_MAXELAPSED'
    $maxElapsed = $null
    if ($null -eq $meRaw) {
        # No total author duration: the capture Budget must agree (null). A null duration stays null across every failed node too; it is never replaced by a number.
        if ($null -ne $cbElapsed) { Invoke-ManagedUnkRefuse 'UNK_MAXELAPSED' }
    } else {
        if ($null -eq $cbElapsed) { Invoke-ManagedUnkRefuse 'UNK_MAXELAPSED' }
        $maxElapsed = Get-ManagedUnkLong $core 'maxElapsedMs' 'UNK_MAXELAPSED'
        if ($maxElapsed -le 0) { Invoke-ManagedUnkRefuse 'UNK_MAXELAPSED' }
    }
    $pid1 = Get-ManagedUnkLong $c 'Pid' 'UNK_CAPTURE_FIELD'
    if (($pid1 -le 0) -or ((Get-ManagedUnkLong $term 'pid' 'UNK_TERMINAL_FIELD') -ne $pid1) -or ((Get-ManagedUnkLong $start 'pid' 'UNK_START_FIELD') -ne $pid1)) { Invoke-ManagedUnkRefuse 'UNK_PID_MISMATCH' }
    $startUtc = Get-ManagedUnkString $term 'startTimeUtc' 'UNK_TERMINAL_FIELD'
    $endUtc = Get-ManagedUnkString $term 'endedUtc' 'UNK_TERMINAL_FIELD'
    if ((Get-ManagedUnkString $start 'startTimeUtc' 'UNK_START_FIELD') -cne $startUtc) { Invoke-ManagedUnkRefuse 'UNK_START_MISMATCH' }
    $termReason = Get-ManagedUnkString $term 'reason' 'UNK_TERMINAL_FIELD'
    $termExit = Get-ManagedUnkLong $term 'exitCode' 'UNK_TERMINAL_FIELD'
    if ($Failed) {
        # Reason-specific failed nodes only: a finite DEADLINE, or an actual NATURAL_EXIT with a nonzero typed exit (the null-duration case). Anything else is unsupported.
        if ((($termReason -cne 'DEADLINE') -and ($termReason -cne 'NATURAL_EXIT')) -or ($termExit -eq 0) -or ((Get-ManagedUnkLong $c 'TransportExitCode' 'UNK_CAPTURE_FIELD') -ne $termExit)) { Invoke-ManagedUnkRefuse 'UNK_TERMINAL_STATE' }
        if (($termReason -ceq 'DEADLINE') -and ($null -eq $maxElapsed)) { Invoke-ManagedUnkRefuse 'UNK_MAXELAPSED' }
    }
    elseif (($termReason -cne 'NATURAL_EXIT') -or ($termExit -ne 0) -or ((Get-ManagedUnkLong $c 'TransportExitCode' 'UNK_CAPTURE_FIELD') -ne 0)) { Invoke-ManagedUnkRefuse 'UNK_TERMINAL_STATE' }
    $t0 = ConvertTo-ManagedUnkTicks $startUtc 'UNK_START_UTC'
    $t1 = ConvertTo-ManagedUnkTicks $endUtc 'UNK_END_UTC'
    if ($t1 -lt $t0) { Invoke-ManagedUnkRefuse 'UNK_TIME_ORDER' }
    $dTicks = [long]($t1 - $t0)
    $usedElapsed = [long](($dTicks - ($dTicks % 10000L)) / 10000L)
    if (($dTicks % 10000L) -ne 0) { $usedElapsed = Add-ManagedUnkLong $usedElapsed 1L 'UNK_ELAPSED_OVERFLOW' }
    if ((-not $Failed) -and ($null -ne $maxElapsed) -and ($usedElapsed -gt $maxElapsed)) { Invoke-ManagedUnkRefuse 'UNK_ELAPSED_EXCEEDS' }
    $reqSha = Get-ManagedUnkMember $c 'RequestSha256' 'UNK_CAPTURE_FIELD'
    if (-not (Test-ManagedUnkHex $reqSha)) { Invoke-ManagedUnkRefuse 'UNK_CAPTURE_FIELD' }
    if (($null -ne (Get-ManagedUnkMember $cbud 'AdditionalOutputMax' 'UNK_BUDGET')) -or ($null -ne (Get-ManagedUnkMember $cbud 'PhaseAggregateCeiling' 'UNK_BUDGET')) -or ($null -ne (Get-ManagedUnkMember $cbud 'HistoricalOutputTokens' 'UNK_BUDGET'))) { Invoke-ManagedUnkRefuse 'UNK_BUDGET' }
    return @{ ticket = $ticket; core = $core; term = $term; start = $start; cbud = $cbud; taskId = $taskId; payloadSha = $payloadSha; sessionId = $sessionId; maxAttempts = $maxAttempts; maxElapsed = $maxElapsed; pid1 = $pid1; startUtc = $startUtc; endUtc = $endUtc; termReason = $termReason; termExit = [long]$termExit; usedElapsed = $usedElapsed; reqSha = $reqSha }
}

# Recomputes the native contract from the ACTUAL captured ticket and binds its continuation descriptor to the evidence references.
function Get-ManagedUnkNodeContinuation {
    param([hashtable]$Binding, [hashtable]$Pe)
    $ct = Test-ManagedNativeTicketContract -Ticket $Binding.ticket -ExpectedPayloadSha256 ([string]$Binding.payloadSha)
    if (($null -eq $ct) -or ($ct.Valid -isnot [bool]) -or (-not $ct.Valid)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_CONTRACT' }
    if (($ct.OutputStopMode -isnot [string]) -or ($ct.OutputStopMode -cne 'OBSERVE_ONLY_DESCRIPTOR') -or ($ct.AccountingMode -isnot [string]) -or ($ct.AccountingMode -cne 'UNKNOWN_CONTINUATION') -or ($null -eq $ct.AccountingContinuation)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_CONTINUATION' }
    if (($null -ne $ct.Budget.HistoricalOutputTokens) -or ($null -ne $ct.Budget.AdditionalOutputMax) -or ($null -ne $ct.Budget.PhaseAggregateCeiling)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_CONTINUATION' }
    $ac = $ct.AccountingContinuation
    if (($ac.UnresolvedFailureReceipt.Path -cne [string]$Pe.failPath) -or ($ac.UnresolvedFailureReceipt.Sha256 -cne [string]$Pe.failSha)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_FAILURE_BINDING' }
    if (($ac.HumanDirectionRef.Path -cne [string]$Pe.dirPath) -or ($ac.HumanDirectionRef.Sha256 -cne [string]$Pe.dirSha)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_DIRECTION_BINDING' }
    if (($ac.PredecessorReceipt.Path -cne [string]$Pe.prePath) -or ($ac.PredecessorReceipt.Sha256 -cne [string]$Pe.preSha)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_PREDECESSOR_BINDING' }
    return $ac
}

# Shared read-only SDK observation of one captured pending node; null/UNKNOWN never becomes zero. Returns only the labelled per-child count and the STDOUT leaf.
function Get-ManagedUnkObservedOutput {
    param($Capture, [hashtable]$Pe)
    $c = $Capture
    $curDto = [pscustomobject]([ordered]@{ schema = 'ManagedNativeAdvisoryEvidence/v1'; manifestPath = $Pe.mPath; manifestSha256 = $Pe.mSha; terminalPath = $Pe.tPath; terminalSha256 = $Pe.tSha; ticketPath = $Pe.kPath; runId = $Pe.runId; attempt = [long]$Pe.attempt })
    $obs = Get-ManagedNativeOutputObservation -Evidence $curDto
    if ((@($obs).Count -ne 1) -or ($obs -isnot [System.Management.Automation.PSCustomObject]) -or ((Get-ManagedUnkMember $obs 'Schema' 'UNK_OBSERVATION_SHAPE') -cne 'ManagedNativeOutputObservation/v1')) { Invoke-ManagedUnkRefuse 'UNK_OBSERVATION_SHAPE' }
    foreach ($fl in @('NoAcceptedUsage', 'NoReceipt', 'NoCompletion', 'NoDispatch')) {
        $fv = Get-ManagedUnkMember $obs $fl 'UNK_OBSERVATION_SHAPE'
        if (($fv -isnot [bool]) -or (-not $fv)) { Invoke-ManagedUnkRefuse 'UNK_OBSERVATION_SHAPE' }
    }
    $oStatus = Get-ManagedUnkMember $obs 'Status' 'UNK_OBSERVATION_SHAPE'
    $oCode = Get-ManagedUnkMember $obs 'Code' 'UNK_OBSERVATION_SHAPE'
    if ($oStatus -ceq 'UNKNOWN') { Invoke-ManagedUnkUnknown (Get-ManagedUnkClean $oCode 'OBSERVATION_UNKNOWN') }
    if ($oStatus -ceq 'INVALID') { Invoke-ManagedUnkRefuse (Get-ManagedUnkClean $oCode 'UNK_OBSERVATION_INVALID') }
    if ($oStatus -cne 'OBSERVED') { Invoke-ManagedUnkRefuse 'UNK_OBSERVATION_SHAPE' }
    $oEv = Get-ManagedUnkMember $obs 'Evidence' 'UNK_OBSERVATION_SHAPE'
    if ((ConvertTo-Json -InputObject $oEv -Compress -Depth 4) -cne (ConvertTo-Json -InputObject $curDto -Compress -Depth 4)) { Invoke-ManagedUnkRefuse 'UNK_OBSERVATION_EVIDENCE' }
    $sdk = Get-ManagedUnkMember $obs 'SdkObservation' 'UNK_OBSERVATION_SHAPE'
    if (((Get-ManagedUnkMember $sdk 'Schema' 'UNK_SDK_SHAPE') -cne 'ManagedNativeSdkObservation/v1') -or ((Get-ManagedUnkMember $sdk 'Status' 'UNK_SDK_SHAPE') -cne 'OBSERVED')) { Invoke-ManagedUnkRefuse 'UNK_SDK_SHAPE' }
    foreach ($fl in @('NoAcceptedUsage', 'NoReceipt', 'NoCompletion', 'NoDispatch')) {
        $fv = Get-ManagedUnkMember $sdk $fl 'UNK_SDK_SHAPE'
        if (($fv -isnot [bool]) -or (-not $fv)) { Invoke-ManagedUnkRefuse 'UNK_SDK_SHAPE' }
    }
    if ((Get-ManagedUnkMember $sdk 'SdkOutcome' 'UNK_SDK_SHAPE') -cne 'SUCCESS') { Invoke-ManagedUnkRefuse 'UNK_SDK_NOT_SUCCESS' }
    $recStatus = Get-ManagedUnkMember $sdk 'RecountStatus' 'UNK_SDK_SHAPE'
    $consistency = Get-ManagedUnkMember $sdk 'Consistency' 'UNK_SDK_SHAPE'
    $reported = Get-ManagedUnkMember $sdk 'SdkReportedOutputTokens' 'UNK_SDK_SHAPE'
    $recount = Get-ManagedUnkMember $sdk 'RecountedOutputTokens' 'UNK_SDK_SHAPE'
    # An incomplete observation is UNKNOWN with null counts, never zero.
    if (($recStatus -ceq 'UNAVAILABLE') -or ($consistency -ceq 'UNAVAILABLE') -or ($null -eq $reported) -or ($null -eq $recount)) { Invoke-ManagedUnkUnknown 'RECOUNT_INCOMPLETE' }
    if (($recStatus -cne 'COMPLETE') -or ($consistency -cne 'MATCH')) { Invoke-ManagedUnkRefuse 'UNK_SDK_RECOUNT' }
    if ((($recount -isnot [int]) -and ($recount -isnot [long])) -or ([long]$recount -lt 0) -or (($reported -isnot [int]) -and ($reported -isnot [long])) -or ([long]$reported -ne [long]$recount)) { Invoke-ManagedUnkRefuse 'UNK_SDK_RECOUNT' }
    $observed = [long]$recount
    $starts = Get-ManagedUnkMember $sdk 'MessageStarts' 'UNK_SDK_SHAPE'
    if ((($starts -isnot [int]) -and ($starts -isnot [long])) -or ([long]$starts -lt 1)) { Invoke-ManagedUnkRefuse 'UNK_SDK_RECOUNT' }
    $vr = Get-ManagedUnkMember $sdk 'VerifiedRaw' 'UNK_SDK_SHAPE'
    $leaf = @(@($c.VerifiedReferences) | Where-Object { $_.Role -ceq 'STDOUT' })
    $oRefs = Get-ManagedUnkMember $obs 'VerifiedReferences' 'UNK_OBSERVATION_SHAPE'
    if ($oRefs -isnot [object[]]) { Invoke-ManagedUnkRefuse 'UNK_STDOUT_LEAF' }
    $oLeaf = @($oRefs | Where-Object { ($_ -is [System.Management.Automation.PSCustomObject]) -and ($_.Role -ceq 'STDOUT') })
    if (($leaf.Count -ne 1) -or ($oLeaf.Count -ne 1) -or ($null -eq $vr)) { Invoke-ManagedUnkRefuse 'UNK_STDOUT_LEAF' }
    $leaf = $leaf[0]
    if (($oLeaf[0].Path -cne $leaf.Path) -or ($oLeaf[0].VerifiedSha256 -cne $leaf.VerifiedSha256) -or ([long]$oLeaf[0].VerifiedLength -ne [long]$leaf.VerifiedLength) -or ((Get-ManagedUnkMember $vr 'Path' 'UNK_STDOUT_LEAF') -cne $leaf.Path) -or ((Get-ManagedUnkMember $vr 'Sha256' 'UNK_STDOUT_LEAF') -cne $leaf.VerifiedSha256) -or ((Get-ManagedUnkLong $vr 'Length' 'UNK_STDOUT_LEAF') -ne [long]$leaf.VerifiedLength)) { Invoke-ManagedUnkRefuse 'UNK_STDOUT_LEAF' }
    return @{ observed = $observed; leaf = $leaf }
}

function Get-ManagedUnkInPaths {
    param($Capture, $Extra, $ReceiptPaths)
    $l = [System.Collections.Generic.List[string]]::new()
    foreach ($e in (@($Capture.Inputs) + @($Capture.StreamedInputs) + @($Extra))) {
        $pth = if ($e -is [string]) { [string]$e } else { [string]$e.Path }
        if ($pth.Length -gt 0) { $l.Add($pth) }
    }
    foreach ($rp in @($ReceiptPaths)) { $l.Add([string]$rp) }
    return , @($l.ToArray())
}

# Facts for one pending node: shared by the current node and every ancestry node so receipt comparison uses exactly one derivation.
function New-ManagedUnkPendingFacts {
    param([hashtable]$Pe, $Capture, [hashtable]$Binding, [hashtable]$Observed, [hashtable]$Parent, $Failure, $Direction, [long]$Subtotal, $ChainNodes, $InPaths)
    $c = $Capture; $b = $Binding; $leaf = $Observed.leaf
    $declared = @(@($c.DeclaredReferences))
    $verified = @(@($c.VerifiedReferences))
    $refOf = {
        param([string]$role)
        $d = @($declared | Where-Object { $_.Role -ceq $role }); $v = @($verified | Where-Object { $_.Role -ceq $role })
        if (($d.Count -ne 1) -or ($v.Count -ne 1)) { Invoke-ManagedUnkRefuse 'UNK_REFERENCE' }
        return [pscustomobject]([ordered]@{ path = [string]$v[0].Path; declaredSha256 = [string]$d[0].DeclaredSha256; declaredLength = [long]$d[0].DeclaredLength; verifiedSha256 = [string]$v[0].VerifiedSha256; verifiedLength = [long]$v[0].VerifiedLength })
    }
    $accounting = [pscustomobject]([ordered]@{
        schema = 'ManagedObserveUnknownContinuationAccounting/v1'
        anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
        accountingStatus = 'UNKNOWN'
        accountingUnresolved = $true
        lastVerifiedSubtotal = [long]$Subtotal
        historicalOutputTokens = $null
        currentOutputTokens = $null
        usedOutputTokens = $null
        cumulativeOutputTokens = $null
        childObservedOutputTokens = [long]$Observed.observed
        childObservedLabel = 'CHILD_SDK_MEASURED_ONLY'
        unresolvedFailure = $Failure
        humanDirectionRef = $Direction
        parent = [pscustomobject]([ordered]@{ receiptPath = [string]$Parent.path; receiptSha256 = [string]$Parent.sha256; schemaVersion = [string]$Parent.schemaVersion; runId = [string]$Parent.runId; attempt = [long]$Parent.attempt })
        chain = @($ChainNodes)
        requestSha256 = [string]$b.reqSha
        startUtc = $b.startUtc
        endedUtc = $b.endUtc
        noAcceptedUsage = $true; noCompletion = $true; noAck = $true; noDispatch = $true
    })
    $facts = [pscustomobject]([ordered]@{
        schema = 'ManagedObserveUnknownContinuationFacts/v1'
        evidence = (New-ManagedUnkEvidenceDto $Pe)
        anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
        identity = [pscustomobject]([ordered]@{ taskId = $b.taskId; payloadSha256 = [string]$b.payloadSha; runId = $Pe.runId; attempt = [long]$Pe.attempt; sessionId = $b.sessionId; pid = $b.pid1; terminalReason = $b.termReason })
        limits = [pscustomobject]([ordered]@{ maxElapsedMs = $b.maxElapsed; maxAttempts = $b.maxAttempts; priorElapsedMs = 0L; maxOutputTokens = $null; softFraction = $null })
        timing = [pscustomobject]([ordered]@{ startUtc = $b.startUtc; endedUtc = $b.endUtc; usedElapsedMs = $b.usedElapsed })
        accounting = $accounting
        stdout = [pscustomobject]([ordered]@{ path = [string]$leaf.Path; sha256 = [string]$leaf.VerifiedSha256; length = [long]$leaf.VerifiedLength })
        references = [pscustomobject]([ordered]@{
            manifest = [pscustomobject]([ordered]@{ path = $Pe.mPath; expectedSha256 = $Pe.mSha; verifiedSha256 = [string]$c.ManifestSha256 })
            terminal = [pscustomobject]([ordered]@{ path = $Pe.tPath; expectedSha256 = $Pe.tSha; verifiedSha256 = [string]$c.TerminalSha256 })
            ticket = [pscustomobject]([ordered]@{ path = $Pe.kPath; expectedSha256 = [string](Get-ManagedUnkMember $b.core 'ticketSha256' 'UNK_CORE_FIELD'); verifiedSha256 = [string]$c.TicketSha256 })
            predecessorReceipt = [pscustomobject]([ordered]@{ path = $Pe.prePath; expectedSha256 = $Pe.preSha; verifiedSha256 = [string]$Parent.sha256 })
            unresolvedFailureReceipt = [pscustomobject]([ordered]@{ path = $Pe.failPath; expectedSha256 = $Pe.failSha; verifiedSha256 = [string]$Failure.receipt.sha256 })
            humanDirection = [pscustomobject]([ordered]@{ path = $Pe.dirPath; expectedSha256 = $Pe.dirSha; verifiedSha256 = [string]$Direction.sha256 })
            stdout = (& $refOf 'STDOUT')
            stderr = (& $refOf 'STDERR')
            artifactState = [string]$c.ArtifactState
        })
        inputPaths = @($InPaths)
        noAcceptedUsage = $true; noCompletion = $true; noAck = $true; noDispatch = $true
    })
    return $facts
}

function ConvertTo-ManagedUnkContinuationOfFailed {
    # Pure structural projection of a stored v7 failed evidence DTO onto its continuation evidence (the first five members). Authenticates nothing.
    param($Ev)
    Assert-ManagedUnkExact $Ev @('schema', 'current', 'predecessorReceipt', 'unresolvedFailureReceipt', 'humanDirectionRef', 'registrationRef', 'selectedClaimRef', 'acknowledgementsRef') 'UNK_EVIDENCE_SHAPE'
    $sc = Get-ManagedUnkMember $Ev 'schema' 'UNK_EVIDENCE_SHAPE'
    if (($sc -isnot [string]) -or ($sc -cne 'ManagedObserveUnknownFailedEvidence/v1')) { Invoke-ManagedUnkRefuse 'UNK_EVIDENCE_SCHEMA' }
    return [pscustomobject]([ordered]@{
        schema = 'ManagedObserveUnknownContinuationEvidence/v1'
        current = (Get-ManagedUnkMember $Ev 'current' 'UNK_EVIDENCE_SHAPE')
        predecessorReceipt = (Get-ManagedUnkMember $Ev 'predecessorReceipt' 'UNK_EVIDENCE_SHAPE')
        unresolvedFailureReceipt = (Get-ManagedUnkMember $Ev 'unresolvedFailureReceipt' 'UNK_EVIDENCE_SHAPE')
        humanDirectionRef = (Get-ManagedUnkMember $Ev 'humanDirectionRef' 'UNK_EVIDENCE_SHAPE')
    })
}

function New-ManagedUnkChainDto {
    param([hashtable]$ParentInfo, $Failure, $Direction, $NodeDtos, [long]$Subtotal, $Extra, $ReceiptPaths)
    return [pscustomobject]([ordered]@{
        Parent = [pscustomobject]([ordered]@{ receiptPath = [string]$ParentInfo.path; receiptSha256 = [string]$ParentInfo.sha256; schemaVersion = [string]$ParentInfo.schemaVersion; runId = [string]$ParentInfo.runId; attempt = [long]$ParentInfo.attempt })
        Failure = $Failure
        HumanDirectionRef = $Direction
        Nodes = @($NodeDtos.ToArray())
        LastVerifiedSubtotal = [long]$Subtotal
        InPaths = @((Get-ManagedUnkInPaths ([pscustomobject]@{ Inputs = @(); StreamedInputs = @() }) $Extra $ReceiptPaths))
    })
}

# Base for the failed (v7) facts of one node whose parent chain is ALREADY authenticated bottom-up by the caller. The facts function never walks the chain for such a
# base, so parent-chain -> failed-facts -> parent-chain recursion cannot occur; the base is built only from the caller's own authenticated nodes, never from supplied facts.
function New-ManagedUnkFailedBase {
    param([hashtable]$Pe, $Capture, [hashtable]$Binding, $Chain)
    $b = $Binding
    return [pscustomobject]([ordered]@{
        Selection = (New-ManagedUnkEvidenceDto $Pe)
        Capture = $Capture
        Bound = [pscustomobject]([ordered]@{ taskId = [string]$b.taskId; payloadSha256 = [string]$b.payloadSha; sessionId = [string]$b.sessionId; pid = [long]$b.pid1; startUtc = [string]$b.startUtc; endUtc = [string]$b.endUtc; terminalReason = [string]$b.termReason; exitCode = [long]$b.termExit; maxAttempts = [long]$b.maxAttempts; maxElapsedMs = $(if ($null -eq $b.maxElapsed) { $null } else { [long]$b.maxElapsed }); usedElapsedMs = [long]$b.usedElapsed; requestSha256 = [string]$b.reqSha; ticketSha256 = [string](Get-ManagedUnkMember $b.core 'ticketSha256' 'UNK_CORE_FIELD') })
        ParentReceipt = [pscustomobject]([ordered]@{ path = [string]$Chain.Parent.receiptPath; sha256 = [string]$Chain.Parent.receiptSha256; schemaVersion = [string]$Chain.Parent.schemaVersion; runId = [string]$Chain.Parent.runId; attempt = [long]$Chain.Parent.attempt })
        Chain = $Chain
        HumanDirectionRef = $Chain.HumanDirectionRef
        LastVerifiedSubtotal = [long]$Chain.LastVerifiedSubtotal
        InPaths = @((Get-ManagedUnkInPaths $Capture @() @()) + @($Chain.InPaths))
    })
}

# Full-chain stability: every retained ancestor receipt, raw DTO, capture and proof reference (including the failed root and its raw DTO) is rechecked from the pinned
# bytes. Callers invoke this AFTER all later processing (including SDK observation) and before any fact escapes; an immediate-parent-only check is never enough.
function Assert-ManagedUnkChainStable {
    param($Retained, [string]$ControlRoot)
    if (($null -eq $Retained) -or ($null -eq $Retained.failure) -or ($null -eq $Retained.nodes)) { Invoke-ManagedUnkRefuse 'UNK_RETAINED_MISSING' }
    $f = $Retained.failure
    $fx2 = Read-ManagedUnkPinned $f.ref $ControlRoot 'UNK_STALE_FAILURE'
    if (($fx2.Sha256 -cne $f.read.Sha256) -or ($fx2.Length -ne $f.read.Length)) { Invoke-ManagedUnkRefuse 'UNK_STALE_FAILURE' }
    $r = Get-ManagedObserveFailedTransportFacts -Evidence $f.evidence
    if (($null -ne $r) -and ($null -ne $r.PSObject.Properties['Status']) -and ($r.Status -ceq 'UNKNOWN')) { Invoke-ManagedUnkUnknown (Get-ManagedUnkClean $r.Reason 'FAILURE_UNKNOWN') }
    if (($null -eq $r) -or ($r.Valid -isnot [bool]) -or (-not $r.Valid) -or ($null -eq $r.Facts)) { Invoke-ManagedUnkRefuse 'UNK_STALE_FAILURE' }
    if ((ConvertTo-Json -InputObject $r.Facts -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $f.facts -Depth 12 -Compress)) { Invoke-ManagedUnkRefuse 'UNK_STALE_FAILURE' }
    $fr = Test-ManagedObserveFailedTransportRawDto -RawPath $f.rawPath -ExpectedSha256 $f.rawSha -Facts $f.facts
    if (($null -eq $fr) -or ($fr.Valid -isnot [bool]) -or (-not $fr.Valid) -or ($fr.Path -cne $f.rawPath)) { Invoke-ManagedUnkRefuse 'UNK_FAILURE_RAW' }
    foreach ($rf in @($f.facts.proof.registrationRef, $f.facts.proof.selectedClaimRef, $f.facts.proof.acknowledgementsRef)) {
        $null = Read-ManagedUnkPinned @{ path = [string]$rf.path; sha256 = [string]$rf.sha256 } $ControlRoot 'UNK_STALE_FAILURE'
    }
    foreach ($n in $Retained.nodes) {
        $q2 = Read-ManagedUnkPinned $n.ref $ControlRoot 'UNK_STALE_PREDECESSOR'
        if (($q2.Sha256 -cne $n.read.Sha256) -or ($q2.Length -ne $n.read.Length)) { Invoke-ManagedUnkRefuse 'UNK_STALE_PREDECESSOR' }
        $kc = Get-ManagedUnkCapture $n.pe $n.failed
        if ((Get-ManagedUnkSignature $kc) -cne (Get-ManagedUnkSignature $n.nc)) { Invoke-ManagedUnkRefuse 'UNK_STALE_ANCESTOR' }
        if ($n.failed) { $kr = Test-ManagedObserveUnknownFailedRawDto -RawPath $n.rawPath -ExpectedSha256 $n.rawSha -Facts $n.facts }
        else { $kr = Test-ManagedObserveUnknownPendingRawDto -RawPath $n.rawPath -ExpectedSha256 $n.rawSha -Facts $n.facts }
        if (($null -eq $kr) -or ($kr.Valid -isnot [bool]) -or (-not $kr.Valid) -or ($kr.Path -cne $n.rawPath)) { Invoke-ManagedUnkRefuse 'UNK_ANCESTOR_RAW' }
        if ($n.failed) {
            foreach ($rf in @($n.facts.proof.registrationRef, $n.facts.proof.selectedClaimRef, $n.facts.proof.acknowledgementsRef)) {
                $null = Read-ManagedUnkPinned @{ path = [string]$rf.path; sha256 = [string]$rf.sha256 } $ControlRoot 'UNK_STALE_ANCESTOR'
            }
        }
    }
}

function Get-ManagedObserveUnknownParentChain {
    # Read-only. Authenticates the immediate parent of an UNKNOWN-history child back to the unresolved failed v5 root. The ancestry is first WALKED from the pinned receipts
    # with cycle and depth protection and no proof derivation; only then is every node derived bottom-up (oldest first): the failed v5 root through the failed-transport
    # verifier (registration, claim, ACK, raw DTO, known v1/v3 lineage, last verified subtotal), each v6 pending node through its own capture, ticket continuation and SDK
    # observation, and each v7 FAILED node through its own failed capture, ticket continuation, registration, claim, ACK and raw DTO against a base built only from the
    # already authenticated older nodes (no recursion, no supplied facts). Lineage identities may not repeat. Nothing is accepted from the caller except the two pinned
    # references and the expected subtotal; all retained pins, receipts, raw DTOs and captures are rechecked at the end and again by the callers after later processing.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$ParentRef,
        [Parameter(Mandatory)]$FailureRef,
        [Parameter(Mandatory)][string]$ControlRoot,
        [Parameter(Mandatory)][long]$ExpectedSubtotal
    )
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    $ordIc = [System.StringComparison]::OrdinalIgnoreCase
    try {
        try {
            . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-sdk-observation.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-output-observation.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
            . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'host-continuation') 'registered-review-record-reader.ps1')
            . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'host-continuation') 'registered-review-prelaunch-capture.ps1')
        } catch { Invoke-ManagedUnkRefuse 'UNK_SIBLING_UNAVAILABLE' }

        $parent = ConvertTo-ManagedUnkRef $ParentRef 'UNK_PARENT_REF'
        $failure = ConvertTo-ManagedUnkRef $FailureRef 'UNK_FAILURE_REF'
        $dir = $null
        try { $dir = Assert-ManagedUnknownContinuationDirective -ControlRoot $ControlRoot } catch { $dir = $null }
        if (($null -eq $dir) -or ($dir -isnot [System.Management.Automation.PSCustomObject])) { Invoke-ManagedUnkRefuse 'UNK_DIRECTION' }
        $direction = @{ path = [string]$dir.Path; sha256 = [string]$dir.Sha256 }

        # ---- unresolved failed v5 root, rederived from its own embedded evidence ----
        $fx = Read-ManagedUnkPinned $failure $ControlRoot 'UNK_FAILURE_UNREADABLE'
        $fv = $fx.Value
        if (-not (Test-ManagedObserveFailedTransportReceiptV5Shape $fv)) { Invoke-ManagedUnkRefuse 'UNK_FAILURE_SHAPE' }
        $failEvidence = Get-ManagedUnkMember $fv 'observeFailedTransportEvidence' 'UNK_FAILURE_SHAPE'
        $r0 = Get-ManagedObserveFailedTransportFacts -Evidence $failEvidence
        if (($null -ne $r0) -and ($null -ne $r0.PSObject.Properties['Status']) -and ($r0.Status -ceq 'UNKNOWN')) { Invoke-ManagedUnkUnknown (Get-ManagedUnkClean $r0.Reason 'FAILURE_UNKNOWN') }
        if (($null -eq $r0) -or ($r0.Valid -isnot [bool]) -or (-not $r0.Valid) -or ($null -eq $r0.Facts) -or ($null -eq $r0.Lineage)) { Invoke-ManagedUnkRefuse 'UNK_FAILURE_FACTS' }
        $fFacts = $r0.Facts
        if (-not (Compare-ManagedObserveFailedTransportReceiptV5ToFacts $fv $fFacts)) { Invoke-ManagedUnkRefuse 'UNK_FAILURE_COMPARE' }
        $fEv = Get-ManagedUnkMember $fv 'evidence' 'UNK_FAILURE_SHAPE'
        $fRawPath = [string](Get-ManagedUnkMember $fEv 'rawPath' 'UNK_FAILURE_SHAPE')
        $fRawSha = [string](Get-ManagedUnkMember $fEv 'rawSha256' 'UNK_FAILURE_SHAPE')
        $fRaw = Test-ManagedObserveFailedTransportRawDto -RawPath $fRawPath -ExpectedSha256 $fRawSha -Facts $fFacts
        if (($null -eq $fRaw) -or ($fRaw.Valid -isnot [bool]) -or (-not $fRaw.Valid) -or ($fRaw.Path -cne $fRawPath)) { Invoke-ManagedUnkRefuse 'UNK_FAILURE_RAW' }
        $subtotal = [long]$fFacts.accounting.lastVerifiedParentOutputTokens
        if ($subtotal -ne $ExpectedSubtotal) { Invoke-ManagedUnkRefuse 'UNK_SUBTOTAL_MISMATCH' }
        $registry = New-ManagedUnkRegistry $r0.Lineage
        $retained = @{ failure = @{ ref = $failure; read = $fx; evidence = $failEvidence; facts = $fFacts; rawPath = $fRawPath; rawSha = $fRawSha }; nodes = [System.Collections.Generic.List[object]]::new() }

        # ---- WALK ONLY: collect the immediate-predecessor edges from the selected parent back to the failed root. Cycle and depth protection happen here, before any
        # node proof (in particular any v7 proof) is derived. Bound exhaustion refuses explicitly; nothing is truncated or accepted partially. ----
        $nodes = [System.Collections.Generic.List[object]]::new()
        $seenSha = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        $seenPath = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        [void]$seenSha.Add([string]$failure.sha256)
        [void]$seenPath.Add([string]$failure.path)
        $cursor = $parent
        while ($true) {
            if ([string]::Equals([string]$cursor.sha256, [string]$failure.sha256, $ord)) {
                if (-not [string]::Equals([string]$cursor.path, [string]$failure.path, $ordIc)) { Invoke-ManagedUnkRefuse 'UNK_PARENT_ALIAS' }
                break
            }
            if ($nodes.Count -ge 64) { Invoke-ManagedUnkRefuse 'UNK_CHAIN_TOO_DEEP' }
            if ((-not $seenSha.Add([string]$cursor.sha256)) -or (-not $seenPath.Add([string]$cursor.path))) { Invoke-ManagedUnkRefuse 'UNK_CHAIN_CYCLE' }
            $rd = Read-ManagedUnkPinned $cursor $ControlRoot 'UNK_PREDECESSOR_UNREADABLE'
            $rv = $rd.Value
            $sv = Get-ManagedUnkMember $rv 'schemaVersion' 'UNK_PREDECESSOR_UNSUPPORTED'
            $v7ev = $null
            if (($sv -is [string]) -and ($sv -ceq 'OperationalRunReceipt/v6')) {
                if (-not (Test-ManagedObserveUnknownPendingReceiptV6Shape $rv)) { Invoke-ManagedUnkRefuse 'UNK_ANCESTOR_RECEIPT' }
                $ape = ConvertTo-ManagedUnkEvidence (Get-ManagedUnkMember $rv 'observeUnknownContinuationEvidence' 'UNK_ANCESTOR_RECEIPT')
                $kind = 'v6'
            }
            elseif (($sv -is [string]) -and ($sv -ceq 'OperationalRunReceipt/v7')) {
                if (-not (Test-ManagedObserveUnknownFailedReceiptV7Shape $rv)) { Invoke-ManagedUnkRefuse 'UNK_ANCESTOR_RECEIPT' }
                $v7ev = Get-ManagedUnkMember $rv 'observeUnknownFailedEvidence' 'UNK_ANCESTOR_RECEIPT'
                $ape = ConvertTo-ManagedUnkEvidence (ConvertTo-ManagedUnkContinuationOfFailed $v7ev)
                $kind = 'v7'
            }
            else { Invoke-ManagedUnkRefuse 'UNK_PREDECESSOR_UNSUPPORTED' }
            if (($ape.failPath -cne [string]$failure.path) -or ($ape.failSha -cne [string]$failure.sha256) -or ($ape.dirPath -cne $direction.path) -or ($ape.dirSha -cne $direction.sha256)) { Invoke-ManagedUnkRefuse 'UNK_ANCESTOR_BINDING' }
            $nodes.Add(@{ kind = $kind; read = $rd; pe = $ape; receipt = $rv; v7ev = $v7ev })
            $cursor = @{ path = [string]$ape.prePath; sha256 = [string]$ape.preSha }
        }

        # ---- shared facts of the failure root, retained verbatim in every descendant ----
        $failureDto = [pscustomobject]([ordered]@{
            receipt = (New-ManagedUnkRefDto @{ path = [string]$failure.path; sha256 = [string]$failure.sha256 })
            runId = [string]$fFacts.identity.runId
            attempt = [long]$fFacts.identity.attempt
            raw = (New-ManagedUnkRefDto @{ path = $fRawPath; sha256 = $fRawSha })
            registrationRef = $fFacts.proof.registrationRef
            selectedClaimRef = $fFacts.proof.selectedClaimRef
            acknowledgementsRef = $fFacts.proof.acknowledgementsRef
            anchor = $fFacts.accounting.anchor
            parent = $fFacts.accounting.parent
            lastVerifiedSubtotal = [long]$subtotal
            knownLineage = $r0.Lineage
        })
        $directionDto = New-ManagedUnkRefDto $direction

        # ---- DERIVE bottom-up (oldest descendant first); every node is rederived and compared with its stored receipt and raw DTO ----
        $nodeDtos = [System.Collections.Generic.List[object]]::new()
        $extra = [System.Collections.Generic.List[object]]::new()
        foreach ($e in @($fFacts.inputPaths)) { $extra.Add([string]$e) }
        $receiptPaths = [System.Collections.Generic.List[string]]::new()
        $receiptPaths.Add([string]$failure.path)
        $parentInfo = @{ path = [string]$failure.path; sha256 = [string]$failure.sha256; schemaVersion = 'OperationalRunReceipt/v5'; runId = [string]$fFacts.identity.runId; attempt = [long]$fFacts.identity.attempt }
        for ($i = $nodes.Count - 1; $i -ge 0; $i--) {
            $nd = $nodes[$i]
            $ape = $nd.pe
            $isFailedNode = ($nd.kind -ceq 'v7')
            $nc = Get-ManagedUnkCapture $ape $isFailedNode
            $nb = Get-ManagedUnkNodeBinding $nc $ape $isFailedNode
            $nac = Get-ManagedUnkNodeContinuation $nb $ape
            if ([long]$nac.LastVerifiedSubtotal -ne $subtotal) { Invoke-ManagedUnkRefuse 'UNK_SUBTOTAL_MISMATCH' }
            $no = $null
            if (-not $isFailedNode) { $no = Get-ManagedUnkObservedOutput $nc $ape }
            $nc2 = Get-ManagedUnkCapture $ape $isFailedNode
            if ((Get-ManagedUnkSignature $nc2) -cne (Get-ManagedUnkSignature $nc)) { Invoke-ManagedUnkRefuse 'UNK_STALE_ANCESTOR' }
            Register-ManagedUnkIdentity $registry @{ runId = [string]$ape.runId; req = [string]$nb.reqSha; termSha = [string]$nc.TerminalSha256; termPath = [string]$nc.TerminalPath; manSha = [string]$nc.ManifestSha256; tkSha = [string]$nc.TicketSha256; session = [string]$nb.sessionId }
            $rEv = Get-ManagedUnkMember $nd.receipt 'evidence' 'UNK_ANCESTOR_RAW'
            $rawPath = [string](Get-ManagedUnkMember $rEv 'rawPath' 'UNK_ANCESTOR_RAW')
            $rawSha = [string](Get-ManagedUnkMember $rEv 'rawSha256' 'UNK_ANCESTOR_RAW')
            if ($isFailedNode) {
                $soFar = New-ManagedUnkChainDto $parentInfo $failureDto $directionDto $nodeDtos $subtotal $extra $receiptPaths
                $fbase = New-ManagedUnkFailedBase $ape $nc $nb $soFar
                # Structural assembly from a base built only from this routine's own already authenticated older nodes; refusals throw into this routine's catch, and
                # the retained-chain recheck below (and the callers' later recheck) owns stability. This is not a public success path.
                $nf = Get-ManagedUnkFailedAssembly -Evidence $nd.v7ev -Base $fbase
                if (-not (Compare-ManagedObserveUnknownFailedReceiptV7ToFacts $nd.receipt $nf)) { Invoke-ManagedUnkRefuse 'UNK_ANCESTOR_RECEIPT' }
                $rawRef = Test-ManagedObserveUnknownFailedRawDto -RawPath $rawPath -ExpectedSha256 $rawSha -Facts $nf
            }
            else {
                $nf = New-ManagedUnkPendingFacts -Pe $ape -Capture $nc -Binding $nb -Observed $no -Parent $parentInfo -Failure $failureDto -Direction $directionDto -Subtotal $subtotal -ChainNodes @($nodeDtos.ToArray()) -InPaths (Get-ManagedUnkInPaths $nc $extra $receiptPaths)
                if (-not (Compare-ManagedObserveUnknownPendingReceiptV6ToFacts $nd.receipt $nf)) { Invoke-ManagedUnkRefuse 'UNK_ANCESTOR_RECEIPT' }
                $rawRef = Test-ManagedObserveUnknownPendingRawDto -RawPath $rawPath -ExpectedSha256 $rawSha -Facts $nf
            }
            if (($null -eq $rawRef) -or ($rawRef.Valid -isnot [bool]) -or (-not $rawRef.Valid) -or ($rawRef.Path -cne $rawPath)) { Invoke-ManagedUnkRefuse 'UNK_ANCESTOR_RAW' }
            $retained.nodes.Add(@{ ref = @{ path = [string]$nd.read.Path; sha256 = [string]$nd.read.Sha256 }; read = $nd.read; pe = $ape; failed = $isFailedNode; nc = $nc; facts = $nf; rawPath = $rawPath; rawSha = $rawSha })
            foreach ($e in (@($nc.Inputs) + @($nc.StreamedInputs))) { $extra.Add($e) }
            $receiptPaths.Add([string]$nd.read.Path)
            $nodeSchema = if ($isFailedNode) { 'OperationalRunReceipt/v7' } else { 'OperationalRunReceipt/v6' }
            $nodeDtos.Add([pscustomobject]([ordered]@{ receiptPath = [string]$nd.read.Path; receiptSha256 = [string]$nd.read.Sha256; schemaVersion = $nodeSchema; runId = [string]$ape.runId; attempt = [long]$ape.attempt }))
            $parentInfo = @{ path = [string]$nd.read.Path; sha256 = [string]$nd.read.Sha256; schemaVersion = $nodeSchema; runId = [string]$ape.runId; attempt = [long]$ape.attempt }
        }

        # ---- stability inside the chain; the callers repeat this after their own later processing ----
        Assert-ManagedUnkChainStable $retained $ControlRoot

        $chain = New-ManagedUnkChainDto $parentInfo $failureDto $directionDto $nodeDtos $subtotal $extra $receiptPaths
        return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'UNKNOWN_PARENT_CHAIN'; Chain = $chain; Registry = $registry; Retained = $retained; ControlRoot = $ControlRoot }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($m.StartsWith('UNKNOWN:', $ord) -and ($m.Length -le 56) -and ($m.Substring(8) -cmatch '^[A-Z0-9_]{1,48}$')) {
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_UNKNOWN_PARENT_UNKNOWN'; Result = 'NONRECEIPT'; Status = 'UNKNOWN'; Reason = $m.Substring(8); Chain = $null; Registry = $null; Retained = $null }
        }
        $code = 'UNK_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', $ord) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Result = 'REFUSED'; Chain = $null; Registry = $null; Retained = $null }
    }
}

function Get-ManagedObserveUnknownContinuationFacts {
    # Read-only. Derives the facts of ONE OBSERVE_ONLY child that follows UNKNOWN accounting history. Pending mode yields the pending v6 accounting facts (every total
    # null, the last verified subtotal separate, the measured per-child SDK count labelled child-only). -FailedCurrent (internal to Get-ManagedObserveUnknownFailedFacts)
    # treats the CURRENT node as an authenticated DEADLINE failed transport instead and returns a base for the failed facts; the parent authentication is the same code.
    # This verifier authenticates referenced data only, never operator authorization, and grants no completion, ACK, acceptance or dispatch.
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Evidence, [switch]$FailedCurrent)
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    $F = $FailedCurrent.IsPresent
    try {
        $pe = ConvertTo-ManagedUnkEvidence $Evidence
        try {
            . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-sdk-observation.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-output-observation.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
        } catch { Invoke-ManagedUnkRefuse 'UNK_SIBLING_UNAVAILABLE' }

        $c = Get-ManagedUnkCapture $pe $F
        $b = Get-ManagedUnkNodeBinding $c $pe $F
        $ac = Get-ManagedUnkNodeContinuation $b $pe
        $wd = Get-ManagedUnkString $b.core 'workingDirectory' 'UNK_CORE_FIELD'
        $controlRoot = [System.IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')

        $chainRes = Get-ManagedObserveUnknownParentChain -ParentRef (New-ManagedUnkRefDto @{ path = $pe.prePath; sha256 = $pe.preSha }) -FailureRef (New-ManagedUnkRefDto @{ path = $pe.failPath; sha256 = $pe.failSha }) -ControlRoot $controlRoot -ExpectedSubtotal ([long]$ac.LastVerifiedSubtotal)
        if (($null -eq $chainRes) -or ($chainRes.Valid -isnot [bool])) { Invoke-ManagedUnkRefuse 'UNK_CHAIN_SHAPE' }
        if (-not $chainRes.Valid) {
            if (($null -ne $chainRes.PSObject.Properties['Status']) -and ($chainRes.Status -ceq 'UNKNOWN')) { Invoke-ManagedUnkUnknown (Get-ManagedUnkClean $chainRes.Reason 'PARENT_UNKNOWN') }
            Invoke-ManagedUnkRefuse (Get-ManagedUnkClean $chainRes.Code 'UNK_CHAIN_REFUSED')
        }
        $chain = $chainRes.Chain
        $direction = $chain.HumanDirectionRef
        if (($ac.HumanDirectionRef.Path -cne [string]$direction.path) -or ($ac.HumanDirectionRef.Sha256 -cne [string]$direction.sha256)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_DIRECTION_BINDING' }
        if (($chain.Parent.receiptPath -cne [string]$pe.prePath) -or ($chain.Parent.receiptSha256 -cne [string]$pe.preSha)) { Invoke-ManagedUnkRefuse 'UNK_PARENT_BINDING' }
        Register-ManagedUnkIdentity $chainRes.Registry @{ runId = [string]$pe.runId; req = [string]$b.reqSha; termSha = [string]$c.TerminalSha256; termPath = [string]$c.TerminalPath; manSha = [string]$c.ManifestSha256; tkSha = [string]$c.TicketSha256; session = [string]$b.sessionId }

        $parentInfo = @{ path = [string]$chain.Parent.receiptPath; sha256 = [string]$chain.Parent.receiptSha256; schemaVersion = [string]$chain.Parent.schemaVersion; runId = [string]$chain.Parent.runId; attempt = [long]$chain.Parent.attempt }
        $o = $null
        if (-not $F) { $o = Get-ManagedUnkObservedOutput $c $pe }

        # ---- stability: recapture current and re-read the selected parent after all other reads ----
        $c2 = Get-ManagedUnkCapture $pe $F
        if ((Get-ManagedUnkSignature $c2) -cne (Get-ManagedUnkSignature $c)) { Invoke-ManagedUnkRefuse 'UNK_STALE_CURRENT' }
        $p2 = Read-ManagedUnkPinned @{ path = [string]$pe.prePath; sha256 = [string]$pe.preSha } $controlRoot 'UNK_STALE_PREDECESSOR'
        if ($p2.Sha256 -cne [string]$pe.preSha) { Invoke-ManagedUnkRefuse 'UNK_STALE_PREDECESSOR' }

        # Full-chain stability AFTER all current processing (including the SDK observation): every retained ancestor pin, receipt, raw DTO and capture is rechecked
        # before any fact escapes. This never relies on the earlier check inside the chain derivation.
        Assert-ManagedUnkChainStable $chainRes.Retained $controlRoot

        if ($F) {
            $fbase = New-ManagedUnkFailedBase $pe $c $b $chain
            return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'UNKNOWN_FAILED_BASE'; Facts = $null; Base = $fbase; ChainRetained = $chainRes.Retained; ChainControlRoot = $controlRoot }
        }
        $facts = New-ManagedUnkPendingFacts -Pe $pe -Capture $c -Binding $b -Observed $o -Parent $parentInfo -Failure $chain.Failure -Direction $direction -Subtotal ([long]$chain.LastVerifiedSubtotal) -ChainNodes @($chain.Nodes) -InPaths (@((Get-ManagedUnkInPaths $c @() @())) + @($chain.InPaths))
        return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'UNKNOWN_PENDING_ACCOUNTING'; Facts = $facts }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($m.StartsWith('UNKNOWN:', $ord) -and ($m.Length -le 56) -and ($m.Substring(8) -cmatch '^[A-Z0-9_]{1,48}$')) {
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_UNKNOWN_CONTINUATION_UNKNOWN'; Result = 'NONRECEIPT'; Status = 'UNKNOWN'; Reason = $m.Substring(8); ObservedOutputTokens = $null; UsedOutputTokens = $null; Facts = $null }
        }
        $code = 'UNK_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', $ord) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Result = 'REFUSED'; Facts = $null }
    }
}

function Test-ManagedObserveUnknownPendingRawDto {
    # Read-only. The pending raw-DTO cross-check in its UNKNOWN-continuation mode (labelled per-child count only; history stays null).
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [AllowNull()][AllowEmptyString()][string]$ExpectedSha256,
        [Parameter(Mandatory)]$Facts
    )
    return Test-ManagedObservePendingRawDto -RawPath $RawPath -ExpectedSha256 $ExpectedSha256 -Facts $Facts -UnknownContinuation
}

function Test-ManagedObserveUnknownFailedRawDto {
    # Read-only. The failed-transport raw-DTO cross-check in its UNKNOWN-continuation mode (actual nonzero exit; observed output and history null).
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [AllowNull()][AllowEmptyString()][string]$ExpectedSha256,
        [Parameter(Mandatory)]$Facts
    )
    return Test-ManagedObservePendingRawDto -RawPath $RawPath -ExpectedSha256 $ExpectedSha256 -Facts $Facts -FailedTransport -UnknownContinuation
}

function Test-ManagedObserveUnknownContinuationPrelaunch {
    # Read-only, no child and no write. Authenticates an UNKNOWN-continuation next ticket against the ACTUAL parent chain BEFORE any process start or allocation
    # admission: the ticket bytes are decoded by the caller (never a caller fact), the native contract is recomputed, the fixed human direction is authenticated, and
    # the immediate parent, the unresolved failed root, the subtotal and the lineage are rederived. The next run/session identity must be new. Authenticates data only.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()]$Ticket,
        [Parameter(Mandatory)][string]$PayloadSha256,
        [Parameter(Mandatory)][string]$ControlRoot,
        [AllowNull()][string]$RunId,
        [AllowNull()][string]$ExpectedParentSha256,
        [AllowNull()][string]$ExpectedParentPath
    )
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    try {
        try {
            . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-sdk-observation.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-output-observation.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
        } catch { Invoke-ManagedUnkRefuse 'UNK_SIBLING_UNAVAILABLE' }
        $ct = Test-ManagedNativeTicketContract -Ticket $Ticket -ExpectedPayloadSha256 $PayloadSha256
        if (($null -eq $ct) -or ($ct.Valid -isnot [bool]) -or (-not $ct.Valid)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_CONTRACT' }
        if (($ct.OutputStopMode -isnot [string]) -or ($ct.OutputStopMode -cne 'OBSERVE_ONLY_DESCRIPTOR') -or ($ct.AccountingMode -isnot [string]) -or ($ct.AccountingMode -cne 'UNKNOWN_CONTINUATION') -or ($null -eq $ct.AccountingContinuation) -or ($null -eq $ct.OutputStops)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_CONTINUATION' }
        if (($null -ne $ct.Budget.HistoricalOutputTokens) -or ($null -ne $ct.Budget.AdditionalOutputMax) -or ($null -ne $ct.Budget.PhaseAggregateCeiling)) { Invoke-ManagedUnkRefuse 'UNK_TICKET_CONTINUATION' }
        $ac = $ct.AccountingContinuation
        $dir = $null
        try { $dir = Assert-ManagedUnknownContinuationDirective -ControlRoot $ControlRoot } catch { $dir = $null }
        if (($null -eq $dir) -or ($dir -isnot [System.Management.Automation.PSCustomObject]) -or ($ac.HumanDirectionRef.Path -cne [string]$dir.Path) -or ($ac.HumanDirectionRef.Sha256 -cne [string]$dir.Sha256)) { Invoke-ManagedUnkRefuse 'UNK_DIRECTION' }
        if ((-not [string]::IsNullOrEmpty($ExpectedParentSha256)) -and ($ac.PredecessorReceipt.Sha256 -cne $ExpectedParentSha256)) { Invoke-ManagedUnkRefuse 'UNK_PARENT_BINDING' }
        if ((-not [string]::IsNullOrEmpty($ExpectedParentPath)) -and (-not [string]::Equals($ac.PredecessorReceipt.Path, $ExpectedParentPath, [System.StringComparison]::OrdinalIgnoreCase))) { Invoke-ManagedUnkRefuse 'UNK_PARENT_BINDING' }
        $chainRes = Get-ManagedObserveUnknownParentChain -ParentRef (New-ManagedUnkRefDto @{ path = $ac.PredecessorReceipt.Path; sha256 = $ac.PredecessorReceipt.Sha256 }) -FailureRef (New-ManagedUnkRefDto @{ path = $ac.UnresolvedFailureReceipt.Path; sha256 = $ac.UnresolvedFailureReceipt.Sha256 }) -ControlRoot $ControlRoot -ExpectedSubtotal ([long]$ac.LastVerifiedSubtotal)
        if (($null -eq $chainRes) -or ($chainRes.Valid -isnot [bool])) { Invoke-ManagedUnkRefuse 'UNK_CHAIN_SHAPE' }
        if (-not $chainRes.Valid) {
            if (($null -ne $chainRes.PSObject.Properties['Status']) -and ($chainRes.Status -ceq 'UNKNOWN')) { Invoke-ManagedUnkUnknown (Get-ManagedUnkClean $chainRes.Reason 'PARENT_UNKNOWN') }
            Invoke-ManagedUnkRefuse (Get-ManagedUnkClean $chainRes.Code 'UNK_CHAIN_REFUSED')
        }
        # The next child's own session and run identities must be new across the whole authenticated lineage.
        $sid = Get-ManagedUnkMember $Ticket 'sessionId' 'UNK_TICKET_FIELD'
        if (($sid -isnot [string]) -or $chainRes.Registry.sessions.Contains($sid)) { Invoke-ManagedUnkRefuse 'UNK_DUPLICATE_SESSION' }
        if ((-not [string]::IsNullOrEmpty($RunId)) -and $chainRes.Registry.runs.Contains($RunId)) { Invoke-ManagedUnkRefuse 'UNK_DUPLICATE_IDENTITY' }
        $maxAttempts = Get-ManagedUnkMember $Ticket 'maxAttempts' 'UNK_MAXATTEMPTS'
        if ((($maxAttempts -isnot [int]) -and ($maxAttempts -isnot [long])) -or ([long]$maxAttempts -le 0)) { Invoke-ManagedUnkRefuse 'UNK_MAXATTEMPTS' }
        # Full-chain stability after the remaining checks, before the verdict escapes.
        Assert-ManagedUnkChainStable $chainRes.Retained $ControlRoot
        return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'UNKNOWN_PRELAUNCH'; Contract = $ct; Chain = $chainRes.Chain }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($m.StartsWith('UNKNOWN:', $ord) -and ($m.Length -le 56) -and ($m.Substring(8) -cmatch '^[A-Z0-9_]{1,48}$')) {
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_UNKNOWN_PRELAUNCH_UNKNOWN'; Result = 'NONRECEIPT'; Status = 'UNKNOWN'; Reason = $m.Substring(8); Contract = $null; Chain = $null }
        }
        $code = 'UNK_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', $ord) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Result = 'REFUSED'; Contract = $null; Chain = $null }
    }
}

function Test-ManagedObserveUnknownPendingReceiptV6Shape {
    # Pure structural check of a stored OperationalRunReceipt/v6 DTO (UNKNOWN-history pending only: raw shape, modes, null limits and null used count,
    # incomplete artifact, no completion fields). It derives nothing, authenticates nothing and confers no receipt validity or authority by itself.
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
        $ord = [System.StringComparison]::Ordinal
        $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
        $exact = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $ps = @($o.PSObject.Properties)
            if ($ps.Count -ne $names.Count) { return $false }
            foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { return $false } }
            return $true
        }
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $isStr = { param($v) ($v -is [string]) -and ($v.Length -gt 0) }

        if (-not (& $exact $obj @('schemaVersion', 'runId', 'taskId', 'payloadSha256', 'destination', 'status', 'attempt', 'sessionId', 'historyVerified', 'budget', 'provider', 'artifact', 'updatedAt', 'evidence', 'outputStopMode', 'observeUnknownContinuationEvidence', 'observeUnknownContinuationAccounting'))) { return $false }
        if (((& $val $obj 'schemaVersion') -isnot [string]) -or ((& $val $obj 'schemaVersion') -cne 'OperationalRunReceipt/v6')) { return $false }
        if (((& $val $obj 'status') -isnot [string]) -or ((& $val $obj 'status') -cne 'AWAITING_CONTROLLER')) { return $false }
        if (((& $val $obj 'outputStopMode') -isnot [string]) -or ((& $val $obj 'outputStopMode') -cne 'OBSERVE_ONLY')) { return $false }
        if (((& $val $obj 'destination') -isnot [string]) -or ((& $val $obj 'destination') -cne 'Anthropic Claude')) { return $false }
        $hv = & $val $obj 'historyVerified'
        if (($hv -isnot [bool]) -or $hv) { return $false }
        foreach ($n in @('runId', 'taskId', 'sessionId', 'updatedAt')) { if (-not (& $isStr (& $val $obj $n))) { return $false } }
        if (-not (& $isHex (& $val $obj 'payloadSha256'))) { return $false }
        $attempt = & $val $obj 'attempt'
        if ((-not (& $isInt $attempt)) -or ([long]$attempt -lt 1)) { return $false }

        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $a = & $val $obj 'artifact'
        $e = & $val $obj 'evidence'
        if (-not ((& $exact $b @('maxOutputTokens', 'maxElapsedMs', 'maxAttempts', 'usedElapsedMs', 'usedOutputTokens', 'attemptsUsed', 'softFraction')) -and (& $exact $p @('startIdentity', 'sessionId', 'terminalReason', 'pid')) -and (& $exact $a @('complete', 'sha256', 'path')) -and (& $exact $e @('rawPath', 'rawSha256', 'ticketPath', 'ticketSha256', 'usagePath', 'usageSha256', 'nativeThinkingTokens')))) { return $false }
        # No output ceiling or soft fraction exists in observe-only mode; nothing is clamped or carried as a finite number.
        if (($null -ne (& $val $b 'maxOutputTokens')) -or ($null -ne (& $val $b 'softFraction'))) { return $false }
        foreach ($n in @('maxAttempts', 'usedElapsedMs', 'attemptsUsed')) { if (-not (& $isInt (& $val $b $n))) { return $false } }
        # UNKNOWN history: the used count is an exact null, never a number and never 0.
        if ($null -ne (& $val $b 'usedOutputTokens')) { return $false }
        # maxElapsedMs: exact null = no total author deadline (compared to authenticated facts elsewhere); otherwise a positive typed integer.
        if (($null -ne (& $val $b 'maxElapsedMs')) -and (-not (& $isInt (& $val $b 'maxElapsedMs')))) { return $false }
        if ((($null -ne (& $val $b 'maxElapsedMs')) -and ([long](& $val $b 'maxElapsedMs') -le 0)) -or ([long](& $val $b 'maxAttempts') -le 0) -or ([long](& $val $b 'usedElapsedMs') -lt 0)) { return $false }
        if (([long](& $val $b 'attemptsUsed') -ne [long]$attempt) -or ([long]$attempt -gt [long](& $val $b 'maxAttempts')) -or (($null -ne (& $val $b 'maxElapsedMs')) -and ([long](& $val $b 'usedElapsedMs') -gt [long](& $val $b 'maxElapsedMs')))) { return $false }
        if ($null -ne (& $val $p 'startIdentity')) { return $false }
        if ((-not (& $isStr (& $val $p 'sessionId'))) -or ((& $val $p 'sessionId') -cne (& $val $obj 'sessionId')) -or (-not (& $isStr (& $val $p 'terminalReason')))) { return $false }
        if ((-not (& $isInt (& $val $p 'pid'))) -or ([long](& $val $p 'pid') -le 0)) { return $false }
        $ac = & $val $a 'complete'
        if (($ac -isnot [bool]) -or $ac -or ($null -ne (& $val $a 'sha256')) -or ($null -ne (& $val $a 'path'))) { return $false }
        foreach ($n in @('rawPath', 'ticketPath', 'usagePath')) { if (-not (& $isStr (& $val $e $n))) { return $false } }
        foreach ($n in @('rawSha256', 'ticketSha256', 'usageSha256')) { if (-not (& $isHex (& $val $e $n))) { return $false } }
        if ($null -ne (& $val $e 'nativeThinkingTokens')) { return $false }
        if (((& $val $obj 'observeUnknownContinuationEvidence') -isnot [System.Management.Automation.PSCustomObject]) -or ((& $val $obj 'observeUnknownContinuationAccounting') -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        return $true
    } catch { return $false }
}

function Compare-ManagedObserveUnknownPendingReceiptV6ToFacts {
    # STRUCTURAL ONLY: compares one stored v6 receipt DTO to facts the CALLER derived itself from raw authenticated captures.
    # It never reads evidence, never authenticates and confers no receipt validity, completion, ACK or dispatch authority; callers must
    # derive the facts internally and reauthenticate the raw DTO themselves. Shared by the v6 validator and the ancestry verifier.
    param($obj, $f)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        if (($null -eq $f) -or ($f -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
        $ord = [System.StringComparison]::Ordinal
        $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
        $exact = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $ps = @($o.PSObject.Properties)
            if ($ps.Count -ne $names.Count) { return $false }
            foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { return $false } }
            return $true
        }
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $isStr = { param($v) ($v -is [string]) -and ($v.Length -gt 0) }

        $attempt = & $val $obj 'attempt'
        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $e = & $val $obj 'evidence'
        $id = $f.identity; $lim = $f.limits; $acct = $f.accounting
        if (($f.anchorLabel -cne 'SELECTED_ACCOUNTING_ANCHOR') -or ($acct.anchorLabel -cne 'SELECTED_ACCOUNTING_ANCHOR')) { return $false }
        foreach ($pair in @(@('runId', 'runId'), @('taskId', 'taskId'), @('payloadSha256', 'payloadSha256'), @('sessionId', 'sessionId'))) {
            if ((& $val $obj $pair[0]) -cne [string]$id.($pair[1])) { return $false }
        }
        if (([long]$attempt -ne [long]$id.attempt) -or ([long](& $val $p 'pid') -ne [long]$id.pid) -or ((& $val $p 'terminalReason') -cne [string]$id.terminalReason)) { return $false }
        if ((& $val $obj 'updatedAt') -cne [string]$f.timing.endedUtc) { return $false }
        if ((($null -eq (& $val $b 'maxElapsedMs')) -ne ($null -eq $lim.maxElapsedMs)) -or (($null -ne $lim.maxElapsedMs) -and ([long](& $val $b 'maxElapsedMs') -ne [long]$lim.maxElapsedMs)) -or ([long](& $val $b 'maxAttempts') -ne [long]$lim.maxAttempts) -or ([long]$lim.priorElapsedMs -ne 0)) { return $false }
        if ([long](& $val $b 'usedElapsedMs') -ne [long]$f.timing.usedElapsedMs) { return $false }
        # UNKNOWN history: the receipt and the facts both keep every total null; only the labelled per-child count may be a number (inside the accounting DTO).
        if (($null -ne (& $val $b 'usedOutputTokens')) -or ($null -ne $acct.usedOutputTokens) -or ($null -ne $acct.cumulativeOutputTokens) -or ($null -ne $acct.currentOutputTokens) -or ($null -ne $acct.historicalOutputTokens) -or ($acct.accountingStatus -cne 'UNKNOWN') -or ($acct.accountingUnresolved -ne $true)) { return $false }
        if (([string](& $val $e 'ticketPath') -cne [string]$f.references.ticket.path) -or ((& $val $e 'ticketSha256') -cne [string]$f.references.ticket.verifiedSha256)) { return $false }
        if (([string](& $val $e 'usagePath') -cne [string]$f.stdout.path) -or ((& $val $e 'usageSha256') -cne [string]$f.stdout.sha256)) { return $false }
        if ((ConvertTo-Json -InputObject (& $val $obj 'observeUnknownContinuationAccounting') -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $acct -Depth 12 -Compress)) { return $false }
        if ((ConvertTo-Json -InputObject (& $val $obj 'observeUnknownContinuationEvidence') -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $f.evidence -Depth 12 -Compress)) { return $false }
        return $true
    } catch { return $false }
}

function Test-ManagedObserveUnknownFailedReceiptV7Shape {
    # Pure structural check of a stored OperationalRunReceipt/v7 DTO (UNKNOWN-history FAILED only, null counts, incomplete artifact). It derives nothing,
    # authenticates nothing and confers no receipt validity, settlement or dispatch authority by itself.
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
        $ord = [System.StringComparison]::Ordinal
        $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
        $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
        $exact = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $ps = @($o.PSObject.Properties)
            if ($ps.Count -ne $names.Count) { return $false }
            foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { return $false } }
            return $true
        }
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $isStr = { param($v) ($v -is [string]) -and ($v.Length -gt 0) }

        if (-not (& $exact $obj @('schemaVersion', 'runId', 'taskId', 'payloadSha256', 'destination', 'status', 'attempt', 'sessionId', 'historyVerified', 'budget', 'provider', 'artifact', 'updatedAt', 'evidence', 'outputStopMode', 'observeUnknownFailedEvidence', 'observeUnknownFailedAccounting', 'observeUnknownFailed'))) { return $false }
        if (((& $val $obj 'schemaVersion') -isnot [string]) -or ((& $val $obj 'schemaVersion') -cne 'OperationalRunReceipt/v7')) { return $false }
        if (((& $val $obj 'status') -isnot [string]) -or ((& $val $obj 'status') -cne 'FAILED')) { return $false }
        if (((& $val $obj 'outputStopMode') -isnot [string]) -or ((& $val $obj 'outputStopMode') -cne 'OBSERVE_ONLY')) { return $false }
        if (((& $val $obj 'destination') -isnot [string]) -or ((& $val $obj 'destination') -cne 'Anthropic Claude')) { return $false }
        $hv = & $val $obj 'historyVerified'
        if (($hv -isnot [bool]) -or $hv) { return $false }
        foreach ($n in @('runId', 'taskId', 'sessionId', 'updatedAt')) { if (-not (& $isStr (& $val $obj $n))) { return $false } }
        if (-not (& $isHex (& $val $obj 'payloadSha256'))) { return $false }
        $attempt = & $val $obj 'attempt'
        if ((-not (& $isInt $attempt)) -or ([long]$attempt -lt 1)) { return $false }

        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $a = & $val $obj 'artifact'
        $e = & $val $obj 'evidence'
        if (-not ((& $exact $b @('maxOutputTokens', 'maxElapsedMs', 'maxAttempts', 'usedElapsedMs', 'usedOutputTokens', 'attemptsUsed', 'softFraction')) -and (& $exact $p @('startIdentity', 'sessionId', 'terminalReason', 'pid')) -and (& $exact $a @('complete', 'sha256', 'path')) -and (& $exact $e @('rawPath', 'rawSha256', 'ticketPath', 'ticketSha256', 'usagePath', 'usageSha256', 'nativeThinkingTokens')))) { return $false }
        # Unknown stays null: no ceiling, no soft fraction and, unlike the pending/completed shapes, no used-output count at all (never 0).
        if (($null -ne (& $val $b 'maxOutputTokens')) -or ($null -ne (& $val $b 'softFraction')) -or ($null -ne (& $val $b 'usedOutputTokens'))) { return $false }
        foreach ($n in @('maxAttempts', 'usedElapsedMs', 'attemptsUsed')) { if (-not (& $isInt (& $val $b $n))) { return $false } }
        # maxElapsedMs: an exact null means NO TOTAL AUTHOR DURATION (never 0); otherwise a positive typed integer. A DEADLINE failure requires the finite value.
        if (($null -ne (& $val $b 'maxElapsedMs')) -and ((-not (& $isInt (& $val $b 'maxElapsedMs'))) -or ([long](& $val $b 'maxElapsedMs') -le 0))) { return $false }
        if (([long](& $val $b 'maxAttempts') -le 0) -or ([long](& $val $b 'usedElapsedMs') -lt 0)) { return $false }
        if (([long](& $val $b 'attemptsUsed') -ne [long]$attempt) -or ([long]$attempt -gt [long](& $val $b 'maxAttempts'))) { return $false }
        if (-not (& $isStr (& $val $p 'startIdentity'))) { return $false }
        if ((-not (& $isStr (& $val $p 'sessionId'))) -or ((& $val $p 'sessionId') -cne (& $val $obj 'sessionId')) -or ((& $val $p 'terminalReason') -isnot [string]) -or (((& $val $p 'terminalReason') -cne 'DEADLINE') -and ((& $val $p 'terminalReason') -cne 'NATURAL_EXIT')) -or (((& $val $p 'terminalReason') -ceq 'DEADLINE') -and ($null -eq (& $val $b 'maxElapsedMs')))) { return $false }
        if ((-not (& $isInt (& $val $p 'pid'))) -or ([long](& $val $p 'pid') -le 0)) { return $false }
        $ac = & $val $a 'complete'
        if (($ac -isnot [bool]) -or $ac -or ($null -ne (& $val $a 'sha256')) -or ($null -ne (& $val $a 'path'))) { return $false }
        foreach ($n in @('rawPath', 'ticketPath', 'usagePath')) { if (-not (& $isStr (& $val $e $n))) { return $false } }
        foreach ($n in @('rawSha256', 'ticketSha256', 'usageSha256')) { if (-not (& $isHex (& $val $e $n))) { return $false } }
        if ($null -ne (& $val $e 'nativeThinkingTokens')) { return $false }
        $ce = & $val $obj 'observeUnknownFailedEvidence'
        if (-not (& $exact $ce @('schema', 'current', 'predecessorReceipt', 'unresolvedFailureReceipt', 'humanDirectionRef', 'registrationRef', 'selectedClaimRef', 'acknowledgementsRef'))) { return $false }
        if (((& $val $ce 'schema') -isnot [string]) -or ((& $val $ce 'schema') -cne 'ManagedObserveUnknownFailedEvidence/v1')) { return $false }
        foreach ($n in @('predecessorReceipt', 'unresolvedFailureReceipt', 'humanDirectionRef', 'registrationRef', 'selectedClaimRef', 'acknowledgementsRef')) {
            $rf = & $val $ce $n
            if ((-not (& $exact $rf @('path', 'sha256'))) -or (-not (& $isStr (& $val $rf 'path'))) -or (-not (& $isHex (& $val $rf 'sha256')))) { return $false }
        }
        if (((& $val $ce 'current') -isnot [System.Management.Automation.PSCustomObject]) -or ((& $val $obj 'observeUnknownFailedAccounting') -isnot [System.Management.Automation.PSCustomObject]) -or ((& $val $obj 'observeUnknownFailed') -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        return $true
    } catch { return $false }
}

function Compare-ManagedObserveUnknownFailedReceiptV7ToFacts {
    # STRUCTURAL ONLY: compares one stored v7 receipt DTO to facts the CALLER derived itself from raw authenticated captures and records.
    # It never reads evidence, never authenticates and confers no receipt validity, settlement or dispatch authority; callers must derive the
    # facts internally (Get-ManagedObserveUnknownFailedFacts) and reauthenticate the raw DTO themselves.
    param($obj, $f)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        if (($null -eq $f) -or ($f -isnot [System.Management.Automation.PSCustomObject])) { return $false }
        $ord = [System.StringComparison]::Ordinal
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }; return , $null }
        $json = { param($o) ConvertTo-Json -InputObject $o -Depth 12 -Compress }
        $id = $f.identity; $lim = $f.limits; $acct = $f.accounting
        if (($f.anchorLabel -cne 'SELECTED_ACCOUNTING_ANCHOR') -or ($acct.anchorLabel -cne 'SELECTED_ACCOUNTING_ANCHOR')) { return $false }
        if (($acct.accountingStatus -cne 'UNKNOWN') -or ($acct.sdkOutcome -cne 'UNKNOWN') -or ($acct.accountingUnresolved -ne $true) -or ($null -ne $acct.currentOutputTokens) -or ($null -ne $acct.cumulativeOutputTokens) -or ($null -ne $acct.usedOutputTokens) -or ($null -ne $acct.historicalOutputTokens)) { return $false }
        $attempt = & $val $obj 'attempt'
        $b = & $val $obj 'budget'
        $p = & $val $obj 'provider'
        $e = & $val $obj 'evidence'
        foreach ($pair in @(@('runId', 'runId'), @('taskId', 'taskId'), @('payloadSha256', 'payloadSha256'), @('sessionId', 'sessionId'))) {
            if ((& $val $obj $pair[0]) -cne [string]$id.($pair[1])) { return $false }
        }
        if (([long]$attempt -ne [long]$id.attempt) -or ([long](& $val $p 'pid') -ne [long]$id.pid) -or ((& $val $p 'terminalReason') -cne [string]$id.terminalReason) -or ((& $val $p 'startIdentity') -cne [string]$id.startIdentity)) { return $false }
        if ((& $val $obj 'updatedAt') -cne [string]$f.timing.endedUtc) { return $false }
        if ((($null -eq (& $val $b 'maxElapsedMs')) -ne ($null -eq $lim.maxElapsedMs)) -or (($null -ne $lim.maxElapsedMs) -and ([long](& $val $b 'maxElapsedMs') -ne [long]$lim.maxElapsedMs)) -or ([long](& $val $b 'maxAttempts') -ne [long]$lim.maxAttempts) -or ([long]$lim.priorElapsedMs -ne 0)) { return $false }
        if ([long](& $val $b 'usedElapsedMs') -ne [long]$f.timing.usedElapsedMs) { return $false }
        if (([string](& $val $e 'ticketPath') -cne [string]$acct.references.ticket.path) -or ((& $val $e 'ticketSha256') -cne [string]$acct.references.ticket.verifiedSha256)) { return $false }
        if (([string](& $val $e 'usagePath') -cne [string]$f.stdout.path) -or ((& $val $e 'usageSha256') -cne [string]$f.stdout.sha256)) { return $false }
        if ((& $json (& $val $obj 'observeUnknownFailedAccounting')) -cne (& $json $acct)) { return $false }
        if ((& $json (& $val $obj 'observeUnknownFailedEvidence')) -cne (& $json $f.evidence)) { return $false }
        if ((& $json (& $val $obj 'observeUnknownFailed')) -cne (& $json $f.proof)) { return $false }
        return $true
    } catch { return $false }
}

function Get-ManagedObserveUnknownFailedFacts {
    # Read-only. Authenticates ONE failed OBSERVE_ONLY native transport (terminal DEADLINE with a finite deadline, or NATURAL_EXIT with a nonzero typed exit and no total
    # author duration) that follows UNKNOWN accounting history. Evidence-only: the caller supplies nothing but the evidence DTO. Everything is derived here from pinned
    # references: the current capture and binding, the parent ancestry back to the unresolved failed v5 root (Get-ManagedObserveUnknownContinuationFacts in its
    # failed-current mode), and the registration, selected claim, keyed ACK, request and raw bindings. The derivation runs twice and must agree, and every retained
    # ancestor pin, receipt, raw DTO and capture is rechecked after all other reads before any facts are returned. The facts preserve the actual failure and the last
    # VERIFIED fully known subtotal; the current, used and cumulative counts stay UNKNOWN (null, never zero) and no SDK success, completion, dispatch, retry or
    # successor authority is derived. This verifier authenticates referenced data only, never external human authority.
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Evidence)
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    try {
        $contEv = ConvertTo-ManagedUnkContinuationOfFailed $Evidence
        $derive = {
            $r = Get-ManagedObserveUnknownContinuationFacts -Evidence $contEv -FailedCurrent
            if ((@($r).Count -ne 1) -or ($r -isnot [System.Management.Automation.PSCustomObject])) { Invoke-ManagedUnkRefuse 'OBSUF_BASE_SHAPE' }
            $valid = Get-ManagedUnkMember $r 'Valid' 'OBSUF_BASE_SHAPE'
            if ($valid -isnot [bool]) { Invoke-ManagedUnkRefuse 'OBSUF_BASE_SHAPE' }
            if (-not $valid) {
                if (($null -ne $r.PSObject.Properties['Status']) -and ($r.Status -ceq 'UNKNOWN')) { Invoke-ManagedUnkUnknown (Get-ManagedUnkClean $r.Reason 'BASE_UNKNOWN') }
                Invoke-ManagedUnkRefuse (Get-ManagedUnkClean (Get-ManagedUnkMember $r 'Code' 'OBSUF_BASE_SHAPE') 'OBSUF_BASE_REFUSED')
            }
            $bs = Get-ManagedUnkMember $r 'Base' 'OBSUF_BASE_SHAPE'
            if (($bs -isnot [System.Management.Automation.PSCustomObject]) -or ($null -eq $r.ChainRetained) -or ($r.ChainControlRoot -isnot [string])) { Invoke-ManagedUnkRefuse 'OBSUF_BASE_SHAPE' }
            return , $r
        }
        $r1 = & $derive
        $facts1 = Get-ManagedUnkFailedAssembly -Evidence $Evidence -Base $r1.Base
        # Second independent derivation after the proof reads: the base and the assembled facts must be identical.
        $r2 = & $derive
        if ((ConvertTo-Json -InputObject $r2.Base -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $r1.Base -Depth 12 -Compress)) { Invoke-ManagedUnkRefuse 'OBSUF_STALE_BASE' }
        $facts2 = Get-ManagedUnkFailedAssembly -Evidence $Evidence -Base $r2.Base
        if ((ConvertTo-Json -InputObject $facts2 -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $facts1 -Depth 12 -Compress)) { Invoke-ManagedUnkRefuse 'OBSUF_STALE_PROOF' }
        # Full-chain stability AFTER all other reads: every retained ancestor pin, receipt, raw DTO and capture is rechecked before facts escape.
        Assert-ManagedUnkChainStable $r2.ChainRetained $r2.ChainControlRoot
        return [pscustomobject]@{ Valid = $true; Code = $null; Result = 'UNKNOWN_FAILED'; Facts = $facts1 }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($m.StartsWith('UNKNOWN:', $ord) -and ($m.Length -le 56) -and ($m.Substring(8) -cmatch '^[A-Z0-9_]{1,48}$')) {
            return [pscustomobject]@{ Valid = $false; Code = 'OBSERVE_UNKNOWN_FAILED_UNKNOWN'; Result = 'NONRECEIPT'; Status = 'UNKNOWN'; Reason = $m.Substring(8); Facts = $null }
        }
        $code = 'OBSUF_UNEXPECTED_ERROR'
        if ($m.StartsWith('REFUSE:', $ord) -and ($m.Length -le 55) -and ($m.Substring(7) -cmatch '^[A-Z0-9_]{1,48}$')) { $code = $m.Substring(7) }
        return [pscustomobject]@{ Valid = $false; Code = $code; Result = 'REFUSED'; Facts = $null }
    }
}

function Get-ManagedUnkFailedAssembly {
    # INTERNAL structural assembly of the failed (v7) facts for ONE node from an evidence DTO and a base that the parent-chain derivation built bottom-up from its own
    # already authenticated older nodes. It is NOT a verifier and NOT authority: it returns no Valid/Code wrapper, throws on any refusal, skips no check of the
    # registration, claim, ACK, request or raw bindings it performs, and performs no ancestry derivation and no final chain stability. Only the parent-chain routine
    # (which has authenticated the preceding nodes and owns the final retained-chain recheck) and the public Get-ManagedObserveUnknownFailedFacts (which derives the base
    # itself and owns its own rechecks) call it. No public success path accepts a supplied base.
    param([Parameter(Mandatory)][AllowNull()]$Evidence, [Parameter(Mandatory)]$Base)
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    $ordIc = [System.StringComparison]::OrdinalIgnoreCase
    $note = [System.Management.Automation.PSMemberTypes]::NoteProperty
    $fail = { param([string]$c) throw [System.InvalidOperationException]::new('REFUSE:' + $c) }
    $unknown = { param([string]$c) throw [System.InvalidOperationException]::new('UNKNOWN:' + $c) }
    $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
    $clean = { param($v, [string]$d) if (($v -is [string]) -and ($v -cmatch '^[A-Z0-9_]{1,48}\z')) { return $v }; return $d }
    $get = {
        param($o, [string]$n, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        foreach ($q in $o.PSObject.Properties) { if (($q.MemberType -eq $note) -and [string]::Equals($q.Name, $n, $ord)) { return , $q.Value } }
        & $fail $c
    }
    $exact = {
        param($o, [string[]]$names, [string]$c)
        if ($o -isnot [System.Management.Automation.PSCustomObject]) { & $fail $c }
        $ps = @($o.PSObject.Properties)
        if ($ps.Count -ne $names.Count) { & $fail $c }
        foreach ($q in $ps) { if (($q.MemberType -ne $note) -or ($names -cnotcontains [string]$q.Name)) { & $fail $c } }
    }
    $same = { param($a, $b) ($a -is [string]) -and ($b -is [string]) -and [string]::Equals($a, $b, $ord) }
    $samePath = {
        param($a, $b)
        if (($a -isnot [string]) -or ($b -isnot [string]) -or ($a.Length -eq 0) -or ($b.Length -eq 0)) { return $false }
        return [string]::Equals([System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($a)), [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($b)), $ordIc)
    }
    $json = { param($o) ConvertTo-Json -InputObject $o -Depth 12 -Compress }
    $shaText = { param([string]$t) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.UTF8Encoding]::new($false).GetBytes($t))).ToLowerInvariant() }
    $str = { param($o, [string]$n, [string]$c) $v = & $get $o $n $c; if (($v -isnot [string]) -or ($v.Length -eq 0) -or ([string]::IsNullOrWhiteSpace($v))) { & $fail $c }; return $v }
    $posInt = { param($v, [string]$c) if ((($v -isnot [int]) -and ($v -isnot [long])) -or ([long]$v -le 0)) { & $fail $c }; return [long]$v }
    $refOf = {
        param($r)
        & $exact $r @('path', 'sha256') 'OBSUF_REF_SHAPE'
        $p = & $get $r 'path' 'OBSUF_REF_SHAPE'
        $s = & $get $r 'sha256' 'OBSUF_REF_PIN'
        if (($p -isnot [string]) -or ($p.Length -eq 0) -or ($p.IndexOf([char]0) -ge 0) -or (-not [System.IO.Path]::IsPathFullyQualified($p)) -or (-not [string]::Equals([System.IO.Path]::GetFullPath($p), $p, $ord))) { & $fail 'OBSUF_REF_PATH' }
        if (-not (& $isHex $s)) { & $fail 'OBSUF_REF_PIN' }
        return @{ path = [string]$p; sha256 = [string]$s }
    }
    $refDto = { param($r) [pscustomobject]([ordered]@{ path = [string]$r.path; sha256 = [string]$r.sha256 }) }

    if ($true) {
        & $exact $Evidence @('schema', 'current', 'predecessorReceipt', 'unresolvedFailureReceipt', 'humanDirectionRef', 'registrationRef', 'selectedClaimRef', 'acknowledgementsRef') 'OBSUF_EVIDENCE_SHAPE'
        $evSchema = & $get $Evidence 'schema' 'OBSUF_EVIDENCE_SHAPE'
        if (($evSchema -isnot [string]) -or ($evSchema -cne 'ManagedObserveUnknownFailedEvidence/v1')) { & $fail 'OBSUF_EVIDENCE_SCHEMA' }
        $curDto = & $get $Evidence 'current' 'OBSUF_EVIDENCE_SHAPE'
        $preDto = & $get $Evidence 'predecessorReceipt' 'OBSUF_EVIDENCE_SHAPE'
        $preRef = & $refOf $preDto
        $failDto = & $get $Evidence 'unresolvedFailureReceipt' 'OBSUF_EVIDENCE_SHAPE'
        $failRef = & $refOf $failDto
        $dirDto = & $get $Evidence 'humanDirectionRef' 'OBSUF_EVIDENCE_SHAPE'
        $dirRef = & $refOf $dirDto
        $regRef = & $refOf (& $get $Evidence 'registrationRef' 'OBSUF_EVIDENCE_SHAPE')
        $claimRef = & $refOf (& $get $Evidence 'selectedClaimRef' 'OBSUF_EVIDENCE_SHAPE')
        $ackRef = & $refOf (& $get $Evidence 'acknowledgementsRef' 'OBSUF_EVIDENCE_SHAPE')
        # Four distinct records: the same path can never stand in for another role.
        $roleRefs = @($preRef, $regRef, $claimRef, $ackRef)
        for ($i = 0; $i -lt $roleRefs.Count; $i++) {
            for ($j = $i + 1; $j -lt $roleRefs.Count; $j++) {
                if ([string]::Equals([string]$roleRefs[$i].path, [string]$roleRefs[$j].path, $ordIc)) { & $fail 'OBSUF_REF_DUPLICATE' }
            }
        }
        $contEv = [pscustomobject]([ordered]@{ schema = 'ManagedObserveUnknownContinuationEvidence/v1'; current = $curDto; predecessorReceipt = $preDto; unresolvedFailureReceipt = $failDto; humanDirectionRef = $dirDto })

        # ---- trusted sibling declarations only; nothing is loaded from the captured workingDirectory ----
        try {
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
            . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'host-continuation') 'registered-review-record-reader.ps1')
            . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'host-continuation') 'registered-review-prelaunch-capture.ps1')
        } catch { & $fail 'OBSUF_SIBLING_UNAVAILABLE' }

        # Parent chain + failed current capture: the shared UNKNOWN-continuation derivation in its failed-current mode.
        $baseOf = { return , $Base }

        $claimNames = @('id', 'owner', 'claimId', 'intentId', 'receiptSha', 'planSha', 'statePath')
        $reqNames = @('RunId', 'Attempt', 'TicketPath', 'PayloadPath', 'GateTicketPath', 'SettingsPath', 'ArtifactPath', 'WorkingDirectory', 'Arguments', 'MaxElapsedMs', 'MaxStreamBytes', 'OutputStopProfile')
        $noHandler = { throw 'OBSUF_HANDLER_NOT_AUTHORITY' }

        # Registration, selected claim and keyed ACK bound to the authenticated base. Run twice (before and after the second base) and compared.
        $bindAll = {
            param($bs)
            $cap = & $get $bs 'Capture' 'OBSUF_BASE_SHAPE'
            $bnd = & $get $bs 'Bound' 'OBSUF_BASE_SHAPE'
            $par = & $get $bs 'ParentReceipt' 'OBSUF_BASE_SHAPE'
            $core = & $get $cap 'Core' 'OBSUF_BASE_SHAPE'
            $term = & $get $cap 'Terminal' 'OBSUF_BASE_SHAPE'
            $wd = & $str $core 'workingDirectory' 'OBSUF_BASE_SHAPE'
            $controlRoot = [System.IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')
            $readCtl = {
                param($rf)
                $x = $null
                try { $x = Read-ManagedPinnedEvidenceJson -Reference ([pscustomobject]@{ path = $rf.path; sha256 = $rf.sha256 }) -ControlRoot $controlRoot } catch { $x = $null }
                if (($null -eq $x) -or ($x.Sha256 -cne $rf.sha256) -or ($x.Path -cne $rf.path) -or ($x.Value -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSUF_REF_UNREADABLE' }
                return , $x
            }
            if (-not ((& $get $term 'onStartedAcknowledged' 'OBSUF_TERMINAL') -is [bool])) { & $fail 'OBSUF_TERMINAL' }
            if ((& $get $term 'onStartedAcknowledged' 'OBSUF_TERMINAL') -ne $true) { & $fail 'OBSUF_START_NOT_ACKNOWLEDGED' }
            $ackMode = & $get $core 'ackMode' 'OBSUF_CORE_ACK'
            if (($ackMode -isnot [bool]) -or (-not $ackMode)) { & $fail 'OBSUF_CORE_ACK' }

            # ---- registration: pinned control record naming the same captured request, ticket, payload, run directory and run ----
            $regX = & $readCtl $regRef
            $pre = $null
            try { $pre = Get-RegisteredReviewPrelaunchCapture -Registration $regX.Value -ExpectedRegistrationSha256 $regRef.sha256 -OnReviewedTerminal $noHandler } catch { $pre = $null }
            if (($null -eq $pre) -or ($pre.registration -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSUF_REGISTRATION' }
            $reg = $pre.registration
            if (-not (& $same ([string]$reg.taskId) ([string]$cap.RunId))) { & $fail 'OBSUF_REG_IDENTITY' }
            if ([long]$reg.attempt -ne [long]$cap.Attempt) { & $fail 'OBSUF_REG_IDENTITY' }
            if (-not ((& $samePath ([string]$reg.ticketPath) ([string]$cap.TicketPath)) -and (& $same ([string]$reg.ticketSha256) ([string]$cap.TicketSha256)))) { & $fail 'OBSUF_REG_TICKET' }
            if (-not ((& $same ([string]$reg.payloadSha256) ([string]$bnd.payloadSha256)) -and (& $samePath ([string]$reg.payloadPath) ([string](& $get $core 'payloadPath' 'OBSUF_BASE_SHAPE'))))) { & $fail 'OBSUF_REG_PAYLOAD' }
            if (-not (& $samePath ([string]$reg.candidatePath) ([string]$cap.ArtifactPath))) { & $fail 'OBSUF_REG_ARTIFACT' }
            if (-not (& $samePath ([string]$reg.runDir) ([string]$cap.RunDir))) { & $fail 'OBSUF_REG_RUNDIR' }
            if ([string]::IsNullOrWhiteSpace([string]$reg.registeredActionId)) { & $fail 'OBSUF_REG_ACTION' }

            # ---- raw request file named by the registration (raw-file SHA stays distinct from the canonical request SHA) ----
            $reqRead = $null
            try { $reqRead = Read-RegisteredReviewRecord -Path ([string]$reg.requestPath) -ExpectedSha256 ([string]$reg.requestSha256) } catch { $reqRead = $null }
            if ($null -eq $reqRead) { & $fail 'OBSUF_REQUEST_UNREADABLE' }
            $rq = $reqRead.record
            & $exact $rq $reqNames 'OBSUF_REQUEST_SHAPE'
            if (-not (& $same ([string](& $get $rq 'RunId' 'OBSUF_REQUEST_SHAPE')) ([string]$reg.taskId))) { & $fail 'OBSUF_REQUEST_BINDING' }
            if ((& $posInt (& $get $rq 'Attempt' 'OBSUF_REQUEST_SHAPE') 'OBSUF_REQUEST_BINDING') -ne [long]$reg.attempt) { & $fail 'OBSUF_REQUEST_BINDING' }
            if (-not ((& $same ([string](& $get $rq 'TicketPath' 'OBSUF_REQUEST_SHAPE')) ([string]$reg.ticketPath)) -and (& $same ([string](& $get $rq 'PayloadPath' 'OBSUF_REQUEST_SHAPE')) ([string]$reg.payloadPath)) -and (& $same ([string](& $get $rq 'ArtifactPath' 'OBSUF_REQUEST_SHAPE')) ([string]$reg.candidatePath)))) { & $fail 'OBSUF_REQUEST_BINDING' }
            if (-not ((& $samePath ([string](& $get $rq 'GateTicketPath' 'OBSUF_REQUEST_SHAPE')) ([string](& $get $core 'gateTicketPath' 'OBSUF_BASE_SHAPE'))) -and (& $samePath ([string](& $get $rq 'SettingsPath' 'OBSUF_REQUEST_SHAPE')) ([string](& $get $core 'settingsPath' 'OBSUF_BASE_SHAPE'))) -and (& $samePath ([string](& $get $rq 'WorkingDirectory' 'OBSUF_REQUEST_SHAPE')) $wd))) { & $fail 'OBSUF_REQUEST_BINDING' }
            $rqElapsed = & $get $rq 'MaxElapsedMs' 'OBSUF_REQUEST_SHAPE'
            # A null author duration stays null: the registered request must carry the same exact null (never 0) when the authenticated capture has none.
            if ($null -eq $bnd.maxElapsedMs) { if ($null -ne $rqElapsed) { & $fail 'OBSUF_REQUEST_BINDING' } }
            elseif ((($rqElapsed -isnot [int]) -and ($rqElapsed -isnot [long])) -or ([long]$rqElapsed -ne [long]$bnd.maxElapsedMs)) { & $fail 'OBSUF_REQUEST_BINDING' }
            if (($null -ne (& $get $rq 'MaxStreamBytes' 'OBSUF_REQUEST_SHAPE')) -or (-not (& $same ([string](& $get $rq 'OutputStopProfile' 'OBSUF_REQUEST_SHAPE')) 'observe-only-v1'))) { & $fail 'OBSUF_REQUEST_PROFILE' }
            $rqArgs = & $get $rq 'Arguments' 'OBSUF_REQUEST_SHAPE'
            $coreArgs = & $get $core 'arguments' 'OBSUF_BASE_SHAPE'
            if (($rqArgs -isnot [object[]]) -or ($coreArgs -isnot [object[]]) -or ($rqArgs.Length -ne $coreArgs.Length)) { & $fail 'OBSUF_REQUEST_BINDING' }
            for ($ai = 0; $ai -lt $rqArgs.Length; $ai++) { if (-not (& $same ([string]$rqArgs[$ai]) ([string]$coreArgs[$ai]))) { & $fail 'OBSUF_REQUEST_BINDING' } }

            # ---- selected claim: pinned immutable selection evidence equal to the claim the ACTUAL captured core launched under ----
            $ackCtx = & $get $core 'ackContext' 'OBSUF_CORE_ACK'
            & $exact $ackCtx @('stateDir', 'taskId', 'claim') 'OBSUF_CORE_ACK'
            $coreClaim = & $get $ackCtx 'claim' 'OBSUF_CORE_ACK'
            & $exact $coreClaim $claimNames 'OBSUF_CORE_ACK'
            $claimX = & $readCtl $claimRef
            $selClaim = $claimX.Value
            # The selected record is the exact-10 registered selection (identity seven + kind/provider/route); the captured core carries only the exact-7.
            # The seven identity fields are compared; kind/provider/route are typed and retained as metadata, never used as authority.
            & $exact $selClaim ($claimNames + @('kind', 'provider', 'route')) 'OBSUF_CLAIM_SHAPE'
            $claimOut = [ordered]@{}
            foreach ($n in $claimNames) {
                $cv = & $str $selClaim $n 'OBSUF_CLAIM_SHAPE'
                if (-not (& $same $cv ([string](& $get $coreClaim $n 'OBSUF_CORE_ACK')))) { & $fail 'OBSUF_CLAIM_BINDING' }
                if ((($n -ceq 'receiptSha') -or ($n -ceq 'planSha')) -and (-not (& $isHex $cv))) { & $fail 'OBSUF_CLAIM_SHAPE' }
                $claimOut[$n] = $cv
            }
            $selMeta = [pscustomobject]([ordered]@{ kind = (& $str $selClaim 'kind' 'OBSUF_CLAIM_SHAPE'); provider = (& $str $selClaim 'provider' 'OBSUF_CLAIM_SHAPE'); route = (& $str $selClaim 'route' 'OBSUF_CLAIM_SHAPE') })
            $claim = [pscustomobject]$claimOut
            $stateDir = & $str $ackCtx 'stateDir' 'OBSUF_CORE_ACK'
            $ctxTaskId = & $str $ackCtx 'taskId' 'OBSUF_CORE_ACK'
            if (-not (& $same $ctxTaskId ([string]$bnd.taskId))) { & $fail 'OBSUF_CLAIM_BINDING' }
            if (-not (& $samePath $claim.statePath ([System.IO.Path]::Combine($stateDir, 'continuation-state.json')))) { & $fail 'OBSUF_CLAIM_STATE' }
            # Parent hash, parent run/attempt and original action are all inside the claim's intent key.
            if (-not (& $same $claim.receiptSha ([string]$par.sha256))) { & $fail 'OBSUF_CLAIM_PARENT' }
            # The ORIGINAL action is the claim/task action (claim.id == task); the registered review action is a different, separately retained identity.
            if (-not (& $same $claim.id $ctxTaskId)) { & $fail 'OBSUF_CLAIM_ACTION' }
            $wantIntent = $claim.receiptSha + '|' + [string]$par.runId + '|' + [string]$par.attempt + '|' + $claim.id
            if (-not (& $same $claim.intentId $wantIntent)) { & $fail 'OBSUF_CLAIM_INTENT' }

            # ---- keyed start ACK snapshot: exact envelope, exactly one keyed entry, native binding equal to the actual started process ----
            $ackX = & $readCtl $ackRef
            $ackRoot = $ackX.Value
            & $exact $ackRoot @('schema', 'acknowledgements') 'OBSUF_ACK_SHAPE'
            if (-not (& $same ([string](& $get $ackRoot 'schema' 'OBSUF_ACK_SHAPE')) 'host-dispatch-acknowledgement/v1')) { & $fail 'OBSUF_ACK_SHAPE' }
            $acks = & $get $ackRoot 'acknowledgements' 'OBSUF_ACK_SHAPE'
            if ($acks -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSUF_ACK_SHAPE' }
            $ackKey = $claim.intentId + '|' + $claim.claimId
            $found = [System.Collections.Generic.List[object]]::new()
            foreach ($ap in @($acks.PSObject.Properties)) { if ([string]::Equals([string]$ap.Name, $ackKey, $ord)) { $found.Add($ap.Value) } }
            if ($found.Count -ne 1) { & $fail 'OBSUF_ACK_ENTRY' }
            $entry = $found[0]
            & $exact $entry @('schema', 'recordedAt', 'entryId', 'owner', 'claimId', 'intentId', 'dispatchedAt', 'executionBinding') 'OBSUF_ACK_SHAPE'
            if (-not (& $same ([string](& $get $entry 'schema' 'OBSUF_ACK_SHAPE')) 'host-dispatch-acknowledgement/v1')) { & $fail 'OBSUF_ACK_SHAPE' }
            $parsedAt = [datetime]::MinValue
            foreach ($tf in @('recordedAt', 'dispatchedAt')) {
                $tv = & $str $entry $tf 'OBSUF_ACK_SHAPE'
                if (-not [datetime]::TryParse($tv, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedAt)) { & $fail 'OBSUF_ACK_SHAPE' }
            }
            if (-not (& $same ([string](& $get $entry 'dispatchedAt' 'OBSUF_ACK_SHAPE')) ([string]$bnd.startUtc))) { & $fail 'OBSUF_ACK_START' }
            if (-not ((& $same ([string](& $get $entry 'entryId' 'OBSUF_ACK_SHAPE')) $claim.id) -and (& $same ([string](& $get $entry 'owner' 'OBSUF_ACK_SHAPE')) $claim.owner) -and (& $same ([string](& $get $entry 'claimId' 'OBSUF_ACK_SHAPE')) $claim.claimId) -and (& $same ([string](& $get $entry 'intentId' 'OBSUF_ACK_SHAPE')) $claim.intentId))) { & $fail 'OBSUF_ACK_CLAIM' }
            $eb = & $get $entry 'executionBinding' 'OBSUF_ACK_SHAPE'
            & $exact $eb @('schema', 'taskId', 'ticketSha256', 'payloadSha256', 'runId', 'attempt', 'receiptSha', 'planSha', 'identity') 'OBSUF_ACK_BINDING'
            if (-not (& $same ([string](& $get $eb 'schema' 'OBSUF_ACK_BINDING')) 'host-dispatch-execution-binding/v1')) { & $fail 'OBSUF_ACK_BINDING' }
            if (-not ((& $same ([string](& $get $eb 'taskId' 'OBSUF_ACK_BINDING')) ([string]$bnd.taskId)) -and (& $same ([string](& $get $eb 'ticketSha256' 'OBSUF_ACK_BINDING')) ([string]$cap.TicketSha256)) -and (& $same ([string](& $get $eb 'payloadSha256' 'OBSUF_ACK_BINDING')) ([string]$bnd.payloadSha256)) -and (& $same ([string](& $get $eb 'runId' 'OBSUF_ACK_BINDING')) ([string]$cap.RunId)) -and (& $same ([string](& $get $eb 'receiptSha' 'OBSUF_ACK_BINDING')) $claim.receiptSha) -and (& $same ([string](& $get $eb 'planSha' 'OBSUF_ACK_BINDING')) $claim.planSha))) { & $fail 'OBSUF_ACK_BINDING' }
            if ((& $posInt (& $get $eb 'attempt' 'OBSUF_ACK_BINDING') 'OBSUF_ACK_BINDING') -ne [long]$cap.Attempt) { & $fail 'OBSUF_ACK_BINDING' }
            $ident = & $get $eb 'identity' 'OBSUF_ACK_BINDING'
            & $exact $ident @('kind', 'pid', 'startIdentity') 'OBSUF_ACK_IDENTITY'
            if (-not (& $same ([string](& $get $ident 'kind' 'OBSUF_ACK_IDENTITY')) 'native')) { & $fail 'OBSUF_ACK_IDENTITY' }
            if ((& $posInt (& $get $ident 'pid' 'OBSUF_ACK_IDENTITY') 'OBSUF_ACK_IDENTITY') -ne [long]$bnd.pid) { & $fail 'OBSUF_ACK_IDENTITY' }
            if (-not (& $same ([string](& $get $ident 'startIdentity' 'OBSUF_ACK_IDENTITY')) ([string]$bnd.startUtc))) { & $fail 'OBSUF_ACK_IDENTITY' }

            return [pscustomobject]([ordered]@{
                schema = 'ManagedObserveUnknownFailedProof/v1'
                registrationRef = (& $refDto $regRef)
                selectedClaimRef = (& $refDto $claimRef)
                acknowledgementsRef = (& $refDto $ackRef)
                registrationId = [string]$reg.registrationId
                registeredActionId = [string]$reg.registeredActionId
                claim = $claim
                selectedClaimMetadata = $selMeta
                originalActionId = [string]$claim.id
                stateDir = $stateDir
                taskId = [string]$bnd.taskId
                runId = [string]$cap.RunId
                attempt = [long]$cap.Attempt
                pid = [long]$bnd.pid
                startIdentity = [string]$bnd.startUtc
                requestRawSha256 = [string]$reg.requestSha256
                requestSha256 = [string]$cap.RequestSha256
                ticketSha256 = [string]$cap.TicketSha256
                payloadSha256 = [string]$bnd.payloadSha256
                manifestSha256 = [string]$cap.ManifestSha256
                startSha256 = [string]$cap.StartSha256
                terminalSha256 = [string]$cap.TerminalSha256
                parentReceiptSha256 = [string]$par.sha256
                parentRunId = [string]$par.runId
                parentAttempt = [long]$par.attempt
                ackKey = $ackKey
                ackEntrySha256 = (& $shaText (ConvertTo-Json -InputObject $entry -Depth 20 -Compress))
                ackMode = $true
                onStartedAcknowledged = $true
                requestPath = [string]$reg.requestPath
                noDispatch = $true; noRetry = $true
            })
        }

        $base1 = & $baseOf
        $proof1 = & $bindAll $base1
        if ($base1 -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSUF_BASE_SHAPE' }
        $cap = $base1.Capture
        $bnd = $base1.Bound
        $par = $base1.ParentReceipt
        $chainBase = $base1.Chain
        $anchor = $chainBase.Failure.anchor
        $term = $cap.Terminal
        $sfv = $cap.StopFacts
        $refRole = {
            param([string]$role)
            $d = @(@($cap.DeclaredReferences) | Where-Object { $_.Role -ceq $role })
            $v = @(@($cap.VerifiedReferences) | Where-Object { $_.Role -ceq $role })
            if (($d.Count -ne 1) -or ($v.Count -ne 1)) { & $fail 'OBSUF_REFERENCE' }
            return [pscustomobject]([ordered]@{ path = [string]$v[0].Path; declaredSha256 = [string]$d[0].DeclaredSha256; declaredLength = [long]$d[0].DeclaredLength; verifiedSha256 = [string]$v[0].VerifiedSha256; verifiedLength = [long]$v[0].VerifiedLength })
        }
        $stdoutRef = & $refRole 'STDOUT'
        $stderrRef = & $refRole 'STDERR'
        $stopOut = [pscustomobject]([ordered]@{
            pid = [long](& $get $sfv 'pid' 'OBSUF_STOPFACTS')
            startTimeUtc = [string](& $get $sfv 'startTimeUtc' 'OBSUF_STOPFACTS')
            deadlineObservedUtc = $(if ($null -eq (& $get $sfv 'deadlineObservedUtc' 'OBSUF_STOPFACTS')) { $null } else { [string](& $get $sfv 'deadlineObservedUtc' 'OBSUF_STOPFACTS') })
            elapsedMs = $(if ($null -eq (& $get $sfv 'elapsedMs' 'OBSUF_STOPFACTS')) { $null } else { [long](& $get $sfv 'elapsedMs' 'OBSUF_STOPFACTS') })
            alive = $(if ($null -eq (& $get $sfv 'alive' 'OBSUF_STOPFACTS')) { $null } else { [bool](& $get $sfv 'alive' 'OBSUF_STOPFACTS') })
            aliveAtStop = $(if ($null -eq (& $get $sfv 'aliveAtStop' 'OBSUF_STOPFACTS')) { $null } else { [bool](& $get $sfv 'aliveAtStop' 'OBSUF_STOPFACTS') })
            killAttempted = [bool](& $get $sfv 'killAttempted' 'OBSUF_STOPFACTS')
            killErrorCode = $(if ($null -eq (& $get $sfv 'killErrorCode' 'OBSUF_STOPFACTS')) { $null } else { [string](& $get $sfv 'killErrorCode' 'OBSUF_STOPFACTS') })
        })
        $failure = [pscustomobject]([ordered]@{
            reason = [string]$bnd.terminalReason
            exitCode = [long]$bnd.exitCode
            definitive = $true; exitObserved = $true; drainComplete = $true; stdinError = $false
            onStartedAcknowledged = $true
            errorCode = $null
            stopFacts = $stopOut
        })
        $identity = [pscustomobject]([ordered]@{ taskId = [string]$bnd.taskId; payloadSha256 = [string]$bnd.payloadSha256; runId = [string]$cap.RunId; attempt = [long]$cap.Attempt; sessionId = [string]$bnd.sessionId; pid = [long]$bnd.pid; terminalReason = [string]$bnd.terminalReason; exitCode = [long]$bnd.exitCode; startIdentity = [string]$bnd.startUtc })
        $references = [pscustomobject]([ordered]@{
            manifest = [pscustomobject]([ordered]@{ path = [string]$cap.ManifestPath; expectedSha256 = [string]$cap.ManifestSha256; verifiedSha256 = [string]$cap.ManifestSha256 })
            terminal = [pscustomobject]([ordered]@{ path = [string]$cap.TerminalPath; expectedSha256 = [string]$cap.TerminalSha256; verifiedSha256 = [string]$cap.TerminalSha256 })
            start = [pscustomobject]([ordered]@{ path = [string]$cap.StartPath; verifiedSha256 = [string]$cap.StartSha256 })
            ticket = [pscustomobject]([ordered]@{ path = [string]$cap.TicketPath; expectedSha256 = [string]$bnd.ticketSha256; verifiedSha256 = [string]$cap.TicketSha256 })
            predecessorReceipt = [pscustomobject]([ordered]@{ path = [string]$preRef.path; expectedSha256 = [string]$preRef.sha256; verifiedSha256 = [string]$par.sha256 })
            unresolvedFailureReceipt = [pscustomobject]([ordered]@{ path = [string]$failRef.path; expectedSha256 = [string]$failRef.sha256; verifiedSha256 = [string]$chainBase.Failure.receipt.sha256 })
            humanDirection = [pscustomobject]([ordered]@{ path = [string]$dirRef.path; expectedSha256 = [string]$dirRef.sha256; verifiedSha256 = [string]$chainBase.HumanDirectionRef.sha256 })
            stdout = $stdoutRef
            stderr = $stderrRef
            artifactState = [string]$cap.ArtifactState
        })
        $accounting = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveUnknownFailedAccounting/v1'
            disposition = 'AUTHENTICATED_FAILED_TERMINAL'
            anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
            anchor = $anchor
            parent = [pscustomobject]([ordered]@{ receiptPath = [string]$par.path; receiptSha256 = [string]$par.sha256; schemaVersion = [string]$par.schemaVersion; runId = [string]$par.runId; attempt = [long]$par.attempt })
            lastVerifiedSubtotal = [long]$base1.LastVerifiedSubtotal
            unresolvedFailure = $chainBase.Failure
            humanDirectionRef = $chainBase.HumanDirectionRef
            chain = @($chainBase.Nodes)
            historicalOutputTokens = $null
            currentOutputTokens = $null
            usedOutputTokens = $null
            cumulativeOutputTokens = $null
            accountingStatus = 'UNKNOWN'
            sdkOutcome = 'UNKNOWN'
            accountingUnresolved = $true
            requestSha256 = [string]$bnd.requestSha256
            startUtc = [string]$bnd.startUtc
            endedUtc = [string]$bnd.endUtc
            identity = $identity
            failure = $failure
            references = $references
            noAcceptedUsage = $true; noCompletion = $true; noDispatch = $true; noRetry = $true
        })
        $normEvidence = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveUnknownFailedEvidence/v1'
            current = $base1.Selection.current
            predecessorReceipt = $base1.Selection.predecessorReceipt
            unresolvedFailureReceipt = $base1.Selection.unresolvedFailureReceipt
            humanDirectionRef = $base1.Selection.humanDirectionRef
            registrationRef = (& $refDto $regRef)
            selectedClaimRef = (& $refDto $claimRef)
            acknowledgementsRef = (& $refDto $ackRef)
        })
        $paths = [System.Collections.Generic.List[string]]::new()
        foreach ($ip in @($base1.InPaths)) { $paths.Add([string]$ip) }
        foreach ($ip in @($regRef.path, $claimRef.path, $ackRef.path, [string]$proof1.requestPath)) { $paths.Add([string]$ip) }
        $facts = [pscustomobject]([ordered]@{
            schema = 'ManagedObserveUnknownFailedFacts/v1'
            evidence = $normEvidence
            anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
            identity = $identity
            limits = [pscustomobject]([ordered]@{ maxElapsedMs = $(if ($null -eq $bnd.maxElapsedMs) { $null } else { [long]$bnd.maxElapsedMs }); maxAttempts = [long]$bnd.maxAttempts; priorElapsedMs = 0L; maxOutputTokens = $null; softFraction = $null })
            timing = [pscustomobject]([ordered]@{ startUtc = [string]$bnd.startUtc; endedUtc = [string]$bnd.endUtc; usedElapsedMs = [long]$bnd.usedElapsedMs })
            accounting = $accounting
            proof = $proof1
            stdout = [pscustomobject]([ordered]@{ path = [string]$stdoutRef.path; sha256 = [string]$stdoutRef.verifiedSha256; length = [long]$stdoutRef.verifiedLength })
            inputPaths = @($paths.ToArray())
            noCompletion = $true; noDispatch = $true; noRetry = $true
        })
        return $facts
    }
}
