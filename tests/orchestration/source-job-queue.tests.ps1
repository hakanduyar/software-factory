# Offline harness for scripts/orchestration/source-job-queue.ps1.
# Run: pwsh -NoProfile -File tests/orchestration/source-job-queue.tests.ps1
# Uses only fresh index copies and fixture files under a private temp directory. It never
# touches a live backlog, starts a provider, or reaches the network.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$libPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts/orchestration/source-job-queue.ps1'
. $libPath

$script:Passed = 0
$script:Failures = 0
$script:Skipped = 0
function New-TestLink([string]$Link, [string]$Target, [bool]$Directory) {
    try {
        if ($Directory -and $IsWindows) { $null = New-Item -ItemType Junction -Path $Link -Target $Target }
        else { $null = New-Item -ItemType SymbolicLink -Path $Link -Target $Target }
        $true
    }
    catch { $false }
}
function Assert-That([bool]$Condition, [string]$Message) {
    if ($Condition) { $script:Passed++ } else { $script:Failures++; Write-Host "FAIL: $Message" }
}
function Assert-Refused([string]$Code, [scriptblock]$Action, [string]$Message) {
    try { $null = & $Action; Assert-That $false "$Message (no refusal)" }
    catch { Assert-That ($_.Exception.Message -clike "SJQ_REFUSED:$Code*") "$Message (got: $($_.Exception.Message))" }
}

$work = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('sjq-' + [guid]::NewGuid().ToString('N'))))
[void][IO.Directory]::CreateDirectory($work)

$T_REG = '2026-10-29T09:00:00.0000000Z'
$T_RES = '2026-10-29T09:30:00.0000000Z'
$T_START = '2026-10-29T10:01:00.0000000Z'
$T_LATE = '2026-10-30T01:00:00.0000000Z'   # after the default admission expiry
$T_CONSUME = '2026-10-29T09:45:00.0000000Z'
$script:OperatorSha = ('e' * 64)

# ---------- fixture helpers ----------

function Get-Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Json([string]$Path, $Object) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Object -Depth 20), [Text.UTF8Encoding]::new($false))
}
function Get-Ref([string]$Path) { [ordered]@{ path = $Path; sha256 = (Get-Sha $Path) } }

function ConvertTo-Canon($Value) {
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = [string[]]@($Value.Keys) | Sort-Object
        return '{' + (($keys | ForEach-Object { (ConvertTo-Json -InputObject $_ -Compress) + ':' + (ConvertTo-Canon $Value[$_]) }) -join ',') + '}'
    }
    if ($Value -is [System.Collections.IList]) { return '[' + ((@($Value) | ForEach-Object { ConvertTo-Canon $_ }) -join ',') + ']' }
    ConvertTo-Json -InputObject $Value -Compress
}
function Read-Root([string]$Index) { Get-Content -LiteralPath $Index -Raw | ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String }
function Get-QueueOrNull([string]$Index) {
    $registry = (Read-Root $Index)['controllerTaskRegistry']
    if ($registry.ContainsKey('sourceOnlyJobQueue')) { $registry['sourceOnlyJobQueue'] } else { $null }
}
function Get-Ver([string]$Index) { $q = Get-QueueOrNull $Index; if ($null -eq $q) { 0 } else { [long]$q['version'] } }
function Get-Job([string]$Index, [string]$JobId) { (Get-QueueOrNull $Index)['jobs'][$JobId] }
function Get-LegacyCanon([string]$Index) {
    $root = Read-Root $Index
    $root['controllerTaskRegistry'].Remove('sourceOnlyJobQueue')
    ConvertTo-Canon $root
}

function New-IndexCopy([string]$Name) {
    $path = Join-Path $work "$Name.index.json"
    Write-Json $path ([ordered]@{
            schema                 = 'fixture-root/v1'
            unrelatedRoot          = [ordered]@{ globalUsage = 'UNKNOWN'; ratio = 1.5; big = 9007199254740993 }
            controllerTaskRegistry = [ordered]@{
                legacyTasks                   = @([ordered]@{ id = 'legacy-1'; status = 'UNKNOWN' }, [ordered]@{ id = 'legacy-2'; status = 'DONE' })
                currentOwnerReconciliationRef = 'queue-reconciliation7'
                currentQueueReconciliation    = [ordered]@{ ref = 'queue-reconciliation7'; status = 'UNKNOWN' }
                'queue-reconciliation1'       = [ordered]@{ status = 'REFUSED'; refs = @('r1') }
            }
        })
    $path
}

function New-JobFixture([string]$Name, [long]$Priority, [string]$Owned = '', [string]$Expires = '2026-10-30T00:00:00.0000000Z', [string[]]$Deps = @()) {
    if (-not $Owned) { $Owned = Join-Path $work "owned-$Name" }
    $editable = Join-Path $Owned 'target.ps1'
    $run = Join-Path (Join-Path $work 'runs') $Name
    $planPath = Join-Path (Join-Path $work 'plans') "$Name.plan.json"
    Write-Json $planPath ([ordered]@{
            schema = 'SupervisedCodeSourceOnlyTask/v1'; taskId = "task-$Name"; sessionId = "session-$Name"; runDirectory = $run
            editablePins = @([ordered]@{ path = $editable; sha256 = ('a' * 64) }); history = @('prior-refusal-1')
            protectedPins = @([ordered]@{ path = (Join-Path $work 'protected.txt'); sha256 = ('d' * 64) })
        })
    $admPath = Join-Path (Join-Path $work 'plans') "$Name.admission.json"
    Write-Json $admPath ([ordered]@{
            schema = 'IndependentSupervisedSourceOnlyAdmission/v1'; decision = 'ADMIT_SOURCE_ONLY_ONCE'; planSha256 = (Get-Sha $planPath)
            taskId = "task-$Name"; expiresUtc = $Expires; reviewer = 'independent-reviewer'; maximumNativeProcesses = 1
            operatorSha256 = $script:OperatorSha
        })
    [pscustomobject]@{
        Name = $Name; JobId = "job-$Name"; Owned = $Owned; Editable = $editable; Run = $run; SessionId = "session-$Name"
        PlanPath = $planPath; AdmPath = $admPath; PlanSha = (Get-Sha $planPath); AdmSha = (Get-Sha $admPath); Priority = $Priority; Deps = $Deps
    }
}

function Get-RegisterEvent($Fx) {
    [ordered]@{
        schema = 'SourceJobQueueEvent/v1'; eventId = "reg-$($Fx.Name)"; type = 'REGISTER_SOURCE_JOB'; jobId = $Fx.JobId; parentId = "parent-$($Fx.Name)"
        priority = $Fx.Priority; ownedPaths = @($Fx.Owned); dependsOn = @($Fx.Deps); planRef = (Get-Ref $Fx.PlanPath); admissionRef = (Get-Ref $Fx.AdmPath)
    }
}
function Get-StartEvent($Fx, [string]$ReservationId, [string]$Tag = '1') {
    [ordered]@{
        schema = 'SourceJobQueueEvent/v1'; eventId = "start-$($Fx.Name)-$Tag"; type = 'OBSERVED_START'; jobId = $Fx.JobId; reservationId = $ReservationId
        startRef = (Get-Ref (Join-Path $Fx.Run 'start.json')); invocationRef = (Get-Ref (Join-Path $Fx.Run 'invocation.json'))
    }
}
function Get-TerminalEvent($Fx, [string]$Tag = '1') {
    [ordered]@{
        schema = 'SourceJobQueueEvent/v1'; eventId = "term-$($Fx.Name)-$Tag"; type = 'OBSERVED_TERMINAL'; jobId = $Fx.JobId
        terminalRef = (Get-Ref (Join-Path $Fx.Run 'terminal.json')); invocationRef = (Get-Ref (Join-Path $Fx.Run 'invocation.json'))
    }
}

function Send-RawEvent([string]$Index, [long]$Version, [string]$Text, [string]$FileName, [string]$At = $T_REG) {
    $path = Join-Path (Join-Path $work 'events') $FileName
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path))
    [IO.File]::WriteAllText($path, $Text, [Text.UTF8Encoding]::new($false))
    Invoke-SourceJobQueueEvent -IndexPath $Index -ExpectedVersion $Version -EventPath $path -ExpectedEventSha256 (Get-Sha $path) -AtUtc $At
}
function Send-Event([string]$Index, $Evt, [string]$At = $T_REG, [string]$Tag = '') {
    Send-RawEvent $Index (Get-Ver $Index) (ConvertTo-Json -InputObject $Evt -Depth 20) "$($Evt.eventId)$Tag.json" $At
}
function Invoke-Reserve([string]$Index, [string[]]$Ids, [string]$ReservationId, [string]$At = $T_RES) {
    Reserve-NextSourceJob -IndexPath $Index -ExpectedVersion (Get-Ver $Index) -CandidateJobIds $Ids -ReservationId $ReservationId -AtUtc $At
}

function Write-Invocation($Fx, $Binding = $null) {
    $invocation = [ordered]@{
        schema = 'SupervisedSourceOnlyInvocation/v1'; planSha256 = $Fx.PlanSha; admissionSha256 = $Fx.AdmSha; usageReceiptSha256 = ('c' * 64)
        arguments = @('--print'); workingDirectory = $Fx.Owned; environmentNames = @('PATH'); history = @('prior-refusal-1')
        factoryClaim = $false; operationalReceipt = $false; continuityGrant = $false
    }
    if ($null -ne $Binding) { $invocation['queueBinding'] = $Binding }
    Write-Json (Join-Path $Fx.Run 'invocation.json') $invocation
}
function Get-Binding($Fx, [string]$ReservationId, [string]$AttemptId, [string]$ConsumedUtc) {
    [ordered]@{ schema = 'SourceJobQueueBinding/v1'; jobId = $Fx.JobId; reservationId = $ReservationId; attemptId = $AttemptId; consumedUtc = $ConsumedUtc; runDirectory = $Fx.Run }
}
function Invoke-Consume([string]$Index, $Fx, [string]$ReservationId, [string]$AttemptId, [hashtable]$Over = @{}) {
    $arguments = @{
        IndexPath = $Index; ExpectedVersion = (Get-Ver $Index); JobId = $Fx.JobId; ReservationId = $ReservationId
        PlanPath = $Fx.PlanPath; ExpectedPlanSha256 = $Fx.PlanSha; AdmissionPath = $Fx.AdmPath; ExpectedAdmissionSha256 = $Fx.AdmSha
        TaskId = "task-$($Fx.Name)"; SessionId = $Fx.SessionId; OperatorSha256 = $script:OperatorSha; RunDirectory = $Fx.Run
        AttemptId = $AttemptId; ConsumedUtc = $T_CONSUME
    }
    foreach ($key in $Over.Keys) { $arguments[$key] = $Over[$key] }
    Consume-SourceJobReservation @arguments
}
function Write-Start($Fx) {
    Write-Json (Join-Path $Fx.Run 'start.json') ([ordered]@{
            schema = 'SupervisedSourceOnlyStart/v1'; pid = 4242; sessionId = $Fx.SessionId
            startUtc = '2026-10-29T10:00:00.0000000Z'; observedUtc = '2026-10-29T10:00:01.0000000Z'; noFactoryClaim = $true
        })
}
function Write-Terminal($Fx, [hashtable]$Over = @{}) {
    $out = Join-Path $Fx.Run 'stdout.bin'
    $err = Join-Path $Fx.Run 'stderr.bin'
    [void][IO.Directory]::CreateDirectory($Fx.Run)
    [IO.File]::WriteAllBytes($out, [Text.Encoding]::UTF8.GetBytes("raw stdout $($Fx.Name)"))
    [IO.File]::WriteAllBytes($err, [Text.Encoding]::UTF8.GetBytes("raw stderr $($Fx.Name)"))
    $terminal = [ordered]@{
        schema = 'SupervisedSourceOnlyTerminal/v1'; providerStarted = $true; pid = 4242; sessionId = $Fx.SessionId
        startUtc = '2026-10-29T10:00:00.0000000Z'; endUtc = '2026-10-29T10:30:00.0000000Z'; exitCode = 0; errorType = $null; rawDrained = $true
        stdoutSha256 = (Get-Sha $out); stdoutBytes = (Get-Item -LiteralPath $out).Length; stderrSha256 = (Get-Sha $err); stderrBytes = (Get-Item -LiteralPath $err).Length
        editableAfter = @([ordered]@{ path = $Fx.Editable; sha256 = ('b' * 64) })
        protectedPostPins = @([ordered]@{ path = (Join-Path $work 'protected.txt'); unchanged = $true })
        history = @('prior-refusal-1'); globalUsage = 'UNKNOWN'; taskAcceptance = 'NOT_EVALUATED'
        factoryClaim = $false; operationalCompletion = $false; successorAuthority = $false
    }
    foreach ($key in $Over.Keys) { $terminal[$key] = $Over[$key] }
    Write-Json (Join-Path $Fx.Run 'terminal.json') $terminal
}

function Register-Fixture([string]$Index, $Fx) { $null = Send-Event $Index (Get-RegisterEvent $Fx) }
function Move-ToRunning([string]$Index, $Fx, [string]$ReservationId) {
    Register-Fixture $Index $Fx
    $null = Invoke-Reserve $Index @($Fx.JobId) $ReservationId
    Write-Invocation $Fx
    Write-Start $Fx
    $null = Send-Event $Index (Get-StartEvent $Fx $ReservationId) $T_START
}

function Assert-EventRefused([string]$Index, [string]$Code, [scriptblock]$Send, [string]$Message) {
    $before = Get-Sha $Index
    Assert-Refused $Code $Send $Message
    Assert-That ((Get-Sha $Index) -ceq $before) "$Message (index bytes must be unchanged)"
}

try {
    # ---------- 1. register vs reservation vs actual start; terminal -> REVIEW_REQUIRED after expiry ----------
    $idx = New-IndexCopy 'lifecycle'
    $legacyBefore = Get-LegacyCanon $idx
    $a = New-JobFixture 'a' 10
    $r = Send-Event $idx (Get-RegisterEvent $a)
    Assert-That ($r.Status -ceq 'APPLIED' -and $r.Version -eq 1) 'register applies and bumps version to 1'
    $job = Get-Job $idx $a.JobId
    Assert-That ($job['state'] -ceq 'SOURCE_PREPARED' -and $null -eq $job['reservation'] -and $null -eq $job['start']) 'register is not a reservation and not a start'

    $res = Invoke-Reserve $idx @($a.JobId) 'res-a'
    $job = Get-Job $idx $a.JobId
    Assert-That ($res.Status -ceq 'RESERVED' -and $res.JobId -ceq $a.JobId -and $res.ReservationOnly) 'reserve picks the registered candidate and says reservation-only'
    Assert-That ($job['state'] -ceq 'DISPATCH_UNCERTAIN' -and $null -eq $job['start'] -and $job['reservation']['reservationOnly'] -eq $true) 'reservation alone is DISPATCH_UNCERTAIN, never RUNNING'

    Write-Invocation $a; Write-Start $a
    $null = Send-Event $idx (Get-StartEvent $a 'res-a') $T_START
    $job = Get-Job $idx $a.JobId
    Assert-That ($job['state'] -ceq 'RUNNING' -and $job['start']['pid'] -eq 4242) 'only observed start evidence yields RUNNING'

    Write-Terminal $a
    $null = Send-Event $idx (Get-TerminalEvent $a) $T_LATE
    $job = Get-Job $idx $a.JobId
    Assert-That ($job['state'] -ceq 'REVIEW_REQUIRED' -and $job['notice'] -ceq 'REVIEW_NEEDED_NOT_ACCEPTED') 'exit0+started+drained is REVIEW_REQUIRED (consumed after admission expiry)'
    Assert-That ($job['terminal']['ref']['sha256'] -ceq (Get-Sha (Join-Path $a.Run 'terminal.json')) -and $job['terminal']['globalUsage'] -ceq 'UNKNOWN') 'exact terminal ref and UNKNOWN are retained'
    $queueText = ConvertTo-Canon (Get-QueueOrNull $idx)
    Assert-That ($queueText -cnotmatch '"(DONE|ACCEPTED|accepted|reviewAccepted)"') 'queue subset never records DONE/accepted'
    Assert-That ($queueText -cnotmatch '"factoryClaim":true') 'queue subset records no Factory claim'
    Assert-That ((Get-LegacyCanon $idx) -ceq $legacyBefore) 'legacy registry keys, UNKNOWN values and unrelated root fields are semantically unchanged'

    # ---------- 2. duplicate event and conflicting event id ----------
    $bytesBefore = Get-Sha $idx
    $verBefore = Get-Ver $idx
    $dup = Send-RawEvent $idx 0 (ConvertTo-Json -InputObject (Get-RegisterEvent $a) -Depth 20) 'reg-a.json'
    Assert-That ($dup.Status -ceq 'NOOP_DUPLICATE' -and (Get-Sha $idx) -ceq $bytesBefore -and (Get-Ver $idx) -eq $verBefore) 'exact replay is a no-op: no byte or version churn (even with a stale expected version)'
    $changed = Get-RegisterEvent $a
    $changed.priority = 99
    Assert-EventRefused $idx 'EVENT_ID_CONFLICT' { Send-RawEvent $idx (Get-Ver $idx) (ConvertTo-Json -InputObject $changed -Depth 20) 'reg-a-conflict.json' } 'same eventId with different bytes'

    # ---------- 3. failure -> FAILED ----------
    $idx = New-IndexCopy 'failed'
    $f = New-JobFixture 'f1' 1
    Move-ToRunning $idx $f 'res-f1'
    Write-Terminal $f @{ exitCode = 1 }
    $null = Send-Event $idx (Get-TerminalEvent $f) $T_START
    $job = Get-Job $idx $f.JobId
    Assert-That ($job['state'] -ceq 'FAILED' -and $job['notice'] -ceq 'FAILURE_RETAINED_NO_AUTO_RETRY') 'nonzero exit is FAILED with retained notice'

    # ---------- 4. reconciliation / refusal classification ----------
    $idx = New-IndexCopy 'classify'
    $r1 = New-JobFixture 'r1' 1; $r2 = New-JobFixture 'r2' 2; $r3 = New-JobFixture 'r3' 3; $r4 = New-JobFixture 'r4' 4; $r5 = New-JobFixture 'r5' 5
    Move-ToRunning $idx $r1 'cres-1'; Move-ToRunning $idx $r2 'cres-2'; Move-ToRunning $idx $r3 'cres-3'; Move-ToRunning $idx $r5 'cres-5'
    Write-Terminal $r1 @{ protectedPostPins = @([ordered]@{ path = (Join-Path $work 'protected.txt'); unchanged = $false }) }
    Write-Terminal $r2 @{ rawDrained = $false }
    Write-Terminal $r3 @{ factoryClaim = $true }
    Write-Terminal $r5 @{ pid = 9999 }
    foreach ($x in $r1, $r2, $r3, $r5) { $null = Send-Event $idx (Get-TerminalEvent $x) $T_START }
    foreach ($x in $r1, $r2, $r3, $r5) { Assert-That ((Get-Job $idx $x.JobId)['state'] -ceq 'RECONCILIATION_REQUIRED') "$($x.JobId) contradictory/incomplete evidence is RECONCILIATION_REQUIRED, not REVIEW_REQUIRED" }
    Assert-That ((Get-Job $idx $r1.JobId)['reasons'] -ccontains 'PROTECTED_POST_PIN_CHANGED') 'false protectedPostPins is recorded as the reason'
    Assert-That ((Get-Job $idx $r5.JobId)['reasons'] -ccontains 'PID_OR_START_DRIFT') 'terminal PID that differs from the observed start is held for reconciliation'

    Register-Fixture $idx $r4
    $null = Invoke-Reserve $idx @($r4.JobId) 'cres-4'
    Write-Invocation $r4
    Write-Terminal $r4 @{ providerStarted = $false; pid = $null; startUtc = $null; endUtc = $null; exitCode = $null; errorType = 'PROCESS_START_FALSE'; rawDrained = $false }
    $null = Send-Event $idx (Get-TerminalEvent $r4) $T_START
    Assert-That ((Get-Job $idx $r4.JobId)['state'] -ceq 'REFUSED') 'explicit not-started terminal with an error is REFUSED, never READY'
    Assert-That ((Invoke-Reserve $idx @($r4.JobId) 'cres-4b').Status -ceq 'NO_ELIGIBLE_CANDIDATE') 'a refused job is not re-reserved automatically'

    # ---------- 5. malformed / drifted evidence refused, old bytes intact ----------
    $idx = New-IndexCopy 'malformed'
    $m = New-JobFixture 'm1' 1
    $good = ConvertTo-Json -InputObject (Get-RegisterEvent $m) -Depth 20
    $extra = Get-RegisterEvent $m; $extra.surprise = 1
    Assert-EventRefused $idx 'UNEXPECTED_KEY' { Send-RawEvent $idx 0 (ConvertTo-Json -InputObject $extra -Depth 20) 'm-extra.json' } 'unknown event key'
    $coerced = Get-RegisterEvent $m; $coerced.priority = '1'
    Assert-EventRefused $idx 'BAD_TYPE' { Send-RawEvent $idx 0 (ConvertTo-Json -InputObject $coerced -Depth 20) 'm-coerced.json' } 'string priority is not coerced'
    $fractional = Get-RegisterEvent $m; $fractional.priority = 1.5
    Assert-EventRefused $idx 'BAD_TYPE' { Send-RawEvent $idx 0 (ConvertTo-Json -InputObject $fractional -Depth 20) 'm-frac.json' } 'fractional priority'
    Assert-EventRefused $idx 'UNEXPECTED_KEY' { Send-RawEvent $idx 0 ($good -replace '"priority"', '"Priority"') 'm-case.json' } 'mis-cased key'
    $dupKey = $good.Insert($good.IndexOf('{') + 1, '"jobId":"job-x",')
    Assert-EventRefused $idx 'DUPLICATE_KEY' { Send-RawEvent $idx 0 $dupKey 'm-dup.json' } 'duplicate key'
    $relative = Get-RegisterEvent $m; $relative.ownedPaths = @('relative\path')
    Assert-EventRefused $idx 'BAD_PATH' { Send-RawEvent $idx 0 (ConvertTo-Json -InputObject $relative -Depth 20) 'm-rel.json' } 'relative owned path'
    $traversal = Get-RegisterEvent $m; $traversal.ownedPaths = @((Join-Path $m.Owned '..\other'))
    Assert-EventRefused $idx 'BAD_PATH' { Send-RawEvent $idx 0 (ConvertTo-Json -InputObject $traversal -Depth 20) 'm-trav.json' } 'traversal in owned path'
    Assert-EventRefused $idx 'HASH_DRIFT' {
        $p = Join-Path $work 'events\m-wronghash.json'; [void][IO.Directory]::CreateDirectory((Split-Path -Parent $p)); [IO.File]::WriteAllText($p, $good)
        Invoke-SourceJobQueueEvent -IndexPath $idx -ExpectedVersion 0 -EventPath $p -ExpectedEventSha256 ('0' * 64) -AtUtc $T_REG
    } 'event hash not matching the pin'
    Assert-EventRefused $idx 'VERSION_CONFLICT' { Send-RawEvent $idx 5 $good 'm-ver.json' } 'wrong expected version'
    Assert-EventRefused $idx 'BAD_UTC' { Send-RawEvent $idx 0 $good 'm-utc.json' '2026-10-29 09:00' } 'non-UTC AtUtc'
    $unowned = New-JobFixture 'm2' 1
    Write-Json $unowned.PlanPath ([ordered]@{ schema = 'SupervisedCodeSourceOnlyTask/v1'; taskId = 'task-m2'; sessionId = 'session-m2'; runDirectory = $unowned.Run; editablePins = @([ordered]@{ path = (Join-Path $work 'elsewhere\x.ps1'); sha256 = ('a' * 64) }) })
    $badPin = Get-RegisterEvent $unowned
    Assert-EventRefused $idx 'EDITABLE_PIN_NOT_OWNED' { Send-RawEvent $idx 0 (ConvertTo-Json -InputObject $badPin -Depth 20) 'm-pin.json' } 'editable pin outside owned paths'
    $badAdm = New-JobFixture 'm3' 1
    $admObject = Get-Content -LiteralPath $badAdm.AdmPath -Raw | ConvertFrom-Json -AsHashtable
    $admObject.decision = 'REFUSE'
    Write-Json $badAdm.AdmPath $admObject
    Assert-EventRefused $idx 'ADMISSION_DECISION' { Send-RawEvent $idx 0 (ConvertTo-Json -InputObject (Get-RegisterEvent $badAdm) -Depth 20) 'm-adm.json' } 'admission that is not ADMIT_SOURCE_ONLY_ONCE'
    Assert-That ($null -eq (Get-QueueOrNull $idx)) 'no refusal created queue state'

    # terminal-side drift on a running job
    Move-ToRunning $idx $m 'mres-1'
    Write-Terminal $m
    $rawBefore = [IO.File]::ReadAllBytes((Join-Path $m.Run 'stdout.bin'))
    [IO.File]::WriteAllBytes((Join-Path $m.Run 'stdout.bin'), [byte[]](, [byte]0x41 * $rawBefore.Length))
    Assert-EventRefused $idx 'RAW_HASH_DRIFT' { Send-Event $idx (Get-TerminalEvent $m '1') $T_START } 'raw stdout hash drift'
    [IO.File]::WriteAllBytes((Join-Path $m.Run 'stdout.bin'), $rawBefore)
    Write-Terminal $m @{ sessionId = 'session-other' }
    Assert-EventRefused $idx 'IDENTITY_DRIFT' { Send-Event $idx (Get-TerminalEvent $m '2') $T_START } 'session identity drift'
    Write-Terminal $m
    $copyPath = Join-Path $work 'terminal-copy.json'
    Copy-Item -LiteralPath (Join-Path $m.Run 'terminal.json') -Destination $copyPath
    $stray = Get-TerminalEvent $m '3'; $stray.terminalRef = (Get-Ref $copyPath)
    Assert-EventRefused $idx 'PATH_NOT_RUN_BOUND' { Send-Event $idx $stray $T_START } 'terminal evidence outside the registered run directory'
    $null = Send-Event $idx (Get-TerminalEvent $m '4') $T_START
    Assert-That ((Get-Job $idx $m.JobId)['state'] -ceq 'REVIEW_REQUIRED') 'after refusals, the valid terminal is still consumed'

    # ---------- 6. competing reservations ----------
    $idx = New-IndexCopy 'compete'
    $c1 = New-JobFixture 'c1' 1; $c2 = New-JobFixture 'c2' 2
    Register-Fixture $idx $c1; Register-Fixture $idx $c2
    $v = Get-Ver $idx
    $first = Reserve-NextSourceJob -IndexPath $idx -ExpectedVersion $v -CandidateJobIds @($c2.JobId, $c1.JobId) -ReservationId 'cres-1' -AtUtc $T_RES
    Assert-That ($first.JobId -ceq $c1.JobId) 'lowest priority number wins regardless of input order'
    $afterFirst = Get-Sha $idx
    Assert-EventRefused $idx 'VERSION_CONFLICT' { Reserve-NextSourceJob -IndexPath $idx -ExpectedVersion $v -CandidateJobIds @($c2.JobId) -ReservationId 'cres-2' -AtUtc $T_RES } 'second reservation with the stale version'
    $uncertain = @((Get-QueueOrNull $idx)['jobs'].Values | Where-Object { $_['state'] -ceq 'DISPATCH_UNCERTAIN' })
    Assert-That ($uncertain.Count -eq 1) 'exactly one job is reserved'
    $replay = Reserve-NextSourceJob -IndexPath $idx -ExpectedVersion 0 -CandidateJobIds @($c1.JobId, $c2.JobId) -ReservationId 'cres-1' -AtUtc $T_RES
    Assert-That ($replay.Status -ceq 'NOOP_DUPLICATE' -and (Get-Sha $idx) -ceq $afterFirst) 'replaying the same reservation id and candidates changes nothing'
    Assert-EventRefused $idx 'RESERVATION_ID_CONFLICT' { Reserve-NextSourceJob -IndexPath $idx -ExpectedVersion (Get-Ver $idx) -CandidateJobIds @($c2.JobId) -ReservationId 'cres-1' -AtUtc $T_RES } 'same reservation id with different candidates'
    $third = Invoke-Reserve $idx @($c1.JobId, $c2.JobId) 'cres-3'
    Assert-That ($third.JobId -ceq $c2.JobId -and (@($third.Skips | Where-Object { $_.JobId -ceq $c1.JobId })[0].Reasons -ccontains 'STATE_DISPATCH_UNCERTAIN')) 'an uncertain reservation is never reissued and does not block the independent job'

    # ---------- 7. restart before start stays uncertain; later same start reconciles once ----------
    $idx = New-IndexCopy 'restart'
    $s = New-JobFixture 's1' 1
    Register-Fixture $idx $s
    $null = Invoke-Reserve $idx @($s.JobId) 'sres-1'
    $again = Invoke-Reserve $idx @($s.JobId) 'sres-2' '2030-01-01T00:00:00.0000000Z'
    Assert-That ($again.Status -ceq 'NO_ELIGIBLE_CANDIDATE' -and (Get-Job $idx $s.JobId)['state'] -ceq 'DISPATCH_UNCERTAIN') 'persisted intent without start stays DISPATCH_UNCERTAIN, never expires into READY'
    Write-Invocation $s; Write-Start $s
    $null = Send-Event $idx (Get-StartEvent $s 'sres-1') $T_START
    Assert-That ((Get-Job $idx $s.JobId)['state'] -ceq 'RUNNING') 'the same actual start reconciles the reservation'
    $verBefore = Get-Ver $idx
    $replayed = Send-Event $idx (Get-StartEvent $s 'sres-1') $T_START
    Assert-That ($replayed.Status -ceq 'NOOP_DUPLICATE' -and (Get-Ver $idx) -eq $verBefore) 'replayed start is idempotent'
    Assert-EventRefused $idx 'STATE_NOT_AWAITING_START' { Send-Event $idx (Get-StartEvent $s 'sres-1' '2') $T_START } 'a second distinct start event for the same job'

    # ---------- 8. stale / blocked candidates do not block an independent one ----------
    $idx = New-IndexCopy 'stale'
    $sa = New-JobFixture 'sa' 1 -Expires '2026-10-29T08:00:00.0000000Z'
    $sb = New-JobFixture 'sb' 5
    $sc = New-JobFixture 'sc' 0
    $sd = New-JobFixture 'sd' 2
    $se = New-JobFixture 'se' 3 -Deps @('job-sb')
    Register-Fixture $idx $sc
    $null = Invoke-Reserve $idx @($sc.JobId) 'stres-sc'
    Write-Invocation $sc; Write-Start $sc; Write-Terminal $sc
    $null = Send-Event $idx (Get-StartEvent $sc 'stres-sc') $T_START
    $null = Send-Event $idx (Get-TerminalEvent $sc) $T_START
    foreach ($x in $sa, $sb, $sd, $se) { Register-Fixture $idx $x }
    [IO.File]::AppendAllText($sd.PlanPath, ' ')
    $pick = Invoke-Reserve $idx @($sa.JobId, $sb.JobId, $sc.JobId, $sd.JobId, $se.JobId, 'job-missing') 'stres-main'
    Assert-That ($pick.JobId -ceq $sb.JobId) 'the independent ready job is selected'
    $why = @{}
    foreach ($skip in $pick.Skips) { $why[$skip.JobId] = $skip.Reasons }
    Assert-That ($why[$sa.JobId] -ccontains 'REFRESH_REQUIRED:ADMISSION_EXPIRED') 'expired admission is a REFRESH_REQUIRED skip'
    Assert-That ($why[$sc.JobId] -ccontains 'STATE_REVIEW_REQUIRED') 'review-pending job is skipped'
    Assert-That ($why[$sd.JobId] -ccontains 'REFRESH_REQUIRED:REF_PIN_DRIFT') 'drifted plan pin is a REFRESH_REQUIRED skip'
    Assert-That ($why[$se.JobId] -ccontains 'UNRESOLVED_DEPENDENCY:job-sb') 'unresolved dependency is skipped'
    Assert-That ($why['job-missing'] -ccontains 'NOT_REGISTERED') 'unregistered candidate is skipped'
    Assert-That ((Get-Job $idx $sa.JobId)['state'] -ceq 'SOURCE_PREPARED' -and (Get-Job $idx $sd.JobId)['state'] -ceq 'SOURCE_PREPARED') 'stale tasks stay prepared for refresh (not DONE, not dropped)'

    # ---------- 9. owned-path overlap ----------
    $idx = New-IndexCopy 'paths'
    $shared = Join-Path $work 'shared-p'
    $pd = New-JobFixture 'pd' 1 $shared
    $pe = New-JobFixture 'pe' 2 (Join-Path $shared 'sub')
    $pf = New-JobFixture 'pf' 3
    foreach ($x in $pd, $pe, $pf) { Register-Fixture $idx $x }
    $null = Invoke-Reserve $idx @($pd.JobId) 'pres-1'
    $blocked = Invoke-Reserve $idx @($pe.JobId) 'pres-2'
    Assert-That ($blocked.Status -ceq 'NO_ELIGIBLE_CANDIDATE' -and $blocked.Skips[0].Reasons -ccontains "PATH_CONFLICT:$($pd.JobId)") 'overlapping owned path is refused while the owner is unresolved'
    $disjoint = Invoke-Reserve $idx @($pe.JobId, $pf.JobId) 'pres-3'
    Assert-That ($disjoint.JobId -ceq $pf.JobId) 'a disjoint job still reserves'

    # ---------- 10. write failure and lease ----------
    $idx = New-IndexCopy 'atomic'
    $w = New-JobFixture 'w1' 1
    $before = Get-Sha $idx
    $original = ${function:Invoke-SjqReplace}
    Set-Item -Path function:Invoke-SjqReplace -Value { param($TempPath, $IndexPath) throw 'simulated replace failure' }
    try { Assert-Refused 'WRITE_FAILED' { Send-Event $idx (Get-RegisterEvent $w) } 'failed replacement' }
    finally { Set-Item -Path function:Invoke-SjqReplace -Value $original }
    Assert-That ((Get-Sha $idx) -ceq $before) 'failed replacement leaves the old index bytes intact'
    Assert-That (@(Get-ChildItem -LiteralPath $work -Filter 'atomic.index.json.*.tmp').Count -eq 0) 'no temp file is left behind'
    $held = [IO.File]::Open("$idx.lease", 'OpenOrCreate', 'ReadWrite', 'None')
    try { Assert-EventRefused $idx 'LEASE_BUSY' { Send-Event $idx (Get-RegisterEvent $w) } 'held lease' }
    finally { $held.Dispose() }
    $null = Send-Event $idx (Get-RegisterEvent $w)
    Assert-That ((Get-Ver $idx) -eq 1) 'the lease is usable again after the failure and after release'
    $canonical = Join-Path $work 'canonical-task-backlog.json'
    Copy-Item -LiteralPath $idx -Destination $canonical
    Assert-Refused 'CANONICAL_BACKLOG_REFUSED' { Invoke-Reserve $canonical @($w.JobId) 'x-1' } 'canonical backlog file name'

    # ---------- 12. terminal evidence coverage and history ----------
    $idx = New-IndexCopy 'coverage'
    $g = New-JobFixture 'g1' 1
    Move-ToRunning $idx $g 'gres-1'
    $protectedPath = Join-Path $work 'protected.txt'
    $otherPath = Join-Path $work 'other.txt'
    $variants = @(
        @{ Tag = 'a'; Code = 'PIN_COVERAGE'; Over = @{ protectedPostPins = @() } },
        @{ Tag = 'b'; Code = 'PIN_COVERAGE'; Over = @{ protectedPostPins = @([ordered]@{ path = $protectedPath; unchanged = $true }, [ordered]@{ path = $protectedPath; unchanged = $true }) } },
        @{ Tag = 'c'; Code = 'PIN_COVERAGE'; Over = @{ protectedPostPins = @([ordered]@{ path = $otherPath; unchanged = $true }) } },
        @{ Tag = 'd'; Code = 'PIN_COVERAGE'; Over = @{ protectedPostPins = @([ordered]@{ path = $protectedPath; unchanged = $true }, [ordered]@{ path = $otherPath; unchanged = $true }) } },
        @{ Tag = 'e'; Code = 'BAD_TYPE'; Over = @{ protectedPostPins = @([ordered]@{ path = $protectedPath; unchanged = 'true' }) } },
        @{ Tag = 'f'; Code = 'EDITABLE_COVERAGE'; Over = @{ editableAfter = @() } },
        @{ Tag = 'g'; Code = 'EDITABLE_COVERAGE'; Over = @{ editableAfter = @([ordered]@{ path = $otherPath; sha256 = ('b' * 64) }) } },
        @{ Tag = 'h'; Code = 'EDITABLE_COVERAGE'; Over = @{ editableAfter = @([ordered]@{ path = $g.Editable; sha256 = ('b' * 64) }, [ordered]@{ path = $g.Editable; sha256 = ('b' * 64) }) } },
        @{ Tag = 'i'; Code = 'BAD_VALUE'; Over = @{ editableAfter = @([ordered]@{ path = $g.Editable; sha256 = 'zz' }) } },
        @{ Tag = 'j'; Code = 'HISTORY_MISMATCH'; Over = @{ history = @('other') } },
        @{ Tag = 'k'; Code = 'HISTORY_MISMATCH'; Over = @{ history = $null } }
    )
    foreach ($variant in $variants) {
        Write-Terminal $g $variant.Over
        $tag = $variant.Tag
        Assert-EventRefused $idx $variant.Code { Send-Event $idx (Get-TerminalEvent $g $tag) $T_START } "terminal coverage variant $tag"
    }
    Assert-That ((Get-Job $idx $g.JobId)['state'] -ceq 'RUNNING') 'incomplete terminal evidence never leaves RUNNING'
    Write-Terminal $g
    $null = Send-Event $idx (Get-TerminalEvent $g 'ok') $T_START
    Assert-That ((Get-Job $idx $g.JobId)['state'] -ceq 'REVIEW_REQUIRED') 'exactly covered terminal evidence with matching history is consumed'
    Assert-That ((ConvertTo-SjqCanonical (Get-Job $idx $g.JobId)['terminal']['history']) -ceq '["prior-refusal-1"]') 'registered history is retained on the terminal record'

    # ---------- 13. lease sidecar boundary ----------
    $idx = New-IndexCopy 'leasebound'
    $lw = New-JobFixture 'lw' 1
    [void][IO.Directory]::CreateDirectory("$idx.lease")
    try { Assert-EventRefused $idx 'LEASE_NOT_FILE' { Send-Event $idx (Get-RegisterEvent $lw) } 'lease sidecar replaced by a directory' }
    finally { Remove-Item -LiteralPath "$idx.lease" -Recurse -Force }

    $leaseTarget = Join-Path $work 'lease-target.bin'
    [IO.File]::WriteAllText($leaseTarget, 'x')
    if (New-TestLink "$idx.lease" $leaseTarget $false) {
        try { Assert-EventRefused $idx 'REPARSE' { Send-Event $idx (Get-RegisterEvent $lw) } 'lease sidecar that is a link' }
        finally { Remove-Item -LiteralPath "$idx.lease" -Force }
    }
    else { $script:Skipped++; Write-Host 'SKIPPED: file symbolic links unavailable on this host (lease sidecar link control)' }

    $realDir = Join-Path $work 'real-index'
    [void][IO.Directory]::CreateDirectory($realDir)
    Copy-Item -LiteralPath $idx -Destination (Join-Path $realDir 'leasebound.index.json')
    $linkDir = Join-Path $work 'link-index'
    if (New-TestLink $linkDir $realDir $true) {
        try {
            $viaLink = Join-Path $linkDir 'leasebound.index.json'
            Assert-EventRefused $viaLink 'REPARSE' { Send-Event $viaLink (Get-RegisterEvent $lw) } 'index reached through a linked ancestor'
        }
        finally { Remove-Item -LiteralPath $linkDir -Force }
    }
    else { $script:Skipped++; Write-Host 'SKIPPED: directory links unavailable on this host (linked ancestor control)' }
    $null = Send-Event $idx (Get-RegisterEvent $lw)
    Assert-That ((Get-Ver $idx) -eq 1) 'the genuine index and sidecar still work after the boundary refusals'

    # ---------- 14. one-time reservation consumption ----------
    $idx = New-IndexCopy 'consume'
    $k1 = New-JobFixture 'k1' 1
    $k2 = New-JobFixture 'k2' 2
    Register-Fixture $idx $k1; Register-Fixture $idx $k2
    Assert-EventRefused $idx 'RESERVATION_NOT_FOUND' { Invoke-Consume $idx $k1 'kres-1' 'att-1' } 'consume before any reservation exists'
    $null = Invoke-Reserve $idx @($k1.JobId) 'kres-1'
    $null = Invoke-Reserve $idx @($k2.JobId) 'kres-2'

    $mismatches = @(
        @{ Tag = 'plan path'; Code = 'PLAN_REF_MISMATCH'; Over = @{ PlanPath = $k2.PlanPath } },
        @{ Tag = 'plan hash'; Code = 'PLAN_REF_MISMATCH'; Over = @{ ExpectedPlanSha256 = ('0' * 64) } },
        @{ Tag = 'admission path'; Code = 'ADMISSION_REF_MISMATCH'; Over = @{ AdmissionPath = $k2.AdmPath } },
        @{ Tag = 'admission hash'; Code = 'ADMISSION_REF_MISMATCH'; Over = @{ ExpectedAdmissionSha256 = ('0' * 64) } },
        @{ Tag = 'malformed hash'; Code = 'BAD_SHA'; Over = @{ ExpectedPlanSha256 = 'xyz' } },
        @{ Tag = 'operator'; Code = 'OPERATOR_MISMATCH'; Over = @{ OperatorSha256 = ('f' * 64) } },
        @{ Tag = 'task'; Code = 'IDENTITY_DRIFT'; Over = @{ TaskId = 'task-other' } },
        @{ Tag = 'session'; Code = 'IDENTITY_DRIFT'; Over = @{ SessionId = 'session-other' } },
        @{ Tag = 'run directory'; Code = 'RUN_DIRECTORY_MISMATCH'; Over = @{ RunDirectory = (Join-Path $work 'runs\elsewhere') } },
        @{ Tag = 'relative run directory'; Code = 'BAD_PATH'; Over = @{ RunDirectory = 'runs\k1' } },
        @{ Tag = 'unknown reservation'; Code = 'RESERVATION_NOT_FOUND'; Over = @{ ReservationId = 'kres-unknown' } },
        @{ Tag = 'reservation of another job'; Code = 'RESERVATION_MISMATCH'; Over = @{ ReservationId = 'kres-2' } },
        @{ Tag = 'unregistered job'; Code = 'JOB_NOT_REGISTERED'; Over = @{ JobId = 'job-missing' } },
        @{ Tag = 'stale version'; Code = 'VERSION_CONFLICT'; Over = @{ ExpectedVersion = 0 } },
        @{ Tag = 'consume before reservation'; Code = 'CONSUME_BEFORE_RESERVATION'; Over = @{ ConsumedUtc = '2026-10-29T09:00:00.0000000Z' } },
        @{ Tag = 'expired admission'; Code = 'ADMISSION_EXPIRED'; Over = @{ ConsumedUtc = $T_LATE } },
        @{ Tag = 'bad attempt id'; Code = 'BAD_VALUE'; Over = @{ AttemptId = 'bad id' } }
    )
    foreach ($case in $mismatches) {
        $over = $case.Over
        Assert-EventRefused $idx $case.Code { Invoke-Consume $idx $k1 'kres-1' 'att-1' $over } "consume refused: $($case.Tag)"
    }
    Assert-That (-not (Test-SjqHasKey (Get-Job $idx $k1.JobId)['reservation'] 'consumed')) 'refused consumes leave the reservation unconsumed'

    $versionBefore = Get-Ver $idx
    $first = Invoke-Consume $idx $k1 'kres-1' 'att-1'
    $job = Get-Job $idx $k1.JobId
    Assert-That ($first.Status -ceq 'NEWLY_CONSUMED' -and $first.LaunchPermitted -eq $true -and $first.Version -eq ($versionBefore + 1)) 'first consume is NEWLY_CONSUMED with launch permission and bumps the version'
    Assert-That ($job['state'] -ceq 'DISPATCH_UNCERTAIN' -and $null -eq $job['start'] -and $job['reservation']['consumed'] -eq $true) 'consumption keeps DISPATCH_UNCERTAIN: not RUNNING, no start'
    Assert-That ($job['reservation']['consumption']['attemptId'] -ceq 'att-1' -and $job['reservation']['consumption']['consumedUtc'] -ceq $T_CONSUME -and $job['reservation']['consumption']['runDirectory'] -ceq $k1.Run) 'attempt identity, timestamp and run directory are persisted'
    Assert-That ((ConvertTo-Canon (Get-QueueOrNull $idx)) -cnotmatch '"(DONE|ACCEPTED|accepted)"') 'consumption records no acceptance'

    $afterConsume = Get-Sha $idx
    foreach ($replay in @(@('att-1', (Get-Ver $idx)), @('att-1', 0), @('att-2', (Get-Ver $idx)), @('att-2', 0))) {
        $again = Invoke-Consume $idx $k1 'kres-1' $replay[0] @{ ExpectedVersion = [long]$replay[1] }
        Assert-That ($again.Status -ceq 'ALREADY_CONSUMED' -and $again.LaunchPermitted -eq $false) "replay ($($replay[0]), version $($replay[1])) never returns launch permission"
    }
    Assert-That ((Get-Sha $idx) -ceq $afterConsume) 'replays and distinct-attempt consumes leave the index bytes untouched'
    Assert-EventRefused $idx 'ATTEMPT_ID_CONFLICT' { Invoke-Consume $idx $k2 'kres-2' 'att-1' } 'an attempt id cannot be reused for another reservation'
    $other = Invoke-Consume $idx $k2 'kres-2' 'att-3'
    Assert-That ($other.Status -ceq 'NEWLY_CONSUMED') 'an independent reservation consumes separately'
    Assert-That ((Invoke-Reserve $idx @($k1.JobId, $k2.JobId) 'kres-again').Status -ceq 'NO_ELIGIBLE_CANDIDATE') 'a consumed reservation is never re-reserved'

    # the observed start must carry exactly the consumed tuple
    [void][IO.Directory]::CreateDirectory($k1.Run)
    Write-Invocation $k1; Write-Start $k1
    Assert-EventRefused $idx 'INVOCATION_BINDING_MISSING' { Send-Event $idx (Get-StartEvent $k1 'kres-1') $T_START } 'start without the consumed binding'
    foreach ($bad in @(
            @{ Field = 'attemptId'; Value = 'att-other' }, @{ Field = 'reservationId'; Value = 'kres-2' }, @{ Field = 'jobId'; Value = $k2.JobId },
            @{ Field = 'consumedUtc'; Value = $T_START }, @{ Field = 'runDirectory'; Value = (Join-Path $work 'runs\elsewhere') })) {
        $binding = Get-Binding $k1 'kres-1' 'att-1' $T_CONSUME
        $binding[$bad.Field] = $bad.Value
        Write-Invocation $k1 $binding
        $field = $bad.Field
        Assert-EventRefused $idx 'INVOCATION_BINDING_MISMATCH' { Send-Event $idx (Get-StartEvent $k1 'kres-1' "-$field") $T_START } "start with a drifted binding $field"
    }
    $extraKey = Get-Binding $k1 'kres-1' 'att-1' $T_CONSUME; $extraKey['surprise'] = 1
    Write-Invocation $k1 $extraKey
    Assert-EventRefused $idx 'UNEXPECTED_KEY' { Send-Event $idx (Get-StartEvent $k1 'kres-1' '-extra') $T_START } 'binding with an unknown key'
    Write-Invocation $k1 (Get-Binding $k1 'kres-1' 'att-1' $T_CONSUME)
    $null = Send-Event $idx (Get-StartEvent $k1 'kres-1' '-ok') $T_START
    Assert-That ((Get-Job $idx $k1.JobId)['state'] -ceq 'RUNNING') 'the exact consumed binding reconciles to RUNNING'
    $replayWhileRunning = Invoke-Consume $idx $k1 'kres-1' 'att-9'
    Assert-That ($replayWhileRunning.Status -ceq 'ALREADY_CONSUMED' -and $replayWhileRunning.LaunchPermitted -eq $false) 'a replay while RUNNING carries no launch permission'
    Write-Terminal $k1
    $null = Send-Event $idx (Get-TerminalEvent $k1) $T_START
    $job = Get-Job $idx $k1.JobId
    Assert-That ($job['state'] -ceq 'REVIEW_REQUIRED' -and $job['reservation']['consumed'] -eq $true) 'consumed tuple reconciles to REVIEW_REQUIRED, never DONE'
    $replayAfterReview = Invoke-Consume $idx $k1 'kres-1' 'att-4'
    Assert-That ($replayAfterReview.Status -ceq 'ALREADY_CONSUMED' -and $replayAfterReview.LaunchPermitted -eq $false) 'a replay after review still carries no launch permission'

    # a binding on a reservation that was never consumed is refused
    $idx = New-IndexCopy 'consume-legacy'
    $lg = New-JobFixture 'lg' 1
    Register-Fixture $idx $lg
    $null = Invoke-Reserve $idx @($lg.JobId) 'lgres-1'
    Write-Invocation $lg (Get-Binding $lg 'lgres-1' 'att-1' $T_CONSUME); Write-Start $lg
    Assert-EventRefused $idx 'INVOCATION_BINDING_UNCONSUMED' { Send-Event $idx (Get-StartEvent $lg 'lgres-1') $T_START } 'binding for a reservation that was never consumed'

    # overlap stays blocked while a consumed job is unresolved; a disjoint job is independent
    $idx = New-IndexCopy 'consume-paths'
    $shared = Join-Path $work 'shared-k'
    $ka = New-JobFixture 'ka' 1 $shared
    $kb = New-JobFixture 'kb' 2 (Join-Path $shared 'sub')
    $kc = New-JobFixture 'kc' 3
    foreach ($x in $ka, $kb, $kc) { Register-Fixture $idx $x }
    $null = Invoke-Reserve $idx @($ka.JobId) 'kpres-1'
    $null = Invoke-Consume $idx $ka 'kpres-1' 'katt-1'
    $blocked = Invoke-Reserve $idx @($kb.JobId) 'kpres-2'
    Assert-That ($blocked.Status -ceq 'NO_ELIGIBLE_CANDIDATE' -and $blocked.Skips[0].Reasons -ccontains "PATH_CONFLICT:$($ka.JobId)") 'overlapping path stays blocked while the consumed job is uncertain'
    $free = Invoke-Reserve $idx @($kb.JobId, $kc.JobId) 'kpres-3'
    Assert-That ($free.JobId -ceq $kc.JobId) 'an independent disjoint reservation still works'
    Assert-That ((Invoke-Consume $idx $kc 'kpres-3' 'katt-2').Status -ceq 'NEWLY_CONSUMED') 'and consumes independently'

    # a held lease is a refusal, never a launch permission
    $idx = New-IndexCopy 'consume-lease'
    $kl = New-JobFixture 'kl' 1
    Register-Fixture $idx $kl
    $null = Invoke-Reserve $idx @($kl.JobId) 'klres-1'
    $held = [IO.File]::Open("$idx.lease", 'OpenOrCreate', 'ReadWrite', 'None')
    try { Assert-EventRefused $idx 'LEASE_BUSY' { Invoke-Consume $idx $kl 'klres-1' 'klatt-1' } 'consume with a held lease' }
    finally { $held.Dispose() }
    Assert-That (-not (Test-SjqHasKey (Get-Job $idx $kl.JobId)['reservation'] 'consumed')) 'a lease refusal consumes nothing'

    # consume write failure keeps the old bytes and the reservation unconsumed
    $original = ${function:Invoke-SjqReplace}
    Set-Item -Path function:Invoke-SjqReplace -Value { param($TempPath, $IndexPath) throw 'simulated replace failure' }
    try { Assert-EventRefused $idx 'WRITE_FAILED' { Invoke-Consume $idx $kl 'klres-1' 'klatt-1' } 'failed consume replacement' }
    finally { Set-Item -Path function:Invoke-SjqReplace -Value $original }
    Assert-That ((Invoke-Consume $idx $kl 'klres-1' 'klatt-1').Status -ceq 'NEWLY_CONSUMED') 'after a failed write the same reservation can still be consumed once'

    # ---------- 15. dependency seam and review-state gates (state forced on a private copy; the full evidence chain is in source-job-owner.tests.ps1) ----------
    function Set-JobState([string]$Index, [string]$JobId, [string]$State) {
        $root = Read-Root $Index
        $root['controllerTaskRegistry']['sourceOnlyJobQueue']['jobs'][$JobId]['state'] = $State
        Write-Json $Index $root
    }
    $idx = New-IndexCopy 'depseam'
    $d1 = New-JobFixture 'd1' 1
    $d2 = New-JobFixture 'd2' 2 -Deps @('job-d1')
    Register-Fixture $idx $d1; Register-Fixture $idx $d2
    $n = 0
    foreach ($blockedState in 'SOURCE_PREPARED', 'DISPATCH_UNCERTAIN', 'RUNNING', 'REVIEW_REQUIRED', 'FAILED', 'SOURCE_REJECTED', 'SOURCE_REVIEW_ACCEPTED', 'DELIVERED_PENDING_RELEASE', 'RELEASED_FAILED') {
        Set-JobState $idx $d1.JobId $blockedState
        $n++
        $got = Invoke-Reserve $idx @($d2.JobId) "dep-res-$n"
        Assert-That ($got.Status -ceq 'NO_ELIGIBLE_CANDIDATE' -and $got.Skips[0].Reasons -ccontains 'UNRESOLVED_DEPENDENCY:job-d1') "dependency on a $blockedState job stays unresolved"
    }
    Assert-That ($got.Skips[0].Reasons -ccontains 'DEPENDENCY_FAILED_RELEASED:job-d1') 'a failed release is reported as such and still does not satisfy the dependency'
    Assert-That ((Invoke-Reserve $idx @($d2.JobId) 'dep-res-missing').Status -ceq 'NO_ELIGIBLE_CANDIDATE') 'dependency state unchanged by repeated checks'
    Set-JobState $idx $d1.JobId 'DELIVERED_RELEASED'
    $ok = Invoke-Reserve $idx @($d2.JobId) 'dep-res-ok'
    Assert-That ($ok.Status -ceq 'RESERVED' -and $ok.JobId -ceq $d2.JobId) 'only a delivered-and-released dependency is satisfied'

    $idx = New-IndexCopy 'overlapfree'
    $sharedO = Join-Path $work 'shared-o'
    $o1 = New-JobFixture 'o1' 1 $sharedO
    $o2 = New-JobFixture 'o2' 2 (Join-Path $sharedO 'sub')
    Register-Fixture $idx $o1; Register-Fixture $idx $o2
    Set-JobState $idx $o1.JobId 'SOURCE_REJECTED'
    Assert-That ((Invoke-Reserve $idx @($o2.JobId) 'ov-1').Skips[0].Reasons -ccontains "PATH_CONFLICT:$($o1.JobId)") 'a rejected-but-unreleased job still protects its paths'
    Set-JobState $idx $o1.JobId 'RELEASED_FAILED'
    Assert-That ((Invoke-Reserve $idx @($o2.JobId) 'ov-2').Status -ceq 'RESERVED') 'a failed release frees the overlapping paths'

    $idx = New-IndexCopy 'newevents'
    $ne = New-JobFixture 'ne' 1
    Register-Fixture $idx $ne
    $dummy = [ordered]@{ path = (Join-Path $work 'nonexistent.json'); sha256 = ('1' * 64) }
    $intentEvt = [ordered]@{ schema = 'SourceJobQueueEvent/v1'; eventId = 'ne-intent'; type = 'REVIEW_INTENT'; jobId = $ne.JobId; intentRef = $dummy }
    Assert-EventRefused $idx 'STATE_NOT_REVIEWABLE' { Send-Event $idx $intentEvt } 'intent for a job that has no terminal evidence'
    $extraIntent = [ordered]@{ schema = 'SourceJobQueueEvent/v1'; eventId = 'ne-intent2'; type = 'REVIEW_INTENT'; jobId = $ne.JobId; intentRef = $dummy; surprise = 1 }
    Assert-EventRefused $idx 'UNEXPECTED_KEY' { Send-Event $idx $extraIntent } 'intent event with an unknown key'
    $releaseEvt = [ordered]@{ schema = 'SourceJobQueueEvent/v1'; eventId = 'ne-release'; type = 'SOURCE_OWNERSHIP_RELEASE'; jobId = $ne.JobId; releaseRef = $dummy }
    Assert-EventRefused $idx 'RELEASE_WITHOUT_DISPOSITION' { Send-Event $idx $releaseEvt } 'release without any admitted disposition'
    $dispEvt = [ordered]@{ schema = 'SourceJobQueueEvent/v1'; eventId = 'ne-disp'; type = 'SOURCE_DISPOSITION'; jobId = $ne.JobId; dispositionRef = $dummy; dispositionAdmissionRef = $dummy }
    Assert-EventRefused $idx 'MISSING_FILE' { Send-Event $idx $dispEvt } 'disposition whose pinned evidence file does not exist'

    # ---------- 11. no process / claim / acceptance surface ----------
    $source = Get-Content -LiteralPath $libPath -Raw
    Assert-That ($source -cnotmatch 'Start-Process|Invoke-Expression|Diagnostics\.Process|Invoke-RestMethod|Invoke-WebRequest|\biex\b') 'library has no process, network or dynamic-code surface'
    Assert-That ($source -cnotmatch "'(DONE|ACCEPTED)'") 'library never writes a DONE/ACCEPTED state'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "source-job-queue tests: passed=$script:Passed failed=$script:Failures skipped=$script:Skipped"
if ($script:Failures -gt 0) { exit 1 }
