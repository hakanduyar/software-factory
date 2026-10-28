# Pure matcher: private parsed snapshots vs captured/verified predecessor scalars. Equality is not authority.
function Get-ReviewedBlockedPredecessorMatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$CapturedPredecessor88,
        [Parameter(Mandatory)][AllowNull()][object]$VerifiedBlockedInputs77,
        [Parameter(Mandatory)][AllowNull()][object]$StateEntry,
        [Parameter(Mandatory)][AllowNull()][object]$AckEntry
    )
    $fail = 'REVIEWED_BLOCKED_PREDECESSOR_MATCH_INVALID'
    $ord = [System.StringComparison]::Ordinal
    try {
        # Checks metadata (NoteProperty presence, optional exact count) then returns values by name.
        $props = {
            param($o, [string[]]$names, [int]$exact = -1)
            if ($null -eq $o -or $o -isnot [System.Management.Automation.PSCustomObject]) { throw $fail }
            $all = @($o.PSObject.Properties)
            $note = @($all | Where-Object { $_.MemberType -eq 'NoteProperty' })
            if ($exact -ge 0 -and ($note.Count -ne $exact -or $all.Count -ne $exact)) { throw $fail }
            # Pass 1: ordinal name match + NoteProperty check for every required name, no values read.
            $matched = @()
            foreach ($n in $names) {
                $hit = @($all | Where-Object { [string]::Equals($_.Name, $n, $ord) })
                if ($hit.Count -ne 1 -or $hit[0].MemberType -ne 'NoteProperty') { throw $fail }
                $matched += , $hit[0]
            }
            # Pass 2: build the returned scalar map.
            $r = @{}
            for ($i = 0; $i -lt $names.Count; $i++) { $r[$names[$i]] = $matched[$i].Value }
            $r
        }
        $str = { param($v) if ($v -isnot [string] -or $v.Length -eq 0) { throw $fail }; $v }
        $hex = { param($v) if ($v -isnot [string] -or $v.Length -ne 64 -or $v -cnotmatch '\A[0-9a-f]{64}\z') { throw $fail }; $v }
        $hexAny = { param($v) if ($v -isnot [string] -or $v.Length -ne 64 -or $v -notmatch '\A[0-9a-fA-F]{64}\z') { throw $fail }; $v.ToLowerInvariant() }
        $pos = { param($v) if (($v -isnot [int] -and $v -isnot [long]) -or $v -le 0) { throw $fail }; [long]$v }
        $eq = { param($a, $b) if (-not [string]::Equals($a, $b, $ord)) { throw $fail } }
        $full = {
            param($v)
            if ($v -isnot [string] -or -not [System.IO.Path]::IsPathRooted($v)) { throw $fail }
            [System.IO.Path]::GetFullPath($v)
        }
        $sha = {
            param([string]$text)
            $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($text)
            $h = [System.Security.Cryptography.SHA256]::Create()
            try { ([System.BitConverter]::ToString($h.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $h.Dispose() }
        }

        # Captured88
        $cap = & $props $CapturedPredecessor88 @('schema', 'previousSelectedClaim', 'expectedReview', 'stateDirFull') 4
        & $eq (& $str $cap.schema) 'ReviewedBlockedPredecessorCapture/v1'
        $sel = & $props $cap.previousSelectedClaim @('id', 'owner', 'provider', 'route', 'claimId', 'intentId', 'kind', 'receiptSha', 'planSha', 'statePath') 10
        $exp = & $props $cap.expectedReview @('reviewSha256', 'evidenceSha256') 2
        $reviewSha = & $hex $exp.reviewSha256
        $evidenceSha = & $hex $exp.evidenceSha256
        $stateDirFull = & $full $cap.stateDirFull
        foreach ($n in 'id', 'owner', 'provider', 'route', 'claimId', 'intentId', 'kind', 'statePath') { $null = & $str $sel[$n] }
        $selReceipt = & $hex $sel.receiptSha
        $selPlan = & $hex $sel.planSha
        $null = & $full $sel.statePath

        # Verified77
        $ver = & $props $VerifiedBlockedInputs77 @('schema', 'terminal', 'terminalSha256', 'receiptPath', 'expected', 'capture') 6
        & $eq (& $str $ver.schema) 'VerifiedBlockedSettlementInputs/v1'
        $vexp = & $props $ver.expected @('reviewSha256', 'evidenceSha256') 2
        & $eq (& $hex $vexp.reviewSha256) $reviewSha
        & $eq (& $hex $vexp.evidenceSha256) $evidenceSha
        $terminalSha = & $hex $ver.terminalSha256
        $terminalPath = & $full $ver.receiptPath
        $t = & $props $ver.terminal @('schemaVersion', 'status', 'taskId', 'runId', 'attempt', 'payloadSha256', 'provider', 'evidence')
        & $eq (& $str $t.schemaVersion) 'OperationalRunReceipt/v2'
        & $eq (& $str $t.status) 'BLOCKED'
        $tTask = & $str $t.taskId
        $tRun = & $str $t.runId
        $tAttempt = & $pos $t.attempt
        $tPayload = & $hex $t.payloadSha256
        $tProv = & $props $t.provider @('terminalReason', 'pid', 'startIdentity')
        $tReason = & $str $tProv.terminalReason
        $tPid = & $pos $tProv.pid
        $tStart = & $str $tProv.startIdentity
        $tEvid = & $props $t.evidence @('ticketSha256')
        $tTicket = & $hexAny $tEvid.ticketSha256

        # State entry
        $st = & $props $StateEntry @('status', 'actionId', 'kind', 'receiptSha256', 'planSha256', 'claim', 'settlement')
        & $eq (& $str $st.status) 'SETTLED'
        & $eq (& $str $st.actionId) $sel.id
        & $eq (& $str $st.kind) $sel.kind
        & $eq (& $hex $st.receiptSha256) $selReceipt
        & $eq (& $hex $st.planSha256) $selPlan
        $cl = & $props $st.claim @('owner', 'claimId')
        & $eq (& $str $cl.owner) $sel.owner
        & $eq (& $str $cl.claimId) $sel.claimId
        $se = & $props $st.settlement @('terminalReceiptPath', 'terminalSha256', 'taskId', 'runId', 'attempt', 'payloadSha256', 'ticketSha256', 'status', 'terminalReason', 'receiptSchemaVersion', 'reviewedDispositionReviewSha256', 'reviewedDispositionEvidenceSha256')
        if (-not [string]::Equals((& $full $se.terminalReceiptPath), $terminalPath, [System.StringComparison]::OrdinalIgnoreCase)) { throw $fail }
        & $eq (& $hex $se.terminalSha256) $terminalSha
        & $eq (& $str $se.taskId) $tTask
        & $eq (& $str $se.runId) $tRun
        if ((& $pos $se.attempt) -ne $tAttempt) { throw $fail }
        & $eq (& $hex $se.payloadSha256) $tPayload
        & $eq (& $hexAny $se.ticketSha256) $tTicket
        & $eq (& $str $se.status) 'BLOCKED'
        & $eq (& $str $se.terminalReason) $tReason
        & $eq (& $str $se.receiptSchemaVersion) 'OperationalRunReceipt/v2'
        & $eq (& $hex $se.reviewedDispositionReviewSha256) $reviewSha
        & $eq (& $hex $se.reviewedDispositionEvidenceSha256) $evidenceSha

        # Ack entry
        $ak = & $props $AckEntry @('schema', 'entryId', 'owner', 'claimId', 'intentId', 'executionBinding')
        & $eq (& $str $ak.schema) 'host-dispatch-acknowledgement/v1'
        & $eq (& $str $ak.entryId) $sel.id
        & $eq (& $str $ak.owner) $sel.owner
        & $eq (& $str $ak.claimId) $sel.claimId
        & $eq (& $str $ak.intentId) $sel.intentId
        $b = & $props $ak.executionBinding @('schema', 'taskId', 'ticketSha256', 'payloadSha256', 'runId', 'attempt', 'receiptSha', 'planSha', 'identity')
        & $eq (& $str $b.schema) 'host-dispatch-execution-binding/v1'
        & $eq (& $hex $b.receiptSha) $selReceipt
        & $eq (& $hex $b.planSha) $selPlan
        & $eq (& $str $b.taskId) $tTask
        & $eq (& $str $b.runId) $tRun
        if ((& $pos $b.attempt) -ne $tAttempt) { throw $fail }
        & $eq (& $hex $b.payloadSha256) $tPayload
        & $eq (& $hexAny $b.ticketSha256) $tTicket
        $id = & $props $b.identity @('kind', 'pid', 'startIdentity')
        & $eq (& $str $id.kind) 'native'
        if ((& $pos $id.pid) -ne $tPid) { throw $fail }
        & $eq (& $str $id.startIdentity) $tStart

        # Fingerprint after validation only
        $entrySha = & $sha (ConvertTo-Json -InputObject $StateEntry -Depth 100 -Compress)
        $ackSha = & $sha (ConvertTo-Json -InputObject $AckEntry -Depth 100 -Compress)
        $tuple = [ordered]@{
            selectedId = $sel.id; selectedOwner = $sel.owner; selectedProvider = $sel.provider
            selectedRoute = $sel.route; selectedClaimId = $sel.claimId; selectedIntentId = $sel.intentId
            selectedKind = $sel.kind; selectedReceiptSha = $selReceipt; selectedPlanSha = $selPlan
            selectedStatePath = $sel.statePath; stateDirFull = $stateDirFull
            terminalSchemaVersion = 'OperationalRunReceipt/v2'; terminalPathFull = $terminalPath
            terminalSha256 = $terminalSha; terminalTaskId = $tTask; terminalRunId = $tRun
            terminalAttempt = $tAttempt; terminalPayloadSha256 = $tPayload; terminalTicketSha256 = $tTicket
            terminalReason = $tReason; nativePid = $tPid; nativeStartIdentity = $tStart
            reviewSha256 = $reviewSha; evidenceSha256 = $evidenceSha; entrySha256 = $entrySha; ackSha256 = $ackSha
        }
        $fingerprint = & $sha (ConvertTo-Json -InputObject $tuple -Depth 100 -Compress)
        [pscustomobject][ordered]@{
            schema = 'ReviewedBlockedPredecessorMatch/v1'
            fingerprintSha256 = $fingerprint
            entrySha256 = $entrySha
            ackSha256 = $ackSha
            predecessorIntentId = $sel.intentId
        }
    }
    catch {
        throw $fail
    }
}