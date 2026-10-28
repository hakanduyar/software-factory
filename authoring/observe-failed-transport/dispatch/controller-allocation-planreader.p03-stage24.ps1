function Read-ControllerAllocationPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$PlanPath,
        [Parameter(Mandatory = $true)][AllowNull()][object]$ExpectedPlanSha256
    )
    $cap = 1048576
    $fail = 'CONTROLLER_ALLOCATION_INVALID'
    $stream = $null
    try {
        if ($null -eq $PlanPath -or $PlanPath -isnot [string] -or [string]::IsNullOrWhiteSpace($PlanPath) -or -not [System.IO.Path]::IsPathRooted($PlanPath)) { throw $fail }
        $expected = $null
        if ($null -ne $ExpectedPlanSha256) {
            if ($ExpectedPlanSha256 -isnot [string] -or $ExpectedPlanSha256.Length -ne 64 -or $ExpectedPlanSha256 -cnotmatch '^[0-9a-f]{64}$') { throw $fail }
            $expected = [string]$ExpectedPlanSha256
        }
        $path = [string]$PlanPath
        if (-not [System.IO.File]::Exists($path)) { throw $fail }
        $attrs = [System.IO.File]::GetAttributes($path)
        if (($attrs -band ([System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint -bor [System.IO.FileAttributes]::Device)) -ne 0) { throw $fail }
        $stream = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $buffer = New-Object byte[] ($cap + 1)
        $total = 0
        while ($total -lt $buffer.Length) {
            $n = $stream.Read($buffer, $total, $buffer.Length - $total)
            if ($n -le 0) { break }
            $total += $n
        }
        if ($total -gt $cap) { throw $fail }
        $bytes = New-Object byte[] $total
        [System.Buffer]::BlockCopy($buffer, 0, $bytes, 0, $total)
        $hash = ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($bytes))).Replace('-', '').ToLowerInvariant()
        if ($null -ne $expected -and [string]::CompareOrdinal($hash, $expected) -ne 0) { throw $fail }
        $offset = 0
        if ($total -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $offset = 3 }
        $decoder = New-Object System.Text.UTF8Encoding($false, $true)
        $json = $decoder.GetString($bytes, $offset, $total - $offset)
        $plan = ConvertFrom-Json -InputObject $json -NoEnumerate -DateKind String -ErrorAction Stop
        if ($plan -isnot [System.Management.Automation.PSCustomObject]) { throw $fail }
        return [pscustomobject][ordered]@{ plan = $plan; json = $json; sha256 = $hash }
    }
    catch {
        throw $fail
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}
