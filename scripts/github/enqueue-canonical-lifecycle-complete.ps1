#Requires -Version 7.6
Set-StrictMode -Version Latest
# Enqueue-only: turns a verified canonical COMPLETE into two durable PENDING outbox rows in the
# existing consumer format. It never publishes, sends, closes, marks DELIVERED, or writes
# anything except the pinned StateDir/outbox.json (through the existing Write-OutboxAtomic).
# The result is observational; it grants no approval, delivery, or dispatch authority. The exact
# invocation (all pins, task, revision, candidate) must be admitted separately by the host.
# Locking is cooperative (two exclusive leases plus the existing atomic replace), not a global CAS.

function Get-EnqSha {
  param([string]$Path)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Path))).ToLowerInvariant()
}

function Assert-EnqFile {
  # Pre-import file check (the consumer's path helpers are not loaded yet at this point).
  param($Path)
  if ($Path -isnot [string] -or $Path.Length -eq 0 -or -not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'PATH_INVALID' }
  if (-not [IO.File]::Exists($Path)) { throw 'INPUT_MISSING' }
  $cur = $Path
  while ($cur) {
    if ((Test-Path -LiteralPath $cur) -and [IO.File]::GetAttributes($cur).HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'REPARSE_REFUSED' }
    $cur = [IO.Path]::GetDirectoryName($cur)
  }
}

function Test-EnqJsonSame {
  # Structural, order-preserving equality of two JSON elements (numbers by raw text: fail closed).
  param([Text.Json.JsonElement]$A, [Text.Json.JsonElement]$B)
  $kind = $A.ValueKind.ToString()
  if ($kind -cne $B.ValueKind.ToString()) { return $false }
  if ($kind -ceq 'Object') {
    $pa = @($A.EnumerateObject()); $pb = @($B.EnumerateObject())
    if ($pa.Count -ne $pb.Count) { return $false }
    for ($i = 0; $i -lt $pa.Count; $i++) {
      if ($pa[$i].Name -cne $pb[$i].Name -or -not (Test-EnqJsonSame $pa[$i].Value $pb[$i].Value)) { return $false }
    }
    return $true
  }
  if ($kind -ceq 'Array') {
    $ea = @($A.EnumerateArray()); $eb = @($B.EnumerateArray())
    if ($ea.Count -ne $eb.Count) { return $false }
    for ($i = 0; $i -lt $ea.Count; $i++) { if (-not (Test-EnqJsonSame $ea[$i] $eb[$i])) { return $false } }
    return $true
  }
  if ($kind -ceq 'String') { return ($A.GetString() -ceq $B.GetString()) }
  if ($kind -ceq 'Number') { return ($A.GetRawText() -ceq $B.GetRawText()) }
  return $true
}

function New-EnqResult {
  param([string]$Status, [string]$Code, [string[]]$Added = @(), $OutboxSha256 = $null)
  [pscustomobject][ordered]@{status = $Status; code = $Code; added = @($Added); outboxSha256 = $OutboxSha256; publication = 'NOT_ATTEMPTED'}
}

function Invoke-CanonicalLifecycleCompleteEnqueue {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$TaskId,
    [Parameter(Mandatory)]$CanonicalRevision,
    [Parameter(Mandatory)][AllowEmptyString()][string]$CandidateCommit,
    [Parameter(Mandatory)][AllowEmptyString()][string]$CanonicalPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedCanonicalSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$PacketPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedPacketSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$CompletionProofPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedCompletionProofSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ConsumerPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedConsumerSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ReconcilePath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedReconcileSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedCaptureSha256,
    [Parameter(Mandatory)][AllowEmptyString()][string]$StateDir,
    [Parameter(Mandatory)][AllowEmptyString()][string]$OutboxPath,
    [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedOutboxSha256
  )
  $ErrorActionPreference = 'Stop'
  $canonicalLease = $null; $publisherLease = $null; $validationPath = $null
  $origDoc = $null; $newDoc = $null
  try {
    foreach ($h in @($ExpectedCanonicalSha256, $ExpectedPacketSha256, $ExpectedCompletionProofSha256, $ExpectedConsumerSha256, $ExpectedReconcileSha256, $ExpectedCaptureSha256, $ExpectedOutboxSha256)) {
      if ($h -cnotmatch '^[0-9a-f]{64}\z') { throw 'PIN_MISSING' }
    }
    if ($TaskId -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z') { throw 'TASK_INVALID' }
    if (-not ($CanonicalRevision -is [int] -or $CanonicalRevision -is [long]) -or $CanonicalRevision -lt 1) { throw 'REVISION_INVALID' }
    if ($CandidateCommit -cnotmatch '^[0-9a-f]{40}\z' -or $CandidateCommit -ceq ('0' * 40)) { throw 'CANDIDATE_INVALID' }

    # Sources: exact independently supplied pins verified before any dot-source. The capture
    # sibling keeps the actual resolution reconcile.ps1 uses (<compat>/dispatch/...).
    Assert-EnqFile $ReconcilePath
    $capturePath = Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $ReconcilePath)) 'dispatch') 'reviewed-blocked-capture.ps1'
    $sources = @(
      @{path = $ConsumerPath; sha = $ExpectedConsumerSha256},
      @{path = $ReconcilePath; sha = $ExpectedReconcileSha256},
      @{path = $capturePath; sha = $ExpectedCaptureSha256}
    )
    $checkSources = {
      foreach ($s in $sources) {
        Assert-EnqFile $s.path
        if ((Get-EnqSha $s.path) -cne $s.sha) { throw 'SOURCE_DRIFT' }
      }
    }
    & $checkSources
    try {
      # Capture first so reconcile.ps1 finds the pinned sibling instead of loading another.
      . $capturePath
      . $ConsumerPath
      . $ReconcilePath
    } catch { throw 'IMPORT_FAILED' }
    & $checkSources
    foreach ($fn in @('New-TaskLifecycleMirrorPacket', 'Read-LifecycleCompletionProof', 'Read-LifecycleJson', 'Assert-LifecycleKeys', 'Assert-LifecyclePath', 'Assert-LifecyclePin', 'Get-LifecycleHash', 'Get-LifecycleFileHash', 'Test-LifecycleStr', 'Read-Outbox', 'Get-EventKey', 'Write-OutboxAtomic')) {
      if (-not (Get-Command -Name $fn -CommandType Function -ErrorAction SilentlyContinue)) { throw 'IMPORT_INCOMPLETE' }
    }

    # Owned locations.
    Assert-LifecyclePath $StateDir ''
    if (-not [IO.Directory]::Exists($StateDir)) { throw 'DIRECTORY_MISSING' }
    Assert-LifecyclePath $OutboxPath $StateDir
    if ($OutboxPath -cne (Join-Path $StateDir 'outbox.json')) { throw 'OUTBOX_BINDING' }
    Assert-EnqFile $OutboxPath
    $canonicalLeasePath = $CanonicalPath + '.lock'
    $publisherLeasePath = Join-Path $StateDir 'publisher.lock'
    Assert-LifecyclePath $canonicalLeasePath ''
    Assert-LifecyclePath $publisherLeasePath $StateDir
    # Write-OutboxAtomic opens this path itself: it must be canonical, nonreparse and owned too.
    $outboxLockPath = $OutboxPath + '.lock'
    Assert-LifecyclePath $outboxLockPath $StateDir

    # Full authentication of canonical, packet and completion proof (also re-run under the
    # leases and immediately before the write). Returns a comparable normalized view.
    $validate = {
      Assert-EnqFile $CanonicalPath; Assert-EnqFile $PacketPath; Assert-EnqFile $CompletionProofPath
      Assert-LifecyclePin @{path = $CanonicalPath; sha256 = $ExpectedCanonicalSha256}
      Assert-LifecyclePin @{path = $PacketPath; sha256 = $ExpectedPacketSha256}
      $c = Read-LifecycleJson $CanonicalPath
      Assert-LifecycleKeys $c @('taskId', 'canonicalRevision', 'publicTitle', 'publicSummary', 'publicStatus', 'nextAction')
      foreach ($k in @('taskId', 'publicTitle', 'publicSummary', 'publicStatus', 'nextAction')) { if ($c[$k] -isnot [string]) { throw 'CANONICAL_INVALID' } }
      if (-not ($c.canonicalRevision -is [int] -or $c.canonicalRevision -is [long])) { throw 'CANONICAL_INVALID' }
      $p = New-TaskLifecycleMirrorPacket (Read-LifecycleJson $PacketPath)
      foreach ($k in @('schema', 'taskId', 'eventType', 'idempotencyKey', 'publicTitle', 'publicSummary', 'publicStatus', 'nextAction')) { if ($p[$k] -isnot [string]) { throw 'PACKET_INVALID' } }
      if ($p.destinations[0] -isnot [string] -or $p.destinations[1] -isnot [string]) { throw 'DESTINATIONS_INVALID' }
      if ($p.eventType -cne 'COMPLETE' -or $p.publicStatus -cne 'ACCEPTED_SCOPED' -or $p.nextAction -cne 'NONE') { throw 'UNSUPPORTED_EVENT' }
      if ($p.taskId -cne $TaskId -or [long]$p.canonicalRevision -ne [long]$CanonicalRevision) { throw 'IDENTITY_MISMATCH' }
      foreach ($k in @($c.Keys)) { if ($c[$k] -cne $p[$k]) { throw 'CANONICAL_DRIFT' } }
      $proof = Read-LifecycleCompletionProof @{path = $CompletionProofPath; sha256 = $ExpectedCompletionProofSha256} $p
      if (-not (Test-LifecycleStr $proof.candidateCommit $CandidateCommit)) { throw 'CANDIDATE_MISMATCH' }
      $res = @{
        p = $p
        digest = (Get-LifecycleHash ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8 -Compress))))
        packetJson = (ConvertTo-Json $p -Depth 5 -Compress)
        proofJson = (ConvertTo-Json $proof -Compress)
      }
      return $res
    }
    $ctx = & $validate
    $recheck = {
      & $checkSources
      $x = & $validate
      if ($x.digest -cne $ctx.digest -or $x.packetJson -cne $ctx.packetJson -or $x.proofJson -cne $ctx.proofJson) { throw 'PROOF_DRIFT' }
      if ((Get-EnqSha $OutboxPath) -cne $ExpectedOutboxSha256) { throw 'OUTBOX_DRIFT' }
      # Last, so nothing can change between this check and the write that opens this path.
      Assert-LifecyclePath $outboxLockPath $StateDir
    }

    # Exclusive cooperative leases, canonical first. A held lease is an observational LOCKED.
    try { $canonicalLease = [IO.File]::Open($canonicalLeasePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] {
      if ($_.Exception -is [IO.DirectoryNotFoundException] -or $_.Exception -is [IO.FileNotFoundException]) { throw 'LEASE_PATH_INVALID' }
      return (New-EnqResult 'LOCKED' 'CANONICAL_LOCKED')
    }
    try { $publisherLease = [IO.File]::Open($publisherLeasePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] {
      if ($_.Exception -is [IO.DirectoryNotFoundException] -or $_.Exception -is [IO.FileNotFoundException]) { throw 'LEASE_PATH_INVALID' }
      return (New-EnqResult 'LOCKED' 'PUBLISHER_LOCKED')
    }
    & $recheck

    # Outbox: read only under both leases, bound to the caller's current pin.
    $origBytes = [IO.File]::ReadAllBytes($OutboxPath)
    if ((Get-LifecycleHash $origBytes) -cne $ExpectedOutboxSha256) { throw 'OUTBOX_DRIFT' }
    try { [void](@(Read-Outbox $OutboxPath)) } catch { throw 'OUTBOX_INVALID' }
    if ((Get-EnqSha $OutboxPath) -cne $ExpectedOutboxSha256) { throw 'OUTBOX_DRIFT' }
    $off = 0
    if ($origBytes.Length -ge 3 -and $origBytes[0] -eq 0xEF -and $origBytes[1] -eq 0xBB -and $origBytes[2] -eq 0xBF) { $off = 3 }
    $origText = [Text.UTF8Encoding]::new($false, $true).GetString($origBytes, $off, $origBytes.Length - $off)
    $origRows = @(); $origEls = @()
    if (-not [string]::IsNullOrWhiteSpace($origText)) {
      $origDoc = [Text.Json.JsonDocument]::Parse($origText)
      if ($origDoc.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Array) { throw 'OUTBOX_SHAPE' }
      $origEls = @($origDoc.RootElement.EnumerateArray())
      # Strings stay strings (no date conversion) so unrelated rows are written back unchanged.
      $parsed = ConvertFrom-Json -InputObject $origText -NoEnumerate -DateKind String
      $origRows = @($parsed)
    }

    $p = $ctx.p; $digest = $ctx.digest; $id = $p.idempotencyKey
    $missing = @(); $present = @()
    foreach ($dest in @('github', 'note')) {
      $runId = $id + ':complete:' + $dest
      $key = Get-EventKey -TaskId $p.taskId -PayloadSha256 $digest -RunId $runId -Status 'AWAITING_CONTROLLER' -Attempt 0
      foreach ($row in $origRows) { if ($row.runId -ceq $runId -and $row.key -cne $key) { throw 'IDENTITY_CONFLICT' } }
      $same = @($origRows | Where-Object { $_.key -ceq $key })
      if ($same.Count -gt 1) { throw 'IDENTITY_CONFLICT' }
      if ($same.Count -eq 1) {
        $row = $same[0]
        if ($row.PSObject.Properties.Name -contains 'retryPolicy' -and $row.retryPolicy -ceq 'NO_RETRY') { throw 'EXCLUDED_NO_RETRY' }
        if ($row.taskId -cne $p.taskId -or $row.payloadSha256 -cne $digest -or $row.runId -cne $runId -or $row.destination -cne $dest -or $row.status -cne 'AWAITING_CONTROLLER' -or -not ($row.attempt -is [int] -or $row.attempt -is [long]) -or [long]$row.attempt -ne 0) { throw 'IDENTITY_CONFLICT' }
        $present += $dest
      } else {
        $missing += [pscustomobject]@{key = $key; taskId = $p.taskId; payloadSha256 = $digest; runId = $runId; destination = $dest; status = 'AWAITING_CONTROLLER'; attempt = 0; deliveryStatus = 'PENDING'; proof = $null}
      }
    }

    if ($missing.Count -eq 0) {
      & $recheck
      return (New-EnqResult 'ALREADY_PRESENT' 'NO_CHANGE' @() $ExpectedOutboxSha256)
    }

    $newRows = @(@($origRows) + @($missing))
    $json = ConvertTo-Json -InputObject @($newRows) -Depth 10
    $newBytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $newSha = Get-LifecycleHash $newBytes

    # Validate the complete resulting outbox with the unmodified reader, via an owned temp file.
    $validationPath = Join-Path $StateDir ('outbox.json.validate-' + [guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllBytes($validationPath, $newBytes)
    $checked = @(Read-Outbox $validationPath)
    if ($checked.Count -ne $newRows.Count) { throw 'VALIDATION_FAILED' }
    foreach ($m in $missing) {
      $hit = @($checked | Where-Object { $_.key -ceq $m.key })
      if ($hit.Count -ne 1 -or $hit[0].taskId -cne $m.taskId -or $hit[0].payloadSha256 -cne $m.payloadSha256 -or $hit[0].runId -cne $m.runId -or $hit[0].destination -cne $m.destination -or $hit[0].status -cne 'AWAITING_CONTROLLER' -or [long]$hit[0].attempt -ne 0 -or $hit[0].deliveryStatus -cne 'PENDING' -or $null -ne $hit[0].proof) { throw 'VALIDATION_FAILED' }
    }
    $newDoc = [Text.Json.JsonDocument]::Parse($json)
    $newEls = @($newDoc.RootElement.EnumerateArray())
    for ($i = 0; $i -lt $origEls.Count; $i++) {
      if (-not (Test-EnqJsonSame $origEls[$i] $newEls[$i])) { throw 'OUTBOX_ROUNDTRIP_DRIFT' }
    }
    [IO.File]::Delete($validationPath); $validationPath = $null

    & $recheck

    try {
      Write-OutboxAtomic $OutboxPath $newRows
    } catch {
      $kept = $false
      try { $kept = ((Get-EnqSha $OutboxPath) -ceq $ExpectedOutboxSha256) } catch { }
      $failed = New-EnqResult 'WRITE_FAILED' 'ATOMIC_WRITE_FAILED' @() $(if ($kept) { $ExpectedOutboxSha256 } else { $null })
      return $failed
    }
    if ((Get-EnqSha $OutboxPath) -cne $newSha) { return (New-EnqResult 'WRITE_FAILED' 'WRITE_READBACK_MISMATCH') }
    return (New-EnqResult 'ENQUEUED' 'ROWS_ADDED' @($missing | ForEach-Object { $_.destination }) $newSha)
  } catch {
    $msg = $_.Exception.Message
    if ($msg -cnotmatch '^[A-Z][A-Z0-9_]{2,63}\z') { $msg = 'UNKNOWN' }
    return (New-EnqResult 'REFUSED' $msg)
  } finally {
    if ($origDoc) { $origDoc.Dispose() }
    if ($newDoc) { $newDoc.Dispose() }
    if ($validationPath -and [IO.File]::Exists($validationPath)) { [IO.File]::Delete($validationPath) }
    if ($publisherLease) { $publisherLease.Dispose() }
    if ($canonicalLease) { $canonicalLease.Dispose() }
  }
}
