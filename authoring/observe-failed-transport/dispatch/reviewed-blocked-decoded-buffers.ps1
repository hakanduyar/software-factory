. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-capture.ps1')

function Get-DecodedReviewedBlockedBuffers {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$InputBuffers
    )

    $refusal = 'REVIEWED_BLOCKED_DECODE_INVALID'
    try {
        $maxBytes = 4194304
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

        $inputFields = @('schema', 'capture', 'rawBytes', 'ticketBytes', 'usageBytes', 'workerResultBytes', 'reviewBytes')
        $captureFields = @('schema', 'evidence', 'reviewSha256', 'evidenceSha256')
        $bufferFields = @('rawBytes', 'ticketBytes', 'usageBytes', 'workerResultBytes', 'reviewBytes')

        # Metadata phase before any value read.
        if (-not (& $shapeOk $InputBuffers $inputFields)) { throw $refusal }

        # Value phase: capture each input value once.
        $inSchema = $InputBuffers.PSObject.Properties['schema'].Value
        $inCapture = $InputBuffers.PSObject.Properties['capture'].Value
        $inBuffers = @{}
        foreach ($name in $bufferFields) {
            $inBuffers[$name] = $InputBuffers.PSObject.Properties[$name].Value
        }
        if ($inSchema -isnot [string] -or -not ($inSchema -ceq 'ReviewedBlockedInputBuffers/v1')) { throw $refusal }

        if (-not (& $shapeOk $inCapture $captureFields)) { throw $refusal }
        $capSchema = $inCapture.PSObject.Properties['schema'].Value
        $capEvidence = $inCapture.PSObject.Properties['evidence'].Value
        $capReviewSha = $inCapture.PSObject.Properties['reviewSha256'].Value
        $capEvidenceSha = $inCapture.PSObject.Properties['evidenceSha256'].Value
        if ($capSchema -isnot [string] -or -not ($capSchema -ceq 'ReviewedBlockedCapture/v1')) { throw $refusal }

        $expected = [pscustomobject][ordered]@{
            reviewSha256   = $capReviewSha
            evidenceSha256 = $capEvidenceSha
        }
        $capture = Get-ReviewedBlockedEvidenceCapture -ReviewedBlockedEvidence $capEvidence -ExpectedBlockedReview $expected
        if ($null -eq $capture -or $capture.schema -cne 'ReviewedBlockedCapture/v1') { throw $refusal }
        $evidence = $capture.evidence

        # Clone all five buffers once before hashing or parsing.
        $clones = @{}
        foreach ($name in $bufferFields) {
            $b = $inBuffers[$name]
            if ($b -isnot [byte[]]) { throw $refusal }
            if ($b.Length -gt $maxBytes) { throw $refusal }
        }
        foreach ($name in $bufferFields) {
            $clones[$name] = [byte[]]($inBuffers[$name].Clone())
        }

        $hashMap = [ordered]@{
            rawBytes          = $evidence.rawSha256
            ticketBytes       = $evidence.ticketSha256
            usageBytes        = $evidence.usageSha256
            workerResultBytes = $evidence.workerResultSha256
            reviewBytes       = $evidence.reviewSha256
        }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            foreach ($name in $bufferFields) {
                $hex = (($sha.ComputeHash($clones[$name]) | ForEach-Object { $_.ToString('x2') }) -join '')
                if (-not ($hex -ceq [string]$hashMap[$name])) { throw $refusal }
            }
        }
        finally { $sha.Dispose() }

        $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $parsed = @{}
        foreach ($name in @('rawBytes', 'ticketBytes', 'workerResultBytes', 'reviewBytes')) {
            $text = $strictUtf8.GetString($clones[$name])
            $doc = ConvertFrom-Json -InputObject $text -DateKind String -NoEnumerate
            if ($doc -isnot [System.Management.Automation.PSCustomObject]) { throw $refusal }
            $parsed[$name] = $doc
        }

        $result = [pscustomobject][ordered]@{
            schema        = 'DecodedReviewedBlockedBuffers/v1'
            capture       = $capture
            raw           = $parsed['rawBytes']
            ticket        = $parsed['ticketBytes']
            workerResult  = $parsed['workerResultBytes']
            reviewedBasis = $parsed['reviewBytes']
        }
        return $result
    }
    catch {
        throw $refusal
    }
}
