if (-not (Get-Command -Name Get-ReviewedBlockedEvidenceCapture -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatch') 'reviewed-blocked-capture.ps1')
}

# OperationalRunReceipt/v2: BLOCKED only, with a reviewedDisposition validated by the accepted capture helper.
# Format validation only; independent host expectation and actual IO are deferred to producer/settlement.
function Test-OperationalReceiptV2 {
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array]) { return $false }
        if ($obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }

        # Metadata phase: property kinds and exact disposition shape before any value is read.
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        $props = @($obj.PSObject.Properties)
        foreach ($pr in $props) {
            if ($pr.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
            if (-not $names.Add([string]$pr.Name)) { return $false }
        }
        foreach ($n in @('schemaVersion','status','reviewedDisposition','provider','artifact','sessionId','taskId','runId','payloadSha256','attempt')) {
            if (-not $names.Contains($n)) { return $false }
        }
        $dispNames = @('schema','providerClassification','evidence','reviewSha256','evidenceSha256')
        $dRaw = $obj.PSObject.Properties['reviewedDisposition'].Value
        if ($null -eq $dRaw -or $dRaw -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        $dProps = @($dRaw.PSObject.Properties)
        if ($dProps.Count -ne $dispNames.Count) { return $false }
        $dSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($dp in $dProps) {
            if ($dp.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
            if (-not $dSeen.Add([string]$dp.Name)) { return $false }
        }
        foreach ($n in $dispNames) { if (-not $dSeen.Contains($n)) { return $false } }
        foreach ($sub in @('provider','artifact')) {
            $sv = $obj.PSObject.Properties[$sub].Value
            if ($null -eq $sv -or $sv -isnot [System.Management.Automation.PSCustomObject]) { return $false }
            foreach ($m in @($sv.PSObject.Properties)) {
                if ($m.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
            }
        }

        # Value phase.
        $schemaV = $obj.PSObject.Properties['schemaVersion'].Value
        $statusV = $obj.PSObject.Properties['status'].Value
        if ($schemaV -isnot [string] -or -not ($schemaV -ceq 'OperationalRunReceipt/v2')) { return $false }
        if ($statusV -isnot [string] -or -not ($statusV -ceq 'BLOCKED')) { return $false }

        $dSchema = $dRaw.PSObject.Properties['schema'].Value
        $dClass = $dRaw.PSObject.Properties['providerClassification'].Value
        $dEvidence = $dRaw.PSObject.Properties['evidence'].Value
        $dReview = $dRaw.PSObject.Properties['reviewSha256'].Value
        $dEvSha = $dRaw.PSObject.Properties['evidenceSha256'].Value
        if ($dSchema -isnot [string] -or -not ($dSchema -ceq 'ReviewedBlockedDisposition/v1')) { return $false }
        if ($dClass -isnot [string] -or -not ($dClass -ceq 'SUCCESS')) { return $false }

        # Private validation copy: original is never mutated; v1 base guards are reused on the copy.
        $copy = [ordered]@{}
        foreach ($pr in $props) {
            if ($pr.Name -ceq 'reviewedDisposition') { continue }
            $copy[$pr.Name] = $pr.Value
        }
        $copy['schemaVersion'] = 'OperationalRunReceipt/v1'
        $copy['status'] = 'FAILED'
        if (-not (Test-OperationalReceipt ([pscustomobject]$copy))) { return $false }

        # Native identity and terminal reason.
        $p = $obj.provider
        $pidV = $p.pid
        if ($null -eq $pidV -or ($pidV -isnot [int] -and $pidV -isnot [long])) { return $false }
        if ([long]$pidV -le 0) { return $false }
        if ($p.startIdentity -isnot [string] -or [string]::IsNullOrWhiteSpace($p.startIdentity)) { return $false }
        if ($p.terminalReason -isnot [string] -or [string]::IsNullOrWhiteSpace($p.terminalReason)) { return $false }
        if ($obj.sessionId -isnot [string] -or [string]::IsNullOrWhiteSpace($obj.sessionId)) { return $false }

        # Artifact must be strictly incomplete.
        $a = $obj.artifact
        if ($a.complete -isnot [bool] -or $a.complete -ne $false) { return $false }
        if ($null -ne $a.path -or $null -ne $a.sha256) { return $false }

        # Captured evidence validated by the accepted helper, then matched to the receipt.
        if (-not (Get-Command -Name Get-ReviewedBlockedEvidenceCapture -CommandType Function -ErrorAction SilentlyContinue)) { return $false }
        $expected = [pscustomobject]@{ reviewSha256 = $dReview; evidenceSha256 = $dEvSha }
        $capture = Get-ReviewedBlockedEvidenceCapture -ReviewedBlockedEvidence $dEvidence -ExpectedBlockedReview $expected
        if ($null -eq $capture -or $capture.schema -cne 'ReviewedBlockedCapture/v1') { return $false }
        $ev = $capture.evidence
        if ($ev.taskId -cne $obj.taskId -or $ev.runId -cne $obj.runId -or $ev.payloadSha256 -cne $obj.payloadSha256) { return $false }
        if ($ev.sessionId -cne $obj.sessionId -or $ev.startIdentity -cne $p.startIdentity) { return $false }
        if ([long]$ev.attempt -ne [long]$obj.attempt -or [long]$ev.pid -ne [long]$pidV) { return $false }
        return $true
    } catch { return $false }
}

# OperationalRunReceipt/v3: OBSERVE_ONLY pending accounting, AWAITING_CONTROLLER only. Independently reruns the shared authenticated verifier
# from the embedded evidence and requires an exact match. Format/derivation validity does not attest host authorization and grants no
# completion, ACK or dispatch; downstream v3 consumers remain unsupported.
function Test-OperationalReceiptV3 {
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array] -or $obj -isnot [System.Management.Automation.PSCustomObject]) { return $false }
        $val = { param($o, [string]$n) foreach ($q in $o.PSObject.Properties) { if ([string]::Equals($q.Name, $n, [System.StringComparison]::Ordinal)) { return , $q.Value } }; return , $null }
        . (Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatch\managed-native-receipt.ps1')
        # Cheap structural shape first; nothing is derived for a malformed DTO.
        if (-not (Test-ManagedObservePendingReceiptV3Shape $obj)) { return $false }
        # Independent rerun of the shared verifier from the embedded evidence only; callers cannot supply facts or skip authentication.
        $vf = Get-ManagedObservePendingAccountingFacts -Evidence (& $val $obj 'observePendingAccountingEvidence')
        if (($null -eq $vf) -or ($vf.Valid -isnot [bool]) -or (-not $vf.Valid) -or ($null -eq $vf.Facts)) { return $false }
        $f = $vf.Facts
        if (-not (Compare-ManagedObservePendingReceiptV3ToFacts $obj $f)) { return $false }
        # Reauthenticate the referenced raw DTO with the same shared rules the adapter used; rawPath/rawSha256 cannot be swapped independently.
        $e = & $val $obj 'evidence'
        $rawPathV = [string](& $val $e 'rawPath')
        $rv = Test-ManagedObservePendingRawDto -RawPath $rawPathV -ExpectedSha256 ([string](& $val $e 'rawSha256')) -Facts $f
        if (($null -eq $rv) -or ($rv.Valid -isnot [bool]) -or (-not $rv.Valid) -or ($rv.Path -cne $rawPathV)) { return $false }
        return $true
    } catch { return $false }
}

function Test-OperationalReceipt {
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array]) { return $false }
        # Explicit v3 dispatch by metadata only; a v3 annotation on any other schema, or a wrong-case v3 schema, refuses and never falls back to v1/v2.
        $v3Member = $obj.PSObject.Properties['schemaVersion']
        $v3Names = @($obj.PSObject.Properties | Where-Object { @('observePendingAccountingEvidence', 'observePendingAccounting', 'outputStopMode') -contains [string]$_.Name })
        $isV3 = ($null -ne $v3Member) -and ($v3Member.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty) -and ($v3Member.Value -is [string]) -and ($v3Member.Value -ceq 'OperationalRunReceipt/v3')
        if ($isV3) { return (Test-OperationalReceiptV3 $obj) }
        if ($v3Names.Count -gt 0) { return $false }
        if (($null -ne $v3Member) -and ($v3Member.Value -is [string]) -and ($v3Member.Value -ilike 'OperationalRunReceipt/v3*')) { return $false }
        # Inspect schemaVersion metadata before any value read; a non-NoteProperty (e.g. ScriptProperty) getter is never executed.
        $svMember = $obj.PSObject.Properties['schemaVersion']
        # Optional aggregate advisory evidence: detected by metadata only (no getter run); never silently ignored, never valid on v2.
        $advMember = $obj.PSObject.Properties['aggregateAdvisoryEvidence']
        $advEvidence = $null
        if ($null -ne $advMember) {
            if ($advMember.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
            $advEvidence = $advMember.Value
            if ($null -eq $advEvidence) { return $false }
            if ($null -eq $svMember -or $svMember.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
            if (-not ($svMember.Value -is [string] -and $svMember.Value -ceq 'OperationalRunReceipt/v1')) { return $false }
        }
        if ($null -ne $svMember) {
            if ($svMember.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
            $svRaw = $svMember.Value
            if ($svRaw -is [string] -and $svRaw -ceq 'OperationalRunReceipt/v2') { return (Test-OperationalReceiptV2 $obj) }
        }
        $isInt = {
            param($v)
            if ($null -eq $v) { return $false }
            if ($v -is [bool]) { return $false }
            if ($v -is [string]) { return $false }
            if ($v -is [double] -or $v -is [float] -or $v -is [decimal]) { if ($v -ne [math]::Truncate($v)) { return $false } }
            try { [void][int64]$v } catch { return $false }
            return $true
        }
        $required = @('schemaVersion','runId','taskId','payloadSha256','destination','status','attempt','sessionId','historyVerified','budget','provider','artifact','updatedAt')
        foreach ($f in $required) { if (-not ($obj.PSObject.Properties.Name -contains $f)) { return $false } }
        if ($obj.schemaVersion -ne 'OperationalRunReceipt/v1') { return $false }
        if ([string]::IsNullOrWhiteSpace("$($obj.runId)") -or [string]::IsNullOrWhiteSpace("$($obj.taskId)") -or [string]::IsNullOrWhiteSpace("$($obj.destination)")) { return $false }
        if ("$($obj.payloadSha256)" -notmatch '^[0-9a-fA-F]{64}$') { return $false }
        if (@('PREPARED','RUNNING','SOFT_LIMIT','AWAITING_CONTROLLER','FAILED','COMPLETED') -notcontains $obj.status) { return $false }
        if (-not (& $isInt $obj.attempt) -or [int64]$obj.attempt -lt 0) { return $false }
        if ($obj.historyVerified -isnot [bool]) { return $false }
        if ($null -ne $obj.sessionId -and [string]::IsNullOrWhiteSpace("$($obj.sessionId)")) { return $false }
        if ([string]::IsNullOrWhiteSpace("$($obj.updatedAt)")) { return $false }
        try { [void][datetime]::Parse("$($obj.updatedAt)", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) } catch { return $false }

        $isStr = { param($v) ($null -eq $v) -or ($v -is [string]) }
        foreach ($sk in @('runId','taskId','destination','payloadSha256','status','updatedAt')) { if ($obj.$sk -isnot [string]) { return $false } }
        if ($null -ne $obj.sessionId -and $obj.sessionId -isnot [string]) { return $false }
        if ($null -ne $obj.provider.startIdentity -and $obj.provider.startIdentity -isnot [string]) { return $false }
        if ($null -ne $obj.provider.sessionId -and $obj.provider.sessionId -isnot [string]) { return $false }
        if ($null -ne $obj.provider.terminalReason -and $obj.provider.terminalReason -isnot [string]) { return $false }
        if ($obj.provider.sessionId -ne $obj.sessionId) { return $false }
        if ($null -ne $obj.artifact.path -and $obj.artifact.path -isnot [string]) { return $false }
        if ($null -ne $obj.artifact.sha256 -and $obj.artifact.sha256 -isnot [string]) { return $false }
        if ($obj.budget.softFraction -isnot [double] -and $obj.budget.softFraction -isnot [decimal] -and $obj.budget.softFraction -isnot [float]) { return $false }
        if ([int64]$obj.budget.attemptsUsed -gt [int64]$obj.budget.maxAttempts) { return $false }
        $b = $obj.budget
        if ($null -eq $b -or $b -is [System.Array]) { return $false }
        foreach ($k in @('maxOutputTokens','maxElapsedMs','maxAttempts','usedElapsedMs','usedOutputTokens','attemptsUsed')) {
            if (-not ($b.PSObject.Properties.Name -contains $k) -or -not (& $isInt $b.$k)) { return $false }
        }
        if ([int64]$b.maxOutputTokens -le 0 -or [int64]$b.maxElapsedMs -le 0 -or [int64]$b.maxAttempts -le 0) { return $false }
        if ([int64]$b.usedElapsedMs -lt 0 -or [int64]$b.usedOutputTokens -lt 0 -or [int64]$b.attemptsUsed -lt 0) { return $false }
        if (-not ($b.PSObject.Properties.Name -contains 'softFraction') -or [double]$b.softFraction -ne 0.75) { return $false }
        if ([int64]$b.attemptsUsed -ne [int64]$obj.attempt) { return $false }
        if ([int64]$b.usedElapsedMs -gt [int64]$b.maxElapsedMs -or [int64]$b.usedOutputTokens -gt [int64]$b.maxOutputTokens) { return $false }

        $p = $obj.provider
        if ($null -eq $p -or $p -is [System.Array]) { return $false }
        foreach ($k in @('startIdentity','sessionId','terminalReason','pid')) { if (-not ($p.PSObject.Properties.Name -contains $k)) { return $false } }
        $pidOk = $false
        if ($null -ne $p.pid) {
            if (-not (& $isInt $p.pid) -or [int64]$p.pid -le 0) { return $false }
            $pidOk = $true
        }
        if ($null -ne $p.startIdentity -and [string]::IsNullOrWhiteSpace("$($p.startIdentity)")) { return $false }
        if ($null -ne $p.sessionId -and [string]::IsNullOrWhiteSpace("$($p.sessionId)")) { return $false }
        $activeOrDone = @('RUNNING','SOFT_LIMIT','COMPLETED') -contains $obj.status
        if ($activeOrDone) {
            if (-not $pidOk -or [string]::IsNullOrWhiteSpace("$($p.startIdentity)")) { return $false }
        }
        if ($obj.status -eq 'COMPLETED' -and [string]::IsNullOrWhiteSpace("$($p.terminalReason)")) { return $false }

        $a = $obj.artifact
        if ($null -eq $a -or $a -is [System.Array]) { return $false }
        foreach ($k in @('complete','sha256','path')) { if (-not ($a.PSObject.Properties.Name -contains $k)) { return $false } }
        if ($a.complete -isnot [bool]) { return $false }
        if ($null -ne $a.sha256 -and "$($a.sha256)" -notmatch '^[0-9a-fA-F]{64}$') { return $false }
        if ($null -ne $a.path -and [string]::IsNullOrWhiteSpace("$($a.path)")) { return $false }
        if ($obj.status -eq 'COMPLETED') {
            if ($a.complete -ne $true) { return $false }
            if ([string]::IsNullOrWhiteSpace("$($a.path)") -or [string]::IsNullOrWhiteSpace("$($a.sha256)")) { return $false }
            if (-not (Test-Path -LiteralPath $a.path -PathType Leaf)) { return $false }
            $hash = (Get-FileHash -LiteralPath $a.path -Algorithm SHA256).Hash
            if ($hash -ne $a.sha256.ToUpperInvariant()) { return $false }
        }
        if ($null -ne $advMember) {
            # Trusted pinned stage siblings only; receipt numbers are compared against the authenticated projection.
            . (Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatch\managed-native-receipt.ps1')
            $advFacts = Get-ManagedNativeAdvisoryBudgetFacts -Evidence $advEvidence
            if ($null -eq $advFacts -or $advFacts.Valid -isnot [bool] -or -not $advFacts.Valid) { return $false }
            $af = $advFacts.Facts
            if ($af.mode -isnot [string] -or $af.mode -cne 'AUTHENTICATED_ADVISORY') { return $false }
            $e0 = $af.evidence
            $cap = Get-ManagedNativeCapturedFacts -ManifestPath $e0.manifestPath -ExpectedManifestSha256 $e0.manifestSha256 -TerminalPath $e0.terminalPath -ExpectedTerminalSha256 $e0.terminalSha256 -TicketPath $e0.ticketPath -RunId $e0.runId -Attempt ([int]$e0.attempt)
            if ($null -eq $cap -or $cap.Valid -isnot [bool] -or -not $cap.Valid) { return $false }
            $cf = $cap.Facts
            $pick = { param($o, [string[]]$names) foreach ($n in $names) { $pp = $o.PSObject.Properties[$n]; if ($null -ne $pp -and $pp.MemberType -eq [System.Management.Automation.PSMemberTypes]::NoteProperty) { return , $pp.Value } }; return , $null }
            $cTid = & $pick $cf.Ticket @('id')
            $cPay = & $pick $cf.Core @('payloadSha256')
            $cSes = & $pick $cf.Ticket @('sessionId')
            $cRun = & $pick $cf.Core @('runId')
            $cAtt = & $pick $cf.Core @('attempt')
            $cMaxEl = & $pick $cf.Core @('maxElapsedMs')
            $cMaxAt = & $pick $cf.Ticket.budget @('maxAttempts')
            $cStart = & $pick $cf.Start @('startTimeUtc')
            $cEnd = & $pick $cf.Terminal @('endedUtc')
            if (($cf.Pid -isnot [int] -and $cf.Pid -isnot [long]) -or [int64]$cf.Pid -le 0 -or -not $pidOk -or [int64]$p.pid -ne [int64]$cf.Pid) { return $false }
            if (($cMaxEl -isnot [int] -and $cMaxEl -isnot [long]) -or [int64]$cMaxEl -le 0 -or [int64]$b.maxElapsedMs -ne [int64]$cMaxEl) { return $false }
            if (($cMaxAt -isnot [int] -and $cMaxAt -isnot [long]) -or [int64]$cMaxAt -le 0 -or [int64]$b.maxAttempts -ne [int64]$cMaxAt) { return $false }
            if ([int64]$b.attemptsUsed -ne [int64]$cf.Core.attempt) { return $false }
            if ($b.PSObject.Properties.Name -contains 'priorElapsedMs' -and [int64]$b.priorElapsedMs -ne 0) { return $false }
            $cElapsed = [int64][math]::Ceiling((([datetime]$cEnd).ToUniversalTime() - ([datetime]$cStart).ToUniversalTime()).TotalMilliseconds)
            if ($cElapsed -lt 0 -or $cElapsed -gt [int64]$cMaxEl -or [int64]$b.usedElapsedMs -ne $cElapsed) { return $false }
            if ($cTid -isnot [string] -or -not [string]::Equals($cTid, [string]$obj.taskId, [System.StringComparison]::Ordinal)) { return $false }
            if ($cPay -isnot [string] -or -not [string]::Equals($cPay, [string]$obj.payloadSha256, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
            if ($cSes -isnot [string] -or -not [string]::Equals($cSes, [string]$obj.sessionId, [System.StringComparison]::Ordinal) -or -not [string]::Equals($cSes, [string]$obj.provider.sessionId, [System.StringComparison]::Ordinal)) { return $false }
            if ($cRun -isnot [string] -or -not [string]::Equals($cRun, [string]$obj.runId, [System.StringComparison]::Ordinal) -or -not [string]::Equals([string]$e0.runId, [string]$obj.runId, [System.StringComparison]::Ordinal)) { return $false }
            if (($cAtt -isnot [int] -and $cAtt -isnot [long]) -or [int64]$cAtt -ne [int64]$obj.attempt -or [int64]$e0.attempt -ne [int64]$obj.attempt) { return $false }
            if ([int64]$b.maxOutputTokens -ne [int64]$af.finiteCarrier -or [int64]$b.usedOutputTokens -ne [int64]$af.actualUsed) { return $false }
            if ($obj.destination -isnot [string] -or $obj.destination -cne 'Anthropic Claude') { return $false }
            $si = $obj.provider.startIdentity
            if ($null -ne $si) {
                if ($si -isnot [string] -or $cStart -isnot [string] -or $si -cne $cStart) { return $false }
            }
        }
        return $true
    } catch { return $false }
}

# Lane C: operational continuity reconciliation (read-only receipts, owned outbox)
# No source/runtime/launcher writes, no network/process/provider execution.

$script:SignificantStatuses = @('SOFT_LIMIT','AWAITING_CONTROLLER','FAILED','BLOCKED','COMPLETED')
$script:ClaimDeadlineSeconds = 120
$script:ValidStatuses = @('PREPARED','RUNNING','SOFT_LIMIT','AWAITING_CONTROLLER','FAILED','BLOCKED','COMPLETED')
$script:SchemaVersion = 'OperationalRunReceipt/v1'

function Get-EventKey {
    param($TaskId,$PayloadSha256,$RunId,$Status,$Attempt)
    return "$TaskId`:$PayloadSha256`:$RunId`:$Status`:$Attempt"
}

function Read-ReceiptFiles {
    param([string]$ReceiptDir,[string]$OutboxPath = (Join-Path $ReceiptDir 'outbox.json'))
    if (-not (Test-Path -LiteralPath $ReceiptDir)) {
        throw "ReceiptDir not found: $ReceiptDir"
    }
    $outboxFull = [System.IO.Path]::GetFullPath($OutboxPath)
    if (Test-Path -LiteralPath $OutboxPath) {
        try { $existing = Get-Content -LiteralPath $OutboxPath -Raw | ConvertFrom-Json } catch { $existing = $null }
        if ($null -ne $existing -and $existing -isnot [System.Array] -and (Test-OperationalReceipt $existing)) {
            throw "OutboxPath '$OutboxPath' contains a valid OperationalRunReceipt/v1 object; refusing to risk receipt overwrite."
        }
    }
    $out = @()
    $invalid = 0
    foreach ($f in Get-ChildItem -LiteralPath $ReceiptDir -Filter '*.json' -File -ErrorAction SilentlyContinue) {
        $fFull = [System.IO.Path]::GetFullPath($f.FullName)
        if ($fFull.Equals($outboxFull, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        try {
            $obj = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json -DateKind String
        } catch { $invalid++; continue }
        # v3 observe-only pending receipts have no supported downstream consumer here; they are counted invalid, never outboxed.
        if (($obj -is [System.Management.Automation.PSCustomObject]) -and ($null -ne $obj.PSObject.Properties['schemaVersion']) -and ($obj.schemaVersion -is [string]) -and ($obj.schemaVersion -ilike 'OperationalRunReceipt/v3*')) { $invalid++; continue }
        if (-not (Test-OperationalReceipt $obj)) { $invalid++; continue }
        $out += $obj
    }
    return @{ Receipts = $out; Invalid = $invalid }
}

function Read-Outbox {
    param([string]$OutboxPath)
    if (-not (Test-Path -LiteralPath $OutboxPath)) { return @() }
    $raw = Get-Content -LiteralPath $OutboxPath -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    $arr = ConvertFrom-Json -InputObject $raw -NoEnumerate
    if ($null -eq $arr) { throw "Outbox at '$OutboxPath' parsed to null; failing closed." }
    if ($arr.PSObject.Properties.Name -contains 'schemaVersion' -and @('OperationalRunReceipt/v1','OperationalRunReceipt/v2','OperationalRunReceipt/v3') -contains $arr.schemaVersion) {
        throw "Outbox at '$OutboxPath' resembles an OperationalRunReceipt/v1 or v2 object; refusing to risk receipt overwrite."
    }
    if ($arr -isnot [System.Array]) { $arr = @($arr) }
    $seen = [hashtable]::new([System.StringComparer]::Ordinal)
    $isInt = { param($v) if ($null -eq $v -or $v -is [bool] -or $v -is [string]) { return $false }; if (($v -is [double] -or $v -is [float] -or $v -is [decimal]) -and ($v -ne [math]::Truncate($v))) { return $false }; try { [void][int64]$v } catch { return $false }; return $true }
    foreach ($e in $arr) {
        if ($null -eq $e -or $e -is [System.Array]) { throw "Outbox contains a malformed event; failing closed." }
        if ($e.PSObject.Properties.Name -contains 'schemaVersion' -and @('OperationalRunReceipt/v1','OperationalRunReceipt/v2','OperationalRunReceipt/v3') -contains $e.schemaVersion) {
            throw "Outbox event resembles an OperationalRunReceipt/v1 or v2 object; refusing to risk receipt overwrite."
        }
        foreach ($f in @('taskId','runId','destination','status','payloadSha256','attempt','key','deliveryStatus')) {
            if (-not ($e.PSObject.Properties.Name -contains $f) -or [string]::IsNullOrWhiteSpace("$($e.$f)")) { throw "Outbox event missing required field '$f'; failing closed." }
        }
        if (@('SOFT_LIMIT','AWAITING_CONTROLLER','FAILED','BLOCKED','COMPLETED') -notcontains $e.status) { throw "Outbox event has invalid status '$($e.status)'; failing closed." }
        if ("$($e.payloadSha256)" -notmatch '^[0-9a-fA-F]{64}$') { throw "Outbox event has invalid payloadSha256; failing closed." }
        if (-not (& $isInt $e.attempt) -or [int64]$e.attempt -lt 0) { throw "Outbox event has invalid attempt; failing closed." }
        $expectedKey = Get-EventKey -TaskId $e.taskId -PayloadSha256 $e.payloadSha256 -RunId $e.runId -Status $e.status -Attempt $e.attempt
        if ($e.key -cne $expectedKey) { throw "Outbox event key mismatch; failing closed." }
        if (@('PENDING','DELIVERED') -notcontains $e.deliveryStatus) { throw "Outbox event has invalid deliveryStatus; failing closed." }
        if ($e.deliveryStatus -eq 'DELIVERED' -and [string]::IsNullOrWhiteSpace("$($e.proof)")) { throw "Outbox event marked DELIVERED without nonempty proof; failing closed." }
        if ($seen.ContainsKey($e.key)) { throw "Outbox contains duplicated key '$($e.key)'; failing closed." }
        $seen[$e.key] = $true
    }
    return $arr
}

function Write-OutboxAtomic {
    param([string]$OutboxPath,[object[]]$Events)
    $dir = Split-Path -Parent $OutboxPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $lockPath = "$OutboxPath.lock"
    $lockStream = $null
    try {
        $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $tmpPath = "$OutboxPath.tmp_$([guid]::NewGuid().ToString('N'))"
        (ConvertTo-Json -InputObject @($Events) -Depth 10) | Set-Content -LiteralPath $tmpPath -Encoding UTF8 -NoNewline
        Move-Item -LiteralPath $tmpPath -Destination $OutboxPath -Force
    } finally {
        if ($lockStream) { $lockStream.Dispose() }
        if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-ReceiptReconciliation {
    param(
        [Parameter(Mandatory=$true)][string]$ReceiptDir,
        [Parameter(Mandatory=$true)][string]$OutboxPath,
        [object[]]$ConsentRecords = @(),
        [object[]]$DeliveryEvidence = @(),
        [object[]]$Claims = @(),
        [datetime]$Now = (Get-Date).ToUniversalTime()
    )
    $dir = Split-Path -Parent $OutboxPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $txLockPath = "$OutboxPath.transaction.lock"
    $txLockStream = [System.IO.File]::Open($txLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
        return Invoke-ReceiptReconciliationCore -ReceiptDir $ReceiptDir -OutboxPath $OutboxPath -ConsentRecords $ConsentRecords -DeliveryEvidence $DeliveryEvidence -Claims $Claims -Now $Now
    } finally {
        $txLockStream.Dispose()
    }
}

function Invoke-ReceiptReconciliationCore {
    param(
        [Parameter(Mandatory=$true)][string]$ReceiptDir,
        [Parameter(Mandatory=$true)][string]$OutboxPath,
        [object[]]$ConsentRecords = @(),
        [object[]]$DeliveryEvidence = @(),
        [object[]]$Claims = @(),
        [datetime]$Now = (Get-Date).ToUniversalTime()
    )

    $read = Read-ReceiptFiles -ReceiptDir $ReceiptDir -OutboxPath $OutboxPath
    $receipts = $read.Receipts

    $existing = Read-Outbox -OutboxPath $OutboxPath
    $existingByKey = [hashtable]::new([System.StringComparer]::Ordinal)
    foreach ($e in $existing) { $existingByKey[$e.key] = $e }

    $newCount = 0
    foreach ($r in $receipts) {
        if ($script:SignificantStatuses -notcontains $r.status) { continue }
        $key = Get-EventKey -TaskId $r.taskId -PayloadSha256 $r.payloadSha256 -RunId $r.runId -Status $r.status -Attempt $r.attempt
        if ($existingByKey.ContainsKey($key)) { continue }
        $evt = [PSCustomObject]@{
            key = $key
            taskId = $r.taskId
            payloadSha256 = $r.payloadSha256
            runId = $r.runId
            destination = $r.destination
            status = $r.status
            attempt = $r.attempt
            updatedAt = $r.updatedAt
            deliveryStatus = 'PENDING'
            proof = $null
            consentEligibility = $null
            reconciliationSignal = $false
        }
        $existingByKey[$key] = $evt
        $newCount++
    }

    # Delivery evidence: only exact key match with nonempty proof marks DELIVERED
    foreach ($ev in $DeliveryEvidence) {
        if (-not $ev.key -or [string]::IsNullOrWhiteSpace("$($ev.proof)")) { continue }
        if ($existingByKey.ContainsKey($ev.key)) {
            $existingByKey[$ev.key].deliveryStatus = 'DELIVERED'
            $existingByKey[$ev.key].proof = $ev.proof
        }
    }

    # Consent: exact taskId+payloadSha256+destination binding only; never implies RUNNING
    foreach ($e in $existingByKey.Values) {
        foreach ($c in $ConsentRecords) {
            if ($c.taskId -ceq $e.taskId -and $c.payloadSha256 -ceq $e.payloadSha256 -and $c.destination -ceq $e.destination) {
                $e.consentEligibility = 'NORMAL_REVIEW_ELIGIBLE'
                break
            }
        }
    }

    # Claims: expiry retains PENDING, signals reconciliation; never asserts owner death
    $claimExpired = 0
    foreach ($c in $Claims) {
        if (-not $c.key -or -not $existingByKey.ContainsKey($c.key)) { continue }
        $e = $existingByKey[$c.key]
        if ($e.deliveryStatus -eq 'DELIVERED') { continue }
        $claimedAt = ([datetime]$c.claimedAt).ToUniversalTime()
        $elapsed = ($Now - $claimedAt).TotalSeconds
        if ($elapsed -gt $script:ClaimDeadlineSeconds) {
            $e.deliveryStatus = 'PENDING'
            $e.reconciliationSignal = $true
            $claimExpired++
        }
    }

    $finalEvents = @($existingByKey.Values)
    Write-OutboxAtomic -OutboxPath $OutboxPath -Events $finalEvents

    # Lane status: group by taskId, latest receipt (by updatedAt) overrides historical RUNNING
    $laneStatuses = [hashtable]::new([System.StringComparer]::Ordinal)
    $byTask = $receipts | Group-Object -Property taskId -CaseSensitive
    foreach ($g in $byTask) {
        $latest = $g.Group | Sort-Object { [datetime]$_.updatedAt } | Select-Object -Last 1
        $lane = switch ($latest.status) {
            'COMPLETED' { 'READY' }
            'FAILED' { 'BLOCKED' }
            'BLOCKED' { 'BLOCKED' }
            'AWAITING_CONTROLLER' { 'BLOCKED' }
            'SOFT_LIMIT' { 'ACTIVE' }
            'PREPARED' { 'PREPARING' }
            'RUNNING' { 'RUNNING' }
            default { 'INVALID' }
        }
        $laneStatuses[$g.Name] = $lane
    }

    $pendingCount = @($finalEvents | Where-Object { $_.deliveryStatus -eq 'PENDING' }).Count
    $deliveredCount = @($finalEvents | Where-Object { $_.deliveryStatus -eq 'DELIVERED' }).Count
    $notificationNeeded = ($pendingCount -gt 0) -or ($claimExpired -gt 0)

    return [PSCustomObject]@{
        totalReceipts = $receipts.Count
        invalidReceipts = $read.Invalid
        newEvents = $newCount
        pendingCount = $pendingCount
        deliveredCount = $deliveredCount
        claimsExpired = $claimExpired
        laneStatuses = $laneStatuses
        notificationNeeded = $notificationNeeded
        overallComplete = (@($laneStatuses.Values | Where-Object { $_ -ne 'READY' }).Count -eq 0) -and ($laneStatuses.Count -gt 0) -and ($read.Invalid -eq 0)
    }
}
