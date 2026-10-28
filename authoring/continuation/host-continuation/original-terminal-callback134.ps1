# Administrative original callback recipe. Installed before the genuine native job.
# This file does not issue admission, interpret an LLM completion as acceptance,
# or dispatch a successor. The independently reviewed host handoff is supplied.
function New-GenuineTerminalCallback134 {
    param(
        [Parameter(Mandatory)][string]$RegistrationPath,
        [Parameter(Mandatory)][string]$RegistrationSha256,
        [Parameter(Mandatory)][hashtable]$Request,
        [Parameter(Mandatory)][string]$RunDir,
        [Parameter(Mandatory)][string]$AckPath,
        [Parameter(Mandatory)][scriptblock]$ReviewedHandoff
    )
    $regBytes = [IO.File]::ReadAllBytes($RegistrationPath)
    $actualRegSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($regBytes)).ToLowerInvariant()
    if (-not [string]::Equals($actualRegSha,$RegistrationSha256,[StringComparison]::Ordinal)) { throw 'REGISTRATION_CHANGED_BEFORE_CALLBACK_CAPTURE' }
    $reg = [Text.Encoding]::UTF8.GetString($regBytes) | ConvertFrom-Json -DateKind String -NoEnumerate
    $capturedRequest = $Request | ConvertTo-Json -Depth 30 -Compress | ConvertFrom-Json -AsHashtable
    $capturedRunDir = [IO.Path]::GetFullPath($RunDir)
    $capturedAckPath = [IO.Path]::GetFullPath($AckPath)
    $capturedRegSha = $RegistrationSha256
    $capturedHandoff = $ReviewedHandoff
    $snapshotPath = Join-Path (Split-Path $RegistrationPath -Parent) 'original-ack-snapshot134.json'
    return {
        param($terminalRef)
        # Two exact interfaces of the SAME presealed handle: original collector
        # produces ref10; accepted130 supplies its verified fresh binding6.
        if ($terminalRef -isnot [pscustomobject]) { throw 'CALLBACK_INPUT_INVALID' }
        $properties = @($terminalRef.PSObject.Properties)
        $handoffNames = @('prelaunch','terminalBinding','reviewCompletion','registrationFileSha256','terminalBindingFileSha256','reviewCompletionFileSha256')
        $producerNames = @('RunId','Attempt','RunDir','RequestSha256','ManifestPath','ManifestSha256','StartPath','TerminalPath','TerminalSha256','Terminal')
        $names = if ($properties.Count -eq 6) { $handoffNames } elseif ($properties.Count -eq 10) { $producerNames } else { throw 'CALLBACK_INPUT_INVALID' }
        $nameSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($n in $names) { [void]$nameSet.Add($n) }
        foreach ($p in $properties) {
            if ($p.MemberType -ne [Management.Automation.PSMemberTypes]::NoteProperty -or -not $nameSet.Remove($p.Name)) { throw 'CALLBACK_INPUT_INVALID' }
        }
        if ($nameSet.Count) { throw 'CALLBACK_INPUT_INVALID' }
        if ($properties.Count -eq 6) {
            if (-not [string]::Equals($terminalRef.registrationFileSha256,$capturedRegSha,[StringComparison]::Ordinal)) { throw 'ORIGINAL_CALLBACK_TUPLE_CHANGED' }
            $outcome = & $capturedHandoff $terminalRef
            if ($null -eq $outcome -or $outcome.status -isnot [string] -or
                -not [string]::Equals($outcome.status,'DURABLE_SUCCESSOR_ACK',[StringComparison]::Ordinal) -or
                $outcome.ackRecorded -isnot [bool] -or $outcome.ackRecorded -ne $true) { throw 'REVIEWED_HANDOFF_UNRESOLVED' }
            return $outcome
        }
        if (-not [string]::Equals($terminalRef.RunId,$reg.taskId,[StringComparison]::Ordinal) -or
            -not [string]::Equals($terminalRef.RunDir,$capturedRunDir,[StringComparison]::Ordinal) -or
            $terminalRef.Attempt -ne $reg.attempt) { throw 'ORIGINAL_CALLBACK_TUPLE_CHANGED' }
        $shaOf = { param($path) (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() }
        # The acknowledged collector invokes this callback only after definitive
        # terminal validation. The retained ACK snapshot remains immutable when
        # a later genuine successor appends its own keyed acknowledgement.
        if (-not (Test-Path -LiteralPath $snapshotPath)) {
            [IO.File]::WriteAllBytes($snapshotPath,[IO.File]::ReadAllBytes($capturedAckPath))
        }
        $binding = [ordered]@{
            schema='RegisteredReviewTerminalBinding/v1'
            registrationId=$reg.registrationId
            registrationSha256=$capturedRegSha
            requestSha256=$terminalRef.RequestSha256
            runId=$terminalRef.RunId
            attempt=[long]$terminalRef.Attempt
            manifestPath=$terminalRef.ManifestPath
            manifestSha256=$terminalRef.ManifestSha256
            startPath=$terminalRef.StartPath
            startSha256=(& $shaOf $terminalRef.StartPath)
            terminalPath=$terminalRef.TerminalPath
            terminalSha256=$terminalRef.TerminalSha256
            candidatePath=$capturedRequest.ArtifactPath
            candidateSha256=(& $shaOf $capturedRequest.ArtifactPath)
            ackPath=$snapshotPath
            ackSha256=(& $shaOf $snapshotPath)
        }
        $json = $binding | ConvertTo-Json -Depth 20
        if (Test-Path -LiteralPath $reg.terminalBindingPath) {
            $existingBytes = [IO.File]::ReadAllBytes($reg.terminalBindingPath)
            $expectedBytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
            if ($existingBytes.Length -ne $expectedBytes.Length) { throw 'IMMUTABLE_TERMINAL_BINDING_CHANGED' }
            for ($i = 0; $i -lt $expectedBytes.Length; $i++) {
                if ($existingBytes[$i] -ne $expectedBytes[$i]) { throw 'IMMUTABLE_TERMINAL_BINDING_CHANGED' }
            }
        } else {
            [IO.File]::WriteAllText($reg.terminalBindingPath,$json,[Text.UTF8Encoding]::new($false))
        }
        # The producer path never consumes a review or dispatches. Even if a
        # review file appeared concurrently it leaves the original projection
        # PENDING. Only accepted130's verified binding6 enters the handoff path.
        throw 'REVIEW_PENDING_NO_SETTLEMENT_YET'
    }.GetNewClosure()
}
