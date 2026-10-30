#Requires -Version 7.6
# SYNTHETIC OFFLINE FIXTURES ONLY. Every task, packet, snapshot, sidecar, outbox row, issue and "gh" below
# is invented. The real existing CREATE enqueue boundary, durable CREATE engine and pinned gh transport run;
# the only seam is the existing injected ProcessRunner (a recording fake remote). No real gh, account,
# credential, model or network is touched. Passing proves the GitHub CREATE destination source capability
# only: it asserts no note operation, note readiness or paired delivery.
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
$ConsumeFile=Get-SourceFile 'scripts\github\consume-canonical-create-github.ps1'
$EnqueueFile=Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-create.ps1'
$HelpersFile=Get-SourceFile 'scripts\github\task-lifecycle-mirror-consumer.ps1'
$ReconcileFile=Get-SourceFile 'scripts\github\lifecycle-compat\continuity\reconcile.ps1'
$CaptureFile=Get-SourceFile 'scripts\github\lifecycle-compat\dispatch\reviewed-blocked-capture.ps1'
$TransportFile=Get-SourceFile 'scripts\github\github-cli-transport216.ps1'
$EngineFile=Get-SourceFile 'scripts\github\github-task-lifecycle.ps1'

function Get-Sha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
function Get-TextSha { param([string]$Text) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant() }
$DepFiles=@($ConsumeFile,$EnqueueFile,$HelpersFile,$ReconcileFile,$CaptureFile,$TransportFile,$EngineFile)
$DepBefore=@{}; foreach($f in $DepFiles){$DepBefore[$f]=Get-Sha $f}

# Test-scope copies are the independent oracle (Read-Outbox, Get-EventKey, strict reader, enqueue).
. $EnqueueFile
. $HelpersFile
. $ReconcileFile
. $ConsumeFile

function Write-Text { param([string]$Path,[string]$Text) [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false)) }
function Write-Json { param([string]$Path,$Obj) Write-Text $Path (ConvertTo-Json -InputObject $Obj -Depth 6) }
function Assert-True { param($Cond,[string]$Msg) if(-not $Cond){throw "ASSERT: $Msg"} }
function Assert-Eq { param($Actual,$Expected,[string]$Msg) if("$Actual" -cne "$Expected"){throw "ASSERT: $Msg (expected '$Expected', got '$Actual')"} }

$TaskId='SYNTH-TASK-1'
$DefaultSummary='Synthetic fixture summary for offline test only.'
$Title='Synthetic fixture title'
function Get-Region { param([int]$Rev,[string]$Summary=$DefaultSummary) "<!-- factory-task-status:start -->`nTask: $TaskId`nVersion: $Rev`nStatus: IN_PROGRESS`nNext action: RUN_FOCUSED_CHECKS`nSummary: $Summary`n<!-- factory-task-status:end -->" }
function Get-Body { param([int]$Rev,[string]$Summary=$DefaultSummary) "<!-- factory-task-$(Get-TextSha $TaskId) -->`n`n$(Get-Region $Rev $Summary)" }
function Get-EngineKey { param([int]$Rev,[string]$Summary=$DefaultSummary) Get-TextSha ($TaskId+'|'+$Rev+'|'+(Get-TextSha ($Title+"`n"+(Get-Region $Rev $Summary)))) }
$Marker='factory-task-'+(Get-TextSha $TaskId)

# ---- Recording fake remote behind the existing ProcessRunner seam -------------------------------------
$script:Fake=@{issues=@{};calls=[Collections.Generic.List[string]]::new();createMode='OK';nextNumber=1;readCount=0;readMutate=$null;afterCreate=$null}
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
      $v=[ordered]@{number=$n;url=($base+$n);state=$i.state;title=$i.title;body=$i.body}
      if($null -ne $f.readMutate -and $f.readMutate.at -eq $f.readCount){$v[$f.readMutate.field]=$f.readMutate.value}
      return (& $ok (ConvertTo-Json -InputObject $v -Compress))
    }
    if($a[0] -ceq 'issue' -and $a[1] -ceq 'create'){
      $f.calls.Add('CREATE')
      $bp=$a[[array]::IndexOf($a,'--body-file')+1]
      $body=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($bp))
      if($f.createMode -ceq 'FAIL_NOEFFECT'){return $fail}
      $n=$f.nextNumber; $f.nextNumber=$n+1
      $f.issues[$n]=@{title=$a[[array]::IndexOf($a,'--title')+1];body=$body;state='OPEN'}
      if($null -ne $f.afterCreate){& $f.afterCreate}
      return (& $ok ($base+$n+"`n"))
    }
    return $fail
  }.GetNewClosure()
}
function Reset-Fake {
  $script:Fake.issues.Clear(); $script:Fake.calls.Clear(); $script:Fake.createMode='OK'; $script:Fake.nextNumber=1
  $script:Fake.readCount=0; $script:Fake.readMutate=$null; $script:Fake.afterCreate=$null
}

# ---- Fixtures: real enqueue boundary produces the delivered-style CREATE pair --------------------------
function New-Row {
  param($Task,$Digest,$RunId,$Dest,$Status='AWAITING_CONTROLLER',$Attempt=0,$Delivery='PENDING',$Proof=$null,[System.Collections.IDictionary]$Extra=@{})
  $key=Get-EventKey -TaskId $Task -PayloadSha256 $Digest -RunId $RunId -Status $Status -Attempt $Attempt
  $o=[ordered]@{key=$key;taskId=$Task;payloadSha256=$Digest;runId=$RunId;destination=$Dest;status=$Status;attempt=$Attempt;deliveryStatus=$Delivery;proof=$Proof}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function New-UnrelatedRows {
  $extra=[ordered]@{updatedAt='2026-01-01T00:00:00Z';consentEligibility=$null;reconciliationSignal=$false;synthNote='unrelated metadata'}
  @(
    (New-Row 'SYNTH-OTHER' ('a'*64) 'synth-update-run:github' 'github' -Status 'FAILED' -Attempt 1 -Extra $extra),
    (New-Row 'SYNTH-TASK-1' ('c'*64) 'synth-create-7:complete:note' 'note' -Delivery 'DELIVERED' -Proof 'bytes:synthetic' -Extra @{legacy='keep'})
  )
}
function Read-RawRows {
  param([string]$Path)
  $p=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -NoEnumerate -DateKind String
  if($p -isnot [array]){$p=@($p)}
  return ,$p
}
function Get-RowJsons { param([string]$Path) $rows=Read-RawRows $Path; @($rows | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 10 -Compress }) }

$script:CaseN=0; $script:AdmN=0
function New-Case {
  param([switch]$Unrelated)
  $script:CaseN++
  Reset-Fake
  $dir=Join-Path $Ev ('case'+$script:CaseN)
  $c=@{dir=$dir;state=(Join-Path $dir 'state');temp=(Join-Path $dir 'temp');vault=(Join-Path $dir 'vault');gh=(Join-Path $dir 'fakegh.bin')}
  $c.outbox=Join-Path $c.state 'outbox.json'; $c.note=Join-Path $c.vault 'note.md'; $c.engineState=Join-Path $c.state 'github-task-lifecycle.state.json'
  foreach($d in @($c.state,$c.temp,$c.vault)){[void][IO.Directory]::CreateDirectory($d)}
  Write-Text $c.gh 'FAKE GH BINARY FIXTURE (never executed)'
  Write-Text $c.note "# Synthetic note`n<!-- factory-task:SYNTH-TASK-1:start -->`nTask: SYNTH-TASK-1`n<!-- factory-task:SYNTH-TASK-1:end -->`n"
  if($Unrelated){Write-OutboxAtomic $c.outbox (New-UnrelatedRows)}
  return $c
}
function Add-Event {
  param($Case,[int]$Revision=7,[string]$Key='synth-create-7',[string]$Summary=$DefaultSummary)
  $dir=Join-Path $Case.state ('canonical-create-'+$Key)
  $e=@{rev=$Revision;key=$Key;summary=$Summary;canonical=(Join-Path $Case.dir "canonical$Revision.json");packet=(Join-Path $Case.dir "packet$Revision.json");eventDir=$dir;event=(Join-Path $dir 'event.json');mapping=(Join-Path $dir 'mapping.json');readback=(Join-Path $dir 'readback.json')}
  Write-Json $e.canonical ([ordered]@{taskId=$TaskId;canonicalRevision=$Revision;publicTitle=$Title;publicSummary=$Summary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})
  Write-Json $e.packet ([ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId=$TaskId;canonicalRevision=$Revision;eventType='CREATE';idempotencyKey=$Key;publicTitle=$Title;publicSummary=$Summary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS';destinations=@('github','note')})
  $pin=$null; if([IO.File]::Exists($Case.outbox)){$pin=Get-Sha $Case.outbox}
  $a=@{TaskId=$TaskId;CanonicalRevision=$Revision;CanonicalPath=$e.canonical;ExpectedCanonicalSha256=(Get-Sha $e.canonical);PacketPath=$e.packet;ExpectedPacketSha256=(Get-Sha $e.packet)
       ConsumerPath=$HelpersFile;ExpectedConsumerSha256=(Get-Sha $HelpersFile);ReconcilePath=$ReconcileFile;ExpectedReconcileSha256=(Get-Sha $ReconcileFile);ExpectedCaptureSha256=(Get-Sha $CaptureFile)
       StateDir=$Case.state;OutboxPath=$Case.outbox;ExpectedOutboxSha256=$pin}
  $res=Invoke-CanonicalLifecycleCreateEnqueue @a
  Assert-Eq $res.status 'ENQUEUED' 'fixture enqueue'
  return $e
}
function Get-Keys {
  param($E)
  $c=Read-LifecycleJson $E.canonical
  $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))
  $k=@{}
  foreach($d in @('github','note')){$k[$d]=Get-EventKey -TaskId $TaskId -PayloadSha256 $digest -RunId ($E.key+':create:'+$d) -Status 'AWAITING_CONTROLLER' -Attempt 0}
  return $k
}
function Set-Mut {
  param($Obj,[hashtable]$Mut)
  foreach($k in $Mut.Keys){ if($Mut[$k] -is [string] -and $Mut[$k] -ceq '__REMOVE__'){[void]$Obj.Remove($k)}else{$Obj[$k]=$Mut[$k]} }
}
function New-Admission {
  param($Case,$E,[string]$Recovery='INITIAL',[hashtable]$Rel=@{},[hashtable]$Rev=@{},[hashtable]$Nat=@{},[hashtable]$All=@{})
  $script:AdmN=$script:AdmN+1
  $sfx=[string]$script:AdmN
  $engSha=$null; if([IO.File]::Exists($Case.engineState)){$engSha=Get-Sha $Case.engineState}
  $cfg=[ordered]@{repo='hakanduyar/software-factory';markerNamespace='factory-task'}
  $hashes=[ordered]@{packetSha256=(Get-Sha $E.packet);canonicalSha256=(Get-Sha $E.canonical);createEventSha256=(Get-Sha $E.event);engineSha256=(Get-Sha $EngineFile);consumerSha256=(Get-Sha $ConsumeFile);lifecycleHelpersSha256=(Get-Sha $HelpersFile);transportSha256=(Get-Sha $TransportFile);reconcileSha256=(Get-Sha $ReconcileFile);captureSha256=(Get-Sha $CaptureFile);executableSha256=(Get-Sha $Case.gh)}
  $tail=[ordered]@{stateDir=$Case.state;outboxPath=$Case.outbox;outboxSha256=(Get-Sha $Case.outbox);engineStateSha256=$engSha;mappingPath=$E.mapping;readbackPath=$E.readback;configuration=$cfg;recovery=$Recovery}
  $review=[ordered]@{schema='CanonicalCreateGitHubIndependentReview/v1';decision='ADMIT_SCOPED_CREATE_GITHUB';reviewer='synthetic-test-reviewer'}
  foreach($k in $hashes.Keys){$review[$k]=$hashes[$k]}
  foreach($k in $tail.Keys){$review[$k]=$tail[$k]}
  Set-Mut $review $All; Set-Mut $review $Rev
  $reviewPath=Join-Path $Case.dir "review$sfx.json"; Write-Json $reviewPath $review
  $native=[ordered]@{schema='CanonicalCreateGitHubNativeRequest/v1';action='CREATE_GITHUB'}
  foreach($k in $hashes.Keys){$native[$k]=$hashes[$k]}
  foreach($k in $tail.Keys){$native[$k]=$tail[$k]}
  $native['reviewSha256']=Get-Sha $reviewPath
  Set-Mut $native $All; Set-Mut $native $Nat
  $nativePath=Join-Path $Case.dir "native$sfx.json"; Write-Json $nativePath $native
  $ref={param($p) [ordered]@{path=$p;sha256=(Get-Sha $p)}}
  $release=[ordered]@{schema='CanonicalCreateGitHubRelease/v1'
    packet=(& $ref $E.packet);canonical=(& $ref $E.canonical);createEvent=(& $ref $E.event);engine=(& $ref $EngineFile);consumer=(& $ref $ConsumeFile);lifecycleHelpers=(& $ref $HelpersFile)
    transport=(& $ref $TransportFile);reconcile=(& $ref $ReconcileFile);capture=(& $ref $CaptureFile);executable=(& $ref $Case.gh);review=(& $ref $reviewPath);nativeRequest=(& $ref $nativePath)
    stateDir=$Case.state;outboxPath=$Case.outbox;outboxSha256=$tail.outboxSha256;engineStateSha256=$engSha;mappingPath=$E.mapping;readbackPath=$E.readback
    canonicalLease=($E.canonical+'.lock');publisherLease=(Join-Path $Case.state 'publisher.lock');tempRoot=$Case.temp;configuration=$cfg;recovery=$Recovery}
  Set-Mut $release $All; Set-Mut $release $Rel
  $releasePath=Join-Path $Case.dir "release$sfx.json"; Write-Json $releasePath $release
  return @{release=$releasePath;relSha=(Get-Sha $releasePath);revSha=(Get-Sha $reviewPath);natSha=(Get-Sha $nativePath);review=$reviewPath;native=$nativePath}
}
function Invoke-Consumer {
  param($Case,$E,[string]$Recovery='INITIAL',[hashtable]$Rel=@{},[hashtable]$Rev=@{},[hashtable]$Nat=@{},[hashtable]$All=@{},[hashtable]$Args2=@{},[scriptblock]$Prep,[scriptblock]$Tamper)
  if($null -ne $Prep){& $Prep}
  $adm=New-Admission $Case $E $Recovery $Rel $Rev $Nat $All
  if($null -ne $Tamper){& $Tamper $adm}
  $script:Fake.calls.Clear(); $script:Fake.readCount=0
  $a=@{ReleasePath=$adm.release;ExpectedReleaseSha256=$adm.relSha;ExpectedReviewSha256=$adm.revSha;ExpectedNativeRequestSha256=$adm.natSha;ProcessRunner=(New-FakeRunner)}
  foreach($k in $Args2.Keys){$a[$k]=$Args2[$k]}
  $res=@(Invoke-AdmittedCanonicalCreateGitHub @a)
  Assert-Eq $res.Count 1 'one result object'
  return $res[0]
}
function Get-Calls { $script:Fake.calls -join ',' }
function Get-State {
  param($Case,$E)
  @{outbox=(Get-Sha $Case.outbox);rows=(Get-RowJsons $Case.outbox);note=(Get-Sha $Case.note)
    mapping=$(if([IO.File]::Exists($E.mapping)){Get-Sha $E.mapping}else{'absent'});readback=$(if([IO.File]::Exists($E.readback)){Get-Sha $E.readback}else{'absent'})
    engine=$(if([IO.File]::Exists($Case.engineState)){Get-Sha $Case.engineState}else{'absent'});event=(Get-Sha $E.event);canonical=(Get-Sha $E.canonical);packet=(Get-Sha $E.packet)}
}
function Assert-SameState {
  param($A,$B,[string]$Msg)
  foreach($k in @('outbox','note','mapping','readback','engine','event','canonical','packet')){Assert-Eq $B[$k] $A[$k] "$Msg $k unchanged"}
}
function Assert-NoteIntact { param($Case,$Before,[string]$Msg) Assert-Eq (Get-Sha $Case.note) $Before.note "$Msg external note file untouched" }
function Assert-RefusedClean {
  param($Case,$E,$Before,$R,[string]$Code,[string]$Msg)
  Assert-Eq $R.status 'REFUSED' "$Msg status"; Assert-Eq $R.code $Code "$Msg code"
  Assert-Eq $R.githubAck $false "$Msg no ack"; Assert-Eq $R.noteAck $false "$Msg no note ack"
  Assert-Eq (Get-Calls) '' "$Msg no runner/transport call"
  Assert-SameState $Before (Get-State $Case $E) $Msg
}
function Assert-AckedGithubOnly {
  # The GitHub row went PENDING/null -> DELIVERED/proof(path+sha of readback); nothing else changed.
  param($Case,$E,$Before,[string]$Msg)
  $k=Get-Keys $E
  $after=Read-RawRows $Case.outbox; $beforeRows=@($Before.rows | ForEach-Object { ConvertFrom-Json -InputObject $_ -DateKind String })
  Assert-Eq @($after).Count @($beforeRows).Count "$Msg row count"
  $proof='canonical-create-readback:sha256='+(Get-Sha $E.readback)+';path='+$E.readback
  for($i=0;$i -lt @($after).Count;$i++){
    if($after[$i].key -ceq $k.github){
      Assert-Eq $after[$i].deliveryStatus 'DELIVERED' "$Msg github delivered"
      Assert-Eq $after[$i].proof $proof "$Msg proof names readback path+sha"
      $b=$beforeRows[$i]; $b.deliveryStatus='DELIVERED'; $b.proof=$proof
      Assert-Eq (ConvertTo-Json -InputObject $after[$i] -Depth 10 -Compress) (ConvertTo-Json -InputObject $b -Depth 10 -Compress) "$Msg github row fields/order otherwise identical"
    } else {
      Assert-Eq (ConvertTo-Json -InputObject $after[$i] -Depth 10 -Compress) $Before.rows[$i] "$Msg row $i (incl. note row) JSON and property order unchanged"
    }
  }
  [void](Read-Outbox $Case.outbox)
  Assert-NoteIntact $Case $Before $Msg
}
function New-DeliveredCase {
  $c=New-Case -Unrelated; $e=Add-Event $c
  $r=Invoke-Consumer $c $e
  Assert-Eq $r.code 'READBACK_ACK' 'delivered fixture'
  return @{c=$c;e=$e}
}

# ---- Test-only scoped writer fault: a global alias outranks the function the consumer loads from the pinned
# reconcile, so production needs no hook. It acts only for the armed exact outbox target; restored in finally.
$script:FaultTarget=$null; $script:FaultMode='THROW'
$script:OriginalWriter=(Get-Command -Name Write-OutboxAtomic -CommandType Function).ScriptBlock
function Invoke-CreateGhFaultWriter {
  param([string]$OutboxPath,[object[]]$Events)
  if($null -ne $script:FaultTarget -and $OutboxPath -ceq $script:FaultTarget){
    if($script:FaultMode -ceq 'WRITE_THEN_THROW'){& $script:OriginalWriter $OutboxPath $Events}
    throw 'SYNTHETIC_WRITER_FAULT'
  }
  & $script:OriginalWriter $OutboxPath $Events
}
function Invoke-WithWriterFault {
  param([string]$Target,[string]$Mode,[scriptblock]$Body)
  $script:FaultTarget=$Target; $script:FaultMode=$Mode
  Set-Alias -Name Write-OutboxAtomic -Value Invoke-CreateGhFaultWriter -Scope Global -Force
  try{& $Body}finally{
    Remove-Item -Path Alias:\Write-OutboxAtomic -ErrorAction SilentlyContinue
    $script:FaultTarget=$null
  }
}

$script:Passed=@()
function Pass { param([string]$Name) $script:Passed+=$Name; Write-Host "PASS $Name" }

# ======================================================================================================
# AC1: valid delivered-style CREATE pair; FIND none -> CREATE -> engine READ -> wrapper READ.
$c=New-Case -Unrelated; $e=Add-Event $c
$before=Get-State $c $e; $keys=Get-Keys $e
$r=Invoke-Consumer $c $e
Assert-Eq $r.status 'DELIVERED' 'AC1 status'; Assert-Eq $r.code 'READBACK_ACK' 'AC1 code'
Assert-Eq $r.githubAck $true 'AC1 github ack'; Assert-Eq $r.noteAck $false 'AC1 note never acked'; Assert-Eq $r.automaticRetry $false 'AC1 no auto retry'
Assert-Eq (Get-Calls) 'FIND,CREATE,READ,READ' 'AC1 FIND none, CREATE once, engine READ, independent wrapper READ'
Assert-Eq $script:Fake.issues[1].body (Get-Body 7) 'AC1 remote body is exactly the managed content'
Assert-AckedGithubOnly $c $e $before 'AC1'
Assert-Eq (Get-Sha $e.canonical) $before.canonical 'AC1 canonical unchanged'; Assert-Eq (Get-Sha $e.event) $before.event 'AC1 sidecar unchanged'
# Exact existing 6-field UPDATE mapping, byte-exact.
$mapText='{"taskId":"SYNTH-TASK-1","repo":"hakanduyar/software-factory","issueNumber":1,"url":"https://github.com/hakanduyar/software-factory/issues/1","stableMarker":"'+$Marker+'","canonicalRevision":7}'
Assert-Eq ([IO.File]::ReadAllText($e.mapping)) $mapText 'AC1 mapping bytes'
$map=Read-LifecycleJson $e.mapping
Assert-LifecycleKeys $map @('taskId','repo','issueNumber','url','stableMarker','canonicalRevision')
$rb=Read-LifecycleJson $e.readback
Assert-LifecycleKeys $rb @('schema','taskId','canonicalRevision','packetSha256','createEventSha256','outboxKey','runId','payloadSha256','engineEventKey','mappingSha256','issueUrl','issueNumber','stableMarker','observedTitle','observedRegionSha256','observedBodySha256')
Assert-Eq $rb.schema 'CanonicalCreateGitHubReadback/v1' 'AC1 receipt schema'
Assert-Eq $rb.packetSha256 (Get-Sha $e.packet) 'AC1 receipt packet sha'; Assert-Eq $rb.createEventSha256 (Get-Sha $e.event) 'AC1 receipt sidecar sha'
Assert-Eq $rb.outboxKey $keys.github 'AC1 receipt outbox key'; Assert-Eq $rb.runId 'synth-create-7:create:github' 'AC1 receipt runId'
Assert-Eq $rb.engineEventKey (Get-EngineKey 7) 'AC1 engine key correlates, distinct from outbox key'
Assert-True ($rb.engineEventKey -cne $rb.outboxKey) 'AC1 engine key distinct from outbox key'
Assert-Eq $rb.mappingSha256 (Get-Sha $e.mapping) 'AC1 receipt mapping sha'; Assert-Eq $rb.issueNumber 1 'AC1 receipt issue number'
Assert-Eq $rb.observedTitle $Title 'AC1 observed title'; Assert-Eq $rb.observedRegionSha256 (Get-TextSha (Get-Region 7)) 'AC1 observed region'
Assert-Eq $rb.observedBodySha256 (Get-TextSha (Get-Body 7)) 'AC1 observed body'
Pass 'AC1 delivered pair -> mapping/readback + one GitHub DELIVERED row'

# ======================================================================================================
# AC2: exact current-state replay is zero transport; stale INITIAL pin refuses; adoption never duplicates.
$d=New-DeliveredCase; $c=$d.c; $e=$d.e
$snap=Get-State $c $e
$r=Invoke-Consumer $c $e
Assert-Eq $r.status 'DELIVERED' 'replay status'; Assert-Eq $r.code 'REPLAY_ACKED' 'replay code'; Assert-Eq $r.githubAck $true 'replay ack'
Assert-Eq (Get-Calls) '' 'replay zero transport'
Assert-SameState $snap (Get-State $c $e) 'replay'
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
Assert-Eq $r.code 'REPLAY_ACKED' 'replay under RECONCILE_MISSING'; Assert-Eq (Get-Calls) '' 'replay RECONCILE zero transport'
$r=Invoke-Consumer $c $e -All @{engineStateSha256=$null}
Assert-RefusedClean $c $e $snap $r 'ENGINE_STATE_DRIFT' 'stale INITIAL engine pin'
$r=Invoke-Consumer $c $e -All @{outboxSha256=('0'*64)}
Assert-RefusedClean $c $e $snap $r 'OUTBOX_DRIFT' 'stale outbox pin'
Pass 'AC2 exact replay zero transport; stale pins refuse'

# Tampered/missing proof refuses and preserves history.
foreach($t in @('REWRITE_READBACK','DELETE_MAPPING','ROW_PROOF')){
  $d=New-DeliveredCase; $c=$d.c; $e=$d.e
  switch($t){
    'REWRITE_READBACK'{Write-Text $e.readback '{"tampered":true}'}
    'DELETE_MAPPING'{[IO.File]::Delete($e.mapping)}
    'ROW_PROOF'{
      $rows=@(Read-Outbox $c.outbox); $k=Get-Keys $e
      foreach($row in $rows){if($row.key -ceq $k.github){$row.proof='readback:forged'}}
      Write-OutboxAtomic $c.outbox $rows
    }
  }
  $snap=Get-State $c $e
  $r=Invoke-Consumer $c $e
  Assert-RefusedClean $c $e $snap $r 'PROOF_INVALID' "tamper $t"
}
Pass 'AC2 tampered or missing proof refuses'

# Engine FIND adopts an existing matching issue: no CREATE.
$c=New-Case -Unrelated; $e=Add-Event $c
$script:Fake.issues[5]=@{title=$Title;body=(Get-Body 7);state='OPEN'}; $script:Fake.nextNumber=6
$before=Get-State $c $e
$r=Invoke-Consumer $c $e
Assert-Eq $r.code 'READBACK_ACK' 'adopt ack'; Assert-Eq (Get-Calls) 'FIND,READ,READ' 'adopt: FIND, engine READ, wrapper READ, never CREATE'
Assert-Eq (Read-LifecycleJson $e.mapping).issueNumber 5 'adopted issue number'
Assert-AckedGithubOnly $c $e $before 'adopt'
Pass 'AC2 adoption without duplicate CREATE'

# Actual read mismatch never ACKs; then explicit recovery converges without a second CREATE.
foreach($mut in @(@{field='title';value='Other synthetic title';code='READBACK_MISMATCH'},
                  @{field='state';value='CLOSED';code='READBACK_MISMATCH'},
                  @{field='body';value=(Get-Body 6);code='READBACK_MISMATCH'},
                  @{field='number';value=99;code='GITHUB_READ_FAILED'})){
  $c=New-Case -Unrelated; $e=Add-Event $c
  $before=Get-State $c $e
  $script:Fake.readMutate=@{at=2;field=$mut.field;value=$mut.value}
  $r=Invoke-Consumer $c $e
  Assert-Eq $r.status 'PENDING' "mismatch $($mut.field) status"; Assert-Eq $r.code $mut.code "mismatch $($mut.field) code"; Assert-Eq $r.githubAck $false "mismatch $($mut.field) no ack"
  Assert-Eq (Get-Calls) 'FIND,CREATE,READ,READ' "mismatch $($mut.field) calls"
  $now=Get-State $c $e
  Assert-Eq $now.outbox $before.outbox "mismatch $($mut.field) outbox untouched"; Assert-Eq $now.mapping 'absent' "mismatch $($mut.field) no mapping"; Assert-Eq $now.readback 'absent' "mismatch $($mut.field) no readback"
  Assert-True ($now.engine -cne 'absent') "mismatch $($mut.field) engine state retained"
  # Stale INITIAL (engine already acted) refuses; explicit RECONCILE_MISSING completes with READs only.
  $r=Invoke-Consumer $c $e -Recovery 'INITIAL'
  Assert-Eq $r.code 'EXPLICIT_RECOVERY_REQUIRED' "mismatch $($mut.field) INITIAL after engine"; Assert-Eq (Get-Calls) '' "mismatch $($mut.field) INITIAL zero calls"
  $script:Fake.readMutate=$null
  $r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
  Assert-Eq $r.code 'READBACK_ACK' "recover $($mut.field)"; Assert-Eq (Get-Calls) 'READ,READ' "recover $($mut.field) no CREATE"
  Assert-AckedGithubOnly $c $e $before "recover $($mut.field)"
}
Pass 'AC2 read mismatch never ACKs; RECONCILE_MISSING converges without CREATE'

# UNKNOWN_SEND stays pending; retained uncertainty never leads to a second CREATE; MAPPED_NEEDS_UPDATE is not success.
$c=New-Case -Unrelated; $e=Add-Event $c
$before=Get-State $c $e
$script:Fake.createMode='FAIL_NOEFFECT'
$r=Invoke-Consumer $c $e
Assert-Eq $r.status 'PENDING' 'unknown send status'; Assert-Eq $r.code 'CREATE_INVALID_RESPONSE' 'unknown send code'; Assert-Eq $r.githubAck $false 'unknown send no ack'
Assert-Eq (Get-Calls) 'FIND,CREATE' 'unknown send calls'
Assert-Eq (Get-Sha $c.outbox) $before.outbox 'unknown send outbox untouched'; Assert-True ([IO.File]::Exists($c.engineState)) 'unknown send engine state retained'
$script:Fake.createMode='OK'
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
Assert-Eq $r.status 'REFUSED' 'ambiguous no match status'; Assert-Eq $r.code 'AMBIGUOUS_NO_MATCH' 'ambiguous no match code'
Assert-Eq (Get-Calls) 'FIND' 'ambiguous no match: FIND only, no second CREATE'
$r=Invoke-Consumer $c $e -Recovery 'INITIAL'
Assert-Eq $r.code 'EXPLICIT_RECOVERY_REQUIRED' 'INITIAL after ambiguity'; Assert-Eq (Get-Calls) '' 'INITIAL after ambiguity zero calls'
$script:Fake.issues[1]=@{title=$Title;body=(Get-Body 7);state='OPEN'}; $script:Fake.nextNumber=2
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
Assert-Eq $r.code 'READBACK_ACK' 'ambiguity resolved by FIND adoption'; Assert-Eq (Get-Calls) 'FIND,READ,READ' 'ambiguity adoption has no CREATE'
Assert-AckedGithubOnly $c $e $before 'ambiguity adoption'

$d=New-DeliveredCase; $c=$d.c; $e7=$d.e
$e8=Add-Event $c -Revision 8 -Key 'synth-create-8' -Summary 'Second synthetic summary for offline test.'
$snap8=Get-State $c $e8
$r=Invoke-Consumer $c $e8
Assert-Eq $r.status 'PENDING' 'needs update status'; Assert-Eq $r.code 'NEEDS_UPDATE' 'needs update code'; Assert-Eq $r.engineStatus 'MAPPED_NEEDS_UPDATE' 'engine status reported'
Assert-Eq $r.githubAck $false 'needs update is not success'; Assert-Eq (Get-Calls) 'READ' 'needs update: one READ, no CREATE/EDIT'
Assert-Eq (Get-Sha $c.outbox) $snap8.outbox 'needs update outbox untouched'; Assert-Eq (Get-State $c $e8).mapping 'absent' 'needs update no mapping'
Pass 'AC2 UNKNOWN_SEND / ambiguity / MAPPED_NEEDS_UPDATE stay pending, never a second CREATE'

# ======================================================================================================
# AC3: controlled failures after the engine already returned MAPPED.
# (a) ACK write fails: mapping/readback persisted, row pending, then explicit recovery needs zero transport.
$c=New-Case -Unrelated; $e=Add-Event $c
$before=Get-State $c $e
$r=Invoke-WithWriterFault $c.outbox 'THROW' { Invoke-Consumer $c $e }
Assert-Eq $r.status 'PENDING_LOCAL_ACK' 'ack failure status'; Assert-Eq $r.code 'OUTBOX_WRITE_FAILED' 'ack failure code'; Assert-Eq $r.githubAck $false 'ack failure no github ack'
Assert-Eq (Get-Calls) 'FIND,CREATE,READ,READ' 'ack failure calls'
$now=Get-State $c $e
Assert-Eq $now.outbox $before.outbox 'ack failure outbox untouched'; Assert-True ($now.mapping -cne 'absent' -and $now.readback -cne 'absent') 'ack failure mapping+readback retained'
Assert-True ($now.engine -cne 'absent') 'ack failure engine state retained'
$r=Invoke-Consumer $c $e -Recovery 'INITIAL'
Assert-Eq $r.code 'EXPLICIT_RECOVERY_REQUIRED' 'stale INITIAL never resends'; Assert-Eq (Get-Calls) '' 'stale INITIAL zero calls'
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
Assert-Eq $r.code 'READBACK_ACK' 'persisted proof completes'; Assert-Eq (Get-Calls) '' 'persisted proof route has zero transport'; Assert-Eq $r.source 'PERSISTED_PROOF' 'persisted route named'
Assert-AckedGithubOnly $c $e $before 'recover from persisted proof'

# (b) writer wrote then threw: actual outbox readback proves the ACK (retained).
$c=New-Case -Unrelated; $e=Add-Event $c
$before=Get-State $c $e
$r=Invoke-WithWriterFault $c.outbox 'WRITE_THEN_THROW' { Invoke-Consumer $c $e }
Assert-Eq $r.status 'DELIVERED' 'retained ack status'; Assert-Eq $r.code 'READBACK_ACK_RETAINED' 'retained ack code'
Assert-AckedGithubOnly $c $e $before 'retained ack'

# (c) mapping persistence fails (obstruction created during CREATE): no duplicate CREATE on recovery.
$c=New-Case -Unrelated; $e=Add-Event $c
$before=Get-State $c $e
$obstruct=$e.mapping
$script:Fake.afterCreate={[void][IO.Directory]::CreateDirectory($obstruct)}.GetNewClosure()
$r=Invoke-Consumer $c $e
Assert-Eq $r.status 'PENDING_LOCAL_ACK' 'mapping failure status'; Assert-Eq $r.code 'MAPPING_PERSIST_FAILED' 'mapping failure code'; Assert-Eq $r.githubAck $false 'mapping failure no ack'
Assert-Eq (Get-Sha $c.outbox) $before.outbox 'mapping failure outbox untouched'; Assert-True (-not [IO.File]::Exists($e.readback)) 'mapping failure no readback'
Assert-True ([IO.Directory]::Exists($obstruct)) 'obstruction untouched'
[IO.Directory]::Delete($obstruct); $script:Fake.afterCreate=$null
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
Assert-Eq $r.code 'READBACK_ACK' 'recover after mapping failure'; Assert-Eq (Get-Calls) 'READ,READ' 'recovery: engine READ + wrapper READ, no CREATE'
Assert-AckedGithubOnly $c $e $before 'recover after mapping failure'

# (d) unrelated outbox drift during the engine call: never merged, no ACK; new admission then completes.
$c=New-Case -Unrelated; $e=Add-Event $c
$before=Get-State $c $e
$script:Fake.afterCreate={
  $rows=@(Read-Outbox $c.outbox); $rows+=(New-Row 'SYNTH-DRIFT' ('d'*64) 'synth-drift:github' 'github')
  Write-OutboxAtomic $c.outbox $rows
}.GetNewClosure()
$r=Invoke-Consumer $c $e
Assert-Eq $r.status 'PENDING_LOCAL_ACK' 'drift status'; Assert-Eq $r.code 'OUTBOX_DRIFT' 'drift code'; Assert-Eq $r.githubAck $false 'drift no ack'
$k=Get-Keys $e
$drifted=Read-RawRows $c.outbox
Assert-Eq $drifted.Count 5 'drift row retained, nothing merged or removed'
Assert-Eq (@($drifted | Where-Object {$_.key -ceq $k.github})[0].deliveryStatus) 'PENDING' 'drift github row still pending'
$script:Fake.afterCreate=$null
$before2=Get-State $c $e
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
Assert-Eq $r.code 'READBACK_ACK' 'drift recovery'; Assert-Eq (Get-Calls) '' 'drift recovery from persisted proof'
Assert-AckedGithubOnly $c $e $before2 'drift recovery'
Pass 'AC3 failures after MAPPED are truthful and converge without duplicate CREATE'

# ======================================================================================================
# AC3: refusals leave no unintended runner call or mutation. Each case is fresh.
function Test-Refusal {
  # Prep runs after the fixture exists and before the admission is built (it may change the outbox).
  # Late returns extra release/review/native overrides that need the case paths. Tamper runs after the
  # admission documents exist, so only the actual current state differs from what they pin.
  param([string]$Name,[string]$Code,[hashtable]$Rel=@{},[hashtable]$Rev=@{},[hashtable]$Nat=@{},[hashtable]$All=@{},[hashtable]$Args2=@{},[scriptblock]$Prep,[scriptblock]$Late,[scriptblock]$Tamper,[switch]$ExpectLease)
  $c=New-Case -Unrelated; $e=Add-Event $c
  if($null -ne $Prep){& $Prep $c $e}
  if($null -ne $Late){$All=@{}+(& $Late $c $e)}
  $before=Get-State $c $e
  $tw=$null; $box=@{snap=$null}
  # A tamper changes the actual state the admission no longer pins; the refusal must then leave that
  # post-tamper state exactly as found.
  if($null -ne $Tamper){$tw={param($adm) & $Tamper $adm $c $e; $box.snap=Get-State $c $e}.GetNewClosure()}
  # The real enqueue boundary used by Add-Event opens canonical.lock with OpenOrCreate, so the lease file
  # legitimately exists before the consumer runs. Baseline it (existence + bytes) just before invocation.
  $lease=$e.canonical+'.lock'
  $leaseBefore=$(if([IO.File]::Exists($lease)){Get-Sha $lease}else{'absent'})
  $r=Invoke-Consumer $c $e -Rel $Rel -Rev $Rev -Nat $Nat -All $All -Args2 $Args2 -Tamper $tw
  if($null -ne $Tamper){$before=$box.snap}
  Assert-RefusedClean $c $e $before $r $Code $Name
  if(-not $ExpectLease){
    $leaseAfter=$(if([IO.File]::Exists($lease)){Get-Sha $lease}else{'absent'})
    Assert-Eq $leaseAfter $leaseBefore "$Name canonical lease unchanged by refused invocation"
  }
}
Test-Refusal 'wrong release pin' 'RELEASE_DRIFT' -Args2 @{ExpectedReleaseSha256=('1'*64)}
Test-Refusal 'missing review pin' 'ADMISSION_PIN_MISSING' -Args2 @{ExpectedReviewSha256=''}
Test-Refusal 'review pin differs from release ref' 'ADMISSION_BINDING' -Args2 @{ExpectedReviewSha256=('2'*64)}
Test-Refusal 'native pin differs from release ref' 'ADMISSION_BINDING' -Args2 @{ExpectedNativeRequestSha256=('2'*64)}
Test-Refusal 'review file tampered after release' 'REVIEW_DRIFT' -Tamper {param($adm,$c,$e) [IO.File]::AppendAllText($adm.review,' ')}
Test-Refusal 'review capture binding' 'REVIEW_BINDING' -Rev @{captureSha256=('4'*64)}
Test-Refusal 'review extra field' 'REVIEW_BINDING' -Rev @{extra='x'}
Test-Refusal 'review wrong decision' 'REVIEW_BINDING' -Rev @{decision='ADMIT'}
Test-Refusal 'native packet binding' 'NATIVE_BINDING' -Nat @{packetSha256=('3'*64)}
Test-Refusal 'native wrong action' 'NATIVE_BINDING' -Nat @{action='UPDATE'}
Test-Refusal 'native wrong review binding' 'NATIVE_BINDING' -Nat @{reviewSha256=('7'*64)}
Test-Refusal 'release extra field' 'RELEASE_INVALID' -Rel @{extra='x'}
Test-Refusal 'release missing field' 'RELEASE_INVALID' -Rel @{tempRoot='__REMOVE__'}
Test-Refusal 'release type coerced hash' 'RELEASE_INVALID' -Rel @{outboxSha256=12345}
Test-Refusal 'release recovery unsupported' 'RELEASE_INVALID' -Rel @{recovery='AUTO'}
Test-Refusal 'config repo' 'CONFIG_INVALID' -All @{configuration=[ordered]@{repo='other/repo';markerNamespace='factory-task'}}
Test-Refusal 'config extra key' 'CONFIG_INVALID' -All @{configuration=[ordered]@{repo='hakanduyar/software-factory';markerNamespace='factory-task';x='y'}}
Test-Refusal 'consumer not this file' 'SOURCE_BINDING' -Rel @{consumer=[ordered]@{path=$HelpersFile;sha256=(Get-Sha $HelpersFile)}}
Test-Refusal 'reconcile not accepted' 'RECONCILE_DRIFT' -Rel @{reconcile=[ordered]@{path=$ReconcileFile;sha256=('5'*64)}}
Test-Refusal 'capture not accepted' 'CAPTURE_DRIFT' -Rel @{capture=[ordered]@{path=$CaptureFile;sha256=('6'*64)}}
Test-Refusal 'capture not the reconcile sibling' 'SOURCE_BINDING' -Rel @{capture=[ordered]@{path=$HelpersFile;sha256=(Get-Sha $CaptureFile)}}
Test-Refusal 'unsafe output path' 'OUTPUT_BINDING' -Late {param($c,$e) @{mappingPath=(Join-Path $c.state 'elsewhere.json')}}
Test-Refusal 'output outside event directory' 'OUTPUT_BINDING' -Late {param($c,$e) @{readbackPath=(Join-Path $c.dir 'readback-outside.json')}}
Test-Refusal 'executable drift' 'EXECUTABLE_DRIFT' -Tamper {param($adm,$c,$e) [IO.File]::AppendAllText($c.gh,'x')}
Test-Refusal 'unrelated outbox drift' 'OUTBOX_DRIFT' -Tamper {param($adm,$c,$e)
  $rows=@(Read-Outbox $c.outbox); $rows+=(New-Row 'SYNTH-DRIFT' ('d'*64) 'synth-drift:github' 'github'); Write-OutboxAtomic $c.outbox $rows
}
Test-Refusal 'NO_RETRY excluded row' 'EXCLUDED_NO_RETRY' -Prep {param($c,$e)
  $rows=@(Read-Outbox $c.outbox); $k=Get-Keys $e
  foreach($row in $rows){if($row.key -ceq $k.github){$row | Add-Member -NotePropertyName retryPolicy -NotePropertyValue 'NO_RETRY'}}
  Write-OutboxAtomic $c.outbox $rows
}
Test-Refusal 'wrong tuple metadata' 'EVENT_CONFLICT' -Prep {param($c,$e)
  $rows=@(Read-Outbox $c.outbox); $k=Get-Keys $e
  foreach($row in $rows){if($row.key -ceq $k.github){$row.packetRef.sha256=('9'*64)}}
  Write-OutboxAtomic $c.outbox $rows
}
Test-Refusal 'note row not PENDING' 'NOTE_ROW_STATE' -Prep {param($c,$e)
  $rows=@(Read-Outbox $c.outbox); $k=Get-Keys $e
  foreach($row in $rows){if($row.key -ceq $k.note){$row.deliveryStatus='DELIVERED'; $row.proof='bytes:synthetic'}}
  Write-OutboxAtomic $c.outbox $rows
}
Test-Refusal 'github row missing' 'ROW_MISSING' -Prep {param($c,$e)
  $k=Get-Keys $e
  Write-OutboxAtomic $c.outbox @(@(Read-Outbox $c.outbox) | Where-Object {$_.key -cne $k.github})
}
Test-Refusal 'sidecar tampered' 'CREATEEVENT_DRIFT' -Tamper {param($adm,$c,$e) [IO.File]::AppendAllText($e.event,' ')}
Test-Refusal 'engine state appears after admission' 'ENGINE_STATE_DRIFT' -Tamper {param($adm,$c,$e) Write-Text $c.engineState '{"schema":1,"tasks":{},"events":{}}'}
Test-Refusal 'recovery without event' 'RECOVERY_WITHOUT_EVENT' -ExpectLease -Rel @{recovery='RECONCILE_MISSING'} -Rev @{recovery='RECONCILE_MISSING'} -Nat @{recovery='RECONCILE_MISSING'}
Test-Refusal 'reparse tempRoot' 'REPARSE_REFUSED' -Late {param($c,$e)
  $j=Join-Path $c.dir 'temp-junction'
  New-Item -ItemType Junction -Path $j -Target $c.temp | Out-Null
  @{tempRoot=$j}
}
Pass 'AC3 refusals leave no runner call or mutation'

# Held locks: explicit unacknowledged results, rows preserved, no transport call, no engine state.
foreach($lock in @('canonical','publisher','engine')){
  $c=New-Case -Unrelated; $e=Add-Event $c
  $paths=@{canonical=($e.canonical+'.lock');publisher=(Join-Path $c.state 'publisher.lock');engine=(Join-Path $c.state 'github-task-lifecycle.lock')}
  $wants=@{canonical='CANONICAL_LOCKED';publisher='PUBLISHER_LOCKED';engine='LOCKED'}
  $before=Get-State $c $e
  $held=[IO.File]::Open($paths[$lock],[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Consumer $c $e }finally{ $held.Dispose() }
  $want=$wants[$lock]
  Assert-Eq $r.status 'REFUSED' "$lock lock status"; Assert-Eq $r.code $want "$lock lock code"; Assert-Eq $r.githubAck $false "$lock lock no ack"
  Assert-Eq (Get-Calls) '' "$lock lock no transport call"
  Assert-SameState $before (Get-State $c $e) "$lock lock"
}
Pass 'AC3 held canonical/publisher/engine locks refuse without effects'

# Production-shaped corruption of the delivered outbox shape is refused by the unchanged reader contract.
$d=New-DeliveredCase; $c=$d.c; $e=$d.e
$r=Invoke-Consumer $c $e
Assert-Eq $r.code 'REPLAY_ACKED' 'existing reader accepts delivered pair and replay is idempotent'
Pass 'AC1 existing reader accepts rows'

# ======================================================================================================
# AC4: the exported mapping is the exact existing 6-field UPDATE schema and its URL is public; no note
# operation, readiness or paired DONE is asserted. Note rows/files were compared unchanged in every case above.
$d=New-DeliveredCase; $c=$d.c; $e=$d.e
$map=Read-LifecycleJson $e.mapping
Assert-LifecycleKeys $map @('taskId','repo','issueNumber','url','stableMarker','canonicalRevision')
Assert-True ($map.url -cmatch '^https://github\.com/hakanduyar/software-factory/issues/[1-9][0-9]{0,9}\z') 'mapping url is the public issue URL'
Assert-Eq $map.stableMarker $Marker 'mapping marker'; Assert-Eq $map.canonicalRevision 7 'mapping revision'
Pass 'AC4 mapping exports exact existing 6-field schema'

# ======================================================================================================
foreach($f in $DepFiles){Assert-Eq (Get-Sha $f) $DepBefore[$f] "source file unchanged by tests: $f"}
Write-Host ("ALL PASSED: "+$script:Passed.Count+" groups")
