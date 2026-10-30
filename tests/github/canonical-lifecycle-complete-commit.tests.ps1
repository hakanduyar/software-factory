#Requires -Version 7.6
# SYNTHETIC OFFLINE FIXTURES ONLY - NOT REAL PROOF. Every task, canonical file, packet, completion
# proof, review/delivery receipt, admission and outbox row below is invented for this test and lives
# under EvidenceRoot. Passing it is not publication, destination delivery, host admission, a real
# delivery receipt or proof of any live installation; it exercises the explicit canonical COMPLETE
# commit -> durable enqueue boundary with the real accepted COMPLETE enqueue/consumer/compat reader.
# No network, gh, credentials or provider/model call. Child pwsh processes are started only for the
# concurrent same-before test and only re-run this file in child mode.
param(
  [string]$SourcePath,[string]$EvidenceRoot,
  [string]$ChildRequestPath,[string]$ChildRequestSha256,[string]$ChildAdmissionPath,[string]$ChildAdmissionSha256,[string]$ChildResultPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

if(-not $SourcePath){$SourcePath=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)}
if(-not $EvidenceRoot){$EvidenceRoot=Join-Path ([IO.Path]::GetTempPath()) ('complete-commit-'+[guid]::NewGuid().ToString('N'))}
$SourceRoot=[IO.Path]::GetFullPath($SourcePath).TrimEnd('\','/')
$Ev=[IO.Path]::GetFullPath($EvidenceRoot).TrimEnd('\','/')
function Get-SourceFile { param([string]$Relative) [IO.Path]::GetFullPath((Join-Path $SourceRoot $Relative)) }
$CommitFile=Get-SourceFile 'scripts/github/commit-canonical-lifecycle-complete.ps1'
$EnqueueFile=Get-SourceFile 'scripts/github/enqueue-canonical-lifecycle-complete.ps1'
$ConsumerFile=Get-SourceFile 'scripts/github/task-lifecycle-mirror-consumer.ps1'
$ReconcileFile=Get-SourceFile 'scripts/github/lifecycle-compat/continuity/reconcile.ps1'
$CaptureFile=Get-SourceFile 'scripts/github/lifecycle-compat/dispatch/reviewed-blocked-capture.ps1'

. $CommitFile
if($ChildResultPath){
  $childResult=Invoke-CanonicalLifecycleCompleteCommit -RequestPath $ChildRequestPath -ExpectedRequestSha256 $ChildRequestSha256 -AdmissionPath $ChildAdmissionPath -ExpectedAdmissionSha256 $ChildAdmissionSha256
  [IO.File]::WriteAllText($ChildResultPath,(ConvertTo-Json -InputObject $childResult -Depth 6 -Compress),[Text.UTF8Encoding]::new($false))
  exit 0
}

if([IO.Directory]::Exists($Ev) -and @(Get-ChildItem -LiteralPath $Ev -Force).Count -gt 0){throw 'EvidenceRoot must be fresh and empty'}
[void][IO.Directory]::CreateDirectory($Ev)

function Get-Sha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
function Get-TextSha { param([string]$Text) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant() }
$DepFiles=@($CommitFile,$EnqueueFile,$ConsumerFile,$ReconcileFile,$CaptureFile)
$DepBefore=@{}; foreach($f in $DepFiles){$DepBefore[$f]=Get-Sha $f}

# The existing consumer/reconcile are the independent oracle (reader, row writer).
. $ConsumerFile
. $ReconcileFile

function Write-Text { param([string]$Path,[string]$Text) [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false)) }
function Write-Json { param([string]$Path,$Obj) Write-Text $Path (ConvertTo-Json -InputObject $Obj -Depth 6) }
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

$Task='SYNTH-TASK-67'; $Candidate=('1a2b3c4d5e'*4); $MergeSha=('9f8e7d6c5b'*4)
$NewTitle='Synthetic canonical complete commit'; $NewSummary='Accepted scoped work is ready for mirror delivery'

function New-Row {
  param($TaskId,$Digest,$RunId,$Dest,$Status='AWAITING_CONTROLLER',$Attempt=0,$Delivery='PENDING',$Proof=$null,[hashtable]$Extra=@{})
  $key=Get-EventKey -TaskId $TaskId -PayloadSha256 $Digest -RunId $RunId -Status $Status -Attempt $Attempt
  $o=[ordered]@{key=$key;taskId=$TaskId;payloadSha256=$Digest;runId=$RunId;destination=$Dest;status=$Status;attempt=$Attempt;deliveryStatus=$Delivery;proof=$Proof}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function Get-UnrelatedRows {
  @(
    (New-Row -TaskId 'SYNTH-OLD-1' -Digest ('a'*64) -RunId 'synth-old-run-1' -Dest 'github' -Extra @{updatedAt='2026-01-01T10:00:00.123Z'}),
    (New-Row -TaskId 'SYNTH-OLD-2' -Digest ('b'*64) -RunId 'synth-old-run-2' -Dest 'note' -Status 'COMPLETED' -Attempt 1 -Delivery 'DELIVERED' -Proof 'readback:synthetic'),
    (New-Row -TaskId 'SYNTH-OLD-3' -Digest ('c'*64) -RunId 'synth-old-run-3' -Dest 'github' -Status 'FAILED' -Attempt 2 -Extra @{retryPolicy='NO_RETRY';synthNote='keep-me'})
  )
}
function Write-Outbox { param($C,[object[]]$Rows) Write-OutboxAtomic $C.outbox $Rows }
function New-Case {
  param([object[]]$Rows=(Get-UnrelatedRows))
  $script:CaseN++
  $dir=Join-Path $Ev ('case'+$script:CaseN); $state=Join-Path $dir 'state'
  [void][IO.Directory]::CreateDirectory($state)
  $c=@{dir=$dir;state=$state;outbox=(Join-Path $state 'outbox.json');canonical=(Join-Path $dir 'canonical.json')}
  Write-Json $c.canonical ([ordered]@{taskId=$Task;canonicalRevision=2;publicTitle='Synthetic work in progress';publicSummary='Synthetic work continues';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})
  $c.oldSha=Get-Sha $c.canonical
  Write-Outbox $c $Rows
  $c.outboxSha=Get-Sha $c.outbox
  return $c
}
$script:CaseN=0

# Request + independent admission for one operation (and the synthetic, NOT REAL proof chain).
function New-Op {
  param($C,[string]$OpId='op1',[hashtable]$New=@{},[hashtable]$Pkt=@{},[hashtable]$Req=@{},[hashtable]$Adm=@{},[hashtable]$Review=@{},[hashtable]$Delivery=@{},[hashtable]$Proof=@{},
        [string]$Idem='synth-idem-67',[string]$Summary=$NewSummary,[int]$NewSize=0)
  $n=[ordered]@{taskId=$Task;canonicalRevision=3;publicTitle=$NewTitle;publicSummary=$Summary;publicStatus='ACCEPTED_SCOPED';nextAction='NONE'}
  foreach($k in $New.Keys){$n[$k]=$New[$k]}
  $pk=[ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId=$Task;canonicalRevision=3;eventType='COMPLETE';idempotencyKey=$Idem;publicTitle=$NewTitle;publicSummary=$Summary;publicStatus='ACCEPTED_SCOPED';nextAction='NONE';destinations=@('github','note')}
  foreach($k in $Pkt.Keys){$pk[$k]=$Pkt[$k]}
  $p=@{}; foreach($k in @('new','packet','request','admission','review','delivery','proof')){$p[$k]=Join-Path $C.dir "$k-$OpId.json"}
  Write-Json $p.new $n; Write-Json $p.packet $pk
  if($NewSize -gt 0){Set-JsonFileSize $p.new $NewSize}
  $rv=[ordered]@{schema='IndependentComponentReview/v1';decision='ACCEPT_SCOPED_SOURCE';commit=$Candidate}
  foreach($k in $Review.Keys){$rv[$k]=$Review[$k]}
  Write-Json $p.review $rv
  $dv=[ordered]@{schema='IndependentDeliveryReceipt/v1';head=$Candidate;merge=$MergeSha;pr='https://github.com/hakanduyar/software-factory/pull/67';requiredChecks='ALL_SUCCESS';normalTypecheck='PASS';normalBuild='PASS';checks=5;focusedTests=12;sourceReviewSha256=(Get-Sha $p.review)}
  foreach($k in $Delivery.Keys){$dv[$k]=$Delivery[$k]}
  Write-Json $p.delivery $dv
  $pf=[ordered]@{schema='LifecycleCompletionProof/v1';taskId=$Task;canonicalRevision=3;candidateCommit=$Candidate;minimumFocusedTests=3
    sourceReview=[ordered]@{path=$p.review;sha256=(Get-Sha $p.review)};delivery=[ordered]@{path=$p.delivery;sha256=(Get-Sha $p.delivery)}}
  foreach($k in $Proof.Keys){$pf[$k]=$Proof[$k]}
  Write-Json $p.proof $pf
  $ref={ param($f) [ordered]@{path=$f;sha256=(Get-Sha $f)} }
  $opDir=Join-Path $C.state ('canonical-complete-'+$OpId)
  $rq=[ordered]@{schema='CanonicalLifecycleCompleteCommitRequest/v1';operationId=$OpId;taskId=$Task;canonicalPath=$C.canonical;expectedBeforeSha256=(Get-Sha $C.canonical)
    newCanonicalRef=(& $ref $p.new);packetRef=(& $ref $p.packet);completionProofRef=(& $ref $p.proof);candidateCommit=$Candidate
    enqueueRef=(& $ref $EnqueueFile);consumerRef=(& $ref $ConsumerFile);reconcileRef=(& $ref $ReconcileFile);captureRef=(& $ref $CaptureFile)
    stateDir=$C.state;outboxPath=$C.outbox;expectedOutboxSha256=(Get-Sha $C.outbox);operationDirectory=$opDir}
  foreach($k in $Req.Keys){$rq[$k]=$Req[$k]}
  Write-Json $p.request $rq
  $ad=[ordered]@{schema='CanonicalLifecycleCompleteCommitAdmission/v1';decision='ADMIT_CANONICAL_COMPLETE_COMMIT';reviewer='synthetic-independent-reviewer';requestSha256=(Get-Sha $p.request);operationId=$OpId;taskId=$Task
    beforeSha256=(Get-Sha $C.canonical);afterSha256=(Get-Sha $p.new);packetSha256=(Get-Sha $p.packet);completionProofSha256=(Get-Sha $p.proof);candidateCommit=$Candidate
    enqueueSha256=(Get-Sha $EnqueueFile);consumerSha256=(Get-Sha $ConsumerFile);reconcileSha256=(Get-Sha $ReconcileFile);captureSha256=(Get-Sha $CaptureFile)}
  foreach($k in $Adm.Keys){$ad[$k]=$Adm[$k]}
  Write-Json $p.admission $ad
  return @{C=$C;OpId=$OpId;OpDir=$opDir;P=$p;NewSha=(Get-Sha $p.new);Idem=$Idem;NewObj=$n
    A=@{RequestPath=$p.request;ExpectedRequestSha256=(Get-Sha $p.request);AdmissionPath=$p.admission;ExpectedAdmissionSha256=(Get-Sha $p.admission)}}
}
function Invoke-Commit { param($Op) $a=$Op.A; Invoke-CanonicalLifecycleCompleteCommit @a }
function Get-Expect {
  # Independent of the code under test: the consumer digest is the SHA-256 of the compact canonical text.
  param($Op)
  $digest=Get-TextSha ($Op.NewObj | ConvertTo-Json -Compress)
  $e=@{digest=$digest}
  foreach($d in @('github','note')){$e[$d]=(@($Task,$digest,($Op.Idem+':complete:'+$d),'AWAITING_CONTROLLER','0') -join ':')}
  return $e
}
function Assert-NoEffects {
  param($Op,[string]$Msg)
  Assert-Eq (Get-Sha $Op.C.canonical) $Op.C.oldSha "$Msg canonical bytes"
  Assert-Eq (Get-Sha $Op.C.outbox) $Op.C.outboxSha "$Msg outbox bytes"
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
    Assert-Eq $m[0].runId ($Op.Idem+':complete:'+$d) "$d runId"; Assert-Eq $m[0].payloadSha256 $ex.digest "$d digest"
    Assert-Eq $m[0].status 'AWAITING_CONTROLLER' "$d status"; Assert-Eq $m[0].attempt 0 "$d attempt"
  }
}

# Test-only seam: a global alias outranks the module's no-op Invoke-CxFaultPoint. CRASH simulates a
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
  Set-Alias -Name Invoke-CxFaultPoint -Value Invoke-TestFault -Scope Global
  $out=$null; $crashed=$false
  try{ $out=Invoke-Commit $Op }
  catch{ if($_.Exception.Message -clike 'SIMULATED_CRASH:*'){$crashed=$true}else{throw} }
  finally{ Remove-Item -Path 'Alias:\Invoke-CxFaultPoint' -Force -ErrorAction SilentlyContinue; $script:FaultPoint=$null }
  Assert-True ($null -eq (Get-Alias -Name Invoke-CxFaultPoint -ErrorAction SilentlyContinue)) 'fault alias removed'
  return @{result=$out;crashed=$crashed}
}

# Static command-AST inspection only (never executes the text): true when a command is named gh/gh.exe.
# Comments and string literals are not commands. Unparseable text is refused.
function Test-GhInvocation {
  param([string]$Text)
  $tokens=$null; $errs=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($Text,[ref]$tokens,[ref]$errs)
  if($errs.Count -gt 0){throw 'ASSERT: source does not parse'}
  $cmds=$ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)
  foreach($cm in $cmds){
    $name=$cm.GetCommandName()
    if($null -ne $name){
      $leaf=[IO.Path]::GetFileName($name)
      if($leaf -ieq 'gh' -or $leaf -ieq 'gh.exe'){return $true}
    }
  }
  return $false
}

$Results=[System.Collections.Generic.List[object]]::new()
function Test-Step {
  param([string]$Name,[scriptblock]$Body)
  try{ & $Body; $Results.Add([pscustomobject]@{name=$Name;ok=$true;error=''}); Write-Host "PASS $Name" }
  catch{ $Results.Add([pscustomobject]@{name=$Name;ok=$false;error=$_.Exception.Message}); Write-Host "FAIL $Name :: $($_.Exception.Message)" }
}

Test-Step 'Valid full proof commits the exact bytes, enqueues two PENDING rows without lease deadlock, retains unrelated rows, and is replay stable' {
  $c=New-Case; $rawBefore=Read-RawRows $c.outbox
  $op=New-Op $c
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'ENQUEUED' "status ($($r.code))"; Assert-Eq $r.code 'ENQUEUED_VERIFIED' 'code'; Assert-True $r.canonicalCommitted 'committed'
  Assert-Eq $r.publication 'NOT_ATTEMPTED' 'no publication attempted'
  Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'canonical is exactly the supplied bytes'
  Assert-EnqueuedRows $op 5
  $ex=Get-Expect $op; Assert-Eq ($r.keys -join '|') ($ex.github+'|'+$ex.note) 'result keys github then note'
  $rawAfter=Read-RawRows $c.outbox
  for($i=0;$i -lt 3;$i++){Assert-Eq (ConvertTo-Json -InputObject $rawAfter[$i] -Depth 10 -Compress) (ConvertTo-Json -InputObject $rawBefore[$i] -Depth 10 -Compress) "unrelated row $i retained"}
  Assert-True ([IO.File]::ReadAllText($c.outbox).Contains('2026-01-01T10:00:00.123Z')) 'unrelated date text not reformatted'
  Assert-Eq (@($rawAfter[3].PSObject.Properties.Name) -join ',') 'key,taskId,payloadSha256,runId,destination,status,attempt,deliveryStatus,proof' 'row key format and order'
  Assert-Eq (Read-Status $op).phase 'ENQUEUED' 'phase'
  Assert-True ([IO.File]::Exists((Join-Path $op.OpDir 'intent.json'))) 'intent persisted'
  foreach($f in @('intent.json','status.json')){$t=[IO.File]::ReadAllText((Join-Path $op.OpDir $f)); Assert-True (-not $t.Contains('"DONE"') -and -not $t.Contains('ACK') -and -not $t.Contains('"DELIVERED"')) "$f has no DONE/ACK/DELIVERED claim"}
  foreach($l in @(($c.canonical+'.lock'),(Join-Path $c.state 'publisher.lock'),(Join-Path $op.OpDir 'operation.lock'))){$h=[IO.File]::Open($l,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $h.Dispose()}
  $outSha=Get-Sha $c.outbox; $intentSha=Get-Sha (Join-Path $op.OpDir 'intent.json')
  $again=Invoke-Commit $op
  Assert-Eq (ConvertTo-Json -InputObject $again -Compress) (ConvertTo-Json -InputObject $r -Compress) 'replay returns the same result'
  Assert-Eq (Get-Sha $c.outbox) $outSha 'outbox byte stable (zero duplicates)'; Assert-Eq (Get-Sha $c.canonical) $op.NewSha 'canonical byte stable'
  Assert-Eq (Get-Sha (Join-Path $op.OpDir 'intent.json')) $intentSha 'intent byte stable'
  Assert-EnqueuedRows $op 5
}

Test-Step 'Invalid, missing or mis-bound request/admission/closure/content/proof refuse before any effect' {
  $variants=[ordered]@{
    'missing admission file'=@{code='FILE_MISSING';make={param($c) $o=New-Op $c; Remove-Item -LiteralPath $o.A.AdmissionPath; $o}}
    'wrong admission pin'=@{code='ADMISSION_DRIFT';make={param($c) $o=New-Op $c; $o.A.ExpectedAdmissionSha256='0'*64; $o}}
    'wrong decision'=@{code='ADMISSION_INVALID';make={param($c) New-Op $c -Adm @{decision='APPROVED'}}}
    'boolean approval shortcut'=@{code='FIELDS_INVALID';make={param($c) New-Op $c -Adm @{approved=$true}}}
    'admission wrong task'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{taskId='OTHER-TASK'}}}
    'admission wrong before'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{beforeSha256=('1'*64)}}}
    'admission wrong after'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{afterSha256=('1'*64)}}}
    'admission wrong packet'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{packetSha256=('1'*64)}}}
    'admission wrong proof'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{completionProofSha256=('1'*64)}}}
    'admission wrong candidate'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{candidateCommit=('3'*40)}}}
    'admission wrong closure'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{enqueueSha256=('1'*64)}}}
    'admission wrong request'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{requestSha256=('1'*64)}}}
    'request wrong schema'=@{code='REQUEST_INVALID';make={param($c) New-Op $c -Req @{schema='CanonicalLifecycleCompleteCommitRequest/v2'}}}
    'request extra field'=@{code='FIELDS_INVALID';make={param($c) New-Op $c -Req @{extra='x'}}}
    'request null outbox pin (no auto-empty)'=@{code='REQUEST_INVALID';make={param($c) New-Op $c -Req @{expectedOutboxSha256=$null}}}
    'request malformed outbox pin'=@{code='REQUEST_INVALID';make={param($c) New-Op $c -Req @{expectedOutboxSha256='ABC'}}}
    'request zero candidate'=@{code='CANDIDATE_INVALID';make={param($c) New-Op $c -Req @{candidateCommit=('0'*40)} -Adm @{candidateCommit=('0'*40)}}}
    'request short candidate'=@{code='CANDIDATE_INVALID';make={param($c) New-Op $c -Req @{candidateCommit='abc'} -Adm @{candidateCommit=('3'*40)}}}
    'candidate differs from proof'=@{code='CANDIDATE_MISMATCH';make={param($c) New-Op $c -Req @{candidateCommit=('3'*40)} -Adm @{candidateCommit=('3'*40)}}}
    'new revision equal'=@{code='REVISION_NOT_INCREASING';make={param($c) New-Op $c -New @{canonicalRevision=2} -Pkt @{canonicalRevision=2}}}
    'new revision lower'=@{code='REVISION_NOT_INCREASING';make={param($c) New-Op $c -New @{canonicalRevision=1} -Pkt @{canonicalRevision=1}}}
    'new revision wrong type'=@{code='REVISION_INVALID';make={param($c) New-Op $c -New @{canonicalRevision='3'}}}
    'new canonical extra field'=@{code='FIELDS_INVALID';make={param($c) New-Op $c -New @{extra='x'}}}
    'new canonical wrong task'=@{code='TASK_MISMATCH';make={param($c) New-Op $c -New @{taskId='OTHER-TASK'}}}
    'packet differs from new bytes'=@{code='CANONICAL_PACKET_MISMATCH';make={param($c) New-Op $c -Pkt @{publicTitle='Different synthetic title'}}}
    'packet is UPDATE'=@{code='UNSUPPORTED_EVENT';make={param($c) New-Op $c -Pkt @{eventType='UPDATE';nextAction='RUN_FOCUSED_CHECKS'}}}
    'packet not accepted scoped'=@{code='UNSUPPORTED_EVENT';make={param($c) New-Op $c -New @{publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'} -Pkt @{publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}}}
    'packet other task'=@{code='TASK_MISMATCH';make={param($c) New-Op $c -Pkt @{taskId='OTHER-TASK'}}}
    'unsupported public status'=@{code=$null;make={param($c) New-Op $c -New @{publicStatus='DONE'} -Pkt @{publicStatus='DONE'}}}
    'failed delivery checks'=@{code='RECEIPT_INVALID';make={param($c) New-Op $c -Delivery @{requiredChecks='FAILED'}}}
    'delivery head differs from candidate'=@{code='PROOF_MISMATCH';make={param($c) New-Op $c -Delivery @{head=('2'*40)}}}
    'review commit differs from candidate'=@{code='PROOF_MISMATCH';make={param($c) New-Op $c -Review @{commit=('2'*40)}}}
    'coerced string check count'=@{code='RECEIPT_INVALID';make={param($c) New-Op $c -Delivery @{checks='5'}}}
    'too few focused tests'=@{code='PROOF_TESTS_INSUFFICIENT';make={param($c) New-Op $c -Delivery @{focusedTests=1}}}
    'unsupported review receipt schema'=@{code='RECEIPT_UNSUPPORTED';make={param($c) New-Op $c -Review @{schema='Other/v1'}}}
    'proof bound to another task'=@{code='PROOF_BINDING';make={param($c) New-Op $c -Proof @{taskId='OTHER-TASK'}}}
    'proof bound to another revision'=@{code=$null;make={param($c) New-Op $c -Proof @{canonicalRevision=4}}}
    'proof extra field'=@{code=$null;make={param($c) New-Op $c -Proof @{extra='x'}}}
    'proof pin in request is stale'=@{code='COMPLETION_PROOF_DRIFT';make={param($c) $o=New-Op $c; $r=Read-LifecycleJson $o.P.request; $r.completionProofRef.sha256='0'*64; Write-Json $o.P.request $r; $a=Read-LifecycleJson $o.P.admission; $a.completionProofSha256='0'*64; $a.requestSha256=Get-Sha $o.P.request; Write-Json $o.P.admission $a; $o.A.ExpectedRequestSha256=Get-Sha $o.P.request; $o.A.ExpectedAdmissionSha256=Get-Sha $o.P.admission; $o}}
    'nested receipt drifted after pinning'=@{code=$null;make={param($c) $o=New-Op $c; [IO.File]::AppendAllText($o.P.delivery,' '); $o}}
    'consumer pin drift'=@{code='CONSUMER_DRIFT';make={param($c) $o=New-Op $c; $r=Read-LifecycleJson $o.P.request; $r.consumerRef.sha256='0'*64; Write-Json $o.P.request $r; $o.A.ExpectedRequestSha256=Get-Sha $o.P.request; $o}}
    'reconcile pin drift'=@{code='RECONCILE_DRIFT';make={param($c) $o=New-Op $c; $r=Read-LifecycleJson $o.P.request; $r.reconcileRef.sha256='0'*64; Write-Json $o.P.request $r; $o.A.ExpectedRequestSha256=Get-Sha $o.P.request; $o}}
    'capture pin drift'=@{code='CAPTURE_DRIFT';make={param($c) $o=New-Op $c; $r=Read-LifecycleJson $o.P.request; $r.captureRef.sha256='0'*64; Write-Json $o.P.request $r; $o.A.ExpectedRequestSha256=Get-Sha $o.P.request; $o}}
    'capture not the reconcile sibling'=@{code='CAPTURE_BINDING';make={param($c) New-Op $c -Req @{captureRef=[ordered]@{path=$EnqueueFile;sha256=(Get-Sha $EnqueueFile)}}}}
    'operation directory not owned'=@{code='OPERATION_BINDING';make={param($c) New-Op $c -Req @{operationDirectory=(Join-Path $c.state 'elsewhere')}}}
    'operation id not stable string'=@{code='OPERATION_ID_INVALID';make={param($c) New-Op $c -Req @{operationId='..\x'}}}
    'outbox not state outbox'=@{code='PATH_OUTSIDE_OWNER';make={param($c) New-Op $c -Req @{outboxPath=(Join-Path $c.dir 'outbox.json')}}}
    'stale canonical before'=@{code='CANONICAL_DRIFT';make={param($c) $o=New-Op $c; Write-Json $c.canonical ([ordered]@{taskId=$Task;canonicalRevision=2;publicTitle='Synthetic work in progress';publicSummary='Changed after pin';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}); $c.oldSha=Get-Sha $c.canonical; $o}}
    'stale outbox pin'=@{code='OUTBOX_DRIFT';make={param($c) $o=New-Op $c; Write-Outbox $c @((Get-UnrelatedRows)[0]); $c.outboxSha=Get-Sha $c.outbox; $o}}
    'outbox missing (never auto-created)'=@{code='OUTBOX_DRIFT';make={param($c) $o=New-Op $c; Remove-Item -LiteralPath $c.outbox; $c.outboxSha=$null; $o}}
  }
  foreach($name in $variants.Keys){
    $c=New-Case; $o=& $variants[$name].make $c
    $r=Invoke-Commit $o
    Assert-Eq $r.status 'REFUSED' "$name status ($($r.code))"
    if($null -ne $variants[$name].code){Assert-Eq $r.code $variants[$name].code "$name code"}
    Assert-True (-not $r.canonicalCommitted) "$name not committed"
    Assert-Eq (Get-Sha $c.canonical) $c.oldSha "$name canonical bytes"
    Assert-True (-not [IO.Directory]::Exists($o.OpDir)) "$name no operation directory"
    Assert-True (-not [IO.File]::Exists($c.canonical+'.lock')) "$name no canonical lease"
    if($null -ne $c.outboxSha){Assert-Eq (Get-Sha $c.outbox) $c.outboxSha "$name outbox bytes"}else{Assert-True (-not [IO.File]::Exists($c.outbox)) "$name outbox still absent"}
  }
  # Duplicate and case-aliased request fields.
  foreach($dup in @(',"taskId":"x"}',',"TASKID":"x"}')){
    $c=New-Case; $o=New-Op $c
    Write-Text $o.P.request ([IO.File]::ReadAllText($o.P.request).TrimEnd().TrimEnd('}')+$dup)
    $o.A.ExpectedRequestSha256=Get-Sha $o.P.request
    $r=Invoke-Commit $o; Assert-Eq $r.status 'REFUSED' 'duplicate request field status'; Assert-Eq $r.code 'DUPLICATE_FIELD' 'duplicate request field code'
    Assert-NoEffects $o 'duplicate request field'
  }
}

Test-Step 'Non-canonical or reparse paths refuse before any effect' {
  $c=New-Case; $o=New-Op $c -Req @{canonicalPath=($c.canonical.Replace('canonical.json','.\canonical.json'))}
  $r=Invoke-Commit $o; Assert-Eq $r.status 'REFUSED' 'dotted path status'; Assert-Eq $r.code 'PATH_INVALID' 'dotted path code'; Assert-NoEffects $o 'dotted path'
  $probe=Join-Path $Ev 'probe-link'
  $can=$true; try{New-DirLink $probe (Join-Path $Ev 'probe-target-missing')}catch{$can=$false}
  if($can){Remove-DirLink $probe}
  if(-not $can -and -not (Test-Path -LiteralPath $probe)){
    [void][IO.Directory]::CreateDirectory((Join-Path $Ev 'probe-target'))
    try{New-DirLink $probe (Join-Path $Ev 'probe-target'); $can=$true; Remove-DirLink $probe}catch{$can=$false}
  }
  if(-not $can){Write-Host 'SKIP reparse sub-checks: cannot create a junction/symlink here'; return}
  $c=New-Case; $link=Join-Path $Ev ('link'+$script:CaseN)
  New-DirLink $link $c.dir
  try{
    $o=New-Op $c -Req @{canonicalPath=(Join-Path $link 'canonical.json')}
    $r=Invoke-Commit $o; Assert-Eq $r.status 'REFUSED' 'reparse canonical status'; Assert-Eq $r.code 'REPARSE_REFUSED' 'reparse canonical code'
    Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'reparse canonical bytes'; Assert-True (-not [IO.Directory]::Exists($o.OpDir)) 'reparse no operation directory'
  } finally { Remove-DirLink $link }
}

Test-Step 'Initial outbox semantics refuse before canonical mutation: NO_RETRY, identity conflicts, unreadable rows' {
  $d=Get-TextSha (([ordered]@{taskId=$Task;canonicalRevision=3;publicTitle=$NewTitle;publicSummary=$NewSummary;publicStatus='ACCEPTED_SCOPED';nextAction='NONE'}) | ConvertTo-Json -Compress)
  $idem='synth-idem-67'
  $cases=[ordered]@{
    'NO_RETRY on a target row'=@{code='EXCLUDED_NO_RETRY';rows={@((New-Row -TaskId $Task -Digest $d -RunId ($idem+':complete:github') -Dest 'github' -Extra @{retryPolicy='NO_RETRY'}))}}
    'same key different destination'=@{code='IDENTITY_CONFLICT';rows={@((New-Row -TaskId $Task -Digest $d -RunId ($idem+':complete:github') -Dest 'note'))}}
    'same runId different payload'=@{code='IDENTITY_CONFLICT';rows={@((New-Row -TaskId $Task -Digest ('d'*64) -RunId ($idem+':complete:note') -Dest 'note'))}}
    'target row already advanced'=@{code='IDENTITY_CONFLICT';rows={@((New-Row -TaskId $Task -Digest $d -RunId ($idem+':complete:github') -Dest 'github' -Status 'AWAITING_CONTROLLER' -Attempt 1))}}
    'DELIVERED row without proof (reader not weakened)'=@{code='OUTBOX_INVALID';rows={@((New-Row -TaskId 'SYNTH-OLD-9' -Digest ('e'*64) -RunId 'synth-old-run-9' -Dest 'github' -Delivery 'DELIVERED' -Proof $null))}}
  }
  foreach($n in $cases.Keys){
    $rows=& $cases[$n].rows
    $c=New-Case -Rows $rows
    $o=New-Op $c
    $r=Invoke-Commit $o
    Assert-Eq $r.status 'REFUSED' "$n status ($($r.code))"; Assert-Eq $r.code $cases[$n].code "$n code"
    Assert-NoEffects $o $n
  }
  $c=New-Case; Write-Text $c.outbox '{not json'; $c.outboxSha=Get-Sha $c.outbox
  $o=New-Op $c; $r=Invoke-Commit $o
  Assert-Eq $r.status 'REFUSED' 'malformed outbox status'; Assert-Eq $r.code 'OUTBOX_INVALID' 'malformed outbox code'; Assert-NoEffects $o 'malformed outbox'
}

Test-Step 'Retained intent that cannot be read back is refused before every owned effect' {
  # Padded new canonical stays under the 1 MiB reader cap alone, but base64 of before+after+outbox does not.
  $c=New-Case; $o=New-Op $c -NewSize 800000
  $r=Invoke-Commit $o
  Assert-Eq $r.status 'REFUSED' 'oversize intent status'; Assert-Eq $r.code 'INTENT_TOO_LARGE' "oversize intent code ($($r.code))"
  Assert-NoEffects $o 'oversize intent'
  # An intent right under the cap is written and read back by the same reader.
  $c=New-Case; $o=New-Op $c -NewSize 300000
  $r=Invoke-Commit $o
  Assert-Eq $r.status 'ENQUEUED' "large but readable intent ($($r.code))"
  Assert-True ([IO.File]::ReadAllBytes((Join-Path $o.OpDir 'intent.json')).Length -le 1048576) 'written intent is within the reader cap'
  [void](Read-LifecycleJson (Join-Path $o.OpDir 'intent.json'))
}

Test-Step 'Held locks are truthful and released; the real enqueue is never nested inside canonical.lock' {
  $c=New-Case; $o=New-Op $c
  $held=[IO.File]::Open(($c.canonical+'.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $o }finally{ $held.Dispose() }
  Assert-Eq $r.status 'REFUSED' 'held canonical lease status'; Assert-Eq $r.code 'CANONICAL_LOCKED' 'held canonical lease code'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'canonical untouched while locked'; Assert-Eq (Get-Sha $c.outbox) $c.outboxSha 'outbox untouched while locked'
  $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "same intent completes after release ($($r.code))"; Assert-EnqueuedRows $o 5
  # Held operation lock.
  $c=New-Case; $o=New-Op $c; [void][IO.Directory]::CreateDirectory($o.OpDir)
  $held=[IO.File]::Open((Join-Path $o.OpDir 'operation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $o }finally{ $held.Dispose() }
  Assert-Eq $r.code 'OPERATION_LOCKED' 'held operation lock'; Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'canonical untouched under operation lock'
  # Held publisher lease: the canonical commit stands, the enqueue reports PENDING, same intent resumes.
  $c=New-Case; $o=New-Op $c
  $held=[IO.File]::Open((Join-Path $c.state 'publisher.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $o }finally{ $held.Dispose() }
  Assert-Eq $r.status 'PENDING_ENQUEUE' "held publisher lease status ($($r.code))"; Assert-Eq $r.code 'PUBLISHER_LOCKED' 'held publisher lease code'
  Assert-True $r.canonicalCommitted 'canonical stays committed'; Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'canonical is the new bytes'
  Assert-Eq (Get-Sha $c.outbox) $c.outboxSha 'outbox untouched while publisher locked'; Assert-Eq (Read-Status $o).phase 'PENDING_ENQUEUE' 'pending phase persisted'
  $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "resume completes ($($r.code))"; Assert-EnqueuedRows $o 5
}

Test-Step 'Injected failures and simulated crashes recover the same intent without rollback or duplicates' {
  # Crash after intent, before commit.
  $c=New-Case; $o=New-Op $c
  $x=Invoke-WithFault $o 'AFTER_INTENT'; Assert-True $x.crashed 'crashed after intent'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'canonical unchanged after intent crash'; Assert-True ([IO.File]::Exists((Join-Path $o.OpDir 'intent.json'))) 'intent persisted'
  $intentSha=Get-Sha (Join-Path $o.OpDir 'intent.json')
  $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "recovered after intent crash ($($r.code))"; Assert-EnqueuedRows $o 5
  Assert-Eq (Get-Sha (Join-Path $o.OpDir 'intent.json')) $intentSha 'same intent reused'
  # Ordinary IO failure before the canonical replace leaves old bytes and is retryable.
  $c=New-Case; $o=New-Op $c
  $x=Invoke-WithFault $o 'BEFORE_CANONICAL_REPLACE' 'FAIL'
  Assert-Eq $x.result.status 'REFUSED' 'precommit failure status'; Assert-Eq $x.result.code 'CANONICAL_COMMIT_FAILED' 'precommit failure code'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'old bytes unchanged after precommit failure'
  Assert-True (@(Get-ChildItem -LiteralPath $c.dir -Filter 'canonical.json.tmp-*' -Force).Count -eq 0) 'no temp file left'
  $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "retry after precommit failure ($($r.code))"; Assert-EnqueuedRows $o 5
  # Crash after canonical commit, before enqueue.
  $c=New-Case; $o=New-Op $c
  $x=Invoke-WithFault $o 'AFTER_CANONICAL_COMMIT'; Assert-True $x.crashed 'crashed after canonical commit'
  Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'canonical is new after commit crash'; Assert-Eq (Get-Sha $c.outbox) $c.outboxSha 'no rows yet'
  $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "recovered after commit crash ($($r.code))"; Assert-True $r.canonicalCommitted 'committed'
  Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'canonical not rolled back'; Assert-EnqueuedRows $o 5
  # Crash after enqueue, before the final mark: replay derives the pin for the same intent only.
  $c=New-Case; $o=New-Op $c
  $x=Invoke-WithFault $o 'AFTER_ENQUEUE'; Assert-True $x.crashed 'crashed after enqueue'
  Assert-EnqueuedRows $o 5; $outSha=Get-Sha $c.outbox
  Assert-True ((Read-Status $o).phase -cne 'ENQUEUED') 'final mark not yet written'
  $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "recovered after enqueue crash ($($r.code))"
  Assert-Eq (Get-Sha $c.outbox) $outSha 'replay adds zero duplicate rows'; Assert-Eq (Read-Status $o).phase 'ENQUEUED' 'final mark written'; Assert-EnqueuedRows $o 5
  # Exact-after without this operation's own intent is never adopted.
  $c=New-Case; $o=New-Op $c; Copy-Item -LiteralPath $o.P.new -Destination $c.canonical -Force
  $r=Invoke-Commit $o; Assert-Eq $r.status 'REFUSED' 'foreign exact-after status'; Assert-Eq $r.code 'CANONICAL_DRIFT' 'foreign exact-after is not the approved before-state'
  Assert-Eq (Get-Sha $c.outbox) $c.outboxSha 'foreign exact-after enqueues nothing'; Assert-True (-not [IO.Directory]::Exists($o.OpDir)) 'foreign exact-after creates no intent'
}

Test-Step 'Recovery drift: other canonical content conflicts; proof drift reports truthful phase; outbox drift/identity/NO_RETRY preserve bytes' {
  # Canonical changed by someone else after the intent: CONFLICT, no overwrite.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'AFTER_INTENT'
  Write-Json $c.canonical ([ordered]@{taskId=$Task;canonicalRevision=9;publicTitle='Other writer';publicSummary='Other writer summary';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}); $other=Get-Sha $c.canonical
  $r=Invoke-Commit $o; Assert-Eq $r.status 'CONFLICT' "foreign canonical status ($($r.code))"; Assert-Eq $r.code 'CANONICAL_CONFLICT' 'foreign canonical code'
  Assert-Eq (Get-Sha $c.canonical) $other 'no overwrite, no rollback, no rebase'; Assert-Eq (Get-Sha $c.outbox) $c.outboxSha 'nothing enqueued'
  # Proof drift before commit (recovery): refused, canonical old, then recovers once restored.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'AFTER_INTENT'
  $orig=[IO.File]::ReadAllBytes($o.P.review); [IO.File]::AppendAllText($o.P.review,' ')
  $r=Invoke-Commit $o; Assert-Eq $r.status 'REFUSED' "proof drift before commit ($($r.code))"; Assert-True (-not $r.canonicalCommitted) 'not committed'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'canonical unchanged by blocked recovery'
  [IO.File]::WriteAllBytes($o.P.review,$orig); $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "restored proof completes ($($r.code))"
  # Proof drift after commit (recovery): pending, never rolled back, nothing enqueued.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'AFTER_CANONICAL_COMMIT'
  $orig=[IO.File]::ReadAllBytes($o.P.delivery); [IO.File]::AppendAllText($o.P.delivery,' ')
  $r=Invoke-Commit $o; Assert-Eq $r.status 'PENDING_ENQUEUE' "proof drift after commit ($($r.code))"; Assert-True $r.canonicalCommitted 'committed truthfully reported'
  Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'canonical not rolled back'; Assert-Eq (Get-Sha $c.outbox) $c.outboxSha 'no enqueue while proof drifted'
  [IO.File]::WriteAllBytes($o.P.delivery,$orig); $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "restored proof resumes ($($r.code))"; Assert-EnqueuedRows $o 5
  # Unrelated outbox row appended between commit and enqueue: CONFLICT, bytes preserved.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'AFTER_CANONICAL_COMMIT'
  Write-Outbox $c @((Get-UnrelatedRows)+@((New-Row -TaskId 'SYNTH-OLD-4' -Digest ('f'*64) -RunId 'synth-old-run-4' -Dest 'note'))); $drift=Get-Sha $c.outbox
  $r=Invoke-Commit $o; Assert-Eq $r.status 'CONFLICT' "unrelated outbox drift ($($r.code))"; Assert-Eq $r.code 'OUTBOX_DRIFT' 'drift code'
  Assert-Eq (Get-Sha $c.outbox) $drift 'outbox bytes preserved (no reset/overwrite)'; Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'canonical not rolled back'
  Assert-Eq (Read-Status $o).phase 'CONFLICT' 'conflict phase recorded'
  # NO_RETRY row for this event added between commit and enqueue: CONFLICT, bytes preserved.
  $c=New-Case; $o=New-Op $c; $ex=Get-Expect $o; $x=Invoke-WithFault $o 'AFTER_CANONICAL_COMMIT'
  Write-Outbox $c @((Get-UnrelatedRows)+@((New-Row -TaskId $Task -Digest $ex.digest -RunId ($o.Idem+':complete:github') -Dest 'github' -Extra @{retryPolicy='NO_RETRY'}))); $drift=Get-Sha $c.outbox
  $r=Invoke-Commit $o; Assert-Eq $r.status 'CONFLICT' "NO_RETRY collision ($($r.code))"
  Assert-Eq (Get-Sha $c.outbox) $drift 'NO_RETRY outbox bytes preserved'; Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'canonical not rolled back'
  # Identity collision (same runId, other payload) between commit and enqueue.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'AFTER_CANONICAL_COMMIT'
  Write-Outbox $c @((Get-UnrelatedRows)+@((New-Row -TaskId $Task -Digest ('d'*64) -RunId ($o.Idem+':complete:note') -Dest 'note'))); $drift=Get-Sha $c.outbox
  $r=Invoke-Commit $o; Assert-Eq $r.status 'CONFLICT' "identity collision ($($r.code))"; Assert-Eq (Get-Sha $c.outbox) $drift 'identity collision outbox bytes preserved'
  # Different request under the same operation id never reuses the intent.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'AFTER_INTENT'
  $o2=New-Op $c -Summary 'Accepted scoped work differs in summary'
  $r=Invoke-Commit $o2; Assert-Eq $r.status 'REFUSED' 'different request same operation'; Assert-Eq $r.code 'INTENT_MISMATCH' 'different request code'
  Assert-Eq (Get-Sha $c.canonical) $c.oldSha 'canonical untouched by mismatched request'
}

Test-Step 'Failed recovery is attributed to this caller only with the same authenticated intent and bound status' {
  # A different valid admission (changed named reviewer) for the same operation/request after the ORIGINAL canonical commit.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'AFTER_CANONICAL_COMMIT'; Assert-True $x.crashed 'crashed after canonical commit'
  $alt=Read-LifecycleJson $o.P.admission; $alt.reviewer='synthetic-other-reviewer'
  $altPath=Join-Path $c.dir 'admission-op1-alt.json'; Write-Json $altPath $alt
  $intentSha=Get-Sha (Join-Path $o.OpDir 'intent.json'); $statusSha=Get-Sha (Join-Path $o.OpDir 'status.json'); $outSha=Get-Sha $c.outbox
  $r=Invoke-CanonicalLifecycleCompleteCommit -RequestPath $o.A.RequestPath -ExpectedRequestSha256 $o.A.ExpectedRequestSha256 -AdmissionPath $altPath -ExpectedAdmissionSha256 (Get-Sha $altPath)
  Assert-Eq $r.status 'REFUSED' "changed admission is not attributed ($($r.code))"; Assert-Eq $r.code 'INTENT_MISMATCH' 'changed admission code'
  Assert-True (-not $r.canonicalCommitted) 'changed admission is not reported as this caller commit'
  Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'original canonical retained'; Assert-Eq (Get-Sha $c.outbox) $outSha 'outbox bytes preserved'
  Assert-Eq (Get-Sha (Join-Path $o.OpDir 'intent.json')) $intentSha 'intent bytes preserved'; Assert-Eq (Get-Sha (Join-Path $o.OpDir 'status.json')) $statusSha 'status bytes preserved'
  # The original identity still resumes and completes.
  $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "original identity resumes ($($r.code))"; Assert-EnqueuedRows $o 5

  # Status not bound to the retained intent: refused, not attributed, bytes preserved.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'AFTER_CANONICAL_COMMIT'
  $sp=Join-Path $o.OpDir 'status.json'; $st=Read-LifecycleJson $sp; $st.intentSha256='0'*64; Write-Json $sp $st
  $intentSha=Get-Sha (Join-Path $o.OpDir 'intent.json'); $statusSha=Get-Sha $sp; $outSha=Get-Sha $c.outbox
  $r=Invoke-Commit $o
  Assert-Eq $r.status 'REFUSED' "unbound status is not attributed ($($r.code))"; Assert-Eq $r.code 'STATUS_INVALID' 'unbound status code'
  Assert-True (-not $r.canonicalCommitted) 'unbound status is not reported as committed'
  Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'canonical retained'; Assert-Eq (Get-Sha $c.outbox) $outSha 'outbox bytes preserved'
  Assert-Eq (Get-Sha (Join-Path $o.OpDir 'intent.json')) $intentSha 'intent bytes preserved'; Assert-Eq (Get-Sha $sp) $statusSha 'status bytes preserved'

  # Same identity with independently retained intent/status and later proof drift: truthful pending, old canonical retained, resumes.
  $c=New-Case; $o=New-Op $c; $x=Invoke-WithFault $o 'BEFORE_ENQUEUE'; Assert-True $x.crashed 'crashed before enqueue'
  Assert-Eq (Read-Status $o).phase 'PENDING_ENQUEUE' 'pending phase retained'
  $intentSha=Get-Sha (Join-Path $o.OpDir 'intent.json'); $outSha=Get-Sha $c.outbox
  $orig=[IO.File]::ReadAllBytes($o.P.delivery); [IO.File]::AppendAllText($o.P.delivery,' ')
  $r=Invoke-Commit $o
  Assert-Eq $r.status 'PENDING_ENQUEUE' "same-identity proof drift is pending ($($r.code))"; Assert-True $r.canonicalCommitted 'prior commit attributed to the same identity'
  Assert-Eq (Get-Sha $c.canonical) $o.NewSha 'canonical not rolled back'; Assert-Eq (Get-Sha $c.outbox) $outSha 'nothing enqueued while proof drifted'
  Assert-Eq (Get-Sha (Join-Path $o.OpDir 'intent.json')) $intentSha 'intent bytes preserved'
  [IO.File]::WriteAllBytes($o.P.delivery,$orig); $r=Invoke-Commit $o; Assert-Eq $r.status 'ENQUEUED' "restored proof resumes ($($r.code))"; Assert-EnqueuedRows $o 5
}

Test-Step 'Existing rows are never downgraded: a DELIVERED target row stays, only the missing row is added' {
  $c=New-Case -Rows @(Get-UnrelatedRows); $o0=New-Op $c -OpId 'probe'; $ex=Get-Expect $o0
  Remove-Item -LiteralPath $o0.OpDir -Recurse -Force -ErrorAction SilentlyContinue
  $delivered=New-Row -TaskId $Task -Digest $ex.digest -RunId ($o0.Idem+':complete:github') -Dest 'github' -Delivery 'DELIVERED' -Proof 'readback:synthetic-existing'
  # Same outbox, but with the earlier delivered github row present before the operation starts.
  Write-Outbox $c @((Get-UnrelatedRows)+@($delivered)); $c.outboxSha=Get-Sha $c.outbox
  $rawBefore=Read-RawRows $c.outbox
  # A DELIVERED row has a different key only if status/attempt differ; here status stays AWAITING_CONTROLLER.
  $o=New-Op $c
  $r=Invoke-Commit $o
  Assert-Eq $r.status 'ENQUEUED' "partial pre-existing row completes ($($r.code))"
  $rows=@(Read-Outbox $c.outbox)
  Assert-Eq $rows.Count 5 'only the note row was added'
  $g=@($rows | Where-Object {$_.key -ceq $ex.github}); Assert-Eq $g.Count 1 'one github row'
  Assert-Eq $g[0].deliveryStatus 'DELIVERED' 'delivered row is not downgraded'; Assert-Eq $g[0].proof 'readback:synthetic-existing' 'delivered proof retained'
  # Exact field/byte preservation of every pre-existing row, including the DELIVERED target row.
  $rawAfter=Read-RawRows $c.outbox
  for($i=0;$i -lt 4;$i++){Assert-Eq (ConvertTo-Json -InputObject $rawAfter[$i] -Depth 10 -Compress) (ConvertTo-Json -InputObject $rawBefore[$i] -Depth 10 -Compress) "pre-existing row $i retained exactly"}
  Assert-Eq (@($rawAfter[3].PSObject.Properties.Name) -join ',') (@($rawBefore[3].PSObject.Properties.Name) -join ',') 'delivered row fields unchanged'
  Assert-Eq @($rawAfter | Where-Object {$_.key -ceq $ex.note}).Count 1 'missing note row appended once'
  Assert-Eq $rawAfter[4].deliveryStatus 'PENDING' 'appended note row is PENDING'; Assert-True ($null -eq $rawAfter[4].proof) 'appended note row has no proof'
  # Same-intent replay: no duplicate and no missing-row resend.
  $outSha=Get-Sha $c.outbox
  $again=Invoke-Commit $o
  Assert-Eq (ConvertTo-Json -InputObject $again -Compress) (ConvertTo-Json -InputObject $r -Compress) 'replay returns the same result'
  Assert-Eq (Get-Sha $c.outbox) $outSha 'replay leaves outbox bytes unchanged'
  Assert-Eq @(Read-Outbox $c.outbox).Count 5 'replay adds no duplicate row'
}

Test-Step 'Competing intents on the same before-state: separate processes, one canonical winner, stale loser never enqueues' {
  $c=New-Case
  $a=New-Op $c -OpId 'opa' -Idem 'synth-idem-a' -Summary 'Accepted scoped work variant alpha'
  $b=New-Op $c -OpId 'opb' -Idem 'synth-idem-b' -Summary 'Accepted scoped work variant beta'
  $pwsh=(Get-Process -Id $PID).Path
  $procs=@(); $outs=@()
  foreach($op in @($a,$b)){
    $out=Join-Path $c.dir ("child-$($op.OpId).json"); $outs+=$out
    $childArgs=@('-NoProfile','-File',$PSCommandPath,'-SourcePath',$SourceRoot,'-ChildRequestPath',$op.A.RequestPath,'-ChildRequestSha256',$op.A.ExpectedRequestSha256,'-ChildAdmissionPath',$op.A.AdmissionPath,'-ChildAdmissionSha256',$op.A.ExpectedAdmissionSha256,'-ChildResultPath',$out)
    # Same controlled executable/arguments everywhere; -WindowStyle is only supported (and kept) on Windows.
    # Two competing processes on the same before-state test CAS, not barrier-proven simultaneous contention.
    $spArgs=@{FilePath=$pwsh;ArgumentList=$childArgs;PassThru=$true}
    if($IsWindows){$spArgs['WindowStyle']='Hidden'}
    $procs+=Start-Process @spArgs
  }
  foreach($p in $procs){[void]$p.WaitForExit(120000); Assert-True $p.HasExited 'child exited'; Assert-Eq $p.ExitCode 0 'child exit code'}
  foreach($o in $outs){Assert-True ([IO.File]::Exists($o)) "child result $o"}
  $canonSha=Get-Sha $c.canonical
  Assert-True ($canonSha -ceq $a.NewSha -or $canonSha -ceq $b.NewSha) 'canonical is exactly one winner bytes'
  $win=$(if($canonSha -ceq $a.NewSha){$a}else{$b}); $lose=$(if($win -eq $a){$b}else{$a})
  # A lease collision may leave the winner PENDING; the same intent completes it. The loser never enqueues.
  $wr=Invoke-Commit $win; Assert-Eq $wr.status 'ENQUEUED' "winner completes ($($wr.code))"
  $lr=Invoke-Commit $lose; Assert-True ($lr.status -cne 'ENQUEUED') "stale loser is not enqueued ($($lr.status)/$($lr.code))"
  Assert-Eq (Get-Sha $c.canonical) $win.NewSha 'loser never overwrote the winner'
  Assert-EnqueuedRows $win 5
  $lex=Get-Expect $lose
  Assert-Eq @(Read-Outbox $c.outbox | Where-Object {$_.key -ceq $lex.github -or $_.key -ceq $lex.note}).Count 0 'loser COMPLETE rows are absent'
}

Test-Step 'No remote process, delivery or provider path exists in the module or its results' {
  # Direct parser controls: a comment mentioning "through ... gh" is not an invocation; a real gh command is.
  Assert-True (-not (Test-GhInvocation "# value read through Read-CxJsonBytes (gh text)`n`$x = 'gh issue close'")) 'comment/string text containing gh is not an invocation'
  Assert-True (Test-GhInvocation 'gh issue close 1') 'plain gh invocation is detected'
  Assert-True (Test-GhInvocation "& 'gh' pr view") 'call-operator gh invocation is detected'
  $src=[IO.File]::ReadAllText($CommitFile)
  foreach($tok in @('Start-Process','Invoke-WebRequest','Invoke-RestMethod','Invoke-Expression','Invoke-TaskLifecycle','github-cli-transport','Write-LifecycleAtomic','Set-LifecycleNoteFields')){
    Assert-True (-not $src.Contains($tok)) "module does not reference '$tok'"
  }
  Assert-True (-not (Test-GhInvocation $src)) 'module contains no gh command invocation'
  Assert-True (-not (Get-Command Invoke-CanonicalLifecycleCompleteCommit).Parameters.ContainsKey('TestSeam')) 'production function exposes no seam parameter'
  $c=New-Case; $o=New-Op $c; $r=Invoke-Commit $o
  Assert-Eq $r.publication 'NOT_ATTEMPTED' 'result states no publication'
  $rows=@(Read-Outbox $c.outbox | Where-Object {$_.taskId -ceq $Task})
  Assert-Eq $rows.Count 2 'exactly two rows for this task'
  foreach($row in $rows){Assert-Eq $row.deliveryStatus 'PENDING' 'no early DELIVERED'; Assert-True ($null -eq $row.proof) 'no manufactured ACK'}
}

Test-Step 'Read-only dependencies and the accepted closure are byte-unchanged' {
  foreach($f in $DepFiles){Assert-Eq (Get-Sha $f) $DepBefore[$f] "unchanged: $f"}
}

$failed=@($Results | Where-Object {-not $_.ok})
Write-Host "Passed: $($Results.Count-$failed.Count)  Failed: $($failed.Count)"
Write-Host 'Not covered here: consumer end-to-end delivery or any remote call; real proof/receipts; CI packaging.'
if($failed.Count -gt 0){exit 1}else{exit 0}
