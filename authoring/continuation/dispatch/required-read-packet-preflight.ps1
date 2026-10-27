function Test-RequiredReadPacketPreflight {
    # Read-only structural preflight. Grants no permission and dispatches nothing.
    param(
        [object]$PacketPath,
        [object]$RequiredReads,
        [object]$AllowedReadPaths
    )

    $maxPacketBytes = 1048576
    $result = {
        param([bool]$Valid, [string]$Code, [int]$Count)
        [pscustomobject]@{ valid = $Valid; code = $Code; checkedCount = $Count }
    }
    $isCanonical = {
        param($Value)
        if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { return $false }
        try {
            if (-not [System.IO.Path]::IsPathFullyQualified($Value)) { return $false }
            return [string]::Equals([System.IO.Path]::GetFullPath($Value), $Value, [System.StringComparison]::Ordinal)
        } catch { return $false }
    }

    # Capture and validate every input before any filesystem IO.
    if (-not (& $isCanonical $PacketPath)) { return & $result $false 'INVALID_PACKET_PATH' 0 }
    if ($RequiredReads -isnot [object[]] -or $RequiredReads.Count -eq 0) { return & $result $false 'INVALID_REQUIRED_READS' 0 }
    if ($AllowedReadPaths -isnot [object[]]) { return & $result $false 'INVALID_ALLOWED_READS' 0 }

    $packet = [string]$PacketPath
    $required = [string[]]@()
    $allowed = [string[]]@()
    foreach ($item in $RequiredReads) {
        if (-not (& $isCanonical $item)) { return & $result $false 'INVALID_REQUIRED_READS' 0 }
        $required += [string]$item
    }
    foreach ($item in $AllowedReadPaths) {
        if (-not (& $isCanonical $item)) { return & $result $false 'INVALID_ALLOWED_READS' 0 }
        $allowed += [string]$item
    }
    if (@($required | Select-Object -Unique).Count -ne $required.Count) { return & $result $false 'DUPLICATE_REQUIRED_READS' 0 }
    if (@($allowed | Select-Object -Unique).Count -ne $allowed.Count) { return & $result $false 'DUPLICATE_ALLOWED_READS' 0 }

    $isRegular = {
        param([string]$Path)
        $info = [System.IO.FileInfo]::new($Path)
        return $info.Exists -and -not ($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    }

    $text = $null
    $stream = $null
    try {
        if (-not (& $isRegular $packet)) { return & $result $false 'PACKET_UNREADABLE' 0 }
        $stream = [System.IO.FileStream]::new($packet, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $buffer = [byte[]]::new($maxPacketBytes + 1)
        $total = 0
        while ($total -lt $buffer.Length) {
            $read = $stream.Read($buffer, $total, $buffer.Length - $total)
            if ($read -le 0) { break }
            $total += $read
        }
        if ($total -gt $maxPacketBytes) { return & $result $false 'PACKET_TOO_LARGE' 0 }
        $strict = [System.Text.UTF8Encoding]::new($false, $true)
        $text = $strict.GetString($buffer, 0, $total)
    } catch { return & $result $false 'PACKET_UNREADABLE' 0 } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }

    $checked = 0
    foreach ($path in $required) {
        $exists = $false
        try { $exists = [bool](& $isRegular $path) } catch { $exists = $false }
        if (-not $exists) { return & $result $false 'MISSING_FILE' $checked }
        if ($allowed -cnotcontains $path) { return & $result $false 'MISSING_GRANT' $checked }
        if ($text.IndexOf($path, [System.StringComparison]::Ordinal) -lt 0) { return & $result $false 'MISSING_CARRIER' $checked }
        $checked++
    }
    return & $result $true 'OK' $checked
}
