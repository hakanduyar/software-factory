# Offline harness for scripts/orchestration/source-job-owner.ps1 and the review/disposition/release events of
# scripts/orchestration/source-job-queue.ps1.
# Run: pwsh -NoProfile -File tests/orchestration/source-job-owner.tests.ps1
#
# Private temp directory only. Real SEPARATE local processes are used: a controlled launcher stand-in consumes
# reservations through the real core and runs a harmless pwsh child; owner "restarts" are fresh pwsh processes.
# It never starts Claude or any provider, reaches the network, probes quota, or touches a live index.
# Every review, mapping, disposition, admission, release, delivery receipt and tool response below is an OFFLINE
# FIXTURE written by this harness. Tool responses are labelled MOCK/NOT_LIVE and prove nothing about a real
# collaboration.followup_task: an actual non-root handoff is a separate observed live integration.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ownerPath = Join-Path $repo 'scripts/orchestration/source-job-owner.ps1'
$corePath = Join-Path $repo 'scripts/orchestration/source-job-queue.ps1'
. $ownerPath

$script:Passed = 0
$script:Failures = 0
function Assert-That([bool]$Condition, [string]$Message) {
    if ($Condition) { $script:Passed++ } else { $script:Failures++; Write-Host "FAIL: $Message" }
}
function Assert-Refused([string]$Code, [scriptblock]$Action, [string]$Message) {
    try { $null = & $Action; Assert-That $false "$Message (no refusal)" }
    catch { Assert-That ($_.Exception.Message -clike "SJQ_REFUSED:$Code*") "$Message (got: $($_.Exception.Message))" }
}

$work = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('sjo-' + [guid]::NewGuid().ToString('N'))))
[void][IO.Directory]::CreateDirectory($work)
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$script:Actions = [Collections.Generic.List[object]]::new()
$script:LaunchLog = [Collections.Generic.List[string]]::new()

# ---------- generic helpers ----------

function Get-Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Json([string]$Path, $Object) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Object -Depth 20), [Text.UTF8Encoding]::new($false))
}
function Read-Json([string]$Path) { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String }
function Get-Ref([string]$Path) { [ordered]@{ path = $Path; sha256 = (Get-Sha $Path) } }
function ConvertTo-RefObj($Ref) { [ordered]@{ path = [string]$Ref['path']; sha256 = [string]$Ref['sha256'] } }
function Get-Queue([string]$Index) {
    $registry = (Read-Json $Index)['controllerTaskRegistry']
    if ($registry.ContainsKey('sourceOnlyJobQueue')) { $registry['sourceOnlyJobQueue'] } else { $null }
}
function Get-Ver([string]$Index) { $q = Get-Queue $Index; if ($null -eq $q) { 0 } else { [long]$q['version'] } }
function Get-JobRec([string]$Index, [string]$JobId) { (Get-Queue $Index)['jobs'][$JobId] }
function Wait-File([string]$Path) {
    # Fixture synchronisation on a child process the harness itself started; bounded so a broken fixture fails fast.
    for ($i = 0; $i -lt 300 -and -not (Test-SjoReadyFile $Path); $i++) { Start-Sleep -Milliseconds 200 }
    Test-SjoReadyFile $Path
}
function Merge-Over($Object, $Over) { if ($Over -is [System.Collections.IDictionary]) { foreach ($key in $Over.Keys) { $Object[$key] = $Over[$key] } } }
function Remove-Keys($Object, $Keys) { foreach ($key in @($Keys)) { if ($null -ne $key) { $Object.Remove($key) } } }
function Write-Doc([string]$Name, $Object, $Transform = $null) {
    $path = Join-Path (Join-Path $work 'docs') $Name
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path))
    $text = ConvertTo-Json -InputObject $Object -Depth 20
    if ($null -ne $Transform) { $text = & $Transform $text }
    [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
    Get-Ref $path
}
function Assert-RefusedKeep([string]$Index, [string]$Code, [scriptblock]$Action, [string]$Message) {
    $before = Get-Sha $Index
    Assert-Refused $Code $Action $Message
    Assert-That ((Get-Sha $Index) -ceq $before) "$Message (index bytes must be unchanged)"
}

# ---------- controlled launcher stand-in and separate-process owner driver ----------

$childScript = Join-Path $work 'fixture-child.ps1'
[IO.File]::WriteAllText($childScript, @'
param([int]$Ms, [int]$Exit, [string]$Path, [string]$Text)
Start-Sleep -Milliseconds $Ms
[IO.File]::WriteAllText($Path, $Text)
[Console]::Out.Write('child-done')
exit $Exit
'@)

$stubTemplate = @'
param([string]$IndexPath, [long]$ExpectedVersion, [string]$JobId, [string]$ReservationId, [string]$PlanPath, [string]$ExpectedPlanSha256, [string]$AdmissionPath, [string]$ExpectedAdmissionSha256, [string]$UsagePath, [string]$ExpectedUsageSha256)
$ErrorActionPreference = 'Stop'
. '__CORE__'
$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
$adm = Get-Content -LiteralPath $AdmissionPath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
$b = $plan['fixtureBehavior']
$attemptId = 'attempt-' + [guid]::NewGuid().ToString('N')
$consumedUtc = [DateTime]::UtcNow.ToString('o')
$c = Consume-SourceJobReservation -IndexPath $IndexPath -ExpectedVersion $ExpectedVersion -JobId $JobId -ReservationId $ReservationId -PlanPath $PlanPath -ExpectedPlanSha256 $ExpectedPlanSha256 -AdmissionPath $AdmissionPath -ExpectedAdmissionSha256 $ExpectedAdmissionSha256 -TaskId $plan['taskId'] -SessionId $plan['sessionId'] -OperatorSha256 $adm['operatorSha256'] -RunDirectory $plan['runDirectory'] -AttemptId $attemptId -ConsumedUtc $consumedUtc
if ($c.Status -cne 'NEWLY_CONSUMED') { throw "NOT_NEWLY_CONSUMED:$($c.Status)" }
if ($b['crashAfter'] -ceq 'consume') { exit 0 }
$run = $plan['runDirectory']
if ([IO.Directory]::Exists($run)) { throw 'RUN_EXISTS_NO_RETRY' }
[void][IO.Directory]::CreateDirectory($run)
function Save-Json([string]$Name, $Object) {
    $stream = [IO.File]::Open((Join-Path $run $Name), 'CreateNew', 'Write', 'None')
    try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Object -Depth 20)); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}
function Get-FileSha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
Save-Json 'invocation.json' ([ordered]@{
        schema = 'SupervisedSourceOnlyInvocation/v1'; planSha256 = $ExpectedPlanSha256; admissionSha256 = $ExpectedAdmissionSha256; usageReceiptSha256 = $ExpectedUsageSha256
        arguments = @('--print'); workingDirectory = $run; environmentNames = @('PATH'); history = $plan['history']
        factoryClaim = $false; operationalReceipt = $false; continuityGrant = $false
        queueBinding = [ordered]@{ schema = 'SourceJobQueueBinding/v1'; jobId = $JobId; reservationId = $ReservationId; attemptId = $attemptId; consumedUtc = $consumedUtc; runDirectory = $run }
    })
$editable = $plan['editablePins'][0]['path']
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
foreach ($a in @('-NoProfile', '-File', '__CHILD__', '-Ms', [string]$b['sleepMs'], '-Exit', [string]$b['exitCode'], '-Path', $editable, '-Text', [string]$b['text'])) { $psi.ArgumentList.Add($a) }
$child = [Diagnostics.Process]::new()
$child.StartInfo = $psi
[void]$child.Start()
$startUtc = $child.StartTime.ToUniversalTime().ToString('o')
Save-Json 'start.json' ([ordered]@{ schema = 'SupervisedSourceOnlyStart/v1'; pid = $child.Id; sessionId = $plan['sessionId']; startUtc = $startUtc; observedUtc = [DateTime]::UtcNow.ToString('o'); noFactoryClaim = $true })
$outTask = $child.StandardOutput.ReadToEndAsync()
$errTask = $child.StandardError.ReadToEndAsync()
$child.WaitForExit()
$exit = $child.ExitCode
$endUtc = $child.ExitTime.ToUniversalTime().ToString('o')
$stdoutPath = Join-Path $run 'stdout.bin'
$stderrPath = Join-Path $run 'stderr.bin'
[IO.File]::WriteAllBytes($stdoutPath, [Text.Encoding]::UTF8.GetBytes($outTask.GetAwaiter().GetResult()))
[IO.File]::WriteAllBytes($stderrPath, [Text.Encoding]::UTF8.GetBytes($errTask.GetAwaiter().GetResult()))
Save-Json 'terminal.json' ([ordered]@{
        schema = 'SupervisedSourceOnlyTerminal/v1'; providerStarted = $true; pid = $child.Id; sessionId = $plan['sessionId']; startUtc = $startUtc; endUtc = $endUtc
        exitCode = $exit; errorType = $null; rawDrained = $true
        stdoutSha256 = (Get-FileSha $stdoutPath); stdoutBytes = (Get-Item -LiteralPath $stdoutPath).Length; stderrSha256 = (Get-FileSha $stderrPath); stderrBytes = (Get-Item -LiteralPath $stderrPath).Length
        editableAfter = @(foreach ($x in $plan['editablePins']) { [ordered]@{ path = $x['path']; sha256 = (Get-FileSha $x['path']) } })
        protectedPostPins = @(foreach ($x in $plan['protectedPins']) { [ordered]@{ path = $x['path']; unchanged = ((Get-FileSha $x['path']) -ceq $x['sha256']) } })
        history = $plan['history']; globalUsage = 'UNKNOWN'; taskAcceptance = 'NOT_EVALUATED'; factoryClaim = $false; operationalCompletion = $false; successorAuthority = $false
    })
'@
$launcherPath = Join-Path $work 'fixture-launcher.ps1'
[IO.File]::WriteAllText($launcherPath, $stubTemplate.Replace('__CORE__', $corePath).Replace('__CHILD__', $childScript))
$launcherSha = Get-Sha $launcherPath

$driverPath = Join-Path $work 'owner-driver.ps1'
[IO.File]::WriteAllText($driverPath, @'
param([Parameter(Mandatory)][string]$ArgsPath)
$ErrorActionPreference = 'Stop'
. '__OWNER__'
$a = Get-Content -LiteralPath $ArgsPath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
$p = @{ IndexPath = $a['indexPath']; Batch = @($a['batch']); EvidenceRoot = $a['evidenceRoot']; LauncherPath = $a['launcherPath']; ExpectedLauncherSha256 = $a['launcherSha']; ReviewerTargets = [string[]]@($a['reviewerTargets']) }
if ($a['await']) { $p['AwaitRunning'] = $true }
$r = Invoke-SourceJobOwnerStep @p
[IO.File]::WriteAllText($a['resultPath'], (ConvertTo-Json -InputObject $r -Depth 12), [Text.UTF8Encoding]::new($false))
'@.Replace('__OWNER__', $ownerPath))

function Start-Driver([string]$Index, $Batch, [string]$Ev, [string[]]$Targets, [bool]$Await, [string]$Tag) {
    $argsPath = Join-Path $work "driver-$Tag.args.json"
    $resultPath = Join-Path $work "driver-$Tag.result.json"
    Write-Json $argsPath ([ordered]@{ indexPath = $Index; batch = @($Batch); evidenceRoot = $Ev; launcherPath = $launcherPath; launcherSha = $launcherSha; reviewerTargets = @($Targets); await = $Await; resultPath = $resultPath })
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $pwsh
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    foreach ($a in @('-NoProfile', '-File', $driverPath, '-ArgsPath', $argsPath)) { $psi.ArgumentList.Add($a) }
    $process = [Diagnostics.Process]::Start($psi)
    [pscustomobject]@{ Process = $process; ResultPath = $resultPath; Out = $process.StandardOutput.ReadToEndAsync(); Err = $process.StandardError.ReadToEndAsync() }
}
function Wait-Driver($Driver) {
    $Driver.Process.WaitForExit()
    $null = $Driver.Out.GetAwaiter().GetResult()
    $err = $Driver.Err.GetAwaiter().GetResult()
    $result = if ([IO.File]::Exists($Driver.ResultPath)) { Read-Json $Driver.ResultPath } else { $null }
    [pscustomobject]@{ ExitCode = $Driver.Process.ExitCode; Result = $result; Err = $err }
}

# ---------- fixtures ----------

function New-IndexCopy([string]$Name) {
    $path = Join-Path $work "$Name.index.json"
    Write-Json $path ([ordered]@{ schema = 'fixture-root/v1'; controllerTaskRegistry = [ordered]@{ legacyTasks = @([ordered]@{ id = 'legacy-1'; status = 'UNKNOWN' }) } })
    $path
}

function New-JobFixture([string]$Name, [long]$Priority, [string]$Owned = '', [string[]]$Deps = @(), [hashtable]$Behavior = @{}, [string]$Session = '', [int]$ExtraPins = 0) {
    if (-not $Owned) { $Owned = Join-Path $work "owned-$Name" }
    [void][IO.Directory]::CreateDirectory($Owned)
    $editable = Join-Path $Owned 'target.txt'
    [IO.File]::WriteAllText($editable, 'v0')
    $protected = Join-Path $work 'protected.txt'
    if (-not [IO.File]::Exists($protected)) { [IO.File]::WriteAllText($protected, 'protected') }
    $run = Join-Path (Join-Path $work 'runs') $Name
    if (-not $Session) { $Session = "session-$Name" }
    # PowerShell variables are case-insensitive: this must not share a name with the $Behavior parameter being enumerated.
    $effectiveBehavior = [ordered]@{ exitCode = 0; sleepMs = 1200; crashAfter = ''; text = "candidate-$Name" }
    foreach ($key in @($Behavior.Keys)) { $effectiveBehavior[$key] = $Behavior[$key] }
    $pinList = [Collections.Generic.List[object]]::new()
    $pinList.Add([ordered]@{ path = $editable; sha256 = (Get-Sha $editable) })
    for ($n = 2; $n -le (1 + $ExtraPins); $n++) {
        $extra = Join-Path $Owned "target$n.txt"
        [IO.File]::WriteAllText($extra, "v0-$n")
        $pinList.Add([ordered]@{ path = $extra; sha256 = (Get-Sha $extra) })
    }
    $planPath = Join-Path (Join-Path $work 'plans') "$Name.plan.json"
    Write-Json $planPath ([ordered]@{
            schema = 'SupervisedCodeSourceOnlyTask/v1'; taskId = "task-$Name"; sessionId = $Session; runDirectory = $run
            editablePins = $pinList.ToArray(); protectedPins = @([ordered]@{ path = $protected; sha256 = (Get-Sha $protected) })
            history = @('prior-refusal-1'); fixtureBehavior = $effectiveBehavior
        })
    $admPath = Join-Path (Join-Path $work 'plans') "$Name.admission.json"
    Write-Json $admPath ([ordered]@{
            schema = 'IndependentSupervisedSourceOnlyAdmission/v1'; decision = 'ADMIT_SOURCE_ONLY_ONCE'; planSha256 = (Get-Sha $planPath); taskId = "task-$Name"
            expiresUtc = '2099-01-01T00:00:00.0000000Z'; reviewer = 'independent-reviewer'; maximumNativeProcesses = 1; operatorSha256 = ('e' * 64)
        })
    [pscustomobject]@{ Name = $Name; JobId = "job-$Name"; Owned = $Owned; Editable = $editable; Run = $run; Session = $Session; PlanPath = $planPath; AdmPath = $admPath; Priority = $Priority; Deps = $Deps }
}

function Register-Job([string]$Index, $Fx) {
    $evt = [ordered]@{
        schema = 'SourceJobQueueEvent/v1'; eventId = "reg-$($Fx.Name)"; type = 'REGISTER_SOURCE_JOB'; jobId = $Fx.JobId; parentId = "parent-$($Fx.Name)"
        priority = $Fx.Priority; ownedPaths = @($Fx.Owned); dependsOn = @($Fx.Deps); planRef = (Get-Ref $Fx.PlanPath); admissionRef = (Get-Ref $Fx.AdmPath)
    }
    $path = Join-Path (Join-Path $work 'events') "reg-$($Fx.Name).json"
    Write-Json $path $evt
    Invoke-SourceJobQueueEvent -IndexPath $Index -ExpectedVersion (Get-Ver $Index) -EventPath $path -ExpectedEventSha256 (Get-Sha $path) -AtUtc (Get-SjoNowUtc)
}

# An OFFLINE FIXTURE shaped like the fields the owner reads; it is not a native usage receipt.
function New-Usage([string]$Name, [int]$CapturedAgoSec, [int]$ExpiresInSec, [long]$Week, [long]$Session, [string]$Credits = 'OFF') {
    $now = [DateTime]::UtcNow
    $path = Join-Path (Join-Path $work 'usage') "$Name.json"
    Write-Json $path ([ordered]@{
            label = 'OFFLINE_FIXTURE_NOT_A_NATIVE_USAGE_RECEIPT'; capturedAtUtc = $now.AddSeconds(-$CapturedAgoSec).ToString('o'); expiresAtUtc = $now.AddSeconds($ExpiresInSec).ToString('o')
            accountUsage = [ordered]@{ weekAllModelsUsedPercent = $Week; sessionUsedPercent = $Session; usageCredits = $Credits }
        })
    Get-Ref $path
}
function New-Entry($Fx, $Usage) { [ordered]@{ jobId = $Fx.JobId; runDirectory = $Fx.Run; usageRef = $Usage } }

function Invoke-Owner([string]$Index, $Batch, [string]$Ev, [string[]]$Targets = @('/root/git_delivery_audit'), [switch]$Await) {
    $p = @{ IndexPath = $Index; Batch = $Batch; EvidenceRoot = $Ev; LauncherPath = $launcherPath; ExpectedLauncherSha256 = $launcherSha; ReviewerTargets = $Targets }
    if ($Await) { $p['AwaitRunning'] = $true }
    $r = Invoke-SourceJobOwnerStep @p
    foreach ($a in $r.Actions) { $script:Actions.Add($a) }
    foreach ($l in $r.Launched) { $script:LaunchLog.Add([string]$l['jobId']) }
    $r
}
function Invoke-Until([string]$Index, $Batch, [string]$Ev, [scriptblock]$Done, [string[]]$Targets = @('/root/git_delivery_audit')) {
    $r = $null
    for ($i = 0; $i -lt 8; $i++) {
        $r = Invoke-Owner $Index $Batch $Ev $Targets -Await
        if (& $Done $r) { return $r }
    }
    $r
}
function Get-ActionsFor([string]$JobId) { @($script:Actions | Where-Object { $_.JobId -ceq $JobId }) }
function Get-LaunchCount([string]$JobId) { @($script:LaunchLog | Where-Object { $_ -ceq $JobId }).Count }

# ---------- offline evidence builders (labelled fixtures; the module never creates these) ----------

function New-DispSet([string]$Index, $Fx, [string]$Tag, [string]$Kind, [hashtable]$Over = @{}) {
    $job = Get-JobRec $Index $Fx.JobId
    $terminalPins = @((Read-Json (Join-Path $Fx.Run 'terminal.json'))['editableAfter'] | ForEach-Object { [ordered]@{ path = $_['path']; sha256 = $_['sha256'] } })
    $pins = if ($Over.ContainsKey('pins')) { $Over['pins'] } else { $terminalPins }
    $head = if ($Over.ContainsKey('head')) { $Over['head'] } else { $null }
    $reviewer = if ($Over.ContainsKey('reviewer')) { $Over['reviewer'] } else { '/root/git_delivery_audit' }
    $original = Join-Path (Join-Path $work 'docs') "$Tag-original-review.json"
    $originalBody = [ordered]@{ label = 'OFFLINE_FIXTURE_NOT_AN_ACTUAL_REVIEW'; tag = $Tag; kind = $Kind }
    Merge-Over $originalBody $Over['originalBody']
    Write-Json $original $originalBody
    $resultPath = Join-Path (Join-Path $work 'docs') "$Tag-result.json"
    $failed = if ($Over.ContainsKey('failedChecks')) { $Over['failedChecks'] } else { 0 }
    $resultBody = if ($Over.ContainsKey('resultBody')) { $Over['resultBody'] } else { [ordered]@{ label = 'OFFLINE_FIXTURE_NOT_AN_ACTUAL_CHECK_RESULT'; passed = 3; failed = $failed } }
    Write-Json $resultPath $resultBody
    $decision = if ($Kind -ceq 'DELIVERED') { 'SOURCE_ACCEPTED' } else { $Kind }
    $map = [ordered]@{
        schema = 'SourceJobScopedReviewMapping/v1'; mappingId = "map-$Tag"; jobId = $Fx.JobId; taskId = "task-$($Fx.Name)"; terminalRef = (ConvertTo-RefObj $job['terminal']['ref'])
        candidatePins = @($pins); sourceHead = $head; originalReviewRef = (Get-Ref $original); resultRefs = @((Get-Ref $resultPath))
        scope = 'SOURCE_ONLY_SCOPED_OFFLINE'; decision = $decision; reviewer = $reviewer
    }
    Merge-Over $map $Over['map']
    $mapRef = Write-Doc "$Tag-mapping.json" $map
    $deliveryRef = $null
    if ($Kind -ceq 'DELIVERED') {
        $deliveryHead = if ($head) { $head } else { 'c8cf8c1942a72eec54ea9b5a4cd336b336a33bb9' }
        $delivery = [ordered]@{
            schema = 'IndependentDeliveryReceipt/v1'; pr = 'https://example.invalid/offline-fixture/pull/110'; head = $deliveryHead; merge = '0e052c3cd8c59236e472812eb079cd10b42c77c7'
            mergedAt = '2026-10-29T21:53:57Z'; checks = 24; checksConclusion = 'ALL_SUCCESS'; componentVerdictSha256 = (Get-Sha $original)
            operationalActivation = $false; continuousOwnerAccepted = $false
        }
        Merge-Over $delivery $Over['delivery']
        $deliveryRef = Write-Doc "$Tag-delivery.json" $delivery
    }
    $tuple = [ordered]@{ planRef = (ConvertTo-RefObj $job['plan']['ref']); admissionRef = (ConvertTo-RefObj $job['admission']['ref']); terminalRef = (ConvertTo-RefObj $job['terminal']['ref']) }
    $disp = [ordered]@{
        schema = 'SourceJobIndependentDisposition/v1'; dispositionId = "disp-$Tag"; jobId = $Fx.JobId; taskId = "task-$($Fx.Name)"
        planRef = $tuple.planRef; admissionRef = $tuple.admissionRef; terminalRef = $tuple.terminalRef; candidatePins = @($pins); sourceHead = $head
        kind = $Kind; reviewer = $reviewer; reviewRef = $mapRef; deliveryRef = $deliveryRef; candidateMappingRef = $null
    }
    Merge-Over $disp $Over['disp']
    Remove-Keys $disp $Over['dispDrop']
    $dispRef = Write-Doc "$Tag-disposition.json" $disp $Over['dispText']
    $adm = [ordered]@{
        schema = 'SourceJobDispositionAdmission/v1'; admissionId = "dadm-$Tag"; decision = 'ADMIT_SCOPED_SOURCE_DISPOSITION'; reviewer = 'host-review-actor'; dispositionRef = $dispRef
        jobId = $Fx.JobId; taskId = "task-$($Fx.Name)"; planRef = $tuple.planRef; admissionRef = $tuple.admissionRef; terminalRef = $tuple.terminalRef; candidatePins = @($pins); sourceHead = $head
    }
    Merge-Over $adm $Over['adm']
    @{ DispRef = $dispRef; AdmRef = (Write-Doc "$Tag-admission.json" $adm); MapRef = $mapRef }
}
function Import-Set([string]$Index, $Fx, $Set, [string]$Ev) {
    Import-SourceJobDisposition -IndexPath $Index -JobId $Fx.JobId -DispositionPath $Set.DispRef.path -ExpectedDispositionSha256 $Set.DispRef.sha256 `
        -DispositionAdmissionPath $Set.AdmRef.path -ExpectedDispositionAdmissionSha256 $Set.AdmRef.sha256 -EvidenceRoot $Ev
}
function New-ReleaseDoc([string]$Index, $Fx, $Set, [string]$Tag, [hashtable]$Over = @{}) {
    $job = Get-JobRec $Index $Fx.JobId
    $release = [ordered]@{
        schema = 'SourceJobOwnershipRelease/v1'; releaseId = "rel-$Tag"; jobId = $Fx.JobId; taskId = "task-$($Fx.Name)"
        planRef = (ConvertTo-RefObj $job['plan']['ref']); admissionRef = (ConvertTo-RefObj $job['admission']['ref']); terminalRef = (ConvertTo-RefObj $job['terminal']['ref'])
        dispositionRef = $Set.DispRef; dispositionAdmissionRef = $Set.AdmRef; ownedPaths = @($Fx.Owned); reviewer = 'host-review-actor'; releasedUtc = (Get-SjoNowUtc)
    }
    Merge-Over $release $Over
    Write-Doc "$Tag-release.json" $release
}
function Import-Release([string]$Index, $Fx, $Ref, [string]$Ev) {
    Import-SourceJobOwnershipRelease -IndexPath $Index -JobId $Fx.JobId -ReleasePath $Ref.path -ExpectedReleaseSha256 $Ref.sha256 -EvidenceRoot $Ev
}
# MOCK/NOT_LIVE stand-in for a saved collaboration.followup_task response.
function Send-MockAck([string]$Index, $Action, [string]$Ev, [hashtable]$Over = @{}) {
    $tool = [ordered]@{ label = 'MOCK/NOT_LIVE'; tool = 'collaboration.followup_task'; target = $Action.ReviewerTarget; intentId = $Action.IntentId; note = 'offline fixture, not a real followup_task response' }
    Merge-Over $tool $Over
    $ref = Write-Doc "toolresult-$($Action.IntentId)-$([guid]::NewGuid().ToString('N').Substring(0, 6)).json" $tool
    Submit-SourceJobHandoffResult -IndexPath $Index -Action $Action -ToolResultPath $ref.path -ExpectedToolResultSha256 $ref.sha256 -EvidenceRoot $Ev
}

# Bounded OFFLINE diagnostic for a missing prerequisite: actual returned result plus the relevant index records.
# It reports observed evidence only and assumes no particular refusal code. It never contains credentials.
function Write-ScenarioDiagnostic($Result, [string]$Index, $Fixtures) {
    $queue = Get-Queue $Index
    $jobs = [ordered]@{}
    $fixtureRefs = [ordered]@{}
    foreach ($f in @($Fixtures)) {
        $j = if ($null -ne $queue) { $queue['jobs'][$f.JobId] } else { $null }
        $review = if ($null -ne $j) { $j['review'] } else { $null }
        $intent = if ($review -is [System.Collections.IDictionary]) { $review['intent'] } else { $null }
        $jobs[$f.JobId] = [ordered]@{
            state = $(if ($null -ne $j) { $j['state'] } else { $null }); notice = $(if ($null -ne $j) { $j['notice'] } else { $null }); reasons = $(if ($null -ne $j) { $j['reasons'] } else { $null })
            intent = $(if ($intent -is [System.Collections.IDictionary]) { [ordered]@{ intentId = $intent['intentId']; status = $intent['status']; target = $intent['reviewerTarget']; ref = $intent['ref']; pinCount = @($intent['candidatePins']).Count } } else { $null })
            handoffRecorded = ($review -is [System.Collections.IDictionary]) -and ($null -ne $review['handoff'])
        }
        $fixtureRefs[$f.JobId] = [ordered]@{ editable = $f.Editable; run = $f.Run; plan = (Get-Ref $f.PlanPath) }
    }
    $diagnostic = [ordered]@{
        label = 'OFFLINE_DIAGNOSTIC_NOT_AN_ACCEPTANCE'
        status = $(if ($null -ne $Result) { $Result.Status } else { $null }); resultActions = $(if ($null -ne $Result) { @($Result.Actions | ForEach-Object { [ordered]@{ type = $_.Type; jobId = $_.JobId } }) } else { @() })
        resultJobs = $(if ($null -ne $Result) { $Result.Jobs } else { $null }); checkpoint = $(if ($null -ne $Result) { $Result.Checkpoint } else { $null })
        accumulatedActions = @($script:Actions | ForEach-Object { [ordered]@{ type = $_.Type; jobId = $_.JobId } }); launchLog = @($script:LaunchLog)
        indexVersion = $(if ($null -ne $queue) { $queue['version'] } else { $null }); indexJobs = $jobs; fixtures = $fixtureRefs
    }
    Write-Host ('DIAGNOSTIC ' + (ConvertTo-Json -InputObject $diagnostic -Depth 8 -Compress))
}

# candidatePins must be a FLAT array of exact {path,sha256} objects whose set equals the immutable terminal editableAfter rows.
function Assert-FlatIntent([string]$Index, $Fx, [int]$Expected, [string]$Label) {
    $intent = (Get-JobRec $Index $Fx.JobId)['review']['intent']
    $terminalRows = @((Read-Json (Join-Path $Fx.Run 'terminal.json'))['editableAfter'])
    $intentFile = Read-Json $intent['ref']['path']
    foreach ($pair in @(@('index record', $intent['candidatePins']), @('intent file', $intentFile['candidatePins']))) {
        $pins = $pair[1]
        $flat = ($pins -is [System.Collections.IList]) -and $pins.Count -eq $Expected
        if ($flat) {
            foreach ($p in $pins) {
                if (($p -isnot [System.Collections.IDictionary]) -or @($p.Keys).Count -ne 2 -or -not $p.ContainsKey('path') -or -not $p.ContainsKey('sha256')) { $flat = $false }
                elseif (@($terminalRows | Where-Object { $_['path'] -ceq $p['path'] -and $_['sha256'] -ceq $p['sha256'] }).Count -ne 1) { $flat = $false }
            }
        }
        Assert-That $flat "${Label}: the $($pair[0]) candidatePins is a flat array of $Expected exact path+sha256 objects matching the terminal rows"
    }
}

try {
    # ===== 0. flat candidatePins intent shape with several pins, through the real owner and core =====
    $idx = New-IndexCopy 'flat'; $ev = Join-Path $work 'ev-flat'
    $script:Actions.Clear(); $script:LaunchLog.Clear()
    $mp = New-JobFixture 'mp' 1 -ExtraPins 2
    $null = Register-Job $idx $mp
    $usageM = New-Usage 'flat-ok' 30 1800 10 20
    $rm = Invoke-Until $idx @((New-Entry $mp $usageM)) $ev { param($r) @(Get-ActionsFor 'job-mp').Count -ge 1 }
    $haveM = @(Get-ActionsFor 'job-mp').Count -ge 1
    Assert-That $haveM 'prerequisite: the multi-pin job produced a handoff action'
    if (-not $haveM) { Write-ScenarioDiagnostic $rm $idx @($mp); throw 'PRECONDITION_FAILED: multi-pin handoff action missing' }
    Assert-That (@(Get-ActionsFor 'job-mp')[0].Type -ceq 'SEND_REVIEW_HANDOFF') 'multi-pin: a review handoff action was generated by the real owner and accepted by the core'
    Assert-FlatIntent $idx $mp 3 'multi-pin (3 pins)'

    $realHead ='c8cf8c1942a72eec54ea9b5a4cd336b336a33bb9'

    # ===== 1. FAILED A -> independent B: diagnosis is not acceptance, no blind retry, a failed release frees paths only =====
    $idx = New-IndexCopy 'fail'; $ev = Join-Path $work 'ev-fail'
    $script:Actions.Clear(); $script:LaunchLog.Clear()
    $fa = New-JobFixture 'fa' 1 -Behavior @{ exitCode = 3 }
    $fb = New-JobFixture 'fb' 2
    $fe = New-JobFixture 'fe' 3 -Owned (Join-Path $fa.Owned 'sub')
    $ff = New-JobFixture 'ff' 4 -Deps @($fa.JobId)
    foreach ($x in $fa, $fb, $fe, $ff) { $null = Register-Job $idx $x }
    $usage = New-Usage 'fail-ok' 30 1800 10 20
    $batch = @($fa, $fb, $fe, $ff | ForEach-Object { New-Entry $_ $usage })
    $r = Invoke-Until $idx $batch $ev { param($r) (@(Get-ActionsFor 'job-fa').Count -ge 1) -and (@(Get-ActionsFor 'job-fb').Count -ge 1) }
    $ja = Get-JobRec $idx $fa.JobId
    Assert-That ($ja['state'] -ceq 'FAILED' -and $ja['notice'] -ceq 'FAILURE_RETAINED_NO_AUTO_RETRY' -and $ja['terminal']['exitCode'] -eq 3) 'A: real controlled failure evidence is retained as FAILED'
    Assert-That ($ja['terminal']['ref']['sha256'] -ceq (Get-Sha (Join-Path $fa.Run 'terminal.json'))) 'A: the immutable terminal ref is the actual file'
    $haveAB = (@(Get-ActionsFor 'job-fa').Count -ge 1) -and (@(Get-ActionsFor 'job-fb').Count -ge 1)
    Assert-That $haveAB "prerequisite: A and B each produced a handoff action (A: $(@(Get-ActionsFor 'job-fa').Count), B: $(@(Get-ActionsFor 'job-fb').Count))"
    if (-not $haveAB) { Write-ScenarioDiagnostic $r $idx @($fa, $fb); throw 'PRECONDITION_FAILED: scenario 1 handoff action(s) missing' }
    Assert-FlatIntent $idx $fa 1 'A single-pin'
    Assert-FlatIntent $idx $fb 1 'B single-pin'
    Assert-That (@(Get-ActionsFor 'job-fa')[0].Type -ceq 'SEND_FAILURE_DIAGNOSIS_HANDOFF' -and @(Get-ActionsFor 'job-fa')[0].Purpose -ceq 'FAILURE_DIAGNOSIS') 'A: failure gets a correlated diagnosis handoff, not an acceptance request'
    Assert-That (@(Get-ActionsFor 'job-fb')[0].Type -ceq 'SEND_REVIEW_HANDOFF' -and (Get-JobRec $idx $fb.JobId)['state'] -ceq 'REVIEW_REQUIRED') 'B (disjoint) ran and reached REVIEW_REQUIRED independently of A'
    Assert-That ((Get-LaunchCount 'job-fa') -eq 1 -and (Get-LaunchCount 'job-fb') -eq 1) 'A and B each launched exactly once'
    $r2 = Invoke-Owner $idx $batch $ev
    Assert-That ($r2.Launched.Count -eq 0 -and $r2.Actions.Count -eq 0) 'no blind retry of A and no blind resend of any handoff'
    Assert-That ($r2.Jobs['job-fa'].Reasons -ccontains 'HANDOFF_UNCERTAIN_NO_ACK') 'a persisted intent without an ack is reported uncertain'
    Assert-That ($r2.Jobs['job-fe'].Reasons -ccontains 'PATH_CONFLICT:job-fa' -and $r2.Jobs['job-ff'].Reasons -ccontains 'UNRESOLVED_DEPENDENCY:job-fa') 'only the path conflict and the true dependency are blocked'

    $actA = @(Get-ActionsFor 'job-fa')[0]
    $null = Send-MockAck $idx $actA $ev
    $r3 = Invoke-Owner $idx $batch $ev
    Assert-That ($r3.Jobs['job-fa'].State -ceq 'FAILED' -and $r3.Jobs['job-fa'].Reasons -ccontains 'AWAIT_INDEPENDENT_DIAGNOSIS:HANDOFF_MOCK_NOT_LIVE') 'a (mock) scheduling ack leaves A FAILED and labelled not-live'
    $setBad = New-DispSet $idx $fa 'fa-acc' 'SOURCE_ACCEPTED'
    Assert-RefusedKeep $idx 'STATE_KIND_MISMATCH' { Import-Set $idx $fa $setBad $ev } 'a failure can never be dispositioned as SOURCE_ACCEPTED'
    $setF = New-DispSet $idx $fa 'fa-fail' 'FAILED' @{ failedChecks = 2 }
    $null = Import-Set $idx $fa $setF $ev
    $ja = Get-JobRec $idx $fa.JobId
    Assert-That ($ja['state'] -ceq 'FAILED' -and $ja['review']['disposition']['kind'] -ceq 'FAILED') 'an admitted failure diagnosis keeps the job FAILED (still protecting its paths)'
    $r4 = Invoke-Owner $idx $batch $ev
    Assert-That ($r4.Jobs['job-fe'].Reasons -ccontains 'PATH_CONFLICT:job-fa' -and $r4.Launched.Count -eq 0) 'a dispositioned but unreleased failure still blocks the overlap'
    $null = Import-Release $idx $fa (New-ReleaseDoc $idx $fa $setF 'fa') $ev
    Assert-That ((Get-JobRec $idx $fa.JobId)['state'] -ceq 'RELEASED_FAILED') 'separate release records the clearly namespaced RELEASED_FAILED state'
    $r5 = Invoke-Until $idx $batch $ev { param($r) @(Get-ActionsFor 'job-fe').Count -ge 1 }
    Assert-That ((Get-JobRec $idx $fe.JobId)['state'] -cne 'SOURCE_PREPARED' -and (Get-LaunchCount 'job-fe') -eq 1) 'the failed release freed the overlapping paths: the successor started once'
    Assert-That ((Get-LaunchCount 'job-fa') -eq 1) 'the failed job was never retried'
    Assert-That ((Get-JobRec $idx $ff.JobId)['state'] -ceq 'SOURCE_PREPARED' -and $r5.Jobs['job-ff'].Reasons -ccontains 'DEPENDENCY_FAILED_RELEASED:job-fa') 'a failed release never satisfies the success dependency'
    Assert-That ((ConvertTo-SjqCanonical (Get-Queue $idx)) -cnotmatch '"(DONE|ACCEPTED|accepted|reviewAccepted)"') 'queue records no DONE/accepted marker'

    # ===== 2. terminal -> intent -> ack -> independent review -> delivery -> separate release -> successor =====
    $idx = New-IndexCopy 'chain'; $ev = Join-Path $work 'ev-chain'
    $script:Actions.Clear(); $script:LaunchLog.Clear()
    $ca = New-JobFixture 'ca' 1 -Owned (Join-Path $work 'shared-chain')
    $cb = New-JobFixture 'cb' 2
    $cc = New-JobFixture 'cc' 3 -Owned (Join-Path $ca.Owned 'sub')
    $cd = New-JobFixture 'cd' 4 -Deps @($ca.JobId)
    foreach ($x in $ca, $cb, $cc, $cd) { $null = Register-Job $idx $x }
    $usage = New-Usage 'chain-ok' 30 1800 10 20
    $batch = @($ca, $cb, $cc, $cd | ForEach-Object { New-Entry $_ $usage })
    $r = Invoke-Until $idx $batch $ev { param($r) (@(Get-ActionsFor 'job-ca').Count -ge 1) -and (@(Get-ActionsFor 'job-cb').Count -ge 1) }
    $ja = Get-JobRec $idx $ca.JobId
    Assert-That ($ja['state'] -ceq 'REVIEW_REQUIRED' -and $ja['notice'] -ceq 'REVIEW_NEEDED_NOT_ACCEPTED' -and $ja['terminal']['exitCode'] -eq 0) 'source exit 0 is REVIEW_REQUIRED only'
    $actA = @(Get-ActionsFor 'job-ca')[0]; $actB = @(Get-ActionsFor 'job-cb')[0]
    Assert-That ($actA.Type -ceq 'SEND_REVIEW_HANDOFF' -and $actA.Tool -ceq 'collaboration.followup_task' -and $actA.ReviewerTarget -ceq '/root/git_delivery_audit' -and $actA.ReviewerTarget -cne '/root') 'the action names the supported NONROOT peer and the tool the active agent must call'
    Assert-That ((Get-JobRec $idx $ca.JobId)['review']['intent']['status'] -ceq 'INTENT_PERSISTED_BEFORE_TOOLCALL') 'the intent was persisted before any tool call'
    $r2 = Invoke-Owner $idx $batch $ev
    Assert-That ($r2.Actions.Count -eq 0 -and $r2.Launched.Count -eq 0 -and $r2.Jobs['job-ca'].Reasons -ccontains 'HANDOFF_UNCERTAIN_NO_ACK') 'without an ack the handoff is uncertain and is never blindly resent'
    Assert-That ($r2.Jobs['job-cc'].Reasons -ccontains 'PATH_CONFLICT:job-ca' -and $r2.Jobs['job-cd'].Reasons -ccontains 'UNRESOLVED_DEPENDENCY:job-ca') 'overlap C and dependent D are blocked while A waits for review'
    $setPre = New-DispSet $idx $ca 'ca-pre' 'SOURCE_ACCEPTED'
    Assert-RefusedKeep $idx 'NO_HANDOFF_ACK' { Import-Set $idx $ca $setPre $ev } 'no review disposition without a recorded handoff ack'
    Assert-RefusedKeep $idx 'ACK_CORRELATION' { Send-MockAck $idx $actA $ev @{ target = '/root/other_peer' } } 'ack naming another destination'
    Assert-RefusedKeep $idx 'ACK_CORRELATION' { Send-MockAck $idx $actA $ev @{ intentId = 'intent-other' } } 'ack naming another intent'
    Assert-RefusedKeep $idx 'ACK_CORRELATION' { Send-MockAck $idx $actA $ev @{ tool = 'shell.fake_ack' } } 'ack not from collaboration.followup_task'
    Assert-RefusedKeep $idx 'BAD_VALUE' { Send-MockAck $idx $actA $ev @{ label = 'LIVE' } } 'unknown fixture label'
    $wrong = [pscustomobject]@{ JobId = $actA.JobId; IntentId = $actA.IntentId; IntentRef = $actB.IntentRef; ReviewerTarget = $actA.ReviewerTarget }
    Assert-RefusedKeep $idx 'ACK_CORRELATION' { Send-MockAck $idx $wrong $ev } 'ack pinned to another job intent'
    # One saved (MOCK/NOT_LIVE) response, pinned once, reused for a wrong-ref call and then the correct call.
    $sameTool = Write-Doc 'toolresult-same-response-ca.json' ([ordered]@{ label = 'MOCK/NOT_LIVE'; tool = 'collaboration.followup_task'; target = $actA.ReviewerTarget; intentId = $actA.IntentId; note = 'offline fixture: one saved response reused for both calls' })
    $wrongSame = [pscustomobject]@{ JobId = $actA.JobId; IntentId = $actA.IntentId; IntentRef = $actB.IntentRef; ReviewerTarget = $actA.ReviewerTarget }
    Assert-RefusedKeep $idx 'ACK_CORRELATION' { Submit-SourceJobHandoffResult -IndexPath $idx -Action $wrongSame -ToolResultPath $sameTool.path -ExpectedToolResultSha256 $sameTool.sha256 -EvidenceRoot $ev } 'another job intent ref with the exact pinned response'
    $poisoned = @(Get-ChildItem -LiteralPath (Join-Path $ev 'acks') -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -clike "*$($sameTool.sha256.Substring(0, 12))*" })
    Assert-That ($null -eq (Get-JobRec $idx $ca.JobId)['review']['handoff'] -and $poisoned.Count -eq 0) 'the refused call registered no ACK for A and persisted no immutable ACK file'
    $okSame = Submit-SourceJobHandoffResult -IndexPath $idx -Action $actA -ToolResultPath $sameTool.path -ExpectedToolResultSha256 $sameTool.sha256 -EvidenceRoot $ev
    Assert-That ($okSame.Status -ceq 'APPLIED') "the correct Action with the same pinned response succeeds once (got: $($okSame.Status))"
    $handoffA = (Get-JobRec $idx $ca.JobId)['review']['handoff']
    $ackDoc = Read-Json $handoffA['ackRef']['path']
    Assert-That ($ackDoc['intentRef']['sha256'] -ceq $actA.IntentRef.sha256 -and $handoffA['toolResultRef']['sha256'] -ceq $sameTool.sha256) 'the registered ACK is bound to A intent and to the unchanged pinned response'
    $beforeDup = Get-Sha $idx
    $dupSame = Submit-SourceJobHandoffResult -IndexPath $idx -Action $actA -ToolResultPath $sameTool.path -ExpectedToolResultSha256 $sameTool.sha256 -EvidenceRoot $ev
    Assert-That ($dupSame.Status -ceq 'NOOP_DUPLICATE' -and (Get-Sha $idx) -ceq $beforeDup) 'repeating the identical call is an idempotent no-op'
    Assert-RefusedKeep $idx 'NO_INTENT' { Submit-SourceJobHandoffResult -IndexPath $idx -Action ([pscustomobject]@{ JobId = $cc.JobId; IntentId = $actA.IntentId; IntentRef = $actA.IntentRef; ReviewerTarget = $actA.ReviewerTarget }) -ToolResultPath $sameTool.path -ExpectedToolResultSha256 $sameTool.sha256 -EvidenceRoot $ev } 'an Action for a job with no persisted intent'
    $null = Send-MockAck $idx $actB $ev
    Assert-RefusedKeep $idx 'ACK_EXISTS' { Send-MockAck $idx $actA $ev @{ note = 'a different second response' } } 'a different second response for the same intent'
    $r3 = Invoke-Owner $idx $batch $ev
    $ha = (Get-JobRec $idx $ca.JobId)['review']['handoff']
    Assert-That ($ha['mock'] -eq $true -and $ha['actualHandoffEvidence'] -eq $false -and $ha['proves'] -ceq 'DISPATCH_ONLY_NOT_REVIEW') 'the mock ack is labelled and proves dispatch only'
    Assert-That ((Get-JobRec $idx $ca.JobId)['state'] -ceq 'REVIEW_REQUIRED' -and $r3.Jobs['job-ca'].Reasons -ccontains 'AWAIT_INDEPENDENT_REVIEW:HANDOFF_MOCK_NOT_LIVE') 'a scheduling ack is not a review result'

    # valid exact current wrapper control: every supported root indicator says success
    $sa = New-DispSet $idx $ca 'ca-acc' 'SOURCE_ACCEPTED' @{ resultBody = [ordered]@{ exitCode = 0; failed = 0; raceFailed = 0; result = 'PASS'; status = 'SUCCESS'; overall = 'PASS'; label = 'OFFLINE_FIXTURE_NOT_AN_ACTUAL_CHECK_RESULT' } }
    $null = Import-Set $idx $ca $sa $ev
    $ja = Get-JobRec $idx $ca.JobId
    Assert-That ($ja['state'] -ceq 'SOURCE_REVIEW_ACCEPTED' -and $null -eq $ja['review']['disposition']['sourceHead'] -and $ja['review']['disposition']['scopedMapping']['variant'] -ceq 'SOURCE_ONLY_SCOPED_MAPPING') 'null-head scoped mapping accepts the correct uncommitted reviewed pins'
    Assert-That ($ja['review']['disposition']['evidenceMode'] -ceq 'HANDOFF_MOCK_NOT_LIVE') 'the disposition carries the not-live label of its handoff'
    $r4 = Invoke-Owner $idx $batch $ev
    Assert-That ($r4.Launched.Count -eq 0 -and $r4.Jobs['job-cc'].Reasons -ccontains 'PATH_CONFLICT:job-ca' -and $r4.Jobs['job-cd'].Reasons -ccontains 'UNRESOLVED_DEPENDENCY:job-ca') 'source acceptance alone neither frees paths nor satisfies the dependency'
    Assert-RefusedKeep $idx 'RELEASE_BEFORE_DELIVERY' { Import-Release $idx $ca (New-ReleaseDoc $idx $ca $sa 'ca-early') $ev } 'release before verified delivery'

    $deliveryCases = @(
        @{ Tag = 'd1'; Code = 'SOURCE_HEAD_REQUIRED'; Over = @{} },
        @{ Tag = 'd2'; Code = 'DELIVERY_MISMATCH'; Over = @{ head = $realHead; delivery = @{ head = ('1' * 40) } } },
        @{ Tag = 'd3'; Code = 'DELIVERY_MISMATCH'; Over = @{ head = $realHead; delivery = @{ componentVerdictSha256 = ('a' * 64) } } },
        @{ Tag = 'd4'; Code = 'DELIVERY_CLAIMS'; Over = @{ head = $realHead; delivery = @{ operationalActivation = $true } } },
        @{ Tag = 'd5'; Code = 'DELIVERY_CHECKS'; Over = @{ head = $realHead; delivery = @{ checksConclusion = 'MIXED' } } },
        @{ Tag = 'd6'; Code = 'UNEXPECTED_KEY'; Over = @{ head = $realHead; delivery = @{ normalTypecheck = 'PASS' } } },
        @{ Tag = 'd7'; Code = 'SCOPED_MAPPING_DECISION'; Over = @{ head = $realHead; map = @{ decision = 'SOURCE_REJECTED' } } },
        @{ Tag = 'd8'; Code = 'CANDIDATE_MISMATCH'; Over = @{ head = $realHead; pins = @([ordered]@{ path = $ca.Editable; sha256 = ('9' * 64) }) } },
        @{ Tag = 'd9'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ head = $realHead; resultBody = [ordered]@{ status = 'FAILED' } } }
    )
    foreach ($case in $deliveryCases) {
        $over = $case.Over; $tag = $case.Tag
        Assert-RefusedKeep $idx $case.Code { Import-Set $idx $ca (New-DispSet $idx $ca "ca-$tag" 'DELIVERED' $over) $ev } "delivery refusal $tag"
    }
    Assert-That ((Get-JobRec $idx $ca.JobId)['state'] -ceq 'SOURCE_REVIEW_ACCEPTED') 'refused delivery evidence changed nothing'
    $sd = New-DispSet $idx $ca 'ca-del' 'DELIVERED' @{ head = $realHead }
    $null = Import-Set $idx $ca $sd $ev
    Assert-That ((Get-JobRec $idx $ca.JobId)['state'] -ceq 'DELIVERED_PENDING_RELEASE') 'verified delivery (actual typed PR/head/merge/CI fields, null activation claims) awaits a separate release'
    $r5 = Invoke-Owner $idx $batch $ev
    Assert-That ($r5.Launched.Count -eq 0 -and $r5.Jobs['job-cc'].Reasons -ccontains 'PATH_CONFLICT:job-ca' -and $r5.Jobs['job-cd'].Reasons -ccontains 'UNRESOLVED_DEPENDENCY:job-ca') 'delivered but unreleased still blocks overlap and dependency'
    Assert-RefusedKeep $idx 'RELEASE_PATHS_MISMATCH' { Import-Release $idx $ca (New-ReleaseDoc $idx $ca $sd 'ca-r1' @{ ownedPaths = @((Join-Path $work 'elsewhere')) }) $ev } 'release of other paths'
    Assert-RefusedKeep $idx 'REVIEWER_NOT_INDEPENDENT' { Import-Release $idx $ca (New-ReleaseDoc $idx $ca $sd 'ca-r2' @{ reviewer = '/root/bounded_state_check' }) $ev } 'release reviewed by the owner'
    Assert-RefusedKeep $idx 'RELEASE_LINKAGE' { Import-Release $idx $ca (New-ReleaseDoc $idx $ca $sd 'ca-r3' @{ dispositionRef = $sa.DispRef }) $ev } 'release linked to a superseded disposition'
    $null = Import-Release $idx $ca (New-ReleaseDoc $idx $ca $sd 'ca') $ev
    $ja = Get-JobRec $idx $ca.JobId
    Assert-That ($ja['state'] -ceq 'DELIVERED_RELEASED' -and $ja['notice'] -cmatch 'NOT_FACTORY_COMPLETE') 'DELIVERED_RELEASED is source-only and never Factory completion'
    $r6 = Invoke-Until $idx $batch $ev { param($r) (@(Get-ActionsFor 'job-cc').Count -ge 1) -and (@(Get-ActionsFor 'job-cd').Count -ge 1) }
    Assert-That ((Get-LaunchCount 'job-cc') -eq 1 -and (Get-LaunchCount 'job-cd') -eq 1 -and (Get-LaunchCount 'job-ca') -eq 1) 'after delivery and release the overlap successor and the dependent each start exactly once'
    $r7 = Invoke-Owner $idx $batch $ev
    Assert-That ($r7.Launched.Count -eq 0) 'no further launches on a later pass'

    # ===== 5. strict evidence refusals (job B: REVIEW_REQUIRED with a recorded ack) =====
    $mapDrift = [ordered]@{ path = $cb.PlanPath; sha256 = ('0' * 64) }
    $variants = @(
        @{ Tag = 'v1'; Code = 'UNEXPECTED_KEY'; Over = @{ disp = @{ surprise = 1 } } },
        @{ Tag = 'v2'; Code = 'MISSING_KEY'; Over = @{ dispDrop = @('reviewRef') } },
        @{ Tag = 'v3'; Code = 'BAD_TYPE'; Over = @{ disp = @{ sourceHead = $false } } },
        @{ Tag = 'v4'; Code = 'BAD_VALUE'; Over = @{ disp = @{ kind = 'source_accepted' } } },
        @{ Tag = 'v5'; Code = 'REVIEWER_NOT_INDEPENDENT'; Over = @{ disp = @{ reviewer = '/root/bounded_state_check' } } },
        @{ Tag = 'v6'; Code = 'REVIEWER_NOT_INDEPENDENT'; Over = @{ disp = @{ reviewer = 'session-cb' } } },
        @{ Tag = 'v7'; Code = 'REVIEWER_NOT_INDEPENDENT'; Over = @{ disp = @{ reviewer = '/root' } } },
        @{ Tag = 'v8'; Code = 'TUPLE_MISMATCH'; Over = @{ disp = @{ taskId = 'task-other' } } },
        @{ Tag = 'v9'; Code = 'DUPLICATE_KEY'; Over = @{ dispText = { param($t) $t.Insert($t.IndexOf('{') + 1, '"kind":"FAILED",') } } },
        @{ Tag = 'v10'; Code = 'UNEXPECTED_KEY'; Over = @{ dispText = { param($t) $t -replace '"kind"', '"Kind"' } } },
        @{ Tag = 'v11'; Code = 'DISPOSITION_ADMISSION_MISMATCH'; Over = @{ adm = @{ sourceHead = ('1' * 40) } } },
        @{ Tag = 'v12'; Code = 'DISPOSITION_ADMISSION_DECISION'; Over = @{ adm = @{ decision = 'ADMIT' } } },
        @{ Tag = 'v13'; Code = 'REVIEWER_NOT_INDEPENDENT'; Over = @{ adm = @{ reviewer = '/root/bounded_state_check' } } },
        @{ Tag = 'v14'; Code = 'SCOPED_MAPPING_SCOPE'; Over = @{ map = @{ scope = 'SOURCE_ONLY' } } },
        @{ Tag = 'v15'; Code = 'SCOPED_MAPPING_DECISION'; Over = @{ map = @{ decision = 'SOURCE_REJECTED' } } },
        @{ Tag = 'v16'; Code = 'UNEXPECTED_KEY'; Over = @{ map = @{ surprise = 1 } } },
        @{ Tag = 'v17'; Code = 'SCOPED_MAPPING_MISMATCH'; Over = @{ map = @{ sourceHead = ('2' * 40) } } },
        @{ Tag = 'v18'; Code = 'EMPTY_LIST'; Over = @{ map = @{ resultRefs = @() } } },
        @{ Tag = 'v19'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ failedChecks = 1 } },
        @{ Tag = 'v20'; Code = 'HASH_DRIFT'; Over = @{ map = @{ originalReviewRef = $mapDrift } } },
        @{ Tag = 'v21'; Code = 'CANDIDATE_MISMATCH'; Over = @{ pins = @([ordered]@{ path = $cb.Editable; sha256 = ('9' * 64) }) } },
        # typed verdict extraction on the result wrapper root (actual source-mapping negatives)
        @{ Tag = 'w1'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ resultBody = [ordered]@{ exitCode = 1 } } },
        @{ Tag = 'w2'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ resultBody = [ordered]@{ status = 'FAIL' } } },
        @{ Tag = 'w3'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ resultBody = [ordered]@{ overall = 'FAILED' } } },
        @{ Tag = 'w4'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ resultBody = [ordered]@{ result = 'NA' } } },
        @{ Tag = 'w5'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ resultBody = [ordered]@{ status = 'NOT_EXECUTED' } } },
        @{ Tag = 'w6'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ resultBody = [ordered]@{ raceFailed = 2 } } },
        @{ Tag = 'w7'; Code = 'SCOPED_MAPPING_RESULT_MALFORMED'; Over = @{ resultBody = [ordered]@{ exitCode = '0' } } },
        @{ Tag = 'w8'; Code = 'SCOPED_MAPPING_RESULT_MALFORMED'; Over = @{ resultBody = [ordered]@{ failed = -1 } } },
        @{ Tag = 'w9'; Code = 'SCOPED_MAPPING_RESULT_MALFORMED'; Over = @{ resultBody = [ordered]@{ failed = '0' } } },
        @{ Tag = 'w10'; Code = 'SCOPED_MAPPING_RESULT_MALFORMED'; Over = @{ resultBody = [ordered]@{ failed = @(0) } } },
        @{ Tag = 'w11'; Code = 'SCOPED_MAPPING_RESULT_MALFORMED'; Over = @{ resultBody = [ordered]@{ status = $true } } },
        @{ Tag = 'w12'; Code = 'SCOPED_MAPPING_RESULT_CONFLICT'; Over = @{ resultBody = [ordered]@{ exitCode = 0; status = 'FAIL' } } },
        @{ Tag = 'w13'; Code = 'SCOPED_MAPPING_RESULT_UNSUPPORTED'; Over = @{ resultBody = [ordered]@{ status = 'UNKNOWN' } } },
        @{ Tag = 'w14'; Code = 'SCOPED_MAPPING_RESULT_UNSUPPORTED'; Over = @{ resultBody = [ordered]@{ status = 'pass' } } },
        @{ Tag = 'w15'; Code = 'SCOPED_MAPPING_RESULT_UNSUPPORTED'; Over = @{ resultBody = [ordered]@{ label = 'no supported verdict indicator'; passed = 3 } } },
        @{ Tag = 'w16'; Code = 'SCOPED_MAPPING_RESULT_FAILED'; Over = @{ originalBody = [ordered]@{ status = 'FAILED' } } }
    )
    foreach ($variant in $variants) {
        $over = $variant.Over; $tag = $variant.Tag
        Assert-RefusedKeep $idx $variant.Code { Import-Set $idx $cb (New-DispSet $idx $cb "cb-$tag" 'SOURCE_ACCEPTED' $over) $ev } "strict evidence refusal $tag ($($variant.Code))"
    }
    [IO.File]::WriteAllText($cb.Editable, 'tampered')
    Assert-RefusedKeep $idx 'CANDIDATE_DRIFT' { Import-Set $idx $cb (New-DispSet $idx $cb 'cb-drift' 'SOURCE_ACCEPTED') $ev } 'mutable candidate drift is caught under the lease'
    [IO.File]::WriteAllText($cb.Editable, 'candidate-cb')
    Assert-That ((Get-JobRec $idx $cb.JobId)['state'] -ceq 'REVIEW_REQUIRED') 'refusals left B at REVIEW_REQUIRED'
    $goodRej = New-DispSet $idx $cb 'cb-rej' 'SOURCE_REJECTED' @{ failedChecks = 2 }
    $held = [IO.File]::Open("$idx.lease", 'OpenOrCreate', 'ReadWrite', 'None')
    try { Assert-RefusedKeep $idx 'LEASE_BUSY' { Import-Set $idx $cb $goodRej $ev } 'held lease' } finally { $held.Dispose() }
    $originalReplace = ${function:Invoke-SjqReplace}
    Set-Item -Path function:Invoke-SjqReplace -Value { param($TempPath, $IndexPath) throw 'simulated replace failure' }
    try { Assert-RefusedKeep $idx 'WRITE_FAILED' { Import-Set $idx $cb $goodRej $ev } 'failed atomic replacement' }
    finally { Set-Item -Path function:Invoke-SjqReplace -Value $originalReplace }
    Assert-That (@(Get-ChildItem -LiteralPath $work -Filter 'chain.index.json.*.tmp').Count -eq 0) 'no temp file is left behind'
    $null = Import-Set $idx $cb $goodRej $ev
    Assert-That ((Get-JobRec $idx $cb.JobId)['state'] -ceq 'SOURCE_REJECTED') 'after the failures the lock is usable and the rejection records once'
    $null = Import-Release $idx $cb (New-ReleaseDoc $idx $cb $goodRej 'cb') $ev
    Assert-That ((Get-JobRec $idx $cb.JobId)['state'] -ceq 'RELEASED_FAILED') 'a rejected source releases as RELEASED_FAILED'
    foreach ($fx in $ca, $cb) {
        $terminal = (Get-JobRec $idx $fx.JobId)['terminal']['ref']
        Assert-That ($terminal['sha256'] -ceq (Get-Sha $terminal['path'])) "$($fx.JobId): immutable terminal evidence is untouched by review, delivery and release"
    }
    Assert-That ((ConvertTo-SjqCanonical (Get-Queue $idx)) -cnotmatch '"(DONE|ACCEPTED|accepted|reviewAccepted)"' -and (ConvertTo-SjqCanonical (Get-Queue $idx)) -cnotmatch '"factoryClaim":true') 'chain queue records no DONE/accepted marker or Factory claim'

    # ===== 3. separate-process restart boundaries =====
    $idx = New-IndexCopy 'restart'; $ev = Join-Path $work 'ev-restart'
    $rr1 = New-JobFixture 'r1' 1 -Behavior @{ crashAfter = 'consume' }
    $rr2 = New-JobFixture 'r2' 2 -Behavior @{ sleepMs = 3000 }
    foreach ($x in $rr1, $rr2) { $null = Register-Job $idx $x }
    $usage = New-Usage 'restart-ok' 30 1800 10 20
    $batch = @($rr1, $rr2 | ForEach-Object { New-Entry $_ $usage })
    $d1 = Wait-Driver (Start-Driver $idx $batch $ev @('/root/git_delivery_audit') $false 'rs1')
    Assert-That ($d1.ExitCode -eq 0 -and $d1.Result['Launched'].Count -eq 2) "first owner process launched each job once (exit $($d1.ExitCode) $($d1.Err))"
    Assert-That (Wait-File (Join-Path $rr2.Run 'terminal.json')) 'r2 terminal evidence exists on disk'
    $j1 = Get-JobRec $idx $rr1.JobId
    Assert-That ($j1['state'] -ceq 'DISPATCH_UNCERTAIN' -and $j1['reservation']['consumed'] -eq $true -and -not [IO.Directory]::Exists($rr1.Run)) 'consume-before-start crash: consumed, uncertain, no run directory, no start'
    Assert-That ((Get-JobRec $idx $rr2.JobId)['state'] -cne 'REVIEW_REQUIRED') 'start/terminal evidence exists before the index has seen the terminal'
    $dA = Start-Driver $idx $batch $ev @('/root/git_delivery_audit') $false 'rs2'
    $dB = Start-Driver $idx $batch $ev @('/root/git_delivery_audit') $false 'rs3'
    $wa = Wait-Driver $dA; $wb = Wait-Driver $dB
    Assert-That ($wa.ExitCode -eq 0 -and $wb.ExitCode -eq 0) "both restarted owner processes completed (errors: $($wa.Err) $($wb.Err))"
    $allActions = @($d1.Result['Actions']) + @($wa.Result['Actions']) + @($wb.Result['Actions'])
    Assert-That (@($allActions | Where-Object { $_['JobId'] -ceq 'job-r2' }).Count -eq 1) 'exactly one review handoff action for r2 across racing owner processes'
    Assert-That ($wa.Result['Launched'].Count -eq 0 -and $wb.Result['Launched'].Count -eq 0) 'restarted owners launch nothing: zero duplicate source starts'
    $jq = Get-Queue $idx
    Assert-That ($jq['jobs']['job-r2']['state'] -ceq 'REVIEW_REQUIRED' -and $null -ne $jq['jobs']['job-r2']['review']['intent']) 'r2 reconciled once to REVIEW_REQUIRED with one persisted intent'
    Assert-That (@($jq['events'].Keys | Where-Object { $_ -clike 'evt-start-job-r2-*' }).Count -le 1 -and @($jq['events'].Keys | Where-Object { $_ -clike 'evt-term-job-r2-*' }).Count -eq 1) 'start/terminal events were applied at most once and exactly once respectively'
    Assert-That (@(Get-ChildItem -LiteralPath (Join-Path $ev 'intents') -Filter '*.json').Count -eq 1 -and @(Get-ChildItem -LiteralPath $rr2.Run -Filter 'invocation.json').Count -eq 1) 'one intent record and one invocation record'
    Assert-That ((Get-JobRec $idx $rr1.JobId)['state'] -ceq 'DISPATCH_UNCERTAIN' -and -not [IO.Directory]::Exists($rr1.Run)) 'r1 stays uncertain and is never started again'
    $before = Get-Sha $idx
    $w4 = Wait-Driver (Start-Driver $idx $batch $ev @('/root/git_delivery_audit') $false 'rs4')
    Assert-That ($w4.Result['Status'] -ceq 'QUIESCENT_ACTIONABLE' -and $w4.Result['Actions'].Count -eq 0 -and $w4.Result['Launched'].Count -eq 0 -and (Get-Sha $idx) -ceq $before) 'tool-dispatch-before-ack boundary: a fresh owner resends nothing, launches nothing and does not churn the index'
    Assert-That ($w4.Result['Jobs']['job-r2']['Next'] -ceq 'RECONCILE_HANDOFF_EVIDENCE' -and $w4.Result['Jobs']['job-r1']['Next'] -ceq 'AWAIT_START_EVIDENCE') 'both uncertainties are actionable with a named next step'
    $actionR2 = @($allActions | Where-Object { $_['JobId'] -ceq 'job-r2' })[0]
    $null = Send-MockAck $idx $actionR2 $ev
    Assert-That ($null -ne (Get-JobRec $idx $rr2.JobId)['review']['handoff']) 'explicit tool/recipient evidence (a labelled mock here) reconciles the same intent'
    $dupSession = New-JobFixture 'r3' 3 -Session 'session-r2'
    Assert-RefusedKeep $idx 'DUPLICATE_RUN_IDENTITY' { Register-Job $idx $dupSession } 'same-session identity guard'
    $planHistory = (Get-JobRec $idx $rr2.JobId)['plan']['history']
    Assert-That ((ConvertTo-SjqCanonical $planHistory) -ceq '["prior-refusal-1"]') 'registered history is preserved'

    # ===== 4. account gate: weekly 75 / session-backend exhaustion stops ALL new launches, evidence keeps advancing =====
    function Get-Gate($Usages) { Get-SjoAccountGate @($Usages | ForEach-Object { [ordered]@{ jobId = 'x'; runDirectory = $work; usageRef = $_ } }) ([DateTimeOffset]::UtcNow) }
    Assert-That ((Get-Gate @((New-Usage 'g1' 10 600 74 99))).State -ceq 'AVAILABLE') 'week 74 / session 99 is not a stop (no session-75 rule)'
    Assert-That ((Get-Gate @((New-Usage 'g2' 10 600 75 10))).Reason -ceq 'WEEKLY_AT_OR_ABOVE_75') 'weekly 75 stops'
    Assert-That ((Get-Gate @((New-Usage 'g3' 10 600 10 100))).Reason -ceq 'SESSION_BACKEND_EXHAUSTED') 'session/backend at 100 stops'
    Assert-That ((Get-Gate @((New-Usage 'g4' 10 600 10 10 'ON'))).Reason -ceq 'PAID_NOT_OFF') 'credits not OFF stops (no paid fallback)'
    Assert-That ((Get-Gate @((New-Usage 'g5a' 600 3000 10 10), (New-Usage 'g5b' 60 3000 90 10))).State -ceq 'EXHAUSTED') 'an older READY packet cannot override a newer exhausted observation'
    Assert-That ((Get-Gate @((New-Usage 'g6a' 300 3000 90 10), (New-Usage 'g6b' 30 3000 10 10))).State -ceq 'AVAILABLE') 'a strictly newer fresh available observation is the genuine reset'
    Assert-That ((Get-Gate @((New-Usage 'g7' 900 -10 10 10))).State -ceq 'REFRESH_NEEDED') 'an expired packet is not availability'
    Assert-That ((Get-Gate @((New-Usage 'g8a' 1000 3000 90 10), (New-Usage 'g8b' 900 -10 10 10))).State -ceq 'EXHAUSTED') 'an advertised or expired reset does not lift a known stop'
    Assert-That ((Get-Gate @()).State -ceq 'REFRESH_NEEDED') 'no account evidence needs an explicit refresh, never an inferred pool'

    $idx = New-IndexCopy 'gate'; $ev = Join-Path $work 'ev-gate'
    $script:Actions.Clear(); $script:LaunchLog.Clear()
    $q3 = New-JobFixture 'q3' 1; $q1 = New-JobFixture 'q1' 2; $q2 = New-JobFixture 'q2' 3
    foreach ($x in $q3, $q1, $q2) { $null = Register-Job $idx $x }
    $okA = New-Usage 'gate-ok' 30 1800 10 20
    $s1 = Invoke-Owner $idx @((New-Entry $q3 $okA)) $ev
    Assert-That ($s1.Launched.Count -eq 1) 'q3 launched while the account was available'
    Assert-That (Wait-File (Join-Path $q3.Run 'terminal.json')) 'q3 finished'
    $exh = New-Usage 'gate-exh' 120 1800 80 30
    $old = New-Usage 'gate-old' 600 3000 10 20
    $s2 = Invoke-Owner $idx @((New-Entry $q3 $old), (New-Entry $q1 $old), (New-Entry $q2 $exh)) $ev
    Assert-That ($s2.Launched.Count -eq 0 -and $s2.LaunchesStopped -eq $true -and (Get-LaunchCount 'job-q1') -eq 0 -and (Get-LaunchCount 'job-q2') -eq 0) 'known exhaustion gates every new launch in the batch'
    Assert-That ($s2.Jobs['job-q1'].Next -ceq 'NO_NEW_LAUNCH_ACCOUNT_STOP' -and $s2.Jobs['job-q1'].Reasons[0] -clike 'ACCOUNT_GATE:EXHAUSTED:WEEKLY_AT_OR_ABOVE_75*') 'the stop is a named, actionable reason per job'
    Assert-That ((Get-JobRec $idx $q3.JobId)['state'] -ceq 'REVIEW_REQUIRED' -and @(Get-ActionsFor 'job-q3').Count -eq 1) 'evidence reconciliation and the review handoff still advance while launches are stopped'
    $okNew = New-Usage 'gate-new' 10 1800 60 90
    $s3 = Invoke-Until $idx @((New-Entry $q1 $okNew), (New-Entry $q2 $exh)) $ev { param($r) @(Get-ActionsFor 'job-q1').Count -ge 1 }
    Assert-That ((Get-LaunchCount 'job-q1') -eq 1 -and (Get-LaunchCount 'job-q2') -eq 0) 'a genuine newer available observation (session 90, week 60) reopens launches for the eligible job only'
    Assert-That ((Get-JobRec $idx $q2.JobId)['state'] -ceq 'SOURCE_PREPARED' -and $s3.Jobs['job-q2'].Reasons -ccontains 'PREPARE_OR_REFRESH:USAGE_PACKET_ACCOUNT_STOP') 'a job whose own packet records the stop is never launched with it'

    # ===== 4b. everything blocked: quiet, persisted, actionable, no model/quota activity =====
    $idx = New-IndexCopy 'blocked'; $ev = Join-Path $work 'ev-blocked'
    $z1 = New-JobFixture 'z1' 1 -Behavior @{ exitCode = 3 }
    $z2 = New-JobFixture 'z2' 2 -Deps @('job-ghost')
    $z3 = New-JobFixture 'z3' 3
    foreach ($x in $z1, $z2, $z3) { $null = Register-Job $idx $x }
    $okZ = New-Usage 'blocked-ok' 30 1800 10 20
    $bz = @((New-Entry $z1 $okZ), (New-Entry $z2 $okZ), (New-Entry $z3 $null))
    $rz = Invoke-Until $idx $bz $ev { param($r) $r.Jobs['job-z1'].State -ceq 'FAILED' -and $r.Jobs['job-z1'].Reasons -ccontains 'REVIEWER_UNAVAILABLE' } @()
    $launcherFiles = @(Get-ChildItem -LiteralPath (Join-Path $ev 'launcher') -File).Count
    $before = Get-Sha $idx
    $rq1 = Invoke-Owner $idx $bz $ev @()
    $rq2 = Invoke-Owner $idx $bz $ev @()
    Assert-That ($rq1.Status -ceq 'QUIESCENT_ACTIONABLE' -and $rq1.Launched.Count -eq 0 -and $rq1.Actions.Count -eq 0 -and $rq2.Launched.Count -eq 0) 'all-blocked batch is quiet: no launch, no action'
    Assert-That ((Get-Sha $idx) -ceq $before -and $rq1.Checkpoint['sha256'] -ceq $rq2.Checkpoint['sha256'] -and @(Get-ChildItem -LiteralPath (Join-Path $ev 'launcher') -File).Count -eq $launcherFiles) 'repeating the quiet pass causes no index churn, no new checkpoint and no launcher activity'
    Assert-That ($rq1.Jobs['job-z1'].Next -ceq 'REVIEWER_UNAVAILABLE' -and $rq1.Jobs['job-z2'].Reasons -ccontains 'UNRESOLVED_DEPENDENCY:job-ghost' -and $rq1.Jobs['job-z3'].Next -ceq 'PREPARE_OR_REFRESH') 'each blocked job carries its own reason and next step'
    $checkpoint = Read-Json $rq1.Checkpoint['path']
    Assert-That ($checkpoint['jobs']['job-z1']['State'] -ceq 'FAILED' -and $checkpoint['note'] -cmatch 'NOT_RUNTIME_AUTHORITY') 'the per-job reasons are persisted as a non-authoritative checkpoint'
    Assert-That ((Get-JobRec $idx $z1.JobId)['state'] -ceq 'FAILED' -and (Get-LaunchCount 'job-z1') -eq 1) 'the failed job is not retried and not hidden'

    # ===== 4c. the gate is re-evaluated at every actual attempt (test-scope clock seam only) =====
    $originalClock = ${function:Get-SjoLaunchClockUtc}
    $idx = New-IndexCopy 'fresh'; $ev = Join-Path $work 'ev-fresh'
    $script:Actions.Clear(); $script:LaunchLog.Clear()
    $t1 = New-JobFixture 't1' 1; $t2 = New-JobFixture 't2' 2
    foreach ($x in $t1, $t2) { $null = Register-Job $idx $x }
    $short = New-Usage 'fresh-short' 30 120 10 20
    $script:ClockIndex = $idx
    Set-Item -Path function:Get-SjoLaunchClockUtc -Value {
        $consumed = $false
        try {
            $q = Get-Queue $script:ClockIndex
            $res = $q['jobs']['job-t1']['reservation']
            $consumed = ($res -is [hashtable]) -and $res.ContainsKey('consumed')
        }
        catch { $consumed = $false }
        if ($consumed) { [DateTime]::UtcNow.AddHours(2).ToString('o') } else { [DateTime]::UtcNow.ToString('o') }
    }
    try { $rf = Invoke-Owner $idx @((New-Entry $t1 $short), (New-Entry $t2 $short)) $ev }
    finally { Set-Item -Path function:Get-SjoLaunchClockUtc -Value $originalClock }
    Assert-That ($rf.Launched.Count -eq 1 -and (Get-LaunchCount 'job-t1') -eq 1 -and (Get-LaunchCount 'job-t2') -eq 0) 'the first attempt used the valid packet; the later attempt saw the expiry and launched nothing'
    $j2 = Get-JobRec $idx $t2.JobId
    Assert-That ($j2['state'] -ceq 'SOURCE_PREPARED' -and $null -eq $j2['reservation'] -and -not [IO.Directory]::Exists($t2.Run)) 'the blocked candidate was neither reserved nor consumed nor started'
    Assert-That (@($rf.Jobs['job-t2'].Reasons | Where-Object { $_ -cmatch '^(LAUNCH|ACCOUNT)_GATE:' }).Count -ge 1) 'an actionable gate reason is recorded for the blocked candidate'
    $null = Invoke-Until $idx @((New-Entry $t1 $short)) $ev { param($r) @(Get-ActionsFor 'job-t1').Count -ge 1 }
    Assert-That ((Get-JobRec $idx $t1.JobId)['state'] -ceq 'REVIEW_REQUIRED') 'evidence and review still advance for the job that did launch'

    $conflictLog = Join-Path $work 'conflict-invocations.txt'
    $conflictLauncher = Join-Path $work 'fixture-launcher-conflict.ps1'
    [IO.File]::WriteAllText($conflictLauncher, @'
param([string]$IndexPath, [long]$ExpectedVersion, [string]$JobId, [string]$ReservationId, [string]$PlanPath, [string]$ExpectedPlanSha256, [string]$AdmissionPath, [string]$ExpectedAdmissionSha256, [string]$UsagePath, [string]$ExpectedUsageSha256)
[IO.File]::AppendAllText('__LOG__', "$JobId`n")
[Console]::Error.WriteLine('SJQ_REFUSED:VERSION_CONFLICT:simulated stale version before consume')
exit 1
'@.Replace('__LOG__', $conflictLog))
    $idx = New-IndexCopy 'conflict'; $ev = Join-Path $work 'ev-conflict'
    $script:LaunchLog.Clear()
    $v1 = New-JobFixture 'v1' 1
    $null = Register-Job $idx $v1
    $shortV = New-Usage 'conflict-short' 30 120 10 20
    $script:ClockLog = $conflictLog
    Set-Item -Path function:Get-SjoLaunchClockUtc -Value {
        $invoked = [IO.File]::Exists($script:ClockLog) -and ((Get-Item -LiteralPath $script:ClockLog).Length -gt 0)
        if ($invoked) { [DateTime]::UtcNow.AddHours(2).ToString('o') } else { [DateTime]::UtcNow.ToString('o') }
    }
    try {
        $rv = Invoke-SourceJobOwnerStep -IndexPath $idx -Batch @((New-Entry $v1 $shortV)) -EvidenceRoot $ev -LauncherPath $conflictLauncher -ExpectedLauncherSha256 (Get-Sha $conflictLauncher) -ReviewerTargets @('/root/git_delivery_audit')
    }
    finally { Set-Item -Path function:Get-SjoLaunchClockUtc -Value $originalClock }
    Assert-That (@(Get-Content -LiteralPath $conflictLog).Count -eq 1 -and $rv.Launched.Count -eq 1) 'the VERSION_CONFLICT retry was fresh-checked against the expired packet: the launcher ran exactly once'
    $jv = Get-JobRec $idx $v1.JobId
    Assert-That ($jv['state'] -ceq 'DISPATCH_UNCERTAIN' -and $jv['reservation'] -is [hashtable] -and -not $jv['reservation'].ContainsKey('consumed') -and -not [IO.Directory]::Exists($v1.Run)) 'the existing reservation stays safely unconsumed and uncertain: nothing reset or reissued'
    Assert-That (@($rv.Jobs['job-v1'].Reasons | Where-Object { $_ -cmatch '^(LAUNCH|ACCOUNT)_GATE:' }).Count -ge 1) 'the block is an actionable reason'
    $null = Invoke-Until $idx @((New-Entry $v1 $shortV)) $ev { param($r) @(Get-ActionsFor 'job-v1').Count -ge 1 }
    Assert-That ((Get-LaunchCount 'job-v1') -eq 1 -and (Get-JobRec $idx $v1.JobId)['state'] -ceq 'REVIEW_REQUIRED') 'with a fresh packet the same reservation is launched once through the real stand-in'

    # ===== 4d. single-result contract after real children complete and their async stdout/stderr drains retire =====
    $idx = New-IndexCopy 'single'; $ev = Join-Path $work 'ev-single'
    $u1 = New-JobFixture 'u1' 1; $u2 = New-JobFixture 'u2' 2
    foreach ($x in $u1, $u2) { $null = Register-Job $idx $x }
    $usageU = New-Usage 'single-ok' 30 1800 10 20
    $batchU = @((New-Entry $u1 $usageU), (New-Entry $u2 $usageU))
    $everySingle = $true; $lastU = $null; $calls = 0
    for ($i = 0; $i -lt 8; $i++) {
        # Public output captured as an array: exactly one intended result per call, never a drain Task result alongside it.
        $outU = @(Invoke-SourceJobOwnerStep -IndexPath $idx -Batch $batchU -EvidenceRoot $ev -LauncherPath $launcherPath -ExpectedLauncherSha256 $launcherSha -ReviewerTargets @('/root/git_delivery_audit') -AwaitRunning)
        $calls++
        if ($outU.Count -ne 1) { $everySingle = $false; break }
        $lastU = $outU[0]
        if ((Get-JobRec $idx $u1.JobId)['state'] -ceq 'REVIEW_REQUIRED' -and (Get-JobRec $idx $u2.JobId)['state'] -ceq 'REVIEW_REQUIRED' -and @($lastU.Actions).Count -ge 0 -and $i -ge 1) { break }
    }
    Assert-That $everySingle "every public Invoke-SourceJobOwnerStep call returned exactly one result (calls: $calls)"
    Assert-That ($null -ne $lastU -and $lastU.GetType().Name -cne 'VoidTaskResult' -and $null -ne $lastU.Status -and $null -ne $lastU.Jobs -and $null -ne $lastU.Checkpoint -and $null -ne $lastU.Actions) 'the single result carries Status/Jobs/Checkpoint/Actions and no property-missing failure'
    Assert-That ((Get-JobRec $idx $u1.JobId)['state'] -ceq 'REVIEW_REQUIRED' -and (Get-JobRec $idx $u2.JobId)['state'] -ceq 'REVIEW_REQUIRED') 'both real children completed, were retired and reconciled within the same sustained batch'
    Assert-That ($null -eq (Get-JobRec $idx $u1.JobId)['review']['handoff'] -and $lastU.Status -cin @('ACTIONS_PENDING', 'QUIESCENT_ACTIONABLE')) 'no ack was fabricated: the handoffs remain pending, mock or live'

    # ===== 6. batch and launcher strictness =====
    $idx = New-IndexCopy 'strict'; $ev = Join-Path $work 'ev-strict'
    $s1x = New-JobFixture 's1' 1
    $null = Register-Job $idx $s1x
    $okS = New-Usage 'strict-ok' 30 1800 10 20
    $good = New-Entry $s1x $okS
    $beforeStrict = Get-Sha $idx
    Assert-Refused 'BATCH_RUN_DIRECTORY_MISMATCH' { Invoke-Owner $idx @([ordered]@{ jobId = $s1x.JobId; runDirectory = (Join-Path $work 'runs\elsewhere'); usageRef = $okS }) $ev } 'only the registered run directory is accepted'
    Assert-Refused 'UNEXPECTED_KEY' { Invoke-Owner $idx @([ordered]@{ jobId = $s1x.JobId; runDirectory = $s1x.Run; usageRef = $okS; extra = 1 }) $ev } 'batch entry with an extra key'
    Assert-Refused 'DUPLICATE_ITEM' { Invoke-Owner $idx @($good, $good) $ev } 'duplicate job in a batch'
    Assert-Refused 'HASH_DRIFT' { Invoke-SourceJobOwnerStep -IndexPath $idx -Batch @($good) -EvidenceRoot $ev -LauncherPath $launcherPath -ExpectedLauncherSha256 ('0' * 64) } 'launcher bytes must match the pin'
    Assert-That ((Get-Sha $idx) -ceq $beforeStrict -and -not [IO.Directory]::Exists($s1x.Run)) 'refusals changed nothing and started nothing'

    # ===== static surface =====
    $ownerSource = Get-Content -LiteralPath $ownerPath -Raw
    Assert-That ($ownerSource -cnotmatch 'Invoke-Expression|\biex\b|FileSystemWatcher|Register-ScheduledTask|Start-Job|Invoke-RestMethod|Invoke-WebRequest|\.Kill\(|Stop-Process') 'owner has no dynamic-code, watcher, scheduler, network or kill surface'
    Assert-That ((Get-Content -LiteralPath $corePath -Raw) -cnotmatch "'(DONE|ACCEPTED)'") 'core never writes a DONE/ACCEPTED state'
    Write-Host 'NOTE: all tool acknowledgments in this harness are MOCK/NOT_LIVE fixtures; an actual collaboration.followup_task handoff is a separate observed live integration.'
}
catch {
    # A hard stop is reported honestly: everything after it was NOT executed, and the run is nonzero.
    $script:Failures++
    $message = $_.Exception.Message
    if ($message.Length -gt 1500) { $message = $message.Substring(0, 1500) }
    Write-Host "STOPPED: $message"
    Write-Host 'MASKED/NOT_EXECUTED: every owner group after the stopping point did not run and is not passed.'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "source-job-owner tests: passed=$script:Passed failed=$script:Failures"
if ($script:Failures -gt 0) { exit 1 }
