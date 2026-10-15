# Pure eligibility evidence proposal validator (311). Dot-source only; no IO, no top-level actions.
# Definitions only. It proves no evidence existence, hash, freshness, eligibility authority, registration, codec, Options264 or gateway behavior.
# VERIFIED_ELIGIBLE is an explicit isolated syntactic fixture label, never a live approval.

function Refill311Fail {
    param([string]$Category)
    throw ('REFILL311_INVALID:' + $Category)
}

function Refill311TestUnicode {
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

function Refill311PathCategory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 'PATH' }
    if (-not (Refill311TestUnicode -Text $Path)) { return 'UNICODE' }
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

function AssertRefillEligibilityEvidence311 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    if ($null -eq $Value) { Refill311Fail 'SHAPE' }
    if (-not ($Value -is [System.Management.Automation.PSCustomObject])) { Refill311Fail 'SHAPE' }

    $required = @('ownedCanonicalPaths', 'classification', 'eligibility', 'owner', 'schema', 'taskId')
    $seen = @{}
    $count = 0
    foreach ($member in $Value.PSObject.Properties) {
        $count++
        if ($count -gt 6) { Refill311Fail 'SHAPE' }
        if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { Refill311Fail 'SHAPE' }
        $matched = $null
        foreach ($r in $required) {
            if ($member.Name -ceq $r) { $matched = $r }
        }
        if ($null -eq $matched) { Refill311Fail 'SHAPE' }
        if ($seen.ContainsKey($matched)) { Refill311Fail 'SHAPE' }
        $seen[$matched] = $true
    }
    if ($count -ne 6) { Refill311Fail 'SHAPE' }

    # All metadata validated; values captured once.
    $paths = $Value.PSObject.Properties['ownedCanonicalPaths'].Value
    $classification = $Value.PSObject.Properties['classification'].Value
    $eligibility = $Value.PSObject.Properties['eligibility'].Value
    $owner = $Value.PSObject.Properties['owner'].Value
    $schema = $Value.PSObject.Properties['schema'].Value
    $taskId = $Value.PSObject.Properties['taskId'].Value

    if (-not ($taskId -is [string])) { Refill311Fail 'TYPE' }
    if ([string]::IsNullOrWhiteSpace($taskId)) { Refill311Fail 'ID' }
    if ($taskId.Length -gt 128) { Refill311Fail 'ID' }
    if (-not (Refill311TestUnicode -Text $taskId)) { Refill311Fail 'UNICODE' }

    if (-not ($owner -is [string])) { Refill311Fail 'TYPE' }
    if ([string]::IsNullOrWhiteSpace($owner)) { Refill311Fail 'ID' }
    if ($owner.Length -gt 128) { Refill311Fail 'ID' }
    if (-not (Refill311TestUnicode -Text $owner)) { Refill311Fail 'UNICODE' }

    if (-not ($eligibility -is [string])) { Refill311Fail 'TYPE' }
    if (@('VERIFIED_ELIGIBLE', 'INELIGIBLE', 'UNKNOWN') -cnotcontains $eligibility) { Refill311Fail 'ELIGIBILITY' }

    if (-not ($schema -is [string])) { Refill311Fail 'TYPE' }
    if ($schema -cne 'IsolatedEligibilityEvidence249/v1') { Refill311Fail 'SCHEMA' }

    if (-not ($classification -is [string])) { Refill311Fail 'TYPE' }
    if ($classification -cne 'NONMODEL_SYNTHETIC_FIXTURE') { Refill311Fail 'CLASSIFICATION' }

    if (-not ($paths -is [object[]])) { Refill311Fail 'TYPE' }
    if ($paths.Length -lt 1 -or $paths.Length -gt 64) { Refill311Fail 'CAP' }

    $unique = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($p in $paths) {
        if (-not ($p -is [string])) { Refill311Fail 'TYPE' }
        $category = Refill311PathCategory -Path $p
        if ($null -ne $category) { Refill311Fail $category }
        if (-not $unique.Add($p)) { Refill311Fail 'DUPLICATE' }
    }

    return $true
}
