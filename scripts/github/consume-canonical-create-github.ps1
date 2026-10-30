#Requires -Version 7.6
Set-StrictMode -Version Latest
$script:CreateGhConsumerSource = $PSCommandPath

# Explicit, separately host-admitted CREATE destination consumer: GITHUB ONLY, SOURCE ONLY.
# It consumes ONE delivered GitHub CREATE row (plus its GitHubCreateEvent/v1 sidecar) produced by
# enqueue-canonical-lifecycle-create.ps1 by driving the existing durable CREATE engine
# (github-task-lifecycle.ps1) through the pinned gh transport, then independently reads the issue back.
#
# Nothing inside a packet, sidecar, row, review or native-request JSON grants authority. Every pin is an
# argument of the host invocation. The review and native documents are only validated for exact
# cross-binding to the release; their origin and the task/revision/destination authorization belong to the
# external independent reviewer. There is no approval boolean, scheduler, automatic retry, default
# repository/account/model probing, or transport selector. ProcessRunner is the existing injected seam.
#
# NOT done here, on purpose: no note write or note ACK (the note row is never modified and no note file is
# read), no canonical mutation, no remote UPDATE/CLOSE, no FactoryDONE, no paired delivery claim. The
# GitHub row is the only row that can change, and only to DELIVERED with a proof naming the durable
# readback artifact (path + SHA-256). That artifact, not a status string, is the source a later note
# consumer may use.
#
# Lock order: canonical lease, then publisher lease, then (inside the engine) the engine's own distinct
# github-task-lifecycle.lock, then (inside the shared writer) outbox.json.lock. All five paths are checked
# pairwise distinct before any effect, so no lease is acquired re-entrantly. Holding the cooperating
# canonical/publisher leases across the engine call is intended: the engine never acquires them.
#
# Durable artifacts (event directory of the sidecar, create-new only, never overwritten):
#   mapping.json  exact existing UPDATE-compatible 6 fields: taskId, repo, issueNumber, url, stableMarker,
#                 canonicalRevision.
#   readback.json CanonicalCreateGitHubReadback/v1, 16 fields: schema, taskId, canonicalRevision,
#                 packetSha256, createEventSha256, outboxKey, runId, payloadSha256, engineEventKey,
#                 mappingSha256, issueUrl, issueNumber, stableMarker, observedTitle,
#                 observedRegionSha256, observedBodySha256.
#   outbox proof  'canonical-create-readback:sha256=<readback sha>;path=<readback path>'.
#
# The sidecar, mapping, readback and outbox are separate files, not one transaction. A failure after the
# engine reported MAPPED returns PENDING_LOCAL_ACK (nothing rolled back, no second CREATE); an explicit
# new RECONCILE_MISSING admission bound to the then-current engine/outbox state completes it from the
# persisted proof or from the engine's safe FIND/READ adoption, never from a blind CREATE.

function Get-CreateGhSha256 {
  param([byte[]]$Bytes)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-CreateGhFileSha256 {
  param([string]$Path)
  Get-CreateGhSha256 ([IO.File]::ReadAllBytes($Path))
}
function Test-CreateGhHash {
  param($Value)
  return ($Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}\z')
}
function Test-CreateGhKeys {
  # Exact, case-sensitive key set of a strict-read hashtable.
  param($Object,[string[]]$Keys)
  if($Object -isnot [hashtable] -or $Object.Count -ne $Keys.Count){return $false}
  $have=@($Object.Keys)
  foreach($k in $Keys){if($have -cnotcontains $k){return $false}}
  return $true
}
function Test-CreateGhRef {
  # Exact two-key {path,sha256} reference in a strict-read document.
  param($Ref)
  if(-not (Test-CreateGhKeys $Ref @('path','sha256'))){return $false}
  return ($Ref['path'] -is [string] -and $Ref['path'].Length -gt 0 -and (Test-CreateGhHash $Ref['sha256']))
}
function Assert-CreateGhPath {
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
function Open-CreateGhLease {
  # Exclusive stream, or $null on contention. Missing directory, access and other errors propagate.
  param([string]$Path)
  try{
    return [IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  }catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{
    throw
  }catch [IO.IOException]{
    return $null
  }
}
function Read-CreateGhBoundedBytes {
  # Same 1 MiB ceiling the existing strict reader applies; also bounds every artifact written here.
  param([string]$Path)
  if([IO.FileInfo]::new($Path).Length -gt 1048576){throw 'INPUT_TOO_LARGE'}
  $b=[IO.File]::ReadAllBytes($Path)
  if($b.Length -gt 1048576){throw 'INPUT_TOO_LARGE'}
  return ,$b
}
function Assert-CreateGhNoDuplicateNames {
  param([Text.Json.JsonElement]$El)
  if($El.ValueKind -eq [Text.Json.JsonValueKind]::Object){
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($pr in $El.EnumerateObject()){
      if(-not $seen.Add($pr.Name)){throw 'DUPLICATE_FIELD'}
      Assert-CreateGhNoDuplicateNames $pr.Value
    }
  } elseif($El.ValueKind -eq [Text.Json.JsonValueKind]::Array){
    foreach($v in $El.EnumerateArray()){Assert-CreateGhNoDuplicateNames $v}
  }
}
function Read-CreateGhStrictJson {
  # Strict UTF-8, no duplicate names at any depth, dates stay strings. Parses exactly the given bytes.
  param([byte[]]$Bytes)
  if($Bytes.Length -gt 1048576){throw 'INPUT_TOO_LARGE'}
  $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)
  $doc=[Text.Json.JsonDocument]::Parse($text)
  try{Assert-CreateGhNoDuplicateNames $doc.RootElement}finally{$doc.Dispose()}
  return ($text | ConvertFrom-Json -AsHashtable -DateKind String)
}
function Read-CreateGhPinnedJson {
  # Reads once; the hash is checked on the same bytes that are parsed.
  param($Ref)
  Assert-CreateGhPath -Path $Ref['path'] -MustBeFile
  $bytes=Read-CreateGhBoundedBytes $Ref['path']
  if((Get-CreateGhSha256 $bytes) -cne $Ref['sha256']){throw 'PIN_DRIFT'}
  try{return (Read-CreateGhStrictJson $bytes)}catch{throw 'ADMISSION_INVALID'}
}
function New-CreateGhResult {
  param([string]$Status,[string]$Code,[bool]$Ack=$false,[System.Collections.IDictionary]$Extra=@{})
  $o=[ordered]@{status=$Status;code=$Code;githubAck=$Ack;noteAck=$false;automaticRetry=$false}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function Test-CreateGhJsonSame {
  # Structural, order-preserving equality of two JSON elements (numbers by raw text: fail closed).
  param([Text.Json.JsonElement]$A,[Text.Json.JsonElement]$B)
  $kind=$A.ValueKind.ToString()
  if($kind -cne $B.ValueKind.ToString()){return $false}
  if($kind -ceq 'Object'){
    $pa=@($A.EnumerateObject()); $pb=@($B.EnumerateObject())
    if($pa.Count -ne $pb.Count){return $false}
    for($i=0;$i -lt $pa.Count;$i++){
      if($pa[$i].Name -cne $pb[$i].Name -or -not (Test-CreateGhJsonSame $pa[$i].Value $pb[$i].Value)){return $false}
    }
    return $true
  }
  if($kind -ceq 'Array'){
    $ea=@($A.EnumerateArray()); $eb=@($B.EnumerateArray())
    if($ea.Count -ne $eb.Count){return $false}
    for($i=0;$i -lt $ea.Count;$i++){if(-not (Test-CreateGhJsonSame $ea[$i] $eb[$i])){return $false}}
    return $true
  }
  if($kind -ceq 'String'){return ($A.GetString() -ceq $B.GetString())}
  if($kind -ceq 'Number'){return ($A.GetRawText() -ceq $B.GetRawText())}
  return $true
}
function Test-CreateGhOutboxTransition {
  # After must equal Before except that row AckIndex went PENDING/proof null -> DELIVERED/Proof, with the
  # same property names in the same order. Every other row, field and value is structurally unchanged.
  param([string]$Before,[string]$After,[int]$AckIndex,[string]$Proof)
  $a=$null; $b=$null
  try{
    $a=[Text.Json.JsonDocument]::Parse($Before); $b=[Text.Json.JsonDocument]::Parse($After)
    if($a.RootElement.ValueKind -eq [Text.Json.JsonValueKind]::Array){$ea=@($a.RootElement.EnumerateArray())}else{$ea=@($a.RootElement)}
    if($b.RootElement.ValueKind -eq [Text.Json.JsonValueKind]::Array){$eb=@($b.RootElement.EnumerateArray())}else{$eb=@($b.RootElement)}
    if($ea.Count -ne $eb.Count -or $AckIndex -lt 0 -or $AckIndex -ge $ea.Count){return $false}
    for($i=0;$i -lt $ea.Count;$i++){
      if($i -ne $AckIndex){
        if(-not (Test-CreateGhJsonSame $ea[$i] $eb[$i])){return $false}
        continue
      }
      if($ea[$i].ValueKind -ne [Text.Json.JsonValueKind]::Object -or $eb[$i].ValueKind -ne [Text.Json.JsonValueKind]::Object){return $false}
      $oa=@($ea[$i].EnumerateObject()); $ob=@($eb[$i].EnumerateObject())
      if($oa.Count -ne $ob.Count){return $false}
      for($j=0;$j -lt $oa.Count;$j++){
        if($oa[$j].Name -cne $ob[$j].Name){return $false}
        $va=$oa[$j].Value; $vb=$ob[$j].Value
        if($oa[$j].Name -ceq 'deliveryStatus'){
          if($va.ValueKind -ne [Text.Json.JsonValueKind]::String -or $va.GetString() -cne 'PENDING' -or $vb.ValueKind -ne [Text.Json.JsonValueKind]::String -or $vb.GetString() -cne 'DELIVERED'){return $false}
        } elseif($oa[$j].Name -ceq 'proof'){
          if($va.ValueKind -ne [Text.Json.JsonValueKind]::Null -or $vb.ValueKind -ne [Text.Json.JsonValueKind]::String -or $vb.GetString() -cne $Proof){return $false}
        } elseif(-not (Test-CreateGhJsonSame $va $vb)){return $false}
      }
    }
    return $true
  }catch{
    return $false
  }finally{
    if($a){$a.Dispose()}
    if($b){$b.Dispose()}
  }
}
function Test-CreateGhRowRef {
  param($Ref,[string]$Path,[string]$Sha)
  if($Ref -isnot [System.Management.Automation.PSCustomObject]){return $false}
  $n=@($Ref.PSObject.Properties.Name)
  if($n.Count -ne 2 -or $n -cnotcontains 'path' -or $n -cnotcontains 'sha256'){return $false}
  return ($Ref.path -is [string] -and $Ref.path -ceq $Path -and $Ref.sha256 -is [string] -and $Ref.sha256 -ceq $Sha)
}
function Assert-CreateGhOwnRow {
  # A row in this event's CREATE namespace must be exactly the enqueue shape: nine reader fields plus the
  # four CREATE metadata keys, bound to the admitted refs. NO_RETRY is an exclusion, never a success.
  param($Row,[hashtable]$X,[hashtable]$Refs)
  $names=@($Row.PSObject.Properties.Name)
  if($names -ccontains 'retryPolicy' -and [string]$Row.retryPolicy -ceq 'NO_RETRY'){throw 'EXCLUDED_NO_RETRY'}
  $want=@('key','taskId','payloadSha256','runId','destination','status','attempt','deliveryStatus','proof','eventType','canonicalRef','packetRef','createEventRef')
  if($names.Count -ne $want.Count){throw 'EVENT_CONFLICT'}
  foreach($n in $want){if($names -cnotcontains $n){throw 'EVENT_CONFLICT'}}
  foreach($pair in @(@('key',$X.key),@('taskId',$X.taskId),@('payloadSha256',$X.digest),@('runId',$X.runId),@('destination',$X.dest),@('status','AWAITING_CONTROLLER'),@('eventType','CREATE'))){
    $v=$Row.($pair[0])
    if($v -isnot [string] -or $v -cne $pair[1]){throw 'EVENT_CONFLICT'}
  }
  if(-not ($Row.attempt -is [int] -or $Row.attempt -is [long]) -or [long]$Row.attempt -ne 0){throw 'EVENT_CONFLICT'}
  if($Row.deliveryStatus -isnot [string] -or $Row.deliveryStatus -cnotin @('PENDING','DELIVERED')){throw 'EVENT_CONFLICT'}
  if($Row.deliveryStatus -ceq 'PENDING' -and $null -ne $Row.proof){throw 'EVENT_CONFLICT'}
  if(-not (Test-CreateGhRowRef $Row.canonicalRef $Refs.canonical.path $Refs.canonical.sha256) -or
     -not (Test-CreateGhRowRef $Row.packetRef $Refs.packet.path $Refs.packet.sha256) -or
     -not (Test-CreateGhRowRef $Row.createEventRef $Refs.event.path $Refs.event.sha256)){throw 'EVENT_CONFLICT'}
}
function ConvertTo-CreateGhJsonBytes {
  param($Ordered)
  [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Ordered -Compress -Depth 4))
}
function New-CreateGhMapping {
  # Exact existing UPDATE-compatible mapping (same six fields the UPDATE/COMPLETE consumers read).
  param([string]$TaskId,[long]$Number,[string]$Marker,[long]$Revision,[string]$Repo)
  return [ordered]@{taskId=$TaskId;repo=$Repo;issueNumber=$Number;url=('https://github.com/'+$Repo+'/issues/'+$Number);stableMarker=$Marker;canonicalRevision=$Revision}
}
function New-CreateGhReceipt {
  param([hashtable]$F)
  $order=@('schema','taskId','canonicalRevision','packetSha256','createEventSha256','outboxKey','runId','payloadSha256','engineEventKey','mappingSha256','issueUrl','issueNumber','stableMarker','observedTitle','observedRegionSha256','observedBodySha256')
  $o=[ordered]@{}
  foreach($k in $order){$o[$k]=$F[$k]}
  return $o
}
function Write-CreateGhNewFile {
  # Create-new only. 'CREATED', or 'IDENTICAL' when exactly these bytes already exist; a different
  # existing file or directory is never replaced. The temp file is named here, so only it is deleted.
  param([string]$Path,[byte[]]$Bytes)
  $sha=Get-CreateGhSha256 $Bytes
  if([IO.Directory]::Exists($Path)){throw 'OUTPUT_CONFLICT'}
  if([IO.File]::Exists($Path)){
    if([IO.FileInfo]::new($Path).Length -ne $Bytes.Length -or (Get-CreateGhFileSha256 $Path) -cne $sha){throw 'OUTPUT_CONFLICT'}
    return 'IDENTICAL'
  }
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  $made=$false; $state='CREATED'
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $made=$true
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    try{
      [IO.File]::Move($tmp,$Path,$false)
    }catch [IO.IOException]{
      if(-not [IO.File]::Exists($Path) -or (Get-CreateGhFileSha256 $Path) -cne $sha){throw 'OUTPUT_CONFLICT'}
      $state='IDENTICAL'
    }
  }finally{
    if($made -and [IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)}
  }
  if((Get-CreateGhFileSha256 $Path) -cne $sha){throw 'OUTPUT_READBACK_FAILED'}
  return $state
}

function Invoke-AdmittedCanonicalCreateGitHub {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$ReleasePath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedReleaseSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedReviewSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedNativeRequestSha256,
    # Existing connector seam of the pinned transport. Production omits it and uses bounded gh execution.
    [scriptblock]$ProcessRunner
  )
  $ErrorActionPreference='Stop'
  $canonicalLease=$null; $publisherLease=$null
  # PREFLIGHT -> REFUSED; ENGINE (engine may have acted) -> PENDING; LOCAL_ACK (engine/proof exists) -> PENDING_LOCAL_ACK.
  $phase='PREFLIGHT'
  $maxBytes=1048576
  $repo='hakanduyar/software-factory'
  # Accepted historical executable closure (same retained hashes the enqueue/UPDATE boundaries bind).
  $acceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'
  $acceptedCaptureSha256='31ba531df2b9c8caa00d80d5a5eb3034922a79da45c1fe217daeb7e3fb72a698'
  $ctx=@{engineEventKey=$null}
  try{
    foreach($h in @($ExpectedReleaseSha256,$ExpectedReviewSha256,$ExpectedNativeRequestSha256)){if(-not (Test-CreateGhHash $h)){throw 'ADMISSION_PIN_MISSING'}}
    Assert-CreateGhPath -Path $ReleasePath -MustBeFile
    $relBytes=Read-CreateGhBoundedBytes $ReleasePath
    if((Get-CreateGhSha256 $relBytes) -cne $ExpectedReleaseSha256){throw 'RELEASE_DRIFT'}
    $r=$null
    try{$r=Read-CreateGhStrictJson $relBytes}catch{throw 'RELEASE_INVALID'}

    # Strict supported shape only; anything else refuses before any effect or runner call.
    $refNames=@('packet','canonical','createEvent','engine','consumer','lifecycleHelpers','transport','reconcile','capture','executable','review','nativeRequest')
    $releaseKeys=@('schema')+$refNames+@('stateDir','outboxPath','outboxSha256','engineStateSha256','mappingPath','readbackPath','canonicalLease','publisherLease','tempRoot','configuration','recovery')
    if(-not (Test-CreateGhKeys $r $releaseKeys)){throw 'RELEASE_INVALID'}
    if($r['schema'] -isnot [string] -or $r['schema'] -cne 'CanonicalCreateGitHubRelease/v1'){throw 'RELEASE_INVALID'}
    if($r['recovery'] -isnot [string] -or $r['recovery'] -cnotin @('INITIAL','RECONCILE_MISSING')){throw 'RELEASE_INVALID'}
    foreach($n in $refNames){if(-not (Test-CreateGhRef $r[$n])){throw 'RELEASE_INVALID'}}
    foreach($n in @('stateDir','outboxPath','mappingPath','readbackPath','canonicalLease','publisherLease','tempRoot')){if($r[$n] -isnot [string]){throw 'RELEASE_INVALID'}}
    if(-not (Test-CreateGhHash $r['outboxSha256'])){throw 'RELEASE_INVALID'}
    if($null -ne $r['engineStateSha256'] -and -not (Test-CreateGhHash $r['engineStateSha256'])){throw 'RELEASE_INVALID'}
    $assertConfig={
      param($cfg)
      if(-not (Test-CreateGhKeys $cfg @('repo','markerNamespace')) -or $cfg['repo'] -isnot [string] -or $cfg['repo'] -cne $repo -or $cfg['markerNamespace'] -isnot [string] -or $cfg['markerNamespace'] -cne 'factory-task'){throw 'CONFIG_INVALID'}
    }
    & $assertConfig $r['configuration']

    $stateDir=$r['stateDir']; $outboxPath=$r['outboxPath']
    foreach($d in @($stateDir,$r['tempRoot'])){
      Assert-CreateGhPath -Path $d
      if(-not [IO.Directory]::Exists($d)){throw 'DIRECTORY_MISSING'}
    }
    $enginePath=Join-Path $stateDir 'github-task-lifecycle.state.json'
    $engineLockPath=Join-Path $stateDir 'github-task-lifecycle.lock'
    if($outboxPath -cne (Join-Path $stateDir 'outbox.json') -or $r['publisherLease'] -cne (Join-Path $stateDir 'publisher.lock') -or $r['canonicalLease'] -cne ($r['canonical']['path']+'.lock')){throw 'LEASE_BINDING'}
    Assert-CreateGhPath -Path $outboxPath -Root $stateDir
    Assert-CreateGhPath -Path ($outboxPath+'.lock') -Root $stateDir
    Assert-CreateGhPath -Path $r['publisherLease'] -Root $stateDir
    Assert-CreateGhPath -Path $r['canonicalLease']
    Assert-CreateGhPath -Path $engineLockPath -Root $stateDir
    Assert-CreateGhPath -Path $enginePath -Root $stateDir
    # No lease may be acquired twice by this call chain (canonical, publisher, engine, shared writer).
    $leaseSet=@($r['canonicalLease'],$r['publisherLease'],$engineLockPath,($outboxPath+'.lock'),($outboxPath+'.transaction.lock'))
    if(@($leaseSet | ForEach-Object {$_.ToUpperInvariant()} | Select-Object -Unique).Count -ne $leaseSet.Count){throw 'LEASE_REENTRANT'}

    # Source bindings: this very file, the reconcile's own capture sibling, and the accepted closure.
    $ownSource=$script:CreateGhConsumerSource
    if([string]::IsNullOrEmpty($ownSource) -or -not [string]::Equals($r['consumer']['path'],$ownSource,[StringComparison]::OrdinalIgnoreCase)){throw 'SOURCE_BINDING'}
    $capturePath=Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $r['reconcile']['path'])) 'dispatch') 'reviewed-blocked-capture.ps1'
    if($r['capture']['path'] -cne $capturePath){throw 'SOURCE_BINDING'}
    if($r['reconcile']['sha256'] -cne $acceptedReconcileSha256){throw 'RECONCILE_DRIFT'}
    if($r['capture']['sha256'] -cne $acceptedCaptureSha256){throw 'CAPTURE_DRIFT'}

    $pins=@(foreach($n in $refNames){@{name=$n;path=$r[$n]['path'];sha=$r[$n]['sha256']}})
    $verify={
      foreach($pin in $pins){
        Assert-CreateGhPath -Path $pin.path -MustBeFile
        if((Get-CreateGhFileSha256 $pin.path) -cne $pin.sha){throw ($pin.name.ToUpperInvariant()+'_DRIFT')}
      }
    }
    & $verify
    if($r['review']['sha256'] -cne $ExpectedReviewSha256 -or $r['nativeRequest']['sha256'] -cne $ExpectedNativeRequestSha256){throw 'ADMISSION_BINDING'}

    # Review and native request: exact shapes, bound to every release pin. Origin is not authenticated here.
    $hashBind=[ordered]@{packetSha256=$r['packet']['sha256'];canonicalSha256=$r['canonical']['sha256'];createEventSha256=$r['createEvent']['sha256'];engineSha256=$r['engine']['sha256'];consumerSha256=$r['consumer']['sha256'];lifecycleHelpersSha256=$r['lifecycleHelpers']['sha256'];transportSha256=$r['transport']['sha256'];reconcileSha256=$r['reconcile']['sha256'];captureSha256=$r['capture']['sha256'];executableSha256=$r['executable']['sha256']}
    $tailBind=[ordered]@{stateDir=$r['stateDir'];outboxPath=$r['outboxPath'];outboxSha256=$r['outboxSha256'];mappingPath=$r['mappingPath'];readbackPath=$r['readbackPath'];recovery=$r['recovery']}
    $commonKeys=@($hashBind.Keys)+@($tailBind.Keys)+@('engineStateSha256','configuration')
    $assertBound={
      param($doc,[string]$code)
      try{
        foreach($k in $hashBind.Keys){if($doc[$k] -isnot [string] -or $doc[$k] -cne $hashBind[$k]){throw 'x'}}
        foreach($k in $tailBind.Keys){if($doc[$k] -isnot [string] -or $doc[$k] -cne $tailBind[$k]){throw 'x'}}
        if($null -eq $r['engineStateSha256']){if($null -ne $doc['engineStateSha256']){throw 'x'}}
        elseif($doc['engineStateSha256'] -isnot [string] -or $doc['engineStateSha256'] -cne $r['engineStateSha256']){throw 'x'}
        & $assertConfig $doc['configuration']
        if($doc['configuration']['repo'] -cne $r['configuration']['repo'] -or $doc['configuration']['markerNamespace'] -cne $r['configuration']['markerNamespace']){throw 'x'}
      }catch{throw $code}
    }
    $review=Read-CreateGhPinnedJson $r['review']
    if(-not (Test-CreateGhKeys $review (@('schema','decision','reviewer')+$commonKeys))){throw 'REVIEW_BINDING'}
    if($review['schema'] -isnot [string] -or $review['schema'] -cne 'CanonicalCreateGitHubIndependentReview/v1' -or $review['decision'] -isnot [string] -or $review['decision'] -cne 'ADMIT_SCOPED_CREATE_GITHUB'){throw 'REVIEW_BINDING'}
    if($review['reviewer'] -isnot [string] -or $review['reviewer'] -cnotmatch '^[A-Za-z0-9 ._:@/-]{1,128}\z'){throw 'REVIEW_BINDING'}
    & $assertBound $review 'REVIEW_BINDING'
    $native=Read-CreateGhPinnedJson $r['nativeRequest']
    if(-not (Test-CreateGhKeys $native (@('schema','action')+$commonKeys+@('reviewSha256')))){throw 'NATIVE_BINDING'}
    if($native['schema'] -isnot [string] -or $native['schema'] -cne 'CanonicalCreateGitHubNativeRequest/v1' -or $native['action'] -isnot [string] -or $native['action'] -cne 'CREATE_GITHUB'){throw 'NATIVE_BINDING'}
    if($native['reviewSha256'] -isnot [string] -or $native['reviewSha256'] -cne $r['review']['sha256']){throw 'NATIVE_BINDING'}
    & $assertBound $native 'NATIVE_BINDING'

    # Load ONLY the pinned sources. The capture is loaded explicitly first so the reconcile's conditional
    # sibling load never runs; function origin is then checked against the exact pinned files, so a
    # preexisting function can neither bypass the closure nor survive it.
    & $verify
    . ([string]$r['lifecycleHelpers']['path'])
    . ([string]$r['capture']['path'])
    . ([string]$r['reconcile']['path'])
    . ([string]$r['engine']['path'])
    . ([string]$r['transport']['path'])
    & $verify
    $origins=[ordered]@{
      'New-TaskLifecycleMirrorPacket'=$r['lifecycleHelpers']['path'];'Read-LifecycleJson'=$r['lifecycleHelpers']['path'];'Assert-LifecycleKeys'=$r['lifecycleHelpers']['path']
      'Get-LifecycleHash'=$r['lifecycleHelpers']['path'];'Get-LifecycleFileHash'=$r['lifecycleHelpers']['path'];'Get-LifecycleRegion'=$r['lifecycleHelpers']['path']
      'Set-LifecycleRegion'=$r['lifecycleHelpers']['path'];'Get-LifecycleTransportDiagnostic'=$r['lifecycleHelpers']['path']
      'Get-ReviewedBlockedEvidenceCapture'=$r['capture']['path']
      'Read-Outbox'=$r['reconcile']['path'];'Write-OutboxAtomic'=$r['reconcile']['path'];'Get-EventKey'=$r['reconcile']['path']
      'Invoke-DurableGitHubTaskCreate'=$r['engine']['path']
      'New-GitHubCliLifecycleTransport216'=$r['transport']['path'];'Test-GitHubCliFailureDiagnostic216'=$r['transport']['path']
    }
    foreach($fn in $origins.Keys){
      $cmd=@(Get-Command -Name $fn -CommandType Function -ErrorAction SilentlyContinue)
      if($cmd.Count -ne 1 -or [string]::IsNullOrEmpty($cmd[0].ScriptBlock.File) -or -not [string]::Equals($cmd[0].ScriptBlock.File,$origins[$fn],[StringComparison]::OrdinalIgnoreCase)){throw 'IMPORT_INCOMPLETE'}
    }

    # Read-only planning: everything that can be refused is refused here. Run once before any lease and
    # again under both leases; -CheckEngine:$false is used only after the engine legitimately changed its
    # own state file.
    $plan={
      param([bool]$CheckEngine=$true)
      & $verify
      $p=New-TaskLifecycleMirrorPacket (Read-LifecycleJson $r['packet']['path'])
      if($p.eventType -cne 'CREATE'){throw 'UNSUPPORTED_EVENT'}
      $c=Read-LifecycleJson $r['canonical']['path']
      Assert-LifecycleKeys $c @('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')
      foreach($k in @('taskId','publicTitle','publicSummary','publicStatus','nextAction')){
        if($c[$k] -isnot [string] -or $p[$k] -isnot [string] -or $c[$k] -cne $p[$k]){throw 'CANONICAL_PACKET_MISMATCH'}
      }
      if(-not ($c.canonicalRevision -is [int] -or $c.canonicalRevision -is [long]) -or [long]$c.canonicalRevision -ne [long]$p.canonicalRevision){throw 'CANONICAL_PACKET_MISMATCH'}
      $id=$p.idempotencyKey
      if($id -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?\z'){throw 'IDEMPOTENCY_KEY_UNSAFE'}
      $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))

      # Deterministic outputs live only in the sidecar's own event directory; the sidecar is immutable.
      $eventDir=Join-Path $stateDir ('canonical-create-'+$id)
      $eventPath=Join-Path $eventDir 'event.json'
      if($r['createEvent']['path'] -cne $eventPath -or $r['mappingPath'] -cne (Join-Path $eventDir 'mapping.json') -or $r['readbackPath'] -cne (Join-Path $eventDir 'readback.json')){throw 'OUTPUT_BINDING'}
      foreach($o in @($eventDir,$eventPath,$r['mappingPath'],$r['readbackPath'])){Assert-CreateGhPath -Path $o -Root $stateDir}
      if(-not [IO.Directory]::Exists($eventDir) -or -not [IO.File]::Exists($eventPath)){throw 'SIDECAR_MISSING'}
      $ev=[ordered]@{schema='GitHubCreateEvent/v1';taskId=[string]$c.taskId;canonicalVersion=[long]$c.canonicalRevision;publicTitle=[string]$c.publicTitle;publicSummary=[string]$c.publicSummary;publicStatus=[string]$c.publicStatus;nextAction=[string]$c.nextAction}
      $evBytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $ev -Compress))
      $onDisk=Read-CreateGhBoundedBytes $eventPath
      if((Get-CreateGhSha256 $onDisk) -cne (Get-CreateGhSha256 $evBytes) -or (Get-CreateGhSha256 $onDisk) -cne $r['createEvent']['sha256']){throw 'SIDECAR_CONFLICT'}
      $refs=@{
        canonical=@{path=$r['canonical']['path'];sha256=$r['canonical']['sha256']}
        packet=@{path=$r['packet']['path'];sha256=$r['packet']['sha256']}
        event=@{path=$eventPath;sha256=$r['createEvent']['sha256']}
      }

      # Engine identity, computed independently of the engine (same formula, pinned engine source).
      $region=Get-LifecycleRegion $p
      $payload=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($p.publicTitle+"`n"+$region))
      $engineKey=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($p.taskId+'|'+[string][long]$p.canonicalRevision+'|'+$payload))

      # Outbox: caller-pinned bytes only; unrelated drift is refused, never merged.
      Assert-CreateGhPath -Path $outboxPath -Root $stateDir -MustBeFile
      $obBytes=Read-CreateGhBoundedBytes $outboxPath
      if((Get-CreateGhSha256 $obBytes) -cne $r['outboxSha256']){throw 'OUTBOX_DRIFT'}
      $rows=[Collections.Generic.List[object]]::new(); $origText=''
      try{
        $validated=@(Read-Outbox $outboxPath)
        $origText=[Text.UTF8Encoding]::new($false,$true).GetString($obBytes).TrimStart([char]0xFEFF)
        if([string]::IsNullOrWhiteSpace($origText)){throw 'OUTBOX_INVALID'}
        $parsed=ConvertFrom-Json -InputObject $origText -NoEnumerate -DateKind String
        if($parsed -isnot [array]){$parsed=@($parsed)}
        foreach($x in $parsed){$rows.Add($x)}
        if($rows.Count -ne $validated.Count){throw 'OUTBOX_INVALID'}
        for($i=0;$i -lt $rows.Count;$i++){if([string]$rows[$i].key -cne [string]$validated[$i].key){throw 'OUTBOX_INVALID'}}
      }catch{
        throw 'OUTBOX_INVALID'
      }
      $expect=@{}; $idx=@{}
      foreach($dest in @('github','note')){
        $runId=$id+':create:'+$dest
        $key=Get-EventKey -TaskId $p.taskId -PayloadSha256 $digest -RunId $runId -Status 'AWAITING_CONTROLLER' -Attempt 0
        $expect[$dest]=@{key=$key;taskId=$p.taskId;digest=$digest;runId=$runId;dest=$dest}
        $hits=@()
        for($i=0;$i -lt $rows.Count;$i++){if([string]$rows[$i].runId -ceq $runId -or [string]$rows[$i].key -ceq $key){$hits+=$i}}
        if($hits.Count -eq 0){throw 'ROW_MISSING'}
        if($hits.Count -gt 1){throw 'EVENT_CONFLICT'}
        Assert-CreateGhOwnRow $rows[$hits[0]] $expect[$dest] $refs
        $idx[$dest]=[int]$hits[0]
      }
      $githubDelivered=($rows[$idx.github].deliveryStatus -ceq 'DELIVERED')
      # The note row is never touched; it must be an untouched PENDING pair row unless GitHub is already ACKed.
      if($rows[$idx.note].deliveryStatus -cne 'PENDING' -and -not $githubDelivered){throw 'NOTE_ROW_STATE'}

      # Engine state is pinned: null iff absent. Only its event membership is read here.
      $eventInState=$false
      if($CheckEngine){
        if([IO.Directory]::Exists($enginePath)){throw 'ENGINE_STATE_DRIFT'}
        if($null -eq $r['engineStateSha256']){
          if([IO.File]::Exists($enginePath)){throw 'ENGINE_STATE_DRIFT'}
        } else {
          if(-not [IO.File]::Exists($enginePath)){throw 'ENGINE_STATE_DRIFT'}
          $stBytes=Read-CreateGhBoundedBytes $enginePath
          if((Get-CreateGhSha256 $stBytes) -cne $r['engineStateSha256']){throw 'ENGINE_STATE_DRIFT'}
          $st=$null
          try{$st=[Text.UTF8Encoding]::new($false,$true).GetString($stBytes) | ConvertFrom-Json -AsHashtable -DateKind String}catch{throw 'ENGINE_STATE_INVALID'}
          if($st -isnot [hashtable] -or $st['events'] -isnot [hashtable]){throw 'ENGINE_STATE_INVALID'}
          $eventInState=$st['events'].ContainsKey($engineKey)
        }
      }
      return @{p=$p;region=$region;digest=$digest;engineKey=$engineKey;eventPath=$eventPath;rows=$rows;origText=$origText;idx=$idx;expect=$expect;githubDelivered=$githubDelivered;eventInState=$eventInState}
    }

    # Durable proof artifacts: exact bytes, exact binding, no remote call. Used for replay and for
    # explicit recovery after the engine already succeeded.
    $checkArtifacts={
      param($s)
      try{
        foreach($f in @($r['mappingPath'],$r['readbackPath'])){Assert-CreateGhPath -Path $f -Root $stateDir -MustBeFile}
        $mBytes=Read-CreateGhBoundedBytes $r['mappingPath']
        $rBytes=Read-CreateGhBoundedBytes $r['readbackPath']
        $p=$s.p
        $marker='factory-task-'+(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($p.taskId)))
        $m=Read-CreateGhStrictJson $mBytes
        if(-not (Test-CreateGhKeys $m @('taskId','repo','issueNumber','url','stableMarker','canonicalRevision'))){throw 'x'}
        if(-not ($m['issueNumber'] -is [int] -or $m['issueNumber'] -is [long]) -or [long]$m['issueNumber'] -lt 1 -or [long]$m['issueNumber'] -gt 2147483647){throw 'x'}
        if(-not ($m['canonicalRevision'] -is [int] -or $m['canonicalRevision'] -is [long])){throw 'x'}
        foreach($k in @('taskId','repo','url','stableMarker')){if($m[$k] -isnot [string]){throw 'x'}}
        $mapExpected=New-CreateGhMapping -TaskId $p.taskId -Number ([long]$m['issueNumber']) -Marker $marker -Revision ([long]$p.canonicalRevision) -Repo $repo
        if((Get-CreateGhSha256 (ConvertTo-CreateGhJsonBytes $mapExpected)) -cne (Get-CreateGhSha256 $mBytes)){throw 'x'}
        $rc=Read-CreateGhStrictJson $rBytes
        $rcKeys=@('schema','taskId','canonicalRevision','packetSha256','createEventSha256','outboxKey','runId','payloadSha256','engineEventKey','mappingSha256','issueUrl','issueNumber','stableMarker','observedTitle','observedRegionSha256','observedBodySha256')
        if(-not (Test-CreateGhKeys $rc $rcKeys)){throw 'x'}
        if(-not ($rc['issueNumber'] -is [int] -or $rc['issueNumber'] -is [long]) -or -not ($rc['canonicalRevision'] -is [int] -or $rc['canonicalRevision'] -is [long])){throw 'x'}
        foreach($k in @($rcKeys | Where-Object {$_ -cne 'issueNumber' -and $_ -cne 'canonicalRevision'})){if($rc[$k] -isnot [string]){throw 'x'}}
        if(-not (Test-CreateGhHash $rc['observedBodySha256'])){throw 'x'}
        $rcExpected=New-CreateGhReceipt @{
          schema='CanonicalCreateGitHubReadback/v1';taskId=[string]$p.taskId;canonicalRevision=[long]$p.canonicalRevision
          packetSha256=[string]$r['packet']['sha256'];createEventSha256=[string]$r['createEvent']['sha256']
          outboxKey=[string]$s.expect.github.key;runId=[string]$s.expect.github.runId;payloadSha256=[string]$s.digest;engineEventKey=[string]$s.engineKey
          mappingSha256=(Get-CreateGhSha256 $mBytes);issueUrl=[string]$m['url'];issueNumber=[long]$m['issueNumber'];stableMarker=$marker
          observedTitle=[string]$p.publicTitle;observedRegionSha256=(Get-CreateGhSha256 ([Text.Encoding]::UTF8.GetBytes($s.region)));observedBodySha256=[string]$rc['observedBodySha256']
        }
        if((Get-CreateGhSha256 (ConvertTo-CreateGhJsonBytes $rcExpected)) -cne (Get-CreateGhSha256 $rBytes)){throw 'x'}
        $rbSha=Get-CreateGhSha256 $rBytes
        return @{mapping=$m;mappingSha256=(Get-CreateGhSha256 $mBytes);readbackSha256=$rbSha;proof=('canonical-create-readback:sha256='+$rbSha+';path='+$r['readbackPath'])}
      }catch{
        throw 'PROOF_INVALID'
      }
    }

    # Single GitHub-row ACK. Re-authenticates the exact admission, canonical, sidecar and outbox
    # immediately before the write; unrelated drift refuses (it is never merged). The shared writer's
    # result is not trusted: the actual outbox is read back and compared structurally.
    $doAck={
      param([string]$Proof,[System.Collections.IDictionary]$Info)
      & $verify
      $a=& $plan $false
      if($a.githubDelivered){throw 'ROW_STATE_DRIFT'}
      $gi=[int]$a.idx.github
      $a.rows[$gi].deliveryStatus='DELIVERED'
      $a.rows[$gi].proof=$Proof
      $final=$a.rows.ToArray()
      $finalJson=ConvertTo-Json -InputObject @($final) -Depth 10
      if([Text.UTF8Encoding]::new($false).GetByteCount($finalJson) -gt $maxBytes){throw 'OUTBOX_TOO_LARGE'}
      if(-not (Test-CreateGhOutboxTransition $a.origText $finalJson $gi $Proof)){throw 'OUTBOX_ROUNDTRIP_DRIFT'}
      $writeFailed=$false
      try{Write-OutboxAtomic $outboxPath $final}catch{$writeFailed=$true}
      $verified=$false
      try{
        $afterText=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($outboxPath)).TrimStart([char]0xFEFF)
        $afterRows=@(Read-Outbox $outboxPath)
        $verified=($afterRows.Count -eq $final.Count -and (Test-CreateGhOutboxTransition $a.origText $afterText $gi $Proof))
      }catch{$verified=$false}
      $extra=[ordered]@{}
      foreach($k in $Info.Keys){$extra[$k]=$Info[$k]}
      $extra['outboxKey']=$a.expect.github.key
      if($verified){
        $extra['outboxSha256']=Get-CreateGhFileSha256 $outboxPath
        return (New-CreateGhResult 'DELIVERED' $(if($writeFailed){'READBACK_ACK_RETAINED'}else{'READBACK_ACK'}) $true $extra)
      }
      return (New-CreateGhResult 'PENDING_LOCAL_ACK' $(if($writeFailed){'OUTBOX_WRITE_FAILED'}else{'WRITE_NOT_VERIFIED'}) $false $extra)
    }

    $pre=& $plan $true

    # Explicit lease order: canonical, then publisher. Never nested calls. Contention is an explicit,
    # unacknowledged result with every row preserved.
    $canonicalLease=Open-CreateGhLease $r['canonicalLease']
    if($null -eq $canonicalLease){return (New-CreateGhResult 'REFUSED' 'CANONICAL_LOCKED')}
    $publisherLease=Open-CreateGhLease $r['publisherLease']
    if($null -eq $publisherLease){return (New-CreateGhResult 'REFUSED' 'PUBLISHER_LOCKED')}
    $s=& $plan $true
    $ctx.engineEventKey=$s.engineKey
    $info=[ordered]@{taskId=[string]$s.p.taskId;engineEventKey=[string]$s.engineKey;mappingPath=$r['mappingPath'];readbackPath=$r['readbackPath']}

    # Already ACKed: zero transport. The durable proof and the outbox proof must still match exactly.
    if($s.githubDelivered){
      $art=& $checkArtifacts $s
      if([string]$s.rows[$s.idx.github].proof -cne $art.proof){throw 'PROOF_INVALID'}
      $info['issueUrl']=[string]$art.mapping['url']; $info['issueNumber']=[long]$art.mapping['issueNumber']
      $info['mappingSha256']=$art.mappingSha256; $info['readbackSha256']=$art.readbackSha256; $info['outboxKey']=$s.expect.github.key
      return (New-CreateGhResult 'DELIVERED' 'REPLAY_ACKED' $true $info)
    }

    # Recovery gating: a stale INITIAL pin never resets or resends; RECONCILE_MISSING needs retained
    # engine state or a complete persisted proof.
    $mapExists=([IO.File]::Exists($r['mappingPath']) -or [IO.Directory]::Exists($r['mappingPath']))
    $rbExists=([IO.File]::Exists($r['readbackPath']) -or [IO.Directory]::Exists($r['readbackPath']))
    $route=$null
    if($r['recovery'] -ceq 'INITIAL'){
      if($s.eventInState -or $mapExists -or $rbExists){throw 'EXPLICIT_RECOVERY_REQUIRED'}
      $route='ENGINE'
    } elseif($mapExists -and $rbExists){
      $route='PERSISTED'
    } elseif($s.eventInState){
      $route='ENGINE'
    } else {
      throw 'RECOVERY_WITHOUT_EVENT'
    }

    if($route -ceq 'PERSISTED'){
      $art=& $checkArtifacts $s
      $info['issueUrl']=[string]$art.mapping['url']; $info['issueNumber']=[long]$art.mapping['issueNumber']
      $info['mappingSha256']=$art.mappingSha256; $info['readbackSha256']=$art.readbackSha256; $info['source']='PERSISTED_PROOF'
      $phase='LOCAL_ACK'
      return (& $doAck $art.proof $info)
    }

    # ENGINE route. The transport is the existing pinned one; no caller transport selector exists.
    $transport=New-GitHubCliLifecycleTransport216 -GhPath $r['executable']['path'] -ExpectedGhSha256 $r['executable']['sha256'] -Repository $repo -TempRoot $r['tempRoot'] -ProcessRunner $ProcessRunner
    & $verify
    $phase='ENGINE'
    $er=$null
    try{
      $er=@(Invoke-DurableGitHubTaskCreate -EventPath $s.eventPath -Configuration @{repo=$repo;markerNamespace='factory-task'} -StateDir $stateDir -Transport $transport)
    }catch{
      return (New-CreateGhResult 'PENDING' 'ENGINE_UNEXPECTED' $false ([ordered]@{engineEventKey=[string]$s.engineKey}))
    }
    $engineBad={param([string]$why) return (New-CreateGhResult 'PENDING' 'ENGINE_RESULT_INVALID' $false ([ordered]@{engineEventKey=[string]$s.engineKey;reason=$why}))}
    if($er.Count -ne 1 -or $er[0] -isnot [pscustomobject]){return (& $engineBad 'SHAPE')}
    $e=$er[0]
    $names=@($e.PSObject.Properties.Name)
    $hasMap=($names -ccontains 'mapping')
    if($names.Count -ne $(if($hasMap){7}else{6})){return (& $engineBad 'SHAPE')}
    foreach($w in @('status','code','taskId','eventKey','attempt','replay')){if($names -cnotcontains $w){return (& $engineBad 'SHAPE')}}
    if($e.status -isnot [string] -or $e.code -isnot [string]){return (& $engineBad 'SHAPE')}
    if($e.status -cne 'MAPPED'){
      $code=$(if($e.code -cmatch '^[A-Z][A-Z0-9_]{2,63}\z'){$e.code}else{'ENGINE_RESULT_INVALID'})
      $st=$(if($e.status -ceq 'MAPPED_NEEDS_UPDATE' -or $e.status -ceq 'UNKNOWN_SEND'){'PENDING'}else{'REFUSED'})
      $x=[ordered]@{engineStatus=$(if($e.status -cmatch '^[A-Z_]{3,32}\z'){$e.status}else{'INVALID'});engineEventKey=[string]$s.engineKey}
      return (New-CreateGhResult $st $code $false $x)
    }
    if(-not $hasMap){return (& $engineBad 'MAPPING_MISSING')}
    $marker='factory-task-'+(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($s.p.taskId)))
    $m=$e.mapping
    if(-not (Test-CreateGhKeys $m @('taskId','repo','issueNumber','stableMarker'))){return (& $engineBad 'MAPPING_SHAPE')}
    if($e.taskId -isnot [string] -or $e.taskId -cne $s.p.taskId -or $e.eventKey -isnot [string] -or $e.eventKey -cne $s.engineKey){return (& $engineBad 'IDENTITY')}
    if($m['taskId'] -isnot [string] -or $m['taskId'] -cne $s.p.taskId -or $m['repo'] -isnot [string] -or $m['repo'] -cne $repo -or $m['stableMarker'] -isnot [string] -or $m['stableMarker'] -cne $marker){return (& $engineBad 'IDENTITY')}
    if(-not ($m['issueNumber'] -is [int] -or $m['issueNumber'] -is [long]) -or [long]$m['issueNumber'] -lt 1 -or [long]$m['issueNumber'] -gt 2147483647){return (& $engineBad 'IDENTITY')}
    $n=[long]$m['issueNumber']
    $url='https://github.com/'+$repo+'/issues/'+$n
    $info['engineStatus']='MAPPED'; $info['engineCode']=$(if($e.code -cmatch '^[A-Z][A-Z0-9_]{2,63}\z'){$e.code}else{'INVALID'})
    $info['issueUrl']=$url; $info['issueNumber']=$n

    # Independent wrapper READ through the same pinned transport. A MAPPED string is never the evidence.
    $rd=$null
    try{
      $o=@(& $transport 'READ' @{repo=$repo;issueNumber=[int]$n})
      if($o.Count -eq 1 -and $o[0] -is [pscustomobject]){$rd=$o[0]}
    }catch{$rd=$null}
    if($null -eq $rd -or $rd.PSObject.Properties.Name -cnotcontains 'ok' -or $rd.ok -isnot [bool] -or -not $rd.ok){
      $x=[ordered]@{}; foreach($k in $info.Keys){$x[$k]=$info[$k]}
      $diag=$null; if($null -ne $rd){$diag=Get-LifecycleTransportDiagnostic $rd}
      if($null -ne $diag){$x['diagnostic']=$diag}
      return (New-CreateGhResult 'PENDING' 'GITHUB_READ_FAILED' $false $x)
    }
    $consistent=$false
    try{
      if(($rd.number -is [int] -or $rd.number -is [long]) -and [long]$rd.number -eq $n -and $rd.url -is [string] -and $rd.url -ceq $url -and $rd.state -is [string] -and $rd.state -ceq 'OPEN' -and
         $rd.title -is [string] -and $rd.title -ceq $s.p.publicTitle -and $rd.body -is [string] -and [Text.Encoding]::UTF8.GetByteCount($rd.body) -le $maxBytes){
        # Exact managed content: replacing the unique managed region with the expected one is a no-op.
        $consistent=((Set-LifecycleRegion $rd.body $s.p.taskId $s.region) -ceq $rd.body)
      }
    }catch{$consistent=$false}
    if(-not $consistent){return (New-CreateGhResult 'PENDING' 'READBACK_MISMATCH' $false $info)}

    # Persist the verified mapping and readback BEFORE touching the row. Failures here are truthful:
    # the engine already succeeded, nothing is rolled back, nothing is created again.
    $phase='LOCAL_ACK'
    $mapBytes=ConvertTo-CreateGhJsonBytes (New-CreateGhMapping -TaskId $s.p.taskId -Number $n -Marker $marker -Revision ([long]$s.p.canonicalRevision) -Repo $repo)
    $mapSha=Get-CreateGhSha256 $mapBytes
    $rcBytes=ConvertTo-CreateGhJsonBytes (New-CreateGhReceipt @{
      schema='CanonicalCreateGitHubReadback/v1';taskId=[string]$s.p.taskId;canonicalRevision=[long]$s.p.canonicalRevision
      packetSha256=[string]$r['packet']['sha256'];createEventSha256=[string]$r['createEvent']['sha256']
      outboxKey=[string]$s.expect.github.key;runId=[string]$s.expect.github.runId;payloadSha256=[string]$s.digest;engineEventKey=[string]$s.engineKey
      mappingSha256=$mapSha;issueUrl=$url;issueNumber=$n;stableMarker=$marker
      observedTitle=[string]$rd.title;observedRegionSha256=(Get-CreateGhSha256 ([Text.Encoding]::UTF8.GetBytes($s.region)));observedBodySha256=(Get-CreateGhSha256 ([Text.Encoding]::UTF8.GetBytes($rd.body)))
    })
    if($mapBytes.Length -gt $maxBytes -or $rcBytes.Length -gt $maxBytes){throw 'ARTIFACT_TOO_LARGE'}
    $rbSha=Get-CreateGhSha256 $rcBytes
    $info['mappingSha256']=$mapSha; $info['readbackSha256']=$rbSha
    $info['mappingPersisted']=$false; $info['readbackPersisted']=$false
    try{[void](Write-CreateGhNewFile $r['mappingPath'] $mapBytes); $info['mappingPersisted']=$true}
    catch{return (New-CreateGhResult 'PENDING_LOCAL_ACK' 'MAPPING_PERSIST_FAILED' $false $info)}
    try{[void](Write-CreateGhNewFile $r['readbackPath'] $rcBytes); $info['readbackPersisted']=$true}
    catch{return (New-CreateGhResult 'PENDING_LOCAL_ACK' 'READBACK_PERSIST_FAILED' $false $info)}
    return (& $doAck ('canonical-create-readback:sha256='+$rbSha+';path='+$r['readbackPath']) $info)
  }catch{
    $msg=$_.Exception.Message
    $classified=($msg -cmatch '^[A-Z][A-Z0-9_]{2,63}\z')
    $status='PENDING_LOCAL_ACK'
    if($phase -ceq 'PREFLIGHT'){$status='REFUSED'}elseif($phase -ceq 'ENGINE'){$status='PENDING'}
    $extra=[ordered]@{}
    if(-not $classified){$extra['errorType']=$_.Exception.GetType().FullName}
    if($null -ne $ctx.engineEventKey){$extra['engineEventKey']=$ctx.engineEventKey}
    return (New-CreateGhResult $status $(if($classified){$msg}else{'UNCLASSIFIED_ERROR'}) $false $extra)
  }finally{
    if($publisherLease){$publisherLease.Dispose()}
    if($canonicalLease){$canonicalLease.Dispose()}
  }
}
