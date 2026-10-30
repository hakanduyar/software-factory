#Requires -Version 7.6
Set-StrictMode -Version Latest

# Explicit, separately host-admitted boundary: canonical CREATE -> one retained GitHubCreateEvent/v1
# sidecar plus durable PENDING outbox rows in the new ':create:' namespace.
# Every pin below is an argument of the host invocation; nothing inside a packet, snapshot, sidecar
# or row metadata grants authority. This is not a delivery consumer: it never reaches a destination,
# never calls a transport or the direct GitHub engine, never writes a journal, mapping, ACK or note,
# and never retries. A CREATE delivery consumer does not exist yet; ENQUEUED is not delivery.
# The sidecar and the outbox are two files, not one transaction. A failure between them leaves a
# truthful PREPARED_HANDOFF (sidecar present, rows absent) that the same exact data completes once.
# No before-state evidence is retained: replay is authenticated by the caller's CURRENT outbox pin.

function Get-CreateEnqSha256 {
  param([byte[]]$Bytes)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-CreateEnqFileSha256 {
  param([string]$Path)
  Get-CreateEnqSha256 ([IO.File]::ReadAllBytes($Path))
}
function Test-CreateEnqHash {
  param($Value)
  return ($Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}\z')
}
function Assert-CreateEnqPath {
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
function Open-CreateEnqLease {
  # Returns the exclusive stream, or $null on contention. Missing directory, access and other
  # errors are not contention and propagate unchanged.
  param([string]$Path)
  try{
    return [IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  }catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{
    throw
  }catch [IO.IOException]{
    return $null
  }
}
function New-CreateEnqResult {
  param([string]$Status,[string]$Code,[int]$Added=0,[int]$Existing=0,[string[]]$Keys=@(),[hashtable]$Extra=@{})
  $o=[ordered]@{status=$Status;code=$Code;added=$Added;existing=$Existing;keys=@($Keys)}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}
function Test-CreateEnqJsonSame {
  # Structural, order-preserving equality of two JSON elements (numbers by raw text: fail closed).
  param([Text.Json.JsonElement]$A,[Text.Json.JsonElement]$B)
  $kind=$A.ValueKind.ToString()
  if($kind -cne $B.ValueKind.ToString()){return $false}
  if($kind -ceq 'Object'){
    $pa=@($A.EnumerateObject()); $pb=@($B.EnumerateObject())
    if($pa.Count -ne $pb.Count){return $false}
    for($i=0;$i -lt $pa.Count;$i++){
      if($pa[$i].Name -cne $pb[$i].Name -or -not (Test-CreateEnqJsonSame $pa[$i].Value $pb[$i].Value)){return $false}
    }
    return $true
  }
  if($kind -ceq 'Array'){
    $ea=@($A.EnumerateArray()); $eb=@($B.EnumerateArray())
    if($ea.Count -ne $eb.Count){return $false}
    for($i=0;$i -lt $ea.Count;$i++){if(-not (Test-CreateEnqJsonSame $ea[$i] $eb[$i])){return $false}}
    return $true
  }
  if($kind -ceq 'String'){return ($A.GetString() -ceq $B.GetString())}
  if($kind -ceq 'Number'){return ($A.GetRawText() -ceq $B.GetRawText())}
  return $true
}
function Test-CreateEnqPrefix {
  # The first Count rows of Before must survive in After structurally unchanged (no normalization).
  param([string]$Before,[string]$After,[int]$Count)
  if($Count -eq 0){return $true}
  $a=$null; $b=$null
  try{
    $a=[Text.Json.JsonDocument]::Parse($Before); $b=[Text.Json.JsonDocument]::Parse($After)
    $ea=@(); $eb=@()
    if($a.RootElement.ValueKind -eq [Text.Json.JsonValueKind]::Array){$ea=@($a.RootElement.EnumerateArray())}else{$ea=@($a.RootElement)}
    if($b.RootElement.ValueKind -eq [Text.Json.JsonValueKind]::Array){$eb=@($b.RootElement.EnumerateArray())}else{$eb=@($b.RootElement)}
    if($ea.Count -lt $Count -or $eb.Count -lt $Count){return $false}
    for($i=0;$i -lt $Count;$i++){if(-not (Test-CreateEnqJsonSame $ea[$i] $eb[$i])){return $false}}
    return $true
  }finally{
    if($a){$a.Dispose()}
    if($b){$b.Dispose()}
  }
}
function Test-CreateEnqRef {
  # Exact two-key {path,sha256} reference object.
  param($Ref,[string]$Path,[string]$Sha)
  if($Ref -isnot [System.Management.Automation.PSCustomObject]){return $false}
  $n=@($Ref.PSObject.Properties.Name)
  if($n.Count -ne 2 -or $n -cnotcontains 'path' -or $n -cnotcontains 'sha256'){return $false}
  return ($Ref.path -is [string] -and $Ref.path -ceq $Path -and $Ref.sha256 -is [string] -and $Ref.sha256 -ceq $Sha)
}
function Assert-CreateEnqOwnRow {
  # An existing row in this event's CREATE namespace must be exactly the supported shape: the nine
  # reader fields plus the four CREATE metadata keys. PENDING needs null proof; DELIVERED is kept
  # as is. NO_RETRY is an exclusion, never a success.
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
  if(-not (Test-CreateEnqRef $Row.canonicalRef $Refs.canonical.path $Refs.canonical.sha256) -or
     -not (Test-CreateEnqRef $Row.packetRef $Refs.packet.path $Refs.packet.sha256) -or
     -not (Test-CreateEnqRef $Row.createEventRef $Refs.event.path $Refs.event.sha256)){throw 'EVENT_CONFLICT'}
}

function Invoke-CanonicalLifecycleCreateEnqueue {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$TaskId,
    [Parameter(Mandatory)][AllowNull()]$CanonicalRevision,
    [Parameter(Mandatory)][AllowEmptyString()][string]$CanonicalPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedCanonicalSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$PacketPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedPacketSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ConsumerPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedConsumerSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ReconcilePath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedReconcileSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedCaptureSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$StateDir,
    [Parameter(Mandatory)][AllowEmptyString()][string]$OutboxPath,
    # $null means the outbox must be absent; a hash means that exact current byte state.
    # The parameter must be supplied explicitly, even when $null.
    [AllowNull()][object]$ExpectedOutboxSha256
  )
  $ErrorActionPreference='Stop'
  $canonicalLease=$null; $publisherLease=$null; $keyList=@(); $tmpEvent=$null
  $handoff=$null; $handoffRef=$null
  # Same ceiling the consumer's strict JSON reader applies to its inputs; also bounds every
  # artifact this boundary writes, so nothing written here is unreadable by the same rules.
  $maxBytes=1048576
  # Accepted historical executable closure (same retained hashes the UPDATE boundary binds).
  $acceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'
  $acceptedCaptureSha256='31ba531df2b9c8caa00d80d5a5eb3034922a79da45c1fe217daeb7e3fb72a698'
  try{
    if(-not $PSBoundParameters.ContainsKey('ExpectedOutboxSha256')){throw 'OUTBOX_PIN_REQUIRED'}
    if($null -ne $ExpectedOutboxSha256 -and -not (Test-CreateEnqHash $ExpectedOutboxSha256)){throw 'PIN_INVALID'}
    foreach($h in @($ExpectedCanonicalSha256,$ExpectedPacketSha256,$ExpectedConsumerSha256,$ExpectedReconcileSha256,$ExpectedCaptureSha256)){if(-not (Test-CreateEnqHash $h)){throw 'PIN_INVALID'}}
    if($ExpectedReconcileSha256 -cne $acceptedReconcileSha256){throw 'RECONCILE_DRIFT'}
    if($ExpectedCaptureSha256 -cne $acceptedCaptureSha256){throw 'CAPTURE_DRIFT'}
    if($TaskId -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z'){throw 'TASK_INVALID'}
    if(-not ($CanonicalRevision -is [int] -or $CanonicalRevision -is [long]) -or $CanonicalRevision -lt 1){throw 'REVISION_INVALID'}

    foreach($f in @($CanonicalPath,$PacketPath,$ConsumerPath,$ReconcilePath)){Assert-CreateEnqPath -Path $f -MustBeFile}
    # The only executable the reconcile may load, located exactly as the reconcile locates it.
    $capturePath=Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $ReconcilePath)) 'dispatch') 'reviewed-blocked-capture.ps1'
    Assert-CreateEnqPath -Path $capturePath -MustBeFile
    Assert-CreateEnqPath -Path $StateDir
    if(-not [IO.Directory]::Exists($StateDir)){throw 'STATE_DIR_MISSING'}
    Assert-CreateEnqPath -Path $OutboxPath -Root $StateDir
    if($OutboxPath -cne (Join-Path $StateDir 'outbox.json')){throw 'OUTBOX_BINDING'}
    $publisherPath=Join-Path $StateDir 'publisher.lock'
    $canonicalLeasePath=$CanonicalPath+'.lock'
    Assert-CreateEnqPath -Path ($OutboxPath+'.lock') -Root $StateDir
    Assert-CreateEnqPath -Path $publisherPath -Root $StateDir
    Assert-CreateEnqPath -Path $canonicalLeasePath

    $pins=@(
      @{path=$CanonicalPath;sha=$ExpectedCanonicalSha256;code='CANONICAL_DRIFT'},
      @{path=$PacketPath;sha=$ExpectedPacketSha256;code='PACKET_DRIFT'},
      @{path=$ConsumerPath;sha=$ExpectedConsumerSha256;code='CONSUMER_DRIFT'},
      @{path=$ReconcilePath;sha=$ExpectedReconcileSha256;code='RECONCILE_DRIFT'},
      @{path=$capturePath;sha=$acceptedCaptureSha256;code='CAPTURE_DRIFT'}
    )
    # Recheck of every pin and, optionally, the outbox before-state (the caller's compare-and-set).
    $verify={
      param([bool]$CheckOutbox=$true)
      foreach($pin in $pins){
        Assert-CreateEnqPath -Path $pin.path -MustBeFile
        if((Get-CreateEnqFileSha256 $pin.path) -cne $pin.sha){throw $pin.code}
      }
      if($CheckOutbox){
        Assert-CreateEnqPath -Path $OutboxPath -Root $StateDir
        if($null -eq $ExpectedOutboxSha256){
          if([IO.File]::Exists($OutboxPath) -or [IO.Directory]::Exists($OutboxPath)){throw 'OUTBOX_DRIFT'}
        } elseif(-not [IO.File]::Exists($OutboxPath) -or (Get-CreateEnqFileSha256 $OutboxPath) -cne $ExpectedOutboxSha256){throw 'OUTBOX_DRIFT'}
      }
    }

    # Only the pinned consumer and reconcile sources are loaded; hashes are checked before and after.
    & $verify $false
    . $ConsumerPath
    . $ReconcilePath
    & $verify $false
    foreach($fn in @('New-TaskLifecycleMirrorPacket','Read-LifecycleJson','Assert-LifecycleKeys','Get-LifecycleHash','Get-LifecycleFileHash','Read-Outbox','Get-EventKey','Write-OutboxAtomic')){
      if(-not (Get-Command -Name $fn -ErrorAction SilentlyContinue)){throw 'IMPORT_INCOMPLETE'}
    }

    # Read-only planning. Everything that can be refused is refused here, before any lease file,
    # directory, sidecar or outbox exists. Run once without leases and again under both leases.
    $plan={
      & $verify $true
      $p=New-TaskLifecycleMirrorPacket (Read-LifecycleJson $PacketPath)
      if($p.eventType -cne 'CREATE'){throw 'UNSUPPORTED_EVENT'}
      $c=Read-LifecycleJson $CanonicalPath
      Assert-LifecycleKeys $c @('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')
      foreach($k in @('taskId','publicTitle','publicSummary','publicStatus','nextAction')){
        if($c[$k] -isnot [string] -or $p[$k] -isnot [string] -or $c[$k] -cne $p[$k]){throw 'CANONICAL_PACKET_MISMATCH'}
      }
      if(-not ($c.canonicalRevision -is [int] -or $c.canonicalRevision -is [long]) -or [long]$c.canonicalRevision -ne [long]$p.canonicalRevision){throw 'CANONICAL_PACKET_MISMATCH'}
      if($p.taskId -cne $TaskId -or [long]$p.canonicalRevision -ne [long]$CanonicalRevision){throw 'IDENTITY_MISMATCH'}
      $id=$p.idempotencyKey
      # The packet grammar allows ':'; a directory segment must not.
      if($id -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?\z'){throw 'IDEMPOTENCY_KEY_UNSAFE'}
      # Digest serialization is the existing boundary's: the strict-read canonical object, compact JSON.
      $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))

      # Deterministic seven-field GitHubCreateEvent/v1, projected from the canonical snapshot only.
      $eventDir=Join-Path $StateDir ('canonical-create-'+$id)
      $eventPath=Join-Path $eventDir 'event.json'
      Assert-CreateEnqPath -Path $eventDir -Root $StateDir
      Assert-CreateEnqPath -Path $eventPath -Root $StateDir
      if([IO.File]::Exists($eventDir) -or [IO.Directory]::Exists($eventPath)){throw 'SIDECAR_CONFLICT'}
      $ev=[ordered]@{schema='GitHubCreateEvent/v1';taskId=[string]$c.taskId;canonicalVersion=[long]$c.canonicalRevision;publicTitle=[string]$c.publicTitle;publicSummary=[string]$c.publicSummary;publicStatus=[string]$c.publicStatus;nextAction=[string]$c.nextAction}
      $evBytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $ev -Compress))
      if($evBytes.Length -gt $maxBytes){throw 'SIDECAR_TOO_LARGE'}
      $evSha=Get-LifecycleHash $evBytes
      $sidecarExists=[IO.File]::Exists($eventPath)
      if($sidecarExists -and ([IO.FileInfo]::new($eventPath).Length -ne $evBytes.Length -or (Get-LifecycleFileHash $eventPath) -cne $evSha)){throw 'SIDECAR_CONFLICT'}
      $refs=@{
        canonical=@{path=$CanonicalPath;sha256=$ExpectedCanonicalSha256}
        packet=@{path=$PacketPath;sha256=$ExpectedPacketSha256}
        event=@{path=$eventPath;sha256=$evSha}
      }

      # Existing outbox: Read-Outbox validates; rows that get rewritten are parsed with
      # -DateKind String so unrelated rows are not reformatted by date conversion.
      $rows=[Collections.Generic.List[object]]::new(); $origText=''
      if([IO.File]::Exists($OutboxPath)){
        try{
          $bytes=[IO.File]::ReadAllBytes($OutboxPath)
          if((Get-LifecycleHash $bytes) -cne $ExpectedOutboxSha256){throw 'OUTBOX_DRIFT'}
          $validated=@(Read-Outbox $OutboxPath)
          $origText=[Text.UTF8Encoding]::new($false,$true).GetString($bytes).TrimStart([char]0xFEFF)
          if(-not [string]::IsNullOrWhiteSpace($origText)){
            $parsed=ConvertFrom-Json -InputObject $origText -NoEnumerate -DateKind String
            if($parsed -isnot [array]){$parsed=@($parsed)}
            foreach($x in $parsed){$rows.Add($x)}
          }
          if($rows.Count -ne $validated.Count){throw 'OUTBOX_INVALID'}
          for($i=0;$i -lt $rows.Count;$i++){if([string]$rows[$i].key -cne [string]$validated[$i].key){throw 'OUTBOX_INVALID'}}
        }catch{
          if($_.Exception.Message -ceq 'OUTBOX_DRIFT'){throw 'OUTBOX_DRIFT'}
          throw 'OUTBOX_INVALID'
        }
      }

      $newRows=@(); $existing=0; $keys=@(); $expect=@{}
      foreach($dest in @('github','note')){
        $runId=$id+':create:'+$dest
        $key=Get-EventKey -TaskId $p.taskId -PayloadSha256 $digest -RunId $runId -Status 'AWAITING_CONTROLLER' -Attempt 0
        $keys+=$key
        $expect[$dest]=@{key=$key;taskId=$p.taskId;digest=$digest;runId=$runId;dest=$dest}
        $related=@($rows | Where-Object {[string]$_.runId -ceq $runId -or [string]$_.key -ceq $key})
        if($related.Count -gt 1){throw 'EVENT_CONFLICT'}
        if($related.Count -eq 1){
          Assert-CreateEnqOwnRow $related[0] $expect[$dest] $refs
          $existing++
        } else {
          $newRows+=[pscustomobject][ordered]@{
            key=$key;taskId=$p.taskId;payloadSha256=$digest;runId=$runId;destination=$dest;status='AWAITING_CONTROLLER';attempt=0;deliveryStatus='PENDING';proof=$null
            eventType='CREATE'
            canonicalRef=[pscustomobject][ordered]@{path=$CanonicalPath;sha256=$ExpectedCanonicalSha256}
            packetRef=[pscustomobject][ordered]@{path=$PacketPath;sha256=$ExpectedPacketSha256}
            createEventRef=[pscustomobject][ordered]@{path=$eventPath;sha256=$evSha}
          }
        }
      }

      # Every size bound is checked on the actual serialization before the first write.
      $final=$null; $finalJson=$null
      if($newRows.Count -gt 0){
        $all=[Collections.Generic.List[object]]::new()
        foreach($x in $rows){$all.Add($x)}
        foreach($x in $newRows){$all.Add($x)}
        $final=$all.ToArray()
        $finalJson=ConvertTo-Json -InputObject @($final) -Depth 10
        if([Text.UTF8Encoding]::new($false).GetByteCount($finalJson) -gt $maxBytes){throw 'OUTBOX_TOO_LARGE'}
        if(-not (Test-CreateEnqPrefix $origText $finalJson $rows.Count)){throw 'OUTBOX_ROUNDTRIP_DRIFT'}
      }
      return @{keys=$keys;existing=$existing;newRows=$newRows;final=$final;rows=$rows;origText=$origText;refs=$refs;expect=$expect
               eventDir=$eventDir;eventPath=$eventPath;evBytes=$evBytes;evSha=$evSha}
    }
    $pre=& $plan
    $keyList=@($pre.keys)

    # Same lease order as the existing boundaries: canonical, then publisher. Never nested calls.
    $canonicalLease=Open-CreateEnqLease $canonicalLeasePath
    if($null -eq $canonicalLease){return (New-CreateEnqResult 'REFUSED' 'CANONICAL_LOCKED')}
    $publisherLease=Open-CreateEnqLease $publisherPath
    if($null -eq $publisherLease){return (New-CreateEnqResult 'REFUSED' 'PUBLISHER_LOCKED')}
    $s=& $plan
    $keyList=@($s.keys)
    $eventRef=[pscustomobject][ordered]@{path=$s.eventPath;sha256=$s.evSha}

    # Sidecar: create-new only, never overwritten. A temp file moved without overwrite means a
    # reader never sees a partial event.json and an existing different file is never replaced.
    $sidecarCreated=$false
    if(-not [IO.File]::Exists($s.eventPath)){
      [void][IO.Directory]::CreateDirectory($s.eventDir)
      Assert-CreateEnqPath -Path $s.eventDir -Root $StateDir
      $tmpEvent=Join-Path $s.eventDir ('event.json.tmp-'+[guid]::NewGuid().ToString('N'))
      $fs=[IO.File]::Open($tmpEvent,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try{$fs.Write($s.evBytes,0,$s.evBytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
      try{
        [IO.File]::Move($tmpEvent,$s.eventPath,$false)
        $sidecarCreated=$true
        $handoff='PREPARED_HANDOFF'; $handoffRef=$eventRef
      }catch [IO.IOException]{
        if(-not [IO.File]::Exists($s.eventPath) -or (Get-LifecycleFileHash $s.eventPath) -cne $s.evSha){throw 'SIDECAR_CONFLICT'}
      }
      if([IO.File]::Exists($tmpEvent)){[IO.File]::Delete($tmpEvent)}
      $tmpEvent=$null
    }
    if((Get-LifecycleFileHash $s.eventPath) -cne $s.evSha){throw 'SIDECAR_READBACK_FAILED'}

    if($s.newRows.Count -eq 0){
      & $verify $true
      $cur=$null; if([IO.File]::Exists($OutboxPath)){$cur=Get-CreateEnqFileSha256 $OutboxPath}
      if($sidecarCreated){
        return (New-CreateEnqResult 'ENQUEUED' 'SIDECAR_RESTORED' -Added 0 -Existing $s.existing -Keys $keyList -Extra @{createEventRef=$eventRef;outboxSha256=$cur;sidecarCreated=$true;delivery='NOT_ATTEMPTED'})
      }
      return (New-CreateEnqResult 'UNCHANGED' 'REPLAY_IDENTICAL' -Existing $s.existing -Keys $keyList -Extra @{createEventRef=$eventRef;outboxSha256=$cur;sidecarCreated=$false;delivery='NOT_ATTEMPTED'})
    }

    # Compare-and-set recheck immediately before the single outbox write.
    & $verify $true
    try{
      Write-OutboxAtomic $OutboxPath $s.final
    }catch{
      $errorType=$_.Exception.GetType().FullName
      # Temporary files the shared writer may leave are not provably owned by this invocation
      # (the writer uses its own outbox.lock), so none are deleted here.
      $state='UNKNOWN'
      try{
        if($null -eq $ExpectedOutboxSha256){$state=$(if([IO.File]::Exists($OutboxPath)){'CHANGED'}else{'UNCHANGED'})}
        else{$state=$(if([IO.File]::Exists($OutboxPath) -and (Get-CreateEnqFileSha256 $OutboxPath) -ceq $ExpectedOutboxSha256){'UNCHANGED'}else{'CHANGED'})}
      }catch{$state='UNKNOWN'}
      $ex=@{errorType=$errorType;outboxState=$state;createEventRef=$eventRef;delivery='NOT_ATTEMPTED'}
      if($state -ceq 'UNCHANGED'){$ex['handoff']='PREPARED_HANDOFF'}
      return (New-CreateEnqResult 'WRITE_FAILED' 'OUTBOX_WRITE_FAILED' -Existing $s.existing -Keys $keyList -Extra $ex)
    }

    # Truthful post-condition: the writer's result is not trusted on its own.
    $ok=$false
    try{
      $after=@(Read-Outbox $OutboxPath)
      $afterText=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($OutboxPath)).TrimStart([char]0xFEFF)
      $afterRows=ConvertFrom-Json -InputObject $afterText -NoEnumerate -DateKind String
      if($afterRows -isnot [array]){$afterRows=@($afterRows)}
      $ok=($after.Count -eq $s.final.Count -and $afterRows.Count -eq $s.final.Count -and (Test-CreateEnqPrefix $s.origText $afterText $s.rows.Count))
      foreach($dest in @('github','note')){
        $x=$s.expect[$dest]
        $match=@($afterRows | Where-Object {[string]$_.key -ceq $x.key})
        if($match.Count -ne 1){$ok=$false; continue}
        Assert-CreateEnqOwnRow $match[0] $x $s.refs
      }
      & $verify $false
      if((Get-LifecycleFileHash $s.eventPath) -cne $s.evSha){$ok=$false}
    }catch{$ok=$false}
    if(-not $ok){
      return (New-CreateEnqResult 'WRITE_FAILED' 'WRITE_NOT_VERIFIED' -Existing $s.existing -Keys $keyList -Extra @{createEventRef=$eventRef;delivery='NOT_ATTEMPTED'})
    }
    $handoff=$null
    return (New-CreateEnqResult 'ENQUEUED' 'PENDING_ROWS_WRITTEN' -Added $s.newRows.Count -Existing $s.existing -Keys $keyList -Extra @{createEventRef=$eventRef;outboxSha256=(Get-CreateEnqFileSha256 $OutboxPath);sidecarCreated=$sidecarCreated;delivery='NOT_ATTEMPTED'})
  }catch{
    $msg=$_.Exception.Message
    $classified=($msg -cmatch '^[A-Z][A-Z0-9_]{2,63}\z')
    $extra=@{}
    if(-not $classified){$extra['errorType']=$_.Exception.GetType().FullName}
    # A sidecar this run created stays on disk; say so instead of implying rollback.
    if($null -ne $handoff){$extra['handoff']=$handoff; $extra['createEventRef']=$handoffRef}
    return (New-CreateEnqResult 'REFUSED' $(if($classified){$msg}else{'UNCLASSIFIED_ERROR'}) -Keys $keyList -Extra $extra)
  }finally{
    if($null -ne $tmpEvent -and [IO.File]::Exists($tmpEvent)){try{[IO.File]::Delete($tmpEvent)}catch{}}
    if($publisherLease){$publisherLease.Dispose()}
    if($canonicalLease){$canonicalLease.Dispose()}
  }
}
