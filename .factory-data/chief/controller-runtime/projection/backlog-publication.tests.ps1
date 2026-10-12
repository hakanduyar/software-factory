param(
  [string]$SourcePath = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\projection\publish-runtime.p02-stage39.ps1',
  [string]$InputPath = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\control\resume-20261011\actual-plan-projection-input.json'
)
$ErrorActionPreference = 'Stop'
. $SourcePath

$labels = New-Object System.Collections.Generic.List[string]
function Assert-That([bool]$Cond, [string]$Label) {
  if (-not $Cond) { throw "FAIL: $Label" }
  $labels.Add($Label); Write-Host "PASS $Label"
}
function Sha([byte[]]$b) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { -join ($h.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
}
function New-State {
  [ordered]@{currentActiveWork=[ordered]@{id='owned-publication';status='active';providerActive=$false;owner='controller'}; operationalContinuation=[ordered]@{status='accepted';fingerprint=('0'*64);reportedOutput=0;reservedUnknownOutput=0;accountedOutput=0}}
}
function Json($o) { $o | ConvertTo-Json -Depth 100 -Compress }

$root = Join-Path $PSScriptRoot ('bp-test-' + [guid]::NewGuid().ToString('N'))
$cp = Join-Path $root 'checkpoint'; $vault = Join-Path $root 'vault'; $ev = Join-Path $root 'evidence'
foreach ($d in $cp, $vault, $ev) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
$cpFile = Join-Path $cp 'checkpoint.json'

function Get-Snapshot([bool]$MismatchReview) {
  $s = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json -DateKind String -NoEnumerate
  foreach ($t in $s.tasks) { if ($t.id -eq 'PAUSE-P14') { $t.externalBlocker = $null } }
  if ($MismatchReview) { $s.accepted[0].reviewSha256 = ('f' * 64) }
  $planPath = Join-Path $root ('predecessor-plan-' + [guid]::NewGuid().ToString('N') + '.json')
  $plan = [ordered]@{ planVersion = 'owned-predecessor-v1'; tasks = $s.tasks }
  [System.IO.File]::WriteAllText($planPath, (Json $plan), (New-Object System.Text.UTF8Encoding($false)))
  $s.planVersion = 'owned-predecessor-v1'
  $s.planSha256 = Sha ([System.IO.File]::ReadAllBytes($planPath))
  $s
}
function Publish($state, $extra) {
  Publish-RuntimeCheckpoint -State $state -CheckpointPath $cpFile -VaultPath $vault -EvidenceRoot $ev @extra
}
function Read-Cp { Get-Content -LiteralPath $cpFile -Raw | ConvertFrom-Json -DateKind String -Depth 100 }
function Inventory { (Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Name -notlike 'predecessor-plan-*' } | Sort-Object FullName | ForEach-Object { "$($_.FullName)|$((Get-FileHash -LiteralPath $_.FullName).Hash)" }) -join "`n" }

try {
  # 1 real publish: changed plan + exact accepted 151
  $snap = Get-Snapshot $false
  $inBefore = Get-Content -LiteralPath $InputPath -Raw
  $state = New-State; $stateBefore = Json $state
  $snapBefore = Json $snap
  $null = Publish $state @{ BacklogSnapshot = $snap }
  $prep1 = (Read-Cp).backlogPreparation
  Assert-That ($null -ne $prep1) 'persisted backlogPreparation present'
  Assert-That ($prep1.candidates -contains 'PAUSE-P14') 'P14 candidate'
  Assert-That ($prep1.candidates -contains 'PAUSE-P02') 'P02 candidate'
  $p05 = @($prep1.blocked | Where-Object { $_.id -ceq 'PAUSE-P05' })
  Assert-That ($p05.Count -eq 1 -and @($p05[0].reasons | Where-Object { $_ -clike 'EXTERNAL*' }).Count -ge 1) 'P05 blocked local'
  Assert-That (($prep1.schema -ceq 'BacklogDependencyProjection/v1') -and ($prep1.planVersion -ceq $snap.planVersion) -and ($prep1.planSha256 -ceq $snap.planSha256)) 'output plan identity is captured owned predecessor'
  Assert-That ((Json $snap) -eq $snapBefore) 'caller Json snapshot unchanged'
  Assert-That ($prep1.planSha256 -ne (Sha ([System.IO.File]::ReadAllBytes($cpFile)))) 'predecessor plan sha distinct from enriched checkpoint sha'
  Assert-That ((Json $state) -eq $stateBefore) 'caller State unchanged'
  Assert-That ((Get-Content -LiteralPath $InputPath -Raw) -eq $inBefore) 'input file unchanged'

  # 2 mismatched accepted review
  $snapM = Get-Snapshot $true
  $null = Publish (New-State) @{ BacklogSnapshot = $snapM }
  $prepM = (Read-Cp).backlogPreparation
  $p14 = @($prepM.blocked | Where-Object { $_.id -ceq 'PAUSE-P14' })
  Assert-That ($p14.Count -eq 1 -and ($p14[0].reasons -contains 'DEPENDENCY_NOT_ACCEPTED:PHASE8-151')) 'mismatched review: P14 dependency-blocked'
  Assert-That ($prepM.candidates -contains 'PAUSE-P02') 'mismatched review: P02 still candidate'

  # 3 replay determinism, no claims/queue/provider creation
  $before3 = Inventory
  $null = Publish (New-State) @{ BacklogSnapshot = $snapM }
  $prepR = (Read-Cp).backlogPreparation
  Assert-That ((Json $prepR) -eq (Json $prepM)) 'replay yields identical preparation'
  $names = (Get-ChildItem -LiteralPath $root -Recurse -File).Name -join ' '
  Assert-That ($names -notmatch '(?i)claim|queue|provider') 'no claims/queue/provider artifacts'

  # 4 refusals
  $cases = @(
    @{ n = 'explicit null'; snap = $null; st = (New-State) },
    @{ n = 'invalid string'; snap = 'not-a-snapshot'; st = (New-State) },
    @{ n = 'reserved collision'; snap = (Get-Snapshot $false); st = ([ordered]@{currentActiveWork=[ordered]@{id='x';status='active';providerActive=$false;owner='controller'}; backlogPreparation=[ordered]@{forged=1}}) },
    @{ n = 'nonobject State'; snap = (Get-Snapshot $false); st = 'not-an-object' }
  )
  foreach ($c in $cases) {
    $invBefore = Inventory
    $r = Publish $c.st @{ BacklogSnapshot = $c.snap }
    $txt = Json $r
    Assert-That ($txt -match 'REFUSED' -and $txt -match 'BACKLOG_PREPARATION_INVALID') "$($c.n): REFUSED BACKLOG_PREPARATION_INVALID"
    Assert-That ((Inventory) -eq $invBefore) "$($c.n): checkpoint bytes and directory inventory unchanged"
  }

  # 5 absent optional parameter: legacy
  $stateL = New-State; $stateLBefore = Json $stateL
  $null = Publish $stateL @{}
  Assert-That ((Get-Content -LiteralPath $cpFile -Raw) -notmatch 'backlogPreparation') 'legacy checkpoint has no backlogPreparation'
  Assert-That ((Json $stateL) -eq $stateLBefore) 'legacy caller State unchanged'

  $summary = [ordered]@{ schema = 'BacklogPublicationTests/v1'; passed = $labels.Count; failed = 0 }
  Write-Host (Json $summary)
}
finally {
  if ($root -and (Test-Path -LiteralPath $root) -and ((Split-Path -Leaf $root) -like 'bp-test-*')) {
    Remove-Item -LiteralPath $root -Recurse -Force
  }
}
