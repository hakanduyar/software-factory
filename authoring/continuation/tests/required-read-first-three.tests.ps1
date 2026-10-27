#Requires -Version 7.0
# Regression increment: first three original B cases for Test-RequiredReadPacketPreflight
# (positive control, case-changed carrier, omitted third carrier, empty grants).
# Exit codes: 0 = all assertions passed, 1 = assertion failed, 2 = harness error.
# NOT covered here (remaining original cases): zero-byte packet, directory refusal,
# multibyte exact1MiB, exclusive reopen after success/badUTF8, identical repeated scalar result.
param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$acceptedSourceHash = '8b5a1d9889137f10eb088399e3178c0e064d604c83f87e6dd8208410708a4fc9'

$cases = [System.Collections.Generic.List[object]]::new()
$harnessError = $null
$resultsPath = $null
$sourceHashBefore = $null
$sourceHashAfter = $null

function Get-Sha256Lower([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-Case {
    param(
        [string]$Name,
        [hashtable]$Arguments,
        [hashtable]$Expected,
        [string]$Source
    )
    $record = [ordered]@{
        name             = $Name
        expected         = $Expected
        actual           = $null
        status           = 'ERROR'
        passed           = $false
        error            = $null
        sourceHashBefore = Get-Sha256Lower $Source
        sourceHashAfter  = $null
    }
    try {
        $r = Test-RequiredReadPacketPreflight @Arguments
        $record.actual = [ordered]@{ valid = $r.valid; code = $r.code; checkedCount = $r.checkedCount }
        $ok = ($r.valid -is [bool]) -and ($r.valid -eq $Expected.valid) -and
              ([string]::Equals([string]$r.code, $Expected.code, [System.StringComparison]::Ordinal)) -and
              ($r.checkedCount -eq $Expected.checkedCount)
        $record.passed = [bool]$ok
        $record.status = if ($ok) { 'PASS' } else { 'FAIL' }
    } catch {
        # An exception is a harness error, never a successful refusal.
        $record.status = 'ERROR'
        $record.passed = $false
        $record.error = $_.Exception.Message
    }
    $record.sourceHashAfter = Get-Sha256Lower $Source
    $cases.Add([pscustomobject]$record)
}

try {
    # Source must be a canonical absolute path with the exact accepted hash.
    if (-not [System.IO.Path]::IsPathFullyQualified($SourcePath) -or
        -not [string]::Equals([System.IO.Path]::GetFullPath($SourcePath), $SourcePath, [System.StringComparison]::Ordinal)) {
        throw "SourcePath must be an absolute canonical path."
    }
    $sourceHashBefore = Get-Sha256Lower $SourcePath
    if ($sourceHashBefore -ne $acceptedSourceHash) {
        throw "Source hash mismatch: $sourceHashBefore"
    }

    # OutputDirectory must be an absolute canonical path that does not yet exist.
    if (-not [System.IO.Path]::IsPathFullyQualified($OutputDirectory) -or
        -not [string]::Equals([System.IO.Path]::GetFullPath($OutputDirectory), $OutputDirectory, [System.StringComparison]::Ordinal)) {
        throw "OutputDirectory must be an absolute canonical path."
    }
    if (Test-Path -LiteralPath $OutputDirectory) {
        throw "OutputDirectory must be fresh (already exists)."
    }
    $null = New-Item -ItemType Directory -Path $OutputDirectory
    $resultsPath = Join-Path $OutputDirectory 'results.json'

    . $SourcePath
    if (-not (Get-Command Test-RequiredReadPacketPreflight -CommandType Function -ErrorAction SilentlyContinue)) {
        throw "Test-RequiredReadPacketPreflight was not defined by the source."
    }

    # Fixtures: three real required files and a packet, all inside OutputDirectory.
    $fixtureDir = Join-Path $OutputDirectory 'fixtures'
    $null = New-Item -ItemType Directory -Path $fixtureDir
    $required = @()
    foreach ($n in 1..3) {
        $p = Join-Path $fixtureDir "required-$n.txt"
        [System.IO.File]::WriteAllText($p, "fixture $n`n", [System.Text.UTF8Encoding]::new($false))
        $required += $p
    }
    foreach ($p in $required) {
        if (-not [string]::Equals([System.IO.Path]::GetFullPath($p), $p, [System.StringComparison]::Ordinal)) {
            throw "Fixture path is not canonical: $p"
        }
    }
    $writePacket = {
        param([string]$Name, [string[]]$Carriers)
        $pp = Join-Path $fixtureDir $Name
        [System.IO.File]::WriteAllText($pp, (($Carriers | ForEach-Object { "Read $_" }) -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
        return $pp
    }
    $grants = [object[]]@($required)
    $requiredReads = [object[]]@($required)

    # Positive control.
    $packetOk = & $writePacket 'packet-control.md' $required
    Invoke-Case -Name 'positive-control' -Source $SourcePath `
        -Arguments @{ PacketPath = $packetOk; RequiredReads = $requiredReads; AllowedReadPaths = $grants } `
        -Expected @{ valid = $true; code = 'OK'; checkedCount = 3 }

    # Case 1: only the case of the first literal carrier changes in the packet text.
    $changed = $required[0].ToUpperInvariant()
    if ([string]::Equals($changed, $required[0], [System.StringComparison]::Ordinal)) {
        throw "Case-changed carrier does not differ ordinally."
    }
    $packetCase = & $writePacket 'packet-case.md' (@($changed) + $required[1..2])
    Invoke-Case -Name 'case1-first-carrier-case-changed' -Source $SourcePath `
        -Arguments @{ PacketPath = $packetCase; RequiredReads = $requiredReads; AllowedReadPaths = $grants } `
        -Expected @{ valid = $false; code = 'MISSING_CARRIER'; checkedCount = 0 }

    # Case 2: third carrier omitted from the packet; files and grants intact.
    $packetOmit = & $writePacket 'packet-omit-third.md' $required[0..1]
    Invoke-Case -Name 'case2-third-carrier-omitted' -Source $SourcePath `
        -Arguments @{ PacketPath = $packetOmit; RequiredReads = $requiredReads; AllowedReadPaths = $grants } `
        -Expected @{ valid = $false; code = 'MISSING_CARRIER'; checkedCount = 2 }

    # Case 3: all carriers/files present, AllowedReadPaths is an actual empty object[].
    $emptyGrants = [object[]]@()
    if ($emptyGrants -isnot [object[]] -or $emptyGrants.Count -ne 0) { throw "Empty grant fixture is not an empty object[]." }
    Invoke-Case -Name 'case3-empty-grants' -Source $SourcePath `
        -Arguments @{ PacketPath = $packetOk; RequiredReads = $requiredReads; AllowedReadPaths = $emptyGrants } `
        -Expected @{ valid = $false; code = 'MISSING_GRANT'; checkedCount = 0 }
} catch {
    $harnessError = $_.Exception.Message
} finally {
    try { $sourceHashAfter = Get-Sha256Lower $SourcePath } catch { $sourceHashAfter = $null }
}

$sourceUnchanged = ($null -ne $sourceHashBefore) -and ($sourceHashBefore -eq $sourceHashAfter)
if ($null -eq $harnessError -and -not $sourceUnchanged) { $harnessError = 'Source hash changed during run.' }
$caseErrors = @($cases | Where-Object { $_.status -eq 'ERROR' }).Count
$caseFails = @($cases | Where-Object { $_.status -eq 'FAIL' }).Count

$exitCode = 0
if ($null -ne $harnessError -or $caseErrors -gt 0) { $exitCode = 2 }
elseif ($caseFails -gt 0 -or $cases.Count -ne 4) { $exitCode = 1 }

$summary = [ordered]@{
    task             = 'REQUIRED_READ_FIRST_THREE_NO_OUTPUT_STOP_20261027'
    scope            = 'positive control + 3 of 8 original B cases; remaining 5 not implemented'
    sourcePath       = $SourcePath
    expectedHash     = $acceptedSourceHash
    sourceHashBefore = $sourceHashBefore
    sourceHashAfter  = $sourceHashAfter
    sourceUnchanged  = $sourceUnchanged
    harnessError     = $harnessError
    caseCount        = $cases.Count
    failedCount      = $caseFails
    errorCount       = $caseErrors
    exitCode         = $exitCode
    cases            = $cases
}
if ($null -ne $resultsPath) {
    try { ($summary | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $resultsPath -Encoding utf8 }
    catch { Write-Error "Failed to write results.json: $($_.Exception.Message)"; $exitCode = 2 }
}

foreach ($c in $cases) { Write-Output ("{0}: {1}" -f $c.name, $c.status) }
if ($null -ne $harnessError) { Write-Error "HARNESS ERROR: $harnessError" -ErrorAction Continue }
exit $exitCode
