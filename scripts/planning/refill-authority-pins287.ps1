# Pure refill authority pin validators (287). Dot-source only; definitions only; no IO, hashing, encoding, JSON or top-level actions.
# Paths are validated lexically only. This proves no filesystem state, evidence or authority.

function Refill287Fail {
    param([string]$Kind, [string]$Category)
    throw ('REFILL287_INVALID:' + $Kind + ':' + $Category)
}

function Refill287TestUnicode {
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

function Refill287PathCategory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 'PATH' }
    if (-not (Refill287TestUnicode -Text $Path)) { return 'UNICODE' }
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

function Refill287Capture {
    param([AllowNull()][object]$Value, [string]$Kind, [string[]]$Names)

    if ($null -eq $Value) { Refill287Fail $Kind 'SHAPE' }
    if (-not ($Value -is [System.Management.Automation.PSCustomObject])) { Refill287Fail $Kind 'SHAPE' }

    $seen = @{}
    $count = 0
    foreach ($member in $Value.PSObject.Properties) {
        $count++
        if ($count -gt $Names.Count) { Refill287Fail $Kind 'SHAPE' }
        if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { Refill287Fail $Kind 'SHAPE' }
        $matched = $null
        foreach ($r in $Names) {
            if ($member.Name -ceq $r) { $matched = $r }
        }
        if ($null -eq $matched) { Refill287Fail $Kind 'SHAPE' }
        if ($seen.ContainsKey($matched)) { Refill287Fail $Kind 'SHAPE' }
        $seen[$matched] = $true
    }
    if ($count -ne $Names.Count) { Refill287Fail $Kind 'SHAPE' }

    # All metadata validated; values captured once.
    $out = @{}
    foreach ($n in $Names) { $out[$n] = $Value.PSObject.Properties[$n].Value }
    return $out
}

function Refill287CheckPath {
    param([AllowNull()][object]$Item, [string]$Kind)
    if (-not ($Item -is [string])) { Refill287Fail $Kind 'TYPE' }
    $category = Refill287PathCategory -Path $Item
    if ($null -ne $category) { Refill287Fail $Kind $category }
}

function Refill287CheckSha {
    param([AllowNull()][object]$Item, [string]$Kind)
    if (-not ($Item -is [string])) { Refill287Fail $Kind 'TYPE' }
    if (-not ($Item -cmatch '^[0-9a-f]{64}\z')) { Refill287Fail $Kind 'HASH' }
}

function Refill287CheckRole {
    param([AllowNull()][object]$Item, [string]$Kind)
    if (-not ($Item -is [string])) { Refill287Fail $Kind 'TYPE' }
    if (-not (@('CHECKPOINT', 'PLAN', 'BACKLOG', 'WATCH') -ccontains $Item)) { Refill287Fail $Kind 'ROLE' }
}

function Refill287CheckVersion {
    param([AllowNull()][object]$Item, [string]$Kind)
    if (-not ($Item -is [string])) { Refill287Fail $Kind 'TYPE' }
    if ([string]::IsNullOrWhiteSpace($Item)) { Refill287Fail $Kind 'VERSION' }
    if ($Item.Length -gt 256) { Refill287Fail $Kind 'VERSION' }
    if (-not (Refill287TestUnicode -Text $Item)) { Refill287Fail $Kind 'UNICODE' }
}

function AssertRefillPin287 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    $v = Refill287Capture -Value $Value -Kind 'PIN' -Names @('path', 'sha256')
    Refill287CheckPath -Item $v['path'] -Kind 'PIN'
    Refill287CheckSha -Item $v['sha256'] -Kind 'PIN'
    return $true
}

function AssertRefillBasisPin287 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    $v = Refill287Capture -Value $Value -Kind 'BASIS' -Names @('path', 'sha256', 'role', 'observedVersion')
    Refill287CheckPath -Item $v['path'] -Kind 'BASIS'
    Refill287CheckSha -Item $v['sha256'] -Kind 'BASIS'
    Refill287CheckRole -Item $v['role'] -Kind 'BASIS'
    Refill287CheckVersion -Item $v['observedVersion'] -Kind 'BASIS'
    return $true
}
