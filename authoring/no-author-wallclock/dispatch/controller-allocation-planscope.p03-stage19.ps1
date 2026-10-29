. (Join-Path $PSScriptRoot 'controller-allocation-marker.p03-stage17.ps1')

function Get-ControllerAllocationPlanScope {
    # ControllerPlanScopeContract/v1: equality comparison only; not authority, READY or Step integration.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Snapshot,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $ExpectedOrigin,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Plan,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Owner
    )

    $fail = { throw 'CONTROLLER_ALLOCATION_INVALID' }
    $ordinal = [System.StringComparison]::Ordinal
    $noteProperty = [System.Management.Automation.PSMemberTypes]::NoteProperty
    $hasNotes = {
        param($obj, $names)
        $members = @($obj.PSObject.Properties)
        foreach ($n in $names) {
            $f = @($members | Where-Object { [string]::Equals($_.Name, $n, $ordinal) })
            if ($f.Count -ne 1 -or $f[0].MemberType -ne $noteProperty) { return $false }
        }
        return $true
    }

    # Plan metadata is proven before any Plan value is read.
    if ($null -eq $Plan -or $Plan -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
    $planNames = @('allocationBindingSha256', 'receiptSha256', 'actionId', 'cumulativeOutput', 'maxAdditionalOutput', 'aggregateCeiling', 'ownedPaths', 'nextInvocation')
    if (-not (& $hasNotes $Plan $planNames)) { & $fail }

    $binding = Get-ControllerAllocationPlanMarker -Snapshot $Snapshot -ExpectedOrigin $ExpectedOrigin -Plan $Plan

    # The captured binding decides the shape. A plan outputStopMode annotation is accepted only in the explicit OBSERVE_ONLY shape and
    # only with the exact-ordinal NoteProperty; any other spelling or presence in a legacy plan refuses and never falls back.
    $observeOnly = ($null -ne $binding.allocation.PSObject.Properties['outputStopMode'])
    $planMarkers = @($Plan.PSObject.Properties | Where-Object { [string]::Equals($_.Name, 'outputStopMode', [System.StringComparison]::OrdinalIgnoreCase) })
    if ($observeOnly) {
        if ($planMarkers.Count -ne 1 -or $planMarkers[0].MemberType -ne $noteProperty -or -not [string]::Equals($planMarkers[0].Name, 'outputStopMode', $ordinal)) { & $fail }
    }
    elseif ($planMarkers.Count -ne 0) { & $fail }

    # The captured binding also decides the UNKNOWN-history tags. The plan carries them as exact-ordinal NoteProperties only in that explicit shape; any alias, partial set
    # or presence in another shape refuses and never falls back. These tags are structural: they are compared to the captured binding, never trusted as authority.
    $unknownShape = ($null -ne $binding.allocation.PSObject.Properties['accountingStatus'])
    $unknownTagNames = @('accountingStatus', 'lastVerifiedSubtotal', 'unresolvedFailureReceipt')
    $planTagCount = 0
    foreach ($planMember in @($Plan.PSObject.Properties)) {
        foreach ($tagName in $unknownTagNames) {
            if ([string]::Equals($planMember.Name, $tagName, [System.StringComparison]::OrdinalIgnoreCase)) { $planTagCount++ }
        }
    }
    if ($unknownShape) {
        if (-not $observeOnly -or $planTagCount -ne $unknownTagNames.Count -or -not (& $hasNotes $Plan $unknownTagNames)) { & $fail }
    }
    elseif ($planTagCount -ne 0) { & $fail }

    if ($Owner -isnot [string] -or [string]::IsNullOrWhiteSpace($Owner)) { & $fail }
    if (-not [string]::Equals($Owner, $binding.allocation.owner, $ordinal)) { & $fail }

    $receipt = $Plan.PSObject.Properties['receiptSha256'].Value
    if ($receipt -isnot [string] -or -not [string]::Equals($receipt, $binding.predecessorReceiptSha256, $ordinal)) { & $fail }

    $next = $Plan.PSObject.Properties['nextInvocation'].Value
    if ($null -eq $next -or $next -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
    if (-not (& $hasNotes $next @('maxAttempts', 'maxElapsedMs'))) { & $fail }

    $actualScope = [pscustomobject][ordered]@{
        taskId              = $Plan.PSObject.Properties['actionId'].Value
        owner               = $Owner
        ownedPaths          = $Plan.PSObject.Properties['ownedPaths'].Value
        maxAdditionalOutput = $Plan.PSObject.Properties['maxAdditionalOutput'].Value
        aggregateCeiling    = $Plan.PSObject.Properties['aggregateCeiling'].Value
        maxAttempts         = $next.PSObject.Properties['maxAttempts'].Value
        maxElapsedMs        = $next.PSObject.Properties['maxElapsedMs'].Value
    }
    if ($observeOnly) {
        # Same ordered shape as the captured binding; the plan's null output fields are compared, never cast or defaulted.
        $observeScope = [ordered]@{
            taskId         = $actualScope.taskId
            owner          = $actualScope.owner
            ownedPaths     = $actualScope.ownedPaths
            outputStopMode = $planMarkers[0].Value
        }
        if ($unknownShape) {
            $observeScope['accountingStatus'] = $Plan.PSObject.Properties['accountingStatus'].Value
            $observeScope['lastVerifiedSubtotal'] = $Plan.PSObject.Properties['lastVerifiedSubtotal'].Value
            $observeScope['unresolvedFailureReceipt'] = $Plan.PSObject.Properties['unresolvedFailureReceipt'].Value
        }
        $observeScope['maxAdditionalOutput'] = $actualScope.maxAdditionalOutput
        $observeScope['aggregateCeiling'] = $actualScope.aggregateCeiling
        $observeScope['maxAttempts'] = $actualScope.maxAttempts
        $observeScope['maxElapsedMs'] = $actualScope.maxElapsedMs
        $actualScope = [pscustomobject]$observeScope
    }
    $cumulative = $Plan.PSObject.Properties['cumulativeOutput'].Value
    $planScope = Get-ControllerAllocationScope -Scope $actualScope -CumulativeOutput $cumulative

    # UNKNOWN-history: the plan and the binding both carry an exact null cumulative output; it is never cast to a number, so nothing is compared arithmetically.
    if ($unknownShape) {
        if ($null -ne $cumulative -or $null -ne $binding.cumulativeOutput) { & $fail }
    }
    elseif ([long]$cumulative -ne [long]$binding.cumulativeOutput) { & $fail }
    $a = $planScope | ConvertTo-Json -Depth 6 -Compress
    $b = $binding.allocation | ConvertTo-Json -Depth 6 -Compress
    if (-not [string]::Equals($a, $b, $ordinal)) { & $fail }

    return $binding
}
