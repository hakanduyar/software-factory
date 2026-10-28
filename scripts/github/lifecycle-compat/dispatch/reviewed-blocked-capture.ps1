function Get-ReviewedBlockedEvidenceCapture {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$ReviewedBlockedEvidence,
        [AllowNull()][object]$ExpectedBlockedReview
    )

    $refusal = 'REVIEWED_BLOCKED_EVIDENCE_INVALID'
    try {
        $evidenceFields = @(
            'schema', 'rawPath', 'rawSha256', 'ticketPath', 'ticketSha256',
            'usagePath', 'usageSha256', 'workerResultPath', 'workerResultSha256',
            'reviewPath', 'reviewSha256', 'taskId', 'runId', 'attempt',
            'payloadSha256', 'sessionId', 'pid', 'startIdentity'
        )
        $expectedFields = @('reviewSha256', 'evidenceSha256')
        $pathFields = @('rawPath', 'ticketPath', 'usagePath', 'workerResultPath', 'reviewPath')
        $hashFields = @(
            'rawSha256', 'ticketSha256', 'usageSha256', 'workerResultSha256',
            'reviewSha256', 'payloadSha256'
        )
        $textFields = @('taskId', 'runId', 'sessionId', 'startIdentity')
        $intFields = @('attempt', 'pid')

        # Metadata phase: exact typed shape and exact NoteProperty name sets before any value is read.
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
        if (-not (& $shapeOk $ReviewedBlockedEvidence $evidenceFields)) { throw $refusal }
        if (-not (& $shapeOk $ExpectedBlockedReview $expectedFields)) { throw $refusal }

        # Value phase: capture each value exactly once.
        $captured = @{}
        foreach ($name in $evidenceFields) {
            $captured[$name] = $ReviewedBlockedEvidence.PSObject.Properties[$name].Value
        }
        $expectedReviewSha = $ExpectedBlockedReview.PSObject.Properties['reviewSha256'].Value
        $expectedEvidenceSha = $ExpectedBlockedReview.PSObject.Properties['evidenceSha256'].Value

        $isHash = {
            param($Value)
            return ($Value -is [string]) -and ($Value.Length -eq 64) -and ($Value -cmatch '^[0-9a-f]{64}\z')
        }

        if ($captured['schema'] -isnot [string] -or -not ($captured['schema'] -ceq 'ReviewedBlockedEvidence/v1')) { throw $refusal }
        foreach ($name in $pathFields) {
            $v = $captured[$name]
            if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v)) { throw $refusal }
            if (-not [System.IO.Path]::IsPathRooted($v)) { throw $refusal }
        }
        foreach ($name in $hashFields) {
            if (-not (& $isHash $captured[$name])) { throw $refusal }
        }
        foreach ($name in $textFields) {
            $v = $captured[$name]
            if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v)) { throw $refusal }
        }
        foreach ($name in $intFields) {
            $v = $captured[$name]
            if (($v -isnot [int]) -and ($v -isnot [long])) { throw $refusal }
            if ([long]$v -le 0) { throw $refusal }
        }
        if (-not (& $isHash $expectedReviewSha)) { throw $refusal }
        if (-not (& $isHash $expectedEvidenceSha)) { throw $refusal }

        # Fresh scalar evidence object in frozen field order.
        $ordered = [ordered]@{}
        foreach ($name in $evidenceFields) {
            $v = $captured[$name]
            if ($intFields -contains $name) { $v = [long]$v } else { $v = [string]$v }
            $ordered[$name] = $v
        }
        $evidence = [pscustomobject]$ordered

        $json = ConvertTo-Json -InputObject $evidence -Depth 10 -Compress
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $hashBytes = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
        $evidenceSha = (($hashBytes | ForEach-Object { $_.ToString('x2') }) -join '')

        if (-not ([string]$expectedReviewSha -ceq [string]$captured['reviewSha256'])) { throw $refusal }
        if (-not ([string]$expectedEvidenceSha -ceq $evidenceSha)) { throw $refusal }

        return [pscustomobject][ordered]@{
            schema         = 'ReviewedBlockedCapture/v1'
            evidence       = $evidence
            reviewSha256   = [string]$captured['reviewSha256']
            evidenceSha256 = $evidenceSha
        }
    }
    catch {
        throw $refusal
    }
}