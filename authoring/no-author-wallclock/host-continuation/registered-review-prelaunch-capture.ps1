function Get-RegisteredReviewPrelaunchCapture {
    [CmdletBinding()]
    param(
        [Parameter()][AllowNull()][object]$Registration,
        [Parameter()][AllowNull()][object]$ExpectedRegistrationSha256,
        [Parameter()][AllowNull()][object]$OnReviewedTerminal
    )

    $invalid = 'REGISTERED_REVIEW_REPLAY_INVALID'
    $fields = @(
        'schema', 'registrationId', 'taskId', 'attempt', 'requestPath', 'requestSha256',
        'runDir', 'ticketPath', 'ticketSha256', 'payloadPath', 'payloadSha256',
        'candidatePath', 'terminalBindingPath', 'reviewCompletionPath',
        'automationId', 'automationTargetThreadId', 'periodMinutes', 'registeredActionId'
    )
    $shaFields = @('requestSha256', 'ticketSha256', 'payloadSha256')
    $pathFields = @('requestPath', 'runDir', 'ticketPath', 'payloadPath', 'candidatePath', 'terminalBindingPath', 'reviewCompletionPath')

    try {
        if ($null -eq $Registration -or $Registration -isnot [System.Management.Automation.PSCustomObject]) { throw $invalid }
        if ($OnReviewedTerminal -isnot [scriptblock]) { throw $invalid }
        if ($ExpectedRegistrationSha256 -isnot [string]) { throw $invalid }
        if ($ExpectedRegistrationSha256.Length -ne 64 -or $ExpectedRegistrationSha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw $invalid }

        # Metadata only: PSMemberInfo enumeration of NoteProperty entries; no .Value reads yet.
        $props = @($Registration.PSObject.Properties)
        if ($props.Count -ne 18) { throw $invalid }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($p in $props) {
            if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $invalid }
            $known = $false
            foreach ($fieldName in $fields) {
                if ([string]::Equals($fieldName, [string]$p.Name, [System.StringComparison]::Ordinal)) { $known = $true; break }
            }
            if (-not $known) { throw $invalid }
            if (-not $seen.Add($p.Name)) { throw $invalid }
        }
        if ($seen.Count -ne 18) { throw $invalid }

        # Values are read only after all metadata passed.
        $v = @{}
        foreach ($p in $props) { $v[$p.Name] = $p.Value }

        foreach ($f in $fields) {
            if ($f -eq 'attempt') {
                if (($v[$f] -isnot [int] -and $v[$f] -isnot [long]) -or $v[$f] -lt 1) { throw $invalid }
            }
            elseif ($f -eq 'periodMinutes') {
                if (($v[$f] -isnot [int] -and $v[$f] -isnot [long]) -or $v[$f] -ne 20) { throw $invalid }
            }
            elseif ($v[$f] -isnot [string] -or [string]::IsNullOrWhiteSpace($v[$f])) { throw $invalid }
        }
        if (-not [string]::Equals([string]$v['schema'], 'RegisteredReviewReplay/v1', [System.StringComparison]::Ordinal)) { throw $invalid }
        if (-not [string]::Equals([string]$v['automationId'], 'software-factory-devam-kontrol', [System.StringComparison]::Ordinal)) { throw $invalid }
        if (-not [string]::Equals([string]$v['automationTargetThreadId'], '01a155f8-8a95-7910-9e74-bb7b793d46f9', [System.StringComparison]::Ordinal)) { throw $invalid }
        foreach ($f in $shaFields) {
            if ($v[$f].Length -ne 64 -or $v[$f] -cnotmatch '\A[0-9a-f]{64}\z') { throw $invalid }
        }
        foreach ($f in $pathFields) {
            if (-not [System.IO.Path]::IsPathFullyQualified($v[$f])) { throw $invalid }
            if ([System.IO.Path]::GetFullPath($v[$f]) -cne $v[$f]) { throw $invalid }
        }

        $clone = [ordered]@{}
        foreach ($f in $fields) {
            $clone[$f] = if ($f -eq 'attempt') { [long]$v[$f] } elseif ($f -eq 'periodMinutes') { [int]$v[$f] } else { [string]$v[$f] }
        }

        return [pscustomobject][ordered]@{
            registration               = [pscustomobject]$clone
            expectedRegistrationSha256 = [string]$ExpectedRegistrationSha256
            onReviewedTerminal         = $OnReviewedTerminal
        }
    }
    catch {
        throw $invalid
    }
}
