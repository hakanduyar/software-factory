#Requires -Version 7.6
Set-StrictMode -Version Latest

# Explicit, separately host-admitted boundary: canonical UPDATE -> durable PENDING outbox rows.
# Every pin below is an argument of the host invocation; nothing inside a packet or snapshot
# grants authority. This is not an approval/review producer, watcher, scheduler or consumer call:
# it never reaches a destination, never writes a journal or receipt, and never retries.

function Get-EnqueueSha256 {
  param([string]$Path)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant()
}
function Test-EnqueueHash {
  param($Value)
  return ($Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}\z')
}
function Assert-EnqueuePath {
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
function Open-EnqueueLease {
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
function New-EnqueueResult {
  param([string]$Status,[string]$Code,[int]$Added=0,[int]$Existing=0,[string[]]$Keys=@(),[hashtable]$Extra=@{})
  $o=[ordered]@{status=$Status;code=$Code;added=$Added;existing=$Existing;keys=@($Keys)}
  foreach($k in $Extra.Keys){$o[$k]=$Extra[$k]}
  return [pscustomobject]$o
}

function Invoke-CanonicalLifecycleUpdateEnqueue {
  [CmdletBinding()]
  param(
    [string]$CanonicalPath,[string]$ExpectedCanonicalSha256,
    [string]$PacketPath,[string]$ExpectedPacketSha256,
    [string]$ConsumerPath,[string]$ExpectedConsumerSha256,
    [string]$ReconcilePath,[string]$ExpectedReconcileSha256,
    [string]$StateDir,[string]$OutboxPath,
    # $null means the outbox must be absent; a hash means that exact current byte state.
    # The parameter must be supplied explicitly, even when $null.
    [AllowNull()][object]$ExpectedOutboxSha256
  )
  $ErrorActionPreference='Stop'
  $canonicalLease=$null; $publisherLease=$null; $keyList=@()
  # Accepted historical executable closure. Dot-sourcing the reconcile executes its sibling
  # dispatch/reviewed-blocked-capture.ps1, so both are bound to these retained hashes; a
  # caller-supplied reconcile pin that differs from the accepted one is refused, never loaded.
  $acceptedReconcileSha256='a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'
  $acceptedCaptureSha256='31ba531df2b9c8caa00d80d5a5eb3034922a79da45c1fe217daeb7e3fb72a698'
  try{
    if(-not $PSBoundParameters.ContainsKey('ExpectedOutboxSha256')){throw 'OUTBOX_PIN_REQUIRED'}
    if($null -ne $ExpectedOutboxSha256 -and -not (Test-EnqueueHash $ExpectedOutboxSha256)){throw 'PIN_INVALID'}
    foreach($h in @($ExpectedCanonicalSha256,$ExpectedPacketSha256,$ExpectedConsumerSha256,$ExpectedReconcileSha256)){if(-not (Test-EnqueueHash $h)){throw 'PIN_INVALID'}}
    if($ExpectedReconcileSha256 -cne $acceptedReconcileSha256){throw 'RECONCILE_DRIFT'}

    Assert-EnqueuePath -Path $CanonicalPath -MustBeFile
    Assert-EnqueuePath -Path $PacketPath -MustBeFile
    Assert-EnqueuePath -Path $ConsumerPath -MustBeFile
    Assert-EnqueuePath -Path $ReconcilePath -MustBeFile
    # The only executable the reconcile may load, located exactly as the reconcile locates it.
    $capturePath=Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $ReconcilePath)) 'dispatch') 'reviewed-blocked-capture.ps1'
    Assert-EnqueuePath -Path $capturePath -MustBeFile
    Assert-EnqueuePath -Path $StateDir
    if(-not [IO.Directory]::Exists($StateDir)){throw 'STATE_DIR_MISSING'}
    Assert-EnqueuePath -Path $OutboxPath -Root $StateDir
    if($OutboxPath -cne (Join-Path $StateDir 'outbox.json')){throw 'OUTBOX_BINDING'}
    $publisherPath=Join-Path $StateDir 'publisher.lock'
    $canonicalLeasePath=$CanonicalPath+'.lock'
    Assert-EnqueuePath -Path ($OutboxPath+'.lock') -Root $StateDir
    Assert-EnqueuePath -Path $publisherPath -Root $StateDir
    Assert-EnqueuePath -Path $canonicalLeasePath

    $pins=@(
      @{path=$CanonicalPath;sha=$ExpectedCanonicalSha256;code='CANONICAL_DRIFT'},
      @{path=$PacketPath;sha=$ExpectedPacketSha256;code='PACKET_DRIFT'},
      @{path=$ConsumerPath;sha=$ExpectedConsumerSha256;code='CONSUMER_DRIFT'},
      @{path=$ReconcilePath;sha=$ExpectedReconcileSha256;code='RECONCILE_DRIFT'},
      @{path=$capturePath;sha=$acceptedCaptureSha256;code='CAPTURE_DRIFT'}
    )
    # Recheck of every pin and of the outbox before-state. Run again under both leases and
    # immediately before the single write.
    $verify={
      foreach($pin in $pins){
        Assert-EnqueuePath -Path $pin.path -MustBeFile
        if((Get-EnqueueSha256 $pin.path) -cne $pin.sha){throw $pin.code}
      }
      Assert-EnqueuePath -Path $OutboxPath -Root $StateDir
      if($null -eq $ExpectedOutboxSha256){
        if([IO.File]::Exists($OutboxPath) -or [IO.Directory]::Exists($OutboxPath)){throw 'OUTBOX_DRIFT'}
      } elseif(-not [IO.File]::Exists($OutboxPath) -or (Get-EnqueueSha256 $OutboxPath) -cne $ExpectedOutboxSha256){throw 'OUTBOX_DRIFT'}
    }

    # Only the pinned consumer and reconcile sources are loaded (strict readers, packet constructor,
    # Get-EventKey, Read-Outbox, Write-OutboxAtomic). Their hashes are checked before and after load.
    foreach($pin in @($pins[2],$pins[3],$pins[4])){Assert-EnqueuePath -Path $pin.path -MustBeFile; if((Get-EnqueueSha256 $pin.path) -cne $pin.sha){throw $pin.code}}
    . $ConsumerPath
    . $ReconcilePath

    # Same lease order as the consumer: canonical, then publisher.
    $canonicalLease=Open-EnqueueLease $canonicalLeasePath
    if($null -eq $canonicalLease){return (New-EnqueueResult 'REFUSED' 'CANONICAL_LOCKED')}
    $publisherLease=Open-EnqueueLease $publisherPath
    if($null -eq $publisherLease){return (New-EnqueueResult 'REFUSED' 'PUBLISHER_LOCKED')}
    & $verify

    $p=New-TaskLifecycleMirrorPacket (Read-LifecycleJson $PacketPath)
    if($p.eventType -cne 'UPDATE'){throw 'UNSUPPORTED_EVENT'}
    $c=Read-LifecycleJson $CanonicalPath
    Assert-LifecycleKeys $c @('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')
    foreach($k in @('taskId','publicTitle','publicSummary','publicStatus','nextAction')){
      if($c[$k] -isnot [string] -or $p[$k] -isnot [string] -or $c[$k] -cne $p[$k]){throw 'CANONICAL_PACKET_MISMATCH'}
    }
    if(-not ($c.canonicalRevision -is [int] -or $c.canonicalRevision -is [long]) -or [long]$c.canonicalRevision -ne [long]$p.canonicalRevision){throw 'CANONICAL_PACKET_MISMATCH'}
    # Digest serialization is the consumer's: the strict-read canonical object, compact JSON.
    $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))

    # Existing rows: Read-Outbox validates; the rows that get rewritten are parsed with
    # -DateKind String so unrelated rows are not reformatted by date conversion.
    $validated=@(); $rows=[Collections.Generic.List[object]]::new()
    if([IO.File]::Exists($OutboxPath)){
      try{
        $bytes=[IO.File]::ReadAllBytes($OutboxPath)
        if((Get-LifecycleHash $bytes) -cne $ExpectedOutboxSha256){throw 'OUTBOX_DRIFT'}
        $validated=@(Read-Outbox $OutboxPath)
        $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes).TrimStart([char]0xFEFF)
        if(-not [string]::IsNullOrWhiteSpace($text)){
          $parsed=ConvertFrom-Json -InputObject $text -NoEnumerate -DateKind String
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

    $newRows=@(); $existing=0
    foreach($dest in @('github','note')){
      $runId=$p.idempotencyKey+':'+$dest
      $key=Get-EventKey -TaskId $p.taskId -PayloadSha256 $digest -RunId $runId -Status 'AWAITING_CONTROLLER' -Attempt 0
      $keyList+=$key
      $related=@($validated | Where-Object {[string]$_.runId -ceq $runId -or [string]$_.key -ceq $key})
      if($related.Count -gt 1){throw 'EVENT_CONFLICT'}
      if($related.Count -eq 1){
        $row=$related[0]
        if([string]$row.key -cne $key -or [string]$row.taskId -cne $p.taskId -or [string]$row.payloadSha256 -cne $digest -or [string]$row.runId -cne $runId -or [string]$row.destination -cne $dest -or [string]$row.status -cne 'AWAITING_CONTROLLER' -or [int64]$row.attempt -ne 0){throw 'EVENT_CONFLICT'}
        if($row.PSObject.Properties.Name -ccontains 'retryPolicy' -and [string]$row.retryPolicy -ceq 'NO_RETRY'){throw 'EXCLUDED_NO_RETRY'}
        $existing++
      } else {
        $newRows+=[pscustomobject]@{key=$key;taskId=$p.taskId;payloadSha256=$digest;runId=$runId;destination=$dest;status='AWAITING_CONTROLLER';attempt=0;deliveryStatus='PENDING';proof=$null}
      }
    }
    if($newRows.Count -eq 0){return (New-EnqueueResult 'UNCHANGED' 'REPLAY_IDENTICAL' -Existing $existing -Keys $keyList)}

    $all=[Collections.Generic.List[object]]::new()
    foreach($x in $rows){$all.Add($x)}
    foreach($x in $newRows){$all.Add($x)}
    $final=$all.ToArray()

    & $verify
    $tmpBefore=@(Get-ChildItem -LiteralPath $StateDir -Filter 'outbox.json.tmp_*' -Force | ForEach-Object {$_.FullName})
    try{
      Write-OutboxAtomic $OutboxPath $final
    }catch{
      $errorType=$_.Exception.GetType().FullName
      # The failed writer may leave its own temporary file; remove only files that were not there before.
      foreach($f in @(Get-ChildItem -LiteralPath $StateDir -Filter 'outbox.json.tmp_*' -File -Force -ErrorAction SilentlyContinue)){
        if($tmpBefore -cnotcontains $f.FullName){try{Remove-Item -LiteralPath $f.FullName -Force}catch{}}
      }
      $state='UNKNOWN'
      try{
        if($null -eq $ExpectedOutboxSha256){$state=$(if([IO.File]::Exists($OutboxPath)){'CHANGED'}else{'UNCHANGED'})}
        else{$state=$(if([IO.File]::Exists($OutboxPath) -and (Get-EnqueueSha256 $OutboxPath) -ceq $ExpectedOutboxSha256){'UNCHANGED'}else{'CHANGED'})}
      }catch{$state='UNKNOWN'}
      return (New-EnqueueResult 'WRITE_FAILED' 'OUTBOX_WRITE_FAILED' -Existing $existing -Keys $keyList -Extra @{errorType=$errorType;outboxState=$state})
    }

    # Truthful post-condition: the writer's result is not trusted on its own.
    try{
      $after=@(Read-Outbox $OutboxPath)
      $ok=($after.Count -eq $final.Count)
      foreach($k in $keyList){if(@($after | Where-Object {[string]$_.key -ceq $k}).Count -ne 1){$ok=$false}}
    }catch{$ok=$false}
    if(-not $ok){return (New-EnqueueResult 'WRITE_FAILED' 'WRITE_NOT_VERIFIED' -Existing $existing -Keys $keyList)}
    return (New-EnqueueResult 'ENQUEUED' 'PENDING_ROWS_WRITTEN' -Added $newRows.Count -Existing $existing -Keys $keyList -Extra @{outboxSha256=(Get-EnqueueSha256 $OutboxPath)})
  }catch{
    $msg=$_.Exception.Message
    $classified=($msg -cmatch '^[A-Z][A-Z0-9_]{2,63}\z')
    $extra=@{}
    if(-not $classified){$extra['errorType']=$_.Exception.GetType().FullName}
    return (New-EnqueueResult 'REFUSED' $(if($classified){$msg}else{'UNCLASSIFIED_ERROR'}) -Keys $keyList -Extra $extra)
  }finally{
    if($publisherLease){$publisherLease.Dispose()}
    if($canonicalLease){$canonicalLease.Dispose()}
  }
}
