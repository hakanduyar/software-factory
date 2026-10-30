#Requires -Version 7.6
# SYNTHETIC OFFLINE FIXTURES ONLY. Every task, canonical file, packet, admission and outbox row below
# is invented for this test and lives under EvidenceRoot. Passing it is not publication, destination
# delivery, host admission or proof of any live installation; it exercises the explicit canonical
# UPDATE commit -> durable enqueue boundary with the real accepted enqueue/consumer/compat reader.
# Child pwsh processes are started only for the concurrent same-before test and only run this file.
param(
  [Parameter(Mandatory)][string]$SourcePath,
  [Parameter(Mandatory)][string]$EvidenceRoot,
  [string]$ChildRequestPath,[string]$ChildRequestSha256,[string]$ChildAdmissionPath,[string]$ChildAdmissionSha256,[string]$ChildResultPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$SourceRoot=[IO.Path]::GetFullPath($SourcePath).TrimEnd('\','/')
$Ev=[IO.Path]::GetFullPath($EvidenceRoot).TrimEnd('\','/')
function Get-SourceFile { param([string]$Relative) [IO.Path]::GetFullPath((Join-Path $SourceRoot $Relative)) }
$CommitFile=Get-SourceFile 'scripts\github\commit-canonical-lifecycle-update.ps1'
$EnqueueFile=Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-update.ps1'
$ConsumerFile=Get-SourceFile 'scripts\github\task-lifecycle-mirror-consumer.ps1'
$ReconcileFile=Get-SourceFile 'scripts\github\lifecycle-compat\continuity\reconcile.ps1'
$CaptureFile=Get-SourceFile 'scripts\github\lifecycle-compat\dispatch\reviewed-blocked-capture.ps1'

. $CommitFile
if($ChildResultPath){
  $childResult=Invoke-CanonicalLifecycleUpdateCommit -RequestPath $ChildRequestPath -ExpectedRequestSha256 $ChildRequestSha256 -AdmissionPath $ChildAdmissionPath -ExpectedAdmissionSha256 $ChildAdmissionSha256
  [IO.File]::WriteAllText($ChildResultPath,(ConvertTo-Json -InputObject $childResult -Depth 6 -Compress),[Text.UTF8Encoding]::new($false))
  exit 0
}

if([IO.Directory]::Exists($Ev) -and @(Get-ChildItem -LiteralPath $Ev -Force).Count -gt 0){throw 'EvidenceRoot must be fresh and empty'}
[void][IO.Directory]::CreateDirectory($Ev)

function Get-Sha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
$DepFiles=@($CommitFile,$EnqueueFile,$ConsumerFile,$ReconcileFile,$CaptureFile)
$DepBefore=@{}; foreach($f in $DepFiles){$DepBefore[$f]=Get-Sha $f}

# The existing consumer/reconcile are the independent oracle (reader, key formula, row writer).
. $ConsumerFile
. $ReconcileFile

function Write-Text { param([string]$Path,[string]$Text) [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false)) }
function Write-Json { param([string]$Path,$Obj) Write-Text $Path (ConvertTo-Json -InputObject $Obj -Depth 6) }
function Get-Names { param([string]$Dir) @(Get-ChildItem -LiteralPath $Dir -Force | ForEach-Object {$_.Name} | Sort-Object) }
function Assert-True { param($Cond,[string]$Msg) if(-not $Cond){throw "ASSERT: $Msg"} }
function Assert-Eq { param($Actual,$Expected,[string]$Msg) if("$Actual" -cne "$Expected"){throw "ASSERT: $Msg (expected '$Expected', got '$Actual')"} }
function Read-RawRows { param([string]$Path) @((ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -NoEnumerate -DateKind String)) }
function Read-Status { param($Op) Read-LifecycleJson (Join-Path $Op.OpDir 'status.json') }
function New-DirLink {
  param([string]$Path,[string]$Target)
  New-Item -ItemType $(if($IsWindows){'Junction'}else{'SymbolicLink'}) -Path $Path -Target $Target | Out-Null
}
function Remove-DirLink {
  param([string]$Path)
  if(([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -eq 0){throw "refusing to remove non-link: $Path"}
  if($IsWindows){[IO.Directory]::Delete($Path,$false)}else{[IO.File]::Delete($Path)}
}

# Pads a valid JSON file with trailing ASCII spaces to an exact UTF-8 byte length (still strict-readable JSON).
function Set-JsonFileSize {
  param([string]$Path,[int]$Length)
  $t=[IO.File]::ReadAllText($Path).TrimEnd()
  if($Length -lt $t.Length){throw "ASSERT: target size below content for $Path"}
  Write-Text $Path ($t+(' '*($Length-$t.Length)))
}

$script:CaseN=0
function New-Case {
  $script:CaseN++
  $dir=Join-Path $Ev ('case'+$script:CaseN); $state=Join-Path $dir 'state'
  [void][IO.Directory]::CreateDirectory($state)
  $c=@{dir=$dir;state=$state;outbox=(Join-Path $state 'outbox.json');canonical=(Join-Path $dir 'canonical.json')}
  Write-Json $c.canonical ([ordered]@{taskId='SYNTH-TASK-1';canonicalRevision=7;publicTitle='Synthetic fixture title';publicSummary='Synthetic fixture summary for offline test only.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})
  $c.oldSha=Get-Sha $c.canonical
  return $c
}
# Request + independent admission for one operation. Overrides let a test break exactly one binding.
function New-Op {
  param($C,[string]$OpId='op1',[hashtable]$New=@{},[hashtable]$Pkt=@{},[hashtable]$Req=@{},[hashtable]$Adm=@{},[string]$Idem='synth-idem-8',[string]$Summary='Synthetic updated summary for offline test only.',[int]$NewSize=0)
  $n=[ordered]@{taskId='SYNTH-TASK-1';canonicalRevision=8;publicTitle='Synthetic fixture title';publicSummary=$Summary;publicStatus='WAITING_FOR_REVIEW';nextAction='INDEPENDENT_REVIEW'}
  foreach($k in $New.Keys){$n[$k]=$New[$k]}
  $pk=[ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId='SYNTH-TASK-1';canonicalRevision=8;eventType='UPDATE';idempotencyKey=$Idem;publicTitle='Synthetic fixture title';publicSummary=$Summary;publicStatus='WAITING_FOR_REVIEW';nextAction='INDEPENDENT_REVIEW';destinations=@('github','note')}
  foreach($k in $Pkt.Keys){$pk[$k]=$Pkt[$k]}
  $newPath=Join-Path $C.dir "new-$OpId.json"; $pktPath=Join-Path $C.dir "packet-$OpId.json"
  $reqPath=Join-Path $C.dir "request-$OpId.json"; $admPath=Join-Path $C.dir "admission-$OpId.json"
  Write-Json $newPath $n; Write-Json $pktPath $pk
  if($NewSize -gt 0){Set-JsonFileSize $newPath $NewSize}
  $pin=$null; if([IO.File]::Exists($C.outbox)){$pin=Get-Sha $C.outbox}
  $ref={ param($p) [ordered]@{path=$p;sha256=(Get-Sha $p)} }
  $opDir=Join-Path $C.state ('canonical-update-'+$OpId)
  $rq=[ordered]@{schema='CanonicalLifecycleUpdateCommitRequest/v1';operationId=$OpId;taskId='SYNTH-TASK-1';canonicalPath=$C.canonical;expectedBeforeSha256=(Get-Sha $C.canonical)
    newCanonicalRef=(& $ref $newPath);packetRef=(& $ref $pktPath);enqueueRef=(& $ref $EnqueueFile);consumerRef=(& $ref $ConsumerFile);reconcileRef=(& $ref $ReconcileFile)
    stateDir=$C.state;outboxPath=$C.outbox;expectedOutboxSha256=$pin;operationDirectory=$opDir}
  foreach($k in $Req.Keys){$rq[$k]=$Req[$k]}
  Write-Json $reqPath $rq
  $ad=[ordered]@{schema='CanonicalLifecycleUpdateCommitAdmission/v1';decision='ADMIT_CANONICAL_UPDATE_COMMIT';reviewer='synthetic-independent-reviewer';requestSha256=(Get-Sha $reqPath);operationId=$OpId;taskId='SYNTH-TASK-1'
    beforeSha256=(Get-Sha $C.canonical);afterSha256=(Get-Sha $newPath);packetSha256=(Get-Sha $pktPath);enqueueSha256=(Get-Sha $EnqueueFile);consumerSha256=(Get-Sha $ConsumerFile);reconcileSha256=(Get-Sha $ReconcileFile);captureSha256=(Get-Sha $CaptureFile)}
  foreach($k in $Adm.Keys){$ad[$k]=$Adm[$k]}
  Write-Json $admPath $ad
  return @{C=$C;OpId=$OpId;OpDir=$opDir;NewPath=$newPath;NewSha=(Get-Sha $newPath);Adm=$ad;ReqPath=$reqPath;Idem=$Idem
    A=@{RequestPath=$reqPath;ExpectedRequestSha256=(Get-Sha $reqPath);AdmissionPath=$admPath;ExpectedAdmissionSha256=(Get-Sha $admPath)}}
}
function Invoke-Commit { param($Op) $a=$Op.A; Invoke-CanonicalLifecycleUpdateCommit @a }
function Get-Expect {
  param($Op)
  $c=Read-LifecycleJson $Op.NewPath
  $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))
  $e=@{digest=$digest}
  foreach($d in @('github','note')){$e[$d]=Get-EventKey -TaskId $c.taskId -PayloadSha256 $digest -RunId ($Op.Idem+':'+$d) -Status 'AWAITING_CONTROLLER' -Attempt 0}
  return $e
}
function New-Row {
  param($Task,$Digest,$RunId,$Dest,$Status='AWAITING_CONTROLLER',$Attempt=0,$Delivery='PENDING',$Proof=$null,[hashtable]$Extra=@{})
  $key=Get-EventKey -TaskId $Task -PayloadSha256 $Digest -RunId $RunId -Status $Status -Attempt $Attempt
  $o=[ordered]@{key=$key;taskId=$Task;payloadSha256=$Digest;runId=$RunId;destination=$Dest;status=$Status;attempt=$Attempt;deliveryStatus=$Delivery;proof=$Proof}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function New-UnrelatedRow { New-Row -Task 'SYNTH-OTHER' -Digest ('a'*64) -RunId 'synth-other-run' -Dest 'github' -Status 'FAILED' -Attempt 1 -Extra @{updatedAt='2026-01-01T00:00:00Z';consentEligibility=$null;reconciliationSignal=$false;synthNote='unrelated metadata'} }
function Write-Outbox { param($C,[object[]]$Rows) Write-OutboxAtomic $C.outbox $Rows }
function Assert-NoEffects {
  param($Op,[string]$Msg)
  Assert-Eq (Get-Sha $Op.C.canonical) $Op.C.oldSha "$Msg canonical bytes"
  Assert-True (-not [IO.Directory]::Exists($Op.OpDir)) "$Msg no operation directory"
  Assert-True (-not [IO.File]::Exists($Op.C.canonical+'.lock')) "$Msg no canonical lease"
  Assert-True (-not [IO.File]::Exists($Op.C.outbox)) "$Msg no outbox"
}
function Assert-PreEffectRefusal {
  # Initial known-invalid outbox state: truthful refusal, nothing owned is created, nothing is rewritten.
  param($Op,[string]$Code,[string]$OutboxSha,[string]$Msg)
  $r=Invoke-Commit $Op
  Assert-Eq $r.status 'REFUSED' "$Msg status"; Assert-Eq $r.code $Code "$Msg code"; Assert-True (-not $r.canonicalCommitted) "$Msg not committed"
  Assert-Eq (Get-Sha $Op.C.canonical) $Op.C.oldSha "$Msg canonical bytes"
  Assert-Eq (Get-Sha $Op.C.outbox) $OutboxSha "$Msg outbox bytes"
  Assert-True (-not [IO.Directory]::Exists($Op.OpDir)) "$Msg no operation directory"
  Assert-True (-not [IO.File]::Exists($Op.C.canonical+'.lock')) "$Msg no canonical lease"
}
function Assert-EnqueuedRows {
  param($Op,[int]$Total)
  $ex=Get-Expect $Op
  $rows=@(Read-Outbox $Op.C.outbox)
  Assert-Eq $rows.Count $Total 'row count'
  foreach($d in @('github','note')){
    $m=@($rows | Where-Object {$_.key -ceq $ex[$d]}); Assert-Eq $m.Count 1 "one $d row"
    Assert-Eq $m[0].deliveryStatus 'PENDING' "$d pending"; Assert-True ($null -eq $m[0].proof) "$d proof null"
    Assert-Eq $m[0].runId ($Op.Idem+':'+$d) "$d runId"; Assert-Eq $m[0].payloadSha256 $ex.digest "$d digest"
  }
}

# Test-only seam: a global alias outranks the module's no-op Invoke-CmFaultPoint. CRASH simulates a
# process death at the named point (nothing after it runs); FAIL is an ordinary injected IO failure.
$script:FaultPoint=$null; $script:FaultMode=$null
function Invoke-TestFault {
  param([string]$Point)
  if($null -ne $script:FaultPoint -and $Point -ceq $script:FaultPoint){
    if($script:FaultMode -ceq 'CRASH'){throw ('SIMULATED_CRASH:'+$Point)}
    throw [IO.IOException]::new('synthetic injected failure')
  }
}
function Invoke-WithFault {
  param($Op,[string]$Point,[string]$Mode='CRASH')
  $script:FaultPoint=$Point; $script:FaultMode=$Mode
  Set-Alias -Name Invoke-CmFaultPoint -Value Invoke-TestFault -Scope Global
  $out=$null; $crashed=$false
  try{ $out=Invoke-Commit $Op }
  catch{ if($_.Exception.Message -clike 'SIMULATED_CRASH:*'){$crashed=$true}else{throw} }
  finally{ Remove-Item -Path 'Alias:\Invoke-CmFaultPoint' -Force -ErrorAction SilentlyContinue; $script:FaultPoint=$null }
  Assert-True ($null -eq (Get-Alias -Name Invoke-CmFaultPoint -ErrorAction SilentlyContinue)) 'fault alias removed'
  return @{result=$out;crashed=$crashed}
}

$Results=[System.Collections.Generic.List[object]]::new()
function Test-Step {
  param([string]$Name,[scriptblock]$Body)
  try{ & $Body; $Results.Add([pscustomobject]@{name=$Name;ok=$true;error=''}); Write-Host "PASS $Name" }
  catch{ $Results.Add([pscustomobject]@{name=$Name;ok=$false;error=$_.Exception.Message}); Write-Host "FAIL $Name :: $($_.Exception.Message)" }
}

Test-Step 'Valid old->new commits the supplied bytes, enqueues two PENDING rows (no lease deadlock), retains unrelated rows, and is replay stable' {
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $rawBefore=Read-RawRows $c.outbox
  $op=New-Op $c
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'ENQUEUED' 'status'; Assert-Eq $r.code 'ENQUEUED_VERIFIED' 'code'; Assert-True $r.canonicalCommitted 'committed'
  Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'canonical is exactly the supplied bytes'
  Assert-EnqueuedRows $op 3
  $ex=Get-Expect $op; Assert-Eq ($r.keys -join '|') ($ex.github+'|'+$ex.note) 'result keys'
  $rawAfter=Read-RawRows $c.outbox
  Assert-Eq (ConvertTo-Json -InputObject $rawAfter[0] -Depth 10 -Compress) (ConvertTo-Json -InputObject $rawBefore[0] -Depth 10 -Compress) 'unrelated row metadata retained'
  Assert-True ([IO.File]::ReadAllText($c.outbox).Contains('2026-01-01T00:00:00Z')) 'unrelated date text not reformatted'
  $s=Read-Status $op; Assert-Eq $s.phase 'ENQUEUED' 'phase'
  Assert-True ([IO.File]::Exists((Join-Path $op.OpDir 'intent.json'))) 'intent persisted'
  foreach($f in @('intent.json','status.json')){$t=[IO.File]::ReadAllText((Join-Path $op.OpDir $f)); Assert-True (-not $t.Contains('DONE') -and -not $t.Contains('"DELIVERED"')) "$f has no DONE/ACK claim"}
  foreach($l in @(($c.canonical+'.lock'),(Join-Path $c.state 'publisher.lock'),(Join-Path $op.OpDir 'operation.lock'))){$h=[IO.File]::Open($l,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $h.Dispose()}
  $outSha=Get-Sha $c.outbox
  $again=Invoke-Commit $op
  Assert-Eq (ConvertTo-Json -InputObject $again -Compress) (ConvertTo-Json -InputObject $r -Compress) 'replay returns the same result'
  Assert-Eq (Get-Sha $c.outbox) $outSha 'outbox byte stable'; Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'canonical byte stable'
  Assert-EnqueuedRows $op 3
}

Test-Step 'Invalid, missing or mis-bound request/admission/closure/content refuse before any effect' {
  $variants=[ordered]@{
    'missing admission file'=@{code='FILE_MISSING';make={param($c) $o=New-Op $c; Remove-Item -LiteralPath $o.A.AdmissionPath; $o}}
    'wrong admission pin'=@{code='ADMISSION_DRIFT';make={param($c) $o=New-Op $c; $o.A.ExpectedAdmissionSha256='0'*64; $o}}
    'wrong decision'=@{code='ADMISSION_INVALID';make={param($c) New-Op $c -Adm @{decision='APPROVED'}}}
    'boolean approval shortcut'=@{code='FIELDS_INVALID';make={param($c) New-Op $c -Adm @{approved=$true}}}
    'admission wrong task'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{taskId='OTHER-TASK'}}}
    'admission wrong before'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{beforeSha256=('1'*64)}}}
    'admission wrong after'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{afterSha256=('1'*64)}}}
    'admission wrong packet'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{packetSha256=('1'*64)}}}
    'admission wrong closure'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{enqueueSha256=('1'*64)}}}
    'admission wrong request'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{requestSha256=('1'*64)}}}
    'new revision equal'=@{code='REVISION_NOT_INCREASING';make={param($c) New-Op $c -New @{canonicalRevision=7} -Pkt @{canonicalRevision=7}}}
    'new revision lower'=@{code='REVISION_NOT_INCREASING';make={param($c) New-Op $c -New @{canonicalRevision=6} -Pkt @{canonicalRevision=6}}}
    'new revision wrong type'=@{code='REVISION_INVALID';make={param($c) New-Op $c -New @{canonicalRevision='8'}}}
    'new canonical extra field'=@{code='FIELDS_INVALID';make={param($c) New-Op $c -New @{extra='x'}}}
    'new canonical wrong task'=@{code='TASK_MISMATCH';make={param($c) New-Op $c -New @{taskId='OTHER-TASK'}}}
    'packet differs from new bytes'=@{code='CANONICAL_PACKET_MISMATCH';make={param($c) New-Op $c -Pkt @{publicTitle='Different synthetic title'}}}
    'packet is not UPDATE'=@{code='UNSUPPORTED_EVENT';make={param($c) New-Op $c -Pkt @{eventType='COMPLETE'}}}
    'closing status unsupported'=@{code='PACKET_INVALID';make={param($c) New-Op $c -New @{publicStatus='DONE'} -Pkt @{publicStatus='DONE'}}}
    'consumer pin drift'=@{code='CONSUMER_DRIFT';make={param($c) $o=New-Op $c; $r=Read-LifecycleJson $o.ReqPath; $r.consumerRef.sha256='0'*64; Write-Json $o.ReqPath $r; $o.A.ExpectedRequestSha256=Get-Sha $o.ReqPath; $o}}
    'unaccepted reconcile pin'=@{code='RECONCILE_DRIFT';make={param($c) $o=New-Op $c; $r=Read-LifecycleJson $o.ReqPath; $r.reconcileRef.sha256='0'*64; Write-Json $o.ReqPath $r; $o.A.ExpectedRequestSha256=Get-Sha $o.ReqPath; $o}}
    'operation directory not owned'=@{code='OPERATION_BINDING';make={param($c) New-Op $c -Req @{operationDirectory=(Join-Path $c.state 'elsewhere')}}}
    'operation id not stable string'=@{code='OPERATION_ID_INVALID';make={param($c) New-Op $c -Req @{operationId='..\x'}}}
    'outbox not state outbox'=@{code='PATH_OUTSIDE_OWNER';make={param($c) New-Op $c -Req @{outboxPath=(Join-Path $c.dir 'outbox.json')}}}
    'stale canonical before'=@{code='CANONICAL_DRIFT';make={param($c) $o=New-Op $c; Write-Json $c.canonical ([ordered]@{taskId='SYNTH-TASK-1';canonicalRevision=7;publicTitle='Synthetic fixture title';publicSummary='Changed after pin.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}); $c.oldSha=Get-Sha $c.canonical; $o}}
    'stale outbox pin'=@{code='OUTBOX_DRIFT';make={param($c) $o=New-Op $c; Write-Outbox $c @((New-UnrelatedRow)); $o}}
  }
  foreach($name in $variants.Keys){
    $c=New-Case; $o=& $variants[$name].make $c
    $r=Invoke-Commit $o
    Assert-Eq $r.status 'REFUSED' "$name status"; Assert-Eq $r.code $variants[$name].code "$name code"
    Assert-Eq (Get-Sha $c.canonical) $c.oldSha "$name canonical bytes"
    Assert-True (-not [IO.Directory]::Exists($o.OpDir)) "$name no operation directory"
    Assert-True (-not [IO.File]::Exists($c.canonical+'.lock')) "$name no canonical lease"
    if($name -cne 'stale outbox pin'){Assert-True (-not [IO.File]::Exists($c.outbox)) "$name no outbox"}
  }
  # Duplicate and case-aliased request fields.
  $c=New-Case; $o=New-Op $c
  foreach($dup in @(',"taskId":"x"',',"TASKID":"x"')){
    $text=[IO.File]::ReadAllText($o.ReqPath).TrimEnd(); $text=$text.Substring(0,$text.Length-1)+$dup+'}'
    Write-Text $o.ReqPath $text; $o.A.ExpectedRequestSha256=Get-Sha $o.ReqPath
    Assert-Eq (Invoke-Commit $o).code 'DUPLICATE_FIELD' "duplicate $dup"
  }
  Assert-NoEffects $o 'duplicate fields'
  # Reparse state directory.
  $c=New-Case; $link=Join-Path $c.dir 'linkstate'; $made=$false
  try{
    New-DirLink $link $c.state; $made=$true
    $o=New-Op $c -Req @{stateDir=$link;outboxPath=(Join-Path $link 'outbox.json');operationDirectory=(Join-Path $link 'canonical-update-op1')}
    $r=Invoke-Commit $o; Assert-Eq $r.code 'REPARSE_REFUSED' 'reparse state'
    Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'reparse canonical bytes'; Assert-Eq @(Get-Names $c.state).Count 0 'reparse state untouched'
  } finally { if($made){Remove-DirLink $link} }
}

Test-Step 'Crash after intent before commit leaves old canonical; same-intent resume commits once' {
  $c=New-Case; $op=New-Op $c
  $f=Invoke-WithFault $op 'AFTER_INTENT'
  Assert-True $f.crashed 'crashed'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'old canonical intact'
  Assert-True ([IO.File]::Exists((Join-Path $op.OpDir 'intent.json'))) 'intent persisted'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox'
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'ENQUEUED' 'resume status'; Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'committed once'; Assert-EnqueuedRows $op 2
}

Test-Step 'Failure injected before canonical replace keeps the old bytes and leaves no temp file; resume succeeds' {
  $c=New-Case; $op=New-Op $c
  $f=Invoke-WithFault $op 'BEFORE_CANONICAL_REPLACE' 'FAIL'
  Assert-Eq $f.result.status 'REFUSED' 'status'; Assert-Eq $f.result.code 'CANONICAL_COMMIT_FAILED' 'code'; Assert-True (-not $f.result.canonicalCommitted) 'not committed'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'old bytes intact'
  Assert-True (@(Get-Names $c.dir | Where-Object {$_ -like 'canonical.json.tmp-*'}).Count -eq 0) 'no temp file'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox'
  Assert-Eq (Invoke-Commit $op).status 'ENQUEUED' 'resume'
  Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'committed'
}

Test-Step 'Crash after canonical commit before enqueue is explicit PENDING_ENQUEUE; same-intent resume enqueues' {
  foreach($point in @('AFTER_CANONICAL_COMMIT','BEFORE_ENQUEUE')){
    $c=New-Case; $op=New-Op $c
    $f=Invoke-WithFault $op $point
    Assert-True $f.crashed "$point crashed"
    Assert-Eq (Get-Sha $c.canonical) $op.NewSha "$point canonical already committed"
    Assert-True (-not [IO.File]::Exists($c.outbox)) "$point no outbox yet"
    if($point -ceq 'BEFORE_ENQUEUE'){Assert-Eq (Read-Status $op).phase 'PENDING_ENQUEUE' 'explicit phase'}
    $r=Invoke-Commit $op
    Assert-Eq $r.status 'ENQUEUED' "$point resume"; Assert-Eq (Get-Sha $c.canonical) $op.NewSha "$point canonical unchanged by resume"; Assert-EnqueuedRows $op 2
  }
  # A changed admission (different identity) cannot adopt the committed state.
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'BEFORE_ENQUEUE')
  $alt=Join-Path $c.dir 'admission-alt.json'; $ad=[ordered]@{}; foreach($k in $op.Adm.Keys){$ad[$k]=$op.Adm[$k]}; $ad['reviewer']='another-reviewer'
  Write-Json $alt $ad
  $op2=@{C=$c;OpId=$op.OpId;OpDir=$op.OpDir;NewPath=$op.NewPath;NewSha=$op.NewSha;Idem=$op.Idem;A=@{RequestPath=$op.A.RequestPath;ExpectedRequestSha256=$op.A.ExpectedRequestSha256;AdmissionPath=$alt;ExpectedAdmissionSha256=(Get-Sha $alt)}}
  $r=Invoke-Commit $op2
  Assert-Eq $r.status 'REFUSED' 'changed admission status'; Assert-Eq $r.code 'INTENT_MISMATCH' 'changed admission code'
  Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'bytes preserved'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox from rejected identity'
}

Test-Step 'Crash after enqueue before final mark resumes with zero duplicates and the same result as an uninterrupted run' {
  $c0=New-Case; Write-Outbox $c0 @((New-UnrelatedRow)); $op0=New-Op $c0
  $control=Invoke-Commit $op0
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $op=New-Op $c; $rawBefore=Read-RawRows $c.outbox
  $f=Invoke-WithFault $op 'AFTER_ENQUEUE'
  Assert-True $f.crashed 'crashed'; Assert-Eq (Read-Status $op).phase 'PENDING_ENQUEUE' 'status not yet final'
  Assert-EnqueuedRows $op 3
  $crashSha=Get-Sha $c.outbox
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'ENQUEUED' 'resume'; Assert-Eq (Get-Sha $c.outbox) $crashSha 'resume added nothing'
  Assert-EnqueuedRows $op 3
  Assert-Eq (ConvertTo-Json -InputObject $r -Compress) (ConvertTo-Json -InputObject $control -Compress) 'same result as uninterrupted run'
  Assert-Eq (ConvertTo-Json -InputObject (Read-RawRows $c.outbox)[0] -Depth 10 -Compress) (ConvertTo-Json -InputObject $rawBefore[0] -Depth 10 -Compress) 'unrelated row retained'
  Assert-Eq (Read-Status $op).phase 'ENQUEUED' 'final mark'
}

Test-Step 'Initially invalid outbox refuses before any effect; postcommit drift reports CONFLICT without rollback' {
  # Malformed outbox with a matching pin.
  $c=New-Case; Write-Text $c.outbox '{not json'; $bad=Get-Sha $c.outbox; $op=New-Op $c
  Assert-PreEffectRefusal $op 'OUTBOX_INVALID' $bad 'malformed outbox'
  # Known NO_RETRY row of this very event.
  $c=New-Case; $probe=New-Op $c -OpId 'probe'; $ex=Get-Expect $probe
  Write-Outbox $c @((New-UnrelatedRow),(New-Row 'SYNTH-TASK-1' $ex.digest ('synth-idem-8:github') 'github' -Extra @{retryPolicy='NO_RETRY'}))
  $nr=Get-Sha $c.outbox; $op=New-Op $c
  Assert-PreEffectRefusal $op 'EXCLUDED_NO_RETRY' $nr 'no-retry'
  # Conflicting own target row (same runId, different payload).
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow),(New-Row 'SYNTH-TASK-1' ('c'*64) ('synth-idem-8:note') 'note'))
  $cf=Get-Sha $c.outbox; $op=New-Op $c
  Assert-PreEffectRefusal $op 'EVENT_CONFLICT' $cf 'conflicting own row'
  # Admitted outbox changed after the intent but before the commit starts: refused at the CAS boundary.
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $op=New-Op $c
  $f=Invoke-WithFault $op 'AFTER_INTENT'; Assert-True $f.crashed 'crashed after intent'
  Write-Outbox $c @((New-UnrelatedRow),(New-Row 'SYNTH-OTHER-2' ('b'*64) 'synth-other-run-2' 'note')); $late=Get-Sha $c.outbox
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'REFUSED' 'late drift status'; Assert-Eq $r.code 'OUTBOX_DRIFT' 'late drift code'; Assert-True (-not $r.canonicalCommitted) 'late drift not committed'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'late drift canonical untouched'; Assert-Eq (Get-Sha $c.outbox) $late 'late drift outbox preserved'
  # Unrelated drift between canonical commit and enqueue.
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $op=New-Op $c
  [void](Invoke-WithFault $op 'BEFORE_ENQUEUE')
  $other=New-Row 'SYNTH-OTHER-2' ('b'*64) 'synth-other-run-2' 'note'
  Write-Outbox $c @((New-UnrelatedRow),$other); $drift=Get-Sha $c.outbox
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'CONFLICT' 'drift status'; Assert-Eq $r.code 'OUTBOX_DRIFT' 'drift code'
  Assert-Eq (Get-Sha $c.outbox) $drift 'drifted outbox bytes preserved'; Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'canonical not rolled back'
  # Own rows plus an extra unrelated row is still drift.
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'AFTER_ENQUEUE')
  $rows=@(Read-Outbox $c.outbox); Write-Outbox $c @($rows+@($other)); $drift=Get-Sha $c.outbox
  Assert-Eq (Invoke-Commit $op).code 'OUTBOX_DRIFT' 'own rows plus unrelated row'; Assert-Eq (Get-Sha $c.outbox) $drift 'bytes preserved'
}

Test-Step 'A concurrently newer canonical is preserved: CONFLICT, no rollback, no stale enqueue' {
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'BEFORE_ENQUEUE')
  Write-Json $c.canonical ([ordered]@{taskId='SYNTH-TASK-1';canonicalRevision=9;publicTitle='Synthetic fixture title';publicSummary='Newer synthetic state.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})
  $newer=Get-Sha $c.canonical
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'CONFLICT' 'status'; Assert-Eq $r.code 'CANONICAL_CONFLICT' 'code'
  Assert-Eq (Get-Sha $c.canonical) $newer 'newer bytes preserved'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no stale enqueue'
  # Exact-after without a started commit is not adoptable.
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'AFTER_INTENT')
  Copy-Item -LiteralPath $op.NewPath -Destination $c.canonical -Force
  $r=Invoke-Commit $op
  Assert-Eq $r.code 'AFTER_NOT_OWNED' 'foreign exact-after refused'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no enqueue'
}

Test-Step 'Canonical, publisher and operation lock contention are explicit and recoverable' {
  $c=New-Case; $op=New-Op $c
  $h=[IO.File]::Open($c.canonical+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $op } finally { $h.Dispose() }
  Assert-Eq $r.status 'REFUSED' 'status'; Assert-Eq $r.code 'CANONICAL_LOCKED' 'code'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'canonical untouched'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox'
  Assert-Eq (Invoke-Commit $op).status 'ENQUEUED' 'after release'
  $c=New-Case; $op=New-Op $c
  $h=[IO.File]::Open((Join-Path $c.state 'publisher.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $op } finally { $h.Dispose() }
  Assert-Eq $r.status 'PENDING_ENQUEUE' 'pending status'; Assert-Eq $r.code 'PUBLISHER_LOCKED' 'pending code'
  Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'canonical committed'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox'
  Assert-Eq (Read-Status $op).cause 'PUBLISHER_LOCKED' 'cause recorded'
  Assert-Eq (Invoke-Commit $op).status 'ENQUEUED' 'resume after release'; Assert-EnqueuedRows $op 2
  $c=New-Case; $op=New-Op $c; [void][IO.Directory]::CreateDirectory($op.OpDir)
  $h=[IO.File]::Open((Join-Path $op.OpDir 'operation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $op } finally { $h.Dispose() }
  Assert-Eq $r.code 'OPERATION_LOCKED' 'operation lock'; Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'canonical untouched'
}

Test-Step 'Two different intents racing from the same before in separate processes yield exactly one commit and one enqueue' {
  $c=New-Case
  $a=New-Op $c -OpId 'opA' -Idem 'synth-idem-8a' -Summary 'Synthetic summary from intent A only.'
  $b=New-Op $c -OpId 'opB' -Idem 'synth-idem-8b' -Summary 'Synthetic summary from intent B only.'
  $pwsh=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $procs=@(); $outs=@()
  foreach($op in @($a,$b)){
    $out=Join-Path $c.dir ("child-$($op.OpId).json"); $outs+=$out
    $argList=@('-NoProfile','-File',$PSCommandPath,'-SourcePath',$SourceRoot,'-EvidenceRoot',$Ev,'-ChildRequestPath',$op.A.RequestPath,'-ChildRequestSha256',$op.A.ExpectedRequestSha256,'-ChildAdmissionPath',$op.A.AdmissionPath,'-ChildAdmissionSha256',$op.A.ExpectedAdmissionSha256,'-ChildResultPath',$out)
    $procs+=Start-Process -FilePath $pwsh -ArgumentList $argList -PassThru -NoNewWindow
  }
  foreach($p in $procs){$p.WaitForExit(); Assert-Eq $p.ExitCode 0 'child exit'}
  $final=@{}
  for($i=0;$i -lt 2;$i++){
    $op=@($a,$b)[$i]; $r=Get-Content -LiteralPath $outs[$i] -Raw | ConvertFrom-Json
    # Transient outcomes are resumed with the SAME intent (no auto-retry exists in the module).
    for($n=0;$n -lt 6 -and ($r.status -ceq 'PENDING_ENQUEUE' -or ($r.status -ceq 'REFUSED' -and $r.code -cin @('CANONICAL_LOCKED','OPERATION_LOCKED','UNCLASSIFIED_ERROR')));$n++){$r=Invoke-Commit $op}
    $final[$op.OpId]=$r
  }
  $winners=@($final.Keys | Where-Object {$final[$_].status -ceq 'ENQUEUED'})
  $losers=@($final.Keys | Where-Object {$final[$_].status -cne 'ENQUEUED'})
  Assert-Eq $winners.Count 1 'exactly one winner'; Assert-Eq $losers.Count 1 'exactly one loser'
  # The loser either lost the CAS under the lock (CONFLICT) or saw the winner's bytes before any effect.
  $l=$final[$losers[0]]
  Assert-True (($l.status -ceq 'CONFLICT') -or ($l.status -ceq 'REFUSED' -and $l.code -ceq 'CANONICAL_DRIFT')) "loser outcome $($l.status)/$($l.code)"
  $win=$(if($winners[0] -ceq 'opA'){$a}else{$b})
  Assert-Eq (Get-Sha $c.canonical) $win.NewSha 'canonical is the winner bytes'
  Assert-EnqueuedRows $win 2
  Assert-Eq @(Read-Outbox $c.outbox).Count 2 'no loser rows'
}

Test-Step 'Persisted intent stays within the reader cap: over-limit aggregate refuses before effects; at-limit intent persists and resumes' {
  # Each canonical file is individually admissible (< 1048576 bytes, JSON padded with spaces) but the
  # base64 intent aggregate need not be. Sizes below are actual UTF-8 byte lengths of the files.
  $limit=1048576
  $b64={ param([long]$n) 4*[long][math]::Ceiling($n/3) }
  $padNew=300000
  $c=New-Case
  # Calibrate the fixed intent overhead (paths, hashes, keys, envelope) with a crash-persisted intent.
  Set-JsonFileSize $c.canonical 300000; $c.oldSha=Get-Sha $c.canonical
  $cal=New-Op $c -OpId 'cal' -NewSize $padNew
  $f=Invoke-WithFault $cal 'AFTER_INTENT'; Assert-True $f.crashed 'calibration crashed after intent'
  $calIntent=[IO.FileInfo]::new((Join-Path $cal.OpDir 'intent.json')).Length
  $newLen=[IO.FileInfo]::new($cal.NewPath).Length
  $overhead=$calIntent-(& $b64 ([IO.FileInfo]::new($c.canonical).Length))-(& $b64 $newLen)
  $room=$limit-$overhead-(& $b64 $newLen)
  $okOld=3*(($room-($room % 4))/4)
  Assert-True ($okOld -gt 0 -and $okOld -lt $limit -and $newLen -lt $limit) 'each input is individually within the reader cap'
  # One base64 quantum over the cap: refused deterministically before any owned effect.
  Set-JsonFileSize $c.canonical ($okOld+3); $c.oldSha=Get-Sha $c.canonical
  $ovr=New-Op $c -OpId 'ovr' -NewSize $padNew
  $r=Invoke-Commit $ovr
  Assert-Eq $r.status 'REFUSED' 'over-limit status'; Assert-Eq $r.code 'INTENT_TOO_LARGE' 'over-limit code'; Assert-True (-not $r.canonicalCommitted) 'over-limit not committed'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'over-limit canonical bytes'
  Assert-True (-not [IO.Directory]::Exists($ovr.OpDir)) 'over-limit no operation directory'
  Assert-True (-not [IO.File]::Exists($c.canonical+'.lock')) 'over-limit no canonical lease'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'over-limit no outbox'
  # Largest supported aggregate: persisted intent is at most the cap and is re-read on same-intent resume.
  Set-JsonFileSize $c.canonical $okOld; $c.oldSha=Get-Sha $c.canonical
  $bnd=New-Op $c -OpId 'bnd' -NewSize $padNew
  $f=Invoke-WithFault $bnd 'AFTER_INTENT'; Assert-True $f.crashed 'boundary crashed after intent'
  $len=[IO.FileInfo]::new((Join-Path $bnd.OpDir 'intent.json')).Length
  Assert-True ($len -le $limit -and $len -gt $limit-4) "boundary intent is at the cap ($len bytes)"
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'boundary canonical untouched before resume'
  $r=Invoke-Commit $bnd
  Assert-Eq $r.status 'ENQUEUED' 'boundary resume status'; Assert-Eq (Get-Sha $c.canonical) $bnd.NewSha 'boundary committed once'; Assert-EnqueuedRows $bnd 2
  $again=Invoke-Commit $bnd
  Assert-Eq (ConvertTo-Json -InputObject $again -Compress) (ConvertTo-Json -InputObject $r -Compress) 'boundary replay returns the same result'
}

Test-Step 'No execution, delivery or acknowledgement surface; dependencies unchanged; fixtures stay under EvidenceRoot' {
  foreach($f in $DepFiles){Assert-Eq (Get-Sha $f) $DepBefore[$f] "unchanged $f"}
  $src=[IO.File]::ReadAllText($CommitFile)
  foreach($bad in @('Start-Process','Invoke-WebRequest','Invoke-RestMethod','Invoke-Expression','Invoke-AdmittedTaskLifecycleUpdate','New-GitHubCliLifecycleTransport216','ConvertTo-SecureString','Write-OutboxAtomic')){
    Assert-True (-not $src.Contains($bad)) "commit source does not reference $bad"
  }
  Assert-True ($src -cnotmatch "deliveryStatus\s*=\s*'DELIVERED'") 'no row is marked DELIVERED'
  foreach($case in 1..$script:CaseN){
    $dir=Join-Path $Ev "case$case"
    foreach($child in @(Get-ChildItem -LiteralPath $dir -Force -Recurse | ForEach-Object {$_.FullName})){
      Assert-True ($child.StartsWith($Ev+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal)) 'fixtures stay under EvidenceRoot'
    }
  }
}

$failed=@($Results | Where-Object {-not $_.ok})
Write-Json (Join-Path $Ev 'results.json') @($Results)
Write-Host ("canonical-lifecycle-update-commit: {0} passed, {1} failed (synthetic offline fixtures; not publication proof)" -f ($Results.Count-$failed.Count),$failed.Count)
if($failed.Count -gt 0){exit 1}
