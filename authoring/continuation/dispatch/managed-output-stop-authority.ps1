function Resolve-ManagedOutputStopAuthority {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$TicketContract,
        [Parameter(Mandatory)][byte[]]$CapturedTicket,
        [Parameter(Mandatory)][string]$ControlRoot
    )
    # Authenticates the no-output-stop descriptor against anchored governance files read through the trusted pinned reader.
    # Authenticated semantics only: not model permission, global health, or a claim that output-stop removal is implemented.
    $anchorPolicy = '646b1cc3275ca3e2d6f04a8868bfafda1d043076027a85cf6d06e2e275c193f0'
    $anchorReview = '4c140c35f112856183181b8aa5d360b63997a950f416b3cebff42e92a35f6139'
    $anchorHuman = '595b9f9bb11f9d9afc9ad7d237ccad3f8fee42a1ce0ca64f025739b5eff1a387'

    $names = { param($o) if ($null -eq $o) { @() } elseif ($o -is [System.Collections.IDictionary]) { @($o.Keys) } else { @($o.PSObject.Properties.Name) } }
    $hasProp = { param($o, [string[]]$n) $p = & $names $o; @($n | Where-Object { $p -cnotcontains $_ }).Count -eq 0 }
    $exactNames = { param($o, [string[]]$n) $p = & $names $o; $p.Count -eq $n.Count -and @($n | Where-Object { $p -cnotcontains $_ }).Count -eq 0 }
    $samePath = { param($a, $b) $a -is [string] -and $b -is [string] -and [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase) }
    $refMatches = {
        param($ref, [string]$path, [string]$hash)
        $ref -is [PSCustomObject] -and (& $exactNames $ref @('path', 'sha256')) -and (& $samePath $ref.path $path) -and $ref.sha256 -is [string] -and $ref.sha256 -ceq $hash
    }
    $contractRefMatches = {
        param($ref, [string]$path, [string]$hash)
        $ref -is [PSCustomObject] -and (& $exactNames $ref @('Path', 'Sha256')) -and (& $samePath $ref.Path $path) -and $ref.Sha256 -is [string] -and $ref.Sha256 -ceq $hash
    }

    if ($null -eq $TicketContract -or -not (& $hasProp $TicketContract @('Valid', 'OutputStopMode', 'OutputStops', 'Budget')) -or $TicketContract.Valid -isnot [bool] -or $TicketContract.Valid -ne $true) { throw 'OUTPUTSTOP_CONTRACT: ticket contract is not valid.' }
    $mode = $TicketContract.OutputStopMode
    if ($mode -isnot [string] -or ($mode -cne 'LEGACY_HARDLIMIT' -and $mode -cne 'OBSERVE_ONLY_DESCRIPTOR')) { throw 'OUTPUTSTOP_CONTRACT: unknown output stop mode.' }
    $isLegacy = ($mode -ceq 'LEGACY_HARDLIMIT')
    if ($isLegacy -and $null -ne $TicketContract.OutputStops) { throw 'OUTPUTSTOP_CONTRACT: legacy mode must not carry a descriptor.' }
    if (-not $isLegacy -and $null -eq $TicketContract.OutputStops) { throw 'OUTPUTSTOP_CONTRACT: descriptor mode requires a descriptor.' }

    # Captured ticket: strict decode, then recompute the native contract and compare.
    if ($CapturedTicket.Length -gt 1048576) { throw 'OUTPUTSTOP_TICKET: captured ticket exceeds 1 MiB.' }
    $offset = 0
    if ($CapturedTicket.Length -ge 3 -and $CapturedTicket[0] -eq 0xEF -and $CapturedTicket[1] -eq 0xBB -and $CapturedTicket[2] -eq 0xBF) { $offset = 3 }
    try { $ticketText = [System.Text.UTF8Encoding]::new($false, $true).GetString($CapturedTicket, $offset, $CapturedTicket.Length - $offset) } catch { throw 'OUTPUTSTOP_TICKET: captured ticket is not valid UTF-8.' }
    $doc = $null
    try {
        $options = [System.Text.Json.JsonDocumentOptions]::new()
        $options.MaxDepth = 64
        $options.AllowTrailingCommas = $false
        $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
        try { $doc = [System.Text.Json.JsonDocument]::Parse($ticketText, $options) } catch { throw 'OUTPUTSTOP_TICKET: captured ticket is not strict JSON.' }
        if ($doc.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'OUTPUTSTOP_TICKET: root must be a JSON object.' }
        $pending = [System.Collections.Generic.Stack[System.Text.Json.JsonElement]]::new()
        $pending.Push($doc.RootElement)
        while ($pending.Count -gt 0) {
            $element = $pending.Pop()
            if ($element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
                foreach ($property in $element.EnumerateObject()) {
                    if (-not $seen.Add($property.Name)) { throw 'OUTPUTSTOP_TICKET: duplicate or case-ambiguous property name.' }
                    $pending.Push($property.Value)
                }
            } elseif ($element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
                foreach ($item in $element.EnumerateArray()) { $pending.Push($item) }
            }
        }
    } finally { if ($null -ne $doc) { $doc.Dispose() } }
    try { $ticket = $ticketText | ConvertFrom-Json -DateKind String -Depth 64 } catch { throw 'OUTPUTSTOP_TICKET: captured ticket could not be converted.' }
    if ($ticket -isnot [PSCustomObject] -or -not (& $hasProp $ticket @('payloadSha256', 'budget')) -or $ticket.payloadSha256 -isnot [string] -or $ticket.budget -isnot [PSCustomObject]) { throw 'OUTPUTSTOP_TICKET: payloadSha256 or budget is missing.' }
    $recomputed = Test-ManagedNativeTicketContract -Ticket $ticket -ExpectedPayloadSha256 $ticket.payloadSha256
    if ($null -eq $recomputed -or $recomputed.Valid -isnot [bool] -or $recomputed.Valid -ne $true) { throw 'OUTPUTSTOP_CONTRACT: recomputed ticket contract is not valid.' }
    if ((ConvertTo-Json -InputObject $recomputed -Depth 12 -Compress) -cne (ConvertTo-Json -InputObject $TicketContract -Depth 12 -Compress)) { throw 'OUTPUTSTOP_CONTRACT: supplied contract differs from the recomputed contract.' }
    if ($recomputed.OutputStopMode -cne $mode) { throw 'OUTPUTSTOP_CONTRACT: recomputed mode differs.' }

    $capturedStops = @($ticket.budget.PSObject.Properties | Where-Object { $_.Name -ieq 'outputStops' })
    if ($isLegacy) {
        if ($capturedStops.Count -ne 0) { throw 'OUTPUTSTOP_CONTRACT: legacy contract but captured ticket carries outputStops.' }
        return $null
    }
    if ($capturedStops.Count -ne 1 -or $capturedStops[0].Name -cne 'outputStops') { throw 'OUTPUTSTOP_DESCRIPTOR: captured outputStops is missing or case-ambiguous.' }
    $captured = $capturedStops[0].Value
    $desc = $TicketContract.OutputStops
    $budget = $TicketContract.Budget
    if ($null -eq $budget -or -not (& $hasProp $budget @('AdditionalOutputMax', 'PhaseAggregateCeiling')) -or $null -ne $budget.AdditionalOutputMax -or $null -ne $budget.PhaseAggregateCeiling) { throw 'OUTPUTSTOP_CONTRACT: descriptor mode must carry null output ceilings.' }
    if ($captured -isnot [PSCustomObject] -or -not (& $exactNames $captured @('schema', 'policyRef', 'policyReviewRef')) -or $captured.schema -isnot [string] -or $captured.schema -cne 'NoOutputStopBudget/v1') { throw 'OUTPUTSTOP_DESCRIPTOR: captured descriptor is malformed.' }
    if ($desc -isnot [PSCustomObject] -or -not (& $exactNames $desc @('Schema', 'PolicyRef', 'PolicyReviewRef')) -or $desc.Schema -isnot [string] -or $desc.Schema -cne 'NoOutputStopBudget/v1') { throw 'OUTPUTSTOP_DESCRIPTOR: contract descriptor is malformed.' }

    # Fixed governance paths derived from the canonical ControlRoot; no caller-supplied alternate policy is accepted.
    $govDir = $ControlRoot.TrimEnd('\') + '\resume-20261020\output-stop-removal-20261027-1'
    $policyPath = $govDir + '\governing-policy.json'
    $reviewPath = $govDir + '\independent-review\governing-policy-review.json'
    $humanPath = $govDir + '\human-direction.json'
    if (-not (& $refMatches $captured.policyRef $policyPath $anchorPolicy) -or -not (& $refMatches $captured.policyReviewRef $reviewPath $anchorReview)) { throw 'OUTPUTSTOP_DESCRIPTOR: captured refs differ from the anchored governance files.' }
    if (-not (& $contractRefMatches $desc.PolicyRef $policyPath $anchorPolicy) -or -not (& $contractRefMatches $desc.PolicyReviewRef $reviewPath $anchorReview)) { throw 'OUTPUTSTOP_DESCRIPTOR: contract refs differ from the anchored governance files.' }

    # Read every anchored file through the trusted pinned reader (validates ControlRoot, hash, strict JSON).
    $policyRead = Read-ManagedPinnedEvidenceJson -Reference ([PSCustomObject]@{ path = $policyPath; sha256 = $anchorPolicy }) -ControlRoot $ControlRoot
    $reviewRead = Read-ManagedPinnedEvidenceJson -Reference ([PSCustomObject]@{ path = $reviewPath; sha256 = $anchorReview }) -ControlRoot $ControlRoot
    $humanRead = Read-ManagedPinnedEvidenceJson -Reference ([PSCustomObject]@{ path = $humanPath; sha256 = $anchorHuman }) -ControlRoot $ControlRoot
    $policy = $policyRead.Value
    $review = $reviewRead.Value
    $human = $humanRead.Value

    # Policy semantics.
    if ($policy -isnot [PSCustomObject] -or -not (& $hasProp $policy @('schema', 'taskId', 'mode', 'authority', 'semantics', 'preserved', 'status', 'runtimeAuthority'))) { throw 'OUTPUTSTOP_POLICY: policy is malformed.' }
    if ($policy.schema -isnot [string] -or $policy.schema -cne 'ManagedNoOutputStopPolicy/v1' -or $policy.taskId -isnot [string] -or $policy.taskId -cne 'REMOVE_ALL_ARTIFICIAL_OUTPUT_STOPS_20261027' -or $policy.mode -isnot [string] -or $policy.mode -cne 'OBSERVE_ONLY') { throw 'OUTPUTSTOP_POLICY: schema, task or mode mismatch.' }
    if ($policy.status -isnot [string] -or $policy.status -cne 'HUMAN_AUTHORIZED_SEMANTICS_IMPLEMENTATION_PENDING' -or $policy.runtimeAuthority -isnot [bool] -or $policy.runtimeAuthority -ne $false) { throw 'OUTPUTSTOP_POLICY: status or runtimeAuthority mismatch.' }
    if (-not (& $hasProp $policy.authority @('humanDirectionRef')) -or -not (& $refMatches $policy.authority.humanDirectionRef $humanPath $anchorHuman)) { throw 'OUTPUTSTOP_POLICY: human direction ref is not the anchored file.' }
    $sem = $policy.semantics
    if ($sem -isnot [PSCustomObject] -or -not (& $hasProp $sem @('usageAccounting', 'artificialOutputTokenCeiling', 'historicalRecords', 'reportByteStop', 'providerOutputCapEnvironment', 'artificialMaxTurns', 'perPhaseOutputCeiling'))) { throw 'OUTPUTSTOP_POLICY: semantics are malformed.' }
    if ($null -ne $sem.artificialOutputTokenCeiling -or $null -ne $sem.reportByteStop -or $null -ne $sem.perPhaseOutputCeiling) { throw 'OUTPUTSTOP_POLICY: output ceilings must be null.' }
    if ($sem.providerOutputCapEnvironment -isnot [string] -or $sem.providerOutputCapEnvironment -cne 'ABSENT' -or $sem.artificialMaxTurns -isnot [string] -or $sem.artificialMaxTurns -cne 'ABSENT') { throw 'OUTPUTSTOP_POLICY: output cap environment and max turns must be ABSENT.' }
    if ($sem.usageAccounting -isnot [string] -or [string]::IsNullOrWhiteSpace($sem.usageAccounting) -or $sem.historicalRecords -isnot [string] -or [string]::IsNullOrWhiteSpace($sem.historicalRecords)) { throw 'OUTPUTSTOP_POLICY: history retention semantics are missing.' }
    if ($policy.preserved -isnot [System.Array] -or $policy.preserved.Count -lt 1 -or @($policy.preserved | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) { throw 'OUTPUTSTOP_POLICY: unrelated controls are not preserved.' }

    # Independent review.
    if ($review -isnot [PSCustomObject] -or -not (& $hasProp $review @('schema', 'decision', 'policySha256', 'reviewer'))) { throw 'OUTPUTSTOP_REVIEW: review is malformed.' }
    if ($review.schema -isnot [string] -or $review.schema -cne 'IndependentOutputStopPolicyReview/v1' -or $review.decision -isnot [string] -or $review.decision -cne 'ACCEPTED_NO_OUTPUT_STOP_SEMANTICS' -or $review.policySha256 -isnot [string] -or $review.policySha256 -cne $anchorPolicy -or $review.reviewer -isnot [string] -or $review.reviewer -cne '/root/git_delivery_audit') { throw 'OUTPUTSTOP_REVIEW: review does not accept the anchored policy.' }

    # Human direction.
    if ($human -isnot [PSCustomObject] -or -not (& $hasProp $human @('schema', 'status'))) { throw 'OUTPUTSTOP_HUMAN: directive is malformed.' }
    if ($human.schema -isnot [string] -or $human.schema -cne 'HumanOutputStopRemovalDirective/v1' -or $human.status -isnot [string] -or $human.status -cne 'EXPLICIT_HUMAN_SCOPE_AUTHORIZED_IMPLEMENTATION_PENDING') { throw 'OUTPUTSTOP_HUMAN: directive schema or status mismatch.' }

    return [PSCustomObject]@{
        Schema = 'ManagedOutputStopAuthority/v1'
        Mode = 'OBSERVE_ONLY'
        PolicyRef = [PSCustomObject]@{ Path = $policyRead.Path; Sha256 = $policyRead.Sha256 }
        PolicyReviewRef = [PSCustomObject]@{ Path = $reviewRead.Path; Sha256 = $reviewRead.Sha256 }
        HumanDirectionRef = [PSCustomObject]@{ Path = $humanRead.Path; Sha256 = $humanRead.Sha256 }
    }
}
