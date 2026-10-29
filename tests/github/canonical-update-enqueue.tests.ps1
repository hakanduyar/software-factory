#Requires -Version 7.6
# SYNTHETIC OFFLINE FIXTURES ONLY. Every task, packet, canonical snapshot and outbox row below is
# invented for this test. Passing it is not publication, destination delivery, or proof of an
# automatic lifecycle feed; it only exercises the explicit enqueue boundary.
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
$EnqueueFile=Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-update.ps1'
$ConsumerFile=Get-SourceFile 'scripts\github\task-lifecycle-mirror-consumer.ps1'
$ReconcileFile=Get-SourceFile 'scripts\github\lifecycle-compat\continuity\reconcile.ps1'
$TransportFile=Get-SourceFile 'scripts\github\github-cli-transport216.ps1'

function Get-Sha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
$EmptySha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
$DepFiles=@($EnqueueFile,$ConsumerFile,$ReconcileFile,$TransportFile)
$DepBefore=@{}; foreach($f in $DepFiles){$DepBefore[$f]=Get-Sha $f}
$ConsumerSha=$DepBefore[$ConsumerFile]; $ReconcileSha=$DepBefore[$ReconcileFile]

# Test-scope copies of the existing consumer/reconcile are the independent oracle (parity, Read-Outbox).
. $EnqueueFile
. $ConsumerFile
. $ReconcileFile

function Write-Text { param([string]$Path,[string]$Text) [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false)) }
function Write-Json { param([string]$Path,$Obj) Write-Text $Path (ConvertTo-Json -InputObject $Obj -Depth 6) }
function Get-Names { param([string]$Dir) @(Get-ChildItem -LiteralPath $Dir -Force | ForEach-Object {$_.Name} | Sort-Object) }
function Assert-True { param($Cond,[string]$Msg) if(-not $Cond){throw "ASSERT: $Msg"} }
function Assert-Eq { param($Actual,$Expected,[string]$Msg) if("$Actual" -cne "$Expected"){throw "ASSERT: $Msg (expected '$Expected', got '$Actual')"} }
function Assert-Refused { param($R,[string]$Code,[string]$Msg) Assert-Eq $R.status 'REFUSED' "$Msg status"; Assert-Eq $R.code $Code "$Msg code" }

$script:CaseN=0
function New-Case {
  param([hashtable]$CanonicalOverride=@{},[hashtable]$PacketOverride=@{})
  $script:CaseN++
  $dir=Join-Path $Ev ('case'+$script:CaseN); $state=Join-Path $dir 'state'
  [void][IO.Directory]::CreateDirectory($state)
  $canon=[ordered]@{taskId='SYNTH-TASK-1';canonicalRevision=7;publicTitle='Synthetic fixture title';publicSummary='Synthetic fixture summary for offline test only.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}
  $pkt=[ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId='SYNTH-TASK-1';canonicalRevision=7;eventType='UPDATE';idempotencyKey='synth-idem-7';publicTitle='Synthetic fixture title';publicSummary='Synthetic fixture summary for offline test only.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS';destinations=@('github','note')}
  foreach($k in $CanonicalOverride.Keys){$canon[$k]=$CanonicalOverride[$k]}
  foreach($k in $PacketOverride.Keys){$pkt[$k]=$PacketOverride[$k]}
  $c=@{dir=$dir;state=$state;outbox=(Join-Path $state 'outbox.json');canonical=(Join-Path $dir 'canonical.json');packet=(Join-Path $dir 'packet.json')}
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
    $literal=$p.taskId+':'+$digest+':'+$p.idempotencyKey+':'+$d+':AWAITING_CONTROLLER:0'
    $e[$d]=Get-EventKey -TaskId $p.taskId -PayloadSha256 $digest -RunId ($p.idempotencyKey+':'+$d) -Status 'AWAITING_CONTROLLER' -Attempt 0
    Assert-Eq $e[$d] $literal "consumer key formula for $d"
  }
  return $e
}
function New-Row {
  param($Task,$Digest,$RunId,$Dest,$Status='AWAITING_CONTROLLER',$Attempt=0,$Delivery='PENDING',$Proof=$null,[hashtable]$Extra=@{})
  $key=Get-EventKey -TaskId $Task -PayloadSha256 $Digest -RunId $RunId -Status $Status -Attempt $Attempt
  $o=[ordered]@{key=$key;taskId=$Task;payloadSha256=$Digest;runId=$RunId;destination=$Dest;status=$Status;attempt=$Attempt;deliveryStatus=$Delivery;proof=$Proof}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function New-UnrelatedRow {
  New-Row -Task 'SYNTH-OTHER' -Digest ('a'*64) -RunId 'synth-other-run' -Dest 'github' -Status 'FAILED' -Attempt 1 -Extra @{updatedAt='2026-01-01T00:00:00Z';consentEligibility=$null;reconciliationSignal=$false;synthNote='unrelated metadata'}
}
function Write-Outbox { param($Case,[object[]]$Rows) Write-OutboxAtomic $Case.outbox $Rows }
function Read-RawRows { param([string]$Path) $t=[IO.File]::ReadAllText($Path); @((ConvertFrom-Json -InputObject $t -NoEnumerate -DateKind String)) }
function Invoke-Enq {
  param($Case,[hashtable]$Override=@{})
  $pin=$null; if([IO.File]::Exists($Case.outbox)){$pin=Get-Sha $Case.outbox}
  $a=@{CanonicalPath=$Case.canonical;ExpectedCanonicalSha256=(Get-Sha $Case.canonical);PacketPath=$Case.packet;ExpectedPacketSha256=(Get-Sha $Case.packet);
       ConsumerPath=$ConsumerFile;ExpectedConsumerSha256=$ConsumerSha;ReconcilePath=$ReconcileFile;ExpectedReconcileSha256=$ReconcileSha;
       StateDir=$Case.state;OutboxPath=$Case.outbox;ExpectedOutboxSha256=$pin}
  foreach($k in $Override.Keys){$a[$k]=$Override[$k]}
  Invoke-CanonicalLifecycleUpdateEnqueue @a
}

# Test-only deterministic writer fault. A global alias outranks the function the enqueue boundary
# loads from the pinned reconcile, so the production code needs no hook. The fault applies only to
# the armed exact outbox target (after leaving a partial temp file); every other call is delegated
# to the original writer. The alias is removed in finally; the original function is never replaced.
$script:FaultTarget=$null; $script:FaultCalls=0
$script:OriginalWriter=(Get-Command -Name Write-OutboxAtomic -CommandType Function).ScriptBlock
function Invoke-FaultWriter {
  param([string]$OutboxPath,[object[]]$Events)
  if($null -ne $script:FaultTarget -and $OutboxPath -ceq $script:FaultTarget){
    $script:FaultCalls++
    [IO.File]::WriteAllText($OutboxPath+'.tmp_'+[guid]::NewGuid().ToString('N'),'partial')
    throw [IO.IOException]::new('synthetic injected writer failure')
  }
  & $script:OriginalWriter $OutboxPath $Events
}
# Copy of the retained compat tree so closure drift/missing/reparse can be staged without touching sources.
function New-CompatCopy {
  param($Case)
  $root=Join-Path $Case.dir 'compat'
  Copy-Item -LiteralPath (Get-SourceFile 'scripts\github\lifecycle-compat') -Destination $root -Recurse
  return @{root=$root;reconcile=(Join-Path $root 'continuity\reconcile.ps1');capture=(Join-Path $root 'dispatch\reviewed-blocked-capture.ps1')}
}
function Assert-NoSideEffects {
  param($Case,[string]$Msg)
  Assert-True (-not [IO.File]::Exists($Case.outbox)) "$Msg no outbox"
  Assert-True (-not [IO.File]::Exists($Case.canonical+'.lock')) "$Msg no canonical lease created"
  Assert-Eq @(Get-Names $Case.state).Count 0 "$Msg state dir untouched"
}

$Results=[System.Collections.Generic.List[object]]::new()
function Test-Step {
  param([string]$Name,[scriptblock]$Body)
  try{ & $Body; $Results.Add([pscustomobject]@{name=$Name;ok=$true;error=''}); Write-Host "PASS $Name" }
  catch{ $Results.Add([pscustomobject]@{name=$Name;ok=$false;error=$_.Exception.Message}); Write-Host "FAIL $Name :: $($_.Exception.Message)" }
}

# AC1
Test-Step 'AC1 fresh UPDATE creates exactly two reader-compatible PENDING rows with consumer parity' {
  $c=New-Case; $ex=Get-Expect $c
  $r=Invoke-Enq $c
  Assert-Eq $r.status 'ENQUEUED' 'status'; Assert-Eq $r.added 2 'added'; Assert-Eq $r.existing 0 'existing'
  Assert-Eq ($r.keys -join '|') ($ex.github+'|'+$ex.note) 'result keys'
  $rows=@(Read-Outbox $c.outbox)
  Assert-Eq $rows.Count 2 'row count'
  foreach($d in @('github','note')){
    $m=@($rows | Where-Object {$_.key -ceq $ex[$d]})
    Assert-Eq $m.Count 1 "consumer key selection $d"
    $row=$m[0]
    Assert-Eq $row.deliveryStatus 'PENDING' "$d delivery"; Assert-True ($null -eq $row.proof) "$d proof null"
    Assert-Eq $row.status 'AWAITING_CONTROLLER' "$d status"; Assert-Eq $row.attempt 0 "$d attempt"
    Assert-Eq $row.runId ($ex.id+':'+$d) "$d runId"; Assert-Eq $row.destination $d "$d destination"
    Assert-Eq $row.payloadSha256 $ex.digest "$d digest"; Assert-Eq $row.taskId $ex.task "$d task"
  }
  Assert-Eq ((Get-Names $c.state) -join '|') 'outbox.json|publisher.lock' 'state dir holds only outbox and publisher lease'
}

# AC2
Test-Step 'AC2 current-pinned identical replay is byte stable; stale pin refuses' {
  $c=New-Case; $ex=Get-Expect $c
  Write-Outbox $c @((New-UnrelatedRow),(New-Row $ex.task $ex.digest ($ex.id+':github') 'github' -Delivery 'DELIVERED' -Proof 'readback:synthetic-proof'),(New-Row $ex.task $ex.digest ($ex.id+':note') 'note'))
  $before=Get-Sha $c.outbox
  $r=Invoke-Enq $c
  Assert-Eq $r.status 'UNCHANGED' 'status'; Assert-Eq $r.existing 2 'existing'; Assert-Eq $r.added 0 'added'
  Assert-Eq (Get-Sha $c.outbox) $before 'bytes after replay'
  $stale=Invoke-Enq $c @{ExpectedOutboxSha256=('0'*64)}
  Assert-Refused $stale 'OUTBOX_DRIFT' 'stale pin'
  Assert-Eq (Get-Sha $c.outbox) $before 'bytes after stale refusal'
}
Test-Step 'AC2 missing one compatible row adds only that row and preserves the rest' {
  $c=New-Case; $ex=Get-Expect $c
  Write-Outbox $c @((New-UnrelatedRow),(New-Row $ex.task $ex.digest ($ex.id+':github') 'github' -Delivery 'DELIVERED' -Proof 'readback:synthetic-proof'))
  $beforeRows=Read-RawRows $c.outbox
  $r=Invoke-Enq $c
  Assert-Eq $r.status 'ENQUEUED' 'status'; Assert-Eq $r.added 1 'added'; Assert-Eq $r.existing 1 'existing'
  $afterRows=Read-RawRows $c.outbox
  Assert-Eq $afterRows.Count 3 'row count'
  for($i=0;$i -lt 2;$i++){Assert-Eq (ConvertTo-Json -InputObject $afterRows[$i] -Depth 10 -Compress) (ConvertTo-Json -InputObject $beforeRows[$i] -Depth 10 -Compress) "row $i preserved"}
  Assert-Eq $afterRows[2].destination 'note' 'added destination'; Assert-Eq $afterRows[2].deliveryStatus 'PENDING' 'added delivery'
  Assert-Eq $afterRows[1].proof 'readback:synthetic-proof' 'delivered proof kept'
  Assert-True ([IO.File]::ReadAllText($c.outbox).Contains('2026-01-01T00:00:00Z')) 'unrelated date text not reformatted'
  Assert-Eq @(Read-Outbox $c.outbox).Count 3 'existing reader accepts result'
}

# AC3
Test-Step 'AC3 conflicting same-key rows refuse and leave bytes unchanged' {
  foreach($variant in @('digest','status','attempt','task')){
    $c=New-Case; $ex=Get-Expect $c
    $row=switch($variant){
      'digest' {New-Row $ex.task ('b'*64) ($ex.id+':github') 'github'}
      'status' {New-Row $ex.task $ex.digest ($ex.id+':github') 'github' -Status 'FAILED'}
      'attempt' {New-Row $ex.task $ex.digest ($ex.id+':github') 'github' -Attempt 1}
      'task' {New-Row 'SYNTH-OTHER' $ex.digest ($ex.id+':github') 'github'}
    }
    Write-Outbox $c @($row)
    $before=Get-Sha $c.outbox
    Assert-Refused (Invoke-Enq $c) 'EVENT_CONFLICT' "conflict $variant"
    Assert-Eq (Get-Sha $c.outbox) $before "bytes $variant"
  }
}
Test-Step 'AC3 malformed or duplicate outbox refuses without mutation' {
  $c=New-Case; $ex=Get-Expect $c
  Write-Text $c.outbox '{not json'
  $before=Get-Sha $c.outbox
  Assert-Refused (Invoke-Enq $c) 'OUTBOX_INVALID' 'malformed'
  Assert-Eq (Get-Sha $c.outbox) $before 'malformed bytes'
  $c=New-Case; $row=New-UnrelatedRow
  Write-Outbox $c @($row,$row); $before=Get-Sha $c.outbox
  Assert-Refused (Invoke-Enq $c) 'OUTBOX_INVALID' 'duplicate'
  Assert-Eq (Get-Sha $c.outbox) $before 'duplicate bytes'
  $c=New-Case; $row=New-UnrelatedRow; $row.PSObject.Properties.Remove('deliveryStatus')
  Write-Outbox $c @($row); $before=Get-Sha $c.outbox
  Assert-Refused (Invoke-Enq $c) 'OUTBOX_INVALID' 'missing field'
  Assert-Eq (Get-Sha $c.outbox) $before 'missing field bytes'
}
Test-Step 'AC3 canonical/packet mismatches and unsupported shapes refuse' {
  $c=New-Case -CanonicalOverride @{publicTitle='Different synthetic title'}
  Assert-Refused (Invoke-Enq $c) 'CANONICAL_PACKET_MISMATCH' 'title'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox after title mismatch'
  $c=New-Case -CanonicalOverride @{canonicalRevision=8}
  Assert-Refused (Invoke-Enq $c) 'CANONICAL_PACKET_MISMATCH' 'revision'
  $c=New-Case -CanonicalOverride @{extraField='x'}
  Assert-Refused (Invoke-Enq $c) 'FIELDS_INVALID' 'extra canonical key'
  $c=New-Case -PacketOverride @{eventType='COMPLETE'}
  Assert-Refused (Invoke-Enq $c) 'UNSUPPORTED_EVENT' 'non-UPDATE packet'
  $c=New-Case -PacketOverride @{destinations=@('github')}
  Assert-Refused (Invoke-Enq $c) 'DESTINATIONS_INVALID' 'destinations'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox after refusals'
}

# AC4
Test-Step 'AC4 wrong pins refuse' {
  $c=New-Case; $other=Get-Sha $c.packet
  Assert-Refused (Invoke-Enq $c @{ExpectedCanonicalSha256=$other}) 'CANONICAL_DRIFT' 'canonical pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedPacketSha256=(Get-Sha $c.canonical)}) 'PACKET_DRIFT' 'packet pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedConsumerSha256=$other}) 'CONSUMER_DRIFT' 'consumer pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedReconcileSha256=$other}) 'RECONCILE_DRIFT' 'reconcile pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedCanonicalSha256=$other.ToUpperInvariant()}) 'PIN_INVALID' 'uppercase pin'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox after pin refusals'
  $pinned=Get-Sha $c.canonical
  Write-Json $c.canonical ([ordered]@{taskId='SYNTH-TASK-1';canonicalRevision=7;publicTitle='Synthetic fixture title';publicSummary='Changed after pin.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})
  Assert-Refused (Invoke-Enq $c @{ExpectedCanonicalSha256=$pinned}) 'CANONICAL_DRIFT' 'drift after pin'
}
Test-Step 'AC4 omitted outbox pin refuses; absent vs empty semantics are explicit' {
  $c=New-Case
  $a=@{CanonicalPath=$c.canonical;ExpectedCanonicalSha256=(Get-Sha $c.canonical);PacketPath=$c.packet;ExpectedPacketSha256=(Get-Sha $c.packet);ConsumerPath=$ConsumerFile;ExpectedConsumerSha256=$ConsumerSha;ReconcilePath=$ReconcileFile;ExpectedReconcileSha256=$ReconcileSha;StateDir=$c.state;OutboxPath=$c.outbox}
  Assert-Refused (Invoke-CanonicalLifecycleUpdateEnqueue @a) 'OUTBOX_PIN_REQUIRED' 'omitted pin'
  Assert-Refused (Invoke-Enq $c @{ExpectedOutboxSha256=$EmptySha}) 'OUTBOX_DRIFT' 'empty-hash pin against absent outbox'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'still absent'
  $c=New-Case; Write-Text $c.outbox ''
  Assert-Refused (Invoke-Enq $c @{ExpectedOutboxSha256=$null}) 'OUTBOX_DRIFT' 'null pin against empty file'
  $c2=New-Case; Write-Text $c2.outbox '[]'
  Assert-Refused (Invoke-Enq $c2 @{ExpectedOutboxSha256=$null}) 'OUTBOX_DRIFT' 'null pin against []'
  $r=Invoke-Enq $c @{ExpectedOutboxSha256=$EmptySha}
  Assert-Eq $r.status 'ENQUEUED' 'empty-hash pin against empty file'; Assert-Eq @(Read-Outbox $c.outbox).Count 2 'two rows'
}
Test-Step 'AC4 reparse and outside-owned or non-canonical paths refuse' {
  $c=New-Case
  $link=Join-Path $c.dir 'linkstate'
  New-Item -ItemType Junction -Path $link -Target $c.state | Out-Null
  try{
    Assert-Refused (Invoke-Enq $c @{StateDir=$link;OutboxPath=(Join-Path $link 'outbox.json')}) 'REPARSE_REFUSED' 'state via junction'
  } finally { [IO.Directory]::Delete($link,$false) }
  $linkDir=Join-Path $Ev ('linkdir'+$script:CaseN)
  New-Item -ItemType Junction -Path $linkDir -Target $c.dir | Out-Null
  try{
    Assert-Refused (Invoke-Enq $c @{CanonicalPath=(Join-Path $linkDir 'canonical.json')}) 'REPARSE_REFUSED' 'canonical via junction'
  } finally { [IO.Directory]::Delete($linkDir,$false) }
  Assert-Refused (Invoke-Enq $c @{OutboxPath=(Join-Path $c.dir 'outbox.json')}) 'PATH_OUTSIDE_OWNER' 'outbox outside state dir'
  Assert-Refused (Invoke-Enq $c @{OutboxPath='outbox.json'}) 'PATH_INVALID' 'relative outbox'
  Assert-Refused (Invoke-Enq $c @{StateDir=(Join-Path $c.dir 'state\..\state')}) 'PATH_INVALID' 'non-canonical state dir'
  Assert-Refused (Invoke-Enq $c @{OutboxPath=(Join-Path $c.state 'other.json')}) 'OUTBOX_BINDING' 'unbound outbox name'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox written'
}

# AC5
Test-Step 'AC5 canonical and publisher lease contention refuse without writing' {
  $c=New-Case
  $h=[IO.File]::Open($c.canonical+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ Assert-Refused (Invoke-Enq $c) 'CANONICAL_LOCKED' 'canonical lease' } finally { $h.Dispose() }
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox after canonical contention'
  $h=[IO.File]::Open((Join-Path $c.state 'publisher.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ Assert-Refused (Invoke-Enq $c) 'PUBLISHER_LOCKED' 'publisher lease' } finally { $h.Dispose() }
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox after publisher contention'
  $again=[IO.File]::Open($c.canonical+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $again.Dispose()
  Assert-Eq (Invoke-Enq $c).status 'ENQUEUED' 'enqueue after leases released'
}
Test-Step 'AC5 injected writer failure keeps original outbox; restart retry yields one pair' {
  $c=New-Case; $ex=Get-Expect $c
  Write-Outbox $c @((New-UnrelatedRow))
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
  Assert-Eq $r.errorType 'System.IO.IOException' 'injected error type'
  Assert-Eq (Get-Sha $c.outbox) $before 'bytes after writer failure'
  Assert-Eq @(Read-Outbox $c.outbox).Count 1 'original still parseable'
  Assert-Eq ((Get-Names $c.state) -join '|') 'outbox.json|publisher.lock' 'no temporary leftovers'
  # Lock-contention case on the writer's own lease. This relies on platform file-lock semantics; it is
  # not the deterministic injected IO failure above.
  $h=[IO.File]::Open($c.outbox+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r2=Invoke-Enq $c } finally { $h.Dispose(); Remove-Item -LiteralPath ($c.outbox+'.lock') -Force -ErrorAction SilentlyContinue }
  Assert-Eq $r2.status 'WRITE_FAILED' 'nested lease status'; Assert-Eq (Get-Sha $c.outbox) $before 'bytes after nested lease failure'
  $retry=Invoke-Enq $c
  Assert-Eq $retry.status 'ENQUEUED' 'retry status'; Assert-Eq $retry.added 2 'retry added'
  $rows=@(Read-Outbox $c.outbox)
  Assert-Eq $rows.Count 3 'rows after retry'
  foreach($d in @('github','note')){Assert-Eq @($rows | Where-Object {$_.key -ceq $ex[$d]}).Count 1 "one $d row"}
  $replay=Invoke-Enq $c
  Assert-Eq $replay.status 'UNCHANGED' 'second retry is replay'; Assert-Eq @(Read-Outbox $c.outbox).Count 3 'no duplicates'
}

# Executable dependency closure
Test-Step 'Closure: accepted reconcile+capture are stable; capture drift/missing/reparse and unpinned reconcile refuse before side effects' {
  $reconcileAccepted='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'
  $captureAccepted='31ba531df2b9c8caa00d80d5a5eb3034922a79da45c1fe217daeb7e3fb72a698'
  Assert-Eq $ReconcileSha $reconcileAccepted 'retained reconcile hash'
  Assert-Eq (Get-Sha (Get-SourceFile 'scripts\github\lifecycle-compat\dispatch\reviewed-blocked-capture.ps1')) $captureAccepted 'retained capture hash'

  $c=New-Case; $k=New-CompatCopy $c
  $r=Invoke-Enq $c @{ReconcilePath=$k.reconcile}
  Assert-Eq $r.status 'ENQUEUED' 'accepted closure enqueues'
  Assert-Eq (Get-Sha $k.capture) $captureAccepted 'capture unchanged by run'; Assert-Eq (Get-Sha $k.reconcile) $reconcileAccepted 'reconcile unchanged by run'

  $c=New-Case; $k=New-CompatCopy $c; Write-Text $k.capture '# drifted capture'
  Assert-Refused (Invoke-Enq $c @{ReconcilePath=$k.reconcile}) 'CAPTURE_DRIFT' 'capture drift'
  Assert-NoSideEffects $c 'capture drift'

  $c=New-Case; $k=New-CompatCopy $c; Remove-Item -LiteralPath $k.capture -Force
  Assert-Refused (Invoke-Enq $c @{ReconcilePath=$k.reconcile}) 'FILE_MISSING' 'capture missing'
  Assert-NoSideEffects $c 'capture missing'

  $c=New-Case; $k=New-CompatCopy $c
  $dispatch=Join-Path $k.root 'dispatch'
  Remove-Item -LiteralPath $dispatch -Recurse -Force
  New-Item -ItemType Junction -Path $dispatch -Target (Get-SourceFile 'scripts\github\lifecycle-compat\dispatch') | Out-Null
  try{ Assert-Refused (Invoke-Enq $c @{ReconcilePath=$k.reconcile}) 'REPARSE_REFUSED' 'capture via junction' }
  finally { [IO.Directory]::Delete($dispatch,$false) }
  Assert-NoSideEffects $c 'capture reparse'

  # A caller cannot choose a different reconcile executable by pinning its own hash.
  $c=New-Case; $k=New-CompatCopy $c; Add-Content -LiteralPath $k.reconcile -Value '# caller-chosen change'
  Assert-Refused (Invoke-Enq $c @{ReconcilePath=$k.reconcile;ExpectedReconcileSha256=(Get-Sha $k.reconcile)}) 'RECONCILE_DRIFT' 'unpinned reconcile'
  Assert-NoSideEffects $c 'unpinned reconcile'
}

# AC6
Test-Step 'AC6 dependency inputs unchanged and no execution surface in the enqueue source' {
  foreach($f in $DepFiles){Assert-Eq (Get-Sha $f) $DepBefore[$f] "unchanged $f"}
  $src=[IO.File]::ReadAllText($EnqueueFile)
  foreach($bad in @('Start-Process','Invoke-WebRequest','Invoke-RestMethod','Invoke-Expression','Invoke-AdmittedTaskLifecycleUpdate','New-GitHubCliLifecycleTransport216','ConvertTo-SecureString')){
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
Write-Host ("canonical-update-enqueue: {0} passed, {1} failed (synthetic offline fixtures; not publication proof)" -f ($Results.Count-$failed.Count),$failed.Count)
if($failed.Count -gt 0){exit 1}
