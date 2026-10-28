function Read-RegisteredReviewRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$Path,
        [Parameter(Mandatory = $true)][AllowNull()][object]$ExpectedSha256
    )

    $ErrorActionPreference = 'Stop'
    $cap = 1048576
    $stream = $null
    $sha = $null

    try {
        # Capture scalar string arguments before any data IO.
        if ($Path -isnot [string] -or $ExpectedSha256 -isnot [string]) { throw 'invalid' }
        $pathText = [string]$Path
        $expected = [string]$ExpectedSha256
        if ([string]::IsNullOrWhiteSpace($pathText) -or $pathText.IndexOf([char]0) -ge 0) { throw 'invalid' }
        if ($expected -cnotmatch '\A[0-9a-f]{64}\z') { throw 'invalid' }
        if (-not [System.IO.Path]::IsPathFullyQualified($pathText)) { throw 'invalid' }
        $full = [System.IO.Path]::GetFullPath($pathText)

        # Regular file only (no directory, no reparse point).
        $info = [System.IO.FileInfo]::new($full)
        if (-not $info.Exists) { throw 'invalid' }
        $dirOrLink = [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint
        if (($info.Attributes -band $dirOrLink) -ne 0) { throw 'invalid' }
        if ($info.Length -gt $cap) { throw 'invalid' }

        # Bounded read of at most cap+1 actual bytes.
        $stream = [System.IO.FileStream]::new(
            $full,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read,
            4096,
            [System.IO.FileOptions]::None)
        $buffer = [byte[]]::new($cap + 1)
        $total = 0
        while ($total -lt $buffer.Length) {
            $n = $stream.Read($buffer, $total, $buffer.Length - $total)
            if ($n -le 0) { break }
            $total += $n
        }
        if ($total -gt $cap) { throw 'invalid' }
        $bytes = [byte[]]::new($total)
        [System.Array]::Copy($buffer, 0, $bytes, 0, $total)

        # Hash the exact retained bytes (including any BOM); ordinal compare to captured expectation.
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $actual = [System.Convert]::ToHexString($sha.ComputeHash($bytes)).ToLowerInvariant()
        if (-not [string]::Equals($actual, $expected, [System.StringComparison]::Ordinal)) { throw 'invalid' }

        # Ignore exactly ONE leading UTF-8 BOM (EF BB BF) for decode only; retained bytes are untouched.
        $offset = 0
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $offset = 3 }

        # Strict UTF-8 (throws on malformed), then JSON; root must be an object.
        $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset)
        $parsed = ConvertFrom-Json -InputObject $text -DateKind String -NoEnumerate
        if ($parsed -isnot [System.Management.Automation.PSCustomObject]) { throw 'invalid' }

        [pscustomobject]@{
            path   = $full
            sha256 = $actual
            bytes  = $bytes
            record = $parsed
        }
    }
    catch {
        throw 'REGISTERED_REVIEW_REPLAY_INVALID'
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $sha) { $sha.Dispose() }
    }
}