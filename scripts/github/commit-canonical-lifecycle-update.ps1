#Requires -Version 7.6
Set-StrictMode -Version Latest

# Explicit, separately host-admitted boundary: ONE caller-owned canonical UPDATE contract file is
# replaced by pre-approved bytes, then the accepted enqueue boundary appends the two PENDING rows.
# Every pin is an argument of the host invocation (request + independent admission); nothing in a
# file grants authority and this module issues none. It is not a two-file transaction: the gap
# between the canonical commit and the enqueue is a durable, resumable PENDING_ENQUEUE state of one
# deterministic operation intent. It never calls the consumer/transport, never delivers, closes,
# acknowledges, rolls back, retries or loops, and never marks any outbox row DELIVERED.
# Lease order: operation lock -> canonical.lock (RELEASED before the enqueue) -> the enqueue's own
# canonical.lock + publisher.lock. Leases are never nested with the enqueue's.

function Get-CmSha256 {
  param([byte[]]$Bytes)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-CmFileSha256 {
  param([string]$Path)
  Get-CmSha256 ([IO.File]::ReadAllBytes($Path))
}
function Test-CmHash {
  param($Value)
  return ($Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}\z')
}
function Test-CmIntegral {
  param($Value)
  return ($Value -is [int] -or $Value -is [long])
}
function Assert-CmPath {
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
function Open-CmLease {
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
function Read-CmJsonBytes {
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
function Assert-CmKeys {
  param($Object,[string[]]$Keys)
  if($Object -isnot [hashtable] -or $Object.Count -ne $Keys.Count){throw 'FIELDS_INVALID'}
  foreach($k in $Keys){if(-not $Object.ContainsKey($k) -or @($Object.Keys) -cnotcontains $k){throw 'FIELDS_INVALID'}}
}
function Get-CmRef {
  # Exact {path, sha256} reference; the digest is compared by the caller against the actual bytes.
  param($Ref)
  Assert-CmKeys $Ref @('path','sha256')
  if($Ref['path'] -isnot [string] -or -not (Test-CmHash $Ref['sha256'])){throw 'REQUEST_INVALID'}
  Assert-CmPath -Path $Ref['path'] -MustBeFile
  return @{path=$Ref['path'];sha256=$Ref['sha256']}
}
function New-CmResult {
  param([string]$Status,[string]$Code,[string]$OperationId='',[string]$Phase='',[bool]$Committed=$false,$CanonicalSha=$null,[string[]]$Keys=@(),$OutboxSha=$null)
  return [pscustomobject][ordered]@{status=$Status;code=$Code;operationId=$OperationId;phase=$Phase;canonicalCommitted=$Committed;canonicalSha256=$CanonicalSha;keys=@($Keys);outboxSha256=$OutboxSha}
}
function Invoke-CmFaultPoint {
  # Narrow test seam. Production no-op; a test shadows it with an alias to inject a failure or a
  # simulated crash ('SIMULATED_CRASH:<point>'). It grants no authority and skips no check.
  param([string]$Point)
}
function Write-CmAtomic {
  param([string]$Path,[byte[]]$Bytes)
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    [IO.File]::Move($tmp,$Path,$true)
  }finally{ if([IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
}
function Write-CmCreateNew {
  # Create-if-absent: the move fails (IOException) when the target already exists.
  param([string]$Path,[byte[]]$Bytes)
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    [IO.File]::Move($tmp,$Path)
  }finally{ if([IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
}
function Assert-CmOpDirEntries {
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
function Read-CmStatus {
  param([string]$Dir,[string]$OperationId,[string]$IntentSha)
  $p=Join-Path $Dir 'status.json'
  if(-not [IO.File]::Exists($p)){return @{phase='INTENT_PERSISTED';basePhase='INTENT_PERSISTED';cause=$null}}
  try{
    $s=Read-CmJsonBytes ([IO.File]::ReadAllBytes($p))
    Assert-CmKeys $s @('schema','operationId','intentSha256','phase','basePhase','cause')
    $phases=@('INTENT_PERSISTED','COMMIT_STARTED','PENDING_ENQUEUE','ENQUEUED')
    if($s['schema'] -cne 'CanonicalLifecycleUpdateCommitStatus/v1' -or $s['operationId'] -cne $OperationId -or $s['intentSha256'] -cne $IntentSha){throw 'x'}
    if($s['basePhase'] -isnot [string] -or $s['basePhase'] -cnotin $phases){throw 'x'}
    if($s['phase'] -isnot [string] -or $s['phase'] -cnotin ($phases+@('CONFLICT'))){throw 'x'}
    if($s['phase'] -cne 'CONFLICT' -and $s['phase'] -cne $s['basePhase']){throw 'x'}
    if($null -ne $s['cause'] -and ($s['cause'] -isnot [string] -or $s['cause'] -cnotmatch '^[A-Z][A-Z0-9_]{2,63}\z')){throw 'x'}
    return @{phase=$s['phase'];basePhase=$s['basePhase'];cause=$s['cause']}
  }catch{ throw 'STATUS_INVALID' }
}
function Set-CmStatus {
  # Truthful phase record of this operation. It is recovery evidence, never authority.
  param([string]$Dir,[string]$OperationId,[string]$IntentSha,[string]$Phase,[string]$BasePhase,$Cause)
  if($null -ne $Cause -and ($Cause -isnot [string] -or $Cause -cnotmatch '^[A-Z][A-Z0-9_]{2,63}\z')){$Cause='UNCLASSIFIED_ERROR'}
  $rec=[ordered]@{schema='CanonicalLifecycleUpdateCommitStatus/v1';operationId=$OperationId;intentSha256=$IntentSha;phase=$Phase;basePhase=$BasePhase;cause=$Cause}
  Write-CmAtomic (Join-Path $Dir 'status.json') ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $rec -Depth 4 -Compress)))
}
function Get-CmRows {
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

function Invoke-CanonicalLifecycleUpdateCommit {
  [CmdletBinding()]
  param(
    [string]$RequestPath,[string]$ExpectedRequestSha256,
    [string]$AdmissionPath,[string]$ExpectedAdmissionSha256
  )
  $ErrorActionPreference='Stop'
  $opLock=$null; $canonicalLease=$null; $opId=''; $keys=@(); $committed=$false; $canonicalPath=$null
  # Accepted historical executable closure, identical to the enqueue boundary's.
  $acceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'
  $acceptedCaptureSha256='31ba531df2b9c8caa00d80d5a5eb3034922a79da45c1fe217daeb7e3fb72a698'
  try{
    foreach($h in @($ExpectedRequestSha256,$ExpectedAdmissionSha256)){if(-not (Test-CmHash $h)){throw 'PIN_INVALID'}}
    Assert-CmPath -Path $RequestPath -MustBeFile
    Assert-CmPath -Path $AdmissionPath -MustBeFile
    $reqBytes=[IO.File]::ReadAllBytes($RequestPath)
    if((Get-CmSha256 $reqBytes) -cne $ExpectedRequestSha256){throw 'REQUEST_DRIFT'}
    $admBytes=[IO.File]::ReadAllBytes($AdmissionPath)
    if((Get-CmSha256 $admBytes) -cne $ExpectedAdmissionSha256){throw 'ADMISSION_DRIFT'}
    $req=Read-CmJsonBytes $reqBytes
    $adm=Read-CmJsonBytes $admBytes

    # Request: exact schema, ordinal keys, strict types.
    Assert-CmKeys $req @('schema','operationId','taskId','canonicalPath','expectedBeforeSha256','newCanonicalRef','packetRef','enqueueRef','consumerRef','reconcileRef','stateDir','outboxPath','expectedOutboxSha256','operationDirectory')
    if($req['schema'] -isnot [string] -or $req['schema'] -cne 'CanonicalLifecycleUpdateCommitRequest/v1'){throw 'REQUEST_INVALID'}
    $opId=$req['operationId']
    if($opId -isnot [string] -or $opId -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z'){$opId='';throw 'OPERATION_ID_INVALID'}
    $taskId=$req['taskId']
    if($taskId -isnot [string] -or $taskId -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z'){throw 'REQUEST_INVALID'}
    foreach($k in @('canonicalPath','stateDir','outboxPath','operationDirectory')){if($req[$k] -isnot [string]){throw 'REQUEST_INVALID'}}
    $beforeSha=$req['expectedBeforeSha256']
    if(-not (Test-CmHash $beforeSha)){throw 'REQUEST_INVALID'}
    $expectedOutbox=$req['expectedOutboxSha256']
    if($null -ne $expectedOutbox -and -not (Test-CmHash $expectedOutbox)){throw 'REQUEST_INVALID'}
    $canonicalPath=$req['canonicalPath']; $stateDir=$req['stateDir']; $outboxPath=$req['outboxPath']; $opDir=$req['operationDirectory']
    $newRef=Get-CmRef $req['newCanonicalRef']; $packetRef=Get-CmRef $req['packetRef']; $enqueueRef=Get-CmRef $req['enqueueRef']
    $consumerRef=Get-CmRef $req['consumerRef']; $reconcileRef=Get-CmRef $req['reconcileRef']
    $newPath=$newRef.path; $afterSha=$newRef.sha256; $packetPath=$packetRef.path

    # Owned, canonical, non-reparse paths.
    Assert-CmPath -Path $canonicalPath -MustBeFile
    if($newPath -ceq $canonicalPath){throw 'REQUEST_INVALID'}
    Assert-CmPath -Path $stateDir
    if(-not [IO.Directory]::Exists($stateDir)){throw 'STATE_DIR_MISSING'}
    Assert-CmPath -Path $outboxPath -Root $stateDir
    if($outboxPath -cne (Join-Path $stateDir 'outbox.json')){throw 'OUTBOX_BINDING'}
    if($opDir -cne (Join-Path $stateDir ('canonical-update-'+$opId))){throw 'OPERATION_BINDING'}
    Assert-CmPath -Path $opDir -Root $stateDir
    Assert-CmPath -Path ($outboxPath+'.lock') -Root $stateDir
    Assert-CmPath -Path (Join-Path $stateDir 'publisher.lock') -Root $stateDir
    Assert-CmPath -Path ($canonicalPath+'.lock')
    $intentPath=Join-Path $opDir 'intent.json'
    $capturePath=Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $reconcileRef.path)) 'dispatch') 'reviewed-blocked-capture.ps1'
    Assert-CmPath -Path $capturePath -MustBeFile

    $pins=@(
      @{path=$RequestPath;sha=$ExpectedRequestSha256;code='REQUEST_DRIFT'},
      @{path=$AdmissionPath;sha=$ExpectedAdmissionSha256;code='ADMISSION_DRIFT'},
      @{path=$newPath;sha=$afterSha;code='NEW_CANONICAL_DRIFT'},
      @{path=$packetPath;sha=$packetRef.sha256;code='PACKET_DRIFT'},
      @{path=$enqueueRef.path;sha=$enqueueRef.sha256;code='ENQUEUE_DRIFT'},
      @{path=$consumerRef.path;sha=$consumerRef.sha256;code='CONSUMER_DRIFT'},
      @{path=$reconcileRef.path;sha=$reconcileRef.sha256;code='RECONCILE_DRIFT'},
      @{path=$capturePath;sha=$acceptedCaptureSha256;code='CAPTURE_DRIFT'}
    )
    # Request, admission, new bytes, packet and the executable closure are immutable under use.
    $verifyPins={
      foreach($pin in $pins){
        Assert-CmPath -Path $pin.path -MustBeFile
        if((Get-CmFileSha256 $pin.path) -cne $pin.sha){throw $pin.code}
      }
    }
    if($reconcileRef.sha256 -cne $acceptedReconcileSha256){throw 'RECONCILE_DRIFT'}
    & $verifyPins

    # Independent host admission: named reviewer, exact bindings, exact decision. Never issued here.
    Assert-CmKeys $adm @('schema','decision','reviewer','requestSha256','operationId','taskId','beforeSha256','afterSha256','packetSha256','enqueueSha256','consumerSha256','reconcileSha256','captureSha256')
    if($adm['schema'] -isnot [string] -or $adm['schema'] -cne 'CanonicalLifecycleUpdateCommitAdmission/v1' -or $adm['decision'] -isnot [string] -or $adm['decision'] -cne 'ADMIT_CANONICAL_UPDATE_COMMIT'){throw 'ADMISSION_INVALID'}
    if($adm['reviewer'] -isnot [string] -or $adm['reviewer'] -cnotmatch '^[A-Za-z0-9._:@-]{1,128}\z'){throw 'ADMISSION_INVALID'}
    foreach($k in @('requestSha256','beforeSha256','afterSha256','packetSha256','enqueueSha256','consumerSha256','reconcileSha256','captureSha256')){if(-not (Test-CmHash $adm[$k])){throw 'ADMISSION_INVALID'}}
    if($adm['operationId'] -isnot [string] -or $adm['operationId'] -cne $opId -or $adm['taskId'] -isnot [string] -or $adm['taskId'] -cne $taskId -or
       $adm['requestSha256'] -cne $ExpectedRequestSha256 -or $adm['beforeSha256'] -cne $beforeSha -or $adm['afterSha256'] -cne $afterSha -or
       $adm['packetSha256'] -cne $packetRef.sha256 -or $adm['enqueueSha256'] -cne $enqueueRef.sha256 -or $adm['consumerSha256'] -cne $consumerRef.sha256 -or
       $adm['reconcileSha256'] -cne $reconcileRef.sha256 -or $adm['captureSha256'] -cne $acceptedCaptureSha256){throw 'ADMISSION_BINDING'}

    # Only the pinned sources are loaded: strict readers/packet constructor, outbox reader, enqueue.
    $loadConsumer=$consumerRef.path; $loadReconcile=$reconcileRef.path; $loadEnqueue=$enqueueRef.path
    . $loadConsumer
    . $loadReconcile
    . $loadEnqueue
    & $verifyPins

    # Everything below the pin checks that can be decided without an effect. Run before any effect
    # and again under the operation lock. Returns the validated operation state.
    $six=@('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')
    # Initial-state outbox check, decided without an effect with the existing reader and the exact event
    # semantics of the enqueue boundary: the admitted bytes must be reader-compatible and this event's own
    # target rows must neither conflict nor be NO_RETRY. Run before any effect and again at the CAS
    # boundary; postcommit external drift is handled separately (PENDING_ENQUEUE / CONFLICT, no rollback).
    $checkOutbox={
      param($pk,[string]$digest,$ekeys)
      if($null -eq $expectedOutbox){
        if([IO.File]::Exists($outboxPath) -or [IO.Directory]::Exists($outboxPath)){throw 'OUTBOX_DRIFT'}
        return
      }
      if(-not [IO.File]::Exists($outboxPath)){throw 'OUTBOX_DRIFT'}
      $bytes=[IO.File]::ReadAllBytes($outboxPath)
      if($bytes.Length -gt 1048576){throw 'OUTBOX_TOO_LARGE'}
      if((Get-CmSha256 $bytes) -cne $expectedOutbox){throw 'OUTBOX_DRIFT'}
      $validated=$null
      try{
        $validated=@(Read-Outbox $outboxPath)
        $raw=Get-CmRows $bytes
        if($raw.Count -ne $validated.Count){throw 'x'}
        for($r=0;$r -lt $raw.Count;$r++){if([string]$raw[$r].key -cne [string]$validated[$r].key){throw 'x'}}
      }catch{ throw 'OUTBOX_INVALID' }
      if((Get-CmFileSha256 $outboxPath) -cne $expectedOutbox){throw 'OUTBOX_DRIFT'}
      foreach($dest in @('github','note')){
        $runId=$pk['idempotencyKey']+':'+$dest; $key=$ekeys[$dest]
        $related=@($validated | Where-Object {[string]$_.runId -ceq $runId -or [string]$_.key -ceq $key})
        if($related.Count -gt 1){throw 'EVENT_CONFLICT'}
        if($related.Count -eq 1){
          $row=$related[0]
          if([string]$row.key -cne $key -or [string]$row.taskId -cne $pk['taskId'] -or [string]$row.payloadSha256 -cne $digest -or [string]$row.runId -cne $runId -or [string]$row.destination -cne $dest -or [string]$row.status -cne 'AWAITING_CONTROLLER' -or [int64]$row.attempt -ne 0){throw 'EVENT_CONFLICT'}
          if($row.PSObject.Properties.Name -ccontains 'retryPolicy' -and [string]$row.retryPolicy -ceq 'NO_RETRY'){throw 'EXCLUDED_NO_RETRY'}
        }
      }
    }
    $prepare={
      $s=@{}
      Assert-CmOpDirEntries $opDir
      if([IO.Directory]::Exists($intentPath) -or [IO.Directory]::Exists($outboxPath)){throw 'OPERATION_DIR_FOREIGN'}
      $s['replay']=[IO.File]::Exists($intentPath)
      $newBytes=[IO.File]::ReadAllBytes($newPath)
      if((Get-CmSha256 $newBytes) -cne $afterSha){throw 'NEW_CANONICAL_DRIFT'}
      $packetBytes=[IO.File]::ReadAllBytes($packetPath)
      if((Get-CmSha256 $packetBytes) -cne $packetRef.sha256){throw 'PACKET_DRIFT'}
      $curBytes=[IO.File]::ReadAllBytes($canonicalPath)
      $outExists=[IO.File]::Exists($outboxPath)
      $oldBytes=$null; $obBytes=$null; $obExists=$false
      if($s['replay']){
        # Resume: the persisted intent supplies the exact before evidence; live bytes cannot.
        $iBytes=[IO.File]::ReadAllBytes($intentPath)
        $i=Read-CmJsonBytes $iBytes
        Assert-CmKeys $i @('schema','operationId','taskId','requestSha256','admissionSha256','canonicalPath','beforeSha256','afterSha256','packetSha256','enqueueSha256','consumerSha256','reconcileSha256','captureSha256','stateDir','outboxPath','expectedOutboxSha256','beforeCanonicalBase64','afterCanonicalBase64','outboxBeforeBase64','digest','keys')
        if($i['beforeCanonicalBase64'] -isnot [string] -or ($null -ne $i['outboxBeforeBase64'] -and $i['outboxBeforeBase64'] -isnot [string])){throw 'INTENT_INVALID'}
        try{
          $oldBytes=[Convert]::FromBase64String($i['beforeCanonicalBase64'])
          if($null -ne $i['outboxBeforeBase64']){$obBytes=[Convert]::FromBase64String($i['outboxBeforeBase64']); $obExists=$true}
        }catch{throw 'INTENT_INVALID'}
        if((Get-CmSha256 $oldBytes) -cne $beforeSha){throw 'INTENT_MISMATCH'}
        if($null -eq $expectedOutbox){ if($obExists){throw 'INTENT_MISMATCH'} }
        elseif(-not $obExists -or (Get-CmSha256 $obBytes) -cne $expectedOutbox){throw 'INTENT_MISMATCH'}
        $s['intentFileSha']=Get-CmSha256 $iBytes
      } else {
        # Initial operation requires the exact before-state.
        if((Get-CmSha256 $curBytes) -cne $beforeSha){throw 'CANONICAL_DRIFT'}
        $oldBytes=$curBytes
        if($null -eq $expectedOutbox){ if($outExists){throw 'OUTBOX_DRIFT'} }
        else {
          if(-not $outExists){throw 'OUTBOX_DRIFT'}
          $obBytes=[IO.File]::ReadAllBytes($outboxPath)
          if($obBytes.Length -gt 1048576){throw 'OUTBOX_TOO_LARGE'}
          if((Get-CmSha256 $obBytes) -cne $expectedOutbox){throw 'OUTBOX_DRIFT'}
          $obExists=$true
        }
      }
      $old=Read-CmJsonBytes $oldBytes
      $new=Read-CmJsonBytes $newBytes
      $p=New-TaskLifecycleMirrorPacket (Read-CmJsonBytes $packetBytes)
      if($p['eventType'] -cne 'UPDATE'){throw 'UNSUPPORTED_EVENT'}
      foreach($o in @($old,$new)){
        Assert-CmKeys $o $six
        if($o['taskId'] -isnot [string] -or $o['taskId'] -cne $taskId){throw 'TASK_MISMATCH'}
        if(-not (Test-CmIntegral $o['canonicalRevision'])){throw 'REVISION_INVALID'}
        $probe=$p.Clone()
        foreach($k in $six){$probe[$k]=$o[$k]}
        try{[void](New-TaskLifecycleMirrorPacket $probe)}catch{throw 'CANONICAL_CONTENT_INVALID'}
      }
      if($p['taskId'] -cne $taskId){throw 'TASK_MISMATCH'}
      if([long]$new['canonicalRevision'] -le [long]$old['canonicalRevision']){throw 'REVISION_NOT_INCREASING'}
      foreach($k in @('taskId','publicTitle','publicSummary','publicStatus','nextAction')){if($new[$k] -isnot [string] -or $p[$k] -isnot [string] -or $new[$k] -cne $p[$k]){throw 'CANONICAL_PACKET_MISMATCH'}}
      if([long]$new['canonicalRevision'] -ne [long]$p['canonicalRevision']){throw 'CANONICAL_PACKET_MISMATCH'}
      # Digest and keys exactly as the enqueue boundary derives them.
      $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($new | ConvertTo-Json -Depth 8 -Compress)))
      $ek=[ordered]@{}
      foreach($dest in @('github','note')){$ek[$dest]=Get-EventKey -TaskId $p['taskId'] -PayloadSha256 $digest -RunId ($p['idempotencyKey']+':'+$dest) -Status 'AWAITING_CONTROLLER' -Attempt 0}
      if(-not $s['replay']){& $checkOutbox $p $digest $ek}
      $obText=$null; if($obExists){$obText=[Convert]::ToBase64String($obBytes)}
      $intent=[ordered]@{
        schema='CanonicalLifecycleUpdateCommitIntent/v1';operationId=$opId;taskId=$taskId;requestSha256=$ExpectedRequestSha256;admissionSha256=$ExpectedAdmissionSha256
        canonicalPath=$canonicalPath;beforeSha256=$beforeSha;afterSha256=$afterSha;packetSha256=$packetRef.sha256;enqueueSha256=$enqueueRef.sha256
        consumerSha256=$consumerRef.sha256;reconcileSha256=$reconcileRef.sha256;captureSha256=$acceptedCaptureSha256;stateDir=$stateDir;outboxPath=$outboxPath
        expectedOutboxSha256=$expectedOutbox;beforeCanonicalBase64=[Convert]::ToBase64String($oldBytes);afterCanonicalBase64=[Convert]::ToBase64String($newBytes)
        outboxBeforeBase64=$obText;digest=$digest;keys=$ek
      }
      $intentBytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $intent -Depth 6 -Compress))
      # The persisted intent is re-read through Read-CmJsonBytes (1048576-byte cap): refuse an
      # unrepresentable aggregate here, before any directory, intent, canonical or outbox effect.
      if($intentBytes.Length -gt 1048576){throw 'INTENT_TOO_LARGE'}
      $s['intentSha']=Get-CmSha256 $intentBytes
      if($s['replay'] -and $s['intentFileSha'] -cne $s['intentSha']){throw 'INTENT_MISMATCH'}
      $s['intentBytes']=$intentBytes; $s['newBytes']=$newBytes; $s['packet']=$p; $s['digest']=$digest; $s['keys']=$ek
      $s['outboxExists']=$obExists; $s['outboxBytes']=$obBytes
      return $s
    }

    $res={
      param([string]$Status,[string]$Code,[string]$Phase)
      $cs=$null; try{$cs=Get-CmFileSha256 $canonicalPath}catch{$cs=$null}
      $os=$null; try{if([IO.File]::Exists($outboxPath)){$os=Get-CmFileSha256 $outboxPath}}catch{$os=$null}
      return (New-CmResult $Status $Code $opId $Phase $committed $cs $keys $os)
    }
    $setStatus={ param([string]$Phase,[string]$Base,$Cause) Set-CmStatus -Dir $opDir -OperationId $opId -IntentSha $s['intentSha'] -Phase $Phase -BasePhase $Base -Cause $Cause }
    $conflict={ param([string]$Code) & $setStatus 'CONFLICT' $st.basePhase $Code; return (& $res 'CONFLICT' $Code 'CONFLICT') }

    # Pre-effect validation, then the owned directory, operation lock and ONE deterministic intent.
    $s=& $prepare
    $keys=@($s['keys']['github'],$s['keys']['note'])
    [void][IO.Directory]::CreateDirectory($opDir)
    Assert-CmPath -Path $opDir -Root $stateDir
    Assert-CmOpDirEntries $opDir
    $opLock=Open-CmLease (Join-Path $opDir 'operation.lock')
    if($null -eq $opLock){return (& $res 'REFUSED' 'OPERATION_LOCKED' 'PREFLIGHT')}
    $s=& $prepare
    if(-not $s['replay']){Write-CmCreateNew $intentPath $s['intentBytes']}
    Invoke-CmFaultPoint 'AFTER_INTENT'
    $st=Read-CmStatus -Dir $opDir -OperationId $opId -IntentSha $s['intentSha']
    $newBytes=$s['newBytes']

    # Canonical stage under canonical.lock: CAS on the exact before-state, never an in-place truncate.
    $canonicalLease=Open-CmLease ($canonicalPath+'.lock')
    if($null -eq $canonicalLease){return (& $res 'REFUSED' 'CANONICAL_LOCKED' $st.phase)}
    & $verifyPins
    $cur=Get-CmFileSha256 $canonicalPath
    if($cur -ceq $afterSha){
      # Exact-after is adoptable only when this operation had started the commit.
      if($st.basePhase -cnotin @('COMMIT_STARTED','PENDING_ENQUEUE','ENQUEUED')){return (& $conflict 'AFTER_NOT_OWNED')}
      $committed=$true
    } elseif($cur -ceq $beforeSha){
      if($st.basePhase -cin @('PENDING_ENQUEUE','ENQUEUED')){return (& $conflict 'CANONICAL_REVERTED')}
      # Canonical is still the exact before-state: recheck the admitted outbox at the CAS boundary.
      & $checkOutbox $s['packet'] $s['digest'] $s['keys']
      & $setStatus 'COMMIT_STARTED' 'COMMIT_STARTED' $null
      $tmp=$canonicalPath+'.tmp-'+[guid]::NewGuid().ToString('N')
      try{
        Invoke-CmFaultPoint 'BEFORE_CANONICAL_REPLACE'
        $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$fs.Write($newBytes,0,$newBytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
        if((Get-CmFileSha256 $tmp) -cne $afterSha){throw 'TEMP_READBACK_MISMATCH'}
        & $verifyPins
        if((Get-CmFileSha256 $canonicalPath) -cne $beforeSha){throw 'CANONICAL_DRIFT'}
        [IO.File]::Move($tmp,$canonicalPath,$true)
      }catch{
        if($_.Exception.Message -clike 'SIMULATED_CRASH:*'){throw}
        return (& $res 'REFUSED' 'CANONICAL_COMMIT_FAILED' 'COMMIT_STARTED')
      }finally{ if([IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
      if((Get-CmFileSha256 $canonicalPath) -cne $afterSha){return (& $conflict 'CANONICAL_READBACK_MISMATCH')}
      $committed=$true
    } else {
      return (& $conflict 'CANONICAL_CONFLICT')
    }
    # Release before the enqueue: the accepted enqueue takes its own canonical + publisher leases.
    $canonicalLease.Dispose(); $canonicalLease=$null
    Invoke-CmFaultPoint 'AFTER_CANONICAL_COMMIT'
    & $setStatus 'PENDING_ENQUEUE' 'PENDING_ENQUEUE' $null
    Invoke-CmFaultPoint 'BEFORE_ENQUEUE'
    & $verifyPins

    # Outbox pin: the original before-pin while it still holds; otherwise derived solely when the
    # retained before rows are intact and ONLY this event's own exact PENDING rows were added.
    $pin=$null
    try{
      $exists=[IO.File]::Exists($outboxPath)
      if($null -eq $expectedOutbox -and -not $exists){$pin=$null}
      elseif($null -ne $expectedOutbox -and $exists -and (Get-CmFileSha256 $outboxPath) -ceq $expectedOutbox){$pin=$expectedOutbox}
      else {
        if(-not $exists){throw 'OUTBOX_DRIFT'}
        $curBytes=[IO.File]::ReadAllBytes($outboxPath)
        if($curBytes.Length -gt 1048576){throw 'OUTBOX_DRIFT'}
        [void](Read-Outbox $outboxPath)
        $curRows=Get-CmRows $curBytes
        $beforeRows=@(); if($s['outboxExists']){$beforeRows=Get-CmRows $s['outboxBytes']}
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
          if([string]$row.taskId -cne $taskId -or [string]$row.payloadSha256 -cne $s['digest'] -or [string]$row.runId -cne ($s['packet']['idempotencyKey']+':'+$dest) -or [string]$row.destination -cne $dest -or [string]$row.status -cne 'AWAITING_CONTROLLER' -or [int64]$row.attempt -ne 0 -or [string]$row.deliveryStatus -cne 'PENDING' -or $null -ne $row.proof){throw 'OUTBOX_DRIFT'}
        }
        $pin=Get-CmSha256 $curBytes
      }
    }catch{
      if($_.Exception.Message -clike 'SIMULATED_CRASH:*'){throw}
      return (& $conflict 'OUTBOX_DRIFT')
    }

    # The accepted enqueue verifies canonical/packet/closure/outbox under its own leases and appends
    # only the two PENDING rows idempotently. No consumer, transport, delivery or CLOSE is invoked.
    $ea=@{CanonicalPath=$canonicalPath;ExpectedCanonicalSha256=$afterSha;PacketPath=$packetPath;ExpectedPacketSha256=$packetRef.sha256
          ConsumerPath=$consumerRef.path;ExpectedConsumerSha256=$consumerRef.sha256;ReconcilePath=$reconcileRef.path;ExpectedReconcileSha256=$reconcileRef.sha256
          StateDir=$stateDir;OutboxPath=$outboxPath;ExpectedOutboxSha256=$pin}
    $er=Invoke-CanonicalLifecycleUpdateEnqueue @ea
    if($er.status -cnotin @('ENQUEUED','UNCHANGED')){
      if($er.code -cin @('CANONICAL_LOCKED','PUBLISHER_LOCKED','OUTBOX_WRITE_FAILED','WRITE_NOT_VERIFIED')){
        & $setStatus 'PENDING_ENQUEUE' 'PENDING_ENQUEUE' $er.code
        return (& $res 'PENDING_ENQUEUE' $er.code 'PENDING_ENQUEUE')
      }
      return (& $conflict $er.code)
    }
    Invoke-CmFaultPoint 'AFTER_ENQUEUE'

    # Truthful final verification: canonical readback and exactly the two reader-compatible PENDING rows.
    if((Get-CmFileSha256 $canonicalPath) -cne $afterSha){return (& $conflict 'CANONICAL_CHANGED_AFTER_ENQUEUE')}
    if((@($er.keys) -join '|') -cne ($keys -join '|')){return (& $conflict 'ENQUEUE_KEYS_MISMATCH')}
    $rows=@(Read-Outbox $outboxPath)
    foreach($dest in @('github','note')){
      $m=@($rows | Where-Object {[string]$_.key -ceq $s['keys'][$dest]})
      if($m.Count -ne 1){return (& $conflict 'ROWS_NOT_VERIFIED')}
      $row=$m[0]
      if([string]$row.taskId -cne $taskId -or [string]$row.payloadSha256 -cne $s['digest'] -or [string]$row.runId -cne ($s['packet']['idempotencyKey']+':'+$dest) -or [string]$row.destination -cne $dest -or [string]$row.status -cne 'AWAITING_CONTROLLER' -or [int64]$row.attempt -ne 0){return (& $conflict 'ROWS_NOT_VERIFIED')}
      if($row.PSObject.Properties.Name -ccontains 'retryPolicy' -and [string]$row.retryPolicy -ceq 'NO_RETRY'){return (& $conflict 'EXCLUDED_NO_RETRY')}
      if([string]$row.deliveryStatus -cne 'PENDING' -or $null -ne $row.proof){return (& $conflict 'ROWS_NOT_PENDING')}
    }
    & $setStatus 'ENQUEUED' 'ENQUEUED' $null
    return (& $res 'ENQUEUED' 'ENQUEUED_VERIFIED' 'ENQUEUED')
  }catch{
    $msg=$_.Exception.Message
    if($msg -clike 'SIMULATED_CRASH:*'){throw}
    $classified=($msg -cmatch '^[A-Z][A-Z0-9_]{2,63}\z')
    $cs=$null; try{if($canonicalPath){$cs=Get-CmFileSha256 $canonicalPath}}catch{$cs=$null}
    return (New-CmResult 'REFUSED' $(if($classified){$msg}else{'UNCLASSIFIED_ERROR'}) $opId 'REFUSED' $committed $cs $keys)
  }finally{
    if($canonicalLease){$canonicalLease.Dispose()}
    if($opLock){$opLock.Dispose()}
  }
}
