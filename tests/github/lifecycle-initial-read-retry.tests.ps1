#Requires -Version 7.6
# Focused offline checks for explicit opt-in INITIAL_READ retry scheduling of the
# admitted lifecycle UPDATE consumer (TaskLifecycleUpdateRelease/v2, journal v3).
# Every dependency is derived from the explicit SourcePath; every fixture lives under
# the fresh caller-owned EvidenceRoot. No gh, network, provider, credential or live
# runtime file is touched: processes are injected offline runners and time is an
# injected UTC clock. The clock and the policy grant no authority.
param(
  [Parameter(Mandatory)][string]$SourcePath,
  [Parameter(Mandatory)][string]$EvidenceRoot
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$AcceptedTransportSha256='140a72148cf074a378262d35d940d865ff29abffafe74d2e70e5c3e243ff75d0'
$AcceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'

function Stop-Harness([string]$Message){throw [InvalidOperationException]::new('HARNESS: '+$Message)}
function Assert($condition,[string]$message){if(-not $condition){throw [InvalidOperationException]::new('ASSERT: '+$message)}}
function Field($o,[string]$n){
  if($null -eq $o){return $null}
  if($o -is [System.Collections.IDictionary]){if($o.Contains($n)){return $o[$n]}else{return $null}}
  if($o.PSObject.Properties.Name -ccontains $n){return $o.$n}
  return $null
}
function Throws([scriptblock]$Block){try{& $Block}catch{return $_.Exception.Message};return $null}

try {
  foreach($p in @($SourcePath,$EvidenceRoot)){
    if(-not [IO.Path]::IsPathFullyQualified($p) -or [IO.Path]::GetFullPath($p) -cne $p){Stop-Harness 'absolute normalized SourcePath and EvidenceRoot required'}
  }
  if(-not [IO.File]::Exists($SourcePath)){Stop-Harness 'SourcePath missing'}
  if([IO.Directory]::Exists($EvidenceRoot) -and @(Get-ChildItem -LiteralPath $EvidenceRoot -Force).Count -gt 0){Stop-Harness 'EvidenceRoot must be fresh (empty or absent)'}
  $TransportPath=Join-Path (Split-Path $SourcePath) 'github-cli-transport216.ps1'
  $ReconcilePath=Join-Path (Join-Path (Join-Path (Split-Path $SourcePath) 'lifecycle-compat') 'continuity') 'reconcile.ps1'
  foreach($p in @($TransportPath,$ReconcilePath)){if(-not [IO.File]::Exists($p)){Stop-Harness 'dependency file missing'}}
  $sha={param($p) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($p))).ToLowerInvariant()}
  if((& $sha $TransportPath) -cne $AcceptedTransportSha256){Stop-Harness 'transport pin drift'}
  if((& $sha $ReconcilePath) -cne $AcceptedReconcileSha256){Stop-Harness 'reconcile pin drift'}
  $SourceSha256=& $sha $SourcePath
  # The lifecycle path never calls the capture helper; a throwing stub keeps this suite closed.
  function Get-ReviewedBlockedEvidenceCapture {throw 'HARNESS_STUB_NOT_USED'}
  . $SourcePath
  . $TransportPath
  if($script:LifecycleConsumerSource -cne $SourcePath){Stop-Harness 'source dot-source path mismatch'}
  $Root=$EvidenceRoot
  [void][IO.Directory]::CreateDirectory($Root)
} catch {
  [Console]::Error.WriteLine('HARNESS_ERROR '+$_.Exception.Message)
  exit 2
}

function PutJson($path,$obj){[IO.File]::WriteAllText($path,($obj|ConvertTo-Json -Depth 18 -Compress),[Text.UTF8Encoding]::new($false))}
function PutText($path,$text){[IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($false))}
function Ref($path){@{path=$path;sha256=(Get-LifecycleFileHash $path)}}
function EditCount($d){[int][IO.File]::ReadAllText((Join-Path $d 'edits.txt'))}
function ReadCount($d){[int][IO.File]::ReadAllText((Join-Path $d 'reads.txt'))}
function SetMode($d,[string]$mode){PutText (Join-Path $d 'mode.txt') $mode}
function JournalPath($d){Join-Path $d 'state/lifecycle-update.journal.json'}
function HasJournal($d){[IO.File]::Exists((JournalPath $d))}
function ReadJournal($d){Read-LifecycleJson (JournalPath $d)}
function JHash($d){Get-LifecycleFileHash (JournalPath $d)}
function Ev($d){(ReadJournal $d).events['update-2']}
function FixtureDigest($d){$c=Read-LifecycleJson (Join-Path $d 'canonical.json');Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c|ConvertTo-Json -Depth 8 -Compress)))}
function LegacyEvent($digest){@{digest=$digest;githubSent=$false;noteSent=$false;githubAck=$false;noteAck=$false}}
function At([string]$text){[datetime]::Parse($text,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)}
function SetClock([string]$text){$script:Clock=(At $text)}
function PolicyText([long]$max=3,[long]$delay=60000,[string]$cats='"RATE_LIMITED","TIMEOUT","NETWORK_UNAVAILABLE"'){
  '{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":'+$max+',"delayMs":'+$delay+',"retryableCategories":['+$cats+']}'
}
function ValidRecord([string]$category='RATE_LIMITED'){@{schema='LifecycleUpdateFailure/v1';code='GITHUB_READ_FAILED';phase='INITIAL_READ';destination='github';operation='READ';diagnostic=@{category=$category;exitCode=1;timedOut=$false;stderrTruncated=$false;stderrEncoding='NOT_OBSERVED'}}}
function PolicySha($d){(Read-LifecycleJson (Join-Path $d 'release.json')).retryPolicy.sha256}
function SeedJournal($d,[string]$schema,$events){PutJson (JournalPath $d) @{schema=$schema;events=$events;heads=@{}}}
function SeedRetry($d,$attempts,$reservedAt,$nextAt,$lastFailure,[hashtable]$Flags=@{}){
  $ev=LegacyEvent (FixtureDigest $d);$ev.lastFailure=$lastFailure
  $ev.retry=@{policySha256=(PolicySha $d);attempts=$attempts;reservedAt=$reservedAt;nextAt=$nextAt}
  foreach($k in $Flags.Keys){$ev[$k]=$Flags[$k]}
  SeedJournal $d 'LifecycleUpdateJournal/v3' @{'update-2'=$ev}
}

$script:Clock=(At '2030-01-01T00:00:00.000Z')
$script:ClockBlock={$script:Clock}

function New-Runner($dir){
  $diagNew=${function:New-GitHubCliFailureDiagnostic216}
  $remotePath=[IO.Path]::Combine($dir,'remote.json');$modePath=[IO.Path]::Combine($dir,'mode.txt');$editsPath=[IO.Path]::Combine($dir,'edits.txt')
  $readsPath=[IO.Path]::Combine($dir,'reads.txt');$journalPath=[IO.Path]::Combine($dir,'state','lifecycle-update.journal.json');$snapPath=[IO.Path]::Combine($dir,'journal-at-read.json')
  return {
    param($exe,$argv,$deadline,$stdoutCap,$stderrCap)
    $mode=if([IO.File]::Exists($modePath)){[IO.File]::ReadAllText($modePath).Trim()}else{''}
    $state=[IO.File]::ReadAllText($remotePath)|ConvertFrom-Json -AsHashtable
    $plain={param($out,$timeout) [pscustomobject]@{exitCode=[int]0;timedOut=[bool]$timeout;stdout=[string]$out;stdoutTruncated=$false;stderrTruncated=$false}}
    $failed={param($diag) [pscustomobject]@{exitCode=[int]1;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false;failureDiagnostic=$diag}}
    if($argv[1] -ceq 'view'){
      [IO.File]::WriteAllText($readsPath,[string]([int][IO.File]::ReadAllText($readsPath)+1))
      # Evidence that the reservation was durable before the transport READ ran.
      if([IO.File]::Exists($journalPath)){[IO.File]::Copy($journalPath,$snapPath,$true)}elseif([IO.File]::Exists($snapPath)){[IO.File]::Delete($snapPath)}
      if($mode.StartsWith('read-fail:',[StringComparison]::Ordinal)){
        return (& $failed (& $diagNew -ExitCode 1 -TimedOut $false -StdoutTruncated $false -StderrTruncated $false -StderrText $null -Category $mode.Substring(10)))
      }
      if($mode -ceq 'read-forged'){
        return (& $failed ([pscustomobject]@{category='ghp_FAKEMARKER_category';exitCode=[int]1;timedOut=$false;stderrTruncated=$false;stderrEncoding='VALID'}))
      }
      return (& $plain ($state|ConvertTo-Json -Compress) $false)
    }
    if($argv[1] -ceq 'edit'){
      [IO.File]::WriteAllText($editsPath,[string]([int][IO.File]::ReadAllText($editsPath)+1))
      if($mode -ceq 'edit-ambiguous-noapply'){return (& $plain '' $true)}
      $bodyIndex=[Array]::IndexOf($argv,'--body-file');$titleIndex=[Array]::IndexOf($argv,'--title')
      $state.body=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($argv[$bodyIndex+1]));$state.title=$argv[$titleIndex+1]
      [IO.File]::WriteAllText($remotePath,($state|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
      return (& $plain $state.url $false)
    }
    throw 'UNEXPECTED_CONNECTOR_OPERATION'
  }.GetNewClosure()
}

function Refresh-Fixture($d,[string]$recovery='INITIAL'){
  $r=Read-LifecycleJson (Join-Path $d 'release.json')
  $v2=($r.schema -ceq 'TaskLifecycleUpdateRelease/v2')
  foreach($name in @('packet','canonical','mapping','beforeIssue','beforeNote')){$r[$name]=Ref $r[$name].path}
  if($v2){$r.retryPolicy=Ref $r.retryPolicy.path}
  $r.recovery=$recovery;$r.outboxSha256=Get-LifecycleFileHash $r.outboxPath
  $rv=[ordered]@{schema=$(if($v2){'LifecycleIndependentReview/v2'}else{'LifecycleIndependentReview/v1'});decision='ADMIT';packetSha256=$r.packet.sha256;consumerSha256=$r.consumer.sha256;transportSha256=$r.transport.sha256}
  if($v2){$rv.retryPolicySha256=$r.retryPolicy.sha256}
  PutJson $r.review.path $rv;$r.review=Ref $r.review.path
  $nv=[ordered]@{schema=$(if($v2){'LifecycleNativeRequest/v2'}else{'LifecycleNativeRequest/v1'});action='UPDATE';packetSha256=$r.packet.sha256;reviewSha256=$r.review.sha256;consumerSha256=$r.consumer.sha256;transportSha256=$r.transport.sha256;executableSha256=$r.executable.sha256;stateDir=$r.stateDir;notePath=$r.notePath;outboxPath=$r.outboxPath}
  if($v2){$nv.retryPolicySha256=$r.retryPolicy.sha256}
  PutJson $r.nativeRequest.path $nv
  $r.nativeRequest=Ref $r.nativeRequest.path
  PutJson (Join-Path $d 'release.json') $r
}
function New-Fixture($name,[string]$policyText=(PolicyText),[switch]$Legacy){
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
  PutJson (Join-Path $d 'remote.json') @{number=67;url=$url;state='OPEN';title='Original task';body=$body};PutText (Join-Path $d 'edits.txt') '0';PutText (Join-Path $d 'reads.txt') '0'
  PutText (Join-Path $d 'gh-fixture.bin') 'fixture executable pin target; never executed'
  PutText (Join-Path $d 'policy.json') $policyText
  $hash='a'*64
  $old=[ordered]@{taskId='ORIGINAL_REFUSED';runId='original';destination='github';status='AWAITING_CONTROLLER';payloadSha256=$hash;attempt=0;key=('ORIGINAL_REFUSED:'+$hash+':original:AWAITING_CONTROLLER:0');deliveryStatus='PENDING';proof=$null;retryPolicy='NO_RETRY'}
  PutText (Join-Path $d 'state/outbox.json') (ConvertTo-Json -InputObject @($old) -Depth 6 -Compress)
  PutJson (Join-Path $d 'review.json') @{};PutJson (Join-Path $d 'native.json') @{}
  $r=@{schema=$(if($Legacy){'TaskLifecycleUpdateRelease/v1'}else{'TaskLifecycleUpdateRelease/v2'});packet=(Ref (Join-Path $d 'packet.json'));canonical=(Ref (Join-Path $d 'canonical.json'));mapping=(Ref (Join-Path $d 'mapping.json'));beforeIssue=(Ref (Join-Path $d 'before-issue.json'));beforeNote=(Ref (Join-Path $d 'before-note.md'));review=(Ref (Join-Path $d 'review.json'));nativeRequest=(Ref (Join-Path $d 'native.json'));consumer=(Ref $SourcePath);transport=(Ref $TransportPath);executable=(Ref (Join-Path $d 'gh-fixture.bin'));stateDir=(Join-Path $d 'state');vaultRoot=(Join-Path $d 'vault');notePath=(Join-Path $d 'vault/task.md');outboxPath=(Join-Path $d 'state/outbox.json');journalPath=(JournalPath $d);canonicalLease=((Join-Path $d 'canonical.json')+'.lock');publisherLease=(Join-Path $d 'state/publisher.lock');tempRoot=(Join-Path $d 'temp');outboxSha256='';recovery='INITIAL'}
  if(-not $Legacy){$r.retryPolicy=(Ref (Join-Path $d 'policy.json'))}
  PutJson (Join-Path $d 'release.json') $r;Refresh-Fixture $d
  return $d
}
function Invoke-Fixture($d,[hashtable]$Override=@{}){
  $r=Read-LifecycleJson (Join-Path $d 'release.json')
  $a=@{ReleasePath=(Join-Path $d 'release.json');ExpectedReleaseSha256=(Get-LifecycleFileHash (Join-Path $d 'release.json'));ExpectedReviewSha256=$r.review.sha256;ExpectedNativeRequestSha256=$r.nativeRequest.sha256;ReconcilePath=$ReconcilePath;UtcClock=$script:ClockBlock}
  foreach($k in $Override.Keys){$a[$k]=$Override[$k]}
  Invoke-AdmittedTaskLifecycleUpdate @a -ProcessRunner (New-Runner $d)
}
function Describe($res){$res|ConvertTo-Json -Compress -Depth 6}
function Assert-Refused($d,$res,[string]$code,[string]$why){
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq $code) ($why+' expected REFUSED '+$code+' got '+(Describe $res))
  Assert ((ReadCount $d) -eq 0 -and (EditCount $d) -eq 0) ($why+' reached the transport')
}
function Assert-Refused2($d,$res,[string]$code,[int]$reads,[string]$why){
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq $code) ($why+' expected REFUSED '+$code+' got '+(Describe $res))
  Assert ((ReadCount $d) -eq $reads -and (EditCount $d) -eq 0) ($why+' used the transport')
}
function Assert-Flags($ev,[bool]$gs,[bool]$ns,[bool]$ga,[bool]$na){
  Assert ($null -ne $ev -and $ev['githubSent'] -eq $gs -and $ev['noteSent'] -eq $ns -and $ev['githubAck'] -eq $ga -and $ev['noteAck'] -eq $na) ('delivery flags '+(Describe $ev))
}
function Assert-Retry($ev,[long]$attempts,$reservedAt,$nextAt){
  $s=$ev['retry']
  Assert ($ev.Count -eq 7 -and $s -is [hashtable] -and $s.Count -eq 4) ('v3 current event shape '+(Describe $ev))
  Assert ([long]$s['attempts'] -eq $attempts) ('attempts expected '+$attempts+' got '+(Describe $s))
  if($null -ne $reservedAt){Assert ($s['reservedAt'] -ceq $reservedAt) ('reservedAt '+(Describe $s))}
  Assert (($null -eq $nextAt -and $null -eq $s['nextAt']) -or ($null -ne $nextAt -and $s['nextAt'] -ceq $nextAt)) ('nextAt expected '+[string]$nextAt+' got '+(Describe $s))
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

Check 'malformed or unsafe policy refuses before state and transport' {
  $bad=[ordered]@{
    extraKey='{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":3,"delayMs":1,"retryableCategories":["TIMEOUT"],"extra":1}'
    missingKey='{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":3,"retryableCategories":["TIMEOUT"]}'
    keyAlias='{"schema":"LifecycleInitialReadRetryPolicy/v1","MaxAttempts":3,"delayMs":1,"retryableCategories":["TIMEOUT"]}'
    wrongSchema='{"schema":"LifecycleInitialReadRetryPolicy/v2","maxAttempts":3,"delayMs":1,"retryableCategories":["TIMEOUT"]}'
    zeroAttempts=(PolicyText 0 1 '"TIMEOUT"')
    negativeDelay=(PolicyText 3 -1 '"TIMEOUT"')
    stringAttempts='{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":"3","delayMs":1,"retryableCategories":["TIMEOUT"]}'
    boolDelay='{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":3,"delayMs":true,"retryableCategories":["TIMEOUT"]}'
    fractionAttempts='{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":2.5,"delayMs":1,"retryableCategories":["TIMEOUT"]}'
    floatForm='{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":3.0,"delayMs":1,"retryableCategories":["TIMEOUT"]}'
    unsafeAttempts=(PolicyText 9007199254740992 1 '"TIMEOUT"')
    unsafeDelay=(PolicyText 3 9007199254740992 '"TIMEOUT"')
    overflowAttempts='{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":99999999999999999999999,"delayMs":1,"retryableCategories":["TIMEOUT"]}'
    emptyCategories=(PolicyText 3 1 '')
    duplicateCategory=(PolicyText 3 1 '"TIMEOUT","TIMEOUT"')
    authCategory=(PolicyText 3 1 '"AUTH_REQUIRED"')
    permissionCategory=(PolicyText 3 1 '"TIMEOUT","PERMISSION_DENIED"')
    lowerCategory=(PolicyText 3 1 '"timeout"')
    scalarCategories='{"schema":"LifecycleInitialReadRetryPolicy/v1","maxAttempts":3,"delayMs":1,"retryableCategories":"TIMEOUT"}'
    notObject='[1,2]'
  }
  foreach($name in $bad.Keys){
    $d=New-Fixture ('policy-'+$name) $bad[$name]
    $res=Invoke-Fixture $d
    Assert-Refused $d $res 'RETRY_POLICY_INVALID' $name
    Assert (-not (HasJournal $d)) ($name+' wrote a journal')
  }
  # Boundary values stay accepted: maxAttempts 1 and the largest safe delay with zero delay.
  foreach($ok in @((PolicyText 1 0 '"NETWORK_UNAVAILABLE"'),(PolicyText 9007199254740991 9007199254740991 '"TIMEOUT","RATE_LIMITED","NETWORK_UNAVAILABLE"'))){
    $d=New-Fixture ('policy-ok-'+[guid]::NewGuid().ToString('N')) $ok
    SetMode $d 'read-fail:TIMEOUT'
    $res=Invoke-Fixture $d
    Assert ((Field $res 'code') -ceq 'GITHUB_READ_FAILED' -and (ReadCount $d) -eq 1) ('valid boundary policy reaches one READ '+(Describe $res))
  }
}

Check 'release, review and native request schemas and policy pins bind exactly' {
  $cases=@('release-missing-policy','release-v1-with-policy','review-v1','native-v1','review-wrong-policy','native-wrong-policy','policy-drift-after-pin','release-policy-sha-wrong')
  foreach($case in $cases){
    $d=New-Fixture ('bind-'+$case);$code='';$override=@{}
    $r=Read-LifecycleJson (Join-Path $d 'release.json')
    switch($case){
      release-missing-policy {$r.Remove('retryPolicy');PutJson (Join-Path $d 'release.json') $r;$code='FIELDS_INVALID'}
      release-v1-with-policy {$r.schema='TaskLifecycleUpdateRelease/v1';PutJson (Join-Path $d 'release.json') $r;$code='FIELDS_INVALID'}
      review-v1 {$rv=[ordered]@{schema='LifecycleIndependentReview/v1';decision='ADMIT';packetSha256=$r.packet.sha256;consumerSha256=$r.consumer.sha256;transportSha256=$r.transport.sha256};PutJson $r.review.path $rv;$r.review=Ref $r.review.path;PutJson (Join-Path $d 'release.json') $r;$code='FIELDS_INVALID'}
      native-v1 {$n=Read-LifecycleJson $r.nativeRequest.path;$n.Remove('retryPolicySha256');$n.schema='LifecycleNativeRequest/v1';PutJson $r.nativeRequest.path $n;$r.nativeRequest=Ref $r.nativeRequest.path;PutJson (Join-Path $d 'release.json') $r;$code='FIELDS_INVALID'}
      review-wrong-policy {$rv=Read-LifecycleJson $r.review.path;$rv.retryPolicySha256=('0'*64);PutJson $r.review.path $rv;$r.review=Ref $r.review.path;PutJson (Join-Path $d 'release.json') $r;$code='REVIEW_BINDING'}
      native-wrong-policy {$n=Read-LifecycleJson $r.nativeRequest.path;$n.retryPolicySha256=('0'*64);PutJson $r.nativeRequest.path $n;$r.nativeRequest=Ref $r.nativeRequest.path;PutJson (Join-Path $d 'release.json') $r;$code='NATIVE_BINDING'}
      policy-drift-after-pin {PutText (Join-Path $d 'policy.json') (PolicyText 5 1 '"TIMEOUT"');$code='PIN_DRIFT'}
      release-policy-sha-wrong {$r.retryPolicy.sha256='0'*64;PutJson (Join-Path $d 'release.json') $r;$code='PIN_DRIFT'}
    }
    # Review/native files changed above are re-pinned by the release; expected review/native pins follow.
    $rr=Read-LifecycleJson (Join-Path $d 'release.json');$override=@{ExpectedReviewSha256=$rr.review.sha256;ExpectedNativeRequestSha256=$rr.nativeRequest.sha256}
    $res=Invoke-Fixture $d $override
    Assert-Refused $d $res $code $case
    Assert (-not (HasJournal $d)) ($case+' wrote a journal')
  }
  # Legacy v1 admission is unchanged: exact original shapes still deliver with the old journal v2.
  $d=New-Fixture 'bind-legacy-v1' -Legacy
  $res=Invoke-Fixture $d
  Assert ((Field $res 'status') -ceq 'DELIVERED' -and (Field $res 'code') -ceq 'READBACK_ACK') ('legacy v1 release '+(Describe $res))
  $j=ReadJournal $d;Assert ($j.schema -ceq 'LifecycleUpdateJournal/v2' -and $j.events['update-2'].Count -eq 6) 'legacy journal stays v2 with six-field event'
}

Check 'transient initial read failure reserves before READ, persists nextAt, restart is NOT_DUE with zero transport' {
  $d=New-Fixture 'schedule';$outHash=Get-LifecycleFileHash (Join-Path $d 'state/outbox.json')
  SeedJournal $d 'LifecycleUpdateJournal/v1' @{'older-key'=@{digest=('b'*64);githubSent=$true;noteSent=$true;githubAck=$true;noteAck=$true}}
  SetMode $d 'read-fail:RATE_LIMITED';SetClock '2030-01-01T00:00:00.000Z'
  $res=Invoke-Fixture $d
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq 'GITHUB_READ_FAILED' -and (Field $res 'automaticRetry') -eq $false -and (Field (Field $res 'diagnostic') 'category') -ceq 'RATE_LIMITED') ('public result '+(Describe $res))
  Assert ((ReadCount $d) -eq 1 -and (EditCount $d) -eq 0) 'exactly one READ and no EDIT'
  $snap=Read-LifecycleJson (Join-Path $d 'journal-at-read.json');$sev=$snap.events['update-2']
  Assert ($snap.schema -ceq 'LifecycleUpdateJournal/v3' -and $sev['retry']['attempts'] -eq 1 -and $null -eq $sev['retry']['nextAt'] -and $sev['retry']['reservedAt'] -ceq '2030-01-01T00:00:00.000Z') 'reservation was durable before the READ'
  $j=ReadJournal $d;$ev=$j.events['update-2']
  Assert ($j.schema -ceq 'LifecycleUpdateJournal/v3' -and $ev['digest'] -ceq (FixtureDigest $d)) 'v3 journal, digest preserved'
  Assert-Flags $ev $false $false $false $false
  Assert-Retry $ev 1 '2030-01-01T00:00:00.000Z' '2030-01-01T00:01:00.000Z'
  Assert ($ev['retry']['policySha256'] -ceq (PolicySha $d)) 'policy pin recorded'
  Assert ($ev['lastFailure']['code'] -ceq 'GITHUB_READ_FAILED' -and $ev['lastFailure']['phase'] -ceq 'INITIAL_READ' -and $ev['lastFailure']['diagnostic']['category'] -ceq 'RATE_LIMITED') 'sanitized failure retained'
  $other=$j.events['older-key'];Assert ($other.Count -eq 5 -and $other['digest'] -ceq ('b'*64) -and $other['githubAck'] -eq $true) 'other event data unchanged'
  Assert ((Get-LifecycleFileHash (Join-Path $d 'state/outbox.json')) -ceq $outHash) 'no outbox write'
  # Restart before nextAt: NOT_DUE, no transport, journal bytes identical.
  Refresh-Fixture $d;SetClock '2030-01-01T00:00:59.999Z';$h=JHash $d
  $again=Invoke-Fixture $d
  Assert ((Field $again 'status') -ceq 'NOT_DUE' -and (Field $again 'code') -ceq 'NOT_DUE' -and (Field $again 'automaticRetry') -eq $false) ('not due '+(Describe $again))
  Assert ((ReadCount $d) -eq 1 -and (JHash $d) -ceq $h) 'NOT_DUE: zero transport and no counter change'
}

Check 'due retry needs fresh admission; attempts count; budget exhaustion is zero transport' {
  $d=New-Fixture 'due-and-budget'
  SetMode $d 'read-fail:TIMEOUT';SetClock '2030-01-01T00:00:00.000Z'
  [void](Invoke-Fixture $d)
  Assert-Retry (Ev $d) 1 '2030-01-01T00:00:00.000Z' '2030-01-01T00:01:00.000Z'
  # Exactly at nextAt the retry is due: second attempt, fails again, new schedule from the new clock.
  Refresh-Fixture $d;SetClock '2030-01-01T00:01:00.000Z'
  $res=Invoke-Fixture $d
  Assert ((Field $res 'code') -ceq 'GITHUB_READ_FAILED' -and (ReadCount $d) -eq 2) ('second attempt '+(Describe $res))
  Assert ((Read-LifecycleJson (Join-Path $d 'journal-at-read.json')).events['update-2']['retry']['attempts'] -eq 2) 'second reservation durable before READ'
  Assert-Retry (Ev $d) 2 '2030-01-01T00:01:00.000Z' '2030-01-01T00:02:00.000Z'
  # Third and last attempt: no nextAt because the budget is spent.
  Refresh-Fixture $d;SetClock '2030-01-01T00:05:00.000Z'
  [void](Invoke-Fixture $d)
  Assert ((ReadCount $d) -eq 3) 'third attempt read'
  Assert-Retry (Ev $d) 3 '2030-01-01T00:05:00.000Z' $null
  Refresh-Fixture $d;SetClock '2031-01-01T00:00:00.000Z';$h=JHash $d
  $dead=Invoke-Fixture $d
  Assert ((Field $dead 'status') -ceq 'BUDGET_EXHAUSTED' -and (Field $dead 'code') -ceq 'BUDGET_EXHAUSTED' -and (Field $dead 'automaticRetry') -eq $false) ('exhausted '+(Describe $dead))
  Assert ((ReadCount $d) -eq 3 -and (EditCount $d) -eq 0 -and (JHash $d) -ceq $h) 'BUDGET_EXHAUSTED: zero transport and no counter change'
  Refresh-Fixture $d 'RECONCILE_MISSING'
  $dead2=Invoke-Fixture $d
  Assert ((Field $dead2 'code') -ceq 'BUDGET_EXHAUSTED' -and (ReadCount $d) -eq 3) 'recovery admission does not widen the budget'
  # maxAttempts 1: the first failure schedules nothing.
  $d=New-Fixture 'budget-one' (PolicyText 1 5 '"TIMEOUT"');SetMode $d 'read-fail:TIMEOUT';SetClock '2030-01-01T00:00:00.000Z'
  [void](Invoke-Fixture $d)
  Assert-Retry (Ev $d) 1 '2030-01-01T00:00:00.000Z' $null
  Refresh-Fixture $d;SetClock '2035-01-01T00:00:00.000Z'
  Assert ((Field (Invoke-Fixture $d) 'code') -ceq 'BUDGET_EXHAUSTED' -and (ReadCount $d) -eq 1) 'single-attempt policy exhausted'
  # A due attempt that succeeds continues the unchanged admitted UPDATE path and ACKs by readback.
  $d=New-Fixture 'due-success';SetMode $d 'read-fail:NETWORK_UNAVAILABLE';SetClock '2030-01-01T00:00:00.000Z'
  [void](Invoke-Fixture $d)
  SetMode $d '';Refresh-Fixture $d;SetClock '2030-01-01T00:02:00.000Z'
  $ok=Invoke-Fixture $d
  Assert ((Field $ok 'status') -ceq 'DELIVERED' -and (Field $ok 'code') -ceq 'READBACK_ACK' -and (EditCount $d) -eq 1) ('due success '+(Describe $ok))
  $ev=Ev $d;Assert-Flags $ev $true $true $true $true
  Assert ([long]$ev['retry']['attempts'] -eq 2) 'attempt 2 consumed by the successful retry'
  $out=@(Read-LifecycleJson (Join-Path $d 'state/outbox.json'))
  Assert (@($out|Where-Object {$_.deliveryStatus -ceq 'DELIVERED'}).Count -eq 2) 'both destinations ACKed from readback evidence'
}

Check 'changed, missing or legacy policy state refuses with zero transport' {
  $d=New-Fixture 'pin-change';SetMode $d 'read-fail:TIMEOUT';SetClock '2030-01-01T00:00:00.000Z'
  [void](Invoke-Fixture $d)
  # A different but valid policy, fully re-admitted: the event's pin cannot change.
  PutText (Join-Path $d 'policy.json') (PolicyText 9 1 '"TIMEOUT"');Refresh-Fixture $d;SetClock '2030-06-01T00:00:00.000Z';$h=JHash $d
  $res=Invoke-Fixture $d
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq 'RETRY_POLICY_PIN_MISMATCH') ('changed policy '+(Describe $res))
  Assert ((ReadCount $d) -eq 1 -and (JHash $d) -ceq $h) 'changed policy: zero new transport, journal unchanged'
  # A v1 (no policy) release cannot drive an event that carries retry state.
  $d=New-Fixture 'pin-missing';SeedRetry $d 1 '2030-01-01T00:00:00.000Z' '2030-01-01T00:01:00.000Z' (ValidRecord)
  $r=Read-LifecycleJson (Join-Path $d 'release.json');$r.Remove('retryPolicy');$r.schema='TaskLifecycleUpdateRelease/v1';PutJson (Join-Path $d 'release.json') $r;Refresh-Fixture $d
  $h=JHash $d;SetClock '2031-01-01T00:00:00.000Z'
  $res=Invoke-Fixture $d
  Assert-Refused $d $res 'JOURNAL_CORRUPT' 'v1 release on a v3 journal'
  Assert ((JHash $d) -ceq $h) 'v1 release on a v3 journal: journal unchanged'
  # Legacy v1/v2 events carry an UNKNOWN prior count: never opted in, inferred, reset or migrated.
  foreach($shape in @('v1-event','v2-null-failure','v2-initial-read-failure')){
    $d=New-Fixture ('legacy-'+$shape);$ev=LegacyEvent (FixtureDigest $d);$schema='LifecycleUpdateJournal/v1'
    if($shape -ne 'v1-event'){$schema='LifecycleUpdateJournal/v2';$ev.lastFailure=$(if($shape -ceq 'v2-null-failure'){$null}else{ValidRecord})}
    SeedJournal $d $schema @{'update-2'=$ev};$h=JHash $d
    $res=Invoke-Fixture $d
    Assert-Refused $d $res 'RETRY_COUNT_UNKNOWN' $shape
    Assert ((JHash $d) -ceq $h) ($shape+': journal bytes unchanged')
  }
}

Check 'reservation-only crash, unknown outcome and persistence failure stay consumed and fail closed' {
  $stale='2030-01-01T00:00:00.000Z'
  # Reservation outstanding (nextAt null): outcome unknown, never retried automatically.
  foreach($shape in @('first-reservation','stale-eligible-failure')){
    $d=New-Fixture ('crash-'+$shape)
    if($shape -ceq 'first-reservation'){SeedRetry $d 1 $stale $null $null}else{SeedRetry $d 2 $stale $null (ValidRecord)}
    SetClock '2040-01-01T00:00:00.000Z';$h=JHash $d
    $res=Invoke-Fixture $d
    Assert-Refused $d $res 'RETRY_ATTEMPT_UNKNOWN' $shape
    Assert ((JHash $d) -ceq $h) ($shape+': no counter change')
  }
  $d=New-Fixture 'crash-last-attempt';SeedRetry $d 3 $stale $null $null;SetClock '2040-01-01T00:00:00.000Z'
  Assert ((Field (Invoke-Fixture $d) 'code') -ceq 'BUDGET_EXHAUSTED' -and (ReadCount $d) -eq 0) 'consumed last reservation is exhausted'
  # Reservation write failure: nothing is read.
  $d=New-Fixture 'reserve-write-fails';SetMode $d 'read-fail:TIMEOUT'
  $script:InjectedRealWriter=${function:Write-LifecycleAtomic};$script:InjectedFailPath=(JournalPath $d)
  ${function:script:Write-LifecycleAtomic}={param([string]$Path,[byte[]]$Bytes)
    if($Path -ceq $script:InjectedFailPath){throw [IO.IOException]::new('INJECTED_WRITE_FAILURE')}
    & $script:InjectedRealWriter -Path $Path -Bytes $Bytes}
  try{$res=Invoke-Fixture $d}finally{${function:script:Write-LifecycleAtomic}=$script:InjectedRealWriter;$script:InjectedRealWriter=$null;$script:InjectedFailPath=$null}
  Assert-Refused $d $res 'RETRY_RESERVATION_NOT_PERSISTED' 'reservation write failure'
  Assert (-not (HasJournal $d)) 'no journal after failed reservation'
  # Schedule persistence failure: second journal write fails; original reason kept, NOT_PERSISTED, reservation stays consumed.
  $d=New-Fixture 'schedule-write-fails';SetMode $d 'read-fail:RATE_LIMITED';SetClock '2030-01-01T00:00:00.000Z'
  $script:InjectedRealWriter=${function:Write-LifecycleAtomic};$script:InjectedFailPath=(JournalPath $d);$script:InjectedWrites=0
  ${function:script:Write-LifecycleAtomic}={param([string]$Path,[byte[]]$Bytes)
    if($Path -ceq $script:InjectedFailPath){$script:InjectedWrites++;if($script:InjectedWrites -ge 2){throw [IO.IOException]::new('INJECTED_WRITE_FAILURE')}}
    & $script:InjectedRealWriter -Path $Path -Bytes $Bytes}
  try{$res=Invoke-Fixture $d}finally{${function:script:Write-LifecycleAtomic}=$script:InjectedRealWriter;$script:InjectedRealWriter=$null;$script:InjectedFailPath=$null}
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq 'GITHUB_READ_FAILED' -and (Field $res 'automaticRetry') -eq $false -and (Field $res 'failureJournal') -ceq 'NOT_PERSISTED') ('original reason kept '+(Describe $res))
  Assert ((ReadCount $d) -eq 1) 'one READ'
  $ev=Ev $d;Assert-Retry $ev 1 '2030-01-01T00:00:00.000Z' $null
  Assert ($null -eq $ev['lastFailure']) 'failure not claimed as persisted'
  Refresh-Fixture $d;SetClock '2040-01-01T00:00:00.000Z'
  Assert ((Field (Invoke-Fixture $d) 'code') -ceq 'RETRY_ATTEMPT_UNKNOWN' -and (ReadCount $d) -eq 1) 'no automatic retry after NOT_PERSISTED'
}

Check 'identity mismatch and non-selected diagnostics are never scheduled' {
  # ok-shaped READ for a closed issue: fail-closed NONRETRYABLE, not GITHUB_READ_FAILED.
  $d=New-Fixture 'identity-closed';$s=Read-LifecycleJson (Join-Path $d 'remote.json');$s.state='CLOSED';PutJson (Join-Path $d 'remote.json') $s
  $res=Invoke-Fixture $d
  Assert ((Field $res 'code') -ceq 'READ_IDENTITY_MISMATCH' -and (Field $res 'code') -cne 'GITHUB_READ_FAILED' -and (ReadCount $d) -eq 1) ('closed state '+(Describe $res))
  $ev=Ev $d;Assert-Retry $ev 1 $null $null
  Assert ($ev['lastFailure']['code'] -ceq 'UNKNOWN' -and $null -eq $ev['lastFailure']['diagnostic']) 'mismatch persisted as UNKNOWN without diagnostic'
  Refresh-Fixture $d;SetClock '2040-01-01T00:00:00.000Z'
  Assert-Refused2 $d (Invoke-Fixture $d) 'RETRY_NOT_ELIGIBLE' 1 'closed state retry'
  # The pinned transport itself rejects a wrong issue number without a diagnostic: also not eligible.
  $d=New-Fixture 'identity-number';$s=Read-LifecycleJson (Join-Path $d 'remote.json');$s.number=68;PutJson (Join-Path $d 'remote.json') $s
  [void](Invoke-Fixture $d);Assert-Retry (Ev $d) 1 $null $null
  Refresh-Fixture $d;SetClock '2040-01-01T00:00:00.000Z'
  Assert-Refused2 $d (Invoke-Fixture $d) 'RETRY_NOT_ELIGIBLE' 1 'wrong number retry'
  # Auth/security/permission and every other unselected diagnostic: no schedule, no retry.
  foreach($mode in @('read-fail:AUTH_REQUIRED','read-fail:PERMISSION_DENIED','read-fail:NOT_FOUND','read-fail:VALIDATION_FAILED','read-fail:UNKNOWN','read-fail:UNAVAILABLE','read-fail:OUTPUT_TRUNCATED','read-forged')){
    $d=New-Fixture ('ineligible-'+$mode.Replace(':','-'));SetMode $d $mode;SetClock '2030-01-01T00:00:00.000Z'
    [void](Invoke-Fixture $d)
    Assert-Retry (Ev $d) 1 '2030-01-01T00:00:00.000Z' $null
    Refresh-Fixture $d;SetClock '2040-01-01T00:00:00.000Z'
    Assert-Refused2 $d (Invoke-Fixture $d) 'RETRY_NOT_ELIGIBLE' 1 $mode
  }
  # A transient category the policy did not select is equally ineligible.
  $d=New-Fixture 'ineligible-unselected' (PolicyText 3 1 '"TIMEOUT"');SetMode $d 'read-fail:RATE_LIMITED';SetClock '2030-01-01T00:00:00.000Z'
  [void](Invoke-Fixture $d);Assert-Retry (Ev $d) 1 '2030-01-01T00:00:00.000Z' $null
  Refresh-Fixture $d;SetClock '2040-01-01T00:00:00.000Z'
  Assert-Refused2 $d (Invoke-Fixture $d) 'RETRY_NOT_ELIGIBLE' 1 'unselected category'
  # Only a policy-selected failure from INITIAL_READ is eligible; the same code from another phase is not.
  $d=New-Fixture 'ineligible-phase'
  $rec=ValidRecord;$rec.phase='EDIT_READBACK'
  SeedRetry $d 1 '2030-01-01T00:00:00.000Z' '2030-01-01T00:01:00.000Z' $rec;SetClock '2040-01-01T00:00:00.000Z'
  Assert-Refused $d (Invoke-Fixture $d) 'JOURNAL_CORRUPT' 'scheduled nextAt on an ineligible record'
}

Check 'delivered replay and debounce consume no attempt' {
  $d=New-Fixture 'replay';SetClock '2030-01-01T00:00:00.000Z'
  $first=Invoke-Fixture $d
  Assert ((Field $first 'code') -ceq 'READBACK_ACK' -and (EditCount $d) -eq 1) ('first delivery '+(Describe $first))
  $ev=Ev $d;Assert-Flags $ev $true $true $true $true;Assert-Retry $ev 1 '2030-01-01T00:00:00.000Z' $null
  $h=JHash $d
  Refresh-Fixture $d 'RECONCILE_MISSING';SetClock '2031-01-01T00:00:00.000Z'
  $again=Invoke-Fixture $d
  Assert ((Field $again 'code') -ceq 'DEBOUNCED' -and (EditCount $d) -eq 1) ('replay '+(Describe $again))
  Assert-Retry (Ev $d) 1 '2030-01-01T00:00:00.000Z' $null
  Assert ((JHash $d) -ceq $h) 'replay left the journal byte-identical'
}

Check 'sent, ambiguous EDIT and forged due state are never widened by the policy' {
  $d=New-Fixture 'ambiguous';SetMode $d 'edit-ambiguous-noapply';SetClock '2030-01-01T00:00:00.000Z'
  $res=Invoke-Fixture $d
  Assert ((Field $res 'status') -ceq 'PENDING' -and (Field $res 'code') -ceq 'EDIT_AMBIGUOUS_NO_RETRY' -and (EditCount $d) -eq 1) ('ambiguous edit '+(Describe $res))
  $ev=Ev $d;Assert-Flags $ev $true $false $false $false;Assert-Retry $ev 1 '2030-01-01T00:00:00.000Z' $null
  $recorded=$ev['lastFailure']|ConvertTo-Json -Compress
  SetMode $d '';Refresh-Fixture $d 'INITIAL';SetClock '2040-01-01T00:00:00.000Z'
  $blocked=Invoke-Fixture $d
  Assert ((Field $blocked 'code') -ceq 'EXPLICIT_RECOVERY_REQUIRED' -and (EditCount $d) -eq 1) ('without recovery '+(Describe $blocked))
  Refresh-Fixture $d 'RECONCILE_MISSING'
  $held=Invoke-Fixture $d
  Assert ((Field $held 'code') -ceq 'AMBIGUOUS_EDIT_NO_RETRY' -and (EditCount $d) -eq 1) ('with recovery '+(Describe $held))
  $ev=Ev $d;Assert-Flags $ev $true $false $false $false;Assert-Retry $ev 1 '2030-01-01T00:00:00.000Z' $null
  Assert (($ev['lastFailure']|ConvertTo-Json -Compress) -ceq $recorded) 'ambiguous EDIT evidence not overwritten'
  # Forged: a sent event whose retry state looks due and eligible still gets no reservation and no retry.
  foreach($flag in @('githubSent','noteSent','githubAck','noteAck')){
    $d=New-Fixture ('forged-'+$flag);SeedRetry $d 1 '2030-01-01T00:00:00.000Z' '2030-01-01T00:01:00.000Z' (ValidRecord) @{($flag)=$true}
    SetClock '2040-01-01T00:00:00.000Z';$h=JHash $d
    $res=Invoke-Fixture $d
    Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -cin @('EXPLICIT_RECOVERY_REQUIRED','ACK_DRIFT')) ($flag+': existing guard '+(Describe $res))
    Assert ((EditCount $d) -eq 0 -and (ReadCount $d) -eq 1) ($flag+': only the ordinary unreserved READ, no EDIT')
    Assert ((JHash $d) -ceq $h) ($flag+': counter and journal untouched')
  }
}

Check 'checked UTC arithmetic, clock seam and persisted state validation' {
  $max=[datetime]::new([datetime]::MaxValue.Ticks,[DateTimeKind]::Utc)
  Assert ($null -eq (Throws {[void](Add-LifecycleCheckedMs $max 0)})) 'zero delay at the maximum instant is representable'
  Assert ((Throws {[void](Add-LifecycleCheckedMs $max 1)}) -ceq 'RETRY_TIME_OVERFLOW') 'overflow at the maximum instant'
  Assert ((Throws {[void](Add-LifecycleCheckedMs (At '2030-01-01T00:00:00.000Z') 9007199254740991)}) -ceq 'RETRY_TIME_OVERFLOW') 'largest safe delay overflows'
  Assert ((Format-LifecycleUtc (Add-LifecycleCheckedMs (At '2030-01-01T00:00:00.000Z') 1500)) -ceq '2030-01-01T00:00:01.500Z') 'canonical millisecond addition'
  foreach($bad in @('2030-01-01T00:00:00Z','2030-01-01T00:00:00.0000Z','2030-01-01 00:00:00.000Z','2030-13-01T00:00:00.000Z','2030-02-30T00:00:00.000Z','2030-01-01T00:00:00.000+00:00','',$null,5)){
    Assert ((Throws {[void](ConvertFrom-LifecycleUtc $bad)}) -ceq 'JOURNAL_CORRUPT') ('non-canonical timestamp '+[string]$bad)
  }
  $policy=Assert-LifecycleRetryPolicy (Read-LifecycleJson (Join-Path (New-Fixture 'unit-policy') 'policy.json'))
  $sha='d'*64;$resAt='2030-01-01T00:00:00.000Z';$next='2030-01-01T00:01:00.000Z'
  function Retry([hashtable]$Over=@{}){$s=@{policySha256=$sha;attempts=1;reservedAt=$resAt;nextAt=$next};foreach($k in $Over.Keys){$s[$k]=$Over[$k]};$s}
  Assert ($null -eq (Throws {Assert-LifecycleRetryState (Retry) $policy $sha})) 'valid state'
  Assert ($null -eq (Throws {Assert-LifecycleRetryState (Retry @{nextAt=$null;attempts=3}) $policy $sha})) 'valid exhausted state'
  Assert ($null -eq (Throws {Assert-LifecycleRetryState (Retry @{attempts=[long]2}) $policy $sha})) 'Int64 attempts from reload'
  foreach($case in @(
    @{n='zero attempts';o=@{attempts=0}},@{n='over budget';o=@{attempts=4}},@{n='string attempts';o=@{attempts='1'}},@{n='double attempts';o=@{attempts=1.5}},@{n='bool attempts';o=@{attempts=$true}},
    @{n='nextAt before reservedAt';o=@{nextAt='2029-12-31T23:59:59.999Z'}},@{n='nextAt with spent budget';o=@{attempts=3}},@{n='bad reservedAt';o=@{reservedAt='yesterday'}},
    @{n='null reservedAt';o=@{reservedAt=$null}},@{n='bad sha';o=@{policySha256='XYZ'}},@{n='uppercase sha';o=@{policySha256=('D'*64)}}
  )){
    Assert ((Throws {Assert-LifecycleRetryState (Retry $case.o) $policy $sha}) -ceq 'JOURNAL_CORRUPT') ('invalid state: '+$case.n)
  }
  Assert ((Throws {Assert-LifecycleRetryState (Retry @{policySha256=('e'*64)}) $policy $sha}) -ceq 'RETRY_POLICY_PIN_MISMATCH') 'same-event policy pin cannot change'
  $extra=Retry;$extra.extra=1;Assert ((Throws {Assert-LifecycleRetryState $extra $policy $sha}) -ceq 'JOURNAL_CORRUPT') 'extra key'
  $alias=Retry;$alias.Remove('attempts');$alias.Attempts=1;Assert ((Throws {Assert-LifecycleRetryState $alias $policy $sha}) -ceq 'JOURNAL_CORRUPT') 'ordinal key alias'
  # End to end: invalid clock values refuse before any state or transport.
  foreach($clock in @({[DateTime]::Now},{'2030-01-01T00:00:00.000Z'},{(At '2030-01-01T00:00:00.000Z');(At '2030-01-01T00:00:00.000Z')},{$null},{[datetime]::SpecifyKind([datetime]::new(2030,1,1),[DateTimeKind]::Unspecified)})){
    $d=New-Fixture ('clock-'+[guid]::NewGuid().ToString('N'))
    $res=Invoke-Fixture $d @{UtcClock=$clock}
    Assert-Refused $d $res 'CLOCK_INVALID' 'invalid clock'
    Assert (-not (HasJournal $d)) 'invalid clock wrote a journal'
  }
  # End to end: a safe-integer delay that overflows the instant keeps the durable failure and schedules nothing.
  $d=New-Fixture 'overflow' (PolicyText 3 9007199254740991 '"TIMEOUT"');SetMode $d 'read-fail:TIMEOUT';SetClock '2030-01-01T00:00:00.000Z'
  $res=Invoke-Fixture $d
  Assert ((Field $res 'code') -ceq 'GITHUB_READ_FAILED' -and $null -eq (Field $res 'failureJournal')) ('original outcome '+(Describe $res))
  $ev=Ev $d;Assert-Retry $ev 1 '2030-01-01T00:00:00.000Z' $null
  Assert ($ev['lastFailure']['diagnostic']['category'] -ceq 'TIMEOUT') 'durable failure preserved'
  # Persisted corruption refuses the whole invocation, journal untouched.
  foreach($case in @('bad-nextAt','extra-key','plain-schema-v2','missing-retry-key')){
    $d=New-Fixture ('corrupt-'+$case);SeedRetry $d 1 '2030-01-01T00:00:00.000Z' '2030-01-01T00:01:00.000Z' (ValidRecord)
    $j=ReadJournal $d;$ev=$j.events['update-2']
    switch($case){
      bad-nextAt {$ev.retry.nextAt='2030-01-01T00:01:00Z'}
      extra-key {$ev.retry.extra=1}
      plain-schema-v2 {$j.schema='LifecycleUpdateJournal/v2'}
      missing-retry-key {$ev.Remove('retry')}
    }
    PutJson (JournalPath $d) $j;$h=JHash $d;SetClock '2040-01-01T00:00:00.000Z'
    $res=Invoke-Fixture $d
    $expected=$(if($case -ceq 'missing-retry-key'){'RETRY_COUNT_UNKNOWN'}else{'JOURNAL_CORRUPT'})
    Assert-Refused $d $res $expected $case
    Assert ((JHash $d) -ceq $h) ($case+': journal unchanged')
  }
}

Check 'legacy v1 release behavior on a failed initial read is unchanged' {
  $d=New-Fixture 'legacy-read-failure' -Legacy;SetMode $d 'read-fail:RATE_LIMITED'
  $res=Invoke-Fixture $d
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq 'GITHUB_READ_FAILED' -and (Field (Field $res 'diagnostic') 'category') -ceq 'RATE_LIMITED') ('legacy result '+(Describe $res))
  $j=ReadJournal $d;$ev=$j.events['update-2']
  Assert ($j.schema -ceq 'LifecycleUpdateJournal/v2' -and $ev.Count -eq 6 -and -not $ev.ContainsKey('retry')) 'legacy journal v2, no retry state'
  Refresh-Fixture $d;SetMode $d '';$ok=Invoke-Fixture $d
  Assert ((Field $ok 'status') -ceq 'DELIVERED' -and (EditCount $d) -eq 1) 'legacy retry-by-rerun path unchanged (no budget, no clock)'
}

PutJson (Join-Path $Root 'results.json') @{schema='LifecycleInitialReadRetryTestResults/v1';sourceSha256=$SourceSha256;results=@($script:Results.ToArray())}
$failures=@($script:Results|Where-Object {$_.outcome -cne 'PASS'})
PutJson (Join-Path $Root 'failures.json') @{schema='LifecycleInitialReadRetryTestFailures/v1';failures=@($failures)}
$failed=@($script:Results|Where-Object {$_.outcome -ceq 'FAIL'}).Count;$harness=@($script:Results|Where-Object {$_.outcome -ceq 'HARNESS_ERROR'}).Count
Write-Output ('SUMMARY checks='+$script:Results.Count+' failed='+$failed+' harnessErrors='+$harness)
if($harness -gt 0){exit 2}
if($failed -gt 0){exit 1}
Write-Output ('ALL_PASS groups='+$script:Results.Count)
exit 0
