Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'tests.ps1') | Out-Null

$failures = @()

try {
    $dir = New-TempDir
    $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'a.json' -TaskId 'Task' -PayloadSha ('a'*64) -RunId 'run1' -Status 'FAILED' -Attempt 1 -Destination 'dest1'
    Write-Receipt -Dir $dir -Name 'b.json' -TaskId 'task' -PayloadSha ('a'*64) -RunId 'run1' -Status 'FAILED' -Attempt 1 -Destination 'dest1'

    $r = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    if ($r.totalReceipts -ne 2) { throw "expected totalReceipts=2, got $($r.totalReceipts)" }
    if ($r.newEvents -ne 2) { throw "expected newEvents=2, got $($r.newEvents)" }
    if ($r.pendingCount -ne 2) { throw "expected pendingCount=2, got $($r.pendingCount)" }
    if ($r.laneStatuses.Count -ne 2) { throw "expected laneStatuses.Count=2, got $($r.laneStatuses.Count)" }

    $events = @(Read-Outbox -OutboxPath $outbox)
    $keys = @($events | ForEach-Object { $_.key })
    if (($keys | Select-Object -Unique).Count -ne 2) { throw "expected 2 distinct keys, got $(($keys | Select-Object -Unique).Count)" }

    $r2 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    if ($r2.newEvents -ne 0) { throw "expected newEvents=0 on repeat, got $($r2.newEvents)" }
    if ($r2.pendingCount -ne 2) { throw "expected pendingCount still 2 on repeat, got $($r2.pendingCount)" }
} catch { $failures += "DistinctCaseIdentities : $_" }

try {
    $dir = New-TempDir
    $outbox = Join-Path $dir 'outbox.json'
    Write-Receipt -Dir $dir -Name 'a.json' -TaskId 'Task' -PayloadSha ('a'*64) -RunId 'run1' -Status 'FAILED' -Attempt 1 -Destination 'dest1'
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox | Out-Null
    $events = @(Read-Outbox -OutboxPath $outbox)
    $realKey = $events[0].key
    $wrongKey = Get-EventKey -TaskId 'task' -PayloadSha256 ('a'*64) -RunId 'run1' -Status 'FAILED' -Attempt 1
    if ($wrongKey -ceq $realKey) { throw "test setup invalid: wrongKey should differ from realKey" }

    $r1 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -DeliveryEvidence @(@{ key = $wrongKey; proof = 'proof1' })
    if ($r1.deliveredCount -ne 0) { throw "wrong-case evidence key must not deliver, got deliveredCount=$($r1.deliveredCount)" }
    if ($r1.pendingCount -ne 1) { throw "expected pendingCount=1 after wrong-case evidence, got $($r1.pendingCount)" }

    $claimedAt = (Get-Date).ToUniversalTime().AddSeconds(-200).ToString('o')
    $r2 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -Claims @(@{ key = $wrongKey; owner = 'ownerA'; claimedAt = $claimedAt })
    if ($r2.claimsExpired -ne 0) { throw "wrong-case claim key must not match, got claimsExpired=$($r2.claimsExpired)" }

    $wrongTaskConsent = @(@{ taskId = 'task'; payloadSha256 = ('a'*64); destination = 'dest1' })
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -ConsentRecords $wrongTaskConsent | Out-Null
    $e = @(Read-Outbox -OutboxPath $outbox)
    if ($null -ne $e[0].consentEligibility) { throw "wrong-case task consent must not bind" }

    $wrongDestConsent = @(@{ taskId = 'Task'; payloadSha256 = ('a'*64); destination = 'Dest1' })
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -ConsentRecords $wrongDestConsent | Out-Null
    $e = @(Read-Outbox -OutboxPath $outbox)
    if ($null -ne $e[0].consentEligibility) { throw "wrong-case destination consent must not bind" }

    $exactConsent = @(@{ taskId = 'Task'; payloadSha256 = ('a'*64); destination = 'dest1' })
    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -ConsentRecords $exactConsent | Out-Null
    $e = @(Read-Outbox -OutboxPath $outbox)
    if ($e[0].consentEligibility -ne 'NORMAL_REVIEW_ELIGIBLE') { throw "exact consent must set NORMAL_REVIEW_ELIGIBLE" }
    if ($e[0].status -ne 'FAILED') { throw "consent must never change status" }
    $r3 = Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox
    if ($r3.laneStatuses['Task'] -ne 'BLOCKED') { throw "lane must remain BLOCKED despite consent eligibility" }

    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox -DeliveryEvidence @(@{ key = $realKey; proof = 'realproof' }) | Out-Null
    $e = @(Read-Outbox -OutboxPath $outbox)
    if ($e[0].deliveryStatus -ne 'DELIVERED') { throw "exact key with proof must deliver" }

    Invoke-ReceiptReconciliation -ReceiptDir $dir -OutboxPath $outbox | Out-Null
    $e = @(Read-Outbox -OutboxPath $outbox)
    if ($e[0].deliveryStatus -ne 'DELIVERED' -or $e[0].proof -ne 'realproof') { throw "restart must preserve delivered proof" }
} catch { $failures += "WrongCaseEvidenceAndConsent : $_" }

if ($failures.Count -gt 0) {
    throw "CASE-IDENTITY FAILURES ($($failures.Count)):`n" + ($failures -join "`n")
}

Write-Output "ALL CASE-IDENTITY TESTS PASSED"