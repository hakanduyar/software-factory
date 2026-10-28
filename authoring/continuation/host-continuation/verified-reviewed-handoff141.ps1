function Invoke-VerifiedReviewedHostHandoff141 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$ReviewedBinding,
        [Parameter(Mandatory)][hashtable]$HostArguments,
        [Parameter(Mandatory)][object]$ExpectedSuccessor
    )
    $ErrorActionPreference = 'Stop'
    $fail = { param($why) throw ('REVIEWED_HANDOFF_UNRESOLVED: {0}' -f $why) }
    $names = {
        param($o)
        if ($o -is [System.Collections.IDictionary]) { @($o.Keys | ForEach-Object { [string]$_ }) }
        else { @($o.PSObject.Properties | ForEach-Object { $_.Name }) }
    }
    $get = {
        param($o, [string]$k)
        if ($o -is [System.Collections.IDictionary]) { $o[$k] } else { $o.PSObject.Properties[$k].Value }
    }
    $exact = {
        param($o, [string[]]$want, [string]$what)
        if ($null -eq $o) { & $fail "$what null" }
        $n = [string[]]@(& $names $o)
        if ($n.Count -ne $want.Count) { & $fail "$what shape" }
        $a = [string[]]$n.Clone(); $b = [string[]]$want.Clone()
        [Array]::Sort($a, [StringComparer]::Ordinal); [Array]::Sort($b, [StringComparer]::Ordinal)
        for ($i = 0; $i -lt $a.Count; $i++) { if ($a[$i] -cne $b[$i]) { & $fail "$what shape" } }
    }
    $str = { param($v, $w) if ($v -isnot [string] -or $v.Length -eq 0) { & $fail "$w invalid" }; [string]::new($v.ToCharArray()) }
    $sha = { param($v, $w) $x = & $str $v $w; if ($x -cnotmatch '^[0-9a-f]{64}$') { & $fail "$w invalid" }; $x }
    $pth = {
        param($v, $w)
        $x = & $str $v $w
        if (-not [System.IO.Path]::IsPathRooted($x) -or [System.IO.Path]::GetFullPath($x) -cne $x) { & $fail "$w invalid" }
        $x
    }
    $pos = { param($v, $w) if (($v -isnot [int] -and $v -isnot [long]) -or [long]$v -lt 1) { & $fail "$w invalid" }; [long]$v }
    $same = { param($a, $b, $w) if ("$a" -cne "$b" -or $null -eq $a) { & $fail "$w mismatch" } }

    $stage = 'INPUT_CAPTURE'
    try {
        # ---- capture ExpectedSuccessor: all metadata first, then typed scalar clones ----
        $expKeys = 'taskId','owner','receiptSha256','planSha256','ticketSha256','payloadSha256','runId','attempt','stateDir','runDir'
        if ($null -eq $ExpectedSuccessor -or $ExpectedSuccessor -is [System.Collections.IDictionary]) { & $fail 'expected invalid' }
        $props = @($ExpectedSuccessor.PSObject.Properties)
        foreach ($p in $props) { if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { & $fail 'expected member type' } }
        & $exact $ExpectedSuccessor $expKeys 'expected'
        $E = [ordered]@{
            taskId        = & $str $ExpectedSuccessor.PSObject.Properties['taskId'].Value 'taskId'
            owner         = & $str $ExpectedSuccessor.PSObject.Properties['owner'].Value 'owner'
            receiptSha256 = & $sha $ExpectedSuccessor.PSObject.Properties['receiptSha256'].Value 'receiptSha256'
            planSha256    = & $sha $ExpectedSuccessor.PSObject.Properties['planSha256'].Value 'planSha256'
            ticketSha256  = & $sha $ExpectedSuccessor.PSObject.Properties['ticketSha256'].Value 'ticketSha256'
            payloadSha256 = & $sha $ExpectedSuccessor.PSObject.Properties['payloadSha256'].Value 'payloadSha256'
            runId         = & $str $ExpectedSuccessor.PSObject.Properties['runId'].Value 'runId'
            attempt       = & $pos $ExpectedSuccessor.PSObject.Properties['attempt'].Value 'attempt'
            stateDir      = & $pth $ExpectedSuccessor.PSObject.Properties['stateDir'].Value 'stateDir'
            runDir        = & $pth $ExpectedSuccessor.PSObject.Properties['runDir'].Value 'runDir'
        }

        # ---- shallow HostArguments snapshot (incl. Dispatch handle) ----
        $snap = @{}
        foreach ($k in @($HostArguments.Keys)) {
            if ($k -isnot [string]) { & $fail 'host argument key' }
            $snap[$k] = $HostArguments[$k]
        }
        foreach ($k in 'TerminalArguments','PreviousSelectedClaim','Dispatch','StateDir','Owner') {
            if (-not $snap.ContainsKey($k) -or $null -eq $snap[$k]) { & $fail "host argument $k missing" }
        }
        if ($snap['Dispatch'] -isnot [scriptblock]) { & $fail 'Dispatch invalid' }
        $hostOwner = & $str $snap['Owner'] 'HostOwner'

        # ---- function-local imports ----
        $stage = 'PINNED_DEPENDENCY_IMPORT'
        $dir = $PSScriptRoot
        if ([string]::IsNullOrEmpty($dir)) { & $fail 'import directory unknown' }
        $pA = Join-Path $dir 'reviewed-a-association139.ps1'
        $pS = Join-Path $dir 'persisted-successor-ack140.ps1'
        $pH = Join-Path $dir 'select-next-ready.ps1'
        foreach ($f in $pA, $pS, $pH) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { & $fail 'import missing' } }
        if ((Get-FileHash -LiteralPath $pA -Algorithm SHA256).Hash.ToLowerInvariant() -cne '48bec6217d1603a663a3bb5110e640e92c00df8b65538698833e925e83c0c8e2') { & $fail 'association hash' }
        if ((Get-FileHash -LiteralPath $pS -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'e434aa773b71b92b9b64de884c5827f77122824f0147c83240cf82c694095bc7') { & $fail 'successor hash' }
        . $pA
        . $pS
        . $pH

        # ---- A association (once) ----
        $stage = 'A_ASSOCIATION139'
        $assoc = Get-ReviewedAHostAssociation139 -ReviewedBinding $ReviewedBinding -StateDir $snap['StateDir'] `
            -PreviousSelectedClaim $snap['PreviousSelectedClaim'] -TerminalArguments $snap['TerminalArguments']
        if (@($assoc).Count -ne 1) { & $fail 'association output' }
        & $exact $assoc 'schema','TerminalArguments','PreviousSelectedClaim','StateDir' 'association'
        & $same (& $get $assoc 'schema') 'ReviewedAHostAssociation/v1' 'association schema'
        $aTA = & $get $assoc 'TerminalArguments'
        $aPrev = & $get $assoc 'PreviousSelectedClaim'
        $aState = & $get $assoc 'StateDir'
        if ($aTA -isnot [System.Collections.IDictionary] -or $null -eq $aPrev) { & $fail 'association captures' }
        & $same $aState $E.stateDir 'StateDir'
        & $same $hostOwner $E.owner 'HostOwner'

        # ---- bridge CompletedNativeEvidence Hashtable -> exact3 PSCustomObject ----
        $ta = @{}
        foreach ($k in @($aTA.Keys)) { $ta[$k] = $aTA[$k] }
        $cn = $ta['CompletedNativeEvidence']
        if ($cn -isnot [hashtable]) { & $fail 'CompletedNativeEvidence invalid' }
        & $exact $cn 'pid','startIdentity','artifactPath' 'CompletedNativeEvidence'
        $ta['CompletedNativeEvidence'] = [pscustomobject][ordered]@{
            pid           = $cn['pid']
            startIdentity = $cn['startIdentity']
            artifactPath  = $cn['artifactPath']
        }

        # ---- existing host, once ----
        $ha = @{}
        foreach ($k in @($snap.Keys)) { $ha[$k] = $snap[$k] }
        $ha['TerminalArguments'] = $ta
        $ha['PreviousSelectedClaim'] = $aPrev
        $ha['StateDir'] = $aState
        $stage = 'HOST_CONTINUATION'
        $r = Invoke-PublishedSettledHostContinuation @ha
        if (@($r).Count -ne 1 -or $null -eq $r) { & $fail 'host output' }

        $status = & $get $r 'status'
        $disp = & $get $r 'dispatched'
        if ($status -isnot [string] -or $disp -isnot [bool]) { & $fail 'host outcome' }
        $waiting = $false
        if ($status -ceq 'DISPATCHED' -and $disp -eq $true) { }
        elseif ($status -ceq 'WAITING' -and $disp -eq $false) {
            $nt = & $get $r 'nextTrigger'
            if ($nt -isnot [string] -or $nt -cne 'claim-ack-reconciliation') { & $fail 'nextTrigger' }
            $waiting = $true
        }
        else { & $fail 'host outcome' }

        # ---- independent 142 verification (both branches) ----
        $stage = 'PERSISTED_ACK142'
        $ver = Get-VerifiedPersistedSuccessorAck140 -ExpectedSuccessor ([pscustomobject]$E)
        if (@($ver).Count -ne 1) { & $fail 'verifier output' }
        & $exact $ver 'schema','claimId','intentId','nativePid','nativeStart','ExpectedSuccessor' 'verified'
        & $same (& $get $ver 'schema') 'VerifiedPersistedSuccessorAck/v1' 'verified schema'
        $vClaim = & $str (& $get $ver 'claimId') 'claimId'
        $vIntent = & $str (& $get $ver 'intentId') 'intentId'
        $vPid = & $pos (& $get $ver 'nativePid') 'nativePid'
        $vStart = & $get $ver 'nativeStart'
        if ($null -eq $vStart -or $vStart -is [System.Collections.IEnumerable] -and $vStart -isnot [string] -or "$vStart".Length -eq 0) { & $fail 'nativeStart invalid' }
        $vExp = & $get $ver 'ExpectedSuccessor'
        & $exact $vExp $expKeys 'verified expected'
        foreach ($k in $expKeys) { & $same (& $get $vExp $k) $E[$k] "verified expected $k" }

        $stage = 'ACK_BINDING'
        if (-not $waiting) {
            $sel = & $get (& $get $r 'decision') 'selected'
            & $exact $sel 'id','owner','provider','route','claimId','intentId','kind','receiptSha','planSha','statePath' 'selected'
            & $same (& $get $sel 'id') $E.taskId 'selected id'
            & $same (& $get $sel 'owner') $E.owner 'selected owner'
            & $same (& $get $sel 'claimId') $vClaim 'selected claimId'
            & $same (& $get $sel 'intentId') $vIntent 'selected intentId'
            & $same (& $get $sel 'receiptSha') $E.receiptSha256 'selected receiptSha'
            & $same (& $get $sel 'planSha') $E.planSha256 'selected planSha'

            $ack = & $get $r 'acknowledged'
            & $exact $ack 'schema','recordedAt','entryId','owner','claimId','intentId','dispatchedAt','executionBinding' 'acknowledged'
            & $same (& $get $ack 'entryId') $E.taskId 'ack entryId'
            & $same (& $get $ack 'owner') $E.owner 'ack owner'
            & $same (& $get $ack 'claimId') $vClaim 'ack claimId'
            & $same (& $get $ack 'intentId') $vIntent 'ack intentId'
            & $same (& $get $ack 'dispatchedAt') $vStart 'ack dispatchedAt'
            $eb = & $get $ack 'executionBinding'
            & $exact $eb 'schema','taskId','ticketSha256','payloadSha256','runId','attempt','receiptSha','planSha','identity' 'executionBinding'
            & $same (& $get $eb 'taskId') $E.taskId 'exec taskId'
            & $same (& $get $eb 'ticketSha256') $E.ticketSha256 'exec ticket'
            & $same (& $get $eb 'payloadSha256') $E.payloadSha256 'exec payload'
            & $same (& $get $eb 'runId') $E.runId 'exec runId'
            if ((& $pos (& $get $eb 'attempt') 'exec attempt') -ne $E.attempt) { & $fail 'exec attempt mismatch' }
            & $same (& $get $eb 'receiptSha') $E.receiptSha256 'exec receipt'
            & $same (& $get $eb 'planSha') $E.planSha256 'exec plan'
            $id = & $get $eb 'identity'
            & $exact $id 'kind','pid','startIdentity' 'identity'
            & $same (& $get $id 'kind') 'native' 'native kind'
            if ((& $pos (& $get $id 'pid') 'identity pid') -ne $vPid) { & $fail 'identity pid mismatch' }
            & $same (& $get $id 'startIdentity') $vStart 'identity start'
        }

        [pscustomobject][ordered]@{
            status      = 'DURABLE_SUCCESSOR_ACK'
            ackRecorded = $true
            replay      = [bool]$waiting
            claimId     = $vClaim
            intentId    = $vIntent
            nativePid   = $vPid
            nativeStart = $vStart
        }
    }
    catch {
        # diagnostic only: emit allowlisted stage literal, never the raw message
        # stage values are fixed literals set above
        throw ('REVIEWED_HANDOFF_UNRESOLVED:{0}' -f $stage)
    }
}