. (Join-Path $PSScriptRoot 'controller-allocation-binding.ps1')

function Get-ControllerAllocationPlanMarker {
    # Equality capture only: not authority, authentication, READY or Step integration.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Snapshot,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $ExpectedOrigin,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Plan
    )

    $fail = { throw 'CONTROLLER_ALLOCATION_INVALID' }
    $binding = Get-ControllerAllocationBinding -Snapshot $Snapshot -ExpectedOrigin $ExpectedOrigin

    # Metadata first: the getter runs only after the exact NoteProperty is proven.
    if ($null -eq $Plan -or $Plan -isnot [System.Management.Automation.PSCustomObject]) { & $fail }
    $found = @($Plan.PSObject.Properties | Where-Object { [string]::Equals($_.Name, 'allocationBindingSha256', [System.StringComparison]::Ordinal) })
    if ($found.Count -ne 1 -or $found[0].MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { & $fail }

    $marker = $Plan.PSObject.Properties['allocationBindingSha256'].Value
    if ($marker -isnot [string] -or $marker.Length -ne 64 -or $marker -cnotmatch '\A[0-9a-f]{64}\z') { & $fail }

    $json = $binding | ConvertTo-Json -Depth 12 -Compress
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $actual = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($json))) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if (-not [string]::Equals($marker, $actual, [System.StringComparison]::Ordinal)) { & $fail }

    return $binding
}
