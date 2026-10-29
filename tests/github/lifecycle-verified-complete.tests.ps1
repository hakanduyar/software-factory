#Requires -Version 7.6
# Focused offline checks for the opt-in verified auto-close capability
# (Invoke-DurableGitHubTaskComplete, TaskLifecycleCompleteRelease/v1, LifecycleCompletionProof/v1,
# transport CLOSE). Every dependency derives from the explicit SourcePath; every fixture lives
# under the fresh caller-owned EvidenceRoot. No gh, network, provider, credential or live runtime
# file is touched: processes are injected offline runners, so the real transport parses and builds
# the actual gh argv. Fixtures prove mechanics only; they can never authorize an actual issue.
param(
  [Parameter(Mandatory)][string]$SourcePath,
  [Parameter(Mandatory)][string]$EvidenceRoot
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

$AcceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'
$Cand=('1234abcd'*5)
$Other=('fedcba98'*5)
$Merge=('ab12cd34'*5)
$Pr='https://github.com/hakanduyar/software-factory/pull/104'

function Stop-Harness([string]$Message){throw [InvalidOperationException]::new('HARNESS: '+$Message)}
function Assert($condition,[string]$message){if(-not $condition){throw [InvalidOperationException]::new('ASSERT: '+$message)}}
function Field($o,[string]$n){
  if($null -eq $o){return $null}
  if($o -is [System.Collections.IDictionary]){if($o.Contains($n)){return $o[$n]}else{return $null}}
  if($o.PSObject.Properties.Name -ccontains $n){return $o.$n}
  return $null
}

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
function Cnt($d,[string]$n){[int][IO.File]::ReadAllText((Join-Path $d ($n+'.txt')))}
function SetMode($d,[string]$mode){PutText (Join-Path $d 'mode.txt') $mode}
function JournalPath($d){Join-Path $d 'state/lifecycle-complete.journal.json'}
function UpdateJournalPath($d){Join-Path $d 'state/lifecycle-update.journal.json'}
function HasJournal($d){[IO.File]::Exists((JournalPath $d))}
function ReadJournal($d){Read-LifecycleJson (JournalPath $d)}
function Ev($d){(ReadJournal $d).events['complete-2']}
function Remote($d){Read-LifecycleJson (Join-Path $d 'remote.json')}
function FileHash($d,[string]$rel){Get-LifecycleFileHash (Join-Path $d $rel)}
function Describe($res){$res|ConvertTo-Json -Compress -Depth 6}
$MarkerOf={param($t) 'factory-task-'+(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($t)))}
$TaskId='LCC_FIXTURE'
$IssueUrl='https://github.com/hakanduyar/software-factory/issues/67'
# Expected terminal projections are built here from literals, independent of the product helpers.
function ExpectedBody($d){
  $b=(Read-LifecycleJson (Join-Path $d 'before-issue.json')).body
  $b.Replace('Version: 1','Version: 2').Replace('Status: IN_PROGRESS','Status: ACCEPTED_SCOPED').Replace('Next action: RUN_FOCUSED_CHECKS','Next action: NONE').Replace('Summary: Original summary','Summary: Reviewed summary')
}
function ExpectedNote($d){
  $n=[IO.File]::ReadAllText((Join-Path $d 'before-note.md'))
  $n.Replace('Status: IN_PROGRESS','Status: ACCEPTED_SCOPED').Replace('Issue state: OPEN','Issue state: CLOSED').Replace('Canonical version: 1','Canonical version: 2').Replace("Next action: RUN_FOCUSED_CHECKS`n","Next action: NONE`nTitle: Reviewed task`nSummary: Reviewed summary`n")
}

function New-Runner($dir){
  $diagNew=${function:New-GitHubCliFailureDiagnostic216}
  $remotePath=[IO.Path]::Combine($dir,'remote.json');$modePath=[IO.Path]::Combine($dir,'mode.txt')
  $editsPath=[IO.Path]::Combine($dir,'edits.txt');$readsPath=[IO.Path]::Combine($dir,'reads.txt');$closesPath=[IO.Path]::Combine($dir,'closes.txt')
  $argvPath=[IO.Path]::Combine($dir,'close-argv.txt');$journalPath=[IO.Path]::Combine($dir,'state','lifecycle-complete.journal.json')
  $jEdit=[IO.Path]::Combine($dir,'journal-at-edit.json');$jClose=[IO.Path]::Combine($dir,'journal-at-close.json');$deliveryPath=[IO.Path]::Combine($dir,'delivery-receipt.json')
  return {
    param($exe,$argv,$deadline,$stdoutCap,$stderrCap)
    $mode=if([IO.File]::Exists($modePath)){[IO.File]::ReadAllText($modePath).Trim()}else{''}
    $state=[IO.File]::ReadAllText($remotePath)|ConvertFrom-Json -AsHashtable
    $plain={param($out) [pscustomobject]@{exitCode=[int]0;timedOut=$false;stdout=[string]$out;stdoutTruncated=$false;stderrTruncated=$false}}
    $fail={[pscustomobject]@{exitCode=[int]1;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false;failureDiagnostic=(& $diagNew -ExitCode 1 -TimedOut $false -StdoutTruncated $false -StderrTruncated $false -StderrText $null -Category 'UNKNOWN')}}
    $bump={param($p) [IO.File]::WriteAllText($p,[string]([int][IO.File]::ReadAllText($p)+1))}
    $snap={param($to) if([IO.File]::Exists($journalPath)){[IO.File]::Copy($journalPath,$to,$true)}}
    $save={[IO.File]::WriteAllText($remotePath,($state|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}
    if($argv[1] -ceq 'view'){
      & $bump $readsPath
      # Drift of an admitted receipt AFTER admission and after both leases were taken.
      if($mode -ceq 'drift-delivery' -and [int][IO.File]::ReadAllText($readsPath) -eq 1){[IO.File]::AppendAllText($deliveryPath,' ')}
      if($mode -ceq 'view-fail-after-close' -and [int][IO.File]::ReadAllText($closesPath) -gt 0){return (& $fail)}
      return (& $plain ($state|ConvertTo-Json -Compress))
    }
    if($argv[1] -ceq 'edit'){
      & $bump $editsPath; & $snap $jEdit
      if($mode -ceq 'edit-fail'){return (& $fail)}
      $bodyIndex=[Array]::IndexOf($argv,'--body-file');$titleIndex=[Array]::IndexOf($argv,'--title')
      $state.body=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($argv[$bodyIndex+1]));$state.title=$argv[$titleIndex+1]
      & $save
      if($mode -ceq 'edit-applied-fail'){return (& $fail)}
      return (& $plain $state.url)
    }
    if($argv[1] -ceq 'close'){
      & $bump $closesPath; & $snap $jClose
      [IO.File]::WriteAllText($argvPath,($argv -join "`n"))
      if($mode -ceq 'close-fail'){return (& $fail)}
      if($mode -ceq 'close-noapply'){return (& $plain '')}
      $state.state='CLOSED'; & $save
      if($mode -ceq 'close-applied-fail'){return (& $fail)}
      return (& $plain '')
    }
    throw 'UNEXPECTED_CONNECTOR_OPERATION'
  }.GetNewClosure()
}

function Put-Receipt($path,$obj,[hashtable]$M,[string]$name,[hashtable]$Tokens){
  if($M.ContainsKey('raw'+$name)){
    $t=[string]$M['raw'+$name];foreach($k in $Tokens.Keys){$t=$t.Replace($k,[string]$Tokens[$k])}
    PutText $path $t
  } else {
    if($M.ContainsKey($name)){& $M[$name] $obj}
    PutJson $path $obj
  }
}
function Build-Chain($d,[hashtable]$M=@{},[string]$recovery='INITIAL'){
  $r=Read-LifecycleJson (Join-Path $d 'release.json')
  foreach($name in @('packet','canonical','mapping','beforeIssue','beforeNote','consumer','transport','executable')){$r[$name]=Ref $r[$name].path}
  $rvPath=Join-Path $d 'review-receipt.json';$dvPath=Join-Path $d 'delivery-receipt.json';$pfPath=Join-Path $d 'proof.json'
  $tok=@{'@@CAND@@'=$Cand;'@@MERGE@@'=$Merge;'@@PR@@'=$Pr}
  $rv=[ordered]@{schema='IndependentComponentReview/v1';decision='ACCEPT_SCOPED_SOURCE';commit=$Cand;note='descriptive field is inert'}
  Put-Receipt $rvPath $rv $M 'review' $tok
  $rvRef=Ref $rvPath;$tok['@@REVIEWSHA@@']=$rvRef.sha256
  $dv=[ordered]@{schema='IndependentDeliveryReceipt/v1';head=$Cand;merge=$Merge;pr=$Pr;requiredChecks='ALL_SUCCESS';checks=7;normalTypecheck='PASS';normalBuild='PASS';focusedTests=12;sourceReviewSha256=$rvRef.sha256;description='descriptive field is inert'}
  Put-Receipt $dvPath $dv $M 'delivery' $tok
  $dvRef=Ref $dvPath;$tok['@@RVREF@@']=(ConvertTo-Json $rvRef -Compress);$tok['@@DVREF@@']=(ConvertTo-Json $dvRef -Compress)
  $pf=[ordered]@{schema='LifecycleCompletionProof/v1';taskId=$TaskId;canonicalRevision=2;candidateCommit=$Cand;minimumFocusedTests=10;sourceReview=$rvRef;delivery=$dvRef}
  Put-Receipt $pfPath $pf $M 'proof' $tok
  $r.completionProof=Ref $pfPath
  $r.recovery=$recovery;$r.outboxSha256=Get-LifecycleFileHash $r.outboxPath
  $ar=[ordered]@{schema='LifecycleCompleteIndependentReview/v1';decision='ADMIT';packetSha256=$r.packet.sha256;consumerSha256=$r.consumer.sha256;transportSha256=$r.transport.sha256;completionProofSha256=$r.completionProof.sha256;taskId=$TaskId;canonicalRevision=2;candidateCommit=$Cand}
  if($M.ContainsKey('admReview')){& $M.admReview $ar}
  PutJson $r.review.path $ar;$r.review=Ref $r.review.path
  $nv=[ordered]@{schema='LifecycleCompleteNativeRequest/v1';action='COMPLETE';packetSha256=$r.packet.sha256;reviewSha256=$r.review.sha256;consumerSha256=$r.consumer.sha256;transportSha256=$r.transport.sha256;executableSha256=$r.executable.sha256;completionProofSha256=$r.completionProof.sha256;taskId=$TaskId;canonicalRevision=2;candidateCommit=$Cand;stateDir=$r.stateDir;notePath=$r.notePath;outboxPath=$r.outboxPath}
  if($M.ContainsKey('native')){& $M.native $nv}
  PutJson $r.nativeRequest.path $nv;$r.nativeRequest=Ref $r.nativeRequest.path
  if($M.ContainsKey('release')){& $M.release $r}
  PutJson (Join-Path $d 'release.json') $r
  if($M.ContainsKey('after')){& $M.after $d}
}
function New-Fixture($name){
  $d=Join-Path $Root $name;[void][IO.Directory]::CreateDirectory($d)
  foreach($sub in @('state','vault','temp')){[void][IO.Directory]::CreateDirectory((Join-Path $d $sub))}
  $p=[ordered]@{schema='TaskLifecycleMirrorPacket/v1';taskId=$TaskId;canonicalRevision=2;eventType='COMPLETE';idempotencyKey='complete-2';publicTitle='Reviewed task';publicSummary='Reviewed summary';publicStatus='ACCEPTED_SCOPED';nextAction='NONE';destinations=@('github','note')}
  PutJson (Join-Path $d 'packet.json') $p
  $c=[ordered]@{};foreach($k in @('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')){$c[$k]=$p[$k]};PutJson (Join-Path $d 'canonical.json') $c
  $marker=& $MarkerOf $TaskId
  $body="<!-- $marker -->`n`n<!-- factory-task-status:start -->`nTask: $TaskId`nVersion: 1`nStatus: IN_PROGRESS`nNext action: RUN_FOCUSED_CHECKS`nSummary: Original summary`n<!-- factory-task-status:end -->`n`nUnowned discussion."
  PutJson (Join-Path $d 'mapping.json') @{taskId=$TaskId;repo='hakanduyar/software-factory';issueNumber=67;url=$IssueUrl;stableMarker=$marker;canonicalRevision=1}
  PutJson (Join-Path $d 'before-issue.json') @{title='Original task';body=$body}
  $note="# Original note heading`n<!-- factory-task:$TaskId`:start -->`nTask: $TaskId`nStatus: IN_PROGRESS`nGitHub: $IssueUrl`nIssue state: OPEN`nCanonical version: 1`nNext action: RUN_FOCUSED_CHECKS`n`nAcceptance criteria (frozen v1):`n- Fixture criterion`n<!-- factory-task:$TaskId`:end -->`nTrailing prose."
  PutText (Join-Path $d 'before-note.md') $note;PutText (Join-Path $d 'vault/task.md') $note
  PutJson (Join-Path $d 'remote.json') @{number=67;url=$IssueUrl;state='OPEN';title='Original task';body=$body}
  foreach($n in @('edits','reads','closes')){PutText (Join-Path $d ($n+'.txt')) '0'}
  PutText (Join-Path $d 'gh-fixture.bin') 'fixture executable pin target; never executed'
  $hash='a'*64
  $old=[ordered]@{taskId='ORIGINAL_REFUSED';runId='original';destination='github';status='AWAITING_CONTROLLER';payloadSha256=$hash;attempt=0;key=('ORIGINAL_REFUSED:'+$hash+':original:AWAITING_CONTROLLER:0');deliveryStatus='PENDING';proof=$null;retryPolicy='NO_RETRY'}
  PutText (Join-Path $d 'state/outbox.json') (ConvertTo-Json -InputObject @($old) -Depth 6 -Compress)
  PutJson (Join-Path $d 'review.json') @{};PutJson (Join-Path $d 'native.json') @{}
  $r=@{schema='TaskLifecycleCompleteRelease/v1';packet=(Ref (Join-Path $d 'packet.json'));canonical=(Ref (Join-Path $d 'canonical.json'));mapping=(Ref (Join-Path $d 'mapping.json'));beforeIssue=(Ref (Join-Path $d 'before-issue.json'));beforeNote=(Ref (Join-Path $d 'before-note.md'));review=(Ref (Join-Path $d 'review.json'));nativeRequest=(Ref (Join-Path $d 'native.json'));consumer=(Ref $SourcePath);transport=(Ref $TransportPath);executable=(Ref (Join-Path $d 'gh-fixture.bin'));completionProof=@{path=(Join-Path $d 'proof.json');sha256=('0'*64)};stateDir=(Join-Path $d 'state');vaultRoot=(Join-Path $d 'vault');notePath=(Join-Path $d 'vault/task.md');outboxPath=(Join-Path $d 'state/outbox.json');journalPath=(JournalPath $d);canonicalLease=((Join-Path $d 'canonical.json')+'.lock');publisherLease=(Join-Path $d 'state/publisher.lock');tempRoot=(Join-Path $d 'temp');outboxSha256='';recovery='INITIAL'}
  PutJson (Join-Path $d 'release.json') $r
  # The placeholder proof pin is replaced by the first chain build.
  PutText (Join-Path $d 'proof.json') '{}'
  Build-Chain $d
  return $d
}
function Invoke-Complete($d,[hashtable]$Override=@{}){
  $r=Read-LifecycleJson (Join-Path $d 'release.json')
  $a=@{ReleasePath=(Join-Path $d 'release.json');ExpectedReleaseSha256=(Get-LifecycleFileHash (Join-Path $d 'release.json'));ExpectedReviewSha256=$r.review.sha256;ExpectedNativeRequestSha256=$r.nativeRequest.sha256;ReconcilePath=$ReconcilePath}
  foreach($k in $Override.Keys){$a[$k]=$Override[$k]}
  Invoke-DurableGitHubTaskComplete @a -ProcessRunner (New-Runner $d)
}
function Snap($d){@{outbox=(FileHash $d 'state/outbox.json');remote=(FileHash $d 'remote.json');note=(FileHash $d 'vault/task.md');journal=$(if(HasJournal $d){FileHash $d 'state/lifecycle-complete.journal.json'}else{''})}}
function Assert-Same($d,$snap,[string]$why){
  $now=Snap $d
  foreach($k in $snap.Keys){Assert ($now[$k] -ceq $snap[$k]) ($why+': '+$k+' changed')}
}
function Assert-Refused($d,$res,[string]$code,[string]$why,[int]$reads=0){
  Assert ((Field $res 'status') -ceq 'REFUSED' -and (Field $res 'code') -ceq $code) ($why+' expected REFUSED '+$code+' got '+(Describe $res))
  Assert ((Cnt $d 'reads') -eq $reads -and (Cnt $d 'edits') -eq 0 -and (Cnt $d 'closes') -eq 0) ($why+' used the transport unexpectedly')
}
function Assert-Flags($ev,[bool]$es,[bool]$ea,[bool]$cs,[bool]$ca,[bool]$ns,[bool]$na){
  Assert ($null -ne $ev -and $ev.Count -eq 10 -and $ev['editSent'] -eq $es -and $ev['editAck'] -eq $ea -and $ev['closeSent'] -eq $cs -and $ev['closeAck'] -eq $ca -and $ev['noteSent'] -eq $ns -and $ev['noteAck'] -eq $na) ('journal flags '+(Describe $ev))
}
function Assert-Delivered($d,$res,[string]$why){
  Assert ((Field $res 'status') -ceq 'DELIVERED' -and (Field $res 'code') -ceq 'READBACK_ACK' -and (Field $res 'githubAck') -eq $true -and (Field $res 'noteAck') -eq $true) ($why+' '+(Describe $res))
  $rm=Remote $d
  Assert ($rm.state -ceq 'CLOSED' -and $rm.title -ceq 'Reviewed task' -and $rm.body -ceq (ExpectedBody $d)) ($why+' remote not exact CLOSED desired')
  Assert ([IO.File]::ReadAllText((Join-Path $d 'vault/task.md')) -ceq (ExpectedNote $d)) ($why+' note bytes')
}

$script:Results=[Collections.Generic.List[object]]::new()
function Check($name,[scriptblock]$test){
  $sw=[Diagnostics.Stopwatch]::StartNew()
  try{& $test;$script:Results.Add(@{name=$name;outcome='PASS';elapsedMs=$sw.ElapsedMilliseconds});Write-Output ('PASS '+$name)}
  catch{
    $m=$_.Exception.Message
    $kind=if($m.StartsWith('ASSERT: ',[StringComparison]::Ordinal)){'FAIL'}else{'HARNESS_ERROR'}
    $script:Results.Add(@{name=$name;outcome=$kind;error=$m;elapsedMs=$sw.ElapsedMilliseconds});Write-Output ($kind+' '+$name+': '+$m)
  }
}
function With-FailingWriter([string]$FailPath,[int]$FailOnCall,[scriptblock]$Body){
  $script:InjectedRealWriter=${function:Write-LifecycleAtomic};$script:InjectedFailPath=$FailPath;$script:InjectedCalls=0;$script:InjectedFailOn=$FailOnCall
  ${function:script:Write-LifecycleAtomic}={param([string]$Path,[byte[]]$Bytes)
    if($Path -ceq $script:InjectedFailPath){$script:InjectedCalls++;if($script:InjectedCalls -eq $script:InjectedFailOn){throw [IO.IOException]::new('INJECTED_WRITE_FAILURE')}}
    & $script:InjectedRealWriter -Path $Path -Bytes $Bytes}
  try{& $Body}finally{${function:script:Write-LifecycleAtomic}=$script:InjectedRealWriter;$script:InjectedRealWriter=$null;$script:InjectedFailPath=$null}
}

Check 'valid tests+review+delivery closes the mapped issue with exact argv, body, readback and durable markers' {
  $d=New-Fixture 'valid'
  PutText (Join-Path $d 'state/lifecycle-update.journal.json') '{"schema":"LifecycleUpdateJournal/v3","events":{},"heads":{}}'
  $updHash=FileHash $d 'state/lifecycle-update.journal.json'
  $res=Invoke-Complete $d
  Assert-Delivered $d $res 'valid closure'
  Assert ((Cnt $d 'edits') -eq 1 -and (Cnt $d 'closes') -eq 1) 'exactly one EDIT and one CLOSE'
  Assert (([IO.File]::ReadAllText((Join-Path $d 'close-argv.txt'))) -ceq ((@('issue','close','67','--repo','hakanduyar/software-factory','--reason','completed')) -join "`n")) 'exact fixed close argv'
  $je=Read-LifecycleJson (Join-Path $d 'journal-at-edit.json');$jc=Read-LifecycleJson (Join-Path $d 'journal-at-close.json')
  Assert ($je.events['complete-2']['editSent'] -eq $true -and $je.events['complete-2']['editAck'] -eq $false -and $je.events['complete-2']['closeSent'] -eq $false) 'EDIT sent marker durable before the EDIT call'
  Assert ($jc.events['complete-2']['editAck'] -eq $true -and $jc.events['complete-2']['closeSent'] -eq $true -and $jc.events['complete-2']['closeAck'] -eq $false) 'edit ACK and CLOSE sent marker durable before the CLOSE call'
  $j=ReadJournal $d
  Assert ($j.schema -ceq 'LifecycleCompleteJournal/v1' -and $j.heads[$TaskId]['revision'] -eq 2) 'versioned journal and head'
  Assert-Flags (Ev $d) $true $true $true $true $true $true
  Assert ((FileHash $d 'state/lifecycle-update.journal.json') -ceq $updHash) 'UPDATE journal untouched'
  $out=@(Read-LifecycleJson (Join-Path $d 'state/outbox.json'))
  Assert ($out.Count -eq 3 -and @($out|Where-Object {$_.deliveryStatus -ceq 'DELIVERED'}).Count -eq 2) 'both complete destinations ACKed'
  $orig=@($out|Where-Object {$_.taskId -ceq 'ORIGINAL_REFUSED'})
  Assert ($orig.Count -eq 1 -and $orig[0].deliveryStatus -ceq 'PENDING' -and $orig[0].retryPolicy -ceq 'NO_RETRY') 'unrelated outbox event preserved'
  # Replay of the exact delivered state: zero remote mutation.
  Build-Chain $d @{} 'INITIAL'
  $again=Invoke-Complete $d
  Assert ((Field $again 'status') -ceq 'DELIVERED' -and (Field $again 'code') -ceq 'DEBOUNCED' -and (Cnt $d 'edits') -eq 1 -and (Cnt $d 'closes') -eq 1) ('CLOSED exact replay '+(Describe $again))
}

Check 'missing, failed, mismatched or coerced proof fields and pins refuse with zero mutation' {
  $cases=@(
    @{n='proof-missing-min';code='PROOF_INVALID';M=@{proof={param($o) $o.Remove('minimumFocusedTests')}}},
    @{n='proof-extra-key';code='PROOF_INVALID';M=@{proof={param($o) $o.extra=1}}},
    @{n='proof-schema';code='PROOF_INVALID';M=@{proof={param($o) $o.schema='LifecycleCompletionProof/v2'}}},
    @{n='proof-task';code='PROOF_BINDING';M=@{proof={param($o) $o.taskId='OTHER_TASK'}}},
    @{n='proof-revision';code='PROOF_BINDING';M=@{proof={param($o) $o.canonicalRevision=3}}},
    @{n='proof-revision-string';code='PROOF_BINDING';M=@{proof={param($o) $o.canonicalRevision='2'}}},
    @{n='proof-revision-bool';code='PROOF_BINDING';M=@{proof={param($o) $o.canonicalRevision=$true}}},
    @{n='proof-candidate-upper';code='PROOF_INVALID';M=@{proof={param($o) $o.candidateCommit=$Cand.ToUpperInvariant()}}},
    @{n='proof-candidate-zero';code='PROOF_INVALID';M=@{proof={param($o) $o.candidateCommit=('0'*40)}}},
    @{n='proof-candidate-short';code='PROOF_INVALID';M=@{proof={param($o) $o.candidateCommit=$Cand.Substring(1)}}},
    @{n='proof-min-zero';code='PROOF_INVALID';M=@{proof={param($o) $o.minimumFocusedTests=0}}},
    @{n='proof-min-bool';code='PROOF_INVALID';M=@{proof={param($o) $o.minimumFocusedTests=$true}}},
    @{n='proof-min-string';code='PROOF_INVALID';M=@{proof={param($o) $o.minimumFocusedTests='10'}}},
    @{n='proof-min-float';code='PROOF_INVALID';M=@{rawproof='{"schema":"LifecycleCompletionProof/v1","taskId":"LCC_FIXTURE","canonicalRevision":2,"candidateCommit":"@@CAND@@","minimumFocusedTests":10.0,"sourceReview":@@RVREF@@,"delivery":@@DVREF@@}'}},
    @{n='proof-revision-float';code='PROOF_BINDING';M=@{rawproof='{"schema":"LifecycleCompletionProof/v1","taskId":"LCC_FIXTURE","canonicalRevision":2.0,"candidateCommit":"@@CAND@@","minimumFocusedTests":10,"sourceReview":@@RVREF@@,"delivery":@@DVREF@@}'}},
    @{n='review-schema';code='RECEIPT_UNSUPPORTED';M=@{review={param($o) $o.schema='IndependentComponentReview/v2'}}},
    @{n='review-decision';code='RECEIPT_INVALID';M=@{review={param($o) $o.decision='REQUEST_CHANGES'}}},
    @{n='review-missing-commit';code='RECEIPT_INVALID';M=@{review={param($o) $o.Remove('commit')}}},
    @{n='review-alias-only';code='RECEIPT_INVALID';M=@{rawreview='{"schema":"IndependentComponentReview/v1","decision":"ACCEPT_SCOPED_SOURCE","Commit":"@@CAND@@"}'}},
    @{n='review-duplicate-alias';code='DUPLICATE_FIELD';M=@{rawreview='{"schema":"IndependentComponentReview/v1","decision":"ACCEPT_SCOPED_SOURCE","commit":"@@CAND@@","Commit":"@@CAND@@"}'}},
    @{n='review-commit-other';code='PROOF_MISMATCH';M=@{review={param($o) $o.commit=$Other}}},
    @{n='delivery-schema';code='RECEIPT_UNSUPPORTED';M=@{delivery={param($o) $o.schema='IndependentDeliveryReceipt/v2'}}},
    @{n='delivery-head-other';code='PROOF_MISMATCH';M=@{delivery={param($o) $o.head=$Other}}},
    @{n='delivery-merge-zero';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.merge=('0'*40)}}},
    @{n='delivery-pr-repo';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.pr='https://github.com/other/software-factory/pull/104'}}},
    @{n='delivery-pr-zero';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.pr='https://github.com/hakanduyar/software-factory/pull/0'}}},
    @{n='delivery-checks-state';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.requiredChecks='SOME_FAILED'}}},
    @{n='delivery-checks-zero';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.checks=0}}},
    @{n='delivery-checks-bool';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.checks=$true}}},
    @{n='delivery-typecheck';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.normalTypecheck='FAIL'}}},
    @{n='delivery-build';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.normalBuild='NOT_RUN'}}},
    @{n='delivery-tests-below-minimum';code='PROOF_TESTS_INSUFFICIENT';M=@{delivery={param($o) $o.focusedTests=9}}},
    @{n='delivery-tests-string';code='RECEIPT_INVALID';M=@{delivery={param($o) $o.focusedTests='12'}}},
    @{n='delivery-tests-float';code='RECEIPT_INVALID';M=@{rawdelivery='{"schema":"IndependentDeliveryReceipt/v1","head":"@@CAND@@","merge":"@@MERGE@@","pr":"@@PR@@","requiredChecks":"ALL_SUCCESS","checks":7,"normalTypecheck":"PASS","normalBuild":"PASS","focusedTests":12.0,"sourceReviewSha256":"@@REVIEWSHA@@"}'}},
    @{n='delivery-review-sha';code='PROOF_MISMATCH';M=@{delivery={param($o) $o.sourceReviewSha256=('0'*64)}}},
    @{n='pin-delivery-drift';code='PIN_DRIFT';M=@{after={param($d) [IO.File]::AppendAllText((Join-Path $d 'delivery-receipt.json'),' ')}}},
    @{n='pin-review-drift';code='PIN_DRIFT';M=@{after={param($d) [IO.File]::AppendAllText((Join-Path $d 'review-receipt.json'),' ')}}},
    @{n='pin-proof-drift';code='PIN_DRIFT';M=@{after={param($d) [IO.File]::AppendAllText((Join-Path $d 'proof.json'),' ')}}},
    @{n='pin-release-proof-sha';code='PIN_DRIFT';M=@{release={param($o) $o.completionProof.sha256=('0'*64)}}}
  )
  foreach($c in $cases){
    $d=New-Fixture ('proof-'+$c.n);$s=Snap $d
    Build-Chain $d $c.M
    $res=Invoke-Complete $d
    Assert-Refused $d $res $c.code $c.n
    Assert (-not (HasJournal $d)) ($c.n+' wrote a journal')
    Assert-Same $d $s $c.n
  }
  # Valid inert descriptive fields are accepted (the default fixture carries them).
  $d=New-Fixture 'proof-inert-fields'
  Assert-Delivered $d (Invoke-Complete $d) 'inert descriptive receipt fields'
}

Check 'admission documents, packet and release bind exactly; UPDATE cannot imply COMPLETE' {
  $adm=@(
    @{n='review-decision';code='REVIEW_BINDING';M=@{admReview={param($o) $o.decision='REJECT'}}},
    @{n='review-proof-sha';code='REVIEW_BINDING';M=@{admReview={param($o) $o.completionProofSha256=('0'*64)}}},
    @{n='review-candidate';code='REVIEW_BINDING';M=@{admReview={param($o) $o.candidateCommit=$Other}}},
    @{n='review-task';code='REVIEW_BINDING';M=@{admReview={param($o) $o.taskId='OTHER_TASK'}}},
    @{n='review-revision-string';code='REVIEW_BINDING';M=@{admReview={param($o) $o.canonicalRevision='2'}}},
    @{n='review-schema-update';code='REVIEW_BINDING';M=@{admReview={param($o) $o.schema='LifecycleIndependentReview/v1'}}},
    @{n='review-extra-key';code='FIELDS_INVALID';M=@{admReview={param($o) $o.approved=$true}}},
    @{n='native-action';code='NATIVE_BINDING';M=@{native={param($o) $o.action='UPDATE'}}},
    @{n='native-proof-sha';code='NATIVE_BINDING';M=@{native={param($o) $o.completionProofSha256=('0'*64)}}},
    @{n='native-candidate';code='NATIVE_BINDING';M=@{native={param($o) $o.candidateCommit=$Other}}},
    @{n='native-revision';code='NATIVE_BINDING';M=@{native={param($o) $o.canonicalRevision=3}}},
    @{n='native-state-dir';code='NATIVE_BINDING';M=@{native={param($o) $o.stateDir=(Join-Path $Root 'elsewhere')}}},
    @{n='native-schema-update';code='NATIVE_BINDING';M=@{native={param($o) $o.schema='LifecycleNativeRequest/v1'}}},
    @{n='release-schema-update';code='RELEASE_INVALID';M=@{release={param($o) $o.schema='TaskLifecycleUpdateRelease/v1'}}},
    @{n='release-recovery';code='RELEASE_INVALID';M=@{release={param($o) $o.recovery='ANY'}}},
    @{n='release-journal-path';code='LEASE_BINDING';M=@{release={param($o) $o.journalPath=(Join-Path $o.stateDir 'lifecycle-update.journal.json')}}}
  )
  foreach($c in $adm){
    $d=New-Fixture ('adm-'+$c.n);$s=Snap $d
    Build-Chain $d $c.M
    $rr=Read-LifecycleJson (Join-Path $d 'release.json')
    Assert-Refused $d (Invoke-Complete $d @{ExpectedReviewSha256=$rr.review.sha256;ExpectedNativeRequestSha256=$rr.nativeRequest.sha256}) $c.code $c.n
    Assert ((-not (HasJournal $d))) ($c.n+' wrote a journal')
    Assert-Same $d $s $c.n
  }
  # Admission arguments that disagree with the release pins.
  $d=New-Fixture 'adm-wrong-expected';$s=Snap $d
  Assert-Refused $d (Invoke-Complete $d @{ExpectedReviewSha256=('0'*64)}) 'ADMISSION_BINDING' 'expected review hash'
  Assert-Refused $d (Invoke-Complete $d @{ExpectedNativeRequestSha256=('0'*64)}) 'ADMISSION_BINDING' 'expected native hash'
  Assert-Refused $d (Invoke-Complete $d @{ExpectedReleaseSha256=('0'*64)}) 'RELEASE_DRIFT' 'expected release hash'
  Assert-Same $d $s 'admission args'
  # Packet shape: only COMPLETE may carry NONE; the entrypoint requires the terminal pair.
  $packetCases=@(
    @{n='update-event';code='UNSUPPORTED_EVENT';f={param($o) $o.eventType='UPDATE';$o.nextAction='RUN_FOCUSED_CHECKS'}},
    @{n='update-event-none';code='PACKET_INVALID';f={param($o) $o.eventType='UPDATE'}},
    @{n='create-event-none';code='PACKET_INVALID';f={param($o) $o.eventType='CREATE'}},
    @{n='complete-not-accepted';code='UNSUPPORTED_EVENT';f={param($o) $o.publicStatus='IN_PROGRESS'}},
    @{n='complete-next-action';code='UNSUPPORTED_EVENT';f={param($o) $o.nextAction='INDEPENDENT_REVIEW'}},
    @{n='complete-bogus-next';code='PACKET_INVALID';f={param($o) $o.nextAction='DONE'}}
  )
  foreach($c in $packetCases){
    $d=New-Fixture ('packet-'+$c.n);$s=Snap $d
    $pk=Read-LifecycleJson (Join-Path $d 'packet.json');& $c.f $pk;PutJson (Join-Path $d 'packet.json') $pk
    $cn=Read-LifecycleJson (Join-Path $d 'canonical.json');foreach($k in @($cn.Keys)){$cn[$k]=$pk[$k]};PutJson (Join-Path $d 'canonical.json') $cn
    Build-Chain $d
    Assert-Refused $d (Invoke-Complete $d) $c.code ('packet '+$c.n)
    Assert-Same $d $s ('packet '+$c.n)
  }
  # Existing enum acceptance is unchanged; an UPDATE packet can never be admitted as COMPLETE.
  $ok=@{schema='TaskLifecycleMirrorPacket/v1';taskId=$TaskId;canonicalRevision=2;eventType='UPDATE';idempotencyKey='u-2';publicTitle='Reviewed task';publicSummary='Reviewed summary';publicStatus='ACCEPTED_SCOPED';nextAction='INDEPENDENT_REVIEW';destinations=@('github','note')}
  [void](New-TaskLifecycleMirrorPacket $ok)
  $none=@{};foreach($k in $ok.Keys){$none[$k]=$ok[$k]};$none.nextAction='NONE'
  $threw=$false;try{[void](New-TaskLifecycleMirrorPacket $none)}catch{$threw=($_.Exception.Message -ceq 'PACKET_INVALID')}
  Assert $threw 'UPDATE packet with NONE refused'
  $none.eventType='COMPLETE';[void](New-TaskLifecycleMirrorPacket $none)
  # The UPDATE entrypoint never accepts a COMPLETE release (no implicit COMPLETE from UPDATE).
  $d=New-Fixture 'update-entry-refuses';$s=Snap $d;$r=Read-LifecycleJson (Join-Path $d 'release.json')
  $res=Invoke-AdmittedTaskLifecycleUpdate -ReleasePath (Join-Path $d 'release.json') -ExpectedReleaseSha256 (FileHash $d 'release.json') -ExpectedReviewSha256 $r.review.sha256 -ExpectedNativeRequestSha256 $r.nativeRequest.sha256 -ReconcilePath $ReconcilePath -ProcessRunner (New-Runner $d)
  Assert-Refused $d $res 'FIELDS_INVALID' 'UPDATE entrypoint with a COMPLETE release'
  Assert-Same $d $s 'UPDATE entrypoint'
}

Check 'proof changed after admission refuses before EDIT and CLOSE' {
  $d=New-Fixture 'drift-under-lock';SetMode $d 'drift-delivery';$s=Snap $d
  $res=Invoke-Complete $d
  Assert ((Field $res 'code') -ceq 'PIN_DRIFT' -and (Field $res 'automaticRetry') -eq $false) ('drift '+(Describe $res))
  Assert ((Cnt $d 'edits') -eq 0 -and (Cnt $d 'closes') -eq 0) 'no remote mutation after drift'
  Assert-Flags (Ev $d) $false $false $false $false $false $false
  Assert ((FileHash $d 'remote.json') -ceq $s.remote -and (FileHash $d 'vault/task.md') -ceq $s.note) 'remote and note untouched'
}

Check 'wrong issue, body, marker, state or canonical content refuses' {
  # Remote READ for another issue number: the transport structural check fails first.
  $d=New-Fixture 'remote-other-issue';$rm=Remote $d;$rm.number=68;PutJson (Join-Path $d 'remote.json') $rm;$s=Snap $d
  Assert-Refused $d (Invoke-Complete $d) 'GITHUB_READ_FAILED' 'other issue number' 1
  Assert-Same $d $s 'other issue number'
  $variants=@(
    @{n='body-outside';f={param($rm,$d) $rm.body=$rm.body+' changed outside'}},
    @{n='marker-changed';f={param($rm,$d) $rm.body=$rm.body.Replace('factory-task-','factory-other-')}},
    @{n='title';f={param($rm,$d) $rm.title='Different title'}},
    @{n='closed-before';f={param($rm,$d) $rm.state='CLOSED'}}
  )
  foreach($v in $variants){
    $d=New-Fixture ('remote-'+$v.n);$rm=Remote $d;& $v.f $rm $d;PutJson (Join-Path $d 'remote.json') $rm;$s=Snap $d
    Assert-Refused $d (Invoke-Complete $d) 'DESTINATION_DRIFT' $v.n 1
    Assert-Same $d $s $v.n
  }
  $d=New-Fixture 'mapping-marker';$m=Read-LifecycleJson (Join-Path $d 'mapping.json');$m.stableMarker='factory-task-'+('0'*64);PutJson (Join-Path $d 'mapping.json') $m;Build-Chain $d;$s=Snap $d
  Assert-Refused $d (Invoke-Complete $d) 'MAPPING_INVALID' 'mapping marker'
  $d=New-Fixture 'mapping-task';$m=Read-LifecycleJson (Join-Path $d 'mapping.json');$m.taskId='OTHER_TASK';PutJson (Join-Path $d 'mapping.json') $m;Build-Chain $d
  Assert-Refused $d (Invoke-Complete $d) 'MAPPING_INVALID' 'mapping task'
  $d=New-Fixture 'canonical-drift';$cn=Read-LifecycleJson (Join-Path $d 'canonical.json');$cn.publicSummary='Different summary';PutJson (Join-Path $d 'canonical.json') $cn;Build-Chain $d
  Assert-Refused $d (Invoke-Complete $d) 'CANONICAL_DRIFT' 'canonical content'
  $d=New-Fixture 'before-body-marker';$b=Read-LifecycleJson (Join-Path $d 'before-issue.json');$b.body=$b.body.Replace('factory-task-','factory-bad-');PutJson (Join-Path $d 'before-issue.json') $b;Build-Chain $d
  Assert-Refused $d (Invoke-Complete $d) 'BODY_OWNERSHIP' 'before body marker'
}

Check 'already CLOSED desired issue is adopted by readback only, with zero EDIT and CLOSE' {
  $d=New-Fixture 'closed-externally'
  $rm=Remote $d;$rm.state='CLOSED';$rm.title='Reviewed task';$rm.body=(ExpectedBody $d);PutJson (Join-Path $d 'remote.json') $rm
  $res=Invoke-Complete $d
  Assert-Delivered $d $res 'closed desired'
  Assert ((Cnt $d 'edits') -eq 0 -and (Cnt $d 'closes') -eq 0) 'no EDIT or CLOSE'
  Assert-Flags (Ev $d) $false $true $false $true $true $true
}

Check 'ambiguous EDIT stays pending and is not repeated on separately admitted recovery' {
  $d=New-Fixture 'edit-ambiguous';SetMode $d 'edit-fail'
  $res=Invoke-Complete $d
  Assert ((Field $res 'status') -ceq 'PENDING' -and (Field $res 'code') -ceq 'EDIT_AMBIGUOUS_NO_RETRY' -and (Field $res 'automaticRetry') -eq $false) ('ambiguous edit '+(Describe $res))
  Assert ($null -ne (Field $res 'diagnostic')) 'sanitized transport diagnostic kept'
  Assert-Flags (Ev $d) $true $false $false $false $false $false
  Assert ((Cnt $d 'edits') -eq 1 -and (Cnt $d 'closes') -eq 0) 'one EDIT attempt'
  SetMode $d ''
  Build-Chain $d @{} 'INITIAL'
  Assert ((Field (Invoke-Complete $d) 'code') -ceq 'EXPLICIT_RECOVERY_REQUIRED') 'recovery must be explicit'
  Build-Chain $d @{} 'RECONCILE_MISSING'
  $again=Invoke-Complete $d
  Assert ((Field $again 'status') -ceq 'PENDING' -and (Field $again 'code') -ceq 'EDIT_AMBIGUOUS_NO_RETRY') ('recovery does not repeat '+(Describe $again))
  Assert ((Cnt $d 'edits') -eq 1 -and (Cnt $d 'closes') -eq 0) 'zero further EDIT/CLOSE'
  # An EDIT that was applied but reported failure is adopted by readback, then closed once.
  $d=New-Fixture 'edit-applied-fail';SetMode $d 'edit-applied-fail'
  Assert ((Field (Invoke-Complete $d) 'code') -ceq 'EDIT_AMBIGUOUS_NO_RETRY') 'first run ambiguous'
  SetMode $d '';Build-Chain $d @{} 'RECONCILE_MISSING'
  Assert-Delivered $d (Invoke-Complete $d) 'adopted edit'
  Assert ((Cnt $d 'edits') -eq 1 -and (Cnt $d 'closes') -eq 1) 'edit not repeated, one CLOSE'
}

Check 'ambiguous CLOSE preserves pending truth; no repeat and no ACK without exact readback' {
  foreach($mode in @('close-fail','close-noapply')){
    $d=New-Fixture ('close-'+$mode);SetMode $d $mode
    $res=Invoke-Complete $d
    $code=$(if($mode -ceq 'close-fail'){'CLOSE_AMBIGUOUS_NO_RETRY'}else{'CLOSE_READBACK_FAILED'})
    Assert ((Field $res 'status') -ceq 'PENDING' -and (Field $res 'code') -ceq $code) ($mode+' '+(Describe $res))
    Assert-Flags (Ev $d) $true $true $true $false $false $false
    $out=@(Read-LifecycleJson (Join-Path $d 'state/outbox.json'))
    Assert (@($out|Where-Object {$_.deliveryStatus -ceq 'DELIVERED'}).Count -eq 0) ($mode+': no destination ACKed')
    Assert ((Remote $d).state -ceq 'OPEN') 'remote still OPEN'
    SetMode $d ''
    Build-Chain $d @{} 'INITIAL'
    Assert ((Field (Invoke-Complete $d) 'code') -ceq 'EXPLICIT_RECOVERY_REQUIRED') ($mode+': recovery explicit')
    Build-Chain $d @{} 'RECONCILE_MISSING'
    $again=Invoke-Complete $d
    Assert ((Field $again 'status') -ceq 'PENDING' -and (Field $again 'code') -ceq 'CLOSE_AMBIGUOUS_NO_RETRY' -and (Field $again 'automaticRetry') -eq $false) ($mode+' recovery '+(Describe $again))
    Assert ((Cnt $d 'closes') -eq 1 -and (Cnt $d 'edits') -eq 1) ($mode+': zero repeat CLOSE/EDIT')
  }
  # CLOSE applied remotely but the process reported failure: readback-only adoption, still one CLOSE.
  $d=New-Fixture 'close-applied-fail';SetMode $d 'close-applied-fail'
  Assert ((Field (Invoke-Complete $d) 'code') -ceq 'CLOSE_AMBIGUOUS_NO_RETRY') 'ambiguous first run'
  SetMode $d '';Build-Chain $d @{} 'RECONCILE_MISSING'
  Assert-Delivered $d (Invoke-Complete $d) 'adopted close'
  Assert ((Cnt $d 'closes') -eq 1 -and (Cnt $d 'edits') -eq 1) 'adopted without repeat'
  # Readback failure after a real CLOSE cannot ACK either destination.
  $d=New-Fixture 'close-readback-fails';SetMode $d 'view-fail-after-close'
  $res=Invoke-Complete $d
  Assert ((Field $res 'status') -ceq 'PENDING' -and (Field $res 'code') -ceq 'GITHUB_READ_FAILED') ('readback failure '+(Describe $res))
  Assert-Flags (Ev $d) $true $true $true $false $false $false
  Assert (@(Read-LifecycleJson (Join-Path $d 'state/outbox.json')|Where-Object {$_.deliveryStatus -ceq 'DELIVERED'}).Count -eq 0) 'no ACK without readback'
  SetMode $d '';Build-Chain $d @{} 'RECONCILE_MISSING'
  Assert-Delivered $d (Invoke-Complete $d) 'recovery readback'
  Assert ((Cnt $d 'closes') -eq 1) 'single CLOSE overall'
}

Check 'partial local note failure is truthful and recovers by readback with zero remote mutation' {
  $d=New-Fixture 'note-partial'
  With-FailingWriter (Join-Path $d 'vault/task.md') 1 { $script:Res=Invoke-Complete $d }
  $res=$script:Res
  Assert ((Field $res 'status') -ceq 'PENDING' -and (Field $res 'code') -ceq 'INJECTED_WRITE_FAILURE') ('note failure '+(Describe $res))
  Assert ((Remote $d).state -ceq 'CLOSED') 'GitHub already CLOSED'
  Assert-Flags (Ev $d) $true $true $true $true $true $false
  $out=@(Read-LifecycleJson (Join-Path $d 'state/outbox.json'))
  Assert (@($out|Where-Object {$_.destination -ceq 'github' -and $_.deliveryStatus -ceq 'DELIVERED'}).Count -eq 1 -and @($out|Where-Object {$_.destination -ceq 'note' -and $_.deliveryStatus -ceq 'PENDING'}).Count -eq 1) 'partial PENDING truth retained'
  Assert ((FileHash $d 'vault/task.md') -ceq (FileHash $d 'before-note.md')) 'note bytes unchanged'
  Build-Chain $d @{} 'INITIAL'
  Assert ((Field (Invoke-Complete $d) 'code') -ceq 'EXPLICIT_RECOVERY_REQUIRED') 'note recovery explicit'
  Build-Chain $d @{} 'RECONCILE_MISSING'
  Assert-Delivered $d (Invoke-Complete $d) 'note recovery'
  Assert ((Cnt $d 'edits') -eq 1 -and (Cnt $d 'closes') -eq 1) 'recovery made zero remote mutation'
  # Note already carrying the exact terminal bytes is ACKed from local readback.
  $d=New-Fixture 'note-already-after';PutText (Join-Path $d 'vault/task.md') (ExpectedNote $d)
  Assert-Delivered $d (Invoke-Complete $d) 'note already terminal'
  # A note edited by someone else refuses rather than being overwritten.
  $d=New-Fixture 'note-drift';PutText (Join-Path $d 'vault/task.md') ([IO.File]::ReadAllText((Join-Path $d 'before-note.md'))+' edited');$s=Snap $d
  Assert-Refused $d (Invoke-Complete $d) 'DESTINATION_DRIFT' 'note drift' 1
  Assert-Same $d $s 'note drift'
}

Check 'unrelated complete-journal and outbox events and the UPDATE journal are preserved' {
  $d=New-Fixture 'unrelated'
  $other=@{taskId='OTHER_TASK';canonicalRevision=5;digest=('b'*64);proofSha256=('c'*64);editSent=$true;editAck=$true;closeSent=$true;closeAck=$true;noteSent=$true;noteAck=$true}
  PutJson (JournalPath $d) @{schema='LifecycleCompleteJournal/v1';events=@{'other-key'=$other};heads=@{OTHER_TASK=@{revision=5;digest=('b'*64)}}}
  PutText (Join-Path $d 'state/lifecycle-update.journal.json') '{"schema":"LifecycleUpdateJournal/v2","events":{"u":{"digest":"x"}},"heads":{}}'
  $upd=FileHash $d 'state/lifecycle-update.journal.json'
  Build-Chain $d
  Assert-Delivered $d (Invoke-Complete $d) 'with unrelated state'
  $j=ReadJournal $d
  $o=$j.events['other-key']
  Assert ($o.Count -eq 10 -and $o['digest'] -ceq ('b'*64) -and $o['closeAck'] -eq $true -and $j.heads['OTHER_TASK']['revision'] -eq 5) 'unrelated complete event and head unchanged'
  Assert ((FileHash $d 'state/lifecycle-update.journal.json') -ceq $upd) 'UPDATE journal bytes untouched'
  # A malformed unrelated event or a foreign journal schema fails closed with zero mutation.
  $d=New-Fixture 'unrelated-corrupt'
  PutJson (JournalPath $d) @{schema='LifecycleCompleteJournal/v1';events=@{'bad'=@{digest='x'}};heads=@{}}
  Build-Chain $d;$s=Snap $d
  Assert-Refused $d (Invoke-Complete $d) 'JOURNAL_CORRUPT' 'unrelated corrupt event'
  Assert-Same $d $s 'corrupt event'
  $d=New-Fixture 'journal-foreign-schema'
  PutJson (JournalPath $d) @{schema='LifecycleUpdateJournal/v3';events=@{};heads=@{}}
  Build-Chain $d;$s=Snap $d
  Assert-Refused $d (Invoke-Complete $d) 'JOURNAL_CORRUPT' 'foreign schema'
  Assert-Same $d $s 'foreign schema'
  # Same key with a different payload or proof, and recovery without an event, refuse.
  $d=New-Fixture 'key-drift'
  PutJson (JournalPath $d) @{schema='LifecycleCompleteJournal/v1';events=@{'complete-2'=@{taskId=$TaskId;canonicalRevision=2;digest=('d'*64);proofSha256=('e'*64);editSent=$false;editAck=$false;closeSent=$false;closeAck=$false;noteSent=$false;noteAck=$false}};heads=@{}}
  Build-Chain $d;$s=Snap $d
  Assert-Refused $d (Invoke-Complete $d) 'KEY_PAYLOAD_DRIFT' 'payload drift'
  $d=New-Fixture 'recovery-without-event';Build-Chain $d @{} 'RECONCILE_MISSING'
  Assert-Refused $d (Invoke-Complete $d) 'RECOVERY_WITHOUT_EVENT' 'recovery without event'
}

Check 'transport CLOSE and terminal EDIT: structural validation, compare-before-write and exact fixed argv' {
  $dir=Join-Path $Root 'transport';[void][IO.Directory]::CreateDirectory($dir);[void][IO.Directory]::CreateDirectory((Join-Path $dir 'temp'))
  PutText (Join-Path $dir 'gh.bin') 'fixture executable pin target; never executed'
  $ghSha=Get-LifecycleFileHash (Join-Path $dir 'gh.bin')
  $marker=& $MarkerOf $TaskId
  $mk={param($status,$next,$summary)
    "<!-- $marker -->`n`n<!-- factory-task-status:start -->`nTask: $TaskId`nVersion: 2`nStatus: $status`nNext action: $next`nSummary: $summary`n<!-- factory-task-status:end -->`n`nUnowned discussion."}
  $desired=& $mk 'ACCEPTED_SCOPED' 'NONE' 'Reviewed summary'
  $calls=[Collections.Generic.List[object]]::new()
  $st=@{state='OPEN';title='Reviewed task';body=$desired;number=67;mode=''}
  $diagNew=${function:New-GitHubCliFailureDiagnostic216}
  $runner={
    param($exe,$argv,$deadline,$stdoutCap,$stderrCap)
    $calls.Add([string[]]@($argv))
    if($argv[1] -ceq 'view'){return [pscustomobject]@{exitCode=[int]0;timedOut=$false;stdout=([pscustomobject]@{number=$st.number;url=('https://github.com/hakanduyar/software-factory/issues/'+$st.number);state=$st.state;title=$st.title;body=$st.body}|ConvertTo-Json -Compress);stdoutTruncated=$false;stderrTruncated=$false}}
    if($argv[1] -ceq 'close'){
      if($st.mode -ceq 'fail'){return [pscustomobject]@{exitCode=[int]1;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false;failureDiagnostic=(& $diagNew -ExitCode 1 -TimedOut $false -StdoutTruncated $false -StderrTruncated $false -StderrText 'http 403 forbidden' -StderrEncoding 'VALID')}}
      $st.state='CLOSED';return [pscustomobject]@{exitCode=[int]0;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false}
    }
    if($argv[1] -ceq 'edit'){return [pscustomobject]@{exitCode=[int]0;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false}}
    throw 'UNEXPECTED_CONNECTOR_OPERATION'
  }.GetNewClosure()
  $t=New-GitHubCliLifecycleTransport216 -GhPath (Join-Path $dir 'gh.bin') -ExpectedGhSha256 $ghSha -Repository 'hakanduyar/software-factory' -TempRoot (Join-Path $dir 'temp') -ProcessRunner $runner
  $req={param($o) $h=@{repo='hakanduyar/software-factory';issueNumber=67;taskId=$TaskId;title='Reviewed task';body=$desired};foreach($k in $o.Keys){if($null -eq $o[$k]){$h.Remove($k)}else{$h[$k]=$o[$k]}};$h}
  # Static rejections never start a process.
  $bad=@(
    @{extra=1},@{repo='other/repo'},@{issueNumber='67'},@{issueNumber=0},@{taskId='bad id!'},
    @{body=(& $mk 'IN_PROGRESS' 'RUN_FOCUSED_CHECKS' 'Reviewed summary')},
    @{body=(& $mk 'ACCEPTED_SCOPED' 'INDEPENDENT_REVIEW' 'Reviewed summary')},
    @{body=(& $mk 'IN_PROGRESS' 'NONE' 'Reviewed summary')},
    @{body=($desired+"`r")},@{body=$desired.Replace($marker,'factory-task-'+('0'*64))},@{title=$null}
  )
  foreach($b in $bad){
    $res=& $t 'CLOSE' (& $req $b)
    Assert ($res.ok -eq $false) ('invalid CLOSE accepted: '+(Describe $b))
  }
  Assert ($calls.Count -eq 0) 'static rejections ran no process'
  # Wrong remote state or content: READ only, no close call.
  foreach($v in @(@{state='CLOSED'},@{title='Other'},@{body=($desired+' x')},@{number=68})){
    $st.state='OPEN';$st.title='Reviewed task';$st.body=$desired;$st.number=67;$st.mode='';foreach($k in $v.Keys){$st[$k]=$v[$k]}
    $calls.Clear();$res=& $t 'CLOSE' (& $req @{})
    Assert ($res.ok -eq $false -and @($calls|Where-Object {$_[1] -ceq 'close'}).Count -eq 0) ('compare-before-write refused '+(Describe $v))
  }
  # A requested title that differs from the remote title is only recognized by the READ: the READ must
  # occur and CLOSE must never run.
  $st.state='OPEN';$st.title='Reviewed task';$st.body=$desired;$st.number=67;$st.mode='';$calls.Clear()
  $res=& $t 'CLOSE' (& $req @{title='Different title'})
  Assert ($res.ok -eq $false) 'requested title mismatch refused'
  Assert (@($calls|Where-Object {$_[1] -ceq 'view'}).Count -eq 1 -and @($calls|Where-Object {$_[1] -ceq 'close'}).Count -eq 0) 'title mismatch: READ occurred and zero CLOSE calls'
  # Exact success: one view then one fixed close argv; structural result.
  $st.state='OPEN';$st.title='Reviewed task';$st.body=$desired;$st.number=67;$st.mode='';$calls.Clear()
  $ok=& $t 'CLOSE' (& $req @{})
  Assert ($ok.ok -eq $true -and $ok.operation -ceq 'CLOSE' -and $ok.number -eq 67 -and $ok.url -ceq 'https://github.com/hakanduyar/software-factory/issues/67') ('CLOSE result '+(Describe $ok))
  Assert ($calls.Count -eq 2 -and ($calls[0] -join ' ') -ceq 'issue view 67 --repo hakanduyar/software-factory --json number,url,state,title,body') 'initial compare READ argv'
  Assert (($calls[1] -join "`n") -ceq ((@('issue','close','67','--repo','hakanduyar/software-factory','--reason','completed')) -join "`n")) 'fixed close argv without shell'
  # A failing process is a failure with a typed diagnostic, never ok.
  $st.state='OPEN';$st.mode='fail'
  $f=& $t 'CLOSE' (& $req @{})
  Assert ($f.ok -eq $false -and $f.diagnostic.category -ceq 'PERMISSION_DENIED') ('failure diagnostic '+(Describe $f))
  # Terminal EDIT: NONE is accepted only with ACCEPTED_SCOPED; CREATE never accepts it.
  $before=& $mk 'IN_PROGRESS' 'RUN_FOCUSED_CHECKS' 'Original summary'
  $before=$before.Replace('Version: 2','Version: 1')
  $st.state='OPEN';$st.mode='';$st.title='Original task';$st.body=$before;$calls.Clear()
  $e=& $t 'EDIT' @{repo='hakanduyar/software-factory';issueNumber=67;taskId=$TaskId;title='Reviewed task';body=$desired;beforeTitle='Original task';beforeBody=$before}
  Assert ($e.ok -eq $true -and @($calls|Where-Object {$_[1] -ceq 'edit'}).Count -eq 1) ('terminal EDIT '+(Describe $e))
  $calls.Clear();$badBody=& $mk 'IN_PROGRESS' 'NONE' 'Reviewed summary'
  $e=& $t 'EDIT' @{repo='hakanduyar/software-factory';issueNumber=67;taskId=$TaskId;title='Reviewed task';body=$badBody;beforeTitle='Original task';beforeBody=$before}
  Assert ($e.ok -eq $false -and $calls.Count -eq 0) 'NONE with a non-terminal status refused by EDIT'
  $create=& $t 'CREATE' @{repo='hakanduyar/software-factory';title='Reviewed task';body=(& $mk 'ACCEPTED_SCOPED' 'NONE' 'Reviewed summary').Replace('Version: 2','Version: 1')}
  Assert ($create.ok -eq $false -and $calls.Count -eq 0) 'CREATE does not accept NONE'
  $unknown=& $t 'REOPEN' (& $req @{})
  Assert ($unknown.ok -eq $false -and $calls.Count -eq 0) 'no reopen operation'
}

Check 'held canonical or publisher lock yields LOCKED with zero transport calls and no byte changes' {
  foreach($which in @('canonical','publisher')){
    $d=New-Fixture ('locked-'+$which)
    $lockPath=$(if($which -ceq 'canonical'){(Join-Path $d 'canonical.json')+'.lock'}else{Join-Path $d 'state/publisher.lock'})
    $expect=$(if($which -ceq 'canonical'){'CANONICAL_LOCKED'}else{'PUBLISHER_LOCKED'})
    $s=Snap $d;$hadJournal=HasJournal $d
    $held=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try{ $res=Invoke-Complete $d }finally{ $held.Dispose() }
    Assert ((Field $res 'status') -ceq 'LOCKED' -and (Field $res 'code') -ceq $expect) ($which+' expected LOCKED '+$expect+' got '+(Describe $res))
    Assert ((Cnt $d 'reads') -eq 0 -and (Cnt $d 'edits') -eq 0 -and (Cnt $d 'closes') -eq 0) ($which+' lock: transport was used')
    Assert ((HasJournal $d) -eq $hadJournal -and -not (HasJournal $d)) ($which+' lock: journal created')
    Assert-Same $d $s ($which+' lock')
  }
}

PutJson (Join-Path $Root 'results.json') @{schema='LifecycleVerifiedCompleteTestResults/v1';sourceSha256=$SourceSha256;results=@($script:Results.ToArray())}
$failures=@($script:Results|Where-Object {$_.outcome -cne 'PASS'})
PutJson (Join-Path $Root 'failures.json') @{schema='LifecycleVerifiedCompleteTestFailures/v1';failures=@($failures)}
$failed=@($script:Results|Where-Object {$_.outcome -ceq 'FAIL'}).Count;$harness=@($script:Results|Where-Object {$_.outcome -ceq 'HARNESS_ERROR'}).Count
Write-Output ('SUMMARY checks='+$script:Results.Count+' failed='+$failed+' harnessErrors='+$harness)
if($harness -gt 0){exit 2}
if($failed -gt 0){exit 1}
Write-Output ('ALL_PASS groups='+$script:Results.Count)
exit 0
