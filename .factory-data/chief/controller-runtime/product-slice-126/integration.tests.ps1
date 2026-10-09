#requires -Version 7
[CmdletBinding()]
param([Parameter(Mandatory)][string]$EvidenceRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$cr = Split-Path -Parent $here
. (Join-Path $cr 'dispatch/continuation-step.ps1')
. (Join-Path $cr 'host-continuation/select-next-ready.ps1')

if (-not (Test-Path -LiteralPath $EvidenceRoot -PathType Container)) { New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null }
$sourceReceiptRaw = Get-Content -LiteralPath (Join-Path $cr 'dispatch/receipts/watcher-06.json') -Raw
$script:children = [Collections.ArrayList]::new()
$script:calls = [Collections.ArrayList]::new()
$script:failures = [Collections.ArrayList]::new()
$script:passed = 0
$script:cx = @{}
$script:lastChild = $null
$script:lastBinding = $null

function Assert-True($Cond, [string]$Msg) { if (-not $Cond) { throw ('assertion failed: ' + $Msg) } }
function Invoke-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Host ('PASS ' + $Name) }
    catch {
        $m = [string]$_.Exception.Message
        if ($m.Length -gt 200) { $m = $m.Substring(0, 200) }
        [void]$script:failures.Add($Name + ' :: ' + $m)
        Write-Host ('FAIL ' + $Name)
    }
}
function Get-TextSha([string]$Text) {
    ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant()
}

function New-FixtureDir([string]$Tag) {
    $dir = Join-Path $EvidenceRoot ($Tag + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $dir
}
function New-TriggeringReceipt([string]$Dir, [string]$RunId, [string]$TaskId) {
    $clone = $sourceReceiptRaw | ConvertFrom-Json -DateKind String
    $clone.runId = $RunId
    $clone.taskId = $TaskId
    $receiptPath = Join-Path $Dir ('receipt-' + $RunId + '.json')
    ($clone | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $receiptPath -NoNewline -Encoding utf8
    $sha = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [PSCustomObject]@{ Dir = $Dir; ReceiptPath = $receiptPath; Receipt = $clone; ReceiptSha = $sha }
}
function New-Plan([object]$Case, [string]$Tag, [string]$OwnedPath) {
    if ([string]::IsNullOrWhiteSpace($OwnedPath)) { $OwnedPath = Join-Path $Case.Dir ('owned-' + $Tag) }
    $plan = [ordered]@{
        receiptSha256       = $Case.ReceiptSha
        actionId            = 'action-' + $Tag + '-' + [Guid]::NewGuid().ToString('N')
        kind                = 'NORMAL_REVIEW_DISPATCH'
        ownedPaths          = @($OwnedPath)
        failures            = 0
        diagnosisSha256     = $null
        dependenciesReady   = $true
        budgetKnown         = $true
        ownershipKnown      = $true
        quotaAllowed        = $true
        reviewDenied        = $false
        maxAdditionalOutput = $Case.Receipt.budget.maxOutputTokens
        cumulativeOutput    = $Case.Receipt.budget.usedOutputTokens
        aggregateCeiling    = $Case.Receipt.budget.usedOutputTokens + $Case.Receipt.budget.maxOutputTokens
    }
    $planPath = Join-Path $Case.Dir ('plan-' + $Tag + '.json')
    ([PSCustomObject]$plan | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $planPath -NoNewline -Encoding utf8
    $planPath
}
function New-TerminalReceipt([string]$Dir, [hashtable]$Fields, [string]$Tag) {
    $clone = $sourceReceiptRaw | ConvertFrom-Json -DateKind String
    $clone.status = 'COMPLETED'
    $clone.provider.terminalReason = 'natural_exit'
    foreach ($k in $Fields.Keys) {
        if ($k -eq 'pid') { $clone.provider.pid = $Fields[$k] }
        elseif ($k -eq 'startIdentity') { $clone.provider.startIdentity = $Fields[$k] }
        else { $clone.$k = $Fields[$k] }
    }
    $artifactPath = Join-Path $Dir ('artifact-' + $Tag + '.bin')
    Set-Content -LiteralPath $artifactPath -Value ('artifact-' + $Tag) -NoNewline -Encoding utf8
    $artifactSha = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $clone.artifact.complete = $true
    $clone.artifact.path = $artifactPath
    $clone.artifact.sha256 = $artifactSha
    $clone.budget.attemptsUsed = $clone.attempt
    $terminalPath = Join-Path $Dir ('terminal-' + $Tag + '.json')
    ($clone | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $terminalPath -NoNewline -Encoding utf8
    $sha = (Get-FileHash -LiteralPath $terminalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [PSCustomObject]@{ Path = $terminalPath; Sha = $sha; Receipt = $clone }
}
function New-QueueFile([string]$Dir, [array]$Entries) {
    $queue = [PSCustomObject]@{ schema = 'version1'; entries = $Entries }
    $queuePath = Join-Path $Dir 'queue.json'
    ($queue | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $queuePath -NoNewline -Encoding utf8
    $queuePath
}
function New-QuotaFile([string]$Path) {
    $now = (Get-Date).ToUniversalTime()
    $base = [ordered]@{
        verified = $true; eligible = $true; reason = 'ok'
        observedAt = $now.ToString('o'); freshUntilUtc = $now.AddHours(1).ToString('o')
        nextTrigger = 'next-dispatch-or-quota-change'
    }
    ([PSCustomObject]$base | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $Path -NoNewline -Encoding utf8
    $Path
}

function Start-LocalChild([string]$Dir, [string]$Tag, [int]$HoldMs) {
    $marker = Join-Path $Dir ('marker-' + $Tag + '.txt')
    $cmd = 'Set-Content -LiteralPath ''' + $marker.Replace('''', '''''') + ''' -Value started; Start-Sleep -Milliseconds ' + $HoldMs
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = (Get-Process -Id $PID).Path
    foreach ($x in @('-NoProfile', '-NonInteractive', '-EncodedCommand', $enc)) { $psi.ArgumentList.Add($x) }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    [void]$script:children.Add($p)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $marker) -and $sw.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 50 }
    Assert-True (Test-Path -LiteralPath $marker) 'child start marker observed'
    $start = $p.StartTime.ToUniversalTime().ToString('o')
    [PSCustomObject]@{ Process = $p; Pid = $p.Id; Marker = $marker; StartIdentity = $start
        Identity = [PSCustomObject]@{ kind = 'native'; pid = $p.Id; startIdentity = $start } }
}
function Get-StateFileCount([string]$StateDir, [string[]]$Needles) {
    $n = 0
    foreach ($f in (Get-ChildItem -LiteralPath $StateDir -Recurse -File)) {
        $t = Get-Content -LiteralPath $f.FullName -Raw
        if ($null -eq $t) { continue }
        $ok = $true
        foreach ($x in $Needles) { if (-not $t.Contains($x)) { $ok = $false; break } }
        if ($ok) { $n++ }
    }
    $n
}
function New-QueueEntry([string]$Id, [string]$Owner, [string]$Provider, [string]$Route, $Case, [string]$PlanPath) {
    [PSCustomObject]@{ id = $Id; owner = $Owner; provider = $Provider; enabled = $true; receiptPath = $Case.ReceiptPath; planPath = $PlanPath }
}
function New-OptInCheckpoint {
    param([string]$Id='optin-task-1',[string]$Status='active',[int64]$Reported=0,[string]$UpdatedAt='2030-01-01T00:00:00Z')
    return [ordered]@{
        currentActiveWork = [ordered]@{ id=$Id; status=$Status; providerActive=$true; owner='worker-a' }
        operationalContinuation = [ordered]@{ status='accepted'; fingerprint=('0'*64); reportedOutput=$Reported; reservedUnknownOutput=0; accountedOutput=$Reported }
        updatedAt = $UpdatedAt
    }
}
function New-FakeGhTransport {
    param([string]$InitialBody = '')
    $store = @{ body = $InitialBody; state = 'OPEN'; calls = [System.Collections.Generic.List[object]]::new() }
    $tp = {
        param($op, $map, $body)
        $store['calls'].Add([pscustomobject]@{ op = $op; repo = $map['repo']; issueNumber = $map['issueNumber'] })
        if ($op -ceq 'READ') {
            return [pscustomobject]@{ ok = $true; number = [long]$map['issueNumber']; url = ('https://github.com/' + $map['repo'] + '/issues/' + [string]$map['issueNumber']); state = $store['state']; body = $store['body'] }
        } else {
            $store['body'] = $body
            return [pscustomobject]@{ ok = $true }
        }
    }.GetNewClosure()
    return [pscustomobject]@{ Transport = $tp; Store = $store }
}

$script:Dispatcher = {
    param($sel)
    [void]$script:calls.Add($sel)
    $b = Start-LocalChild $script:cx.Dir ($script:cx.Tag + 'b') 6000
    $script:lastChild = $b
    $binding = [PSCustomObject]@{
        schema = 'host-dispatch-execution-binding/v1'
        taskId = 'DISPATCHED-' + $script:cx.Tag + 'b'
        ticketSha256 = Get-TextSha ('ticket-B-' + $script:cx.Tag)
        payloadSha256 = Get-TextSha ('payload-B-' + $script:cx.Tag)
        runId = 'dispatched-' + $script:cx.Tag + 'b'
        attempt = 1
        identity = $b.Identity
        receiptSha = $sel.receiptSha
        planSha = $sel.planSha
    }
    $script:lastBinding = $binding
    $ack = [PSCustomObject]@{ claimId = $sel.claimId; owner = $sel.owner; intentId = $sel.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
    [PSCustomObject]@{ Acknowledgement = $ack; ExecutionBinding = $binding }
}

function New-RunToDispatch([string]$Tag) {
    $a = Start-LocalChild (New-FixtureDir ($Tag + '-a')) ($Tag + 'a') 15000
    $dir = New-FixtureDir $Tag
    $case = New-TriggeringReceipt -Dir $dir -RunId ('run-' + $Tag) -TaskId ('TASK-' + $Tag)
    $planPath = New-Plan $case $Tag ''
    $stateDir = Join-Path $dir 'state'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $owner = 'owner-' + $Tag
    $co = Invoke-ContinuationStep -StateDir $stateDir -ReceiptPath $case.ReceiptPath -PlanPath $planPath -Owner $owner -Claim
    $selectedClaim = [PSCustomObject]@{
        id = $Tag + '-entry'; owner = $owner; provider = 'claude'; route = 'normal'
        claimId = $co.claimId; intentId = $co.intentId; kind = $co.kind
        receiptSha = $co.receiptSha; planSha = $co.planSha; statePath = $co.statePath
    }
    $decision = [PSCustomObject]@{
        schema = 'host-continuation-decision/v1'; recordedAt = (Get-Date).ToUniversalTime().ToString('o')
        status = 'SELECTED'; owner = $owner; nextTrigger = $null; reason = $null
        selected = $selectedClaim; perEntry = @()
    }
    ($decision | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $stateDir 'host-continuation-decision.json') -NoNewline -Encoding utf8
    $payloadPath = Join-Path $dir 'payload.txt'
    Set-Content -LiteralPath $payloadPath -Value ('fixture payload ' + $Tag) -NoNewline -Encoding utf8
    $psha = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $ticketPath = Join-Path $dir 'ticket.json'
    ([PSCustomObject]@{
        id = 'DISPATCHED-' + $Tag; payloadSha256 = $psha; sessionId = 'fixture-' + $Tag
        budget = [ordered]@{ historicalOutputTokens = 0; additionalOutputMax = 100; phaseAggregateCeiling = 200; elapsedMs = 60000; contextTokens = 64000 }
    } | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $ticketPath -NoNewline -Encoding utf8
    $tsha = (Get-FileHash -LiteralPath $ticketPath -Algorithm SHA256).Hash
    $binding = [PSCustomObject]@{
        schema = 'host-dispatch-execution-binding/v1'; taskId = 'DISPATCHED-' + $Tag
        ticketSha256 = $tsha; payloadSha256 = $psha; runId = 'dispatched-' + $Tag; attempt = 1
        identity = $a.Identity
        receiptSha = $selectedClaim.receiptSha; planSha = $selectedClaim.planSha
    }
    $ack = [PSCustomObject]@{ claimId = $selectedClaim.claimId; owner = $owner; intentId = $selectedClaim.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
    Assert-True (-not $a.Process.HasExited) ($Tag + ' child A still alive before ACK')
    Record-HostDispatchAcknowledgement -StateDir $stateDir -SelectedClaim $selectedClaim -Acknowledgement $ack -ExecutionBinding $binding | Out-Null
    Assert-True ($a.Process.WaitForExit(20000)) ($Tag + ' child A natural exit observed')
    Assert-True ($a.Process.ExitCode -eq 0) ($Tag + ' child A exit code 0')

    $rawPath = Join-Path $dir ('raw-accepted-' + $Tag + '.json')
    $exitTimeStr = $a.Process.ExitTime.ToUniversalTime().ToString('o')
    ([PSCustomObject]@{
        status = 'TERMINAL'; pid = $a.Pid; session = 'fixture-' + $Tag; startUtc = $a.StartIdentity; endUtc = $exitTimeStr
        exit = 0; stopReason = $null; historicalOutput = 0; observedOutput = 1; additionalCap = 100
    } | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $rawPath -NoNewline -Encoding utf8
    $usagePath = Join-Path $dir ('usage-accepted-' + $Tag + '.jsonl')
    (@(
        '{"type":"message_start"}',
        '{"type":"message_delta","usage":{"output_tokens":1}}',
        '{"type":"result","usage":{"output_tokens":1}}'
    ) -join "`n") | Set-Content -LiteralPath $usagePath -NoNewline -Encoding utf8
    $terminalArgs = @{
        RawPath        = $rawPath
        TicketPath     = $ticketPath
        UsagePath      = $usagePath
        RunId          = 'dispatched-' + $Tag
        Attempt        = 1
        MaxAttempts    = 1
        PriorElapsedMs = [long]0
        MaxElapsedMs   = [long]60000
        ReceiptPath    = (Join-Path $dir ('terminal-' + $Tag + '.json'))
        CompletedNativeEvidence = [PSCustomObject]@{ pid = $a.Pid; startIdentity = $a.StartIdentity; artifactPath = $a.Marker }
    }
    $checkpointPath = Join-Path $dir ('checkpoint-' + $Tag + '.json')
    $vaultPath = Join-Path $dir 'vault'

    $bCase = New-TriggeringReceipt -Dir $dir -RunId ('run-' + $Tag + '-b') -TaskId ('TASK-' + $Tag + '-b')
    $owned = @((Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json).ownedPaths)[0]
    $bPlan = New-Plan $bCase ($Tag + 'b') $owned
    $queue = New-QueueFile $dir @((New-QueueEntry ($Tag + '-b-entry') $owner 'claude' 'normal' $bCase $bPlan))
    $quota = New-QuotaFile (Join-Path $dir ('quota-normal-' + $Tag + '.json'))

    [PSCustomObject]@{
        Dir = $dir; TerminalArgs = $terminalArgs; SelectedClaim = $selectedClaim; StateDir = $stateDir
        Owner = $owner; QueuePath = $queue; QuotaPath = $quota; CheckpointPath = $checkpointPath; VaultPath = $vaultPath
    }
}

try {
    Invoke-Case '2 actual A/B postcore orderedState publication with local+github ledger replay' {
        $tag = 'p2'
        $run = New-RunToDispatch $tag
        $script:cx = @{ Dir = $run.Dir; Tag = $tag }
        New-Item -ItemType Directory -Path $run.VaultPath -Force | Out-Null

        $taskId = 'TASK-' + $tag
        $marker = 'stable-marker-' + $tag
        $ghFake = New-FakeGhTransport -InitialBody $marker
        $localLedger = Join-Path $run.Dir 'local-ledger'
        $ghLedger = Join-Path $run.Dir 'gh-ledger'

        $script:postCoreCallCount = 0
        $script:firstCoreStatus = $null
        $producer = {
            param($core)
            $script:postCoreCallCount++
            if ($script:postCoreCallCount -eq 1) { $script:firstCoreStatus = $core.status }
            New-OptInCheckpoint -Id $taskId -Status $script:firstCoreStatus
        }.GetNewClosure()

        $localCfg = @{ StateDir = $localLedger }
        $ghCfg = @{
            Mapping = @{ taskId = $taskId; repo = 'fixture-org/fixture-repo'; issueNumber = [long]1; stableMarker = $marker }
            StateDir = $ghLedger
            PublicStatus = 'IN_PROGRESS'
            NextAction = 'RUN_FOCUSED_CHECKS'
            Transport = $ghFake.Transport
        }

        $capturedDispatcher = $script:Dispatcher
        $aliasDispatch = {
            param($sel)
            $result = & $capturedDispatcher $sel
            $localCfg.StateDir = Join-Path $run.Dir 'alias-mutated-local-ledger'
            $ghCfg.StateDir = Join-Path $run.Dir 'alias-mutated-gh-ledger'
            $ghCfg.PublicStatus = 'ALIAS_MUTATED'
            $ghCfg.NextAction = 'ALIAS_MUTATED_ACTION'
            $ghCfg.Mapping.repo = 'alias-mutated-org/alias-mutated-repo'
            $ghCfg.Mapping.issueNumber = [long]999
            $ghCfg.Mapping.stableMarker = 'alias-mutated-marker'
            $ghCfg.Mapping.taskId = 'ALIAS-MUTATED-TASK'
            $result
        }.GetNewClosure()

        $res = Invoke-PublishedSettledHostContinuation -TerminalArguments $run.TerminalArgs -PreviousSelectedClaim $run.SelectedClaim `
            -Dispatch $aliasDispatch -CheckpointPath $run.CheckpointPath -VaultPath $run.VaultPath -EvidenceRoot $run.Dir `
            -QueuePath $run.QueuePath -StateDir $run.StateDir -NormalQuotaPath $run.QuotaPath -Owner $run.Owner `
            -PostCoreStateProducer $producer -LocalSyncConfig $localCfg -GitHubSyncConfig $ghCfg

        ([PSCustomObject]@{
            status = $res.status
            reason = $(if ($res.PSObject.Properties['reason']) { $res.reason } else { $null })
            publicationStatus = $(if ($res.PSObject.Properties['publication'] -and $res.publication.PSObject.Properties['status']) { $res.publication.status } else { $null })
            publicationCode = $(if ($res.PSObject.Properties['publication'] -and $res.publication.PSObject.Properties['code']) { $res.publication.code } else { $null })
        } | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Join-Path $run.Dir 'alias-dispatch-diagnostic-p2.json') -NoNewline -Encoding utf8

        Assert-True ($res.status -eq 'DISPATCHED' -and $res.dispatched -eq $true) 'p2 first call actual core DISPATCHED'
        Assert-True ($null -ne $res.publication -and $res.publication.status -eq 'ROOT_WRITTEN') 'p2 publication ROOT_WRITTEN'
        Assert-True ($res.publication.local.status -eq 'DELIVERED' -and $res.publication.local.code -eq 'OK') 'p2 local ledger DELIVERED'
        Assert-True ($res.publication.github.status -eq 'DELIVERED') 'p2 github ledger DELIVERED'
        $rootSha1 = $res.publication.checkpointSha
        Assert-True ($rootSha1 -match '^[0-9a-f]{64}$') 'p2 root checkpoint sha present'
        $checkpointBytesSha = (Get-FileHash -LiteralPath $run.CheckpointPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-True ($checkpointBytesSha -ceq $rootSha1) 'p2 checkpoint file bytes match publication root sha'

        $notePath = Join-Path $run.VaultPath 'Current Runtime.md'
        Assert-True (Test-Path -LiteralPath $notePath -PathType Leaf) 'p2 vault note written'
        $noteText = Get-Content -LiteralPath $notePath -Raw
        Assert-True ($noteText.Contains('Source checkpoint: `' + $run.CheckpointPath + '` sha256 `' + $rootSha1 + '`')) 'p2 note source checkpoint path/hash managed line'

        Assert-True ($ghFake.Store.calls.Count -ge 1) 'p2 at least one actual gh sink call'
        foreach ($c in $ghFake.Store.calls) {
            Assert-True ($c.repo -eq 'fixture-org/fixture-repo') 'p2 gh call used original fixture repo'
            Assert-True ($c.issueNumber -eq [long]1) 'p2 gh call used original fixture issue1'
        }

        $localCfg2 = @{ StateDir = $localLedger }
        $ghCfg2 = @{
            Mapping = @{ taskId = $taskId; repo = 'fixture-org/fixture-repo'; issueNumber = [long]1; stableMarker = $marker }
            StateDir = $ghLedger
            PublicStatus = 'IN_PROGRESS'
            NextAction = 'RUN_FOCUSED_CHECKS'
            Transport = $ghFake.Transport
        }

        $before = $script:children.Count
        $script:calls.Clear()
        $res2 = Invoke-PublishedSettledHostContinuation -TerminalArguments $run.TerminalArgs -PreviousSelectedClaim $run.SelectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $run.CheckpointPath -VaultPath $run.VaultPath -EvidenceRoot $run.Dir `
            -QueuePath $run.QueuePath -StateDir $run.StateDir -NormalQuotaPath $run.QuotaPath -Owner $run.Owner `
            -PostCoreStateProducer $producer -LocalSyncConfig $localCfg2 -GitHubSyncConfig $ghCfg2

        Assert-True ($script:calls.Count -eq 0) 'p2 replay: no new dispatch callback'
        Assert-True ($script:children.Count -eq $before) 'p2 replay: no new child'
        Assert-True ($res2.status -ne 'DISPATCHED') 'p2 replay: core not dispatched again'
        Assert-True ($null -ne $res2.publication -and $res2.publication.status -eq 'ROOT_WRITTEN') 'p2 replay publication ROOT_WRITTEN'
        $rootSha2 = $res2.publication.checkpointSha
        Assert-True ($rootSha2 -ceq $rootSha1) 'p2 replay checkpoint byte-stable'
        Assert-True ($res2.publication.local.status -eq 'DELIVERED' -and $res2.publication.local.replay -eq $true) 'p2 replay local DELIVERED via replay'
        Assert-True ($res2.publication.github.status -eq 'DELIVERED' -and $res2.publication.github.replay -eq $true) 'p2 replay github DELIVERED via replay'

        $localStatePath = Join-Path $localLedger 'runtime-status-sync.state.json'
        $ghStatePath = Join-Path $ghLedger 'runtime-github-sync.state.json'
        Assert-True (Test-Path -LiteralPath $localStatePath -PathType Leaf) 'p2 local ledger file present'
        Assert-True (Test-Path -LiteralPath $ghStatePath -PathType Leaf) 'p2 github ledger file present'
        $localLedgerDoc = Get-Content -LiteralPath $localStatePath -Raw | ConvertFrom-Json -DateKind String
        Assert-True (@($localLedgerDoc.versions.PSObject.Properties).Count -eq 1) 'p2 local ledger single bound version'

        ([PSCustomObject]@{
            checkpointPath = $run.CheckpointPath; localStatePath = $localStatePath; ghStatePath = $ghStatePath
            rootSha = $rootSha1; coreStatus = $res.status; replayCoreStatus = $res2.status
            publication = $res.publication; replayPublication = $res2.publication
        } | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $run.Dir 'usage-proof-p2.json') -NoNewline -Encoding utf8
    }

    Invoke-Case '0 actual A/B first dispatch config-refusal then settled producer-failure replay group' {
        $tag = 'rf'
        $run = New-RunToDispatch $tag
        $script:cx = @{ Dir = $run.Dir; Tag = $tag }

        $script:rfProducerCalls = 0
        $countingProducer = {
            param($core)
            $script:rfProducerCalls++
            New-OptInCheckpoint -Id 'rf-task'
        }.GetNewClosure()

        $validLocalCfg = @{ StateDir = (Join-Path $run.Dir 'rf-local-ledger') }
        $malformedLocalCfg = @{ StateDir = '' }

        $childrenBefore0 = $script:children.Count
        $script:calls.Clear()
        $res0 = Invoke-PublishedSettledHostContinuation -TerminalArguments $run.TerminalArgs -PreviousSelectedClaim $run.SelectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $run.CheckpointPath -VaultPath $run.VaultPath -EvidenceRoot $run.Dir `
            -QueuePath $run.QueuePath -StateDir $run.StateDir -NormalQuotaPath $run.QuotaPath -Owner $run.Owner `
            -PostCoreStateProducer $countingProducer -LocalSyncConfig $malformedLocalCfg

        Assert-True ($res0.status -eq 'DISPATCHED' -and $res0.dispatched -eq $true) 'rf first call actual core DISPATCHED despite malformed sync config'
        Assert-True ($script:calls.Count -eq 1) 'rf first call exactly one actual dispatch callback'
        Assert-True ($script:children.Count -eq ($childrenBefore0 + 1)) 'rf first call exactly one new native child'
        Assert-True ($script:rfProducerCalls -eq 0) 'rf malformed sync config refuses before producer ever runs'
        Assert-True ($null -ne $res0.publication -and $res0.publication.status -eq 'REFUSED' -and $res0.publication.code -eq 'SYNC_CONFIG_INVALID') 'rf publication REFUSED SYNC_CONFIG_INVALID'
        Assert-True (-not (Test-Path -LiteralPath $run.CheckpointPath)) 'rf checkpoint absent after malformed-config refusal'

        # All remaining calls settle/replay this SAME fixture: B is already claimed, so core cannot dispatch again.
        $childrenBefore1 = $script:children.Count
        $script:calls.Clear()
        $res1 = Invoke-PublishedSettledHostContinuation -TerminalArguments $run.TerminalArgs -PreviousSelectedClaim $run.SelectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $run.CheckpointPath -VaultPath $run.VaultPath -EvidenceRoot $run.Dir `
            -QueuePath $run.QueuePath -StateDir $run.StateDir -NormalQuotaPath $run.QuotaPath -Owner $run.Owner `
            -LocalSyncConfig $validLocalCfg

        Assert-True ($res1.status -ne 'DISPATCHED') 'rf missing-producer replay: core not dispatched again'
        Assert-True ($script:calls.Count -eq 0) 'rf missing-producer replay: no dispatch callback'
        Assert-True ($script:children.Count -eq $childrenBefore1) 'rf missing-producer replay: no new child'
        Assert-True ($null -ne $res1.publication -and $res1.publication.status -eq 'REFUSED' -and $res1.publication.code -eq 'STATE_PRODUCER_REQUIRED') 'rf publication REFUSED STATE_PRODUCER_REQUIRED'
        Assert-True (-not (Test-Path -LiteralPath $run.CheckpointPath)) 'rf checkpoint absent after missing-producer refusal'

        $scalarProducer = { param($core) 42 }
        $childrenBefore2 = $script:children.Count
        $script:calls.Clear()
        $res2 = Invoke-PublishedSettledHostContinuation -TerminalArguments $run.TerminalArgs -PreviousSelectedClaim $run.SelectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $run.CheckpointPath -VaultPath $run.VaultPath -EvidenceRoot $run.Dir `
            -QueuePath $run.QueuePath -StateDir $run.StateDir -NormalQuotaPath $run.QuotaPath -Owner $run.Owner `
            -PostCoreStateProducer $scalarProducer -LocalSyncConfig $validLocalCfg

        Assert-True ($script:calls.Count -eq 0) 'rf scalar-producer replay: no dispatch callback'
        Assert-True ($script:children.Count -eq $childrenBefore2) 'rf scalar-producer replay: no new child'
        Assert-True ($null -ne $res2.publication -and $res2.publication.status -eq 'REFUSED' -and $res2.publication.code -eq 'STATE_INVALID') 'rf publication REFUSED STATE_INVALID for scalar producer output'
        Assert-True (-not (Test-Path -LiteralPath $run.CheckpointPath)) 'rf checkpoint absent after scalar-producer refusal'

        $multiProducer = { param($core) @([PSCustomObject]@{ a = 1 }, [PSCustomObject]@{ b = 2 }) }
        $childrenBefore3 = $script:children.Count
        $script:calls.Clear()
        $res3 = Invoke-PublishedSettledHostContinuation -TerminalArguments $run.TerminalArgs -PreviousSelectedClaim $run.SelectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $run.CheckpointPath -VaultPath $run.VaultPath -EvidenceRoot $run.Dir `
            -QueuePath $run.QueuePath -StateDir $run.StateDir -NormalQuotaPath $run.QuotaPath -Owner $run.Owner `
            -PostCoreStateProducer $multiProducer -LocalSyncConfig $validLocalCfg

        Assert-True ($script:calls.Count -eq 0) 'rf multi-object-producer replay: no dispatch callback'
        Assert-True ($script:children.Count -eq $childrenBefore3) 'rf multi-object-producer replay: no new child'
        Assert-True ($null -ne $res3.publication -and $res3.publication.status -eq 'REFUSED' -and $res3.publication.code -eq 'STATE_INVALID') 'rf publication REFUSED STATE_INVALID for two-object producer output'
        Assert-True (-not (Test-Path -LiteralPath $run.CheckpointPath)) 'rf checkpoint absent after multi-object-producer refusal'

        $throwingProducer = { param($core) throw 'rf producer deliberately fails' }
        $childrenBefore4 = $script:children.Count
        $script:calls.Clear()
        $res4 = Invoke-PublishedSettledHostContinuation -TerminalArguments $run.TerminalArgs -PreviousSelectedClaim $run.SelectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $run.CheckpointPath -VaultPath $run.VaultPath -EvidenceRoot $run.Dir `
            -QueuePath $run.QueuePath -StateDir $run.StateDir -NormalQuotaPath $run.QuotaPath -Owner $run.Owner `
            -PostCoreStateProducer $throwingProducer -LocalSyncConfig $validLocalCfg

        Assert-True ($script:calls.Count -eq 0) 'rf throwing-producer replay: no dispatch callback'
        Assert-True ($script:children.Count -eq $childrenBefore4) 'rf throwing-producer replay: no new child'
        Assert-True ($null -ne $res4.publication -and $res4.publication.status -eq 'REFUSED' -and $res4.publication.code -eq 'STATE_PRODUCER_FAILED') 'rf publication REFUSED STATE_PRODUCER_FAILED for throwing producer'
        Assert-True (-not (Test-Path -LiteralPath $run.CheckpointPath)) 'rf checkpoint absent after throwing-producer refusal'

        $noVersionProducer = { param($core) $c = New-OptInCheckpoint -Id 'rf-task'; $c.Remove('updatedAt'); $c }
        $childrenBefore5 = $script:children.Count
        $script:calls.Clear()
        $res5 = Invoke-PublishedSettledHostContinuation -TerminalArguments $run.TerminalArgs -PreviousSelectedClaim $run.SelectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $run.CheckpointPath -VaultPath $run.VaultPath -EvidenceRoot $run.Dir `
            -QueuePath $run.QueuePath -StateDir $run.StateDir -NormalQuotaPath $run.QuotaPath -Owner $run.Owner `
            -PostCoreStateProducer $noVersionProducer -LocalSyncConfig $validLocalCfg

        Assert-True ($script:calls.Count -eq 0) 'rf missing-updatedAt replay: no dispatch callback'
        Assert-True ($script:children.Count -eq $childrenBefore5) 'rf missing-updatedAt replay: no new child'
        Assert-True ($null -ne $res5.publication -and $res5.publication.status -eq 'REFUSED' -and $res5.publication.code -eq 'SYNC_VERSION_UNBOUND') 'rf publication REFUSED SYNC_VERSION_UNBOUND via actual publisher, not PUBLISH_ERROR'
        Assert-True (-not (Test-Path -LiteralPath $run.CheckpointPath)) 'rf checkpoint absent after missing-updatedAt refusal'

        ([PSCustomObject]@{
            configRefusal = $res0.publication; producerRequired = $res1.publication; scalarInvalid = $res2.publication
            multiInvalid = $res3.publication; producerFailed = $res4.publication; versionUnbound = $res5.publication
        } | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath (Join-Path $run.Dir 'refusal-evidence-rf.json') -NoNewline -Encoding utf8
    }

    Invoke-Case '1 actual child A terminal to actual child B via published settled caller' {
        $a = Start-LocalChild (New-FixtureDir 'child-a') 'p1a' 15000

        $dir = New-FixtureDir 'p1'
        $case = New-TriggeringReceipt -Dir $dir -RunId 'run-p1' -TaskId 'TASK-p1'
        $planPath = New-Plan $case 'p1' ''
        $stateDir = Join-Path $dir 'state'
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        $owner = 'owner-p1'
        $co = Invoke-ContinuationStep -StateDir $stateDir -ReceiptPath $case.ReceiptPath -PlanPath $planPath -Owner $owner -Claim
        $selectedClaim = [PSCustomObject]@{
            id = 'p1-entry'; owner = $owner; provider = 'claude'; route = 'normal'
            claimId = $co.claimId; intentId = $co.intentId; kind = $co.kind
            receiptSha = $co.receiptSha; planSha = $co.planSha; statePath = $co.statePath
        }
        $decision = [PSCustomObject]@{
            schema = 'host-continuation-decision/v1'; recordedAt = (Get-Date).ToUniversalTime().ToString('o')
            status = 'SELECTED'; owner = $owner; nextTrigger = $null; reason = $null
            selected = $selectedClaim; perEntry = @()
        }
        ($decision | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $stateDir 'host-continuation-decision.json') -NoNewline -Encoding utf8
        $payloadPath = Join-Path $dir 'payload.txt'
        Set-Content -LiteralPath $payloadPath -Value 'fixture payload p1' -NoNewline -Encoding utf8
        $psha = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $ticketPath = Join-Path $dir 'ticket.json'
        ([PSCustomObject]@{
            id = 'DISPATCHED-p1'; payloadSha256 = $psha; sessionId = 'fixture-p1'
            budget = [ordered]@{ historicalOutputTokens = 0; additionalOutputMax = 100; phaseAggregateCeiling = 200; elapsedMs = 60000; contextTokens = 64000 }
        } | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $ticketPath -NoNewline -Encoding utf8
        $tsha = (Get-FileHash -LiteralPath $ticketPath -Algorithm SHA256).Hash
        $binding = [PSCustomObject]@{
            schema = 'host-dispatch-execution-binding/v1'; taskId = 'DISPATCHED-p1'
            ticketSha256 = $tsha; payloadSha256 = $psha; runId = 'dispatched-p1'; attempt = 1
            identity = $a.Identity
            receiptSha = $selectedClaim.receiptSha; planSha = $selectedClaim.planSha
        }
        $ack = [PSCustomObject]@{ claimId = $selectedClaim.claimId; owner = $owner; intentId = $selectedClaim.intentId; dispatchedAt = (Get-Date).ToUniversalTime().ToString('o') }
        Assert-True (-not $a.Process.HasExited) 'child A still alive before ACK'
        Record-HostDispatchAcknowledgement -StateDir $stateDir -SelectedClaim $selectedClaim -Acknowledgement $ack -ExecutionBinding $binding | Out-Null
        Assert-True ($a.Process.WaitForExit(20000)) 'child A natural exit observed'
        Assert-True ($a.Process.ExitCode -eq 0) 'child A exit code 0'

        $rawPath = Join-Path $dir 'raw-accepted-p1.json'
        $exitTimeStr = $a.Process.ExitTime.ToUniversalTime().ToString('o')
        ([PSCustomObject]@{
            status = 'TERMINAL'; pid = $a.Pid; session = 'fixture-p1'; startUtc = $a.StartIdentity; endUtc = $exitTimeStr
            exit = 0; stopReason = $null; historicalOutput = 0; observedOutput = 1; additionalCap = 100
        } | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $rawPath -NoNewline -Encoding utf8
        $usagePath = Join-Path $dir 'usage-accepted-p1.jsonl'
        (@(
            '{"type":"message_start"}',
            '{"type":"message_delta","usage":{"output_tokens":1}}',
            '{"type":"result","usage":{"output_tokens":1}}'
        ) -join "`n") | Set-Content -LiteralPath $usagePath -NoNewline -Encoding utf8
        $terminalArgs = @{
            RawPath        = $rawPath
            TicketPath     = $ticketPath
            UsagePath      = $usagePath
            RunId          = 'dispatched-p1'
            Attempt        = 1
            MaxAttempts    = 1
            PriorElapsedMs = [long]0
            MaxElapsedMs   = [long]60000
            ReceiptPath    = (Join-Path $dir 'terminal-p1.json')
            CompletedNativeEvidence = [PSCustomObject]@{ pid = $a.Pid; startIdentity = $a.StartIdentity; artifactPath = $a.Marker }
        }
        $checkpointPath = Join-Path $dir 'malformed-checkpoint-p1.json'
        Set-Content -LiteralPath $checkpointPath -Value '{invalidJSON' -NoNewline -Encoding utf8
        $vaultPath = Join-Path $dir 'vault'

        $bCase = New-TriggeringReceipt -Dir $dir -RunId 'run-p1-b' -TaskId 'TASK-p1-b'
        $owned = @((Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json).ownedPaths)[0]
        $bPlan = New-Plan $bCase 'p1b' $owned
        $queue = New-QueueFile $dir @((New-QueueEntry 'p1-b-entry' $owner 'claude' 'normal' $bCase $bPlan))
        $quota = New-QuotaFile (Join-Path $dir 'quota-normal.json')

        function Get-JsonHashSnapshot([string]$SnapDir) {
            $map = [ordered]@{}
            foreach ($f in (Get-ChildItem -LiteralPath $SnapDir -Recurse -File -Filter *.json)) {
                $map[$f.FullName] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
            }
            $map
        }
        function Assert-SnapshotUnchanged($Before, [string]$SnapDir, [string]$Msg) {
            $after = Get-JsonHashSnapshot $SnapDir
            Assert-True ($after.Count -eq $Before.Count) ($Msg + ' state/ACK file count unchanged')
            foreach ($k in $Before.Keys) {
                Assert-True ($after.Contains($k) -and $after[$k] -ceq $Before[$k]) ($Msg + ' state/ACK file hash unchanged: ' + $k)
            }
        }

        $negEvidence = [Collections.ArrayList]::new()

        # (a) missing required UsagePath key -> bounded RECEIPT_INVALID refusal before any dispatch
        $script:calls.Clear()
        $childrenBeforeA = $script:children.Count
        $snapBeforeA = Get-JsonHashSnapshot $stateDir
        $negA = $terminalArgs.Clone()
        [void]$negA.Remove('UsagePath')
        $resA = Invoke-PublishedSettledHostContinuation -TerminalArguments $negA -PreviousSelectedClaim $selectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $checkpointPath -VaultPath $vaultPath -EvidenceRoot $dir `
            -QueuePath $queue -StateDir $stateDir -NormalQuotaPath $quota -Owner $owner
        Assert-True ($resA.status -eq 'RECONCILIATION_REQUIRED' -and $resA.reason -eq 'RECEIPT_INVALID' -and $resA.dispatched -eq $false) 'neg(a) bounded RECEIPT_INVALID refusal'
        Assert-True ($script:calls.Count -eq 0) 'neg(a) no dispatch callback'
        Assert-True ($script:children.Count -eq $childrenBeforeA) 'neg(a) no new child'
        Assert-SnapshotUnchanged $snapBeforeA $stateDir 'neg(a)'
        [void]$negEvidence.Add(@{ case = 'a'; status = $resA.status; reason = $resA.reason })

        # (b) RawPath points to a missing fixture leaf -> same bounded adapter refusal, no dispatch
        $script:calls.Clear()
        $childrenBeforeB = $script:children.Count
        $snapBeforeB = Get-JsonHashSnapshot $stateDir
        $negB = $terminalArgs.Clone()
        $negB.RawPath = Join-Path $dir 'missing-raw-leaf-p1.json'
        $resB = Invoke-PublishedSettledHostContinuation -TerminalArguments $negB -PreviousSelectedClaim $selectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $checkpointPath -VaultPath $vaultPath -EvidenceRoot $dir `
            -QueuePath $queue -StateDir $stateDir -NormalQuotaPath $quota -Owner $owner
        Assert-True ($resB.status -eq 'RECONCILIATION_REQUIRED' -and $resB.reason -eq 'RECEIPT_INVALID' -and $resB.dispatched -eq $false) 'neg(b) bounded RECEIPT_INVALID refusal'
        Assert-True ($script:calls.Count -eq 0) 'neg(b) no dispatch callback'
        Assert-True ($script:children.Count -eq $childrenBeforeB) 'neg(b) no new child'
        Assert-SnapshotUnchanged $snapBeforeB $stateDir 'neg(b)'
        [void]$negEvidence.Add(@{ case = 'b'; status = $resB.status; reason = $resB.reason })

        # (c) CompletedNativeEvidence absent, all other accepted fields unchanged -> adapter writes
        # default receipt.status AWAITING_CONTROLLER; core settlement refuses a non-terminal receipt
        # (exception may propagate) so a generic fixture failure cannot masquerade as this refusal.
        $script:calls.Clear()
        $childrenBeforeC = $script:children.Count
        $snapBeforeC = Get-JsonHashSnapshot $stateDir
        $negC = $terminalArgs.Clone()
        [void]$negC.Remove('CompletedNativeEvidence')
        $negCReceiptPath = Join-Path $dir 'terminal-p1-neg-c.json'
        $negC.ReceiptPath = $negCReceiptPath
        $negCRefused = $false
        try {
            Invoke-PublishedSettledHostContinuation -TerminalArguments $negC -PreviousSelectedClaim $selectedClaim `
                -Dispatch $script:Dispatcher -CheckpointPath $checkpointPath -VaultPath $vaultPath -EvidenceRoot $dir `
                -QueuePath $queue -StateDir $stateDir -NormalQuotaPath $quota -Owner $owner | Out-Null
        } catch {
            $negCRefused = $true
        }
        Assert-True $negCRefused 'neg(c) core settlement refused non-terminal receipt'
        Assert-True (Test-Path -LiteralPath $negCReceiptPath -PathType Leaf) 'neg(c) adapter wrote default receipt'
        $negCReceipt = Get-Content -LiteralPath $negCReceiptPath -Raw | ConvertFrom-Json -DateKind String
        Assert-True ($negCReceipt.status -eq 'AWAITING_CONTROLLER') 'neg(c) persisted receipt status is AWAITING_CONTROLLER'
        Assert-True ($script:calls.Count -eq 0) 'neg(c) no dispatch callback'
        Assert-True ($script:children.Count -eq $childrenBeforeC) 'neg(c) no new child'
        Assert-SnapshotUnchanged $snapBeforeC $stateDir 'neg(c)'
        [void]$negEvidence.Add(@{ case = 'c'; receiptStatus = $negCReceipt.status })

        ($negEvidence | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath (Join-Path $dir 'negative-cases-p1.json') -NoNewline -Encoding utf8

        $script:cx = @{ Dir = $dir; Tag = 'p1' }
        $res = Invoke-PublishedSettledHostContinuation -TerminalArguments $terminalArgs -PreviousSelectedClaim $selectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $checkpointPath -VaultPath $vaultPath -EvidenceRoot $dir `
            -QueuePath $queue -StateDir $stateDir -NormalQuotaPath $quota -Owner $owner

        ([PSCustomObject]@{
            rawPath = $rawPath; ticketPath = $ticketPath; usagePath = $usagePath; artifactPath = $a.Marker
            receiptPath = $terminalArgs.ReceiptPath; result = $res
        } | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $dir 'usage-proof-p1.json') -NoNewline -Encoding utf8

        Assert-True ($res.status -eq 'DISPATCHED' -and $res.dispatched -eq $true) 'DISPATCHED'
        Assert-True ($script:calls.Count -eq 1) 'exactly one callback'
        $sel = $script:calls[0]
        $b = $script:lastChild
        Assert-True ($sel.id -eq 'p1-b-entry' -and $sel.owner -eq $owner) 'selected id/owner'
        Assert-True ($sel.claimId -ne $selectedClaim.claimId) 'new claim distinct from A'
        Assert-True ($b.Pid -gt 0 -and $b.Pid -ne $a.Pid) 'B real distinct pid'
        Assert-True ((Get-Content -LiteralPath $b.Marker -Raw).Trim() -eq 'started') 'B start marker'
        Assert-True ((Get-StateFileCount $stateDir @($selectedClaim.claimId, 'SETTLED')) -ge 1) 'A SETTLED tombstone'
        $ackKey = $sel.intentId + '|' + $sel.claimId
        $ackDoc = $null
        foreach ($f in (Get-ChildItem -LiteralPath $stateDir -Recurse -File -Filter *.json)) {
            $j = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json -DateKind String
            if ($j -is [PSCustomObject] -and $null -ne $j.PSObject.Properties['acknowledgements'] -and $null -ne $j.acknowledgements.PSObject.Properties[$ackKey]) { $ackDoc = $j.acknowledgements.PSObject.Properties[$ackKey].Value }
        }
        Assert-True ($null -ne $ackDoc) 'keyed ACK for B claim'
        $sb = $ackDoc.executionBinding
        $ob = $script:lastBinding
        Assert-True ($sb.taskId -eq $ob.taskId -and $sb.runId -eq $ob.runId -and $sb.ticketSha256 -eq $ob.ticketSha256 -and $sb.payloadSha256 -eq $ob.payloadSha256) 'ACK binding matches dispatcher binding'
        Assert-True ($sb.identity.pid -eq $b.Pid -and $sb.identity.startIdentity -eq $b.StartIdentity) 'ACK native identity is observed B pid/startIdentity'

        $before = $script:children.Count
        $script:calls.Clear()
        $res2 = Invoke-PublishedSettledHostContinuation -TerminalArguments $terminalArgs -PreviousSelectedClaim $selectedClaim `
            -Dispatch $script:Dispatcher -CheckpointPath $checkpointPath -VaultPath $vaultPath -EvidenceRoot $dir `
            -QueuePath $queue -StateDir $stateDir -NormalQuotaPath $quota -Owner $owner
        Assert-True ($script:calls.Count -eq 0) 'replay: no duplicate callback'
        Assert-True ($script:children.Count -eq $before) 'replay: no new child'
        Assert-True ($res2.status -ne 'DISPATCHED') 'replay: not dispatched again'

        Assert-True ($b.Process.WaitForExit(20000)) 'child B natural exit observed after replay'
        Assert-True ($b.Process.ExitCode -eq 0) 'child B exit code 0'
        Assert-True ((Get-StateFileCount $stateDir @($sel.claimId, 'CLAIMED')) -ge 1) 'B claim still active/retained after replay'
    }
}
finally {
    foreach ($p in $script:children) { try { if (-not $p.HasExited) { $p.Kill() } } catch { } }
}
Write-Host ('SUMMARY passed={0} failed={1}' -f $script:passed, $script:failures.Count)
foreach ($f in $script:failures) { Write-Host $f }
if ($script:failures.Count -gt 0) { exit 1 }
exit 0
