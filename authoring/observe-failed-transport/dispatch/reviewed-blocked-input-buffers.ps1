function Get-ReviewedBlockedInputBuffers {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$ReviewedBlockedEvidence,
        [AllowNull()][object]$ExpectedBlockedReview
    )

    $refusal = 'REVIEWED_BLOCKED_INPUTS_INVALID'
    try {
        . (Join-Path $PSScriptRoot 'reviewed-blocked-capture.ps1')

        # Single capture before any I/O; only the returned clone is used afterwards.
        $capture = Get-ReviewedBlockedEvidenceCapture -ReviewedBlockedEvidence $ReviewedBlockedEvidence -ExpectedBlockedReview $ExpectedBlockedReview
        $evidence = $capture.evidence

        $maxBytes = 4194304
        $readBytes = {
            param([string]$Path, [string]$ExpectedSha)
            $stream = $null
            try {
                $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
                $cap = $maxBytes + 1
                $buffer = New-Object byte[] $cap
                $total = 0
                while ($total -lt $cap) {
                    $n = $stream.Read($buffer, $total, $cap - $total)
                    if ($n -le 0) { break }
                    $total += $n
                }
            }
            finally {
                if ($null -ne $stream) { $stream.Dispose() }
            }
            if ($total -gt $maxBytes) { throw $refusal }
            $data = New-Object byte[] $total
            [System.Array]::Copy($buffer, $data, $total)
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $hashBytes = $sha.ComputeHash($data) } finally { $sha.Dispose() }
            $hex = (($hashBytes | ForEach-Object { $_.ToString('x2') }) -join '')
            if (-not ($hex -ceq $ExpectedSha)) { throw $refusal }
            return , $data
        }

        $raw = & $readBytes ([string]$evidence.rawPath) ([string]$evidence.rawSha256)
        $ticket = & $readBytes ([string]$evidence.ticketPath) ([string]$evidence.ticketSha256)
        $usage = & $readBytes ([string]$evidence.usagePath) ([string]$evidence.usageSha256)
        $workerResult = & $readBytes ([string]$evidence.workerResultPath) ([string]$evidence.workerResultSha256)
        $review = & $readBytes ([string]$evidence.reviewPath) ([string]$evidence.reviewSha256)

        return [pscustomobject][ordered]@{
            schema            = 'ReviewedBlockedInputBuffers/v1'
            capture           = $capture
            rawBytes          = [byte[]]$raw
            ticketBytes       = [byte[]]$ticket
            usageBytes        = [byte[]]$usage
            workerResultBytes = [byte[]]$workerResult
            reviewBytes       = [byte[]]$review
        }
    }
    catch {
        throw $refusal
    }
}
