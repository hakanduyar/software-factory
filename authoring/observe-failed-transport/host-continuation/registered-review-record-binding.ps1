function Get-RegisteredReviewRecordBinding {
    [CmdletBinding()]
    param(
        [Parameter()][AllowNull()][object]$RegistrationPath,
        [Parameter()][AllowNull()][object]$ExpectedRegistrationSha256,
        [Parameter()][AllowNull()][object]$ExpectedTerminalBindingSha256,
        [Parameter()][AllowNull()][object]$ExpectedReviewCompletionSha256,
        [Parameter()][AllowNull()][object]$OnReviewedTerminal
    )

    $invalid = 'REGISTERED_REVIEW_REPLAY_INVALID'

    try {
        # Capture and validate every scalar before any import or file IO.
        if ($RegistrationPath -isnot [string] -or $OnReviewedTerminal -isnot [scriptblock]) { throw $invalid }
        foreach ($h in @($ExpectedRegistrationSha256, $ExpectedTerminalBindingSha256, $ExpectedReviewCompletionSha256)) {
            if ($h -isnot [string] -or $h.Length -ne 64 -or $h -cnotmatch '\A[0-9a-f]{64}\z') { throw $invalid }
        }
        $pathText = [string]$RegistrationPath
        if ([string]::IsNullOrWhiteSpace($pathText) -or $pathText.IndexOf([char]0) -ge 0) { throw $invalid }
        if (-not [System.IO.Path]::IsPathFullyQualified($pathText)) { throw $invalid }
        if ([System.IO.Path]::GetFullPath($pathText) -cne $pathText) { throw $invalid }
        $registrationSha = [string]$ExpectedRegistrationSha256
        $terminalSha = [string]$ExpectedTerminalBindingSha256
        $reviewSha = [string]$ExpectedReviewCompletionSha256
        $handler = $OnReviewedTerminal

        # Function-local imports of the exact accepted siblings.
        . (Join-Path $PSScriptRoot 'registered-review-record-reader.ps1')
        . (Join-Path $PSScriptRoot 'registered-review-prelaunch-capture.ps1')
        . (Join-Path $PSScriptRoot 'registered-review-completion-capture.ps1')

        $registrationRead = Read-RegisteredReviewRecord -Path $pathText -ExpectedSha256 $registrationSha
        $prelaunch = Get-RegisteredReviewPrelaunchCapture -Registration $registrationRead.record -ExpectedRegistrationSha256 $registrationSha -OnReviewedTerminal $handler

        # Only the paths returned by the typed prelaunch capture are read.
        $terminalRead = Read-RegisteredReviewRecord -Path $prelaunch.registration.terminalBindingPath -ExpectedSha256 $terminalSha
        $reviewRead = Read-RegisteredReviewRecord -Path $prelaunch.registration.reviewCompletionPath -ExpectedSha256 $reviewSha

        $completion = Get-RegisteredReviewCompletionCapture -CapturedPrelaunch $prelaunch -TerminalBinding $terminalRead.record -TerminalBindingSha256 $terminalRead.sha256 -ReviewCompletion $reviewRead.record

        return [pscustomobject][ordered]@{
            prelaunch                = $completion.prelaunch
            terminalBinding          = $completion.terminalBinding
            reviewCompletion         = $completion.reviewCompletion
            registrationFileSha256   = [string]$registrationRead.sha256
            terminalBindingFileSha256 = [string]$terminalRead.sha256
            reviewCompletionFileSha256 = [string]$reviewRead.sha256
        }
    }
    catch {
        throw $invalid
    }
}
