#Requires -Version 7.6
Set-StrictMode -Version Latest

# Explicit, separately host-admitted boundary: ONE caller-owned canonical CREATE contract file is
# created from pre-approved candidate bytes, then the accepted CREATE enqueue boundary projects the
# sidecar and appends the two PENDING rows. Every pin is an argument of the host invocation (request
# + an independently supplied admission); nothing in a file grants authority and this module issues
# none. It is not a two-file transaction: the gap between the canonical commit and the enqueue is a
# durable, resumable PENDING_ENQUEUE state of one deterministic operation intent. It never calls a
# consumer/transport, never delivers, closes, acknowledges, rolls back, deletes a canonical file,
# retries or loops, and never marks any outbox row DELIVERED. There is no test flag or hook here.
# Lease order: operation lock -> canonical.lock (RELEASED before the enqueue) -> the enqueue's own
# canonical.lock + publisher.lock. Leases are never nested with the enqueue's.

function Get-CcSha256 {
  param([byte[]]$Bytes)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-CcFileSha256 {
  param([string]$Path)
  Get-CcSha256 ([IO.File]::ReadAllBytes($Path))
}
function Test-CcHash {
  param($Value)
  return ($Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}\z')
}
function Test-CcIntegral {
  param($Value)
  return ($Value -is [int] -or $Value -is [long])
}
function Assert-CcPath {
  # Canonical absolute ordinary path, optionally inside Root, no reparse point on the path or any ancestor.
  param([string]$Path,[string]$Root='',[switch]$MustBeFile)
  if([string]::IsNullOrEmpty($Path) -or $Path.Contains([char]0)){throw 'PATH_INVALID'}
  if(-not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path){throw 'PATH_INVALID'}
  if($IsWindows){
    # Drive-letter paths only: no device/UNC namespace, no alternate data stream, no trailing dot/space segment.
    if($Path -cnotmatch '^[A-Za-z]:\\' -or $Path.IndexOf(':',2) -ge 0){throw 'PATH_INVALID'}
    foreach($seg in $Path.Substring(3).Split('\')){if($seg.Length -gt 0 -and ($seg.EndsWith(' ') -or $seg.EndsWith('.'))){throw 'PATH_INVALID'}}
  }
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
function Test-CcUnder {
  param([string]$Path,[string]$Root)
  return $Path.StartsWith(($Root.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)
}
function Open-CcLease {
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
function Read-CcJsonBytes {
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
function Assert-CcKeys {
  param($Object,[string[]]$Keys)
  if($Object -isnot [hashtable] -or $Object.Count -ne $Keys.Count){throw 'FIELDS_INVALID'}
  foreach($k in $Keys){if(-not $Object.ContainsKey($k) -or @($Object.Keys) -cnotcontains $k){throw 'FIELDS_INVALID'}}
}
function Get-CcRef {
  # Exact {path, sha256} reference; the digest is compared by the caller against the actual bytes.
  param($Ref)
  Assert-CcKeys $Ref @('path','sha256')
  if($Ref['path'] -isnot [string] -or -not (Test-CcHash $Ref['sha256'])){throw 'REQUEST_INVALID'}
  Assert-CcPath -Path $Ref['path'] -MustBeFile
  return @{path=$Ref['path'];sha256=$Ref['sha256']}
}
function New-CcResult {
  param([string]$Status,[string]$Code,[string]$OperationId='',[string]$Phase='',[bool]$Committed=$false,$CanonicalSha=$null,[string[]]$Keys=@(),$OutboxSha=$null)
  return [pscustomobject][ordered]@{status=$Status;code=$Code;operationId=$OperationId;phase=$Phase;canonicalCommitted=$Committed;canonicalSha256=$CanonicalSha;keys=@($Keys);outboxSha256=$OutboxSha}
}
function Write-CcAtomic {
  # Operation-owned status record only: temporary + replace.
  param([string]$Path,[byte[]]$Bytes)
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  $made=$false
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $made=$true
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    [IO.File]::Move($tmp,$Path,$true)
  }finally{ if($made -and [IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
}
function Write-CcCreateNew {
  # Create-if-absent for the operation intent: the move fails (IOException) when the target exists.
  param([string]$Path,[byte[]]$Bytes)
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  $made=$false
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $made=$true
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    [IO.File]::Move($tmp,$Path)
  }finally{ if($made -and [IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
}
function Write-CcCanonicalNoReplace {
  # Candidate bytes reach the canonical path only by a no-replace move of a fully owned temporary.
  # Only the exact temporary created here is ever removed; an existing canonical is never touched.
  param([string]$Path,[byte[]]$Bytes,[string]$Sha256)
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  $made=$false
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $made=$true
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    if((Get-CcFileSha256 $tmp) -cne $Sha256){throw 'TEMP_READBACK_MISMATCH'}
    [IO.File]::Move($tmp,$Path)
  }finally{ if($made -and [IO.File]::Exists($tmp)){try{[IO.File]::Delete($tmp)}catch{}} }
}
function Assert-CcOpDirEntries {
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
function Read-CcStatus {
  param([string]$Dir,[string]$OperationId,[string]$IntentSha)
  $p=Join-Path $Dir 'status.json'
  if(-not [IO.File]::Exists($p)){return @{phase='INTENT_PERSISTED';basePhase='INTENT_PERSISTED';cause=$null}}
  try{
    $s=Read-CcJsonBytes ([IO.File]::ReadAllBytes($p))
    Assert-CcKeys $s @('schema','operationId','intentSha256','phase','basePhase','cause')
    $phases=@('INTENT_PERSISTED','COMMIT_STARTED','PENDING_ENQUEUE','ENQUEUED')
    if($s['schema'] -cne 'CanonicalCreateCommitStatus/v1' -or $s['operationId'] -cne $OperationId -or $s['intentSha256'] -cne $IntentSha){throw 'x'}
    if($s['basePhase'] -isnot [string] -or $s['basePhase'] -cnotin $phases){throw 'x'}
    if($s['phase'] -isnot [string] -or $s['phase'] -cnotin ($phases+@('CONFLICT'))){throw 'x'}
    if($s['phase'] -cne 'CONFLICT' -and $s['phase'] -cne $s['basePhase']){throw 'x'}
    if($null -ne $s['cause'] -and ($s['cause'] -isnot [string] -or $s['cause'] -cnotmatch '^[A-Z][A-Z0-9_]{2,63}\z')){throw 'x'}
    return @{phase=$s['phase'];basePhase=$s['basePhase'];cause=$s['cause']}
  }catch{ throw 'STATUS_INVALID' }
}
function Set-CcStatus {
  # Truthful phase record of this operation. It is recovery evidence, never authority.
  param([string]$Dir,[string]$OperationId,[string]$IntentSha,[string]$Phase,[string]$BasePhase,$Cause)
  if($null -ne $Cause -and ($Cause -isnot [string] -or $Cause -cnotmatch '^[A-Z][A-Z0-9_]{2,63}\z')){$Cause='UNCLASSIFIED_ERROR'}
  $rec=[ordered]@{schema='CanonicalCreateCommitStatus/v1';operationId=$OperationId;intentSha256=$IntentSha;phase=$Phase;basePhase=$BasePhase;cause=$Cause}
  Write-CcAtomic (Join-Path $Dir 'status.json') ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $rec -Depth 4 -Compress)))
}
function Get-CcRows {
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
function Test-CcRowRef {
  param($Ref,[string]$Path,$Sha)
  if($Ref -isnot [System.Management.Automation.PSCustomObject]){return $false}
  $n=@($Ref.PSObject.Properties.Name)
  if($n.Count -ne 2 -or $n -cnotcontains 'path' -or $n -cnotcontains 'sha256'){return $false}
  if($Ref.path -isnot [string] -or $Ref.path -cne $Path -or -not (Test-CcHash $Ref.sha256)){return $false}
  return ($null -eq $Sha -or $Ref.sha256 -ceq $Sha)
}
function Test-CcOwnRow {
  # Exactly this operation's supported CREATE row: nine reader fields + the four CREATE metadata keys, PENDING.
  # $X.eventSha $null means only that the sidecar digest is a well-formed hash.
  param($Row,[hashtable]$X)
  if($Row -isnot [System.Management.Automation.PSCustomObject]){return $false}
  $names=@($Row.PSObject.Properties.Name)
  $want=@('key','taskId','payloadSha256','runId','destination','status','attempt','deliveryStatus','proof','eventType','canonicalRef','packetRef','createEventRef')
  if($names.Count -ne $want.Count){return $false}
  foreach($n in $want){if($names -cnotcontains $n){return $false}}
  foreach($pair in @(@('key',$X.key),@('taskId',$X.taskId),@('payloadSha256',$X.digest),@('runId',$X.runId),@('destination',$X.dest),@('status','AWAITING_CONTROLLER'),@('deliveryStatus','PENDING'),@('eventType','CREATE'))){
    $v=$Row.($pair[0])
    if($v -isnot [string] -or $v -cne $pair[1]){return $false}
  }
  if(-not (Test-CcIntegral $Row.attempt) -or [long]$Row.attempt -ne 0 -or $null -ne $Row.proof){return $false}
  return ((Test-CcRowRef $Row.canonicalRef $X.canonicalPath $X.candSha) -and (Test-CcRowRef $Row.packetRef $X.packetPath $X.packetSha) -and (Test-CcRowRef $Row.createEventRef $X.eventPath $X.eventSha))
}

function Invoke-CanonicalLifecycleCreateCommit {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$RequestPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedRequestSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$AdmissionPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedAdmissionSha256
  )
  $ErrorActionPreference='Stop'
  $opLock=$null; $canonicalLease=$null; $opId=''; $keys=@(); $committed=$false; $canonicalPath=$null; $outboxPath=$null; $stage='PREFLIGHT'
  # Accepted historical executable closure, identical to the enqueue boundary's.
  $acceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'
  $acceptedCaptureSha256='31ba531df2b9c8caa00d80d5a5eb3034922a79da45c1fe217daeb7e3fb72a698'
  try{
    foreach($h in @($ExpectedRequestSha256,$ExpectedAdmissionSha256)){if(-not (Test-CcHash $h)){throw 'PIN_INVALID'}}
    Assert-CcPath -Path $RequestPath -MustBeFile
    Assert-CcPath -Path $AdmissionPath -MustBeFile
    # Request and admission are frozen separately: request bytes/hash first, then the admission of that hash.
    $reqBytes=[IO.File]::ReadAllBytes($RequestPath)
    if((Get-CcSha256 $reqBytes) -cne $ExpectedRequestSha256){throw 'REQUEST_DRIFT'}
    $admBytes=[IO.File]::ReadAllBytes($AdmissionPath)
    if((Get-CcSha256 $admBytes) -cne $ExpectedAdmissionSha256){throw 'ADMISSION_DRIFT'}
    $req=Read-CcJsonBytes $reqBytes
    $adm=Read-CcJsonBytes $admBytes

    Assert-CcKeys $req @('schema','operationId','taskId','canonicalRevision','canonicalPath','candidateRef','packetRef','enqueueRef','consumerRef','reconcileRef','captureRef','stateDir','outboxPath','expectedOutboxSha256','operationDir')
    if($req['schema'] -isnot [string] -or $req['schema'] -cne 'CanonicalCreateCommitRequest/v1'){throw 'REQUEST_INVALID'}
    $opId=$req['operationId']
    if($opId -isnot [string] -or $opId -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z'){$opId='';throw 'OPERATION_ID_INVALID'}
    $taskId=$req['taskId']
    if($taskId -isnot [string] -or $taskId -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z'){throw 'REQUEST_INVALID'}
    $revision=$req['canonicalRevision']
    if(-not (Test-CcIntegral $revision) -or [long]$revision -lt 1){throw 'REVISION_INVALID'}
    foreach($k in @('canonicalPath','stateDir','outboxPath','operationDir')){if($req[$k] -isnot [string]){throw 'REQUEST_INVALID'}}
    $expectedOutbox=$req['expectedOutboxSha256']
    if($null -ne $expectedOutbox -and -not (Test-CcHash $expectedOutbox)){throw 'REQUEST_INVALID'}
    $canonicalPath=$req['canonicalPath']; $stateDir=$req['stateDir']; $outboxPath=$req['outboxPath']; $opDir=$req['operationDir']
    $candRef=Get-CcRef $req['candidateRef']; $packetRef=Get-CcRef $req['packetRef']; $enqueueRef=Get-CcRef $req['enqueueRef']
    $consumerRef=Get-CcRef $req['consumerRef']; $reconcileRef=Get-CcRef $req['reconcileRef']; $captureRef=Get-CcRef $req['captureRef']
    $candPath=$candRef.path; $candSha=$candRef.sha256; $packetPath=$packetRef.path; $packetSha=$packetRef.sha256

    # Owned, canonical, non-reparse, mutually disjoint paths.
    Assert-CcPath -Path $canonicalPath
    Assert-CcPath -Path $stateDir
    if(-not [IO.Directory]::Exists($stateDir)){throw 'STATE_DIR_MISSING'}
    $canonicalDir=[IO.Path]::GetDirectoryName($canonicalPath)
    if(-not $canonicalDir -or -not [IO.Directory]::Exists($canonicalDir)){throw 'CANONICAL_DIR_MISSING'}
    Assert-CcPath -Path $outboxPath -Root $stateDir
    if($outboxPath -cne (Join-Path $stateDir 'outbox.json')){throw 'OUTBOX_BINDING'}
    if($opDir -cne (Join-Path $stateDir ('create-commit-'+$opId))){throw 'OPERATION_BINDING'}
    Assert-CcPath -Path $opDir -Root $stateDir
    Assert-CcPath -Path ($outboxPath+'.lock') -Root $stateDir
    Assert-CcPath -Path (Join-Path $stateDir 'publisher.lock') -Root $stateDir
    Assert-CcPath -Path ($canonicalPath+'.lock')
    $intentPath=Join-Path $opDir 'intent.json'
    $capturePath=Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $reconcileRef.path)) 'dispatch') 'reviewed-blocked-capture.ps1'
    Assert-CcPath -Path $capturePath -MustBeFile
    if($captureRef.path -cne $capturePath){throw 'CAPTURE_BINDING'}
    $fixed=@($RequestPath,$AdmissionPath,$candPath,$packetPath,$enqueueRef.path,$consumerRef.path,$reconcileRef.path,$capturePath,$canonicalPath)
    $seenPaths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($f in $fixed){
      if(-not $seenPaths.Add($f) -or (Test-CcUnder $f $stateDir)){throw 'PATHS_NOT_DISJOINT'}
    }
    if(-not $seenPaths.Add($canonicalPath+'.lock')){throw 'PATHS_NOT_DISJOINT'}

    $pins=@(
      @{path=$RequestPath;sha=$ExpectedRequestSha256;code='REQUEST_DRIFT'},
      @{path=$AdmissionPath;sha=$ExpectedAdmissionSha256;code='ADMISSION_DRIFT'},
      @{path=$candPath;sha=$candSha;code='CANDIDATE_DRIFT'},
      @{path=$packetPath;sha=$packetSha;code='PACKET_DRIFT'},
      @{path=$enqueueRef.path;sha=$enqueueRef.sha256;code='ENQUEUE_DRIFT'},
      @{path=$consumerRef.path;sha=$consumerRef.sha256;code='CONSUMER_DRIFT'},
      @{path=$reconcileRef.path;sha=$reconcileRef.sha256;code='RECONCILE_DRIFT'},
      @{path=$capturePath;sha=$captureRef.sha256;code='CAPTURE_DRIFT'}
    )
    # Request, admission, candidate, packet and the executable closure are immutable under use.
    $verifyPins={
      foreach($pin in $pins){
        Assert-CcPath -Path $pin.path -MustBeFile
        if((Get-CcFileSha256 $pin.path) -cne $pin.sha){throw $pin.code}
      }
    }
    if($reconcileRef.sha256 -cne $acceptedReconcileSha256){throw 'RECONCILE_DRIFT'}
    if($captureRef.sha256 -cne $acceptedCaptureSha256){throw 'CAPTURE_DRIFT'}
    & $verifyPins

    # Independent host admission: named reviewer, exact bindings, exact decision. Never issued here.
    Assert-CcKeys $adm @('schema','decision','reviewer','requestSha256','operationId','taskId','canonicalRevision','candidateSha256','packetSha256','enqueueSha256','consumerSha256','reconcileSha256','captureSha256')
    if($adm['schema'] -isnot [string] -or $adm['schema'] -cne 'CanonicalCreateCommitAdmission/v1' -or $adm['decision'] -isnot [string] -or $adm['decision'] -cne 'ADMIT_SCOPED_CANONICAL_CREATE'){throw 'ADMISSION_INVALID'}
    if($adm['reviewer'] -isnot [string] -or $adm['reviewer'] -cnotmatch '^[A-Za-z0-9._:@-]{1,128}\z'){throw 'ADMISSION_INVALID'}
    foreach($k in @('requestSha256','candidateSha256','packetSha256','enqueueSha256','consumerSha256','reconcileSha256','captureSha256')){if(-not (Test-CcHash $adm[$k])){throw 'ADMISSION_INVALID'}}
    if(-not (Test-CcIntegral $adm['canonicalRevision'])){throw 'ADMISSION_INVALID'}
    if($adm['operationId'] -isnot [string] -or $adm['operationId'] -cne $opId -or $adm['taskId'] -isnot [string] -or $adm['taskId'] -cne $taskId -or
       [long]$adm['canonicalRevision'] -ne [long]$revision -or
       $adm['requestSha256'] -cne $ExpectedRequestSha256 -or $adm['candidateSha256'] -cne $candSha -or $adm['packetSha256'] -cne $packetSha -or
       $adm['enqueueSha256'] -cne $enqueueRef.sha256 -or $adm['consumerSha256'] -cne $consumerRef.sha256 -or
       $adm['reconcileSha256'] -cne $reconcileRef.sha256 -or $adm['captureSha256'] -cne $acceptedCaptureSha256){throw 'ADMISSION_BINDING'}

    # Only the pinned sources are loaded. The pinned capture helper is loaded first so a same-named
    # function from elsewhere cannot suppress the reconcile's own load; every function the closure
    # needs must then originate from a pinned file.
    . $capturePath
    . $consumerRef.path
    . $reconcileRef.path
    . $enqueueRef.path
    & $verifyPins
    $verifyOrigins={
      $cons=$consumerRef.path; $rec=$reconcileRef.path; $enq=$enqueueRef.path
      $spec=@(
        @{n='Get-LifecycleHash';o=@($cons)},@{n='Get-LifecycleFileHash';o=@($cons)},@{n='Read-LifecycleJson';o=@($cons)},
        @{n='Assert-LifecycleKeys';o=@($cons)},@{n='New-TaskLifecycleMirrorPacket';o=@($cons)},
        @{n='Test-OperationalReceiptV2';o=@($rec)},@{n='Get-ReviewedBlockedEvidenceCapture';o=@($capturePath)},
        @{n='Read-Outbox';o=@($cons,$rec,$capturePath)},@{n='Get-EventKey';o=@($cons,$rec,$capturePath)},@{n='Write-OutboxAtomic';o=@($cons,$rec,$capturePath)},
        @{n='Invoke-CanonicalLifecycleCreateEnqueue';o=@($enq)}
      )
      foreach($h in @('Get-CreateEnqSha256','Get-CreateEnqFileSha256','Test-CreateEnqHash','Assert-CreateEnqPath','Open-CreateEnqLease','New-CreateEnqResult','Test-CreateEnqJsonSame','Test-CreateEnqPrefix','Test-CreateEnqRef','Assert-CreateEnqOwnRow')){$spec+=@{n=$h;o=@($enq)}}
      foreach($x in $spec){
        # The effective command (an alias would outrank a function) must be a function from a pinned file.
        $cmd=@(Get-Command -Name $x.n -ErrorAction SilentlyContinue)
        if($cmd.Count -ne 1 -or $cmd[0].CommandType -ne [System.Management.Automation.CommandTypes]::Function){throw 'IMPORT_INCOMPLETE'}
        $file=$cmd[0].ScriptBlock.File
        if($file -isnot [string] -or $x.o -cnotcontains $file){throw 'IMPORT_ORIGIN'}
      }
    }
    & $verifyOrigins

    $six=@('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')
    $eventDirFor={ param([string]$id) Join-Path $stateDir ('canonical-create-'+$id) }
    # Initial-state outbox check, decided without an effect with the existing reader: the admitted bytes
    # must be reader-compatible, this event's own target rows must not exist, conflict or be NO_RETRY, and
    # the final serialization must stay within the reader cap. Returns the retained before evidence.
    $checkOutbox={
      param([string]$id,[string]$digest,$ekeys)
      $obBytes=$null; $rawRows=@()
      if($null -eq $expectedOutbox){
        if([IO.File]::Exists($outboxPath) -or [IO.Directory]::Exists($outboxPath)){throw 'OUTBOX_DRIFT'}
      } else {
        if(-not [IO.File]::Exists($outboxPath)){throw 'OUTBOX_DRIFT'}
        $obBytes=[IO.File]::ReadAllBytes($outboxPath)
        if($obBytes.Length -gt 1048576){throw 'OUTBOX_TOO_LARGE'}
        if((Get-CcSha256 $obBytes) -cne $expectedOutbox){throw 'OUTBOX_DRIFT'}
        $validated=$null
        try{
          $validated=@(Read-Outbox $outboxPath)
          $rawRows=Get-CcRows $obBytes
          if($rawRows.Count -ne $validated.Count){throw 'x'}
          for($r=0;$r -lt $rawRows.Count;$r++){if([string]$rawRows[$r].key -cne [string]$validated[$r].key){throw 'x'}}
        }catch{ throw 'OUTBOX_INVALID' }
        foreach($dest in @('github','note')){
          $runId=$id+':create:'+$dest; $key=$ekeys[$dest]
          $related=@($validated | Where-Object {[string]$_.runId -ceq $runId -or [string]$_.key -ceq $key})
          foreach($row in $related){
            if($row.PSObject.Properties.Name -ccontains 'retryPolicy' -and [string]$row.retryPolicy -ceq 'NO_RETRY'){throw 'EXCLUDED_NO_RETRY'}
          }
          if($related.Count -gt 0){throw 'EVENT_CONFLICT'}
        }
      }
      $eventDir=& $eventDirFor $id
      if([IO.File]::Exists($eventDir) -or [IO.Directory]::Exists((Join-Path $eventDir 'event.json'))){throw 'SIDECAR_CONFLICT'}
      $all=[Collections.Generic.List[object]]::new()
      foreach($x in $rawRows){$all.Add($x)}
      foreach($dest in @('github','note')){
        $all.Add([pscustomobject][ordered]@{
          key=$ekeys[$dest];taskId=$taskId;payloadSha256=$digest;runId=($id+':create:'+$dest);destination=$dest;status='AWAITING_CONTROLLER';attempt=0;deliveryStatus='PENDING';proof=$null
          eventType='CREATE'
          canonicalRef=[pscustomobject][ordered]@{path=$canonicalPath;sha256=$candSha}
          packetRef=[pscustomobject][ordered]@{path=$packetPath;sha256=$packetSha}
          createEventRef=[pscustomobject][ordered]@{path=(Join-Path $eventDir 'event.json');sha256=('0'*64)}
        })
      }
      if([Text.UTF8Encoding]::new($false).GetByteCount((ConvertTo-Json -InputObject @($all.ToArray()) -Depth 10)) -gt 1048576){throw 'OUTBOX_TOO_LARGE'}
      return @{exists=($null -ne $obBytes);bytes=$obBytes}
    }

    # Everything that can be decided without an effect. Run before any effect and again under the operation lock.
    $prepare={
      $s=@{}
      Assert-CcOpDirEntries $opDir
      if([IO.Directory]::Exists($intentPath) -or [IO.Directory]::Exists($outboxPath)){throw 'OPERATION_DIR_FOREIGN'}
      $s['replay']=[IO.File]::Exists($intentPath)
      & $verifyPins
      $candBytes=[IO.File]::ReadAllBytes($candPath)
      if((Get-CcSha256 $candBytes) -cne $candSha){throw 'CANDIDATE_DRIFT'}
      $packetBytes=[IO.File]::ReadAllBytes($packetPath)
      if((Get-CcSha256 $packetBytes) -cne $packetSha){throw 'PACKET_DRIFT'}
      $cand=$null
      try{$cand=Read-LifecycleJson $candPath}catch{ $m=$_.Exception.Message; if($m -cin @('DUPLICATE_FIELD','INPUT_TOO_LARGE')){throw $m}; throw 'CANDIDATE_INVALID' }
      Assert-LifecycleKeys $cand $six
      if($cand['taskId'] -isnot [string] -or $cand['taskId'] -cne $taskId){throw 'TASK_MISMATCH'}
      if(-not (Test-CcIntegral $cand['canonicalRevision']) -or [long]$cand['canonicalRevision'] -lt 1){throw 'REVISION_INVALID'}
      if([long]$cand['canonicalRevision'] -ne [long]$revision){throw 'IDENTITY_MISMATCH'}
      $p=$null
      try{$p=New-TaskLifecycleMirrorPacket (Read-LifecycleJson $packetPath)}catch{ $m=$_.Exception.Message; if($m -cmatch '^[A-Z][A-Z0-9_]{2,63}\z'){throw $m}; throw 'PACKET_INVALID' }
      if($p['eventType'] -cne 'CREATE'){throw 'UNSUPPORTED_EVENT'}
      if($p['taskId'] -cne $taskId){throw 'TASK_MISMATCH'}
      foreach($k in @('publicTitle','publicSummary','publicStatus','nextAction')){if($cand[$k] -isnot [string] -or $p[$k] -isnot [string] -or $cand[$k] -cne $p[$k]){throw 'CANONICAL_PACKET_MISMATCH'}}
      if([long]$cand['canonicalRevision'] -ne [long]$p['canonicalRevision']){throw 'CANONICAL_PACKET_MISMATCH'}
      $id=$p['idempotencyKey']
      if($id -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?\z'){throw 'IDEMPOTENCY_KEY_UNSAFE'}
      # Digest and keys exactly as the enqueue boundary derives them from the strict-read canonical.
      $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($cand | ConvertTo-Json -Depth 8 -Compress)))
      $ek=[ordered]@{}
      foreach($dest in @('github','note')){$ek[$dest]=Get-EventKey -TaskId $p['taskId'] -PayloadSha256 $digest -RunId ($id+':create:'+$dest) -Status 'AWAITING_CONTROLLER' -Attempt 0}
      $obBytes=$null
      if($s['replay']){
        # Resume: the persisted intent supplies the exact before evidence; live bytes cannot.
        $iBytes=[IO.File]::ReadAllBytes($intentPath)
        $i=Read-CcJsonBytes $iBytes
        Assert-CcKeys $i @('schema','operationId','taskId','canonicalRevision','requestSha256','admissionSha256','canonicalPath','canonicalBefore','candidateSha256','packetSha256','enqueueSha256','consumerSha256','reconcileSha256','captureSha256','stateDir','outboxPath','expectedOutboxSha256','outboxBeforeBase64','digest','keys')
        if($null -ne $i['outboxBeforeBase64'] -and $i['outboxBeforeBase64'] -isnot [string]){throw 'INTENT_INVALID'}
        if($null -ne $i['outboxBeforeBase64']){
          try{$obBytes=[Convert]::FromBase64String($i['outboxBeforeBase64'])}catch{throw 'INTENT_INVALID'}
        }
        if($null -eq $expectedOutbox){ if($null -ne $obBytes){throw 'INTENT_MISMATCH'} }
        elseif($null -eq $obBytes -or (Get-CcSha256 $obBytes) -cne $expectedOutbox){throw 'INTENT_MISMATCH'}
        $s['intentFileSha']=Get-CcSha256 $iBytes
      } else {
        # Initial operation: the canonical must be absent (an identical unrelated file is not ownership).
        if([IO.File]::Exists($canonicalPath) -or [IO.Directory]::Exists($canonicalPath)){throw 'CANONICAL_EXISTS'}
        $ob=& $checkOutbox $id $digest $ek
        $obBytes=$ob.bytes
      }
      $obText=$null; if($null -ne $obBytes){$obText=[Convert]::ToBase64String($obBytes)}
      $intent=[ordered]@{
        schema='CanonicalCreateCommitIntent/v1';operationId=$opId;taskId=$taskId;canonicalRevision=[long]$revision;requestSha256=$ExpectedRequestSha256;admissionSha256=$ExpectedAdmissionSha256
        canonicalPath=$canonicalPath;canonicalBefore='ABSENT';candidateSha256=$candSha;packetSha256=$packetSha;enqueueSha256=$enqueueRef.sha256
        consumerSha256=$consumerRef.sha256;reconcileSha256=$reconcileRef.sha256;captureSha256=$acceptedCaptureSha256;stateDir=$stateDir;outboxPath=$outboxPath
        expectedOutboxSha256=$expectedOutbox;outboxBeforeBase64=$obText;digest=$digest;keys=$ek
      }
      $intentBytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $intent -Depth 6 -Compress))
      # The persisted intent is re-read through Read-CcJsonBytes (1048576-byte cap): refuse an
      # unrepresentable aggregate here, before any directory, intent, canonical or outbox effect.
      if($intentBytes.Length -gt 1048576){throw 'INTENT_TOO_LARGE'}
      $s['intentSha']=Get-CcSha256 $intentBytes
      if($s['replay'] -and $s['intentFileSha'] -cne $s['intentSha']){throw 'INTENT_MISMATCH'}
      $s['intentBytes']=$intentBytes; $s['candBytes']=$candBytes; $s['packet']=$p; $s['id']=$id; $s['digest']=$digest; $s['keys']=$ek
      $s['outboxBytes']=$obBytes
      return $s
    }

    $res={
      param([string]$Status,[string]$Code,[string]$Phase)
      $cs=$null; try{if([IO.File]::Exists($canonicalPath)){$cs=Get-CcFileSha256 $canonicalPath}}catch{$cs=$null}
      $os=$null; try{if([IO.File]::Exists($outboxPath)){$os=Get-CcFileSha256 $outboxPath}}catch{$os=$null}
      return (New-CcResult $Status $Code $opId $Phase $committed $cs $keys $os)
    }
    $setStatus={ param([string]$Phase,[string]$Base,$Cause) Set-CcStatus -Dir $opDir -OperationId $opId -IntentSha $s['intentSha'] -Phase $Phase -BasePhase $Base -Cause $Cause }
    $conflict={ param([string]$Code) & $setStatus 'CONFLICT' $st.basePhase $Code; return (& $res 'CONFLICT' $Code 'CONFLICT') }

    # Pre-effect validation, then the owned directory, operation lock and ONE deterministic intent.
    $s=& $prepare
    $keys=@($s['keys']['github'],$s['keys']['note'])
    [void][IO.Directory]::CreateDirectory($opDir)
    Assert-CcPath -Path $opDir -Root $stateDir
    Assert-CcOpDirEntries $opDir
    $opLock=Open-CcLease (Join-Path $opDir 'operation.lock')
    if($null -eq $opLock){return (& $res 'REFUSED' 'OPERATION_LOCKED' 'PREFLIGHT')}
    $s=& $prepare
    if(-not $s['replay']){Write-CcCreateNew $intentPath $s['intentBytes']}
    $st=Read-CcStatus -Dir $opDir -OperationId $opId -IntentSha $s['intentSha']
    $candBytes=$s['candBytes']; $pktId=$s['id']

    # Canonical stage under canonical.lock: absence check, no-replace create, readback.
    $canonicalLease=Open-CcLease ($canonicalPath+'.lock')
    if($null -eq $canonicalLease){return (& $res 'REFUSED' 'CANONICAL_LOCKED' $st.phase)}
    & $verifyPins
    Assert-CcPath -Path $canonicalPath
    if([IO.Directory]::Exists($canonicalPath)){return (& $conflict 'CANONICAL_CONFLICT')}
    if([IO.File]::Exists($canonicalPath)){
      if((Get-CcFileSha256 $canonicalPath) -cne $candSha){return (& $conflict 'CANONICAL_CONFLICT')}
      # The exact candidate is adoptable only when this operation had started the commit.
      if($st.basePhase -cnotin @('COMMIT_STARTED','PENDING_ENQUEUE','ENQUEUED')){return (& $conflict 'AFTER_NOT_OWNED')}
      $committed=$true
    } else {
      if($st.basePhase -cin @('PENDING_ENQUEUE','ENQUEUED')){return (& $conflict 'CANONICAL_REVERTED')}
      # Still absent: recheck the admitted outbox at the CAS boundary, before the first canonical effect.
      [void](& $checkOutbox $pktId $s['digest'] $s['keys'])
      & $setStatus 'COMMIT_STARTED' 'COMMIT_STARTED' $null
      try{
        & $verifyPins
        Write-CcCanonicalNoReplace -Path $canonicalPath -Bytes $candBytes -Sha256 $candSha
      }catch{
        return (& $res 'REFUSED' 'CANONICAL_COMMIT_FAILED' 'COMMIT_STARTED')
      }
      if((Get-CcFileSha256 $canonicalPath) -cne $candSha){return (& $conflict 'CANONICAL_READBACK_MISMATCH')}
      $committed=$true
    }
    $stage='POSTCOMMIT'
    # Release before the enqueue: the accepted enqueue takes its own canonical + publisher leases.
    $canonicalLease.Dispose(); $canonicalLease=$null
    if($st.basePhase -cin @('INTENT_PERSISTED','COMMIT_STARTED')){& $setStatus 'PENDING_ENQUEUE' 'PENDING_ENQUEUE' $null}
    & $verifyPins

    # Outbox pin: the original before-pin while it still holds; otherwise derived solely when the
    # retained before rows are intact and ONLY this operation's two exact PENDING rows were added.
    $eventDir=& $eventDirFor $pktId
    $eventPath=Join-Path $eventDir 'event.json'
    $rowCtx={
      param([string]$dest,$eventSha)
      @{key=$s['keys'][$dest];taskId=$taskId;digest=$s['digest'];runId=($pktId+':create:'+$dest);dest=$dest;canonicalPath=$canonicalPath;candSha=$candSha;packetPath=$packetPath;packetSha=$packetSha;eventPath=$eventPath;eventSha=$eventSha}
    }
    $pin=$null
    try{
      $exists=[IO.File]::Exists($outboxPath)
      if($null -eq $expectedOutbox -and -not $exists){$pin=$null}
      elseif($null -ne $expectedOutbox -and $exists -and (Get-CcFileSha256 $outboxPath) -ceq $expectedOutbox){$pin=$expectedOutbox}
      else {
        if(-not $exists){throw 'OUTBOX_DRIFT'}
        $curBytes=[IO.File]::ReadAllBytes($outboxPath)
        if($curBytes.Length -gt 1048576){throw 'OUTBOX_DRIFT'}
        [void](Read-Outbox $outboxPath)
        $curRows=Get-CcRows $curBytes
        $beforeRows=@(); if($null -ne $s['outboxBytes']){$beforeRows=Get-CcRows $s['outboxBytes']}
        $n=$beforeRows.Count
        if($curRows.Count -ne $n+2){throw 'OUTBOX_DRIFT'}
        for($r=0;$r -lt $n;$r++){
          if((ConvertTo-Json -InputObject $curRows[$r] -Depth 10 -Compress) -cne (ConvertTo-Json -InputObject $beforeRows[$r] -Depth 10 -Compress)){throw 'OUTBOX_DRIFT'}
        }
        $byKey=@{}; foreach($dest in @('github','note')){$byKey[[string]$s['keys'][$dest]]=$dest}
        $seenKeys=@{}
        for($r=$n;$r -lt $curRows.Count;$r++){
          $row=$curRows[$r]
          if($row -isnot [System.Management.Automation.PSCustomObject] -or $row.PSObject.Properties.Name -cnotcontains 'key'){throw 'OUTBOX_DRIFT'}
          $dest=$byKey[[string]$row.key]
          if($null -eq $dest -or $seenKeys.ContainsKey([string]$row.key)){throw 'OUTBOX_DRIFT'}
          $seenKeys[[string]$row.key]=$true
          if(-not (Test-CcOwnRow $row (& $rowCtx $dest $null))){throw 'OUTBOX_DRIFT'}
        }
        $pin=Get-CcSha256 $curBytes
      }
    }catch{
      return (& $conflict 'OUTBOX_DRIFT')
    }

    # The accepted enqueue verifies canonical/packet/closure/outbox under its own leases and appends
    # only the two PENDING rows idempotently. No consumer, transport, delivery or CLOSE is invoked.
    $ea=@{TaskId=$taskId;CanonicalRevision=[long]$revision;CanonicalPath=$canonicalPath;ExpectedCanonicalSha256=$candSha;PacketPath=$packetPath;ExpectedPacketSha256=$packetSha
          ConsumerPath=$consumerRef.path;ExpectedConsumerSha256=$consumerRef.sha256;ReconcilePath=$reconcileRef.path;ExpectedReconcileSha256=$reconcileRef.sha256
          ExpectedCaptureSha256=$acceptedCaptureSha256;StateDir=$stateDir;OutboxPath=$outboxPath;ExpectedOutboxSha256=$pin}
    $er=Invoke-CanonicalLifecycleCreateEnqueue @ea
    if($er.status -cnotin @('ENQUEUED','UNCHANGED')){
      if($er.code -cin @('CANONICAL_LOCKED','PUBLISHER_LOCKED','OUTBOX_WRITE_FAILED','WRITE_NOT_VERIFIED','UNCLASSIFIED_ERROR')){
        & $setStatus 'PENDING_ENQUEUE' 'PENDING_ENQUEUE' $er.code
        return (& $res 'PENDING_ENQUEUE' $er.code 'PENDING_ENQUEUE')
      }
      return (& $conflict $er.code)
    }

    # Truthful final verification: canonical readback, the immutable seven-field sidecar, and exactly
    # this operation's two reader-compatible PENDING rows referencing it.
    if((Get-CcFileSha256 $canonicalPath) -cne $candSha){return (& $conflict 'CANONICAL_CHANGED_AFTER_ENQUEUE')}
    if((@($er.keys) -join '|') -cne ($keys -join '|')){return (& $conflict 'ENQUEUE_KEYS_MISMATCH')}
    $eventSha=$null
    try{
      Assert-CcPath -Path $eventPath -Root $stateDir -MustBeFile
      $eventBytes=[IO.File]::ReadAllBytes($eventPath)
      $ev=Read-CcJsonBytes $eventBytes
      Assert-CcKeys $ev @('schema','taskId','canonicalVersion','publicTitle','publicSummary','publicStatus','nextAction')
      $cand2=Read-LifecycleJson $candPath
      if($ev['schema'] -cne 'GitHubCreateEvent/v1' -or $ev['taskId'] -cne $taskId -or -not (Test-CcIntegral $ev['canonicalVersion']) -or [long]$ev['canonicalVersion'] -ne [long]$revision){throw 'x'}
      foreach($k in @('publicTitle','publicSummary','publicStatus','nextAction')){if($ev[$k] -isnot [string] -or $ev[$k] -cne $cand2[$k]){throw 'x'}}
      $eventSha=Get-CcSha256 $eventBytes
    }catch{ return (& $conflict 'SIDECAR_NOT_VERIFIED') }
    $rows=@(Read-Outbox $outboxPath)
    $raw=Get-CcRows ([IO.File]::ReadAllBytes($outboxPath))
    if($raw.Count -ne $rows.Count){return (& $conflict 'ROWS_NOT_VERIFIED')}
    foreach($dest in @('github','note')){
      $m=@($raw | Where-Object {[string]$_.key -ceq $s['keys'][$dest]})
      if($m.Count -ne 1){return (& $conflict 'ROWS_NOT_VERIFIED')}
      $row=$m[0]
      if($row.PSObject.Properties.Name -ccontains 'retryPolicy' -and [string]$row.retryPolicy -ceq 'NO_RETRY'){return (& $conflict 'EXCLUDED_NO_RETRY')}
      if(-not (Test-CcOwnRow $row (& $rowCtx $dest $eventSha))){return (& $conflict 'ROWS_NOT_VERIFIED')}
    }
    if($st.phase -cne 'ENQUEUED'){& $setStatus 'ENQUEUED' 'ENQUEUED' $null}
    return (& $res 'ENQUEUED' 'ENQUEUED_VERIFIED' 'ENQUEUED')
  }catch{
    $msg=$_.Exception.Message
    $classified=($msg -cmatch '^[A-Z][A-Z0-9_]{2,63}\z')
    $code=$(if($classified){$msg}else{'UNCLASSIFIED_ERROR'})
    $cs=$null; try{if($canonicalPath -and [IO.File]::Exists($canonicalPath)){$cs=Get-CcFileSha256 $canonicalPath}}catch{$cs=$null}
    $os=$null; try{if($outboxPath -and [IO.File]::Exists($outboxPath)){$os=Get-CcFileSha256 $outboxPath}}catch{$os=$null}
    # After this operation's own canonical commit an interruption is a truthful PENDING_ENQUEUE of the
    # same authenticated operation (resume with the SAME intent); never a rollback or a refusal of bytes.
    if($committed -and $stage -ceq 'POSTCOMMIT'){
      return (New-CcResult 'PENDING_ENQUEUE' $code $opId 'PENDING_ENQUEUE' $true $cs $keys $os)
    }
    return (New-CcResult 'REFUSED' $code $opId 'REFUSED' $committed $cs $keys $os)
  }finally{
    if($canonicalLease){$canonicalLease.Dispose()}
    if($opLock){$opLock.Dispose()}
  }
}
