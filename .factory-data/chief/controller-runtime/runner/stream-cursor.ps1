Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-AppendedJsonLines {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$State,
        [switch]$Final
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Refusing: file not found: $Path" }
    $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath

    function Test-SafeIntegral($v) {
        if ($v -isnot [int32] -and $v -isnot [int64] -and $v -isnot [double]) { return $false }
        if ($v -is [double] -and ([double]::IsNaN($v) -or [double]::IsInfinity($v) -or ($v -ne [math]::Floor($v)))) { return $false }
        return $true
    }

    if ($State.Count -eq 0) {
        $State.canonicalPath = $resolved
        $State.byteOffset = [int64]0
        $State.pendingBytes = @()
        $State.final = $false
        $State.hasError = $false
    } else {
        if (-not $State.ContainsKey('canonicalPath') -or $State.canonicalPath -isnot [string] -or $State.canonicalPath -ne $resolved) {
            throw 'Refusing: State is missing or bound to a different canonical path.'
        }
        if (-not $State.ContainsKey('byteOffset') -or -not (Test-SafeIntegral $State.byteOffset) -or $State.byteOffset -lt 0 -or $State.byteOffset -gt 9007199254740991) {
            throw 'Refusing: State.byteOffset is missing, non-integral, negative, or exceeds safe-integer bound.'
        }
        if (-not $State.ContainsKey('pendingBytes') -or $null -eq $State.pendingBytes -or $State.pendingBytes -isnot [array]) {
            throw 'Refusing: State.pendingBytes is missing or not an array.'
        }
        foreach ($pb in @($State.pendingBytes)) {
            if (-not (Test-SafeIntegral $pb) -or [int64]$pb -lt 0 -or [int64]$pb -gt 255) {
                throw 'Refusing: State.pendingBytes contains a non-byte value.'
            }
        }
        if (-not $State.ContainsKey('final') -or $State.final -isnot [bool]) {
            throw 'Refusing: State.final is missing or not boolean.'
        }
        if (-not $State.ContainsKey('hasError') -or $State.hasError -isnot [bool]) {
            throw 'Refusing: State.hasError is missing or not boolean.'
        }
    }

    $offset = [int64]$State.byteOffset
    $pendingRaw = if ($State.ContainsKey('pendingBytes') -and $null -ne $State.pendingBytes) { @($State.pendingBytes) } else { @() }
    $pending = [byte[]]@($pendingRaw | ForEach-Object { [byte]$_ })

    $fs = [System.IO.FileStream]::new($resolved, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($fs.Length -lt $offset) { throw 'Refusing: file is shorter than recorded byte offset (truncated evidence).' }

        if ($State.final -eq $true) {
            if ($fs.Length -gt $offset) { throw 'Refusing: bytes appended to file after it was finalized.' }
            return @{ events = @(); errors = @(); offset = $offset; pendingByteCount = $pending.Length; final = $true; hasError = [bool]$State.hasError }
        }

        $snapshotLength = $fs.Length
        $available = $snapshotLength - $offset
        $newBytes = [byte[]]::new(0)
        if ($available -gt 0) {
            $buffer = [byte[]]::new($available)
            $fs.Seek($offset, [System.IO.SeekOrigin]::Begin) | Out-Null
            $totalRead = 0
            while ($totalRead -lt $available) {
                $readNow = $fs.Read($buffer, $totalRead, $available - $totalRead)
                if ($readNow -le 0) { break }
                $totalRead += $readNow
            }
            if ($totalRead -gt 0) {
                $newBytes = [byte[]]::new($totalRead)
                [Array]::Copy($buffer, 0, $newBytes, 0, $totalRead)
            }
        }
        $offset += $newBytes.Length
        $data = [byte[]]($pending + $newBytes)
    } finally { $fs.Dispose() }

    $events = @()
    $errors = @()
    $callHadError = $false
    $enc = [System.Text.UTF8Encoding]::new($false, $true)

    $start = 0
    $lines = @()
    for ($i = 0; $i -lt $data.Length; $i++) {
        if ($data[$i] -eq 10) {
            $len = $i - $start
            $line = [byte[]]::new($len); if ($len -gt 0) { [Array]::Copy($data, $start, $line, 0, $len) }
            $lines += ,$line
            $start = $i + 1
        }
    }
    $remLen = $data.Length - $start
    $remainder = [byte[]]::new($remLen); if ($remLen -gt 0) { [Array]::Copy($data, $start, $remainder, 0, $remLen) }

    if ($Final -and $remainder.Length -gt 0) { $lines += ,$remainder; $remainder = [byte[]]@() }

    foreach ($line in $lines) {
        if ($line.Length -gt 0 -and $line[-1] -eq 13) { $trimmedLine = [byte[]]::new($line.Length - 1); if ($trimmedLine.Length -gt 0) { [Array]::Copy($line, 0, $trimmedLine, 0, $trimmedLine.Length) }; $line = $trimmedLine }
        if ($line.Length -eq 0) { continue }
        try { $text = $enc.GetString($line) } catch { $errors += 'invalid UTF8 bytes in complete line'; $callHadError = $true; continue }
        if ($text.Trim().Length -eq 0) { continue }
        try { $obj = $text | ConvertFrom-Json -AsHashtable -ErrorAction Stop } catch { $errors += 'malformed JSON in complete line'; $callHadError = $true; continue }
        if ($obj -isnot [hashtable]) { $errors += 'non-object JSON in complete line'; $callHadError = $true; continue }
        $events += $obj
    }

    $State.byteOffset = $offset
    $State.pendingBytes = @($remainder | ForEach-Object { [int]$_ })
    $State.final = [bool]($Final.IsPresent -or $State.final)
    $State.hasError = [bool]($State.hasError -or $callHadError)

    return @{ events = $events; errors = $errors; offset = $offset; pendingByteCount = $remainder.Length; final = [bool]$State.final; hasError = [bool]$State.hasError }
}
