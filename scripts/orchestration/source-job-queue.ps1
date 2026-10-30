#Requires -Version 7.5
# SOURCE-ONLY job queue common core (offline).
#
# Operates only on an explicitly supplied COPY of the operational index. All queue
# state lives in one namespaced subset inside controllerTaskRegistry; every other
# key is carried through semantically unchanged.
#
# Nothing here starts a provider, makes a Factory claim, or accepts work. A reservation
# is a recorded intent only. Consume-SourceJobReservation durably records that exactly one
# launch attempt was authorised for a reservation; it never resets, never leaves
# DISPATCH_UNCERTAIN and is neither a start, an acceptance nor a Factory claim.
# REVIEW_REQUIRED means "evidence exists and a reviewer must look", never accepted.
#
# Review/ownership events (REVIEW_INTENT, REVIEW_HANDOFF_ACK, SOURCE_DISPOSITION, SOURCE_OWNERSHIP_RELEASE)
# import independently supplied evidence only. A source review never releases paths or resolves a
# dependency: only SOURCE review -> verified delivery -> separate release (DELIVERED_RELEASED) does.
# A failed or rejected release (RELEASED_FAILED) frees overlapping paths but never satisfies a dependency.
# None of these states is Factory completion.
#
# Refusals throw 'SJQ_REFUSED:<CODE>[:<detail>]'.
Set-StrictMode -Version Latest

$script:SjqSchema = 'SourceOnlyJobQueueSubset/v1'
$script:SjqKey = 'sourceOnlyJobQueue'
$script:SjqEventSchema = 'SourceJobQueueEvent/v1'
$script:SjqIdPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
$script:SjqShaPattern = '^[0-9a-f]{64}$'
$script:SjqPathComparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
# States that keep their owned paths protected until an explicit owner disposition.
$script:SjqBlockingStates = @('DISPATCH_UNCERTAIN', 'RUNNING', 'REVIEW_REQUIRED', 'FAILED', 'REFUSED', 'RECONCILIATION_REQUIRED', 'SOURCE_REJECTED', 'SOURCE_REVIEW_ACCEPTED', 'DELIVERED_PENDING_RELEASE')
# Source-only terminal ownership states. Neither is a Factory completion; only DELIVERED_RELEASED satisfies a dependency.
$script:SjqOwnerIdentity = '/root/bounded_state_check'
$script:SjqActorPattern = '^/?[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
$script:SjqNonrootPattern = '^/root/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
$script:SjqSha40Pattern = '^[0-9a-f]{40}$'

function Stop-SjqRefused([string]$Code, [string]$Detail = '') {
    if ($Detail) { throw "SJQ_REFUSED:${Code}:$Detail" }
    throw "SJQ_REFUSED:$Code"
}

# ---------- strict JSON ----------

function Assert-SjqNoDuplicateKeys([Text.Json.JsonElement]$Element, [string]$What) {
    if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
        # Case-insensitive on purpose: exact duplicates and mis-cased twins both fail closed.
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($property in $Element.EnumerateObject()) {
            if (-not $seen.Add($property.Name)) { Stop-SjqRefused 'DUPLICATE_KEY' "$What.$($property.Name)" }
            Assert-SjqNoDuplicateKeys $property.Value $What
        }
    }
    elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
        foreach ($item in $Element.EnumerateArray()) { Assert-SjqNoDuplicateKeys $item $What }
    }
}

function ConvertFrom-SjqJsonBytes([byte[]]$Bytes, [string]$What) {
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes) }
    catch { Stop-SjqRefused 'BAD_ENCODING' $What }
    $options = [Text.Json.JsonDocumentOptions]::new()
    $options.MaxDepth = 100
    try { $document = [Text.Json.JsonDocument]::Parse($text, $options) }
    catch { Stop-SjqRefused 'BAD_JSON' $What }
    try { Assert-SjqNoDuplicateKeys $document.RootElement $What }
    finally { $document.Dispose() }
    ConvertFrom-Json -InputObject $text -AsHashtable -Depth 100 -DateKind String
}

# ---------- typed field access (no coercion) ----------

function Test-SjqHasKey($Object, [string]$Key) {
    ($Object -is [System.Collections.IDictionary]) -and (@($Object.Keys) -ccontains $Key)
}

function Assert-SjqKeys($Object, [string[]]$Required, [string]$What) {
    if ($Object -isnot [System.Collections.IDictionary]) { Stop-SjqRefused 'NOT_OBJECT' $What }
    $present = @($Object.Keys)
    foreach ($key in $present) { if ($Required -cnotcontains $key) { Stop-SjqRefused 'UNEXPECTED_KEY' "$What.$key" } }
    foreach ($key in $Required) { if ($present -cnotcontains $key) { Stop-SjqRefused 'MISSING_KEY' "$What.$key" } }
}

function Get-SjqString($Object, [string]$Key, [string]$What, [string]$Pattern = '') {
    if (-not (Test-SjqHasKey $Object $Key)) { Stop-SjqRefused 'MISSING_KEY' "$What.$Key" }
    $value = $Object[$Key]
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { Stop-SjqRefused 'BAD_TYPE' "$What.$Key" }
    if ($Pattern -and $value -cnotmatch $Pattern) { Stop-SjqRefused 'BAD_VALUE' "$What.$Key" }
    $value
}

function Get-SjqInt($Object, [string]$Key, [string]$What, [long]$Minimum = [long]::MinValue) {
    if (-not (Test-SjqHasKey $Object $Key)) { Stop-SjqRefused 'MISSING_KEY' "$What.$Key" }
    $value = $Object[$Key]
    if (($value -isnot [int]) -and ($value -isnot [long])) { Stop-SjqRefused 'BAD_TYPE' "$What.$Key" }
    if ([long]$value -lt $Minimum) { Stop-SjqRefused 'BAD_VALUE' "$What.$Key" }
    [long]$value
}

function Get-SjqBool($Object, [string]$Key, [string]$What) {
    if (-not (Test-SjqHasKey $Object $Key)) { Stop-SjqRefused 'MISSING_KEY' "$What.$Key" }
    $value = $Object[$Key]
    if ($value -isnot [bool]) { Stop-SjqRefused 'BAD_TYPE' "$What.$Key" }
    $value
}

function Get-SjqNullable($Object, [string]$Key, [string]$What, [string]$Kind) {
    if (-not (Test-SjqHasKey $Object $Key)) { Stop-SjqRefused 'MISSING_KEY' "$What.$Key" }
    if ($null -eq $Object[$Key]) { return $null }
    if ($Kind -ceq 'int') { return (Get-SjqInt $Object $Key $What) }
    $text = Get-SjqString $Object $Key $What
    if ($Kind -ceq 'utc') { $null = ConvertTo-SjqUtc $text "$What.$Key" }
    $text
}

function Get-SjqList($Object, [string]$Key, [string]$What) {
    if (-not (Test-SjqHasKey $Object $Key)) { Stop-SjqRefused 'MISSING_KEY' "$What.$Key" }
    $value = $Object[$Key]
    if (($value -is [string]) -or ($value -isnot [System.Collections.IList])) { Stop-SjqRefused 'BAD_TYPE' "$What.$Key" }
    , $value
}

function Get-SjqIdList($Object, [string]$Key, [string]$What) {
    $list = Get-SjqList $Object $Key $What
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $result = [Collections.Generic.List[string]]::new()
    foreach ($item in $list) {
        if ($item -isnot [string] -or $item -cnotmatch $script:SjqIdPattern) { Stop-SjqRefused 'BAD_VALUE' "$What.$Key" }
        if (-not $seen.Add($item)) { Stop-SjqRefused 'DUPLICATE_ITEM' "$What.$Key" }
        $result.Add($item)
    }
    , ([string[]]$result.ToArray())
}

function Get-SjqPathList($Object, [string]$Key, [string]$What) {
    $list = Get-SjqList $Object $Key $What
    $result = [Collections.Generic.List[string]]::new()
    foreach ($item in $list) {
        if ($item -isnot [string]) { Stop-SjqRefused 'BAD_TYPE' "$What.$Key" }
        Assert-SjqNormalizedPath $item "$What.$Key"
        foreach ($earlier in $result) {
            if (Test-SjqPathsOverlap $earlier $item) { Stop-SjqRefused 'OVERLAPPING_PATHS' "$What.$Key" }
        }
        $result.Add($item)
    }
    if ($result.Count -eq 0) { Stop-SjqRefused 'EMPTY_LIST' "$What.$Key" }
    , ([string[]]$result.ToArray())
}

function Get-SjqRef($Object, [string]$What) {
    Assert-SjqKeys $Object @('path', 'sha256') $What
    [ordered]@{
        path   = Get-SjqString $Object 'path' $What
        sha256 = Get-SjqString $Object 'sha256' $What $script:SjqShaPattern
    }
}

function ConvertTo-SjqUtc($Value, [string]$What) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|\+00:00)$') { Stop-SjqRefused 'BAD_UTC' $What }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) { Stop-SjqRefused 'BAD_UTC' $What }
    $parsed
}

# ---------- paths and files ----------

function Assert-SjqNoReparse([string]$Path, [string]$What) {
    $walk = $Path
    while ($walk) {
        if ([IO.File]::Exists($walk) -or [IO.Directory]::Exists($walk)) {
            if (([int][IO.File]::GetAttributes($walk) -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-SjqRefused 'REPARSE' $What }
        }
        $walk = [IO.Path]::GetDirectoryName($walk)
    }
}

function Assert-SjqNormalizedPath([string]$Path, [string]$What) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains([char]0)) { Stop-SjqRefused 'BAD_PATH' $What }
    try {
        $fullyQualified = [IO.Path]::IsPathFullyQualified($Path)
        $full = [IO.Path]::GetFullPath($Path)
        $root = [IO.Path]::GetPathRoot($Path)
    }
    catch { Stop-SjqRefused 'BAD_PATH' $What }
    if (-not $fullyQualified -or $full -cne $Path) { Stop-SjqRefused 'BAD_PATH' $What }
    if ($Path -cne $root -and ($Path.EndsWith('\') -or $Path.EndsWith('/'))) { Stop-SjqRefused 'BAD_PATH' $What }
    Assert-SjqNoReparse $Path $What
}

function Assert-SjqOrdinaryFile([string]$Path, [string]$What) {
    Assert-SjqNormalizedPath $Path $What
    if (-not [IO.File]::Exists($Path)) { Stop-SjqRefused 'MISSING_FILE' $What }
}

function Test-SjqPathsOverlap([string]$A, [string]$B) {
    $separator = [string][IO.Path]::DirectorySeparatorChar
    $left = if ($A.EndsWith($separator)) { $A } else { $A + $separator }
    $right = if ($B.EndsWith($separator)) { $B } else { $B + $separator }
    $left.StartsWith($right, $script:SjqPathComparison) -or $right.StartsWith($left, $script:SjqPathComparison)
}

function Test-SjqPathCovered([string]$Path, [string[]]$Owned) {
    $separator = [string][IO.Path]::DirectorySeparatorChar
    $candidate = if ($Path.EndsWith($separator)) { $Path } else { $Path + $separator }
    foreach ($ownedPath in $Owned) {
        $prefix = if ($ownedPath.EndsWith($separator)) { $ownedPath } else { $ownedPath + $separator }
        if ($candidate.StartsWith($prefix, $script:SjqPathComparison)) { return $true }
    }
    $false
}

function Test-SjqAnyOverlap($Left, $Right) {
    foreach ($a in $Left) { foreach ($b in $Right) { if (Test-SjqPathsOverlap ([string]$a) ([string]$b)) { return $true } } }
    $false
}

# One read feeds both the hash and the parse, so they cannot disagree.
function Get-SjqPinnedBytes([string]$Path, [string]$Sha256, [string]$What) {
    if ($Sha256 -cnotmatch $script:SjqShaPattern) { Stop-SjqRefused 'BAD_SHA' $What }
    Assert-SjqOrdinaryFile $Path $What
    try { $bytes = [IO.File]::ReadAllBytes($Path) }
    catch { Stop-SjqRefused 'UNREADABLE' $What }
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if ($actual -cne $Sha256) { Stop-SjqRefused 'HASH_DRIFT' $What }
    , $bytes
}

# Raw run artifacts are hashed as a stream; there is no size cap or truncation.
function Get-SjqStreamedDigest([string]$Path, [string]$What) {
    Assert-SjqOrdinaryFile $Path $What
    try { $stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read') }
    catch { Stop-SjqRefused 'UNREADABLE' $What }
    try {
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $hash = $hasher.ComputeHash($stream) } finally { $hasher.Dispose() }
        [pscustomobject]@{ Sha256 = [Convert]::ToHexString($hash).ToLowerInvariant(); Bytes = [long]$stream.Length }
    }
    finally { $stream.Dispose() }
}

function Assert-SjqRunBoundPath([string]$Path, [string]$RunDirectory, [string]$Leaf) {
    if ($Path -cne (Join-Path $RunDirectory $Leaf)) { Stop-SjqRefused 'PATH_NOT_RUN_BOUND' $Leaf }
}

# ---------- index lease, load, atomic save ----------

function Assert-SjqIndexPath([string]$IndexPath) {
    Assert-SjqOrdinaryFile $IndexPath 'index'
    if ([IO.Path]::GetFileName($IndexPath) -ceq 'canonical-task-backlog.json') { Stop-SjqRefused 'CANONICAL_BACKLOG_REFUSED' }
}

function Enter-SjqLease([string]$IndexPath) {
    $leasePath = "$IndexPath.lease"
    # The sidecar and its ancestors are validated before it is opened, so a planted link is never followed.
    Assert-SjqNormalizedPath $leasePath 'lease'
    if ([IO.Directory]::Exists($leasePath)) { Stop-SjqRefused 'LEASE_NOT_FILE' }
    $stream = $null
    for ($attempt = 0; $attempt -lt 5 -and $null -eq $stream; $attempt++) {
        try { $stream = [IO.File]::Open($leasePath, 'OpenOrCreate', 'ReadWrite', 'None') }
        catch { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $stream) { Stop-SjqRefused 'LEASE_BUSY' }
    # Revalidate under the held lease: the index and sidecar must still be the ordinary files that were checked.
    try {
        Assert-SjqIndexPath $IndexPath
        Assert-SjqNormalizedPath $leasePath 'lease'
    }
    catch { $stream.Dispose(); throw }
    $stream
}

function ConvertTo-SjqCanonical($Value) {
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = [Collections.Generic.List[string]]::new()
        foreach ($key in $Value.Keys) { $keys.Add([string]$key) }
        $keys.Sort([StringComparer]::Ordinal)
        $parts = [Collections.Generic.List[string]]::new()
        foreach ($key in $keys) { $parts.Add((ConvertTo-Json -InputObject $key -Compress) + ':' + (ConvertTo-SjqCanonical $Value[$key])) }
        return '{' + ($parts -join ',') + '}'
    }
    if (($Value -is [System.Collections.IList]) -and ($Value -isnot [string])) {
        $items = [Collections.Generic.List[string]]::new()
        foreach ($item in $Value) { $items.Add((ConvertTo-SjqCanonical $item)) }
        return '[' + ($items -join ',') + ']'
    }
    ConvertTo-Json -InputObject $Value -Compress
}

function New-SjqQueue {
    @{ schema = $script:SjqSchema; version = [long]0; events = @{}; jobs = @{}; reservations = @{} }
}

function Assert-SjqQueueShape($Queue) {
    Assert-SjqKeys $Queue @('schema', 'version', 'events', 'jobs', 'reservations') 'queue'
    if ($Queue['schema'] -cne $script:SjqSchema) { Stop-SjqRefused 'QUEUE_SCHEMA' }
    $version = $Queue['version']
    if ((($version -isnot [int]) -and ($version -isnot [long])) -or $version -lt 0) { Stop-SjqRefused 'QUEUE_VERSION' }
    foreach ($name in 'events', 'jobs', 'reservations') {
        if ($Queue[$name] -isnot [System.Collections.IDictionary]) { Stop-SjqRefused 'QUEUE_SHAPE' $name }
    }
}

function Read-SjqIndexState([string]$IndexPath) {
    try { $bytes = [IO.File]::ReadAllBytes($IndexPath) }
    catch { Stop-SjqRefused 'UNREADABLE' 'index' }
    $root = ConvertFrom-SjqJsonBytes $bytes 'index'
    if ($root -isnot [System.Collections.IDictionary]) { Stop-SjqRefused 'NOT_OBJECT' 'index' }
    if (-not (Test-SjqHasKey $root 'controllerTaskRegistry') -or $root['controllerTaskRegistry'] -isnot [System.Collections.IDictionary]) {
        Stop-SjqRefused 'NO_CONTROLLER_TASK_REGISTRY'
    }
    $registry = $root['controllerTaskRegistry']
    if (Test-SjqHasKey $registry $script:SjqKey) {
        $queue = $registry[$script:SjqKey]
        Assert-SjqQueueShape $queue
    }
    else { $queue = New-SjqQueue }
    [pscustomobject]@{ Root = $root; Registry = $registry; Queue = $queue }
}

# Seam for the failure-integrity test: the only step that touches the live index.
function Invoke-SjqReplace([string]$TempPath, [string]$IndexPath) {
    # A bare $null binds to an empty string here and is rejected; NullString passes a real null (no backup file).
    [IO.File]::Replace($TempPath, $IndexPath, [NullString]::Value)
}

function Save-SjqIndex([string]$IndexPath, $Root) {
    $json = ConvertTo-Json -InputObject $Root -Depth 100
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
    $temp = "$IndexPath.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $stream = [IO.File]::Open($temp, 'CreateNew', 'Write', 'None')
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        Invoke-SjqReplace $temp $IndexPath
    }
    catch {
        if ([IO.File]::Exists($temp)) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
        Stop-SjqRefused 'WRITE_FAILED' $_.Exception.Message
    }
}

# ---------- job helpers ----------

function Get-SjqExistingJob($Queue, [string]$JobId) {
    if (-not $Queue['jobs'].Contains($JobId)) { Stop-SjqRefused 'JOB_NOT_REGISTERED' $JobId }
    $Queue['jobs'][$JobId]
}

function Assert-SjqInvocation($Job, $Invocation) {
    if ((Get-SjqString $Invocation 'schema' 'invocation') -cne 'SupervisedSourceOnlyInvocation/v1') { Stop-SjqRefused 'INVOCATION_SCHEMA' }
    if ((Get-SjqString $Invocation 'planSha256' 'invocation') -cne $Job['plan']['ref']['sha256']) { Stop-SjqRefused 'INVOCATION_PLAN_DRIFT' }
    if ((Get-SjqString $Invocation 'admissionSha256' 'invocation') -cne $Job['admission']['ref']['sha256']) { Stop-SjqRefused 'INVOCATION_ADMISSION_DRIFT' }
    foreach ($marker in 'factoryClaim', 'operationalReceipt', 'continuityGrant') {
        if ((Get-SjqBool $Invocation $marker 'invocation') -ne $false) { Stop-SjqRefused 'INVOCATION_MARKER_CONTRADICTION' $marker }
    }
    # An invocation for a consumed reservation must carry the exact consumed tuple; a binding without one is refused.
    $reservation = $Job['reservation']
    $consumed = ($reservation -is [System.Collections.IDictionary]) -and (Test-SjqHasKey $reservation 'consumed') -and ($reservation['consumed'] -eq $true)
    if (Test-SjqHasKey $Invocation 'queueBinding') {
        if (-not $consumed) { Stop-SjqRefused 'INVOCATION_BINDING_UNCONSUMED' }
        $binding = $Invocation['queueBinding']
        Assert-SjqKeys $binding @('schema', 'jobId', 'reservationId', 'attemptId', 'consumedUtc', 'runDirectory') 'invocation.queueBinding'
        $consumption = $reservation['consumption']
        if ((Get-SjqString $binding 'schema' 'invocation.queueBinding') -cne 'SourceJobQueueBinding/v1') { Stop-SjqRefused 'INVOCATION_BINDING_MISMATCH' 'schema' }
        if ((Get-SjqString $binding 'jobId' 'invocation.queueBinding') -cne [string]$Job['jobId']) { Stop-SjqRefused 'INVOCATION_BINDING_MISMATCH' 'jobId' }
        if ((Get-SjqString $binding 'reservationId' 'invocation.queueBinding') -cne [string]$reservation['reservationId']) { Stop-SjqRefused 'INVOCATION_BINDING_MISMATCH' 'reservationId' }
        if ((Get-SjqString $binding 'attemptId' 'invocation.queueBinding') -cne [string]$consumption['attemptId']) { Stop-SjqRefused 'INVOCATION_BINDING_MISMATCH' 'attemptId' }
        if ((Get-SjqString $binding 'consumedUtc' 'invocation.queueBinding') -cne [string]$consumption['consumedUtc']) { Stop-SjqRefused 'INVOCATION_BINDING_MISMATCH' 'consumedUtc' }
        if ((Get-SjqString $binding 'runDirectory' 'invocation.queueBinding') -cne [string]$Job['plan']['runDirectory']) { Stop-SjqRefused 'INVOCATION_BINDING_MISMATCH' 'runDirectory' }
    }
    elseif ($consumed) { Stop-SjqRefused 'INVOCATION_BINDING_MISSING' }
}

# ---------- reducers ----------

function Add-SjqRegistration($Queue, $Event, [string]$AtUtc) {
    Assert-SjqKeys $Event @('schema', 'eventId', 'type', 'jobId', 'parentId', 'priority', 'ownedPaths', 'dependsOn', 'planRef', 'admissionRef') 'event'
    $jobId = Get-SjqString $Event 'jobId' 'event' $script:SjqIdPattern
    $parentId = Get-SjqString $Event 'parentId' 'event' $script:SjqIdPattern
    $priority = Get-SjqInt $Event 'priority' 'event'
    $owned = Get-SjqPathList $Event 'ownedPaths' 'event'
    $dependsOn = Get-SjqIdList $Event 'dependsOn' 'event'
    if ($Queue['jobs'].Contains($jobId)) { Stop-SjqRefused 'JOB_EXISTS' $jobId }
    if ($dependsOn -ccontains $jobId) { Stop-SjqRefused 'SELF_DEPENDENCY' $jobId }
    $planRef = Get-SjqRef $Event['planRef'] 'event.planRef'
    $admissionRef = Get-SjqRef $Event['admissionRef'] 'event.admissionRef'

    $plan = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $planRef.path $planRef.sha256 'planRef') 'plan'
    if ((Get-SjqString $plan 'schema' 'plan') -cne 'SupervisedCodeSourceOnlyTask/v1') { Stop-SjqRefused 'PLAN_SCHEMA' }
    $taskId = Get-SjqString $plan 'taskId' 'plan'
    $sessionId = Get-SjqString $plan 'sessionId' 'plan'
    $runDirectory = Get-SjqString $plan 'runDirectory' 'plan'
    Assert-SjqNormalizedPath $runDirectory 'plan.runDirectory'
    # Editable pins are validated structurally only; the mutable files are never read here.
    $pinList = Get-SjqList $plan 'editablePins' 'plan'
    $pins = [Collections.Generic.List[object]]::new()
    foreach ($pin in $pinList) {
        $pinPath = Get-SjqString $pin 'path' 'plan.editablePins'
        $pinSha = Get-SjqString $pin 'sha256' 'plan.editablePins' $script:SjqShaPattern
        Assert-SjqNormalizedPath $pinPath 'plan.editablePins.path'
        if (-not (Test-SjqPathCovered $pinPath $owned)) { Stop-SjqRefused 'EDITABLE_PIN_NOT_OWNED' $pinPath }
        foreach ($earlier in $pins) { if ($earlier['path'] -ceq $pinPath) { Stop-SjqRefused 'DUPLICATE_ITEM' 'plan.editablePins' } }
        $pins.Add([ordered]@{ path = $pinPath; sha256 = $pinSha })
    }
    if ($pins.Count -eq 0) { Stop-SjqRefused 'EMPTY_LIST' 'plan.editablePins' }
    # Retained so terminal evidence can be checked for exact coverage and history agreement.
    $protectedList = Get-SjqList $plan 'protectedPins' 'plan'
    $protectedPaths = [Collections.Generic.List[string]]::new()
    foreach ($pin in $protectedList) {
        $protectedPath = Get-SjqString $pin 'path' 'plan.protectedPins'
        $null = Get-SjqString $pin 'sha256' 'plan.protectedPins' $script:SjqShaPattern
        Assert-SjqNormalizedPath $protectedPath 'plan.protectedPins.path'
        if ($protectedPaths.Contains($protectedPath)) { Stop-SjqRefused 'DUPLICATE_ITEM' 'plan.protectedPins' }
        $protectedPaths.Add($protectedPath)
    }
    if (-not (Test-SjqHasKey $plan 'history')) { Stop-SjqRefused 'MISSING_KEY' 'plan.history' }

    $admission = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $admissionRef.path $admissionRef.sha256 'admissionRef') 'admission'
    if ((Get-SjqString $admission 'schema' 'admission') -cne 'IndependentSupervisedSourceOnlyAdmission/v1') { Stop-SjqRefused 'ADMISSION_SCHEMA' }
    if ((Get-SjqString $admission 'decision' 'admission') -cne 'ADMIT_SOURCE_ONLY_ONCE') { Stop-SjqRefused 'ADMISSION_DECISION' }
    if ((Get-SjqString $admission 'planSha256' 'admission' $script:SjqShaPattern) -cne $planRef.sha256) { Stop-SjqRefused 'ADMISSION_PLAN_MISMATCH' }
    if ((Get-SjqString $admission 'taskId' 'admission') -cne $taskId) { Stop-SjqRefused 'ADMISSION_TASK_MISMATCH' }
    $reviewer = Get-SjqString $admission 'reviewer' 'admission'
    if ($reviewer -ceq '/root/bounded_state_check') { Stop-SjqRefused 'ADMISSION_REVIEWER' }
    if ((Get-SjqInt $admission 'maximumNativeProcesses' 'admission') -ne 1) { Stop-SjqRefused 'ADMISSION_PROCESS_COUNT' }
    $expiresUtc = Get-SjqString $admission 'expiresUtc' 'admission'
    $null = ConvertTo-SjqUtc $expiresUtc 'admission.expiresUtc'

    foreach ($other in $Queue['jobs'].Values) {
        if ($other['plan']['taskId'] -ceq $taskId -or $other['plan']['runDirectory'] -ceq $runDirectory -or $other['plan']['sessionId'] -ceq $sessionId) {
            Stop-SjqRefused 'DUPLICATE_RUN_IDENTITY' $jobId
        }
    }

    $Queue['jobs'][$jobId] = [ordered]@{
        jobId           = $jobId
        parentId        = $parentId
        priority        = $priority
        ownedPaths      = $owned
        dependsOn       = $dependsOn
        state           = 'SOURCE_PREPARED'
        registeredUtc   = $AtUtc
        registerEventId = Get-SjqString $Event 'eventId' 'event'
        plan            = [ordered]@{ ref = $planRef; taskId = $taskId; sessionId = $sessionId; runDirectory = $runDirectory; editablePins = $pins.ToArray(); protectedPaths = [string[]]$protectedPaths.ToArray(); history = $plan['history'] }
        admission       = [ordered]@{ ref = $admissionRef; expiresUtc = $expiresUtc; reviewer = $reviewer }
        reservation     = $null
        start           = $null
        terminal        = $null
        notice          = $null
        reasons         = [string[]]@()
    }
    $jobId
}

function Add-SjqObservedStart($Queue, $Event, [string]$AtUtc) {
    Assert-SjqKeys $Event @('schema', 'eventId', 'type', 'jobId', 'reservationId', 'startRef', 'invocationRef') 'event'
    $job = Get-SjqExistingJob $Queue (Get-SjqString $Event 'jobId' 'event' $script:SjqIdPattern)
    if ($job['state'] -cne 'DISPATCH_UNCERTAIN') { Stop-SjqRefused 'STATE_NOT_AWAITING_START' $job['state'] }
    $reservationId = Get-SjqString $Event 'reservationId' 'event' $script:SjqIdPattern
    if ($job['reservation']['reservationId'] -cne $reservationId) { Stop-SjqRefused 'RESERVATION_MISMATCH' }
    $run = [string]$job['plan']['runDirectory']
    $startRef = Get-SjqRef $Event['startRef'] 'event.startRef'
    $invocationRef = Get-SjqRef $Event['invocationRef'] 'event.invocationRef'
    Assert-SjqRunBoundPath $startRef.path $run 'start.json'
    Assert-SjqRunBoundPath $invocationRef.path $run 'invocation.json'

    Assert-SjqInvocation $job (ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $invocationRef.path $invocationRef.sha256 'invocationRef') 'invocation')
    $start = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $startRef.path $startRef.sha256 'startRef') 'start'
    Assert-SjqKeys $start @('schema', 'pid', 'sessionId', 'startUtc', 'observedUtc', 'noFactoryClaim') 'start'
    if ((Get-SjqString $start 'schema' 'start') -cne 'SupervisedSourceOnlyStart/v1') { Stop-SjqRefused 'START_SCHEMA' }
    $startPid = Get-SjqInt $start 'pid' 'start' 1
    if ((Get-SjqString $start 'sessionId' 'start') -cne $job['plan']['sessionId']) { Stop-SjqRefused 'IDENTITY_DRIFT' 'sessionId' }
    $startUtc = Get-SjqString $start 'startUtc' 'start'
    $observedUtc = Get-SjqString $start 'observedUtc' 'start'
    $startedAt = ConvertTo-SjqUtc $startUtc 'start.startUtc'
    $null = ConvertTo-SjqUtc $observedUtc 'start.observedUtc'
    if ((Get-SjqBool $start 'noFactoryClaim' 'start') -ne $true) { Stop-SjqRefused 'START_MARKER_CONTRADICTION' }
    if ($startedAt -lt (ConvertTo-SjqUtc $job['reservation']['reservedUtc'] 'reservedUtc')) { Stop-SjqRefused 'START_BEFORE_RESERVATION' }

    $job['state'] = 'RUNNING'
    $job['start'] = [ordered]@{ pid = $startPid; sessionId = $job['plan']['sessionId']; startUtc = $startUtc; observedUtc = $observedUtc; startRef = $startRef; invocationRef = $invocationRef; source = 'START_EVIDENCE'; eventId = Get-SjqString $Event 'eventId' 'event' }
    $job['notice'] = $null
    [string]$job['jobId']
}

function Add-SjqObservedTerminal($Queue, $Event, [string]$AtUtc) {
    Assert-SjqKeys $Event @('schema', 'eventId', 'type', 'jobId', 'terminalRef', 'invocationRef') 'event'
    $job = Get-SjqExistingJob $Queue (Get-SjqString $Event 'jobId' 'event' $script:SjqIdPattern)
    $priorState = [string]$job['state']
    # Admission expiry is deliberately not consulted: a started run must always be consumable.
    if ($priorState -cne 'RUNNING' -and $priorState -cne 'DISPATCH_UNCERTAIN') { Stop-SjqRefused 'STATE_NOT_AWAITING_TERMINAL' $priorState }
    $run = [string]$job['plan']['runDirectory']
    $terminalRef = Get-SjqRef $Event['terminalRef'] 'event.terminalRef'
    $invocationRef = Get-SjqRef $Event['invocationRef'] 'event.invocationRef'
    Assert-SjqRunBoundPath $terminalRef.path $run 'terminal.json'
    Assert-SjqRunBoundPath $invocationRef.path $run 'invocation.json'

    Assert-SjqInvocation $job (ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $invocationRef.path $invocationRef.sha256 'invocationRef') 'invocation')
    $t = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $terminalRef.path $terminalRef.sha256 'terminalRef') 'terminal'
    Assert-SjqKeys $t @('schema', 'providerStarted', 'pid', 'sessionId', 'startUtc', 'endUtc', 'exitCode', 'errorType', 'rawDrained', 'stdoutSha256', 'stdoutBytes', 'stderrSha256', 'stderrBytes', 'editableAfter', 'protectedPostPins', 'history', 'globalUsage', 'taskAcceptance', 'factoryClaim', 'operationalCompletion', 'successorAuthority') 'terminal'
    if ((Get-SjqString $t 'schema' 'terminal') -cne 'SupervisedSourceOnlyTerminal/v1') { Stop-SjqRefused 'TERMINAL_SCHEMA' }
    $started = Get-SjqBool $t 'providerStarted' 'terminal'
    $terminalPid = Get-SjqNullable $t 'pid' 'terminal' 'int'
    if ((Get-SjqString $t 'sessionId' 'terminal') -cne $job['plan']['sessionId']) { Stop-SjqRefused 'IDENTITY_DRIFT' 'sessionId' }
    $startUtc = Get-SjqNullable $t 'startUtc' 'terminal' 'utc'
    $endUtc = Get-SjqNullable $t 'endUtc' 'terminal' 'utc'
    $exitCode = Get-SjqNullable $t 'exitCode' 'terminal' 'int'
    $errorType = Get-SjqNullable $t 'errorType' 'terminal' 'string'
    $rawDrained = Get-SjqBool $t 'rawDrained' 'terminal'
    $stdoutSha = Get-SjqString $t 'stdoutSha256' 'terminal' $script:SjqShaPattern
    $stderrSha = Get-SjqString $t 'stderrSha256' 'terminal' $script:SjqShaPattern
    $stdoutBytes = Get-SjqInt $t 'stdoutBytes' 'terminal' 0
    $stderrBytes = Get-SjqInt $t 'stderrBytes' 'terminal' 0
    # Exactly one typed row per admitted path: omitted, duplicate or unrelated rows are refused outright.
    $editableRows = Get-SjqList $t 'editableAfter' 'terminal'
    $editableSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($row in $editableRows) {
        Assert-SjqKeys $row @('path', 'sha256') 'terminal.editableAfter'
        $rowPath = Get-SjqString $row 'path' 'terminal.editableAfter'
        $null = Get-SjqString $row 'sha256' 'terminal.editableAfter' $script:SjqShaPattern
        if (-not $editableSeen.Add($rowPath)) { Stop-SjqRefused 'EDITABLE_COVERAGE' 'duplicate' }
    }
    $expectedEditable = @($job['plan']['editablePins'] | ForEach-Object { [string]$_['path'] })
    if ($editableSeen.Count -ne $expectedEditable.Count) { Stop-SjqRefused 'EDITABLE_COVERAGE' 'count' }
    foreach ($expected in $expectedEditable) { if (-not $editableSeen.Contains($expected)) { Stop-SjqRefused 'EDITABLE_COVERAGE' 'missing_or_unrelated' } }

    $postPins = Get-SjqList $t 'protectedPostPins' 'terminal'
    $pinsChanged = $false
    $pinSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($pin in $postPins) {
        Assert-SjqKeys $pin @('path', 'unchanged') 'terminal.protectedPostPins'
        $pinPath = Get-SjqString $pin 'path' 'terminal.protectedPostPins'
        if (-not $pinSeen.Add($pinPath)) { Stop-SjqRefused 'PIN_COVERAGE' 'duplicate' }
        if ((Get-SjqBool $pin 'unchanged' 'terminal.protectedPostPins') -ne $true) { $pinsChanged = $true }
    }
    $expectedProtected = @($job['plan']['protectedPaths'])
    if ($pinSeen.Count -ne $expectedProtected.Count) { Stop-SjqRefused 'PIN_COVERAGE' 'count' }
    foreach ($expected in $expectedProtected) { if (-not $pinSeen.Contains([string]$expected)) { Stop-SjqRefused 'PIN_COVERAGE' 'missing_or_unrelated' } }

    # Terminal history is evidence only when it equals the registered plan history.
    if ((ConvertTo-SjqCanonical $t['history']) -cne (ConvertTo-SjqCanonical $job['plan']['history'])) { Stop-SjqRefused 'HISTORY_MISMATCH' }
    $globalUsage = Get-SjqString $t 'globalUsage' 'terminal'
    $taskAcceptance = Get-SjqString $t 'taskAcceptance' 'terminal'
    $markersClean = ((Get-SjqBool $t 'factoryClaim' 'terminal') -eq $false) -and ((Get-SjqBool $t 'operationalCompletion' 'terminal') -eq $false) -and ((Get-SjqBool $t 'successorAuthority' 'terminal') -eq $false) -and ($taskAcceptance -ceq 'NOT_EVALUATED') -and ($globalUsage -ceq 'UNKNOWN')

    # Immutable raw artifacts must match what the terminal record claims; otherwise nothing authenticates.
    $stdout = Get-SjqStreamedDigest (Join-Path $run 'stdout.bin') 'stdout.bin'
    $stderr = Get-SjqStreamedDigest (Join-Path $run 'stderr.bin') 'stderr.bin'
    if ($stdout.Sha256 -cne $stdoutSha -or $stderr.Sha256 -cne $stderrSha) { Stop-SjqRefused 'RAW_HASH_DRIFT' }
    if ($stdout.Bytes -ne $stdoutBytes -or $stderr.Bytes -ne $stderrBytes) { Stop-SjqRefused 'RAW_BYTES_DRIFT' }

    # Authenticated but non-clean evidence is held for reconciliation, never promoted.
    $reasons = [Collections.Generic.List[string]]::new()
    if (-not $markersClean) { $reasons.Add('SOURCE_ONLY_MARKER_CONTRADICTION') }
    if ($pinsChanged) { $reasons.Add('PROTECTED_POST_PIN_CHANGED') }
    if ($started) {
        if ($null -eq $terminalPid -or $null -eq $startUtc) { $reasons.Add('STARTED_WITHOUT_PID_OR_START') }
        if ($priorState -ceq 'RUNNING' -and ($terminalPid -ne $job['start']['pid'] -or $startUtc -cne $job['start']['startUtc'])) { $reasons.Add('PID_OR_START_DRIFT') }
        if ($null -ne $startUtc -and $startUtc -and ((ConvertTo-SjqUtc $startUtc 'startUtc') -lt (ConvertTo-SjqUtc $job['reservation']['reservedUtc'] 'reservedUtc'))) { $reasons.Add('START_BEFORE_RESERVATION') }
        if ($null -eq $endUtc) { $reasons.Add('END_MISSING') }
        elseif ($null -ne $startUtc -and (ConvertTo-SjqUtc $endUtc 'endUtc') -lt (ConvertTo-SjqUtc $startUtc 'startUtc')) { $reasons.Add('END_BEFORE_START') }
        if (-not $rawDrained) { $reasons.Add('RAW_NOT_DRAINED') }
        if ($null -eq $exitCode) { $reasons.Add('EXIT_CODE_MISSING') }
    }
    elseif ($priorState -ceq 'RUNNING') { $reasons.Add('NOT_STARTED_CONTRADICTS_OBSERVED_START') }
    elseif ($null -ne $terminalPid -or $null -ne $exitCode -or $null -eq $errorType) { $reasons.Add('NOT_STARTED_UNRESOLVED') }

    if ($reasons.Count -gt 0) { $newState = 'RECONCILIATION_REQUIRED'; $notice = 'RECONCILIATION_NEEDED' }
    elseif (-not $started) { $newState = 'REFUSED'; $notice = 'REFUSAL_RETAINED_NO_AUTO_RETRY' }
    elseif ($exitCode -ne 0 -or $null -ne $errorType) { $newState = 'FAILED'; $notice = 'FAILURE_RETAINED_NO_AUTO_RETRY' }
    else { $newState = 'REVIEW_REQUIRED'; $notice = 'REVIEW_NEEDED_NOT_ACCEPTED' }

    if ($priorState -ceq 'DISPATCH_UNCERTAIN' -and $started -and $null -ne $terminalPid -and $null -ne $startUtc) {
        $job['start'] = [ordered]@{ pid = $terminalPid; sessionId = $job['plan']['sessionId']; startUtc = $startUtc; observedUtc = $null; startRef = $null; invocationRef = $invocationRef; source = 'TERMINAL_EVIDENCE'; eventId = Get-SjqString $Event 'eventId' 'event' }
    }
    $job['state'] = $newState
    $job['notice'] = $notice
    $job['reasons'] = [string[]]$reasons.ToArray()
    $job['terminal'] = [ordered]@{
        ref = $terminalRef; invocationRef = $invocationRef; eventId = Get-SjqString $Event 'eventId' 'event'; observedAtUtc = $AtUtc
        providerStarted = $started; pid = $terminalPid; startUtc = $startUtc; endUtc = $endUtc; exitCode = $exitCode; errorType = $errorType; rawDrained = $rawDrained
        stdoutSha256 = $stdoutSha; stdoutBytes = $stdoutBytes; stderrSha256 = $stderrSha; stderrBytes = $stderrBytes
        protectedPostPins = $postPins; history = $t['history']; globalUsage = $globalUsage; taskAcceptance = $taskAcceptance
    }
    [string]$job['jobId']
}

# ---------- review, disposition and release evidence ----------
# Every document consumed below is independently supplied immutable evidence. These reducers only check
# it against the registered job and record it under the lease; nothing here issues an admission, reviews
# a candidate or declares Factory completion. Admissibility of reviewers is a trusted-host boundary: the
# JSON and hashes are not cryptographic origin authentication.

function Get-SjqReview($Job) {
    if ($Job['review'] -isnot [System.Collections.IDictionary]) {
        $Job['review'] = [ordered]@{ intent = $null; handoff = $null; disposition = $null; history = @(); release = $null }
    }
    $Job['review']
}

function Get-SjqJobOwner($Job) {
    $review = $Job['review']
    if (($review -is [System.Collections.IDictionary]) -and ($review['intent'] -is [System.Collections.IDictionary])) { return [string]$review['intent']['owner'] }
    $script:SjqOwnerIdentity
}

function Get-SjqEvidenceJson($Ref, [string]$What) {
    ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $Ref.path $Ref.sha256 $What) $What
}

function Get-SjqNullableRef($Object, [string]$Key, [string]$What) {
    if (-not (Test-SjqHasKey $Object $Key)) { Stop-SjqRefused 'MISSING_KEY' "$What.$Key" }
    if ($null -eq $Object[$Key]) { return $null }
    Get-SjqRef $Object[$Key] "$What.$Key"
}

function Get-SjqSourceHead($Object, [string]$What) {
    if (-not (Test-SjqHasKey $Object 'sourceHead')) { Stop-SjqRefused 'MISSING_KEY' "$What.sourceHead" }
    if ($null -eq $Object['sourceHead']) { return $null }
    Get-SjqString $Object 'sourceHead' $What $script:SjqSha40Pattern
}

function Test-SjqRefEqual($A, $B) {
    ([string]$A['path'] -ceq [string]$B['path']) -and ([string]$A['sha256'] -ceq [string]$B['sha256'])
}

function Get-SjqPins($Object, [string]$Key, [string]$What, [string[]]$Owned) {
    $list = Get-SjqList $Object $Key $What
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $pins = [Collections.Generic.List[object]]::new()
    foreach ($item in $list) {
        $pin = Get-SjqRef $item "$What.$Key"
        Assert-SjqNormalizedPath $pin.path "$What.$Key.path"
        if (-not (Test-SjqPathCovered $pin.path $Owned)) { Stop-SjqRefused 'PIN_NOT_OWNED' "$What.$Key" }
        if (-not $paths.Add($pin.path)) { Stop-SjqRefused 'DUPLICATE_ITEM' "$What.$Key" }
        $pins.Add($pin)
    }
    if ($pins.Count -eq 0) { Stop-SjqRefused 'EMPTY_LIST' "$What.$Key" }
    $pins.Sort([Comparison[object]] { param($x, $y) [string]::CompareOrdinal([string]$x['path'], [string]$y['path']) })
    , $pins.ToArray()
}

# The immutable candidate: exactly the editableAfter rows of the pinned terminal record, never the mutable source.
function Get-SjqTerminalPins($Job) {
    if ($null -eq $Job['terminal']) { Stop-SjqRefused 'NO_TERMINAL' ([string]$Job['jobId']) }
    $terminalRef = $Job['terminal']['ref']
    $terminal = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes ([string]$terminalRef['path']) ([string]$terminalRef['sha256']) 'terminalRef') 'terminal'
    Get-SjqPins $terminal 'editableAfter' 'terminal' @($Job['ownedPaths'])
}

function ConvertTo-SjqSortedKey([string[]]$Items) {
    $sorted = [Collections.Generic.List[string]]::new([string[]]@($Items))
    $sorted.Sort([StringComparer]::Ordinal)
    $sorted -join "`n"
}

function Assert-SjqTuple($Doc, $Job, [string]$What) {
    if ($null -eq $Job['terminal']) { Stop-SjqRefused 'NO_TERMINAL' $What }
    if ((Get-SjqString $Doc 'jobId' $What) -cne [string]$Job['jobId']) { Stop-SjqRefused 'TUPLE_MISMATCH' "$What.jobId" }
    if ((Get-SjqString $Doc 'taskId' $What) -cne [string]$Job['plan']['taskId']) { Stop-SjqRefused 'TUPLE_MISMATCH' "$What.taskId" }
    $expected = [ordered]@{ planRef = $Job['plan']['ref']; admissionRef = $Job['admission']['ref']; terminalRef = $Job['terminal']['ref'] }
    foreach ($key in @($expected.Keys)) {
        if (-not (Test-SjqRefEqual (Get-SjqRef $Doc[$key] "$What.$key") $expected[$key])) { Stop-SjqRefused 'TUPLE_MISMATCH' "$What.$key" }
    }
}

function Assert-SjqIndependentActor($Value, $Job, [string]$Owner, [string]$What) {
    if ($Value -isnot [string] -or $Value -cnotmatch $script:SjqActorPattern) { Stop-SjqRefused 'BAD_VALUE' $What }
    if ($Value -ceq '/root' -or $Value -ceq $Owner -or $Value -ceq $script:SjqOwnerIdentity -or $Value -ceq [string]$Job['plan']['sessionId']) {
        Stop-SjqRefused 'REVIEWER_NOT_INDEPENDENT' $What
    }
}

function Add-SjqReviewIntent($Queue, $Event, [string]$AtUtc) {
    Assert-SjqKeys $Event @('schema', 'eventId', 'type', 'jobId', 'intentRef') 'event'
    $job = Get-SjqExistingJob $Queue (Get-SjqString $Event 'jobId' 'event' $script:SjqIdPattern)
    # REVIEW_REQUIRED gets a source review; FAILED/REFUSED get an independent failure DIAGNOSIS through the same
    # correlated contract. Diagnosis never changes the state, never accepts and never retries. Reconciliation
    # states need explicit evidence reconciliation first, not a review of a candidate that may not be sound.
    if (@('REVIEW_REQUIRED', 'FAILED', 'REFUSED') -cnotcontains [string]$job['state']) { Stop-SjqRefused 'STATE_NOT_REVIEWABLE' ([string]$job['state']) }
    $review = Get-SjqReview $job
    # A changed candidate is a different job revision; an existing intent is never merged or replaced.
    if ($null -ne $review['intent']) { Stop-SjqRefused 'INTENT_EXISTS' ([string]$job['jobId']) }
    $intentRef = Get-SjqRef $Event['intentRef'] 'event.intentRef'
    $doc = Get-SjqEvidenceJson $intentRef 'intent'
    Assert-SjqKeys $doc @('schema', 'intentId', 'jobId', 'taskId', 'planRef', 'admissionRef', 'terminalRef', 'candidatePins', 'sourceHead', 'owner', 'reviewerTarget', 'createdUtc') 'intent'
    if ((Get-SjqString $doc 'schema' 'intent') -cne 'SourceJobReviewIntent/v1') { Stop-SjqRefused 'INTENT_SCHEMA' }
    $intentId = Get-SjqString $doc 'intentId' 'intent' $script:SjqIdPattern
    Assert-SjqTuple $doc $job 'intent'
    $pins = Get-SjqPins $doc 'candidatePins' 'intent' @($job['ownedPaths'])
    if ((ConvertTo-SjqCanonical $pins) -cne (ConvertTo-SjqCanonical (Get-SjqTerminalPins $job))) { Stop-SjqRefused 'CANDIDATE_MISMATCH' 'intent' }
    $head = Get-SjqSourceHead $doc 'intent'
    $owner = Get-SjqString $doc 'owner' 'intent' $script:SjqActorPattern
    $target = Get-SjqString $doc 'reviewerTarget' 'intent' $script:SjqNonrootPattern
    if ($owner -ceq '/root' -or $target -ceq $owner -or $target -ceq $script:SjqOwnerIdentity -or $target -ceq [string]$job['plan']['sessionId']) { Stop-SjqRefused 'REVIEWER_TARGET' 'intent.reviewerTarget' }
    $createdUtc = Get-SjqString $doc 'createdUtc' 'intent'
    $null = ConvertTo-SjqUtc $createdUtc 'intent.createdUtc'
    $review['intent'] = [ordered]@{
        intentId = $intentId; ref = $intentRef; owner = $owner; reviewerTarget = $target; createdUtc = $createdUtc; sourceHead = $head
        candidatePins = $pins; eventId = Get-SjqString $Event 'eventId' 'event'; status = 'INTENT_PERSISTED_BEFORE_TOOLCALL'
        purpose = $(if ([string]$job['state'] -ceq 'REVIEW_REQUIRED') { 'SOURCE_REVIEW' } else { 'FAILURE_DIAGNOSIS' })
    }
    [string]$job['jobId']
}

# An acknowledgment proves the follow-up was scheduled for the target; it never implies a review result.
function Add-SjqReviewAck($Queue, $Event, [string]$AtUtc) {
    Assert-SjqKeys $Event @('schema', 'eventId', 'type', 'jobId', 'ackRef') 'event'
    $job = Get-SjqExistingJob $Queue (Get-SjqString $Event 'jobId' 'event' $script:SjqIdPattern)
    if (@('REVIEW_REQUIRED', 'FAILED', 'REFUSED') -cnotcontains [string]$job['state']) { Stop-SjqRefused 'STATE_NOT_REVIEWABLE' ([string]$job['state']) }
    $review = Get-SjqReview $job
    $intent = $review['intent']
    if ($null -eq $intent) { Stop-SjqRefused 'NO_INTENT' ([string]$job['jobId']) }
    if ($null -ne $review['handoff']) { Stop-SjqRefused 'ACK_EXISTS' ([string]$job['jobId']) }
    $ackRef = Get-SjqRef $Event['ackRef'] 'event.ackRef'
    $ack = Get-SjqEvidenceJson $ackRef 'ack'
    Assert-SjqKeys $ack @('schema', 'ackId', 'intentRef', 'reviewerTarget', 'acknowledgedUtc', 'toolResultRef') 'ack'
    if ((Get-SjqString $ack 'schema' 'ack') -cne 'SourceJobReviewHandoffAck/v1') { Stop-SjqRefused 'ACK_SCHEMA' }
    $ackId = Get-SjqString $ack 'ackId' 'ack' $script:SjqIdPattern
    if (-not (Test-SjqRefEqual (Get-SjqRef $ack['intentRef'] 'ack.intentRef') $intent['ref'])) { Stop-SjqRefused 'ACK_CORRELATION' 'intentRef' }
    $target = Get-SjqString $ack 'reviewerTarget' 'ack' $script:SjqNonrootPattern
    if ($target -cne [string]$intent['reviewerTarget']) { Stop-SjqRefused 'ACK_CORRELATION' 'reviewerTarget' }
    $acknowledgedUtc = Get-SjqString $ack 'acknowledgedUtc' 'ack'
    if ((ConvertTo-SjqUtc $acknowledgedUtc 'ack.acknowledgedUtc') -lt (ConvertTo-SjqUtc ([string]$intent['createdUtc']) 'createdUtc')) { Stop-SjqRefused 'ACK_CORRELATION' 'acknowledgedUtc' }
    $toolRef = Get-SjqRef $ack['toolResultRef'] 'ack.toolResultRef'
    $tool = Get-SjqEvidenceJson $toolRef 'toolResult'
    if ($tool -isnot [System.Collections.IDictionary]) { Stop-SjqRefused 'NOT_OBJECT' 'toolResult' }
    # The saved response must name the exact tool, destination and intent; the external broker attests the real call.
    foreach ($pair in @(@('tool', 'collaboration.followup_task'), @('target', $target), @('intentId', [string]$intent['intentId']))) {
        if (-not (Test-SjqHasKey $tool $pair[0]) -or $tool[$pair[0]] -isnot [string] -or $tool[$pair[0]] -cne $pair[1]) { Stop-SjqRefused 'ACK_CORRELATION' "toolResult.$($pair[0])" }
    }
    $mock = $false
    if (Test-SjqHasKey $tool 'label') {
        if ($tool['label'] -isnot [string] -or $tool['label'] -cne 'MOCK/NOT_LIVE') { Stop-SjqRefused 'BAD_VALUE' 'toolResult.label' }
        $mock = $true
    }
    $review['handoff'] = [ordered]@{
        ackId = $ackId; ackRef = $ackRef; toolResultRef = $toolRef; reviewerTarget = $target; acknowledgedUtc = $acknowledgedUtc
        mock = $mock; actualHandoffEvidence = (-not $mock); proves = 'DISPATCH_ONLY_NOT_REVIEW'; eventId = Get-SjqString $Event 'eventId' 'event'
    }
    [string]$job['jobId']
}

# Typed verdict indicators read from the ROOT of a result wrapper only (no recursion, no field paths):
#   exitCode            integer; 0 is success, anything else failure
#   failed, raceFailed  non-negative integer; 0 is success, positive is failure
#   result, status, overall   exact string; SUCCESS/PASS success; FAIL/FAILED/NA/NOT_EXECUTED/NOT_AVAILABLE failure
# A recognized indicator of the wrong type, a negative count or an unknown string refuses (fail closed).
function Get-SjqVerdictCounts($Doc, [string]$What, [switch]$IgnoreUnknownStrings) {
    $success = 0
    $failure = 0
    if (Test-SjqHasKey $Doc 'exitCode') {
        $value = $Doc['exitCode']
        if (($value -isnot [int]) -and ($value -isnot [long])) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_MALFORMED' "$What.exitCode" }
        if ($value -eq 0) { $success++ } else { $failure++ }
    }
    foreach ($key in 'failed', 'raceFailed') {
        if (Test-SjqHasKey $Doc $key) {
            $value = $Doc[$key]
            if ((($value -isnot [int]) -and ($value -isnot [long])) -or $value -lt 0) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_MALFORMED' "$What.$key" }
            if ($value -eq 0) { $success++ } else { $failure++ }
        }
    }
    foreach ($key in 'result', 'status', 'overall') {
        if (Test-SjqHasKey $Doc $key) {
            $value = $Doc[$key]
            if ($value -isnot [string]) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_MALFORMED' "$What.$key" }
            if ($value -ceq 'SUCCESS' -or $value -ceq 'PASS') { $success++ }
            elseif (@('FAIL', 'FAILED', 'NA', 'NOT_EXECUTED', 'NOT_AVAILABLE') -ccontains $value) { $failure++ }
            elseif (-not $IgnoreUnknownStrings) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_UNSUPPORTED' "$What.$key" }
        }
    }
    [pscustomobject]@{ Success = $success; Failure = $failure }
}

# The ONE explicit source-only variant for reviews whose original receipt has no commit/typecheck/build fields
# (e.g. uncommitted PowerShell source). It is independently supplied and host-attested through the disposition
# admission; this module only validates its exact shape and its binding to the job, terminal and candidate.
function Assert-SjqScopedMapping($Map, $Ref, [string]$Kind, [string]$Reviewer, $Head, $Job, $Pins) {
    Assert-SjqKeys $Map @('schema', 'mappingId', 'jobId', 'taskId', 'terminalRef', 'candidatePins', 'sourceHead', 'originalReviewRef', 'resultRefs', 'scope', 'decision', 'reviewer') 'scopedMapping'
    $mappingId = Get-SjqString $Map 'mappingId' 'scopedMapping' $script:SjqIdPattern
    if ((Get-SjqString $Map 'jobId' 'scopedMapping') -cne [string]$Job['jobId'] -or (Get-SjqString $Map 'taskId' 'scopedMapping') -cne [string]$Job['plan']['taskId']) { Stop-SjqRefused 'SCOPED_MAPPING_MISMATCH' 'identity' }
    if (-not (Test-SjqRefEqual (Get-SjqRef $Map['terminalRef'] 'scopedMapping.terminalRef') $Job['terminal']['ref'])) { Stop-SjqRefused 'SCOPED_MAPPING_MISMATCH' 'terminalRef' }
    $mapPins = Get-SjqPins $Map 'candidatePins' 'scopedMapping' @($Job['ownedPaths'])
    if ((ConvertTo-SjqCanonical $mapPins) -cne (ConvertTo-SjqCanonical $Pins)) { Stop-SjqRefused 'SCOPED_MAPPING_MISMATCH' 'candidatePins' }
    if ([string](Get-SjqSourceHead $Map 'scopedMapping') -cne [string]$Head) { Stop-SjqRefused 'SCOPED_MAPPING_MISMATCH' 'sourceHead' }
    if ((Get-SjqString $Map 'scope' 'scopedMapping') -cne 'SOURCE_ONLY_SCOPED_OFFLINE') { Stop-SjqRefused 'SCOPED_MAPPING_SCOPE' }
    $decision = Get-SjqString $Map 'decision' 'scopedMapping'
    $expectedDecision = if ($Kind -ceq 'DELIVERED') { 'SOURCE_ACCEPTED' } else { $Kind }
    if ($decision -cne $expectedDecision) { Stop-SjqRefused 'SCOPED_MAPPING_DECISION' "$decision/$Kind" }
    if ((Get-SjqString $Map 'reviewer' 'scopedMapping') -cne $Reviewer) { Stop-SjqRefused 'SCOPED_MAPPING_MISMATCH' 'reviewer' }
    $original = Get-SjqRef $Map['originalReviewRef'] 'scopedMapping.originalReviewRef'
    $originalBytes = Get-SjqPinnedBytes $original.path $original.sha256 'scopedMapping.originalReviewRef'
    if ($decision -ceq 'SOURCE_ACCEPTED') {
        # The original review keeps its own scoped schema/decision and needs no root PASS, but a root outcome that
        # records a known failed/not-run required check can never back an acceptance.
        try { $originalDoc = ConvertFrom-SjqJsonBytes $originalBytes 'originalReview' } catch { $originalDoc = $null }
        if ($originalDoc -is [System.Collections.IDictionary]) {
            $originalCounts = Get-SjqVerdictCounts $originalDoc 'scopedMapping.originalReviewRef' -IgnoreUnknownStrings
            if ($originalCounts.Failure -gt 0) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_FAILED' 'originalReviewRef' }
        }
    }
    $results =Get-SjqList $Map 'resultRefs' 'scopedMapping'
    if ($results.Count -eq 0) { Stop-SjqRefused 'EMPTY_LIST' 'scopedMapping.resultRefs' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in $results) {
        $result = Get-SjqRef $item 'scopedMapping.resultRefs'
        if (-not $seen.Add("$($result.path)|$($result.sha256)")) { Stop-SjqRefused 'DUPLICATE_ITEM' 'scopedMapping.resultRefs' }
        $resultBytes = Get-SjqPinnedBytes $result.path $result.sha256 'scopedMapping.resultRefs'
        # An acceptance needs executable results that positively say success through the small set of typed ROOT
        # indicators; a hash or a non-empty file proves nothing. Rejection/failure decisions are not checked here.
        if ($decision -ceq 'SOURCE_ACCEPTED') {
            try { $parsed = ConvertFrom-SjqJsonBytes $resultBytes 'result' } catch { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_UNSUPPORTED' 'resultRefs' }
            if ($parsed -isnot [System.Collections.IDictionary]) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_UNSUPPORTED' 'resultRefs' }
            $counts = Get-SjqVerdictCounts $parsed 'scopedMapping.resultRefs'
            if ($counts.Failure -gt 0 -and $counts.Success -gt 0) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_CONFLICT' 'resultRefs' }
            if ($counts.Failure -gt 0) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_FAILED' 'resultRefs' }
            if ($counts.Success -eq 0) { Stop-SjqRefused 'SCOPED_MAPPING_RESULT_UNSUPPORTED' 'resultRefs' }
        }
    }
    [ordered]@{ variant = 'SOURCE_ONLY_SCOPED_MAPPING'; mappingId = $mappingId; originalReviewRef = $original; scope = 'SOURCE_ONLY_SCOPED_OFFLINE' }
}

# Returns the scoped-mapping info when that variant was used, otherwise $null (legacy IndependentComponentReview/v1).
function Assert-SjqReviewReceipt($Ref, [string]$Kind, [string]$Reviewer, $Head, $Job, $Pins) {
    $bytes = Get-SjqPinnedBytes $Ref.path $Ref.sha256 'reviewRef'
    try { $probe = ConvertFrom-SjqJsonBytes $bytes 'review' } catch { $probe = $null }
    if (($probe -is [System.Collections.IDictionary]) -and (Test-SjqHasKey $probe 'schema') -and ($probe['schema'] -ceq 'SourceJobScopedReviewMapping/v1')) {
        return (Assert-SjqScopedMapping $probe $Ref $Kind $Reviewer $Head $Job $Pins)
    }
    if ($Kind -ceq 'SOURCE_ACCEPTED') {
        $review = ConvertFrom-SjqJsonBytes $bytes 'review'
        if ((Get-SjqString $review 'schema' 'review') -cne 'IndependentComponentReview/v1') { Stop-SjqRefused 'REVIEW_SCHEMA' }
        if ((Get-SjqString $review 'decision' 'review') -cne 'ACCEPT_SCOPED_SOURCE') { Stop-SjqRefused 'REVIEW_DECISION' }
        if ((Get-SjqString $review 'typecheck' 'review') -cne 'PASS' -or (Get-SjqString $review 'build' 'review') -cne 'PASS') { Stop-SjqRefused 'REVIEW_CHECKS' }
        if (-not (Test-SjqHasKey $review 'focusedTests') -or $null -eq $review['focusedTests']) { Stop-SjqRefused 'MISSING_KEY' 'review.focusedTests' }
        if ((Get-SjqBool $review 'ciRequiredBeforeDelivery' 'review') -ne $true) { Stop-SjqRefused 'REVIEW_CHECKS' 'ciRequiredBeforeDelivery' }
        $commit = Get-SjqString $review 'commit' 'review' $script:SjqSha40Pattern
        if ($null -ne $Head -and $commit -cne $Head) { Stop-SjqRefused 'REVIEW_HEAD_MISMATCH' }
        if ((Get-SjqString $review 'reviewer' 'review') -cne $Reviewer) { Stop-SjqRefused 'REVIEW_REVIEWER_MISMATCH' }
        return
    }
    # A rejection/failure diagnosis is opaque, but it may not be a structured acceptance in disguise.
    try { $parsed = ConvertFrom-SjqJsonBytes $bytes 'review' } catch { return }
    if (($parsed -is [System.Collections.IDictionary]) -and (Test-SjqHasKey $parsed 'decision') -and ($parsed['decision'] -ceq 'ACCEPT_SCOPED_SOURCE') -and $Kind -cne 'DELIVERED') {
        Stop-SjqRefused 'REVIEW_CONTRADICTS_KIND' $Kind
    }
}

function Assert-SjqDeliveryReceipt($Ref, [string]$Head, $Accepted, $DeliveredMapping) {
    $d = Get-SjqEvidenceJson $Ref 'delivery'
    if ((Get-SjqString $d 'schema' 'delivery') -cne 'IndependentDeliveryReceipt/v1') { Stop-SjqRefused 'DELIVERY_SCHEMA' }
    if ($null -ne $DeliveredMapping) {
        # Source-only variant: the actual typed receipt (PR, head, merge, CI) linked to the reviewed delivery verdict.
        # Source-only evidence never claims activation or continuous-owner acceptance, so both must be explicit false.
        Assert-SjqKeys $d @('schema', 'pr', 'head', 'merge', 'mergedAt', 'checks', 'checksConclusion', 'componentVerdictSha256', 'operationalActivation', 'continuousOwnerAccepted') 'delivery'
        $null = Get-SjqString $d 'pr' 'delivery'
        if ((Get-SjqString $d 'head' 'delivery' $script:SjqSha40Pattern) -cne $Head) { Stop-SjqRefused 'DELIVERY_MISMATCH' 'head' }
        $null = Get-SjqString $d 'merge' 'delivery' $script:SjqSha40Pattern
        $null = ConvertTo-SjqUtc (Get-SjqString $d 'mergedAt' 'delivery') 'delivery.mergedAt'
        if ((Get-SjqInt $d 'checks' 'delivery' 1) -lt 1) { Stop-SjqRefused 'DELIVERY_CHECKS' 'checks' }
        if ((Get-SjqString $d 'checksConclusion' 'delivery') -cne 'ALL_SUCCESS') { Stop-SjqRefused 'DELIVERY_CHECKS' 'checksConclusion' }
        if ((Get-SjqBool $d 'operationalActivation' 'delivery') -ne $false -or (Get-SjqBool $d 'continuousOwnerAccepted' 'delivery') -ne $false) { Stop-SjqRefused 'DELIVERY_CLAIMS' }
        if ((Get-SjqString $d 'componentVerdictSha256' 'delivery' $script:SjqShaPattern) -cne [string]$DeliveredMapping['originalReviewRef']['sha256']) { Stop-SjqRefused 'DELIVERY_MISMATCH' 'componentVerdictSha256' }
        return
    }
    if ((Get-SjqString $d 'head' 'delivery' $script:SjqSha40Pattern) -cne $Head) { Stop-SjqRefused 'DELIVERY_MISMATCH' 'head' }
    $null = Get-SjqString $d 'merge' 'delivery' $script:SjqSha40Pattern
    foreach ($key in 'pr', 'checks', 'focusedTests') {
        if (-not (Test-SjqHasKey $d $key) -or $null -eq $d[$key] -or (($d[$key] -is [string]) -and [string]::IsNullOrWhiteSpace($d[$key]))) { Stop-SjqRefused 'DELIVERY_CHECKS' $key }
    }
    if ((Get-SjqString $d 'checksConclusion' 'delivery') -cne 'ALL_SUCCESS') { Stop-SjqRefused 'DELIVERY_CHECKS' 'checksConclusion' }
    if ((Get-SjqString $d 'normalTypecheck' 'delivery') -cne 'PASS' -or (Get-SjqString $d 'normalBuild' 'delivery') -cne 'PASS') { Stop-SjqRefused 'DELIVERY_CHECKS' 'typecheck/build' }
    if ((Get-SjqString $d 'sourceReviewSha256' 'delivery' $script:SjqShaPattern) -cne [string]$Accepted['reviewRef']['sha256']) { Stop-SjqRefused 'DELIVERY_MISMATCH' 'sourceReviewSha256' }
}

function Add-SjqDisposition($Queue, $Event, [string]$AtUtc) {
    Assert-SjqKeys $Event @('schema', 'eventId', 'type', 'jobId', 'dispositionRef', 'dispositionAdmissionRef') 'event'
    $job = Get-SjqExistingJob $Queue (Get-SjqString $Event 'jobId' 'event' $script:SjqIdPattern)
    $state = [string]$job['state']
    $review = Get-SjqReview $job
    $dispositionRef = Get-SjqRef $Event['dispositionRef'] 'event.dispositionRef'
    $admissionDocRef = Get-SjqRef $Event['dispositionAdmissionRef'] 'event.dispositionAdmissionRef'

    $a = Get-SjqEvidenceJson $dispositionRef 'disposition'
    Assert-SjqKeys $a @('schema', 'dispositionId', 'jobId', 'taskId', 'planRef', 'admissionRef', 'terminalRef', 'candidatePins', 'sourceHead', 'kind', 'reviewer', 'reviewRef', 'deliveryRef', 'candidateMappingRef') 'disposition'
    if ((Get-SjqString $a 'schema' 'disposition') -cne 'SourceJobIndependentDisposition/v1') { Stop-SjqRefused 'DISPOSITION_SCHEMA' }
    $dispositionId = Get-SjqString $a 'dispositionId' 'disposition' $script:SjqIdPattern
    Assert-SjqTuple $a $job 'disposition'
    $kind = Get-SjqString $a 'kind' 'disposition'
    if (@('SOURCE_ACCEPTED', 'SOURCE_REJECTED', 'FAILED', 'DELIVERED') -cnotcontains $kind) { Stop-SjqRefused 'BAD_VALUE' 'disposition.kind' }
    $owner = Get-SjqJobOwner $job
    $reviewer = Get-SjqString $a 'reviewer' 'disposition' $script:SjqActorPattern
    Assert-SjqIndependentActor $reviewer $job $owner 'disposition.reviewer'
    $reviewRef = Get-SjqRef $a['reviewRef'] 'disposition.reviewRef'
    $deliveryRef = Get-SjqNullableRef $a 'deliveryRef' 'disposition'
    $mappingRef = Get-SjqNullableRef $a 'candidateMappingRef' 'disposition'
    $head = Get-SjqSourceHead $a 'disposition'
    $pins = Get-SjqPins $a 'candidatePins' 'disposition' @($job['ownedPaths'])

    # The host-reviewed admission must restate exactly the same envelope; this module never issues it.
    $b = Get-SjqEvidenceJson $admissionDocRef 'dispositionAdmission'
    Assert-SjqKeys $b @('schema', 'admissionId', 'decision', 'reviewer', 'dispositionRef', 'jobId', 'taskId', 'planRef', 'admissionRef', 'terminalRef', 'candidatePins', 'sourceHead') 'dispositionAdmission'
    if ((Get-SjqString $b 'schema' 'dispositionAdmission') -cne 'SourceJobDispositionAdmission/v1') { Stop-SjqRefused 'DISPOSITION_ADMISSION_SCHEMA' }
    $null = Get-SjqString $b 'admissionId' 'dispositionAdmission' $script:SjqIdPattern
    if ((Get-SjqString $b 'decision' 'dispositionAdmission') -cne 'ADMIT_SCOPED_SOURCE_DISPOSITION') { Stop-SjqRefused 'DISPOSITION_ADMISSION_DECISION' }
    Assert-SjqIndependentActor (Get-SjqString $b 'reviewer' 'dispositionAdmission' $script:SjqActorPattern) $job $owner 'dispositionAdmission.reviewer'
    if (-not (Test-SjqRefEqual (Get-SjqRef $b['dispositionRef'] 'dispositionAdmission.dispositionRef') $dispositionRef)) { Stop-SjqRefused 'DISPOSITION_ADMISSION_MISMATCH' 'dispositionRef' }
    Assert-SjqTuple $b $job 'dispositionAdmission'
    $bPins = Get-SjqPins $b 'candidatePins' 'dispositionAdmission' @($job['ownedPaths'])
    if ((ConvertTo-SjqCanonical $bPins) -cne (ConvertTo-SjqCanonical $pins)) { Stop-SjqRefused 'DISPOSITION_ADMISSION_MISMATCH' 'candidatePins' }
    if ([string](Get-SjqSourceHead $b 'dispositionAdmission') -cne [string]$head) { Stop-SjqRefused 'DISPOSITION_ADMISSION_MISMATCH' 'sourceHead' }

    # Kind and state must agree; a rejected or failed review never upgrades itself to acceptance.
    switch -CaseSensitive ($kind) {
        'FAILED' {
            if (@('FAILED', 'REFUSED', 'RECONCILIATION_REQUIRED') -cnotcontains $state -or $null -ne $review['disposition']) { Stop-SjqRefused 'STATE_KIND_MISMATCH' "$state/$kind" }
        }
        { $_ -ceq 'SOURCE_ACCEPTED' -or $_ -ceq 'SOURCE_REJECTED' } {
            if ($state -cne 'REVIEW_REQUIRED') { Stop-SjqRefused 'STATE_KIND_MISMATCH' "$state/$kind" }
            if ($null -eq $review['handoff']) { Stop-SjqRefused 'NO_HANDOFF_ACK' ([string]$job['jobId']) }
        }
        'DELIVERED' {
            if ($state -cne 'SOURCE_REVIEW_ACCEPTED') { Stop-SjqRefused 'STATE_KIND_MISMATCH' "$state/$kind" }
        }
    }

    $terminalPins = Get-SjqTerminalPins $job
    $terminalCanon = ConvertTo-SjqCanonical $terminalPins
    if ($kind -ceq 'DELIVERED') {
        if ($null -eq $deliveryRef) { Stop-SjqRefused 'DELIVERY_REF_REQUIRED' }
        if ($null -eq $head) { Stop-SjqRefused 'SOURCE_HEAD_REQUIRED' }
    }
    elseif ($null -ne $deliveryRef -or $null -ne $mappingRef) { Stop-SjqRefused 'DELIVERY_REF_NOT_ALLOWED' $kind }

    if ($null -eq $mappingRef) {
        if ((ConvertTo-SjqCanonical $pins) -cne $terminalCanon) { Stop-SjqRefused 'CANDIDATE_MISMATCH' 'disposition' }
    }
    else {
        # The only supported normalization: an independently reviewed from->to pin mapping anchored to the immutable terminal.
        $f = Get-SjqEvidenceJson $mappingRef 'mapping'
        Assert-SjqKeys $f @('schema', 'mappingId', 'jobId', 'taskId', 'terminalRef', 'fromPins', 'toPins', 'sourceHead', 'reviewRef', 'reviewer') 'mapping'
        if ((Get-SjqString $f 'schema' 'mapping') -cne 'SourceJobCandidateMapping/v1') { Stop-SjqRefused 'MAPPING_SCHEMA' }
        $null = Get-SjqString $f 'mappingId' 'mapping' $script:SjqIdPattern
        if ((Get-SjqString $f 'jobId' 'mapping') -cne [string]$job['jobId'] -or (Get-SjqString $f 'taskId' 'mapping') -cne [string]$job['plan']['taskId']) { Stop-SjqRefused 'MAPPING_MISMATCH' 'identity' }
        if (-not (Test-SjqRefEqual (Get-SjqRef $f['terminalRef'] 'mapping.terminalRef') $job['terminal']['ref'])) { Stop-SjqRefused 'MAPPING_MISMATCH' 'terminalRef' }
        $from = Get-SjqPins $f 'fromPins' 'mapping' @($job['ownedPaths'])
        $to = Get-SjqPins $f 'toPins' 'mapping' @($job['ownedPaths'])
        if ((ConvertTo-SjqCanonical $from) -cne $terminalCanon) { Stop-SjqRefused 'MAPPING_MISMATCH' 'fromPins' }
        if ((ConvertTo-SjqCanonical $to) -cne (ConvertTo-SjqCanonical $pins)) { Stop-SjqRefused 'MAPPING_MISMATCH' 'toPins' }
        if ((ConvertTo-SjqCanonical $from) -ceq (ConvertTo-SjqCanonical $to)) { Stop-SjqRefused 'MAPPING_NOT_NEEDED' }
        if ([string](Get-SjqSourceHead $f 'mapping') -cne [string]$head) { Stop-SjqRefused 'MAPPING_MISMATCH' 'sourceHead' }
        $mappingReview = Get-SjqRef $f['reviewRef'] 'mapping.reviewRef'
        $null = Get-SjqPinnedBytes $mappingReview.path $mappingReview.sha256 'mapping.reviewRef'
        Assert-SjqIndependentActor (Get-SjqString $f 'reviewer' 'mapping' $script:SjqActorPattern) $job $owner 'mapping.reviewer'
    }

    $scoped = Assert-SjqReviewReceipt $reviewRef $kind $reviewer $head $job $pins
    if ($kind -ceq 'DELIVERED') {
        $accepted = $review['disposition']
        if ($null -eq $accepted -or [string]$accepted['kind'] -cne 'SOURCE_ACCEPTED') { Stop-SjqRefused 'STATE_KIND_MISMATCH' 'no accepted source review' }
        # The scoped variant is all-or-nothing across the chain: a mapped acceptance needs a mapped delivery verdict.
        if (($null -ne $accepted['scopedMapping']) -ne ($null -ne $scoped)) { Stop-SjqRefused 'REVIEW_VARIANT_MISMATCH' }
        Assert-SjqDeliveryReceipt $deliveryRef $head $accepted $scoped
    }
    # Candidate bytes are rechecked here, under the lease, immediately before the index is replaced.
    if ($kind -ceq 'SOURCE_ACCEPTED' -or $kind -ceq 'DELIVERED') {
        foreach ($pin in $pins) {
            if (-not [IO.File]::Exists($pin.path)) { Stop-SjqRefused 'CANDIDATE_DRIFT' $pin.path }
            if ((Get-SjqStreamedDigest $pin.path 'candidate').Sha256 -cne $pin.sha256) { Stop-SjqRefused 'CANDIDATE_DRIFT' $pin.path }
        }
    }

    $handoff = $review['handoff']
    $record = [ordered]@{
        dispositionId = $dispositionId; kind = $kind; reviewer = $reviewer; ref = $dispositionRef; admissionRef = $admissionDocRef; reviewRef = $reviewRef
        deliveryRef = $deliveryRef; candidateMappingRef = $mappingRef; scopedMapping = $scoped; candidatePins = $pins; sourceHead = $head; eventId = Get-SjqString $Event 'eventId' 'event'
        evidenceMode = $(if (($handoff -is [System.Collections.IDictionary]) -and $handoff['mock'] -eq $true) { 'HANDOFF_MOCK_NOT_LIVE' } else { 'NOT_MOCK_LABELLED' })
    }
    $history = [Collections.Generic.List[object]]::new()
    foreach ($earlier in @($review['history'])) { $history.Add($earlier) }
    $history.Add($record)
    $review['history'] = $history.ToArray()
    $review['disposition'] = $record
    switch -CaseSensitive ($kind) {
        'FAILED' { $job['notice'] = 'FAILURE_DISPOSITIONED_AWAITING_RELEASE' }
        'SOURCE_ACCEPTED' { $job['state'] = 'SOURCE_REVIEW_ACCEPTED'; $job['notice'] = 'SOURCE_REVIEW_ACCEPTED_PENDING_DELIVERY_NOT_FACTORY_COMPLETE' }
        'SOURCE_REJECTED' { $job['state'] = 'SOURCE_REJECTED'; $job['notice'] = 'SOURCE_REJECTED_AWAITING_RELEASE' }
        'DELIVERED' { $job['state'] = 'DELIVERED_PENDING_RELEASE'; $job['notice'] = 'DELIVERED_AWAITING_SEPARATE_RELEASE' }
    }
    [string]$job['jobId']
}

function Add-SjqRelease($Queue, $Event, [string]$AtUtc) {
    Assert-SjqKeys $Event @('schema', 'eventId', 'type', 'jobId', 'releaseRef') 'event'
    $job = Get-SjqExistingJob $Queue (Get-SjqString $Event 'jobId' 'event' $script:SjqIdPattern)
    $state = [string]$job['state']
    $review = Get-SjqReview $job
    $disposition = $review['disposition']
    if ($null -eq $disposition) { Stop-SjqRefused 'RELEASE_WITHOUT_DISPOSITION' ([string]$job['jobId']) }
    $releaseRef = Get-SjqRef $Event['releaseRef'] 'event.releaseRef'
    $e = Get-SjqEvidenceJson $releaseRef 'release'
    Assert-SjqKeys $e @('schema', 'releaseId', 'jobId', 'taskId', 'planRef', 'admissionRef', 'terminalRef', 'dispositionRef', 'dispositionAdmissionRef', 'ownedPaths', 'reviewer', 'releasedUtc') 'release'
    if ((Get-SjqString $e 'schema' 'release') -cne 'SourceJobOwnershipRelease/v1') { Stop-SjqRefused 'RELEASE_SCHEMA' }
    $releaseId = Get-SjqString $e 'releaseId' 'release' $script:SjqIdPattern
    Assert-SjqTuple $e $job 'release'
    if (-not (Test-SjqRefEqual (Get-SjqRef $e['dispositionRef'] 'release.dispositionRef') $disposition['ref'])) { Stop-SjqRefused 'RELEASE_LINKAGE' 'dispositionRef' }
    if (-not (Test-SjqRefEqual (Get-SjqRef $e['dispositionAdmissionRef'] 'release.dispositionAdmissionRef') $disposition['admissionRef'])) { Stop-SjqRefused 'RELEASE_LINKAGE' 'dispositionAdmissionRef' }
    $paths = Get-SjqPathList $e 'ownedPaths' 'release'
    if ((ConvertTo-SjqSortedKey $paths) -cne (ConvertTo-SjqSortedKey ([string[]]@($job['ownedPaths'])))) { Stop-SjqRefused 'RELEASE_PATHS_MISMATCH' }
    $reviewer = Get-SjqString $e 'reviewer' 'release' $script:SjqActorPattern
    Assert-SjqIndependentActor $reviewer $job (Get-SjqJobOwner $job) 'release.reviewer'
    $releasedUtc = Get-SjqString $e 'releasedUtc' 'release'
    $null = ConvertTo-SjqUtc $releasedUtc 'release.releasedUtc'

    if ($state -ceq 'DELIVERED_PENDING_RELEASE') { $newState = 'DELIVERED_RELEASED'; $notice = 'DELIVERED_RELEASED_SOURCE_ONLY_NOT_FACTORY_COMPLETE' }
    elseif ($state -ceq 'SOURCE_REVIEW_ACCEPTED') { Stop-SjqRefused 'RELEASE_BEFORE_DELIVERY' }
    elseif (@('FAILED', 'REFUSED', 'RECONCILIATION_REQUIRED', 'SOURCE_REJECTED') -ccontains $state) { $newState = 'RELEASED_FAILED'; $notice = 'RELEASED_FAILED_FREES_PATHS_NEVER_SUCCESS' }
    else { Stop-SjqRefused 'RELEASE_STATE' $state }

    $job['state'] = $newState
    $job['notice'] = $notice
    $review['release'] = [ordered]@{ releaseId = $releaseId; ref = $releaseRef; reviewer = $reviewer; releasedUtc = $releasedUtc; releasedFrom = $state; dispositionKind = [string]$disposition['kind']; eventId = Get-SjqString $Event 'eventId' 'event' }
    [string]$job['jobId']
}

# ---------- public API ----------

function Invoke-SourceJobQueueEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath,
        [Parameter(Mandatory)][long]$ExpectedVersion,
        [Parameter(Mandatory)][string]$EventPath,
        [Parameter(Mandatory)][string]$ExpectedEventSha256,
        [Parameter(Mandatory)][string]$AtUtc
    )
    $ErrorActionPreference = 'Stop'
    Assert-SjqIndexPath $IndexPath
    $null = ConvertTo-SjqUtc $AtUtc 'AtUtc'
    if ($ExpectedVersion -lt 0) { Stop-SjqRefused 'BAD_VERSION' }

    $evt = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $EventPath $ExpectedEventSha256 'event') 'event'
    if ((Get-SjqString $evt 'schema' 'event') -cne $script:SjqEventSchema) { Stop-SjqRefused 'EVENT_SCHEMA' }
    $eventId = Get-SjqString $evt 'eventId' 'event' $script:SjqIdPattern
    $type = Get-SjqString $evt 'type' 'event'

    $lease = Enter-SjqLease $IndexPath
    try {
        $state = Read-SjqIndexState $IndexPath
        $queue = $state.Queue
        if ($queue['events'].Contains($eventId)) {
            if ([string]$queue['events'][$eventId] -ceq $ExpectedEventSha256) {
                return [pscustomobject]@{ Status = 'NOOP_DUPLICATE'; EventId = $eventId; Version = [long]$queue['version'] }
            }
            Stop-SjqRefused 'EVENT_ID_CONFLICT' $eventId
        }
        if ([long]$queue['version'] -ne $ExpectedVersion) { Stop-SjqRefused 'VERSION_CONFLICT' "expected=$ExpectedVersion actual=$($queue['version'])" }

        switch -CaseSensitive ($type) {
            'REGISTER_SOURCE_JOB' { $jobId = Add-SjqRegistration $queue $evt $AtUtc }
            'OBSERVED_START' { $jobId = Add-SjqObservedStart $queue $evt $AtUtc }
            'OBSERVED_TERMINAL' { $jobId = Add-SjqObservedTerminal $queue $evt $AtUtc }
            'REVIEW_INTENT' { $jobId = Add-SjqReviewIntent $queue $evt $AtUtc }
            'REVIEW_HANDOFF_ACK' { $jobId = Add-SjqReviewAck $queue $evt $AtUtc }
            'SOURCE_DISPOSITION' { $jobId = Add-SjqDisposition $queue $evt $AtUtc }
            'SOURCE_OWNERSHIP_RELEASE' { $jobId = Add-SjqRelease $queue $evt $AtUtc }
            default { Stop-SjqRefused 'UNKNOWN_EVENT_TYPE' $type }
        }
        $queue['events'][$eventId] = $ExpectedEventSha256
        $queue['version'] = [long]$queue['version'] + 1
        $state.Registry[$script:SjqKey] = $queue
        Save-SjqIndex $IndexPath $state.Root
        [pscustomobject]@{ Status = 'APPLIED'; EventId = $eventId; Version = [long]$queue['version']; JobId = $jobId; JobState = [string]$queue['jobs'][$jobId]['state'] }
    }
    finally { $lease.Dispose() }
}

function Get-SjqSkipReasons($Queue, $Job, [DateTimeOffset]$At) {
    $reasons = [Collections.Generic.List[string]]::new()
    $state = [string]$Job['state']
    if ($state -cne 'SOURCE_PREPARED') { $reasons.Add("STATE_$state"); return , $reasons.ToArray() }
    # Only a verified source delivery followed by its separate release satisfies a dependency. Missing,
    # pending, review, uncertain, unreleased and failed-released dependencies all keep blocking.
    foreach ($dependency in $Job['dependsOn']) {
        $dependencyJob = if ($Queue['jobs'].Contains([string]$dependency)) { $Queue['jobs'][[string]$dependency] } else { $null }
        $dependencyState = if ($null -eq $dependencyJob) { '' } else { [string]$dependencyJob['state'] }
        if ($dependencyState -cne 'DELIVERED_RELEASED') { $reasons.Add("UNRESOLVED_DEPENDENCY:$dependency") }
        if ($dependencyState -ceq 'RELEASED_FAILED') { $reasons.Add("DEPENDENCY_FAILED_RELEASED:$dependency") }
    }
    if ($At -ge (ConvertTo-SjqUtc $Job['admission']['expiresUtc'] 'expiresUtc')) { $reasons.Add('REFRESH_REQUIRED:ADMISSION_EXPIRED') }
    try {
        $null = Get-SjqPinnedBytes $Job['plan']['ref']['path'] $Job['plan']['ref']['sha256'] 'planRef'
        $null = Get-SjqPinnedBytes $Job['admission']['ref']['path'] $Job['admission']['ref']['sha256'] 'admissionRef'
    }
    catch { $reasons.Add('REFRESH_REQUIRED:REF_PIN_DRIFT') }
    $conflicts = [Collections.Generic.List[string]]::new()
    foreach ($other in $Queue['jobs'].Values) {
        if ($other['jobId'] -ceq $Job['jobId']) { continue }
        if ($script:SjqBlockingStates -cnotcontains [string]$other['state']) { continue }
        if (Test-SjqAnyOverlap $Job['ownedPaths'] $other['ownedPaths']) { $conflicts.Add([string]$other['jobId']) }
    }
    $conflicts.Sort([StringComparer]::Ordinal)
    foreach ($conflict in $conflicts) { $reasons.Add("PATH_CONFLICT:$conflict") }
    , $reasons.ToArray()
}

function Reserve-NextSourceJob {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath,
        [Parameter(Mandatory)][long]$ExpectedVersion,
        [Parameter(Mandatory)][string[]]$CandidateJobIds,
        [Parameter(Mandatory)][string]$ReservationId,
        [Parameter(Mandatory)][string]$AtUtc
    )
    $ErrorActionPreference = 'Stop'
    Assert-SjqIndexPath $IndexPath
    if ($ReservationId -cnotmatch $script:SjqIdPattern) { Stop-SjqRefused 'BAD_VALUE' 'ReservationId' }
    $at = ConvertTo-SjqUtc $AtUtc 'AtUtc'
    if ($ExpectedVersion -lt 0) { Stop-SjqRefused 'BAD_VERSION' }
    $unique = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($id in $CandidateJobIds) {
        if ($id -cnotmatch $script:SjqIdPattern) { Stop-SjqRefused 'BAD_VALUE' 'CandidateJobIds' }
        if (-not $unique.Add($id)) { Stop-SjqRefused 'DUPLICATE_ITEM' 'CandidateJobIds' }
    }
    if ($unique.Count -eq 0) { Stop-SjqRefused 'EMPTY_LIST' 'CandidateJobIds' }
    $sortedIds = [Collections.Generic.List[string]]::new($unique)
    $sortedIds.Sort([StringComparer]::Ordinal)
    $setSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($sortedIds -join "`n")))).ToLowerInvariant()

    $lease = Enter-SjqLease $IndexPath
    try {
        $state = Read-SjqIndexState $IndexPath
        $queue = $state.Queue
        if ($queue['reservations'].Contains($ReservationId)) {
            $existing = $queue['reservations'][$ReservationId]
            if ($existing['candidateSetSha256'] -cne $setSha) { Stop-SjqRefused 'RESERVATION_ID_CONFLICT' $ReservationId }
            return [pscustomobject]@{ Status = 'NOOP_DUPLICATE'; Reserved = $true; JobId = [string]$existing['jobId']; ReservationId = $ReservationId; ReservationOnly = $true; Version = [long]$queue['version']; Skips = @() }
        }
        if ([long]$queue['version'] -ne $ExpectedVersion) { Stop-SjqRefused 'VERSION_CONFLICT' "expected=$ExpectedVersion actual=$($queue['version'])" }

        $skips = [Collections.Generic.List[object]]::new()
        $eligible = [Collections.Generic.List[object]]::new()
        foreach ($id in $sortedIds) {
            if (-not $queue['jobs'].Contains($id)) { $skips.Add([pscustomobject]@{ JobId = $id; Reasons = [string[]]@('NOT_REGISTERED') }); continue }
            $job = $queue['jobs'][$id]
            $reasons = Get-SjqSkipReasons $queue $job $at
            if ($reasons.Count -gt 0) { $skips.Add([pscustomobject]@{ JobId = $id; Reasons = $reasons }) }
            else { $eligible.Add([pscustomobject]@{ JobId = $id; Priority = [long]$job['priority'] }) }
        }
        # Lower priority number first, then jobId, both ordinal and independent of input order.
        $eligible.Sort([Comparison[object]] {
                param($x, $y)
                $byPriority = $x.Priority.CompareTo($y.Priority)
                if ($byPriority -ne 0) { return $byPriority }
                return [string]::CompareOrdinal($x.JobId, $y.JobId)
            })
        if ($eligible.Count -eq 0) {
            return [pscustomobject]@{ Status = 'NO_ELIGIBLE_CANDIDATE'; Reserved = $false; JobId = $null; ReservationId = $null; ReservationOnly = $true; Version = [long]$queue['version']; Skips = $skips.ToArray() }
        }
        $winner = $eligible[0].JobId
        for ($i = 1; $i -lt $eligible.Count; $i++) { $skips.Add([pscustomobject]@{ JobId = $eligible[$i].JobId; Reasons = [string[]]@('NOT_SELECTED_ONE_RESERVATION_PER_CALL') }) }

        $job = $queue['jobs'][$winner]
        $job['state'] = 'DISPATCH_UNCERTAIN'
        $job['reservation'] = [ordered]@{ reservationId = $ReservationId; reservedUtc = $AtUtc; reservationOnly = $true; note = 'RESERVATION_ONLY_NOT_LAUNCHER_TOKEN_NOT_START_PROOF' }
        $queue['reservations'][$ReservationId] = [ordered]@{ jobId = $winner; reservedUtc = $AtUtc; candidateSetSha256 = $setSha }
        $queue['version'] = [long]$queue['version'] + 1
        $state.Registry[$script:SjqKey] = $queue
        Save-SjqIndex $IndexPath $state.Root
        [pscustomobject]@{ Status = 'RESERVED'; Reserved = $true; JobId = $winner; ReservationId = $ReservationId; ReservationOnly = $true; Version = [long]$queue['version']; Skips = $skips.ToArray() }
    }
    finally { $lease.Dispose() }
}

# One-time permission to attempt a launch for a reservation. NEWLY_CONSUMED (LaunchPermitted = $true) is valid
# only in the call that returns it; every replay, same or different attempt id, reports ALREADY_CONSUMED with
# LaunchPermitted = $false. The job stays DISPATCH_UNCERTAIN until an actual start is observed.
function Consume-SourceJobReservation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$IndexPath,
        [Parameter(Mandatory)][long]$ExpectedVersion,
        [Parameter(Mandatory)][string]$JobId,
        [Parameter(Mandatory)][string]$ReservationId,
        [Parameter(Mandatory)][string]$PlanPath,
        [Parameter(Mandatory)][string]$ExpectedPlanSha256,
        [Parameter(Mandatory)][string]$AdmissionPath,
        [Parameter(Mandatory)][string]$ExpectedAdmissionSha256,
        [Parameter(Mandatory)][string]$TaskId,
        [Parameter(Mandatory)][string]$SessionId,
        [Parameter(Mandatory)][string]$OperatorSha256,
        [Parameter(Mandatory)][string]$RunDirectory,
        [Parameter(Mandatory)][string]$AttemptId,
        [Parameter(Mandatory)][string]$ConsumedUtc
    )
    $ErrorActionPreference = 'Stop'
    Assert-SjqIndexPath $IndexPath
    if ($JobId -cnotmatch $script:SjqIdPattern) { Stop-SjqRefused 'BAD_VALUE' 'JobId' }
    if ($ReservationId -cnotmatch $script:SjqIdPattern) { Stop-SjqRefused 'BAD_VALUE' 'ReservationId' }
    if ($AttemptId -cnotmatch $script:SjqIdPattern) { Stop-SjqRefused 'BAD_VALUE' 'AttemptId' }
    if ($ExpectedPlanSha256 -cnotmatch $script:SjqShaPattern) { Stop-SjqRefused 'BAD_SHA' 'ExpectedPlanSha256' }
    if ($ExpectedAdmissionSha256 -cnotmatch $script:SjqShaPattern) { Stop-SjqRefused 'BAD_SHA' 'ExpectedAdmissionSha256' }
    if ($OperatorSha256 -cnotmatch $script:SjqShaPattern) { Stop-SjqRefused 'BAD_SHA' 'OperatorSha256' }
    $consumedAt = ConvertTo-SjqUtc $ConsumedUtc 'ConsumedUtc'
    if ($ExpectedVersion -lt 0) { Stop-SjqRefused 'BAD_VERSION' }
    Assert-SjqNormalizedPath $RunDirectory 'RunDirectory'

    $lease = Enter-SjqLease $IndexPath
    try {
        $state = Read-SjqIndexState $IndexPath
        $queue = $state.Queue
        $job = Get-SjqExistingJob $queue $JobId
        if (-not $queue['reservations'].Contains($ReservationId)) { Stop-SjqRefused 'RESERVATION_NOT_FOUND' $ReservationId }
        if ([string]$queue['reservations'][$ReservationId]['jobId'] -cne $JobId) { Stop-SjqRefused 'RESERVATION_MISMATCH' }
        $reservation = $job['reservation']
        if (($reservation -isnot [System.Collections.IDictionary]) -or ([string]$reservation['reservationId'] -cne $ReservationId)) { Stop-SjqRefused 'RESERVATION_MISMATCH' }

        # Replays never carry launch permission, whatever the version or attempt id.
        if ((Test-SjqHasKey $reservation 'consumed') -and ($reservation['consumed'] -eq $true)) {
            return [pscustomobject]@{
                Status = 'ALREADY_CONSUMED'; LaunchPermitted = $false; JobId = $JobId; ReservationId = $ReservationId
                SameAttempt = ([string]$reservation['consumption']['attemptId'] -ceq $AttemptId); AttemptId = [string]$reservation['consumption']['attemptId']
                Version = [long]$queue['version']; JobState = [string]$job['state']
            }
        }
        if ([long]$queue['version'] -ne $ExpectedVersion) { Stop-SjqRefused 'VERSION_CONFLICT' "expected=$ExpectedVersion actual=$($queue['version'])" }
        if ([string]$job['state'] -cne 'DISPATCH_UNCERTAIN') { Stop-SjqRefused 'STATE_NOT_RESERVED' ([string]$job['state']) }
        if ($null -ne $job['start'] -or $null -ne $job['terminal']) { Stop-SjqRefused 'ALREADY_RESOLVED' }

        # Re-authenticate the registered refs and the task/session/operator tuple under the lease.
        $planRef = $job['plan']['ref']
        $admissionRef = $job['admission']['ref']
        if ($PlanPath -cne $planRef['path'] -or $ExpectedPlanSha256 -cne $planRef['sha256']) { Stop-SjqRefused 'PLAN_REF_MISMATCH' }
        if ($AdmissionPath -cne $admissionRef['path'] -or $ExpectedAdmissionSha256 -cne $admissionRef['sha256']) { Stop-SjqRefused 'ADMISSION_REF_MISMATCH' }
        $plan = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $PlanPath $ExpectedPlanSha256 'planRef') 'plan'
        $admission = ConvertFrom-SjqJsonBytes (Get-SjqPinnedBytes $AdmissionPath $ExpectedAdmissionSha256 'admissionRef') 'admission'
        if ((Get-SjqString $plan 'schema' 'plan') -cne 'SupervisedCodeSourceOnlyTask/v1') { Stop-SjqRefused 'PLAN_SCHEMA' }
        $planTask = Get-SjqString $plan 'taskId' 'plan'
        if ($planTask -cne $job['plan']['taskId'] -or $planTask -cne $TaskId) { Stop-SjqRefused 'IDENTITY_DRIFT' 'taskId' }
        $planSession = Get-SjqString $plan 'sessionId' 'plan'
        if ($planSession -cne $job['plan']['sessionId'] -or $planSession -cne $SessionId) { Stop-SjqRefused 'IDENTITY_DRIFT' 'sessionId' }
        $planRun = Get-SjqString $plan 'runDirectory' 'plan'
        if ($planRun -cne $job['plan']['runDirectory'] -or $planRun -cne $RunDirectory) { Stop-SjqRefused 'RUN_DIRECTORY_MISMATCH' }

        if ((Get-SjqString $admission 'schema' 'admission') -cne 'IndependentSupervisedSourceOnlyAdmission/v1') { Stop-SjqRefused 'ADMISSION_SCHEMA' }
        if ((Get-SjqString $admission 'decision' 'admission') -cne 'ADMIT_SOURCE_ONLY_ONCE') { Stop-SjqRefused 'ADMISSION_DECISION' }
        if ((Get-SjqString $admission 'planSha256' 'admission' $script:SjqShaPattern) -cne $ExpectedPlanSha256) { Stop-SjqRefused 'ADMISSION_PLAN_MISMATCH' }
        if ((Get-SjqString $admission 'taskId' 'admission') -cne $planTask) { Stop-SjqRefused 'ADMISSION_TASK_MISMATCH' }
        $reviewer = Get-SjqString $admission 'reviewer' 'admission'
        if ($reviewer -ceq '/root/bounded_state_check' -or $reviewer -cne $job['admission']['reviewer']) { Stop-SjqRefused 'ADMISSION_REVIEWER' }
        if ((Get-SjqInt $admission 'maximumNativeProcesses' 'admission') -ne 1) { Stop-SjqRefused 'ADMISSION_PROCESS_COUNT' }
        if ((Get-SjqString $admission 'operatorSha256' 'admission' $script:SjqShaPattern) -cne $OperatorSha256) { Stop-SjqRefused 'OPERATOR_MISMATCH' }
        $expiresUtc = Get-SjqString $admission 'expiresUtc' 'admission'
        if ($expiresUtc -cne $job['admission']['expiresUtc']) { Stop-SjqRefused 'ADMISSION_DRIFT' 'expiresUtc' }
        # Prelaunch expiry only: it is checked here, before consumption, and never afterwards.
        if ($consumedAt -ge (ConvertTo-SjqUtc $expiresUtc 'admission.expiresUtc')) { Stop-SjqRefused 'ADMISSION_EXPIRED' }
        if ($consumedAt -lt (ConvertTo-SjqUtc $reservation['reservedUtc'] 'reservedUtc')) { Stop-SjqRefused 'CONSUME_BEFORE_RESERVATION' }
        foreach ($other in $queue['jobs'].Values) {
            $otherReservation = $other['reservation']
            if (($otherReservation -is [System.Collections.IDictionary]) -and (Test-SjqHasKey $otherReservation 'consumption') -and ([string]$otherReservation['consumption']['attemptId'] -ceq $AttemptId)) {
                Stop-SjqRefused 'ATTEMPT_ID_CONFLICT' $AttemptId
            }
        }

        $newVersion = [long]$queue['version'] + 1
        $reservation['consumed'] = $true
        $reservation['consumption'] = [ordered]@{ attemptId = $AttemptId; consumedUtc = $ConsumedUtc; runDirectory = $RunDirectory; operatorSha256 = $OperatorSha256; indexVersion = $newVersion; note = 'CONSUMED_NOT_RUNNING_NOT_ACCEPTED_NEVER_RESET' }
        $queue['reservations'][$ReservationId]['consumed'] = $true
        $queue['reservations'][$ReservationId]['attemptId'] = $AttemptId
        $queue['version'] = $newVersion
        $state.Registry[$script:SjqKey] = $queue
        Save-SjqIndex $IndexPath $state.Root
        [pscustomobject]@{
            Status = 'NEWLY_CONSUMED'; LaunchPermitted = $true; JobId = $JobId; ReservationId = $ReservationId; AttemptId = $AttemptId
            ConsumedUtc = $ConsumedUtc; Version = $newVersion; JobState = [string]$job['state']
        }
    }
    finally { $lease.Dispose() }
}
