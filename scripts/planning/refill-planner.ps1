$script:RefillPlannerPinPath = [System.IO.Path]::Combine($PSScriptRoot, 'backlog-dependency-projection.ps1')
$script:RefillPlannerPinSha256 = '1DFAC70A2EA2E2F584EF01393F461C901D4950FE9F2C02CE14831C9CD7FD1F5D'
if (-not [System.IO.File]::Exists($script:RefillPlannerPinPath)) { throw 'REFILL_DEPENDENCY_PIN_MISSING' }
$refillPinBytes = [System.IO.File]::ReadAllBytes($script:RefillPlannerPinPath)
$refillPinSha = [System.Security.Cryptography.SHA256]::Create()
try { $refillPinActual = [System.BitConverter]::ToString($refillPinSha.ComputeHash($refillPinBytes)).Replace('-', '') }
finally { $refillPinSha.Dispose() }
if (-not [string]::Equals($refillPinActual, $script:RefillPlannerPinSha256, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'REFILL_DEPENDENCY_PIN_MISMATCH' }
$refillPinOffset = 0
if ($refillPinBytes.Length -ge 3 -and $refillPinBytes[0] -eq 0xEF -and $refillPinBytes[1] -eq 0xBB -and $refillPinBytes[2] -eq 0xBF) { $refillPinOffset = 3 }
$refillPinText = [System.Text.Encoding]::UTF8.GetString($refillPinBytes, $refillPinOffset, $refillPinBytes.Length - $refillPinOffset)
. ([scriptblock]::Create($refillPinText))

function Get-ContinuityRefillProposal175 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [object]$BacklogSnapshot,

        [Parameter(Mandatory)]
        [AllowNull()]
        [object]$ControllerFacts
    )

    Set-StrictMode -Version 3.0
    $ord = [System.StringComparer]::Ordinal

    function Assert-Shape {
        param($Value, [string[]]$Names, [string]$Label)
        if ($null -eq $Value -or $Value -isnot [System.Management.Automation.PSCustomObject]) { throw ('INVALID_FACTS:' + $Label) }
        $actual = [System.Collections.Generic.List[string]]::new()
        foreach ($p in $Value.PSObject.Properties) {
            if ($p.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw ('INVALID_FACTS:' + $Label) }
            $actual.Add($p.Name)
        }
        if ($actual.Count -ne $Names.Count) { throw ('INVALID_FACTS:' + $Label) }
        $expected = [System.Collections.Generic.HashSet[string]]::new($ord)
        foreach ($n in $Names) { [void]$expected.Add($n) }
        foreach ($n in $actual) { if (-not $expected.Contains($n)) { throw ('INVALID_FACTS:' + $Label) } }
    }

    function Get-Field {
        param($Value, [string]$Name)
        $fieldValue = $Value.PSObject.Properties[$Name].Value
        return ,$fieldValue
    }

    function Assert-Array {
        param($Value, [int]$Min, [int]$Max, [string]$Label)
        if ($Value -isnot [array]) { throw ('INVALID_FACTS:' + $Label) }
        if ($Value.Count -lt $Min -or $Value.Count -gt $Max) { throw ('INVALID_FACTS:' + $Label) }
    }

    function Assert-Text {
        param($Value, [string]$Label)
        if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw ('INVALID_FACTS:' + $Label) }
    }

    function Get-PathKey {
        param($Path, [string]$Label)
        if ($Path -isnot [string]) { throw ('INVALID_PATH:' + $Label) }
        if ($Path -cnotmatch '^[A-Za-z]:\\(?:[^\\/:*?\x22<>|\x00-\x1F]+\\)*[^\\/:*?\x22<>|\x00-\x1F]*$') { throw ('INVALID_PATH:' + $Label) }
        if ($Path.Length -gt 3 -and $Path.EndsWith('\', [System.StringComparison]::Ordinal)) { throw ('INVALID_PATH:' + $Label) }
        foreach ($segment in $Path.Substring(3).Split('\')) {
            if ($segment.Length -gt 0 -and $segment -cmatch '[. ]$') { throw ('INVALID_PATH:' + $Label) }
        }
        return $Path.TrimEnd('\').ToUpperInvariant()
    }

    function Read-PathList {
        param($List, [string]$Label)
        $keys = [System.Collections.Generic.List[string]]::new()
        $seen = [System.Collections.Generic.HashSet[string]]::new($ord)
        foreach ($item in $List) {
            $key = Get-PathKey -Path $item -Label $Label
            if (-not $seen.Add($key)) { throw ('INVALID_PATH:DUPLICATE:' + $Label) }
            $keys.Add($key)
        }
        return [pscustomobject]@{ paths = [string[]]@($List); keys = [string[]]$keys.ToArray() }
    }

    function Test-KeyOverlap {
        param([string]$A, [string]$B)
        if ([string]::Equals($A, $B, [System.StringComparison]::Ordinal)) { return $true }
        if ($A.StartsWith($B + '\', [System.StringComparison]::Ordinal)) { return $true }
        if ($B.StartsWith($A + '\', [System.StringComparison]::Ordinal)) { return $true }
        return $false
    }

    function Test-AnyOverlap {
        param([string[]]$KeysA, [string[]]$KeysB)
        foreach ($a in $KeysA) {
            foreach ($b in $KeysB) {
                if (Test-KeyOverlap -A $a -B $b) { return $true }
            }
        }
        return $false
    }

    # Phase 1: metadata prepass over every facts object before any scalar value is read.
    Assert-Shape -Value $ControllerFacts -Label 'facts' -Names @('schema', 'snapshotVersion', 'pauseVersion', 'paused', 'ownershipVersion', 'eligibilityVersion', 'maxCandidates', 'tasks', 'activeOwners')
    $taskRecords = Get-Field $ControllerFacts 'tasks'
    $ownerRecords = Get-Field $ControllerFacts 'activeOwners'
    Assert-Array -Value $taskRecords -Min 0 -Max 1000 -Label 'tasks'
    Assert-Array -Value $ownerRecords -Min 0 -Max 1000 -Label 'activeOwners'
    foreach ($record in $taskRecords) {
        Assert-Shape -Value $record -Label 'task' -Names @('taskId', 'ownedCanonicalPaths', 'eligibility')
        $list = Get-Field $record 'ownedCanonicalPaths'
        Assert-Array -Value $list -Min 1 -Max 64 -Label 'task.ownedCanonicalPaths'
        foreach ($item in $list) { if ($item -isnot [string]) { throw 'INVALID_FACTS:task.ownedCanonicalPaths' } }
    }
    foreach ($record in $ownerRecords) {
        Assert-Shape -Value $record -Label 'owner' -Names @('ownerId', 'ownedCanonicalPaths')
        $list = Get-Field $record 'ownedCanonicalPaths'
        Assert-Array -Value $list -Min 1 -Max 64 -Label 'owner.ownedCanonicalPaths'
        foreach ($item in $list) { if ($item -isnot [string]) { throw 'INVALID_FACTS:owner.ownedCanonicalPaths' } }
    }

    # Phase 2: reuse the pinned dependency projection; it validates the snapshot and fails closed.
    $projection = Resolve-BacklogDependencyProjection -Snapshot $BacklogSnapshot

    # Phase 3: scalar values.
    $schemaValue = Get-Field $ControllerFacts 'schema'
    if ($schemaValue -isnot [string] -or -not [string]::Equals($schemaValue, 'RefillPlannerFacts/v1', [System.StringComparison]::Ordinal)) { throw 'INVALID_FACTS:schema' }
    $snapshotVersion = Get-Field $ControllerFacts 'snapshotVersion'
    $pauseVersion = Get-Field $ControllerFacts 'pauseVersion'
    $ownershipVersion = Get-Field $ControllerFacts 'ownershipVersion'
    $eligibilityVersion = Get-Field $ControllerFacts 'eligibilityVersion'
    Assert-Text -Value $snapshotVersion -Label 'snapshotVersion'
    Assert-Text -Value $pauseVersion -Label 'pauseVersion'
    Assert-Text -Value $ownershipVersion -Label 'ownershipVersion'
    Assert-Text -Value $eligibilityVersion -Label 'eligibilityVersion'
    $paused = Get-Field $ControllerFacts 'paused'
    if ($paused -isnot [bool]) { throw 'INVALID_FACTS:paused' }
    $maxCandidates = Get-Field $ControllerFacts 'maxCandidates'
    if (($maxCandidates -isnot [int] -and $maxCandidates -isnot [long]) -or $maxCandidates -lt 1 -or $maxCandidates -gt 32) { throw 'INVALID_FACTS:maxCandidates' }
    if (-not [string]::Equals($snapshotVersion, [string]$projection.planVersion, [System.StringComparison]::Ordinal)) { throw 'STALE_SNAPSHOT_VERSION' }

    $snapshotIds = [System.Collections.Generic.List[string]]::new()
    $snapshotIdSet = [System.Collections.Generic.HashSet[string]]::new($ord)
    foreach ($t in $BacklogSnapshot.tasks) {
        $snapshotIds.Add([string]$t.id)
        [void]$snapshotIdSet.Add([string]$t.id)
    }
    $candidateSet = [System.Collections.Generic.HashSet[string]]::new($ord)
    foreach ($c in $projection.candidates) { [void]$candidateSet.Add([string]$c) }
    $blockedMap = [System.Collections.Generic.Dictionary[string, string[]]]::new($ord)
    foreach ($b in $projection.blocked) { $blockedMap[[string]$b.id] = [string[]]$b.reasons }

    $factById = [System.Collections.Generic.Dictionary[string, object]]::new($ord)
    foreach ($record in $taskRecords) {
        $taskId = Get-Field $record 'taskId'
        Assert-Text -Value $taskId -Label 'task.taskId'
        if ($factById.ContainsKey($taskId)) { throw 'DUPLICATE_TASK_ID' }
        if (-not $snapshotIdSet.Contains($taskId)) { throw 'UNKNOWN_TASK_ID' }
        $eligibility = Get-Field $record 'eligibility'
        if ($eligibility -isnot [string] -or ($eligibility -cne 'VERIFIED_ELIGIBLE' -and $eligibility -cne 'INELIGIBLE' -and $eligibility -cne 'UNKNOWN')) { throw 'INVALID_FACTS:eligibility' }
        $pathInfo = Read-PathList -List (Get-Field $record 'ownedCanonicalPaths') -Label 'task'
        $factById[$taskId] = [pscustomobject]@{ eligibility = $eligibility; paths = $pathInfo.paths; keys = $pathInfo.keys }
    }

    $owners = [System.Collections.Generic.List[object]]::new()
    $ownerIdSet = [System.Collections.Generic.HashSet[string]]::new($ord)
    foreach ($record in $ownerRecords) {
        $ownerId = Get-Field $record 'ownerId'
        Assert-Text -Value $ownerId -Label 'owner.ownerId'
        if (-not $ownerIdSet.Add($ownerId)) { throw 'DUPLICATE_OWNER_ID' }
        $pathInfo = Read-PathList -List (Get-Field $record 'ownedCanonicalPaths') -Label 'owner'
        $owners.Add([pscustomobject]@{ ownerId = $ownerId; keys = $pathInfo.keys })
    }

    $proposed = [System.Collections.Generic.List[object]]::new()
    $selected = [System.Collections.Generic.List[object]]::new()
    $blocked = [System.Collections.Generic.List[object]]::new()

    foreach ($id in $snapshotIds) {
        if ($blockedMap.ContainsKey($id)) {
            $blocked.Add([pscustomobject]@{ taskId = $id; reasons = [string[]]$blockedMap[$id] })
            continue
        }
        if (-not $candidateSet.Contains($id)) { continue }

        $reasons = [System.Collections.Generic.List[string]]::new()
        if ($paused) { $reasons.Add('PAUSED') }
        $fact = $null
        if (-not $factById.ContainsKey($id)) {
            $reasons.Add('ELIGIBILITY_UNKNOWN')
        }
        else {
            $fact = $factById[$id]
            if ($fact.eligibility -ceq 'UNKNOWN') { $reasons.Add('ELIGIBILITY_UNKNOWN') }
            elseif ($fact.eligibility -ceq 'INELIGIBLE') { $reasons.Add('ELIGIBILITY_INELIGIBLE') }
            foreach ($owner in $owners) {
                if (Test-AnyOverlap -KeysA $fact.keys -KeysB $owner.keys) { $reasons.Add('OWNERSHIP_COLLISION:' + $owner.ownerId) }
            }
        }
        if ($reasons.Count -eq 0) {
            foreach ($s in $selected) {
                if (Test-AnyOverlap -KeysA $fact.keys -KeysB $s.keys) { $reasons.Add('CANDIDATE_COLLISION:' + $s.taskId) }
            }
            if ($reasons.Count -eq 0 -and $selected.Count -ge $maxCandidates) { $reasons.Add('MAX_CANDIDATES_REACHED') }
        }

        if ($reasons.Count -eq 0) {
            $selected.Add([pscustomobject]@{ taskId = $id; keys = $fact.keys })
            $proposed.Add([pscustomobject]@{ taskId = $id; ownedCanonicalPaths = [string[]]$fact.paths })
        }
        else {
            $blocked.Add([pscustomobject]@{ taskId = $id; reasons = [string[]]$reasons.ToArray() })
        }
    }

    $trigger = 'CONTROLLER_FACTS_OR_PLAN_CHANGED'
    if ($paused) { $trigger = 'HUMAN_RESUME_REQUIRED' }

    [pscustomobject]@{
        schema             = 'RefillPlannerProposal/v1'
        basis              = [pscustomobject]@{
            planVersion        = [string]$projection.planVersion
            planSha256         = [string]$projection.planSha256
            snapshotVersion    = $snapshotVersion
            pauseVersion       = $pauseVersion
            ownershipVersion   = $ownershipVersion
            eligibilityVersion = $eligibilityVersion
        }
        proposedCandidates = [object[]]$proposed.ToArray()
        blocked            = [object[]]$blocked.ToArray()
        nextTrigger        = $trigger
        grantsAuthority    = $false
    }
}
