#Requires -Version 7.6
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ProviderPath,
 [Parameter(Mandatory)][string]$ExpectedProviderSha256,
 [Parameter(Mandatory)][string]$GhPath,
 [Parameter(Mandatory)][string]$ExpectedGhSha256,
 [Parameter(Mandatory)][string]$CompilerPath,
 [Parameter(Mandatory)][string]$ExpectedCompilerSha256,
 [Parameter(Mandatory)][string]$EvidenceRoot,
 [string]$LifecyclePath,
 [string]$ExpectedLifecycleSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:res = [System.Collections.Generic.List[object]]::new()
function Chk217 { param([string]$N, [bool]$Ok) $script:res.Add([pscustomobject]@{ n = $N; ok = $Ok }); $t = 'FAIL'; if ($Ok) { $t = 'PASS' }; Write-Host ($t + ' ' + $N) }
function Thr217 { param([scriptblock]$B) try { & $B | Out-Null; $false } catch { $true } }
function Sf217 { param([string]$P) [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.IO.File]::ReadAllBytes($P))).ToLowerInvariant() }
function Ss217 { param([string]$S) [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($S))).ToLowerInvariant() }
function NoRp217 { param([string]$P) $c = $P; while (-not [string]::IsNullOrEmpty($c)) { if ((Test-Path -LiteralPath $c) -and [System.IO.File]::GetAttributes($c).HasFlag([System.IO.FileAttributes]::ReparsePoint)) { return $false }; $c = [System.IO.Path]::GetDirectoryName($c) }; $true }

# ---- trusted pins and root confinement BEFORE any import or write ----
$hx = '^[0-9a-f]{64}$'
$ep = $ExpectedProviderSha256.ToLowerInvariant(); $eg = $ExpectedGhSha256.ToLowerInvariant(); $ec = $ExpectedCompilerSha256.ToLowerInvariant()
foreach ($p in @($ep, $eg, $ec)) { if ($p -cnotmatch $hx) { throw 'ABORT217_PIN_FORMAT' } }
if ($ep -cne '68FE98B94572974E80F019CAFFF86E0CE74DA86072745C8F3F1A77A3C61847D7'.ToLowerInvariant()) { throw 'ABORT217_PROVIDER_NOT_ACCEPTED216' }
if ($eg -cne 'E2EFA10A5D2CE93CAC9BC4B676932B62947C0967C01C8F2C3A9CB4437AD358D3'.ToLowerInvariant()) { throw 'ABORT217_GH_PIN' }
if ($ec -cne '46809206887326D2D24DB1EFF1F3064DE972C3451ABE766B49111450A5E08E00'.ToLowerInvariant()) { throw 'ABORT217_COMPILER_PIN' }
if ((Sf217 $ProviderPath) -cne $ep) { throw 'ABORT217_PROVIDER_HASH' }
if ((Sf217 $GhPath) -cne $eg) { throw 'ABORT217_GH_HASH' }
if ((Sf217 $CompilerPath) -cne $ec) { throw 'ABORT217_COMPILER_HASH' }
$got = $EvidenceRoot
$sysTmp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\','/')
if (-not $IsWindows -or [string]::IsNullOrEmpty($got) -or $got.IndexOf([char]0) -ge 0 -or -not [System.IO.Path]::IsPathFullyQualified($got)) { throw 'ABORT217_EVIDENCE_ROOT' }
if ($got -cne [System.IO.Path]::GetFullPath($got) -or $got.EndsWith('\') -or $got.EndsWith('/')) { throw 'ABORT217_EVIDENCE_ROOT' }
if (([System.IO.Path]::GetDirectoryName($got) -ine $sysTmp) -or ([System.IO.Path]::GetFileName($got) -cnotmatch '^software-factory-gh-native-[0-9a-f]{32}\z')) { throw 'ABORT217_EVIDENCE_ROOT' }
$gotExists = $false
try { [void][System.IO.File]::GetAttributes($got); $gotExists = $true } catch { }
if ($gotExists -or [System.IO.File]::Exists($got) -or [System.IO.Directory]::Exists($got)) { throw 'ABORT217_EVIDENCE_EXISTS' }
if (-not (NoRp217 $got)) { throw 'ABORT217_EVIDENCE_REPARSE' }
. $ProviderPath
$lc = $false
if (-not [string]::IsNullOrEmpty($LifecyclePath) -and -not [string]::IsNullOrEmpty($ExpectedLifecycleSha256) -and (Sf217 $LifecyclePath) -ceq $ExpectedLifecycleSha256.ToLowerInvariant()) { . $LifecyclePath; $lc = $true }

[System.IO.Directory]::CreateDirectory($got) | Out-Null
if (-not (NoRp217 $got)) { throw 'ABORT217_EVIDENCE_REPARSE' }
$work = Join-Path $got ('run-' + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($work) | Out-Null
if (-not (NoRp217 $work)) { throw 'ABORT217_WORK_REPARSE' }
$script:tmp = Join-Path $work 'tmp'
[System.IO.Directory]::CreateDirectory($script:tmp) | Out-Null
[System.IO.File]::WriteAllText((Join-Path $script:tmp 'keep.txt'), 'keep')
$script:fake = Join-Path $work 'fakegh.bin'
[System.IO.File]::WriteAllBytes($script:fake, [byte[]](1..40))
$script:fakeSha = Sf217 $script:fake

$repo = 'hakanduyar/software-factory'; $ub = 'https://github.com/' + $repo + '/issues/'; $nl = [string][char]10
$id = 'task:one'; $title = 'Public task title'; $stable = 'factory-task-' + (Ss217 $id); $rend = '<!-- ' + $stable + ' -->'
function Body217 { param([string]$Sum) $rg = @('<!-- factory-task-status:start -->', ('Task: ' + $id), 'Version: 1', 'Status: IN_PROGRESS', 'Next action: RUN_FOCUSED_CHECKS', ('Summary: ' + $Sum), '<!-- factory-task-status:end -->') -join $nl; $rend + $nl + $nl + $rg }
$gb = Body217 'Initial summary'
function Is217 { param([int]$N, [string]$S, $B, [bool]$Pr = $false) $o = [ordered]@{ number = $N; html_url = ($ub + $N); state = $S; body = $B }; if ($Pr) { $o['pull_request'] = @{ url = 'https://example.invalid/pr' } }; ConvertTo-Json -InputObject $o -Compress -Depth 4 }
function Pg217 { param([string[]]$I) '[' + ($I -join ',') + ']' }
function Al217 { param([string[]]$P) '[' + ($P -join ',') + ']' }
function Rs217 { param([string]$S, [int]$C = 0, [bool]$T = $false, [bool]$O = $false, [bool]$E = $false) [pscustomobject]@{ exitCode = $C; timedOut = $T; stdout = $S; stdoutTruncated = $O; stderrTruncated = $E } }
function Mk217 { param([string]$S, [int]$C = 0, [bool]$T = $false, [bool]$O = $false, [bool]$E = $false) $r = Rs217 $S $C $T $O $E; $b = { param($a) $r }.GetNewClosure(); $b }
function Route217 { param($F, $C, $V) $h = @{ find = $F; create = $C; view = $V }; $b = { param($a) $k = 'view'; if ($a[0] -ceq 'api') { $k = 'find' } elseif ($a[0] -ceq 'issue' -and $a[1] -ceq 'create') { $k = 'create' }; $h[$k] }.GetNewClosure(); $b }
function Rig217 {
 param([scriptblock]$Resp, [string]$Exe = $script:fake, [string]$Sha = $script:fakeSha)
 $log = [System.Collections.Generic.List[object]]::new()
 $run = { param($e, $a, $d, $o, $m) $bp = $null; $bt = $null; if (@($a).Count -gt 7 -and $a[6] -ceq '--body-file') { $bp = $a[7]; if ([System.IO.File]::Exists($bp)) { $bt = [System.IO.File]::ReadAllText($bp) } }; $log.Add([pscustomobject]@{ a = @($a); d = $d; o = $o; m = $m; e = $e; bp = $bp; bt = $bt }); & $Resp $a }.GetNewClosure()
 [pscustomobject]@{ t = (New-GitHubCliLifecycleTransport216 -GhPath $Exe -ExpectedGhSha256 $Sha -Repository $repo -TempRoot $script:tmp -ProcessRunner $run); log = $log }
}
function Cr217 { param($G) @($G.log | Where-Object { $_.a[0] -ceq 'issue' -and $_.a[1] -ceq 'create' }).Count }
function Clean217 { @(Get-ChildItem -LiteralPath $script:tmp -Force | Where-Object { $_.Name -cne 'keep.txt' }).Count -eq 0 }
$findReq = @{ repo = $repo; stableMarker = $stable; renderedMarker = $rend }

# ---- P1 configuration/pin ----
Chk217 'P1 wrong exe pin throws' (Thr217 { Rig217 (Mk217 '') -Sha ('0' * 64) })
Chk217 'P1 wrong repository throws' (Thr217 { New-GitHubCliLifecycleTransport216 -GhPath $script:fake -ExpectedGhSha256 $script:fakeSha -Repository 'other/repo' -TempRoot $script:tmp -ProcessRunner (Mk217 '') })
Chk217 'P1 relative temp root throws' (Thr217 { New-GitHubCliLifecycleTransport216 -GhPath $script:fake -ExpectedGhSha256 $script:fakeSha -Repository $repo -TempRoot 'rel/tmp' -ProcessRunner (Mk217 '') })
Chk217 'P1 missing temp root throws' (Thr217 { New-GitHubCliLifecycleTransport216 -GhPath $script:fake -ExpectedGhSha256 $script:fakeSha -Repository $repo -TempRoot (Join-Path $work 'absent') -ProcessRunner (Mk217 '') })
Chk217 'P1 relative exe path throws' (Thr217 { New-GitHubCliLifecycleTransport216 -GhPath 'gh.exe' -ExpectedGhSha256 $script:fakeSha -Repository $repo -TempRoot $script:tmp -ProcessRunner (Mk217 '') })
$rg = Rig217 (Mk217 '') -Exe $GhPath -Sha $eg
Chk217 'P1 real gh pin validates, never started' (($null -ne $rg.t) -and $rg.log.Count -eq 0)
$lk = Join-Path $work 'link'
try { if (-not $IsWindows) { throw [System.PlatformNotSupportedException]::new('x') }; $wf = [System.IO.Path]::GetFullPath($work).TrimEnd('\','/') + '\'; $lf = [System.IO.Path]::GetFullPath($lk); $tf = [System.IO.Path]::GetFullPath($script:tmp).TrimEnd('\','/'); if (-not $lf.StartsWith($wf, [System.StringComparison]::OrdinalIgnoreCase) -or -not ($tf + '\').StartsWith($wf, [System.StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $lk) -or -not (NoRp217 $tf)) { throw [System.InvalidOperationException]::new('x') }; New-Item -ItemType Junction -Path $lk -Target $script:tmp | Out-Null; $li = Get-Item -LiteralPath $lk -Force; $lt = [string]@($li.Target)[0]; if ($lt.StartsWith('\??\')) { $lt = $lt.Substring(4) }; if (-not $li.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint) -or $li.LinkType -cne 'Junction' -or $lt.TrimEnd('\','/') -ine $tf) { throw [System.InvalidOperationException]::new('x') }; $zc = [System.Collections.Generic.List[object]]::new(); $zr = { param($e, $a, $d, $o, $m) $zc.Add(1); Rs217 '' }.GetNewClosure(); Chk217 'P1 reparse temp root throws, zero ProcessRunner calls' ((Thr217 { New-GitHubCliLifecycleTransport216 -GhPath $script:fake -ExpectedGhSha256 $script:fakeSha -Repository $repo -TempRoot $lk -ProcessRunner $zr }) -and $zc.Count -eq 0) } catch { Chk217 ('P1 reparse temp root fixture BLOCKED ' + $_.Exception.GetType().Name) $false }
$inv = @(
 @('WRITE', @{ repo = $repo }), @('CLOSE', @{ repo = $repo }), @('login', @{ repo = $repo }),
 @('READ', @{ repo = 'other/repo'; issueNumber = 5 }), @('READ', @{ repo = $repo; issueNumber = 0 }), @('READ', @{ repo = $repo; issueNumber = -1 }),
 @('READ', @{ repo = $repo; issueNumber = 2147483648L }), @('READ', @{ repo = $repo; issueNumber = '5' }), @('READ', @{ repo = $repo; issueNumber = 5; x = 1 }),
 @('READ', [pscustomobject]@{ repo = $repo; issueNumber = 5 }),
 @('FIND', @{ repo = $repo; stableMarker = $stable }), @('FIND', @{ repo = $repo; stableMarker = $stable; renderedMarker = '<!-- other -->' }),
 @('FIND', @{ repo = $repo; stableMarker = 'factory-task-ABC'; renderedMarker = '<!-- factory-task-ABC -->' }),
 @('CREATE', @{ repo = $repo; title = 'a/b'; body = $gb }), @('CREATE', @{ repo = $repo; title = 'my password'; body = $gb }),
 @('CREATE', @{ repo = $repo; title = $title; body = ($gb + $nl + 'extra') }),
 @('CREATE', @{ repo = $repo; title = $title; body = $gb.Replace($stable, ('factory-task-' + ('0' * 64))) }),
 @('CREATE', @{ repo = $repo; title = $title; body = $gb; x = 1 })
)
$i = 0
foreach ($c in $inv) { $i++; $g = Rig217 (Mk217 'x'); $r = & $g.t $c[0] $c[1]; Chk217 ('P1 invalid request #' + $i + ' zero process') (($r.ok -eq $false) -and $g.log.Count -eq 0 -and (Clean217)) }
$f2 = Join-Path $work 'fake2.bin'; [System.IO.File]::WriteAllBytes($f2, [byte[]](5..50)); $s2 = Sf217 $f2
$g = Rig217 (Mk217 'x') -Exe $f2 -Sha $s2
[System.IO.File]::AppendAllText($f2, 'tamper')
$r = & $g.t 'READ' @{ repo = $repo; issueNumber = 5 }
Chk217 'P1 changed pin before invocation zero starts' (($r.ok -eq $false) -and $g.log.Count -eq 0)

# ---- P2 FIND ----
$mb = Body217 'Initial summary'
$pages = Al217 @((Pg217 @((Is217 1 'open' $mb $true), (Is217 2 'closed' 'other'))), (Pg217 @((Is217 7 'closed' $mb), (Is217 8 'open' $null), (Is217 9 'open' ('see ' + $rend)))))
$g = Rig217 (Mk217 $pages)
$r = & $g.t 'FIND' $findReq
$a0 = $g.log[0]
Chk217 'P2 FIND baseline excludes PR keeps closed' (($r.ok -eq $true) -and $r.complete -eq $true -and @($r.issues).Count -eq 1 -and $r.issues[0].number -eq 7 -and $r.issues[0].url -ceq ($ub + '7'))
Chk217 'P2 FIND exact argv and caps' ((($a0.a -join '|') -ceq ('api|--method|GET|repos/' + $repo + '/issues?state=all&per_page=100|--paginate|--slurp')) -and $a0.d -eq 30000 -and $a0.o -eq 8388608 -and $a0.m -eq 65536)
$crl = Al217 @((Pg217 @((Is217 3 'open' ('x' + [char]13 + $nl + $rend + [char]13 + $nl + 'y')), (Is217 4 'open' $mb))))
$r = & (Rig217 (Mk217 $crl)).t 'FIND' $findReq
Chk217 'P2 FIND CRLF line and duplicate issues returned for lifecycle' (($r.ok -eq $true) -and @($r.issues).Count -eq 2)
$r = & (Rig217 (Mk217 (Al217 @((Pg217 @((Is217 3 'open' ('x ' + $rend))))))) ).t 'FIND' $findReq
Chk217 'P2 non-standalone marker not matched' (($r.ok -eq $true) -and @($r.issues).Count -eq 0)
$r = & (Rig217 (Mk217 (Al217 @((Pg217 @((1..1000 | ForEach-Object { Is217 $_ 'open' 'x' }))))))).t 'FIND' $findReq
Chk217 'P2 exactly 1000 records ok' (($r.ok -eq $true) -and $r.complete -eq $true)
$dup = Al217 @((Pg217 @((Is217 5 'open' ($rend + $nl + 'x' + $nl + $rend)))))
$bad = [ordered]@{
 over1000 = (Mk217 (Al217 @((Pg217 @((1..1001 | ForEach-Object { Is217 $_ 'open' 'x' }))))))
 dupmarker = (Mk217 $dup); malformed = (Mk217 '[[{'); notarray = (Mk217 '{}'); pagenotarray = (Mk217 '[{}]'); empty = (Mk217 '[]'); blank = (Mk217 '')
 wrongurl = (Mk217 (Al217 @((Pg217 @(('{"number":1,"html_url":"https://example.invalid/1","state":"open","body":null}'))))))
 dupnum = (Mk217 (Al217 @((Pg217 @((Is217 1 'open' 'a'), (Is217 1 'open' 'b'))))))
 badstate = (Mk217 (Al217 @((Pg217 @((Is217 1 'OPEN' 'a'))))))
 nonzero = (Mk217 $pages 1); timeout = (Mk217 $pages 0 $true); trunc = (Mk217 $pages 0 $false $true); errtrunc = (Mk217 $pages 0 $false $false $true)
}
foreach ($k in $bad.Keys) { $g = Rig217 $bad[$k]; $r = & $g.t 'FIND' $findReq; Chk217 ('P2 FIND refusal ' + $k) (($r.ok -eq $false) -and $r.complete -eq $false -and @($r.issues).Count -eq 0 -and $g.log.Count -eq 1) }
$sh = { param($a) [pscustomobject]@{ exitCode = 0; timedOut = $false; stdout = '[]' } }
$r = & (Rig217 $sh).t 'FIND' $findReq
Chk217 'P2 malformed runner shape refused' (($r.ok -eq $false) -and $r.complete -eq $false)
$two = { param($a) (Rs217 '[[]]'); (Rs217 '[[]]') }
$r = & (Rig217 $two).t 'FIND' $findReq
Chk217 'P2 multiple runner results refused' ($r.ok -eq $false)

# ---- P4 READ ----
function Vw217 { param($N = 5, $U = ($ub + '5'), $S = 'OPEN', $T = $title, $B = $gb, [switch]$X) $o = [ordered]@{ number = $N; url = $U; state = $S; title = $T; body = $B }; if ($X) { $o['extra'] = 1 }; ConvertTo-Json -InputObject $o -Compress }
$g = Rig217 (Mk217 (Vw217))
$r = & $g.t 'READ' @{ repo = $repo; issueNumber = 5 }
Chk217 'P4 READ baseline' (($r.ok -eq $true) -and $r.number -eq 5 -and $r.url -ceq ($ub + '5') -and $r.state -ceq 'OPEN' -and $r.title -ceq $title -and $r.body -ceq $gb)
Chk217 'P4 READ exact argv' ((($g.log[0].a -join '|') -ceq ('issue|view|5|--repo|' + $repo + '|--json|number,url,state,title,body')) -and $g.log.Count -eq 1)
$rb = [ordered]@{ number = (Mk217 (Vw217 -N 6)); url = (Mk217 (Vw217 -U 'http://github.com/x/5')); lower = (Mk217 (Vw217 -S 'open')); extra = (Mk217 (Vw217 -X)); nulltitle = (Mk217 (Vw217 -T $null)); dupkey = (Mk217 '{"number":5,"number":5,"url":"u","state":"OPEN","title":"t","body":"b"}'); junk = (Mk217 '{'); nonzero = (Mk217 (Vw217) 2); timeout = (Mk217 (Vw217) 0 $true) }
foreach ($k in $rb.Keys) { $r = & (Rig217 $rb[$k]).t 'READ' @{ repo = $repo; issueNumber = 5 }; Chk217 ('P4 READ refusal ' + $k) ($r.ok -eq $false) }

# ---- P3 CREATE ----
$okUrl = $ub + '11'
$g = Rig217 (Mk217 ($okUrl + $nl))
$r = & $g.t 'CREATE' @{ repo = $repo; title = $title; body = $gb }
$l = $g.log[0]
Chk217 'P3 CREATE success' (($r.ok -eq $true) -and $r.number -eq 11 -and $r.url -ceq $okUrl -and $g.log.Count -eq 1)
Chk217 'P3 CREATE argv body-file title repo' (($l.a.Count -eq 8) -and (($l.a[0..5] -join '|') -ceq ('issue|create|--repo|' + $repo + '|--title|' + $title)) -and $l.a[6] -ceq '--body-file')
Chk217 'P3 body file confined content exact then deleted' (($null -ne $l.bp) -and [System.IO.Path]::GetDirectoryName($l.bp) -ceq [System.IO.Path]::GetFullPath($script:tmp).TrimEnd('\','/') -and $l.bt -ceq $gb -and -not [System.IO.File]::Exists($l.bp) -and (Clean217) -and [System.IO.File]::Exists((Join-Path $script:tmp 'keep.txt')))
$g = Rig217 (Mk217 ($okUrl + [char]13 + $nl)); $r = & $g.t 'CREATE' @{ repo = $repo; title = $title; body = $gb }
Chk217 'P3 CREATE CRLF stdout accepted' ($r.ok -eq $true)
$cb = [ordered]@{ zero = ($ub + '0'); lead0 = ($ub + '05'); extra = ($okUrl + ' extra'); other = 'https://github.com/other/repo/issues/5'; text = 'created'; blank = '' }
foreach ($k in $cb.Keys) { $g = Rig217 (Mk217 $cb[$k]); $r = & $g.t 'CREATE' @{ repo = $repo; title = $title; body = $gb }; Chk217 ('P3 CREATE malformed ' + $k + ' single call') (($r.ok -eq $false) -and (Cr217 $g) -eq 1 -and (Clean217)) }
foreach ($v in @(@('nonzero', (Mk217 $okUrl 1)), @('timeout', (Mk217 $okUrl 0 $true)), @('trunc', (Mk217 $okUrl 0 $false $true)))) { $g = Rig217 $v[1]; $r = & $g.t 'CREATE' @{ repo = $repo; title = $title; body = $gb }; Chk217 ('P3 CREATE ' + $v[0] + ' no success no retry') (($r.ok -eq $false) -and (Cr217 $g) -eq 1 -and (Clean217)) }

# ---- 218C integration (P2/P3/P4/P6) ----
if (-not $lc) { Chk217 'P6 lifecycle218C configured and hash-pinned' $false } else {
 $ev = Join-Path $work 'event.json'
 [System.IO.File]::WriteAllText($ev, (ConvertTo-Json -InputObject ([ordered]@{ schema = 'GitHubCreateEvent/v1'; taskId = $id; canonicalVersion = 1; publicTitle = $title; publicSummary = 'Initial summary'; publicStatus = 'IN_PROGRESS'; nextAction = 'RUN_FOCUSED_CHECKS' }) -Compress))
 $cfg = @{ repo = $repo; markerNamespace = 'factory-task' }
 $e0 = Pg217 @(); $none = Al217 @($e0)
 $g = Rig217 (Route217 (Rs217 $none) (Rs217 ($ub + '11')) (Rs217 (Vw217 -N 11 -U ($ub + '11'))))
 $o = Invoke-DurableGitHubTaskCreate -EventPath $ev -Configuration $cfg -StateDir (Join-Path $work 'stA') -Transport $g.t
 Chk217 'P3/P4 actual218C FIND-empty CREATE READ maps' (($o.status -ceq 'MAPPED') -and $o.code -ceq 'CREATED' -and $o.mapping.issueNumber -eq 11 -and $o.mapping.stableMarker -ceq $stable -and (Cr217 $g) -eq 1 -and $g.log.Count -eq 3)
 $g = Rig217 (Route217 (Rs217 $dup) (Rs217 ($ub + '11')) (Rs217 (Vw217 -N 11 -U ($ub + '11'))))
 $o = Invoke-DurableGitHubTaskCreate -EventPath $ev -Configuration $cfg -StateDir (Join-Path $work 'stB') -Transport $g.t
 Chk217 'P2 actual218C duplicate rendered marker zero CREATE' (($o.status -ceq 'REFUSED') -and $o.code -ceq 'LOOKUP_INCOMPLETE' -and (Cr217 $g) -eq 0)
 $sd = Join-Path $work 'stC'
 $g1 = Rig217 (Route217 (Rs217 $none) (Rs217 '' 0 $true) $null)
 $o1 = Invoke-DurableGitHubTaskCreate -EventPath $ev -Configuration $cfg -StateDir $sd -Transport $g1.t
 $g2 = Rig217 (Route217 (Rs217 $none) (Rs217 ($ub + '11')) (Rs217 (Vw217 -N 11 -U ($ub + '11'))))
 $o2 = Invoke-DurableGitHubTaskCreate -EventPath $ev -Configuration $cfg -StateDir $sd -Transport $g2.t
 Chk217 'P3 ambiguous CREATE then restart complete-zero lookup never repeats CREATE' (($o1.status -ceq 'UNKNOWN_SEND') -and (Cr217 $g1) -eq 1 -and $o2.status -ceq 'REFUSED' -and $o2.code -ceq 'AMBIGUOUS_NO_MATCH' -and (Cr217 $g2) -eq 0)
 $found = Al217 @((Pg217 @((Is217 12 'open' $gb))))
 $g = Rig217 (Route217 (Rs217 $found) $null (Rs217 (Vw217 -N 12 -U ($ub + '12'))))
 $g3 = Rig217 (Route217 (Rs217 $found) $null (Rs217 (Vw217 -N 12 -U ($ub + '12')))); $o3 = Invoke-DurableGitHubTaskCreate -EventPath $ev -Configuration $cfg -StateDir $sd -Transport $g3.t; Chk217 'P3 same stC ambiguous CREATE then restart found FIND+READ maps issue12 zero CREATE' (($o3.status -ceq 'MAPPED') -and $o3.mapping.issueNumber -eq 12 -and (Cr217 $g3) -eq 0); $o = Invoke-DurableGitHubTaskCreate -EventPath $ev -Configuration $cfg -StateDir (Join-Path $work 'stD') -Transport $g.t
 Chk217 'P4 colon taskId adoption via FIND+READ, no CREATE' (($o.status -ceq 'MAPPED') -and $o.code -ceq 'ADOPTED' -and $o.mapping.issueNumber -eq 12 -and (Cr217 $g) -eq 0)
}

# ---- P5 native helper with harmless non-model C# fixture ----
$src = Join-Path $work 'fixture217.cs'; $fx = Join-Path $work 'fixture217.exe'
$cs = @'
using System;
using System.IO;
using System.Threading;
public static class Fixture217 {
  static void Flood(Stream o) { var b = new byte[4096]; for (int i = 0; i < b.Length; i++) b[i] = 65; for (int i = 0; i < 64; i++) o.Write(b, 0, b.Length); o.Flush(); Thread.Sleep(20000); }
  public static int Main(string[] a) {
    string m = a.Length > 0 ? a[0] : "";
    if (m == "sleep") { Thread.Sleep(20000); return 0; }
    if (m == "stdout") { Flood(Console.OpenStandardOutput()); return 0; }
    if (m == "stderr") { Flood(Console.OpenStandardError()); return 0; }
    if (m == "argv") { for (int i = 1; i < a.Length; i++) { Console.Out.Write("ARG[" + a[i] + "]"); Console.Out.Write((char)10); } return 0; }
    Console.Out.Write("synthetic"); return 0;
  }
}
'@
[System.IO.File]::WriteAllText($src, $cs)
& $CompilerPath /nologo /target:exe ('/out:' + $fx) $src 2>&1 | Out-Null
$built = ($LASTEXITCODE -eq 0) -and [System.IO.File]::Exists($fx)
Chk217 'P5 fixture compiled with pinned compiler' $built
if ($built) {
 $fxSha = Sf217 $fx
 $names = 'exitCode,timedOut,stdout,stdoutTruncated,stderrTruncated'
 $r = Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 $fxSha -Arguments @('plain') -DeadlineMs 3000 -StdoutMaxBytes 1000 -StderrMaxBytes 1000
 Chk217 'P5 plain run exact shape' ((@($r.PSObject.Properties.Name) -join ',') -ceq $names -and $r.exitCode -eq 0 -and $r.stdout -ceq 'synthetic' -and -not $r.timedOut -and -not $r.stdoutTruncated -and -not $r.stderrTruncated)
 $sw = [System.Diagnostics.Stopwatch]::StartNew()
 $r = Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 $fxSha -Arguments @('sleep') -DeadlineMs 200 -StdoutMaxBytes 1000 -StderrMaxBytes 1000
 Chk217 'P5 deadline kills hung process' (($r.timedOut -eq $true) -and $sw.ElapsedMilliseconds -lt 10000)
 $gone = $false; for ($k = 0; $k -lt 30; $k++) { if (@(Get-Process -Name 'fixture217' -ErrorAction SilentlyContinue).Count -eq 0) { $gone = $true; break }; Start-Sleep -Milliseconds 100 }
 Chk217 'P5 no fixture process left after kill' $gone
 $sw.Restart()
 $r = Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 $fxSha -Arguments @('stdout') -DeadlineMs 3000 -StdoutMaxBytes 1000 -StderrMaxBytes 1000
 Chk217 'P5 stdout overflow truncates and kills' (($r.stdoutTruncated -eq $true) -and -not $r.timedOut -and $r.stdout.Length -le 1000 -and $sw.ElapsedMilliseconds -lt 3000)
 $sw.Restart()
 $r = Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 $fxSha -Arguments @('stderr') -DeadlineMs 3000 -StdoutMaxBytes 1000 -StderrMaxBytes 1000
 Chk217 'P5 stderr overflow marks and kills, stderr not returned' (($r.stderrTruncated -eq $true) -and -not $r.timedOut -and (@($r.PSObject.Properties.Name) -cnotcontains 'stderr') -and $sw.ElapsedMilliseconds -lt 3000)
 $av = @('a b', 'x;y&z', '$HOME', '%PATH%', '*', 'it''s', '')
 $r = Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 $fxSha -Arguments (@('argv') + $av) -DeadlineMs 3000 -StdoutMaxBytes 4096 -StderrMaxBytes 1000
 $exp = (($av | ForEach-Object { 'ARG[' + $_ + ']' + $nl }) -join '')
 Chk217 'P5 arguments literal, no shell' ($r.stdout -ceq $exp)
 Chk217 'P5 wrong executable pin throws' (Thr217 { Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 ('0' * 64) -Arguments @('plain') -DeadlineMs 1000 -StdoutMaxBytes 10 -StderrMaxBytes 10 })
 Chk217 'P5 deadline above 30000 refused' (Thr217 { Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 $fxSha -Arguments @('plain') -DeadlineMs 30001 -StdoutMaxBytes 10 -StderrMaxBytes 10 })
 Chk217 'P5 stderr cap above 65536 refused' (Thr217 { Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 $fxSha -Arguments @('plain') -DeadlineMs 1000 -StdoutMaxBytes 10 -StderrMaxBytes 65537 })
 Chk217 'P5 short hash refused' (Thr217 { Invoke-GitHubCliBoundedProcess216 -ExecutablePath $fx -ExpectedExecutableSha256 'abc' -Arguments @('plain') -DeadlineMs 1000 -StdoutMaxBytes 10 -StderrMaxBytes 10 })
 $dt = New-GitHubCliLifecycleTransport216 -GhPath $fx -ExpectedGhSha256 $fxSha -Repository $repo -TempRoot $script:tmp
 $r = & $dt 'READ' @{ repo = $repo; issueNumber = 5 }
 Chk217 'P5 default public runner wired, non-JSON output refused' ($r.ok -eq $false)
}

# ---- P6 receipt: counts and names only, no raw CLI output ----
$fails = @($script:res | Where-Object { -not $_.ok })
$rc = [ordered]@{ schema = 'GhProviderTests217Receipt/v1'; total = $script:res.Count; failed = $fails.Count; failedNames = @($fails | ForEach-Object { $_.n }); providerSha256 = $ep; ghSha256 = $eg; compilerSha256 = $ec }
[System.IO.File]::WriteAllText((Join-Path $work 'receipt217.json'), (ConvertTo-Json -InputObject $rc -Depth 4))
Write-Host ('TOTAL ' + $script:res.Count + ' FAILED ' + $fails.Count)
if ($fails.Count -gt 0) { exit 1 }
exit 0
