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
    $cumulative = $Plan.PSObject.Properties['cumulativeOutput'].Value
    $planScope = Get-ControllerAllocationScope -Scope $actualScope -CumulativeOutput $cumulative

    if ([long]$cumulative -ne [long]$binding.cumulativeOutput) { & $fail }
    $a = $planScope | ConvertTo-Json -Depth 6 -Compress
    $b = $binding.allocation | ConvertTo-Json -Depth 6 -Compress
    if (-not [string]::Equals($a, $b, $ordinal)) { & $fail }

    return $binding
}
