function Test-OperationalReceipt {
    param($obj)
    try {
        if ($null -eq $obj -or $obj -is [System.Array]) { return $false }
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
        return $true
    } catch { return $false }
}

# Lane C: operational continuity reconciliation (read-only receipts, owned outbox)
# No source/runtime/launcher writes, no network/process/provider execution.

$script:SignificantStatuses = @('SOFT_LIMIT','AWAITING_CONTROLLER','FAILED','COMPLETED')
$script:ClaimDeadlineSeconds = 120
$script:ValidStatuses = @('PREPARED','RUNNING','SOFT_LIMIT','AWAITING_CONTROLLER','FAILED','COMPLETED')
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
    if ($arr.PSObject.Properties.Name -contains 'schemaVersion' -and $arr.schemaVersion -eq 'OperationalRunReceipt/v1') {
        throw "Outbox at '$OutboxPath' resembles an OperationalRunReceipt/v1 object; refusing to risk receipt overwrite."
    }
    if ($arr -isnot [System.Array]) { $arr = @($arr) }
    $seen = [hashtable]::new([System.StringComparer]::Ordinal)
    $isInt = { param($v) if ($null -eq $v -or $v -is [bool] -or $v -is [string]) { return $false }; if (($v -is [double] -or $v -is [float] -or $v -is [decimal]) -and ($v -ne [math]::Truncate($v))) { return $false }; try { [void][int64]$v } catch { return $false }; return $true }
    foreach ($e in $arr) {
        if ($null -eq $e -or $e -is [System.Array]) { throw "Outbox contains a malformed event; failing closed." }
        if ($e.PSObject.Properties.Name -contains 'schemaVersion' -and $e.schemaVersion -eq 'OperationalRunReceipt/v1') {
            throw "Outbox event resembles an OperationalRunReceipt/v1 object; refusing to risk receipt overwrite."
        }
        foreach ($f in @('taskId','runId','destination','status','payloadSha256','attempt','key','deliveryStatus')) {
            if (-not ($e.PSObject.Properties.Name -contains $f) -or [string]::IsNullOrWhiteSpace("$($e.$f)")) { throw "Outbox event missing required field '$f'; failing closed." }
        }
        if (@('SOFT_LIMIT','AWAITING_CONTROLLER','FAILED','COMPLETED') -notcontains $e.status) { throw "Outbox event has invalid status '$($e.status)'; failing closed." }
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
