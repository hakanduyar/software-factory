function Get-ControllerAllocationOriginBinding {
    # Equality capture only: ExpectedOrigin comes independently from the trusted host.
    # This is not authentication and proves no issuer, grant or READY state.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Origin,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $ExpectedOrigin
    )

    $names = @('issuerId', 'authoritySha256', 'phaseId', 'predecessorReceiptSha256', 'nextTicketSha256', 'nextPayloadSha256')
    $hashNames = @('authoritySha256', 'predecessorReceiptSha256', 'nextTicketSha256', 'nextPayloadSha256')
    $fail = { throw 'CONTROLLER_ALLOCATION_INVALID' }

    # Phase 1: inspect metadata of both objects only; no property value is read here.
    foreach ($candidate in @($Origin, $ExpectedOrigin)) {
        if ($null -eq $candidate -or $candidate -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
        $members = @($candidate.PSObject.Properties)
        if ($members.Count -ne $names.Count) { & $fail }
        foreach ($expectedName in $names) {
            $matches = @($members | Where-Object { [string]::Equals($_.Name, $expectedName, [System.StringComparison]::Ordinal) })
            if ($matches.Count -ne 1) { & $fail }
            if ($matches[0].MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { & $fail }
        }
    }

    # Phase 2: read values (safe, all are plain NoteProperties) and validate.
    $captured = [ordered]@{}
    foreach ($pair in @(@('o', $Origin), @('e', $ExpectedOrigin))) {
        $values = @{}
        foreach ($name in $names) {
            $value = $pair[1].PSObject.Properties[$name].Value
            if ($value -isnot [string]) { & $fail }
            if ($hashNames -contains $name) {
                if ($value.Length -ne 64 -or $value -cnotmatch '\A[0-9a-f]{64}\z') { & $fail }
            }
            elseif ([string]::IsNullOrWhiteSpace($value)) { & $fail }
            $values[$name] = $value
        }
        $captured[$pair[0]] = $values
    }

    foreach ($name in $names) {
        if (-not [string]::Equals($captured.o[$name], $captured.e[$name], [System.StringComparison]::Ordinal)) { & $fail }
    }

    $result = [ordered]@{}
    foreach ($name in $names) { $result[$name] = [string]::Copy($captured.o[$name]) }
    return [pscustomobject]$result
}

function Get-ControllerAllocationScope {
    # Pure capture of configured budget fields (ControllerAllocationScopeContract/v1).
    # This is not authority, admission, queueing or enforcement of attempts/time.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Scope,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $CumulativeOutput
    )

    $names = @('taskId', 'owner', 'ownedPaths', 'maxAdditionalOutput', 'aggregateCeiling', 'maxAttempts', 'maxElapsedMs')
    $budgetNames = @('maxAdditionalOutput', 'aggregateCeiling', 'maxAttempts', 'maxElapsedMs')
    $fail = { throw 'CONTROLLER_ALLOCATION_INVALID' }
    $isInteger = { param($v) ($v -is [int] -or $v -is [long]) }

    # Metadata first: no property getter runs until the exact NoteProperty shape is proven.
    if ($null -eq $Scope -or $Scope -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
    $members = @($Scope.PSObject.Properties)
    # Exact-ordinal outputStopMode selects the explicit OBSERVE_ONLY shape; a mis-cased alias refuses and never falls back to legacy.
    # Shape capture only: the marker and its null fields are not policy authority.
    $markerMembers = @($members | Where-Object { [string]::Equals($_.Name, 'outputStopMode', [System.StringComparison]::OrdinalIgnoreCase) })
    $observeOnly = $false
    if ($markerMembers.Count -gt 0) {
        if ($markerMembers.Count -ne 1 -or -not [string]::Equals($markerMembers[0].Name, 'outputStopMode', [System.StringComparison]::Ordinal)) { & $fail }
        $observeOnly = $true
        $names = @('taskId', 'owner', 'ownedPaths', 'outputStopMode', 'maxAdditionalOutput', 'aggregateCeiling', 'maxAttempts', 'maxElapsedMs')
        $budgetNames = @('maxAttempts', 'maxElapsedMs')
    }
    if ($members.Count -ne $names.Count) { & $fail }
    foreach ($expectedName in $names) {
        $found = @($members | Where-Object { [string]::Equals($_.Name, $expectedName, [System.StringComparison]::Ordinal) })
        if ($found.Count -ne 1) { & $fail }
        if ($found[0].MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { & $fail }
    }

    $values = @{}
    foreach ($name in $names) { $values[$name] = $Scope.PSObject.Properties[$name].Value }

    foreach ($name in @('taskId', 'owner')) {
        if ($values[$name] -isnot [string] -or [string]::IsNullOrWhiteSpace($values[$name])) { & $fail }
    }

    $paths = $values['ownedPaths']
    if ($null -eq $paths -or $paths -isnot [object[]] -or $paths.Count -lt 1 -or $paths.Count -gt 32) { & $fail }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    $copiedPaths = New-Object 'string[]' $paths.Count
    for ($i = 0; $i -lt $paths.Count; $i++) {
        $p = $paths[$i]
        if ($p -isnot [string] -or [string]::IsNullOrWhiteSpace($p) -or -not [System.IO.Path]::IsPathRooted($p)) { & $fail }
        try { $full = [System.IO.Path]::GetFullPath($p) } catch { & $fail }
        if (-not $seen.Add($full)) { & $fail }
        $copiedPaths[$i] = [string]::Copy($full)
    }

    foreach ($name in $budgetNames) {
        # Observe-only shape only: an exact null maxElapsedMs means NO TOTAL AUTHOR DEADLINE (never 0). A finite positive value remains valid for historical scopes.
        if ($observeOnly -and $name -ceq 'maxElapsedMs' -and $null -eq $values[$name]) { continue }
        if (-not (& $isInteger $values[$name]) -or [long]$values[$name] -le 0) { & $fail }
    }
    if (-not (& $isInteger $CumulativeOutput) -or [long]$CumulativeOutput -lt 0) { & $fail }
    if ($observeOnly) {
        # No output ceiling exists in this shape: both fields must be present and null; nothing is cast, defaulted or minted.
        if ($values['outputStopMode'] -isnot [string] -or -not [string]::Equals($values['outputStopMode'], 'OBSERVE_ONLY', [System.StringComparison]::Ordinal)) { & $fail }
        if ($null -ne $values['maxAdditionalOutput'] -or $null -ne $values['aggregateCeiling']) { & $fail }
        return [pscustomobject][ordered]@{
            taskId              = [string]::Copy($values['taskId'])
            owner               = [string]::Copy($values['owner'])
            ownedPaths          = [string[]]$copiedPaths
            outputStopMode      = 'OBSERVE_ONLY'
            maxAdditionalOutput = $null
            aggregateCeiling    = $null
            maxAttempts         = [long]$values['maxAttempts']
            maxElapsedMs        = $(if ($null -eq $values['maxElapsedMs']) { $null } else { [long]$values['maxElapsedMs'] })
        }
    }
    $ceiling = [long]$values['aggregateCeiling']
    $cumulative = [long]$CumulativeOutput
    if ($cumulative -gt $ceiling) { & $fail }
    if ([long]$values['maxAdditionalOutput'] -gt ($ceiling - $cumulative)) { & $fail }

    return [pscustomobject][ordered]@{
        taskId              = [string]::Copy($values['taskId'])
        owner               = [string]::Copy($values['owner'])
        ownedPaths          = [string[]]$copiedPaths
        maxAdditionalOutput = [long]$values['maxAdditionalOutput']
        aggregateCeiling    = $ceiling
        maxAttempts         = [long]$values['maxAttempts']
        maxElapsedMs        = [long]$values['maxElapsedMs']
    }
}

function Get-ControllerAllocationBinding {
    # ControllerCombinedAllocationContract/v1: pure equality + configured scope capture.
    # Not authority, authentication, READY, receipt or Step integration.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Snapshot,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $ExpectedOrigin
    )

    $names = @('issuerId', 'authoritySha256', 'phaseId', 'predecessorReceiptSha256', 'cumulativeOutput', 'nextTicketSha256', 'nextPayloadSha256', 'allocation')
    $originNames = @('issuerId', 'authoritySha256', 'phaseId', 'predecessorReceiptSha256', 'nextTicketSha256', 'nextPayloadSha256')
    $fail = { throw 'CONTROLLER_ALLOCATION_INVALID' }

    # Exact root shape is proven from metadata before any value is read.
    if ($null -eq $Snapshot -or $Snapshot -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
    $members = @($Snapshot.PSObject.Properties)
    if ($members.Count -ne $names.Count) { & $fail }
    foreach ($expectedName in $names) {
        $found = @($members | Where-Object { [string]::Equals($_.Name, $expectedName, [System.StringComparison]::Ordinal) })
        if ($found.Count -ne 1 -or $found[0].MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { & $fail }
    }

    $originInput = [ordered]@{}
    foreach ($name in $originNames) { $originInput[$name] = $Snapshot.PSObject.Properties[$name].Value }
    $origin = Get-ControllerAllocationOriginBinding -Origin ([pscustomobject]$originInput) -ExpectedOrigin $ExpectedOrigin
    $cumulativeInput = $Snapshot.PSObject.Properties['cumulativeOutput'].Value
    $scope = Get-ControllerAllocationScope -Scope $Snapshot.PSObject.Properties['allocation'].Value -CumulativeOutput $cumulativeInput

    $result = [ordered]@{}
    foreach ($name in $names) {
        $result[$name] = switch ($name) {
            'cumulativeOutput' { [long]$cumulativeInput }
            'allocation' { $scope }
            default { $origin.$name }
        }
    }
    return [pscustomobject]$result
}
