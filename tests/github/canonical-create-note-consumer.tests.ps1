#Requires -Version 7.6
# SYNTHETIC OFFLINE FIXTURES ONLY. Every task, packet, snapshot, sidecar, outbox row, issue, receipt and note
# below is invented. The real existing CREATE enqueue boundary runs; the GitHub DELIVERED mapping/readback/row
# fixture is built here independently from the documented ABI (no GitHub consumer, engine, transport, gh,
# process, account, credential, model, vault or network is touched). Passing proves the NOTE CREATE destination
# source capability only: it asserts no publication, no Obsidian sync and no Factory task DONE.
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
$ConsumeFile=Get-SourceFile 'scripts\github\consume-canonical-create-note.ps1'
$GhFile=Get-SourceFile 'scripts\github\consume-canonical-create-github.ps1'
$EnqueueFile=Get-SourceFile 'scripts\github\enqueue-canonical-lifecycle-create.ps1'
$HelpersFile=Get-SourceFile 'scripts\github\task-lifecycle-mirror-consumer.ps1'
$ReconcileFile=Get-SourceFile 'scripts\github\lifecycle-compat\continuity\reconcile.ps1'
$CaptureFile=Get-SourceFile 'scripts\github\lifecycle-compat\dispatch\reviewed-blocked-capture.ps1'

function Get-Sha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
function Get-TextSha { param([string]$Text) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant() }
function Get-BytesSha { param([byte[]]$B) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($B)).ToLowerInvariant() }
function Get-Utf8 { param([string]$T) [Text.UTF8Encoding]::new($false).GetBytes($T) }
$DepFiles=@($ConsumeFile,$GhFile,$EnqueueFile,$HelpersFile,$ReconcileFile,$CaptureFile)
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
$DefUrl='https://github.com/hakanduyar/software-factory/issues/1'
$Marker='factory-task-'+(Get-TextSha $TaskId)
function Get-Region { param([int]$Rev,[string]$Summary=$DefaultSummary) "<!-- factory-task-status:start -->`nTask: $TaskId`nVersion: $Rev`nStatus: IN_PROGRESS`nNext action: RUN_FOCUSED_CHECKS`nSummary: $Summary`n<!-- factory-task-status:end -->" }
function Get-Body { param([int]$Rev,[string]$Summary=$DefaultSummary) "<!-- factory-task-$(Get-TextSha $TaskId) -->`n`n$(Get-Region $Rev $Summary)" }
function Get-EngineKey { param([int]$Rev,[string]$Summary=$DefaultSummary) Get-TextSha ($TaskId+'|'+$Rev+'|'+(Get-TextSha ($Title+"`n"+(Get-Region $Rev $Summary)))) }

function Get-CandidateText {
  param([int]$Rev=7,[string]$Url=$DefUrl,[string]$Status='IN_PROGRESS',[string]$Task=$TaskId,[switch]$NoPair,[switch]$Crlf,[switch]$DupMarker,[switch]$NoMarkers)
  $h=@("Task: $Task","Status: $Status","GitHub: $Url",'Issue state: OPEN',"Canonical version: $Rev",'Next action: RUN_FOCUSED_CHECKS')
  if(-not $NoPair){$h+=@("Title: $Title","Summary: $DefaultSummary")}
  $s="<!-- factory-task:${TaskId}:start -->`n"; $e="<!-- factory-task:${TaskId}:end -->`n"
  if($NoMarkers){$s='';$e=''}
  $t="# Human reviewed heading`n`nFrozen prose kept byte for byte.`n"+$s+($h -join "`n")+"`n`n"+$e+"Frozen acceptance criteria prose.`n"
  if($DupMarker){$t+="<!-- factory-task:${TaskId}:start -->`n"}
  if($Crlf){$t=$t.Replace("`n","`r`n")}
  return $t
}
function Get-DefaultCandBytes { Get-Utf8 (Get-CandidateText) }

# ---- Fixtures: real enqueue boundary produces the CREATE pair; GitHub DELIVERED is built from the ABI -----
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

$script:CaseN=0; $script:AdmN=0; $script:CandN=0
function New-Case {
  $script:CaseN++
  $dir=Join-Path $Ev ('case'+$script:CaseN)
  $c=@{dir=$dir;state=(Join-Path $dir 'state');vault=(Join-Path $dir 'vault')}
  $c.outbox=Join-Path $c.state 'outbox.json'; $c.note=Join-Path $c.vault 'note.md'
  foreach($d in @($c.state,$c.vault)){[void][IO.Directory]::CreateDirectory($d)}
  Write-OutboxAtomic $c.outbox (New-UnrelatedRows)
  return $c
}
function Add-Event {
  param($Case,[int]$Revision=7,[string]$Key='synth-create-7',[string]$Summary=$DefaultSummary)
  $dir=Join-Path $Case.state ('canonical-create-'+$Key)
  $e=@{rev=$Revision;key=$Key;summary=$Summary;canonical=(Join-Path $Case.dir "canonical$Revision.json");packet=(Join-Path $Case.dir "packet$Revision.json");eventDir=$dir;event=(Join-Path $dir 'event.json');mapping=(Join-Path $dir 'mapping.json');readback=(Join-Path $dir 'readback.json')}
  Write-Json $e.canonical ([ordered]@{taskId=$TaskId;canonicalRevision=$Revision;publicTitle=$Title;publicSummary=$Summary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})
  Write-Json $e.packet ([ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId=$TaskId;canonicalRevision=$Revision;eventType='CREATE';idempotencyKey=$Key;publicTitle=$Title;publicSummary=$Summary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS';destinations=@('github','note')})
  $a=@{TaskId=$TaskId;CanonicalRevision=$Revision;CanonicalPath=$e.canonical;ExpectedCanonicalSha256=(Get-Sha $e.canonical);PacketPath=$e.packet;ExpectedPacketSha256=(Get-Sha $e.packet)
       ConsumerPath=$HelpersFile;ExpectedConsumerSha256=(Get-Sha $HelpersFile);ReconcilePath=$ReconcileFile;ExpectedReconcileSha256=(Get-Sha $ReconcileFile);ExpectedCaptureSha256=(Get-Sha $CaptureFile)
       StateDir=$Case.state;OutboxPath=$Case.outbox;ExpectedOutboxSha256=(Get-Sha $Case.outbox)}
  $res=Invoke-CanonicalLifecycleCreateEnqueue @a
  Assert-Eq $res.status 'ENQUEUED' 'fixture enqueue'
  return $e
}
function Get-Digest {
  param($E)
  $c=Read-LifecycleJson $E.canonical
  Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))
}
function Get-Keys {
  param($E)
  $digest=Get-Digest $E
  $k=@{}
  foreach($d in @('github','note')){$k[$d]=Get-EventKey -TaskId $TaskId -PayloadSha256 $digest -RunId ($E.key+':create:'+$d) -Status 'AWAITING_CONTROLLER' -Attempt 0}
  return $k
}
function Set-RowState {
  param($Case,[string]$Key,[string]$Delivery,$Proof)
  $rows=@(Read-Outbox $Case.outbox)
  foreach($row in $rows){if($row.key -ceq $Key){$row.deliveryStatus=$Delivery;$row.proof=$Proof}}
  Write-OutboxAtomic $Case.outbox $rows
}
function Get-GhProof { param($E) 'canonical-create-readback:sha256='+(Get-Sha $E.readback)+';path='+$E.readback }
function Add-GithubDelivered {
  # Independent oracle of the documented GitHub consumer ABI: 6-field mapping, 16-field readback, proof string.
  param($Case,$E,[int]$Issue=1)
  $k=Get-Keys $E
  $mapObj=[ordered]@{taskId=$TaskId;repo='hakanduyar/software-factory';issueNumber=$Issue;url=('https://github.com/hakanduyar/software-factory/issues/'+$Issue);stableMarker=$Marker;canonicalRevision=$E.rev}
  $mapBytes=Get-Utf8 (ConvertTo-Json -InputObject $mapObj -Compress -Depth 4)
  [IO.File]::WriteAllBytes($E.mapping,$mapBytes)
  $rb=[ordered]@{schema='CanonicalCreateGitHubReadback/v1';taskId=$TaskId;canonicalRevision=$E.rev;packetSha256=(Get-Sha $E.packet);createEventSha256=(Get-Sha $E.event)
    outboxKey=$k.github;runId=($E.key+':create:github');payloadSha256=(Get-Digest $E);engineEventKey=(Get-EngineKey $E.rev $E.summary)
    mappingSha256=(Get-BytesSha $mapBytes);issueUrl=$mapObj.url;issueNumber=$Issue;stableMarker=$Marker;observedTitle=$Title
    observedRegionSha256=(Get-TextSha (Get-Region $E.rev $E.summary));observedBodySha256=(Get-TextSha (Get-Body $E.rev $E.summary))}
  [IO.File]::WriteAllBytes($E.readback,(Get-Utf8 (ConvertTo-Json -InputObject $rb -Compress -Depth 4)))
  Set-RowState $Case $k.github 'DELIVERED' (Get-GhProof $E)
}
function Get-NoteProof { param($Case,[byte[]]$Cand) 'canonical-create-note-readback:sha256='+(Get-BytesSha $Cand)+';path='+$Case.note }
function New-Ready {
  $c=New-Case; $e=Add-Event $c; Add-GithubDelivered $c $e
  return @{c=$c;e=$e}
}
function Set-Mut {
  param($Obj,[hashtable]$Mut)
  foreach($k in $Mut.Keys){ if($Mut[$k] -is [string] -and $Mut[$k] -ceq '__REMOVE__'){[void]$Obj.Remove($k)}else{$Obj[$k]=$Mut[$k]} }
}
function New-Admission {
  param($Case,$E,[string]$CandPath,[string]$Recovery,$Expect,[hashtable]$Rel=@{},[hashtable]$Rev=@{},[hashtable]$Nat=@{},[hashtable]$All=@{})
  $script:AdmN=$script:AdmN+1
  $sfx=[string]$script:AdmN
  $hashes=[ordered]@{packetSha256=(Get-Sha $E.packet);canonicalSha256=(Get-Sha $E.canonical);createEventSha256=(Get-Sha $E.event);githubConsumerSha256=(Get-Sha $GhFile);lifecycleHelpersSha256=(Get-Sha $HelpersFile);reconcileSha256=(Get-Sha $ReconcileFile);captureSha256=(Get-Sha $CaptureFile);mappingSha256=(Get-Sha $E.mapping);readbackSha256=(Get-Sha $E.readback);noteCandidateSha256=(Get-Sha $CandPath)}
  $tail=[ordered]@{stateDir=$Case.state;outboxPath=$Case.outbox;outboxSha256=(Get-Sha $Case.outbox);vaultRoot=$Case.vault;notePath=$Case.note;expectedNoteSha256=$Expect;recovery=$Recovery}
  $review=[ordered]@{schema='CanonicalCreateNoteIndependentReview/v1';decision='ADMIT_SCOPED_CREATE_NOTE';reviewer='synthetic-test-reviewer'}
  foreach($k in $hashes.Keys){$review[$k]=$hashes[$k]}
  foreach($k in $tail.Keys){$review[$k]=$tail[$k]}
  Set-Mut $review $All; Set-Mut $review $Rev
  $reviewPath=Join-Path $Case.dir "review$sfx.json"; Write-Json $reviewPath $review
  $native=[ordered]@{schema='CanonicalCreateNoteNativeRequest/v1';action='CREATE_NOTE'}
  foreach($k in $hashes.Keys){$native[$k]=$hashes[$k]}
  foreach($k in $tail.Keys){$native[$k]=$tail[$k]}
  $native['reviewSha256']=Get-Sha $reviewPath
  Set-Mut $native $All; Set-Mut $native $Nat
  $nativePath=Join-Path $Case.dir "native$sfx.json"; Write-Json $nativePath $native
  $ref={param($p) [ordered]@{path=$p;sha256=(Get-Sha $p)}}
  $release=[ordered]@{schema='CanonicalCreateNoteRelease/v1'
    packet=(& $ref $E.packet);canonical=(& $ref $E.canonical);createEvent=(& $ref $E.event);githubConsumer=(& $ref $GhFile);lifecycleHelpers=(& $ref $HelpersFile)
    reconcile=(& $ref $ReconcileFile);capture=(& $ref $CaptureFile);mapping=(& $ref $E.mapping);readback=(& $ref $E.readback);noteCandidate=(& $ref $CandPath)
    review=(& $ref $reviewPath);nativeRequest=(& $ref $nativePath)
    stateDir=$Case.state;outboxPath=$Case.outbox;outboxSha256=$tail.outboxSha256;vaultRoot=$Case.vault;notePath=$Case.note;expectedNoteSha256=$Expect
    canonicalLease=($E.canonical+'.lock');publisherLease=(Join-Path $Case.state 'publisher.lock');recovery=$Recovery}
  Set-Mut $release $All; Set-Mut $release $Rel
  $releasePath=Join-Path $Case.dir "release$sfx.json"; Write-Json $releasePath $release
  return @{release=$releasePath;relSha=(Get-Sha $releasePath);revSha=(Get-Sha $reviewPath);natSha=(Get-Sha $nativePath);review=$reviewPath;native=$nativePath;cand=$CandPath}
}
function Invoke-Consumer {
  param($Case,$E,[string]$Recovery='INITIAL',[hashtable]$Rel=@{},[hashtable]$Rev=@{},[hashtable]$Nat=@{},[hashtable]$All=@{},[hashtable]$Args2=@{},[object]$CandBytes,[object]$ExpectOv,[scriptblock]$Tamper)
  $script:CandN++
  $cand=Join-Path $Case.dir ('candidate'+$script:CandN+'.md')
  $bytes=$(if($null -ne $CandBytes){[byte[]]$CandBytes}else{Get-DefaultCandBytes})
  [IO.File]::WriteAllBytes($cand,$bytes)
  $expect=$null; if([IO.File]::Exists($Case.note)){$expect=Get-Sha $Case.note}
  if($null -ne $ExpectOv){$expect=$ExpectOv.v}
  $adm=New-Admission $Case $E $cand $Recovery $expect $Rel $Rev $Nat $All
  if($null -ne $Tamper){& $Tamper $adm}
  $a=@{ReleasePath=$adm.release;ExpectedReleaseSha256=$adm.relSha;ExpectedReviewSha256=$adm.revSha;ExpectedNativeRequestSha256=$adm.natSha}
  foreach($k in $Args2.Keys){$a[$k]=$Args2[$k]}
  $res=@(Invoke-AdmittedCanonicalCreateNote @a)
  Assert-Eq $res.Count 1 'one result object'
  Assert-Eq $res[0].factoryDone $false 'never Factory DONE'; Assert-Eq $res[0].automaticRetry $false 'no automatic retry'
  return $res[0]
}
function Get-State {
  param($Case,$E)
  $v=(@(Get-ChildItem -LiteralPath $Case.vault -Recurse -Force -File -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object { $_.FullName+'='+(Get-Sha $_.FullName) }) -join '|')
  @{outbox=(Get-Sha $Case.outbox);rows=(Get-RowJsons $Case.outbox);vault=$v
    note=$(if([IO.File]::Exists($Case.note)){Get-Sha $Case.note}else{'absent'})
    mapping=$(if([IO.File]::Exists($E.mapping)){Get-Sha $E.mapping}else{'absent'});readback=$(if([IO.File]::Exists($E.readback)){Get-Sha $E.readback}else{'absent'})
    event=(Get-Sha $E.event);canonical=(Get-Sha $E.canonical);packet=(Get-Sha $E.packet)}
}
function Assert-SameState {
  param($A,$B,[string]$Msg)
  foreach($k in @('outbox','note','vault','mapping','readback','event','canonical','packet')){Assert-Eq $B[$k] $A[$k] "$Msg $k unchanged"}
}
function Assert-RefusedClean {
  param($Case,$E,$Before,$R,[string]$Code,[string]$Msg)
  Assert-Eq $R.status 'REFUSED' "$Msg status"; Assert-Eq $R.code $Code "$Msg code"
  Assert-Eq $R.noteAck $false "$Msg no note ack"; Assert-Eq $R.paired $false "$Msg not paired"
  Assert-SameState $Before (Get-State $Case $E) $Msg
}
function Assert-AckedNoteOnly {
  # The note row went PENDING/null -> DELIVERED/proof(note path + note readback sha); nothing else changed.
  param($Case,$E,$Before,[byte[]]$Cand,[string]$Msg)
  $k=Get-Keys $E
  $after=Read-RawRows $Case.outbox; $beforeRows=@($Before.rows | ForEach-Object { ConvertFrom-Json -InputObject $_ -DateKind String })
  Assert-Eq @($after).Count @($beforeRows).Count "$Msg row count"
  $proof=Get-NoteProof $Case $Cand
  for($i=0;$i -lt @($after).Count;$i++){
    if($after[$i].key -ceq $k.note){
      Assert-Eq $after[$i].deliveryStatus 'DELIVERED' "$Msg note delivered"
      Assert-Eq $after[$i].proof $proof "$Msg proof names note path+sha"
      $b=$beforeRows[$i]; $b.deliveryStatus='DELIVERED'; $b.proof=$proof
      Assert-Eq (ConvertTo-Json -InputObject $after[$i] -Depth 10 -Compress) (ConvertTo-Json -InputObject $b -Depth 10 -Compress) "$Msg note row fields/order otherwise identical"
    } else {
      Assert-Eq (ConvertTo-Json -InputObject $after[$i] -Depth 10 -Compress) $Before.rows[$i] "$Msg row $i (incl. GitHub row) JSON and property order unchanged"
    }
  }
  [void](Read-Outbox $Case.outbox)
  Assert-Eq ([IO.File]::Exists($Case.note)) $true "$Msg note exists"
  Assert-Eq (Get-Sha $Case.note) (Get-BytesSha $Cand) "$Msg note bytes are exactly the approved candidate"
  foreach($f in @('mapping','readback','event','canonical','packet')){Assert-Eq (Get-State $Case $E)[$f] $Before[$f] "$Msg $f unchanged"}
}

# ---- Test-only scoped faults: a global alias outranks the function the consumer calls, so production needs
# no hook. They act only for the armed exact target and are restored in finally.
$script:FaultTarget=$null; $script:FaultMode='THROW'
$script:OriginalWriter=(Get-Command -Name Write-OutboxAtomic -CommandType Function).ScriptBlock
function Invoke-NoteFaultOutboxWriter {
  param([string]$OutboxPath,[object[]]$Events)
  if($null -ne $script:FaultTarget -and $OutboxPath -ceq $script:FaultTarget){
    if($script:FaultMode -ceq 'NOOP'){return}
    if($script:FaultMode -ceq 'WRITE_THEN_THROW'){& $script:OriginalWriter $OutboxPath $Events}
    throw 'SYNTHETIC_WRITER_FAULT'
  }
  & $script:OriginalWriter $OutboxPath $Events
}
function Invoke-WithWriterFault {
  param([string]$Target,[string]$Mode,[scriptblock]$Body)
  $script:FaultTarget=$Target; $script:FaultMode=$Mode
  Set-Alias -Name Write-OutboxAtomic -Value Invoke-NoteFaultOutboxWriter -Scope Global -Force
  try{& $Body}finally{
    Remove-Item -Path Alias:\Write-OutboxAtomic -ErrorAction SilentlyContinue
    $script:FaultTarget=$null
  }
}
$script:NoteFault=$null
$script:OriginalNoteWriter=(Get-Command -Name Write-CreateNoteNewFile -CommandType Function).ScriptBlock
function Invoke-NoteFaultNoteWriter {
  param([string]$Path,[byte[]]$Bytes)
  switch($script:NoteFault){
    'THROW'{throw 'SYNTHETIC_NOTE_FAULT'}
    'RACE'{[IO.File]::WriteAllBytes($Path,(Get-Utf8 "human file created concurrently`n")); & $script:OriginalNoteWriter $Path $Bytes}
    'CORRUPT'{[IO.File]::WriteAllBytes($Path,(Get-Utf8 "tampered note bytes`n"))}
    default{& $script:OriginalNoteWriter $Path $Bytes}
  }
}
function Invoke-WithNoteFault {
  param([string]$Mode,[scriptblock]$Body)
  $script:NoteFault=$Mode
  Set-Alias -Name Write-CreateNoteNewFile -Value Invoke-NoteFaultNoteWriter -Scope Global -Force
  try{& $Body}finally{
    Remove-Item -Path Alias:\Write-CreateNoteNewFile -ErrorAction SilentlyContinue
    $script:NoteFault=$null
  }
}

$script:Passed=@()
function Pass { param([string]$Name) $script:Passed+=$Name; Write-Host "PASS $Name" }

# ======================================================================================================
# AC1: real CREATE enqueue rows + actual-shaped DELIVERED GitHub fixture -> exact candidate CreateNew, readback,
# only the note row ACKed; everything else unchanged.
$d=New-Ready; $c=$d.c; $e=$d.e
$before=Get-State $c $e; $cand=Get-DefaultCandBytes
$r=Invoke-Consumer $c $e
Assert-Eq $r.status 'DELIVERED' 'AC1 status'; Assert-Eq $r.code 'NOTE_ACK' 'AC1 code'
Assert-Eq $r.noteAck $true 'AC1 note ack'; Assert-Eq $r.githubAckVerified $true 'AC1 github proof verified'; Assert-Eq $r.paired $true 'AC1 both verified'
Assert-AckedNoteOnly $c $e $before $cand 'AC1'
Assert-Eq (Get-State $c $e).vault ($c.note+'='+(Get-BytesSha $cand)) 'AC1 only the note exists in the vault (no temp left)'
Pass 'AC1 delivered pair -> exact candidate created, note-only ACK'

# Candidate bytes (CRLF, no Title/Summary pair) are preserved exactly.
foreach($variant in @('CRLF','NOPAIR')){
  $d=New-Ready; $c=$d.c; $e=$d.e
  $before=Get-State $c $e
  $cand=$(if($variant -ceq 'CRLF'){Get-Utf8 (Get-CandidateText -Crlf)}else{Get-Utf8 (Get-CandidateText -NoPair)})
  $r=Invoke-Consumer $c $e -CandBytes $cand
  Assert-Eq $r.code 'NOTE_ACK' "AC1 $variant code"
  Assert-AckedNoteOnly $c $e $before $cand "AC1 $variant"
}
Pass 'AC1 line endings and optional pair preserved byte for byte'

# ======================================================================================================
# AC2: replay is byte stable; ACK failure then explicit current-pin recovery without rewrite; stale pins.
$d=New-Ready; $c=$d.c; $e=$d.e
$before=Get-State $c $e; $cand=Get-DefaultCandBytes
$r=Invoke-Consumer $c $e
Assert-Eq $r.code 'NOTE_ACK' 'replay fixture'
$snap=Get-State $c $e
foreach($rec in @('INITIAL','RECONCILE_MISSING')){
  $r=Invoke-Consumer $c $e -Recovery $rec
  Assert-Eq $r.status 'DELIVERED' "replay $rec status"; Assert-Eq $r.code 'REPLAY_ACKED' "replay $rec code"; Assert-Eq $r.paired $true "replay $rec paired"
  Assert-SameState $snap (Get-State $c $e) "replay $rec"
}
# A human edit after the ACK is a conflict, never rewritten or re-ACKed.
Write-Text $c.note "human edited after ack`n"
$snapHuman=Get-State $c $e
$r=Invoke-Consumer $c $e
Assert-Eq $r.status 'REFUSED' 'edited note status'; Assert-Eq $r.code 'NOTE_CONFLICT' 'edited note code'; Assert-SameState $snapHuman (Get-State $c $e) 'edited note'

$d=New-Ready; $c=$d.c; $e=$d.e
$before=Get-State $c $e; $cand=Get-DefaultCandBytes
$r=Invoke-WithWriterFault $c.outbox 'THROW' { Invoke-Consumer $c $e }
Assert-Eq $r.status 'PENDING_LOCAL_ACK' 'ack failure status'; Assert-Eq $r.code 'OUTBOX_WRITE_FAILED' 'ack failure code'; Assert-Eq $r.noteAck $false 'ack failure no note ack'; Assert-Eq $r.paired $false 'ack failure not paired'
Assert-Eq (Get-Sha $c.outbox) $before.outbox 'ack failure outbox untouched'
Assert-Eq (Get-Sha $c.note) (Get-BytesSha $cand) 'ack failure note preserved'
$stale=Get-State $c $e
# Stale initial/expected pins: no writes.
$r=Invoke-Consumer $c $e -Recovery 'INITIAL'
Assert-Eq $r.code 'EXPLICIT_RECOVERY_REQUIRED' 'INITIAL never adopts existing note'; Assert-SameState $stale (Get-State $c $e) 'INITIAL after note'
$r=Invoke-Consumer $c $e -Recovery 'INITIAL' -ExpectOv @{v=$null}
Assert-Eq $r.code 'NOTE_STATE_DRIFT' 'stale absent-note pin'; Assert-SameState $stale (Get-State $c $e) 'stale absent pin'
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING' -ExpectOv @{v=('e'*64)}
Assert-Eq $r.code 'NOTE_STATE_DRIFT' 'stale note hash pin'; Assert-SameState $stale (Get-State $c $e) 'stale hash pin'
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING' -All @{outboxSha256=('0'*64)}
Assert-Eq $r.code 'OUTBOX_DRIFT' 'stale outbox pin'; Assert-SameState $stale (Get-State $c $e) 'stale outbox pin'
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
Assert-Eq $r.status 'DELIVERED' 'recovery status'; Assert-Eq $r.code 'NOTE_ACK_RECOVERED' 'recovery code'; Assert-Eq $r.paired $true 'recovery paired'
Assert-AckedNoteOnly $c $e $before $cand 'recovery'
Pass 'AC2 replay stable; ACK failure recovered once without rewrite; stale pins no writes'

# Different human file, identical unowned initial file, and recovery without a note refuse.
$d=New-Ready; $c=$d.c; $e=$d.e
Write-Text $c.note "my own human note`n"
$snap=Get-State $c $e
foreach($rec in @('INITIAL','RECONCILE_MISSING')){
  $r=Invoke-Consumer $c $e -Recovery $rec
  Assert-RefusedClean $c $e $snap $r 'NOTE_CONFLICT' "human file $rec"
}
$d=New-Ready; $c=$d.c; $e=$d.e
[IO.File]::WriteAllBytes($c.note,(Get-DefaultCandBytes))
$snap=Get-State $c $e
$r=Invoke-Consumer $c $e -Recovery 'INITIAL'
Assert-RefusedClean $c $e $snap $r 'EXPLICIT_RECOVERY_REQUIRED' 'identical unowned file with pin'
$r=Invoke-Consumer $c $e -Recovery 'INITIAL' -ExpectOv @{v=$null}
Assert-RefusedClean $c $e $snap $r 'NOTE_STATE_DRIFT' 'identical unowned file without pin'
$d=New-Ready; $c=$d.c; $e=$d.e
$snap=Get-State $c $e
$r=Invoke-Consumer $c $e -Recovery 'RECONCILE_MISSING'
Assert-RefusedClean $c $e $snap $r 'RECOVERY_WITHOUT_NOTE' 'recovery without a note'
Pass 'AC2 human, identical unowned and missing-note recovery refuse'

# ======================================================================================================
# AC3: refusals leave no mutation. Each case is fresh.
function Test-Refusal {
  # Prep runs after the GitHub fixture and before the admission is built. Late returns release/review/native
  # overrides (needs case paths); LateRel only release overrides. Tamper runs after the admission documents
  # exist, so only the actual current state differs from what they pin.
  param([string]$Name,[string]$Code,[hashtable]$Rel=@{},[hashtable]$Rev=@{},[hashtable]$Nat=@{},[hashtable]$All=@{},[hashtable]$Args2=@{},[string]$Recovery='INITIAL',[object]$CandBytes,[object]$ExpectOv,[scriptblock]$Prep,[scriptblock]$Late,[scriptblock]$LateRel,[scriptblock]$Tamper,[switch]$NoGithub)
  $c=New-Case; $e=Add-Event $c
  Add-GithubDelivered $c $e
  # NoGithub: same mapping/readback artifacts as a delivered event, but the GitHub row stays undelivered (no ACK forged).
  if($NoGithub){Set-RowState $c (Get-Keys $e).github 'PENDING' $null}
  if($null -ne $Prep){& $Prep $c $e}
  if($null -ne $Late){$All=@{}+(& $Late $c $e)}
  if($null -ne $LateRel){$Rel=@{}+(& $LateRel $c $e)}
  $before=Get-State $c $e
  $tw=$null; $box=@{snap=$null}
  if($null -ne $Tamper){$tw={param($adm) & $Tamper $adm $c $e; $box.snap=Get-State $c $e}.GetNewClosure()}
  $r=Invoke-Consumer $c $e -Recovery $Recovery -Rel $Rel -Rev $Rev -Nat $Nat -All $All -Args2 $Args2 -CandBytes $CandBytes -ExpectOv $ExpectOv -Tamper $tw
  if($null -ne $Tamper){$before=$box.snap}
  Assert-RefusedClean $c $e $before $r $Code $Name
}
Test-Refusal 'wrong release pin' 'RELEASE_DRIFT' -Args2 @{ExpectedReleaseSha256=('1'*64)}
Test-Refusal 'missing review pin' 'ADMISSION_PIN_MISSING' -Args2 @{ExpectedReviewSha256=''}
Test-Refusal 'review pin differs from release ref' 'ADMISSION_BINDING' -Args2 @{ExpectedReviewSha256=('2'*64)}
Test-Refusal 'native pin differs from release ref' 'ADMISSION_BINDING' -Args2 @{ExpectedNativeRequestSha256=('2'*64)}
Test-Refusal 'review file tampered after release' 'REVIEW_DRIFT' -Tamper {param($adm,$c,$e) [IO.File]::AppendAllText($adm.review,' ')}
Test-Refusal 'review extra field' 'REVIEW_BINDING' -Rev @{extra='x'}
Test-Refusal 'review binds native hash (circular)' 'REVIEW_BINDING' -Rev @{nativeRequestSha256=('3'*64)}
Test-Refusal 'review wrong decision' 'REVIEW_BINDING' -Rev @{decision='ADMIT'}
Test-Refusal 'review readback binding' 'REVIEW_BINDING' -Rev @{readbackSha256=('4'*64)}
Test-Refusal 'review note expectation' 'REVIEW_BINDING' -Rev @{expectedNoteSha256=('4'*64)}
Test-Refusal 'native candidate binding' 'NATIVE_BINDING' -Nat @{noteCandidateSha256=('3'*64)}
Test-Refusal 'native wrong action' 'NATIVE_BINDING' -Nat @{action='UPDATE'}
Test-Refusal 'native wrong review binding' 'NATIVE_BINDING' -Nat @{reviewSha256=('7'*64)}
Test-Refusal 'native vault binding' 'NATIVE_BINDING' -Nat @{vaultRoot='C:\elsewhere'}
Test-Refusal 'release extra field' 'RELEASE_INVALID' -Rel @{extra='x'}
Test-Refusal 'release missing field' 'RELEASE_INVALID' -Rel @{vaultRoot='__REMOVE__'}
Test-Refusal 'release type coerced hash' 'RELEASE_INVALID' -Rel @{outboxSha256=12345}
Test-Refusal 'release bad note pin' 'RELEASE_INVALID' -Rel @{expectedNoteSha256='NOT-A-HASH'}
Test-Refusal 'release recovery unsupported' 'RELEASE_INVALID' -Rel @{recovery='AUTO'}
Test-Refusal 'release schema' 'RELEASE_INVALID' -Rel @{schema='CanonicalCreateGitHubRelease/v1'}
Test-Refusal 'github consumer not the sibling' 'SOURCE_BINDING' -Rel @{githubConsumer=[ordered]@{path=$HelpersFile;sha256=(Get-Sha $HelpersFile)}}
Test-Refusal 'github consumer pin drift' 'GITHUBCONSUMER_DRIFT' -Rel @{githubConsumer=[ordered]@{path=$GhFile;sha256=('5'*64)}}
Test-Refusal 'helpers not the sibling' 'SOURCE_BINDING' -Rel @{lifecycleHelpers=[ordered]@{path=$GhFile;sha256=(Get-Sha $GhFile)}}
Test-Refusal 'reconcile not accepted' 'RECONCILE_DRIFT' -Rel @{reconcile=[ordered]@{path=$ReconcileFile;sha256=('5'*64)}}
Test-Refusal 'capture not accepted' 'CAPTURE_DRIFT' -Rel @{capture=[ordered]@{path=$CaptureFile;sha256=('6'*64)}}
Test-Refusal 'capture not the reconcile sibling' 'SOURCE_BINDING' -Rel @{capture=[ordered]@{path=$HelpersFile;sha256=(Get-Sha $CaptureFile)}}
Test-Refusal 'mapping outside event directory' 'OUTPUT_BINDING' -LateRel {param($c,$e) $x=Join-Path $c.state 'elsewhere.json'; Copy-Item -LiteralPath $e.mapping -Destination $x; @{mapping=[ordered]@{path=$x;sha256=(Get-Sha $x)}}}
Test-Refusal 'candidate tampered after release' 'NOTECANDIDATE_DRIFT' -Tamper {param($adm,$c,$e) [IO.File]::AppendAllText($adm.cand,' ')}
Test-Refusal 'candidate file missing' 'FILE_MISSING' -Tamper {param($adm,$c,$e) [IO.File]::Delete($adm.cand)}
Test-Refusal 'candidate invalid UTF-8' 'NOTECANDIDATE_INVALID' -CandBytes ([byte[]]@(0x23,0x20,0xC3,0x28,0x0A))
Test-Refusal 'candidate BOM' 'NOTECANDIDATE_INVALID' -CandBytes ([byte[]]@(0xEF,0xBB,0xBF)+(Get-DefaultCandBytes))
Test-Refusal 'candidate wrong GitHub URL' 'NOTE_OWNERSHIP' -CandBytes (Get-Utf8 (Get-CandidateText -Url 'https://github.com/hakanduyar/software-factory/issues/2'))
Test-Refusal 'candidate wrong revision' 'NOTE_VERSION_MISMATCH' -CandBytes (Get-Utf8 (Get-CandidateText -Rev 6))
Test-Refusal 'candidate wrong header task' 'NOTE_OWNERSHIP' -CandBytes (Get-Utf8 (Get-CandidateText -Task 'SYNTH-OTHER'))
Test-Refusal 'candidate status differs from canonical' 'CANDIDATE_MISMATCH' -CandBytes (Get-Utf8 (Get-CandidateText -Status 'BLOCKED'))
Test-Refusal 'candidate title differs from canonical' 'CANDIDATE_MISMATCH' -CandBytes (Get-Utf8 ((Get-CandidateText).Replace('Title: Synthetic fixture title','Title: Another synthetic title')))
Test-Refusal 'candidate duplicate markers' 'NOTE_OWNERSHIP' -CandBytes (Get-Utf8 (Get-CandidateText -DupMarker))
Test-Refusal 'candidate without markers' 'NOTE_OWNERSHIP' -CandBytes (Get-Utf8 (Get-CandidateText -NoMarkers))
Test-Refusal 'github row PENDING' 'GITHUB_NOT_DELIVERED' -NoGithub
Test-Refusal 'github forged proof' 'PROOF_INVALID' -Prep {param($c,$e) Set-RowState $c (Get-Keys $e).github 'DELIVERED' 'readback:forged'}
Test-Refusal 'github proof for another path' 'PROOF_INVALID' -Prep {param($c,$e) Set-RowState $c (Get-Keys $e).github 'DELIVERED' ('canonical-create-readback:sha256='+(Get-Sha $e.readback)+';path='+$e.mapping)}
Test-Refusal 'github readback stale vs row proof' 'PROOF_INVALID' -Prep {param($c,$e) Write-Text $e.readback '{"stale":true}'}
Test-Refusal 'github readback forged with matching proof' 'PROOF_INVALID' -Prep {param($c,$e)
  $t=[IO.File]::ReadAllText($e.readback).Replace('"observedTitle":"Synthetic fixture title"','"observedTitle":"Other synthetic title"')
  Write-Text $e.readback $t; Set-RowState $c (Get-Keys $e).github 'DELIVERED' (Get-GhProof $e)
}
Test-Refusal 'github mapping for another issue' 'PROOF_INVALID' -Prep {param($c,$e) Add-GithubDelivered $c $e -Issue 1; $t=[IO.File]::ReadAllText($e.mapping).Replace('issues/1','issues/2').Replace('"issueNumber":1','"issueNumber":2'); Write-Text $e.mapping $t}
Test-Refusal 'github mapping revision drift' 'PROOF_INVALID' -Prep {param($c,$e) $t=[IO.File]::ReadAllText($e.mapping).Replace('"canonicalRevision":7','"canonicalRevision":6'); Write-Text $e.mapping $t}
Test-Refusal 'github readback missing' 'FILE_MISSING' -Tamper {param($adm,$c,$e) [IO.File]::Delete($e.readback)}
Test-Refusal 'canonical revision differs from packet' 'CANONICAL_PACKET_MISMATCH' -Prep {param($c,$e) Write-Json $e.canonical ([ordered]@{taskId=$TaskId;canonicalRevision=8;publicTitle=$Title;publicSummary=$DefaultSummary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})}
Test-Refusal 'canonical task differs from packet' 'CANONICAL_PACKET_MISMATCH' -Prep {param($c,$e) Write-Json $e.canonical ([ordered]@{taskId='SYNTH-OTHER';canonicalRevision=7;publicTitle=$Title;publicSummary=$DefaultSummary;publicStatus='IN_PROGRESS';nextAction='RUN_FOCUSED_CHECKS'})}
Test-Refusal 'sidecar tampered' 'CREATEEVENT_DRIFT' -Tamper {param($adm,$c,$e) [IO.File]::AppendAllText($e.event,' ')}
Test-Refusal 'unrelated outbox drift' 'OUTBOX_DRIFT' -Tamper {param($adm,$c,$e)
  $rows=@(Read-Outbox $c.outbox); $rows+=(New-Row 'SYNTH-DRIFT' ('d'*64) 'synth-drift:github' 'github'); Write-OutboxAtomic $c.outbox $rows
}
Test-Refusal 'NO_RETRY excluded note row' 'EXCLUDED_NO_RETRY' -Prep {param($c,$e)
  $rows=@(Read-Outbox $c.outbox); $k=Get-Keys $e
  foreach($row in $rows){if($row.key -ceq $k.note){$row | Add-Member -NotePropertyName retryPolicy -NotePropertyValue 'NO_RETRY'}}
  Write-OutboxAtomic $c.outbox $rows
}
Test-Refusal 'wrong tuple metadata on note row' 'EVENT_CONFLICT' -Prep {param($c,$e)
  $rows=@(Read-Outbox $c.outbox); $k=Get-Keys $e
  foreach($row in $rows){if($row.key -ceq $k.note){$row.packetRef.sha256=('9'*64)}}
  Write-OutboxAtomic $c.outbox $rows
}
Test-Refusal 'note row delivered with foreign proof' 'PROOF_INVALID' -Prep {param($c,$e) Set-RowState $c (Get-Keys $e).note 'DELIVERED' 'bytes:synthetic'}
Test-Refusal 'note row missing' 'ROW_MISSING' -Prep {param($c,$e)
  $k=Get-Keys $e
  Write-OutboxAtomic $c.outbox @(@(Read-Outbox $c.outbox) | Where-Object {$_.key -cne $k.note})
}
Pass 'AC3 refusals leave outbox, note, vault and artifacts untouched'

# ======================================================================================================
# AC4: locks, path safety and note-write faults preserve bytes and unknown temps.
foreach($lock in @('canonical','publisher')){
  $d=New-Ready; $c=$d.c; $e=$d.e
  $paths=@{canonical=($e.canonical+'.lock');publisher=(Join-Path $c.state 'publisher.lock')}
  $wants=@{canonical='CANONICAL_LOCKED';publisher='PUBLISHER_LOCKED'}
  $before=Get-State $c $e
  $held=[IO.File]::Open($paths[$lock],[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{ $r=Invoke-Consumer $c $e }finally{ $held.Dispose() }
  Assert-RefusedClean $c $e $before $r $wants[$lock] "$lock lock"
}
Test-Refusal 'note path is a directory' 'NOTE_PATH_CONFLICT' -Prep {param($c,$e) [void][IO.Directory]::CreateDirectory($c.note)}
Test-Refusal 'missing note parent' 'NOTE_PARENT_MISSING' -Late {param($c,$e) @{notePath=(Join-Path $c.vault 'missing\note.md')}}
Test-Refusal 'note outside vault' 'PATH_OUTSIDE_OWNER' -Late {param($c,$e) @{notePath=(Join-Path $c.dir 'outside.md')}}
Test-Refusal 'note under reparse ancestor' 'REPARSE_REFUSED' -Late {param($c,$e)
  $real=Join-Path $c.dir 'real-target'; [void][IO.Directory]::CreateDirectory($real)
  $j=Join-Path $c.vault 'junction'
  $linkType=$(if($IsWindows){'Junction'}else{'SymbolicLink'})
  Assert-True ([IO.Directory]::Exists($real)) 'reparse fixture target exists'
  New-Item -ItemType $linkType -Path $j -Target $real | Out-Null
  Assert-True ([IO.Directory]::Exists($j)) 'reparse fixture link is a reachable directory'
  Assert-True (([IO.File]::GetAttributes($j) -band [IO.FileAttributes]::ReparsePoint) -ne 0) 'reparse fixture link is a ReparsePoint'
  @{notePath=(Join-Path $j 'note.md')}
}
Test-Refusal 'vault root contains state' 'VAULT_STATE_OVERLAP' -Late {param($c,$e) @{vaultRoot=$c.dir}}

# Controlled note-write faults: nothing ACKed, outbox untouched, unknown temp preserved, no cleanup.
foreach($mode in @('THROW','RACE')){
  $d=New-Ready; $c=$d.c; $e=$d.e
  $unknownTmp=$c.note+'.tmp-unknown'; Write-Text $unknownTmp "foreign temp`n"
  $before=Get-State $c $e
  $r=Invoke-WithNoteFault $mode { Invoke-Consumer $c $e }
  Assert-Eq $r.status 'PENDING' "$mode status"; Assert-Eq $r.noteAck $false "$mode no ack"; Assert-Eq $r.paired $false "$mode not paired"
  Assert-Eq $r.code $(if($mode -ceq 'THROW'){'SYNTHETIC_NOTE_FAULT'}else{'NOTE_CONFLICT'}) "$mode code"
  Assert-Eq (Get-Sha $c.outbox) $before.outbox "$mode outbox untouched"
  Assert-Eq (Get-Sha $unknownTmp) (Get-TextSha "foreign temp`n") "$mode unknown temp preserved"
  if($mode -ceq 'RACE'){Assert-Eq ([IO.File]::ReadAllText($c.note)) "human file created concurrently`n" 'racing human file preserved'}else{Assert-Eq ([IO.File]::Exists($c.note)) $false 'THROW leaves no note'}
  Assert-Eq (@(Get-ChildItem -LiteralPath $c.vault -Force | Where-Object {$_.Name -like 'note.md.tmp-*' -and $_.Name -cne 'note.md.tmp-unknown'}).Count) 0 "$mode no leaked owned temp"
}
Pass 'AC4 locks, path safety and write faults preserve state and unknown temps'

# ======================================================================================================
# AC5: ACK writer failure / readback mismatch are truthful; GitHub row, unrelated rows and note untouched.
$d=New-Ready; $c=$d.c; $e=$d.e
$before=Get-State $c $e; $cand=Get-DefaultCandBytes
$r=Invoke-WithWriterFault $c.outbox 'WRITE_THEN_THROW' { Invoke-Consumer $c $e }
Assert-Eq $r.status 'DELIVERED' 'retained ack status'; Assert-Eq $r.code 'NOTE_ACK_RETAINED' 'retained ack code'; Assert-Eq $r.paired $true 'retained ack paired'
Assert-AckedNoteOnly $c $e $before $cand 'retained ack'

$d=New-Ready; $c=$d.c; $e=$d.e
$before=Get-State $c $e; $cand=Get-DefaultCandBytes
$r=Invoke-WithWriterFault $c.outbox 'NOOP' { Invoke-Consumer $c $e }
Assert-Eq $r.status 'PENDING_LOCAL_ACK' 'unverified write status'; Assert-Eq $r.code 'WRITE_NOT_VERIFIED' 'unverified write code'; Assert-Eq $r.noteAck $false 'unverified write no ack'; Assert-Eq $r.paired $false 'unverified write not paired'
Assert-Eq (Get-Sha $c.outbox) $before.outbox 'unverified write outbox untouched'; Assert-Eq (Get-Sha $c.note) (Get-BytesSha $cand) 'unverified write note preserved'

$d=New-Ready; $c=$d.c; $e=$d.e
$before=Get-State $c $e
$r=Invoke-WithNoteFault 'CORRUPT' { Invoke-Consumer $c $e }
Assert-Eq $r.status 'PENDING' 'readback mismatch status'; Assert-Eq $r.code 'NOTE_READBACK_MISMATCH' 'readback mismatch code'; Assert-Eq $r.noteAck $false 'readback mismatch no ack'; Assert-Eq $r.paired $false 'readback mismatch not paired'
Assert-Eq (Get-Sha $c.outbox) $before.outbox 'readback mismatch outbox untouched'
Assert-Eq ([IO.File]::ReadAllText($c.note)) "tampered note bytes`n" 'mismatching note is preserved, not rolled back'
Pass 'AC5 ACK failure and readback mismatch are truthful; paired only when both verified'

# ======================================================================================================
foreach($f in $DepFiles){Assert-Eq (Get-Sha $f) $DepBefore[$f] "source file unchanged by tests: $f"}
Write-Host ("ALL PASSED: "+$script:Passed.Count+" groups")
