#Requires -Version 7.6
# SYNTHETIC OFFLINE FIXTURES ONLY. Every task, packet, canonical snapshot, sidecar and outbox row below
# is invented for this test. Passing it is not publication, destination delivery, or proof of an
# automatic lifecycle feed, and no CREATE delivery consumer exists yet; it only exercises the explicit
# CREATE enqueue boundary and shows the existing UPDATE/COMPLETE consumers still refuse CREATE.
param(
  [Parameter(Mandatory)][string]$SourcePath,
  [Parameter(Mandatory)][string]$EvidenceRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$SourceRoot=[IO.Path]::GetFullPath($SourcePath).TrimEnd('\','/')
$Ev=[IO.Path]::GetFullPath($EvidenceRoot).TrimEnd('\','/')
if([IO.Directory]::Exists($Ev) -and @(Get-ChildItem -LiteralPath $Ev -Force).Count -gt 0){throw 'EvidenceRoot must be fresh and empty'}
[void][IO.Directory]::CreateDirectory($Ev)

function Get-SourceFile { param([string]$Relative) [IO.Path]::GetFullPath((Join-Path $SourceRoot $Relative)) }
$EnqueueFile=Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-create.ps1'
$ConsumerFile=Get-SourceFile 'scripts\github\task-lifecycle-mirror-consumer.ps1'
$ReconcileFile=Get-SourceFile 'scripts\github\lifecycle-compat\continuity\reconcile.ps1'
$CaptureFile=Get-SourceFile 'scripts\github\lifecycle-compat\dispatch\reviewed-blocked-capture.ps1'
$TransportFile=Get-SourceFile 'scripts\github\github-cli-transport216.ps1'

function Get-Sha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
function Get-TextSha { param([string]$Text) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant() }
$EmptySha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
$DepFiles=@($EnqueueFile,$ConsumerFile,$ReconcileFile,$CaptureFile,$TransportFile,
  (Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-update.ps1'),
  (Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-complete.ps1'),
  (Get-SourceFile 'scripts\github\github-task-lifecycle.ps1'))
$DepBefore=@{}; foreach($f in $DepFiles){$DepBefore[$f]=Get-Sha $f}
$ConsumerSha=$DepBefore[$ConsumerFile]; $ReconcileSha=$DepBefore[$ReconcileFile]; $CaptureSha=$DepBefore[$CaptureFile]

# Test-scope copies of the existing consumer/reconcile are the independent oracle (Read-Outbox, keys).
. $EnqueueFile
. $ConsumerFile
. $ReconcileFile

function Write-Text { param([string]$Path,[string]$Text) [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false)) }
function Write-Json { param([string]$Path,$Obj) Write-Text $Path (ConvertTo-Json -InputObject $Obj -Depth 6) }
function Get-Names { param([string]$Dir) @(Get-ChildItem -LiteralPath $Dir -Force | ForEach-Object {$_.Name} | Sort-Object) }
function Get-Tree {
  param([string]$Dir)
  (@(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force | Sort-Object FullName | ForEach-Object {$_.FullName.Substring($Dir.Length)+'='+(Get-Sha $_.FullName)})) -join "`n"
}
function Assert-True { param($Cond,[string]$Msg) if(-not $Cond){throw "ASSERT: $Msg"} }
function Assert-Eq { param($Actual,$Expected,[string]$Msg) if("$Actual" -cne "$Expected"){throw "ASSERT: $Msg (expected '$Expected', got '$Actual')"} }
function Assert-Refused { param($R,[string]$Code,[string]$Msg) Assert-Eq $R.status 'REFUSED' "$Msg status"; Assert-Eq $R.code $Code "$Msg code" }

# Independent of the code under test: the exact seven-field GitHubCreateEvent/v1 bytes for the default fixture.
$ExpectedEventText='{"schema":"GitHubCreateEvent/v1","taskId":"SYNTH-TASK-1","canonicalVersion":7,"publicTitle":"Synthetic fixture title","publicSummary":"Synthetic fixture summary for offline test only.","publicStatus":"IN_PROGRESS","nextAction":"RUN_FOCUSED_CHECKS"}'
$EventSha=Get-TextSha $ExpectedEventText
$EventDirName='canonical-create-synth-create-7'

$script:CaseN=0
function New-Case {
  param([hashtable]$CanonicalOverride=@{},[hashtable]$PacketOverride=@{})
  $script:CaseN++
  $dir=Join-Path $Ev ('case'+$script:CaseN); $state=Join-Path $dir 'state'
  [void][IO.Directory]::CreateDirectory($state)
  $canon=[ordered]@{taskId='SYNTH-TASK-1';canonicalRevision=7;publicTitle='Synthetic fixture title';publicSummary='Synthetic fixture summary for offline test only.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}
  $pkt=[ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId='SYNTH-TASK-1';canonicalRevision=7;eventType='CREATE';idempotencyKey='synth-create-7';publicTitle='Synthetic fixture title';publicSummary='Synthetic fixture summary for offline test only.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS';destinations=@('github','note')}
  foreach($k in $CanonicalOverride.Keys){$canon[$k]=$CanonicalOverride[$k]}
  foreach($k in $PacketOverride.Keys){$pkt[$k]=$PacketOverride[$k]}
  $c=@{dir=$dir;state=$state;outbox=(Join-Path $state 'outbox.json');canonical=(Join-Path $dir 'canonical.json');packet=(Join-Path $dir 'packet.json');eventDir=(Join-Path $state $EventDirName);event=(Join-Path (Join-Path $state $EventDirName) 'event.json')}
  Write-Json $c.canonical $canon
  Write-Json $c.packet $pkt
  return $c
}
function Get-Expect {
  param($Case)
  $c=Read-LifecycleJson $Case.canonical
  $p=Read-LifecycleJson $Case.packet
  $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))
  $e=@{digest=$digest;task=$p.taskId;id=$p.idempotencyKey}
  foreach($d in @('github','note')){
    $literal=$p.taskId+':'+$digest+':'+$p.idempotencyKey+':create:'+$d+':AWAITING_CONTROLLER:0'
    $e[$d]=Get-EventKey -TaskId $p.taskId -PayloadSha256 $digest -RunId ($p.idempotencyKey+':create:'+$d) -Status 'AWAITING_CONTROLLER' -Attempt 0
    Assert-Eq $e[$d] $literal "key formula for $d"
  }
  return $e
}
function New-Row {
  param($Task,$Digest,$RunId,$Dest,$Status='AWAITING_CONTROLLER',$Attempt=0,$Delivery='PENDING',$Proof=$null,[System.Collections.IDictionary]$Extra=@{})
  $key=Get-EventKey -TaskId $Task -PayloadSha256 $Digest -RunId $RunId -Status $Status -Attempt $Attempt
  $o=[ordered]@{key=$key;taskId=$Task;payloadSha256=$Digest;runId=$RunId;destination=$Dest;status=$Status;attempt=$Attempt;deliveryStatus=$Delivery;proof=$Proof}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function New-OwnRow {
  param($Case,$Ex,[string]$Dest,[string]$Delivery='PENDING',$Proof=$null,[hashtable]$Mut=@{},[hashtable]$Extra=@{},$Status='AWAITING_CONTROLLER')
  $meta=[ordered]@{eventType='CREATE';canonicalRef=[ordered]@{path=$Case.canonical;sha256=(Get-Sha $Case.canonical)};packetRef=[ordered]@{path=$Case.packet;sha256=(Get-Sha $Case.packet)};createEventRef=[ordered]@{path=$Case.event;sha256=$EventSha}}
  foreach($k in $Mut.Keys){$meta[$k]=$Mut[$k]}
  foreach($k in $Extra.Keys){$meta[$k]=$Extra[$k]}
  New-Row $Ex.task $Ex.digest ($Ex.id+':create:'+$Dest) $Dest -Status $Status -Delivery $Delivery -Proof $Proof -Extra $meta
}
# Rows another namespace owns: an UPDATE-style pair and a COMPLETE-style row must stay untouched.
function New-UnrelatedRows {
  param([string]$BigNote='')
  $extra=[ordered]@{updatedAt='2026-01-01T00:00:00Z';consentEligibility=$null;reconciliationSignal=$false;synthNote='unrelated metadata'}
  if($BigNote){$extra['synthBig']=$BigNote}
  @(
    (New-Row 'SYNTH-OTHER' ('a'*64) 'synth-update-run:github' 'github' -Status 'FAILED' -Attempt 1 -Extra $extra),
    (New-Row 'SYNTH-TASK-1' ('c'*64) 'synth-create-7:complete:note' 'note' -Delivery 'DELIVERED' -Proof 'bytes:synthetic' -Extra @{legacy='keep'})
  )
}
function Write-Outbox { param($Case,[object[]]$Rows) Write-OutboxAtomic $Case.outbox $Rows }
function Read-RawRows {
  param([string]$Path)
  $p=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -NoEnumerate -DateKind String
  if($p -isnot [array]){$p=@($p)}
  return ,$p
}
function Get-RowJson { param($Row) ConvertTo-Json -InputObject $Row -Depth 10 -Compress }
function Invoke-Enq {
  param($Case,[hashtable]$Override=@{})
  $pin=$null; if([IO.File]::Exists($Case.outbox)){$pin=Get-Sha $Case.outbox}
  $a=@{TaskId='SYNTH-TASK-1';CanonicalRevision=7
       CanonicalPath=$Case.canonical;ExpectedCanonicalSha256=(Get-Sha $Case.canonical);PacketPath=$Case.packet;ExpectedPacketSha256=(Get-Sha $Case.packet)
       ConsumerPath=$ConsumerFile;ExpectedConsumerSha256=$ConsumerSha;ReconcilePath=$ReconcileFile;ExpectedReconcileSha256=$ReconcileSha;ExpectedCaptureSha256=$CaptureSha
       StateDir=$Case.state;OutboxPath=$Case.outbox;ExpectedOutboxSha256=$pin}
  foreach($k in $Override.Keys){$a[$k]=$Override[$k]}
  Invoke-CanonicalLifecycleCreateEnqueue @a
}
function Assert-NoEffects {
  # Pre-lease refusals leave no lease, sidecar directory or outbox behind.
  param($Case,[string]$Msg,[string]$OutboxSha='')
  Assert-True (-not [IO.Directory]::Exists($Case.eventDir)) "$Msg no sidecar directory"
  Assert-True (-not [IO.File]::Exists($Case.canonical+'.lock')) "$Msg no canonical lease created"
  Assert-True (-not [IO.File]::Exists((Join-Path $Case.state 'publisher.lock'))) "$Msg no publisher lease created"
  if($OutboxSha){Assert-Eq (Get-Sha $Case.outbox) $OutboxSha "$Msg outbox bytes"}else{Assert-True (-not [IO.File]::Exists($Case.outbox)) "$Msg no outbox"}
}

# Test-only deterministic writer fault. A global alias outranks the function the enqueue boundary loads
# from the pinned reconcile, so production code needs no hook. It fails only for the armed exact outbox
# target (after leaving a partial temp file); all other calls go to the original writer.
$script:FaultTarget=$null; $script:FaultCalls=0; $script:FaultTemps=@{}
$script:OriginalWriter=(Get-Command -Name Write-OutboxAtomic -CommandType Function).ScriptBlock
function Invoke-FaultWriter {
  param([string]$OutboxPath,[object[]]$Events)
  if($null -ne $script:FaultTarget -and $OutboxPath -ceq $script:FaultTarget){
    $script:FaultCalls++
    # Neither file is owned by the enqueue caller: the injected partial and an unrelated sentinel that
    # appears after the invocation began (created here, after any pre-write snapshot). Both match the
    # writer's temp glob and must survive the failure byte for byte.
    $script:FaultTemps=@{}
    $partial=$OutboxPath+'.tmp_'+[guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($partial,'partial')
    $script:FaultTemps[$partial]=(Get-Sha $partial)
    $sentinel=$OutboxPath+'.tmp_unrelated-sentinel-'+[guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllBytes($sentinel,[Text.Encoding]::UTF8.GetBytes('unrelated-sentinel-bytes-0123456789'))
    $script:FaultTemps[$sentinel]=(Get-Sha $sentinel)
    throw [IO.IOException]::new('synthetic injected writer failure')
  }
  & $script:OriginalWriter $OutboxPath $Events
}
function Assert-FaultTempsRetained {
  param($Case,[string]$Msg)
  Assert-Eq $script:FaultTemps.Count 2 "$Msg partial and sentinel recorded"
  foreach($p in @($script:FaultTemps.Keys)){
    Assert-True ($p.StartsWith($Ev+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal)) "$Msg temp under EvidenceRoot"
    Assert-True ([IO.File]::Exists($p)) "$Msg unowned temp retained"
    Assert-Eq (Get-Sha $p) $script:FaultTemps[$p] "$Msg unowned temp bytes identical"
  }
}
function New-DirLink {
  param([string]$Path,[string]$Target)
  $type=$(if($IsWindows){'Junction'}else{'SymbolicLink'})
  New-Item -ItemType $type -Path $Path -Target $Target | Out-Null
}
function Remove-DirLink {
  param([string]$Path)
  if(([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -eq 0){throw "refusing to remove non-link: $Path"}
  if($IsWindows){[IO.Directory]::Delete($Path,$false)}else{[IO.File]::Delete($Path)}
}

$Results=[System.Collections.Generic.List[object]]::new()
function Test-Step {
  param([string]$Name,[scriptblock]$Body)
  try{ & $Body; $Results.Add([pscustomobject]@{name=$Name;ok=$true;error=''}); Write-Host "PASS $Name" }
  catch{ $Results.Add([pscustomobject]@{name=$Name;ok=$false;error=$_.Exception.Message}); Write-Host "FAIL $Name :: $($_.Exception.Message)" }
}

# AC1
Test-Step 'AC1 fresh CREATE retains the exact seven-field sidecar and two PENDING :create: rows beside unrelated rows' {
  $c=New-Case; $ex=Get-Expect $c
  Write-Outbox $c (New-UnrelatedRows)
  $rawBefore=Read-RawRows $c.outbox
  $unrelatedBefore=@($rawBefore | ForEach-Object {Get-RowJson $_})
  $canonBefore=Get-Sha $c.canonical; $packetBefore=Get-Sha $c.packet
  $r=Invoke-Enq $c
  Assert-Eq $r.status 'ENQUEUED' 'status'; Assert-Eq $r.code 'PENDING_ROWS_WRITTEN' 'code'; Assert-Eq $r.added 2 'added'; Assert-Eq $r.existing 0 'existing'
  Assert-Eq ($r.keys -join '|') ($ex.github+'|'+$ex.note) 'result keys'
  Assert-Eq $r.delivery 'NOT_ATTEMPTED' 'no delivery claimed'
  Assert-Eq $r.createEventRef.path $c.event 'event ref path'; Assert-Eq $r.createEventRef.sha256 $EventSha 'event ref sha'
  Assert-Eq $r.outboxSha256 (Get-Sha $c.outbox) 'reported outbox sha'
  $evBytes=[IO.File]::ReadAllBytes($c.event)
  Assert-Eq ([Text.Encoding]::UTF8.GetString($evBytes)) $ExpectedEventText 'sidecar text'
  Assert-True (-not ($evBytes.Length -ge 3 -and $evBytes[0] -eq 0xEF)) 'sidecar has no BOM'
  $rows=@(Read-Outbox $c.outbox)
  Assert-Eq $rows.Count 4 'existing reader accepts unrelated plus CREATE rows'
  $raw=Read-RawRows $c.outbox
  for($i=0;$i -lt 2;$i++){Assert-Eq (Get-RowJson $raw[$i]) $unrelatedBefore[$i] "unrelated row $i preserved"}
  foreach($d in @('github','note')){
    $m=@($rows | Where-Object {$_.key -ceq $ex[$d]})
    Assert-Eq $m.Count 1 "reader key selection $d"
    $row=$m[0]
    Assert-Eq $row.deliveryStatus 'PENDING' "$d delivery"; Assert-True ($null -eq $row.proof) "$d proof null"
    Assert-Eq $row.status 'AWAITING_CONTROLLER' "$d status"; Assert-Eq $row.attempt 0 "$d attempt"
    Assert-Eq $row.runId ($ex.id+':create:'+$d) "$d runId"; Assert-Eq $row.destination $d "$d destination"
    Assert-Eq $row.payloadSha256 $ex.digest "$d digest"; Assert-Eq $row.eventType 'CREATE' "$d eventType"
    Assert-Eq $row.canonicalRef.path $c.canonical "$d canonicalRef path"; Assert-Eq $row.canonicalRef.sha256 $canonBefore "$d canonicalRef sha"
    Assert-Eq $row.packetRef.path $c.packet "$d packetRef path"; Assert-Eq $row.packetRef.sha256 $packetBefore "$d packetRef sha"
    Assert-Eq $row.createEventRef.path $c.event "$d createEventRef path"; Assert-Eq $row.createEventRef.sha256 $EventSha "$d createEventRef sha"
  }
  Assert-Eq (Get-Sha $c.canonical) $canonBefore 'canonical unchanged'; Assert-Eq (Get-Sha $c.packet) $packetBefore 'packet unchanged'
  Assert-Eq ((Get-Names $c.state) -join '|') ($EventDirName+'|outbox.json|publisher.lock') 'state dir holds only sidecar dir, outbox and lease'
  Assert-Eq ((Get-Names $c.eventDir) -join '|') 'event.json' 'sidecar dir holds only event.json'
}

# AC2
Test-Step 'AC2 exact replay is byte stable; one existing DELIVERED destination keeps its proof and only the missing row is added' {
  $c=New-Case; $ex=Get-Expect $c
  $first=Invoke-Enq $c
  Assert-Eq $first.status 'ENQUEUED' 'first'
  $outboxBefore=Get-Sha $c.outbox; $eventBefore=Get-Sha $c.event
  $r=Invoke-Enq $c
  Assert-Eq $r.status 'UNCHANGED' 'replay status'; Assert-Eq $r.code 'REPLAY_IDENTICAL' 'replay code'; Assert-Eq $r.existing 2 'existing'; Assert-Eq $r.added 0 'added'
  Assert-Eq (Get-Sha $c.outbox) $outboxBefore 'outbox bytes after replay'; Assert-Eq (Get-Sha $c.event) $eventBefore 'sidecar bytes after replay'

  $c=New-Case; $ex=Get-Expect $c
  Write-Outbox $c @((New-UnrelatedRows)[0],(New-OwnRow $c $ex 'github' -Delivery 'DELIVERED' -Proof 'readback:synthetic-proof'))
  $beforeRaw=Read-RawRows $c.outbox
  $r=Invoke-Enq $c
  Assert-Eq $r.status 'ENQUEUED' 'partial status'; Assert-Eq $r.added 1 'added'; Assert-Eq $r.existing 1 'existing'
  $afterRaw=Read-RawRows $c.outbox
  Assert-Eq $afterRaw.Count 3 'row count'
  for($i=0;$i -lt 2;$i++){Assert-Eq (Get-RowJson $afterRaw[$i]) (Get-RowJson $beforeRaw[$i]) "row $i preserved"}
  Assert-Eq $afterRaw[1].proof 'readback:synthetic-proof' 'delivered proof kept'; Assert-Eq $afterRaw[1].deliveryStatus 'DELIVERED' 'delivered kept'
  Assert-Eq $afterRaw[2].destination 'note' 'added destination'; Assert-Eq $afterRaw[2].deliveryStatus 'PENDING' 'added pending'
  Assert-True ([IO.File]::ReadAllText($c.outbox).Contains('2026-01-01T00:00:00Z')) 'unrelated date text not reformatted'
  Assert-Eq @(Read-Outbox $c.outbox).Count 3 'existing reader accepts result'
}
Test-Step 'AC2 sidecar missing while both rows exist is restored without touching the outbox' {
  $c=New-Case; $ex=Get-Expect $c
  Write-Outbox $c @((New-OwnRow $c $ex 'github'),(New-OwnRow $c $ex 'note'))
  $before=Get-Sha $c.outbox
  $r=Invoke-Enq $c
  Assert-Eq $r.status 'ENQUEUED' 'status'; Assert-Eq $r.code 'SIDECAR_RESTORED' 'code'; Assert-Eq $r.added 0 'added'
  Assert-Eq (Get-Sha $c.outbox) $before 'outbox bytes'; Assert-Eq (Get-Sha $c.event) $EventSha 'sidecar restored'
}
Test-Step 'AC2 conflicting, excluded or malformed existing state refuses before any effect' {
  $variants=@(
    @{n='digest';code='EVENT_CONFLICT'}, @{n='canonicalRefSha';code='EVENT_CONFLICT'}, @{n='eventRefSha';code='EVENT_CONFLICT'},
    @{n='packetRefExtraKey';code='EVENT_CONFLICT'}, @{n='eventType';code='EVENT_CONFLICT'}, @{n='noRetry';code='EXCLUDED_NO_RETRY'},
    @{n='extraField';code='EVENT_CONFLICT'}, @{n='pendingProof';code='EVENT_CONFLICT'}, @{n='status';code='EVENT_CONFLICT'}, @{n='attempt';code='EVENT_CONFLICT'}
  )
  foreach($v in $variants){
    $c=New-Case; $ex=Get-Expect $c
    $row=switch($v.n){
      'digest' {New-OwnRow $c @{task=$ex.task;digest=('b'*64);id=$ex.id} 'github'}
      'canonicalRefSha' {New-OwnRow $c $ex 'github' -Mut @{canonicalRef=[ordered]@{path=$c.canonical;sha256=('d'*64)}}}
      'eventRefSha' {New-OwnRow $c $ex 'github' -Mut @{createEventRef=[ordered]@{path=$c.event;sha256=('d'*64)}}}
      'packetRefExtraKey' {New-OwnRow $c $ex 'github' -Mut @{packetRef=[ordered]@{path=$c.packet;sha256=(Get-Sha $c.packet);extra='x'}}}
      'eventType' {New-OwnRow $c $ex 'github' -Mut @{eventType='UPDATE'}}
      'noRetry' {New-OwnRow $c $ex 'github' -Extra @{retryPolicy='NO_RETRY'}}
      'extraField' {New-OwnRow $c $ex 'github' -Extra @{surprise='x'}}
      'pendingProof' {New-OwnRow $c $ex 'github' -Proof 'readback:not-allowed-on-pending'}
      'status' {New-OwnRow $c $ex 'github' -Status 'FAILED'}
      'attempt' {New-Row $ex.task $ex.digest ($ex.id+':create:github') 'github' -Attempt 1 -Extra @{eventType='CREATE'}}
    }
    Write-Outbox $c @($row)
    $before=Get-Sha $c.outbox
    Assert-Refused (Invoke-Enq $c) $v.code "variant $($v.n)"
    Assert-NoEffects $c "variant $($v.n)" $before
  }
  $c=New-Case; Write-Text $c.outbox '{not json'; $before=Get-Sha $c.outbox
  Assert-Refused (Invoke-Enq $c) 'OUTBOX_INVALID' 'malformed'; Assert-NoEffects $c 'malformed' $before
  $c=New-Case; $u=(New-UnrelatedRows)[0]; Write-Outbox $c @($u,$u); $before=Get-Sha $c.outbox
  Assert-Refused (Invoke-Enq $c) 'OUTBOX_INVALID' 'duplicate key'; Assert-NoEffects $c 'duplicate key' $before
  $c=New-Case; Write-Outbox $c (New-UnrelatedRows); $before=Get-Sha $c.outbox
  Assert-Refused (Invoke-Enq $c @{ExpectedOutboxSha256=('0'*64)}) 'OUTBOX_DRIFT' 'stale pin'; Assert-NoEffects $c 'stale pin' $before
}
Test-Step 'AC2 oversize serialization and a conflicting sidecar refuse before any outbox write' {
  $c=New-Case; Write-Outbox $c (New-UnrelatedRows -BigNote ('x'*1100000)); $before=Get-Sha $c.outbox
  Assert-Refused (Invoke-Enq $c) 'OUTBOX_TOO_LARGE' 'oversize'; Assert-NoEffects $c 'oversize' $before
  $c=New-Case; Write-Outbox $c (New-UnrelatedRows); $before=Get-Sha $c.outbox
  [void][IO.Directory]::CreateDirectory($c.eventDir); Write-Text $c.event 'tampered'; $tamperedSha=Get-Sha $c.event
  Assert-Refused (Invoke-Enq $c) 'SIDECAR_CONFLICT' 'tampered sidecar'
  Assert-Eq (Get-Sha $c.event) $tamperedSha 'tampered sidecar bytes preserved'; Assert-Eq (Get-Sha $c.outbox) $before 'outbox untouched'
  Assert-True (-not [IO.File]::Exists($c.canonical+'.lock')) 'no lease for a pre-lease refusal'
}
Test-Step 'AC2 wrong event, revision, fields, identity, pins and key grammar refuse and are not repaired' {
  $cases=@(
    @{c=(New-Case -PacketOverride @{eventType='UPDATE'});code='UNSUPPORTED_EVENT';n='non-CREATE packet'},
    @{c=(New-Case -PacketOverride @{eventType='COMPLETE'});code='UNSUPPORTED_EVENT';n='COMPLETE packet'},
    @{c=(New-Case -CanonicalOverride @{nextAction='NONE'} -PacketOverride @{nextAction='NONE'});code='PACKET_INVALID';n='terminal NONE'},
    @{c=(New-Case -PacketOverride @{destinations=@('github')});code='DESTINATIONS_INVALID';n='destinations'},
    @{c=(New-Case -CanonicalOverride @{publicTitle='Different synthetic title'});code='CANONICAL_PACKET_MISMATCH';n='title'},
    @{c=(New-Case -CanonicalOverride @{canonicalRevision=8});code='CANONICAL_PACKET_MISMATCH';n='canonical revision'},
    @{c=(New-Case -CanonicalOverride @{extraField='x'});code='FIELDS_INVALID';n='extra canonical key'},
    @{c=(New-Case -PacketOverride @{idempotencyKey='synth:create:7'});code='IDEMPOTENCY_KEY_UNSAFE';n='unsafe key segment'}
  )
  foreach($x in $cases){Assert-Refused (Invoke-Enq $x.c) $x.code $x.n; Assert-NoEffects $x.c $x.n}
  $c=New-Case
  Assert-Refused (Invoke-Enq $c @{CanonicalRevision=8}) 'IDENTITY_MISMATCH' 'invoked revision'
  Assert-Refused (Invoke-Enq $c @{TaskId='SYNTH-TASK-2'}) 'IDENTITY_MISMATCH' 'invoked task'
  Assert-Refused (Invoke-Enq $c @{CanonicalRevision=0}) 'REVISION_INVALID' 'revision zero'
  $other=Get-Sha $c.packet
  Assert-Refused (Invoke-Enq $c @{ExpectedCanonicalSha256=$other}) 'CANONICAL_DRIFT' 'canonical pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedPacketSha256=(Get-Sha $c.canonical)}) 'PACKET_DRIFT' 'packet pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedConsumerSha256=$other}) 'CONSUMER_DRIFT' 'consumer pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedReconcileSha256=$other}) 'RECONCILE_DRIFT' 'reconcile pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedCaptureSha256=$other}) 'CAPTURE_DRIFT' 'capture pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedCanonicalSha256=$other.ToUpperInvariant()}) 'PIN_INVALID' 'uppercase pin'
  Assert-NoEffects $c 'pin refusals'
  $a=@{TaskId='SYNTH-TASK-1';CanonicalRevision=7;CanonicalPath=$c.canonical;ExpectedCanonicalSha256=(Get-Sha $c.canonical);PacketPath=$c.packet;ExpectedPacketSha256=(Get-Sha $c.packet);ConsumerPath=$ConsumerFile;ExpectedConsumerSha256=$ConsumerSha;ReconcilePath=$ReconcileFile;ExpectedReconcileSha256=$ReconcileSha;ExpectedCaptureSha256=$CaptureSha;StateDir=$c.state;OutboxPath=$c.outbox}
  Assert-Refused (Invoke-CanonicalLifecycleCreateEnqueue @a) 'OUTBOX_PIN_REQUIRED' 'omitted outbox pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedOutboxSha256=$EmptySha}) 'OUTBOX_DRIFT' 'empty-hash pin against absent outbox'
  $pinned=Get-Sha $c.canonical
  Write-Json $c.canonical ([ordered]@{taskId='SYNTH-TASK-1';canonicalRevision=7;publicTitle='Synthetic fixture title';publicSummary='Changed after pin.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})
  Assert-Refused (Invoke-Enq $c @{ExpectedCanonicalSha256=$pinned}) 'CANONICAL_DRIFT' 'drift after pin'
  Assert-NoEffects $c 'drift after pin'
}
Test-Step 'AC2 reparse, outside-owned and non-canonical paths refuse' {
  $c=New-Case
  $link=Join-Path $c.dir 'linkstate'; $made=$false
  try{ New-DirLink $link $c.state; $made=$true
    Assert-Refused (Invoke-Enq $c @{StateDir=$link;OutboxPath=(Join-Path $link 'outbox.json')}) 'REPARSE_REFUSED' 'state via junction'
  } finally { if($made){Remove-DirLink $link} }
  $target=Join-Path $c.dir 'elsewhere'; [void][IO.Directory]::CreateDirectory($target); $made=$false
  try{ New-DirLink $c.eventDir $target; $made=$true
    Assert-Refused (Invoke-Enq $c) 'REPARSE_REFUSED' 'sidecar directory is a junction'
  } finally { if($made){Remove-DirLink $c.eventDir} }
  Assert-Eq @(Get-Names $target).Count 0 'junction target untouched'
  Assert-Refused (Invoke-Enq $c @{OutboxPath=(Join-Path $c.dir 'outbox.json')}) 'PATH_OUTSIDE_OWNER' 'outbox outside state dir'
  Assert-Refused (Invoke-Enq $c @{OutboxPath='outbox.json'}) 'PATH_INVALID' 'relative outbox'
  Assert-Refused (Invoke-Enq $c @{StateDir=(Join-Path $c.dir 'state\..\state')}) 'PATH_INVALID' 'non-canonical state dir'
  Assert-Refused (Invoke-Enq $c @{OutboxPath=(Join-Path $c.state 'other.json')}) 'OUTBOX_BINDING' 'unbound outbox name'
  Assert-NoEffects $c 'path refusals'
}
Test-Step 'AC2 lease contention refuses without writing; release then enqueues' {
  $c=New-Case
  $h=[IO.File]::Open($c.canonical+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ Assert-Refused (Invoke-Enq $c) 'CANONICAL_LOCKED' 'canonical lease' } finally { $h.Dispose() }
  Assert-True (-not [IO.File]::Exists($c.outbox) -and -not [IO.Directory]::Exists($c.eventDir)) 'nothing written under canonical contention'
  $h=[IO.File]::Open((Join-Path $c.state 'publisher.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ Assert-Refused (Invoke-Enq $c) 'PUBLISHER_LOCKED' 'publisher lease' } finally { $h.Dispose() }
  Assert-True (-not [IO.File]::Exists($c.outbox) -and -not [IO.Directory]::Exists($c.eventDir)) 'nothing written under publisher contention'
  Assert-Eq (Invoke-Enq $c).status 'ENQUEUED' 'enqueue after leases released'
}

# AC3
Test-Step 'AC3 failure after sidecar preparation reports PREPARED_HANDOFF; same data recovers once; drift and conflict preserve bytes' {
  $c=New-Case; $ex=Get-Expect $c
  Write-Outbox $c (New-UnrelatedRows)
  $before=Get-Sha $c.outbox
  $script:FaultTarget=$c.outbox; $script:FaultCalls=0
  Set-Alias -Name Write-OutboxAtomic -Value Invoke-FaultWriter -Scope Global
  try{ $r=Invoke-Enq $c } finally {
    Remove-Item -Path 'Alias:\Write-OutboxAtomic' -Force -ErrorAction SilentlyContinue
    $script:FaultTarget=$null
  }
  Assert-Eq $script:FaultCalls 1 'writer reached once on the exact target'
  Assert-True ($null -eq (Get-Alias -Name Write-OutboxAtomic -ErrorAction SilentlyContinue)) 'fault alias removed'
  Assert-Eq $r.status 'WRITE_FAILED' 'status'; Assert-Eq $r.code 'OUTBOX_WRITE_FAILED' 'code'; Assert-Eq $r.outboxState 'UNCHANGED' 'outbox state'
  Assert-Eq $r.handoff 'PREPARED_HANDOFF' 'explicit prepared evidence'; Assert-Eq $r.createEventRef.sha256 $EventSha 'prepared event ref'
  Assert-Eq $r.errorType 'System.IO.IOException' 'injected error type'
  Assert-Eq (Get-Sha $c.outbox) $before 'old outbox still intact'; Assert-Eq @(Read-Outbox $c.outbox).Count 2 'old outbox still valid'
  Assert-Eq (Get-Sha $c.event) $EventSha 'prepared sidecar kept, not rolled back'
  Assert-FaultTempsRetained $c 'after failure'
  $expectedNames=@($EventDirName,'outbox.json','publisher.lock')+@($script:FaultTemps.Keys | ForEach-Object {[IO.Path]::GetFileName($_)})
  Assert-Eq ((Get-Names $c.state) -join '|') (($expectedNames | Sort-Object) -join '|') 'only sidecar, outbox, lease and retained unowned temps'
  # External drift after the failure: the stale pin is refused and every byte is preserved.
  Write-Outbox $c @((New-UnrelatedRows)[0])
  $driftBytes=Get-Sha $c.outbox
  Assert-Refused (Invoke-Enq $c @{ExpectedOutboxSha256=$before}) 'OUTBOX_DRIFT' 'stale pin after external change'
  Assert-Eq (Get-Sha $c.outbox) $driftBytes 'drifted outbox preserved'; Assert-Eq (Get-Sha $c.event) $EventSha 'sidecar preserved'
  Write-Outbox $c (New-UnrelatedRows)
  $retry=Invoke-Enq $c
  Assert-Eq $retry.status 'ENQUEUED' 'retry status'; Assert-Eq $retry.added 2 'retry added'; Assert-Eq $retry.sidecarCreated $false 'prepared sidecar reused'
  Assert-Eq (Get-Sha $c.event) $EventSha 'sidecar bytes stable'
  $rows=@(Read-Outbox $c.outbox)
  Assert-Eq $rows.Count 4 'rows after retry'
  foreach($d in @('github','note')){Assert-Eq @($rows | Where-Object {$_.key -ceq $ex[$d]}).Count 1 "one $d row"}
  Assert-Eq (Invoke-Enq $c).status 'UNCHANGED' 'second retry is replay'
}
Test-Step 'AC3 an outbox with no prior file keeps no half state when the writer fails' {
  $c=New-Case
  $script:FaultTarget=$c.outbox; $script:FaultCalls=0
  Set-Alias -Name Write-OutboxAtomic -Value Invoke-FaultWriter -Scope Global
  try{ $r=Invoke-Enq $c } finally { Remove-Item -Path 'Alias:\Write-OutboxAtomic' -Force -ErrorAction SilentlyContinue; $script:FaultTarget=$null }
  Assert-Eq $r.status 'WRITE_FAILED' 'status'; Assert-Eq $r.outboxState 'UNCHANGED' 'absent outbox stays absent'; Assert-Eq $r.handoff 'PREPARED_HANDOFF' 'handoff'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox'
  Assert-FaultTempsRetained $c 'absent outbox'
  $expectedNames=@($EventDirName,'publisher.lock')+@($script:FaultTemps.Keys | ForEach-Object {[IO.Path]::GetFileName($_)})
  Assert-Eq ((Get-Names $c.state) -join '|') (($expectedNames | Sort-Object) -join '|') 'only sidecar, lease and retained unowned temps remain'
  Assert-Eq (Invoke-Enq $c).added 2 'recovery adds both rows'
}

# AC4
function New-ConsumerRelease {
  param($Case,[ValidateSet('UPDATE','COMPLETE')][string]$Kind)
  $d=Join-Path $Case.dir ('consumer-'+$Kind); $vault=Join-Path $d 'vault'; $tmp=Join-Path $d 'tmp'
  foreach($x in @($d,$vault,$tmp)){[void][IO.Directory]::CreateDirectory($x)}
  $f=@{}
  foreach($n in @('mapping.json','before-issue.json','before-note.md','gh-placeholder.txt','completion-proof.json')){$f[$n]=Join-Path $d $n; Write-Text $f[$n] ('{"synthetic":"'+$n+'"}')}
  $pin={param($p) [ordered]@{path=$p;sha256=(Get-Sha $p)}}
  $review=Join-Path $d 'review.json'; $native=Join-Path $d 'native.json'
  Write-Json $review ([ordered]@{schema='LifecycleIndependentReview/v1';decision='ADMIT';packetSha256=(Get-Sha $Case.packet);consumerSha256=$ConsumerSha;transportSha256=(Get-Sha $TransportFile)})
  Write-Json $native ([ordered]@{schema='LifecycleNativeRequest/v1';action='UPDATE';packetSha256=(Get-Sha $Case.packet);reviewSha256=(Get-Sha $review);consumerSha256=$ConsumerSha;transportSha256=(Get-Sha $TransportFile);executableSha256=(Get-Sha $f['gh-placeholder.txt']);stateDir=$Case.state;notePath=(Join-Path $vault 'note.md');outboxPath=$Case.outbox})
  $rel=[ordered]@{schema=$(if($Kind -ceq 'UPDATE'){'TaskLifecycleUpdateRelease/v1'}else{'TaskLifecycleCompleteRelease/v1'})
    packet=(& $pin $Case.packet);canonical=(& $pin $Case.canonical);mapping=(& $pin $f['mapping.json']);beforeIssue=(& $pin $f['before-issue.json']);beforeNote=(& $pin $f['before-note.md'])
    review=(& $pin $review);nativeRequest=(& $pin $native);consumer=(& $pin $ConsumerFile);transport=(& $pin $TransportFile);executable=(& $pin $f['gh-placeholder.txt'])}
  if($Kind -ceq 'COMPLETE'){$rel['completionProof']=(& $pin $f['completion-proof.json'])}
  $lifecycleName=$(if($Kind -ceq 'UPDATE'){'lifecycle-update.journal.json'}else{'lifecycle-complete.journal.json'})
  $rel['stateDir']=$Case.state; $rel['vaultRoot']=$vault; $rel['notePath']=(Join-Path $vault 'note.md'); $rel['outboxPath']=$Case.outbox
  $rel['journalPath']=(Join-Path $Case.state $lifecycleName); $rel['canonicalLease']=($Case.canonical+'.lock'); $rel['publisherLease']=(Join-Path $Case.state 'publisher.lock')
  $rel['tempRoot']=$tmp; $rel['outboxSha256']=(Get-Sha $Case.outbox); $rel['recovery']='INITIAL'
  $relPath=Join-Path $d 'release.json'; Write-Json $relPath $rel
  return @{release=$relPath;releaseSha=(Get-Sha $relPath);reviewSha=(Get-Sha $review);nativeSha=(Get-Sha $native)}
}
Test-Step 'AC4 existing UPDATE and COMPLETE consumers refuse a CREATE packet with zero transport, note or outbox mutation' {
  $c=New-Case
  Write-Outbox $c (New-UnrelatedRows)
  Assert-Eq (Invoke-Enq $c).status 'ENQUEUED' 'enqueue'
  $readerBefore=@(Read-Outbox $c.outbox).Count
  Assert-Eq $readerBefore 4 'reader sees CREATE rows before'
  $upd=New-ConsumerRelease $c 'UPDATE'; $cmp=New-ConsumerRelease $c 'COMPLETE'
  $treeBefore=Get-Tree $c.dir
  $script:RunnerCalls=0
  $runner={ $script:RunnerCalls++; throw 'transport must never be reached for a CREATE packet' }
  $r1=Invoke-AdmittedTaskLifecycleUpdate -ReleasePath $upd.release -ExpectedReleaseSha256 $upd.releaseSha -ExpectedReviewSha256 $upd.reviewSha -ExpectedNativeRequestSha256 $upd.nativeSha -ReconcilePath $ReconcileFile -ProcessRunner $runner
  Assert-Refused $r1 'UNSUPPORTED_EVENT' 'UPDATE consumer'
  $r2=Invoke-DurableGitHubTaskComplete -ReleasePath $cmp.release -ExpectedReleaseSha256 $cmp.releaseSha -ExpectedReviewSha256 $cmp.reviewSha -ExpectedNativeRequestSha256 $cmp.nativeSha -ReconcilePath $ReconcileFile -ProcessRunner $runner
  Assert-Refused $r2 'UNSUPPORTED_EVENT' 'COMPLETE consumer'
  Assert-Eq $script:RunnerCalls 0 'transport runner never invoked'
  Assert-Eq (Get-Tree $c.dir) $treeBefore 'no file in the case tree changed (outbox, note, journals, leases, sidecar)'
  Assert-Eq @(Read-Outbox $c.outbox).Count $readerBefore 'reader still accepts the same rows after'
}

# AC5
Test-Step 'AC5 dependency inputs unchanged and no execution surface in the CREATE enqueue source' {
  foreach($f in $DepFiles){Assert-Eq (Get-Sha $f) $DepBefore[$f] "unchanged $f"}
  $src=[IO.File]::ReadAllText($EnqueueFile)
  foreach($bad in @('Start-Process','Invoke-WebRequest','Invoke-RestMethod','Invoke-Expression','Invoke-DurableGitHubTaskCreate','Invoke-AdmittedTaskLifecycleUpdate','Invoke-DurableGitHubTaskComplete','New-GitHubCliLifecycleTransport216','github-task-lifecycle','ConvertTo-SecureString')){
    Assert-True (-not $src.Contains($bad)) "enqueue source does not reference $bad"
  }
  foreach($case in 1..$script:CaseN){
    $dir=Join-Path $Ev "case$case"
    foreach($child in @(Get-ChildItem -LiteralPath $dir -Force -Recurse | ForEach-Object {$_.FullName})){
      Assert-True ($child.StartsWith($Ev+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal)) 'fixtures stay under EvidenceRoot'
    }
  }
}

$failed=@($Results | Where-Object {-not $_.ok})
Write-Json (Join-Path $Ev 'results.json') @($Results)
Write-Host ("canonical-create-enqueue: {0} passed, {1} failed (synthetic offline fixtures; not publication proof)" -f ($Results.Count-$failed.Count),$failed.Count)
if($failed.Count -gt 0){exit 1}
