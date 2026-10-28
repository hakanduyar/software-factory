function Get-VerifiedPersistedSuccessorAck140 {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$ExpectedSuccessor)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    function Fail([string]$Reason) { throw "VERIFIED_SUCCESSOR_ACK_INVALID: $Reason" }
    function Test-Names($Obj, [string[]]$Names, [string]$What) {
        if ($null -eq $Obj -or $Obj -isnot [System.Management.Automation.PSCustomObject]) { Fail "$What not object" }
        # Metadata only: names and member types, never property values.
        $actual = @()
        foreach ($m in $Obj.PSObject.Properties) {
            if ($m.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { Fail "$What member not NoteProperty" }
            $actual += [string]$m.Name
        }
        if ($actual.Count -ne $Names.Count) { Fail "$What field count" }
        foreach ($n in $Names) {
            if (-not ($actual | Where-Object { [string]::Equals($_, $n, [StringComparison]::Ordinal) })) { Fail "$What missing $n" }
        }
    }
    function Get-Str($Obj, [string]$Name, [string]$What) {
        $p = $Obj.PSObject.Properties[$Name]
        if ($null -eq $p -or $p.Value -isnot [string] -or $p.Value.Length -eq 0) { Fail "$What.$Name not string" }
        return [string]$p.Value
    }
    function Get-Hash($Obj, [string]$Name, [string]$What) {
        $v = Get-Str $Obj $Name $What
        if (-not ($v -cmatch '\A[0-9a-f]{64}\z')) { Fail "$What.$Name not lower sha256" }
        return $v
    }
    function Get-PosInt($Obj, [string]$Name, [string]$What) {
        $p = $Obj.PSObject.Properties[$Name]
        if ($null -eq $p -or ($p.Value -isnot [int] -and $p.Value -isnot [long]) -or [long]$p.Value -lt 1) { Fail "$What.$Name not positive integer" }
        return [long]$p.Value
    }
    function Get-Path($Obj, [string]$Name, [string]$What) {
        $v = Get-Str $Obj $Name $What
        if (-not [System.IO.Path]::IsPathRooted($v) -or -not [string]::Equals([System.IO.Path]::GetFullPath($v), $v, [StringComparison]::Ordinal)) { Fail "$What.$Name not canonical path" }
        return $v
    }
    function Test-Eq([string]$A, [string]$B, [string]$What) {
        if (-not [string]::Equals($A, $B, [StringComparison]::Ordinal)) { Fail $What }
    }
    function ConvertFrom-JsonObject([string]$Text, [string]$What) {
        try { $parsed = ConvertFrom-Json -InputObject $Text -DateKind String -NoEnumerate }
        catch { Fail "$What unparsable" }
        if ($null -eq $parsed -or $parsed -isnot [System.Management.Automation.PSCustomObject]) { Fail "$What root not object" }
        return $parsed
    }
    function Read-Json([string]$Path, [string]$What) {
        if (-not [System.IO.File]::Exists($Path)) { Fail "$What missing" }
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        # Ignore exactly one leading UTF-8 BOM for decode only; bytes are untouched.
        $offset = 0
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $offset = 3 }
        try { $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset) }
        catch { Fail "$What not strict UTF-8" }
        return (ConvertFrom-JsonObject $text $What)
    }

    # Capture all caller-expected scalars before any import or IO.
    $names10 = @('taskId', 'owner', 'receiptSha256', 'planSha256', 'ticketSha256', 'payloadSha256', 'runId', 'attempt', 'stateDir', 'runDir')
    Test-Names $ExpectedSuccessor $names10 'ExpectedSuccessor'
    $exTaskId = Get-Str $ExpectedSuccessor 'taskId' 'expected'
    $exOwner = Get-Str $ExpectedSuccessor 'owner' 'expected'
    $exReceipt = Get-Hash $ExpectedSuccessor 'receiptSha256' 'expected'
    $exPlan = Get-Hash $ExpectedSuccessor 'planSha256' 'expected'
    $exTicket = Get-Hash $ExpectedSuccessor 'ticketSha256' 'expected'
    $exPayload = Get-Hash $ExpectedSuccessor 'payloadSha256' 'expected'
    $exRunId = Get-Str $ExpectedSuccessor 'runId' 'expected'
    $exAttempt = Get-PosInt $ExpectedSuccessor 'attempt' 'expected'
    $exStateDir = Get-Path $ExpectedSuccessor 'stateDir' 'expected'
    $exRunDir = Get-Path $ExpectedSuccessor 'runDir' 'expected'

    $hostDir = $PSScriptRoot
    if ([string]::IsNullOrEmpty($hostDir)) {
        $hostDir = 'C:\Users\hakan\.codex\worktrees\e954\software-factory\.factory-data\chief\controller-runtime\host-continuation'
    }
    . (Join-Path $hostDir 'select-next-ready.ps1')

    # 1. Continuation state envelope (read-only).
    $state = Read-Json (Join-Path $exStateDir 'continuation-state.json') 'continuation-state'
    Test-Names $state @('schema', 'entries', 'overallComplete') 'state'
    Test-Eq (Get-Str $state 'schema' 'state') 'continuation-state/v1' 'state schema'
    $entries = $state.entries
    if ($null -eq $entries -or $entries -isnot [System.Management.Automation.PSCustomObject]) { Fail 'state entries not object' }
    $matches = @()
    foreach ($p in $entries.PSObject.Properties) {
        Test-ContinuationStateEntry -Key $p.Name -Entry $p.Value | Out-Null
        $e = $p.Value
        $a = $e.PSObject.Properties['actionId']; $r = $e.PSObject.Properties['receiptSha256']; $l = $e.PSObject.Properties['planSha256']
        if ($a -and $r -and $l -and
            $a.Value -is [string] -and [string]::Equals($a.Value, $exTaskId, [StringComparison]::Ordinal) -and
            $r.Value -is [string] -and [string]::Equals($r.Value, $exReceipt, [StringComparison]::Ordinal) -and
            $l.Value -is [string] -and [string]::Equals($l.Value, $exPlan, [StringComparison]::Ordinal)) {
            $matches += , @($p.Name, $e)
        }
    }
    if ($matches.Count -ne 1) { Fail "state matches=$($matches.Count)" }
    $intentKey = [string]$matches[0][0]
    $stEntry = $matches[0][1]
    $claim = $stEntry.PSObject.Properties['claim']
    if ($null -eq $claim -or $claim.Value -isnot [System.Management.Automation.PSCustomObject]) { Fail 'state claim not object' }
    $claimId = Get-Str $claim.Value 'claimId' 'state.claim'
    $claimOwner = Get-Str $claim.Value 'owner' 'state.claim'
    Test-Eq $claimOwner $exOwner 'state claim owner'

    # 2. Current acknowledgement envelope.
    $ackState = Read-Json (Join-Path $exStateDir 'host-dispatch-acknowledgements.json') 'acknowledgements'
    $ackMap = Test-HostDispatchAcknowledgementEnvelope -AckState $ackState
    $ackKey = $intentKey + '|' + $claimId
    if ($null -eq $ackMap -or -not $ackMap.Contains($ackKey)) { Fail 'ack entry absent' }
    $ack = $ackMap[$ackKey]
    Test-Names $ack @('schema', 'recordedAt', 'entryId', 'owner', 'claimId', 'intentId', 'dispatchedAt', 'executionBinding') 'ack'
    Test-Eq (Get-Str $ack 'entryId' 'ack') $exTaskId 'ack entryId'
    Test-Eq (Get-Str $ack 'owner' 'ack') $exOwner 'ack owner'
    Test-Eq (Get-Str $ack 'claimId' 'ack') $claimId 'ack claimId'
    Test-Eq (Get-Str $ack 'intentId' 'ack') $intentKey 'ack intentId'
    $dispatchedAt = Get-Str $ack 'dispatchedAt' 'ack'
    $eb = $ack.executionBinding
    Test-Names $eb @('schema', 'taskId', 'ticketSha256', 'payloadSha256', 'runId', 'attempt', 'receiptSha', 'planSha', 'identity') 'executionBinding'
    $pairs = @(
        @('taskId', $exTaskId), @('ticketSha256', $exTicket), @('payloadSha256', $exPayload),
        @('runId', $exRunId), @('receiptSha', $exReceipt), @('planSha', $exPlan))
    foreach ($pr in $pairs) {
        Test-Eq (Get-Str $eb $pr[0] 'executionBinding') $pr[1] "binding $($pr[0])"
    }
    if ((Get-PosInt $eb 'attempt' 'executionBinding') -ne $exAttempt) { Fail 'binding attempt' }
    $identity = $eb.identity
    if ($null -eq $identity -or $identity -isnot [System.Management.Automation.PSCustomObject]) { Fail 'binding identity' }
    Test-Eq (Get-Str $identity 'kind' 'identity') 'native' 'identity kind'
    $idPid = Get-PosInt $identity 'pid' 'identity'
    $idStart = Get-Str $identity 'startIdentity' 'identity'

    # 3. Native start + manifest in the real run directory.
    $start = Read-Json (Join-Path $exRunDir 'start.json') 'start'
    Test-Names $start @('schema', 'runId', 'attempt', 'requestSha256', 'pid', 'startTimeUtc', 'persistedUtc') 'start'
    $manifest = Read-Json (Join-Path $exRunDir 'manifest.json') 'manifest'
    Test-Names $manifest @('schema', 'requestCanonical', 'requestSha256', 'reservedUtc', 'gateStatus', 'gateResultSha256') 'manifest'
    Test-Eq (Get-Str $start 'schema' 'start') 'ManagedNativeStart/v1' 'start schema'
    Test-Eq (Get-Str $manifest 'schema' 'manifest') 'ManagedNativeCollector/v1' 'manifest schema'
    $sRunId = Get-Str $start 'runId' 'start'
    $sAttempt = Get-PosInt $start 'attempt' 'start'
    $sReq = Get-Hash $start 'requestSha256' 'start'
    $sPid = Get-PosInt $start 'pid' 'start'
    $sTime = Get-Str $start 'startTimeUtc' 'start'
    Get-Str $start 'persistedUtc' 'start' | Out-Null
    $mReq = Get-Hash $manifest 'requestSha256' 'manifest'
    $canon = Get-Str $manifest 'requestCanonical' 'manifest'
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = (($sha.ComputeHash([System.Text.UTF8Encoding]::new($false).GetBytes($canon)) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
    Test-Eq $mReq $sReq 'request sha start/manifest'
    Test-Eq $digest $mReq 'request sha canonical'
    Test-Eq $sRunId $exRunId 'start runId'
    if ($sAttempt -ne $exAttempt) { Fail 'start attempt' }
    if ($sPid -ne $idPid) { Fail 'start pid vs ack identity' }
    Test-Eq $sTime $dispatchedAt 'start time vs dispatchedAt'
    Test-Eq $idStart $sTime 'identity startIdentity vs start time'
    $core = ConvertFrom-JsonObject $canon 'requestCanonical'
    Test-Eq (Get-Str $core 'runId' 'core') $exRunId 'core runId'
    if ((Get-PosInt $core 'attempt' 'core') -ne $exAttempt) { Fail 'core attempt' }
    Test-Eq (Get-Hash $core 'ticketSha256' 'core') $exTicket 'core ticket'
    Test-Eq (Get-Hash $core 'payloadSha256' 'core') $exPayload 'core payload'
    Test-Eq (Get-Path $core 'runDir' 'core') $exRunDir 'core runDir'

    $captured = [pscustomobject][ordered]@{
        taskId = $exTaskId; owner = $exOwner; receiptSha256 = $exReceipt; planSha256 = $exPlan
        ticketSha256 = $exTicket; payloadSha256 = $exPayload; runId = $exRunId
        attempt = [int]$exAttempt; stateDir = $exStateDir; runDir = $exRunDir
    }
    return [pscustomobject][ordered]@{
        schema            = 'VerifiedPersistedSuccessorAck/v1'
        claimId           = $claimId
        nativeStart       = $sTime
        intentId          = $intentKey
        ExpectedSuccessor = $captured
        nativePid         = [int]$sPid
    }
}