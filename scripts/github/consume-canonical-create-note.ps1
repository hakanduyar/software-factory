#Requires -Version 7.6
Set-StrictMode -Version Latest
$script:CreateNoteConsumerSource = $PSCommandPath

# Explicit, separately host-admitted CREATE destination consumer: NOTE ONLY, SOURCE ONLY.
# It consumes ONE CREATE note PENDING row (enqueue-canonical-lifecycle-create.ps1) AFTER the GitHub CREATE
# row of the same event is DELIVERED with the durable proof written by consume-canonical-create-github.ps1.
# It CreateNew-writes exactly one host-reviewed full note candidate, reads it back, and only then ACKs the
# note row. No engine, transport, process, network or provider is invoked.
#
# Nothing inside a packet, sidecar, row, candidate, review or native-request JSON grants authority. Every
# pin is an argument of the host invocation. Review and native documents are only validated for exact
# cross-binding to the release (no approval boolean, no circular hash: the review binds data/source refs
# only, the native request additionally binds the review hash, the release pins both through the
# externally supplied expected hashes). Their origin and the task/revision/note authorization belong to the
# external independent reviewer. No scheduler, automatic retry, template, vault scan or path discovery.
#
# The GitHub consumer is pinned provenance only: its emitted ABI (six-field mapping, 16-field
# CanonicalCreateGitHubReadback/v1, proof 'canonical-create-readback:sha256=<sha>;path=<path>') is
# re-authenticated directly and it is never dot-loaded here.
#
# Note proof: 'canonical-create-note-readback:sha256=<note sha>;path=<note path>'.
# The note file and the outbox are separate files, not one transaction. An ACK failure after the note was
# created returns PENDING_LOCAL_ACK (nothing rolled back, note never rewritten); an explicit new
# RECONCILE_MISSING admission pinned to the then-current note bytes completes it once.
# Local ACK asserts no Obsidian sync/publication, no Factory task DONE.
# 'paired' is true only when this call itself verified both the GitHub proof and the note ACK.

function Get-CreateNoteSha256 {
  param([byte[]]$Bytes)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-CreateNoteFileSha256 {
  param([string]$Path)
  Get-CreateNoteSha256 ([IO.File]::ReadAllBytes($Path))
}
function Test-CreateNoteHash {
  param($Value)
  return ($Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}\z')
}
function Test-CreateNoteKeys {
  param($Object,[string[]]$Keys)
  if($Object -isnot [hashtable] -or $Object.Count -ne $Keys.Count){return $false}
  $have=@($Object.Keys)
  foreach($k in $Keys){if($have -cnotcontains $k){return $false}}
  return $true
}
function Test-CreateNoteRef {
  param($Ref)
  if(-not (Test-CreateNoteKeys $Ref @('path','sha256'))){return $false}
  return ($Ref['path'] -is [string] -and $Ref['path'].Length -gt 0 -and (Test-CreateNoteHash $Ref['sha256']))
}
function Assert-CreateNotePath {
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
function Open-CreateNoteLease {
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
function Read-CreateNoteBoundedBytes {
  # Same 1 MiB ceiling the existing strict reader applies; it also bounds every artifact handled here.
  param([string]$Path)
  if([IO.FileInfo]::new($Path).Length -gt 1048576){throw 'INPUT_TOO_LARGE'}
  $b=[IO.File]::ReadAllBytes($Path)
  if($b.Length -gt 1048576){throw 'INPUT_TOO_LARGE'}
  return ,$b
}
function Assert-CreateNoteNoDuplicateNames {
  param([Text.Json.JsonElement]$El)
  if($El.ValueKind -eq [Text.Json.JsonValueKind]::Object){
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($pr in $El.EnumerateObject()){
      if(-not $seen.Add($pr.Name)){throw 'DUPLICATE_FIELD'}
      Assert-CreateNoteNoDuplicateNames $pr.Value
    }
  } elseif($El.ValueKind -eq [Text.Json.JsonValueKind]::Array){
    foreach($v in $El.EnumerateArray()){Assert-CreateNoteNoDuplicateNames $v}
  }
}
function Read-CreateNoteStrictJson {
  # Strict UTF-8, no duplicate names at any depth, dates stay strings. Parses exactly the given bytes.
  param([byte[]]$Bytes)
  if($Bytes.Length -gt 1048576){throw 'INPUT_TOO_LARGE'}
  $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)
  $doc=[Text.Json.JsonDocument]::Parse($text)
  try{Assert-CreateNoteNoDuplicateNames $doc.RootElement}finally{$doc.Dispose()}
  return ($text | ConvertFrom-Json -AsHashtable -DateKind String)
}
function Read-CreateNotePinnedJson {
  # Reads once; the hash is checked on the same bytes that are parsed.
  param($Ref)
  Assert-CreateNotePath -Path $Ref['path'] -MustBeFile
  $bytes=Read-CreateNoteBoundedBytes $Ref['path']
  if((Get-CreateNoteSha256 $bytes) -cne $Ref['sha256']){throw 'PIN_DRIFT'}
  try{return (Read-CreateNoteStrictJson $bytes)}catch{throw 'ADMISSION_INVALID'}
}
function New-CreateNoteResult {
  param([string]$Status,[string]$Code,[bool]$NoteAck=$false,[bool]$GithubVerified=$false,[System.Collections.IDictionary]$Extra=@{})
  $o=[ordered]@{status=$Status;code=$Code;githubAckVerified=$GithubVerified;noteAck=$NoteAck;paired=($GithubVerified -and $NoteAck);factoryDone=$false;automaticRetry=$false}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function Test-CreateNoteJsonSame {
  # Structural, order-preserving equality of two JSON elements (numbers by raw text: fail closed).
  param([Text.Json.JsonElement]$A,[Text.Json.JsonElement]$B)
  $kind=$A.ValueKind.ToString()
  if($kind -cne $B.ValueKind.ToString()){return $false}
  if($kind -ceq 'Object'){
    $pa=@($A.EnumerateObject()); $pb=@($B.EnumerateObject())
    if($pa.Count -ne $pb.Count){return $false}
    for($i=0;$i -lt $pa.Count;$i++){
      if($pa[$i].Name -cne $pb[$i].Name -or -not (Test-CreateNoteJsonSame $pa[$i].Value $pb[$i].Value)){return $false}
    }
    return $true
  }
  if($kind -ceq 'Array'){
    $ea=@($A.EnumerateArray()); $eb=@($B.EnumerateArray())
    if($ea.Count -ne $eb.Count){return $false}
    for($i=0;$i -lt $ea.Count;$i++){if(-not (Test-CreateNoteJsonSame $ea[$i] $eb[$i])){return $false}}
    return $true
  }
  if($kind -ceq 'String'){return ($A.GetString() -ceq $B.GetString())}
  if($kind -ceq 'Number'){return ($A.GetRawText() -ceq $B.GetRawText())}
  return $true
}
function Test-CreateNoteOutboxTransition {
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
        if(-not (Test-CreateNoteJsonSame $ea[$i] $eb[$i])){return $false}
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
        } elseif(-not (Test-CreateNoteJsonSame $va $vb)){return $false}
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
function Test-CreateNoteRowRef {
  param($Ref,[string]$Path,[string]$Sha)
  if($Ref -isnot [System.Management.Automation.PSCustomObject]){return $false}
  $n=@($Ref.PSObject.Properties.Name)
  if($n.Count -ne 2 -or $n -cnotcontains 'path' -or $n -cnotcontains 'sha256'){return $false}
  return ($Ref.path -is [string] -and $Ref.path -ceq $Path -and $Ref.sha256 -is [string] -and $Ref.sha256 -ceq $Sha)
}
function Assert-CreateNoteOwnRow {
  # A row in this event's CREATE namespace must be exactly the enqueue shape, bound to the admitted refs.
  # NO_RETRY is an exclusion, never a success.
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
  if(-not (Test-CreateNoteRowRef $Row.canonicalRef $Refs.canonical.path $Refs.canonical.sha256) -or
     -not (Test-CreateNoteRowRef $Row.packetRef $Refs.packet.path $Refs.packet.sha256) -or
     -not (Test-CreateNoteRowRef $Row.createEventRef $Refs.event.path $Refs.event.sha256)){throw 'EVENT_CONFLICT'}
}
function ConvertTo-CreateNoteJsonBytes {
  param($Ordered)
  [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Ordered -Compress -Depth 4))
}
function Write-CreateNoteNewFile {
  # Create-new only: exact owned temp, then a no-replace move. An existing file or directory at Path is never
  # replaced, adopted or deleted (a racing identical file is not ours either). Only the temp named here is
  # deleted.
  param([string]$Path,[byte[]]$Bytes)
  if([IO.Directory]::Exists($Path) -or [IO.File]::Exists($Path)){throw 'NOTE_CONFLICT'}
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  $made=$false
  try{
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $made=$true
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    try{
      [IO.File]::Move($tmp,$Path,$false)
    }catch [IO.IOException]{
      throw 'NOTE_CREATE_RACE'
    }
  }finally{
    if($made -and [IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)}
  }
}
function Assert-CreateNoteCandidate {
  # The delivered helper validates ownership/header identity against the current packet and mapping
  # (it throws a classified code); its rewritten output is discarded: the approved bytes are kept exactly.
  param([string]$Text,$Packet,$Mapping)
  if($Text.Length -gt 0 -and $Text[0] -eq [char]0xFEFF){throw 'NOTECANDIDATE_INVALID'}
  [void](Set-LifecycleNoteFields $Text $Packet $Mapping)
  $nl=$(if($Text.Contains("`r`n")){"`r`n"}else{"`n"})
  $start='<!-- factory-task:'+$Packet.taskId+':start -->'; $end='<!-- factory-task:'+$Packet.taskId+':end -->'
  $off=$Text.IndexOf($start,[StringComparison]::Ordinal)+$start.Length+$nl.Length
  $lines=$Text.Substring($off,$Text.IndexOf($end,[StringComparison]::Ordinal)-$off).Split(@($nl),[StringSplitOptions]::None)
  if($lines[1] -cne ('Status: '+$Packet.publicStatus) -or $lines[5] -cne ('Next action: '+$Packet.nextAction)){throw 'CANDIDATE_MISMATCH'}
  if($lines[6].StartsWith('Title: ',[StringComparison]::Ordinal)){
    if($lines[6] -cne ('Title: '+$Packet.publicTitle) -or $lines[7] -cne ('Summary: '+$Packet.publicSummary)){throw 'CANDIDATE_MISMATCH'}
  }
}

function Invoke-AdmittedCanonicalCreateNote {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$ReleasePath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedReleaseSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedReviewSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedNativeRequestSha256
  )
  $ErrorActionPreference='Stop'
  $canonicalLease=$null; $publisherLease=$null
  # PREFLIGHT -> REFUSED; NOTE_WRITE (note may exist) -> PENDING; LOCAL_ACK (note exists) -> PENDING_LOCAL_ACK.
  $phase='PREFLIGHT'
  $maxBytes=1048576
  $repo='hakanduyar/software-factory'
  $acceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'
  $acceptedCaptureSha256='31ba531df2b9c8caa00d80d5a5eb3034922a79da45c1fe217daeb7e3fb72a698'
  $ctx=@{ghVerified=$false;notePath=$null}
  try{
    foreach($h in @($ExpectedReleaseSha256,$ExpectedReviewSha256,$ExpectedNativeRequestSha256)){if(-not (Test-CreateNoteHash $h)){throw 'ADMISSION_PIN_MISSING'}}
    Assert-CreateNotePath -Path $ReleasePath -MustBeFile
    $relBytes=Read-CreateNoteBoundedBytes $ReleasePath
    if((Get-CreateNoteSha256 $relBytes) -cne $ExpectedReleaseSha256){throw 'RELEASE_DRIFT'}
    $r=$null
    try{$r=Read-CreateNoteStrictJson $relBytes}catch{throw 'RELEASE_INVALID'}

    $refNames=@('packet','canonical','createEvent','githubConsumer','lifecycleHelpers','reconcile','capture','mapping','readback','noteCandidate','review','nativeRequest')
    $releaseKeys=@('schema')+$refNames+@('stateDir','outboxPath','outboxSha256','vaultRoot','notePath','expectedNoteSha256','canonicalLease','publisherLease','recovery')
    if(-not (Test-CreateNoteKeys $r $releaseKeys)){throw 'RELEASE_INVALID'}
    if($r['schema'] -isnot [string] -or $r['schema'] -cne 'CanonicalCreateNoteRelease/v1'){throw 'RELEASE_INVALID'}
    if($r['recovery'] -isnot [string] -or $r['recovery'] -cnotin @('INITIAL','RECONCILE_MISSING')){throw 'RELEASE_INVALID'}
    foreach($n in $refNames){if(-not (Test-CreateNoteRef $r[$n])){throw 'RELEASE_INVALID'}}
    foreach($n in @('stateDir','outboxPath','vaultRoot','notePath','canonicalLease','publisherLease')){if($r[$n] -isnot [string]){throw 'RELEASE_INVALID'}}
    if(-not (Test-CreateNoteHash $r['outboxSha256'])){throw 'RELEASE_INVALID'}
    if($null -ne $r['expectedNoteSha256'] -and -not (Test-CreateNoteHash $r['expectedNoteSha256'])){throw 'RELEASE_INVALID'}

    $stateDir=$r['stateDir']; $outboxPath=$r['outboxPath']; $vaultRoot=$r['vaultRoot']; $notePath=$r['notePath']
    $ctx.notePath=$notePath
    foreach($d in @($stateDir,$vaultRoot)){
      Assert-CreateNotePath -Path $d
      if(-not [IO.Directory]::Exists($d)){throw 'DIRECTORY_MISSING'}
    }
    $sd=$stateDir.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar; $vd=$vaultRoot.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    if($sd.StartsWith($vd,[StringComparison]::OrdinalIgnoreCase) -or $vd.StartsWith($sd,[StringComparison]::OrdinalIgnoreCase)){throw 'VAULT_STATE_OVERLAP'}
    if($outboxPath -cne (Join-Path $stateDir 'outbox.json') -or $r['publisherLease'] -cne (Join-Path $stateDir 'publisher.lock') -or $r['canonicalLease'] -cne ($r['canonical']['path']+'.lock')){throw 'LEASE_BINDING'}
    Assert-CreateNotePath -Path $outboxPath -Root $stateDir
    Assert-CreateNotePath -Path ($outboxPath+'.lock') -Root $stateDir
    Assert-CreateNotePath -Path $r['publisherLease'] -Root $stateDir
    Assert-CreateNotePath -Path $r['canonicalLease']
    $leaseSet=@($r['canonicalLease'],$r['publisherLease'],($outboxPath+'.lock'),($outboxPath+'.transaction.lock'))
    if(@($leaseSet | ForEach-Object {$_.ToUpperInvariant()} | Select-Object -Unique).Count -ne $leaseSet.Count){throw 'LEASE_REENTRANT'}
    # Note identity: inside the explicit vault, ordinary non-reparse, parent already exists (never created).
    Assert-CreateNotePath -Path $notePath -Root $vaultRoot
    if(-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($notePath))){throw 'NOTE_PARENT_MISSING'}
    if([IO.Directory]::Exists($notePath)){throw 'NOTE_PATH_CONFLICT'}

    # Source bindings: sibling GitHub consumer and lifecycle helpers, the reconcile's capture sibling, accepted closure.
    $ownDir=Split-Path -Parent $script:CreateNoteConsumerSource
    if([string]::IsNullOrEmpty($ownDir) -or
       -not [string]::Equals($r['githubConsumer']['path'],(Join-Path $ownDir 'consume-canonical-create-github.ps1'),[StringComparison]::OrdinalIgnoreCase) -or
       -not [string]::Equals($r['lifecycleHelpers']['path'],(Join-Path $ownDir 'task-lifecycle-mirror-consumer.ps1'),[StringComparison]::OrdinalIgnoreCase)){throw 'SOURCE_BINDING'}
    $capturePath=Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $r['reconcile']['path'])) 'dispatch') 'reviewed-blocked-capture.ps1'
    if($r['capture']['path'] -cne $capturePath){throw 'SOURCE_BINDING'}
    if($r['reconcile']['sha256'] -cne $acceptedReconcileSha256){throw 'RECONCILE_DRIFT'}
    if($r['capture']['sha256'] -cne $acceptedCaptureSha256){throw 'CAPTURE_DRIFT'}

    $pins=@(foreach($n in $refNames){@{name=$n;path=$r[$n]['path'];sha=$r[$n]['sha256']}})
    $verify={
      foreach($pin in $pins){
        Assert-CreateNotePath -Path $pin.path -MustBeFile
        if((Get-CreateNoteFileSha256 $pin.path) -cne $pin.sha){throw ($pin.name.ToUpperInvariant()+'_DRIFT')}
      }
    }
    & $verify
    if($r['review']['sha256'] -cne $ExpectedReviewSha256 -or $r['nativeRequest']['sha256'] -cne $ExpectedNativeRequestSha256){throw 'ADMISSION_BINDING'}

    # Review binds data/source refs only (never its own or the native hash); native adds the review hash.
    $hashBind=[ordered]@{packetSha256=$r['packet']['sha256'];canonicalSha256=$r['canonical']['sha256'];createEventSha256=$r['createEvent']['sha256'];githubConsumerSha256=$r['githubConsumer']['sha256'];lifecycleHelpersSha256=$r['lifecycleHelpers']['sha256'];reconcileSha256=$r['reconcile']['sha256'];captureSha256=$r['capture']['sha256'];mappingSha256=$r['mapping']['sha256'];readbackSha256=$r['readback']['sha256'];noteCandidateSha256=$r['noteCandidate']['sha256']}
    $tailBind=[ordered]@{stateDir=$stateDir;outboxPath=$outboxPath;outboxSha256=$r['outboxSha256'];vaultRoot=$vaultRoot;notePath=$notePath;recovery=$r['recovery']}
    $commonKeys=@($hashBind.Keys)+@($tailBind.Keys)+@('expectedNoteSha256')
    $assertBound={
      param($doc,[string]$code)
      try{
        foreach($k in $hashBind.Keys){if($doc[$k] -isnot [string] -or $doc[$k] -cne $hashBind[$k]){throw 'x'}}
        foreach($k in $tailBind.Keys){if($doc[$k] -isnot [string] -or $doc[$k] -cne $tailBind[$k]){throw 'x'}}
        if($null -eq $r['expectedNoteSha256']){if($null -ne $doc['expectedNoteSha256']){throw 'x'}}
        elseif($doc['expectedNoteSha256'] -isnot [string] -or $doc['expectedNoteSha256'] -cne $r['expectedNoteSha256']){throw 'x'}
      }catch{throw $code}
    }
    $review=Read-CreateNotePinnedJson $r['review']
    if(-not (Test-CreateNoteKeys $review (@('schema','decision','reviewer')+$commonKeys))){throw 'REVIEW_BINDING'}
    if($review['schema'] -isnot [string] -or $review['schema'] -cne 'CanonicalCreateNoteIndependentReview/v1' -or $review['decision'] -isnot [string] -or $review['decision'] -cne 'ADMIT_SCOPED_CREATE_NOTE'){throw 'REVIEW_BINDING'}
    if($review['reviewer'] -isnot [string] -or $review['reviewer'] -cnotmatch '^[A-Za-z0-9 ._:@/-]{1,128}\z'){throw 'REVIEW_BINDING'}
    & $assertBound $review 'REVIEW_BINDING'
    $native=Read-CreateNotePinnedJson $r['nativeRequest']
    if(-not (Test-CreateNoteKeys $native (@('schema','action')+$commonKeys+@('reviewSha256')))){throw 'NATIVE_BINDING'}
    if($native['schema'] -isnot [string] -or $native['schema'] -cne 'CanonicalCreateNoteNativeRequest/v1' -or $native['action'] -isnot [string] -or $native['action'] -cne 'CREATE_NOTE'){throw 'NATIVE_BINDING'}
    if($native['reviewSha256'] -isnot [string] -or $native['reviewSha256'] -cne $r['review']['sha256']){throw 'NATIVE_BINDING'}
    & $assertBound $native 'NATIVE_BINDING'

    # Load ONLY the pinned helpers, capture (before reconcile, so its conditional sibling load never runs)
    # and reconcile; function origin must then be the exact pinned files. The GitHub consumer is not loaded.
    & $verify
    . ([string]$r['lifecycleHelpers']['path'])
    . ([string]$r['capture']['path'])
    . ([string]$r['reconcile']['path'])
    & $verify
    $origins=[ordered]@{
      'New-TaskLifecycleMirrorPacket'=$r['lifecycleHelpers']['path'];'Read-LifecycleJson'=$r['lifecycleHelpers']['path'];'Assert-LifecycleKeys'=$r['lifecycleHelpers']['path']
      'Get-LifecycleHash'=$r['lifecycleHelpers']['path'];'Get-LifecycleFileHash'=$r['lifecycleHelpers']['path'];'Get-LifecycleRegion'=$r['lifecycleHelpers']['path']
      'Set-LifecycleNoteFields'=$r['lifecycleHelpers']['path'];'Get-ReviewedBlockedEvidenceCapture'=$r['capture']['path']
      'Read-Outbox'=$r['reconcile']['path'];'Write-OutboxAtomic'=$r['reconcile']['path'];'Get-EventKey'=$r['reconcile']['path']
    }
    foreach($fn in $origins.Keys){
      $cmd=@(Get-Command -Name $fn -CommandType Function -ErrorAction SilentlyContinue)
      if($cmd.Count -ne 1 -or [string]::IsNullOrEmpty($cmd[0].ScriptBlock.File) -or -not [string]::Equals($cmd[0].ScriptBlock.File,$origins[$fn],[StringComparison]::OrdinalIgnoreCase)){throw 'IMPORT_INCOMPLETE'}
    }

    # Read-only planning: everything refusable is refused here. Run once before any lease and again under
    # both leases. NoteMode PRE checks the note against the release pin; POST requires the exact candidate.
    $plan={
      param([string]$NoteMode='PRE')
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

      $eventDir=Join-Path $stateDir ('canonical-create-'+$id)
      $eventPath=Join-Path $eventDir 'event.json'
      $mappingPath=Join-Path $eventDir 'mapping.json'; $readbackPath=Join-Path $eventDir 'readback.json'
      if($r['createEvent']['path'] -cne $eventPath -or $r['mapping']['path'] -cne $mappingPath -or $r['readback']['path'] -cne $readbackPath){throw 'OUTPUT_BINDING'}
      foreach($o in @($eventDir,$eventPath,$mappingPath,$readbackPath)){Assert-CreateNotePath -Path $o -Root $stateDir}
      if(-not [IO.File]::Exists($eventPath)){throw 'SIDECAR_MISSING'}
      $ev=[ordered]@{schema='GitHubCreateEvent/v1';taskId=[string]$c.taskId;canonicalVersion=[long]$c.canonicalRevision;publicTitle=[string]$c.publicTitle;publicSummary=[string]$c.publicSummary;publicStatus=[string]$c.publicStatus;nextAction=[string]$c.nextAction}
      $evSha=Get-CreateNoteSha256 ([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $ev -Compress)))
      if((Get-CreateNoteSha256 (Read-CreateNoteBoundedBytes $eventPath)) -cne $evSha -or $evSha -cne $r['createEvent']['sha256']){throw 'SIDECAR_CONFLICT'}
      $refs=@{
        canonical=@{path=$r['canonical']['path'];sha256=$r['canonical']['sha256']}
        packet=@{path=$r['packet']['path'];sha256=$r['packet']['sha256']}
        event=@{path=$eventPath;sha256=$evSha}
      }
      $region=Get-LifecycleRegion $p
      $payload=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($p.publicTitle+"`n"+$region))
      $engineKey=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($p.taskId+'|'+[string][long]$p.canonicalRevision+'|'+$payload))

      # Outbox: caller-pinned bytes only; unrelated drift is refused, never merged.
      Assert-CreateNotePath -Path $outboxPath -Root $stateDir -MustBeFile
      $obBytes=Read-CreateNoteBoundedBytes $outboxPath
      if((Get-CreateNoteSha256 $obBytes) -cne $r['outboxSha256']){throw 'OUTBOX_DRIFT'}
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
        Assert-CreateNoteOwnRow $rows[$hits[0]] $expect[$dest] $refs
        $idx[$dest]=[int]$hits[0]
      }

      # GitHub destination must hold actual DELIVERED/readback proof; re-authenticate the exact artifact bytes.
      $ghRow=$rows[$idx.github]
      if($ghRow.deliveryStatus -cne 'DELIVERED'){throw 'GITHUB_NOT_DELIVERED'}
      $m=$null
      try{
        $mBytes=Read-CreateNoteBoundedBytes $mappingPath
        $rBytes=Read-CreateNoteBoundedBytes $readbackPath
        if((Get-CreateNoteSha256 $mBytes) -cne $r['mapping']['sha256'] -or (Get-CreateNoteSha256 $rBytes) -cne $r['readback']['sha256']){throw 'x'}
        $marker='factory-task-'+(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($p.taskId)))
        $m=Read-CreateNoteStrictJson $mBytes
        if(-not (Test-CreateNoteKeys $m @('taskId','repo','issueNumber','url','stableMarker','canonicalRevision'))){throw 'x'}
        if(-not ($m['issueNumber'] -is [int] -or $m['issueNumber'] -is [long]) -or [long]$m['issueNumber'] -lt 1 -or [long]$m['issueNumber'] -gt 2147483647){throw 'x'}
        $n=[long]$m['issueNumber']
        $mapExpected=[ordered]@{taskId=[string]$p.taskId;repo=$repo;issueNumber=$n;url=('https://github.com/'+$repo+'/issues/'+$n);stableMarker=$marker;canonicalRevision=[long]$p.canonicalRevision}
        if((Get-CreateNoteSha256 (ConvertTo-CreateNoteJsonBytes $mapExpected)) -cne (Get-CreateNoteSha256 $mBytes)){throw 'x'}
        $rc=Read-CreateNoteStrictJson $rBytes
        $rcKeys=@('schema','taskId','canonicalRevision','packetSha256','createEventSha256','outboxKey','runId','payloadSha256','engineEventKey','mappingSha256','issueUrl','issueNumber','stableMarker','observedTitle','observedRegionSha256','observedBodySha256')
        if(-not (Test-CreateNoteKeys $rc $rcKeys) -or -not (Test-CreateNoteHash $rc['observedBodySha256'])){throw 'x'}
        $rcExpected=[ordered]@{
          schema='CanonicalCreateGitHubReadback/v1';taskId=[string]$p.taskId;canonicalRevision=[long]$p.canonicalRevision
          packetSha256=[string]$r['packet']['sha256'];createEventSha256=[string]$evSha
          outboxKey=[string]$expect.github.key;runId=[string]$expect.github.runId;payloadSha256=[string]$digest;engineEventKey=[string]$engineKey
          mappingSha256=(Get-CreateNoteSha256 $mBytes);issueUrl=[string]$mapExpected.url;issueNumber=$n;stableMarker=$marker
          observedTitle=[string]$p.publicTitle;observedRegionSha256=(Get-CreateNoteSha256 ([Text.Encoding]::UTF8.GetBytes($region)));observedBodySha256=[string]$rc['observedBodySha256']
        }
        if((Get-CreateNoteSha256 (ConvertTo-CreateNoteJsonBytes $rcExpected)) -cne (Get-CreateNoteSha256 $rBytes)){throw 'x'}
        $ghProof='canonical-create-readback:sha256='+(Get-CreateNoteSha256 $rBytes)+';path='+$readbackPath
        if($ghRow.proof -isnot [string] -or $ghRow.proof -cne $ghProof){throw 'x'}
      }catch{
        throw 'PROOF_INVALID'
      }

      # Host-reviewed full candidate: exact pinned bytes, strict UTF-8, validated against current packet+mapping.
      $candBytes=Read-CreateNoteBoundedBytes $r['noteCandidate']['path']
      $candSha=Get-CreateNoteSha256 $candBytes
      if($candSha -cne $r['noteCandidate']['sha256']){throw 'NOTECANDIDATE_DRIFT'}
      $candText=$null
      try{$candText=[Text.UTF8Encoding]::new($false,$true).GetString($candBytes)}catch{throw 'NOTECANDIDATE_INVALID'}
      Assert-CreateNoteCandidate $candText $p $m

      # Note state, bound to the release pin before any effect.
      $noteExists=[IO.File]::Exists($notePath)
      if([IO.Directory]::Exists($notePath)){throw 'NOTE_PATH_CONFLICT'}
      $noteSha=$null
      if($noteExists){$noteSha=Get-CreateNoteSha256 (Read-CreateNoteBoundedBytes $notePath)}
      if($NoteMode -ceq 'PRE'){
        if($null -eq $r['expectedNoteSha256']){if($noteExists){throw 'NOTE_STATE_DRIFT'}}
        elseif(-not $noteExists -or $noteSha -cne $r['expectedNoteSha256']){throw 'NOTE_STATE_DRIFT'}
        if($noteExists -and $noteSha -cne $candSha){throw 'NOTE_CONFLICT'}
      } elseif(-not $noteExists -or $noteSha -cne $candSha){throw 'NOTE_READBACK_MISMATCH'}
      $noteProof='canonical-create-note-readback:sha256='+$candSha+';path='+$notePath
      $noteRow=$rows[$idx.note]
      $noteDelivered=($noteRow.deliveryStatus -ceq 'DELIVERED')
      if($noteDelivered -and ($noteRow.proof -isnot [string] -or $noteRow.proof -cne $noteProof -or -not $noteExists)){throw 'PROOF_INVALID'}
      return @{p=$p;rows=$rows;origText=$origText;idx=$idx;expect=$expect;noteExists=$noteExists;candidateBytes=$candBytes;candidateSha=$candSha;noteProof=$noteProof;noteDelivered=$noteDelivered;issueUrl=[string]$m['url'];issueNumber=[long]$m['issueNumber']}
    }

    # Single note-row ACK. Re-authenticates everything immediately before the write; the writer's result is not
    # trusted: the actual outbox is read back and compared structurally.
    $doAck={
      param([string]$Code,[System.Collections.IDictionary]$Info)
      & $verify
      $a=& $plan 'POST'
      if($a.noteDelivered){throw 'ROW_STATE_DRIFT'}
      $ni=[int]$a.idx.note; $proof=[string]$a.noteProof
      $a.rows[$ni].deliveryStatus='DELIVERED'
      $a.rows[$ni].proof=$proof
      $final=$a.rows.ToArray()
      $finalJson=ConvertTo-Json -InputObject @($final) -Depth 10
      if([Text.UTF8Encoding]::new($false).GetByteCount($finalJson) -gt $maxBytes){throw 'OUTBOX_TOO_LARGE'}
      if(-not (Test-CreateNoteOutboxTransition $a.origText $finalJson $ni $proof)){throw 'OUTBOX_ROUNDTRIP_DRIFT'}
      $writeFailed=$false
      try{Write-OutboxAtomic $outboxPath $final}catch{$writeFailed=$true}
      $verified=$false
      try{
        $afterText=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($outboxPath)).TrimStart([char]0xFEFF)
        $afterRows=@(Read-Outbox $outboxPath)
        $verified=($afterRows.Count -eq $final.Count -and (Test-CreateNoteOutboxTransition $a.origText $afterText $ni $proof))
      }catch{$verified=$false}
      $extra=[ordered]@{}
      foreach($k in $Info.Keys){$extra[$k]=$Info[$k]}
      $extra['outboxKey']=$a.expect.note.key
      if($verified){
        $extra['outboxSha256']=Get-CreateNoteFileSha256 $outboxPath
        return (New-CreateNoteResult 'DELIVERED' $(if($writeFailed){'NOTE_ACK_RETAINED'}else{$Code}) $true $true $extra)
      }
      return (New-CreateNoteResult 'PENDING_LOCAL_ACK' $(if($writeFailed){'OUTBOX_WRITE_FAILED'}else{'WRITE_NOT_VERIFIED'}) $false $true $extra)
    }

    $pre=& $plan 'PRE'

    # Explicit lease order: canonical, then publisher. Contention is an explicit unacknowledged result.
    $canonicalLease=Open-CreateNoteLease $r['canonicalLease']
    if($null -eq $canonicalLease){return (New-CreateNoteResult 'REFUSED' 'CANONICAL_LOCKED')}
    $publisherLease=Open-CreateNoteLease $r['publisherLease']
    if($null -eq $publisherLease){return (New-CreateNoteResult 'REFUSED' 'PUBLISHER_LOCKED')}
    $s=& $plan 'PRE'
    $ctx.ghVerified=$true
    $info=[ordered]@{taskId=[string]$s.p.taskId;notePath=$notePath;noteSha256=$s.candidateSha;githubIssueUrl=$s.issueUrl;githubIssueNumber=$s.issueNumber}

    # Already ACKed: zero note write. Row proof and the note bytes must still match exactly.
    if($s.noteDelivered){
      $info['outboxKey']=$s.expect.note.key
      return (New-CreateNoteResult 'DELIVERED' 'REPLAY_ACKED' $true $true $info)
    }

    if($s.noteExists){
      # Exact candidate already present: only an explicit RECONCILE_MISSING admission pinned to these
      # bytes may ACK it; the note is never rewritten and an INITIAL pin never adopts an unowned file.
      if($r['recovery'] -ceq 'INITIAL'){throw 'EXPLICIT_RECOVERY_REQUIRED'}
      $phase='LOCAL_ACK'
      $info['source']='EXISTING_NOTE'
      return (& $doAck 'NOTE_ACK_RECOVERED' $info)
    }
    if($r['recovery'] -cne 'INITIAL'){throw 'RECOVERY_WITHOUT_NOTE'}

    $s=& $plan 'PRE'
    $phase='NOTE_WRITE'
    try{
      Write-CreateNoteNewFile $notePath $s.candidateBytes
    }catch{
      $msg=$_.Exception.Message
      return (New-CreateNoteResult 'PENDING' $(if($msg -cmatch '^[A-Z][A-Z0-9_]{2,63}\z'){$msg}else{'NOTE_WRITE_FAILED'}) $false $true $info)
    }
    $readOk=$false
    try{
      $readOk=([IO.File]::Exists($notePath) -and (Get-CreateNoteSha256 (Read-CreateNoteBoundedBytes $notePath)) -ceq $s.candidateSha)
    }catch{$readOk=$false}
    if(-not $readOk){return (New-CreateNoteResult 'PENDING' 'NOTE_READBACK_MISMATCH' $false $true $info)}
    $phase='LOCAL_ACK'
    return (& $doAck 'NOTE_ACK' $info)
  }catch{
    $msg=$_.Exception.Message
    $classified=($msg -cmatch '^[A-Z][A-Z0-9_]{2,63}\z')
    $status='PENDING_LOCAL_ACK'
    if($phase -ceq 'PREFLIGHT'){$status='REFUSED'}elseif($phase -ceq 'NOTE_WRITE'){$status='PENDING'}
    $extra=[ordered]@{}
    if(-not $classified){$extra['errorType']=$_.Exception.GetType().FullName}
    return (New-CreateNoteResult $status $(if($classified){$msg}else{'UNCLASSIFIED_ERROR'}) $false $ctx.ghVerified $extra)
  }finally{
    if($publisherLease){$publisherLease.Dispose()}
    if($canonicalLease){$canonicalLease.Dispose()}
  }
}
