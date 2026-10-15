# Pure TaskFact validator (271). Dot-source only; no IO, no top-level actions.
# eligibilityEvidenceRef is validated as a lexical canonical path only. It proves no evidence, hash, freshness or authority.

function Refill271Fail {
    param([string]$Category)
    throw ('REFILL271_INVALID:' + $Category)
}

function Refill271TestUnicode {
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

function Refill271PathCategory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 'PATH' }
    if (-not (Refill271TestUnicode -Text $Path)) { return 'UNICODE' }
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

function AssertRefillTaskFact271 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    if ($null -eq $Value) { Refill271Fail 'SHAPE' }
    if (-not ($Value -is [System.Management.Automation.PSCustomObject])) { Refill271Fail 'SHAPE' }

    $required = @('taskId', 'ownedCanonicalPaths', 'eligibility', 'eligibilityEvidenceRef')
    $seen = @{}
    $count = 0
    foreach ($member in $Value.PSObject.Properties) {
        $count++
        if ($count -gt 4) { Refill271Fail 'SHAPE' }
        if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { Refill271Fail 'SHAPE' }
        $matched = $null
        foreach ($r in $required) {
            if ($member.Name -ceq $r) { $matched = $r }
        }
        if ($null -eq $matched) { Refill271Fail 'SHAPE' }
        if ($seen.ContainsKey($matched)) { Refill271Fail 'SHAPE' }
        $seen[$matched] = $true
    }
    if ($count -ne 4) { Refill271Fail 'SHAPE' }

    # All metadata validated; values captured once.
    $taskId = $Value.PSObject.Properties['taskId'].Value
    $paths = $Value.PSObject.Properties['ownedCanonicalPaths'].Value
    $eligibility = $Value.PSObject.Properties['eligibility'].Value
    $evidenceRef = $Value.PSObject.Properties['eligibilityEvidenceRef'].Value

    if (-not ($taskId -is [string])) { Refill271Fail 'TYPE' }
    if ([string]::IsNullOrWhiteSpace($taskId)) { Refill271Fail 'ID' }
    if ($taskId.Length -gt 128) { Refill271Fail 'ID' }
    if (-not (Refill271TestUnicode -Text $taskId)) { Refill271Fail 'UNICODE' }

    if (-not ($eligibility -is [string])) { Refill271Fail 'TYPE' }
    if (@('VERIFIED_ELIGIBLE', 'INELIGIBLE', 'UNKNOWN') -cnotcontains $eligibility) { Refill271Fail 'ELIGIBILITY' }

    if (-not ($evidenceRef -is [string])) { Refill271Fail 'TYPE' }
    $refCategory = Refill271PathCategory -Path $evidenceRef
    if ($null -ne $refCategory) { Refill271Fail $refCategory }

    if (-not ($paths -is [object[]])) { Refill271Fail 'TYPE' }
    if ($paths.Length -lt 1 -or $paths.Length -gt 64) { Refill271Fail 'CAP' }

    $unique = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($p in $paths) {
        if (-not ($p -is [string])) { Refill271Fail 'TYPE' }
        $category = Refill271PathCategory -Path $p
        if ($null -ne $category) { Refill271Fail $category }
        if (-not $unique.Add($p)) { Refill271Fail 'DUPLICATE' }
    }

    return $true
}
