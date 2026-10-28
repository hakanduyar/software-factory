param([switch]$CycleChildB,[string]$ChildEnvelopePath,[string]$ExpectedChildEnvelopeSha256)
$Script:RC152Source = $PSCommandPath
$Script:RC152ReaderPath = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\host-continuation\registered-review-record-reader.ps1'
$Script:RC152ReaderSha = 'eebe9a02f7798efc8917e3c35d6c9d8e158d630e3c3a0007a7ebc201bb860abf'

function Get-RC152Hex {
    param([byte[]]$Bytes)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Test-RC152Sha {
    param($Value)
    return ($Value -is [string] -and $Value.Length -eq 64 -and $Value -cmatch '^[0-9a-f]+$')
}

function Get-RC152FileBytes {
    param([string]$Path, [string]$Sha)
    $i = [IO.FileInfo]::new($Path)
    if (-not $i.Exists -or (($i.Attributes -band 1040) -ne 0)) { throw 'invalid' }
    $b = [IO.File]::ReadAllBytes($Path)
    if ((Get-RC152Hex $b) -cne $Sha) { throw 'invalid' }
    return , $b
}

function ConvertTo-RC152Plain {
    param($V)
    if ($V -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $V.PSObject.Properties) { $h[[string]$p.Name] = ConvertTo-RC152Plain $p.Value }
        return $h
    }
    if ($V -is [System.Collections.IDictionary]) {
        $h = @{}
        foreach ($k in @($V.Keys)) { $h[[string]$k] = ConvertTo-RC152Plain $V[$k] }
        return $h
    }
    if ($V -is [System.Collections.IList]) {
        $a = [object[]]::new($V.Count)
        for ($n = 0; $n -lt $V.Count; $n++) { $a[$n] = ConvertTo-RC152Plain $V[$n] }
        return , $a
    }
    return $V
}

function New-RegisteredCycleSuccessorDispatch152 {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Spec)
    $ErrorActionPreference = 'Stop'
    $source = $Script:RC152Source
    $readerPath = $Script:RC152ReaderPath
    $readerSha = $Script:RC152ReaderSha
    $names = @('schema', 'requestPath', 'requestFileSha256', 'runDir', 'stateDir', 'powerShellPath', 'powerShellSha256', 'launcherPath', 'launcherSha256', 'hostPath', 'hostSha256', 'childEnvelopePath', 'startDeadlineMs')
    try {
        if ([string]::IsNullOrWhiteSpace($source)) { throw 'source' }
        if ($Spec -isnot [System.Management.Automation.PSCustomObject]) { throw 'spec' }
        $pr = @($Spec.PSObject.Properties)
        if ($pr.Count -ne 13) { throw 'spec' }
        foreach ($p in $pr) {
            if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty -or $names -cnotcontains $p.Name) { throw 'spec' }
        }
        if ([Collections.Generic.HashSet[string]]::new([string[]]@($pr.Name), [StringComparer]::Ordinal).Count -ne 13) { throw 'spec' }
        $v = @{}
        foreach ($n in $names) { $v[$n] = $Spec.$n }
        if ($v['schema'] -isnot [string] -or $v['schema'] -cne 'RegisteredCycleDispatchSpec/v1') { throw 'spec' }
        $q = [string][char]34
        foreach ($n in 'requestPath', 'runDir', 'stateDir', 'powerShellPath', 'launcherPath', 'hostPath', 'childEnvelopePath') {
            $s = $v[$n]
            if ($s -isnot [string] -or [string]::IsNullOrWhiteSpace($s) -or $s.IndexOf([char]0) -ge 0 -or $s.Contains($q)) { throw 'spec' }
            if (-not [IO.Path]::IsPathFullyQualified($s) -or [IO.Path]::GetFullPath($s) -cne $s) { throw 'spec' }
        }
        foreach ($n in 'requestFileSha256', 'powerShellSha256', 'launcherSha256', 'hostSha256') {
            if (-not (Test-RC152Sha $v[$n])) { throw 'spec' }
        }
        $dl = $v['startDeadlineMs']
        if (($dl -isnot [int] -and $dl -isnot [long]) -or $dl -le 0 -or $dl -gt 30000) { throw 'spec' }
        $deadline = [int]$dl

        # Verified reader (hash before and after load), then hash-bound request via accepted reader.
        $null = Get-RC152FileBytes $readerPath $readerSha
        . $readerPath
        $null = Get-RC152FileBytes $readerPath $readerSha
        $null = Get-RC152FileBytes $v['powerShellPath'] $v['powerShellSha256']
        $lb = Get-RC152FileBytes $v['launcherPath'] $v['launcherSha256']
        $hb = Get-RC152FileBytes $v['hostPath'] $v['hostSha256']
        $ht = [Text.UTF8Encoding]::new($false, $true).GetString($hb).TrimStart([char]0xFEFF)
        $pt = $null; $pe = $null
        $ha = [Management.Automation.Language.Parser]::ParseInput($ht, [ref]$pt, [ref]$pe)
        $fd = @($ha.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-HostAdmissionPhase' }, $true))
        if ($fd.Count -ne 1) { throw 'spec' }
        $hostBody = $fd[0].Extent.Text
        $rr = Read-RegisteredReviewRecord -Path $v['requestPath'] -ExpectedSha256 $v['requestFileSha256']
        $rb = [byte[]]$rr.bytes
        $off = 0
        if ($rb.Length -ge 3 -and $rb[0] -eq 0xEF -and $rb[1] -eq 0xBB -and $rb[2] -eq 0xBF) { $off = 3 }
        $txt = [Text.UTF8Encoding]::new($false, $true).GetString($rb, $off, $rb.Length - $off)
        $req = ConvertTo-RC152Plain (ConvertFrom-Json -InputObject $txt -AsHashtable -DateKind String -NoEnumerate)
        if ($req -isnot [hashtable]) { throw 'request' }
        foreach ($k in 'RunId', 'TicketPath', 'PayloadPath', 'GateTicketPath', 'SettingsPath', 'ArtifactPath', 'WorkingDirectory', 'MaxElapsedMs', 'MaxStreamBytes', 'Attempt') {
            if (-not $req.ContainsKey($k)) { throw 'request' }
        }
        if ($req['RunId'] -isnot [string] -or [string]::IsNullOrWhiteSpace($req['RunId'])) { throw 'request' }
        $paths = @{}
        $shas = @{}
        foreach ($k in 'TicketPath', 'PayloadPath', 'GateTicketPath', 'SettingsPath', 'ArtifactPath', 'WorkingDirectory') {
            $pv = $req[$k]
            if ($pv -isnot [string] -or [string]::IsNullOrWhiteSpace($pv) -or -not [IO.Path]::IsPathFullyQualified($pv)) { throw 'request' }
            $paths[$k] = [IO.Path]::GetFullPath($pv)
        }
        foreach ($k in 'TicketPath', 'PayloadPath', 'GateTicketPath', 'SettingsPath') {
            $shas[$k] = Get-RC152Hex ([IO.File]::ReadAllBytes($paths[$k]))
        }
        $ticket = [IO.File]::ReadAllText($paths['TicketPath']) | ConvertFrom-Json -DateKind String
        foreach ($f in 'id', 'owner') {
            if ($ticket.$f -isnot [string] -or [string]::IsNullOrWhiteSpace($ticket.$f)) { throw 'ticket' }
        }
        if ($ticket.id -cne $req['RunId']) { throw 'ticket' }
        # Executable pin: Script:PinnedExecutable literal from the hash-verified launcher bytes, parsed (never imported) before any launch.
        $lt = [Text.UTF8Encoding]::new($false, $true).GetString($lb).TrimStart([char]0xFEFF)
        $lpt = $null; $lpe = $null
        $la = [Management.Automation.Language.Parser]::ParseInput($lt, [ref]$lpt, [ref]$lpe)
        if (@($lpe).Count -ne 0) { throw 'spec' }
        $pins = @($la.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left -is [Management.Automation.Language.VariableExpressionAst] -and $n.Left.VariablePath.UserPath -ieq 'Script:PinnedExecutable' }, $true))
        if ($pins.Count -ne 1) { throw 'spec' }
        $pr0 = $pins[0]
        if ($pr0.Operator -ne [Management.Automation.Language.TokenKind]::Equals -or $pr0.Right -isnot [Management.Automation.Language.CommandExpressionAst]) { throw 'spec' }
        $pl = $pr0.Right.Expression
        if ($pl -isnot [Management.Automation.Language.StringConstantExpressionAst] -or $pl.StringConstantType -ne [Management.Automation.Language.StringConstantType]::SingleQuoted) { throw 'spec' }
        $exe = [string]$pl.Value
        if ([string]::IsNullOrWhiteSpace($exe) -or $exe.IndexOf([char]0) -ge 0 -or -not [IO.Path]::IsPathFullyQualified($exe)) { throw 'spec' }
        $stateDir = [IO.Path]::TrimEndingDirectorySeparator($v['stateDir'])
        $cfg = @{
            request = $req; paths = $paths; shas = $shas; ticketId = [string]$ticket.id; ticketOwner = [string]$ticket.owner
            runDir = $v['runDir']; stateDir = $stateDir; statePath = (Join-Path $stateDir 'continuation-state.json')
            pwsh = $v['powerShellPath']; launcherPath = $v['launcherPath']; launcherSha = $v['launcherSha256']
            hostPath = $v['hostPath']; hostSha = $v['hostSha256']; envPath = $v['childEnvelopePath']; deadline = $deadline; source = $source; exe = $exe; hostFn = $hostBody
        }
    } catch {
        throw 'REGISTERED_CYCLE_DISPATCH_SPEC_INVALID'
    }

    $run = {
        param($C, $Sel)
        $fail = { param($m) throw ('REGISTERED_CYCLE_DISPATCH_REFUSED:' + $m) }
        $unres = { param($m) throw ('REGISTERED_CYCLE_DISPATCH_UNRESOLVED:' + $m) }
        $fields = @('id', 'owner', 'claimId', 'intentId', 'receiptSha', 'planSha', 'statePath')
        if ($Sel -isnot [System.Management.Automation.PSCustomObject]) { & $fail 'selected' }
        $sp = @($Sel.PSObject.Properties)
        if ($sp.Count -ne 10) { & $fail 'selected' }
        foreach ($p in $sp) {
            if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty -or @($fields + @('kind', 'provider', 'route')) -cnotcontains $p.Name) { & $fail 'selected' }
        }
        if ([Collections.Generic.HashSet[string]]::new([string[]]@($sp.Name), [StringComparer]::Ordinal).Count -ne 10) { & $fail 'selected' }
        foreach ($x in 'kind', 'provider', 'route') {
            $xv = $Sel.$x
            if ($xv -isnot [string] -or [string]::IsNullOrWhiteSpace($xv)) { & $fail 'selected' }
        }
        $cl = [ordered]@{}
        foreach ($f in $fields) {
            if (@($sp.Name) -cnotcontains $f) { & $fail 'selected' }
            $fv = $Sel.$f
            if ($fv -isnot [string] -or [string]::IsNullOrWhiteSpace($fv)) { & $fail 'selected' }
            if (($f -ceq 'receiptSha' -or $f -ceq 'planSha') -and -not (Test-RC152Sha $fv)) { & $fail 'selected' }
            $cl[$f] = $fv
        }
        if ($cl['id'] -cne $C.request['RunId'] -or $cl['id'] -cne $C.ticketId -or $cl['owner'] -cne $C.ticketOwner) { & $fail 'binding' }
        if ([IO.Path]::GetFullPath($cl['statePath']) -cne $C.statePath) { & $fail 'binding' }

        # Real host admission phase, from the pinned host file already imported by the actual host.
        $cmd = @(Get-Command -Name Assert-HostAdmissionPhase -CommandType Function -ErrorAction SilentlyContinue)[0]
        if ($null -eq $cmd -or $cmd.ScriptBlock.File -ine $C.hostPath) { & $fail 'phase' }
        try {
            $null = Get-RC152FileBytes $C.hostPath $C.hostSha
            if ($cmd.ScriptBlock.Ast.Extent.Text -cne $C.hostFn) { throw 'phase' }
            $null = & $cmd -StateDir $C.stateDir -Phase @('CALLBACK')
        } catch { & $fail 'phase' }

        # Existing evidence or envelope conflicts refuse; never start a second child.
        $manifestPath = Join-Path $C.runDir 'manifest.json'
        $startPath = Join-Path $C.runDir 'start.json'
        if ((Test-Path -LiteralPath $manifestPath) -or (Test-Path -LiteralPath $startPath) -or (Test-Path -LiteralPath $C.envPath)) { & $fail 'existing-evidence' }

        $envObj = [ordered]@{
            schema = 'RegisteredCycleChildEnvelope/v1'; Request = $C.request; RunDir = $C.runDir
            StartAcknowledgementContext = [ordered]@{ StateDir = $C.stateDir; SelectedClaim = $cl; TaskId = $C.ticketId }
            LauncherPath = $C.launcherPath; LauncherSha256 = $C.launcherSha
        }
        $envBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $envObj -Compress -Depth 8))
        $envSha = Get-RC152Hex $envBytes
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($C.envPath))
        $fs = [IO.FileStream]::new($C.envPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $fs.Write($envBytes, 0, $envBytes.Length) } finally { $fs.Dispose() }

        $qq = [string][char]34
        $argv = @('-NoProfile', '-File', ($qq + $C.source + $qq), '-CycleChildB', '-ChildEnvelopePath', ($qq + $C.envPath + $qq), '-ExpectedChildEnvelopeSha256', $envSha)
        $proc = Start-Process -FilePath $C.pwsh -ArgumentList $argv -WindowStyle Hidden -PassThru

        $sw = [Diagnostics.Stopwatch]::StartNew()
        $start = $null; $man = $null
        while ($sw.ElapsedMilliseconds -lt $C.deadline) {
            if ((Test-Path -LiteralPath $startPath -PathType Leaf) -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
                try {
                    $start = [IO.File]::ReadAllText($startPath) | ConvertFrom-Json -DateKind String
                    $man = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json -DateKind String
                    break
                } catch { $start = $null; $man = $null }
            }
            if ($proc.HasExited) { & $unres 'child-exited-before-start' }
            Start-Sleep -Milliseconds 25
        }
        if ($null -eq $start -or $null -eq $man) { & $unres 'start-deadline' }

        try {
            if (@($start.PSObject.Properties).Count -ne 7 -or @($man.PSObject.Properties).Count -ne 6) { throw 'shape' }
            if ($start.schema -cne 'ManagedNativeStart/v1' -or $man.schema -cne 'ManagedNativeCollector/v1') { throw 'schema' }
            if ($man.requestCanonical -isnot [string] -or $man.requestSha256 -isnot [string]) { throw 'manifest' }
            $canonSha = Get-RC152Hex ([Text.UTF8Encoding]::new($false).GetBytes($man.requestCanonical))
            if ($man.requestSha256 -cne $canonSha -or $start.requestSha256 -cne $canonSha) { throw 'hash' }
            $core = ConvertFrom-Json -InputObject $man.requestCanonical -DateKind String
            $rq = $C.request
            if ($core.schema -cne 'ManagedNativeCollector/v1' -or $core.runId -cne $rq['RunId'] -or $core.attempt -ne $rq['Attempt']) { throw 'core' }
            if ($start.runId -cne $core.runId -or $start.attempt -ne $core.attempt) { throw 'start' }
            if ($core.executable -isnot [string] -or -not [IO.Path]::IsPathRooted($core.executable) -or $core.executable -cne $C.exe) { throw 'exe' }
            if ((ConvertTo-Json -InputObject @($core.arguments) -Compress) -cne (ConvertTo-Json -InputObject @($rq['Arguments']) -Compress)) { throw 'argv' }
            if ($core.workingDirectory -cne $C.paths['WorkingDirectory'] -or $core.artifactPath -cne $C.paths['ArtifactPath']) { throw 'paths' }
            if ($core.ticketPath -cne $C.paths['TicketPath'] -or $core.payloadPath -cne $C.paths['PayloadPath'] -or $core.gateTicketPath -cne $C.paths['GateTicketPath'] -or $core.settingsPath -cne $C.paths['SettingsPath']) { throw 'paths' }
            if ($core.ticketSha256 -cne $C.shas['TicketPath'] -or $core.payloadSha256 -cne $C.shas['PayloadPath'] -or $core.gateTicketSha256 -cne $C.shas['GateTicketPath'] -or $core.settingsSha256 -cne $C.shas['SettingsPath']) { throw 'hashes' }
            $rqProfile = $false
            foreach ($rk in @($rq.Keys)) { if ($rk -is [string] -and [string]::Equals($rk, 'OutputStopProfile', [StringComparison]::Ordinal)) { $rqProfile = $true } }
            if ($rqProfile) {
                # Observe-only B: exact profile selector, null stream cap on both sides (no numeric stand-in) and the collector-authenticated descriptor carried in the captured core.
                if ($rq['OutputStopProfile'] -isnot [string] -or $rq['OutputStopProfile'] -cne 'observe-only-v1' -or $null -ne $rq['MaxStreamBytes']) { throw 'limits' }
                if ($core.maxElapsedMs -ne $rq['MaxElapsedMs']) { throw 'limits' }
                if ($null -eq $core.PSObject.Properties['maxStreamBytes'] -or $null -ne $core.maxStreamBytes) { throw 'limits' }
                if ($null -eq $core.PSObject.Properties['outputStopProfile'] -or $core.outputStopProfile -isnot [string] -or $core.outputStopProfile -cne 'observe-only-v1') { throw 'limits' }
                if ($null -eq $core.PSObject.Properties['outputStopAuthority'] -or $null -eq $core.outputStopAuthority) { throw 'limits' }
            }
            elseif ($core.maxElapsedMs -ne $rq['MaxElapsedMs'] -or $core.maxStreamBytes -ne $rq['MaxStreamBytes']) { throw 'limits' }
            if ([IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($core.runDir)) -cne [IO.Path]::TrimEndingDirectorySeparator($C.runDir)) { throw 'rundir' }
            if ($core.ackMode -ne $true -or $core.ackContext.stateDir -cne $C.stateDir -or $core.ackContext.taskId -cne $C.ticketId) { throw 'ack' }
            foreach ($f in $fields) { if ($core.ackContext.claim.$f -cne $cl[$f]) { throw 'claim' } }
            if (@($core.ackContext.claim.PSObject.Properties).Count -ne 7) { throw 'claim' }
            if ($start.pid -isnot [int] -and $start.pid -isnot [long]) { throw 'pid' }
            $nativePid = [int]$start.pid
            if ($nativePid -eq $proc.Id -or $start.startTimeUtc -isnot [string]) { throw 'wrapper-pid' }
            $np = Get-Process -Id $nativePid -ErrorAction Stop
            if ($np.HasExited -or $np.StartTime.ToUniversalTime().ToString('o') -cne $start.startTimeUtc) { throw 'native-dead' }
        } catch {
            & $unres 'native-identity'
        }

        $ack = [PSCustomObject]@{ claimId = $cl['claimId']; owner = $cl['owner']; intentId = $cl['intentId']; dispatchedAt = [string]$start.startTimeUtc }
        $binding = [PSCustomObject]@{
            schema = 'host-dispatch-execution-binding/v1'; taskId = $C.ticketId
            ticketSha256 = $C.shas['TicketPath']; payloadSha256 = $C.shas['PayloadPath']
            runId = [string]$start.runId; attempt = $start.attempt; receiptSha = $cl['receiptSha']; planSha = $cl['planSha']
            identity = [PSCustomObject]@{ kind = 'native'; pid = $nativePid; startIdentity = [string]$start.startTimeUtc }
        }
        return [PSCustomObject]@{ Acknowledgement = $ack; ExecutionBinding = $binding }
    }
    $sb = { param($SelectedClaim) & $run $cfg $SelectedClaim }.GetNewClosure()
    return $sb
}

function Invoke-RegisteredCycleChildCollector152 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$EnvelopePath,
        [Parameter(Mandatory = $true)][string]$ExpectedEnvelopeSha256
    )
    $ErrorActionPreference = 'Stop'
    try {
        if (-not (Test-RC152Sha $ExpectedEnvelopeSha256) -or -not [IO.Path]::IsPathFullyQualified($EnvelopePath)) { throw 'envelope' }
        $b = Get-RC152FileBytes ([IO.Path]::GetFullPath($EnvelopePath)) $ExpectedEnvelopeSha256
        $e = ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false, $true).GetString($b)) -AsHashtable -DateKind String -NoEnumerate
        $keys = @('schema', 'Request', 'RunDir', 'StartAcknowledgementContext', 'LauncherPath', 'LauncherSha256')
        if ($e -isnot [hashtable] -or $e.Count -ne 6) { throw 'envelope' }
        foreach ($k in $keys) { if (-not $e.ContainsKey($k)) { throw 'envelope' } }
        if ($e['schema'] -cne 'RegisteredCycleChildEnvelope/v1' -or $e['Request'] -isnot [hashtable] -or $e['RunDir'] -isnot [string]) { throw 'envelope' }
        if ($e['LauncherPath'] -isnot [string] -or -not (Test-RC152Sha $e['LauncherSha256'])) { throw 'envelope' }
        $c = $e['StartAcknowledgementContext']
        if ($c -isnot [hashtable] -or $c.Count -ne 3 -or $c['SelectedClaim'] -isnot [hashtable] -or $c['SelectedClaim'].Count -ne 7) { throw 'envelope' }
        $sc = [ordered]@{}
        foreach ($f in 'id', 'owner', 'claimId', 'intentId', 'receiptSha', 'planSha', 'statePath') {
            if (-not $c['SelectedClaim'].ContainsKey($f)) { throw 'envelope' }
            $sc[$f] = $c['SelectedClaim'][$f]
        }
        $ctx = @{ StateDir = $c['StateDir']; SelectedClaim = [PSCustomObject]$sc; TaskId = $c['TaskId'] }
        $lp = $e['LauncherPath']
        $null = Get-RC152FileBytes $lp $e['LauncherSha256']
        . $lp
        $null = Get-RC152FileBytes $lp $e['LauncherSha256']
    } catch {
        throw 'REGISTERED_CYCLE_CHILD_ENVELOPE_INVALID'
    }
    Invoke-ManagedNativeCollector -Request $e['Request'] -RunDir $e['RunDir'] -StartAcknowledgementContext $ctx
}

function Assert-RC152StrictJson {
    param([string]$Text)
    $o = [Text.Json.JsonDocumentOptions]::new()
    $o.MaxDepth = 16
    $d = [Text.Json.JsonDocument]::Parse($Text, $o)
    try {
        $stack = [Collections.Generic.Stack[Text.Json.JsonElement]]::new()
        $stack.Push($d.RootElement)
        while ($stack.Count -gt 0) {
            $e = $stack.Pop()
            if ($e.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
                $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
                foreach ($p in $e.EnumerateObject()) {
                    if (-not $seen.Add($p.Name)) { throw 'json' }
                    $stack.Push($p.Value)
                }
            } elseif ($e.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
                foreach ($i in $e.EnumerateArray()) { $stack.Push($i) }
            }
        }
    } finally { $d.Dispose() }
}

function Read-RC152PinnedJson {
    param([string]$Path, [string]$Sha, [bool]$AsHashtable)
    $b = Get-RC152FileBytes $Path $Sha
    $t = [Text.UTF8Encoding]::new($false, $true).GetString($b).TrimStart([char]0xFEFF)
    if ($b.Length -gt 65536) { throw 'invalid' }
    Assert-RC152StrictJson $t
    if ($AsHashtable) { return ConvertTo-RC152Plain (ConvertFrom-Json -InputObject $t -AsHashtable -DateKind String -NoEnumerate) }
    return ConvertFrom-Json -InputObject $t -DateKind String -NoEnumerate
}

function Test-RC152Exact {
    param($Object, [string[]]$Names)
    if ($Object -isnot [System.Management.Automation.PSCustomObject]) { return $false }
    $pr = @($Object.PSObject.Properties)
    if ($pr.Count -ne $Names.Count) { return $false }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($p in $pr) {
        if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty -or $Names -cnotcontains $p.Name -or -not $seen.Add($p.Name)) { return $false }
    }
    return $true
}

function Test-RC152Text {
    param($V)
    return ($V -is [string] -and -not [string]::IsNullOrWhiteSpace($V))
}

function Test-RC152Path {
    param($V)
    return ((Test-RC152Text $V) -and $V.IndexOf([char]0) -lt 0 -and [IO.Path]::IsPathFullyQualified($V) -and [IO.Path]::GetFullPath($V) -ceq $V)
}

function Get-RC152Configuration {
    param([string]$Path, [string]$Sha)
    $names = @('schema', 'registrationPath', 'registrationSha256', 'requestPath', 'requestSha256', 'aSelectedClaimPath', 'aSelectedClaimSha256', 'lateAuthorizationPath', 'callbackPath', 'callbackSha256', 'dependencies', 'owner')
    $c = Read-RC152PinnedJson $Path $Sha $false
    if (-not (Test-RC152Exact $c $names)) { throw 'config' }
    $v = @{}
    foreach ($n in $names) { $v[$n] = $c.PSObject.Properties[$n].Value }
    if ($v['schema'] -isnot [string] -or $v['schema'] -cne 'RegisteredUsefulCycleConfiguration/v1' -or -not (Test-RC152Text $v['owner'])) { throw 'config' }
    foreach ($n in 'registrationPath', 'requestPath', 'aSelectedClaimPath', 'lateAuthorizationPath', 'callbackPath') { if (-not (Test-RC152Path $v[$n])) { throw 'config' } }
    foreach ($n in 'registrationSha256', 'requestSha256', 'aSelectedClaimSha256', 'callbackSha256') { if (-not (Test-RC152Sha $v[$n])) { throw 'config' } }
    $d = $v['dependencies']
    if ($d -isnot [object[]] -or $d.Count -lt 1) { throw 'config' }
    $deps = [Collections.Generic.List[object]]::new()
    foreach ($x in $d) {
        if ($x -isnot [System.Management.Automation.PSCustomObject]) { throw 'config' }
        $xn = @($x.PSObject.Properties.Name)
        foreach ($q in $xn) { if (@('path', 'sha256', 'length') -cnotcontains $q) { throw 'config' } }
        if ($xn -cnotcontains 'path' -or $xn -cnotcontains 'sha256') { throw 'config' }
        if (-not (Test-RC152Path $x.path) -or -not (Test-RC152Sha $x.sha256)) { throw 'config' }
        $deps.Add(@{ path = [string]$x.path; sha = [string]$x.sha256 })
    }
    $v['dependencies'] = $deps.ToArray()
    return $v
}

function Get-RC152LateAuthorization {
    param([scriptblock]$Provider, [string]$RegistrationSha256)
    $ErrorActionPreference = 'Stop'
    try {
        $raw = @(& $Provider)
        if ($raw.Count -ne 1 -or -not (Test-RC152Exact $raw[0] @('Bytes', 'ExpectedSha256'))) { throw 'snapshot' }
        $src = $raw[0].PSObject.Properties['Bytes'].Value
        $exp = $raw[0].PSObject.Properties['ExpectedSha256'].Value
        if ($src -isnot [byte[]] -or $src.Length -lt 1 -or $src.Length -gt 65536 -or -not (Test-RC152Sha $exp)) { throw 'snapshot' }
        $bytes = [byte[]]$src.Clone()
        if ((Get-RC152Hex $bytes) -cne $exp) { throw 'snapshot' }
        $lt = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xFEFF)
        Assert-RC152StrictJson $lt
        $j = ConvertTo-RC152Plain (ConvertFrom-Json -InputObject $lt -AsHashtable -DateKind String -NoEnumerate)
        if ($j -isnot [hashtable] -or $j.Count -ne 6) { throw 'late' }
        foreach ($k in 'schema', 'registrationSha256', 'recipePath', 'recipeSha256', 'terminalBindingSha256', 'reviewCompletionSha256') { if (@($j.Keys) -cnotcontains $k) { throw 'late' } }
        if ($j['schema'] -isnot [string] -or $j['schema'] -cne 'RegisteredUsefulCycleLateAuthorization/v1') { throw 'late' }
        foreach ($k in 'registrationSha256', 'recipeSha256', 'terminalBindingSha256', 'reviewCompletionSha256') { if (-not (Test-RC152Sha $j[$k])) { throw 'late' } }
        if ($j['registrationSha256'] -cne $RegistrationSha256 -or -not (Test-RC152Path $j['recipePath'])) { throw 'late' }
        return [pscustomobject]@{ Sha256 = [string]$exp; Late = $j }
    } catch {
        throw 'REGISTERED_USEFUL_CYCLE_LATE_AUTHORIZATION_PENDING'
    }
}

function Get-RC152Recipe {
    param([hashtable]$Late)
    $ErrorActionPreference = 'Stop'
    try {
        $r = Read-RC152PinnedJson $Late['recipePath'] $Late['recipeSha256'] $true
        if ($r -isnot [hashtable] -or $r.Count -ne 10) { throw 'recipe' }
        foreach ($k in 'HostArguments', 'ExpectedSuccessor', 'BRequestPath', 'BRequestSha256', 'BRunDir', 'PowerShellExecutable', 'PowerShellExecutableSha256', 'ChildEnvelopePath', 'ChildResultPath', 'startDeadlineMs') { if (@($r.Keys) -cnotcontains $k) { throw 'recipe' } }
        if (-not (Test-RC152Path $r['ChildResultPath'])) { throw 'recipe' }
        if ($r['HostArguments'] -is [hashtable] -and $r['HostArguments'].ContainsKey('AllocationContexts')) {
            $typed = Read-RC152PinnedJson $Late['recipePath'] $Late['recipeSha256'] $false
            $typedHost = $typed.HostArguments
            if ($null -eq $typedHost -or $null -eq $typedHost.PSObject.Properties['AllocationContexts']) { throw 'recipe' }
            $typedContexts = $typedHost.PSObject.Properties['AllocationContexts'].Value
            if ($typedContexts -isnot [object[]]) { throw 'recipe' }
            $r['HostArguments']['AllocationContexts'] = $typedContexts
        }
        $rt0 = $null
        if ($r['HostArguments'] -is [hashtable] -and $r['HostArguments']['TerminalArguments'] -is [hashtable]) { $rt0 = $r['HostArguments']['TerminalArguments'] }
        if ($null -ne $rt0 -and @($rt0.Keys | Where-Object { $_ -is [string] -and $_ -ceq 'ObserveOnlyReviewedCompletionEvidence' }).Count -gt 0) {
            # Strict ordinal typed reread of the proof from the same pinned bytes; no hashtable-to-object coercion of nested values.
            $typed2 = Read-RC152PinnedJson $Late['recipePath'] $Late['recipeSha256'] $false
            $typedTa = $typed2.HostArguments.PSObject.Properties['TerminalArguments'].Value
            $typedEv = $typedTa.PSObject.Properties['ObserveOnlyReviewedCompletionEvidence'].Value
            if (-not (Test-RC152Exact $typedEv @('schema', 'accountingEvidence', 'registrationRef', 'terminalBindingRef', 'reviewCompletionRef'))) { throw 'recipe' }
            if ($typedEv.schema -isnot [string] -or $typedEv.schema -cne 'ManagedObserveReviewedCompletionEvidence/v1') { throw 'recipe' }
            foreach ($rn in 'registrationRef', 'terminalBindingRef', 'reviewCompletionRef') {
                $rf = $typedEv.PSObject.Properties[$rn].Value
                if (-not (Test-RC152Exact $rf @('path', 'sha256')) -or -not (Test-RC152Path $rf.path) -or -not (Test-RC152Sha $rf.sha256)) { throw 'recipe' }
            }
            $rt0['ObserveOnlyReviewedCompletionEvidence'] = $typedEv
        }
        return $r
    } catch {
        throw 'REGISTERED_USEFUL_CYCLE_RECIPE_INVALID'
    }
}

function New-RegisteredUsefulCycleCallbacks152 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ConfigurationPath,
        [Parameter(Mandatory = $true)][string]$ExpectedConfigurationSha256,
        [Parameter(Mandatory = $true)][scriptblock]$TrustedLateSnapshotProvider
    )
    $ErrorActionPreference = 'Stop'
    # Original provider handle is captured by reference before any import or IO and is never invoked here.
    $provider = $TrustedLateSnapshotProvider
    try {
        $pa = $provider.Ast
        if ($null -ne $pa.ParamBlock -and @($pa.ParamBlock.Parameters).Count -gt 0) { throw 'provider' }
        if ($pa.Parent -is [Management.Automation.Language.FunctionDefinitionAst] -and @($pa.Parent.Parameters).Count -gt 0) { throw 'provider' }
        if (-not (Test-RC152Sha $ExpectedConfigurationSha256) -or -not [IO.Path]::IsPathFullyQualified($ConfigurationPath)) { throw 'config' }

        # All typed capture and validation happens before any import.
        $cfg = Get-RC152Configuration $ConfigurationPath $ExpectedConfigurationSha256
        $rn = @('schema', 'registrationId', 'taskId', 'attempt', 'requestPath', 'requestSha256', 'runDir', 'ticketPath', 'ticketSha256', 'payloadPath', 'payloadSha256', 'candidatePath', 'terminalBindingPath', 'reviewCompletionPath', 'automationId', 'automationTargetThreadId', 'periodMinutes', 'registeredActionId')
        $rg = Read-RC152PinnedJson $cfg['registrationPath'] $cfg['registrationSha256'] $false
        if (-not (Test-RC152Exact $rg $rn)) { throw 'registration' }
        $reg = @{}
        foreach ($n in $rn) { $reg[$n] = $rg.PSObject.Properties[$n].Value }
        foreach ($n in $rn) {
            if ($n -ceq 'attempt') { if (($reg[$n] -isnot [int] -and $reg[$n] -isnot [long]) -or $reg[$n] -lt 1) { throw 'registration' } }
            elseif ($n -ceq 'periodMinutes') { if (($reg[$n] -isnot [int] -and $reg[$n] -isnot [long]) -or $reg[$n] -ne 20) { throw 'registration' } }
            elseif (-not (Test-RC152Text $reg[$n])) { throw 'registration' }
        }
        if ($reg['schema'] -cne 'RegisteredReviewReplay/v1' -or $reg['requestPath'] -cne $cfg['requestPath'] -or $reg['requestSha256'] -cne $cfg['requestSha256']) { throw 'registration' }
        foreach ($n in 'requestSha256', 'ticketSha256', 'payloadSha256') { if (-not (Test-RC152Sha $reg[$n])) { throw 'registration' } }
        foreach ($n in 'requestPath', 'runDir', 'ticketPath', 'payloadPath', 'candidatePath', 'terminalBindingPath', 'reviewCompletionPath') { if (-not (Test-RC152Path $reg[$n])) { throw 'registration' } }

        $req = Read-RC152PinnedJson $cfg['requestPath'] $cfg['requestSha256'] $true
        if ($req -isnot [hashtable] -or $req['RunId'] -isnot [string] -or $req['RunId'] -cne $reg['taskId']) { throw 'request' }
        if (($req['Attempt'] -isnot [int] -and $req['Attempt'] -isnot [long]) -or $req['Attempt'] -ne $reg['attempt'] -or -not (Test-RC152Text $req['ArtifactPath'])) { throw 'request' }
        foreach ($pk in @(@('TicketPath', 'ticketPath'), @('PayloadPath', 'payloadPath'), @('ArtifactPath', 'candidatePath'))) {
            if ($req[$pk[0]] -isnot [string] -or $req[$pk[0]] -cne $reg[$pk[1]]) { throw 'request' }
        }
        $null = Get-RC152FileBytes $reg['ticketPath'] $reg['ticketSha256']
        $null = Get-RC152FileBytes $reg['payloadPath'] $reg['payloadSha256']

        $sn = @('id', 'owner', 'claimId', 'intentId', 'receiptSha', 'planSha', 'statePath', 'kind', 'provider', 'route')
        $sc = Read-RC152PinnedJson $cfg['aSelectedClaimPath'] $cfg['aSelectedClaimSha256'] $false
        if (-not (Test-RC152Exact $sc $sn)) { throw 'selected' }
        foreach ($n in $sn) { if (-not (Test-RC152Text $sc.PSObject.Properties[$n].Value)) { throw 'selected' } }
        if ($sc.id -cne $reg['taskId'] -or -not (Test-RC152Sha $sc.receiptSha) -or -not (Test-RC152Sha $sc.planSha) -or -not (Test-RC152Path $sc.statePath)) { throw 'selected' }
        $stateDir = [IO.Path]::GetDirectoryName($sc.statePath)
        if ([string]::IsNullOrWhiteSpace($stateDir) -or $sc.statePath -cne (Join-Path $stateDir 'continuation-state.json')) { throw 'selected' }
        $ackPath = Join-Path $stateDir 'host-dispatch-acknowledgements.json'

        $deps = $cfg['dependencies']
        $pick = {
            param($leaf)
            $m = @($deps | Where-Object { [IO.Path]::GetFileName($_.path) -ceq $leaf })
            if ($m.Count -ne 1) { throw 'dependency' }
            $m[0]
        }
        if (@($deps | Where-Object { $_.path -ceq $cfg['callbackPath'] -and $_.sha -ceq $cfg['callbackSha256'] }).Count -ne 1) { throw 'dependency' }
        $handDep = & $pick 'verified-reviewed-handoff141.ps1'
        $hostDep = & $pick 'select-next-ready.ps1'
        $launchDep = & $pick 'launch.ps1'
        if ([IO.Path]::GetDirectoryName($handDep.path) -ine [IO.Path]::GetDirectoryName($hostDep.path)) { throw 'dependency' }

        # Every source pin is verified before the first import; the callback recipe is pinned again around its load.
        foreach ($d in $deps) { $null = Get-RC152FileBytes $d.path $d.sha }
        $cbPath = $cfg['callbackPath']
        $cbSha = $cfg['callbackSha256']
        . $cbPath
        $null = Get-RC152FileBytes $cbPath $cbSha
        $cb = @(Get-Command -Name New-GenuineTerminalCallback134 -CommandType Function -ErrorAction SilentlyContinue)
        if ($cb.Count -ne 1 -or $cb[0].ScriptBlock.File -ine $cbPath) { throw 'callback' }

        $ex = @{
            Provider = $provider; RegistrationSha = $cfg['registrationSha256']; Owner = $cfg['owner']; StateDir = $stateDir
            ExpKeys = @('taskId', 'owner', 'receiptSha256', 'planSha256', 'ticketSha256', 'payloadSha256', 'runId', 'attempt', 'stateDir', 'runDir')
            HandoffPath = $handDep.path; HandoffSha = $handDep.sha; HostPath = $hostDep.path; HostSha = $hostDep.sha
            LauncherPath = $launchDep.path; LauncherSha = $launchDep.sha
            GetLate = (Get-Command -Name Get-RC152LateAuthorization -CommandType Function).ScriptBlock
            GetRecipe = (Get-Command -Name Get-RC152Recipe -CommandType Function).ScriptBlock
            NewDispatch = (Get-Command -Name New-RegisteredCycleSuccessorDispatch152 -CommandType Function).ScriptBlock
        }

        $body = {
            param($E, $Binding)
            $ErrorActionPreference = 'Stop'
            try {
                if ($Binding -isnot [System.Management.Automation.PSCustomObject]) { throw 'binding' }
                # Provider is invoked only here, after A, once per consumer.
                $la = & $E.GetLate -Provider $E.Provider -RegistrationSha256 $E.RegistrationSha
                $late = $la.Late
                if ($Binding.registrationFileSha256 -cne $E.RegistrationSha -or $Binding.terminalBindingFileSha256 -cne $late['terminalBindingSha256'] -or $Binding.reviewCompletionFileSha256 -cne $late['reviewCompletionSha256']) { throw 'binding' }
                $r = & $E.GetRecipe -Late $late
                $ha = $r['HostArguments']
                $es = $r['ExpectedSuccessor']
                if ($ha -isnot [hashtable] -or $es -isnot [hashtable] -or $es.Count -ne 10 -or $ha.ContainsKey('Dispatch') -or $ha['PreviousSelectedClaim'] -isnot [hashtable]) { throw 'recipe' }
                $eo = [ordered]@{}
                foreach ($k in $E.ExpKeys) {
                    if (@($es.Keys) -cnotcontains $k) { throw 'recipe' }
                    $eo[$k] = $es[$k]
                }
                if ($eo['owner'] -cne $E.Owner -or $eo['stateDir'] -cne $E.StateDir -or $ha['Owner'] -cne $E.Owner -or $ha['StateDir'] -cne $E.StateDir) { throw 'recipe' }
                $esO = [pscustomobject]$eo

                $spec = [pscustomobject][ordered]@{
                    schema = 'RegisteredCycleDispatchSpec/v1'; requestPath = $r['BRequestPath']; requestFileSha256 = $r['BRequestSha256']
                    runDir = $r['BRunDir']; stateDir = $E.StateDir; powerShellPath = $r['PowerShellExecutable']; powerShellSha256 = $r['PowerShellExecutableSha256']
                    launcherPath = $E.LauncherPath; launcherSha256 = $E.LauncherSha; hostPath = $E.HostPath; hostSha256 = $E.HostSha
                    childEnvelopePath = $r['ChildEnvelopePath']; startDeadlineMs = $r['startDeadlineMs']
                }
                foreach ($k in 'taskId', 'owner', 'runId') { if ($eo[$k] -isnot [string] -or [string]::IsNullOrWhiteSpace($eo[$k])) { throw 'recipe' } }
                foreach ($k in 'receiptSha256', 'planSha256', 'ticketSha256', 'payloadSha256') { if (-not (Test-RC152Sha $eo[$k])) { throw 'recipe' } }
                foreach ($k in 'stateDir', 'runDir') { if (-not (Test-RC152Path $eo[$k])) { throw 'recipe' } }
                if (($eo['attempt'] -isnot [int] -and $eo['attempt'] -isnot [long]) -or $eo['attempt'] -lt 1) { throw 'recipe' }
                if (-not (Test-RC152Path $r['BRequestPath']) -or -not (Test-RC152Sha $r['BRequestSha256']) -or -not (Test-RC152Path $r['BRunDir'])) { throw 'recipe' }
                $bq = Read-RC152PinnedJson $r['BRequestPath'] $r['BRequestSha256'] $true
                if ($bq -isnot [hashtable] -or $bq['RunId'] -isnot [string] -or $bq['RunId'] -cne $eo['runId'] -or $bq['RunId'] -cne $eo['taskId']) { throw 'recipe' }
                if (($bq['Attempt'] -isnot [int] -and $bq['Attempt'] -isnot [long]) -or $bq['Attempt'] -ne $eo['attempt']) { throw 'recipe' }
                foreach ($pk in @(@('TicketPath', 'ticketSha256'), @('PayloadPath', 'payloadSha256'))) {
                    $pv = $bq[$pk[0]]
                    if ($pv -isnot [string] -or [string]::IsNullOrWhiteSpace($pv) -or -not [IO.Path]::IsPathFullyQualified($pv)) { throw 'recipe' }
                    $null = Get-RC152FileBytes ([IO.Path]::GetFullPath($pv)) $eo[$pk[1]]
                }
                if ([IO.Path]::TrimEndingDirectorySeparator($r['BRunDir']) -cne [IO.Path]::TrimEndingDirectorySeparator($eo['runDir'])) { throw 'recipe' }
                $transport = & $E.NewDispatch -Spec $spec
                $dispatch = {
                    param($SelectedClaim)
                    if ($SelectedClaim -isnot [System.Management.Automation.PSCustomObject]) { throw 'REGISTERED_CYCLE_DISPATCH_REFUSED:selected' }
                    $wp = @($SelectedClaim.PSObject.Properties)
                    $wn = @('id', 'owner', 'claimId', 'intentId', 'receiptSha', 'planSha', 'statePath', 'kind', 'provider', 'route')
                    if ($wp.Count -ne 10) { throw 'REGISTERED_CYCLE_DISPATCH_REFUSED:selected' }
                    foreach ($wq in $wp) {
                        if ($wq.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty -or $wn -cnotcontains $wq.Name) { throw 'REGISTERED_CYCLE_DISPATCH_REFUSED:selected' }
                    }
                    if ([Collections.Generic.HashSet[string]]::new([string[]]@($wp.Name), [StringComparer]::Ordinal).Count -ne 10) { throw 'REGISTERED_CYCLE_DISPATCH_REFUSED:selected' }
                    foreach ($wq in $wp) { if ($wq.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($wq.Value)) { throw 'REGISTERED_CYCLE_DISPATCH_REFUSED:selected' } }
                    if ($SelectedClaim.receiptSha.Length -ne 64 -or $SelectedClaim.receiptSha -cnotmatch '^[0-9a-f]+$' -or $SelectedClaim.planSha.Length -ne 64 -or $SelectedClaim.planSha -cnotmatch '^[0-9a-f]+$') { throw 'REGISTERED_CYCLE_DISPATCH_REFUSED:selected' }
                    if ($SelectedClaim.id -cne $esO.taskId -or $SelectedClaim.owner -cne $esO.owner -or $SelectedClaim.receiptSha -cne $esO.receiptSha256 -or $SelectedClaim.planSha -cne $esO.planSha256) { throw 'REGISTERED_CYCLE_DISPATCH_REFUSED:successor' }
                    $out = @(& $transport $SelectedClaim)
                    if ($out.Count -ne 1) { throw 'REGISTERED_CYCLE_DISPATCH_UNRESOLVED:output' }
                    $eb = $out[0].ExecutionBinding
                    if ($eb.taskId -cne $esO.taskId -or $eb.ticketSha256 -cne $esO.ticketSha256 -or $eb.payloadSha256 -cne $esO.payloadSha256 -or $eb.runId -cne $esO.runId -or [long]$eb.attempt -ne [long]$esO.attempt -or $eb.receiptSha -cne $esO.receiptSha256 -or $eb.planSha -cne $esO.planSha256) { throw 'REGISTERED_CYCLE_DISPATCH_UNRESOLVED:binding' }
                    return $out[0]
                }.GetNewClosure()

                $ha2 = @{}
                foreach ($k in @($ha.Keys)) { $ha2[$k] = $ha[$k] }
                $t0 = $ha['TerminalArguments']
                $tnames = @('RawPath', 'TicketPath', 'UsagePath', 'RunId', 'Attempt', 'MaxAttempts', 'PriorElapsedMs', 'MaxElapsedMs', 'ReceiptPath', 'CompletedNativeEvidence')
                if (-not $ha.ContainsKey('TerminalArguments') -or $t0 -isnot [hashtable]) { throw 'recipe' }
                # Exact-ordinal branch: ten legacy keys, or the same ten plus ObserveOnlyReviewedCompletionEvidence (eleven); nothing else.
                $obsTa = $false
                foreach ($tk in @($t0.Keys)) { if ($tk -is [string] -and [string]::Equals($tk, 'ObserveOnlyReviewedCompletionEvidence', [StringComparison]::Ordinal)) { $obsTa = $true } }
                if ($obsTa) { $tnames = $tnames + @('ObserveOnlyReviewedCompletionEvidence') }
                if ($t0.Count -ne $tnames.Count) { throw 'recipe' }
                foreach ($tk in @($t0.Keys)) { if ($tk -isnot [string] -or $tnames -cnotcontains $tk) { throw 'recipe' } }
                if ($obsTa) {
                    $oe0 = $t0['ObserveOnlyReviewedCompletionEvidence']
                    if (-not (Test-RC152Exact $oe0 @('schema', 'accountingEvidence', 'registrationRef', 'terminalBindingRef', 'reviewCompletionRef')) -or $oe0.schema -isnot [string] -or $oe0.schema -cne 'ManagedObserveReviewedCompletionEvidence/v1') { throw 'recipe' }
                }
                $t1 = $t0['CompletedNativeEvidence']
                if ($t1 -isnot [hashtable] -or $t1.Count -ne 3) { throw 'recipe' }
                foreach ($tk in @($t1.Keys)) { if ($tk -isnot [string] -or @('pid', 'startIdentity', 'artifactPath') -cnotcontains $tk) { throw 'recipe' } }
                $tpid = $t1['pid']
                $tsid = $t1['startIdentity']
                $tart = $t1['artifactPath']
                if (($tpid -isnot [int] -and $tpid -isnot [long]) -or $tpid -le 0) { throw 'recipe' }
                if ($tsid -isnot [string] -or [string]::IsNullOrWhiteSpace($tsid) -or $tsid.IndexOf([char]0) -ge 0) { throw 'recipe' }
                if (-not (Test-RC152Path $tart)) { throw 'recipe' }
                $native3 = [pscustomobject][ordered]@{ pid = $tpid; startIdentity = $tsid; artifactPath = $tart }
                $ta2 = @{}
                foreach ($tk in @($t0.Keys)) { $ta2[$tk] = $t0[$tk] }
                $ta2['CompletedNativeEvidence'] = $native3
                $ha2['TerminalArguments'] = $ta2
                $ha2['PreviousSelectedClaim'] = [pscustomobject]$ha['PreviousSelectedClaim']
                $ha2['Dispatch'] = $dispatch

                $hp = $E.HandoffPath
                $null = Get-RC152FileBytes $hp $E.HandoffSha
                . $hp
                $null = Get-RC152FileBytes $hp $E.HandoffSha
                $fn = @(Get-Command -Name Invoke-VerifiedReviewedHostHandoff141 -CommandType Function -ErrorAction SilentlyContinue)
                if ($fn.Count -ne 1 -or $fn[0].ScriptBlock.File -ine $hp) { throw 'handoff' }
                $res = @(Invoke-VerifiedReviewedHostHandoff141 -ReviewedBinding $Binding -HostArguments $ha2 -ExpectedSuccessor $esO)
                if ($res.Count -ne 1) { throw 'handoff-output' }
                return $res[0]
            } catch {
                throw ('REGISTERED_USEFUL_CYCLE_HANDOFF_UNRESOLVED: ' + $_.Exception.Message)
            }
        }
        $handoff = { param($ReviewedBinding) & $body $ex $ReviewedBinding }.GetNewClosure()

        $original = New-GenuineTerminalCallback134 -RegistrationPath $cfg['registrationPath'] -RegistrationSha256 $cfg['registrationSha256'] -Request $req -RunDir $reg['runDir'] -AckPath $ackPath -ReviewedHandoff $handoff
        if ($original -isnot [scriptblock]) { throw 'callback' }
    } catch {
        throw 'REGISTERED_USEFUL_CYCLE_FACTORY_REFUSED'
    }
    return [pscustomobject][ordered]@{ OriginalCallback = $original; ReviewedHandoff = $handoff }
}

if ($CycleChildB) {
    Invoke-RegisteredCycleChildCollector152 -EnvelopePath $ChildEnvelopePath -ExpectedEnvelopeSha256 $ExpectedChildEnvelopeSha256
}
