# Pure OwnerFact validator (283). Dot-source only; no IO, no top-level actions.
# Paths are validated lexically only. This proves no filesystem state, evidence or authority.

function Refill283Fail {
    param([string]$Category)
    throw ('REFILL283_INVALID:' + $Category)
}

function Refill283TestUnicode {
    param([string]$Text)
    $i = 0
    while ($i -lt $Text.Length) {
        $c = $Text[$i]
        if ([char]::IsHighSurrogate($c)) {
            if (($i + 1) -ge $Text.Length -or -not [char]::IsLowSurrogate($Text[$i + 1])) { return $false }
            $i += 2
            continue
        }
        if ([char]::IsLowSurrogate($c)) { return $false }
        $i++
    }
    return $true
}

function Refill283PathCategory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 'PATH' }
    if (-not (Refill283TestUnicode -Text $Path)) { return 'UNICODE' }
    $bs = [char]92
    if ($Path.Length -lt 3) { return 'PATH' }
    if (-not ([string]$Path[0] -cmatch '^[A-Za-z]$')) { return 'PATH' }
    if ($Path[1] -cne [char]58 -or $Path[2] -cne $bs) { return 'PATH' }
    foreach ($ch in $Path.ToCharArray()) {
        if ([int]$ch -lt 32) { return 'PATH' }
    }
    $rest = $Path.Substring(3)
    $bad = [char[]]@(34, 42, 47, 58, 60, 62, 63, 124)
    if ($rest.IndexOfAny($bad) -ge 0) { return 'PATH' }
    foreach ($seg in $(if ($Path.Length -eq 3) { @() } else { $rest.Split($bs) })) {
        if ($seg.Length -eq 0) { return 'PATH' }
        if ($seg -ceq '.' -or $seg -ceq '..') { return 'PATH' }
        if ($seg.EndsWith('.') -or $seg.EndsWith(' ')) { return 'PATH' }
        $dot = $seg.IndexOf('.')
        $base = if ($dot -ge 0) { $seg.Substring(0, $dot) } else { $seg }
        if ($base.TrimEnd(' ') -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') { return 'PATH' }
    }
    $full = $null
    try { $full = [System.IO.Path]::GetFullPath($Path) } catch { return 'PATH' }
    if (-not ([string]::Equals($full, $Path, [System.StringComparison]::Ordinal))) { return 'PATH' }
    return $null
}

function AssertRefillOwnerFact283 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    if ($null -eq $Value) { Refill283Fail 'SHAPE' }
    if (-not ($Value -is [System.Management.Automation.PSCustomObject])) { Refill283Fail 'SHAPE' }

    $required = @('ownerId', 'ownedCanonicalPaths')
    $seen = @{}
    $count = 0
    foreach ($member in $Value.PSObject.Properties) {
        $count++
        if ($count -gt 2) { Refill283Fail 'SHAPE' }
        if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { Refill283Fail 'SHAPE' }
        $matched = $null
        foreach ($r in $required) {
            if ($member.Name -ceq $r) { $matched = $r }
        }
        if ($null -eq $matched) { Refill283Fail 'SHAPE' }
        if ($seen.ContainsKey($matched)) { Refill283Fail 'SHAPE' }
        $seen[$matched] = $true
    }
    if ($count -ne 2) { Refill283Fail 'SHAPE' }

    # All metadata validated; values captured once.
    $ownerId = $Value.PSObject.Properties['ownerId'].Value
    $paths = $Value.PSObject.Properties['ownedCanonicalPaths'].Value

    if (-not ($ownerId -is [string])) { Refill283Fail 'TYPE' }
    if ([string]::IsNullOrWhiteSpace($ownerId)) { Refill283Fail 'ID' }
    if ($ownerId.Length -gt 128) { Refill283Fail 'ID' }
    if (-not (Refill283TestUnicode -Text $ownerId)) { Refill283Fail 'UNICODE' }

    if (-not ($paths -is [object[]])) { Refill283Fail 'TYPE' }
    if ($paths.Length -lt 1 -or $paths.Length -gt 64) { Refill283Fail 'CAP' }

    $unique = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($p in $paths) {
        if (-not ($p -is [string])) { Refill283Fail 'TYPE' }
        $category = Refill283PathCategory -Path $p
        if ($null -ne $category) { Refill283Fail $category }
        if (-not $unique.Add($p)) { Refill283Fail 'DUPLICATE' }
    }

    return $true
}
