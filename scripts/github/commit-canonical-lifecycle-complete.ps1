#Requires -Version 7.6
Set-StrictMode -Version Latest

# Explicit, separately host-admitted boundary: ONE caller-owned canonical COMPLETE contract record
# (the six public fields only) is replaced by pre-approved bytes after the existing completion-proof
# reader has re-authenticated the proof chain, then the accepted COMPLETE enqueue boundary appends
# the two PENDING rows. Every pin is an argument of the host invocation (request + independent
# admission); nothing in a file grants authority and this module issues none. The public contract
# label ACCEPTED_SCOPED never means a remote close, a delivered note or domain completion.
# It is not a two-file transaction: the gap between the canonical commit and the enqueue is a
# durable, resumable PENDING_ENQUEUE state of one deterministic operation intent. It never calls
# the delivery consumer or any remote service, never closes, acknowledges, rolls back, retries or
# loops, and never marks any outbox row DELIVERED.
# Lease order: operation lock -> canonical.lock (RELEASED before the enqueue) -> the enqueue's own
# canonical.lock + publisher.lock. Leases are never nested with the enqueue's.

function Get-CxSha256 {
  param([byte[]]$Bytes)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-CxFileSha256 {
  param([string]$Path)
  Get-CxSha256 ([IO.File]::ReadAllBytes($Path))
}
function Test-CxHash {
  param($Value)
  return ($Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}\z')
}
function Test-CxIntegral {
  param($Value)
  return ($Value -is [int] -or $Value -is [long])
}
function Assert-CxPath {
  # Canonical absolute path, optionally inside Root, no reparse point on the path or any ancestor.
  param([string]$Path,[string]$Root='',[switch]$MustBeFile)
  if([string]::IsNullOrEmpty($Path) -or $Path.Contains([char]0)){throw 'PATH_INVALID'}
  if(-not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path){throw 'PATH_INVALID'}
  if($Root -and -not $Path.StartsWith(($Root.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar),[StringComparison]::Ordinal)){throw 'PATH_OUTSIDE_OWNER'}
  $cur=$Path
  while($cur){
    $attr=$null
    try{$attr=[IO.File]::GetAttributes($cur)}catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{$attr=$null}
    if($null -ne $attr -and (($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'REPARSE_REFUSED'}
    $cur=[IO.Path]::GetDirectoryName($cur)
  }
  if($MustBeFile -and -not [IO.File]::Exists($Path)){throw 'FILE_MISSING'}
}
function Open-CxLease {
  # Exclusive stream, or $null on contention. Missing directory and other errors propagate.
  param([string]$Path)
  try{
    return [IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  }catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{
    throw
  }catch [IO.IOException]{
    return $null
  }
}
function Read-CxJsonBytes {
  # Strict: size cap, strict UTF-8, no duplicate names at any depth (ordinal-ignore-case).
  param([byte[]]$Bytes)
  if($Bytes.Length -gt 1048576){throw 'INPUT_TOO_LARGE'}
  $text=$null; $doc=$null
  try{
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)
    $doc=[Text.Json.JsonDocument]::Parse($text)
  }catch{throw 'JSON_INVALID'}
  try{
    $visit={ param($el)
      if($el.ValueKind -eq [Text.Json.JsonValueKind]::Object){
        $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach($pr in $el.EnumerateObject()){ if(-not $seen.Add($pr.Name)){throw 'DUPLICATE_FIELD'}; & $visit $pr.Value }
      } elseif($el.ValueKind -eq [Text.Json.JsonValueKind]::Array){ foreach($v in $el.EnumerateArray()){ & $visit $v } }
    }
    & $visit $doc.RootElement
  }catch{
    if($_.Exception.Message -ceq 'DUPLICATE_FIELD'){throw 'DUPLICATE_FIELD'}
    throw 'JSON_INVALID'
  }finally{ $doc.Dispose() }
  try{ return ($text | ConvertFrom-Json -AsHashtable -DateKind String) }catch{ throw 'JSON_INVALID' }
}
function Assert-CxKeys {
  param($Object,[string[]]$Keys)
  if($Object -isnot [hashtable] -or $Object.Count -ne $Keys.Count){throw 'FIELDS_INVALID'}
  foreach($k in $Keys){if(-not $Object.ContainsKey($k) -or @($Object.Keys) -cnotcontains $k){throw 'FIELDS_INVALID'}}
}
function Get-CxRef {
  # Exact {path, sha256} reference; the digest is compared by the caller against the actual bytes.
  param($Ref)
  Assert-CxKeys $Ref @('path','sha256')
  if($Ref['path'] -isnot [string] -or -not (Test-CxHash $Ref['sha256'])){throw 'REQUEST_INVALID'}
  Assert-CxPath -Path $Ref['path'] -MustBeFile
  return @{path=$Ref['path'];sha256=$Ref['sha256']}
}
function New-CxResult {
  param([string]$Status,[string]$Code,[string]$OperationId='',[string]$Phase='',[bool]$Committed=$false,$CanonicalSha=$null,[string[]]$Keys=@(),$OutboxSha=$null)
  return [pscustomobject][ordered]@{status=$Status;code=$Code;operationId=$OperationId;phase=$Phase;canonicalCommitted=$Committed;canonicalSha256=$CanonicalSha;keys=@($Keys);outboxSha256=$OutboxSha;publication='NOT_ATTEMPTED'}
}
function Invoke-CxFaultPoint {
  # Narrow test seam. Production no-op; a test shadows it with an alias to inject a failure or a
  # simulated crash ('SIMULATED_CRASH:<point>'). It grants no authority and skips no check.
  param([string]$Point)
}
function Write-CxAtomic {
  param([string]$Path,[byte[]]$Bytes)
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    [IO.File]::Move($tmp,$Path,$true)
  }finally{ if([IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
}
function Write-CxCreateNew {
  # Create-if-absent: the move fails (IOException) when the target already exists.
  param([string]$Path,[byte[]]$Bytes)
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    [IO.File]::Move($tmp,$Path)
  }finally{ if([IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
}
function Assert-CxOpDirEntries {
  # The operation directory holds only this module's own files.
  param([string]$Dir)
  if(-not [IO.Directory]::Exists($Dir)){return}
  foreach($e in [IO.Directory]::GetFileSystemEntries($Dir)){
    $n=[IO.Path]::GetFileName($e)
    if(-not ($n -cin @('operation.lock','intent.json','status.json') -or $n -cmatch '^(intent|status)\.json\.tmp-[0-9a-f]{32}\z')){throw 'OPERATION_DIR_FOREIGN'}
    if(([IO.File]::GetAttributes($e) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_REFUSED'}
    if([IO.Directory]::Exists($e)){throw 'OPERATION_DIR_FOREIGN'}
  }
}
function Read-CxStatus {
  param([string]$Dir,[string]$OperationId,[string]$IntentSha)
  $p=Join-Path $Dir 'status.json'
  if(-not [IO.File]::Exists($p)){return @{phase='INTENT_PERSISTED';basePhase='INTENT_PERSISTED';cause=$null}}
  try{
    $s=Read-CxJsonBytes ([IO.File]::ReadAllBytes($p))
    Assert-CxKeys $s @('schema','operationId','intentSha256','phase','basePhase','cause')
    $phases=@('INTENT_PERSISTED','COMMIT_STARTED','PENDING_ENQUEUE','ENQUEUED')
    if($s['schema'] -cne 'CanonicalLifecycleCompleteCommitStatus/v1' -or $s['operationId'] -cne $OperationId -or $s['intentSha256'] -cne $IntentSha){throw 'x'}
    if($s['basePhase'] -isnot [string] -or $s['basePhase'] -cnotin $phases){throw 'x'}
    if($s['phase'] -isnot [string] -or $s['phase'] -cnotin ($phases+@('CONFLICT'))){throw 'x'}
    if($s['phase'] -cne 'CONFLICT' -and $s['phase'] -cne $s['basePhase']){throw 'x'}
    if($null -ne $s['cause'] -and ($s['cause'] -isnot [string] -or $s['cause'] -cnotmatch '^[A-Z][A-Z0-9_]{2,63}\z')){throw 'x'}
    return @{phase=$s['phase'];basePhase=$s['basePhase'];cause=$s['cause']}
  }catch{ throw 'STATUS_INVALID' }
}
function Set-CxStatus {
  # Truthful phase record of this operation. It is recovery evidence, never authority.
  param([string]$Dir,[string]$OperationId,[string]$IntentSha,[string]$Phase,[string]$BasePhase,$Cause)
  if($null -ne $Cause -and ($Cause -isnot [string] -or $Cause -cnotmatch '^[A-Z][A-Z0-9_]{2,63}\z')){$Cause='UNCLASSIFIED_ERROR'}
  $rec=[ordered]@{schema='CanonicalLifecycleCompleteCommitStatus/v1';operationId=$OperationId;intentSha256=$IntentSha;phase=$Phase;basePhase=$BasePhase;cause=$Cause}
  Write-CxAtomic (Join-Path $Dir 'status.json') ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $rec -Depth 4 -Compress)))
}
function Get-CxRows {
  # Rows parsed with -DateKind String so unrelated rows are compared without date conversion.
  param([byte[]]$Bytes)
  $rows=[Collections.Generic.List[object]]::new()
  $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes).TrimStart([char]0xFEFF)
  if(-not [string]::IsNullOrWhiteSpace($text)){
    $parsed=ConvertFrom-Json -InputObject $text -NoEnumerate -DateKind String
    if($parsed -isnot [array]){$parsed=@($parsed)}
    foreach($x in $parsed){$rows.Add($x)}
  }
  return ,$rows.ToArray()
}

function Invoke-CanonicalLifecycleCompleteCommit {
  [CmdletBinding()]
  param(
    [string]$RequestPath,[string]$ExpectedRequestSha256,
    [string]$AdmissionPath,[string]$ExpectedAdmissionSha256
  )
  $ErrorActionPreference='Stop'
  $opLock=$null; $canonicalLease=$null; $opId=''; $keys=@(); $committed=$false; $canonicalPath=$null
  $afterSha=$null; $opDir=$null; $intentPath=$null
  try{
    foreach($h in @($ExpectedRequestSha256,$ExpectedAdmissionSha256)){if(-not (Test-CxHash $h)){throw 'PIN_INVALID'}}
    Assert-CxPath -Path $RequestPath -MustBeFile
    Assert-CxPath -Path $AdmissionPath -MustBeFile
    $reqBytes=[IO.File]::ReadAllBytes($RequestPath)
    if((Get-CxSha256 $reqBytes) -cne $ExpectedRequestSha256){throw 'REQUEST_DRIFT'}
    $admBytes=[IO.File]::ReadAllBytes($AdmissionPath)
    if((Get-CxSha256 $admBytes) -cne $ExpectedAdmissionSha256){throw 'ADMISSION_DRIFT'}
    $req=Read-CxJsonBytes $reqBytes
    $adm=Read-CxJsonBytes $admBytes

    # Request: exact schema, ordinal keys, strict types. No default, no alias, no coercion.
    Assert-CxKeys $req @('schema','operationId','taskId','canonicalPath','expectedBeforeSha256','newCanonicalRef','packetRef','completionProofRef','candidateCommit','enqueueRef','consumerRef','reconcileRef','captureRef','stateDir','outboxPath','expectedOutboxSha256','operationDirectory')
    if($req['schema'] -isnot [string] -or $req['schema'] -cne 'CanonicalLifecycleCompleteCommitRequest/v1'){throw 'REQUEST_INVALID'}
    $opId=$req['operationId']
    if($opId -isnot [string] -or $opId -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z'){$opId='';throw 'OPERATION_ID_INVALID'}
    $taskId=$req['taskId']
    if($taskId -isnot [string] -or $taskId -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z'){throw 'REQUEST_INVALID'}
    foreach($k in @('canonicalPath','stateDir','outboxPath','operationDirectory')){if($req[$k] -isnot [string]){throw 'REQUEST_INVALID'}}
    $beforeSha=$req['expectedBeforeSha256']
    if(-not (Test-CxHash $beforeSha)){throw 'REQUEST_INVALID'}
    # The outbox must already exist with this exact hash; there is no absent or auto-created case.
    $expectedOutbox=$req['expectedOutboxSha256']
    if(-not (Test-CxHash $expectedOutbox)){throw 'REQUEST_INVALID'}
    $candidate=$req['candidateCommit']
    if($candidate -isnot [string] -or $candidate -cnotmatch '^[0-9a-f]{40}\z' -or $candidate -ceq ('0'*40)){throw 'CANDIDATE_INVALID'}
    $canonicalPath=$req['canonicalPath']; $stateDir=$req['stateDir']; $outboxPath=$req['outboxPath']; $opDir=$req['operationDirectory']
    $newRef=Get-CxRef $req['newCanonicalRef']; $packetRef=Get-CxRef $req['packetRef']; $proofRef=Get-CxRef $req['completionProofRef']
    $enqueueRef=Get-CxRef $req['enqueueRef']; $consumerRef=Get-CxRef $req['consumerRef']; $reconcileRef=Get-CxRef $req['reconcileRef']
    $captureRef=Get-CxRef $req['captureRef']
    $newPath=$newRef.path; $afterSha=$newRef.sha256; $packetPath=$packetRef.path; $proofPath=$proofRef.path

    # Owned, canonical, non-reparse paths.
    Assert-CxPath -Path $canonicalPath -MustBeFile
    if($newPath -ceq $canonicalPath){throw 'REQUEST_INVALID'}
    Assert-CxPath -Path $stateDir
    if(-not [IO.Directory]::Exists($stateDir)){throw 'STATE_DIR_MISSING'}
    Assert-CxPath -Path $outboxPath -Root $stateDir
    if($outboxPath -cne (Join-Path $stateDir 'outbox.json')){throw 'OUTBOX_BINDING'}
    if($opDir -cne (Join-Path $stateDir ('canonical-complete-'+$opId))){throw 'OPERATION_BINDING'}
    Assert-CxPath -Path $opDir -Root $stateDir
    Assert-CxPath -Path ($outboxPath+'.lock') -Root $stateDir
    Assert-CxPath -Path (Join-Path $stateDir 'publisher.lock') -Root $stateDir
    Assert-CxPath -Path ($canonicalPath+'.lock')
    $intentPath=Join-Path $opDir 'intent.json'
    # The capture helper is the sibling the reconcile source itself resolves.
    $capturePath=Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $reconcileRef.path)) 'dispatch') 'reviewed-blocked-capture.ps1'
    if($captureRef.path -cne $capturePath){throw 'CAPTURE_BINDING'}

    $pins=@(
      @{path=$RequestPath;sha=$ExpectedRequestSha256;code='REQUEST_DRIFT'},
      @{path=$AdmissionPath;sha=$ExpectedAdmissionSha256;code='ADMISSION_DRIFT'},
      @{path=$newPath;sha=$afterSha;code='NEW_CANONICAL_DRIFT'},
      @{path=$packetPath;sha=$packetRef.sha256;code='PACKET_DRIFT'},
      @{path=$proofPath;sha=$proofRef.sha256;code='COMPLETION_PROOF_DRIFT'},
      @{path=$enqueueRef.path;sha=$enqueueRef.sha256;code='ENQUEUE_DRIFT'},
      @{path=$consumerRef.path;sha=$consumerRef.sha256;code='CONSUMER_DRIFT'},
      @{path=$reconcileRef.path;sha=$reconcileRef.sha256;code='RECONCILE_DRIFT'},
      @{path=$capturePath;sha=$captureRef.sha256;code='CAPTURE_DRIFT'}
    )
    # Request, admission, new bytes, packet, proof and the executable closure are immutable under use.
    $verifyPins={
      foreach($pin in $pins){
        Assert-CxPath -Path $pin.path -MustBeFile
        if((Get-CxFileSha256 $pin.path) -cne $pin.sha){throw $pin.code}
      }
    }
    & $verifyPins

    # Independent host admission: named reviewer, exact bindings, exact decision. Never issued here.
    Assert-CxKeys $adm @('schema','decision','reviewer','requestSha256','operationId','taskId','beforeSha256','afterSha256','packetSha256','completionProofSha256','candidateCommit','enqueueSha256','consumerSha256','reconcileSha256','captureSha256')
    if($adm['schema'] -isnot [string] -or $adm['schema'] -cne 'CanonicalLifecycleCompleteCommitAdmission/v1' -or $adm['decision'] -isnot [string] -or $adm['decision'] -cne 'ADMIT_CANONICAL_COMPLETE_COMMIT'){throw 'ADMISSION_INVALID'}
    if($adm['reviewer'] -isnot [string] -or $adm['reviewer'] -cnotmatch '^[A-Za-z0-9._:@-]{1,128}\z'){throw 'ADMISSION_INVALID'}
    foreach($k in @('requestSha256','beforeSha256','afterSha256','packetSha256','completionProofSha256','enqueueSha256','consumerSha256','reconcileSha256','captureSha256')){if(-not (Test-CxHash $adm[$k])){throw 'ADMISSION_INVALID'}}
    if($adm['candidateCommit'] -isnot [string] -or $adm['candidateCommit'] -cnotmatch '^[0-9a-f]{40}\z'){throw 'ADMISSION_INVALID'}
    if($adm['operationId'] -isnot [string] -or $adm['operationId'] -cne $opId -or $adm['taskId'] -isnot [string] -or $adm['taskId'] -cne $taskId -or
       $adm['requestSha256'] -cne $ExpectedRequestSha256 -or $adm['beforeSha256'] -cne $beforeSha -or $adm['afterSha256'] -cne $afterSha -or
       $adm['packetSha256'] -cne $packetRef.sha256 -or $adm['completionProofSha256'] -cne $proofRef.sha256 -or $adm['candidateCommit'] -cne $candidate -or
       $adm['enqueueSha256'] -cne $enqueueRef.sha256 -or $adm['consumerSha256'] -cne $consumerRef.sha256 -or
       $adm['reconcileSha256'] -cne $reconcileRef.sha256 -or $adm['captureSha256'] -cne $captureRef.sha256){throw 'ADMISSION_BINDING'}

    # Only the pinned sources are loaded. Capture first so the reconcile source finds the pinned
    # sibling instead of loading another; then the readers and the accepted COMPLETE enqueue.
    $loadCapture=$capturePath; $loadConsumer=$consumerRef.path; $loadReconcile=$reconcileRef.path; $loadEnqueue=$enqueueRef.path
    try{
      . $loadCapture
      . $loadConsumer
      . $loadReconcile
      . $loadEnqueue
    }catch{ throw 'IMPORT_FAILED' }
    & $verifyPins
    foreach($fn in @('New-TaskLifecycleMirrorPacket','Read-LifecycleCompletionProof','Get-LifecycleHash','Read-Outbox','Get-EventKey','Invoke-CanonicalLifecycleCompleteEnqueue')){
      if(-not (Get-Command -Name $fn -CommandType Function -ErrorAction SilentlyContinue)){throw 'IMPORT_INCOMPLETE'}
    }

    $six=@('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')

    # Proof preflight with the existing reader (never a weaker copy): the new canonical must equal
    # the typed COMPLETE packet and the proof chain must authenticate for exactly this task,
    # revision and candidate. Returns comparable normalized views; re-run at every boundary.
    $validateProof={
      param($pk,[byte[]]$newBytes)
      $new=Read-CxJsonBytes $newBytes
      $proof=Read-LifecycleCompletionProof @{path=$proofPath;sha256=$proofRef.sha256} $pk
      if([string]$proof.candidateCommit -cne $candidate){throw 'CANDIDATE_MISMATCH'}
      return @{
        digest=(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($new | ConvertTo-Json -Depth 8 -Compress))))
        packetJson=(ConvertTo-Json $pk -Depth 5 -Compress)
        proofJson=(ConvertTo-Json $proof -Compress)
      }
    }
    # Initial-state outbox check, decided without an effect with the existing reader and the exact event
    # semantics of the enqueue boundary: the admitted bytes must be reader-compatible and this event's own
    # target rows must neither conflict nor be NO_RETRY. Run before any effect and again at the CAS
    # boundary; postcommit external drift is handled separately (PENDING_ENQUEUE / CONFLICT, no rollback).
    $checkOutbox={
      param($pk,[string]$digest,$ekeys)
      if(-not [IO.File]::Exists($outboxPath)){throw 'OUTBOX_DRIFT'}
      $bytes=[IO.File]::ReadAllBytes($outboxPath)
      if($bytes.Length -gt 1048576){throw 'OUTBOX_TOO_LARGE'}
      if((Get-CxSha256 $bytes) -cne $expectedOutbox){throw 'OUTBOX_DRIFT'}
      $validated=$null
      try{
        $validated=@(Read-Outbox $outboxPath)
        $raw=Get-CxRows $bytes
        if($raw.Count -ne $validated.Count){throw 'x'}
        for($r=0;$r -lt $raw.Count;$r++){if([string]$raw[$r].key -cne [string]$validated[$r].key){throw 'x'}}
      }catch{ throw 'OUTBOX_INVALID' }
      if((Get-CxFileSha256 $outboxPath) -cne $expectedOutbox){throw 'OUTBOX_DRIFT'}
      foreach($dest in @('github','note')){
        $runId=$pk['idempotencyKey']+':complete:'+$dest; $key=$ekeys[$dest]
        if(@($validated | Where-Object {[string]$_.runId -ceq $runId -and [string]$_.key -cne $key}).Count -gt 0){throw 'IDENTITY_CONFLICT'}
        $same=@($validated | Where-Object {[string]$_.key -ceq $key})
        if($same.Count -gt 1){throw 'IDENTITY_CONFLICT'}
        if($same.Count -eq 1){
          $row=$same[0]
          if($row.PSObject.Properties.Name -ccontains 'retryPolicy' -and [string]$row.retryPolicy -ceq 'NO_RETRY'){throw 'EXCLUDED_NO_RETRY'}
          if([string]$row.taskId -cne $pk['taskId'] -or [string]$row.payloadSha256 -cne $digest -or [string]$row.runId -cne $runId -or [string]$row.destination -cne $dest -or [string]$row.status -cne 'AWAITING_CONTROLLER' -or -not (Test-CxIntegral $row.attempt) -or [int64]$row.attempt -ne 0){throw 'IDENTITY_CONFLICT'}
        }
      }
    }
    # Everything that can be decided without an effect. Run before any effect and again under the
    # operation lock. Returns the validated operation state.
    $prepare={
      $s=@{}
      Assert-CxOpDirEntries $opDir
      if([IO.Directory]::Exists($intentPath) -or [IO.Directory]::Exists($outboxPath)){throw 'OPERATION_DIR_FOREIGN'}
      $s['replay']=[IO.File]::Exists($intentPath)
      $newBytes=[IO.File]::ReadAllBytes($newPath)
      if((Get-CxSha256 $newBytes) -cne $afterSha){throw 'NEW_CANONICAL_DRIFT'}
      $packetBytes=[IO.File]::ReadAllBytes($packetPath)
      if((Get-CxSha256 $packetBytes) -cne $packetRef.sha256){throw 'PACKET_DRIFT'}
      $curBytes=[IO.File]::ReadAllBytes($canonicalPath)
      if(-not [IO.File]::Exists($outboxPath)){throw 'OUTBOX_DRIFT'}
      $oldBytes=$null; $obBytes=$null
      if($s['replay']){
        # Resume: the persisted intent supplies the exact before evidence; live bytes cannot.
        $iBytes=[IO.File]::ReadAllBytes($intentPath)
        $i=Read-CxJsonBytes $iBytes
        Assert-CxKeys $i @('schema','operationId','taskId','requestSha256','admissionSha256','canonicalPath','beforeSha256','afterSha256','packetSha256','completionProofSha256','candidateCommit','enqueueSha256','consumerSha256','reconcileSha256','captureSha256','stateDir','outboxPath','expectedOutboxSha256','beforeCanonicalBase64','afterCanonicalBase64','outboxBeforeBase64','digest','keys')
        if($i['beforeCanonicalBase64'] -isnot [string] -or $i['outboxBeforeBase64'] -isnot [string]){throw 'INTENT_INVALID'}
        try{
          $oldBytes=[Convert]::FromBase64String($i['beforeCanonicalBase64'])
          $obBytes=[Convert]::FromBase64String($i['outboxBeforeBase64'])
        }catch{throw 'INTENT_INVALID'}
        if((Get-CxSha256 $oldBytes) -cne $beforeSha){throw 'INTENT_MISMATCH'}
        if((Get-CxSha256 $obBytes) -cne $expectedOutbox){throw 'INTENT_MISMATCH'}
        $s['intentFileSha']=Get-CxSha256 $iBytes
      } else {
        # Initial operation requires the exact before-state and the exact approved outbox.
        if((Get-CxSha256 $curBytes) -cne $beforeSha){throw 'CANONICAL_DRIFT'}
        $oldBytes=$curBytes
        $obBytes=[IO.File]::ReadAllBytes($outboxPath)
        if($obBytes.Length -gt 1048576){throw 'OUTBOX_TOO_LARGE'}
        if((Get-CxSha256 $obBytes) -cne $expectedOutbox){throw 'OUTBOX_DRIFT'}
      }
      $old=Read-CxJsonBytes $oldBytes
      $new=Read-CxJsonBytes $newBytes
      foreach($o in @($old,$new)){
        Assert-CxKeys $o $six
        foreach($k in @('taskId','publicTitle','publicSummary','publicStatus','nextAction')){if($o[$k] -isnot [string]){throw 'CANONICAL_CONTENT_INVALID'}}
        if($o['taskId'] -cne $taskId){throw 'TASK_MISMATCH'}
        if(-not (Test-CxIntegral $o['canonicalRevision'])){throw 'REVISION_INVALID'}
      }
      $p=New-TaskLifecycleMirrorPacket (Read-CxJsonBytes $packetBytes)
      if($p['eventType'] -cne 'COMPLETE'){throw 'UNSUPPORTED_EVENT'}
      if($p['publicStatus'] -cne 'ACCEPTED_SCOPED' -or $p['nextAction'] -cne 'NONE'){throw 'UNSUPPORTED_EVENT'}
      if($p['taskId'] -cne $taskId){throw 'TASK_MISMATCH'}
      if([long]$new['canonicalRevision'] -le [long]$old['canonicalRevision']){throw 'REVISION_NOT_INCREASING'}
      foreach($k in @('taskId','publicTitle','publicSummary','publicStatus','nextAction')){if($p[$k] -isnot [string] -or $new[$k] -cne $p[$k]){throw 'CANONICAL_PACKET_MISMATCH'}}
      if([long]$new['canonicalRevision'] -ne [long]$p['canonicalRevision']){throw 'CANONICAL_PACKET_MISMATCH'}
      $pv=& $validateProof $p $newBytes
      $digest=$pv.digest
      $ek=[ordered]@{}
      foreach($dest in @('github','note')){$ek[$dest]=Get-EventKey -TaskId $p['taskId'] -PayloadSha256 $digest -RunId ($p['idempotencyKey']+':complete:'+$dest) -Status 'AWAITING_CONTROLLER' -Attempt 0}
      if(-not $s['replay']){& $checkOutbox $p $digest $ek}
      $intent=[ordered]@{
        schema='CanonicalLifecycleCompleteCommitIntent/v1';operationId=$opId;taskId=$taskId;requestSha256=$ExpectedRequestSha256;admissionSha256=$ExpectedAdmissionSha256
        canonicalPath=$canonicalPath;beforeSha256=$beforeSha;afterSha256=$afterSha;packetSha256=$packetRef.sha256;completionProofSha256=$proofRef.sha256;candidateCommit=$candidate
        enqueueSha256=$enqueueRef.sha256;consumerSha256=$consumerRef.sha256;reconcileSha256=$reconcileRef.sha256;captureSha256=$captureRef.sha256;stateDir=$stateDir;outboxPath=$outboxPath
        expectedOutboxSha256=$expectedOutbox;beforeCanonicalBase64=[Convert]::ToBase64String($oldBytes);afterCanonicalBase64=[Convert]::ToBase64String($newBytes)
        outboxBeforeBase64=[Convert]::ToBase64String($obBytes);digest=$digest;keys=$ek
      }
      $intentBytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $intent -Depth 6 -Compress))
      # The persisted intent is re-read through Read-CxJsonBytes (1048576-byte cap): refuse an
      # unrepresentable aggregate here, before any directory, intent, canonical or outbox effect.
      if($intentBytes.Length -gt 1048576){throw 'INTENT_TOO_LARGE'}
      $s['intentSha']=Get-CxSha256 $intentBytes
      if($s['replay'] -and $s['intentFileSha'] -cne $s['intentSha']){throw 'INTENT_MISMATCH'}
      $s['intentBytes']=$intentBytes; $s['newBytes']=$newBytes; $s['packet']=$p; $s['digest']=$digest; $s['keys']=$ek
      $s['packetJson']=$pv.packetJson; $s['proofJson']=$pv.proofJson; $s['newRevision']=$new['canonicalRevision']
      $s['outboxBytes']=$obBytes
      return $s
    }
    $recheckProof={
      $x=& $validateProof $s['packet'] $s['newBytes']
      if($x.digest -cne $s['digest'] -or $x.packetJson -cne $s['packetJson'] -or $x.proofJson -cne $s['proofJson']){throw 'PROOF_DRIFT'}
    }

    $res={
      param([string]$Status,[string]$Code,[string]$Phase)
      $cs=$null; try{$cs=Get-CxFileSha256 $canonicalPath}catch{$cs=$null}
      $os=$null; try{if([IO.File]::Exists($outboxPath)){$os=Get-CxFileSha256 $outboxPath}}catch{$os=$null}
      return (New-CxResult $Status $Code $opId $Phase $committed $cs $keys $os)
    }
    $setStatus={
      param([string]$Phase,[string]$Base,$Cause)
      Set-CxStatus -Dir $opDir -OperationId $opId -IntentSha $s['intentSha'] -Phase $Phase -BasePhase $Base -Cause $Cause
      if($Phase -cne 'CONFLICT'){$st['phase']=$Phase;$st['basePhase']=$Base;$st['cause']=$Cause}
    }
    $conflict={ param([string]$Code) & $setStatus 'CONFLICT' $st['basePhase'] $Code; return (& $res 'CONFLICT' $Code 'CONFLICT') }

    # Pre-effect validation, then the owned directory, operation lock and ONE deterministic intent.
    $s=& $prepare
    $keys=@($s['keys']['github'],$s['keys']['note'])
    [void][IO.Directory]::CreateDirectory($opDir)
    Assert-CxPath -Path $opDir -Root $stateDir
    Assert-CxOpDirEntries $opDir
    $opLock=Open-CxLease (Join-Path $opDir 'operation.lock')
    if($null -eq $opLock){return (& $res 'REFUSED' 'OPERATION_LOCKED' 'PREFLIGHT')}
    $s=& $prepare
    if(-not $s['replay']){Write-CxCreateNew $intentPath $s['intentBytes']}
    Invoke-CxFaultPoint 'AFTER_INTENT'
    $st=Read-CxStatus -Dir $opDir -OperationId $opId -IntentSha $s['intentSha']
    $newBytes=$s['newBytes']

    # Canonical stage under canonical.lock: CAS on the exact before-state, never an in-place truncate.
    $canonicalLease=Open-CxLease ($canonicalPath+'.lock')
    if($null -eq $canonicalLease){return (& $res 'REFUSED' 'CANONICAL_LOCKED' $st['phase'])}
    & $verifyPins
    $cur=Get-CxFileSha256 $canonicalPath
    if($cur -ceq $afterSha){
      # Exact-after is adoptable only when this operation had started the commit.
      if($st['basePhase'] -cnotin @('COMMIT_STARTED','PENDING_ENQUEUE','ENQUEUED')){return (& $conflict 'AFTER_NOT_OWNED')}
      $committed=$true
    } elseif($cur -ceq $beforeSha){
      if($st['basePhase'] -cin @('PENDING_ENQUEUE','ENQUEUED')){return (& $conflict 'CANONICAL_REVERTED')}
      # Canonical is still the exact before-state: recheck proof and the admitted outbox at the CAS boundary.
      & $recheckProof
      & $checkOutbox $s['packet'] $s['digest'] $s['keys']
      & $setStatus 'COMMIT_STARTED' 'COMMIT_STARTED' $null
      $tmp=$canonicalPath+'.tmp-'+[guid]::NewGuid().ToString('N')
      try{
        Invoke-CxFaultPoint 'BEFORE_CANONICAL_REPLACE'
        $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$fs.Write($newBytes,0,$newBytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
        if((Get-CxFileSha256 $tmp) -cne $afterSha){throw 'TEMP_READBACK_MISMATCH'}
        & $verifyPins
        & $recheckProof
        if((Get-CxFileSha256 $canonicalPath) -cne $beforeSha){throw 'CANONICAL_DRIFT'}
        [IO.File]::Move($tmp,$canonicalPath,$true)
      }catch{
        if($_.Exception.Message -clike 'SIMULATED_CRASH:*'){throw}
        $why=$_.Exception.Message
        return (& $res 'REFUSED' $(if($why -cmatch '^[A-Z][A-Z0-9_]{2,63}\z'){$why}else{'CANONICAL_COMMIT_FAILED'}) 'COMMIT_STARTED')
      }finally{ if([IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
      if((Get-CxFileSha256 $canonicalPath) -cne $afterSha){return (& $conflict 'CANONICAL_READBACK_MISMATCH')}
      $committed=$true
    } else {
      return (& $conflict 'CANONICAL_CONFLICT')
    }
    # Release before the enqueue: the accepted enqueue takes its own canonical + publisher leases.
    $canonicalLease.Dispose(); $canonicalLease=$null
    Invoke-CxFaultPoint 'AFTER_CANONICAL_COMMIT'
    if($st['basePhase'] -cne 'ENQUEUED'){& $setStatus 'PENDING_ENQUEUE' 'PENDING_ENQUEUE' $null}
    Invoke-CxFaultPoint 'BEFORE_ENQUEUE'
    # Reference or proof drift blocks the enqueue; the committed canonical is never rolled back.
    try{ & $verifyPins; & $recheckProof }catch{
      if($_.Exception.Message -clike 'SIMULATED_CRASH:*'){throw}
      $why=$_.Exception.Message
      $why=$(if($why -cmatch '^[A-Z][A-Z0-9_]{2,63}\z'){$why}else{'PROOF_DRIFT'})
      & $setStatus 'PENDING_ENQUEUE' 'PENDING_ENQUEUE' $why
      return (& $res 'PENDING_ENQUEUE' $why 'PENDING_ENQUEUE')
    }

    # Outbox pin: the approved before-pin while it still holds; otherwise derived solely for THIS
    # intent when the retained before rows are intact and ONLY this event's own exact PENDING rows
    # were added.
    $pin=$null
    try{
      if(-not [IO.File]::Exists($outboxPath)){throw 'OUTBOX_DRIFT'}
      if((Get-CxFileSha256 $outboxPath) -ceq $expectedOutbox){$pin=$expectedOutbox}
      else {
        $curBytes=[IO.File]::ReadAllBytes($outboxPath)
        if($curBytes.Length -gt 1048576){throw 'OUTBOX_DRIFT'}
        [void](Read-Outbox $outboxPath)
        $curRows=Get-CxRows $curBytes
        $beforeRows=Get-CxRows $s['outboxBytes']
        $n=$beforeRows.Count
        if($curRows.Count -lt $n -or $curRows.Count -gt $n+2){throw 'OUTBOX_DRIFT'}
        for($r=0;$r -lt $n;$r++){
          if((ConvertTo-Json -InputObject $curRows[$r] -Depth 10 -Compress) -cne (ConvertTo-Json -InputObject $beforeRows[$r] -Depth 10 -Compress)){throw 'OUTBOX_DRIFT'}
        }
        $missing=@{}
        foreach($dest in @('github','note')){
          $kk=$s['keys'][$dest]
          if(@($beforeRows | Where-Object {[string]$_.key -ceq $kk}).Count -eq 0){$missing[$kk]=$dest}
        }
        $seenKeys=@{}
        for($r=$n;$r -lt $curRows.Count;$r++){
          $row=$curRows[$r]
          $names=@($row.PSObject.Properties.Name)
          if($names.Count -ne 9){throw 'OUTBOX_DRIFT'}
          foreach($f in @('key','taskId','payloadSha256','runId','destination','status','attempt','deliveryStatus','proof')){if($names -cnotcontains $f){throw 'OUTBOX_DRIFT'}}
          $dest=$missing[[string]$row.key]
          if($null -eq $dest -or $seenKeys.ContainsKey([string]$row.key)){throw 'OUTBOX_DRIFT'}
          $seenKeys[[string]$row.key]=$true
          if([string]$row.taskId -cne $taskId -or [string]$row.payloadSha256 -cne $s['digest'] -or [string]$row.runId -cne ($s['packet']['idempotencyKey']+':complete:'+$dest) -or [string]$row.destination -cne $dest -or [string]$row.status -cne 'AWAITING_CONTROLLER' -or -not (Test-CxIntegral $row.attempt) -or [int64]$row.attempt -ne 0 -or [string]$row.deliveryStatus -cne 'PENDING' -or $null -ne $row.proof){throw 'OUTBOX_DRIFT'}
        }
        $pin=Get-CxSha256 $curBytes
      }
    }catch{
      if($_.Exception.Message -clike 'SIMULATED_CRASH:*'){throw}
      return (& $conflict 'OUTBOX_DRIFT')
    }

    # The accepted enqueue re-authenticates canonical/packet/proof/closure/outbox under its own leases
    # and appends only the two PENDING rows idempotently. It is never called while holding
    # canonical.lock. No consumer, delivery, remote call or CLOSE is invoked here.
    $ea=@{TaskId=$taskId;CanonicalRevision=$s['newRevision'];CandidateCommit=$candidate
          CanonicalPath=$canonicalPath;ExpectedCanonicalSha256=$afterSha;PacketPath=$packetPath;ExpectedPacketSha256=$packetRef.sha256
          CompletionProofPath=$proofPath;ExpectedCompletionProofSha256=$proofRef.sha256
          ConsumerPath=$consumerRef.path;ExpectedConsumerSha256=$consumerRef.sha256;ReconcilePath=$reconcileRef.path;ExpectedReconcileSha256=$reconcileRef.sha256
          ExpectedCaptureSha256=$captureRef.sha256;StateDir=$stateDir;OutboxPath=$outboxPath;ExpectedOutboxSha256=$pin}
    $er=Invoke-CanonicalLifecycleCompleteEnqueue @ea
    if($er.status -cnotin @('ENQUEUED','ALREADY_PRESENT')){
      if($er.status -ceq 'REFUSED' -and $er.code -cin @('IDENTITY_CONFLICT','EXCLUDED_NO_RETRY','OUTBOX_INVALID','OUTBOX_DRIFT','OUTBOX_SHAPE','OUTBOX_BINDING','OUTBOX_ROUNDTRIP_DRIFT','VALIDATION_FAILED')){
        return (& $conflict $er.code)
      }
      & $setStatus 'PENDING_ENQUEUE' 'PENDING_ENQUEUE' $er.code
      return (& $res 'PENDING_ENQUEUE' $er.code 'PENDING_ENQUEUE')
    }
    Invoke-CxFaultPoint 'AFTER_ENQUEUE'

    # Truthful final verification: canonical readback and exactly the two reader-compatible PENDING rows.
    if((Get-CxFileSha256 $canonicalPath) -cne $afterSha){return (& $conflict 'CANONICAL_CHANGED_AFTER_ENQUEUE')}
    $rows=@(Read-Outbox $outboxPath)
    foreach($dest in @('github','note')){
      $m=@($rows | Where-Object {[string]$_.key -ceq $s['keys'][$dest]})
      if($m.Count -ne 1){return (& $conflict 'ROWS_NOT_VERIFIED')}
      $row=$m[0]
      if([string]$row.taskId -cne $taskId -or [string]$row.payloadSha256 -cne $s['digest'] -or [string]$row.runId -cne ($s['packet']['idempotencyKey']+':complete:'+$dest) -or [string]$row.destination -cne $dest -or [string]$row.status -cne 'AWAITING_CONTROLLER' -or [int64]$row.attempt -ne 0){return (& $conflict 'ROWS_NOT_VERIFIED')}
      if($row.PSObject.Properties.Name -ccontains 'retryPolicy' -and [string]$row.retryPolicy -ceq 'NO_RETRY'){return (& $conflict 'EXCLUDED_NO_RETRY')}
      # A row this operation did not add may legitimately be further along; ours must stay unmarked
      # unless it was already present and untouched before the operation.
      # Get-CxRows returns one flat array (unary comma); filter its elements, not the array as one object.
      $beforeAll=Get-CxRows $s['outboxBytes']
      $before=@($beforeAll | Where-Object {[string]$_.key -ceq $s['keys'][$dest]})
      if($before.Count -eq 0 -and ([string]$row.deliveryStatus -cne 'PENDING' -or $null -ne $row.proof)){return (& $conflict 'ROWS_NOT_PENDING')}
    }
    & $setStatus 'ENQUEUED' 'ENQUEUED' $null
    return (& $res 'ENQUEUED' 'ENQUEUED_VERIFIED' 'ENQUEUED')
  }catch{
    $msg=$_.Exception.Message
    if($msg -clike 'SIMULATED_CRASH:*'){throw}
    $code=$(if($msg -cmatch '^[A-Z][A-Z0-9_]{2,63}\z'){$msg}else{'UNCLASSIFIED_ERROR'})
    $cs=$null; try{if($canonicalPath -and [IO.File]::Exists($canonicalPath)){$cs=Get-CxFileSha256 $canonicalPath}}catch{$cs=$null}
    $os=$null; try{if($outboxPath -and [IO.File]::Exists($outboxPath)){$os=Get-CxFileSha256 $outboxPath}}catch{$os=$null}
    # A failure after this operation's own canonical commit (even a failed recovery attempt) is
    # reported truthfully as pending; the committed canonical is never rolled back.
    $pending=$committed
    try{
      if(-not $pending -and $afterSha -and $cs -ceq $afterSha -and $intentPath -and [IO.File]::Exists($intentPath)){
        # Attribute the prior commit to THIS caller only when the retained intent carries this exact
        # operation/request/admission/after identity and the status record is bound to that intent.
        $sp=Join-Path $opDir 'status.json'
        if([IO.File]::Exists($sp)){
          $iBytes=[IO.File]::ReadAllBytes($intentPath)
          $ti=Read-CxJsonBytes $iBytes
          if($ti['schema'] -ceq 'CanonicalLifecycleCompleteCommitIntent/v1' -and $ti['operationId'] -ceq $opId -and
             $ti['requestSha256'] -ceq $ExpectedRequestSha256 -and $ti['admissionSha256'] -ceq $ExpectedAdmissionSha256 -and $ti['afterSha256'] -ceq $afterSha){
            $t=Read-CxStatus -Dir $opDir -OperationId $opId -IntentSha (Get-CxSha256 $iBytes)
            if($t['basePhase'] -cin @('COMMIT_STARTED','PENDING_ENQUEUE','ENQUEUED')){$pending=$true}
          }
        }
      }
    }catch{$pending=$false}
    if($pending){return (New-CxResult 'PENDING_ENQUEUE' $code $opId 'PENDING_ENQUEUE' $true $cs $keys $os)}
    return (New-CxResult 'REFUSED' $code $opId 'REFUSED' $false $cs $keys $os)
  }finally{
    if($canonicalLease){$canonicalLease.Dispose()}
    if($opLock){$opLock.Dispose()}
  }
}
