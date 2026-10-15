# Pure Binding validator (306). Dot-source only; no IO, no top-level actions.
# Paths are validated lexically only. This proves no filesystem state, evidence or authority.

function Refill306Fail {
    param([string]$Category)
    throw ('REFILL306_INVALID:' + $Category)
}

function Refill306TestUnicode {
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

function Refill306PathCategory {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 'PATH' }
    if (-not (Refill306TestUnicode -Text $Path)) { return 'UNICODE' }
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

function AssertRefillBinding306 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    if ($null -eq $Value) { Refill306Fail 'SHAPE' }
    if (-not ($Value -is [System.Management.Automation.PSCustomObject])) { Refill306Fail 'SHAPE' }

    $required = @('planPath', 'receiptPath', 'eligibilityEvidenceRef', 'planSha256', 'receiptSha256', 'provider', 'owner', 'enabled', 'taskId')
    $seen = @{}
    $count = 0
    foreach ($member in $Value.PSObject.Properties) {
        $count++
        if ($count -gt 9) { Refill306Fail 'SHAPE' }
        if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { Refill306Fail 'SHAPE' }
        $matched = $null
        foreach ($r in $required) {
            if ($member.Name -ceq $r) { $matched = $r }
        }
        if ($null -eq $matched) { Refill306Fail 'SHAPE' }
        if ($seen.ContainsKey($matched)) { Refill306Fail 'SHAPE' }
        $seen[$matched] = $true
    }
    if ($count -ne 9) { Refill306Fail 'SHAPE' }

    # All metadata validated; values captured once.
    $planPath = $Value.PSObject.Properties['planPath'].Value
    $receiptPath = $Value.PSObject.Properties['receiptPath'].Value
    $provider = $Value.PSObject.Properties['provider'].Value
    $owner = $Value.PSObject.Properties['owner'].Value
    $enabled = $Value.PSObject.Properties['enabled'].Value
    $taskId = $Value.PSObject.Properties['taskId'].Value
    $eligibilityEvidenceRef = $Value.PSObject.Properties['eligibilityEvidenceRef'].Value
    $planSha256 = $Value.PSObject.Properties['planSha256'].Value
    $receiptSha256 = $Value.PSObject.Properties['receiptSha256'].Value

    foreach ($p in @($planPath, $receiptPath, $eligibilityEvidenceRef, $planSha256, $receiptSha256)) {
        if (-not ($p -is [string])) { Refill306Fail 'TYPE' }
    }
    if (-not ($provider -is [string])) { Refill306Fail 'TYPE' }
    if (-not ($owner -is [string])) { Refill306Fail 'TYPE' }
    if (-not ($enabled -is [System.Boolean])) { Refill306Fail 'TYPE' }
    if (-not ($taskId -is [string])) { Refill306Fail 'TYPE' }

    foreach ($s in @($owner, $taskId)) {
        if ([string]::IsNullOrWhiteSpace($s)) { Refill306Fail 'ID' }
        if ($s.Length -gt 128) { Refill306Fail 'ID' }
        if (-not (Refill306TestUnicode -Text $s)) { Refill306Fail 'UNICODE' }
    }

    if (-not ([string]::Equals($provider, 'independent', [System.StringComparison]::Ordinal) -or [string]::Equals($provider, 'claude', [System.StringComparison]::Ordinal))) { Refill306Fail 'PROVIDER' }

    foreach ($p in @($planPath, $receiptPath, $eligibilityEvidenceRef)) {
        $category = Refill306PathCategory -Path $p
        if ($null -ne $category) { Refill306Fail $category }
    }

    foreach ($h in @($planSha256, $receiptSha256)) {
        if (-not ($h -cmatch '^[0-9a-f]{64}\z')) { Refill306Fail 'SHA' }
    }

    return $true
}
