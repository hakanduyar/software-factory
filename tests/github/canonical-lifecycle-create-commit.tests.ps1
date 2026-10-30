#Requires -Version 7.6
# SYNTHETIC OFFLINE FIXTURES ONLY. Every task, candidate, packet, admission and outbox row below is
# invented for this test and lives under EvidenceRoot. Passing it is not publication, destination
# delivery, host admission or proof of any live installation; it exercises the explicit canonical
# CREATE commit -> durable CREATE enqueue boundary with the real accepted enqueue/consumer/compat reader.
# Fault injection is test-local only: global aliases that shadow module/closure functions, always
# removed in finally. Production has no hook. Child pwsh processes are started only for the
# same-operation contention test and only run this file. No remote, network, model or vault access.
param(
  [Parameter(Mandatory)][string]$SourcePath,
  [Parameter(Mandatory)][string]$EvidenceRoot,
  [string]$ChildRequestPath,[string]$ChildRequestSha256,[string]$ChildAdmissionPath,[string]$ChildAdmissionSha256,[string]$ChildResultPath,
  [switch]$OwnershipControlsOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$SourceRoot=[IO.Path]::GetFullPath($SourcePath).TrimEnd('\','/')
$Ev=[IO.Path]::GetFullPath($EvidenceRoot).TrimEnd('\','/')
function Get-SourceFile { param([string]$Relative) [IO.Path]::GetFullPath((Join-Path $SourceRoot $Relative)) }
$CommitFile=Get-SourceFile 'scripts\github\commit-canonical-lifecycle-create.ps1'
$EnqueueFile=Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-create.ps1'
$ConsumerFile=Get-SourceFile 'scripts\github\task-lifecycle-mirror-consumer.ps1'
$ReconcileFile=Get-SourceFile 'scripts\github\lifecycle-compat\continuity\reconcile.ps1'
$CaptureFile=Get-SourceFile 'scripts\github\lifecycle-compat\dispatch\reviewed-blocked-capture.ps1'
$UpdateWriterFile=Get-SourceFile 'scripts\github\commit-canonical-lifecycle-update.ps1'

. $CommitFile
if($ChildResultPath){
  $childResult=Invoke-CanonicalLifecycleCreateCommit -RequestPath $ChildRequestPath -ExpectedRequestSha256 $ChildRequestSha256 -AdmissionPath $ChildAdmissionPath -ExpectedAdmissionSha256 $ChildAdmissionSha256
  [IO.File]::WriteAllText($ChildResultPath,(ConvertTo-Json -InputObject $childResult -Depth 6 -Compress),[Text.UTF8Encoding]::new($false))
  exit 0
}

if([IO.Directory]::Exists($Ev) -and @(Get-ChildItem -LiteralPath $Ev -Force).Count -gt 0){throw 'EvidenceRoot must be fresh and empty'}
[void][IO.Directory]::CreateDirectory($Ev)

function Get-Sha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
$DepFiles=@($CommitFile,$EnqueueFile,$ConsumerFile,$ReconcileFile,$CaptureFile,$UpdateWriterFile)
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
function Get-Snapshot {
  # Every entry under a case directory with its content hash: equality means no effect of any kind.
  param([string]$Dir)
  $lines=foreach($i in @(Get-ChildItem -LiteralPath $Dir -Force -Recurse)){
    $rel=$i.FullName.Substring($Dir.Length)
    if($i.PSIsContainer){"$rel|DIR"}else{"$rel|$(Get-Sha $i.FullName)"}
  }
  return (@($lines | Sort-Object) -join "`n")
}

$script:CaseN=0
function New-Case {
  $script:CaseN++
  $dir=Join-Path $Ev ('case'+$script:CaseN); $state=Join-Path $dir 'state'
  [void][IO.Directory]::CreateDirectory($state)
  [void][IO.Directory]::CreateDirectory((Join-Path $dir 'canon'))
  return @{dir=$dir;state=$state;outbox=(Join-Path $state 'outbox.json');canonical=(Join-Path (Join-Path $dir 'canon') 'canonical.json')}
}
# Request + a SEPARATE admission of the request's hash for one operation. Overrides break exactly one binding.
function New-Op {
  param($C,[string]$OpId='op1',[string]$Tag='',[hashtable]$Cand=@{},[hashtable]$Pkt=@{},[hashtable]$Req=@{},[hashtable]$Adm=@{},[string]$Idem='synth-create-1',[string]$Summary='Synthetic create summary for offline test only.')
  if(-not $Tag){$Tag=$OpId}
  $n=[ordered]@{taskId='SYNTH-TASK-C1';canonicalRevision=1;publicTitle='Synthetic create title';publicSummary=$Summary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}
  foreach($k in $Cand.Keys){$n[$k]=$Cand[$k]}
  $pk=[ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId='SYNTH-TASK-C1';canonicalRevision=1;eventType='CREATE';idempotencyKey=$Idem;publicTitle='Synthetic create title';publicSummary=$Summary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS';destinations=@('github','note')}
  foreach($k in $Pkt.Keys){$pk[$k]=$Pkt[$k]}
  $candPath=Join-Path $C.dir "candidate-$Tag.json"; $pktPath=Join-Path $C.dir "packet-$Tag.json"
  $reqPath=Join-Path $C.dir "request-$Tag.json"; $admPath=Join-Path $C.dir "admission-$Tag.json"
  Write-Json $candPath $n; Write-Json $pktPath $pk
  $pin=$null; if([IO.File]::Exists($C.outbox)){$pin=Get-Sha $C.outbox}
  $ref={ param($p) [ordered]@{path=$p;sha256=(Get-Sha $p)} }
  $opDir=Join-Path $C.state ('create-commit-'+$OpId)
  $rq=[ordered]@{schema='CanonicalCreateCommitRequest/v1';operationId=$OpId;taskId='SYNTH-TASK-C1';canonicalRevision=1;canonicalPath=$C.canonical
    candidateRef=(& $ref $candPath);packetRef=(& $ref $pktPath);enqueueRef=(& $ref $EnqueueFile);consumerRef=(& $ref $ConsumerFile);reconcileRef=(& $ref $ReconcileFile);captureRef=(& $ref $CaptureFile)
    stateDir=$C.state;outboxPath=$C.outbox;expectedOutboxSha256=$pin;operationDir=$opDir}
  foreach($k in $Req.Keys){$rq[$k]=$Req[$k]}
  Write-Json $reqPath $rq
  # Admission is written only after the request bytes are frozen; it names the request hash, never the reverse.
  $ad=[ordered]@{schema='CanonicalCreateCommitAdmission/v1';decision='ADMIT_SCOPED_CANONICAL_CREATE';reviewer='synthetic-independent-reviewer';requestSha256=(Get-Sha $reqPath);operationId=$OpId;taskId='SYNTH-TASK-C1';canonicalRevision=1
    candidateSha256=(Get-Sha $candPath);packetSha256=(Get-Sha $pktPath);enqueueSha256=(Get-Sha $EnqueueFile);consumerSha256=(Get-Sha $ConsumerFile);reconcileSha256=(Get-Sha $ReconcileFile);captureSha256=(Get-Sha $CaptureFile)}
  foreach($k in $Adm.Keys){$ad[$k]=$Adm[$k]}
  Write-Json $admPath $ad
  return @{C=$C;OpId=$OpId;OpDir=$opDir;CandPath=$candPath;CandSha=(Get-Sha $candPath);CandBytes=[IO.File]::ReadAllBytes($candPath);Adm=$ad;ReqPath=$reqPath;AdmPath=$admPath;Idem=$Idem
    EventDir=(Join-Path $C.state ('canonical-create-'+$Idem))
    A=@{RequestPath=$reqPath;ExpectedRequestSha256=(Get-Sha $reqPath);AdmissionPath=$admPath;ExpectedAdmissionSha256=(Get-Sha $admPath)}}
}
function Invoke-Commit { param($Op) $a=$Op.A; Invoke-CanonicalLifecycleCreateCommit @a }
function Get-Expect {
  param($Op)
  $c=Read-LifecycleJson $Op.CandPath
  $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))
  $e=@{digest=$digest}
  foreach($d in @('github','note')){$e[$d]=Get-EventKey -TaskId $c.taskId -PayloadSha256 $digest -RunId ($Op.Idem+':create:'+$d) -Status 'AWAITING_CONTROLLER' -Attempt 0}
  return $e
}
function New-Row {
  param($Task,$Digest,$RunId,$Dest,$Status='AWAITING_CONTROLLER',$Attempt=0,$Delivery='PENDING',$Proof=$null,[hashtable]$Extra=@{})
  $key=Get-EventKey -TaskId $Task -PayloadSha256 $Digest -RunId $RunId -Status $Status -Attempt $Attempt
  $o=[ordered]@{key=$key;taskId=$Task;payloadSha256=$Digest;runId=$RunId;destination=$Dest;status=$Status;attempt=$Attempt;deliveryStatus=$Delivery;proof=$Proof}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function New-UnrelatedRow { param([int]$Pad=0) New-Row -Task 'SYNTH-OTHER' -Digest ('a'*64) -RunId 'synth-other-run' -Dest 'github' -Status 'FAILED' -Attempt 1 -Extra @{updatedAt='2026-01-01T00:00:00Z';consentEligibility=$null;reconciliationSignal=$false;synthNote=('x'*$Pad)} }
function Write-Outbox { param($C,[object[]]$Rows) Write-OutboxAtomic $C.outbox $Rows }
function Assert-Sidecar {
  param($Op)
  $p=Join-Path $Op.EventDir 'event.json'
  Assert-True ([IO.File]::Exists($p)) 'sidecar exists'
  $ev=Read-LifecycleJson $p
  Assert-LifecycleKeys $ev @('schema','taskId','canonicalVersion','publicTitle','publicSummary','publicStatus','nextAction')
  Assert-Eq $ev.schema 'GitHubCreateEvent/v1' 'sidecar schema'
  Assert-Eq (@(Get-ChildItem -LiteralPath $Op.EventDir -Force).Count) 1 'sidecar directory holds only event.json'
  return (Get-Sha $p)
}
function Assert-EnqueuedRows {
  param($Op,[int]$Total)
  $ex=Get-Expect $Op
  $rows=@(Read-Outbox $Op.C.outbox)
  Assert-Eq $rows.Count $Total 'row count'
  $raw=Read-RawRows $Op.C.outbox
  $evSha=Assert-Sidecar $Op
  foreach($d in @('github','note')){
    $m=@($rows | Where-Object {$_.key -ceq $ex[$d]}); Assert-Eq $m.Count 1 "one $d row"
    Assert-Eq $m[0].deliveryStatus 'PENDING' "$d pending"; Assert-True ($null -eq $m[0].proof) "$d proof null"
    Assert-Eq $m[0].runId ($Op.Idem+':create:'+$d) "$d runId"; Assert-Eq $m[0].payloadSha256 $ex.digest "$d digest"
    $r=@($raw | Where-Object {$_.key -ceq $ex[$d]})[0]
    Assert-Eq @($r.PSObject.Properties.Name).Count 13 "$d metadata field count"
    Assert-Eq $r.eventType 'CREATE' "$d eventType"
    Assert-Eq $r.canonicalRef.sha256 $Op.CandSha "$d canonical ref"; Assert-Eq $r.createEventRef.sha256 $evSha "$d sidecar ref"
  }
}
function Assert-StateOnlyOwned {
  # Zero transport/note/engine surface: the state directory holds only the outbox, locks and owned directories.
  param($C)
  foreach($n in (Get-Names $C.state)){Assert-True ($n -cmatch '^(outbox\.json|[A-Za-z0-9._-]+\.lock|create-commit-[A-Za-z0-9._-]+|canonical-create-[A-Za-z0-9._-]+)\z') "unexpected state entry $n"}
}
function Assert-Refused {
  # Pre-effect refusal: truthful result and byte-identical case tree (no canonical, directory, lease or outbox effect).
  param($Op,[string]$Code,[string]$Msg)
  $before=Get-Snapshot $Op.C.dir
  $r=Invoke-Commit $Op
  Assert-Eq $r.status 'REFUSED' "$Msg status"; Assert-Eq $r.code $Code "$Msg code"; Assert-True (-not $r.canonicalCommitted) "$Msg not committed"
  Assert-Eq (Get-Snapshot $Op.C.dir) $before "$Msg no effects"
}

# Test-only seams: global aliases shadow module/closure functions. Each throws an ordinary IO failure
# once. CANONICAL_CREATE_FAIL shadows the no-replace writer; the others wrap the status writer; the
# last also shadows the outbox writer only after the status write, so the real enqueue fails to write.
$script:RealSetCcStatus=${function:Set-CcStatus}
$script:FaultMode=$null; $script:FaultFired=$false
function Invoke-TestFail { $script:FaultFired=$true; throw [IO.IOException]::new('synthetic injected failure') }
function Invoke-TestCanonicalFail { param([string]$Path,[byte[]]$Bytes,[string]$Sha256) Invoke-TestFail }
function Invoke-TestWriteOutboxFail { param($Path,$Rows) throw [IO.IOException]::new('synthetic outbox write failure') }
function Invoke-TestSetCcStatus {
  param([string]$Dir,[string]$OperationId,[string]$IntentSha,[string]$Phase,[string]$BasePhase,$Cause)
  $m=$script:FaultMode
  $before=@{AFTER_INTENT='COMMIT_STARTED';AFTER_CANONICAL_COMMIT='PENDING_ENQUEUE';AFTER_ENQUEUE='ENQUEUED'}
  if(-not $script:FaultFired -and $null -ne $m -and $before.ContainsKey($m) -and $Phase -ceq $before[$m]){Invoke-TestFail}
  & $script:RealSetCcStatus -Dir $Dir -OperationId $OperationId -IntentSha $IntentSha -Phase $Phase -BasePhase $BasePhase -Cause $Cause
  if(-not $script:FaultFired -and $Phase -ceq 'PENDING_ENQUEUE' -and $null -eq $Cause){
    if($m -ceq 'BEFORE_ENQUEUE'){Invoke-TestFail}
    if($m -ceq 'ENQUEUE_WRITE_FAIL'){$script:FaultFired=$true; Set-Alias -Name Write-OutboxAtomic -Value Invoke-TestWriteOutboxFail -Scope Global}
  }
}
function Invoke-WithFault {
  param($Op,[string]$Mode)
  $script:FaultMode=$Mode; $script:FaultFired=$false
  $out=$null
  try{
    Set-Alias -Name Set-CcStatus -Value Invoke-TestSetCcStatus -Scope Global
    if($Mode -ceq 'CANONICAL_CREATE_FAIL'){Set-Alias -Name Write-CcCanonicalNoReplace -Value Invoke-TestCanonicalFail -Scope Global}
    $out=Invoke-Commit $Op
  } finally {
    foreach($n in @('Set-CcStatus','Write-CcCanonicalNoReplace','Write-OutboxAtomic')){Remove-Item -Path "Alias:\$n" -Force -ErrorAction SilentlyContinue}
    $script:FaultMode=$null
  }
  foreach($n in @('Set-CcStatus','Write-CcCanonicalNoReplace','Write-OutboxAtomic')){Assert-True ($null -eq (Get-Alias -Name $n -ErrorAction SilentlyContinue)) "fault alias $n removed"}
  Assert-True $script:FaultFired "fault fired: $Mode"
  return $out
}

$Results=[System.Collections.Generic.List[object]]::new()
function Test-Step {
  param([string]$Name,[scriptblock]$Body)
  # -OwnershipControlsOnly runs just the temporary-ownership step; earlier recorded results are not replayed.
  if($OwnershipControlsOnly -and $Name -cnotlike 'Ownership*'){return}
  try{ & $Body; $Results.Add([pscustomobject]@{name=$Name;ok=$true;error=''}); Write-Host "PASS $Name" }
  catch{ $Results.Add([pscustomobject]@{name=$Name;ok=$false;error=$_.Exception.Message}); Write-Host "FAIL $Name :: $($_.Exception.Message)" }
}

Test-Step '1 Valid absent canonical: exact candidate bytes, sidecar + two PENDING rows, no transport surface, replay byte-stable' {
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $rawBefore=Read-RawRows $c.outbox
  Write-Text (Join-Path $c.dir 'canon\neighbor.txt') 'unrelated human file'
  $op=New-Op $c
  Assert-True (-not [IO.File]::Exists($c.canonical)) 'canonical absent before'
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'ENQUEUED' 'status'; Assert-Eq $r.code 'ENQUEUED_VERIFIED' 'code'; Assert-True $r.canonicalCommitted 'committed'
  Assert-Eq (Get-Sha $c.canonical) $op.CandSha 'canonical is exactly the candidate bytes'
  Assert-Eq (([IO.File]::ReadAllBytes($c.canonical) -join ',')) ($op.CandBytes -join ',') 'byte-identical'
  Assert-EnqueuedRows $op 3
  $ex=Get-Expect $op; Assert-Eq ($r.keys -join '|') ($ex.github+'|'+$ex.note) 'result keys'
  Assert-Eq (Read-Status $op).phase 'ENQUEUED' 'phase'
  Assert-Eq (ConvertTo-Json -InputObject (Read-RawRows $c.outbox)[0] -Depth 10 -Compress) (ConvertTo-Json -InputObject $rawBefore[0] -Depth 10 -Compress) 'unrelated row metadata and order retained'
  Assert-True ([IO.File]::ReadAllText($c.outbox).Contains('2026-01-01T00:00:00Z')) 'unrelated date text not reformatted'
  Assert-Eq ([IO.File]::ReadAllText((Join-Path $c.dir 'canon\neighbor.txt'))) 'unrelated human file' 'neighbor retained'
  Assert-StateOnlyOwned $c
  foreach($f in @('intent.json','status.json')){$t=[IO.File]::ReadAllText((Join-Path $op.OpDir $f)); Assert-True (-not $t.Contains('DONE') -and -not $t.Contains('"DELIVERED"')) "$f has no DONE/ACK claim"}
  foreach($l in @(($c.canonical+'.lock'),(Join-Path $c.state 'publisher.lock'),(Join-Path $op.OpDir 'operation.lock'))){$h=[IO.File]::Open($l,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $h.Dispose()}
  $snap=Get-Snapshot $c.dir
  $again=Invoke-Commit $op
  Assert-Eq (ConvertTo-Json -InputObject $again -Compress) (ConvertTo-Json -InputObject $r -Compress) 'replay returns the same result'
  Assert-Eq (Get-Snapshot $c.dir) $snap 'replay leaves every byte unchanged'
  Assert-EnqueuedRows $op 3
  # No outbox before: absent pin works too.
  $c2=New-Case; $op2=New-Op $c2
  Assert-Eq (Invoke-Commit $op2).status 'ENQUEUED' 'absent outbox'; Assert-EnqueuedRows $op2 2
}

Test-Step '2a Existing canonical (identical, different, directory, reparse) is refused without overwrite' {
  foreach($kind in @('identical','different','directory')){
    $c=New-Case; $op=New-Op $c
    $keep=$null
    if($kind -ceq 'identical'){[IO.File]::WriteAllBytes($c.canonical,$op.CandBytes)}
    elseif($kind -ceq 'different'){Write-Text $c.canonical '{"human":"owned"}'}
    else{[void][IO.Directory]::CreateDirectory($c.canonical); Write-Text (Join-Path $c.canonical 'inside.txt') 'x'}
    Assert-Refused $op 'CANONICAL_EXISTS' $kind
    Assert-True (-not [IO.File]::Exists($c.outbox)) "$kind no outbox"
  }
  $c=New-Case; $target=Join-Path $c.dir 'target'; [void][IO.Directory]::CreateDirectory($target); $made=$false
  try{
    New-DirLink $c.canonical $target; $made=$true
    $op=New-Op $c
    Assert-Refused $op 'REPARSE_REFUSED' 'reparse canonical'
    Assert-Eq @(Get-Names $target).Count 0 'reparse target untouched'
  } finally { if($made){Remove-DirLink $c.canonical} }
}

Test-Step '2b Malformed, missing, mistyped, duplicate, mismatched request/admission/candidate/packet/closure refuse with no effects' {
  $badHash='0'*64
  $variants=[ordered]@{
    'missing admission file'=@{code='FILE_MISSING';make={param($c) $o=New-Op $c; Remove-Item -LiteralPath $o.A.AdmissionPath; $o}}
    'wrong admission pin'=@{code='ADMISSION_DRIFT';make={param($c) $o=New-Op $c; $o.A.ExpectedAdmissionSha256=$badHash; $o}}
    'wrong request pin'=@{code='REQUEST_DRIFT';make={param($c) $o=New-Op $c; $o.A.ExpectedRequestSha256=$badHash; $o}}
    'malformed request pin'=@{code='PIN_INVALID';make={param($c) $o=New-Op $c; $o.A.ExpectedRequestSha256='ABC'; $o}}
    'wrong decision'=@{code='ADMISSION_INVALID';make={param($c) New-Op $c -Adm @{decision='APPROVED'}}}
    'update-style decision'=@{code='ADMISSION_INVALID';make={param($c) New-Op $c -Adm @{decision='ADMIT_CANONICAL_UPDATE_COMMIT'}}}
    'boolean approval shortcut'=@{code='FIELDS_INVALID';make={param($c) New-Op $c -Adm @{approved=$true}}}
    'admission wrong task'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{taskId='OTHER-TASK'}}}
    'admission wrong operation'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{operationId='other'}}}
    'admission revision string'=@{code='ADMISSION_INVALID';make={param($c) New-Op $c -Adm @{canonicalRevision='1'}}}
    'admission wrong revision'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{canonicalRevision=2}}}
    'admission wrong candidate'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{candidateSha256=$badHash}}}
    'admission wrong packet'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{packetSha256=$badHash}}}
    'admission wrong enqueue'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{enqueueSha256=$badHash}}}
    'admission wrong consumer'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{consumerSha256=$badHash}}}
    'admission wrong capture'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{captureSha256=$badHash}}}
    'admission wrong request'=@{code='ADMISSION_BINDING';make={param($c) New-Op $c -Adm @{requestSha256=$badHash}}}
    'request schema'=@{code='REQUEST_INVALID';make={param($c) New-Op $c -Req @{schema='CanonicalLifecycleUpdateCommitRequest/v1'}}}
    'request revision string'=@{code='REVISION_INVALID';make={param($c) New-Op $c -Req @{canonicalRevision='1'}}}
    'request revision zero'=@{code='REVISION_INVALID';make={param($c) New-Op $c -Req @{canonicalRevision=0}}}
    'request extra field'=@{code='FIELDS_INVALID';make={param($c) New-Op $c -Req @{extra='x'}}}
    'request uppercase outbox pin'=@{code='REQUEST_INVALID';make={param($c) New-Op $c -Req @{expectedOutboxSha256=('A'*64)}}}
    'candidate extra field'=@{code='FIELDS_INVALID';make={param($c) New-Op $c -Cand @{extra='x'}}}
    'candidate wrong task'=@{code='TASK_MISMATCH';make={param($c) New-Op $c -Cand @{taskId='OTHER-TASK'}}}
    'candidate revision string'=@{code='REVISION_INVALID';make={param($c) New-Op $c -Cand @{canonicalRevision='1'}}}
    'candidate revision differs from request'=@{code='IDENTITY_MISMATCH';make={param($c) New-Op $c -Cand @{canonicalRevision=2} -Pkt @{canonicalRevision=2}}}
    'packet differs from candidate'=@{code='CANONICAL_PACKET_MISMATCH';make={param($c) New-Op $c -Pkt @{publicTitle='Different synthetic title'}}}
    'packet is not CREATE'=@{code='UNSUPPORTED_EVENT';make={param($c) New-Op $c -Pkt @{eventType='UPDATE'}}}
    'packet wrong task'=@{code='TASK_MISMATCH';make={param($c) New-Op $c -Pkt @{taskId='OTHER-TASK'}}}
    'closing status unsupported'=@{code='PACKET_INVALID';make={param($c) New-Op $c -Cand @{publicStatus='DONE'} -Pkt @{publicStatus='DONE'}}}
    'terminal next action unsupported'=@{code='PACKET_INVALID';make={param($c) New-Op $c -Cand @{nextAction='NONE'} -Pkt @{nextAction='NONE'}}}
    'unsafe idempotency key'=@{code='IDEMPOTENCY_KEY_UNSAFE';make={param($c) New-Op $c -Idem 'synth:create:1'}}
    'packet destinations'=@{code='DESTINATIONS_INVALID';make={param($c) New-Op $c -Pkt @{destinations=@('github')}}}
    'consumer pin drift'=@{code='CONSUMER_DRIFT';make={param($c) New-Op $c -Req @{consumerRef=[ordered]@{path=$ConsumerFile;sha256=$badHash}}}}
    'enqueue pin drift'=@{code='ENQUEUE_DRIFT';make={param($c) New-Op $c -Req @{enqueueRef=[ordered]@{path=$EnqueueFile;sha256=$badHash}}}}
    'unaccepted reconcile pin'=@{code='RECONCILE_DRIFT';make={param($c) New-Op $c -Req @{reconcileRef=[ordered]@{path=$ReconcileFile;sha256=$badHash}}}}
    'unaccepted capture pin'=@{code='CAPTURE_DRIFT';make={param($c) New-Op $c -Req @{captureRef=[ordered]@{path=$CaptureFile;sha256=$badHash}}}}
    'capture not the reconcile sibling'=@{code='CAPTURE_BINDING';make={param($c) New-Op $c -Req @{captureRef=[ordered]@{path=$ConsumerFile;sha256=(Get-Sha $ConsumerFile)}}}}
    'operation directory not owned'=@{code='OPERATION_BINDING';make={param($c) New-Op $c -Req @{operationDir=(Join-Path $c.state 'elsewhere')}}}
    'operation id not stable string'=@{code='OPERATION_ID_INVALID';make={param($c) New-Op $c -Req @{operationId='..\x'}}}
    'outbox not state outbox'=@{code='PATH_OUTSIDE_OWNER';make={param($c) New-Op $c -Req @{outboxPath=(Join-Path $c.dir 'outbox.json')}}}
    'relative canonical path'=@{code='PATH_INVALID';make={param($c) New-Op $c -Req @{canonicalPath='canon\canonical.json'}}}
    'noncanonical canonical path'=@{code='PATH_INVALID';make={param($c) New-Op $c -Req @{canonicalPath=($c.dir+[IO.Path]::DirectorySeparatorChar+'canon'+[IO.Path]::DirectorySeparatorChar+'..'+[IO.Path]::DirectorySeparatorChar+'canon'+[IO.Path]::DirectorySeparatorChar+'canonical.json')}}}
    'canonical parent missing'=@{code='CANONICAL_DIR_MISSING';make={param($c) New-Op $c -Req @{canonicalPath=(Join-Path $c.dir 'nodir\canonical.json')}}}
    'canonical inside state'=@{code='PATHS_NOT_DISJOINT';make={param($c) New-Op $c -Req @{canonicalPath=(Join-Path $c.state 'canonical.json')}}}
    'canonical is the candidate'=@{code='PATHS_NOT_DISJOINT';make={param($c) New-Op $c -Req @{canonicalPath=(Join-Path $c.dir 'candidate-op1.json')}}}
    'stale outbox pin'=@{code='OUTBOX_DRIFT';make={param($c) $o=New-Op $c; Write-Outbox $c @((New-UnrelatedRow)); $o}}
  }
  foreach($name in $variants.Keys){
    $c=New-Case; $o=& $variants[$name].make $c
    Assert-Refused $o $variants[$name].code $name
  }
  # Duplicate and case-aliased request fields.
  $c=New-Case; $o=New-Op $c
  foreach($dup in @(',"taskId":"x"',',"TASKID":"x"')){
    $text=[IO.File]::ReadAllText($o.ReqPath).TrimEnd(); $text=$text.Substring(0,$text.Length-1)+$dup+'}'
    Write-Text $o.ReqPath $text; $o.A.ExpectedRequestSha256=Get-Sha $o.ReqPath
    Assert-Refused $o 'DUPLICATE_FIELD' "duplicate $dup"
  }
  # Missing request field.
  $c=New-Case; $o=New-Op $c; $r=Read-LifecycleJson $o.ReqPath; $r.Remove('captureRef'); Write-Json $o.ReqPath $r; $o.A.ExpectedRequestSha256=Get-Sha $o.ReqPath
  Assert-Refused $o 'FIELDS_INVALID' 'missing request field'
  # Reparse state directory.
  $c=New-Case; $link=Join-Path $c.dir 'linkstate'; $made=$false
  try{
    New-DirLink $link $c.state; $made=$true
    $o=New-Op $c -Req @{stateDir=$link;outboxPath=(Join-Path $link 'outbox.json');operationDir=(Join-Path $link 'create-commit-op1')}
    Assert-Refused $o 'REPARSE_REFUSED' 'reparse state'
  } finally { if($made){Remove-DirLink $link} }
}

Test-Step '3 Crash/fault after owned intent and after canonical commit resume once; changed identity or drift refuses truthfully without rollback' {
  $c=New-Case; $op=New-Op $c
  $f=Invoke-WithFault $op 'AFTER_INTENT'
  Assert-Eq $f.status 'REFUSED' 'after-intent status'; Assert-True (-not $f.canonicalCommitted) 'after-intent not committed'
  Assert-True ([IO.File]::Exists((Join-Path $op.OpDir 'intent.json'))) 'intent persisted'
  Assert-True (-not [IO.File]::Exists($c.canonical)) 'canonical not created'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox'
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'ENQUEUED' 'resume status'; Assert-Eq (Get-Sha $c.canonical) $op.CandSha 'committed once'; Assert-EnqueuedRows $op 2

  foreach($mode in @('AFTER_CANONICAL_COMMIT','BEFORE_ENQUEUE')){
    $c=New-Case; $op=New-Op $c
    $f=Invoke-WithFault $op $mode
    Assert-Eq $f.status 'PENDING_ENQUEUE' "$mode truthful status"; Assert-True $f.canonicalCommitted "$mode committed"; Assert-Eq $f.operationId 'op1' "$mode bound to this operation"
    Assert-Eq (Get-Sha $c.canonical) $op.CandSha "$mode canonical committed"; Assert-True (-not [IO.File]::Exists($c.outbox)) "$mode no outbox yet"
    if($mode -ceq 'BEFORE_ENQUEUE'){Assert-Eq (Read-Status $op).phase 'PENDING_ENQUEUE' 'explicit phase'}
    $r=Invoke-Commit $op
    Assert-Eq $r.status 'ENQUEUED' "$mode resume"; Assert-Eq (Get-Sha $c.canonical) $op.CandSha "$mode canonical unchanged by resume"; Assert-EnqueuedRows $op 2
  }

  # Crash after the enqueue, before the final mark: resume adds nothing.
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $op=New-Op $c
  $f=Invoke-WithFault $op 'AFTER_ENQUEUE'
  Assert-Eq $f.status 'PENDING_ENQUEUE' 'after-enqueue truthful status'; Assert-Eq (Read-Status $op).phase 'PENDING_ENQUEUE' 'status not yet final'; Assert-EnqueuedRows $op 3
  $crashSha=Get-Sha $c.outbox
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'ENQUEUED' 'resume'; Assert-Eq (Get-Sha $c.outbox) $crashSha 'resume added nothing'; Assert-EnqueuedRows $op 3
  Assert-Eq (Read-Status $op).phase 'ENQUEUED' 'final mark'
  Assert-Eq (ConvertTo-Json -InputObject (Invoke-Commit $op) -Compress) (ConvertTo-Json -InputObject $r -Compress) 'result stable afterwards'

  # A fault before the canonical create keeps nothing and resumes.
  $c=New-Case; $op=New-Op $c
  $f=Invoke-WithFault $op 'CANONICAL_CREATE_FAIL'
  Assert-Eq $f.code 'CANONICAL_COMMIT_FAILED' 'create failure code'; Assert-True (-not $f.canonicalCommitted) 'create failure not committed'
  Assert-True (-not [IO.File]::Exists($c.canonical)) 'no canonical'; Assert-Eq @(Get-Names (Join-Path $c.dir 'canon') | Where-Object {$_ -like '*.tmp-*'}).Count 0 'no temp'
  Assert-Eq (Invoke-Commit $op).status 'ENQUEUED' 'resume after create failure'

  # Changed admission, or a changed candidate under the same operation id, cannot adopt the committed state.
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'BEFORE_ENQUEUE')
  $alt=Join-Path $c.dir 'admission-alt.json'; $ad=[ordered]@{}; foreach($k in $op.Adm.Keys){$ad[$k]=$op.Adm[$k]}; $ad['reviewer']='another-reviewer'; Write-Json $alt $ad
  $op2=@{} + $op; $op2.A=@{RequestPath=$op.A.RequestPath;ExpectedRequestSha256=$op.A.ExpectedRequestSha256;AdmissionPath=$alt;ExpectedAdmissionSha256=(Get-Sha $alt)}
  $before=Get-Snapshot $c.dir
  $r=Invoke-Commit $op2
  Assert-Eq $r.status 'REFUSED' 'changed admission status'; Assert-Eq $r.code 'INTENT_MISMATCH' 'changed admission code'; Assert-True (-not $r.canonicalCommitted) 'changed admission is not misattributed as committed'
  Assert-Eq (Get-Snapshot $c.dir) $before 'changed admission: no effect, no rollback'
  $op3=New-Op $c -OpId 'op1' -Tag 'b' -Summary 'A different synthetic summary for the same operation id.'
  $r=Invoke-Commit $op3
  Assert-Eq $r.code 'INTENT_MISMATCH' 'changed candidate code'; Assert-True (-not $r.canonicalCommitted) 'changed candidate not committed'; Assert-Eq (Get-Sha $c.canonical) $op.CandSha 'original canonical preserved'
  Assert-Eq (Invoke-Commit $op).status 'ENQUEUED' 'the original operation still resumes'

  # Current canonical changed, removed, or planted after the intent: preserved, truthful, no rollback.
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'BEFORE_ENQUEUE')
  Write-Text $c.canonical '{"human":"edited after commit"}'; $edited=Get-Sha $c.canonical
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'CONFLICT' 'edited status'; Assert-Eq $r.code 'CANONICAL_CONFLICT' 'edited code'; Assert-Eq (Get-Sha $c.canonical) $edited 'human bytes preserved'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no stale enqueue'
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'BEFORE_ENQUEUE')
  [IO.File]::Delete($c.canonical)
  $r=Invoke-Commit $op
  Assert-Eq $r.code 'CANONICAL_REVERTED' 'removed code'; Assert-True (-not [IO.File]::Exists($c.canonical)) 'not silently recreated'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no enqueue'
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'AFTER_INTENT')
  [IO.File]::WriteAllBytes($c.canonical,$op.CandBytes)
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'CONFLICT' 'planted status'; Assert-Eq $r.code 'AFTER_NOT_OWNED' 'identical file without commit evidence is not ownership'
  Assert-True (-not [IO.File]::Exists($c.outbox)) 'no enqueue'; Assert-True (-not $r.canonicalCommitted) 'planted file is not reported as committed by this operation'

  # External outbox drift: before the commit refuses (nothing created); after it reports CONFLICT (no rollback).
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $op=New-Op $c; [void](Invoke-WithFault $op 'AFTER_INTENT')
  Write-Outbox $c @((New-UnrelatedRow),(New-Row 'SYNTH-OTHER-2' ('b'*64) 'synth-other-run-2' 'note')); $late=Get-Sha $c.outbox
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'REFUSED' 'late drift status'; Assert-Eq $r.code 'OUTBOX_DRIFT' 'late drift code'; Assert-True (-not $r.canonicalCommitted) 'late drift not committed'
  Assert-True (-not [IO.File]::Exists($c.canonical)) 'late drift canonical not created'; Assert-Eq (Get-Sha $c.outbox) $late 'late drift outbox preserved'
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $op=New-Op $c; [void](Invoke-WithFault $op 'BEFORE_ENQUEUE')
  Write-Outbox $c @((New-UnrelatedRow),(New-Row 'SYNTH-OTHER-2' ('b'*64) 'synth-other-run-2' 'note')); $drift=Get-Sha $c.outbox
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'CONFLICT' 'drift status'; Assert-Eq $r.code 'OUTBOX_DRIFT' 'drift code'
  Assert-Eq (Get-Sha $c.outbox) $drift 'drifted outbox bytes preserved'; Assert-Eq (Get-Sha $c.canonical) $op.CandSha 'canonical not rolled back'
  $c=New-Case; $op=New-Op $c; [void](Invoke-WithFault $op 'AFTER_ENQUEUE')
  $rows=@(Read-Outbox $c.outbox); Write-Outbox $c @($rows+@((New-Row 'SYNTH-OTHER-2' ('b'*64) 'synth-other-run-2' 'note'))); $drift=Get-Sha $c.outbox
  Assert-Eq (Invoke-Commit $op).code 'OUTBOX_DRIFT' 'own rows plus an extra row'; Assert-Eq (Get-Sha $c.outbox) $drift 'bytes preserved'
}

Test-Step '4 Corrupt/known-NO_RETRY/conflicting/oversized outbox and the intent boundary fail BEFORE canonical creation' {
  $c=New-Case; Write-Text $c.outbox '{not json'; Assert-Refused (New-Op $c) 'OUTBOX_INVALID' 'malformed outbox'
  $c=New-Case; $probe=New-Op $c -OpId 'probe'; $ex=Get-Expect $probe
  Write-Outbox $c @((New-UnrelatedRow),(New-Row 'SYNTH-TASK-C1' $ex.digest 'synth-create-1:create:github' 'github' -Extra @{retryPolicy='NO_RETRY'}))
  Assert-Refused (New-Op $c) 'EXCLUDED_NO_RETRY' 'known NO_RETRY own row'
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow),(New-Row 'SYNTH-TASK-C1' ('c'*64) 'synth-create-1:create:note' 'note'))
  Assert-Refused (New-Op $c) 'EVENT_CONFLICT' 'conflicting own row'
  $c=New-Case; $big=New-Op $c -OpId 'probe2'; $ex=Get-Expect $big
  Write-Outbox $c @((New-Row 'SYNTH-TASK-C1' $ex.digest 'synth-create-1:create:github' 'github'),(New-Row 'SYNTH-TASK-C1' $ex.digest 'synth-create-1:create:note' 'note'))
  Assert-Refused (New-Op $c) 'EVENT_CONFLICT' 'matching pre-existing own rows are not an initial state'
  # Read-limit: the outbox itself over the cap, and a valid outbox whose final serialization would exceed it.
  $c=New-Case; Write-Text $c.outbox ('[]'+(' '*1048577)); Assert-Refused (New-Op $c) 'OUTBOX_TOO_LARGE' 'outbox over the read limit'
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $base=[IO.FileInfo]::new($c.outbox).Length
  Write-Outbox $c @((New-UnrelatedRow -Pad (1048000-$base)))
  Assert-Eq ([IO.FileInfo]::new($c.outbox).Length) 1048000 'outbox is individually readable'
  Assert-Refused (New-Op $c) 'OUTBOX_TOO_LARGE' 'final outbox would exceed the read limit'

  # Serialized intent boundary, calibrated on this case (equal-length operation ids; one alignment class).
  $limit=1048576
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $nBase=[IO.FileInfo]::new($c.outbox).Length
  $pad0=1000+((3-(($nBase+1000)%3))%3)
  Write-Outbox $c @((New-UnrelatedRow -Pad $pad0)); $n0=[IO.FileInfo]::new($c.outbox).Length
  Assert-Eq ($n0%3) 0 'calibration outbox is block aligned'
  $cal=New-Op $c -OpId 'cal'
  $f=Invoke-WithFault $cal 'AFTER_INTENT'; Assert-Eq $f.status 'REFUSED' 'calibration stops after the intent'
  $l0=[IO.FileInfo]::new((Join-Path $cal.OpDir 'intent.json')).Length
  $overhead=$l0-4*[math]::Ceiling($n0/3)
  $maxQ=[math]::Floor(($limit-$overhead)/4); $nOk=3*$maxQ; $padOk=$nOk-$nBase
  Assert-True ($padOk -gt 0 -and $nOk -lt $limit) 'boundary outbox is individually within the reader cap'
  Write-Outbox $c @((New-UnrelatedRow -Pad ($padOk+1))); $ovrOutbox=Get-Sha $c.outbox
  $ovr=New-Op $c -OpId 'ovr'
  $r=Invoke-Commit $ovr
  Assert-Eq $r.status 'REFUSED' 'over-limit status'; Assert-Eq $r.code 'INTENT_TOO_LARGE' 'over-limit code'; Assert-True (-not $r.canonicalCommitted) 'over-limit not committed'
  Assert-True (-not [IO.File]::Exists($c.canonical)) 'over-limit no canonical'; Assert-True (-not [IO.Directory]::Exists($ovr.OpDir)) 'over-limit no operation directory'
  Assert-Eq (Get-Sha $c.outbox) $ovrOutbox 'over-limit outbox bytes'
  Write-Outbox $c @((New-UnrelatedRow -Pad $padOk))
  Assert-Eq ([IO.FileInfo]::new($c.outbox).Length) $nOk 'at-limit outbox size'
  $bnd=New-Op $c -OpId 'bnd'
  $f=Invoke-WithFault $bnd 'AFTER_INTENT'
  $len=[IO.FileInfo]::new((Join-Path $bnd.OpDir 'intent.json')).Length
  Assert-True ($len -le $limit -and $len -gt $limit-4) "boundary intent is at the cap ($len bytes)"
  Assert-True (-not [IO.File]::Exists($c.canonical)) 'boundary canonical untouched before resume'
  # "Restart": a fresh invocation re-reads the persisted intent through the strict reader.
  $r=Invoke-Commit $bnd
  Assert-Eq $r.status 'ENQUEUED' 'boundary resume'; Assert-Eq (Get-Sha $c.canonical) $bnd.CandSha 'boundary committed once'; Assert-EnqueuedRows $bnd 3
  Assert-Eq (ConvertTo-Json -InputObject (Invoke-Commit $bnd) -Compress) (ConvertTo-Json -InputObject $r -Compress) 'boundary replay result is stable'
}

Test-Step '5a Held operation/canonical/publisher locks give explicit no-ACK results and recover' {
  $c=New-Case; $op=New-Op $c
  $h=[IO.File]::Open($c.canonical+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $op } finally { $h.Dispose() }
  Assert-Eq $r.status 'REFUSED' 'status'; Assert-Eq $r.code 'CANONICAL_LOCKED' 'code'; Assert-True (-not $r.canonicalCommitted) 'not committed'
  Assert-True (-not [IO.File]::Exists($c.canonical)) 'canonical not created'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox'
  Assert-Eq (Invoke-Commit $op).status 'ENQUEUED' 'same operation after release'
  $c=New-Case; $op=New-Op $c
  $h=[IO.File]::Open((Join-Path $c.state 'publisher.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $op } finally { $h.Dispose() }
  Assert-Eq $r.status 'PENDING_ENQUEUE' 'pending status'; Assert-Eq $r.code 'PUBLISHER_LOCKED' 'pending code'; Assert-True $r.canonicalCommitted 'committed'
  Assert-Eq (Get-Sha $c.canonical) $op.CandSha 'canonical committed'; Assert-True (-not [IO.File]::Exists($c.outbox)) 'no outbox'
  Assert-Eq (Read-Status $op).cause 'PUBLISHER_LOCKED' 'cause recorded'
  Assert-Eq (Invoke-Commit $op).status 'ENQUEUED' 'resume after release'; Assert-EnqueuedRows $op 2
  $c=New-Case; $op=New-Op $c; [void][IO.Directory]::CreateDirectory($op.OpDir)
  $h=[IO.File]::Open((Join-Path $op.OpDir 'operation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Commit $op } finally { $h.Dispose() }
  Assert-Eq $r.code 'OPERATION_LOCKED' 'operation lock'; Assert-True (-not [IO.File]::Exists($c.canonical)) 'canonical not created'
  Assert-True (-not [IO.File]::Exists((Join-Path $op.OpDir 'intent.json'))) 'no intent while the operation is locked'
}

Test-Step '5b Two separate processes for the same operation yield one canonical commit and no duplicate rows (contention reported as observed)' {
  $c=New-Case; $op=New-Op $c
  $pwsh=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $procs=@(); $outs=@()
  foreach($i in 1..2){
    $out=Join-Path $c.dir "child-$i.json"; $outs+=$out
    $argList=@('-NoProfile','-File',$PSCommandPath,'-SourcePath',$SourceRoot,'-EvidenceRoot',$Ev,'-ChildRequestPath',$op.A.RequestPath,'-ChildRequestSha256',$op.A.ExpectedRequestSha256,'-ChildAdmissionPath',$op.A.AdmissionPath,'-ChildAdmissionSha256',$op.A.ExpectedAdmissionSha256,'-ChildResultPath',$out)
    $procs+=Start-Process -FilePath $pwsh -ArgumentList $argList -PassThru -NoNewWindow
  }
  foreach($p in $procs){$p.WaitForExit(); Assert-Eq $p.ExitCode 0 'child exit'}
  $observed=@()
  foreach($out in $outs){
    $r=Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
    $observed+="$($r.status)/$($r.code)"
    Assert-True ($r.status -cin @('ENQUEUED','REFUSED','PENDING_ENQUEUE')) "child outcome $($r.status)/$($r.code)"
  }
  Write-Host "  observed child outcomes: $($observed -join ', ')"
  # Transient outcomes are resumed by the caller with the SAME operation (the module never retries).
  $r=Invoke-Commit $op
  for($n=0;$n -lt 6 -and $r.status -cne 'ENQUEUED';$n++){$r=Invoke-Commit $op}
  Assert-Eq $r.status 'ENQUEUED' 'settles'
  Assert-Eq (Get-Sha $c.canonical) $op.CandSha 'one canonical with the candidate bytes'
  Assert-EnqueuedRows $op 2
  Assert-Eq @(Read-Outbox $c.outbox).Count 2 'no duplicate rows'
  Assert-StateOnlyOwned $c
}

Test-Step '6 Injected enqueue write failure keeps unknown temp/sentinel files and existing evidence; only exact owned temporaries are cleaned' {
  $c=New-Case; Write-Outbox $c @((New-UnrelatedRow)); $op=New-Op $c
  $sentOutbox=Join-Path $c.state 'outbox.json.tmp-0123456789abcdef0123456789abcdef'
  $sentCanon=$c.canonical+'.tmp-fedcba9876543210fedcba9876543210'
  $sentHuman=Join-Path $c.dir 'canon\human.note'
  Write-Text $sentOutbox 'unknown outbox temp'; Write-Text $sentCanon 'unknown canonical temp'; Write-Text $sentHuman 'human'
  $outboxBefore=Get-Sha $c.outbox
  $f=Invoke-WithFault $op 'ENQUEUE_WRITE_FAIL'
  Assert-Eq $f.status 'PENDING_ENQUEUE' 'status'; Assert-Eq $f.code 'OUTBOX_WRITE_FAILED' 'code'; Assert-True $f.canonicalCommitted 'canonical committed'
  Assert-Eq (Get-Sha $c.canonical) $op.CandSha 'canonical evidence retained'
  Assert-Eq (Get-Sha $c.outbox) $outboxBefore 'outbox evidence unchanged'
  $evSha=Assert-Sidecar $op
  Assert-Eq ([IO.File]::ReadAllText($sentOutbox)) 'unknown outbox temp' 'unknown outbox temp retained'
  Assert-Eq ([IO.File]::ReadAllText($sentCanon)) 'unknown canonical temp' 'unknown canonical temp retained'
  Assert-Eq ([IO.File]::ReadAllText($sentHuman)) 'human' 'human file retained'
  Assert-Eq @(Get-Names (Join-Path $c.dir 'canon') | Where-Object {$_ -like '*.tmp-*'}).Count 1 'only the sentinel canonical temp remains'
  Assert-Eq @(Get-Names $op.EventDir | Where-Object {$_ -like '*.tmp-*'}).Count 0 'owned sidecar temporary cleaned'
  Assert-Eq (Read-Status $op).cause 'OUTBOX_WRITE_FAILED' 'cause recorded'
  $r=Invoke-Commit $op
  Assert-Eq $r.status 'ENQUEUED' 'resume'; Assert-EnqueuedRows $op 3; Assert-Eq (Assert-Sidecar $op) $evSha 'sidecar unchanged'
  Assert-Eq ([IO.File]::ReadAllText($sentCanon)) 'unknown canonical temp' 'unknown canonical temp still retained after resume'
}

# DETERMINISTIC NONCE BINDING, not live filesystem race proof. Each helper under test is the exact
# production function text (taken from its AST) with ONLY the GUID nonce expression replaced by a fixed
# literal, so the temporary name is predictable and a collision can be staged. The File.Open / Move /
# finally-delete code is the production text, unaltered; no replacement helper acts as the oracle.
function New-NonceBoundHelper {
  param([string]$Name,[string]$Nonce)
  $guidExpr="[guid]::NewGuid().ToString('N')"
  $ast=[Management.Automation.Language.Parser]::ParseFile($CommitFile,[ref]$null,[ref]$null)
  $fns=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $Name},$true))
  Assert-Eq $fns.Count 1 "$Name defined once"
  $fn=$fns[0]
  $hits=@($fn.FindAll({param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Extent.Text -ceq "[guid]::NewGuid().ToString('N')"},$true))
  Assert-Eq $hits.Count 1 "$Name has exactly one nonce expression"
  $orig=$fn.Extent.Text
  $off=$hits[0].Extent.StartOffset-$fn.Extent.StartOffset
  $literal="'$Nonce'"
  $bound=$orig.Substring(0,$off)+$literal+$orig.Substring($off+$guidExpr.Length)
  # Mechanical proof that the nonce expression is the sole substitution.
  Assert-Eq $bound.Replace($literal,$guidExpr) $orig "$Name nonce is the sole substitution"
  Assert-True (-not $bound.Contains('NewGuid')) "$Name bound text has no GUID"
  Assert-True ($bound.Contains('$made') -and $bound.Contains('[IO.File]::Delete($tmp)')) "$Name keeps the production ownership and delete code"
  # Invoked in a child scope so the production function in the test scope is never replaced.
  return [scriptblock]::Create('param($P,$B) '+$bound+"`n& '$Name' -Path `$P -Bytes `$B")
}
function Invoke-Capture {
  param([scriptblock]$Helper,[string]$Path,[byte[]]$Bytes)
  try{ & $Helper $Path $Bytes; return $null }
  catch{ $e=$_.Exception; while($e.InnerException){$e=$e.InnerException}; return $e }
}
function Get-TmpNames { param([string]$Dir) @(Get-Names $Dir | Where-Object {$_ -like '*.tmp-*'}) }

Test-Step 'Ownership: a CreateNew collision on the temporary leaves the unowned bytes; only an invocation-created temporary is cleaned' {
  $nonce='0123456789abcdef0123456789abcdef'
  $enc=[Text.UTF8Encoding]::new($false); $new=$enc.GetBytes('new bytes'); $prior=$enc.GetBytes('prior destination')
  foreach($name in @('Write-CcAtomic','Write-CcCreateNew')){
    $h=New-NonceBoundHelper $name $nonce
    $c=New-Case; $d=Join-Path $c.dir 'canon'

    # Controls: ordinary success. Atomic replaces the status record; CreateNew creates an absent target.
    $ok=Join-Path $d "$name-ok.json"
    Assert-True ($null -eq (Invoke-Capture $h $ok $new)) "$name success control"
    Assert-Eq ([IO.File]::ReadAllText($ok)) 'new bytes' "$name success writes the bytes"
    Assert-Eq @(Get-TmpNames $d).Count 0 "$name success leaves no temporary"
    if($name -ceq 'Write-CcAtomic'){
      Assert-True ($null -eq (Invoke-Capture $h $ok $prior)) 'Write-CcAtomic replace control'
      Assert-Eq ([IO.File]::ReadAllText($ok)) 'prior destination' 'Write-CcAtomic replaced the target'
      Assert-Eq @(Get-TmpNames $d).Count 0 'Write-CcAtomic replace leaves no temporary'
    }

    # Collision on the exact temporary name, destination absent.
    $dest=Join-Path $d "$name-target.json"; $sent=$dest+'.tmp-'+$nonce; $sentBytes=$enc.GetBytes('unowned sentinel bytes')
    [IO.File]::WriteAllBytes($sent,$sentBytes)
    $e=Invoke-Capture $h $dest $new
    Assert-True ($e -is [IO.IOException]) "$name collision surfaces the original I/O failure ($($e.GetType().Name))"
    Assert-True ([IO.File]::Exists($sent)) "$name sentinel still exists"
    Assert-Eq (([IO.File]::ReadAllBytes($sent)) -join ',') ($sentBytes -join ',') "$name sentinel bytes unchanged"
    Assert-True (-not [IO.File]::Exists($dest)) "$name destination stays absent"
    [IO.File]::Delete($sent)

    # Collision on the exact temporary name, destination holds prior bytes.
    $dest2=Join-Path $d "$name-target2.json"; $sent2=$dest2+'.tmp-'+$nonce
    [IO.File]::WriteAllBytes($dest2,$prior); [IO.File]::WriteAllBytes($sent2,$sentBytes)
    $e=Invoke-Capture $h $dest2 $new
    Assert-True ($e -is [IO.IOException]) "$name collision (existing destination) surfaces the original I/O failure"
    Assert-Eq (([IO.File]::ReadAllBytes($sent2)) -join ',') ($sentBytes -join ',') "$name sentinel bytes unchanged (existing destination)"
    Assert-Eq (([IO.File]::ReadAllBytes($dest2)) -join ',') ($prior -join ',') "$name prior destination bytes unchanged"

    # Failure AFTER a successful CreateNew: the invocation-created temporary is cleaned, the destination
    # and an unrelated temporary (different name) are preserved.
    $other=Join-Path $d "$name-fail.json.tmp-ffffffffffffffffffffffffffffffff"; [IO.File]::WriteAllBytes($other,$sentBytes)
    if($name -ceq 'Write-CcCreateNew'){
      $dest3=Join-Path $d "$name-fail.json"; [IO.File]::WriteAllBytes($dest3,$prior)   # the no-replace move fails
      $e=Invoke-Capture $h $dest3 $new
      Assert-True ($e -is [IO.IOException]) 'Write-CcCreateNew move failure propagates'
      Assert-Eq (([IO.File]::ReadAllBytes($dest3)) -join ',') ($prior -join ',') 'Write-CcCreateNew existing destination preserved'
    } else {
      $dest3=Join-Path $d "$name-fail.json"; [void][IO.Directory]::CreateDirectory($dest3); Write-Text (Join-Path $dest3 'keep.txt') 'keep'   # the replace move fails
      $e=Invoke-Capture $h $dest3 $new
      Assert-True ($null -ne $e) 'Write-CcAtomic move failure propagates'
      Assert-True ([IO.Directory]::Exists($dest3) -and [IO.File]::ReadAllText((Join-Path $dest3 'keep.txt')) -ceq 'keep') 'Write-CcAtomic existing destination preserved'
    }
    Assert-True (-not [IO.File]::Exists($dest3+'.tmp-'+$nonce)) "$name owned temporary cleaned after the move failure"
    Assert-Eq (([IO.File]::ReadAllBytes($other)) -join ',') ($sentBytes -join ',') "$name unrelated temporary untouched"
    Assert-True ([IO.File]::Exists($sent2)) "$name collision sentinel survives later invocations"
  }
}

Test-Step 'No execution, delivery or acknowledgement surface; dependencies unchanged; fixtures stay under EvidenceRoot' {
  foreach($f in $DepFiles){if($f -cne $CommitFile){Assert-Eq (Get-Sha $f) $DepBefore[$f] "unchanged $f"}}
  $src=[IO.File]::ReadAllText($CommitFile)
  foreach($bad in @('Start-Process','Invoke-WebRequest','Invoke-RestMethod','Invoke-Expression','Invoke-AdmittedTaskLifecycleUpdate','New-GitHubCliLifecycleTransport216','ConvertTo-SecureString','FaultPoint','SIMULATED')){
    Assert-True (-not $src.Contains($bad)) "commit source does not reference $bad"
  }
  Assert-True ($src -cnotmatch "deliveryStatus\s*=\s*'DELIVERED'") 'no row is marked DELIVERED'
  Assert-True ($src -cnotmatch 'Remove-Item|\[IO\.File\]::Delete\(\$canonical') 'no canonical deletion'
  foreach($case in 1..$script:CaseN){
    $dir=Join-Path $Ev "case$case"
    foreach($child in @(Get-ChildItem -LiteralPath $dir -Force -Recurse | ForEach-Object {$_.FullName})){
      Assert-True ($child.StartsWith($Ev+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal)) 'fixtures stay under EvidenceRoot'
    }
  }
}

$failed=@($Results | Where-Object {-not $_.ok})
Write-Json (Join-Path $Ev 'results.json') @($Results)
Write-Host ("canonical-lifecycle-create-commit: {0} passed, {1} failed (synthetic offline fixtures; not publication proof)" -f ($Results.Count-$failed.Count),$failed.Count)
if($failed.Count -gt 0){exit 1}
