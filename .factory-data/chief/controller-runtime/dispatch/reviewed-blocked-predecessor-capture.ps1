# Pure scalar capture of the previous selected claim and independent expected blocked review.
# Grants no authority; performs no file IO, admission, receipt, status or ACK work.
function Get-ReviewedBlockedPredecessorCapture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$PreviousSelectedClaim,
        [Parameter(Mandatory = $true)][AllowNull()][object]$ExpectedBlockedReview,
        [Parameter(Mandatory = $true)][AllowNull()][object]$StateDir
    )

    $invalid = 'REVIEWED_BLOCKED_PREDECESSOR_INVALID'
    $selectedNames = @('id', 'owner', 'provider', 'route', 'claimId', 'intentId', 'kind', 'receiptSha', 'planSha', 'statePath')
    $reviewNames = @('reviewSha256', 'evidenceSha256')

    # Metadata only: returns the NoteProperty members without reading any value.
    $getMembers = {
        param($Candidate, [string[]]$Expected)
        if ($null -eq $Candidate -or $Candidate -isnot [System.Management.Automation.PSCustomObject]) { throw $invalid }
        $members = @($Candidate.PSObject.Properties)
        if ($members.Count -ne $Expected.Count) { throw $invalid }
        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($member in $members) {
            if ($member.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $invalid }
            if (-not $seen.Add([string]$member.Name)) { throw $invalid }
        }
        foreach ($name in $Expected) {
            if (-not $seen.Contains($name)) { throw $invalid }
        }
        return , $members
    }
    $cloneString = {
        param($Value)
        if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw $invalid }
        return [string]::new($Value.ToCharArray())
    }

    try {
        # Both metadata sets are verified before any field value is read.
        $selectedMembers = & $getMembers $PreviousSelectedClaim $selectedNames
        $reviewMembers = & $getMembers $ExpectedBlockedReview $reviewNames

        $selected = [ordered]@{}
        foreach ($member in $selectedMembers) { $selected[[string]$member.Name] = & $cloneString $member.Value }
        $review = [ordered]@{}
        foreach ($member in $reviewMembers) { $review[[string]$member.Name] = & $cloneString $member.Value }
        $stateDirValue = & $cloneString $StateDir

        $guid = [guid]::Empty
        if (-not [guid]::TryParse($selected['claimId'], [ref]$guid) -or $guid -eq [guid]::Empty) { throw $invalid }
        foreach ($hex in @($selected['receiptSha'], $selected['planSha'], $review['reviewSha256'], $review['evidenceSha256'])) {
            if ($hex.Length -ne 64 -or $hex -cnotmatch '\A[0-9a-f]{64}\z') { throw $invalid }
        }

        $stateDirFull = [System.IO.Path]::GetFullPath($stateDirValue)
        $expectedState = [System.IO.Path]::GetFullPath([System.IO.Path]::Join($stateDirFull, 'continuation-state.json'))
        $actualState = [System.IO.Path]::GetFullPath($selected['statePath'])
        if (-not [string]::Equals($expectedState, $actualState, [System.StringComparison]::OrdinalIgnoreCase)) { throw $invalid }

        [pscustomobject]@{
            schema              = 'ReviewedBlockedPredecessorCapture/v1'
            previousSelectedClaim = [pscustomobject]@{
                id         = $selected['id']
                owner      = $selected['owner']
                provider   = $selected['provider']
                route      = $selected['route']
                claimId    = $selected['claimId']
                intentId   = $selected['intentId']
                kind       = $selected['kind']
                receiptSha = $selected['receiptSha']
                planSha    = $selected['planSha']
                statePath  = $selected['statePath']
            }
            expectedReview      = [pscustomobject]@{
                reviewSha256   = $review['reviewSha256']
                evidenceSha256 = $review['evidenceSha256']
            }
            stateDirFull        = [string]::new($stateDirFull.ToCharArray())
        }
    }
    catch {
        throw $invalid
    }
}