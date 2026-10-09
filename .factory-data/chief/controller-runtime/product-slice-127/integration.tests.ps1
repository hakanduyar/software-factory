#requires -Version 7
[CmdletBinding()]
param([Parameter(Mandatory)][string]$EvidenceRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$cr = Split-Path -Parent $here
. (Join-Path $cr 'dispatch/continuation-step.ps1')
. (Join-Path $cr 'host-continuation/select-next-ready.ps1')
. (Join-Path $cr 'dispatch/invoke-supervised.ps1')

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
        PlanPath = $planPath
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

        $termArgs1 = $run.TerminalArgs.Clone()
        $termArgs1.Remove('CompletedNativeEvidence')
        $hc1 = @{
            PreviousSelectedClaim = $run.SelectedClaim; Dispatch = $aliasDispatch; CheckpointPath = $run.CheckpointPath
            VaultPath = $run.VaultPath; EvidenceRoot = $run.Dir; QueuePath = $run.QueuePath; NormalQuotaPath = $run.QuotaPath
            CompletedNativeEvidence = $run.TerminalArgs['CompletedNativeEvidence']
            PostCoreStateProducer = $producer; LocalSyncConfig = $localCfg; GitHubSyncConfig = $ghCfg
        }
        $res = Invoke-SupervisedTerminal @termArgs1 -PlanPath $run.PlanPath -StateDir $run.StateDir -Owner $run.Owner -HostLifecycleContext $hc1

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
        $hc2 = @{
            PreviousSelectedClaim = $run.SelectedClaim; Dispatch = $script:Dispatcher; CheckpointPath = $run.CheckpointPath
            VaultPath = $run.VaultPath; EvidenceRoot = $run.Dir; QueuePath = $run.QueuePath; NormalQuotaPath = $run.QuotaPath
            CompletedNativeEvidence = $run.TerminalArgs['CompletedNativeEvidence']
            PostCoreStateProducer = $producer; LocalSyncConfig = $localCfg2; GitHubSyncConfig = $ghCfg2
        }
        $res2 = Invoke-SupervisedTerminal @termArgs1 -PlanPath $run.PlanPath -StateDir $run.StateDir -Owner $run.Owner -HostLifecycleContext $hc2

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

        $preCheckpointSha = (Get-FileHash -LiteralPath $run.CheckpointPath -Algorithm SHA256).Hash
        $preStateCount = (Get-ChildItem -LiteralPath $run.StateDir -Recurse -File).Count
        $preChildCount = $script:children.Count
        $preCallCount = $script:calls.Count
        $badCases = @(
            @{ Name = 'null context'; Context = $null },
            @{ Name = 'unknown key'; Context = @{ PreviousSelectedClaim = $run.SelectedClaim; Dispatch = $script:Dispatcher; CheckpointPath = $run.CheckpointPath; VaultPath = $run.VaultPath; EvidenceRoot = $run.Dir; QueuePath = $run.QueuePath; NormalQuotaPath = $run.QuotaPath; BogusKey = 'x' } },
            @{ Name = 'wrong-type evidence'; Context = @{ PreviousSelectedClaim = $run.SelectedClaim; Dispatch = $script:Dispatcher; CheckpointPath = $run.CheckpointPath; VaultPath = $run.VaultPath; EvidenceRoot = $run.Dir; QueuePath = $run.QueuePath; NormalQuotaPath = $run.QuotaPath; CompletedNativeEvidence = 'wrong-type' } }
        )
        foreach ($bc in $badCases) {
            $badRes = Invoke-SupervisedTerminal @termArgs1 -PlanPath $run.PlanPath -StateDir $run.StateDir -Owner $run.Owner -HostLifecycleContext $bc.Context
            Assert-True ($badRes.status -eq 'RECONCILIATION_REQUIRED' -and $badRes.reason -eq 'HOST_CONTEXT_INVALID') ('p2 boundary ' + $bc.Name + ' refused')
            Assert-True ($null -eq $badRes.claimResult) ('p2 boundary ' + $bc.Name + ' no claimResult')
        }
        Assert-True ((Get-FileHash -LiteralPath $run.CheckpointPath -Algorithm SHA256).Hash -ceq $preCheckpointSha) 'p2 boundary checkpoint unchanged'
        Assert-True ((Get-ChildItem -LiteralPath $run.StateDir -Recurse -File).Count -eq $preStateCount) 'p2 boundary state unchanged'
        Assert-True ($script:children.Count -eq $preChildCount) 'p2 boundary no new child'
        Assert-True ($script:calls.Count -eq $preCallCount) 'p2 boundary no new dispatch callback'

        $absentRes = Invoke-SupervisedTerminal -RawPath (Join-Path $run.Dir 'missing-raw.json') -TicketPath $termArgs1['TicketPath'] -UsagePath $termArgs1['UsagePath'] `
            -RunId $termArgs1['RunId'] -Attempt $termArgs1['Attempt'] -MaxAttempts $termArgs1['MaxAttempts'] -PriorElapsedMs $termArgs1['PriorElapsedMs'] `
            -MaxElapsedMs $termArgs1['MaxElapsedMs'] -ReceiptPath $termArgs1['ReceiptPath'] -PlanPath $run.PlanPath -StateDir $run.StateDir -Owner $run.Owner
        Assert-True ($absentRes.status -eq 'RECONCILE_EVIDENCE') 'p2 absent-context legacy path raw-missing evidence'

        $nullProducerCtx = @{
            PreviousSelectedClaim = $run.SelectedClaim; Dispatch = $script:Dispatcher; CheckpointPath = $run.CheckpointPath
            VaultPath = $run.VaultPath; EvidenceRoot = $run.Dir; QueuePath = $run.QueuePath; NormalQuotaPath = $run.QuotaPath
            PostCoreStateProducer = $null; LocalSyncConfig = $null; GitHubSyncConfig = $null
            CompletedNativeEvidence = $run.TerminalArgs['CompletedNativeEvidence']
        }
        $nullRes = Invoke-SupervisedTerminal @termArgs1 -PlanPath $run.PlanPath -StateDir $run.StateDir -Owner $run.Owner -HostLifecycleContext $nullProducerCtx
        Assert-True (-not ($nullRes.status -eq 'RECONCILIATION_REQUIRED' -and $nullRes.reason -eq 'HOST_CONTEXT_INVALID')) 'p2 null-config context not wrapper-invalid'
        Assert-True ($nullRes.publication.status -eq 'REFUSED' -and $nullRes.publication.code -eq 'STATE_PRODUCER_REQUIRED') 'p2 null-producer deferred publication refusal'
    }
}
finally {
    foreach ($p in $script:children) { try { if (-not $p.HasExited) { $p.Kill() } } catch { } }
}
Write-Host ('SUMMARY passed={0} failed={1}' -f $script:passed, $script:failures.Count)
foreach ($f in $script:failures) { Write-Host $f }
if ($script:failures.Count -gt 0) { exit 1 }
exit 0
