function Get-RegisteredReviewCompletionCapture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$CapturedPrelaunch,
        [Parameter(Mandatory = $true)][AllowNull()][object]$TerminalBinding,
        [Parameter(Mandatory = $true)][AllowNull()][object]$TerminalBindingSha256,
        [Parameter(Mandatory = $true)][AllowNull()][object]$ReviewCompletion
    )

    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest

    try {
        $fail = { throw 'invalid' }

        # Exact unordered NoteProperty name set, checked before any value is read.
        $shape = {
            param($o, [string[]]$names)
            if ($o -isnot [System.Management.Automation.PSCustomObject]) { throw 'invalid' }
            $props = @($o.PSObject.Properties)
            if ($props.Count -ne $names.Count) { throw 'invalid' }
            $set = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($n in $names) { [void]$set.Add($n) }
            foreach ($p in $props) {
                if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw 'invalid' }
                if (-not $set.Remove([string]$p.Name)) { throw 'invalid' }
            }
            if ($set.Count -ne 0) { throw 'invalid' }
        }
        $get = { param($o, [string]$n) $o.PSObject.Properties[$n].Value }
        $str = {
            param($v)
            if ($v -isnot [string] -or $v.Length -eq 0) { throw 'invalid' }
            [string]::new(([string]$v).ToCharArray())
        }
        $hash = {
            param($v)
            if ($v -isnot [string] -or $v -cnotmatch '\A[0-9a-f]{64}\z') { throw 'invalid' }
            [string]::new(([string]$v).ToCharArray())
        }
        $path = {
            param($v)
            if ($v -isnot [string] -or $v.Length -eq 0 -or $v.IndexOf([char]0) -ge 0) { throw 'invalid' }
            if (-not [System.IO.Path]::IsPathFullyQualified($v)) { throw 'invalid' }
            if (-not [string]::Equals([System.IO.Path]::GetFullPath($v), $v, [System.StringComparison]::Ordinal)) { throw 'invalid' }
            [string]::new(([string]$v).ToCharArray())
        }
        $posInt = {
            param($v)
            if ($v -is [int]) { if ($v -le 0) { throw 'invalid' }; return [long]([int]$v) }
            if ($v -is [long]) { if ($v -le 0) { throw 'invalid' }; return [long]$v }
            throw 'invalid'
        }
        $eq = { param([string]$a, [string]$b) [string]::Equals($a, $b, [System.StringComparison]::Ordinal) }

        $outerNames = @('registration', 'expectedRegistrationSha256', 'onReviewedTerminal')
        $regNames = @('schema', 'registrationId', 'taskId', 'attempt', 'requestPath', 'requestSha256', 'runDir',
            'ticketPath', 'ticketSha256', 'payloadPath', 'payloadSha256', 'candidatePath', 'terminalBindingPath',
            'reviewCompletionPath', 'automationId', 'automationTargetThreadId', 'periodMinutes', 'registeredActionId')
        $termNames = @('schema', 'registrationId', 'registrationSha256', 'requestSha256', 'runId', 'attempt',
            'manifestPath', 'manifestSha256', 'startPath', 'startSha256', 'terminalPath', 'terminalSha256',
            'candidatePath', 'candidateSha256', 'ackPath', 'ackSha256')
        $revNames = @('schema', 'registrationId', 'registrationSha256', 'terminalBindingSha256', 'candidateSha256',
            'terminalSha256', 'reviewPath', 'reviewSha256', 'verdict')

        # Metadata of all supplied objects first, then values.
        & $shape $CapturedPrelaunch $outerNames
        & $shape $TerminalBinding $termNames
        & $shape $ReviewCompletion $revNames
        $bindingHash = & $hash $TerminalBindingSha256

        # Recapture prelaunch through the accepted sibling, function-local scope only.
        $siblingPath = Join-Path $PSScriptRoot 'registered-review-prelaunch-capture.ps1'
        . $siblingPath
        $inReg = & $get $CapturedPrelaunch 'registration'
        $inSha = & $get $CapturedPrelaunch 'expectedRegistrationSha256'
        $inHandle = & $get $CapturedPrelaunch 'onReviewedTerminal'
        $re = Get-RegisteredReviewPrelaunchCapture -Registration $inReg -ExpectedRegistrationSha256 $inSha -OnReviewedTerminal $inHandle
        & $shape $re $outerNames
        $reg = & $get $re 'registration'
        & $shape $reg $regNames
        $expectedRegSha = & $hash (& $get $re 'expectedRegistrationSha256')
        $handle = & $get $re 'onReviewedTerminal'

        # Fresh scalar clone of the registration.
        $regClone = [ordered]@{}
        foreach ($n in $regNames) {
            $v = & $get $reg $n
            if ($n -eq 'attempt') { $regClone[$n] = & $posInt $v }
            elseif ($n -eq 'periodMinutes') {
                if ($v -isnot [int] -or $v -le 0) { throw 'invalid' }
                $regClone[$n] = [int]$v
            }
            else { $regClone[$n] = & $str $v }
        }
        $regObj = [pscustomobject]$regClone

        # Terminal binding (16 fields).
        $t = @{}
        foreach ($n in $termNames) {
            $v = & $get $TerminalBinding $n
            switch -CaseSensitive ($n) {
                'attempt' { $t[$n] = & $posInt $v }
                { $_ -in 'registrationSha256', 'requestSha256', 'manifestSha256', 'startSha256', 'terminalSha256', 'candidateSha256', 'ackSha256' } { $t[$n] = & $hash $v }
                { $_ -in 'manifestPath', 'startPath', 'terminalPath', 'candidatePath', 'ackPath' } { $t[$n] = & $path $v }
                default { $t[$n] = & $str $v }
            }
        }
        if (-not (& $eq $t['schema'] 'RegisteredReviewTerminalBinding/v1')) { throw 'invalid' }

        # Review completion (9 fields).
        $r = @{}
        foreach ($n in $revNames) {
            $v = & $get $ReviewCompletion $n
            switch -CaseSensitive ($n) {
                { $_ -in 'registrationSha256', 'terminalBindingSha256', 'candidateSha256', 'terminalSha256', 'reviewSha256' } { $r[$n] = & $hash $v }
                'reviewPath' { $r[$n] = & $path $v }
                default { $r[$n] = & $str $v }
            }
        }
        if (-not (& $eq $r['schema'] 'RegisteredIndependentReviewCompletion/v1')) { throw 'invalid' }
        if (-not (& $eq $r['verdict'] 'PASS_SCOPED')) { throw 'invalid' }

        # Terminal binding vs prelaunch registration.
        if (-not (& $eq $t['registrationId'] $regObj.registrationId)) { throw 'invalid' }
        if (-not (& $eq $t['registrationSha256'] $expectedRegSha)) { throw 'invalid' }
        if (-not (& $eq $t['runId'] $regObj.taskId)) { throw 'invalid' }
        if ([long]$t['attempt'] -ne [long]$regObj.attempt) { throw 'invalid' }
        $regCandidate = [System.IO.Path]::GetFullPath([string]$regObj.candidatePath)
        if (-not (& $eq $t['candidatePath'] $regCandidate)) { throw 'invalid' }

        # Review completion vs prelaunch and terminal tuple.
        if (-not (& $eq $r['registrationId'] $regObj.registrationId)) { throw 'invalid' }
        if (-not (& $eq $r['registrationSha256'] $expectedRegSha)) { throw 'invalid' }
        if (-not (& $eq $r['terminalBindingSha256'] $bindingHash)) { throw 'invalid' }
        if (-not (& $eq $r['terminalSha256'] $t['terminalSha256'])) { throw 'invalid' }
        if (-not (& $eq $r['candidateSha256'] $t['candidateSha256'])) { throw 'invalid' }

        $termOut = [ordered]@{}
        foreach ($n in $termNames) { $termOut[$n] = $t[$n] }
        $revOut = [ordered]@{}
        foreach ($n in $revNames) { $revOut[$n] = $r[$n] }

        [pscustomobject]@{
            prelaunch        = [pscustomobject]@{
                registration               = $regObj
                expectedRegistrationSha256 = $expectedRegSha
                onReviewedTerminal         = $handle
            }
            terminalBinding  = [pscustomobject]$termOut
            reviewCompletion = [pscustomobject]$revOut
        }
    }
    catch {
        throw 'REGISTERED_REVIEW_REPLAY_INVALID'
    }
}