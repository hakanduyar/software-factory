function Test-BacklogAcceptedBinding {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [AllowNull()][object]$Requirement,
        [AllowNull()][object]$Accepted
    )

    try {
        if ($null -eq $Requirement -or $null -eq $Accepted) { return $false }

        $requiredNames = @('taskId', 'candidateSha256', 'reviewSha256')
        $acceptedNames = @('taskId', 'candidateSha256', 'reviewSha256', 'status')

        # Exact-shape check: PSCustomObject, only NoteProperty members, exact case-sensitive name set.
        $hasShape = {
            param($Value, [string[]]$Names)
            if ($Value -isnot [psobject] -or $Value.PSObject.TypeNames[0] -ne 'System.Management.Automation.PSCustomObject') { return $false }
            $props = @($Value.PSObject.Properties)
            if ($props.Count -ne $Names.Count) { return $false }
            foreach ($p in $props) {
                if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
            }
            foreach ($n in $Names) {
                if (@($props | Where-Object { [string]::Equals($_.Name, $n, [System.StringComparison]::Ordinal) }).Count -ne 1) { return $false }
            }
            return $true
        }

        if (-not (& $hasShape $Requirement $requiredNames)) { return $false }
        if (-not (& $hasShape $Accepted $acceptedNames)) { return $false }

        $taskIdRequired = $Requirement.taskId
        if ($taskIdRequired -isnot [string] -or $taskIdRequired.Length -eq 0) { return $false }
        if ($Accepted.taskId -isnot [string] -or $Accepted.taskId.Length -eq 0) { return $false }
        if ($Accepted.status -isnot [string] -or -not [string]::Equals($Accepted.status, 'ACCEPTED_SCOPED', [System.StringComparison]::Ordinal)) { return $false }

        foreach ($field in @('candidateSha256', 'reviewSha256')) {
            foreach ($obj in @($Requirement, $Accepted)) {
                $v = $obj.$field
                if ($v -isnot [string] -or $v.Length -ne 64 -or -not ($v -cmatch '\A[0-9a-f]{64}\z')) { return $false }
            }
        }

        foreach ($field in @('taskId', 'candidateSha256', 'reviewSha256')) {
            if (-not [string]::Equals([string]$Requirement.$field, [string]$Accepted.$field, [System.StringComparison]::Ordinal)) { return $false }
        }
        return $true
    }
    catch {
        return $false
    }
}

function Get-BacklogDependencyOrder {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [AllowEmptyCollection()]
        [object]$Tasks
    )

    $prefix = 'BACKLOG_GRAPH_INVALID'
    $fail = { param([string]$Reason) throw "${prefix}: $Reason" }
    $isText = { param($Value) ($Value -is [string]) -and -not [string]::IsNullOrWhiteSpace($Value) }
    $isPlainObject = {
        param($Value, [string[]]$Names)
        if ($Value -isnot [System.Management.Automation.PSObject]) { return $false }
        if ($Value.PSObject.TypeNames[0] -ne 'System.Management.Automation.PSCustomObject') { return $false }
        $props = @($Value.PSObject.Properties)
        if ($props.Count -ne $Names.Count) { return $false }
        $actual = [string[]]@($props | ForEach-Object { $_.Name })
        [array]::Sort($actual, [System.StringComparer]::Ordinal)
        $expected = [string[]]@($Names)
        [array]::Sort($expected, [System.StringComparer]::Ordinal)
        for ($i = 0; $i -lt $expected.Length; $i++) {
            if ($actual[$i] -cne $expected[$i]) { return $false }
        }
        foreach ($p in $props) {
            if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { return $false }
        }
        $true
    }

    if ($Tasks -isnot [object[]]) { & $fail 'Tasks must be an array' }
    $count = $Tasks.Length
    if ($count -lt 1 -or $count -gt 1000) { & $fail 'Tasks must contain 1..1000 items' }

    $indexById = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::Ordinal)
    $ids = [string[]]::new($count)
    for ($i = 0; $i -lt $count; $i++) {
        $task = $Tasks[$i]
        if (-not (& $isPlainObject $task @('id', 'dependencies', 'externalBlocker', 'requiredAcceptance'))) {
            & $fail "task $i must be a PSCustomObject with exactly id/dependencies/externalBlocker/requiredAcceptance note properties"
        }
        if (-not (& $isText $task.id)) { & $fail "task $i id must be a nonblank string" }
        if ($indexById.ContainsKey($task.id)) { & $fail "duplicate task id at $i" }
        $indexById[$task.id] = $i
        $ids[$i] = $task.id
    }

    $depIndexes = [int[][]]::new($count)
    for ($i = 0; $i -lt $count; $i++) {
        $task = $Tasks[$i]
        $deps = $task.dependencies
        if ($deps -isnot [object[]] -or $deps.Length -gt 64) { & $fail "task $i dependencies must be an array of at most 64 items" }
        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        $resolved = [int[]]::new($deps.Length)
        for ($d = 0; $d -lt $deps.Length; $d++) {
            $dep = $deps[$d]
            if (-not (& $isText $dep)) { & $fail "task $i dependency $d must be a nonblank string" }
            if (-not $seen.Add($dep)) { & $fail "task $i has duplicate dependency" }
            if (-not $indexById.ContainsKey($dep)) { & $fail "task $i has unknown dependency" }
            if ($indexById[$dep] -eq $i) { & $fail "task $i depends on itself" }
            $resolved[$d] = $indexById[$dep]
        }
        $depIndexes[$i] = $resolved

        if ($null -ne $task.externalBlocker -and -not (& $isText $task.externalBlocker)) {
            & $fail "task $i externalBlocker must be null or a nonblank string"
        }

        $acceptance = $task.requiredAcceptance
        if ($null -ne $acceptance) {
            if (-not (& $isPlainObject $acceptance @('taskId', 'candidateSha256', 'reviewSha256'))) {
                & $fail "task $i requiredAcceptance must be null or an exact taskId/candidateSha256/reviewSha256 object"
            }
            if (-not (& $isText $acceptance.taskId)) { & $fail "task $i requiredAcceptance.taskId must be nonblank" }
            foreach ($digest in @($acceptance.candidateSha256, $acceptance.reviewSha256)) {
                if ($digest -isnot [string] -or $digest -cnotmatch '\A[0-9a-f]{64}\z') {
                    & $fail "task $i requiredAcceptance digest must be 64 lowercase hex characters"
                }
            }
        }
    }

    # Kahn's algorithm; the ready set is ordered by original index for stable ties.
    $pending = [int[]]::new($count)
    $dependents = [System.Collections.Generic.List[int][]]::new($count)
    for ($i = 0; $i -lt $count; $i++) { $dependents[$i] = [System.Collections.Generic.List[int]]::new() }
    $ready = [System.Collections.Generic.SortedSet[int]]::new()
    for ($i = 0; $i -lt $count; $i++) {
        $pending[$i] = $depIndexes[$i].Length
        foreach ($d in $depIndexes[$i]) { $dependents[$d].Add($i) }
        if ($pending[$i] -eq 0) { [void]$ready.Add($i) }
    }

    $order = [System.Collections.Generic.List[string]]::new()
    while ($ready.Count -gt 0) {
        $next = $ready.Min
        [void]$ready.Remove($next)
        $order.Add($ids[$next])
        foreach ($dependent in $dependents[$next]) {
            $pending[$dependent]--
            if ($pending[$dependent] -eq 0) { [void]$ready.Add($dependent) }
        }
    }
    if ($order.Count -ne $count) { & $fail 'dependency cycle detected' }

    [pscustomobject]@{ order = [string[]]$order.ToArray() }
}

function Get-ValidatedBacklogProjectionInput {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object]$Snapshot
    )

    $invalid = 'BACKLOG_PROJECTION_INVALID'
    try {
        $names = @('schema', 'planVersion', 'planSha256', 'tasks', 'accepted')
        if ($Snapshot -isnot [System.Management.Automation.PSObject] -or $Snapshot.PSObject.TypeNames[0] -ne 'System.Management.Automation.PSCustomObject') { throw 'shape' }
        $props = @($Snapshot.PSObject.Properties)
        if ($props.Count -ne $names.Count) { throw 'shape' }
        foreach ($p in $props) {
            if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw 'shape' }
        }
        foreach ($n in $names) {
            if (@($props | Where-Object { [string]::Equals($_.Name, $n, [System.StringComparison]::Ordinal) }).Count -ne 1) { throw 'shape' }
        }

        if ($Snapshot.schema -isnot [string] -or -not [string]::Equals($Snapshot.schema, 'BacklogDependencyProjectionInput/v1', [System.StringComparison]::Ordinal)) { throw 'schema' }
        $planVersion = $Snapshot.planVersion
        if ($planVersion -isnot [string] -or [string]::IsNullOrWhiteSpace($planVersion)) { throw 'planVersion' }
        $planSha256 = $Snapshot.planSha256
        if ($planSha256 -isnot [string] -or $planSha256.Length -ne 64 -or $planSha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'planSha256' }

        $tasks = $Snapshot.tasks
        $accepted = $Snapshot.accepted
        if ($tasks -isnot [object[]]) { throw 'tasks' }
        if ($accepted -isnot [object[]] -or $accepted.Length -gt 1000) { throw 'accepted' }

        [void](Get-BacklogDependencyOrder -Tasks $tasks)

        foreach ($task in $tasks) {
            $req = $task.requiredAcceptance
            if ($null -ne $req -and -not [string]::Equals($req.taskId, $task.id, [System.StringComparison]::Ordinal)) { throw 'requirement' }
        }

        $acceptedById = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
        foreach ($record in $accepted) {
            if ($record -isnot [System.Management.Automation.PSObject] -or $record.PSObject.TypeNames[0] -ne 'System.Management.Automation.PSCustomObject') { throw 'record' }
            $recordProps = @($record.PSObject.Properties)
            if ($recordProps.Count -ne 4) { throw 'record' }
            foreach ($rp in $recordProps) {
                if ($rp.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw 'record' }
            }
            foreach ($rn in @('taskId', 'candidateSha256', 'reviewSha256', 'status')) {
                if (@($recordProps | Where-Object { [string]::Equals($_.Name, $rn, [System.StringComparison]::Ordinal) }).Count -ne 1) { throw 'record' }
            }
            $copy = [pscustomobject]@{
                taskId          = $record.taskId
                candidateSha256 = $record.candidateSha256
                reviewSha256    = $record.reviewSha256
            }
            if (-not (Test-BacklogAcceptedBinding -Requirement $copy -Accepted $record)) { throw 'record' }
            if ($acceptedById.ContainsKey($record.taskId)) { throw 'duplicate' }
            $acceptedById[$record.taskId] = [pscustomobject]@{
                taskId          = [string]$record.taskId
                candidateSha256 = [string]$record.candidateSha256
                reviewSha256    = [string]$record.reviewSha256
                status          = [string]$record.status
            }
        }

        [pscustomobject]@{
            planVersion  = $planVersion
            planSha256   = $planSha256
            tasks        = $tasks
            acceptedById = $acceptedById
        }
    }
    catch {
        throw $invalid
    }
}

function Resolve-BacklogDependencyProjection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object]$Snapshot
    )

    $context = Get-ValidatedBacklogProjectionInput -Snapshot $Snapshot

    $completed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($task in $context.tasks) {
        if ($context.acceptedById.ContainsKey($task.id) -and
            (Test-BacklogAcceptedBinding -Requirement $task.requiredAcceptance -Accepted $context.acceptedById[$task.id])) {
            [void]$completed.Add($task.id)
        }
    }

    $candidates = [System.Collections.Generic.List[string]]::new()
    $blocked = [System.Collections.Generic.List[object]]::new()
    foreach ($task in $context.tasks) {
        if ($completed.Contains($task.id)) { continue }
        $reasons = [System.Collections.Generic.List[string]]::new()
        if ($null -ne $task.externalBlocker) { $reasons.Add("EXTERNAL:$($task.externalBlocker)") }
        foreach ($dependency in $task.dependencies) {
            if (-not $completed.Contains($dependency)) { $reasons.Add("DEPENDENCY_NOT_ACCEPTED:$dependency") }
        }
        if ($reasons.Count -eq 0) {
            $candidates.Add($task.id)
        }
        else {
            $blocked.Add([pscustomobject]@{ id = $task.id; reasons = [string[]]$reasons.ToArray() })
        }
    }

    [pscustomobject]@{
        schema      = 'BacklogDependencyProjection/v1'
        planVersion = $context.planVersion
        planSha256  = $context.planSha256
        candidates  = [string[]]$candidates.ToArray()
        blocked     = [object[]]$blocked.ToArray()
        nextTrigger = 'PLAN_OR_ACCEPTANCE_CHANGED'
    }
}
