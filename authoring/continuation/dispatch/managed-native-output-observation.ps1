# managed-native-output-observation.ps1 - read-only binding seam. Dot-source only; defines one function and executes nothing.
# Dependencies Get-ManagedNativeCapturedFacts and Get-ManagedNativeSdkObservation must already be loaded from reviewed sources
# by the caller; this file never dot-sources, discovers or loads code, and the caller supplies no callbacks, raw paths or sessions.
function Get-ManagedNativeOutputObservation {
    # Binds one reviewed transport capture to one reviewed SDK observation. Grants no accepted usage, receipt, completion,
    # dispatch, process, provider action or filesystem write. Imposes no output/token/turn/report ceiling.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()]$Evidence
    )
    Set-StrictMode -Version Latest
    $ord = [System.StringComparison]::Ordinal
    $noteKind = [System.Management.Automation.PSMemberTypes]::NoteProperty
    $isObj = { param($v) $v -is [System.Management.Automation.PSCustomObject] }
    $isInt = { param($v) ($v -is [int]) -or ($v -is [long]) }
    $isHex = { param($v) ($v -is [string]) -and ($v -cmatch '^[0-9a-f]{64}\z') }
    $halt = { param([string]$st, [string]$c) throw [System.InvalidOperationException]::new('BIND:' + $st + ':' + $c) }
    # Exact-ordinal NoteProperty lookup; returns @($true, value) or @($false, $null).
    $get = {
        param($o, [string]$n)
        foreach ($q in $o.PSObject.Properties) {
            if (($q.MemberType -eq $noteKind) -and [string]::Equals($q.Name, $n, $ord)) { return , @($true, $q.Value) }
        }
        return , @($false, $null)
    }
    $need = {
        param($o, [string]$n, [string]$c)
        $g = & $get $o $n
        if (-not $g[0]) { & $halt 'INVALID' $c }
        return , $g[1]
    }
    $st = @{ n = 0 }
    $sb = [System.Text.StringBuilder]::new()
    $cn = $null
    # Typed deterministic canonical form: type tag + length prefix, ordinal-sorted names, ordered arrays; never string coercion.
    $cn = {
        param($v, [int]$d)
        $st.n = $st.n + 1
        if (($d -gt 16) -or ($st.n -gt 20000) -or ($sb.Length -gt 4194304)) { throw [System.InvalidOperationException]::new('CANON:LIMIT') }
        if ($null -eq $v) { [void]$sb.Append('N;'); return }
        if ($v -is [string]) { [void]$sb.Append('S').Append($v.Length.ToString([System.Globalization.CultureInfo]::InvariantCulture)).Append(':').Append($v).Append(';'); return }
        if ($v -is [bool]) { [void]$sb.Append($(if ($v) { 'B1;' } else { 'B0;' })); return }
        if ($v -is [int]) { [void]$sb.Append('I').Append(([int]$v).ToString([System.Globalization.CultureInfo]::InvariantCulture)).Append(';'); return }
        if ($v -is [long]) { [void]$sb.Append('L').Append(([long]$v).ToString([System.Globalization.CultureInfo]::InvariantCulture)).Append(';'); return }
        $names = [System.Collections.Generic.List[string]]::new()
        $vals = @{}
        if ($v -is [System.Management.Automation.PSCustomObject]) {
            foreach ($q in $v.PSObject.Properties) {
                if ($q.MemberType -ne $noteKind) { throw [System.InvalidOperationException]::new('CANON:MEMBER') }
                $names.Add([string]$q.Name); $vals[[string]$q.Name] = $q.Value
            }
            $tag = 'O'
        }
        elseif ($v -is [System.Collections.IDictionary]) {
            foreach ($k in $v.Keys) {
                if ($k -isnot [string]) { throw [System.InvalidOperationException]::new('CANON:KEY') }
                $names.Add($k); $vals[$k] = $v[$k]
            }
            $tag = 'D'
        }
        elseif ($v -is [object[]]) {
            [void]$sb.Append('A').Append($v.Length.ToString([System.Globalization.CultureInfo]::InvariantCulture)).Append('[')
            foreach ($item in $v) { & $cn $item ($d + 1) }
            [void]$sb.Append(']')
            return
        }
        else { throw [System.InvalidOperationException]::new('CANON:TYPE') }
        $names.Sort([System.StringComparer]::Ordinal)
        [void]$sb.Append($tag).Append($names.Count.ToString([System.Globalization.CultureInfo]::InvariantCulture)).Append('{')
        foreach ($nm in $names) {
            [void]$sb.Append($nm.Length.ToString([System.Globalization.CultureInfo]::InvariantCulture)).Append(':').Append($nm).Append('=')
            & $cn $vals[$nm] ($d + 1)
        }
        [void]$sb.Append('}')
    }
    $compared = @('RunId', 'Attempt', 'SessionId', 'ManifestPath', 'ManifestSha256', 'TerminalPath', 'TerminalSha256', 'TicketPath', 'TicketSha256',
        'StartPath', 'StartSha256', 'RequestSha256', 'ArtifactPath', 'ArtifactState', 'Authority', 'Budget',
        'DeclaredReferences', 'VerifiedReferences', 'Inputs', 'StreamedInputs')
    $snapshot = {
        param($cap)
        $st.n = 0; [void]$sb.Clear()
        foreach ($f in $compared) {
            $g = & $get $cap $f
            [void]$sb.Append($f.Length.ToString([System.Globalization.CultureInfo]::InvariantCulture)).Append(':').Append($f).Append($(if ($g[0]) { '+' } else { '-' }))
            if ($g[0]) { & $cn $g[1] 0 }
        }
        return $sb.ToString()
    }
    $codeOf = { param($v, [string]$dflt) if (($v -is [string]) -and ($v -cmatch '^[A-Z0-9_]{1,48}\z')) { return $v }; return $dflt }
    # Whitelisted bounded copy of a reference inventory; unverified (declared) entries never carry Verified* names.
    $copyRefs = {
        param($arr, [bool]$verified)
        if ($arr -isnot [object[]]) { & $halt 'INVALID' 'CAPTURE_REFERENCE_SHAPE' }
        if ($arr.Length -gt 8) { & $halt 'INVALID' 'CAPTURE_REFERENCE_SHAPE' }
        $out = [System.Collections.Generic.List[object]]::new()
        foreach ($r in $arr) {
            if (-not (& $isObj $r)) { & $halt 'INVALID' 'CAPTURE_REFERENCE_SHAPE' }
            $role = & $need $r 'Role' 'CAPTURE_REFERENCE_SHAPE'
            $path = & $need $r 'Path' 'CAPTURE_REFERENCE_SHAPE'
            $shaN = $(if ($verified) { 'VerifiedSha256' } else { 'DeclaredSha256' })
            $lenN = $(if ($verified) { 'VerifiedLength' } else { 'DeclaredLength' })
            $sha = & $need $r $shaN 'CAPTURE_REFERENCE_SHAPE'
            $len = & $need $r $lenN 'CAPTURE_REFERENCE_SHAPE'
            if (($role -isnot [string]) -or ($path -isnot [string]) -or (-not (& $isHex $sha)) -or (-not (& $isInt $len)) -or ([long]$len -lt 0)) { & $halt 'INVALID' 'CAPTURE_REFERENCE_SHAPE' }
            $out.Add([pscustomobject]([ordered]@{ Role = [string]$role; Path = [string]$path; $shaN = [string]$sha; $lenN = [long]$len }))
        }
        return , $out.ToArray()
    }

    $cu = @{ declared = $null }
    $recDriven = $false
    $evidenceCopy = $null
    $declared = @()
    $verifiedRefs = @()
    $sdk = $null
    $status = 'UNKNOWN'; $code = 'OUTPUT_OBSERVATION_UNEXPECTED_ERROR'; $reason = 'Output observation could not be completed; no usage is accepted.'
    try {
        # ---- exact input, copied so later caller mutation cannot alter the second capture call ----
        if (-not (& $isObj $Evidence)) { & $halt 'INVALID' 'EVIDENCE_NOT_OBJECT' }
        $want = @('schema', 'manifestPath', 'manifestSha256', 'terminalPath', 'terminalSha256', 'ticketPath', 'runId', 'attempt')
        $props = @($Evidence.PSObject.Properties)
        if ($props.Count -ne $want.Count) { & $halt 'INVALID' 'EVIDENCE_SHAPE' }
        foreach ($w in $want) {
            $g = & $get $Evidence $w
            if (-not $g[0]) { & $halt 'INVALID' 'EVIDENCE_SHAPE' }
        }
        foreach ($q in $props) {
            if (($q.MemberType -ne $noteKind) -or ($want -cnotcontains [string]$q.Name)) { & $halt 'INVALID' 'EVIDENCE_SHAPE' }
        }
        $in = @{}
        foreach ($w in $want) { $in[$w] = (& $get $Evidence $w)[1] }
        if (($in.schema -isnot [string]) -or ($in.schema -cne 'ManagedNativeAdvisoryEvidence/v1')) { & $halt 'INVALID' 'EVIDENCE_SCHEMA' }
        foreach ($w in @('manifestPath', 'terminalPath', 'ticketPath', 'runId')) {
            if (($in[$w] -isnot [string]) -or ($in[$w].Length -eq 0)) { & $halt 'INVALID' 'EVIDENCE_FIELD' }
        }
        foreach ($w in @('manifestSha256', 'terminalSha256')) {
            if (-not (& $isHex $in[$w])) { & $halt 'INVALID' 'EVIDENCE_HASH' }
        }
        if ((-not (& $isInt $in.attempt)) -or ([long]$in.attempt -lt 1) -or ([long]$in.attempt -gt [long][int]::MaxValue)) { & $halt 'INVALID' 'EVIDENCE_ATTEMPT' }
        $mPath = [string]$in.manifestPath; $mSha = [string]$in.manifestSha256
        $tPath = [string]$in.terminalPath; $tSha = [string]$in.terminalSha256
        $kPath = [string]$in.ticketPath; $runId = [string]$in.runId; $attempt = [int][long]$in.attempt
        $evidenceCopy = [pscustomobject]([ordered]@{
            schema = 'ManagedNativeAdvisoryEvidence/v1'; manifestPath = $mPath; manifestSha256 = $mSha; terminalPath = $tPath
            terminalSha256 = $tSha; ticketPath = $kPath; runId = $runId; attempt = [long]$attempt })

        # ---- trusted externally loaded dependencies only ----
        foreach ($dn in @('Get-ManagedNativeCapturedFacts', 'Get-ManagedNativeSdkObservation')) {
            $dc = Get-Command -Name $dn -CommandType Function -ErrorAction SilentlyContinue
            if (@($dc).Count -ne 1) { & $halt 'UNKNOWN' 'DEPENDENCY_UNAVAILABLE' }
        }
        $capture = {
            $r = Get-ManagedNativeCapturedFacts -ManifestPath $mPath -ExpectedManifestSha256 $mSha -TerminalPath $tPath -ExpectedTerminalSha256 $tSha -TicketPath $kPath -RunId $runId -Attempt $attempt -ForOutputObservation
            if ((@($r).Count -ne 1) -or (-not (& $isObj $r))) { & $halt 'INVALID' 'CAPTURE_RESULT_SHAPE' }
            foreach ($f in @('Valid', 'Code', 'Facts')) { if (-not (& $get $r $f)[0]) { & $halt 'INVALID' 'CAPTURE_RESULT_SHAPE' } }
            $valid = (& $get $r 'Valid')[1]; $cc = (& $get $r 'Code')[1]; $facts = (& $get $r 'Facts')[1]
            if (($valid -isnot [bool]) -or $valid -or ($null -ne $facts)) {
                # Valid ordinary facts or any non-observation result is never consumed.
                & $halt 'INVALID' (& $codeOf $cc 'CAPTURE_REFUSED')
            }
            if ($cc -ceq 'OBSERVE_ONLY_CAPTURE_UNKNOWN') {
                $res = (& $get $r 'Result')
                if (-not $res[0] -or ($res[1] -cne 'UNKNOWN')) { & $halt 'INVALID' 'CAPTURE_RESULT_SHAPE' }
                                $dg = & $get $r 'DeclaredReferences'
                $cu.declared = $(if ($dg[0]) { $dg[1] } else { $null })
                & $halt 'UNKNOWN' 'CAPTURE_UNKNOWN'
            }
            if ($cc -cne 'OBSERVE_ONLY_TRANSPORT_CAPTURE') { & $halt 'INVALID' (& $codeOf $cc 'CAPTURE_REFUSED') }
            $oc = (& $get $r 'ObservationCapture')
            if ((-not $oc[0]) -or (-not (& $isObj $oc[1]))) { & $halt 'INVALID' 'CAPTURE_INCOMPLETE' }
            $oc[1]
        }
                $cap1 = $null
        try { $cap1 = & $capture }
        catch {
            $m = [string]$_.Exception.Message
            if ($m -cmatch '^BIND:(INVALID|UNKNOWN):([A-Z0-9_]{1,48})\z') {
                if (($Matches[2] -ceq 'CAPTURE_UNKNOWN') -and ($cu.declared -is [object[]])) {
                    try { $declared = & $copyRefs $cu.declared $false } catch { $declared = @() }
                }
                throw
            }
            & $halt 'UNKNOWN' 'CAPTURE_EXCEPTION'
        }

        # ---- first capture: identity, one verified STDOUT leaf, session ----
        if ((& $need $cap1 'RunId' 'CAPTURE_INCOMPLETE') -cne $runId) { & $halt 'INVALID' 'CAPTURE_IDENTITY_MISMATCH' }
        $ca = & $need $cap1 'Attempt' 'CAPTURE_INCOMPLETE'
        if ((-not (& $isInt $ca)) -or ([long]$ca -ne [long]$attempt)) { & $halt 'INVALID' 'CAPTURE_IDENTITY_MISMATCH' }
        $idPairs = @(@('ManifestPath', $mPath), @('ManifestSha256', $mSha), @('TerminalPath', $tPath), @('TerminalSha256', $tSha), @('TicketPath', $kPath))
        foreach ($p in $idPairs) {
            $cv = & $need $cap1 $p[0] 'CAPTURE_INCOMPLETE'
            if (($cv -isnot [string]) -or ($cv -cne $p[1])) { & $halt 'INVALID' 'CAPTURE_IDENTITY_MISMATCH' }
        }
        if (-not (& $isHex (& $need $cap1 'TicketSha256' 'CAPTURE_INCOMPLETE'))) { & $halt 'INVALID' 'CAPTURE_IDENTITY_MISMATCH' }
        $sess = & $need $cap1 'SessionId' 'CAPTURE_INCOMPLETE'
        if (($sess -isnot [string]) -or [string]::IsNullOrWhiteSpace($sess)) { & $halt 'INVALID' 'CAPTURE_SESSION' }
        foreach ($f in @('Authority', 'Budget', 'Inputs', 'StreamedInputs')) { [void](& $need $cap1 $f 'CAPTURE_INCOMPLETE') }
        $declared = & $copyRefs (& $need $cap1 'DeclaredReferences' 'CAPTURE_INCOMPLETE') $false
        $verifiedRefs = & $copyRefs (& $need $cap1 'VerifiedReferences' 'CAPTURE_INCOMPLETE') $true
        $leaf = @($verifiedRefs | Where-Object { $_.Role -ceq 'STDOUT' })
        if ($leaf.Count -ne 1) { & $halt 'INVALID' 'CAPTURE_STDOUT_LEAF' }
        $leaf = $leaf[0]
        $snap1 = $null
        try { $snap1 = & $snapshot $cap1 } catch { $snap1 = $null }
        $sessionCopy = [string]$sess

        # ---- SDK observer over the single verified stdout leaf ----
        $sdkStatus = 'UNKNOWN'; $sdkCode = 'SDK_OBSERVER_EXCEPTION'
        $sdkRes = $null
        try {
            $sdkRes = Get-ManagedNativeSdkObservation -StdoutPath ([string]$leaf.Path) -ExpectedStdoutSha256 ([string]$leaf.VerifiedSha256) -ExpectedStdoutLength ([long]$leaf.VerifiedLength) -ExpectedSessionId $sessionCopy
        } catch { $sdkRes = $null }
        if ($null -ne $sdkRes) {
            try {
                if ((@($sdkRes).Count -ne 1) -or (-not (& $isObj $sdkRes))) { & $halt 'INVALID' 'SDK_RESULT_MALFORMED' }
                if ((& $need $sdkRes 'Schema' 'SDK_RESULT_MALFORMED') -cne 'ManagedNativeSdkObservation/v1') { & $halt 'INVALID' 'SDK_RESULT_MALFORMED' }
                $ss = & $need $sdkRes 'Status' 'SDK_RESULT_MALFORMED'
                if (($ss -isnot [string]) -or (@('OBSERVED', 'UNKNOWN', 'INVALID') -cnotcontains $ss)) { & $halt 'INVALID' 'SDK_RESULT_MALFORMED' }
                foreach ($fl in @('NoAcceptedUsage', 'NoReceipt', 'NoCompletion', 'NoDispatch')) {
                    if ((& $need $sdkRes $fl 'SDK_RESULT_MALFORMED') -isnot [bool] -or (-not (& $need $sdkRes $fl 'SDK_RESULT_MALFORMED'))) { & $halt 'INVALID' 'SDK_RESULT_MALFORMED' }
                }
                $vr = & $need $sdkRes 'VerifiedRaw' 'SDK_RESULT_MALFORMED'
                if ($null -ne $vr) {
                    if (-not (& $isObj $vr)) { & $halt 'INVALID' 'SDK_RAW_INCONSISTENT' }
                    $vp = & $need $vr 'Path' 'SDK_RAW_INCONSISTENT'; $vh = & $need $vr 'Sha256' 'SDK_RAW_INCONSISTENT'; $vl = & $need $vr 'Length' 'SDK_RAW_INCONSISTENT'
                    if (($vp -isnot [string]) -or ($vp -cne [string]$leaf.Path) -or ($vh -isnot [string]) -or ($vh -cne [string]$leaf.VerifiedSha256) -or (-not (& $isInt $vl)) -or ([long]$vl -ne [long]$leaf.VerifiedLength)) { & $halt 'INVALID' 'SDK_RAW_INCONSISTENT' }
                }
                elseif ($ss -ceq 'OBSERVED') { & $halt 'INVALID' 'SDK_RAW_INCONSISTENT' }
                $sc = & $need $sdkRes 'Code' 'SDK_RESULT_MALFORMED'
                $sdkStatus = $ss; $sdkCode = & $codeOf $sc 'SDK_CODE_MALFORMED'
                $nul = { param($v, [string]$n) if (($null -ne $v) -and (-not (& $isInt $v))) { & $halt 'INVALID' 'SDK_RESULT_MALFORMED' }; if ($null -eq $v) { return $null }; return [long]$v }
                $sdk = [pscustomobject]([ordered]@{
                    Schema = 'ManagedNativeSdkObservation/v1'; Status = $ss; Code = $sdkCode
                    SdkOutcome = (& $need $sdkRes 'SdkOutcome' 'SDK_RESULT_MALFORMED'); SdkSubtype = (& $need $sdkRes 'SdkSubtype' 'SDK_RESULT_MALFORMED')
                    SdkStopReason = (& $need $sdkRes 'SdkStopReason' 'SDK_RESULT_MALFORMED'); SdkTerminalReason = (& $need $sdkRes 'SdkTerminalReason' 'SDK_RESULT_MALFORMED')
                    SdkErrors = $(
                        $e = & $need $sdkRes 'SdkErrors' 'SDK_RESULT_MALFORMED'
                        if ($null -eq $e) { $null } else {
                            if (($e -isnot [object[]]) -and ($e -isnot [string[]])) { & $halt 'INVALID' 'SDK_RESULT_MALFORMED' }
                            foreach ($ei in $e) { if ($ei -isnot [string]) { & $halt 'INVALID' 'SDK_RESULT_MALFORMED' } }
                            , ([string[]]$e)
                        })
                    SdkReportedOutputTokens = (& $nul (& $need $sdkRes 'SdkReportedOutputTokens' 'SDK_RESULT_MALFORMED') 'r')
                    RecountedOutputTokens = (& $nul (& $need $sdkRes 'RecountedOutputTokens' 'SDK_RESULT_MALFORMED') 'c')
                    RecountStatus = (& $need $sdkRes 'RecountStatus' 'SDK_RESULT_MALFORMED'); Consistency = (& $need $sdkRes 'Consistency' 'SDK_RESULT_MALFORMED')
                    MessageStarts = (& $nul (& $need $sdkRes 'MessageStarts' 'SDK_RESULT_MALFORMED') 'm')
                    VerifiedRaw = $(if ($null -eq $vr) { $null } else { [pscustomobject]([ordered]@{ Path = [string]$vr.Path; Sha256 = [string]$vr.Sha256; Length = [long]$vr.Length }) })
                    NoAcceptedUsage = $true; NoReceipt = $true; NoCompletion = $true; NoDispatch = $true })
            }
            catch {
                $m = [string]$_.Exception.Message
                $sdk = $null
                if ($m -cmatch '^BIND:INVALID:([A-Z0-9_]{1,48})\z') { $sdkStatus = 'INVALID'; $sdkCode = $Matches[1] }
                else { $sdkStatus = 'UNKNOWN'; $sdkCode = 'SDK_OBSERVER_EXCEPTION' }
            }
        }

        # ---- exactly one recapture of the same immutable tuple, before anything is published ----
        $recStatus = 'SAME'; $recCode = $null
        try {
            $cap2 = & $capture
            if ($null -eq $snap1) { $recStatus = 'UNKNOWN'; $recCode = 'RECAPTURE_COMPARE_UNAVAILABLE' }
            else {
                $snap2 = $null
                try { $snap2 = & $snapshot $cap2 } catch { $snap2 = $null }
                if ($null -eq $snap2) { $recStatus = 'UNKNOWN'; $recCode = 'RECAPTURE_COMPARE_UNAVAILABLE' }
                elseif (-not [string]::Equals($snap1, $snap2, $ord)) { $recStatus = 'INVALID'; $recCode = 'RECAPTURE_CHANGED' }
            }
        }
        catch {
            $m = [string]$_.Exception.Message
            if ($m -cmatch '^BIND:INVALID:') { $recStatus = 'INVALID'; $recCode = 'RECAPTURE_INVALID' }
            else { $recStatus = 'UNKNOWN'; $recCode = 'RECAPTURE_UNKNOWN' }
        }

        $recDriven = ($recStatus -cne 'SAME')
        # Precedence: known SDK INVALID, then recapture INVALID/change, then recapture UNKNOWN, then the SDK status.
        if ($sdkStatus -ceq 'INVALID') { $status = 'INVALID'; $code = $sdkCode; $reason = 'SDK observation is invalid; no usage is accepted.' }
        elseif ($recStatus -ceq 'INVALID') { $status = 'INVALID'; $code = $recCode; $reason = 'Transport capture was invalid or changed across the observation; no usage is accepted.' }
        elseif ($recStatus -ceq 'UNKNOWN') { $status = 'UNKNOWN'; $code = $recCode; $reason = 'Transport capture stability could not be re-established; no usage is accepted.' }
        elseif ($sdkStatus -ceq 'OBSERVED') { $status = 'OBSERVED'; $code = 'OUTPUT_OBSERVATION_BOUND'; $reason = 'SDK result observed over the verified stdout leaf; capture unchanged across one recapture. Observation only, not authority.' }
        else { $status = 'UNKNOWN'; $code = $sdkCode; $reason = 'SDK result could not be fully observed; no usage is accepted and nothing is implied zero.' }
    }
    catch {
        $m = [string]$_.Exception.Message
        if ($m -cmatch '^BIND:(INVALID|UNKNOWN):([A-Z0-9_]{1,48})\z') {
            $status = $Matches[1]; $code = $Matches[2]
            $reason = $(if ($status -ceq 'INVALID') { 'Input or captured evidence is invalid; no usage is accepted.' } else { 'Evidence could not be fully observed; no usage is accepted.' })
        }
        else { $status = 'UNKNOWN'; $code = 'OUTPUT_OBSERVATION_UNEXPECTED_ERROR'; $reason = 'Output observation failed unexpectedly; no usage is accepted.' }
    }
    # Verified references appear only when a stable complete capture yielded exactly one verified STDOUT leaf and the observer produced a result.
    if ($recDriven -or (($status -ceq 'UNKNOWN') -and ($null -eq $sdk))) { $verifiedRefs = @() }
    return [pscustomobject]([ordered]@{
        Schema = 'ManagedNativeOutputObservation/v1'
        Status = $status; Code = $code; Reason = $reason
        Evidence = $evidenceCopy
        DeclaredReferences = @($declared); VerifiedReferences = @($verifiedRefs)
        SdkObservation = $sdk
        NoAcceptedUsage = $true; NoReceipt = $true; NoCompletion = $true; NoDispatch = $true })
}
