function Get-RegisteredReviewReplayContext {
    [CmdletBinding()]
    param(
        [Parameter()][AllowNull()][object]$RegistrationPath,
        [Parameter()][AllowNull()][object]$ExpectedRegistrationSha256,
        [Parameter()][AllowNull()][object]$ExpectedTerminalBindingSha256,
        [Parameter()][AllowNull()][object]$ExpectedReviewCompletionSha256,
        [Parameter()][AllowNull()][object]$OnReviewedTerminal
    )

    $invalid = 'REGISTERED_REVIEW_REPLAY_INVALID'

    try {
        # ---- Capture and validate caller scalars + handler before any import or IO ----
        if ($RegistrationPath -isnot [string] -or $OnReviewedTerminal -isnot [scriptblock]) { throw $invalid }
        foreach ($h in @($ExpectedRegistrationSha256, $ExpectedTerminalBindingSha256, $ExpectedReviewCompletionSha256)) {
            if ($h -isnot [string] -or $h.Length -ne 64 -or $h -cnotmatch '\A[0-9a-f]{64}\z') { throw $invalid }
        }
        $pathText = [string]$RegistrationPath
        if ([string]::IsNullOrWhiteSpace($pathText) -or $pathText.IndexOf([char]0) -ge 0) { throw $invalid }
        if (-not [System.IO.Path]::IsPathFullyQualified($pathText)) { throw $invalid }
        if ([System.IO.Path]::GetFullPath($pathText) -cne $pathText) { throw $invalid }
        $regSha = [string]$ExpectedRegistrationSha256
        $termSha = [string]$ExpectedTerminalBindingSha256
        $revSha = [string]$ExpectedReviewCompletionSha256
        $handler = $OnReviewedTerminal

        # ---- Function-local imports of the exact accepted siblings ----
        . (Join-Path $PSScriptRoot 'registered-review-record-reader.ps1')
        . (Join-Path $PSScriptRoot 'registered-review-prelaunch-capture.ps1')
        . (Join-Path $PSScriptRoot 'registered-review-completion-capture.ps1')
        . (Join-Path $PSScriptRoot 'registered-review-record-binding.ps1')

        # ---- Local helpers (pure / read-only) ----
        $cap = 1048576
        $ord = [System.StringComparison]::Ordinal
        $ordIc = [System.StringComparison]::OrdinalIgnoreCase
        $eq = { param($a, $b) ($a -is [string]) -and ($b -is [string]) -and [string]::Equals($a, $b, $ord) }
        $get = { param($o, [string]$n) $o.PSObject.Properties[$n].Value }
        $shape = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { throw 'x' }
            $props = @($o.PSObject.Properties)
            if ($props.Count -ne $names.Count) { throw 'x' }
            $set = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($n in $names) { [void]$set.Add($n) }
            foreach ($p in $props) {
                if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw 'x' }
                if (-not $set.Remove([string]$p.Name)) { throw 'x' }
            }
            if ($set.Count -ne 0) { throw 'x' }
        }
        $hasName = {
            param($o, [string]$n)
            foreach ($p in @($o.PSObject.Properties)) { if ([string]::Equals([string]$p.Name, $n, $ord)) { return $true } }
            return $false
        }
        $str = { param($v) if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v)) { throw 'x' }; [string]$v }
        $lower64 = { param($v) if ($v -isnot [string] -or $v -cnotmatch '\A[0-9a-f]{64}\z') { throw 'x' }; [string]$v }
        $posInt = {
            param($v)
            if ($v -is [int]) { if ($v -le 0) { throw 'x' }; return [long]([int]$v) }
            if ($v -is [long]) { if ($v -le 0) { throw 'x' }; return [long]$v }
            throw 'x'
        }
        $natInt = {
            param($v)
            if ($v -is [int]) { if ($v -lt 0) { throw 'x' }; return [long]([int]$v) }
            if ($v -is [long]) { if ($v -lt 0) { throw 'x' }; return [long]$v }
            throw 'x'
        }
        $fullPath = {
            param($v)
            if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v) -or $v.IndexOf([char]0) -ge 0) { throw 'x' }
            if (-not [System.IO.Path]::IsPathFullyQualified($v)) { throw 'x' }
            [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($v))
        }
        $samePath = {
            param($a, $b)
            [string]::Equals((& $fullPath $a), (& $fullPath $b), $ordIc)
        }
        $sha256Bytes = { param([byte[]]$b) [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
        $sha256Text = { param([string]$s) & $sha256Bytes ([System.Text.UTF8Encoding]::new($false).GetBytes($s)) }
        $readBin = {
            param([string]$p)
            $info = [System.IO.FileInfo]::new($p)
            if (-not $info.Exists) { throw 'x' }
            $bad = [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint
            if (($info.Attributes -band $bad) -ne 0) { throw 'x' }
            if ($info.Length -gt $cap) { throw 'x' }
            $fs = $null
            try {
                $fs = [System.IO.FileStream]::new($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read, 4096, [System.IO.FileOptions]::None)
                $buf = [byte[]]::new($cap + 1)
                $t = 0
                while ($t -lt $buf.Length) {
                    $n = $fs.Read($buf, $t, $buf.Length - $t)
                    if ($n -le 0) { break }
                    $t += $n
                }
                if ($t -gt $cap) { throw 'x' }
                $out = [byte[]]::new($t)
                [System.Array]::Copy($buf, 0, $out, 0, $t)
                , $out
            }
            finally { if ($null -ne $fs) { $fs.Dispose() } }
        }
        $strictJson = {
            param([byte[]]$b)
            $off = 0
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $off = 3 }
            $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($b, $off, $b.Length - $off)
            ConvertFrom-Json -InputObject $text -DateKind String -NoEnumerate
        }

        # ---- Registration (single prelaunch read) and review-pending decision ----
        $regRead = Read-RegisteredReviewRecord -Path $pathText -ExpectedSha256 $regSha
        $pre = Get-RegisteredReviewPrelaunchCapture -Registration $regRead.record -ExpectedRegistrationSha256 $regSha -OnReviewedTerminal $handler
        $reg = $pre.registration
        $reviewRecPath = [string]$reg.reviewCompletionPath
        if ([System.IO.Directory]::Exists($reviewRecPath)) { throw $invalid }
        if (-not [System.IO.File]::Exists($reviewRecPath)) { throw 'REVIEW_PENDING' }

        # ---- Original captured binding (122) ----
        $binding = Get-RegisteredReviewRecordBinding -RegistrationPath $pathText -ExpectedRegistrationSha256 $regSha `
            -ExpectedTerminalBindingSha256 $termSha -ExpectedReviewCompletionSha256 $revSha -OnReviewedTerminal $handler
        $tb = $binding.terminalBinding
        $rc = $binding.reviewCompletion
        $reg = $binding.prelaunch.registration
        $taskId = [string]$reg.taskId
        $attempt = [long]$reg.attempt
        $runDir = [string]$reg.runDir

        # ---- Raw request (119 reader) ----
        $reqRead = Read-RegisteredReviewRecord -Path $reg.requestPath -ExpectedSha256 $reg.requestSha256
        $rr = $reqRead.record
        $reqKnown = @('RunId','Attempt','TicketPath','PayloadPath','GateTicketPath','SettingsPath','ArtifactPath','WorkingDirectory','Arguments','MaxElapsedMs','MaxStreamBytes','TokenAccountingPolicy','StructuredOutputProfile')
        $reqProps = @($rr.PSObject.Properties)
        $hasTap = $false; $hasProf = $false
        foreach ($p in $reqProps) {
            if ($reqKnown -cnotcontains [string]$p.Name) { throw $invalid }
            if ([string]$p.Name -ceq 'TokenAccountingPolicy') { $hasTap = $true }; if ([string]$p.Name -ceq 'StructuredOutputProfile') { $hasProf = $true }
        }
        if ($reqProps.Count -ne (11 + [int]$hasTap + [int]$hasProf)) { throw $invalid }
        $request = @{}
        foreach ($p in $reqProps) {
            $n = [string]$p.Name
            $v = $p.Value
            if ($n -ceq 'TokenAccountingPolicy') {
                if ($v -isnot [System.Management.Automation.PSCustomObject]) { throw $invalid }
                & $shape $v @('MaxMessages','MaxEvents','MaxLineBytes','MaxInputBytes')
                $ht = @{}
                foreach ($q in @($v.PSObject.Properties)) { $ht[[string]$q.Name] = $q.Value }
                $request[$n] = $ht
            }
            elseif ($n -ceq 'StructuredOutputProfile') { if ($v -isnot [string] -or $v -cne 'canonical8-v1') { throw $invalid }; $request[$n] = [string]$v } elseif ($n -ceq 'Arguments') {
                if ($v -isnot [object[]]) { throw $invalid }
                $a = [object[]]::new($v.Count)
                [System.Array]::Copy($v, $a, $v.Count)
                $request[$n] = $a
            }
            else { $request[$n] = $v }
        }
        if (-not (& $eq $request['RunId'] $taskId)) { throw $invalid }
        if ([long](& $posInt $request['Attempt']) -ne $attempt) { throw $invalid }
        if (-not (& $eq $request['TicketPath'] $reg.ticketPath)) { throw $invalid }
        if (-not (& $eq $request['PayloadPath'] $reg.payloadPath)) { throw $invalid }
        if (-not (& $eq $request['ArtifactPath'] $reg.candidatePath)) { throw $invalid }
        $gatePath = [string](& $str $request['GateTicketPath'])
        $settingsPath = [string](& $str $request['SettingsPath'])
        [void](& $fullPath $gatePath); [void](& $fullPath $settingsPath); [void](& $fullPath $request['WorkingDirectory'])

        # ---- Data-file bytes ----
        $ticketBytes = & $readBin $reg.ticketPath
        if (-not (& $eq (& $sha256Bytes $ticketBytes) $reg.ticketSha256)) { throw $invalid }
        $payloadBytes = & $readBin $reg.payloadPath
        if (-not (& $eq (& $sha256Bytes $payloadBytes) $reg.payloadSha256)) { throw $invalid }
        $gateSha = & $sha256Bytes (& $readBin $gatePath)
        $settingsSha = & $sha256Bytes (& $readBin $settingsPath)
        $candBytes = & $readBin $tb.candidatePath
        $candSha = & $sha256Bytes $candBytes
        if (-not (& $eq $candSha $tb.candidateSha256)) { throw $invalid }
        $reviewSha = & $sha256Bytes (& $readBin $rc.reviewPath)
        if (-not (& $eq $reviewSha $rc.reviewSha256)) { throw $invalid }

        # ---- Manifest ----
        foreach ($f in @('manifestPath','startPath','terminalPath')) {
            $leaf = @{ manifestPath = 'manifest.json'; startPath = 'start.json'; terminalPath = 'terminal.json' }[$f]
            if (-not (& $samePath $tb.$f (Join-Path $runDir $leaf))) { throw $invalid }
        }
        $manRead = Read-RegisteredReviewRecord -Path $tb.manifestPath -ExpectedSha256 $tb.manifestSha256
        $man = $manRead.record
        & $shape $man @('schema','requestCanonical','requestSha256','reservedUtc','gateStatus','gateResultSha256')
        $canonText = & $get $man 'requestCanonical'
        if ($canonText -isnot [string] -or $canonText.Length -eq 0) { throw $invalid }
        $canonSha = & $sha256Text $canonText
        if (-not (& $eq $canonSha (& $lower64 (& $get $man 'requestSha256')))) { throw $invalid }
        if (-not (& $eq $canonSha $tb.requestSha256)) { throw $invalid }
        $core = ConvertFrom-Json -InputObject $canonText -DateKind String -NoEnumerate
        if ($core -isnot [System.Management.Automation.PSCustomObject]) { throw $invalid }
        $coreVal = { param($n) if (-not (& $hasName $core $n)) { throw 'x' }; & $get $core $n }
        if (-not (& $eq (& $coreVal 'schema') 'ManagedNativeCollector/v1')) { throw $invalid }
        if (-not (& $eq (& $coreVal 'runId') $taskId)) { throw $invalid }
        if ([long](& $posInt (& $coreVal 'attempt')) -ne $attempt) { throw $invalid }
        if (-not (& $samePath (& $coreVal 'runDir') $runDir)) { throw $invalid }
        if (-not (& $eq (& $coreVal 'ticketPath') $reg.ticketPath)) { throw $invalid }
        if (-not (& $eq (& $coreVal 'ticketSha256') $reg.ticketSha256)) { throw $invalid }
        if (-not (& $eq (& $coreVal 'payloadPath') $reg.payloadPath)) { throw $invalid }
        if (-not (& $eq (& $coreVal 'payloadSha256') $reg.payloadSha256)) { throw $invalid }
        if (-not (& $eq (& $coreVal 'artifactPath') $reg.candidatePath)) { throw $invalid }
        if (-not (& $samePath (& $coreVal 'gateTicketPath') $gatePath)) { throw $invalid }
        if (-not (& $eq (& $coreVal 'gateTicketSha256') $gateSha)) { throw $invalid }
        if (-not (& $samePath (& $coreVal 'settingsPath') $settingsPath)) { throw $invalid }
        if (-not (& $eq (& $coreVal 'settingsSha256') $settingsSha)) { throw $invalid }
        if (-not (& $samePath (& $coreVal 'workingDirectory') $request['WorkingDirectory'])) { throw $invalid }
        if ((& $natInt (& $coreVal 'maxElapsedMs')) -ne (& $natInt $request['MaxElapsedMs'])) { throw $invalid }
        if ((& $natInt (& $coreVal 'maxStreamBytes')) -ne (& $natInt $request['MaxStreamBytes'])) { throw $invalid }
        if ((& $hasName $core 'tokenAccountingPolicy') -ne $hasTap) { throw $invalid }
        if ((& $hasName $core 'nativeStructuredOutput') -ne $hasProf) { throw $invalid }
        if ($hasProf) {
            $nso = $core.PSObject.Properties['nativeStructuredOutput'].Value
            if ($nso -isnot [System.Management.Automation.PSCustomObject]) { throw $invalid }
            if (@($nso.PSObject.Properties).Count -ne 2) { throw $invalid }
            $nsoNames = @($nso.PSObject.Properties | ForEach-Object { [string]$_.Name })
            if (-not ($nsoNames -ccontains 'profileId') -or -not ($nsoNames -ccontains 'schemaSha256')) { throw $invalid }
            $nsoId =$nso.PSObject.Properties['profileId']
            $nsoSha = $nso.PSObject.Properties['schemaSha256']
            if ($null -eq $nsoId -or $null -eq $nsoSha) { throw $invalid }
            if ($nsoId.Value -isnot [string] -or $nsoId.Value -cne 'canonical8-v1') { throw $invalid }
            if ($nsoSha.Value -isnot [string] -or $nsoSha.Value -cne 'fd655794f2298daf88877d652f94736ed2e74cf520b3278f694b141d492b8cfa') { throw $invalid }
        }

        # Canonical vs raw arguments (direct property access: no pipeline unrolling)
        if (-not (& $hasName $core 'arguments')) { throw $invalid }
        $canonArgs = $core.PSObject.Properties['arguments'].Value
        $rawArgs = $request['Arguments']
        if ($canonArgs -isnot [object[]] -or $rawArgs -isnot [object[]] -or $canonArgs.Length -ne $rawArgs.Length) { throw $invalid }
        for ($i = 0; $i -lt $rawArgs.Length; $i++) {
            if ($canonArgs[$i] -isnot [string] -or $rawArgs[$i] -isnot [string]) { throw $invalid }
            if (-not [string]::Equals([string]$canonArgs[$i], [string]$rawArgs[$i], $ord)) { throw $invalid }
        }

        # Canonical vs raw token accounting policy, bound to captured ticket budget
        if ($hasTap) {
            $rawTap = $request['TokenAccountingPolicy']
            $rawTapNames = @('MaxMessages', 'MaxEvents', 'MaxLineBytes', 'MaxInputBytes')
            if ($rawTap.Count -ne 4) { throw $invalid }
            foreach ($n in $rawTapNames) { if (-not $rawTap.ContainsKey($n)) { throw $invalid } }
            $canonTap = $core.PSObject.Properties['tokenAccountingPolicy'].Value
            & $shape $canonTap ($rawTapNames + @('RemainingTokens', 'HistoricalOutputTokens', 'AdditionalOutputMax', 'PhaseAggregateCeiling'))
            foreach ($n in $rawTapNames) {
                if ((& $natInt $rawTap[$n]) -ne (& $natInt (& $get $canonTap $n))) { throw $invalid }
            }
            $ticketDoc = & $strictJson $ticketBytes
            if ($ticketDoc -isnot [System.Management.Automation.PSCustomObject]) { throw $invalid }
            $budgetOwner = $ticketDoc
            if (-not (& $hasName $budgetOwner 'budget') -and (& $hasName $ticketDoc 'private')) { $budgetOwner = $ticketDoc.PSObject.Properties['private'].Value }
            if ($budgetOwner -isnot [System.Management.Automation.PSCustomObject] -or -not (& $hasName $budgetOwner 'budget')) { throw $invalid }
            $budget = $budgetOwner.PSObject.Properties['budget'].Value
            if ($budget -isnot [System.Management.Automation.PSCustomObject]) { throw $invalid }
            foreach ($n in @('historicalOutputTokens', 'additionalOutputMax', 'phaseAggregateCeiling')) { if (-not (& $hasName $budget $n)) { throw $invalid } }
            $hist = [long](& $natInt (& $get $budget 'historicalOutputTokens'))
            $addMax = [long](& $posInt (& $get $budget 'additionalOutputMax'))
            $phaseMax = [long](& $posInt (& $get $budget 'phaseAggregateCeiling'))
            if ($phaseMax -le $hist) { throw $invalid }
            $remaining = [Math]::Min($addMax, $phaseMax - $hist)
            if ((& $natInt (& $get $canonTap 'HistoricalOutputTokens')) -ne $hist) { throw $invalid }
            if ((& $natInt (& $get $canonTap 'AdditionalOutputMax')) -ne $addMax) { throw $invalid }
            if ((& $natInt (& $get $canonTap 'PhaseAggregateCeiling')) -ne $phaseMax) { throw $invalid }
            if ((& $natInt (& $get $canonTap 'RemainingTokens')) -ne $remaining) { throw $invalid }
        }
        $ackMode = & $coreVal 'ackMode'
        if ($ackMode -isnot [bool] -or $ackMode -ne $true) { throw $invalid }
        $ackCtx = & $coreVal 'ackContext'
        & $shape $ackCtx @('stateDir','taskId','claim')
        $stateDir = & $fullPath (& $str (& $get $ackCtx 'stateDir'))
        $ctxTaskId = [string](& $str (& $get $ackCtx 'taskId'))
        $claimSrc = & $get $ackCtx 'claim'
        $claimNames = @('id','owner','claimId','intentId','receiptSha','planSha','statePath')
        & $shape $claimSrc $claimNames
        $claimOut = [ordered]@{}
        foreach ($n in $claimNames) {
            $cv = & $str (& $get $claimSrc $n)
            if ($n -ceq 'receiptSha' -or $n -ceq 'planSha') { $cv = & $lower64 $cv }
            $claimOut[$n] = $cv
        }
        if (-not (& $samePath $claimOut['statePath'] (Join-Path $stateDir 'continuation-state.json'))) { throw $invalid }
        $claim = [pscustomobject]$claimOut

        # ---- Start / terminal ----
        $startRead = Read-RegisteredReviewRecord -Path $tb.startPath -ExpectedSha256 $tb.startSha256
        $start = $startRead.record
        & $shape $start @('schema','runId','attempt','requestSha256','pid','startTimeUtc','persistedUtc')
        if (-not (& $eq (& $get $start 'schema') 'ManagedNativeStart/v1')) { throw $invalid }
        if (-not (& $eq (& $get $start 'runId') $taskId)) { throw $invalid }
        if ([long](& $posInt (& $get $start 'attempt')) -ne $attempt) { throw $invalid }
        if (-not (& $eq (& $get $start 'requestSha256') $canonSha)) { throw $invalid }
        $pidValue = [long](& $posInt (& $get $start 'pid'))
        $startTime = [string](& $str (& $get $start 'startTimeUtc'))
        [void](& $str (& $get $start 'persistedUtc'))

        $termRead = Read-RegisteredReviewRecord -Path $tb.terminalPath -ExpectedSha256 $tb.terminalSha256
        $term = $termRead.record
        if (-not (& $eq (& $get $term 'schema') 'ManagedNativeTerminal/v1')) { throw $invalid }
        if (-not (& $eq (& $get $term 'runId') $taskId)) { throw $invalid }
        if ([long](& $posInt (& $get $term 'attempt')) -ne $attempt) { throw $invalid }
        if (-not (& $eq (& $get $term 'requestSha256') $canonSha)) { throw $invalid }
        foreach ($f in @('pid', 'startTimeUtc', 'ticketSha256', 'payloadSha256', 'gateTicketSha256', 'settingsSha256', 'manifestSha256')) {
            if (-not (& $hasName $term $f)) { throw $invalid }
        }
        if ([long](& $posInt (& $get $term 'pid')) -ne $pidValue) { throw $invalid }
        if (-not (& $eq (& $get $term 'startTimeUtc') $startTime)) { throw $invalid }
        if (-not (& $eq (& $lower64 (& $get $term 'ticketSha256')) $reg.ticketSha256)) { throw $invalid }
        if (-not (& $eq (& $lower64 (& $get $term 'payloadSha256')) $reg.payloadSha256)) { throw $invalid }
        if (-not (& $eq (& $lower64 (& $get $term 'gateTicketSha256')) $gateSha)) { throw $invalid }
        if (-not (& $eq (& $lower64 (& $get $term 'settingsSha256')) $settingsSha)) { throw $invalid }
        if (-not (& $eq (& $lower64 (& $get $term 'manifestSha256')) $tb.manifestSha256)) { throw $invalid }
        foreach ($f in @('definitive','exitObserved','onStartedAcknowledged','drainComplete')) {
            $fv = & $get $term $f
            if ($fv -isnot [bool] -or $fv -ne $true) { throw $invalid }
        }
        $artNames = @('path','state','sha256','length')
        if (-not (& $hasName $term 'artifact')) { throw $invalid }
        $artifact = $term.PSObject.Properties['artifact'].Value
        & $shape $artifact $artNames
        if (-not (& $eq (& $get $artifact 'state') 'PRESENT')) { throw $invalid }
        if (-not (& $eq (& $get $artifact 'path') $reg.candidatePath)) { throw $invalid }
        if (-not (& $eq (& $lower64 (& $get $artifact 'sha256')) $candSha)) { throw $invalid }
        if ((& $natInt (& $get $artifact 'length')) -ne [long]$candBytes.Length) { throw $invalid }

        # ---- Immutable ACK snapshot ----
        $ackRead = Read-RegisteredReviewRecord -Path $tb.ackPath -ExpectedSha256 $tb.ackSha256
        $ackRoot = $ackRead.record
        & $shape $ackRoot @('schema','acknowledgements')
        if (-not (& $eq (& $get $ackRoot 'schema') 'host-dispatch-acknowledgement/v1')) { throw $invalid }
        $acks = & $get $ackRoot 'acknowledgements'
        $key = $claim.intentId + '|' + $claim.claimId
        $found = [System.Collections.Generic.List[object]]::new()
        if ($acks -is [System.Management.Automation.PSCustomObject]) {
            foreach ($p in @($acks.PSObject.Properties)) {
                if ([string]::Equals([string]$p.Name, $key, $ord)) { $found.Add($p.Value) }
            }
        }
        else { throw $invalid }
        if ($found.Count -ne 1) { throw $invalid }
        $entry = $found[0]
        & $shape $entry @('schema','recordedAt','entryId','owner','claimId','intentId','dispatchedAt','executionBinding')
        if (-not (& $eq (& $get $entry 'schema') 'host-dispatch-acknowledgement/v1')) { throw $invalid }
        $parsedAt = [datetime]::MinValue
        foreach ($f in @('recordedAt', 'dispatchedAt')) {
            $tv = & $str (& $get $entry $f)
            if (-not [datetime]::TryParse($tv, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsedAt)) { throw $invalid }
        }
        if (-not (& $eq (& $get $entry 'dispatchedAt') $startTime)) { throw $invalid }
        if (-not (& $eq (& $get $entry 'entryId') $claim.id)) { throw $invalid }
        if (-not (& $eq (& $get $entry 'owner') $claim.owner)) { throw $invalid }
        if (-not (& $eq (& $get $entry 'claimId') $claim.claimId)) { throw $invalid }
        if (-not (& $eq (& $get $entry 'intentId') $claim.intentId)) { throw $invalid }
        $eb = & $get $entry 'executionBinding'
        & $shape $eb @('schema','taskId','ticketSha256','payloadSha256','runId','attempt','receiptSha','planSha','identity')
        if (-not (& $eq (& $get $eb 'schema') 'host-dispatch-execution-binding/v1')) { throw $invalid }
        if (-not (& $eq (& $get $eb 'taskId') $ctxTaskId)) { throw $invalid }
        if (-not (& $eq (& $get $eb 'ticketSha256') $reg.ticketSha256)) { throw $invalid }
        if (-not (& $eq (& $get $eb 'payloadSha256') $reg.payloadSha256)) { throw $invalid }
        if (-not (& $eq (& $get $eb 'runId') $taskId)) { throw $invalid }
        if ([long](& $posInt (& $get $eb 'attempt')) -ne $attempt) { throw $invalid }
        if (-not (& $eq (& $get $eb 'receiptSha') $claim.receiptSha)) { throw $invalid }
        if (-not (& $eq (& $get $eb 'planSha') $claim.planSha)) { throw $invalid }
        $ident = & $get $eb 'identity'
        & $shape $ident @('kind','pid','startIdentity')
        if (-not (& $eq (& $get $ident 'kind') 'native')) { throw $invalid }
        if ([long](& $posInt (& $get $ident 'pid')) -ne $pidValue) { throw $invalid }
        if (-not (& $eq (& $get $ident 'startIdentity') $startTime)) { throw $invalid }

        # ---- Existing projection (must already exist; never created) ----
        $projPath = Join-Path $runDir 'projection.json'
        $projBytes = & $readBin $projPath
        $proj = & $strictJson $projBytes
        & $shape $proj @('schema','runId','attempt','requestSha256','status','attempts','terminalSha256','lastErrorCode','result')
        if (-not (& $eq (& $get $proj 'schema') 'ManagedNativeProjection/v1')) { throw $invalid }
        if (-not (& $eq (& $get $proj 'runId') $taskId)) { throw $invalid }
        if ([long](& $posInt (& $get $proj 'attempt')) -ne $attempt) { throw $invalid }
        if (-not (& $eq (& $get $proj 'requestSha256') $canonSha)) { throw $invalid }
        $status = & $get $proj 'status'
        if ($status -isnot [string] -or ($status -cne 'PENDING' -and $status -cne 'DONE')) { throw $invalid }

        # ---- Fingerprint (immutable tuple only; no projection lifecycle fields) ----
        $tuple = [ordered]@{
            registrationFileSha256     = [string]$binding.registrationFileSha256
            terminalBindingFileSha256  = [string]$binding.terminalBindingFileSha256
            reviewCompletionFileSha256 = [string]$binding.reviewCompletionFileSha256
            rawRequestSha256           = [string]$reg.requestSha256
            manifestSha256             = [string]$tb.manifestSha256
            startSha256                = [string]$tb.startSha256
            terminalSha256             = [string]$tb.terminalSha256
            candidateSha256            = [string]$candSha
            ackSnapshotSha256          = [string]$tb.ackSha256
            reviewSha256               = [string]$reviewSha
            ticketSha256               = [string]$reg.ticketSha256
            payloadSha256              = [string]$reg.payloadSha256
            gateTicketSha256           = [string]$gateSha
            settingsSha256             = [string]$settingsSha
            runId                      = [string]$taskId
            attempt                    = [long]$attempt
            pid                        = [long]$pidValue
            startTimeUtc               = [string]$startTime
        }
        $fingerprint = & $sha256Text (ConvertTo-Json -InputObject $tuple -Compress -Depth 3)

        return [pscustomobject][ordered]@{
            schema                       = 'RegisteredReviewReplayContext/v1'
            binding                      = $binding
            request                      = $request
            runDir                       = $runDir
            startAcknowledgementContext  = @{ StateDir = $stateDir; TaskId = $ctxTaskId; SelectedClaim = $claim }
            fingerprint                  = $fingerprint
        }
    }
    catch {
        if ($_.Exception.Message -ceq 'REVIEW_PENDING') { throw 'REVIEW_PENDING' }
        throw $invalid
    }
}