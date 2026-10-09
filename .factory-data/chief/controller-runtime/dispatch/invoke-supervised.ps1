#Requires -Version 7.0

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'receipt-adapter.ps1')
. (Join-Path $here 'continuation-step.ps1')

function Invoke-SupervisedTerminal {
    param(
        [Parameter(Mandatory)][string]$RawPath,
        [Parameter(Mandatory)][string]$TicketPath,
        [Parameter(Mandatory)][string]$UsagePath,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][int]$Attempt,
        [Parameter(Mandatory)][int]$MaxAttempts,
        [Parameter(Mandatory)][long]$PriorElapsedMs,
        [Parameter(Mandatory)][long]$MaxElapsedMs,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [Parameter(Mandatory)][string]$PlanPath,
        [Parameter(Mandatory)][string]$StateDir,
        [Parameter(Mandatory)][string]$Owner,
        [hashtable]$HostLifecycleContext
    )

    if ($PSBoundParameters.ContainsKey('HostLifecycleContext')) {
        $hc = $HostLifecycleContext
        $refuse = {
            param([string]$Why)
            [PSCustomObject]@{ status = 'RECONCILIATION_REQUIRED'; reason = 'HOST_CONTEXT_INVALID'; detail = $Why; claimResult = $null }
        }
        $coreKeys = @('PreviousSelectedClaim', 'Dispatch', 'CheckpointPath', 'VaultPath', 'EvidenceRoot', 'QueuePath', 'NormalQuotaPath')
        $optKeys = @('CloudQuotaPath', 'PostCoreStateProducer', 'LocalSyncConfig', 'GitHubSyncConfig', 'CompletedNativeEvidence')
        $knownKeys = @($coreKeys + $optKeys)
        if ($hc -isnot [hashtable]) { return (& $refuse 'invalid HostLifecycleContext') }
        foreach ($key in @($hc.Keys)) {
            if ($key -isnot [string] -or $knownKeys -notcontains $key) { return (& $refuse 'unknown key') }
        }
        foreach ($key in $coreKeys) {
            if (-not $hc.ContainsKey($key)) { return (& $refuse ('missing ' + $key)) }
        }
        if ($hc['PreviousSelectedClaim'] -isnot [PSCustomObject]) { return (& $refuse 'invalid PreviousSelectedClaim') }
        if ($hc['Dispatch'] -isnot [scriptblock]) { return (& $refuse 'invalid Dispatch') }
        foreach ($key in @('CheckpointPath', 'VaultPath', 'EvidenceRoot', 'QueuePath', 'NormalQuotaPath')) {
            $v = $hc[$key]
            if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v)) { return (& $refuse ('invalid ' + $key)) }
        }
        if ($hc.ContainsKey('CloudQuotaPath')) {
            $v = $hc['CloudQuotaPath']
            if ($null -ne $v -and $v -isnot [string]) { return (& $refuse 'invalid CloudQuotaPath') }
        }
        if ($hc.ContainsKey('PostCoreStateProducer') -and $null -ne $hc['PostCoreStateProducer'] -and $hc['PostCoreStateProducer'] -isnot [scriptblock]) { return (& $refuse 'invalid PostCoreStateProducer') }
        if ($hc.ContainsKey('LocalSyncConfig') -and $null -ne $hc['LocalSyncConfig'] -and $hc['LocalSyncConfig'] -isnot [hashtable]) { return (& $refuse 'invalid LocalSyncConfig') }
        if ($hc.ContainsKey('GitHubSyncConfig') -and $null -ne $hc['GitHubSyncConfig'] -and $hc['GitHubSyncConfig'] -isnot [hashtable]) { return (& $refuse 'invalid GitHubSyncConfig') }
        if ($hc.ContainsKey('CompletedNativeEvidence') -and $hc['CompletedNativeEvidence'] -isnot [PSCustomObject]) { return (& $refuse 'invalid CompletedNativeEvidence') }

        $terminalArguments = @{
            RawPath        = $RawPath
            TicketPath     = $TicketPath
            UsagePath      = $UsagePath
            RunId          = $RunId
            Attempt        = $Attempt
            MaxAttempts    = $MaxAttempts
            PriorElapsedMs = $PriorElapsedMs
            MaxElapsedMs   = $MaxElapsedMs
            ReceiptPath    = $ReceiptPath
            PlanPath       = $PlanPath
        }
        if ($hc.ContainsKey('CompletedNativeEvidence')) { $terminalArguments['CompletedNativeEvidence'] = $hc['CompletedNativeEvidence'] }

        $callParams = @{
            TerminalArguments     = $terminalArguments
            PreviousSelectedClaim = $hc['PreviousSelectedClaim']
            Dispatch              = $hc['Dispatch']
            CheckpointPath        = $hc['CheckpointPath']
            VaultPath             = $hc['VaultPath']
            EvidenceRoot          = $hc['EvidenceRoot']
            QueuePath             = $hc['QueuePath']
            StateDir              = $StateDir
            NormalQuotaPath       = $hc['NormalQuotaPath']
            Owner                 = $Owner
        }
        foreach ($key in @('CloudQuotaPath', 'PostCoreStateProducer', 'LocalSyncConfig', 'GitHubSyncConfig')) {
            if ($hc.ContainsKey($key)) { $callParams[$key] = $hc[$key] }
        }

        try {
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'host-continuation/select-next-ready.ps1')
        } catch {
            return [PSCustomObject]@{ status = 'RECONCILIATION_REQUIRED'; reason = 'HOST_CONTINUATION_UNAVAILABLE'; claimResult = $null }
        }

        return (Invoke-PublishedSettledHostContinuation @callParams)
    }

    if (-not (Test-Path -LiteralPath $StateDir)) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    }

    try {
        $adapter = ConvertTo-TerminalReceipt -RawPath $RawPath -TicketPath $TicketPath -UsagePath $UsagePath `
            -RunId $RunId -Attempt $Attempt -MaxAttempts $MaxAttempts -PriorElapsedMs $PriorElapsedMs `
            -MaxElapsedMs $MaxElapsedMs -ReceiptPath $ReceiptPath
    } catch {
        $reason = 'Adapter invocation failed.'
        $evidencePath = Join-Path $StateDir 'terminal-adapter-failure.json'
        [PSCustomObject]@{ reason = $reason; timestampUtc = (Get-Date).ToUniversalTime().ToString('o') } |
            ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $evidencePath -Encoding utf8
        return [PSCustomObject]@{ status = 'RECONCILE_EVIDENCE'; claimResult = $null; failureEvidencePath = $evidencePath }
    }

    if (-not $adapter.valid) {
        $reason = [string]$adapter.reason
        if ($reason.Length -gt 512) { $reason = $reason.Substring(0, 512) }
        $evidencePath = Join-Path $StateDir 'terminal-adapter-failure.json'
        [PSCustomObject]@{
            reason        = $reason
            rawSha256     = $adapter.rawSha256
            ticketSha256  = $adapter.ticketSha256
            timestampUtc  = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $evidencePath -Encoding utf8
        return [PSCustomObject]@{ status = 'RECONCILE_EVIDENCE'; claimResult = $null; failureEvidencePath = $evidencePath }
    }

    try {
        $plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
    } catch {
        return [PSCustomObject]@{ status = 'WAIT_DEPENDENCY'; claimResult = $null; classification = $adapter.classification }
    }

    if (-not $plan) {
        return [PSCustomObject]@{ status = 'WAIT_DEPENDENCY'; claimResult = $null; classification = $adapter.classification }
    }

    $depsReady = $plan.PSObject.Properties['dependenciesReady']
    if (-not $depsReady -or $depsReady.Value -isnot [bool] -or $depsReady.Value -ne $true) {
        return [PSCustomObject]@{ status = 'WAIT_DEPENDENCY'; claimResult = $null; classification = $adapter.classification }
    }

    $claim = Invoke-ContinuationStep -StateDir $StateDir -ReceiptPath $adapter.receiptPath -PlanPath $PlanPath -Owner $Owner -Claim

    return [PSCustomObject]@{
        status         = $claim.status
        claimResult    = $claim.claimResult
        claim          = $claim
        classification = $adapter.classification
        receiptPath    = $adapter.receiptPath
        receiptSha256  = $adapter.receiptSha256
    }
}
