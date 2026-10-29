#Requires -Version 7.6
# Focused offline checks for the durable sanitized lifecycle UPDATE failure journal.
# Portable: every source/dependency is an explicit pinned path argument and every
# fixture lives under one new unique child of the caller-owned OutputDirectory.
# No gh, network, provider or live runtime file is touched; all processes are
# injected custom runners. Nothing outside the unique child is written or deleted.
param(
  [Parameter(Mandatory)][string]$ConsumerPath,
  [Parameter(Mandatory)][string]$TransportPath,
  [Parameter(Mandatory)][string]$ReconcilePath,
  [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# Accepted production pins preserved inside the test admission fixture.
$AcceptedTransportSha256='a5b09457e7735eec768b16cefbb8343a97fca55f2b00b0af2b4dbbbf932791e1'
$AcceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'

function Stop-Harness([string]$Message){throw [InvalidOperationException]::new('HARNESS: '+$Message)}
function Assert($condition,[string]$message){if(-not $condition){throw [InvalidOperationException]::new('ASSERT: '+$message)}}
function Field($o,[string]$n){
  if($null -eq $o){return $null}
  if($o -is [System.Collections.IDictionary]){if($o.Contains($n)){return $o[$n]}else{return $null}}
  if($o.PSObject.Properties.Name -ccontains $n){return $o.$n}
  return $null
}

try {
  foreach($p in @($ConsumerPath,$TransportPath,$ReconcilePath,$OutputDirectory)){
    if(-not [IO.Path]::IsPathFullyQualified($p) -or [IO.Path]::GetFullPath($p) -cne $p){Stop-Harness 'absolute normalized path arguments required'}
  }
  foreach($p in @($ConsumerPath,$TransportPath,$ReconcilePath)){if(-not [IO.File]::Exists($p)){Stop-Harness 'dependency file missing'}}
  if($TransportPath -cne (Join-Path (Split-Path $ConsumerPath) 'github-cli-transport216.ps1')){Stop-Harness 'transport must be the consumer sibling'}
  $sha={param($p) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($p))).ToLowerInvariant()}
  if((& $sha $TransportPath) -cne $AcceptedTransportSha256){Stop-Harness 'transport pin drift'}
  if((& $sha $ReconcilePath) -cne $AcceptedReconcileSha256){Stop-Harness 'reconcile pin drift'}
  # reconcile.ps1 would otherwise dot-source a sibling capture helper from its tree;
  # the lifecycle path never calls it, so a throwing stub keeps this suite closed.
  function Get-ReviewedBlockedEvidenceCapture {throw 'HARNESS_STUB_NOT_USED'}
  . $ConsumerPath
  . $TransportPath
  if($script:LifecycleConsumerSource -cne $ConsumerPath){Stop-Harness 'consumer dot-source path mismatch'}
  $Root=Join-Path $OutputDirectory ('lifecycle-failure-journal-'+[guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($Root)
} catch {
  [Console]::Error.WriteLine('HARNESS_ERROR '+$_.Exception.Message)
  exit 2
}

function PutJson($path,$obj){[IO.File]::WriteAllText($path,($obj|ConvertTo-Json -Depth 18 -Compress),[Text.UTF8Encoding]::new($false))}
function PutText($path,$text){[IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($false))}
function Ref($path){@{path=$path;sha256=(Get-LifecycleFileHash $path)}}
function EditCount($d){[int][IO.File]::ReadAllText((Join-Path $d 'edits.txt'))}
function SetMode($d,[string]$mode){PutText (Join-Path $d 'mode.txt') $mode}
function JournalPath($d){Join-Path $d 'state/lifecycle-update.journal.json'}
function ReadJournal($d){Read-LifecycleJson (JournalPath $d)}
function FixtureDigest($d){$c=Read-LifecycleJson (Join-Path $d 'canonical.json');Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c|ConvertTo-Json -Depth 8 -Compress)))}
function LegacyEvent($digest){@{digest=$digest;githubSent=$false;noteSent=$false;githubAck=$false;noteAck=$false}}
function SeedJournal($d,[string]$schema,$events){PutJson (JournalPath $d) @{schema=$schema;events=$events;heads=@{}}}
function ValidRecord(){@{schema='LifecycleUpdateFailure/v1';code='GITHUB_READ_FAILED';phase='INITIAL_READ';destination='github';operation='READ';diagnostic=@{category='RATE_LIMITED';exitCode=1;timedOut=$false;stderrTruncated=$false;stderrEncoding='NOT_OBSERVED'}}}

function New-Runner($dir){
  $diagNew=${function:New-GitHubCliFailureDiagnostic216}
  $remotePath=[IO.Path]::Combine($dir,'remote.json');$modePath=[IO.Path]::Combine($dir,'mode.txt');$editsPath=[IO.Path]::Combine($dir,'edits.txt')
  return {
    param($exe,$argv,$deadline,$stdoutCap,$stderrCap)
    $mode=if([IO.File]::Exists($modePath)){[IO.File]::ReadAllText($modePath).Trim()}else{''}
    $state=[IO.File]::ReadAllText($remotePath)|ConvertFrom-Json -AsHashtable
    $plain={param($out,$timeout) [pscustomobject]@{exitCode=[int]0;timedOut=[bool]$timeout;stdout=[string]$out;stdoutTruncated=$false;stderrTruncated=$false}}
    $failed={param($diag) [pscustomobject]@{exitCode=[int]1;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false;failureDiagnostic=$diag}}
    if($argv[1] -ceq 'view'){
      if($mode.StartsWith('read-fail:',[StringComparison]::Ordinal)){
        return (& $failed (& $diagNew -ExitCode 1 -TimedOut $false -StdoutTruncated $false -StderrTruncated $false -StderrText $null -Category $mode.Substring(10)))
      }
      if($mode -ceq 'read-secret-stderr'){
        $raw='HTTP 403 Forbidden token ghp_FAKEMARKER0123 sk-FAKEMARKER99 C:\Users\someone\factory-data\x https://example.invalid/?access_token=abc'
        return (& $failed (& $diagNew -ExitCode 1 -TimedOut $false -StdoutTruncated $false -StderrTruncated $false -StderrText $raw -StderrEncoding 'VALID'))
      }
      if($mode -ceq 'read-forged'){
        return (& $failed ([pscustomobject]@{category='ghp_FAKEMARKER_category';exitCode=[int]1;timedOut=$false;stderrTruncated=$false;stderrEncoding='VALID'}))
      }
      if($mode -ceq 'read-throw'){throw 'ghp_FAKEMARKER raw child failure'}
      return (& $plain ($state|ConvertTo-Json -Compress) $false)
    }
    if($argv[1] -ceq 'edit'){
      [IO.File]::WriteAllText($editsPath,[string]([int][IO.File]::ReadAllText($editsPath)+1))
      if($mode -ceq 'edit-ambiguous-noapply'){return (& $plain '' $true)}
      $bodyIndex=[Array]::IndexOf($argv,'--body-file');$titleIndex=[Array]::IndexOf($argv,'--title')
      $state.body=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($argv[$bodyIndex+1]));$state.title=$argv[$titleIndex+1]
      [IO.File]::WriteAllText($remotePath,($state|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
      return (& $plain $(if($mode -ceq 'edit-ambiguous-apply'){''}else{$state.url}) ($mode -ceq 'edit-ambiguous-apply'))
    }
    throw 'UNEXPECTED_CONNECTOR_OPERATION'
  }.GetNewClosure()
}

function Refresh-Fixture($d,[string]$recovery='INITIAL'){
  $r=Read-LifecycleJson (Join-Path $d 'release.json')
  foreach($name in @('packet','canonical','mapping','beforeIssue','beforeNote')){$r[$name]=Ref $r[$name].path}
  $r.recovery=$recovery;$r.outboxSha256=Get-LifecycleFileHash $r.outboxPath
  PutJson $r.review.path @{schema='LifecycleIndependentReview/v1';decision='ADMIT';packetSha256=$r.packet.sha256;consumerSha256=$r.consumer.sha256;transportSha256=$r.transport.sha256};$r.review=Ref $r.review.path
  PutJson $r.nativeRequest.path @{schema='LifecycleNativeRequest/v1';action='UPDATE';packetSha256=$r.packet.sha256;reviewSha256=$r.review.sha256;consumerSha256=$r.consumer.sha256;transportSha256=$r.transport.sha256;executableSha256=$r.executable.sha256;stateDir=$r.stateDir;notePath=$r.notePath;outboxPath=$r.outboxPath}
  $r.nativeRequest=Ref $r.nativeRequest.path
  PutJson (Join-Path $d 'release.json') $r
}
function New-Fixture($name){
  $d=Join-Path $Root $name;[void][IO.Directory]::CreateDirectory($d)
  foreach($sub in @('state','vault','temp')){[void][IO.Directory]::CreateDirectory((Join-Path $d $sub))}
  $p=[ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId='LCU_FIXTURE';canonicalRevision=2;eventType='UPDATE';idempotencyKey='update-2';publicTitle='Reviewed task';publicSummary='Reviewed summary';publicStatus='WAITING_FOR_REVIEW';nextAction='INDEPENDENT_REVIEW';destinations=@('github','note')}
  PutJson (Join-Path $d 'packet.json') $p
  $c=[ordered]@{};foreach($k in @('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')){$c[$k]=$p[$k]};PutJson (Join-Path $d 'canonical.json') $c
  $marker='factory-task-'+(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($p.taskId)))
  $url='https://github.com/hakanduyar/software-factory/issues/67'
  $body="<!-- $marker -->`n`n<!-- factory-task-status:start -->`nTask: LCU_FIXTURE`nVersion: 1`nStatus: IN_PROGRESS`nNext action: RUN_FOCUSED_CHECKS`nSummary: Original summary`n<!-- factory-task-status:end -->`n`nUnowned discussion."
  PutJson (Join-Path $d 'mapping.json') @{taskId=$p.taskId;repo='hakanduyar/software-factory';issueNumber=67;url=$url;stableMarker=$marker;canonicalRevision=1}
  PutJson (Join-Path $d 'before-issue.json') @{title='Original task';body=$body}
  $note="# Original note heading`n<!-- factory-task:LCU_FIXTURE:start -->`nTask: LCU_FIXTURE`nStatus: IN_PROGRESS`nGitHub: $url`nIssue state: OPEN`nCanonical version: 1`nNext action: RUN_FOCUSED_CHECKS`n`nAcceptance criteria (frozen v1):`n- Fixture criterion`n<!-- factory-task:LCU_FIXTURE:end -->`nTrailing prose."
  PutText (Join-Path $d 'before-note.md') $note;PutText (Join-Path $d 'vault/task.md') $note
  PutJson (Join-Path $d 'remote.json') @{number=67;url=$url;state='OPEN';title='Original task';body=$body};PutText (Join-Path $d 'edits.txt') '0'
  PutText (Join-Path $d 'gh-fixture.bin') 'fixture executable pin target; never executed'
  $hash='a'*64
  $old=[ordered]@{taskId='ORIGINAL_REFUSED';runId='original';destination='github';status='AWAITING_CONTROLLER';payloadSha256=$hash;attempt=0;key=('ORIGINAL_REFUSED:'+$hash+':original:AWAITING_CONTROLLER:0');deliveryStatus='PENDING';proof=$null;retryPolicy='NO_RETRY'}
  PutText (Join-Path $d 'state/outbox.json') (ConvertTo-Json -InputObject @($old) -Depth 6 -Compress)
  PutJson (Join-Path $d 'review.json') @{};PutJson (Join-Path $d 'native.json') @{}
  $r=@{schema='TaskLifecycleUpdateRelease/v1';packet=(Ref (Join-Path $d 'packet.json'));canonical=(Ref (Join-Path $d 'canonical.json'));mapping=(Ref (Join-Path $d 'mapping.json'));beforeIssue=(Ref (Join-Path $d 'before-issue.json'));beforeNote=(Ref (Join-Path $d 'before-note.md'));review=(Ref (Join-Path $d 'review.json'));nativeRequest=(Ref (Join-Path $d 'native.json'));consumer=(Ref $ConsumerPath);transport=(Ref $TransportPath);executable=(Ref (Join-Path $d 'gh-fixture.bin'));stateDir=(Join-Path $d 'state');vaultRoot=(Join-Path $d 'vault');notePath=(Join-Path $d 'vault/task.md');outboxPath=(Join-Path $d 'state/outbox.json');journalPath=(JournalPath $d);canonicalLease=((Join-Path $d 'canonical.json')+'.lock');publisherLease=(Join-Path $d 'state/publisher.lock');tempRoot=(Join-Path $d 'temp');outboxSha256='';recovery='INITIAL'}
  PutJson (Join-Path $d 'release.json') $r;Refresh-Fixture $d
  return $d
}
function Invoke-Fixture($d,[hashtable]$Override=@{}){
  $r=Read-LifecycleJson (Join-Path $d 'release.json')
  $a=@{ReleasePath=(Join-Path $d 'release.json');ExpectedReleaseSha256=(Get-LifecycleFileHash (Join-Path $d 'release.json'));ExpectedReviewSha256=$r.review.sha256;ExpectedNativeRequestSha256=$r.nativeRequest.sha256;ReconcilePath=$ReconcilePath}
  foreach($k in $Override.Keys){$a[$k]=$Override[$k]}
  Invoke-AdmittedTaskLifecycleUpdate @a -ProcessRunner (New-Runner $d)
}
function Assert-FailureRecord($f,[string]$code,[string]$phase,[string]$dest,[string]$op,[string]$category){
  Assert ($f -is [hashtable] -and $f.Count -eq 6 -and $f['schema'] -ceq 'LifecycleUpdateFailure/v1') 'failure record exact schema/shape'
  Assert ($f['code'] -ceq $code -and $f['phase'] -ceq $phase -and $f['destination'] -ceq $dest -and $f['operation'] -ceq $op) ('failure tuple '+($f|ConvertTo-Json -Compress -Depth 6))
  if($category){
    $dg=$f['diagnostic']
    Assert ($dg -is [hashtable] -and $dg.Count -eq 5 -and $dg['category'] -ceq $category) ('diagnostic category '+$category)
  } else {Assert ($null -eq $f['diagnostic']) 'diagnostic null'}
}
function Assert-Flags($ev,[bool]$gs,[bool]$ns,[bool]$ga,[bool]$na){
  Assert ($null -ne $ev -and $ev['githubSent'] -eq $gs -and $ev['noteSent'] -eq $ns -and $ev['githubAck'] -eq $ga -and $ev['noteAck'] -eq $na) ('delivery flags '+($ev|ConvertTo-Json -Compress -Depth 6))
}

$script:Results=[Collections.Generic.List[object]]::new()
function Check($name,[scriptblock]$test){
  $sw=[Diagnostics.Stopwatch]::StartNew()
  try{& $test;$script:Results.Add(@{name=$name;outcome='PASS';elapsedMs=$sw.ElapsedMilliseconds});Write-Output ('PASS '+$name)}
  catch{
    $m=$_.Exception.Message
    # ASSERT = the behavior under test failed; anything else is a harness/unexpected error.
    $kind=if($m.StartsWith('ASSERT: ',[StringComparison]::Ordinal)){'FAIL'}else{'HARNESS_ERROR'}
    $script:Results.Add(@{name=$name;outcome=$kind;error=$m;elapsedMs=$sw.ElapsedMilliseconds});Write-Output ($kind+' '+$name+': '+$m)
  }
}

Check 'failed READ persists category and phase, reload emits zero EDIT, success keeps provenance' {
  $d=New-Fixture 'read-failure';$outHash=Get-LifecycleFileHash (Join-Path $d 'state/outbox.json')
  SetMode $d 'read-fail:RATE_LIMITED'
  $res=Invoke-Fixture $d
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq 'GITHUB_READ_FAILED' -and (Field $res 'automaticRetry') -eq $false) ('public result '+($res|ConvertTo-Json -Compress -Depth 6))
  Assert ((Field (Field $res 'diagnostic') 'category') -ceq 'RATE_LIMITED') 'public diagnostic unchanged'
  $j=ReadJournal $d;$ev=Field $j.events 'update-2'
  Assert ($j.schema -ceq 'LifecycleUpdateJournal/v2' -and $ev.Count -eq 6 -and $ev['digest'] -ceq (FixtureDigest $d)) 'v2 journal, digest preserved'
  Assert-Flags $ev $false $false $false $false
  Assert-FailureRecord $ev['lastFailure'] 'GITHUB_READ_FAILED' 'INITIAL_READ' 'github' 'READ' 'RATE_LIMITED'
  Assert ((Get-LifecycleFileHash (Join-Path $d 'state/outbox.json')) -ceq $outHash -and (EditCount $d) -eq 0) 'no outbox write and zero EDIT'
  SetMode $d 'read-fail:AUTH_REQUIRED'
  $again=Invoke-Fixture $d
  Assert ((Field $again 'code') -ceq 'GITHUB_READ_FAILED' -and (EditCount $d) -eq 0) ('reload reads persisted record without EDIT '+($again|ConvertTo-Json -Compress -Depth 6))
  Assert-FailureRecord (Field (Field (ReadJournal $d).events 'update-2') 'lastFailure') 'GITHUB_READ_FAILED' 'INITIAL_READ' 'github' 'READ' 'AUTH_REQUIRED'
  SetMode $d ''
  $ok=Invoke-Fixture $d
  Assert ((Field $ok 'status') -ceq 'DELIVERED' -and (EditCount $d) -eq 1) ('later success '+($ok|ConvertTo-Json -Compress -Depth 6))
  $ev=Field (ReadJournal $d).events 'update-2'
  Assert-Flags $ev $true $true $true $true
  Assert-FailureRecord $ev['lastFailure'] 'GITHUB_READ_FAILED' 'INITIAL_READ' 'github' 'READ' 'AUTH_REQUIRED'
}

Check 'ambiguous EDIT persists sent flag and diagnostic; reload never issues a second EDIT' {
  $d=New-Fixture 'ambiguous-edit';SetMode $d 'edit-ambiguous-noapply'
  $res=Invoke-Fixture $d
  Assert ((Field $res 'status') -ceq 'PENDING' -and (Field $res 'code') -ceq 'EDIT_AMBIGUOUS_NO_RETRY' -and (Field $res 'automaticRetry') -eq $false -and (Field (Field $res 'diagnostic') 'category') -ceq 'TIMEOUT') ('public result '+($res|ConvertTo-Json -Compress -Depth 6))
  Assert ((EditCount $d) -eq 1) 'single attempted EDIT'
  $ev=Field (ReadJournal $d).events 'update-2'
  Assert-Flags $ev $true $false $false $false
  Assert-FailureRecord $ev['lastFailure'] 'EDIT_AMBIGUOUS_NO_RETRY' 'EDIT' 'github' 'EDIT' 'TIMEOUT'
  Assert (@(Read-LifecycleJson (Join-Path $d 'state/outbox.json')|Where-Object {$_.deliveryStatus -ceq 'DELIVERED'}).Count -eq 0) 'no false ACK'
  $recorded=$ev['lastFailure']|ConvertTo-Json -Compress -Depth 6
  SetMode $d '';Refresh-Fixture $d 'INITIAL'
  $blocked=Invoke-Fixture $d
  Assert ((Field $blocked 'code') -ceq 'EXPLICIT_RECOVERY_REQUIRED' -and (EditCount $d) -eq 1) ('reload without recovery '+($blocked|ConvertTo-Json -Compress -Depth 6))
  Refresh-Fixture $d 'RECONCILE_MISSING'
  $held=Invoke-Fixture $d
  Assert ((Field $held 'code') -ceq 'AMBIGUOUS_EDIT_NO_RETRY' -and (EditCount $d) -eq 1) ('reload with recovery '+($held|ConvertTo-Json -Compress -Depth 6))
  $ev=Field (ReadJournal $d).events 'update-2'
  Assert-Flags $ev $true $false $false $false
  Assert (($ev['lastFailure']|ConvertTo-Json -Compress -Depth 6) -ceq $recorded) 'original ambiguous-EDIT evidence not overwritten by guard refusals'
}

Check 'GitHub ACK then note failure preserves partial flags, destination and sanitized code' {
  $d=New-Fixture 'partial-note'
  # Injected write-failure coverage (test double), not actual filesystem-lock behavior:
  # FileShare locks block replacement on Windows only; Unix rename is still permitted.
  $script:InjectedRealWriter=${function:Write-LifecycleAtomic};$script:InjectedFailPath=(Join-Path $d 'vault/task.md')
  ${function:script:Write-LifecycleAtomic}={param([string]$Path,[byte[]]$Bytes)
    if($Path -ceq $script:InjectedFailPath){throw [IO.IOException]::new('INJECTED_WRITE_FAILURE')}
    & $script:InjectedRealWriter -Path $Path -Bytes $Bytes}
  try{$res=Invoke-Fixture $d}finally{${function:script:Write-LifecycleAtomic}=$script:InjectedRealWriter;$script:InjectedRealWriter=$null;$script:InjectedFailPath=$null}
  Assert ((Field $res 'status') -ceq 'PENDING' -and (Field $res 'automaticRetry') -eq $false) ('public result '+($res|ConvertTo-Json -Compress -Depth 6))
  $ev=Field (ReadJournal $d).events 'update-2'
  Assert-Flags $ev $true $true $true $false
  Assert-FailureRecord $ev['lastFailure'] 'NOTE_WRITE_FAILED' 'NOTE_WRITE' 'note' 'WRITE' ''
  $text=[IO.File]::ReadAllText((JournalPath $d))
  Assert (-not $text.Contains('task.md') -and -not $text.Contains('Exception') -and -not $text.Contains('denied')) 'raw exception text and paths not persisted'
  $out=@(Read-LifecycleJson (Join-Path $d 'state/outbox.json'))
  Assert (@($out|Where-Object {$_.deliveryStatus -ceq 'DELIVERED' -and $_.destination -ceq 'github'}).Count -eq 1 -and @($out|Where-Object {$_.deliveryStatus -ceq 'DELIVERED' -and $_.destination -ceq 'note'}).Count -eq 0) 'partial ACK only for github'
  Refresh-Fixture $d 'RECONCILE_MISSING'
  $done=Invoke-Fixture $d
  Assert ((Field $done 'status') -ceq 'DELIVERED' -and (EditCount $d) -eq 1) ('note-only completion '+($done|ConvertTo-Json -Compress -Depth 6))
  $ev=Field (ReadJournal $d).events 'update-2'
  Assert-Flags $ev $true $true $true $true
  Assert-FailureRecord $ev['lastFailure'] 'NOTE_WRITE_FAILED' 'NOTE_WRITE' 'note' 'WRITE' ''
}

Check 'invalid admission and guard refusals write no journal and no outbox' {
  $expected=@{release=@('REFUSED','RELEASE_DRIFT');packet=@('REFUSED','PUBLIC_TEXT_INVALID');recovery=@('REFUSED','RECOVERY_WITHOUT_EVENT');locked=@('LOCKED','CANONICAL_LOCKED');drift=@('REFUSED','DESTINATION_DRIFT')}
  foreach($case in @('release','packet','recovery','locked','drift')){
    $d=New-Fixture ('refuse-'+$case);$override=@{};$lock=$null
    switch($case){
      release {$override=@{ExpectedReleaseSha256=('0'*64)}}
      packet {$p=Read-LifecycleJson (Join-Path $d 'packet.json');$p.publicSummary='bad<script>';PutJson (Join-Path $d 'packet.json') $p;Refresh-Fixture $d}
      recovery {Refresh-Fixture $d 'RECONCILE_MISSING'}
      locked {$lock=[IO.File]::Open((Join-Path $d 'canonical.json.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
      drift {$s=Read-LifecycleJson (Join-Path $d 'remote.json');$s.body+=' drift';PutJson (Join-Path $d 'remote.json') $s}
    }
    $outHash=Get-LifecycleFileHash (Join-Path $d 'state/outbox.json');$noteHash=Get-LifecycleFileHash (Join-Path $d 'vault/task.md')
    try{$res=Invoke-Fixture $d $override}finally{if($lock){$lock.Dispose()}}
    Assert ((Field $res 'status') -ceq $expected[$case][0] -and (Field $res 'code') -ceq $expected[$case][1]) ($case+' boundary '+($res|ConvertTo-Json -Compress -Depth 6))
    Assert (-not [IO.File]::Exists((JournalPath $d))) ($case+' wrote a journal')
    Assert ((Get-LifecycleFileHash (Join-Path $d 'state/outbox.json')) -ceq $outHash -and (Get-LifecycleFileHash (Join-Path $d 'vault/task.md')) -ceq $noteHash -and (EditCount $d) -eq 0) ($case+' mutated state')
    Assert ($null -eq (Field $res 'failureJournal')) ($case+' claimed a failure journal')
  }
}

Check 'valid legacy v1 journal is not rewritten on refusal and upgrades with unchanged outcome on success' {
  $d=New-Fixture 'legacy-refusal';$old=@{digest=('b'*64);githubSent=$true;noteSent=$true;githubAck=$true;noteAck=$true}
  SeedJournal $d 'LifecycleUpdateJournal/v1' @{'update-2'=(LegacyEvent (FixtureDigest $d));'older-key'=$old}
  $s=Read-LifecycleJson (Join-Path $d 'remote.json');$s.body+=' drift';PutJson (Join-Path $d 'remote.json') $s
  $before=Get-LifecycleFileHash (JournalPath $d)
  $res=Invoke-Fixture $d
  Assert ((Field $res 'code') -ceq 'DESTINATION_DRIFT') ('legacy journal accepted then drift refused '+($res|ConvertTo-Json -Compress -Depth 6))
  Assert ((Get-LifecycleFileHash (JournalPath $d)) -ceq $before) 'refusal left legacy v1 bytes untouched'
  $d=New-Fixture 'legacy-success'
  SeedJournal $d 'LifecycleUpdateJournal/v1' @{'update-2'=(LegacyEvent (FixtureDigest $d));'older-key'=$old}
  $res=Invoke-Fixture $d
  Assert ((Field $res 'status') -ceq 'DELIVERED' -and (Field $res 'code') -ceq 'READBACK_ACK' -and (Field $res 'githubAck') -eq $true -and (Field $res 'noteAck') -eq $true -and (EditCount $d) -eq 1) ('legacy success '+($res|ConvertTo-Json -Compress -Depth 6))
  $j=ReadJournal $d;$cur=Field $j.events 'update-2';$other=Field $j.events 'older-key'
  Assert ($j.schema -ceq 'LifecycleUpdateJournal/v2' -and $cur.Count -eq 6 -and $null -eq $cur['lastFailure'] -and $cur['digest'] -ceq (FixtureDigest $d)) 'current event upgraded with null lastFailure'
  Assert-Flags $cur $true $true $true $true
  Assert ($other.Count -eq 5 -and $other['digest'] -ceq ('b'*64)) 'inherited legacy event unchanged'
  Refresh-Fixture $d 'RECONCILE_MISSING'
  $again=Invoke-Fixture $d
  Assert ((Field $again 'code') -ceq 'DEBOUNCED' -and (EditCount $d) -eq 1) ('replay '+($again|ConvertTo-Json -Compress -Depth 6))
}

Check 'malformed persisted lastFailure refuses while a valid one is accepted' {
  $d=New-Fixture 'lastfailure-valid'
  SeedJournal $d 'LifecycleUpdateJournal/v2' @{'update-2'=(LegacyEvent (FixtureDigest $d))}
  $j=ReadJournal $d;$j.events['update-2']['lastFailure']=ValidRecord;PutJson (JournalPath $d) $j
  $ok=Invoke-Fixture $d
  Assert ((Field $ok 'status') -ceq 'DELIVERED') ('valid persisted record rejected '+($ok|ConvertTo-Json -Compress -Depth 6))
  Assert-FailureRecord (Field (Field (ReadJournal $d).events 'update-2') 'lastFailure') 'GITHUB_READ_FAILED' 'INITIAL_READ' 'github' 'READ' 'RATE_LIMITED'
  foreach($case in @('unknown-code','extra-key','forged-diagnostic','tuple-mismatch','wrong-type','v1-schema')){
    $d=New-Fixture ('lastfailure-'+$case);$rec=ValidRecord;$schema='LifecycleUpdateJournal/v2'
    switch($case){
      unknown-code {$rec.code='LEAK_ME'}
      extra-key {$rec.raw='unexpected'}
      forged-diagnostic {$rec.diagnostic.category='ghp_FAKEMARKER_category'}
      tuple-mismatch {$rec.phase='EDIT'}
      wrong-type {$rec='oops'}
      v1-schema {$schema='LifecycleUpdateJournal/v1'}
    }
    $ev=LegacyEvent (FixtureDigest $d);$ev.lastFailure=$rec
    SeedJournal $d $schema @{'update-2'=$ev}
    $jHash=Get-LifecycleFileHash (JournalPath $d);$outHash=Get-LifecycleFileHash (Join-Path $d 'state/outbox.json')
    $res=Invoke-Fixture $d
    Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq 'JOURNAL_CORRUPT') ($case+' not refused as corrupt '+($res|ConvertTo-Json -Compress -Depth 6))
    Assert ((Get-LifecycleFileHash (JournalPath $d)) -ceq $jHash -and (Get-LifecycleFileHash (Join-Path $d 'state/outbox.json')) -ceq $outHash -and (EditCount $d) -eq 0) ($case+' wrote or mutated')
  }
}

Check 'secret-bearing raw child failure yields only a sanitized category in return and journal' {
  $markers=@('FAKEMARKER','factory-data','someone','access_token','Forbidden')
  $cases=@(@{mode='read-secret-stderr';category='PERMISSION_DENIED'},@{mode='read-forged';category=''},@{mode='read-throw';category='UNAVAILABLE'})
  foreach($c in $cases){
    $d=New-Fixture ('secret-'+$c.mode);SetMode $d $c.mode
    $res=Invoke-Fixture $d
    $resText=$res|ConvertTo-Json -Compress -Depth 8;$jText=[IO.File]::ReadAllText((JournalPath $d))
    Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq 'GITHUB_READ_FAILED') ($c.mode+' public '+$resText)
    foreach($m in $markers){Assert (-not $resText.Contains($m,[StringComparison]::OrdinalIgnoreCase) -and -not $jText.Contains($m,[StringComparison]::OrdinalIgnoreCase)) ($c.mode+' leaked '+$m)}
    if($c.category){Assert ((Field (Field $res 'diagnostic') 'category') -ceq $c.category) ($c.mode+' public category')}
    else {Assert ($null -eq (Field $res 'diagnostic')) ($c.mode+' forged diagnostic omitted from return')}
    Assert-FailureRecord (Field (Field (ReadJournal $d).events 'update-2') 'lastFailure') 'GITHUB_READ_FAILED' 'INITIAL_READ' 'github' 'READ' $c.category
    Assert ((EditCount $d) -eq 0) ($c.mode+' EDIT issued')
  }
}

Check 'failure-record persistence inability fails closed and keeps the original outcome' {
  $d=New-Fixture 'persist-fails'
  SeedJournal $d 'LifecycleUpdateJournal/v1' @{'update-2'=(LegacyEvent (FixtureDigest $d))}
  $before=Get-LifecycleFileHash (JournalPath $d);SetMode $d 'read-fail:RATE_LIMITED'
  # Injected write-failure coverage (test double), not actual filesystem-lock behavior:
  # FileShare locks block replacement on Windows only; Unix rename is still permitted.
  $script:InjectedRealWriter=${function:Write-LifecycleAtomic};$script:InjectedFailPath=(JournalPath $d)
  ${function:script:Write-LifecycleAtomic}={param([string]$Path,[byte[]]$Bytes)
    if($Path -ceq $script:InjectedFailPath){throw [IO.IOException]::new('INJECTED_WRITE_FAILURE')}
    & $script:InjectedRealWriter -Path $Path -Bytes $Bytes}
  try{$res=Invoke-Fixture $d}finally{${function:script:Write-LifecycleAtomic}=$script:InjectedRealWriter;$script:InjectedRealWriter=$null;$script:InjectedFailPath=$null}
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq 'GITHUB_READ_FAILED' -and (Field $res 'automaticRetry') -eq $false) ('original outcome kept '+($res|ConvertTo-Json -Compress -Depth 6))
  Assert ((Field $res 'failureJournal') -ceq 'NOT_PERSISTED') 'no claim of successful persistence'
  Assert-FailureRecord (Field $res 'failure') 'GITHUB_READ_FAILED' 'INITIAL_READ' 'github' 'READ' 'RATE_LIMITED'
  Assert ((Get-LifecycleFileHash (JournalPath $d)) -ceq $before -and (EditCount $d) -eq 0) 'journal untouched, zero EDIT'
}

Check 'persisted numeric conversion boundary preserves strict DTO and caller data' {
  foreach($v in @([int]1,[long]1,[int]0,[int]::MinValue,[int]::MaxValue,[long][int]::MinValue,[long][int]::MaxValue)){
    $r=ValidRecord; $r.diagnostic.exitCode=$v;$before=$r|ConvertTo-Json -Depth 8 -Compress;$type=$r.diagnostic.exitCode.GetType().FullName
    Assert (Test-LifecycleFailureRecord $r) ('valid integral code '+$type+' '+$v)
    Assert (($r|ConvertTo-Json -Depth 8 -Compress)-ceq$before -and $r.diagnostic.exitCode.GetType().FullName-ceq$type) 'caller DTO unchanged'
  }
  foreach($v in @('1',$true,[double]1,[decimal]1,$null,([long][int]::MaxValue+1),([long][int]::MinValue-1))){$r=ValidRecord;$r.diagnostic.exitCode=$v;Assert (-not(Test-LifecycleFailureRecord $r)) ('invalid code type/value '+[string]$v)}
  foreach($k in @('category','exitCode','timedOut','stderrTruncated','stderrEncoding')){$r=ValidRecord;$value=$r.diagnostic[$k];$r.diagnostic.Remove($k);$r.diagnostic[$k.Substring(0,1).ToUpperInvariant()+$k.Substring(1)]=$value;Assert (-not(Test-LifecycleFailureRecord $r)) ('ordinal alias '+$k)}
}

PutJson (Join-Path $Root 'results.json') @($script:Results.ToArray())
$failed=@($script:Results|Where-Object {$_.outcome -ceq 'FAIL'}).Count;$harness=@($script:Results|Where-Object {$_.outcome -ceq 'HARNESS_ERROR'}).Count
Write-Output ('SUMMARY checks='+$script:Results.Count+' failed='+$failed+' harnessErrors='+$harness+' root='+$Root)
if($harness -gt 0){exit 2}
if($failed -gt 0){exit 1}
Write-Output ('ALL_PASS groups='+$script:Results.Count)
exit 0
