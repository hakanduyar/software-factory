#Requires -Version 7.6
Set-StrictMode -Version Latest
$script:LifecycleConsumerSource = $PSCommandPath

function Get-LifecycleHash {
  param([byte[]]$Bytes)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-LifecycleFileHash { param([string]$Path) Get-LifecycleHash ([IO.File]::ReadAllBytes($Path)) }
function Read-LifecycleJson {
  param([string]$Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -gt 1048576) { throw 'INPUT_TOO_LARGE' }
  $text = [Text.UTF8Encoding]::new($false,$true).GetString($bytes)
  $doc = [Text.Json.JsonDocument]::Parse($text)
  try {
    # Reject duplicate names at every depth before ConvertFrom-Json normalizes them.
    $visit = { param($el)
      if ($el.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
        $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach($pr in $el.EnumerateObject()) { if(-not $seen.Add($pr.Name)){throw 'DUPLICATE_FIELD'}; & $visit $pr.Value }
      } elseif($el.ValueKind -eq [Text.Json.JsonValueKind]::Array) { foreach($v in $el.EnumerateArray()){ & $visit $v } }
    }
    & $visit $doc.RootElement
  } finally { $doc.Dispose() }
  $text | ConvertFrom-Json -AsHashtable -DateKind String
}
function Assert-LifecycleKeys {
  param($Object,[string[]]$Keys)
  if($Object -isnot [hashtable] -or $Object.Count -ne $Keys.Count){throw 'FIELDS_INVALID'}
  foreach($k in $Keys){if(-not $Object.ContainsKey($k) -or @($Object.Keys) -cnotcontains $k){throw 'FIELDS_INVALID'}}
}
function Assert-LifecyclePath {
  param([string]$Path,[string]$Root)
  if(-not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path){throw 'PATH_INVALID'}
  if($Root -and -not $Path.StartsWith(($Root.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar),[StringComparison]::Ordinal)){throw 'PATH_OUTSIDE_OWNER'}
  $cur=$Path
  while($cur){ if((Test-Path -LiteralPath $cur) -and [IO.File]::GetAttributes($cur).HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'REPARSE_REFUSED'}; $cur=[IO.Path]::GetDirectoryName($cur) }
}
function Assert-LifecyclePin {
  param($Ref)
  Assert-LifecycleKeys $Ref @('path','sha256')
  Assert-LifecyclePath $Ref.path ''
  if($Ref.sha256 -isnot [string] -or $Ref.sha256 -cnotmatch '^[0-9a-f]{64}\z' -or (Get-LifecycleFileHash $Ref.path) -cne $Ref.sha256){throw 'PIN_DRIFT'}
}
function New-TaskLifecycleMirrorPacket {
  # Structural validation only. Neither this constructor nor a JSON review
  # grants native platform approval. The exact host invocation must be admitted
  # separately, following execute-reviewed-publication's external boundary.
  param([Parameter(Mandatory)][hashtable]$Fields)
  Assert-LifecycleKeys $Fields @('schema','taskId','canonicalRevision','eventType','idempotencyKey','publicTitle','publicSummary','publicStatus','nextAction','destinations')
  if($Fields.schema -cne 'TaskLifecycleMirrorPacket/v1' -or $Fields.taskId -isnot [string] -or $Fields.taskId -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z' -or
     $Fields.idempotencyKey -isnot [string] -or $Fields.idempotencyKey -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z' -or
     -not ($Fields.canonicalRevision -is [int] -or $Fields.canonicalRevision -is [long]) -or $Fields.canonicalRevision -lt 1 -or
     $Fields.eventType -cnotin @('CREATE','UPDATE','COMPLETE') -or $Fields.publicStatus -cnotin @('IN_PROGRESS','WAITING_FOR_REVIEW','BLOCKED','ACCEPTED_SCOPED') -or
     $Fields.nextAction -cnotin @('RUN_FOCUSED_CHECKS','INDEPENDENT_REVIEW','RESUME_AUTHORIZED_WORK','WAIT_FOR_DEPENDENCY')){throw 'PACKET_INVALID'}
  if($Fields.destinations -isnot [array] -or $Fields.destinations.Count -ne 2 -or $Fields.destinations[0] -cne 'github' -or $Fields.destinations[1] -cne 'note'){throw 'DESTINATIONS_INVALID'}
  $cred='(?i)sk-[A-Za-z0-9]{8}|ghp|github pat|access token|refresh token|oauth token|bearer|password|secret|api key|(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])|\.factory-data|\b(?:windows|users|home)\b'
  foreach($item in @(@($Fields.publicTitle,1,160),@($Fields.publicSummary,0,512))){
    $s=$item[0]
    if($s -isnot [string] -or $s.Length -lt $item[1] -or $s.Length -gt $item[2] -or $s -cnotmatch '^[\p{L}\p{Nd} .,()-]*\z' -or $s -cmatch '^ | \z' -or $s -match $cred){throw 'PUBLIC_TEXT_INVALID'}
    [void][Text.UTF8Encoding]::new($false,$true).GetBytes($s)
  }
  return $Fields
}
function Get-LifecycleRegion {
  param($Packet)
  "<!-- factory-task-status:start -->`nTask: $($Packet.taskId)`nVersion: $($Packet.canonicalRevision)`nStatus: $($Packet.publicStatus)`nNext action: $($Packet.nextAction)`nSummary: $($Packet.publicSummary)`n<!-- factory-task-status:end -->"
}
function Set-LifecycleRegion {
  param([string]$Body,[string]$TaskId,[string]$Region)
  $marker='<!-- factory-task-'+(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($TaskId)))+' -->'
  $rx='(?m)^<!-- factory-task-status:start -->\nTask: '+[regex]::Escape($TaskId)+'\n[^\r]*?\n<!-- factory-task-status:end -->(?=\n|\z)'
  if($Body.Contains("`r") -or [regex]::Matches($Body,[regex]::Escape($marker)).Count -ne 1 -or
     [regex]::Matches($Body,'<!-- factory-task-status:start -->').Count -ne 1 -or [regex]::Matches($Body,'<!-- factory-task-status:end -->').Count -ne 1){throw 'BODY_OWNERSHIP'}
  $m=[regex]::Matches($Body,$rx)
  if($m.Count -ne 1 -or $Body.IndexOf($marker,[StringComparison]::Ordinal) -gt $m[0].Index){throw 'BODY_OWNERSHIP'}
  $Body.Substring(0,$m[0].Index)+$Region+$Body.Substring($m[0].Index+$m[0].Length)
}
function Set-LifecycleNoteFields {
  param([string]$Before,$Packet,$Mapping)
  # Existing notes own only these generated header fields inside their task
  # markers. H1, frozen acceptance criteria and prose are byte preserved.
  $nl=if($Before.Contains("`r`n")){"`r`n"}else{"`n"}
  if($Before.Replace($nl,'').Contains("`r") -or $Before.Replace($nl,'').Contains("`n")){throw 'NOTE_NEWLINES_INVALID'}
  $start='<!-- factory-task:'+$Packet.taskId+':start -->';$end='<!-- factory-task:'+$Packet.taskId+':end -->'
  if([regex]::Matches($Before,[regex]::Escape($start)).Count -ne 1 -or [regex]::Matches($Before,[regex]::Escape($end)).Count -ne 1){throw 'NOTE_OWNERSHIP'}
  $startIndex=$Before.IndexOf($start,[StringComparison]::Ordinal);$endIndex=$Before.IndexOf($end,[StringComparison]::Ordinal)
  if($startIndex -ge $endIndex -or ($startIndex -gt 0 -and $Before.Substring(0,$startIndex).EndsWith($nl) -ne $true)){throw 'NOTE_OWNERSHIP'}
  $offset=$startIndex+$start.Length+$nl.Length
  if($Before.Substring($startIndex+$start.Length,$nl.Length) -cne $nl){throw 'NOTE_OWNERSHIP'}
  if(-not $Before.Substring(0,$endIndex).EndsWith($nl,[StringComparison]::Ordinal) -or ($Before.Length -gt ($endIndex+$end.Length) -and -not $Before.Substring($endIndex+$end.Length).StartsWith($nl,[StringComparison]::Ordinal))){throw 'NOTE_OWNERSHIP'}
  $rest=$Before.Substring($offset,$endIndex-$offset);$lines=$rest.Split(@($nl),[StringSplitOptions]::None)
  if($lines.Count -lt 8 -or $lines[0] -cne ('Task: '+$Packet.taskId) -or $lines[1] -cnotmatch '^Status: (IN_PROGRESS|WAITING_FOR_REVIEW|BLOCKED|ACCEPTED_SCOPED)\z' -or $lines[2] -cne ('GitHub: '+$Mapping.url) -or $lines[3] -cne 'Issue state: OPEN' -or $lines[5] -cnotmatch '^Next action: (RUN_FOCUSED_CHECKS|INDEPENDENT_REVIEW|RESUME_AUTHORIZED_WORK|WAIT_FOR_DEPENDENCY)\z'){throw 'NOTE_OWNERSHIP'}
  if($lines[4] -cne ('Canonical version: '+$Mapping.canonicalRevision)){throw 'NOTE_VERSION_MISMATCH'}
  $headerCount=6
  if($lines[6].StartsWith('Title: ',[StringComparison]::Ordinal)){
    if($lines.Count -lt 10 -or -not $lines[7].StartsWith('Summary: ',[StringComparison]::Ordinal)){throw 'NOTE_OWNERSHIP'}
    $old=$Packet.Clone();$old.publicTitle=$lines[6].Substring(7);$old.publicSummary=$lines[7].Substring(9)
    [void](New-TaskLifecycleMirrorPacket $old);$headerCount=8
  }
  if($lines[$headerCount] -cne ''){throw 'NOTE_OWNERSHIP'}
  foreach($name in @('Task','Status','GitHub','Issue state','Canonical version','Next action','Title','Summary')){
    $count=@($lines|Where-Object {$_.StartsWith(($name+': '),[StringComparison]::Ordinal)}).Count
    $expected=if($name -cin @('Title','Summary') -and $headerCount -eq 6){0}else{1}
    if($count -ne $expected){throw 'NOTE_DUPLICATE_FIELD'}
  }
  $oldHeader=($lines[0..($headerCount-1)] -join $nl)
  $newHeader=@(('Task: '+$Packet.taskId),('Status: '+$Packet.publicStatus),('GitHub: '+$Mapping.url),'Issue state: OPEN',('Canonical version: '+$Packet.canonicalRevision),('Next action: '+$Packet.nextAction),('Title: '+$Packet.publicTitle),('Summary: '+$Packet.publicSummary)) -join $nl
  $Before.Substring(0,$offset)+$newHeader+$Before.Substring($offset+$oldHeader.Length)
}
function Write-LifecycleAtomic {
  param([string]$Path,[byte[]]$Bytes)
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  try {
    $fs=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$fs.Write($Bytes,0,$Bytes.Length); $fs.Flush($true)}finally{$fs.Dispose()}
    [IO.File]::Move($tmp,$Path,$true)
  } finally {if([IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)}}
}
function Get-LifecycleTransportDiagnostic {
  # Re-validates the transport's typed failure diagnostic; malformed is omitted.
  param($Result)
  try {
    if ($null -ne $Result -and $Result.PSObject.Properties.Name -ccontains 'diagnostic' -and (Test-GitHubCliFailureDiagnostic216 $Result.diagnostic)) { return $Result.diagnostic }
  } catch { }
  return $null
}
# Durable failure vocabulary. Each phase fixes its destination/operation; each code
# is valid only in the listed phases. These sets are the only values ever persisted.
$script:LifecycleFailurePhases = [ordered]@{
  INITIAL_READ=@{destination='github';operation='READ'}
  EDIT=@{destination='github';operation='EDIT'}
  EDIT_READBACK=@{destination='github';operation='READ'}
  NOTE_PRECHECK=@{destination='note';operation='READ'}
  NOTE_WRITE=@{destination='note';operation='WRITE'}
  NOTE_READBACK=@{destination='note';operation='READ'}
}
$script:LifecycleFailureCodes = [ordered]@{
  GITHUB_READ_FAILED=@('INITIAL_READ','EDIT_READBACK')
  EDIT_AMBIGUOUS_NO_RETRY=@('EDIT')
  EDIT_READBACK_FAILED=@('EDIT_READBACK')
  NOTE_DRIFT=@('NOTE_PRECHECK')
  NOTE_WRITE_FAILED=@('NOTE_WRITE')
  NOTE_READBACK_FAILED=@('NOTE_READBACK')
  UNKNOWN=@('INITIAL_READ','EDIT','EDIT_READBACK','NOTE_PRECHECK','NOTE_WRITE','NOTE_READBACK')
}
function Test-LifecycleFailureRecord {
  # Exact LifecycleUpdateFailure/v1 shape; a valid record never grants permission.
  param($Record)
  try {
    if ($Record -isnot [hashtable] -or $Record.Count -ne 6) { return $false }
    foreach ($k in @('schema','code','phase','destination','operation','diagnostic')) { if (@($Record.Keys) -cnotcontains $k) { return $false } }
    foreach ($k in @('schema','code','phase','destination','operation')) { if ($Record[$k] -isnot [string]) { return $false } }
    if ($Record.schema -cne 'LifecycleUpdateFailure/v1') { return $false }
    if (@($script:LifecycleFailurePhases.Keys) -cnotcontains $Record.phase -or @($script:LifecycleFailureCodes.Keys) -cnotcontains $Record.code) { return $false }
    if ($script:LifecycleFailureCodes[$Record.code] -cnotcontains $Record.phase) { return $false }
    $shape = $script:LifecycleFailurePhases[$Record.phase]
    if ($Record.destination -cne $shape.destination -or $Record.operation -cne $shape.operation) { return $false }
    if ($null -eq $Record.diagnostic) { return $true }
    if ($Record.code -cnotin @('GITHUB_READ_FAILED','EDIT_AMBIGUOUS_NO_RETRY') -or $Record.diagnostic -isnot [hashtable] -or $Record.diagnostic.Count -ne 5) { return $false }
    return [bool](Test-GitHubCliFailureDiagnostic216 ([pscustomobject]$Record.diagnostic))
  } catch { return $false }
}
function New-LifecycleFailureRecord {
  # Maps only to the allowlists above. The raw message is never copied: a message
  # outside the allowlist becomes NOTE_WRITE_FAILED for a note write, else UNKNOWN.
  param([string]$Message,[string]$Phase,$Diagnostic)
  $code = 'UNKNOWN'
  if ($Message -cne 'UNKNOWN' -and @($script:LifecycleFailureCodes.Keys) -ccontains $Message -and $script:LifecycleFailureCodes[$Message] -ccontains $Phase) { $code = $Message }
  elseif ($Phase -ceq 'NOTE_WRITE') { $code = 'NOTE_WRITE_FAILED' }
  $shape = $script:LifecycleFailurePhases[$Phase]
  $diag = $null
  if ($code -cin @('GITHUB_READ_FAILED','EDIT_AMBIGUOUS_NO_RETRY') -and $null -ne $Diagnostic -and (Test-GitHubCliFailureDiagnostic216 $Diagnostic)) {
    $diag = @{category=[string]$Diagnostic.category;exitCode=[int]$Diagnostic.exitCode;timedOut=[bool]$Diagnostic.timedOut;stderrTruncated=[bool]$Diagnostic.stderrTruncated;stderrEncoding=[string]$Diagnostic.stderrEncoding}
  }
  $rec = @{schema='LifecycleUpdateFailure/v1';code=$code;phase=$Phase;destination=[string]$shape.destination;operation=[string]$shape.operation;diagnostic=$diag}
  if (-not (Test-LifecycleFailureRecord $rec)) { throw 'FAILURE_RECORD_INVALID' }
  return $rec
}
function Invoke-AdmittedTaskLifecycleUpdate {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ReleasePath,
    [Parameter(Mandatory)][string]$ExpectedReleaseSha256,
    [Parameter(Mandatory)][string]$ExpectedReviewSha256,
    [Parameter(Mandatory)][string]$ExpectedNativeRequestSha256,
    [Parameter(Mandatory)][string]$ReconcilePath,
    [scriptblock]$ProcessRunner
  )
  # These exact pins are arguments of the separately native-approved invocation,
  # not an API which issues approval. There is deliberately no approved boolean,
  # review producer, scheduler, or automatic retry here. ProcessRunner is an
  # external connector seam; production omits it and uses bounded gh execution.
  $ErrorActionPreference='Stop'; $canonicalLease=$null; $publisherLease=$null
  $phase='PREFLIGHT'; $code='INPUT_INVALID'; $diagBox=@{v=$null}
  # $op.phase is set only while an admitted destination operation is in flight; a
  # durable failure record is written only for a failure raised during one.
  $op=@{phase=$null}; $r=$null; $j=$null; $e=$null
  try {
    foreach($h in @($ExpectedReleaseSha256,$ExpectedReviewSha256,$ExpectedNativeRequestSha256)){if($h -cnotmatch '^[0-9a-f]{64}\z'){throw 'ADMISSION_PIN_MISSING'}}
    Assert-LifecyclePath $ReleasePath ''
    if((Get-LifecycleFileHash $ReleasePath) -cne $ExpectedReleaseSha256){throw 'RELEASE_DRIFT'}
    $r=Read-LifecycleJson $ReleasePath
    Assert-LifecycleKeys $r @('schema','packet','canonical','mapping','beforeIssue','beforeNote','review','nativeRequest','consumer','transport','executable','stateDir','vaultRoot','notePath','outboxPath','journalPath','canonicalLease','publisherLease','tempRoot','outboxSha256','recovery')
    if($r.schema -cne 'TaskLifecycleUpdateRelease/v1' -or $r.recovery -cnotin @('INITIAL','RECONCILE_MISSING')){throw 'RELEASE_INVALID'}
    foreach($k in @('packet','canonical','mapping','beforeIssue','beforeNote','review','nativeRequest','consumer','transport','executable')){Assert-LifecyclePin $r[$k]}
    if($r.consumer.path -cne $script:LifecycleConsumerSource -or $r.transport.path -cne (Join-Path (Split-Path $script:LifecycleConsumerSource) 'github-cli-transport216.ps1')){throw 'SOURCE_BINDING'}
    if($r.review.sha256 -cne $ExpectedReviewSha256 -or $r.nativeRequest.sha256 -cne $ExpectedNativeRequestSha256){throw 'ADMISSION_BINDING'}
    $review=Read-LifecycleJson $r.review.path
    Assert-LifecycleKeys $review @('schema','decision','packetSha256','consumerSha256','transportSha256')
    if($review.schema -cne 'LifecycleIndependentReview/v1' -or $review.decision -cne 'ADMIT' -or $review.packetSha256 -cne $r.packet.sha256 -or $review.consumerSha256 -cne $r.consumer.sha256 -or $review.transportSha256 -cne $r.transport.sha256){throw 'REVIEW_BINDING'}
    $native=Read-LifecycleJson $r.nativeRequest.path
    Assert-LifecycleKeys $native @('schema','action','packetSha256','reviewSha256','consumerSha256','transportSha256','executableSha256','stateDir','notePath','outboxPath')
    if($native.schema -cne 'LifecycleNativeRequest/v1' -or $native.action -cne 'UPDATE' -or $native.packetSha256 -cne $r.packet.sha256 -or $native.reviewSha256 -cne $r.review.sha256 -or $native.consumerSha256 -cne $r.consumer.sha256 -or $native.transportSha256 -cne $r.transport.sha256 -or $native.executableSha256 -cne $r.executable.sha256 -or $native.stateDir -cne $r.stateDir -or $native.notePath -cne $r.notePath -or $native.outboxPath -cne $r.outboxPath){throw 'NATIVE_BINDING'}
    $p=New-TaskLifecycleMirrorPacket (Read-LifecycleJson $r.packet.path)
    if($p.eventType -cne 'UPDATE'){throw 'UNSUPPORTED_EVENT'}
    foreach($dir in @($r.stateDir,$r.vaultRoot,$r.tempRoot)){Assert-LifecyclePath $dir ''; if(-not [IO.Directory]::Exists($dir)){throw 'DIRECTORY_MISSING'}}
    foreach($path in @($r.outboxPath,$r.journalPath,$r.publisherLease)){Assert-LifecyclePath $path $r.stateDir}
    Assert-LifecyclePath $r.notePath $r.vaultRoot
    Assert-LifecyclePath $r.canonicalLease ''
    if($r.publisherLease -cne (Join-Path $r.stateDir 'publisher.lock') -or $r.journalPath -cne (Join-Path $r.stateDir 'lifecycle-update.journal.json') -or $r.outboxPath -cne (Join-Path $r.stateDir 'outbox.json') -or $r.canonicalLease -cne ($r.canonical.path+'.lock')){throw 'LEASE_BINDING'}
    # Never load unpinned dependencies supplied by packet contents.
    Assert-LifecyclePath $ReconcilePath ''
    if((Get-LifecycleFileHash $ReconcilePath) -cne 'a18d8f1d5ef0ef8bba11580d2cbdabcc60937489195c88d9f406c551a443d4da'){throw 'RECONCILE_DRIFT'}
    . $ReconcilePath
    . $r.transport.path
    try{$canonicalLease=[IO.File]::Open($r.canonicalLease,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch [IO.IOException]{return [pscustomobject]@{status='LOCKED';code='CANONICAL_LOCKED'}}
    try{$publisherLease=[IO.File]::Open($r.publisherLease,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch [IO.IOException]{return [pscustomobject]@{status='LOCKED';code='PUBLISHER_LOCKED'}}
    foreach($k in @('packet','canonical','mapping','beforeIssue','beforeNote','review','nativeRequest','consumer','transport','executable')){Assert-LifecyclePin $r[$k]}
    if((Get-LifecycleFileHash $r.outboxPath) -cne $r.outboxSha256){throw 'OUTBOX_DRIFT'}
    $c=Read-LifecycleJson $r.canonical.path
    Assert-LifecycleKeys $c @('taskId','canonicalRevision','publicTitle','publicSummary','publicStatus','nextAction')
    foreach($k in @($c.Keys)){if($c[$k] -cne $p[$k]){throw 'CANONICAL_DRIFT'}}
    $map=Read-LifecycleJson $r.mapping.path
    Assert-LifecycleKeys $map @('taskId','repo','issueNumber','url','stableMarker','canonicalRevision')
    $marker='factory-task-'+(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($p.taskId)))
    if($map.taskId -cne $p.taskId -or $map.repo -cne 'hakanduyar/software-factory' -or -not($map.issueNumber -is [int] -or $map.issueNumber -is [long]) -or $map.issueNumber -lt 1 -or $map.issueNumber -gt 2147483647 -or $map.url -cne ('https://github.com/'+$map.repo+'/issues/'+$map.issueNumber) -or $map.stableMarker -cne $marker -or -not($map.canonicalRevision -is [int] -or $map.canonicalRevision -is [long]) -or $map.canonicalRevision -ge $p.canonicalRevision){throw 'MAPPING_INVALID'}
    $before=Read-LifecycleJson $r.beforeIssue.path
    Assert-LifecycleKeys $before @('title','body')
    $region=Get-LifecycleRegion $p
    $afterBody=Set-LifecycleRegion $before.body $p.taskId $region
    $beforeNote=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($r.beforeNote.path))
    if(-not $beforeNote.Contains(('GitHub: '+$map.url),[StringComparison]::Ordinal)){throw 'NOTE_MAPPING'}
    $afterNote=Set-LifecycleNoteFields $beforeNote $p $map
    $oldRegion=[regex]::Match($before.body,'(?m)^<!-- factory-task-status:start -->\n[^\r]*?\n<!-- factory-task-status:end -->(?=\n|\z)').Value
    $oldLines=$oldRegion.Split("`n")
    if($oldLines.Count -ne 7 -or $oldLines[2] -cne ('Version: '+$map.canonicalRevision) -or -not $oldLines[3].StartsWith('Status: ',[StringComparison]::Ordinal) -or -not $oldLines[4].StartsWith('Next action: ',[StringComparison]::Ordinal) -or -not $oldLines[5].StartsWith('Summary: ',[StringComparison]::Ordinal)){throw 'BEFORE_VERSION_INVALID'}
    $oldPacket=$p.Clone();$oldPacket.canonicalRevision=$map.canonicalRevision;$oldPacket.publicTitle=$before.title
    $oldPacket.publicStatus=$oldLines[3].Substring(8);$oldPacket.nextAction=$oldLines[4].Substring(13);$oldPacket.publicSummary=$oldLines[5].Substring(9)
    [void](New-TaskLifecycleMirrorPacket $oldPacket)
    if((Get-LifecycleRegion $oldPacket) -cne $oldRegion){throw 'BEFORE_REGION_MISMATCH'}
    $noteAfterSha=Get-LifecycleHash ([Text.UTF8Encoding]::new($false,$true).GetBytes($afterNote))
    $digest=Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress)))
    $events=@(Read-Outbox $r.outboxPath)
    $j=@{schema='LifecycleUpdateJournal/v1';events=@{};heads=@{}}
    if(Test-Path -LiteralPath $r.journalPath){$j=Read-LifecycleJson $r.journalPath; Assert-LifecycleKeys $j @('schema','events','heads'); if($j.schema -cnotin @('LifecycleUpdateJournal/v1','LifecycleUpdateJournal/v2') -or $j.events -isnot [hashtable] -or $j.heads -isnot [hashtable]){throw 'JOURNAL_CORRUPT'}}
    $id=$p.idempotencyKey
    $head=$j.heads[$p.taskId]
    if($null -ne $head -and ($p.canonicalRevision -lt $head.revision -or ($p.canonicalRevision -eq $head.revision -and $head.digest -cne $digest))){throw 'REVISION_CONFLICT'}
    $e=$j.events[$id]
    if($null -ne $e -and $e.digest -cne $digest){throw 'KEY_PAYLOAD_DRIFT'}
    if($null -eq $e -and $r.recovery -cne 'INITIAL'){throw 'RECOVERY_WITHOUT_EVENT'}
    if($null -eq $e){$e=@{digest=$digest;githubSent=$false;noteSent=$false;githubAck=$false;noteAck=$false}; $j.events[$id]=$e}
    # A v1 event has exactly five fields. In a v2 journal the current event may still
    # be an inherited five-field event; it gains lastFailure on the first durable write.
    if($e.ContainsKey('lastFailure')){
      if($j.schema -cne 'LifecycleUpdateJournal/v2'){throw 'JOURNAL_CORRUPT'}
      Assert-LifecycleKeys $e @('digest','githubSent','noteSent','githubAck','noteAck','lastFailure')
      if($null -ne $e.lastFailure -and -not (Test-LifecycleFailureRecord $e.lastFailure)){throw 'JOURNAL_CORRUPT'}
    } else {Assert-LifecycleKeys $e @('digest','githubSent','noteSent','githubAck','noteAck')}
    foreach($k in @('githubSent','noteSent','githubAck','noteAck')){if($e[$k] -isnot [bool]){throw 'JOURNAL_CORRUPT'}}
    $keys=@{}
    foreach($dest in @('github','note')){
      $key=Get-EventKey -TaskId $p.taskId -PayloadSha256 $digest -RunId ($id+':'+$dest) -Status 'AWAITING_CONTROLLER' -Attempt 0
      $keys[$dest]=$key
      $existing=@($events|Where-Object {$_.key -ceq $key})
      if($existing.Count -gt 0 -and $existing[0].PSObject.Properties.Name -contains 'retryPolicy' -and $existing[0].retryPolicy -ceq 'NO_RETRY'){throw 'EXCLUDED_NO_RETRY'}
    }
    $transport=New-GitHubCliLifecycleTransport216 -GhPath $r.executable.path -ExpectedGhSha256 $r.executable.sha256 -Repository $map.repo -TempRoot $r.tempRoot -ProcessRunner $ProcessRunner
    $read={
      $rr=& $transport 'READ' @{repo=$map.repo;issueNumber=$map.issueNumber}
      if($null -eq $rr -or $rr.ok -isnot [bool] -or -not $rr.ok){$diagBox.v=Get-LifecycleTransportDiagnostic $rr;throw 'GITHUB_READ_FAILED'}
      if($rr.number -ne $map.issueNumber -or $rr.url -cne $map.url -or $rr.state -cne 'OPEN'){throw 'GITHUB_READ_FAILED'}
      return $rr
    }
    $op.phase='INITIAL_READ'; $rr=& $read; $op.phase=$null
    $ghDesired=($rr.title -ceq $p.publicTitle -and $rr.body -ceq $afterBody)
    $ghBefore=($rr.title -ceq $before.title -and $rr.body -ceq $before.body)
    $noteHash=Get-LifecycleFileHash $r.notePath
    if((-not $ghDesired -and -not $ghBefore) -or ($noteHash -cne $r.beforeNote.sha256 -and $noteHash -cne $noteAfterSha)){throw 'DESTINATION_DRIFT'}
    if(($e.githubAck -and -not $ghDesired) -or ($e.noteAck -and $noteHash -cne $noteAfterSha)){throw 'ACK_DRIFT'}
    if($null -ne $head -and $p.canonicalRevision -eq $head.revision -and $ghDesired -and $noteHash -ceq $noteAfterSha){return [pscustomobject]@{status='DELIVERED';code='DEBOUNCED';githubAck=$true;noteAck=$true}}
    if(($e.githubSent -or $e.noteSent) -and $r.recovery -cne 'RECONCILE_MISSING'){throw 'EXPLICIT_RECOVERY_REQUIRED'}
    # Before mutation persist PENDING independently per destination; excluded old
    # events remain untouched. Shared outbox schema retains PENDING/DELIVERED.
    foreach($dest in @('github','note')){
      if(@($events|Where-Object {$_.key -ceq $keys[$dest]}).Count -eq 0){$events += [pscustomobject]@{key=$keys[$dest];taskId=$p.taskId;payloadSha256=$digest;runId=($id+':'+$dest);destination=$dest;status='AWAITING_CONTROLLER';attempt=0;deliveryStatus='PENDING';proof=$null}}
    }
    # First admitted durable write upgrades the journal to v2 and gives the current
    # event its nullable lastFailure; other inherited events are written unchanged.
    $saveJournal={$j.schema='LifecycleUpdateJournal/v2'; if(-not $e.ContainsKey('lastFailure')){$e['lastFailure']=$null}; Write-LifecycleAtomic $r.journalPath ([Text.Encoding]::UTF8.GetBytes(($j|ConvertTo-Json -Depth 12 -Compress)))}
    $ack={param($dest,$proof) $e[$dest+'Ack']=$true; foreach($row in $events){if($row.key -ceq $keys[$dest]){$row.deliveryStatus='DELIVERED';$row.proof=$proof}}; Write-OutboxAtomic $r.outboxPath $events; & $saveJournal}
    Write-OutboxAtomic $r.outboxPath $events; & $saveJournal
    $phase='DELIVERY'
    # Fresh source/canonical/mapping check immediately before external mutation.
    $fresh={foreach($k in @('canonical','mapping','packet','consumer','transport','executable')){Assert-LifecyclePin $r[$k]}}
    if($ghDesired){& $ack 'github' ('readback:'+ (Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($rr.title+"`n"+$rr.body))))}
    else {
      if($e.githubSent){throw 'AMBIGUOUS_EDIT_NO_RETRY'}
      & $fresh
      $e.githubSent=$true; & $saveJournal
      $op.phase='EDIT'
      $edited=& $transport 'EDIT' @{repo=$map.repo;issueNumber=$map.issueNumber;taskId=$p.taskId;title=$p.publicTitle;body=$afterBody;beforeTitle=$before.title;beforeBody=$before.body}
      if($null -eq $edited -or $edited.ok -isnot [bool] -or -not $edited.ok){$diagBox.v=Get-LifecycleTransportDiagnostic $edited;throw 'EDIT_AMBIGUOUS_NO_RETRY'}
      $op.phase='EDIT_READBACK'
      $rr=& $read
      if($rr.title -cne $p.publicTitle -or $rr.body -cne $afterBody){throw 'EDIT_READBACK_FAILED'}
      $op.phase=$null
      & $ack 'github' ('readback:'+(Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($rr.title+"`n"+$rr.body))))
    }
    if($noteHash -ceq $noteAfterSha){& $ack 'note' ('bytes:'+$noteAfterSha)}
    else {
      & $fresh; Assert-LifecyclePath $r.notePath $r.vaultRoot
      $op.phase='NOTE_PRECHECK'
      if((Get-LifecycleFileHash $r.notePath) -cne $r.beforeNote.sha256){throw 'NOTE_DRIFT'}
      $op.phase=$null
      $e.noteSent=$true; & $saveJournal
      $op.phase='NOTE_WRITE'
      Write-LifecycleAtomic $r.notePath ([Text.UTF8Encoding]::new($false,$true).GetBytes($afterNote))
      $op.phase='NOTE_READBACK'
      if((Get-LifecycleFileHash $r.notePath) -cne $noteAfterSha){throw 'NOTE_READBACK_FAILED'}
      $op.phase=$null
      & $ack 'note' ('bytes:'+$noteAfterSha)
    }
    & $fresh
    $j.heads[$p.taskId]=@{revision=$p.canonicalRevision;digest=$digest}; & $saveJournal
    return [pscustomobject]@{status='DELIVERED';code='READBACK_ACK';githubAck=$e.githubAck;noteAck=$e.noteAck}
  }catch{
    $msg=$_.Exception.Message
    $out=[ordered]@{status=$(if($phase -ceq 'PREFLIGHT'){'REFUSED'}else{'PENDING'});code=$msg;automaticRetry=$false}
    if($null -ne $diagBox.v){$out['diagnostic']=$diagBox.v}
    # Durable failure evidence: only after full admission, both leases and a validated
    # journal, and only when an admitted destination operation actually failed. The
    # original outcome above is never replaced; inability to persist fails closed.
    if($null -ne $op.phase -and $null -ne $r -and $null -ne $j -and $null -ne $e -and $null -ne $canonicalLease -and $null -ne $publisherLease){
      $rec=$null
      try{
        $rec=New-LifecycleFailureRecord -Message $msg -Phase $op.phase -Diagnostic $diagBox.v
        $e['lastFailure']=$rec; $j.schema='LifecycleUpdateJournal/v2'
        Write-LifecycleAtomic $r.journalPath ([Text.Encoding]::UTF8.GetBytes(($j|ConvertTo-Json -Depth 12 -Compress)))
      }catch{
        $out['failureJournal']='NOT_PERSISTED'
        if($null -ne $rec){$out['failure']=$rec}
      }
    }
    return [pscustomobject]$out
  }finally{if($publisherLease){$publisherLease.Dispose()};if($canonicalLease){$canonicalLease.Dispose()}}
}
