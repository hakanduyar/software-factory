# Reviewed blocked direct-settlement inputs: composes accepted capture A, input buffers, facts and budget comparator.
# No writes, no state/ACK/claim semantics; all numerical/UTC work is delegated to Test-ReviewedBlockedSettlementBudget.
. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-terminal-capture.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-input-buffers.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-facts.ps1')
. (Join-Path -Path $PSScriptRoot -ChildPath 'reviewed-blocked-budget.ps1')

function Get-VerifiedBlockedSettlementInputs {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$ExpectedBlockedReview,
        [AllowNull()][object]$TerminalReceiptPath,
        [AllowNull()][object]$TerminalSha256
    )

    $failure = 'REVIEWED_BLOCKED_SETTLEMENT_INPUTS_INVALID'
    try {
        # NoteProperty metadata is checked before any getter runs.
        $note = {
            param($Object, [string]$Name)
            if ($null -eq $Object -or $Object -isnot [System.Management.Automation.PSCustomObject]) { throw $failure }
            $m = @($Object.PSObject.Properties | Where-Object { [string]::Equals($_.Name, $Name, [System.StringComparison]::Ordinal) })
            if ($m.Count -ne 1 -or $m[0].MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $failure }
            return $m[0].Value
        }
        $ordinal = {
            param($A, $B)
            if ($A -isnot [string] -or $B -isnot [string] -or [string]::IsNullOrEmpty($A)) { throw $failure }
            if (-not [string]::Equals($A, $B, [System.StringComparison]::Ordinal)) { throw $failure }
        }
        $isInt = { param($V) return ($V -is [int]) -or ($V -is [long]) }
        $samePath = {
            param($A, $B)
            if ($A -isnot [string] -or $B -isnot [string]) { throw $failure }
            if (-not [System.IO.Path]::IsPathFullyQualified($A) -or -not [System.IO.Path]::IsPathFullyQualified($B)) { throw $failure }
            if (-not [string]::Equals([System.IO.Path]::GetFullPath($A), [System.IO.Path]::GetFullPath($B), [System.StringComparison]::OrdinalIgnoreCase)) { throw $failure }
        }
        $sameHash = {
            param($A, $B)
            if ($A -isnot [string] -or $B -isnot [string]) { throw $failure }
            if (-not ($A -match '^[0-9a-fA-F]{64}\z') -or -not ($B -match '^[0-9a-fA-F]{64}\z')) { throw $failure }
            if (-not [string]::Equals($A.ToLowerInvariant(), $B.ToLowerInvariant(), [System.StringComparison]::Ordinal)) { throw $failure }
        }

        # Accepted A once on the original parameters; only its returned values are used afterwards.
        $a = Get-BlockedSettlementTerminalCapture -ExpectedBlockedReview $ExpectedBlockedReview -TerminalReceiptPath $TerminalReceiptPath -TerminalSha256 $TerminalSha256
        if ($null -eq $a -or $a -isnot [System.Management.Automation.PSCustomObject]) { throw $failure }
        $terminal = & $note $a 'terminal'
        $aExpected = & $note $a 'expected'
        $aSha = & $note $a 'terminalSha256'
        $aPath = & $note $a 'receiptPath'
        if ($terminal -isnot [System.Management.Automation.PSCustomObject]) { throw $failure }
        if ($aSha -isnot [string] -or $aPath -isnot [string]) { throw $failure }

        $tDisp = & $note $terminal 'reviewedDisposition'
        $tDispEvidence = & $note $tDisp 'evidence'

        $buffers = Get-ReviewedBlockedInputBuffers -ReviewedBlockedEvidence $tDispEvidence -ExpectedBlockedReview $aExpected
        $facts = Get-VerifiedReviewedBlockedFacts -InputBuffers $buffers
        if ($null -eq $facts -or $facts -isnot [System.Management.Automation.PSCustomObject]) { throw $failure }

        $fCapture = & $note $facts 'capture'
        $fEvidence = & $note $fCapture 'evidence'
        $fRaw = & $note $facts 'raw'
        $fBasis = & $note $facts 'reviewedBasis'

        # Receipt identity tuple against the independently verified capture evidence.
        foreach ($n in @('taskId', 'runId', 'payloadSha256')) {
            & $ordinal (& $note $terminal $n) (& $note $fEvidence $n)
        }
        & $ordinal (& $note $terminal 'sessionId') (& $note $fEvidence 'sessionId')
        $tAttempt = & $note $terminal 'attempt'
        $fAttempt = & $note $fEvidence 'attempt'
        if (-not (& $isInt $tAttempt) -or -not (& $isInt $fAttempt) -or [decimal]$tAttempt -ne [decimal]$fAttempt) { throw $failure }

        $provider = & $note $terminal 'provider'
        & $ordinal (& $note $provider 'sessionId') (& $note $fEvidence 'sessionId')
        $pPid = & $note $provider 'pid'
        $fPid = & $note $fEvidence 'pid'
        if (-not (& $isInt $pPid) -or -not (& $isInt $fPid) -or [decimal]$pPid -ne [decimal]$fPid) { throw $failure }
        & $ordinal (& $note $provider 'startIdentity') (& $note $fEvidence 'startIdentity')
        & $ordinal (& $note $provider 'terminalReason') (& $note $fRaw 'stopReason')

        # Receipt evidence paths and hashes against the captured pair.
        $tEvidence = & $note $terminal 'evidence'
        foreach ($n in @('rawPath', 'ticketPath', 'usagePath')) {
            & $samePath (& $note $tEvidence $n) (& $note $fEvidence $n)
        }
        foreach ($n in @('rawSha256', 'usageSha256')) {
            & $sameHash (& $note $tEvidence $n) (& $note $fEvidence $n)
        }
        & $sameHash (& $note $tEvidence 'ticketSha256') (& $note $fEvidence 'ticketSha256')

        # Destination and history flags.
        $dest = & $note $terminal 'destination'
        & $ordinal $dest 'Anthropic Claude'
        $hv = & $note $terminal 'historyVerified'
        if ($hv -isnot [bool] -or $hv -ne $false) { throw $failure }

        # Disposition hashes against the verified capture.
        & $ordinal (& $note $tDisp 'reviewSha256') (& $note $aExpected 'reviewSha256')
        & $ordinal (& $note $tDisp 'evidenceSha256') (& $note $aExpected 'evidenceSha256')

        # Budget: exact five-field scalar tuple; numerical/UTC checks are delegated.
        $expectedBudget = [pscustomobject][ordered]@{}
        foreach ($n in @('cumulativeOutputTokens', 'phaseAggregateCeiling', 'maxAttempts', 'maxElapsedMs')) {
            $v = & $note $fBasis $n
            if (-not (& $isInt $v)) { throw $failure }
            $expectedBudget | Add-Member -MemberType NoteProperty -Name $n -Value ([int64]$v)
        }
        $expectedBudget | Add-Member -MemberType NoteProperty -Name 'attempt' -Value ([int64]$fAttempt)
        $budgetOk = Test-ReviewedBlockedSettlementBudget (& $note $terminal 'budget') $expectedBudget (& $note $fRaw 'startUtc') (& $note $fRaw 'endUtc')
        if ($budgetOk -isnot [bool] -or $budgetOk -ne $true) { throw $failure }

        $rv = [string](& $note $aExpected 'reviewSha256')
        $ev = [string](& $note $aExpected 'evidenceSha256')
        $sha = New-Object string (, $aSha.ToCharArray())
        $path = New-Object string (, $aPath.ToCharArray())
        $result = [pscustomobject][ordered]@{
            schema         = 'VerifiedBlockedSettlementInputs/v1'
            terminal       = $terminal
            terminalSha256 = $sha
            receiptPath    = $path
            expected       = [pscustomobject][ordered]@{ reviewSha256 = $rv; evidenceSha256 = $ev }
            capture        = [pscustomobject][ordered]@{
                schema         = 'BlockedSettlementTerminalCapture/v1'
                terminalSha256 = $sha
                receiptPath    = $path
                expected       = [pscustomobject][ordered]@{ reviewSha256 = $rv; evidenceSha256 = $ev }
            }
        }
        return $result
    }
    catch {
        throw $failure
    }
}
