function AssertRefillTransactionId296 {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [object]$Value
    )

    Set-StrictMode -Version Latest

    if ([object]::ReferenceEquals($Value, $null) -or -not ($Value -is [string])) {
        throw 'REFILL296_INVALID:TYPE'
    }

    $text = [string]$Value
    if ($text.Length -ne 36) {
        throw 'REFILL296_INVALID:UUID'
    }

    $pattern = '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
    if (-not [System.Text.RegularExpressions.Regex]::IsMatch($text, $pattern, [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
        throw 'REFILL296_INVALID:UUID'
    }

    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($text, 'D', [ref]$parsed)) {
        throw 'REFILL296_INVALID:UUID'
    }

    $canonical = $parsed.ToString('D', [System.Globalization.CultureInfo]::InvariantCulture)
    if (-not [string]::Equals($text, $canonical, [System.StringComparison]::Ordinal)) {
        throw 'REFILL296_INVALID:UUID'
    }

    return $true
}
