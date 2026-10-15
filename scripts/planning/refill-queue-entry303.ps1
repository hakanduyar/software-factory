# Pure QueueEntry validator (303). Dot-source only; no IO, no top-level actions.
# Paths are validated lexically only. This proves no filesystem state, evidence or authority.

function Refill303Fail {
    param([string]$Category)
    throw ('REFILL303_INVALID:' + $Category)
}

function Refill303TestUnicode {
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

function Refill303PathCategory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 'PATH' }
    if (-not (Refill303TestUnicode -Text $Path)) { return 'UNICODE' }
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

function AssertRefillQueueEntry303 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    if ($null -eq $Value) { Refill303Fail 'SHAPE' }
    if (-not ($Value -is [System.Management.Automation.PSCustomObject])) { Refill303Fail 'SHAPE' }

    $required = @('planPath', 'receiptPath', 'provider', 'owner', 'enabled', 'id')
    $seen = @{}
    $count = 0
    foreach ($member in $Value.PSObject.Properties) {
        $count++
        if ($count -gt 6) { Refill303Fail 'SHAPE' }
        if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { Refill303Fail 'SHAPE' }
        $matched = $null
        foreach ($r in $required) {
            if ($member.Name -ceq $r) { $matched = $r }
        }
        if ($null -eq $matched) { Refill303Fail 'SHAPE' }
        if ($seen.ContainsKey($matched)) { Refill303Fail 'SHAPE' }
        $seen[$matched] = $true
    }
    if ($count -ne 6) { Refill303Fail 'SHAPE' }

    # All metadata validated; values captured once.
    $planPath = $Value.PSObject.Properties['planPath'].Value
    $receiptPath = $Value.PSObject.Properties['receiptPath'].Value
    $provider = $Value.PSObject.Properties['provider'].Value
    $owner = $Value.PSObject.Properties['owner'].Value
    $enabled = $Value.PSObject.Properties['enabled'].Value
    $id = $Value.PSObject.Properties['id'].Value

    foreach ($p in @($planPath, $receiptPath)) {
        if (-not ($p -is [string])) { Refill303Fail 'TYPE' }
    }
    if (-not ($provider -is [string])) { Refill303Fail 'TYPE' }
    if (-not ($owner -is [string])) { Refill303Fail 'TYPE' }
    if (-not ($enabled -is [System.Boolean])) { Refill303Fail 'TYPE' }
    if (-not ($id -is [string])) { Refill303Fail 'TYPE' }

    foreach ($s in @($owner, $id)) {
        if ([string]::IsNullOrWhiteSpace($s)) { Refill303Fail 'ID' }
        if ($s.Length -gt 128) { Refill303Fail 'ID' }
        if (-not (Refill303TestUnicode -Text $s)) { Refill303Fail 'UNICODE' }
    }

    if (-not ([string]::Equals($provider, 'independent', [System.StringComparison]::Ordinal) -or [string]::Equals($provider, 'claude', [System.StringComparison]::Ordinal))) { Refill303Fail 'PROVIDER' }

    foreach ($p in @($planPath, $receiptPath)) {
        $category = Refill303PathCategory -Path $p
        if ($null -ne $category) { Refill303Fail $category }
    }

    return $true
}
