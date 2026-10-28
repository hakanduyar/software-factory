#Requires -Version 7.6
Set-StrictMode -Version Latest

function Invoke-RuntimeProjection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$CheckpointPath,
        [Parameter(Mandatory)][string]$VaultPath,
        [Parameter(Mandatory)][string]$EvidenceRoot
    )

    $NL = "`n"
    $StartMarker = '<!-- factory-runtime:start -->'
    $EndMarker   = '<!-- factory-runtime:end -->'
    $NoteFileName = 'Current Runtime.md'
    $PrevFileName = 'Current Runtime.previous.md'
    $LockFileName = '.runtime.lock'
    $ErrorFileName = 'sync-error.json'

    $IdPattern   = '^[A-Za-z0-9_\-]{1,128}$'
    $OwnerPattern = '^[A-Za-z0-9_\-./]{1,256}$'
    $FingerprintPattern = '^[0-9a-f]{64}$'
    $MaxSafeInt = 9007199254740991

    function Test-SafeNonNegativeInteger {
        param($Value)
        if ($null -eq $Value) { return $false }
        if ($Value -is [string] -or $Value -is [bool] -or $Value -is [array] -or $Value -is [System.Collections.IDictionary] -or $Value -is [System.Management.Automation.PSCustomObject]) { return $false }
        $d = 0.0
        try { $d = [double]$Value } catch { return $false }
        if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $false }
        if ($d -lt 0) { return $false }
        if ($d -ne [math]::Floor($d)) { return $false }
        if ($d -gt $MaxSafeInt) { return $false }
        return $true
    }

    function Test-BoundedId {
        param([string]$Value, [string]$Pattern)
        if ($null -eq $Value) { return $false }
        if ($Value -isnot [string]) { return $false }
        if ($Value.Length -lt 1 -or $Value.Length -gt 256) { return $false }
        return [regex]::IsMatch($Value, $Pattern)
    }

    function Test-RelativeRefPath {
        param([string]$Value)
        if ($null -eq $Value) { return $false }
        if ($Value -isnot [string]) { return $false }
        if ($Value.Length -lt 1 -or $Value.Length -gt 1024) { return $false }
        if (-not [regex]::IsMatch($Value, '^[A-Za-z0-9_./ -]+$')) { return $false }
        if ($Value -match '\.\.') { return $false }
        if ([System.IO.Path]::IsPathRooted($Value)) { return $false }
        if ($Value -match '^[A-Za-z]:') { return $false }
        if ($Value.StartsWith('/') -or $Value.StartsWith('\\')) { return $false }
        return $true
    }

    function Resolve-UnderRoot {
        param([string]$Root, [string]$RelPath)
        $rootFull = [System.IO.Path]::GetFullPath($Root)
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $rootFull $RelPath))
        $rootFullNorm = $rootFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        if (-not ($candidate.StartsWith($rootFullNorm + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or $candidate.Equals($rootFullNorm, [System.StringComparison]::OrdinalIgnoreCase))) {
            return $null
        }
        return $candidate
    }

    function Test-NotReparsePoint {
        param([string]$Path)
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        try {
            $attr = [System.IO.File]::GetAttributes($Path)
            if ($attr -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
        } catch { return $false }
        return $true
    }

    function Write-GenericSyncError {
        param([string]$VaultDir, [string]$Code)
        try {
            $errPath = Join-Path $VaultDir $ErrorFileName
            if (-not (Test-NotReparsePoint $errPath)) { return }
            $tmp = Join-Path $VaultDir ("$ErrorFileName." + [guid]::NewGuid().ToString('N') + '.tmp')
            $obj = [ordered]@{ errorCode = $Code; timestampUtc = (Get-Date).ToUniversalTime().ToString('o') }
            $json = $obj | ConvertTo-Json -Compress
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
            Move-Item -LiteralPath $tmp -Destination $errPath -Force
        } catch { }
    }

    function Clear-SyncError {
        param([string]$VaultDir)
        try {
            $errPath = Join-Path $VaultDir $ErrorFileName
            if (Test-Path -LiteralPath $errPath) {
                if (Test-NotReparsePoint $errPath) {
                    Remove-Item -LiteralPath $errPath -Force
                }
            }
        } catch { }
    }

    function Get-ManagedRegion {
        param([string]$Content)
        $startIdx = @()
        $endIdx = @()
        $pos = 0
        while (($i = $Content.IndexOf($StartMarker, $pos, [System.StringComparison]::Ordinal)) -ge 0) { $startIdx += $i; $pos = $i + 1 }
        $pos = 0
        while (($i = $Content.IndexOf($EndMarker, $pos, [System.StringComparison]::Ordinal)) -ge 0) { $endIdx += $i; $pos = $i + 1 }
        if ($startIdx.Count -eq 0 -and $endIdx.Count -eq 0) {
            return [ordered]@{ Found = $false; Malformed = $false }
        }
        if ($startIdx.Count -ne 1 -or $endIdx.Count -ne 1) {
            return [ordered]@{ Found = $false; Malformed = $true }
        }
        if ($endIdx[0] -lt $startIdx[0]) {
            return [ordered]@{ Found = $false; Malformed = $true }
        }
        $prefix = $Content.Substring(0, $startIdx[0])
        $suffixStart = $endIdx[0] + $EndMarker.Length
        $suffix = $Content.Substring($suffixStart)
        $inner = $Content.Substring($startIdx[0] + $StartMarker.Length, $endIdx[0] - ($startIdx[0] + $StartMarker.Length))
        return [ordered]@{ Found = $true; Malformed = $false; Prefix = $prefix; Suffix = $suffix; Inner = $inner }
    }

    function Get-ExistingMaterialFingerprint {
        param([string]$Inner)
        $m = [regex]::Match($Inner, 'materialFingerprint:\s*([0-9a-f]{64})')
        if ($m.Success) { return $m.Groups[1].Value }
        return $null
    }

    $resultStatus = 'ERROR'
    $materialFingerprintOut = $null

    try {
        $vaultFull = [System.IO.Path]::GetFullPath($VaultPath)
        $evidenceRootFull = [System.IO.Path]::GetFullPath($EvidenceRoot)

        if (-not (Test-Path -LiteralPath $vaultFull -PathType Container)) {
            return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
        }
        if (-not (Test-Path -LiteralPath $CheckpointPath -PathType Leaf)) {
            Write-GenericSyncError -VaultDir $vaultFull -Code 'CHECKPOINT_UNAVAILABLE'
            return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
        }

        $lockPath = Join-Path $vaultFull $LockFileName
        if (-not (Test-NotReparsePoint $lockPath)) {
            return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
        }

        $lockStream = $null
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        while ($true) {
            try {
                $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
                break
            } catch {
                if ([DateTime]::UtcNow -ge $deadline) {
                    return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
                }
                Start-Sleep -Milliseconds 50
            }
        }

        try {
            $notePath = Join-Path $vaultFull $NoteFileName
            $prevPath = Join-Path $vaultFull $PrevFileName
            if (-not (Test-NotReparsePoint $notePath) -or -not (Test-NotReparsePoint $prevPath)) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'UNSAFE_NOTE_PATH'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }

            $checkpointBytes = [System.IO.File]::ReadAllBytes($CheckpointPath)
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                $checkpointHashBytes = $sha.ComputeHash($checkpointBytes)
            } finally { $sha.Dispose() }
            $checkpointSha256 = -join ($checkpointHashBytes | ForEach-Object { $_.ToString('x2') })

            $checkpointText = [System.Text.Encoding]::UTF8.GetString($checkpointBytes)
            $root = $null
            try {
                $root = $checkpointText | ConvertFrom-Json -Depth 32
            } catch {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'CHECKPOINT_PARSE_FAILED'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }

            if ($null -eq $root -or $root -isnot [System.Management.Automation.PSCustomObject]) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'CHECKPOINT_SHAPE_INVALID'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }

            $caw = $root.currentActiveWork
            $oc = $root.operationalContinuation
            if ($null -eq $caw -or $null -eq $oc) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'REQUIRED_SECTION_MISSING'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }
            foreach ($optName in @('owner','claim','handoff')) {
                if (-not (Get-Member -InputObject $caw -Name $optName -MemberType NoteProperty)) {
                    $caw | Add-Member -MemberType NoteProperty -Name $optName -Value $null
                }
            }
            foreach ($optName in @('acceptance','defaultTerminalBinding','activePointer')) {
                if (-not (Get-Member -InputObject $oc -Name $optName -MemberType NoteProperty)) {
                    $oc | Add-Member -MemberType NoteProperty -Name $optName -Value $null
                }
            }

            if ($caw.id -isnot [string] -or $caw.status -isnot [string] -or $oc.status -isnot [string] -or $oc.fingerprint -isnot [string]) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'TYPE_MISMATCH'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }
            if ($null -ne $caw.owner -and $caw.owner -isnot [string]) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'TYPE_MISMATCH'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }
            foreach ($rn in @('claim','handoff')) {
                if ($null -ne $caw.$rn -and $caw.$rn -isnot [string]) {
                    Write-GenericSyncError -VaultDir $vaultFull -Code 'TYPE_MISMATCH'
                    return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
                }
            }
            foreach ($rn in @('acceptance','defaultTerminalBinding','activePointer')) {
                if ($null -ne $oc.$rn -and $oc.$rn -isnot [string]) {
                    Write-GenericSyncError -VaultDir $vaultFull -Code 'TYPE_MISMATCH'
                    return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
                }
            }
            foreach ($nn in @('reportedOutput','reservedUnknownOutput','accountedOutput')) {
                if ($oc.$nn -is [string] -or $oc.$nn -is [bool]) {
                    Write-GenericSyncError -VaultDir $vaultFull -Code 'TYPE_MISMATCH'
                    return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
                }
            }
            if (-not (Test-BoundedId $caw.id $IdPattern)) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'INVALID_WORK_ID'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }
            if (-not (Test-BoundedId $caw.status $IdPattern)) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'INVALID_WORK_STATUS'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }
            if ($caw.providerActive -isnot [bool]) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'INVALID_PROVIDER_ACTIVE'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }

            $ownerVal = $null
            if ($null -ne $caw.owner) {
                if (-not (Test-BoundedId $caw.owner $OwnerPattern)) {
                    Write-GenericSyncError -VaultDir $vaultFull -Code 'INVALID_OWNER'
                    return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
                }
                $ownerVal = $caw.owner
            }

            function Resolve-OptionalRef {
                param($Value, [string]$Code)
                if ($null -eq $Value) { return @{ Ok = $true; Rel = $null; Full = $null } }
                if (-not (Test-RelativeRefPath $Value)) { return @{ Ok = $false; Code = $Code } }
                $full = Resolve-UnderRoot -Root $evidenceRootFull -RelPath $Value
                if ($null -eq $full) { return @{ Ok = $false; Code = $Code } }
                if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return @{ Ok = $false; Code = $Code } }
                return @{ Ok = $true; Rel = $Value; Full = $full }
            }

            $claimR  = Resolve-OptionalRef $caw.claim 'INVALID_CLAIM_REF'
            if (-not $claimR.Ok) { Write-GenericSyncError -VaultDir $vaultFull -Code $claimR.Code; return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null } }
            $handoffR = Resolve-OptionalRef $caw.handoff 'INVALID_HANDOFF_REF'
            if (-not $handoffR.Ok) { Write-GenericSyncError -VaultDir $vaultFull -Code $handoffR.Code; return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null } }

            if (-not (Test-BoundedId $oc.status $IdPattern)) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'INVALID_CONTINUATION_STATUS'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }
            if ($oc.fingerprint -isnot [string] -or -not [regex]::IsMatch($oc.fingerprint, $FingerprintPattern)) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'INVALID_CONTINUATION_FINGERPRINT'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
            }
            foreach ($n in @('reportedOutput','reservedUnknownOutput','accountedOutput')) {
                if (-not (Test-SafeNonNegativeInteger $oc.$n)) {
                    Write-GenericSyncError -VaultDir $vaultFull -Code 'INVALID_NUMERIC_COUNTER'
                    return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null }
                }
            }
            $reportedOutput = [int64]$oc.reportedOutput
            $reservedUnknownOutput = [int64]$oc.reservedUnknownOutput
            $accountedOutput = [int64]$oc.accountedOutput

            $acceptanceR = Resolve-OptionalRef $oc.acceptance 'INVALID_ACCEPTANCE_REF'
            if (-not $acceptanceR.Ok) { Write-GenericSyncError -VaultDir $vaultFull -Code $acceptanceR.Code; return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null } }
            $bindingR = Resolve-OptionalRef $oc.defaultTerminalBinding 'INVALID_BINDING_REF'
            if (-not $bindingR.Ok) { Write-GenericSyncError -VaultDir $vaultFull -Code $bindingR.Code; return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null } }
            $pointerR = Resolve-OptionalRef $oc.activePointer 'INVALID_POINTER_REF'
            if (-not $pointerR.Ok) { Write-GenericSyncError -VaultDir $vaultFull -Code $pointerR.Code; return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $null } }

            $fpParts = @(
                $caw.id, $caw.status, [string]$caw.providerActive, ($ownerVal ?? ''),
                ($claimR.Rel ?? ''), ($handoffR.Rel ?? ''),
                $oc.status, $oc.fingerprint,
                [string]$reportedOutput, [string]$reservedUnknownOutput, [string]$accountedOutput,
                ($acceptanceR.Rel ?? ''), ($bindingR.Rel ?? ''), ($pointerR.Rel ?? '')
            )
            $fpCanonical = [string]::Join("`u{1f}", $fpParts)
            $fpBytes = [System.Text.Encoding]::UTF8.GetBytes($fpCanonical)
            $sha2 = [System.Security.Cryptography.SHA256]::Create()
            try { $fpHashBytes = $sha2.ComputeHash($fpBytes) } finally { $sha2.Dispose() }
            $materialFingerprint = -join ($fpHashBytes | ForEach-Object { $_.ToString('x2') })
            $materialFingerprintOut = $materialFingerprint

            $existingContent = ''
            $hadFile = Test-Path -LiteralPath $notePath -PathType Leaf
            $noteEncoding = New-Object System.Text.UTF8Encoding($false)
            if ($hadFile) {
                $strictUtf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)
                $reader = New-Object System.IO.StreamReader($notePath, $strictUtf8NoBom, $true)
                try {
                    $existingContent = $reader.ReadToEnd()
                    $noteEncoding = $reader.CurrentEncoding
                } finally {
                    $reader.Dispose()
                }
            }
            $region = Get-ManagedRegion -Content $existingContent
            if ($region.Malformed) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'MANAGED_REGION_MALFORMED'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $materialFingerprintOut }
            }

            if ($region.Found) {
                $existingFp = Get-ExistingMaterialFingerprint -Inner $region.Inner
                if ($existingFp -eq $materialFingerprint) {
                    # UNCHANGED additionally requires exactly one matching Source checkpoint line inside the validated managed region.
                    $noopSrcOk = $false
                    try {
                        $noopWant = '- Source checkpoint: `' + $CheckpointPath + '` sha256 `' + $checkpointSha256 + '`'
                        $noopSrc = @(([string]$region.Inner -split "`r?`n") | Where-Object { $_.StartsWith('- Source checkpoint:', [System.StringComparison]::Ordinal) })
                        if ($noopSrc.Count -eq 1 -and $noopSrc[0] -ceq $noopWant) { $noopSrcOk = $true }
                    } catch { $noopSrcOk = $false }
                    if ($noopSrcOk) {
                        Clear-SyncError -VaultDir $vaultFull
                        return [pscustomobject]@{ status = 'UNCHANGED'; materialFingerprint = $materialFingerprint }
                    }
                }
            }

            $linesInner = New-Object System.Collections.Generic.List[string]
            $linesInner.Add('- Selected task: `' + $caw.id + '` status `' + $caw.status + '` providerActive `' + $caw.providerActive + '`' + ($(if ($ownerVal) { ' owner `' + $ownerVal + '`' } else { '' })))
            $linesInner.Add('- Accepted continuation scope: `' + $oc.status + '`')
            $linesInner.Add('- Accounting: reportedOutput=' + $reportedOutput + ', reservedUnknownOutput=' + $reservedUnknownOutput + ' (reserved is not measured usage), accountedOutput=' + $accountedOutput)
            $linesInner.Add('- Source checkpoint: `' + $CheckpointPath + '` sha256 `' + $checkpointSha256 + '`')
            $linesInner.Add('- materialFingerprint: ' + $materialFingerprint)
            $provLines = New-Object System.Collections.Generic.List[string]
            if ($claimR.Rel) { $provLines.Add('  - claim: [' + $claimR.Rel + '](' + ([uri]$claimR.Full).AbsoluteUri + ')') }
            if ($handoffR.Rel) { $provLines.Add('  - handoff: [' + $handoffR.Rel + '](' + ([uri]$handoffR.Full).AbsoluteUri + ')') }
            if ($acceptanceR.Rel) { $provLines.Add('  - acceptance: [' + $acceptanceR.Rel + '](' + ([uri]$acceptanceR.Full).AbsoluteUri + ')') }
            if ($bindingR.Rel) { $provLines.Add('  - defaultTerminalBinding: [' + $bindingR.Rel + '](' + ([uri]$bindingR.Full).AbsoluteUri + ')') }
            if ($pointerR.Rel) { $provLines.Add('  - activePointer: [' + $pointerR.Rel + '](' + ([uri]$pointerR.Full).AbsoluteUri + ')') }
            if ($provLines.Count -gt 0) {
                $linesInner.Add('- Local provenance:')
                foreach ($l in $provLines) { $linesInner.Add($l) }
            }
            $linesInner.Add('- Scope: supervised active controller only; not an app-closed daemon or aggregate Factory/D1 completion claim.')
            $innerText = $NL + ([string]::Join($NL, $linesInner)) + $NL

            if ($region.Found) {
                $newContent = $region.Prefix + $StartMarker + $innerText + $EndMarker + $region.Suffix
            } else {
                $header = '# Current Runtime' + $NL + $NL + 'Runtime structured state below is authoritative; any prior prose snapshots elsewhere are historical only.' + $NL + $NL
                $prefix = if ($hadFile) { $existingContent } else { $header }
                $suffix = ''
                $sep = if ($hadFile -and $prefix.Length -gt 0 -and -not $prefix.EndsWith($NL)) { $NL } else { '' }
                $newContent = $prefix + $sep + $StartMarker + $innerText + $EndMarker + $suffix
            }

            $tmpNote = Join-Path $vaultFull ($NoteFileName + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
            if (-not (Test-NotReparsePoint $tmpNote)) {
                Write-GenericSyncError -VaultDir $vaultFull -Code 'UNSAFE_TEMP_PATH'
                return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $materialFingerprintOut }
            }
            [System.IO.File]::WriteAllText($tmpNote, $newContent, $noteEncoding)
            if ($hadFile) {
                [System.IO.File]::Replace($tmpNote, $notePath, $prevPath)
            } else {
                Move-Item -LiteralPath $tmpNote -Destination $notePath -Force
            }

            Clear-SyncError -VaultDir $vaultFull
            return [pscustomobject]@{ status = 'UPDATED'; materialFingerprint = $materialFingerprint }
        } finally {
            if ($null -ne $lockStream) {
                $lockStream.Dispose()
            }
        }
    } catch {
        try {
            $vaultFullSafe = [System.IO.Path]::GetFullPath($VaultPath)
            Write-GenericSyncError -VaultDir $vaultFullSafe -Code 'UNEXPECTED_FAILURE'
        } catch { }
        return [pscustomobject]@{ status = 'ERROR'; materialFingerprint = $materialFingerprintOut }
    }
}

