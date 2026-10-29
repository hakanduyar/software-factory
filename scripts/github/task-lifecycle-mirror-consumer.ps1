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
    # Persisted JSON reloads integers as Int64; admit Int32/Int64 within Int32 range, then
    # hand a fresh typed copy to the transport validator (caller object is not mutated).
    $d = $Record.diagnostic
    foreach ($k in @('category','exitCode','timedOut','stderrTruncated','stderrEncoding')) { if (@($d.Keys) -cnotcontains $k) { return $false } }
    if ($d['category'] -isnot [string] -or $d['timedOut'] -isnot [bool] -or $d['stderrTruncated'] -isnot [bool] -or $d['stderrEncoding'] -isnot [string]) { return $false }
    $ec = $d['exitCode']
    if ($ec -isnot [int] -and $ec -isnot [long]) { return $false }
    if ([long]$ec -lt [long][int]::MinValue -or [long]$ec -gt [long][int]::MaxValue) { return $false }
    $copy = [pscustomobject]@{category=[string]$d['category'];exitCode=[int]$ec;timedOut=[bool]$d['timedOut'];stderrTruncated=[bool]$d['stderrTruncated'];stderrEncoding=[string]$d['stderrEncoding']}
    return [bool](Test-GitHubCliFailureDiagnostic216 $copy)
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
# Explicit opt-in INITIAL_READ retry scheduling. These helpers are structural
# validators and a pure clock seam; none of them issues authority or retries.
$script:LifecycleRetryCategories = @('TIMEOUT','NETWORK_UNAVAILABLE','RATE_LIMITED')
$script:LifecycleSafeInteger = [long]9007199254740991
$script:LifecycleUtcFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'"
function Test-LifecycleIntegral { param($Value) return ($Value -is [int] -or $Value -is [long]) }
function Assert-LifecycleRetryPolicy {
  # Exact LifecycleInitialReadRetryPolicy/v1. Returns a normalized read-only view.
  param($Policy)
  try {
    Assert-LifecycleKeys $Policy @('schema','maxAttempts','delayMs','retryableCategories')
    if($Policy.schema -isnot [string] -or $Policy.schema -cne 'LifecycleInitialReadRetryPolicy/v1'){throw 'x'}
    foreach($k in @('maxAttempts','delayMs')){if(-not (Test-LifecycleIntegral $Policy[$k]) -or [long]$Policy[$k] -gt $script:LifecycleSafeInteger){throw 'x'}}
    if([long]$Policy.maxAttempts -lt 1 -or [long]$Policy.delayMs -lt 0){throw 'x'}
    $c=$Policy.retryableCategories
    if($c -isnot [array] -or $c.Count -lt 1 -or $c.Count -gt $script:LifecycleRetryCategories.Count){throw 'x'}
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach($x in $c){if($x -isnot [string] -or $x -cnotin $script:LifecycleRetryCategories -or -not $seen.Add($x)){throw 'x'}}
    return [pscustomobject]@{maxAttempts=[long]$Policy.maxAttempts;delayMs=[long]$Policy.delayMs;retryableCategories=[string[]]@($c)}
  } catch { throw 'RETRY_POLICY_INVALID' }
}
function Read-LifecycleRetryPolicy {
  param($Pin)
  $raw=$null
  try { $raw=Read-LifecycleJson $Pin.path } catch { throw 'RETRY_POLICY_INVALID' }
  if((Get-LifecycleFileHash $Pin.path) -cne $Pin.sha256){throw 'PIN_DRIFT'}
  Assert-LifecycleRetryPolicy $raw
}
function Get-LifecycleUtcNow {
  # Injectable clock; it only supplies time and grants no authority.
  param([scriptblock]$Clock)
  $v=$null
  if($null -eq $Clock){$v=[DateTime]::UtcNow}
  else { $o=@(& $Clock); if($o.Count -ne 1){throw 'CLOCK_INVALID'}; $v=$o[0] }
  if($v -isnot [datetime] -or $v.Kind -ne [DateTimeKind]::Utc){throw 'CLOCK_INVALID'}
  return [datetime]::new($v.Ticks-($v.Ticks % 10000),[DateTimeKind]::Utc)
}
function Format-LifecycleUtc { param([datetime]$Time) $Time.ToString($script:LifecycleUtcFormat,[Globalization.CultureInfo]::InvariantCulture) }
function ConvertFrom-LifecycleUtc {
  # Only the canonical millisecond UTC form round-trips; anything else is corrupt.
  param($Text)
  if($Text -isnot [string] -or $Text -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\z'){throw 'JOURNAL_CORRUPT'}
  $t=[datetime]::MinValue
  if(-not [datetime]::TryParseExact($Text,$script:LifecycleUtcFormat,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal,[ref]$t) -or (Format-LifecycleUtc $t) -cne $Text){throw 'JOURNAL_CORRUPT'}
  return [datetime]::new($t.Ticks,[DateTimeKind]::Utc)
}
function Add-LifecycleCheckedMs {
  param([datetime]$Time,[long]$Ms)
  $room=[long][Math]::Floor([decimal]([datetime]::MaxValue.Ticks-$Time.Ticks)/10000)
  if($Ms -lt 0 -or $Ms -gt $room){throw 'RETRY_TIME_OVERFLOW'}
  return [datetime]::new($Time.Ticks+($Ms*10000),[DateTimeKind]::Utc)
}
function Assert-LifecycleRetryState {
  # Exact current-event retry state of LifecycleUpdateJournal/v3.
  param($State,$Policy,[string]$PolicySha256)
  try { Assert-LifecycleKeys $State @('policySha256','attempts','reservedAt','nextAt') } catch { throw 'JOURNAL_CORRUPT' }
  if($State.policySha256 -isnot [string] -or $State.policySha256 -cnotmatch '^[0-9a-f]{64}\z'){throw 'JOURNAL_CORRUPT'}
  if($State.policySha256 -cne $PolicySha256){throw 'RETRY_POLICY_PIN_MISMATCH'}
  if(-not (Test-LifecycleIntegral $State.attempts) -or [long]$State.attempts -lt 1 -or [long]$State.attempts -gt $Policy.maxAttempts){throw 'JOURNAL_CORRUPT'}
  $reserved=ConvertFrom-LifecycleUtc $State.reservedAt
  if($null -ne $State.nextAt){
    $next=ConvertFrom-LifecycleUtc $State.nextAt
    if($next -lt $reserved -or [long]$State.attempts -ge $Policy.maxAttempts){throw 'JOURNAL_CORRUPT'}
  }
}
function Test-LifecycleInitialReadRetryEligible {
  # Eligible only when the previous failure is a valid typed INITIAL_READ transport
  # diagnostic whose category the policy explicitly selects.
  param($Failure,$Policy)
  try {
    if(-not (Test-LifecycleFailureRecord $Failure)){return $false}
    if($Failure.code -cne 'GITHUB_READ_FAILED' -or $Failure.phase -cne 'INITIAL_READ' -or $null -eq $Failure.diagnostic){return $false}
    return [bool]($Failure.diagnostic.category -cin $Policy.retryableCategories)
  } catch { return $false }
}
function Invoke-AdmittedTaskLifecycleUpdate {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ReleasePath,
    [Parameter(Mandatory)][string]$ExpectedReleaseSha256,
    [Parameter(Mandatory)][string]$ExpectedReviewSha256,
    [Parameter(Mandatory)][string]$ExpectedNativeRequestSha256,
    [Parameter(Mandatory)][string]$ReconcilePath,
    [scriptblock]$ProcessRunner,
    [scriptblock]$UtcClock
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
  $retry=$false; $policy=$null; $reserved=$false; $freshEvent=$false
  try {
    foreach($h in @($ExpectedReleaseSha256,$ExpectedReviewSha256,$ExpectedNativeRequestSha256)){if($h -cnotmatch '^[0-9a-f]{64}\z'){throw 'ADMISSION_PIN_MISSING'}}
    Assert-LifecyclePath $ReleasePath ''
    if((Get-LifecycleFileHash $ReleasePath) -cne $ExpectedReleaseSha256){throw 'RELEASE_DRIFT'}
    $r=Read-LifecycleJson $ReleasePath
    # v2 is the explicit opt-in: v1 keys plus an immutable retryPolicy pin. v1 keeps
    # its exact original shape; a v1 release carrying retryPolicy is FIELDS_INVALID.
    $retry=($r -is [hashtable] -and $r.ContainsKey('schema') -and $r.schema -ceq 'TaskLifecycleUpdateRelease/v2')
    $releaseKeys=@('schema','packet','canonical','mapping','beforeIssue','beforeNote','review','nativeRequest','consumer','transport','executable','stateDir','vaultRoot','notePath','outboxPath','journalPath','canonicalLease','publisherLease','tempRoot','outboxSha256','recovery')
    if($retry){$releaseKeys+='retryPolicy'}
    Assert-LifecycleKeys $r $releaseKeys
    if((-not $retry -and $r.schema -cne 'TaskLifecycleUpdateRelease/v1') -or $r.recovery -cnotin @('INITIAL','RECONCILE_MISSING')){throw 'RELEASE_INVALID'}
    $pinKeys=@('packet','canonical','mapping','beforeIssue','beforeNote','review','nativeRequest','consumer','transport','executable')
    $freshKeys=@('canonical','mapping','packet','consumer','transport','executable')
    if($retry){$pinKeys+='retryPolicy';$freshKeys+='retryPolicy'}
    foreach($k in $pinKeys){Assert-LifecyclePin $r[$k]}
    if($r.consumer.path -cne $script:LifecycleConsumerSource -or $r.transport.path -cne (Join-Path (Split-Path $script:LifecycleConsumerSource) 'github-cli-transport216.ps1')){throw 'SOURCE_BINDING'}
    if($r.review.sha256 -cne $ExpectedReviewSha256 -or $r.nativeRequest.sha256 -cne $ExpectedNativeRequestSha256){throw 'ADMISSION_BINDING'}
    $review=Read-LifecycleJson $r.review.path
    $reviewKeys=@('schema','decision','packetSha256','consumerSha256','transportSha256')
    $nativeKeys=@('schema','action','packetSha256','reviewSha256','consumerSha256','transportSha256','executableSha256','stateDir','notePath','outboxPath')
    if($retry){$reviewKeys+='retryPolicySha256';$nativeKeys+='retryPolicySha256'}
    $schemaSuffix=$(if($retry){'/v2'}else{'/v1'})
    Assert-LifecycleKeys $review $reviewKeys
    if($review.schema -cne ('LifecycleIndependentReview'+$schemaSuffix) -or $review.decision -cne 'ADMIT' -or $review.packetSha256 -cne $r.packet.sha256 -or $review.consumerSha256 -cne $r.consumer.sha256 -or $review.transportSha256 -cne $r.transport.sha256 -or ($retry -and $review.retryPolicySha256 -cne $r.retryPolicy.sha256)){throw 'REVIEW_BINDING'}
    $native=Read-LifecycleJson $r.nativeRequest.path
    Assert-LifecycleKeys $native $nativeKeys
    if($retry -and $native.retryPolicySha256 -cne $r.retryPolicy.sha256){throw 'NATIVE_BINDING'}
    if($native.schema -cne ('LifecycleNativeRequest'+$schemaSuffix) -or $native.action -cne 'UPDATE' -or $native.packetSha256 -cne $r.packet.sha256 -or $native.reviewSha256 -cne $r.review.sha256 -or $native.consumerSha256 -cne $r.consumer.sha256 -or $native.transportSha256 -cne $r.transport.sha256 -or $native.executableSha256 -cne $r.executable.sha256 -or $native.stateDir -cne $r.stateDir -or $native.notePath -cne $r.notePath -or $native.outboxPath -cne $r.outboxPath){throw 'NATIVE_BINDING'}
    $p=New-TaskLifecycleMirrorPacket (Read-LifecycleJson $r.packet.path)
    if($p.eventType -cne 'UPDATE'){throw 'UNSUPPORTED_EVENT'}
    $policy=$null; if($retry){$policy=Read-LifecycleRetryPolicy $r.retryPolicy}
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
    foreach($k in $pinKeys){Assert-LifecyclePin $r[$k]}
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
    if(Test-Path -LiteralPath $r.journalPath){$j=Read-LifecycleJson $r.journalPath; Assert-LifecycleKeys $j @('schema','events','heads'); if($j.schema -cnotin $(if($retry){@('LifecycleUpdateJournal/v1','LifecycleUpdateJournal/v2','LifecycleUpdateJournal/v3')}else{@('LifecycleUpdateJournal/v1','LifecycleUpdateJournal/v2')}) -or $j.events -isnot [hashtable] -or $j.heads -isnot [hashtable]){throw 'JOURNAL_CORRUPT'}}
    $id=$p.idempotencyKey
    $head=$j.heads[$p.taskId]
    if($null -ne $head -and ($p.canonicalRevision -lt $head.revision -or ($p.canonicalRevision -eq $head.revision -and $head.digest -cne $digest))){throw 'REVISION_CONFLICT'}
    $e=$j.events[$id]
    if($null -ne $e -and $e.digest -cne $digest){throw 'KEY_PAYLOAD_DRIFT'}
    if($null -eq $e -and $r.recovery -cne 'INITIAL'){throw 'RECOVERY_WITHOUT_EVENT'}
    # Retry state is never inferred: an existing event without it has an UNKNOWN prior
    # attempt count and cannot be opted in. A v3 journal is refused by v1 releases above.
    if($retry -and $null -ne $e -and -not ($e -is [hashtable] -and $e.ContainsKey('retry'))){throw 'RETRY_COUNT_UNKNOWN'}
    $freshEvent=($null -eq $e)
    if($freshEvent){
      $e=@{digest=$digest;githubSent=$false;noteSent=$false;githubAck=$false;noteAck=$false}
      if($retry){$e['lastFailure']=$null;$e['retry']=$null}
      $j.events[$id]=$e
    }
    # A v1 event has exactly five fields. In a v2 journal the current event may still
    # be an inherited five-field event; it gains lastFailure on the first durable write.
    if($retry){
      Assert-LifecycleKeys $e @('digest','githubSent','noteSent','githubAck','noteAck','lastFailure','retry')
      if($null -ne $e.lastFailure -and -not (Test-LifecycleFailureRecord $e.lastFailure)){throw 'JOURNAL_CORRUPT'}
      if(-not $freshEvent){
        if($j.schema -cne 'LifecycleUpdateJournal/v3'){throw 'JOURNAL_CORRUPT'}
        Assert-LifecycleRetryState $e.retry $policy $r.retryPolicy.sha256
      }
    } elseif($e.ContainsKey('lastFailure')){
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
    # First admitted durable write upgrades the journal (v2, or v3 for an opt-in
    # retry release) and gives the current event its nullable lastFailure; other
    # inherited events are written unchanged.
    $saveJournal={$j.schema=$(if($retry){'LifecycleUpdateJournal/v3'}else{'LifecycleUpdateJournal/v2'}); if(-not $e.ContainsKey('lastFailure')){$e['lastFailure']=$null}; Write-LifecycleAtomic $r.journalPath ([Text.Encoding]::UTF8.GetBytes(($j|ConvertTo-Json -Depth 12 -Compress)))}
    $read={
      param([bool]$StrictIdentity)
      $rr=& $transport 'READ' @{repo=$map.repo;issueNumber=$map.issueNumber}
      if($null -eq $rr -or $rr.ok -isnot [bool] -or -not $rr.ok){$diagBox.v=Get-LifecycleTransportDiagnostic $rr;throw 'GITHUB_READ_FAILED'}
      # An ok-shaped READ for another issue/state is a fail-closed identity error,
      # never a transport failure a retry policy could select.
      if($rr.number -ne $map.issueNumber -or $rr.url -cne $map.url -or $rr.state -cne 'OPEN'){throw $(if($StrictIdentity){'READ_IDENTITY_MISMATCH'}else{'GITHUB_READ_FAILED'})}
      return $rr
    }
    # Opt-in gate. Only an event whose four delivery flags are all false may be
    # (re)attempted, and only a due, explicitly eligible INITIAL_READ transport
    # failure. The attempt is reserved durably BEFORE the transport READ; a crash
    # leaves it consumed (nextAt null => unknown outcome) and is never retried.
    $reserved=$false
    if($retry -and -not ($e.githubSent -or $e.noteSent -or $e.githubAck -or $e.noteAck)){
      $now=Get-LifecycleUtcNow $UtcClock
      $prior=0
      if(-not $freshEvent){
        $st=$e.retry; $prior=[long]$st.attempts
        if($null -eq $st.nextAt){
          if($prior -ge $policy.maxAttempts){return [pscustomobject]@{status='BUDGET_EXHAUSTED';code='BUDGET_EXHAUSTED';automaticRetry=$false;attempts=$prior}}
          if($null -ne $e.lastFailure -and -not (Test-LifecycleInitialReadRetryEligible $e.lastFailure $policy)){throw 'RETRY_NOT_ELIGIBLE'}
          throw 'RETRY_ATTEMPT_UNKNOWN'
        }
        if(-not (Test-LifecycleInitialReadRetryEligible $e.lastFailure $policy)){throw 'JOURNAL_CORRUPT'}
        if($now -lt (ConvertFrom-LifecycleUtc $st.nextAt)){return [pscustomobject]@{status='NOT_DUE';code='NOT_DUE';automaticRetry=$false;attempts=$prior;nextAt=[string]$st.nextAt}}
      }
      $e.retry=@{policySha256=[string]$r.retryPolicy.sha256;attempts=($prior+1);reservedAt=(Format-LifecycleUtc $now);nextAt=$null}
      Assert-LifecycleRetryState $e.retry $policy $r.retryPolicy.sha256
      try{& $saveJournal}catch{throw 'RETRY_RESERVATION_NOT_PERSISTED'}
      $reserved=$true
    }
    $op.phase='INITIAL_READ'; $rr=& $read $retry; $op.phase=$null
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
    $ack={param($dest,$proof) $e[$dest+'Ack']=$true; foreach($row in $events){if($row.key -ceq $keys[$dest]){$row.deliveryStatus='DELIVERED';$row.proof=$proof}}; Write-OutboxAtomic $r.outboxPath $events; & $saveJournal}
    Write-OutboxAtomic $r.outboxPath $events; & $saveJournal
    $phase='DELIVERY'
    # Fresh source/canonical/mapping check immediately before external mutation.
    $fresh={foreach($k in $freshKeys){Assert-LifecyclePin $r[$k]}}
    if($ghDesired){& $ack 'github' ('readback:'+ (Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes($rr.title+"`n"+$rr.body))))}
    else {
      if($e.githubSent){throw 'AMBIGUOUS_EDIT_NO_RETRY'}
      & $fresh
      $e.githubSent=$true; & $saveJournal
      $op.phase='EDIT'
      $edited=& $transport 'EDIT' @{repo=$map.repo;issueNumber=$map.issueNumber;taskId=$p.taskId;title=$p.publicTitle;body=$afterBody;beforeTitle=$before.title;beforeBody=$before.body}
      if($null -eq $edited -or $edited.ok -isnot [bool] -or -not $edited.ok){$diagBox.v=Get-LifecycleTransportDiagnostic $edited;throw 'EDIT_AMBIGUOUS_NO_RETRY'}
      $op.phase='EDIT_READBACK'
      $rr=& $read $false
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
        $e['lastFailure']=$rec
        $j.schema=$(if($retry){'LifecycleUpdateJournal/v3'}else{'LifecycleUpdateJournal/v2'})
        # Schedule only the attempt this run reserved, only for a policy-selected
        # INITIAL_READ transport diagnostic and only while budget remains. A clock
        # or overflow error leaves nextAt null: the attempt stays consumed, no retry.
        if($retry -and $reserved -and $op.phase -ceq 'INITIAL_READ' -and [long]$e.retry.attempts -lt $policy.maxAttempts -and (Test-LifecycleInitialReadRetryEligible $rec $policy)){
          try{
            $base=Get-LifecycleUtcNow $UtcClock; $res=ConvertFrom-LifecycleUtc $e.retry.reservedAt
            if($base -lt $res){$base=$res}
            $e.retry.nextAt=(Format-LifecycleUtc (Add-LifecycleCheckedMs $base $policy.delayMs))
          }catch{$e.retry.nextAt=$null}
        }
        Write-LifecycleAtomic $r.journalPath ([Text.Encoding]::UTF8.GetBytes(($j|ConvertTo-Json -Depth 12 -Compress)))
      }catch{
        $out['failureJournal']='NOT_PERSISTED'
        if($null -ne $rec){$out['failure']=$rec}
      }
    }
    return [pscustomobject]$out
  }finally{if($publisherLease){$publisherLease.Dispose()};if($canonicalLease){$canonicalLease.Dispose()}}
}
