# Offline harness for scripts/orchestration/invoke-supervised-source-job.ps1.
# Run: pwsh -NoProfile -File tests/orchestration/supervised-source-job.tests.ps1
# Real durable queue operations (scripts/orchestration/source-job-queue.ps1) on private index copies,
# real launcher guards, and a real child process that is an ordinary local pwsh running a fixed
# script. It never starts Claude or any model, never reaches the network and never touches a live
# index. Separate pwsh processes dot-source the launcher and replace ONLY its dependency boundaries
# (Authenticode check, claude command lookup, and a crash point); the production launcher exposes
# no test mode, skip switch or dynamic-script parameter.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$launcher = [IO.Path]::GetFullPath((Join-Path $repo 'scripts/orchestration/invoke-supervised-source-job.ps1'))
$corePath = [IO.Path]::GetFullPath((Join-Path $repo 'scripts/orchestration/source-job-queue.ps1'))
. $corePath
$pwsh = (Get-Process -Id $PID).Path

$script:Passed = 0
$script:Failures = 0
function Assert-That([bool]$Condition, [string]$Message) {
    if ($Condition) { $script:Passed++ } else { $script:Failures++; Write-Host "FAIL: $Message" }
}

$work = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('ssj-' + [guid]::NewGuid().ToString('N'))))
[void][IO.Directory]::CreateDirectory($work)

# ---------- helpers ----------

function Get-Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Text([string]$Path, [string]$Text) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function Write-Json([string]$Path, $Object) { Write-Text $Path (ConvertTo-Json -InputObject $Object -Depth 20) }
function Get-Ref([string]$Path) { [ordered]@{ path = $Path; sha256 = (Get-Sha $Path) } }
function Get-UtcText([double]$Hours) { [DateTime]::UtcNow.AddHours($Hours).ToString('o') }
function Get-Opt([hashtable]$Opt, [string]$Key, $Default) { if ($Opt.ContainsKey($Key)) { $Opt[$Key] } else { $Default } }

function Read-Root([string]$Index) { Get-Content -LiteralPath $Index -Raw | ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String }
function Get-QueueOrNull([string]$Index) {
    $registry = (Read-Root $Index)['controllerTaskRegistry']
    if ($registry.ContainsKey('sourceOnlyJobQueue')) { $registry['sourceOnlyJobQueue'] } else { $null }
}
function Get-Ver([string]$Index) { $q = Get-QueueOrNull $Index; if ($null -eq $q) { 0 } else { [long]$q['version'] } }
function Get-Job([string]$Index, [string]$JobId) { (Get-QueueOrNull $Index)['jobs'][$JobId] }
function Test-Consumed($Job) { (Test-SjqHasKey $Job['reservation'] 'consumed') -and ($Job['reservation']['consumed'] -eq $true) }
function Get-Starts($Fx) { @(Get-ChildItem -LiteralPath $Fx.Markers -File -ErrorAction SilentlyContinue).Count }

function Send-Event([string]$Index, $Evt, [string]$At) {
    $path = Join-Path (Join-Path $work 'events') "$($Evt.eventId).json"
    Write-Json $path $Evt
    Invoke-SourceJobQueueEvent -IndexPath $Index -ExpectedVersion (Get-Ver $Index) -EventPath $path -ExpectedEventSha256 (Get-Sha $path) -AtUtc $At
}

# A registered, reserved job whose plan, admission, usage receipt and pins are all valid for the real launcher.
function New-LaunchFixture([string]$Name, [hashtable]$Opt = @{}) {
    $root = Join-Path $work $Name
    $owned = Join-Path $root 'owned'
    $markers = Join-Path $root 'markers'
    $qualDir = Join-Path $root 'qual'
    foreach ($dir in $owned, $markers, $qualDir) { [void][IO.Directory]::CreateDirectory($dir) }
    $editable = Join-Path $owned 'target.ps1'
    $protectedFile = Join-Path $root 'protected.txt'
    $claudeStub = Join-Path $root 'claude.ps1'
    $validator = Join-Path $root 'usage-validator.ps1'
    $payload = Join-Path $root 'payload.txt'
    $run = Join-Path $root 'run'
    $index = Join-Path $root 'index.json'
    Write-Text $editable "# editable $Name`n"
    Write-Text $protectedFile "protected $Name`n"
    Write-Text $claudeStub "# claude stub $Name`n"
    Write-Text $payload "payload $Name"
    Write-Text $validator @'
function Assert-HGReceipt($Receipt, [DateTimeOffset]$NowUtc) {
    if ($NowUtc -ge [DateTimeOffset]::Parse($Receipt.expiresAtUtc)) { throw 'RECEIPT_STALE' }
    return [ordered]@{ account = 'fixture' }
}
'@
    Write-Json (Join-Path $qualDir 'qualification.json') ([ordered]@{ nativePath = $pwsh; nativeSha256 = (Get-Sha $pwsh) })
    Write-Json (Join-Path $qualDir 'fresh-settings-inventory.json') ([ordered]@{ sources = @() })
    Write-Json $index ([ordered]@{ controllerTaskRegistry = [ordered]@{ legacy = 'x' } })

    $usagePath = Join-Path $root 'usage.json'
    Write-Json $usagePath ([ordered]@{
            capturedAtUtc = (Get-UtcText (-0.1)); expiresAtUtc = [DateTime]::UtcNow.AddMinutes([double](Get-Opt $Opt 'UsageMinutes' 30.0)).ToString('o')
            accountUsage = [ordered]@{ weekAllModelsUsedPercent = [int](Get-Opt $Opt 'WeekPct' 10) }
            resolvedCommand = [ordered]@{ fileContentSha256 = (Get-Sha $claudeStub) }
        })

    # The child is an ordinary local pwsh: it drains stdin, leaves one marker file per start, writes fixed raw output and exits 0.
    $childScript = '$null = [Console]::In.ReadToEnd(); [IO.File]::WriteAllText((Join-Path ''{0}'' ([guid]::NewGuid().ToString(''N''))), ''x''); [Console]::Out.Write(''child-out''); [Console]::Error.Write(''child-err''); exit 0' -f $markers
    $protectedPins = @([ordered]@{ path = $protectedFile; sha256 = (Get-Sha $protectedFile) })
    if (-not (Get-Opt $Opt 'DropValidatorPin' $false)) { $protectedPins += [ordered]@{ path = $validator; sha256 = (Get-Sha $validator) } }
    $planPath = Join-Path $root 'plan.json'
    Write-Json $planPath ([ordered]@{
            schema = 'SupervisedCodeSourceOnlyTask/v1'; taskId = "task-$Name"; sessionId = "session-$Name"; runDirectory = $run; workingDirectory = $owned
            qualificationPath = (Join-Path $qualDir 'qualification.json')
            qualificationExpiresUtc = [DateTime]::UtcNow.AddHours([double](Get-Opt $Opt 'QualHours' 3.0)).ToString('o')
            usageValidatorPath = $validator
            queueCore = [ordered]@{ path = $corePath; sha256 = (Get-Opt $Opt 'CoreSha' (Get-Sha $corePath)) }
            protectedPins = $protectedPins
            editablePins = @([ordered]@{ path = $editable; sha256 = (Get-Sha $editable) })
            environmentAllowlist = @('PATH', 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'HOME', 'DOTNET_ROOT')
            arguments = @('-NoProfile', '-NonInteractive', '-Command', $childScript); payloadPath = $payload; history = @('prior-refusal-1')
        })
    $admPath = Join-Path $root 'admission.json'
    Write-Json $admPath ([ordered]@{
            schema = 'IndependentSupervisedSourceOnlyAdmission/v1'; decision = 'ADMIT_SOURCE_ONLY_ONCE'; planSha256 = (Get-Sha $planPath); taskId = "task-$Name"
            operatorSha256 = (Get-Opt $Opt 'OperatorSha' (Get-Sha $launcher)); expiresUtc = [DateTime]::UtcNow.AddHours([double](Get-Opt $Opt 'ExpiresHours' 2.0)).ToString('o')
            reviewer = 'independent-reviewer'; maximumNativeProcesses = 1
        })
    $jobId = "job-$Name"
    $null = Send-Event $index ([ordered]@{
            schema = 'SourceJobQueueEvent/v1'; eventId = "reg-$Name"; type = 'REGISTER_SOURCE_JOB'; jobId = $jobId; parentId = "parent-$Name"; priority = 1
            ownedPaths = @($owned); dependsOn = @(); planRef = (Get-Ref $planPath); admissionRef = (Get-Ref $admPath)
        }) (Get-UtcText (-2))
    $null = Reserve-NextSourceJob -IndexPath $index -ExpectedVersion (Get-Ver $index) -CandidateJobIds @($jobId) -ReservationId "res-$Name" -AtUtc (Get-UtcText (-1))
    [pscustomobject]@{
        Name = $Name; Root = $root; Owned = $owned; Markers = $markers; Editable = $editable; Protected = $protectedFile; Run = $run; Index = $index
        JobId = $jobId; ReservationId = "res-$Name"; ClaudeStub = $claudeStub
        PlanPath = $planPath; PlanSha = (Get-Sha $planPath); AdmPath = $admPath; AdmSha = (Get-Sha $admPath); UsagePath = $usagePath; UsageSha = (Get-Sha $usagePath)
    }
}

# A registered job that is never launched: only its queue state matters (overlap and independence checks).
function Register-PlainJob([string]$Index, [string]$Name, [string]$Owned) {
    $planPath = Join-Path (Join-Path $work 'plain') "$Name.plan.json"
    Write-Json $planPath ([ordered]@{
            schema = 'SupervisedCodeSourceOnlyTask/v1'; taskId = "task-$Name"; sessionId = "session-$Name"; runDirectory = (Join-Path (Join-Path $work 'plainruns') $Name)
            editablePins = @([ordered]@{ path = (Join-Path $Owned 'plain-target.ps1'); sha256 = ('a' * 64) })
            protectedPins = @([ordered]@{ path = (Join-Path (Join-Path $work 'plain') 'protected.txt'); sha256 = ('d' * 64) }); history = @('prior-refusal-1')
        })
    $admPath = Join-Path (Join-Path $work 'plain') "$Name.admission.json"
    Write-Json $admPath ([ordered]@{
            schema = 'IndependentSupervisedSourceOnlyAdmission/v1'; decision = 'ADMIT_SOURCE_ONLY_ONCE'; planSha256 = (Get-Sha $planPath); taskId = "task-$Name"
            expiresUtc = (Get-UtcText 2); reviewer = 'independent-reviewer'; maximumNativeProcesses = 1
        })
    $null = Send-Event $Index ([ordered]@{
            schema = 'SourceJobQueueEvent/v1'; eventId = "reg-$Name"; type = 'REGISTER_SOURCE_JOB'; jobId = "job-$Name"; parentId = "parent-$Name"; priority = 2
            ownedPaths = @($Owned); dependsOn = @(); planRef = (Get-Ref $planPath); admissionRef = (Get-Ref $admPath)
        }) (Get-UtcText (-2))
    "job-$Name"
}
function Reserve-Plain([string]$Index, [string]$JobId, [string]$ReservationId) {
    Reserve-NextSourceJob -IndexPath $Index -ExpectedVersion (Get-Ver $Index) -CandidateJobIds @($JobId) -ReservationId $ReservationId -AtUtc (Get-UtcText (-0.5))
}

# ---------- separate-process runner ----------

$harness = Join-Path (Join-Path $work 'harness') 'harness.ps1'
Write-Text $harness @'
param(
    [Parameter(Mandatory)][string]$ArgsFile,
    [string]$Mode = 'normal',
    [string]$GoFile = ''
)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $ArgsFile -Raw | ConvertFrom-Json -AsHashtable
$launchArgs = $cfg.Launch
$launcherPath = $cfg.Launcher
. $launcherPath @launchArgs
function Get-SsjClaudeCommandSource { $cfg.ClaudeStub }
if ($Mode -ne 'real-signature') { function Assert-SsjNativeSignature([string]$Path) { } }
if ($Mode -eq 'crash-after-consume') { function Open-SsjRunFiles([string]$RunDirectory) { [Environment]::Exit(97) } }
if ($GoFile) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $GoFile))
    [IO.File]::WriteAllText("$GoFile.ready.$PID", 'x')
    while (-not [IO.File]::Exists($GoFile)) { Start-Sleep -Milliseconds 10 }
}
try { Invoke-SsjMain @launchArgs }
catch { Write-Output ('HARNESS_ERR:' + $_.Exception.Message); exit 3 }
exit 0
'@

function Start-Harness($Fx, [string]$Mode = 'normal', [hashtable]$EnvVars = @{}, [string]$GoFile = '', [hashtable]$Over = @{}) {
    $launch = [ordered]@{
        IndexPath = $Fx.Index; ExpectedVersion = [long](Get-Ver $Fx.Index); JobId = $Fx.JobId; ReservationId = $Fx.ReservationId
        PlanPath = $Fx.PlanPath; ExpectedPlanSha256 = $Fx.PlanSha; AdmissionPath = $Fx.AdmPath; ExpectedAdmissionSha256 = $Fx.AdmSha
        UsagePath = $Fx.UsagePath; ExpectedUsageSha256 = $Fx.UsageSha
    }
    foreach ($key in $Over.Keys) { $launch[$key] = $Over[$key] }
    $argsFile = Join-Path (Join-Path $work 'args') ([guid]::NewGuid().ToString('N') + '.json')
    Write-Json $argsFile ([ordered]@{ Launcher = $launcher; ClaudeStub = $Fx.ClaudeStub; Launch = $launch })
    $psi = [Diagnostics.ProcessStartInfo]::new($pwsh)
    foreach ($arg in @('-NoProfile', '-NonInteractive', '-File', $harness, '-ArgsFile', $argsFile, '-Mode', $Mode)) { $psi.ArgumentList.Add($arg) }
    if ($GoFile) { $psi.ArgumentList.Add('-GoFile'); $psi.ArgumentList.Add($GoFile) }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    foreach ($key in $EnvVars.Keys) { $psi.Environment[$key] = [string]$EnvVars[$key] }
    $proc = [Diagnostics.Process]::Start($psi)
    [pscustomobject]@{ Proc = $proc; OutTask = $proc.StandardOutput.ReadToEndAsync(); ErrTask = $proc.StandardError.ReadToEndAsync() }
}
function Complete-Harness($H) {
    # Harness-only safety net for a hung test process; the launcher under test has no such kill.
    if (-not $H.Proc.WaitForExit(240000)) { $H.Proc.Kill($true); $H.Proc.WaitForExit() }
    [pscustomobject]@{ Exit = $H.Proc.ExitCode; Out = ($H.OutTask.GetAwaiter().GetResult() + "`n" + $H.ErrTask.GetAwaiter().GetResult()) }
}
function Invoke-Harness($Fx, [string]$Mode = 'normal', [hashtable]$EnvVars = @{}, [hashtable]$Over = @{}) { Complete-Harness (Start-Harness $Fx $Mode $EnvVars '' $Over) }

function Assert-NoLaunch($Fx, $Result, [string]$Code, [string]$Message, [string]$IndexShaBefore) {
    Assert-That ($Result.Exit -ne 0) "$Message (exit must be non-zero, got $($Result.Exit))"
    if ($Code) { Assert-That ($Result.Out -clike "*$Code*") "$Message (expected $Code in: $($Result.Out))" }
    Assert-That ((Get-Starts $Fx) -eq 0) "$Message (zero children)"
    Assert-That ((Get-Sha $Fx.Index) -ceq $IndexShaBefore) "$Message (index bytes intact)"
    Assert-That (-not (Test-Path -LiteralPath $Fx.Run)) "$Message (no run directory)"
}

try {
    # ---------- 0. launcher surface ----------
    $source = Get-Content -LiteralPath $launcher -Raw
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors)
    Assert-That ($parseErrors.Count -eq 0) 'launcher parses'
    $paramNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    Assert-That (($paramNames -join ',') -ceq 'IndexPath,ExpectedVersion,JobId,ReservationId,PlanPath,ExpectedPlanSha256,AdmissionPath,ExpectedAdmissionSha256,UsagePath,ExpectedUsageSha256') 'public parameters are exactly the queue binding plus the six pins (no skip, test or script parameter)'
    Assert-That ($source -cnotmatch 'SkipSecurity|TestMode|Invoke-Expression|\biex\b|Start-Process|\.Kill\(|WaitForExit\([^)\s]|Invoke-RestMethod|Invoke-WebRequest|canonical-task-backlog') 'no test mode, dynamic script, network, kill, wallclock wait or real-canonical default'

    # ---------- 1. stale / unsafe inputs are refused before consumption: zero children, index untouched ----------
    $variants = @(
        @{ Tag = 'stale qualification'; Code = 'PRELAUNCH_EXPIRED'; Opt = @{ ExpiresHours = 2.0; QualHours = 1.0 } },
        @{ Tag = 'expired admission'; Code = 'PRELAUNCH_EXPIRED'; Opt = @{ ExpiresHours = -0.5 } },
        @{ Tag = 'stale usage receipt'; Code = 'RECEIPT_STALE'; Opt = @{ UsageMinutes = -1.0 } },
        @{ Tag = '100 percent included week'; Code = 'INCLUDED_WEEK_EXHAUSTED'; Opt = @{ WeekPct = 100 } },
        @{ Tag = 'admission pins another operator'; Code = 'EXACT_INDEPENDENT_ADMISSION'; Opt = @{ OperatorSha = ('f' * 64) } },
        @{ Tag = 'core closure not matching its pin'; Code = 'PIN_DRIFT'; Opt = @{ CoreSha = ('0' * 64) } },
        @{ Tag = 'usage validator outside the protected pins'; Code = 'UNPINNED_USAGE_VALIDATOR'; Opt = @{ DropValidatorPin = $true } },
        @{ Tag = 'editable pin drift'; Code = 'PIN_DRIFT'; Post = { param($f) [IO.File]::AppendAllText($f.Editable, 'x') } },
        @{ Tag = 'protected pin drift'; Code = 'PIN_DRIFT'; Post = { param($f) [IO.File]::AppendAllText($f.Protected, 'x') } },
        @{ Tag = 'ambient provider override'; Code = 'AMBIENT_OVERRIDE_OR_CAP'; Env = @{ ANTHROPIC_API_KEY = 'fixture-not-a-secret' } },
        @{ Tag = 'native binary without the expected signature'; Code = ''; Mode = 'real-signature' }
    )
    $n = 0
    foreach ($variant in $variants) {
        $n++
        $fx = New-LaunchFixture "ref$n" (Get-Opt $variant 'Opt' @{})
        if ($variant.ContainsKey('Post')) { & $variant.Post $fx }
        $before = Get-Sha $fx.Index
        $result = Invoke-Harness $fx (Get-Opt $variant 'Mode' 'normal') (Get-Opt $variant 'Env' @{})
        Assert-NoLaunch $fx $result $variant.Code "refusal: $($variant.Tag)" $before
        $job = Get-Job $fx.Index $fx.JobId
        Assert-That ($job['state'] -ceq 'DISPATCH_UNCERTAIN' -and -not (Test-Consumed $job)) "refusal: $($variant.Tag) leaves the reservation unconsumed"
    }

    # ---------- 2. two processes compete for one reservation; 4. natural run reconciles the consumed tuple ----------
    $race = New-LaunchFixture 'race'
    $barrier = Join-Path (Join-Path $work 'barrier') 'go'
    $h1 = Start-Harness $race 'normal' @{} $barrier
    $h2 = Start-Harness $race 'normal' @{} $barrier
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while (@(Get-ChildItem -LiteralPath (Split-Path -Parent $barrier) -Filter 'go.ready.*' -ErrorAction SilentlyContinue).Count -lt 2 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    Assert-That (@(Get-ChildItem -LiteralPath (Split-Path -Parent $barrier) -Filter 'go.ready.*' -ErrorAction SilentlyContinue).Count -eq 2) 'both racing processes reached the barrier (2 ready markers) before it was released'
    [IO.File]::WriteAllText($barrier, 'go')
    $r1 = Complete-Harness $h1
    $r2 = Complete-Harness $h2
    $outs = @($r1.Out, $r2.Out)
    Assert-That (@($outs | Where-Object { $_ -clike '*RESERVATION_NEWLY_CONSUMED*' }).Count -eq 1) 'exactly one process reports NEWLY_CONSUMED'
    Assert-That (@($outs | Where-Object { $_ -clike '*ACTUAL_SOURCE_AUTHOR_STARTED*' }).Count -eq 1) 'exactly one process starts the author'
    Assert-That ((Get-Starts $race) -eq 1) 'exactly one controlled child was started'
    Assert-That ((((@($r1.Exit, $r2.Exit) | Sort-Object) -join ',')) -ceq '0,3') 'one process succeeds and the other is refused'
    Assert-That (@($outs | Where-Object { $_ -clike '*ALREADY_CONSUMED*' -or $_ -clike '*RUN_EXISTS_NO_RETRY*' -or $_ -clike '*LEASE_BUSY*' }).Count -eq 1) 'the loser is refused by the consumed reservation, the existing run or the lease'
    $job = Get-Job $race.Index $race.JobId
    Assert-That ($job['state'] -ceq 'DISPATCH_UNCERTAIN' -and (Test-Consumed $job) -and $null -eq $job['start']) 'consumption alone leaves the job DISPATCH_UNCERTAIN until an actual start is submitted'

    $inv = Join-Path $race.Run 'invocation.json'
    $invObj = Get-Content -LiteralPath $inv -Raw | ConvertFrom-Json -AsHashtable
    Assert-That ($invObj['queueBinding']['attemptId'] -ceq $job['reservation']['consumption']['attemptId'] -and $invObj['queueBinding']['reservationId'] -ceq $race.ReservationId -and $invObj['queueBinding']['jobId'] -ceq $race.JobId) 'immutable invocation binds the consumed attempt, reservation and job'
    Assert-That ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $race.Run 'stdout.bin'))) -clike '*child-out*' -and [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $race.Run 'stderr.bin'))) -clike '*child-err*') 'raw stdout and stderr were streamed to the run directory'

    $startEvent = [ordered]@{ schema = 'SourceJobQueueEvent/v1'; eventId = 'start-race'; type = 'OBSERVED_START'; jobId = $race.JobId; reservationId = $race.ReservationId; startRef = (Get-Ref (Join-Path $race.Run 'start.json')); invocationRef = (Get-Ref $inv) }
    $null = Send-Event $race.Index $startEvent (Get-UtcText 0)
    Assert-That ((Get-Job $race.Index $race.JobId)['state'] -ceq 'RUNNING') 'actual start evidence for the consumed tuple reconciles to RUNNING'
    $terminalEvent = [ordered]@{ schema = 'SourceJobQueueEvent/v1'; eventId = 'term-race'; type = 'OBSERVED_TERMINAL'; jobId = $race.JobId; terminalRef = (Get-Ref (Join-Path $race.Run 'terminal.json')); invocationRef = (Get-Ref $inv) }
    $null = Send-Event $race.Index $terminalEvent (Get-UtcText 0)
    $job = Get-Job $race.Index $race.JobId
    Assert-That ($job['state'] -ceq 'REVIEW_REQUIRED' -and $job['notice'] -ceq 'REVIEW_NEEDED_NOT_ACCEPTED' -and @($job['reasons']).Count -eq 0) 'exit 0 with drained raw output is REVIEW_REQUIRED with no reconciliation reasons'
    Assert-That ($job['terminal']['exitCode'] -eq 0 -and $job['terminal']['rawDrained'] -eq $true -and $job['terminal']['stdoutSha256'] -ceq (Get-Sha (Join-Path $race.Run 'stdout.bin')) -and $job['terminal']['stderrSha256'] -ceq (Get-Sha (Join-Path $race.Run 'stderr.bin'))) 'terminal record carries the exit code and the raw artifact hashes'
    Assert-That ($job['start']['invocationRef']['sha256'] -ceq (Get-Sha $inv) -and $job['terminal']['taskAcceptance'] -ceq 'NOT_EVALUATED' -and $job['terminal']['globalUsage'] -ceq 'UNKNOWN') 'start and terminal bind the same invocation; nothing is accepted'
    Assert-That ((ConvertTo-SjqCanonical (Get-QueueOrNull $race.Index)) -cnotmatch '"(DONE|ACCEPTED|accepted)"') 'the queue never records DONE or accepted'
    $versionBefore = Get-Ver $race.Index
    $replay = Send-Event $race.Index $startEvent (Get-UtcText 0)
    Assert-That ($replay.Status -ceq 'NOOP_DUPLICATE' -and (Get-Ver $race.Index) -eq $versionBefore) 'replayed observed events stay idempotent'
    $shaBeforeReplayRun = Get-Sha $race.Index
    $again = Invoke-Harness $race
    Assert-That ($again.Exit -ne 0 -and (Get-Starts $race) -eq 1 -and (Get-Sha $race.Index) -ceq $shaBeforeReplayRun) 'a replayed launch after review starts nothing and changes nothing'

    # ---------- 6. a REVIEW_REQUIRED owner still blocks overlap ----------
    $overlapReview = Register-PlainJob $race.Index 'pj-review-overlap' $race.Root
    $blocked = Reserve-Plain $race.Index $overlapReview 'res-pj-review-overlap'
    Assert-That ($blocked.Status -ceq 'NO_ELIGIBLE_CANDIDATE' -and $blocked.Skips[0].Reasons -ccontains "PATH_CONFLICT:$($race.JobId)") 'overlapping work stays blocked while the first job is REVIEW_REQUIRED'

    # ---------- 3. crash after consume, before start; retry in another process ----------
    $crash = New-LaunchFixture 'crash'
    $crashRun = Invoke-Harness $crash 'crash-after-consume'
    Assert-That ($crashRun.Exit -eq 97) "the injected crash after consumption ended the process (exit $($crashRun.Exit))"
    $job = Get-Job $crash.Index $crash.JobId
    Assert-That ((Test-Consumed $job) -and $job['state'] -ceq 'DISPATCH_UNCERTAIN' -and $null -eq $job['start'] -and $null -eq $job['terminal']) 'durable DISPATCH_UNCERTAIN with consumed=true after the crash'
    Assert-That ((Get-Starts $crash) -eq 0 -and -not (Test-Path -LiteralPath $crash.Run)) 'the crash produced no child'
    $shaAfterCrash = Get-Sha $crash.Index
    $retry = Invoke-Harness $crash
    Assert-NoLaunch $crash $retry 'ALREADY_CONSUMED' 'retry in another process after the crash' $shaAfterCrash
    $staleRetry = Invoke-Harness $crash 'normal' @{} @{ ExpectedVersion = [long]0 }
    Assert-NoLaunch $crash $staleRetry 'ALREADY_CONSUMED' 'retry with a stale expected version' $shaAfterCrash
    Assert-That ((Get-Job $crash.Index $crash.JobId)['state'] -ceq 'DISPATCH_UNCERTAIN') 'retries leave the job DISPATCH_UNCERTAIN: not reset, not READY'

    # ---------- 6. overlap stays blocked and an independent disjoint reservation still works ----------
    $overlap = Register-PlainJob $crash.Index 'pj-overlap' $crash.Root
    $free = Register-PlainJob $crash.Index 'pj-free' (Join-Path (Join-Path $work 'plain') 'free-owned')
    $blocked = Reserve-Plain $crash.Index $overlap 'res-pj-overlap'
    Assert-That ($blocked.Status -ceq 'NO_ELIGIBLE_CANDIDATE' -and $blocked.Skips[0].Reasons -ccontains "PATH_CONFLICT:$($crash.JobId)") 'overlapping work stays blocked while the first job is uncertain'
    $independent = Reserve-Plain $crash.Index $free 'res-pj-free'
    Assert-That ($independent.Status -ceq 'RESERVED' -and $independent.JobId -ceq $free) 'a disjoint job reserves independently while the first is uncertain'

    # ---------- 5. mismatched binding inputs are refused; old bytes intact; the reservation is not burned ----------
    $mm = New-LaunchFixture 'mm'
    $mmb = New-LaunchFixture 'mmb'
    $other = Register-PlainJob $mm.Index 'pj-mm' (Join-Path (Join-Path $work 'plain') 'mm-owned')
    $null = Reserve-Plain $mm.Index $other 'res-pj-mm'
    $mmSha = Get-Sha $mm.Index
    $cases = @(
        @{ Tag = 'plan, admission and usage of another job'; Code = 'PLAN_REF_MISMATCH'; Fx = $mmb; Over = @{ IndexPath = $mm.Index; ExpectedVersion = [long](Get-Ver $mm.Index); JobId = $mm.JobId; ReservationId = $mm.ReservationId } },
        @{ Tag = 'admission of another job'; Code = 'EXACT_INDEPENDENT_ADMISSION'; Fx = $mm; Over = @{ AdmissionPath = $mmb.AdmPath; ExpectedAdmissionSha256 = $mmb.AdmSha } },
        @{ Tag = 'unknown reservation'; Code = 'RESERVATION_NOT_FOUND'; Fx = $mm; Over = @{ ReservationId = 'res-unknown' } },
        @{ Tag = 'reservation that belongs to another job'; Code = 'RESERVATION_MISMATCH'; Fx = $mm; Over = @{ ReservationId = 'res-pj-mm' } },
        @{ Tag = 'unregistered job'; Code = 'JOB_NOT_REGISTERED'; Fx = $mm; Over = @{ JobId = 'job-unregistered' } },
        @{ Tag = 'stale index version'; Code = 'VERSION_CONFLICT'; Fx = $mm; Over = @{ ExpectedVersion = [long]0 } },
        @{ Tag = 'plan hash that does not match the file'; Code = 'PIN_DRIFT'; Fx = $mm; Over = @{ ExpectedPlanSha256 = ('0' * 64) } },
        @{ Tag = 'run directory that already exists'; Code = 'RUN_EXISTS_NO_RETRY'; Fx = $mm; Over = @{}; Pre = { [void][IO.Directory]::CreateDirectory($mm.Run) }; Post = { Remove-Item -LiteralPath $mm.Run -Recurse -Force } }
    )
    foreach ($case in $cases) {
        if ($case.ContainsKey('Pre')) { & $case.Pre }
        $result = Complete-Harness (Start-Harness $case.Fx 'normal' @{} '' $case.Over)
        if ($case.ContainsKey('Post')) { & $case.Post }
        Assert-That ($result.Exit -ne 0 -and $result.Out -clike "*$($case.Code)*") "mismatch refused: $($case.Tag) (got: $($result.Out))"
        Assert-That ((Get-Starts $mm) -eq 0 -and (Get-Starts $mmb) -eq 0 -and (Get-Sha $mm.Index) -ceq $mmSha) "mismatch refused: $($case.Tag) starts nothing and leaves the index bytes intact"
    }
    Assert-That (-not (Test-Consumed (Get-Job $mm.Index $mm.JobId))) 'no refused attempt consumed the reservation'
    $good = Invoke-Harness $mm
    Assert-That ($good.Exit -eq 0 -and (Get-Starts $mm) -eq 1 -and (Test-Consumed (Get-Job $mm.Index $mm.JobId))) 'after the refusals the exact reservation still launches once'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "supervised-source-job tests: passed=$script:Passed failed=$script:Failures"
if ($script:Failures -gt 0) { exit 1 }
