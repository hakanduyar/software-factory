#Requires -Version 7.6
# SYNTHETIC OFFLINE FIXTURES ONLY. Every task, candidate, packet, admission, review, native request, outbox row,
# issue and "gh" below is invented and lives under EvidenceRoot. This composes two ALREADY ACCEPTED source
# components and nothing else: the real canonical CREATE writer (commit-canonical-lifecycle-create.ps1, which
# itself invokes the real CREATE enqueue) and the real GitHub CREATE destination consumer
# (consume-canonical-create-github.ps1, which drives the real durable CREATE engine and pinned gh transport).
# The only seam is the existing injected ProcessRunner (a recording fake remote): no real gh, account,
# credential, model, vault, process or network is touched. The review/native/admission documents are explicit
# synthetic test inputs, not production grants. Passing proves the writer -> consumer composition for the
# GitHub destination only: it asserts no note write/ACK, no Git delivery, no live ACK and no Factory DONE.
# Case A: writer-produced chain -> consumer delivers once -> consumer-only replay is zero transport.
# Case B: writer-produced chain -> admission frozen -> canonical bytes change -> consumer refuses, zero calls.
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
$CommitFile=Get-SourceFile 'scripts\github\commit-canonical-lifecycle-create.ps1'
$EnqueueFile=Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-create.ps1'
$ConsumeFile=Get-SourceFile 'scripts\github\consume-canonical-create-github.ps1'
$HelpersFile=Get-SourceFile 'scripts\github\task-lifecycle-mirror-consumer.ps1'
$ReconcileFile=Get-SourceFile 'scripts\github\lifecycle-compat\continuity\reconcile.ps1'
$CaptureFile=Get-SourceFile 'scripts\github\lifecycle-compat\dispatch\reviewed-blocked-capture.ps1'
$TransportFile=Get-SourceFile 'scripts\github\github-cli-transport216.ps1'
$EngineFile=Get-SourceFile 'scripts\github\github-task-lifecycle.ps1'

function Get-Sha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
function Get-TextSha { param([string]$Text) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant() }
$DepFiles=@($CommitFile,$EnqueueFile,$ConsumeFile,$HelpersFile,$ReconcileFile,$CaptureFile,$TransportFile,$EngineFile)
$DepBefore=[ordered]@{}; foreach($f in $DepFiles){$DepBefore[$f]=Get-Sha $f}

# Test-scope copies are the independent oracle (reader, key formula, strict reader). The enqueue boundary is NOT
# loaded here: it runs only through the real writer.
. $CommitFile
. $HelpersFile
. $ReconcileFile
. $ConsumeFile

function Write-Text { param([string]$Path,[string]$Text) [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false)) }
function Write-Json { param([string]$Path,$Obj) Write-Text $Path (ConvertTo-Json -InputObject $Obj -Depth 6) }
function Assert-True { param($Cond,[string]$Msg) if(-not $Cond){throw "ASSERT: $Msg"} }
function Assert-Eq { param($Actual,$Expected,[string]$Msg) if("$Actual" -cne "$Expected"){throw "ASSERT: $Msg (expected '$Expected', got '$Actual')"} }

$TaskId='SYNTH-TASK-1'
$Revision=7
$IdemKey='synth-create-7'
$DefaultSummary='Synthetic fixture summary for offline test only.'
$Title='Synthetic fixture title'
function Get-Region { param([int]$Rev,[string]$Summary=$DefaultSummary) "<!-- factory-task-status:start -->`nTask: $TaskId`nVersion: $Rev`nStatus: IN_PROGRESS`nNext action: RUN_FOCUSED_CHECKS`nSummary: $Summary`n<!-- factory-task-status:end -->" }
function Get-Body { param([int]$Rev,[string]$Summary=$DefaultSummary) "<!-- factory-task-$(Get-TextSha $TaskId) -->`n`n$(Get-Region $Rev $Summary)" }
function Get-EngineKey { param([int]$Rev,[string]$Summary=$DefaultSummary) Get-TextSha ($TaskId+'|'+$Rev+'|'+(Get-TextSha ($Title+"`n"+(Get-Region $Rev $Summary)))) }
$Marker='factory-task-'+(Get-TextSha $TaskId)

# ---- Recording fake remote behind the existing ProcessRunner seam (same shape the consumer tests use) ----
$script:Fake=@{issues=@{};calls=[Collections.Generic.List[string]]::new();nextNumber=1;readCount=0}
function New-FakeRunner {
  $f=$script:Fake
  return {
    param($e,$a,$d,$o,$m)
    $ok={param($s) [pscustomobject]@{exitCode=0;timedOut=$false;stdout=[string]$s;stdoutTruncated=$false;stderrTruncated=$false}}
    $fail=[pscustomobject]@{exitCode=1;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false}
    $base='https://github.com/hakanduyar/software-factory/issues/'
    if($a[0] -ceq 'api'){
      $f.calls.Add('FIND')
      $items=@()
      foreach($k in @($f.issues.Keys | Sort-Object)){
        $i=$f.issues[$k]
        $items+=ConvertTo-Json -InputObject ([ordered]@{number=[int]$k;html_url=($base+$k);state=$(if($i.state -ceq 'OPEN'){'open'}else{'closed'});body=$i.body}) -Compress
      }
      return (& $ok ('[['+($items -join ',')+']]'))
    }
    if($a[0] -ceq 'issue' -and $a[1] -ceq 'view'){
      $f.calls.Add('READ')
      $f.readCount=$f.readCount+1
      $n=[int]$a[2]
      if(-not $f.issues.ContainsKey($n)){return $fail}
      $i=$f.issues[$n]
      return (& $ok (ConvertTo-Json -InputObject ([ordered]@{number=$n;url=($base+$n);state=$i.state;title=$i.title;body=$i.body}) -Compress))
    }
    if($a[0] -ceq 'issue' -and $a[1] -ceq 'create'){
      $f.calls.Add('CREATE')
      $bp=$a[[array]::IndexOf($a,'--body-file')+1]
      $body=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($bp))
      $n=$f.nextNumber; $f.nextNumber=$n+1
      $f.issues[$n]=@{title=$a[[array]::IndexOf($a,'--title')+1];body=$body;state='OPEN'}
      return (& $ok ($base+$n+"`n"))
    }
    return $fail
  }.GetNewClosure()
}
function Reset-Fake { $script:Fake.issues.Clear(); $script:Fake.calls.Clear(); $script:Fake.nextNumber=1; $script:Fake.readCount=0 }
function Get-Calls { $script:Fake.calls -join ',' }

# ---- Fixtures --------------------------------------------------------------------------------------
function New-Row {
  param($Task,$Digest,$RunId,$Dest,$Status='AWAITING_CONTROLLER',$Attempt=0,$Delivery='PENDING',$Proof=$null,[System.Collections.IDictionary]$Extra=@{})
  $key=Get-EventKey -TaskId $Task -PayloadSha256 $Digest -RunId $RunId -Status $Status -Attempt $Attempt
  $o=[ordered]@{key=$key;taskId=$Task;payloadSha256=$Digest;runId=$RunId;destination=$Dest;status=$Status;attempt=$Attempt;deliveryStatus=$Delivery;proof=$Proof}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function New-UnrelatedRows {
  @(
    (New-Row 'SYNTH-OTHER' ('a'*64) 'synth-update-run:github' 'github' -Status 'FAILED' -Attempt 1 -Extra ([ordered]@{updatedAt='2026-01-01T00:00:00Z';consentEligibility=$null;reconciliationSignal=$false;synthNote='unrelated metadata'})),
    (New-Row 'SYNTH-OTHER-2' ('c'*64) 'synth-other-run:complete:note' 'note' -Delivery 'DELIVERED' -Proof 'bytes:synthetic' -Extra @{legacy='keep'})
  )
}
function Read-RawRows {
  param([string]$Path)
  $p=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -NoEnumerate -DateKind String
  if($p -isnot [array]){$p=@($p)}
  return ,$p
}
function Get-RowJsons { param([string]$Path) $rows=Read-RawRows $Path; @($rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 10 -Compress }) }

function New-Chain {
  # A fresh, separately owned directory tree; pre-existing unrelated rows make the pin and ordering meaningful.
  param([string]$Name)
  Reset-Fake
  $dir=Join-Path $Ev $Name
  $c=@{dir=$dir;state=(Join-Path $dir 'state');canon=(Join-Path $dir 'canon');temp=(Join-Path $dir 'temp');vault=(Join-Path $dir 'vault');gh=(Join-Path $dir 'fakegh.bin')}
  $c.outbox=Join-Path $c.state 'outbox.json'; $c.note=Join-Path $c.vault 'note.md'; $c.engineState=Join-Path $c.state 'github-task-lifecycle.state.json'
  $c.canonical=Join-Path $c.canon 'canonical.json'
  foreach($d in @($c.state,$c.canon,$c.temp,$c.vault)){[void][IO.Directory]::CreateDirectory($d)}
  Write-Text $c.gh 'FAKE GH BINARY FIXTURE (never executed)'
  Write-Text $c.note "# Synthetic note`n<!-- factory-task:SYNTH-TASK-1:start -->`nTask: SYNTH-TASK-1`n<!-- factory-task:SYNTH-TASK-1:end -->`n"
  Write-OutboxAtomic $c.outbox (New-UnrelatedRows)
  return $c
}

function Invoke-RealWriter {
  # Pre-approved synthetic candidate + separately pinned request and admission; the REAL writer runs once.
  param($C,[string]$OpId)
  $cand=[ordered]@{taskId=$TaskId;canonicalRevision=$Revision;publicTitle=$Title;publicSummary=$DefaultSummary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}
  $pk=[ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId=$TaskId;canonicalRevision=$Revision;eventType='CREATE';idempotencyKey=$IdemKey;publicTitle=$Title;publicSummary=$DefaultSummary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS';destinations=@('github','note')}
  $candPath=Join-Path $C.dir 'candidate.json'; $pktPath=Join-Path $C.dir 'packet.json'
  $reqPath=Join-Path $C.dir 'writer-request.json'; $admPath=Join-Path $C.dir 'writer-admission.json'
  Write-Json $candPath $cand; Write-Json $pktPath $pk
  $ref={ param($p) [ordered]@{path=$p;sha256=(Get-Sha $p)} }
  $rq=[ordered]@{schema='CanonicalCreateCommitRequest/v1';operationId=$OpId;taskId=$TaskId;canonicalRevision=$Revision;canonicalPath=$C.canonical
    candidateRef=(& $ref $candPath);packetRef=(& $ref $pktPath);enqueueRef=(& $ref $EnqueueFile);consumerRef=(& $ref $HelpersFile);reconcileRef=(& $ref $ReconcileFile);captureRef=(& $ref $CaptureFile)
    stateDir=$C.state;outboxPath=$C.outbox;expectedOutboxSha256=(Get-Sha $C.outbox);operationDir=(Join-Path $C.state ('create-commit-'+$OpId))}
  Write-Json $reqPath $rq
  # The admission is written only after the request bytes are frozen; it names the request hash, never the reverse.
  $ad=[ordered]@{schema='CanonicalCreateCommitAdmission/v1';decision='ADMIT_SCOPED_CANONICAL_CREATE';reviewer='synthetic-independent-reviewer';requestSha256=(Get-Sha $reqPath);operationId=$OpId;taskId=$TaskId;canonicalRevision=$Revision
    candidateSha256=(Get-Sha $candPath);packetSha256=(Get-Sha $pktPath);enqueueSha256=(Get-Sha $EnqueueFile);consumerSha256=(Get-Sha $HelpersFile);reconcileSha256=(Get-Sha $ReconcileFile);captureSha256=(Get-Sha $CaptureFile)}
  Write-Json $admPath $ad
  $a=@{RequestPath=$reqPath;ExpectedRequestSha256=(Get-Sha $reqPath);AdmissionPath=$admPath;ExpectedAdmissionSha256=(Get-Sha $admPath)}
  $res=@(Invoke-CanonicalLifecycleCreateCommit @a)
  Assert-Eq $res.Count 1 'writer returns one result object'
  Write-Text (Join-Path $C.dir 'writer-result.json') (ConvertTo-Json -InputObject $res[0] -Depth 6)
  $eventDir=Join-Path $C.state ('canonical-create-'+$IdemKey)
  $e=@{canonical=$C.canonical;packet=$pktPath;eventDir=$eventDir;event=(Join-Path $eventDir 'event.json');mapping=(Join-Path $eventDir 'mapping.json');readback=(Join-Path $eventDir 'readback.json')}
  return @{result=$res[0];e=$e;candPath=$candPath;candSha=(Get-Sha $candPath);candBytes=[IO.File]::ReadAllBytes($candPath);packetSha=(Get-Sha $pktPath)}
}

function Get-Keys {
  param($E)
  $c=Read-LifecycleJson $E.canonical
  $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))
  $k=@{digest=$digest}
  foreach($d in @('github','note')){$k[$d]=Get-EventKey -TaskId $TaskId -PayloadSha256 $digest -RunId ($IdemKey+':create:'+$d) -Status 'AWAITING_CONTROLLER' -Attempt 0}
  return $k
}

function Assert-WriterOutput {
  # The writer's own contract, observed on the ACTUAL artifacts it produced (not re-derived by a second enqueue).
  param($C,$W,[string[]]$UnrelatedBefore)
  $r=$W.result; $e=$W.e
  Assert-Eq $r.status 'ENQUEUED' 'writer status'; Assert-Eq $r.code 'ENQUEUED_VERIFIED' 'writer code'; Assert-True $r.canonicalCommitted 'writer committed'
  Assert-Eq (Get-Sha $C.canonical) $W.candSha 'canonical sha equals candidate sha'
  Assert-Eq ([IO.File]::ReadAllBytes($C.canonical) -join ',') ($W.candBytes -join ',') 'canonical bytes equal candidate bytes'
  Assert-True ([IO.File]::Exists($e.event)) 'actual sidecar exists'
  $ev=Read-LifecycleJson $e.event
  Assert-LifecycleKeys $ev @('schema','taskId','canonicalVersion','publicTitle','publicSummary','publicStatus','nextAction')
  Assert-Eq $ev.schema 'GitHubCreateEvent/v1' 'sidecar schema'; Assert-Eq $ev.canonicalVersion $Revision 'sidecar revision'
  Assert-True (-not [IO.File]::Exists($e.mapping) -and -not [IO.File]::Exists($e.readback)) 'writer produced no mapping/readback'
  Assert-True (-not [IO.File]::Exists($C.engineState)) 'writer touched no engine state'
  $k=Get-Keys $e
  Assert-Eq ($r.keys -join '|') ($k.github+'|'+$k.note) 'writer result keys'
  $rows=Read-RawRows $C.outbox
  Assert-Eq @($rows).Count 4 'two unrelated rows + exactly two appended rows'
  for($i=0;$i -lt 2;$i++){Assert-Eq (ConvertTo-Json -InputObject $rows[$i] -Depth 10 -Compress) $UnrelatedBefore[$i] "unrelated row $i unchanged by writer"}
  Assert-Eq $rows[2].key $k.github 'github row appended first'; Assert-Eq $rows[3].key $k.note 'note row appended second'
  $evSha=Get-Sha $e.event
  foreach($d in @('github','note')){
    $m=@($rows | Where-Object {$_.key -ceq $k[$d]}); Assert-Eq $m.Count 1 "exactly one $d row"
    $row=$m[0]
    Assert-Eq @($row.PSObject.Properties.Name).Count 13 "$d row field count"
    Assert-Eq $row.deliveryStatus 'PENDING' "$d PENDING"; Assert-True ($null -eq $row.proof) "$d proof null"
    Assert-Eq $row.status 'AWAITING_CONTROLLER' "$d status"; Assert-Eq $row.attempt 0 "$d attempt"; Assert-Eq $row.eventType 'CREATE' "$d eventType"
    Assert-Eq $row.runId ($IdemKey+':create:'+$d) "$d runId"; Assert-Eq $row.payloadSha256 $k.digest "$d digest"; Assert-Eq $row.destination $d "$d destination"
    Assert-Eq $row.canonicalRef.path $C.canonical "$d canonicalRef path"; Assert-Eq $row.canonicalRef.sha256 $W.candSha "$d canonicalRef sha"
    Assert-Eq $row.packetRef.path $e.packet "$d packetRef path"; Assert-Eq $row.packetRef.sha256 $W.packetSha "$d packetRef sha"
    Assert-Eq $row.createEventRef.path $e.event "$d createEventRef path"; Assert-Eq $row.createEventRef.sha256 $evSha "$d createEventRef sha"
  }
  [void](Read-Outbox $C.outbox)
}

function New-Admission {
  # Strict consumer release/review/native documents bound to the ACTUAL writer artifacts and CURRENT outbox/engine bytes.
  param($C,$E,[string]$Recovery='INITIAL',[string]$Tag='1')
  $engSha=$null; if([IO.File]::Exists($C.engineState)){$engSha=Get-Sha $C.engineState}
  $cfg=[ordered]@{repo='hakanduyar/software-factory';markerNamespace='factory-task'}
  $hashes=[ordered]@{packetSha256=(Get-Sha $E.packet);canonicalSha256=(Get-Sha $E.canonical);createEventSha256=(Get-Sha $E.event);engineSha256=(Get-Sha $EngineFile);consumerSha256=(Get-Sha $ConsumeFile);lifecycleHelpersSha256=(Get-Sha $HelpersFile);transportSha256=(Get-Sha $TransportFile);reconcileSha256=(Get-Sha $ReconcileFile);captureSha256=(Get-Sha $CaptureFile);executableSha256=(Get-Sha $C.gh)}
  $tail=[ordered]@{stateDir=$C.state;outboxPath=$C.outbox;outboxSha256=(Get-Sha $C.outbox);engineStateSha256=$engSha;mappingPath=$E.mapping;readbackPath=$E.readback;configuration=$cfg;recovery=$Recovery}
  $review=[ordered]@{schema='CanonicalCreateGitHubIndependentReview/v1';decision='ADMIT_SCOPED_CREATE_GITHUB';reviewer='synthetic-test-reviewer'}
  foreach($k in $hashes.Keys){$review[$k]=$hashes[$k]}
  foreach($k in $tail.Keys){$review[$k]=$tail[$k]}
  $reviewPath=Join-Path $C.dir "review$Tag.json"; Write-Json $reviewPath $review
  $native=[ordered]@{schema='CanonicalCreateGitHubNativeRequest/v1';action='CREATE_GITHUB'}
  foreach($k in $hashes.Keys){$native[$k]=$hashes[$k]}
  foreach($k in $tail.Keys){$native[$k]=$tail[$k]}
  $native['reviewSha256']=Get-Sha $reviewPath
  $nativePath=Join-Path $C.dir "native$Tag.json"; Write-Json $nativePath $native
  $ref={param($p) [ordered]@{path=$p;sha256=(Get-Sha $p)}}
  $release=[ordered]@{schema='CanonicalCreateGitHubRelease/v1'
    packet=(& $ref $E.packet);canonical=(& $ref $E.canonical);createEvent=(& $ref $E.event);engine=(& $ref $EngineFile);consumer=(& $ref $ConsumeFile);lifecycleHelpers=(& $ref $HelpersFile)
    transport=(& $ref $TransportFile);reconcile=(& $ref $ReconcileFile);capture=(& $ref $CaptureFile);executable=(& $ref $C.gh);review=(& $ref $reviewPath);nativeRequest=(& $ref $nativePath)
    stateDir=$C.state;outboxPath=$C.outbox;outboxSha256=$tail.outboxSha256;engineStateSha256=$engSha;mappingPath=$E.mapping;readbackPath=$E.readback
    canonicalLease=($E.canonical+'.lock');publisherLease=(Join-Path $C.state 'publisher.lock');tempRoot=$C.temp;configuration=$cfg;recovery=$Recovery}
  $releasePath=Join-Path $C.dir "release$Tag.json"; Write-Json $releasePath $release
  return @{release=$releasePath;relSha=(Get-Sha $releasePath);revSha=(Get-Sha $reviewPath);natSha=(Get-Sha $nativePath)}
}
function Invoke-ConsumerWith {
  # Real consumer, existing deterministic ProcessRunner fake. Pins are those of the supplied (possibly frozen) admission.
  param($C,$Adm,[string]$ResultName)
  $script:Fake.calls.Clear(); $script:Fake.readCount=0
  $a=@{ReleasePath=$Adm.release;ExpectedReleaseSha256=$Adm.relSha;ExpectedReviewSha256=$Adm.revSha;ExpectedNativeRequestSha256=$Adm.natSha;ProcessRunner=(New-FakeRunner)}
  $res=@(Invoke-AdmittedCanonicalCreateGitHub @a)
  Assert-Eq $res.Count 1 'one consumer result object'
  Write-Text (Join-Path $C.dir ($ResultName+'.json')) (ConvertTo-Json -InputObject $res[0] -Depth 6)
  return $res[0]
}
function Get-State {
  param($C,$E)
  @{outbox=(Get-Sha $C.outbox);rows=(Get-RowJsons $C.outbox);note=(Get-Sha $C.note)
    mapping=$(if([IO.File]::Exists($E.mapping)){Get-Sha $E.mapping}else{'absent'});readback=$(if([IO.File]::Exists($E.readback)){Get-Sha $E.readback}else{'absent'})
    engine=$(if([IO.File]::Exists($C.engineState)){Get-Sha $C.engineState}else{'absent'});event=(Get-Sha $E.event);canonical=(Get-Sha $E.canonical);packet=(Get-Sha $E.packet)}
}
function Assert-SameState {
  param($A,$B,[string]$Msg)
  foreach($k in @('outbox','note','mapping','readback','engine','event','canonical','packet')){Assert-Eq $B[$k] $A[$k] "$Msg $k unchanged"}
  Assert-Eq ($B.rows -join "`n") ($A.rows -join "`n") "$Msg rows unchanged"
}

$script:Passed=@()
function Pass { param([string]$Name) $script:Passed+=$Name; Write-Host "PASS $Name" }

# ======================================================================================================
# CASE A: real writer -> real GitHub consumer (one synthetic delivery) -> consumer-only replay.
$ca=New-Chain 'caseA'
$unrelatedA=Get-RowJsons $ca.outbox
$noteBeforeA=Get-Sha $ca.note
$wa=Invoke-RealWriter $ca 'opA'
Assert-WriterOutput $ca $wa $unrelatedA
$ea=$wa.e; $ka=Get-Keys $ea
$afterWriter=Get-State $ca $ea
Assert-Eq $afterWriter.note $noteBeforeA 'writer did not touch the external note file'

$admA=New-Admission $ca $ea 'INITIAL' 'A1'
$ra=Invoke-ConsumerWith $ca $admA 'consumer-result-A1'
Assert-Eq $ra.status 'DELIVERED' 'A status'; Assert-Eq $ra.code 'READBACK_ACK' 'A code'
Assert-Eq $ra.githubAck $true 'A github ack'; Assert-Eq $ra.noteAck $false 'A note never acked'; Assert-Eq $ra.automaticRetry $false 'A no automatic retry'
Assert-Eq (Get-Calls) 'FIND,CREATE,READ,READ' 'A exactly one synthetic create with engine and independent wrapper readback'
Assert-Eq @($script:Fake.issues.Keys).Count 1 'A exactly one synthetic issue'
Assert-Eq $script:Fake.issues[1].title $Title 'A remote title'
Assert-Eq $script:Fake.issues[1].body (Get-Body $Revision) 'A remote body is exactly the managed content for the canonical identity/revision'
Assert-True ($script:Fake.issues[1].body.Contains("<!-- $Marker -->")) 'A remote body carries the stable marker'
Assert-Eq $ra.issueNumber 1 'A issue number'; Assert-Eq $ra.outboxKey $ka.github 'A result names the writer-produced github key'

# Mapping + readback validate against the emitted result and the actual artifacts.
$map=Read-LifecycleJson $ea.mapping
Assert-LifecycleKeys $map @('taskId','repo','issueNumber','url','stableMarker','canonicalRevision')
Assert-Eq $map.taskId $TaskId 'A mapping task'; Assert-Eq $map.canonicalRevision $Revision 'A mapping revision'; Assert-Eq $map.stableMarker $Marker 'A mapping marker'
Assert-Eq $map.issueNumber 1 'A mapping issue number'; Assert-Eq $map.url $ra.issueUrl 'A mapping url equals emitted url'
$rb=Read-LifecycleJson $ea.readback
Assert-LifecycleKeys $rb @('schema','taskId','canonicalRevision','packetSha256','createEventSha256','outboxKey','runId','payloadSha256','engineEventKey','mappingSha256','issueUrl','issueNumber','stableMarker','observedTitle','observedRegionSha256','observedBodySha256')
Assert-Eq $rb.schema 'CanonicalCreateGitHubReadback/v1' 'A readback schema'
Assert-Eq $rb.taskId $TaskId 'A readback task'; Assert-Eq $rb.canonicalRevision $Revision 'A readback revision'; Assert-Eq $rb.stableMarker $Marker 'A readback marker'
Assert-Eq $rb.packetSha256 (Get-Sha $ea.packet) 'A readback packet sha'; Assert-Eq $rb.createEventSha256 (Get-Sha $ea.event) 'A readback sidecar sha'
Assert-Eq $rb.outboxKey $ka.github 'A readback outbox key'; Assert-Eq $rb.runId ($IdemKey+':create:github') 'A readback runId'; Assert-Eq $rb.payloadSha256 $ka.digest 'A readback payload digest'
Assert-Eq $rb.engineEventKey (Get-EngineKey $Revision) 'A readback engine key'
Assert-Eq $rb.mappingSha256 (Get-Sha $ea.mapping) 'A readback mapping sha'; Assert-Eq $rb.mappingSha256 $ra.mappingSha256 'A readback names emitted mapping sha'
Assert-Eq (Get-Sha $ea.readback) $ra.readbackSha256 'A emitted readback sha equals the actual file'
Assert-Eq $rb.issueUrl $ra.issueUrl 'A readback url equals emitted url'; Assert-Eq $rb.issueNumber $ra.issueNumber 'A readback issue number equals emitted'
Assert-Eq $rb.observedTitle $Title 'A observed title'; Assert-Eq $rb.observedRegionSha256 (Get-TextSha (Get-Region $Revision)) 'A observed region'
Assert-Eq $rb.observedBodySha256 (Get-TextSha $script:Fake.issues[1].body) 'A observed body is the actual remote body'

# Exactly the selected GitHub row changed: PENDING/null -> DELIVERED/proof(path+sha of readback); everything else identical.
$proof='canonical-create-readback:sha256='+(Get-Sha $ea.readback)+';path='+$ea.readback
$after=Read-RawRows $ca.outbox
Assert-Eq @($after).Count 4 'A row count unchanged'
$beforeRows=@($afterWriter.rows | ForEach-Object { ConvertFrom-Json -InputObject $_ -DateKind String })
for($i=0;$i -lt 4;$i++){
  if($after[$i].key -ceq $ka.github){
    Assert-Eq $after[$i].deliveryStatus 'DELIVERED' 'A github DELIVERED'
    Assert-Eq $after[$i].proof $proof 'A proof names readback path+sha'
    $b=$beforeRows[$i]; $b.deliveryStatus='DELIVERED'; $b.proof=$proof
    Assert-Eq (ConvertTo-Json -InputObject $after[$i] -Depth 10 -Compress) (ConvertTo-Json -InputObject $b -Depth 10 -Compress) 'A github row otherwise identical, same property order'
  } else {
    Assert-Eq (ConvertTo-Json -InputObject $after[$i] -Depth 10 -Compress) $afterWriter.rows[$i] "A row $i JSON and property order unchanged"
  }
}
$noteRow=@($after | Where-Object {$_.key -ceq $ka.note})[0]
Assert-Eq $noteRow.deliveryStatus 'PENDING' 'A note row remains PENDING'; Assert-True ($null -eq $noteRow.proof) 'A note row proof remains null'
Assert-Eq (Get-Sha $ca.note) $noteBeforeA 'A external note file untouched'
Assert-Eq (Get-Sha $ca.canonical) $wa.candSha 'A canonical bytes unchanged'
Assert-Eq (Get-Sha $ea.event) $afterWriter.event 'A sidecar unchanged'; Assert-Eq (Get-Sha $ea.packet) $afterWriter.packet 'A packet unchanged'
[void](Read-Outbox $ca.outbox)

# Consumer ONLY again (never the writer), with explicitly CURRENT outbox/engine pins: zero transport, no duplicate synthetic write.
$settled=Get-State $ca $ea
$issuesBody=$script:Fake.issues[1].body
foreach($rec in @('INITIAL','RECONCILE_MISSING')){
  $adm2=New-Admission $ca $ea $rec ('A2'+$rec)
  $r2=Invoke-ConsumerWith $ca $adm2 ('consumer-result-A2-'+$rec)
  Assert-Eq $r2.status 'DELIVERED' "A replay $rec status"; Assert-Eq $r2.code 'REPLAY_ACKED' "A replay $rec code"; Assert-Eq $r2.githubAck $true "A replay $rec ack"; Assert-Eq $r2.noteAck $false "A replay $rec note not acked"
  Assert-Eq (Get-Calls) '' "A replay $rec makes zero transport calls"
  Assert-Eq @($script:Fake.issues.Keys).Count 1 "A replay $rec no duplicate synthetic issue"
  Assert-Eq $script:Fake.issues[1].body $issuesBody "A replay $rec remote unchanged"
  Assert-SameState $settled (Get-State $ca $ea) "A replay $rec"
}
Pass 'A writer-produced chain delivered once by the real GitHub consumer; consumer-only replay is zero transport and byte-stable'

# ======================================================================================================
# CASE B: separately owned writer chain; consumer admission frozen; canonical bytes change before the consumer.
$cb=New-Chain 'caseB'
$unrelatedB=Get-RowJsons $cb.outbox
$wb=Invoke-RealWriter $cb 'opB'
Assert-WriterOutput $cb $wb $unrelatedB
$eb=$wb.e
$admB=New-Admission $cb $eb 'INITIAL' 'B1'
# The admission is now frozen against the writer's canonical. Change it (still valid JSON of the same shape).
$tampered=[ordered]@{taskId=$TaskId;canonicalRevision=$Revision;publicTitle=$Title;publicSummary='Tampered after admission, synthetic.';publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'}
Write-Json $cb.canonical $tampered
$tamperedSha=Get-Sha $cb.canonical
Assert-True ($tamperedSha -cne $wb.candSha) 'B canonical bytes actually changed'
$beforeB=Get-State $cb $eb
$rb2=Invoke-ConsumerWith $cb $admB 'consumer-result-B1'
Assert-Eq $rb2.status 'REFUSED' 'B status'; Assert-Eq $rb2.code 'CANONICAL_DRIFT' 'B code names the writer-bound canonical pin'
Assert-Eq $rb2.githubAck $false 'B no github ack'; Assert-Eq $rb2.noteAck $false 'B no note ack'
Assert-Eq (Get-Calls) '' 'B zero fake-runner calls'
Assert-Eq $script:Fake.readCount 0 'B zero reads'; Assert-Eq @($script:Fake.issues.Keys).Count 0 'B no remote issue'
Assert-SameState $beforeB (Get-State $cb $eb) 'B refusal'
Assert-Eq (Get-Sha $cb.canonical) $tamperedSha 'B changed canonical preserved, not restored or overwritten'
$rowsB=Read-RawRows $cb.outbox
foreach($row in @($rowsB | Where-Object {$_.runId -clike 'synth-create-7:create:*'})){
  Assert-Eq $row.deliveryStatus 'PENDING' 'B own rows remain PENDING'; Assert-True ($null -eq $row.proof) 'B own rows proof remains null'
}
Assert-True (-not [IO.File]::Exists($eb.mapping) -and -not [IO.File]::Exists($eb.readback) -and -not [IO.File]::Exists($cb.engineState)) 'B no mapping, readback or engine state'
Pass 'B canonical change after frozen admission is refused with zero calls, no ACK and every artifact preserved'

# ======================================================================================================
foreach($f in $DepFiles){Assert-Eq (Get-Sha $f) $DepBefore[$f] "source file unchanged by tests: $f"}
$summary=[ordered]@{sourceRoot=$SourceRoot;sourcePinsBefore=$DepBefore;sourcePinsAfter=([ordered]@{});groups=$script:Passed}
foreach($f in $DepFiles){$summary.sourcePinsAfter[$f]=Get-Sha $f}
Write-Text (Join-Path $Ev 'summary.json') (ConvertTo-Json -InputObject $summary -Depth 6)
Write-Host ("ALL PASSED: "+$script:Passed.Count+" groups")
