function Get-ReviewedAHostAssociation139 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$ReviewedBinding,
        [Parameter(Mandatory = $true)][AllowNull()][object]$StateDir,
        [Parameter(Mandatory = $true)][AllowNull()][object]$PreviousSelectedClaim,
        [Parameter(Mandatory = $true)][AllowNull()][object]$TerminalArguments
    )

    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest

    try {
        $ord = [System.StringComparison]::Ordinal
        $eq = { param($a, $b) ($a -is [string]) -and ($b -is [string]) -and [string]::Equals($a, $b, $ord) }
        $str = { param($v) if ($v -isnot [string] -or $v.Length -eq 0) { throw 'invalid' }; [string]::new($v.ToCharArray()) }
        $hash = { param($v) if ($v -isnot [string] -or $v -cnotmatch '\A[0-9a-f]{64}\z') { throw 'invalid' }; [string]::new($v.ToCharArray()) }
        $path = {
            param($v)
            if ($v -isnot [string] -or $v.Length -eq 0 -or $v.IndexOf([char]0) -ge 0) { throw 'invalid' }
            if (-not [System.IO.Path]::IsPathFullyQualified($v) -or -not [string]::Equals([System.IO.Path]::GetFullPath($v), $v, $ord)) { throw 'invalid' }
            [string]::new($v.ToCharArray())
        }
        $pos = { param($v) if (($v -isnot [int] -and $v -isnot [long]) -or $v -le 0) { throw 'invalid' }; [long]$v }
        $get = { param($o, [string]$n) if ($o -is [System.Collections.IDictionary]) { $o[$n] } else { $o.PSObject.Properties[$n].Value } }
        # Exact NoteProperty set; returns name -> value (references only; values cloned by callers).
        $note = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { throw 'invalid' }
            $props = @($o.PSObject.Properties)
            if ($props.Count -ne $names.Count) { throw 'invalid' }
            $allowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($n in $names) { $null = $allowed.Add($n) }
            $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            # Pass 1: metadata only, no Value access.
            foreach ($p in $props) {
                if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty -or -not $allowed.Contains($p.Name) -or -not $seen.Add($p.Name)) { throw 'invalid' }
            }
            # Pass 2: values.
            $out = [ordered]@{}
            foreach ($p in $props) { $out[[string]$p.Name] = $p.Value }
            $out
        }

        # Capture every caller-supplied value before any import or data IO.
        $b = & $note $ReviewedBinding @('prelaunch', 'terminalBinding', 'reviewCompletion', 'registrationFileSha256', 'terminalBindingFileSha256', 'reviewCompletionFileSha256')
        $regFileSha = & $hash $b['registrationFileSha256']
        $tbFileSha = & $hash $b['terminalBindingFileSha256']
        $rcFileSha = & $hash $b['reviewCompletionFileSha256']
        $selNames = @('id', 'owner', 'provider', 'route', 'claimId', 'intentId', 'kind', 'receiptSha', 'planSha', 'statePath')
        $pscIn = & $note $PreviousSelectedClaim $selNames
        $psc = [ordered]@{}
        foreach ($n in $selNames) { $psc[$n] = & $str $pscIn[$n] }
        $stateDir = & $path $StateDir
        $taNames = @('RawPath', 'TicketPath', 'UsagePath', 'RunId', 'Attempt', 'MaxAttempts', 'PriorElapsedMs', 'MaxElapsedMs', 'ReceiptPath', 'CompletedNativeEvidence')
        $obsName = 'ObserveOnlyReviewedCompletionEvidence'
        if ($TerminalArguments -isnot [hashtable]) { throw 'invalid' }
        # Explicit exact-ordinal eleven-key branch; the original ten-key branch is selected only when the key is absent.
        $newMode = $false
        foreach ($tk in @($TerminalArguments.Keys)) { if ($tk -is [string] -and [string]::Equals($tk, $obsName, $ord)) { $newMode = $true } }
        if ($newMode) {
            $taNames = $taNames + @($obsName)
            foreach ($tk in @($TerminalArguments.Keys)) { if ($tk -isnot [string] -or $taNames -cnotcontains $tk) { throw 'invalid' } }
        }
        if ($TerminalArguments.Count -ne $taNames.Count) { throw 'invalid' }
        $clone = {
            param($v, [int]$depth)
            if ($depth -gt 16) { throw 'invalid' }
            if ($null -eq $v) { return $null }
            if ($v -is [string]) { return [string]::new($v.ToCharArray()) }
            if ($v -is [bool] -or $v -is [int] -or $v -is [long] -or $v -is [double]) { return $v }
            if ($v -is [System.Management.Automation.PSCustomObject]) {
                $o = [ordered]@{}
                foreach ($q in @($v.PSObject.Properties)) {
                    if ($q.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty -or $o.Contains([string]$q.Name)) { throw 'invalid' }
                    $o[[string]$q.Name] = & $clone $q.Value ($depth + 1)
                }
                return [pscustomobject]$o
            }
            if ($v -is [object[]]) {
                $l = [System.Collections.Generic.List[object]]::new()
                foreach ($x in $v) { $l.Add((& $clone $x ($depth + 1))) }
                return , $l.ToArray()
            }
            throw 'invalid'
        }
        $ta = @{}
        foreach ($n in $taNames) {
            if (-not $TerminalArguments.ContainsKey($n)) { throw 'invalid' }
            $v = $TerminalArguments[$n]
            if ($n -in 'RawPath', 'TicketPath', 'UsagePath', 'ReceiptPath') { $ta[$n] = & $path $v }
            elseif ($n -eq 'RunId') { $ta[$n] = & $str $v }
            elseif ($n -eq 'CompletedNativeEvidence') {
                $cnIn = & $note $v @('pid', 'startIdentity', 'artifactPath')
                $ta[$n] = @{ pid = (& $pos $cnIn['pid']); startIdentity = (& $str $cnIn['startIdentity']); artifactPath = (& $path $cnIn['artifactPath']) }
            }
            elseif ($n -ceq $obsName) {
                $oe = & $note $v @('schema', 'accountingEvidence', 'registrationRef', 'terminalBindingRef', 'reviewCompletionRef')
                if (-not (& $eq $oe['schema'] 'ManagedObserveReviewedCompletionEvidence/v1')) { throw 'invalid' }
                $ta[$n] = & $clone $v 0
            }
            elseif ($n -eq 'PriorElapsedMs') {
                if (($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0) { throw 'invalid' }
                $ta[$n] = $v
            }
            elseif ($n -eq 'MaxElapsedMs' -and $newMode -and $null -eq $v) { $ta[$n] = $null }
            else { $ta[$n] = $v; $null = & $pos $v }
        }

        # Accepted helpers, function-local scope only; none is invoked beyond the calls below.
        $root = $PSScriptRoot
        . (Join-Path $root 'registered-review-completion-capture.ps1')
        . (Join-Path $root 'registered-review-record-reader.ps1')
        . (Join-Path $root 'select-next-ready.ps1')
        . (Join-Path (Join-Path (Split-Path -Parent $root) 'dispatch') 'managed-native-receipt.ps1')

        $c = Get-RegisteredReviewCompletionCapture -CapturedPrelaunch $b['prelaunch'] -TerminalBinding $b['terminalBinding'] -TerminalBindingSha256 $tbFileSha -ReviewCompletion $b['reviewCompletion']
        $reg = $c.prelaunch.registration
        $tb = $c.terminalBinding
        if (-not (& $eq $regFileSha $c.prelaunch.expectedRegistrationSha256)) { throw 'invalid' }

        if ($newMode) {
            # Observe-only reviewed completion: every native fact comes from the Slice1 authenticated facts (streamed, pinned stdout leaf; null stream cap).
            $of = Get-ManagedObserveReviewedCompletionFacts -Evidence $ta[$obsName]
            if ($null -eq $of -or $of.Valid -isnot [bool] -or -not $of.Valid -or $null -eq $of.Facts) { throw 'invalid' }
            $pf = $of.Facts.pending
            $pr = $of.Facts.proof
            $eqi = { param($a, $b) ($a -is [string]) -and ($b -is [string]) -and [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase) }
            # Proof binds exactly the supplied reviewed binding, A record and previous selected claim.
            if (-not (& $eq $pr.registrationRef.sha256 $regFileSha) -or -not (& $eq $pr.terminalBindingRef.sha256 $tbFileSha) -or -not (& $eq $pr.reviewCompletionRef.sha256 $rcFileSha)) { throw 'invalid' }
            if (-not (& $eq $pr.taskId $reg.taskId) -or -not (& $eq $pr.runId $tb.runId) -or [long]$pr.attempt -ne [long]$tb.attempt) { throw 'invalid' }
            if (-not (& $eq $pr.requestSha256 $tb.requestSha256) -or -not (& $eq $pr.terminalSha256 $tb.terminalSha256) -or -not (& $eq $pr.startSha256 $tb.startSha256)) { throw 'invalid' }
            if (-not (& $eqi $pr.candidatePath $tb.candidatePath) -or -not (& $eq $pr.candidateSha256 $tb.candidateSha256) -or -not (& $eqi $pr.ackSnapshotPath $tb.ackPath) -or -not (& $eq $pr.ackSnapshotSha256 $tb.ackSha256)) { throw 'invalid' }
            if (-not (& $eqi $pf.references.ticket.path $reg.ticketPath) -or -not (& $eq $pf.references.ticket.verifiedSha256 $reg.ticketSha256)) { throw 'invalid' }
            foreach ($n in 'id', 'owner', 'claimId', 'intentId', 'receiptSha', 'planSha') {
                if (-not (& $eq $pr.claim.$n $psc[$n])) { throw 'invalid' }
            }
            if (-not (& $eqi $pr.claim.statePath $psc['statePath']) -or -not (& $eqi $pr.stateDir $stateDir)) { throw 'invalid' }
            if ($pr.ackMode -isnot [bool] -or -not $pr.ackMode -or $pr.onStartedAcknowledged -isnot [bool] -or -not $pr.onStartedAcknowledged -or $pr.verdict -cne 'PASS_SCOPED') { throw 'invalid' }

            # Host terminal arguments vs the verified A record.
            if (-not (& $eq $ta['TicketPath'] $reg.ticketPath) -or -not (& $eq $ta['RunId'] $tb.runId) -or [long]$ta['Attempt'] -ne [long]$tb.attempt) { throw 'invalid' }
            # CompletedNativeEvidence is an equality cross-check of native pid/start/artifact only, never authentication.
            $cn = $ta['CompletedNativeEvidence']
            if ([long]$cn['pid'] -ne [long]$pr.pid -or -not (& $eqi $cn['artifactPath'] $pr.candidatePath) -or -not (& $eq $cn['startIdentity'] $pr.startIdentity)) { throw 'invalid' }
            $nPid = [long]$pr.pid
            $nStart = [string]$pr.startIdentity

            # Raw DTO cross-check through the accepted shared comparer against the authenticated facts.
            $rv = Test-ManagedObserveReviewedRawDto -RawPath $ta['RawPath'] -ExpectedSha256 $null -Facts $of.Facts
            if ($null -eq $rv -or $rv.Valid -isnot [bool] -or -not $rv.Valid) { throw 'invalid' }

            # Verified streamed stdout reference: same leaf, ordinary file, recorded length and streamed SHA-256; no byte materialization, no stream cap.
            if (-not (& $eqi $ta['UsagePath'] $pf.stdout.path)) { throw 'invalid' }
            $usageFile = [System.IO.FileInfo]::new($ta['UsagePath'])
            if (-not $usageFile.Exists -or ($usageFile.Attributes -band ([System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint)) -ne 0 -or $usageFile.Length -ne [long]$pf.stdout.length) { throw 'invalid' }
            $us = [System.IO.FileStream]::new($ta['UsagePath'], [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            try {
                if ($us.Length -ne [long]$pf.stdout.length) { throw 'invalid' }
                $usageSha = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::Create().ComputeHash($us)).ToLowerInvariant()
            } finally { $us.Dispose() }
            if (-not (& $eq $usageSha $pf.stdout.sha256)) { throw 'invalid' }
        }
        else {
            $fr = Get-ManagedNativeCapturedFacts -ManifestPath $tb.manifestPath -ExpectedManifestSha256 $tb.manifestSha256 -TerminalPath $tb.terminalPath -ExpectedTerminalSha256 $tb.terminalSha256 -TicketPath $reg.ticketPath -RunId $tb.runId -Attempt ([int]$tb.attempt)
            if ($fr.Valid -isnot [bool] -or -not $fr.Valid -or $null -eq $fr.Facts) { throw 'invalid' }
            $f = $fr.Facts
            if (-not (& $eq $f.RunDir $reg.runDir) -or -not (& $eq $f.StartPath $tb.startPath) -or -not (& $eq $f.StartSha256 $tb.startSha256) -or -not (& $eq $f.RequestSha256 $tb.requestSha256)) { throw 'invalid' }

            # Host terminal arguments vs the verified A record.
            if (-not (& $eq $ta['TicketPath'] $reg.ticketPath) -or -not (& $eq $ta['RunId'] $tb.runId) -or [long]$ta['Attempt'] -ne [long]$tb.attempt) { throw 'invalid' }
            $cn = $ta['CompletedNativeEvidence']
            if ([long]$cn['pid'] -ne [long]$f.Pid -or -not (& $eq $cn['artifactPath'] $f.ArtifactPath) -or -not (& $eq $cn['startIdentity'] $f.Terminal.startTimeUtc)) { throw 'invalid' }
            $sid = $f.Ticket.sessionId

            # Raw trace must match native terminal and ticket.
            $rawFile = [System.IO.FileInfo]::new($ta['RawPath'])
            if (-not $rawFile.Exists -or ($rawFile.Attributes -band ([System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint)) -ne 0 -or $rawFile.Length -gt 1048576) { throw 'invalid' }
            $rawText = [System.Text.UTF8Encoding]::new($false, $true).GetString([System.IO.File]::ReadAllBytes($ta['RawPath']))
            $raw = ConvertFrom-Json -InputObject $rawText.TrimStart([char]0xFEFF) -DateKind String
            if ((& $get $raw 'status') -cne 'TERMINAL' -or [long](& $get $raw 'pid') -ne [long]$f.Pid -or [long](& $get $raw 'exit') -ne [long]$f.Terminal.exitCode) { throw 'invalid' }
            if (-not (& $eq (& $get $raw 'startUtc') $f.Terminal.startTimeUtc) -or -not (& $eq (& $get $raw 'endUtc') $f.Terminal.endedUtc) -or -not (& $eq (& $get $raw 'session') $sid)) { throw 'invalid' }

            # Usage is raw stdout bytes, bounded by maxStreamBytes, hash-bound to terminal.stdout.sha256.
            if (-not (& $eq $ta['UsagePath'] $f.StdoutPath)) { throw 'invalid' }
            $usageFile = [System.IO.FileInfo]::new($ta['UsagePath'])
            if (-not $usageFile.Exists -or ($usageFile.Attributes -band ([System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint)) -ne 0 -or $usageFile.Length -gt [long]$f.Core.maxStreamBytes) { throw 'invalid' }
            $usage = [System.IO.File]::ReadAllBytes($ta['UsagePath'])
            $usageSha = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($usage)).ToLowerInvariant()
            if (-not (& $eq $usageSha $f.Terminal.stdout.sha256) -or $usage.Length -ne $f.StdoutBytes.Length) { throw 'invalid' }

            $nPid = [long]$f.Pid
            $nStart = [string]$f.Start.startTimeUtc
        }

        # Retained A ACK snapshot bound by terminalBinding ackPath/SHA; selected claim must be in it.
        $ack = Read-RegisteredReviewRecord -Path $tb.ackPath -ExpectedSha256 $tb.ackSha256
        $map = Test-HostDispatchAcknowledgementEnvelope -AckState $ack.record
        $key = $psc['intentId'] + '|' + $psc['claimId']
        if (-not $map.Contains($key)) { throw 'invalid' }
        $e = $map[$key]
        if (-not (& $eq $psc['statePath'] (Join-Path $stateDir 'continuation-state.json'))) { throw 'invalid' }
        if (-not (& $eq (& $get $e 'entryId') $psc['id'])) { throw 'invalid' }
        foreach ($n in 'owner', 'claimId', 'intentId') {
            if (-not (& $eq (& $get $e $n) $psc[$n])) { throw 'invalid' }
        }
        $eb = & $get $e 'executionBinding'
        if (-not (& $eq (& $get $eb 'receiptSha') $psc['receiptSha']) -or -not (& $eq (& $get $eb 'planSha') $psc['planSha'])) { throw 'invalid' }
        $ae = $eb
        $idn = & $get $ae 'identity'
        $startId = $nStart
        if (-not (& $eq (& $get $ae 'taskId') $psc['id']) -or -not (& $eq (& $get $ae 'taskId') $reg.taskId)) { throw 'invalid' }
        if (-not (& $eq (& $get $ae 'runId') $tb.runId) -or [long](& $get $ae 'attempt') -ne [long]$tb.attempt) { throw 'invalid' }
        if (-not (& $eq (& $get $idn 'kind') 'native') -or [long](& $get $idn 'pid') -ne $nPid -or -not (& $eq (& $get $idn 'startIdentity') $startId) -or -not (& $eq (& $get $e 'dispatchedAt') $startId)) { throw 'invalid' }

        [pscustomobject]@{
            schema                = 'ReviewedAHostAssociation/v1'
            TerminalArguments     = $ta
            PreviousSelectedClaim = [pscustomobject]$psc
            StateDir              = $stateDir
        }
    }
    catch {
        throw 'REVIEWED_A_HOST_ASSOCIATION_INVALID'
    }
}
