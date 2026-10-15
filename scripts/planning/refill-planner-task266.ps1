function Refill266Fail {
    param([string]$Category)
    throw ('REFILL266_INVALID:' + $Category)
}

function Refill266TestUnicode {
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

function Refill266PathCategory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 'PATH' }
    if (-not (Refill266TestUnicode -Text $Path)) { return 'UNICODE' }
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

function AssertRefillPlannerTask266 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    if ($null -eq $Value) { Refill266Fail 'SHAPE' }
    if (-not ($Value -is [System.Management.Automation.PSCustomObject])) { Refill266Fail 'SHAPE' }

    $required = @('taskId', 'eligibility', 'ownedCanonicalPaths')
    $seen = @{}
    $count = 0
    foreach ($member in $Value.PSObject.Properties) {
        $count++
        if ($count -gt 3) { Refill266Fail 'SHAPE' }
        if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { Refill266Fail 'SHAPE' }
        $matched = $null
        foreach ($r in $required) {
            if ($member.Name -ceq $r) { $matched = $r }
        }
        if ($null -eq $matched) { Refill266Fail 'SHAPE' }
        if ($seen.ContainsKey($matched)) { Refill266Fail 'SHAPE' }
        $seen[$matched] = $true
    }
    if ($count -ne 3) { Refill266Fail 'SHAPE' }

    # Metadata fully validated; values captured once.
    $taskId = $Value.PSObject.Properties['taskId'].Value
    $eligibility = $Value.PSObject.Properties['eligibility'].Value
    $paths = $Value.PSObject.Properties['ownedCanonicalPaths'].Value

    if (-not ($taskId -is [string])) { Refill266Fail 'TYPE' }
    if ([string]::IsNullOrWhiteSpace($taskId)) { Refill266Fail 'ID' }
    if ($taskId.Length -gt 128) { Refill266Fail 'ID' }
    if (-not (Refill266TestUnicode -Text $taskId)) { Refill266Fail 'UNICODE' }

    if (-not ($eligibility -is [string])) { Refill266Fail 'TYPE' }
    if (@('VERIFIED_ELIGIBLE', 'INELIGIBLE', 'UNKNOWN') -cnotcontains $eligibility) { Refill266Fail 'ELIGIBILITY' }

    if (-not ($paths -is [object[]])) { Refill266Fail 'TYPE' }
    if ($paths.Length -lt 1 -or $paths.Length -gt 64) { Refill266Fail 'CAP' }

    $unique = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($p in $paths) {
        if (-not ($p -is [string])) { Refill266Fail 'TYPE' }
        $category = Refill266PathCategory -Path $p
        if ($null -ne $category) { Refill266Fail $category }
        if (-not $unique.Add($p)) { Refill266Fail 'DUPLICATE' }
    }

    return $true
}
