function Get-ControllerAllocationTarget {
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$ExpectedAllocationTarget,
        [Parameter(Mandatory = $true)][AllowNull()][object]$StateDir
    )
    try {
        if ($null -eq $ExpectedAllocationTarget -or $null -eq $StateDir) { throw 'invalid' }
        if ($ExpectedAllocationTarget -isnot [System.Management.Automation.PSCustomObject]) { throw 'invalid' }
        $props = @($ExpectedAllocationTarget.PSObject.Properties)
        if ($props.Count -ne 2) { throw 'invalid' }
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($p in $props) {
            if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw 'invalid' }
            if (-not $names.Add([string]$p.Name)) { throw 'invalid' }
        }
        if (-not ($names.Contains('stateDir') -and $names.Contains('planSha256'))) { throw 'invalid' }
        $targetDir = $ExpectedAllocationTarget.stateDir
        $plan = $ExpectedAllocationTarget.planSha256
        if ($targetDir -isnot [string] -or $StateDir -isnot [string]) { throw 'invalid' }
        if ([string]::IsNullOrWhiteSpace($targetDir) -or [string]::IsNullOrWhiteSpace($StateDir)) { throw 'invalid' }
        if (-not [System.IO.Path]::IsPathRooted([string]$targetDir)) { throw 'invalid' }
        if (-not [System.IO.Path]::IsPathRooted([string]$StateDir)) { throw 'invalid' }
        $fullTarget = [System.IO.Path]::GetFullPath([string]$targetDir)
        $fullActual = [System.IO.Path]::GetFullPath([string]$StateDir)
        if (-not [string]::Equals($fullTarget, $fullActual, [System.StringComparison]::Ordinal)) { throw 'invalid' }
        if ($plan -isnot [string] -or $plan.Length -ne 64 -or $plan -cnotmatch '\A[0-9a-f]{64}\z') { throw 'invalid' }
        return [pscustomobject][ordered]@{ stateDir = $fullTarget; planSha256 = [string]$plan }
    }
    catch {
        throw 'CONTROLLER_ALLOCATION_INVALID'
    }
}
