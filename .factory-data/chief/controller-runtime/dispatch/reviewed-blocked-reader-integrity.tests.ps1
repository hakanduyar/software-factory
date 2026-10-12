# Frozen v2 BLOCKED integrity leaf (TEST57): same-fixture refusals only.
# Out of scope: outbox, reconciliation (TEST56), unrelated cases.
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

# Controlled valid v2 BLOCKED clone, constructed exactly as the accepted positive leaf.
$valid = Copy-ByJson $receipt
$capture = Get-ReviewedBlockedEvidenceCapture -ReviewedBlockedEvidence $tuple -ExpectedBlockedReview $expected
$provider = $capture.evidence
$valid.schemaVersion = 'OperationalRunReceipt/v2'
$valid.status = 'BLOCKED'
$valid.provider.pid = $provider.pid
$valid.provider.startIdentity = $provider.startIdentity
$valid.provider.sessionId = $provider.sessionId
$valid.artifact.complete = $false
$valid.artifact.path = $null
$valid.artifact.sha256 = $null
$valid | Add-Member -NotePropertyName reviewedDisposition -Force -NotePropertyValue ([pscustomobject][ordered]@{
    schema = 'ReviewedBlockedDisposition/v1'
    providerClassification = 'SUCCESS'
    evidence = $capture.evidence
    reviewSha256 = $capture.reviewSha256
    evidenceSha256 = $capture.evidenceSha256
})

function Assert-Refused([string]$Name, [scriptblock]$Mutate) {
    $baseline = Copy-ByJson $valid
    Assert-That ([bool](Test-OperationalReceipt $baseline)) "$Name baseline valid"
    $mutant = Copy-ByJson $valid
    & $Mutate $mutant
    Assert-That (-not (Test-OperationalReceipt $mutant)) "$Name refused"
}
function Get-AlteredHash([string]$Hash) {
    $first = if ($Hash[0] -ceq '0') { '1' } else { '0' }
    $first + $Hash.Substring(1)
}

Assert-Refused 'v2 status other than BLOCKED' { param($r) $r.status = 'FAILED' }
Assert-Refused 'reviewedDisposition missing field' { param($r) $r.reviewedDisposition.PSObject.Properties.Remove('evidenceSha256') }
Assert-Refused 'reviewedDisposition extra field' { param($r) $r.reviewedDisposition | Add-Member -NotePropertyName extra -NotePropertyValue 'x' }
Assert-Refused 'wrong review hash' { param($r) $r.reviewedDisposition.reviewSha256 = Get-AlteredHash ([string]$r.reviewedDisposition.reviewSha256) }
Assert-Refused 'mismatched native PID' { param($r) $r.provider.pid = [int]$r.provider.pid + 1 }
Assert-Refused 'wrong payload hash' { param($r) $r.payloadSha256 = Get-AlteredHash ([string]$r.payloadSha256) }
Assert-Refused 'artifact.complete true' { param($r) $r.artifact.complete = $true }
Assert-Refused 'artifact.path non-null' { param($r) $r.artifact.path = 'artifact.bin' }

# Typed boundary: schema is a ScriptProperty getter; validator must refuse without invoking it.
$counter = @{ Count = 0 }
$typed = Copy-ByJson $valid
Assert-That ([bool](Test-OperationalReceipt (Copy-ByJson $valid))) 'typed boundary baseline valid'
$typed.reviewedDisposition | Add-Member -MemberType ScriptProperty -Name schema -Force -Value ({ $counter.Count++; 'ReviewedBlockedDisposition/v1' }.GetNewClosure())
Assert-That (-not (Test-OperationalReceipt $typed)) 'ScriptProperty disposition.schema refused'
Assert-That ($counter.Count -eq 0) 'ScriptProperty getter counter is 0'

Assert-That (($receipt | ConvertTo-Json -Depth 100 -Compress) -ceq $originalJson) 'original receipt memory object unchanged'
$hashAfter = $inputPaths | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }
Assert-That (($hashBefore -join ',') -ceq ($hashAfter -join ',')) 'all three input file SHA256 unchanged'
