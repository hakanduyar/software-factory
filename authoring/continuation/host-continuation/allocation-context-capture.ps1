. (Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatch/controller-allocation-binding.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatch/controller-allocation-target.p03-stage22.ps1')

function Get-HostAllocationContextsCapture {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$AllocationContexts,
        [AllowNull()][object]$StateDir
    )

    $fail = { throw 'HOST_ALLOCATION_CONTEXT_INVALID' }
    $fields = @('EntryId', 'AllocationSnapshot', 'ExpectedAllocationOrigin', 'NextTicketPath', 'NextPayloadPath', 'ExpectedAllocationTarget')
    $originNames = @('issuerId', 'authoritySha256', 'phaseId', 'predecessorReceiptSha256', 'nextTicketSha256', 'nextPayloadSha256')

    try {
        if ($null -eq $AllocationContexts -or $AllocationContexts.GetType() -ne [object[]]) { & $fail }
        $records = [object[]]$AllocationContexts
        if ($records.Length -lt 1 -or $records.Length -gt 32) { & $fail }

        # Pass 1: shape only, before any record value is read.
        foreach ($rec in $records) {
            if ($null -eq $rec) { & $fail }
            $members = @($rec.PSObject.Properties)
            if ($members.Count -ne 6) { & $fail }
            $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($m in $members) {
                if ($m.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { & $fail }
                if ($fields -cnotcontains $m.Name -or -not $seen.Add($m.Name)) { & $fail }
            }
        }

        # Pass 2: single read of each value, then capture.
        $ids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        $results = [System.Collections.Generic.List[object]]::new()
        foreach ($rec in $records) {
            $id = $rec.EntryId
            $snapshot = $rec.AllocationSnapshot
            $origin = $rec.ExpectedAllocationOrigin
            $ticket = $rec.NextTicketPath
            $payload = $rec.NextPayloadPath
            $target = $rec.ExpectedAllocationTarget

            if ($id -isnot [string] -or [string]::IsNullOrWhiteSpace($id) -or -not $ids.Add($id)) { & $fail }

            $paths = foreach ($p in @($ticket, $payload)) {
                if ($p -isnot [string] -or [string]::IsNullOrWhiteSpace($p) -or -not [System.IO.Path]::IsPathRooted($p)) { & $fail }
                [System.IO.Path]::GetFullPath($p)
            }

            $binding = Get-ControllerAllocationBinding -Snapshot $snapshot -ExpectedOrigin $origin
            $targetClone = Get-ControllerAllocationTarget -ExpectedAllocationTarget $target -StateDir $StateDir

            $json = ConvertTo-Json -InputObject $binding -Depth 10 -Compress
            $clone = ConvertFrom-Json -InputObject $json -DateKind String -NoEnumerate
            if ((ConvertTo-Json -InputObject $clone -Depth 10 -Compress) -cne $json) { & $fail }

            $originClone = [pscustomobject]@{}
            foreach ($n in $originNames) {
                $v = $clone.$n
                if ($v -isnot [string]) { & $fail }
                $originClone | Add-Member -MemberType NoteProperty -Name $n -Value $v
            }
            $targetOut = [pscustomobject][ordered]@{
                stateDir   = [string]$targetClone.stateDir
                planSha256 = [string]$targetClone.planSha256
            }

            $results.Add([pscustomobject][ordered]@{
                EntryId                  = [string]$id
                AllocationSnapshot       = $clone
                ExpectedAllocationOrigin = $originClone
                NextTicketPath           = [string]$paths[0]
                NextPayloadPath          = [string]$paths[1]
                ExpectedAllocationTarget = $targetOut
            })
        }
        return , ([object[]]$results.ToArray())
    }
    catch {
        throw 'HOST_ALLOCATION_CONTEXT_INVALID'
    }
}
