param([string]$SourcePath='C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime/dispatch/invoke-supervised.p02-stage44.ps1',[string]$InputPath='C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime/control/resume-20261011/actual-plan-projection-input.json')
$ErrorActionPreference='Stop'
. $SourcePath
function Assert-Eq($a,$b,$m){ if($a -ne $b){ throw "MISMATCH $m : expected '$b' got '$a'" } }

$shaBefore=(Get-FileHash -LiteralPath $InputPath -Algorithm SHA256).Hash
$input=Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json -NoEnumerate -DateKind String
Assert-Eq $input.schema 'BacklogDependencyProjectionInput/v1' 'schema' 2>$null
foreach($f in 'planVersion','planSha256','tasks','accepted'){
  if($null -eq $input.PSObject.Properties[$f]){ throw "Input missing field $f" }
}
$snapshot=$input
$snapJsonBefore=$snapshot | ConvertTo-Json -Depth 50 -Compress

$root=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
$producer={ throw 'MUST_NOT_PRODUCE' }

function New-Hc($snap,[bool]$withProducer){
  $hc=@{
    PreviousSelectedClaim=[pscustomobject]@{id='unreachable'}
    Dispatch={ throw 'MUST_NOT_DISPATCH' }
    CheckpointPath=Join-Path $root 'fake-checkpoint.json'
    VaultPath=Join-Path $root 'fake-vault'
    EvidenceRoot=Join-Path $root 'fake-evidence'
    QueuePath=Join-Path $root 'fake-queue.json'
    NormalQuotaPath=Join-Path $root 'fake-quota.json'
    BacklogSnapshot=$snap
  }
  if($withProducer){ $hc.PostCoreStateProducer=$producer }
  $hc
}

$cases=@(
  @{name='producer-absent';snap=$snapshot;prod=$false;detail='BacklogSnapshot requires PostCoreStateProducer'},
  @{name='null-snapshot';snap=$null;prod=$true;detail='invalid BacklogSnapshot'},
  @{name='malformed-snapshot';snap='malformed';prod=$true;detail='invalid BacklogSnapshot'}
)
foreach($c in $cases){
  $stateDir=Join-Path $root 'fake-state'
  $r=Invoke-SupervisedTerminal -RawPath (Join-Path $root 'fake-raw.txt') -TicketPath (Join-Path $root 'fake-ticket.json') `
    -UsagePath (Join-Path $root 'fake-usage.json') -RunId 'PUBLIC_NEGATIVE' -ReceiptPath (Join-Path $root 'fake-receipt.json') `
    -PlanPath (Join-Path $root 'fake-plan.json') -StateDir $stateDir -Owner 'controller' -Attempt 1 -MaxAttempts 1 `
    -PriorElapsedMs 0 -MaxElapsedMs 180000 -HostLifecycleContext (New-Hc $c.snap $c.prod)
  Assert-Eq $r.status 'RECONCILIATION_REQUIRED' "$($c.name) status"
  Assert-Eq $r.reason 'HOST_CONTEXT_INVALID' "$($c.name) reason"
  Assert-Eq $r.detail $c.detail "$($c.name) detail"
  if(Test-Path -LiteralPath $root){ throw "$($c.name): root was created" }
  if(Test-Path -LiteralPath $stateDir){ throw "$($c.name): StateDir was created" }
}

Assert-Eq (Get-FileHash -LiteralPath $InputPath -Algorithm SHA256).Hash $shaBefore 'input sha'
Assert-Eq ($snapshot | ConvertTo-Json -Depth 50 -Compress) $snapJsonBefore 'snapshot json'
Write-Output 'PASS backlog-supervised public negatives: 3/3 (producer-absent, null, malformed); input unchanged; no paths created'
