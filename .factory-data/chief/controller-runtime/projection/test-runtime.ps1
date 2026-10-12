#Requires -Version 7.6
Set-StrictMode -Version Latest
$testRoot = $PSScriptRoot
$ErrorActionPreference = 'Stop'
. (Join-Path $testRoot 'project-runtime.ps1')
. (Join-Path $testRoot 'publish-runtime.ps1')
$script:Assertions = 0
function Assert-That { param([bool]$Cond, [string]$Name) $script:Assertions++; if (-not $Cond) { Write-Error "FAIL: $Name" } else { Write-Host "PASS: $Name" } }

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('projtest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
$vault = Join-Path $tmpRoot 'vault'; New-Item -ItemType Directory -Path $vault -Force | Out-Null
$evidence = Join-Path $tmpRoot 'evidence'; New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$ckpDir = Join-Path $tmpRoot 'ckp'; New-Item -ItemType Directory -Path $ckpDir -Force | Out-Null

function New-Checkpoint {
    param([string]$Id='task-1',[string]$Status='active',[int64]$Reported=0)
    return [ordered]@{
        currentActiveWork = [ordered]@{ id=$Id; status=$Status; providerActive=$true; owner='worker-a' }
        operationalContinuation = [ordered]@{ status='accepted'; fingerprint=('0'*64); reportedOutput=$Reported; reservedUnknownOutput=0; accountedOutput=$Reported }
    }
}

$ckpPath = Join-Path $ckpDir 'checkpoint.json'
($(New-Checkpoint) | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $ckpPath -Encoding utf8
$r1 = Invoke-RuntimeProjection -CheckpointPath $ckpPath -VaultPath $vault -EvidenceRoot $evidence
Assert-That ($r1.status -eq 'UPDATED') 'initial update'

($(New-Checkpoint -Reported 5) | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $ckpPath -Encoding utf8
$r2 = Invoke-RuntimeProjection -CheckpointPath $ckpPath -VaultPath $vault -EvidenceRoot $evidence
Assert-That ($r2.status -eq 'UPDATED' -and $r2.materialFingerprint -ne $r1.materialFingerprint) 'changed material updates'

$notePath = Join-Path $vault 'Current Runtime.md'
$before = Get-Item -LiteralPath $notePath
$beforeBytes = [System.IO.File]::ReadAllBytes($notePath)
Start-Sleep -Milliseconds 50
$r3 = Invoke-RuntimeProjection -CheckpointPath $ckpPath -VaultPath $vault -EvidenceRoot $evidence
$afterBytes = [System.IO.File]::ReadAllBytes($notePath)
$after = Get-Item -LiteralPath $notePath
Assert-That ($r3.status -eq 'UNCHANGED' -and ([System.BitConverter]::ToString($beforeBytes) -eq [System.BitConverter]::ToString($afterBytes)) -and $before.LastWriteTimeUtc -eq $after.LastWriteTimeUtc) 'noop bytes+mtime stable'

$content = [System.IO.File]::ReadAllText($notePath)
$manualContent = "MANUAL-PREFIX`n" + $content + "MANUAL-SUFFIX`n"
[System.IO.File]::WriteAllText($notePath, $manualContent)
($(New-Checkpoint -Reported 9) | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $ckpPath -Encoding utf8
$r4 = Invoke-RuntimeProjection -CheckpointPath $ckpPath -VaultPath $vault -EvidenceRoot $evidence
$afterManual = [System.IO.File]::ReadAllText($notePath)
Assert-That ($r4.status -eq 'UPDATED' -and $afterManual.StartsWith('MANUAL-PREFIX') -and $afterManual.EndsWith("MANUAL-SUFFIX`n")) 'manual prefix/suffix preserved'

'{not valid json' | Set-Content -LiteralPath $ckpPath -Encoding utf8
$lastGoodBefore = [System.IO.File]::ReadAllText($notePath)
Assert-That ($afterManual -ne $null) 'manual content captured'

$r5 = Invoke-RuntimeProjection -CheckpointPath $ckpPath -VaultPath $vault -EvidenceRoot $evidence
$lastGoodAfter = [System.IO.File]::ReadAllText($notePath)
$errPath = Join-Path $vault 'sync-error.json'
$errContent = ''
if (Test-Path -LiteralPath $errPath) { $errContent = Get-Content -LiteralPath $errPath -Raw }
Assert-That ($r5.status -eq 'ERROR' -and $lastGoodAfter -eq $lastGoodBefore) 'malformed checkpoint preserves prior note'
Assert-That ($errContent -notmatch '\{not valid json') 'generic sync error has no raw input'

($(New-Checkpoint -Reported 20) | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $ckpPath -Encoding utf8
$r6 = Invoke-RuntimeProjection -CheckpointPath $ckpPath -VaultPath $vault -EvidenceRoot $evidence
Assert-That ($r6.status -eq 'UPDATED') 'absent optional ref fields work'

$badRefFile = Join-Path $evidence 'claim-with-`]`(injected`).md'
Set-Content -LiteralPath $badRefFile -Value 'x' -Encoding utf8
$badCkp = New-Checkpoint -Reported 21
$badCkp.currentActiveWork.claim = 'claim-with-`]`(injected`).md'
($badCkp | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $ckpPath -Encoding utf8
$lastGoodBeforeBadRef = [System.IO.File]::ReadAllText($notePath)
$r7 = Invoke-RuntimeProjection -CheckpointPath $ckpPath -VaultPath $vault -EvidenceRoot $evidence
$lastGoodAfterBadRef = [System.IO.File]::ReadAllText($notePath)
Assert-That ($r7.status -eq 'ERROR' -and $lastGoodAfterBadRef -eq $lastGoodBeforeBadRef) 'claim ref with markdown delimiter rejected, note unchanged'

($(New-Checkpoint -Reported 30) | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $ckpPath -Encoding utf8
$pubCkpPath = Join-Path $ckpDir 'pub-checkpoint.json'
($(New-Checkpoint -Reported 1) | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $pubCkpPath -Encoding utf8
$homePath = Join-Path $vault 'Home.md'
Set-Content -LiteralPath $homePath -Value "# Home`nMANUAL-HOME-CONTENT`n" -Encoding utf8
$state1 = New-Checkpoint -Reported 1
$p1 = Publish-RuntimeCheckpoint -State $state1 -CheckpointPath $pubCkpPath -VaultPath $vault -EvidenceRoot $evidence
$notePath2 = Join-Path $vault 'Current Runtime.md'
Assert-That ($p1.status -eq 'UPDATED' -and (Test-Path -LiteralPath $notePath2) -and (Get-Content -LiteralPath $homePath -Raw) -match 'MANUAL-HOME-CONTENT') 'publish updates checkpoint+note, preserves manual home content'

$noteBytes1 = [System.IO.File]::ReadAllBytes($notePath2)
$homeBytes1 = [System.IO.File]::ReadAllBytes($homePath)
$noteItem1 = Get-Item -LiteralPath $notePath2
$homeItem1 = Get-Item -LiteralPath $homePath
Start-Sleep -Milliseconds 50
$state2 = New-Checkpoint -Reported 1
$p2 = Publish-RuntimeCheckpoint -State $state2 -CheckpointPath $pubCkpPath -VaultPath $vault -EvidenceRoot $evidence
$noteBytes2 = [System.IO.File]::ReadAllBytes($notePath2)
$homeBytes2 = [System.IO.File]::ReadAllBytes($homePath)
$noteItem2 = Get-Item -LiteralPath $notePath2
$homeItem2 = Get-Item -LiteralPath $homePath
Assert-That (
    $p2.status -eq 'UNCHANGED' -and
    ([System.BitConverter]::ToString($noteBytes1) -eq [System.BitConverter]::ToString($noteBytes2)) -and
    ([System.BitConverter]::ToString($homeBytes1) -eq [System.BitConverter]::ToString($homeBytes2)) -and
    $noteItem1.LastWriteTimeUtc -eq $noteItem2.LastWriteTimeUtc -and
    $homeItem1.LastWriteTimeUtc -eq $homeItem2.LastWriteTimeUtc
) 'repeated identical state leaves note+home bytes and mtimes unchanged'

Remove-Item -LiteralPath $homePath -Force
$state3 = New-Checkpoint -Reported 1
$p3 = Publish-RuntimeCheckpoint -State $state3 -CheckpointPath $pubCkpPath -VaultPath $vault -EvidenceRoot $evidence
Assert-That ($p3.status -eq 'UNCHANGED' -and (Test-Path -LiteralPath $homePath) -and ((Get-Content -LiteralPath $homePath -Raw) -match 'Runtime')) 'removed home pointer restored despite unchanged projection'

$concCkpDir = Join-Path $tmpRoot 'conc-ckp'; New-Item -ItemType Directory -Path $concCkpDir -Force | Out-Null
$concVault = Join-Path $tmpRoot 'conc-vault'; New-Item -ItemType Directory -Path $concVault -Force | Out-Null
$concEvidence = Join-Path $tmpRoot 'conc-evidence'; New-Item -ItemType Directory -Path $concEvidence -Force | Out-Null
$concCkpPath = Join-Path $concCkpDir 'checkpoint.json'
($(New-Checkpoint -Reported 42) | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $concCkpPath -Encoding utf8

$runnerScript = Join-Path $testRoot 'project-runtime.ps1'
$childScriptPath = Join-Path $tmpRoot 'child-run.ps1'
$readyFile1 = Join-Path $tmpRoot 'child1-ready.txt'
$readyFile2 = Join-Path $tmpRoot 'child2-ready.txt'
$releaseFile = Join-Path $tmpRoot 'release.txt'
if (Test-Path -LiteralPath $readyFile1) { Remove-Item -LiteralPath $readyFile1 -Force }
if (Test-Path -LiteralPath $readyFile2) { Remove-Item -LiteralPath $readyFile2 -Force }
if (Test-Path -LiteralPath $releaseFile) { Remove-Item -LiteralPath $releaseFile -Force }
$concNotePathPre = Join-Path $concVault 'Current Runtime.md'
if (Test-Path -LiteralPath $concNotePathPre) {
    $preContent = [System.IO.File]::ReadAllText($concNotePathPre)
    $preManual = "MANUAL-PREFIX`n" + $preContent + "MANUAL-SUFFIX`n"
    [System.IO.File]::WriteAllText($concNotePathPre, $preManual)
} else {
    $null = Invoke-RuntimeProjection -CheckpointPath $concCkpPath -VaultPath $concVault -EvidenceRoot $concEvidence
    $preContent = [System.IO.File]::ReadAllText($concNotePathPre)
    $preManual = "MANUAL-PREFIX`n" + $preContent + "MANUAL-SUFFIX`n"
    [System.IO.File]::WriteAllText($concNotePathPre, $preManual)
}
($(New-Checkpoint -Reported 43) | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $concCkpPath -Encoding utf8
$childScript = @"
`$ErrorActionPreference = 'Stop'
. '$runnerScript'
New-Item -ItemType File -Path '{1}' -Force | Out-Null
`$waited = 0
while (-not (Test-Path -LiteralPath '$releaseFile') -and `$waited -lt 15000) {{ Start-Sleep -Milliseconds 50; `$waited += 50 }}
`$r = Invoke-RuntimeProjection -CheckpointPath '$concCkpPath' -VaultPath '$concVault' -EvidenceRoot '$concEvidence'
`$r.status | Out-File -FilePath '{0}' -Encoding utf8
"@

$out1 = Join-Path $tmpRoot 'child1-status.txt'
$out2 = Join-Path $tmpRoot 'child2-status.txt'
$childScript1Path = Join-Path $tmpRoot 'child1.ps1'
$childScript2Path = Join-Path $tmpRoot 'child2.ps1'
Set-Content -LiteralPath $childScript1Path -Value ($childScript -f $out1, $readyFile1) -Encoding utf8
Set-Content -LiteralPath $childScript2Path -Value ($childScript -f $out2, $readyFile2) -Encoding utf8

$pwsh = (Get-Process -Id $PID).Path
$psi1 = New-Object System.Diagnostics.ProcessStartInfo
$psi1.FileName = $pwsh
$psi1.ArgumentList.Add('-NoProfile')
$psi1.ArgumentList.Add('-NonInteractive')
$psi1.ArgumentList.Add('-File')
$psi1.ArgumentList.Add($childScript1Path)
$psi1.UseShellExecute = $false
$psi2 = New-Object System.Diagnostics.ProcessStartInfo
$psi2.FileName = $pwsh
$psi2.ArgumentList.Add('-NoProfile')
$psi2.ArgumentList.Add('-NonInteractive')
$psi2.ArgumentList.Add('-File')
$psi2.ArgumentList.Add($childScript2Path)
$psi2.UseShellExecute = $false

$proc1 = [System.Diagnostics.Process]::Start($psi1)
$proc2 = [System.Diagnostics.Process]::Start($psi2)
$barrierWaited = 0
while ((-not (Test-Path -LiteralPath $readyFile1) -or -not (Test-Path -LiteralPath $readyFile2)) -and $barrierWaited -lt 15000) { Start-Sleep -Milliseconds 50; $barrierWaited += 50 }
$bothReady = (Test-Path -LiteralPath $readyFile1) -and (Test-Path -LiteralPath $readyFile2)
New-Item -ItemType File -Path $releaseFile -Force | Out-Null
$ok1 = $proc1.WaitForExit(15000)
$ok2 = $proc2.WaitForExit(15000)
if (-not $ok1 -and -not $proc1.HasExited) { $proc1.Kill() }
if (-not $ok2 -and -not $proc2.HasExited) { $proc2.Kill() }
Assert-That ($bothReady -and $ok1 -and $ok2 -and $proc1.ExitCode -eq 0 -and $proc2.ExitCode -eq 0) 'two concurrent projector processes both exit cleanly after bounded barrier'

$status1 = (Get-Content -LiteralPath $out1 -Raw).Trim()
$status2 = (Get-Content -LiteralPath $out2 -Raw).Trim()
Assert-That ($status1 -in @('UPDATED','UNCHANGED') -and $status2 -in @('UPDATED','UNCHANGED')) 'concurrent child statuses are UPDATED or UNCHANGED'

$concNotePath = Join-Path $concVault 'Current Runtime.md'
$concContent = [System.IO.File]::ReadAllText($concNotePath)
$startCount = ([regex]::Matches($concContent, [regex]::Escape('<!-- factory-runtime:start -->'))).Count
$endCount = ([regex]::Matches($concContent, [regex]::Escape('<!-- factory-runtime:end -->'))).Count
Assert-That ($startCount -eq 1 -and $endCount -eq 1) 'concurrent runs leave exactly one managed marker pair'
Assert-That ($concContent.StartsWith('MANUAL-PREFIX') -and $concContent.Contains('MANUAL-SUFFIX')) 'concurrent runs preserve manual note content'
Assert-That ($status1 -eq 'UPDATED' -or $status2 -eq 'UPDATED') 'at least one concurrent child observes an actual update'

$missingRaw = Join-Path $tmpRoot 'missing-raw.json'
$missingVault = Join-Path $tmpRoot 'missing-vault'
$termArgs = @{
    RawPath = $missingRaw
    TicketPath = (Join-Path $tmpRoot 'na-ticket.json')
    UsagePath = (Join-Path $tmpRoot 'na-usage.jsonl')
    RunId = 'run-x'
    Attempt = 1
    MaxAttempts = 1
    PriorElapsedMs = 0
    MaxElapsedMs = 180000
    ReceiptPath = (Join-Path $tmpRoot 'na-receipt.json')
    PlanPath = (Join-Path $tmpRoot 'na-plan.json')
    StateDir = (Join-Path $tmpRoot 'na-state')
    Owner = 'tester'
}
$wrapped = Invoke-PublishedSupervisedTerminal -TerminalArguments $termArgs -CheckpointPath $concCkpPath -VaultPath $missingVault -EvidenceRoot $concEvidence
$core = Invoke-SupervisedTerminal @termArgs
Assert-That ($wrapped.status -eq 'RECONCILE_EVIDENCE' -and $core.status -eq 'RECONCILE_EVIDENCE') 'wrapper and core both RECONCILE_EVIDENCE on missing raw input'
Assert-That ($wrapped.status -eq $core.status -and $wrapped.claimResult -eq $core.claimResult) 'projection failure does not change core authority or dispatch'

$fixtureCkp = Join-Path $testRoot 'projector-01-checkpoint.json'
$fixtureTicket = Join-Path $testRoot 'projector-01-ticket.json'
$fixtureStream = Join-Path $testRoot 'projector-01-stream.jsonl'
$receiptOutPath = Join-Path $tmpRoot 'receipt-out.json'
$adapterResult = ConvertTo-TerminalReceipt -RawPath $fixtureCkp -TicketPath $fixtureTicket -UsagePath $fixtureStream -RunId 'projector-01' -Attempt 1 -MaxAttempts 1 -PriorElapsedMs 0 -MaxElapsedMs 180000 -ReceiptPath $receiptOutPath
Assert-That ($adapterResult.valid -eq $true -and $adapterResult.classification -eq 'OUTPUT_CAP' -and $adapterResult.receipt.budget.usedOutputTokens -eq 6500) 'valid OUTPUT_CAP receipt with usedOutputTokens 6500'

$negDir = Join-Path $tmpRoot 'neg-fixtures'; New-Item -ItemType Directory -Path $negDir -Force | Out-Null
function Test-NegativeTicket {
    param([string]$Name, [scriptblock]$Mutate, [string]$ExpectedField)
    $negTicketPath = Join-Path $negDir ($Name + '-ticket.json')
    $ticketObj = Get-Content -LiteralPath $fixtureTicket -Raw | ConvertFrom-Json
    & $Mutate $ticketObj
    ($ticketObj | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $negTicketPath -Encoding utf8
    $negReceiptPath = Join-Path $negDir ($Name + '-receipt.json')
    $r = ConvertTo-TerminalReceipt -RawPath $fixtureCkp -TicketPath $negTicketPath -UsagePath $fixtureStream -RunId 'projector-01' -Attempt 1 -MaxAttempts 1 -PriorElapsedMs 0 -MaxElapsedMs 180000 -ReceiptPath $negReceiptPath
    $expectedReason = "ticket budget.$ExpectedField invalid"
    Assert-That ($r.valid -eq $false -and $r.reason -eq $expectedReason) "negative fixture rejected: $Name"
}

Test-NegativeTicket 'hist-neg1' { param($t) $t.budget.historicalOutputTokens = -1 } 'historicalOutputTokens'
Test-NegativeTicket 'hist-null' { param($t) $t.budget.historicalOutputTokens = $null } 'historicalOutputTokens'
Test-NegativeTicket 'hist-string' { param($t) $t.budget.historicalOutputTokens = '0' } 'historicalOutputTokens'
Test-NegativeTicket 'additionalcap-zero' { param($t) $t.budget.additionalOutputMax = 0 } 'additionalOutputMax'
Test-NegativeTicket 'ceiling-zero' { param($t) $t.budget.phaseAggregateCeiling = 0 } 'phaseAggregateCeiling'
Test-NegativeTicket 'elapsed-zero' { param($t) $t.budget.elapsedMs = 0 } 'elapsedMs'
Test-NegativeTicket 'context-zero' { param($t) $t.budget.contextTokens = 0 } 'contextTokens'

$bomVault = Join-Path $tmpRoot 'vault-bom'; New-Item -ItemType Directory -Path $bomVault -Force | Out-Null
$bomCkpDir = Join-Path $tmpRoot 'ckp-bom'; New-Item -ItemType Directory -Path $bomCkpDir -Force | Out-Null
$bomEvidence = Join-Path $tmpRoot 'evidence-bom'; New-Item -ItemType Directory -Path $bomEvidence -Force | Out-Null
$bomNotePath = Join-Path $bomVault 'Current Runtime.md'
$bomHomePath = Join-Path $bomVault 'Home.md'
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$noteManualPrefix = "# Current Runtime`n`nManual preserved content.`n"
$homeManualPrefix = "# Home`n`nManual home content.`n"
[System.IO.File]::WriteAllText($bomNotePath, $noteManualPrefix, $utf8Bom)
[System.IO.File]::WriteAllText($bomHomePath, $homeManualPrefix, $utf8Bom)
$expectedNotePrefixBytes = [System.IO.File]::ReadAllBytes($bomNotePath)[0..([System.Text.Encoding]::UTF8.GetPreamble().Length + [System.Text.Encoding]::UTF8.GetBytes($noteManualPrefix).Length - 1)]
$expectedHomePrefixBytes = [System.IO.File]::ReadAllBytes($bomHomePath)[0..([System.Text.Encoding]::UTF8.GetPreamble().Length + [System.Text.Encoding]::UTF8.GetBytes($homeManualPrefix).Length - 1)]

$bomCkpPath = Join-Path $bomCkpDir 'checkpoint.json'
$bomState1 = New-Checkpoint
Publish-RuntimeCheckpoint -State $bomState1 -CheckpointPath $bomCkpPath -VaultPath $bomVault -EvidenceRoot $bomEvidence | Out-Null
$notePrefixBytes1 = [System.IO.File]::ReadAllBytes($bomNotePath)[0..($expectedNotePrefixBytes.Length - 1)]
$homePrefixBytes1 = [System.IO.File]::ReadAllBytes($bomHomePath)[0..($expectedHomePrefixBytes.Length - 1)]
Assert-That -Cond ((Compare-Object $expectedNotePrefixBytes $notePrefixBytes1 -SyncWindow 0) -eq $null) -Name 'BOM note prefix preserved on first publish'
Assert-That -Cond ((Compare-Object $expectedHomePrefixBytes $homePrefixBytes1 -SyncWindow 0) -eq $null) -Name 'BOM home prefix preserved on first publish'

$bomState2 = New-Checkpoint -Id 'task-2' -Status 'active' -Reported 5
Publish-RuntimeCheckpoint -State $bomState2 -CheckpointPath $bomCkpPath -VaultPath $bomVault -EvidenceRoot $bomEvidence | Out-Null
$notePrefixBytes2 = [System.IO.File]::ReadAllBytes($bomNotePath)[0..($expectedNotePrefixBytes.Length - 1)]
$homePrefixBytes2 = [System.IO.File]::ReadAllBytes($bomHomePath)[0..($expectedHomePrefixBytes.Length - 1)]
Assert-That -Cond ((Compare-Object $expectedNotePrefixBytes $notePrefixBytes2 -SyncWindow 0) -eq $null) -Name 'BOM note prefix preserved on replacement'
Assert-That -Cond ((Compare-Object $expectedHomePrefixBytes $homePrefixBytes2 -SyncWindow 0) -eq $null) -Name 'BOM home prefix preserved on replacement'

## --- Opt-in durable sink group (PHASE7-125) ---
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

$optInRoot = Join-Path $tmpRoot 'optin'; New-Item -ItemType Directory -Path $optInRoot -Force | Out-Null

# Invalid GH mapping refuses before any root mutation.
$invA = Join-Path $optInRoot 'inv-a'; New-Item -ItemType Directory -Path $invA -Force | Out-Null
$invCkp = Join-Path $invA 'checkpoint.json'
$invState = New-OptInCheckpoint -Id 'inv-task'
$badMapBlank = @{ Mapping = @{ taskId=''; repo='owner/repo'; issueNumber=1; stableMarker='m' }; StateDir=(Join-Path $invA 'gh-state'); PublicStatus='IN_PROGRESS'; NextAction='RUN_FOCUSED_CHECKS' }
$rInvBlank = Publish-RuntimeCheckpoint -State $invState -CheckpointPath $invCkp -VaultPath (Join-Path $invA 'vault') -EvidenceRoot (Join-Path $invA 'evidence') -GitHubSyncConfig $badMapBlank
Assert-That ($rInvBlank.status -eq 'REFUSED' -and $rInvBlank.code -eq 'SYNC_CONFIG_INVALID' -and -not (Test-Path -LiteralPath $invCkp)) 'blank taskId mapping refuses before root mutation'
$badMapIssue0 = @{ Mapping = @{ taskId='inv-task'; repo='owner/repo'; issueNumber=0; stableMarker='m' }; StateDir=(Join-Path $invA 'gh-state'); PublicStatus='IN_PROGRESS'; NextAction='RUN_FOCUSED_CHECKS' }
$rInvIssue0 = Publish-RuntimeCheckpoint -State $invState -CheckpointPath $invCkp -VaultPath (Join-Path $invA 'vault') -EvidenceRoot (Join-Path $invA 'evidence') -GitHubSyncConfig $badMapIssue0
Assert-That ($rInvIssue0.status -eq 'REFUSED' -and $rInvIssue0.code -eq 'SYNC_CONFIG_INVALID' -and -not (Test-Path -LiteralPath $invCkp)) 'issueNumber 0 mapping refuses before root mutation'

# Valid local+GH publishers bind their own serialized bytes/version; local readback and same-version replay.
$scC = Join-Path $optInRoot 'valid-c'; New-Item -ItemType Directory -Path $scC -Force | Out-Null
$ckpC = Join-Path $scC 'checkpoint.json'; $vaultC = Join-Path $scC 'vault'; $evidenceC = Join-Path $scC 'evidence'
New-Item -ItemType Directory -Path $vaultC -Force | Out-Null
New-Item -ItemType Directory -Path $evidenceC -Force | Out-Null
$lcStateC = Join-Path $scC 'lc-state'; $ghStateC = Join-Path $scC 'gh-state'
$fakeC = New-FakeGhTransport -InitialBody "Tracking issue stable-marker-c`n"
$stateC1 = New-OptInCheckpoint -Id 'task-c' -UpdatedAt '2030-01-01T00:00:00Z'
$ghCfgC = @{ Mapping=@{ taskId='task-c'; repo='owner/repo-c'; issueNumber=1; stableMarker='stable-marker-c' }; StateDir=$ghStateC; PublicStatus='IN_PROGRESS'; NextAction='RUN_FOCUSED_CHECKS'; Transport=$fakeC.Transport }
$pC1 = Publish-RuntimeCheckpoint -State $stateC1 -CheckpointPath $ckpC -VaultPath $vaultC -EvidenceRoot $evidenceC -LocalSyncConfig @{ StateDir=$lcStateC } -GitHubSyncConfig $ghCfgC
$expectedShaC1 = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData([System.IO.File]::ReadAllBytes($ckpC))).Replace('-', '').ToLowerInvariant()
Assert-That ($pC1.status -eq 'ROOT_WRITTEN' -and $pC1.checkpointSha -ceq $expectedShaC1 -and $pC1.version -eq '2030-01-01T00:00:00Z') 'valid publish binds own serialized bytes sha and version'
Assert-That ($pC1.local.status -eq 'DELIVERED' -and $pC1.github.status -eq 'DELIVERED') 'valid local+GH sinks both deliver'

$pC2 = Publish-RuntimeCheckpoint -State $stateC1 -CheckpointPath $ckpC -VaultPath $vaultC -EvidenceRoot $evidenceC -LocalSyncConfig @{ StateDir=$lcStateC } -GitHubSyncConfig $ghCfgC
Assert-That ($pC2.local.status -eq 'DELIVERED' -and $pC2.local.replay -eq $true) 'local same-version replay reports DELIVERED/replay'
Assert-That ($pC2.github.status -eq 'DELIVERED' -and $pC2.github.replay -eq $true) 'GH same-version replay reports DELIVERED/replay'

# Same material, newer updatedAt-only version: fresh checkpoint sha, unchanged materialFingerprint, refreshed provenance.
$notePathC = Join-Path $vaultC 'Current Runtime.md'
$oldNoteTextC = [System.IO.File]::ReadAllText($notePathC)
$oldMaterialMatchC = [regex]::Match($oldNoteTextC, '- materialFingerprint:\s*([0-9a-f]{64})')
Assert-That ($oldMaterialMatchC.Success) 'captured prior materialFingerprint before version refresh publish'
$oldMaterialC = $oldMaterialMatchC.Groups[1].Value

$stateC3 = New-OptInCheckpoint -Id 'task-c' -UpdatedAt '2030-01-02T00:00:00Z'
$pC3 = Publish-RuntimeCheckpoint -State $stateC3 -CheckpointPath $ckpC -VaultPath $vaultC -EvidenceRoot $evidenceC -LocalSyncConfig @{ StateDir=$lcStateC } -GitHubSyncConfig $ghCfgC
Assert-That ($pC3.local.status -eq 'DELIVERED' -and $pC3.checkpointSha -cne $expectedShaC1) 'same material newer version produces new checkpoint sha and delivers'

$newNoteTextC = [System.IO.File]::ReadAllText($notePathC)
$newMaterialMatchC = [regex]::Match($newNoteTextC, '- materialFingerprint:\s*([0-9a-f]{64})')
Assert-That ($newMaterialMatchC.Success -and $newMaterialMatchC.Groups[1].Value -ceq $oldMaterialC) 'materialFingerprint unchanged when only version/updatedAt advances'

$startIdxC = $newNoteTextC.IndexOf('<!-- factory-runtime:start -->', [System.StringComparison]::Ordinal)
$endIdxC = $newNoteTextC.IndexOf('<!-- factory-runtime:end -->', [System.StringComparison]::Ordinal)
$innerC = $newNoteTextC.Substring($startIdxC, $endIdxC - $startIdxC)
$expectedSrcLineC = '- Source checkpoint: `' + ([System.IO.Path]::GetFullPath($ckpC)) + '` sha256 `' + $pC3.checkpointSha + '`'
$srcLinesC = @(($innerC -split "`r?`n") | Where-Object { $_.StartsWith('- Source checkpoint:', [System.StringComparison]::Ordinal) })
Assert-That ($srcLinesC.Count -eq 1 -and $srcLinesC[0] -ceq $expectedSrcLineC) 'exactly one managed source provenance line matches newly generated checkpoint path/sha'

$noteBytesAfterC3 = [System.IO.File]::ReadAllBytes($notePathC)
$pC3b = Publish-RuntimeCheckpoint -State $stateC3 -CheckpointPath $ckpC -VaultPath $vaultC -EvidenceRoot $evidenceC -LocalSyncConfig @{ StateDir=$lcStateC } -GitHubSyncConfig $ghCfgC
$noteBytesAfterReplayC = [System.IO.File]::ReadAllBytes($notePathC)
Assert-That ($pC3b.local.status -eq 'DELIVERED' -and $pC3b.local.replay -eq $true -and ([System.BitConverter]::ToString($noteBytesAfterC3) -eq [System.BitConverter]::ToString($noteBytesAfterReplayC))) 'republish of same refreshed version replays locally with unchanged note bytes'
Assert-That ($pC3b.github.status -eq 'DELIVERED' -and $pC3b.github.replay -eq $true) 'GH replay for same refreshed version'

# Independent sink failure then recovery preserving root and other sink result.
$scE = Join-Path $optInRoot 'fail-e'; New-Item -ItemType Directory -Path $scE -Force | Out-Null
$ckpE = Join-Path $scE 'checkpoint.json'; $vaultE = Join-Path $scE 'vault'; $evidenceE = Join-Path $scE 'evidence'
New-Item -ItemType Directory -Path $vaultE -Force | Out-Null
New-Item -ItemType Directory -Path $evidenceE -Force | Out-Null
$lcStateEBad = Join-Path $scE 'lc-state-leaf'
New-Item -ItemType File -Path $lcStateEBad -Force | Out-Null
$ghStateE = Join-Path $scE 'gh-state'
$fakeE = New-FakeGhTransport -InitialBody "Tracking issue stable-marker-e`n"
$stateE1 = New-OptInCheckpoint -Id 'task-e' -UpdatedAt '2030-01-01T00:00:00Z'
$ghCfgE = @{ Mapping=@{ taskId='task-e'; repo='owner/repo-e'; issueNumber=1; stableMarker='stable-marker-e' }; StateDir=$ghStateE; PublicStatus='IN_PROGRESS'; NextAction='RUN_FOCUSED_CHECKS'; Transport=$fakeE.Transport }
$pE1 = Publish-RuntimeCheckpoint -State $stateE1 -CheckpointPath $ckpE -VaultPath $vaultE -EvidenceRoot $evidenceE -LocalSyncConfig @{ StateDir=$lcStateEBad } -GitHubSyncConfig $ghCfgE
Assert-That ($pE1.status -eq 'ROOT_WRITTEN' -and $pE1.local.status -eq 'REFUSED' -and $pE1.local.code -eq 'UNEXPECTED_FAILURE' -and $pE1.local.delivered -eq $false -and $pE1.github.status -eq 'DELIVERED') 'local filesystem failure does not block independent GH delivery'
Remove-Item -LiteralPath $lcStateEBad -Force
$stateE2 = New-OptInCheckpoint -Id 'task-e' -UpdatedAt '2030-01-02T00:00:00Z'
$pE2 = Publish-RuntimeCheckpoint -State $stateE2 -CheckpointPath $ckpE -VaultPath $vaultE -EvidenceRoot $evidenceE -LocalSyncConfig @{ StateDir=$lcStateEBad } -GitHubSyncConfig $ghCfgE
Assert-That ($pE2.local.status -eq 'DELIVERED' -and $pE2.github.status -eq 'DELIVERED') 'fixed local sink recovers to DELIVERED alongside GH'

# Captured GH config alias mutation during the call cannot change the bound GH target.
$scF = Join-Path $optInRoot 'alias-f'; New-Item -ItemType Directory -Path $scF -Force | Out-Null
$ckpF = Join-Path $scF 'checkpoint.json'; $vaultF = Join-Path $scF 'vault'; $evidenceF = Join-Path $scF 'evidence'; $ghStateF = Join-Path $scF 'gh-state'
$mutatingMap = @{ taskId='task-f'; repo='owner/repo-f'; issueNumber=1; stableMarker='stable-marker-f' }
$mutateCalls = [System.Collections.Generic.List[object]]::new()
$fakeFStore = @{ body = "Tracking issue stable-marker-f`n" }
$fakeFTransport = {
    param($op, $map, $body)
    $mutateCalls.Add([pscustomobject]@{ op = $op; repo = $map['repo'] })
    if ($op -ceq 'READ') { $mutatingMap['repo'] = 'attacker/hijacked' }
    if ($op -ceq 'READ') {
        return [pscustomobject]@{ ok=$true; number=[long]$map['issueNumber']; url=('https://github.com/' + $map['repo'] + '/issues/' + [string]$map['issueNumber']); state='OPEN'; body=$fakeFStore['body'] }
    } else {
        $fakeFStore['body'] = $body
        return [pscustomobject]@{ ok = $true }
    }
}.GetNewClosure()
$stateF = New-OptInCheckpoint -Id 'task-f' -UpdatedAt '2030-01-01T00:00:00Z'
$ghCfgF = @{ Mapping=$mutatingMap; StateDir=$ghStateF; PublicStatus='IN_PROGRESS'; NextAction='RUN_FOCUSED_CHECKS'; Transport=$fakeFTransport }
$pF = Publish-RuntimeCheckpoint -State $stateF -CheckpointPath $ckpF -VaultPath $vaultF -EvidenceRoot $evidenceF -GitHubSyncConfig $ghCfgF
$allOriginalRepo = @($mutateCalls | Where-Object { $_.repo -ne 'owner/repo-f' }).Count -eq 0
Assert-That ($pF.github.status -eq 'DELIVERED' -and $allOriginalRepo) 'mapping alias mutation mid-call cannot change the already-bound GH target'

# Checkpoint changed during GH READ refuses before WRITE and before a false DELIVERED.
. (Join-Path $testRoot 'sync-github-task-status.ps1')
$scG = Join-Path $optInRoot 'race-g'; New-Item -ItemType Directory -Path $scG -Force | Out-Null
$ckpG = Join-Path $scG 'checkpoint.json'; $ghStateG = Join-Path $scG 'gh-state'
$stateG = New-OptInCheckpoint -Id 'task-g' -UpdatedAt '2030-01-01T00:00:00Z'
($stateG | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $ckpG -Encoding utf8
$writeCalledG = $false
$raceTransport = {
    param($op, $map, $body)
    if ($op -ceq 'READ') {
        [System.IO.File]::WriteAllText($ckpG, 'MUTATED-DURING-READ', [System.Text.UTF8Encoding]::new($false))
        return [pscustomobject]@{ ok=$true; number=[long]$map['issueNumber']; url=('https://github.com/' + $map['repo'] + '/issues/' + [string]$map['issueNumber']); state='OPEN'; body="Tracking issue stable-marker-g`n" }
    } else {
        $script:writeCalledG = $true
        return [pscustomobject]@{ ok = $true }
    }
}.GetNewClosure()
$rG = Invoke-DurableGitHubTaskStatusSync -CheckpointPath $ckpG -Mapping @{ taskId='task-g'; repo='owner/repo-g'; issueNumber=1; stableMarker='stable-marker-g' } -StateDir $ghStateG -PublicStatus 'IN_PROGRESS' -NextAction 'RUN_FOCUSED_CHECKS' -Transport $raceTransport
Assert-That ($rG.status -eq 'REFUSED' -and $rG.code -eq 'CHECKPOINT_CHANGED' -and -not $writeCalledG) 'checkpoint changed during GH READ refuses before WRITE, no false DELIVERED'

# GH-only projector race: checkpoint changed during projection cannot publish Home or report UPDATED.
$scH = Join-Path $optInRoot 'race-h'; New-Item -ItemType Directory -Path $scH -Force | Out-Null
$ckpH = Join-Path $scH 'checkpoint.json'; $vaultH = Join-Path $scH 'vault'; $evidenceH = Join-Path $scH 'evidence'; $ghStateH = Join-Path $scH 'gh-state'
$fakeH = New-FakeGhTransport -InitialBody "Tracking issue stable-marker-h`n"
$stateH = New-OptInCheckpoint -Id 'task-h' -UpdatedAt '2030-01-01T00:00:00Z'
$ghCfgH = @{ Mapping=@{ taskId='task-h'; repo='owner/repo-h'; issueNumber=1; stableMarker='stable-marker-h' }; StateDir=$ghStateH; PublicStatus='IN_PROGRESS'; NextAction='RUN_FOCUSED_CHECKS'; Transport=$fakeH.Transport }
$originalProjectionH = ${function:Invoke-RuntimeProjection}
try {
    ${function:Invoke-RuntimeProjection} = {
        param($CheckpointPath, $VaultPath, $EvidenceRoot)
        [System.IO.File]::WriteAllText($CheckpointPath, 'MUTATED-DURING-PROJECTION', [System.Text.UTF8Encoding]::new($false))
        return [pscustomobject]@{ status = 'UPDATED'; materialFingerprint = 'fake-fingerprint' }
    }
    $pH = Publish-RuntimeCheckpoint -State $stateH -CheckpointPath $ckpH -VaultPath $vaultH -EvidenceRoot $evidenceH -GitHubSyncConfig $ghCfgH
} finally {
    ${function:Invoke-RuntimeProjection} = $originalProjectionH
}
Assert-That ($pH.projection.status -eq 'ERROR' -and $pH.projection.code -eq 'CHECKPOINT_CHANGED') 'GH-only projection race reports ERROR/CHECKPOINT_CHANGED, never UPDATED'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $vaultH 'Home.md'))) 'GH-only projection race does not publish Home'

Write-Host "Total assertions: $script:Assertions"

try {
    $resolvedTmp = [System.IO.Path]::GetFullPath($tmpRoot)
    $sysTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTmp.StartsWith($sysTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTmp -Recurse -Force -ErrorAction SilentlyContinue
    }
} catch { }

exit 0
