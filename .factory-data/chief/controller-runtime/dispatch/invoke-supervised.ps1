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
        [Parameter(Mandatory)][string]$Owner
    )

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
