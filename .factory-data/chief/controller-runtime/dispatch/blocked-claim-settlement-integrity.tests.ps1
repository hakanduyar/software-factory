param(
    [Parameter(Mandatory)][string]$StepPath,
    [Parameter(Mandatory)][string]$FixtureRoot,
    [Parameter(Mandatory)][string]$PositiveResultPath,
    [Parameter(Mandatory)][string]$OutputDir
)
# RESUME-P07-BLOCKED-INTEGRITY-85: two after-lock controlled-boundary injections against source79.
$ErrorActionPreference = 'Stop'
. $StepPath

function Get-Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }

$names = @('selected.json', 'expected.json', 'terminal.json', 'continuation-state.json', 'host-dispatch-acknowledgements.json')
$origBefore = @{}
foreach ($n in $names) { $origBefore[$n] = Get-Sha (Join-Path $FixtureRoot $n) }

$positive = Get-Content -LiteralPath $PositiveResultPath -Raw | ConvertFrom-Json -DateKind String
if ($positive.passed -isnot [bool] -or $positive.passed -ne $true) { throw 'Accepted82 positive proof.passed is not Boolean true.' }
if (-not (Test-Path -LiteralPath $positive.case -PathType Container)) { throw 'Accepted82 settled case path missing.' }
$posFiles = Get-ChildItem -LiteralPath $positive.case -File | Sort-Object Name
$posBefore = @{}
foreach ($f in $posFiles) { $posBefore[$f.Name] = Get-Sha $f.FullName }

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$realValidator = (Get-Command Test-HostDispatchAcknowledgementEnvelope -CommandType Function).ScriptBlock
$selectedRoot = Get-Content -LiteralPath (Join-Path $FixtureRoot 'selected.json') -Raw | ConvertFrom-Json -DateKind String
$expected = Get-Content -LiteralPath (Join-Path $FixtureRoot 'expected.json') -Raw | ConvertFrom-Json -DateKind String

$script:inj = $null
$cases = @(
    @{ name = 'terminal-bytes-changed'; mode = 'AppendLf'; refusal = 'REVIEWED_BLOCKED_SETTLEMENT_INPUTS_INVALID' },
    @{ name = 'ack-key-removed'; mode = 'RemoveKey'; refusal = 'Acknowledgement entry missing at locked closure' }
)
$results = @()
try {
    foreach ($c in $cases) {
        $dir = Join-Path $OutputDir ("case-$($c.name)-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        foreach ($n in $names) { Copy-Item -LiteralPath (Join-Path $FixtureRoot $n) -Destination (Join-Path $dir $n) }
        $statePath = Join-Path $dir 'continuation-state.json'
        $ackPath = Join-Path $dir 'host-dispatch-acknowledgements.json'
        $termPath = Join-Path $dir 'terminal.json'
        $sel = $selectedRoot.selected | ConvertTo-Json -Depth 20 | ConvertFrom-Json -DateKind String
        $sel.statePath = $statePath
        $key = "$($sel.intentId)|$($sel.claimId)"

        # Initial actual validator must accept the copied ACK.
        $initialAck = Get-Content -LiteralPath $ackPath -Raw | ConvertFrom-Json -DateKind String
        $initialOk = $null -ne (& $realValidator -AckState $initialAck) -and $true

        $stateBefore = Get-Sha $statePath
        $filesBefore = @(Get-ChildItem -LiteralPath $dir -File | Where-Object Name -ne 'continuation-state.lock' | ForEach-Object Name | Sort-Object)
        $script:inj = @{ hit = $false; mutated = $false; mode = $c.mode; ackPath = $ackPath; termPath = $termPath; key = $key; lock = Join-Path $dir 'continuation-state.lock'; real = $realValidator; mutatedSha = $null; beforeSha = $null }

        function Test-HostDispatchAcknowledgementEnvelope {
            param([Parameter(Mandatory)][PSCustomObject]$AckState)
            $i = $script:inj
            $map = & $i.real -AckState $AckState
            $held = $false
            try { $h = [System.IO.File]::Open($i.lock, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $h.Close() } catch { $held = $true }
            if ($held -and -not $i.mutated) {
                $i.hit = $true; $i.mutated = $true
                if ($i.mode -eq 'AppendLf') {
                    $i.beforeSha = Get-Sha $i.termPath
                    $fsm = [System.IO.File]::Open($i.termPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
                    try { $fsm.WriteByte(10) } finally { $fsm.Close() }
                    $i.mutatedSha = Get-Sha $i.termPath
                } else {
                    $i.beforeSha = Get-Sha $i.ackPath
                    $o = Get-Content -LiteralPath $i.ackPath -Raw | ConvertFrom-Json -DateKind String
                    $o.acknowledgements.PSObject.Properties.Remove($i.key)
                    [System.IO.File]::WriteAllText($i.ackPath, ($o | ConvertTo-Json -Depth 20))
                    $i.mutatedSha = Get-Sha $i.ackPath
                }
            }
            return $map
        }

        $sha = Get-Sha $termPath
        $err = $null; $res = $null
        try { $res = Complete-ContinuationClaim -StateDir $dir -SelectedClaim $sel -TerminalReceiptPath $termPath -TerminalSha256 $sha -ExpectedBlockedReview $expected }
        catch { $err = $_.Exception.Message }
        Remove-Item Function:\Test-HostDispatchAcknowledgementEnvelope
        . ([scriptblock]::Create("function Test-HostDispatchAcknowledgementEnvelope {`n$realValidator`n}"))

        $filesAfter = @(Get-ChildItem -LiteralPath $dir -File | Where-Object Name -ne 'continuation-state.lock' | ForEach-Object Name | Sort-Object)
        $i = $script:inj
        $refused = $null -eq $res -and $null -ne $err -and $err.Contains($c.refusal)
        $results += [ordered]@{
            case = $c.name; dir = $dir; initialActualValid = $initialOk
            forwardedBoundaryHit = $i.hit; intendedBytesChanged = ($null -ne $i.mutatedSha -and $i.mutatedSha -ne $i.beforeSha)
            intendedRefusal = $c.refusal; observedError = $err; refused = $refused
            stateBytesUnchanged = ((Get-Sha $statePath) -eq $stateBefore); noWrites = (($filesBefore -join '|') -ceq ($filesAfter -join '|'))
            passed = ($initialOk -and $i.hit -and $refused -and $null -ne $i.mutatedSha -and $i.mutatedSha -ne $i.beforeSha -and ((Get-Sha $statePath) -eq $stateBefore) -and (($filesBefore -join '|') -ceq ($filesAfter -join '|')))
        }
    }
} finally {
    if (Test-Path Function:\Test-HostDispatchAcknowledgementEnvelope) { Remove-Item Function:\Test-HostDispatchAcknowledgementEnvelope }
    . ([scriptblock]::Create("function Test-HostDispatchAcknowledgementEnvelope {`n$realValidator`n}"))
}

$origUnchanged = $true
foreach ($n in $names) { if ((Get-Sha (Join-Path $FixtureRoot $n)) -ne $origBefore[$n]) { $origUnchanged = $false } }
$posUnchanged = $true
foreach ($f in $posFiles) { if ((Get-Sha $f.FullName) -ne $posBefore[$f.Name]) { $posUnchanged = $false } }

$allPassed = $origUnchanged -and $posUnchanged -and (@($results | Where-Object { -not $_.passed }).Count -eq 0)
$resultPath = Join-Path $OutputDir 'blocked-claim-settlement-integrity.result.json'
[ordered]@{
    schema = 'BlockedClaimSettlementIntegrityResult/v1'; id = 'RESUME-P07-BLOCKED-INTEGRITY-85'
    passed = $allPassed; originalFixtureUnchanged = $origUnchanged; positiveCaseUnchanged = $posUnchanged; cases = $results
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultPath
if (-not $allPassed) { throw "Blocked settlement integrity failed; see $resultPath" }
$resultPath