#Requires -Version 7.6
# Offline focused harness: pwsh -NoProfile -File tests/github/canonical-complete-enqueue.tests.ps1
# Uses the real consumer/reconcile/capture sources and the real filesystem in a fresh temp root.
# No network, gh, credentials, or provider/model calls. Exit code is the number of failures (capped at 1).
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
function Get-FxPath { param([string]$Rel) [IO.Path]::GetFullPath((Join-Path $repoRoot $Rel)) }
$consumerPath = Get-FxPath 'scripts/github/task-lifecycle-mirror-consumer.ps1'
$reconcilePath = Get-FxPath 'scripts/github/lifecycle-compat/continuity/reconcile.ps1'
$capturePath = Get-FxPath 'scripts/github/lifecycle-compat/dispatch/reviewed-blocked-capture.ps1'
$enqueuePath = Get-FxPath 'scripts/github/enqueue-canonical-lifecycle-complete.ps1'
. $consumerPath
. $reconcilePath
. $enqueuePath

$script:Pass = 0; $script:Fail = 0; $script:CaseNo = 0
function Check { param([bool]$Cond, [string]$Name) if ($Cond) { $script:Pass++; Write-Host "PASS $Name" } else { $script:Fail++; Write-Host "FAIL $Name" } }
function Get-FxSha { param([string]$Path) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant() }
function Get-FxTextSha { param([string]$Text) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant() }
function Test-FxBytes { param([byte[]]$Orig, [string]$Path) return ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Orig)).ToLowerInvariant() -ceq (Get-FxSha $Path)) }
function Write-FxText { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false)) }
function Get-FxSnap {
  param([string]$Dir, [string]$Exclude = '')
  (Get-ChildItem -LiteralPath $Dir -Recurse -File | Where-Object { $_.Name -notlike '*.lock' -and $_.Name -cne $Exclude } | Sort-Object FullName |
    ForEach-Object { $_.FullName.Substring($Dir.Length) + '=' + (Get-FxSha $_.FullName) }) -join "`n"
}
function Invoke-FxCase { param([string]$Name, [scriptblock]$Body) try { & $Body } catch { $script:Fail++; Write-Host "FAIL $Name threw: $($_.Exception.Message)" } }

$taskId = 'TASK-67-AC3'; $rev = 3; $idem = 'idem-67-ac3-complete'
$candidate = ('1a2b3c4d5e' * 4); $mergeSha = ('9f8e7d6c5b' * 4)
$title = 'Canonical complete enqueue'; $summary = 'Accepted scoped work is ready for mirror delivery'
$canonicalObj = [ordered]@{taskId = $taskId; canonicalRevision = $rev; publicTitle = $title; publicSummary = $summary; publicStatus = 'ACCEPTED_SCOPED'; nextAction = 'NONE'}
$canonicalText = $canonicalObj | ConvertTo-Json -Compress
# Independent of the code under test: the consumer digest is the SHA-256 of this compact text.
$digest = Get-FxTextSha $canonicalText
$consumerSha = Get-FxSha $consumerPath; $reconcileSha = Get-FxSha $reconcilePath; $captureSha = Get-FxSha $capturePath
$keyFor = { param($d) (@($taskId, $digest, ($idem + ':complete:' + $d), 'AWAITING_CONTROLLER', '0') -join ':') }

function New-FxRow {
  param($Task, $Payload, $Run, $Dest, $Status = 'AWAITING_CONTROLLER', $Attempt = 0, $Delivery = 'PENDING', $Proof = $null, [hashtable]$Extra = @{})
  $o = [ordered]@{key = (Get-EventKey -TaskId $Task -PayloadSha256 $Payload -RunId $Run -Status $Status -Attempt $Attempt); taskId = $Task; payloadSha256 = $Payload; runId = $Run; destination = $Dest; status = $Status; attempt = $Attempt; deliveryStatus = $Delivery; proof = $Proof}
  foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] }
  [pscustomobject]$o
}
function Get-FxLegacy {
  @(
    (New-FxRow -Task 'OLD-1' -Payload ('a' * 64) -Run 'run-old-1' -Dest 'github' -Extra @{updatedAt = '2026-10-01T10:00:00.123Z'}),
    (New-FxRow -Task 'OLD-2' -Payload ('b' * 64) -Run 'run-old-2' -Dest 'note' -Status 'COMPLETED' -Attempt 1 -Delivery 'DELIVERED' -Proof 'readback:legacy'),
    (New-FxRow -Task 'OLD-3' -Payload ('c' * 64) -Run 'run-old-3' -Dest 'github' -Status 'FAILED' -Attempt 2 -Extra @{retryPolicy = 'NO_RETRY'; metadata = 'keep-me'})
  )
}
function Set-FxChain {
  param($Ctx, [hashtable]$Delivery = @{}, [hashtable]$Proof = @{}, [hashtable]$Review = @{})
  $rv = [ordered]@{schema = 'IndependentComponentReview/v1'; decision = 'ACCEPT_SCOPED_SOURCE'; commit = $candidate}
  foreach ($k in $Review.Keys) { $rv[$k] = $Review[$k] }
  Write-FxText $Ctx.Review ($rv | ConvertTo-Json -Compress)
  $dv = [ordered]@{schema = 'IndependentDeliveryReceipt/v1'; head = $candidate; merge = $mergeSha; pr = 'https://github.com/hakanduyar/software-factory/pull/67'; requiredChecks = 'ALL_SUCCESS'; normalTypecheck = 'PASS'; normalBuild = 'PASS'; checks = 5; focusedTests = 12; sourceReviewSha256 = (Get-FxSha $Ctx.Review)}
  foreach ($k in $Delivery.Keys) { $dv[$k] = $Delivery[$k] }
  Write-FxText $Ctx.Delivery ($dv | ConvertTo-Json -Compress)
  $pf = [ordered]@{schema = 'LifecycleCompletionProof/v1'; taskId = $taskId; canonicalRevision = $rev; candidateCommit = $candidate; minimumFocusedTests = 3
    sourceReview = [ordered]@{path = $Ctx.Review; sha256 = (Get-FxSha $Ctx.Review)}; delivery = [ordered]@{path = $Ctx.Delivery; sha256 = (Get-FxSha $Ctx.Delivery)}}
  foreach ($k in $Proof.Keys) { $pf[$k] = $Proof[$k] }
  Write-FxText $Ctx.Proof ($pf | ConvertTo-Json -Compress)
  $Ctx.Call.ExpectedCompletionProofSha256 = Get-FxSha $Ctx.Proof
}
function Set-FxOutbox { param($Ctx, [object[]]$Rows) Write-FxText $Ctx.Outbox (ConvertTo-Json -InputObject @($Rows) -Depth 10); $Ctx.Call.ExpectedOutboxSha256 = Get-FxSha $Ctx.Outbox }
function Set-FxPacket {
  param($Ctx, [hashtable]$Override = @{})
  $pk = [ordered]@{schema = 'TaskLifecycleMirrorPacket/v1'; taskId = $taskId; canonicalRevision = $rev; eventType = 'COMPLETE'; idempotencyKey = $idem; publicTitle = $title; publicSummary = $summary; publicStatus = 'ACCEPTED_SCOPED'; nextAction = 'NONE'; destinations = @('github', 'note')}
  foreach ($k in $Override.Keys) { $pk[$k] = $Override[$k] }
  Write-FxText $Ctx.Packet ($pk | ConvertTo-Json -Compress)
  $Ctx.Call.ExpectedPacketSha256 = Get-FxSha $Ctx.Packet
}
function New-FxCase {
  param([object[]]$Rows = (Get-FxLegacy))
  $script:CaseNo++
  $dir = Join-Path $script:Root ('case' + $script:CaseNo)
  $state = Join-Path $dir 'state'
  [void][IO.Directory]::CreateDirectory($state)
  $ctx = @{Dir = $dir; State = $state; Outbox = (Join-Path $state 'outbox.json'); Canonical = (Join-Path $dir 'canonical.json'); Packet = (Join-Path $dir 'packet.json')
    Proof = (Join-Path $dir 'proof.json'); Review = (Join-Path $dir 'review.json'); Delivery = (Join-Path $dir 'delivery.json')}
  Write-FxText $ctx.Canonical $canonicalText
  $ctx.Call = @{TaskId = $taskId; CanonicalRevision = $rev; CandidateCommit = $candidate
    CanonicalPath = $ctx.Canonical; ExpectedCanonicalSha256 = (Get-FxSha $ctx.Canonical); PacketPath = $ctx.Packet; ExpectedPacketSha256 = ('0' * 64)
    CompletionProofPath = $ctx.Proof; ExpectedCompletionProofSha256 = ('0' * 64)
    ConsumerPath = $consumerPath; ExpectedConsumerSha256 = $consumerSha; ReconcilePath = $reconcilePath; ExpectedReconcileSha256 = $reconcileSha; ExpectedCaptureSha256 = $captureSha
    StateDir = $state; OutboxPath = $ctx.Outbox; ExpectedOutboxSha256 = ('0' * 64)}
  Set-FxPacket $ctx
  Set-FxChain $ctx
  Set-FxOutbox $ctx $Rows
  return $ctx
}
function Invoke-Fx { param($Ctx) $c = $Ctx.Call.Clone(); Invoke-CanonicalLifecycleCompleteEnqueue @c }
function Invoke-FxWithDrift {
  # Test-scope only: shadows the production script's own Assert-EnqFile (not replaced by the imports)
  # and fires $Mutate on the $OnCall-th check of $TriggerPath (1 = pre-lock, 2 = after locks,
  # 3 = immediately before the write), then delegates unchanged. The shadow is removed in finally.
  param($Ctx, [string]$TriggerPath, [int]$OnCall, [scriptblock]$Mutate)
  $fxOrig = Get-Command -Name Assert-EnqFile -CommandType Function
  $fxDrift = @{Path = $TriggerPath; On = $OnCall; Count = 0; Mutate = $Mutate; Fired = $false}
  function Assert-EnqFile {
    param($Path)
    if ($Path -ceq $fxDrift.Path) { $fxDrift.Count++; if ($fxDrift.Count -eq $fxDrift.On) { & $fxDrift.Mutate; $fxDrift.Fired = $true } }
    & $fxOrig $Path
  }
  try { $r = Invoke-Fx $Ctx } finally { Remove-Item -LiteralPath Function:\Assert-EnqFile -ErrorAction SilentlyContinue }
  return [pscustomobject]@{Result = $r; Fired = $fxDrift.Fired}
}
function Assert-FxDrift {
  param([string]$Name, [string]$Target, [int]$OnCall, [string]$Code)
  $ctx = New-FxCase
  $file = $ctx[$Target]; $leaf = Split-Path -Leaf $file
  $before = Get-FxSnap $ctx.Dir $leaf
  $origLen = [IO.File]::ReadAllBytes($file).Length; $origSha = Get-FxSha $file
  $mut = { [IO.File]::AppendAllText($file, ' ') }.GetNewClosure()
  $d = Invoke-FxWithDrift $ctx $ctx.Canonical $OnCall $mut
  Check $d.Fired "${Name}: the drift was actually injected"
  Check ($d.Result.status -ceq 'REFUSED' -and $d.Result.code -ceq $Code) "$Name -> REFUSED $Code (got $($d.Result.status)/$($d.Result.code))"
  Check ([IO.File]::ReadAllBytes($file).Length -eq ($origLen + 1) -and (Get-FxSha $file) -cne $origSha) "${Name}: the intentional mutation remains (not reverted or hidden)"
  Check ((Get-FxSnap $ctx.Dir $leaf) -ceq $before) "${Name}: outbox and every other protected input are unchanged"
  Check (@(Read-Outbox $ctx.Outbox).Count -eq 3) "${Name}: no destination row was added"
  Assert-FxState $ctx $Name
}
function New-FxReparse {
  param([string]$Link, [string]$Target)
  [void][IO.Directory]::CreateDirectory($Target)
  try { New-Item -ItemType $(if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }) -Path $Link -Target $Target | Out-Null; return $true } catch { return $false }
}
function Remove-FxReparse { param([string]$Link) if ([IO.Directory]::Exists($Link)) { [IO.Directory]::Delete($Link) } }
function Assert-FxState { param($Ctx, [string]$Name) $n = @(Get-ChildItem -LiteralPath $Ctx.State -Force | ForEach-Object Name | Where-Object { $_ -cnotin @('outbox.json', 'publisher.lock') }); Check ($n.Count -eq 0) "$Name leaves no temp/validation files in StateDir" }
function Assert-FxRefusal {
  param($Ctx, [string]$Code, [string]$Name)
  $before = Get-FxSnap $Ctx.Dir
  $r = Invoke-Fx $Ctx
  Check ($r.status -ceq 'REFUSED' -and ($Code -eq '' -or $r.code -ceq $Code)) "$Name -> REFUSED $Code (got $($r.status)/$($r.code))"
  Check ((Get-FxSnap $Ctx.Dir) -ceq $before) "$Name changes no non-lock file"
  Assert-FxState $Ctx $Name
}
function Get-FxRows { param([string]$Path) $a = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -NoEnumerate -DateKind String; return @($a) }

$script:Root = Join-Path ([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) ('enq-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($script:Root)
try {
  Invoke-FxCase 'valid+replay' {
    $ctx = New-FxCase
    $legacyBefore = Get-FxRows $ctx.Outbox
    $others = Get-FxSnap $ctx.Dir 'outbox.json'
    $r = Invoke-Fx $ctx
    Check ($r.status -ceq 'ENQUEUED' -and ($r.added -join ',') -ceq 'github,note') "valid canonical COMPLETE -> ENQUEUED github,note (got $($r.status)/$($r.code))"
    $rows = @(Read-Outbox $ctx.Outbox)
    Check ($rows.Count -eq 5) 'existing Read-Outbox accepts the resulting outbox with exactly two added rows'
    $after = Get-FxRows $ctx.Outbox
    Check ($after[3].key -ceq (& $keyFor 'github') -and $after[4].key -ceq (& $keyFor 'note')) 'row keys equal consumer Get-EventKey over the independent digest, github then note'
    Check ((@($after[3].PSObject.Properties.Name) -join ',') -ceq 'key,taskId,payloadSha256,runId,destination,status,attempt,deliveryStatus,proof') 'new row has the exact existing consumer shape and order'
    Check ($after[3].runId -ceq ($idem + ':complete:github') -and $after[4].runId -ceq ($idem + ':complete:note') -and $after[3].payloadSha256 -ceq $digest -and $after[4].destination -ceq 'note') 'runId, digest and destination follow the COMPLETE consumer'
    Check ($after[3].status -ceq 'AWAITING_CONTROLLER' -and $after[3].attempt -eq 0 -and $after[3].deliveryStatus -ceq 'PENDING' -and $null -eq $after[3].proof -and $after[4].deliveryStatus -ceq 'PENDING' -and $null -eq $after[4].proof) 'new rows are PENDING with null proof and attempt 0'
    Check ([IO.File]::ReadAllText($ctx.Outbox) -match '"attempt":\s*0[,\s}]') 'attempt is serialized as the integer 0'
    $same = $true
    for ($i = 0; $i -lt 3; $i++) { if (($legacyBefore[$i] | ConvertTo-Json -Compress -Depth 10) -cne ($after[$i] | ConvertTo-Json -Compress -Depth 10)) { $same = $false } }
    Check $same 'unrelated legacy/delivered/NO_RETRY rows and metadata are preserved in order'
    Check ([IO.File]::ReadAllText($ctx.Outbox).Contains('2026-10-01T10:00:00.123Z')) 'date-like string in an unrelated row is not rewritten'
    Check ((Get-FxSnap $ctx.Dir 'outbox.json') -ceq $others) 'canonical, packet, proof and receipts are untouched'
    Assert-FxState $ctx 'valid enqueue'
    Check ($r.outboxSha256 -ceq (Get-FxSha $ctx.Outbox)) 'result reports the actual new outbox SHA'

    $old = $ctx.Call.ExpectedOutboxSha256
    $bytes = [IO.File]::ReadAllBytes($ctx.Outbox)
    $ctx.Call.ExpectedOutboxSha256 = Get-FxSha $ctx.Outbox
    $r2 = Invoke-Fx $ctx
    Check ($r2.status -ceq 'ALREADY_PRESENT') 'replay with the actual current pin -> ALREADY_PRESENT'
    Check ((Get-FxSha $ctx.Outbox) -ceq $ctx.Call.ExpectedOutboxSha256 -and (Test-FxBytes $bytes $ctx.Outbox)) 'replay leaves outbox bytes identical'
    $ctx.Call.ExpectedOutboxSha256 = $old
    $r3 = Invoke-Fx $ctx
    Check ($r3.status -ceq 'REFUSED' -and $r3.code -ceq 'OUTBOX_DRIFT') 'stale old outbox pin refuses'
    Check ((Get-FxSha $ctx.Outbox) -ceq (Get-FxSha $ctx.Outbox) -and (Test-FxBytes $bytes $ctx.Outbox)) 'stale-pin refusal leaves outbox bytes identical'
  }

  Invoke-FxCase 'input pins and sources' {
    $ctx = New-FxCase; $ctx.Call.ExpectedPacketSha256 = 'ABC'; Assert-FxRefusal $ctx 'PIN_MISSING' 'malformed pin'
    $ctx = New-FxCase; $ctx.Call.ExpectedCanonicalSha256 = ('f' * 64); Assert-FxRefusal $ctx 'PIN_DRIFT' 'stale canonical pin'
    $ctx = New-FxCase; $ctx.Call.ExpectedPacketSha256 = ('f' * 64); Assert-FxRefusal $ctx 'PIN_DRIFT' 'stale packet pin'
    $ctx = New-FxCase; $ctx.Call.ExpectedCompletionProofSha256 = ('f' * 64); Assert-FxRefusal $ctx 'PIN_DRIFT' 'mismatched proof pin'
    $ctx = New-FxCase; $ctx.Call.ExpectedConsumerSha256 = ('f' * 64); Assert-FxRefusal $ctx 'SOURCE_DRIFT' 'stale consumer source pin'
    $ctx = New-FxCase; $ctx.Call.ExpectedReconcileSha256 = ('f' * 64); Assert-FxRefusal $ctx 'SOURCE_DRIFT' 'stale reconcile source pin'
    $ctx = New-FxCase; $ctx.Call.ExpectedCaptureSha256 = ('f' * 64); Assert-FxRefusal $ctx 'SOURCE_DRIFT' 'stale capture sibling pin'
    $ctx = New-FxCase; $ctx.Call.TaskId = 'OTHER-TASK'; Assert-FxRefusal $ctx 'IDENTITY_MISMATCH' 'task identity mismatch'
    $ctx = New-FxCase; $ctx.Call.CandidateCommit = ('3' * 40); Assert-FxRefusal $ctx 'CANDIDATE_MISMATCH' 'candidate mismatch'
    $ctx = New-FxCase; $ctx.Call.OutboxPath = Join-Path $ctx.State 'other.json'; Assert-FxRefusal $ctx 'OUTBOX_BINDING' 'arbitrary outbox path'
  }

  Invoke-FxCase 'proof chain' {
    $ctx = New-FxCase; [IO.File]::Delete($ctx.Proof); Assert-FxRefusal $ctx 'INPUT_MISSING' 'missing proof'
    $ctx = New-FxCase; Set-FxChain $ctx -Delivery @{requiredChecks = 'FAILED'}; Assert-FxRefusal $ctx 'RECEIPT_INVALID' 'failed delivery checks'
    $ctx = New-FxCase; Set-FxChain $ctx -Delivery @{head = ('2' * 40)}; Assert-FxRefusal $ctx 'PROOF_MISMATCH' 'delivery head differs from candidate'
    $ctx = New-FxCase; Set-FxChain $ctx -Review @{commit = ('2' * 40)}; Assert-FxRefusal $ctx 'PROOF_MISMATCH' 'review commit differs from candidate'
    $ctx = New-FxCase; Set-FxChain $ctx -Delivery @{checks = '5'}; Assert-FxRefusal $ctx 'RECEIPT_INVALID' 'coerced string check count'
    $ctx = New-FxCase; Set-FxChain $ctx -Delivery @{focusedTests = 1}; Assert-FxRefusal $ctx 'PROOF_TESTS_INSUFFICIENT' 'too few focused tests'
    $ctx = New-FxCase; Set-FxChain $ctx -Review @{schema = 'Other/v1'}; Assert-FxRefusal $ctx 'RECEIPT_UNSUPPORTED' 'unsupported review receipt schema'
    $ctx = New-FxCase; Set-FxChain $ctx -Proof @{taskId = 'OTHER-TASK'}; Assert-FxRefusal $ctx 'PROOF_BINDING' 'proof bound to another task'
  }

  Invoke-FxCase 'canonical and packet' {
    $ctx = New-FxCase; Write-FxText $ctx.Canonical ($canonicalText.Replace($title, 'Different title')); $ctx.Call.ExpectedCanonicalSha256 = Get-FxSha $ctx.Canonical
    Assert-FxRefusal $ctx 'CANONICAL_DRIFT' 'canonical content differs from packet'
    $ctx = New-FxCase; Write-FxText $ctx.Canonical ($canonicalText.TrimEnd('}') + ',"extra":1}'); $ctx.Call.ExpectedCanonicalSha256 = Get-FxSha $ctx.Canonical
    Assert-FxRefusal $ctx 'FIELDS_INVALID' 'canonical extra field'
    $ctx = New-FxCase; Write-FxText $ctx.Canonical ($canonicalText.Replace('"canonicalRevision":3', '"canonicalRevision":"3"')); $ctx.Call.ExpectedCanonicalSha256 = Get-FxSha $ctx.Canonical
    Assert-FxRefusal $ctx 'CANONICAL_INVALID' 'canonical revision coerced to string'
    $ctx = New-FxCase; Set-FxPacket $ctx @{eventType = 'UPDATE'; nextAction = 'RUN_FOCUSED_CHECKS'}; Assert-FxRefusal $ctx 'UNSUPPORTED_EVENT' 'UPDATE packet'
    $ctx = New-FxCase; Set-FxPacket $ctx @{publicStatus = $true}; Assert-FxRefusal $ctx '' 'boolean-coerced packet status'
    $ctx = New-FxCase; Set-FxPacket $ctx @{destinations = @('note', 'github')}; Assert-FxRefusal $ctx 'DESTINATIONS_INVALID' 'reordered destinations'
  }

  Invoke-FxCase 'drift at lock and final-check boundaries' {
    Check (-not (Get-Command Invoke-CanonicalLifecycleCompleteEnqueue).Parameters.ContainsKey('TestSeam')) 'production function exposes no test seam or callback parameter'
    Assert-FxDrift 'canonical drift right after locks' 'Canonical' 2 'PIN_DRIFT'
    Assert-FxDrift 'nested receipt drift before the write' 'Delivery' 3 'PIN_DRIFT'
    Assert-FxDrift 'packet drift before the write' 'Packet' 3 'PIN_DRIFT'
    Assert-FxDrift 'outbox drift before the write' 'Outbox' 3 'OUTBOX_DRIFT'
  }

  Invoke-FxCase 'nested outbox lock path' {
    $probe = Join-Path $script:Root 'probe-link'
    if (-not (New-FxReparse $probe (Join-Path $script:Root 'probe-target'))) { Write-Host 'SKIP nested reparse outbox-lock tests: cannot create a junction/symlink in this environment'; return }
    Remove-FxReparse $probe
    $ctx = New-FxCase; $link = $ctx.Outbox + '.lock'; $tgt = Join-Path $script:Root 'lock-target-a'
    [void](New-FxReparse $link $tgt)
    try {
      $orig = [IO.File]::ReadAllBytes($ctx.Outbox)
      $r = Invoke-Fx $ctx
      Check ($r.status -ceq 'REFUSED' -and $r.code -ceq 'REPARSE_REFUSED') "pre-existing reparse outbox lock path -> REFUSED REPARSE_REFUSED (got $($r.status)/$($r.code))"
      Check ((Test-FxBytes $orig $ctx.Outbox) -and @(Get-ChildItem -LiteralPath $tgt -Force).Count -eq 0) 'nothing was written to the outbox or through the link'
    } finally { Remove-FxReparse $link }
    $ctx = New-FxCase; $link2 = $ctx.Outbox + '.lock'; $tgt2 = Join-Path $script:Root 'lock-target-b'
    [void][IO.Directory]::CreateDirectory($tgt2)
    $orig = [IO.File]::ReadAllBytes($ctx.Outbox)
    $mut = { New-Item -ItemType $(if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }) -Path $link2 -Target $tgt2 | Out-Null }.GetNewClosure()
    try {
      $d = Invoke-FxWithDrift $ctx $ctx.Canonical 3 $mut
      Check $d.Fired 'reparse lock path was injected immediately before the write'
      Check ($d.Result.status -ceq 'REFUSED' -and $d.Result.code -ceq 'REPARSE_REFUSED') "reparse lock path appearing before the write -> REFUSED REPARSE_REFUSED (got $($d.Result.status)/$($d.Result.code))"
      Check ((Test-FxBytes $orig $ctx.Outbox) -and @(Get-ChildItem -LiteralPath $tgt2 -Force).Count -eq 0) 'pre-write reparse refusal wrote nothing to the outbox or through the link'
    } finally { Remove-FxReparse $link2 }
  }

  Invoke-FxCase 'held locks' {
    $ctx = New-FxCase; $orig = [IO.File]::ReadAllBytes($ctx.Outbox)
    $held = [IO.File]::Open(($ctx.Canonical + '.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { $r = Invoke-Fx $ctx } finally { $held.Dispose() }
    Check ($r.status -ceq 'LOCKED' -and $r.code -ceq 'CANONICAL_LOCKED') "held canonical lease -> LOCKED CANONICAL_LOCKED (got $($r.status)/$($r.code))"
    Check ((Test-FxBytes $orig $ctx.Outbox)) 'canonical lock leaves outbox bytes identical'
    $held = [IO.File]::Open((Join-Path $ctx.State 'publisher.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { $r = Invoke-Fx $ctx } finally { $held.Dispose() }
    Check ($r.status -ceq 'LOCKED' -and $r.code -ceq 'PUBLISHER_LOCKED') "held publisher lease -> LOCKED PUBLISHER_LOCKED (got $($r.status)/$($r.code))"
    Check ((Test-FxBytes $orig $ctx.Outbox)) 'publisher lock leaves outbox bytes identical'
    $again = Invoke-Fx $ctx
    Check ($again.status -ceq 'ENQUEUED') 'leases were released by the LOCKED invocations (next run succeeds)'
  }

  Invoke-FxCase 'conflicts' {
    $ctx = New-FxCase -Rows @((New-FxRow -Task $taskId -Payload $digest -Run ($idem + ':complete:github') -Dest 'note'))
    Assert-FxRefusal $ctx 'IDENTITY_CONFLICT' 'same key with a different destination'
    $ctx = New-FxCase -Rows @((New-FxRow -Task $taskId -Payload ('d' * 64) -Run ($idem + ':complete:github') -Dest 'github'))
    Assert-FxRefusal $ctx 'IDENTITY_CONFLICT' 'same runId with a different payload'
    $ctx = New-FxCase -Rows @((New-FxRow -Task $taskId -Payload $digest -Run ($idem + ':complete:github') -Dest 'github' -Extra @{retryPolicy = 'NO_RETRY'}))
    Assert-FxRefusal $ctx 'EXCLUDED_NO_RETRY' 'matching target carries NO_RETRY'
  }

  Invoke-FxCase 'partial and complete pre-existing rows' {
    $github = New-FxRow -Task $taskId -Payload $digest -Run ($idem + ':complete:github') -Dest 'github' -Delivery 'DELIVERED' -Proof 'readback:abc'
    $ctx = New-FxCase -Rows (@(Get-FxLegacy) + @($github))
    $r = Invoke-Fx $ctx
    Check ($r.status -ceq 'ENQUEUED' -and ($r.added -join ',') -ceq 'note') "partial pre-existing github row adds only note (got $($r.status)/$($r.code))"
    $after = Get-FxRows $ctx.Outbox
    Check ($after.Count -eq 5 -and $after[3].deliveryStatus -ceq 'DELIVERED' -and $after[3].proof -ceq 'readback:abc' -and $after[4].destination -ceq 'note' -and $after[4].deliveryStatus -ceq 'PENDING') 'existing DELIVERED row is not downgraded or rewritten'
    $note = New-FxRow -Task $taskId -Payload $digest -Run ($idem + ':complete:note') -Dest 'note'
    $ctx = New-FxCase -Rows @($github, $note)
    $orig = [IO.File]::ReadAllBytes($ctx.Outbox)
    $r = Invoke-Fx $ctx
    Check ($r.status -ceq 'ALREADY_PRESENT') 'both rows consistent -> ALREADY_PRESENT'
    Check ((Test-FxBytes $orig $ctx.Outbox)) 'no-op leaves outbox bytes identical'
  }

  Invoke-FxCase 'invalid outbox' {
    $ctx = New-FxCase; Write-FxText $ctx.Outbox '{not json'; $ctx.Call.ExpectedOutboxSha256 = Get-FxSha $ctx.Outbox
    Assert-FxRefusal $ctx 'OUTBOX_INVALID' 'malformed outbox'
    $bad = New-FxRow -Task 'OLD-9' -Payload ('e' * 64) -Run 'run-old-9' -Dest 'github' -Delivery 'DELIVERED' -Proof $null
    $ctx = New-FxCase -Rows @($bad)
    Assert-FxRefusal $ctx 'OUTBOX_INVALID' 'DELIVERED row without proof (parser not weakened)'
  }

  Invoke-FxCase 'atomic write failure' {
    $ctx = New-FxCase; $orig = [IO.File]::ReadAllBytes($ctx.Outbox)
    # A directory where the existing atomic writer opens its lock file makes the write fail deterministically.
    [void][IO.Directory]::CreateDirectory(($ctx.Outbox + '.lock'))
    $r = Invoke-Fx $ctx
    Check ($r.status -ceq 'WRITE_FAILED' -and $r.code -ceq 'ATOMIC_WRITE_FAILED') "failing atomic write -> WRITE_FAILED (got $($r.status)/$($r.code))"
    Check ((Test-FxBytes $orig $ctx.Outbox)) 'original outbox bytes are retained'
    Check ($r.outboxSha256 -ceq $ctx.Call.ExpectedOutboxSha256) 'WRITE_FAILED reports the retained original pin'
    $left = @(Get-ChildItem -LiteralPath $ctx.State -Force | ForEach-Object Name | Where-Object { $_ -clike '*.tmp_*' -or $_ -clike '*validate*' })
    Check ($left.Count -eq 0) 'no temp or validation file is left behind'
  }
} finally {
  if (Test-Path -LiteralPath $script:Root) { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "Passed: $script:Pass  Failed: $script:Fail"
Write-Host 'Not covered here: consumer end-to-end delivery (needs the gh transport); CI packaging; real concurrent processes.'
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
