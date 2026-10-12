# Staged v2 BLOCKED reader usage: positive-only controlled-fixture leaf (TEST54).
# Deferred to next leaves: outbox, reconciliation, refusal/malformed matrix.
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [Parameter(Mandatory)][string]$TuplePath,
    [Parameter(Mandatory)][string]$ExpectedPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. $SourcePath

function Read-FixtureJson([string]$Path) {
    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -DateKind String -NoEnumerate
}
function Copy-ByJson($Value) {
    $Value | ConvertTo-Json -Depth 100 -Compress | ConvertFrom-Json -DateKind String -NoEnumerate
}
function Assert-That([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    "PASS: $Name"
}

$inputPaths = @($ReceiptPath, $TuplePath, $ExpectedPath)
$hashBefore = $inputPaths | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }

$receipt = Read-FixtureJson $ReceiptPath
$tuple = Read-FixtureJson $TuplePath
$expected = Read-FixtureJson $ExpectedPath
$originalJson = $receipt | ConvertTo-Json -Depth 100 -Compress

$clone = Copy-ByJson $receipt
$capture = Get-ReviewedBlockedEvidenceCapture -ReviewedBlockedEvidence $tuple -ExpectedBlockedReview $expected
$provider = $capture.evidence

# Controlled v2 representation only; not an operational admission.
$clone.schemaVersion = 'OperationalRunReceipt/v2'
$clone.status = 'BLOCKED'
$clone.provider.pid = $provider.pid
$clone.provider.startIdentity = $provider.startIdentity
$clone.provider.sessionId = $provider.sessionId
$clone.artifact.complete = $false
$clone.artifact.path = $null
$clone.artifact.sha256 = $null
$clone | Add-Member -NotePropertyName reviewedDisposition -Force -NotePropertyValue ([pscustomobject][ordered]@{
    schema = 'ReviewedBlockedDisposition/v1'
    providerClassification = 'SUCCESS'
    evidence = $capture.evidence
    reviewSha256 = $capture.reviewSha256
    evidenceSha256 = $capture.evidenceSha256
})

$v1Blocked = Copy-ByJson $receipt
$v1Blocked.status = 'BLOCKED'

Assert-That ($null -eq $receipt.provider.startIdentity) 'original provider.startIdentity is null'
Assert-That (Test-OperationalReceipt $receipt) 'original v1 receipt valid'
Assert-That (Test-OperationalReceipt $clone) 'controlled v2 BLOCKED receipt valid'
Assert-That (-not (Test-OperationalReceipt $v1Blocked)) 'v1 clone with status BLOCKED rejected'
Assert-That (($receipt | ConvertTo-Json -Depth 100 -Compress) -ceq $originalJson) 'original receipt memory object unchanged'
$hashAfter = $inputPaths | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
Assert-That (($hashBefore -join ',') -ceq ($hashAfter -join ',')) 'all three input file SHA256 unchanged'

# Reconciliation/outbox/replay leaf (TEST56): controlled v2 BLOCKED clone only, GUID-owned temp dir.
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('D'))
try {
    $null = New-Item -ItemType Directory -Path $tempDir
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $receiptDir = Join-Path $tempDir 'receipts'
    $null = New-Item -ItemType Directory -Path $receiptDir
    $cloneJson = $clone | ConvertTo-Json -Depth 100 -Compress
    [System.IO.File]::WriteAllText((Join-Path $receiptDir 'receipt.json'), $cloneJson, $utf8)
    $outboxPath = Join-Path $tempDir 'outbox.json'

    $first = Invoke-ReceiptReconciliation -ReceiptDir $receiptDir -OutboxPath $outboxPath
    Assert-That ($first.newEvents -eq 1) 'reconciliation first call newEvents is 1'
    Assert-That ($first.laneStatuses[$clone.taskId] -ceq 'BLOCKED') 'laneStatuses for clone taskId is BLOCKED'
    Assert-That ($first.overallComplete -eq $false) 'overallComplete is false'
    $persisted = Read-Outbox -OutboxPath $outboxPath
    Assert-That (@($persisted).Count -eq 1) 'persisted outbox has one event'
    Assert-That (@($persisted)[0].status -ceq 'BLOCKED') 'persisted event status is BLOCKED'

    $outboxHash = (Get-FileHash -LiteralPath $outboxPath -Algorithm SHA256).Hash
    $replay = Invoke-ReceiptReconciliation -ReceiptDir $receiptDir -OutboxPath $outboxPath
    Assert-That ($replay.newEvents -eq 0) 'same-call replay newEvents is 0'
    Assert-That ((Get-FileHash -LiteralPath $outboxPath -Algorithm SHA256).Hash -ceq $outboxHash) 'outbox SHA256 unchanged after replay'

    $rootPath = Join-Path $tempDir 'root-receipt.json'
    $arrayPath = Join-Path $tempDir 'array-receipt.json'
    [System.IO.File]::WriteAllText($rootPath, $cloneJson, $utf8)
    [System.IO.File]::WriteAllText($arrayPath, "[$cloneJson]", $utf8)
    $refusalBefore = @($rootPath, $arrayPath) | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
    foreach ($case in @(@('root receipt', $rootPath), @('array receipt', $arrayPath))) {
        $refused = $false
        try { $null = Read-Outbox -OutboxPath $case[1] } catch { $refused = $true }
        Assert-That $refused "Read-Outbox refuses $($case[0])"
    }
    $refusalAfter = @($rootPath, $arrayPath) | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
    Assert-That (($refusalBefore -join ',') -ceq ($refusalAfter -join ',')) 'refused receipt files not overwritten, bytes stable'
}
finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir)) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
$hashFinal = $inputPaths | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
Assert-That (($hashBefore -join ',') -ceq ($hashFinal -join ',')) 'all three original input bytes untouched after reconciliation leaf'
'DEFERRED: refusal/malformed matrix (TEST57)'