. (Join-Path $PSScriptRoot 'controller-allocation-target.p03-stage22.ps1')
. (Join-Path $PSScriptRoot 'controller-allocation-planreader.p03-stage24.ps1')
. (Join-Path $PSScriptRoot 'controller-allocation-input.p03-stage18.ps1')
. (Join-Path $PSScriptRoot 'controller-allocation-planscope.p03-stage19.ps1')

function Get-ControllerAllocationPrestate {
    # ControllerPrestateCapture/v1: cooperative read-only capture; not authority, C3, claim or Step integration.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $StateDir,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $ReceiptPath,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $PlanPath,
        [Parameter(Mandatory = $true)] [AllowNull()] [object] $Owner,
        [AllowNull()] [object] $AllocationSnapshot,
        [AllowNull()] [object] $ExpectedAllocationOrigin,
        [AllowNull()] [object] $NextTicketPath,
        [AllowNull()] [object] $NextPayloadPath,
        [AllowNull()] [object] $ExpectedAllocationTarget
    )

    $fail = 'CONTROLLER_ALLOCATION_INVALID'
    $ordinal = [System.StringComparison]::Ordinal
    try {
        $optional = 'AllocationSnapshot', 'ExpectedAllocationOrigin', 'NextTicketPath', 'NextPayloadPath', 'ExpectedAllocationTarget'
        $count = 0
        foreach ($n in $optional) { if ($PSBoundParameters.ContainsKey($n)) { $count++ } }
        if ($count -ne 0 -and $count -ne 5) { throw $fail }
        $optIn = ($count -eq 5)

        foreach ($v in $StateDir, $ReceiptPath, $PlanPath, $Owner) {
            if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v)) { throw $fail }
        }
        foreach ($v in $StateDir, $ReceiptPath, $PlanPath) {
            if (-not [System.IO.Path]::IsPathRooted($v)) { throw $fail }
        }
        if ($optIn) {
            if ($null -eq $AllocationSnapshot -or $null -eq $ExpectedAllocationOrigin -or $null -eq $ExpectedAllocationTarget) { throw $fail }
            foreach ($v in $NextTicketPath, $NextPayloadPath) {
                if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v) -or -not [System.IO.Path]::IsPathRooted($v)) { throw $fail }
            }
            $target = Get-ControllerAllocationTarget -ExpectedAllocationTarget $ExpectedAllocationTarget -StateDir $StateDir
            $expectedHash = $target.planSha256
            $binding = Get-ControllerAllocationInputBinding -Snapshot $AllocationSnapshot -ExpectedOrigin $ExpectedAllocationOrigin `
                -ReceiptPath $ReceiptPath -NextTicketPath $NextTicketPath -NextPayloadPath $NextPayloadPath
            $initial = $binding | ConvertTo-Json -Depth 12 -Compress
        }
        else {
            $target = $null
            $expectedHash = $null
        }

        $reader = Read-ControllerAllocationPlan -PlanPath $PlanPath -ExpectedPlanSha256 $expectedHash
        $markerProp = $reader.plan.PSObject.Properties['allocationBindingSha256']
        $hasMarker = ($null -ne $markerProp -and $markerProp.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty)

        if (-not $optIn) {
            if ($hasMarker) { throw $fail }
            return [pscustomobject][ordered]@{ enabled = $false }
        }
        if (-not $hasMarker) { throw $fail }

        $origin = [pscustomobject][ordered]@{
            issuerId                 = [string]$binding.issuerId
            authoritySha256          = [string]$binding.authoritySha256
            phaseId                  = [string]$binding.phaseId
            predecessorReceiptSha256 = [string]$binding.predecessorReceiptSha256
            nextTicketSha256         = [string]$binding.nextTicketSha256
            nextPayloadSha256        = [string]$binding.nextPayloadSha256
        }
        $scopeSnapshot = ConvertFrom-Json -InputObject $initial -DateKind String -NoEnumerate
        $roundTrip = $scopeSnapshot | ConvertTo-Json -Depth 12 -Compress
        if (-not [string]::Equals($initial, $roundTrip, $ordinal)) { throw $fail }
        $verified = Get-ControllerAllocationPlanScope -Snapshot $scopeSnapshot -ExpectedOrigin $origin -Plan $reader.plan -Owner $Owner
        $after = $verified | ConvertTo-Json -Depth 12 -Compress
        if (-not [string]::Equals($initial, $after, $ordinal)) { throw $fail }

        return [pscustomobject][ordered]@{
            enabled       = $true
            stateDir      = $target.stateDir
            plan          = $reader.plan
            json          = $reader.json
            planSha256    = $reader.sha256
            receiptSha256 = $binding.predecessorReceiptSha256
            binding       = $binding
        }
    }
    catch {
        throw 'CONTROLLER_ALLOCATION_INVALID'
    }
}
