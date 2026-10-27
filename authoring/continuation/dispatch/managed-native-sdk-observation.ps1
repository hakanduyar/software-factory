function Get-ManagedNativeSdkObservation {
    # Read-only. Observes one captured SDK newline-delimited JSON stdout file and reports what the SDK itself said.
    # Pins are caller assertions, not authenticated capture authority. Grants no receipt, completion, history advance,
    # dispatch, callback, provider/process action or filesystem write. A later consumer must authenticate the captured refs itself.
    # MaxRecordBytes bounds observer memory for one JSON record only; it never stops or truncates the author output or the raw file.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][AllowEmptyString()]$StdoutPath,
        [Parameter(Mandatory)][AllowNull()][AllowEmptyString()]$ExpectedStdoutSha256,
        [Parameter(Mandatory)][AllowNull()]$ExpectedStdoutLength,
        [Parameter(Mandatory)][AllowNull()][AllowEmptyString()]$ExpectedSessionId,
        [ValidateRange(1, 2000000000)][long]$MaxRecordBytes = 1048576
    )
    Set-StrictMode -Version Latest
    $strict = [System.Text.UTF8Encoding]::new($false, $true)
    $kind = [System.Text.Json.JsonValueKind]
    $halt = { param([string]$st, [string]$c) throw [System.InvalidOperationException]::new('OBS:' + $st + ':' + $c) }
    $add = { param([long]$a, [long]$b, [string]$c) if (($a -lt 0) -or ($b -lt 0) -or ($a -gt ([long]::MaxValue - $b))) { & $halt 'UNKNOWN' $c }; return [long]($a + $b) }
    $prop = {
        param($el, [string]$name)
        foreach ($p in $el.EnumerateObject()) { if ($p.Name -ceq $name) { return , $p.Value } }
        return $null
    }
    $cntOf = {
        param($v, [string]$c)
        if ($v.ValueKind -ne $kind::Number) { & $halt 'INVALID' $c }
        $raw = $v.GetRawText()
        if ($raw -cnotmatch '^(0|[1-9][0-9]*)\z') { & $halt 'INVALID' $c }
        $o = 0L
        if (-not [long]::TryParse($raw, [System.Globalization.NumberStyles]::None, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$o)) { & $halt 'UNKNOWN' 'NUMERIC_OVERFLOW' }
        return [long]$o
    }
    $s = @{
        invalid = $null; unknown = $null; limited = $false; over = $false; rec = [System.IO.MemoryStream]::new()
        inMsg = $false; curCov = $false; curMax = 0L; native = 0L; starts = 0L; missing = $false
        resultCount = 0; subtype = $null; isError = $null; reported = $null; stopReason = $null; terminalReason = $null; errors = $null
    }
    $setBad = {
        param([string]$st, [string]$c)
        if ($st -ceq 'INVALID') { if ($null -eq $s.invalid) { $s.invalid = $c } }
        else { $s.limited = $true; if ($null -eq $s.unknown) { $s.unknown = $c } }
    }
    $closeMsg = {
        if ($s.inMsg) {
            if ($s.curCov) { $s.native = & $add $s.native $s.curMax 'RECOUNT_OVERFLOW' } else { $s.missing = $true }
        }
    }
    $proc = {
        param([byte[]]$bytes)
        $text = $null
        try { $text = $strict.GetString($bytes) } catch { $text = $null }
        if ($null -eq $text) { & $halt 'INVALID' 'STREAM_UTF8' }
        if ([string]::IsNullOrWhiteSpace($text)) { return }
        if ($s.resultCount -gt 0) { & $halt 'INVALID' 'STREAM_ORDER' }
        $opt = [System.Text.Json.JsonDocumentOptions]::new()
        $opt.MaxDepth = 1000
        $jd = $null
        try { $jd = [System.Text.Json.JsonDocument]::Parse($text, $opt) }
        catch {
            $m = [string]$_.Exception.Message
            if ($null -ne $_.Exception.InnerException) { $m += ' ' + [string]$_.Exception.InnerException.Message }
            if ($m -clike '*maximum configured depth*') { & $halt 'UNKNOWN' 'JSON_DEPTH_LIMIT' }
            & $halt 'INVALID' 'STREAM_JSON'
        }
        try {
            # Recursive duplicate property check (case-insensitive) so wrong-case aliases cannot hide a second value.
            $stk = [System.Collections.Generic.Stack[System.Text.Json.JsonElement]]::new()
            $stk.Push($jd.RootElement)
            while ($stk.Count -gt 0) {
                $el = $stk.Pop()
                if ($el.ValueKind -eq $kind::Object) {
                    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                    foreach ($jp in $el.EnumerateObject()) {
                        if (-not $seen.Add($jp.Name)) { & $halt 'INVALID' 'STREAM_JSON_DUPLICATE' }
                        $stk.Push($jp.Value)
                    }
                }
                elseif ($el.ValueKind -eq $kind::Array) {
                    foreach ($ji in $el.EnumerateArray()) { $stk.Push($ji) }
                }
            }
            $root = $jd.RootElement
            if ($root.ValueKind -ne $kind::Object) { & $halt 'INVALID' 'STREAM_JSON' }
            $tp = & $prop $root 'type'
            if (($null -eq $tp) -or ($tp.ValueKind -ne $kind::String)) { & $halt 'INVALID' 'STREAM_TYPE' }
            $evt = $root
            if ($tp.GetString() -ceq 'stream_event') {
                $ep = & $prop $root 'event'
                if (($null -eq $ep) -or ($ep.ValueKind -ne $kind::Object)) { & $halt 'INVALID' 'STREAM_TYPE' }
                $evt = $ep
            }
            $et = & $prop $evt 'type'
            if (($null -eq $et) -or ($et.ValueKind -ne $kind::String)) { & $halt 'INVALID' 'STREAM_TYPE' }
            $t = $et.GetString()
            if ($t -ceq 'message_start') {
                & $closeMsg
                $s.inMsg = $true; $s.curCov = $false; $s.curMax = 0L
                $s.starts = & $add $s.starts 1L 'RECOUNT_OVERFLOW'
            }
            elseif ($t -ceq 'message_delta') {
                if ((-not $s.inMsg) -and (-not $s.limited)) { & $halt 'INVALID' 'STREAM_ORDER' }
                $up = & $prop $evt 'usage'
                if (($null -ne $up) -and ($up.ValueKind -ne $kind::Null)) {
                    if ($up.ValueKind -ne $kind::Object) { & $halt 'INVALID' 'STREAM_USAGE' }
                    $op = & $prop $up 'output_tokens'
                    if (($null -ne $op) -and ($op.ValueKind -ne $kind::Null)) {
                        $ov = & $cntOf $op 'STREAM_USAGE'
                        if ($s.inMsg) { $s.curCov = $true; if ($ov -gt $s.curMax) { $s.curMax = $ov } }
                    }
                }
            }
            elseif ($t -ceq 'system') {
                $stp = & $prop $evt 'subtype'
                if (($null -ne $stp) -and ($stp.ValueKind -eq $kind::String) -and ($stp.GetString() -ceq 'init')) {
                    $sip = & $prop $evt 'session_id'
                    if (($null -eq $sip) -or ($sip.ValueKind -ne $kind::String)) { & $halt 'INVALID' 'SESSION_INIT' }
                    if ($sip.GetString() -cne $ExpectedSessionId) { & $halt 'INVALID' 'SESSION_MISMATCH' }
                }
            }
            elseif ($t -ceq 'result') {
                $sub = & $prop $evt 'subtype'
                if (($null -eq $sub) -or ($sub.ValueKind -ne $kind::String) -or ($sub.GetString().Length -eq 0)) { & $halt 'INVALID' 'RESULT_SUBTYPE' }
                $ie = & $prop $evt 'is_error'
                if (($null -eq $ie) -or (($ie.ValueKind -ne $kind::True) -and ($ie.ValueKind -ne $kind::False))) { & $halt 'INVALID' 'RESULT_IS_ERROR' }
                $rs = & $prop $evt 'session_id'
                if (($null -eq $rs) -or ($rs.ValueKind -ne $kind::String)) { & $halt 'INVALID' 'RESULT_SESSION' }
                if ($rs.GetString() -cne $ExpectedSessionId) { & $halt 'INVALID' 'SESSION_MISMATCH' }
                $rep = $null
                $ru = & $prop $evt 'usage'
                if (($null -ne $ru) -and ($ru.ValueKind -ne $kind::Null)) {
                    if ($ru.ValueKind -ne $kind::Object) { & $halt 'INVALID' 'RESULT_USAGE' }
                    $ro = & $prop $ru 'output_tokens'
                    if (($null -ne $ro) -and ($ro.ValueKind -ne $kind::Null)) { $rep = & $cntOf $ro 'RESULT_USAGE' }
                }
                $s.resultCount = 1
                $s.subtype = $sub.GetString()
                $s.isError = ($ie.ValueKind -eq $kind::True)
                $s.reported = $rep
                foreach ($k in @('stop_reason', 'terminal_reason')) {
                    $kv = & $prop $evt $k
                    $val = if (($null -ne $kv) -and ($kv.ValueKind -eq $kind::String)) { $kv.GetString() } else { $null }
                    if ($k -ceq 'stop_reason') { $s.stopReason = $val } else { $s.terminalReason = $val }
                }
                $er = & $prop $evt 'errors'
                if (($null -ne $er) -and ($er.ValueKind -eq $kind::Array)) {
                    $list = [System.Collections.Generic.List[string]]::new()
                    $allStr = $true
                    foreach ($ei in $er.EnumerateArray()) { if ($ei.ValueKind -eq $kind::String) { $list.Add($ei.GetString()) } else { $allStr = $false } }
                    if ($allStr) { $s.errors = $list.ToArray() }
                }
            }
            # Every other event type, including assistant aggregate summaries and tool-input fragments, is left opaque and uncounted.
        }
        finally { $jd.Dispose() }
    }
    $endRec = {
        if ($s.over) {
            $s.over = $false
            $s.rec = [System.IO.MemoryStream]::new()
            & $setBad 'UNKNOWN' 'RECORD_OBSERVATION_LIMIT'
            return
        }
        $b = $s.rec.ToArray()
        $s.rec = [System.IO.MemoryStream]::new()
        try { & $proc $b }
        catch {
            $m = [string]$_.Exception.Message
            if ($m -cmatch '^OBS:(INVALID|UNKNOWN):([A-Z0-9_]{1,48})\z') { & $setBad $Matches[1] $Matches[2] } else { throw }
        }
    }
    $append = {
        param([byte[]]$b, [int]$o, [int]$c)
        if ($s.over -or ($c -le 0)) { return }
        if (($s.rec.Length + $c) -gt $MaxRecordBytes) { $s.over = $true; $s.rec = [System.IO.MemoryStream]::new(); return }
        $s.rec.Write($b, $o, $c)
    }

    $expected = [pscustomobject]@{ Path = $StdoutPath; Sha256 = $ExpectedStdoutSha256; Length = $ExpectedStdoutLength }
    $verified = $null
    $observedRaw = $null
    $final = $null
    $fs = $null; $h = $null
    try {
        $ok = { param([string]$c) & $halt 'INVALID' $c }
        $p = $StdoutPath
        if (($p -isnot [string]) -or ($p.Length -eq 0) -or ($p.Length -gt 4096) -or ($p.IndexOf([char]0) -ge 0) -or -not [System.IO.Path]::IsPathRooted($p)) { & $ok 'INPUT_PATH' }
        $full = $null
        try { $full = [System.IO.Path]::GetFullPath($p) } catch { $full = $null }
        if (($null -eq $full) -or ($full -cne $p) -or $p.EndsWith([string][System.IO.Path]::DirectorySeparatorChar) -or $p.EndsWith([string][System.IO.Path]::AltDirectorySeparatorChar)) { & $ok 'INPUT_PATH' }
        if (($ExpectedStdoutSha256 -isnot [string]) -or ($ExpectedStdoutSha256 -cnotmatch '^[0-9a-f]{64}\z')) { & $ok 'INPUT_SHA256' }
        if ((($ExpectedStdoutLength -isnot [int]) -and ($ExpectedStdoutLength -isnot [long])) -or ([long]$ExpectedStdoutLength -lt 0)) { & $ok 'INPUT_LENGTH' }
        if (($ExpectedSessionId -isnot [string]) -or [string]::IsNullOrWhiteSpace($ExpectedSessionId)) { & $ok 'INPUT_SESSION' }
        $fi = [System.IO.FileInfo]::new($p)
        if (-not $fi.Exists) { & $ok 'INPUT_PATH_NOT_FILE' }
        if (($fi.Attributes -band ([System.IO.FileAttributes]::ReparsePoint -bor [System.IO.FileAttributes]::Device -bor [System.IO.FileAttributes]::Directory)) -ne 0) { & $ok 'INPUT_PATH_NOT_ORDINARY' }
        if ($null -ne $fi.LinkTarget) { & $ok 'INPUT_PATH_NOT_ORDINARY' }
        $len0 = $fi.Length; $mt0 = $fi.LastWriteTimeUtc

        $fs = [System.IO.FileStream]::new($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read, 65536, [System.IO.FileOptions]::SequentialScan)
        $h = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA256)
        $buf = [byte[]]::new(65536)
        $total = 0L
        while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
            $total = & $add $total ([long]$n) 'LENGTH_OVERFLOW'
            $h.AppendData($buf, 0, $n)
            if ($null -ne $s.invalid) { continue }   # keep hashing every byte; parsing has nothing further to learn
            $i = 0
            while ($i -lt $n) {
                $nl = [System.Array]::IndexOf([byte[]]$buf, [byte]10, $i, $n - $i)
                if ($nl -lt 0) { & $append $buf $i ($n - $i); break }
                & $append $buf $i ($nl - $i)
                & $endRec
                if ($null -ne $s.invalid) { break }
                $i = $nl + 1
            }
        }
        if (($null -eq $s.invalid) -and ($s.over -or ($s.rec.Length -gt 0))) { & $endRec }
        $sha = [System.Convert]::ToHexString($h.GetHashAndReset()).ToLowerInvariant()
        $fi2 = [System.IO.FileInfo]::new($p)
        $stable = $fi2.Exists -and ($fi2.Length -eq $total) -and ($fs.Length -eq $total) -and ($len0 -eq $total) -and ($fi2.LastWriteTimeUtc -eq $mt0)
        $observedRaw = [pscustomobject]@{ Path = $p; Sha256 = $sha; Length = $total }
        # Raw-pin precedence: any change or pin mismatch is INVALID whatever the parser observed or could not observe.
        if (-not $stable) { & $ok 'STDOUT_CHANGED' }
        if ($total -ne [long]$ExpectedStdoutLength) { & $ok 'STDOUT_LENGTH_MISMATCH' }
        if ($sha -cne $ExpectedStdoutSha256) { & $ok 'STDOUT_SHA256_MISMATCH' }
        $verified = [pscustomobject]@{ Path = $p; Sha256 = $sha; Length = $total }

        if ($null -ne $s.invalid) { & $halt 'INVALID' $s.invalid }
        try { & $closeMsg } catch { & $setBad 'UNKNOWN' 'RECOUNT_OVERFLOW' }
        if ($null -ne $s.unknown) { & $halt 'UNKNOWN' $s.unknown }
        if ($s.resultCount -ne 1) { & $halt 'UNKNOWN' 'NO_SDK_RESULT' }

        $complete = ($s.starts -gt 0) -and (-not $s.missing) -and (-not $s.limited)
        $consistency = 'UNAVAILABLE'
        if ($complete -and ($null -ne $s.reported)) {
            if ([long]$s.reported -ne [long]$s.native) { & $halt 'INVALID' 'OUTPUT_RECOUNT_MISMATCH' }
            $consistency = 'MATCH'
        }
        $final = [pscustomobject]@{
            Status = 'OBSERVED'; Code = 'SDK_RESULT_OBSERVED'; Reason = 'Exactly one well-typed terminal SDK result observed over fully hashed pinned bytes.'
            SdkOutcome = $(if ($s.isError) { 'ERROR' } else { 'SUCCESS' }); SdkSubtype = [string]$s.subtype
            SdkStopReason = $s.stopReason; SdkTerminalReason = $s.terminalReason; SdkErrors = $s.errors
            SdkReportedOutputTokens = $s.reported
            RecountedOutputTokens = $(if ($complete) { [long]$s.native } else { $null })
            RecountStatus = $(if ($complete) { 'COMPLETE' } else { 'UNAVAILABLE' }); Consistency = $consistency
        }
    }
    catch {
        $m = [string]$_.Exception.Message
        $st = 'UNKNOWN'; $code = 'OBSERVER_UNEXPECTED_ERROR'
        if ($m -cmatch '^OBS:(INVALID|UNKNOWN):([A-Z0-9_]{1,48})\z') { $st = $Matches[1]; $code = $Matches[2] }
        elseif ($_.Exception -is [System.IO.IOException]) { $code = 'STDOUT_READ_ERROR' }
        elseif ($_.Exception -is [System.OutOfMemoryException]) { $code = 'RESOURCE_LIMIT' }
        $final = [pscustomobject]@{
            Status = $st; Code = $code; Reason = $(if ($st -ceq 'INVALID') { 'Input or SDK stream is invalid; no usage is accepted.' } else { 'SDK result could not be fully observed; no usage is accepted and nothing is implied zero.' })
            SdkOutcome = 'UNKNOWN'; SdkSubtype = $null; SdkStopReason = $null; SdkTerminalReason = $null; SdkErrors = $null
            SdkReportedOutputTokens = $null; RecountedOutputTokens = $null; RecountStatus = 'UNAVAILABLE'; Consistency = 'UNAVAILABLE'
        }
    }
    finally {
        if ($null -ne $h) { $h.Dispose() }
        if ($null -ne $fs) { $fs.Dispose() }
    }
    return [pscustomobject]@{
        Schema = 'ManagedNativeSdkObservation/v1'
        Status = $final.Status; Code = $final.Code; Reason = $final.Reason
        ExpectedRaw = $expected; ObservedRaw = $observedRaw; VerifiedRaw = $verified
        SdkOutcome = $final.SdkOutcome; SdkSubtype = $final.SdkSubtype; SdkStopReason = $final.SdkStopReason; SdkTerminalReason = $final.SdkTerminalReason; SdkErrors = $final.SdkErrors
        SdkReportedOutputTokens = $final.SdkReportedOutputTokens; RecountedOutputTokens = $final.RecountedOutputTokens
        RecountStatus = $final.RecountStatus; Consistency = $final.Consistency
        MessageStarts = [long]$s.starts
        NoAcceptedUsage = $true; NoReceipt = $true; NoCompletion = $true; NoDispatch = $true
    }
}
