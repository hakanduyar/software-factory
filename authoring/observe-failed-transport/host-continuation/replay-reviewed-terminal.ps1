function Invoke-RegisteredReviewedTerminalReplay {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$RegistrationPath,
        [Parameter(Mandatory)][object]$ExpectedRegistrationSha256,
        [Parameter(Mandatory)][object]$ExpectedTerminalBindingSha256,
        [Parameter(Mandatory)][object]$ExpectedReviewCompletionSha256,
        [Parameter(Mandatory)][object]$OnReviewedTerminal
    )
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # Capture the original scalar inputs immutably before any import or IO.
    $capturedPath = $RegistrationPath
    $capturedRegSha = $ExpectedRegistrationSha256
    $capturedTermSha = $ExpectedTerminalBindingSha256
    $capturedReviewSha = $ExpectedReviewCompletionSha256
    $capturedHandler = $OnReviewedTerminal
    if ($capturedPath -isnot [string] -or [string]::IsNullOrWhiteSpace($capturedPath) -or -not [System.IO.Path]::IsPathRooted($capturedPath)) {
        throw 'Refusing: RegistrationPath must be a full canonical path string.'
    }
    if ([System.IO.Path]::GetFullPath($capturedPath) -cne $capturedPath) {
        throw 'Refusing: RegistrationPath must be a full canonical path string.'
    }

    # Function-local imports only; no fallback to same-named foreign functions.
    $contextPath = Join-Path $PSScriptRoot 'registered-review-replay-context.ps1'
    $launchPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'runner/launch.ps1'
    . $contextPath
    . $launchPath
    $contextCmd = Get-Command -Name 'Get-RegisteredReviewReplayContext' -CommandType Function -ErrorAction Stop
    $collectorCmd = Get-Command -Name 'Invoke-ManagedNativeCollector' -CommandType Function -ErrorAction Stop
    if ([System.IO.Path]::GetFullPath([string]$contextCmd.ScriptBlock.File) -ine [System.IO.Path]::GetFullPath($contextPath)) {
        throw 'Refusing: Get-RegisteredReviewReplayContext is not the sibling import.'
    }
    if ([System.IO.Path]::GetFullPath([string]$collectorCmd.ScriptBlock.File) -ine [System.IO.Path]::GetFullPath($launchPath)) {
        throw 'Refusing: Invoke-ManagedNativeCollector is not the runner import.'
    }
    $getContext = $contextCmd.ScriptBlock

    $initial = & $getContext -RegistrationPath $capturedPath -ExpectedRegistrationSha256 $capturedRegSha `
        -ExpectedTerminalBindingSha256 $capturedTermSha -ExpectedReviewCompletionSha256 $capturedReviewSha `
        -OnReviewedTerminal $capturedHandler
    $exact = @('schema', 'binding', 'request', 'runDir', 'startAcknowledgementContext', 'fingerprint')
    $initialNames = @($initial.PSObject.Properties.Name)
    if ($initial -isnot [PSCustomObject] -or $initialNames.Count -ne $exact.Count) { throw 'Refusing: replay context shape is invalid.' }
    foreach ($n in $exact) { if ($initialNames -cnotcontains $n) { throw 'Refusing: replay context shape is invalid.' } }
    if ($initial.request -isnot [hashtable] -or $initial.startAcknowledgementContext -isnot [hashtable] -or $initial.runDir -isnot [string]) {
        throw 'Refusing: replay context members are invalid.'
    }
    if ($initial.fingerprint -isnot [string] -or $initial.fingerprint -cnotmatch '^[0-9a-f]{64}$') { throw 'Refusing: replay context fingerprint is invalid.' }
    $initialFingerprint = [string]$initial.fingerprint
    $bindingOne = $initial.binding
    $returnedHandler = $bindingOne.prelaunch.onReviewedTerminal
    $lateRegSha = [string]$bindingOne.registrationFileSha256
    $lateTermSha = [string]$bindingOne.terminalBindingFileSha256
    $lateReviewSha = [string]$bindingOne.reviewCompletionFileSha256

    $projectionCallback = {
        param($ref)
        $fresh = & $getContext -RegistrationPath $capturedPath -ExpectedRegistrationSha256 $lateRegSha `
            -ExpectedTerminalBindingSha256 $lateTermSha -ExpectedReviewCompletionSha256 $lateReviewSha `
            -OnReviewedTerminal $returnedHandler
        if (-not [string]::Equals([string]$fresh.fingerprint, $initialFingerprint, [StringComparison]::Ordinal)) { throw 'Refusing: replay context fingerprint changed.' }
        $tb = $fresh.binding.terminalBinding
        $checks = @(
            [string]::Equals([string]$ref.RunId, [string]$tb.runId, [StringComparison]::Ordinal),
            ([int64]$ref.Attempt -eq [int64]$tb.attempt),
            [string]::Equals([string]$ref.RunDir, [string]$fresh.runDir, [StringComparison]::Ordinal),
            [string]::Equals([string]$ref.RequestSha256, [string]$tb.requestSha256, [StringComparison]::Ordinal),
            [string]::Equals([string]$ref.ManifestPath, [string]$tb.manifestPath, [StringComparison]::Ordinal),
            [string]::Equals([string]$ref.ManifestSha256, [string]$tb.manifestSha256, [StringComparison]::Ordinal),
            [string]::Equals([string]$ref.StartPath, [string]$tb.startPath, [StringComparison]::Ordinal),
            [string]::Equals([string]$ref.TerminalPath, [string]$tb.terminalPath, [StringComparison]::Ordinal),
            [string]::Equals([string]$ref.TerminalSha256, [string]$tb.terminalSha256, [StringComparison]::Ordinal)
        )
        if ($checks -contains $false) { throw 'Refusing: collector reference does not match the reviewed terminal binding.' }
        & $returnedHandler $fresh.binding
    }.GetNewClosure()

    $result = Invoke-ManagedNativeCollector -Request $initial.request -RunDir $initial.runDir `
        -StartAcknowledgementContext $initial.startAcknowledgementContext -TerminalProjection $projectionCallback
    if ($result.State -cne 'TERMINAL' -or $result.ProjectionStatus -cne 'DONE') {
        throw ('Refusing: reviewed terminal replay did not reach DONE (' + [string]$result.State + '/' + [string]$result.ProjectionStatus + ').')
    }
    return $result
}
