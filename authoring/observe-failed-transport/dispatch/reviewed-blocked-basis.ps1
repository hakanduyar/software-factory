. (Join-Path $PSScriptRoot 'reviewed-blocked-capture.ps1')

function Get-VerifiedReviewedBlockedBasis {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$DecodedBuffers
    )

    $refusal = 'REVIEWED_BLOCKED_BASIS_INVALID'
    try {
        $basisFields = @(
            'schema', 'verdict', 'providerClassification', 'rawPath', 'rawSha256',
            'ticketPath', 'ticketSha256', 'usagePath', 'usageSha256',
            'workerResultPath', 'workerResultSha256', 'taskId', 'runId', 'attempt',
            'payloadSha256', 'sessionId', 'pid', 'startIdentity', 'sdkOutputTokens',
            'historicalOutputTokens', 'cumulativeOutputTokens', 'phaseAggregateCeiling',
            'additionalOutputMax', 'maxAttempts', 'maxElapsedMs', 'terminalPath',
            'terminalSha256', 'stdoutPath', 'stdoutSha256', 'terminalReason', 'exitCode',
            'exitObserved', 'drainComplete', 'onStartedAcknowledged',
            'completeNativeEditCount', 'workerStatus', 'workerReason', 'acceptedArtifact',
            'retainedArtifact', 'reviewLineagePath', 'reviewLineageSha256', 'limits'
        )
        $decodedFields = @('schema', 'capture', 'raw', 'ticket', 'workerResult', 'reviewedBasis')
        $captureFields = @('schema', 'evidence', 'reviewSha256', 'evidenceSha256')
        $retainedFields = @('state', 'sha256', 'meaning')
        $pathFields = @('rawPath', 'ticketPath', 'usagePath', 'workerResultPath', 'terminalPath', 'stdoutPath', 'reviewLineagePath')
        $hashFields = @(
            'rawSha256', 'ticketSha256', 'usageSha256', 'workerResultSha256', 'payloadSha256',
            'terminalSha256', 'stdoutSha256', 'reviewLineageSha256'
        )
        $textFields = @(
            'taskId', 'runId', 'sessionId', 'startIdentity', 'workerReason', 'limits',
            'verdict', 'providerClassification', 'terminalReason', 'workerStatus', 'schema'
        )
        $positiveFields = @('attempt', 'pid', 'maxAttempts', 'maxElapsedMs', 'phaseAggregateCeiling', 'additionalOutputMax')
        $nonNegativeFields = @('sdkOutputTokens', 'historicalOutputTokens', 'cumulativeOutputTokens')
        $trueFields = @('exitObserved', 'drainComplete', 'onStartedAcknowledged')
        $zeroFields = @('exitCode', 'completeNativeEditCount')
        $fixedText = @{
            schema                 = 'ReviewedBlockedBasis/v1'
            verdict                = 'BLOCKED_NO_ACCEPTED_ARTIFACT'
            providerClassification = 'SUCCESS'
            terminalReason         = 'NATURAL_EXIT'
            workerStatus           = 'BLOCKED'
        }
        $equalText = @(
            'rawPath', 'rawSha256', 'ticketPath', 'ticketSha256', 'usagePath', 'usageSha256',
            'workerResultPath', 'workerResultSha256', 'taskId', 'runId', 'payloadSha256',
            'sessionId', 'startIdentity'
        )

        $shapeOk = {
            param($Candidate, [string[]]$Names)
            if ($null -eq $Candidate) { return $false }
            if ($Candidate -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            $props = @($Candidate.PSObject.Properties)
            if ($props.Count -ne $Names.Count) { return $false }
            $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
            foreach ($p in $props) {
                if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
                if (-not $seen.Add([string]$p.Name)) { return $false }
            }
            foreach ($n in $Names) {
                if (-not $seen.Contains($n)) { return $false }
            }
            return $true
        }
        $isHash = {
            param($Value)
            return ($Value -is [string]) -and ($Value.Length -eq 64) -and ($Value -cmatch '^[0-9a-f]{64}\z')
        }
        $isInt = { param($Value) return ($Value -is [int]) -or ($Value -is [long]) }

        # Metadata phase: all exact typed shapes before any value is read.
        if (-not (& $shapeOk $DecodedBuffers $decodedFields)) { throw $refusal }
        $decodedProps = $DecodedBuffers.PSObject.Properties
        $schemaValue = $decodedProps['schema'].Value
        $captureIn = $decodedProps['capture'].Value
        $basisIn = $decodedProps['reviewedBasis'].Value
        if ($schemaValue -isnot [string] -or -not ($schemaValue -ceq 'DecodedReviewedBlockedBuffers/v1')) { throw $refusal }
        if (-not (& $shapeOk $captureIn $captureFields)) { throw $refusal }
        $captureInSchema = $captureIn.PSObject.Properties['schema'].Value
        if ($captureInSchema -isnot [string] -or -not ($captureInSchema -ceq 'ReviewedBlockedCapture/v1')) { throw $refusal }
        if (-not (& $shapeOk $basisIn $basisFields)) { throw $refusal }

        # Value phase: capture each basis value once.
        $b = @{}
        foreach ($name in $basisFields) {
            $b[$name] = $basisIn.PSObject.Properties[$name].Value
        }
        $retainedIn = $b['retainedArtifact']
        if (-not (& $shapeOk $retainedIn $retainedFields)) { throw $refusal }
        $r = @{}
        foreach ($name in $retainedFields) {
            $r[$name] = $retainedIn.PSObject.Properties[$name].Value
        }

        # Accepted capture getter recaptures evidence and expected SHAs once.
        $capture = Get-ReviewedBlockedEvidenceCapture `
            -ReviewedBlockedEvidence $captureIn.PSObject.Properties['evidence'].Value `
            -ExpectedBlockedReview ([pscustomobject]@{
                reviewSha256   = $captureIn.PSObject.Properties['reviewSha256'].Value
                evidenceSha256 = $captureIn.PSObject.Properties['evidenceSha256'].Value
            })
        if (-not (& $shapeOk $capture $captureFields)) { throw $refusal }
        $ev = $capture.evidence

        foreach ($name in $textFields) {
            if ($b[$name] -isnot [string] -or [string]::IsNullOrWhiteSpace($b[$name])) { throw $refusal }
        }
        foreach ($name in $fixedText.Keys) {
            if (-not ($b[$name] -ceq $fixedText[$name])) { throw $refusal }
        }
        foreach ($name in $pathFields) {
            if ($b[$name] -isnot [string] -or [string]::IsNullOrWhiteSpace($b[$name])) { throw $refusal }
            if (-not [System.IO.Path]::IsPathFullyQualified($b[$name])) { throw $refusal }
        }
        foreach ($name in $hashFields) {
            if (-not (& $isHash $b[$name])) { throw $refusal }
        }
        foreach ($name in $positiveFields) {
            if (-not (& $isInt $b[$name]) -or [long]$b[$name] -le 0) { throw $refusal }
        }
        foreach ($name in $nonNegativeFields) {
            if (-not (& $isInt $b[$name]) -or [long]$b[$name] -lt 0) { throw $refusal }
        }
        foreach ($name in $zeroFields) {
            if (-not (& $isInt $b[$name]) -or [long]$b[$name] -ne 0) { throw $refusal }
        }
        foreach ($name in $trueFields) {
            if ($b[$name] -isnot [bool] -or -not $b[$name]) { throw $refusal }
        }
        if ($b['acceptedArtifact'] -isnot [bool] -or $b['acceptedArtifact']) { throw $refusal }

        if ($r['state'] -isnot [string] -or -not ($r['state'] -ceq 'PRESENT')) { throw $refusal }
        if (-not (& $isHash $r['sha256'])) { throw $refusal }
        if ($r['meaning'] -isnot [string] -or [string]::IsNullOrWhiteSpace($r['meaning'])) { throw $refusal }

        # Captured equality with the accepted capture evidence (review lineage is not compared).
        foreach ($name in $equalText) {
            if (-not ([string]$b[$name] -ceq [string]$ev.$name)) { throw $refusal }
        }
        foreach ($name in @('attempt', 'pid')) {
            if ([long]$b[$name] -ne [long]$ev.$name) { throw $refusal }
        }

        # Fresh scalar clone in frozen order.
        $ordered = [ordered]@{}
        foreach ($name in $basisFields) {
            $v = $b[$name]
            if ($name -eq 'retainedArtifact') {
                $v = [pscustomobject][ordered]@{
                    state   = [string]$r['state']
                    sha256  = [string]$r['sha256']
                    meaning = [string]$r['meaning']
                }
            }
            elseif ($v -is [bool]) { $v = [bool]$v }
            elseif ($v -is [string]) { $v = [string]$v }
            else { $v = [long]$v }
            $ordered[$name] = $v
        }

        return [pscustomobject][ordered]@{
            schema  = 'VerifiedReviewedBlockedBasis/v1'
            capture = $capture
            basis   = [pscustomobject]$ordered
        }
    }
    catch {
        throw $refusal
    }
}
