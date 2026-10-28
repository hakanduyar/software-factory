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
        [switch]$ForOutputObservation
    )
    Set-StrictMode -Version Latest
    $ticketIssues = @()
    $obs = $ForOutputObservation.IsPresent
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
        $maxElapsed = & $lng $core 'maxElapsedMs'
        if ($maxElapsed -le 0) { & $fail 'MAXELAPSED_INVALID' }
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
        $wantReason = if ($FailureKind -ceq 'TOKEN_ACCOUNTING_STOP') { 'TOKEN_ACCOUNTING_STOP' } else { 'NATURAL_EXIT' }
        if ((& $str $term 'reason') -cne $wantReason) { & $fail 'TERMINAL_REASON' }
        if ($null -ne (& $prop $term 'errorCode')) { & $fail 'TERMINAL_ERRORCODE' }
        if ((& $bool $term 'definitive') -ne $true) { & $fail 'TERMINAL_NOT_DEFINITIVE' }
        if ((& $bool $term 'exitObserved') -ne $true) { & $fail 'TERMINAL_EXIT_NOT_OBSERVED' }
        if ((& $bool $term 'drainComplete') -ne $true) { & $fail 'TERMINAL_DRAIN_INCOMPLETE' }
        if ((& $bool $term 'stdinError') -ne $false) { & $fail 'TERMINAL_STDIN_ERROR' }
        $termExit = & $lng $term 'exitCode'
        if ($ForFailedAccounting) { if ($termExit -eq 0) { & $fail 'TERMINAL_EXITCODE' } }
        elseif ($termExit -ne 0) { & $fail 'TERMINAL_EXITCODE' }
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
                SDKOutcome = 'PENDING'
                ObservedOutputTokens = $null
                Inputs = $inv.ToArray()
                StreamedInputs = $invStream.ToArray()
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
    # Read-only. Derives pending accounting for one OBSERVE_ONLY managed run joined to one selected legacy advisory receipt anchor.
    # SELECTED_ACCOUNTING_ANCHOR: the trusted host selects the anchor in its outer packet; the actual current ticket carries no predecessor
    # reference, so no prelaunch lineage is claimed. This verifier authenticates referenced data only, never operator authorization, and grants
    # no completion, ACK, acceptance or dispatch. Supports a legacy OperationalRunReceipt/v1 advisory anchor only.
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Evidence)
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
    try {
        # ---- exact input: ordinal PSCustomObject, no aliases, extras, nulls or loose pins ----
        & $exact $Evidence @('schema', 'current', 'predecessorReceipt') 'OBSPA_EVIDENCE_SHAPE'
        $evSchema = & $get $Evidence 'schema' 'OBSPA_EVIDENCE_SHAPE'
        if (($evSchema -isnot [string]) -or ($evSchema -cne 'ManagedObservePendingAccountingEvidence/v1')) { & $fail 'OBSPA_EVIDENCE_SCHEMA' }
        $cur = & $get $Evidence 'current' 'OBSPA_EVIDENCE_SHAPE'
        & $exact $cur @('schema', 'manifestPath', 'manifestSha256', 'terminalPath', 'terminalSha256', 'ticketPath', 'runId', 'attempt') 'OBSPA_CURRENT_SHAPE'
        if ((& $get $cur 'schema' 'OBSPA_CURRENT_SHAPE') -cne 'ManagedNativeAdvisoryEvidence/v1') { & $fail 'OBSPA_CURRENT_SCHEMA' }
        $mPath = & $str $cur 'manifestPath' 'OBSPA_CURRENT_FIELD'
        $tPath = & $str $cur 'terminalPath' 'OBSPA_CURRENT_FIELD'
        $kPath = & $str $cur 'ticketPath' 'OBSPA_CURRENT_FIELD'
        $runId = & $str $cur 'runId' 'OBSPA_CURRENT_FIELD'
        $mSha = & $get $cur 'manifestSha256' 'OBSPA_CURRENT_PIN'
        $tSha = & $get $cur 'terminalSha256' 'OBSPA_CURRENT_PIN'
        if ((-not (& $isHex $mSha)) -or (-not (& $isHex $tSha))) { & $fail 'OBSPA_CURRENT_PIN' }
        $att = & $get $cur 'attempt' 'OBSPA_CURRENT_ATTEMPT'
        if ((-not (& $isInt $att)) -or ([long]$att -lt 1) -or ([long]$att -gt [long][int]::MaxValue)) { & $fail 'OBSPA_CURRENT_ATTEMPT' }
        $attempt = [int][long]$att
        $pre = & $get $Evidence 'predecessorReceipt' 'OBSPA_EVIDENCE_SHAPE'
        & $exact $pre @('path', 'sha256') 'OBSPA_PREDECESSOR_SHAPE'
        $prePath = & $str $pre 'path' 'OBSPA_PREDECESSOR_SHAPE'
        $preSha = & $get $pre 'sha256' 'OBSPA_PREDECESSOR_PIN'
        if (-not (& $isHex $preSha)) { & $fail 'OBSPA_PREDECESSOR_PIN' }
        $mkCur = { [pscustomobject]([ordered]@{ schema = 'ManagedNativeAdvisoryEvidence/v1'; manifestPath = $mPath; manifestSha256 = $mSha; terminalPath = $tPath; terminalSha256 = $tSha; ticketPath = $kPath; runId = $runId; attempt = [long]$attempt }) }
        $selection = [pscustomobject]([ordered]@{ schema = 'ManagedObservePendingAccountingEvidence/v1'; current = (& $mkCur); predecessorReceipt = [pscustomobject]([ordered]@{ path = $prePath; sha256 = $preSha }) })

        # ---- trusted sibling declarations only; nothing is loaded from the captured workingDirectory ----
        try {
            . (Join-Path $PSScriptRoot 'native-ticket-contract.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-sdk-observation.ps1')
            . (Join-Path $PSScriptRoot 'managed-native-output-observation.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'runner\launch.ps1')
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'continuity\reconcile.ps1')
        } catch { & $fail 'OBSPA_SIBLING_UNAVAILABLE' }

        $capture = {
            $r = Get-ManagedNativeCapturedFacts -ManifestPath $mPath -ExpectedManifestSha256 $mSha -TerminalPath $tPath -ExpectedTerminalSha256 $tSha -TicketPath $kPath -RunId $runId -Attempt $attempt -ForOutputObservation
            if ((@($r).Count -ne 1) -or ($r -isnot [System.Management.Automation.PSCustomObject])) { & $fail 'OBSPA_CAPTURE_SHAPE' }
            $valid = & $get $r 'Valid' 'OBSPA_CAPTURE_SHAPE'
            $code = & $get $r 'Code' 'OBSPA_CAPTURE_SHAPE'
            $facts = & $get $r 'Facts' 'OBSPA_CAPTURE_SHAPE'
            if (($valid -isnot [bool]) -or $valid -or ($null -ne $facts)) { & $fail (& $clean $code 'OBSPA_CAPTURE_REFUSED') }
            if ($code -ceq 'OBSERVE_ONLY_CAPTURE_UNKNOWN') { & $unknown 'CAPTURE_UNKNOWN' }
            if ($code -cne 'OBSERVE_ONLY_TRANSPORT_CAPTURE') { & $fail (& $clean $code 'OBSPA_CAPTURE_REFUSED') }
            $oc = & $get $r 'ObservationCapture' 'OBSPA_CAPTURE_SHAPE'
            if ($oc -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'OBSPA_CAPTURE_SHAPE' }
            return , $oc
        }
        $c = & $capture

        # ---- bind current identity, limits and timing to the captured ticket/core/start/terminal ----
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
        $maxElapsed = & $lng $core 'maxElapsedMs' 'OBSPA_MAXELAPSED'
        if ($maxElapsed -le 0) { & $fail 'OBSPA_MAXELAPSED' }
        $pid1 = & $lng $c 'Pid' 'OBSPA_CAPTURE_FIELD'
        if (($pid1 -le 0) -or ((& $lng $term 'pid' 'OBSPA_TERMINAL_FIELD') -ne $pid1) -or ((& $lng $start 'pid' 'OBSPA_START_FIELD') -ne $pid1)) { & $fail 'OBSPA_PID_MISMATCH' }
        $startUtc = & $str $term 'startTimeUtc' 'OBSPA_TERMINAL_FIELD'
        $endUtc = & $str $term 'endedUtc' 'OBSPA_TERMINAL_FIELD'
        if ((& $str $start 'startTimeUtc' 'OBSPA_START_FIELD') -cne $startUtc) { & $fail 'OBSPA_START_MISMATCH' }
        $termReason = & $str $term 'reason' 'OBSPA_TERMINAL_FIELD'
        if (($termReason -cne 'NATURAL_EXIT') -or ((& $lng $term 'exitCode' 'OBSPA_TERMINAL_FIELD') -ne 0) -or ((& $lng $c 'TransportExitCode' 'OBSPA_CAPTURE_FIELD') -ne 0)) { & $fail 'OBSPA_TERMINAL_STATE' }
        $t0 = & $ticks $startUtc 'OBSPA_START_UTC'
        $t1 = & $ticks $endUtc 'OBSPA_END_UTC'
        if ($t1 -lt $t0) { & $fail 'OBSPA_TIME_ORDER' }
        $dTicks = [long]($t1 - $t0)
        $usedElapsed = [long](($dTicks - ($dTicks % 10000L)) / 10000L)
        if (($dTicks % 10000L) -ne 0) { $usedElapsed = & $add $usedElapsed 1L 'OBSPA_ELAPSED_OVERFLOW' }
        if ($usedElapsed -gt $maxElapsed) { & $fail 'OBSPA_ELAPSED_EXCEEDS' }
        $reqSha = & $get $c 'RequestSha256' 'OBSPA_CAPTURE_FIELD'
        if (-not (& $isHex $reqSha)) { & $fail 'OBSPA_CAPTURE_FIELD' }
        if (($null -ne (& $get $cbud 'AdditionalOutputMax' 'OBSPA_BUDGET')) -or ($null -ne (& $get $cbud 'PhaseAggregateCeiling' 'OBSPA_BUDGET'))) { & $fail 'OBSPA_BUDGET' }
        $curHist = & $cnt (& $get $cbud 'HistoricalOutputTokens' 'OBSPA_BUDGET') 'OBSPA_BUDGET'

        # ---- selected accounting anchor: pinned legacy v1 advisory receipt, authenticated through its own recapture ----
        $wd = & $str $core 'workingDirectory' 'OBSPA_CORE_FIELD'
        $controlRoot = [IO.Path]::Combine($wd, '.factory-data', 'chief', 'controller-runtime', 'control')
        $preRef = [pscustomobject]@{ path = $prePath; sha256 = $preSha }
        $readPre = {
            $x = $null
            try { $x = Read-ManagedPinnedEvidenceJson -Reference $preRef -ControlRoot $controlRoot } catch { $x = $null }
            if (($null -eq $x) -or ($x.Sha256 -cne $preSha) -or ($x.Path -cne $prePath)) { & $fail 'OBSPA_PREDECESSOR_UNREADABLE' }
            return , $x
        }
        $pr = & $readPre
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
        # Current ticket history must equal the anchor's authenticated used total; no history list is fabricated for the current ticket.
        if ($curHist -ne $priorUsed) { & $fail 'OBSPA_ANCHOR_HISTORY_MISMATCH' }

        # Current identity must be absent from authenticated predecessor history plus the predecessor terminal.
        $runs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $reqs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $shas = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $paths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
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

        # ---- shared read-only observation over the captured stdout leaf ----
        $obs = Get-ManagedNativeOutputObservation -Evidence (& $mkCur)
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
        if ((ConvertTo-Json -InputObject $oEv -Compress -Depth 4) -cne (ConvertTo-Json -InputObject (& $mkCur) -Compress -Depth 4)) { & $fail 'OBSPA_OBSERVATION_EVIDENCE' }
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

        # ---- stability: recapture current and predecessor exact tuples after observation ----
        $c2 = & $capture
        if ((& $sig $c2) -cne (& $sig $c)) { & $fail 'OBSPA_STALE_CURRENT' }
        $pr2 = & $readPre
        if (($pr2.Sha256 -cne $pr.Sha256) -or ($pr2.Length -ne $pr.Length)) { & $fail 'OBSPA_STALE_PREDECESSOR' }
        $pcap2 = Get-ManagedNativeCapturedFacts @pcapArgs
        if (($pcap2.Valid -isnot [bool]) -or (-not $pcap2.Valid) -or ((& $inventory $pcap2.Facts) -cne (& $inventory $pc))) { & $fail 'OBSPA_STALE_PREDECESSOR' }

        $declared = @(@($c.DeclaredReferences))
        $verified = @(@($c.VerifiedReferences))
        $refOf = {
            param([string]$role)
            $d = @($declared | Where-Object { $_.Role -ceq $role }); $v = @($verified | Where-Object { $_.Role -ceq $role })
            if (($d.Count -ne 1) -or ($v.Count -ne 1)) { & $fail 'OBSPA_REFERENCE' }
            return [pscustomobject]([ordered]@{ path = [string]$v[0].Path; declaredSha256 = [string]$d[0].DeclaredSha256; declaredLength = [long]$d[0].DeclaredLength; verifiedSha256 = [string]$v[0].VerifiedSha256; verifiedLength = [long]$v[0].VerifiedLength })
        }
        $inPaths = [System.Collections.Generic.List[string]]::new()
        foreach ($e in @($c.Inputs) + @($c.StreamedInputs) + @($pc.Inputs)) { if (([string]$e.Path).Length -gt 0) { $inPaths.Add([string]$e.Path) } }
        $inPaths.Add([string]$pr.Path)
        $accounting = [pscustomobject]([ordered]@{
            schema = 'ManagedObservePendingAccounting/v1'
            anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
            anchor = [pscustomobject]([ordered]@{ receiptPath = [string]$pr.Path; receiptSha256 = [string]$pr.Sha256; runId = [string]$pEv.runId; attempt = [long]$pEv.attempt; terminalPath = [string]$pc.TerminalPath; terminalSha256 = [string]$pc.TerminalSha256; usedOutputTokens = $priorUsed })
            historicalOutputTokens = $curHist
            observedOutputTokens = $observed
            usedOutputTokens = $used
            requestSha256 = [string]$reqSha
            startUtc = $startUtc
            endedUtc = $endUtc
            noAcceptedUsage = $true; noCompletion = $true; noAck = $true; noDispatch = $true
        })
        $facts = [pscustomobject]([ordered]@{
            schema = 'ManagedObservePendingAccountingFacts/v1'
            evidence = $selection
            anchorLabel = 'SELECTED_ACCOUNTING_ANCHOR'
            identity = [pscustomobject]([ordered]@{ taskId = $taskId; payloadSha256 = [string]$payloadSha; runId = $runId; attempt = [long]$attempt; sessionId = $sessionId; pid = $pid1; terminalReason = $termReason })
            limits = [pscustomobject]([ordered]@{ maxElapsedMs = $maxElapsed; maxAttempts = $maxAttempts; priorElapsedMs = 0L; maxOutputTokens = $null; softFraction = $null })
            timing = [pscustomobject]([ordered]@{ startUtc = $startUtc; endedUtc = $endUtc; usedElapsedMs = $usedElapsed })
            accounting = $accounting
            stdout = [pscustomobject]([ordered]@{ path = [string]$leaf.Path; sha256 = [string]$leaf.VerifiedSha256; length = [long]$leaf.VerifiedLength })
            references = [pscustomobject]([ordered]@{
                manifest = [pscustomobject]([ordered]@{ path = $mPath; expectedSha256 = $mSha; verifiedSha256 = [string]$c.ManifestSha256 })
                terminal = [pscustomobject]([ordered]@{ path = $tPath; expectedSha256 = $tSha; verifiedSha256 = [string]$c.TerminalSha256 })
                ticket = [pscustomobject]([ordered]@{ path = $kPath; expectedSha256 = [string](& $get $core 'ticketSha256' 'OBSPA_CORE_FIELD'); verifiedSha256 = [string]$c.TicketSha256 })
                predecessorReceipt = [pscustomobject]([ordered]@{ path = $prePath; expectedSha256 = $preSha; verifiedSha256 = [string]$pr.Sha256 })
                stdout = (& $refOf 'STDOUT')
                stderr = (& $refOf 'STDERR')
                artifactState = [string]$c.ArtifactState
            })
            inputPaths = @($inPaths.ToArray())
            noAcceptedUsage = $true; noCompletion = $true; noAck = $true; noDispatch = $true
        })
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

function Test-ManagedObservePendingRawDto {
    # Read-only. Cross-checks one caller raw DTO against derived authenticated pending-accounting facts; shared by the adapter and the v3 validator.
    # The raw DTO is crosschecked input, not provider attestation and not the captured terminal. The read bound below is an observation constraint
    # for this small metadata file only; it never limits or stops author output.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [AllowNull()][AllowEmptyString()][string]$ExpectedSha256,
        [Parameter(Mandatory)]$Facts
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
        if ((-not (& $isInt $raw.exit)) -or ([long]$raw.exit -ne 0)) { & $fail 'OBSPA_RAW_EXIT' }
        if ((-not (& $isInt $raw.observedOutput)) -or ([long]$raw.observedOutput -ne [long]$acct.observedOutputTokens)) { & $fail 'OBSPA_RAW_OBSERVED' }
        if (($rn -ccontains 'historicalOutput') -and ((-not (& $isInt $raw.historicalOutput)) -or ([long]$raw.historicalOutput -ne [long]$acct.historicalOutputTokens))) { & $fail 'OBSPA_RAW_HISTORY' }
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
