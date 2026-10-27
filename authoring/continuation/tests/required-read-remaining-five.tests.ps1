#Requires -Version 7.0
# Regression increment: remaining five original B groups for Test-RequiredReadPacketPreflight
# (zero-byte packet, directory packet, exact 1 MiB multibyte packet, handle release, repeat call)
# plus a separately labelled prerequisite positive control.
# The first three original cases (case-changed carrier, missing third carrier, empty grants)
# live in required-read-first-three.tests.ps1 and are intentionally NOT repeated here.
# Exit codes: 0 = all passed, 1 = assertion failed, 2 = harness error / case error.
param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$acceptedSourceHash = '8b5a1d9889137f10eb088399e3178c0e064d604c83f87e6dd8208410708a4fc9'
$maxPacketBytes = 1048576
$utf8 = [System.Text.UTF8Encoding]::new($false)
$strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)

$cases = [System.Collections.Generic.List[object]]::new()
$harnessError = $null
$resultsPath = $null
$sourceHashBefore = $null
$sourceHashAfter = $null

function Get-Sha256Lower([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-Canonical([string]$Path) {
    return [System.IO.Path]::IsPathFullyQualified($Path) -and
        [string]::Equals([System.IO.Path]::GetFullPath($Path), $Path, [System.StringComparison]::Ordinal)
}

# Calls the actual dot-sourced function and captures typed scalars.
function Invoke-Preflight([string]$Packet) {
    $r = Test-RequiredReadPacketPreflight -PacketPath $Packet -RequiredReads $script:requiredReads -AllowedReadPaths $script:grants
    return [ordered]@{
        valid        = $r.valid
        code         = $r.code
        checkedCount = $r.checkedCount
        typesOk      = (($r.valid -is [bool]) -and ($r.code -is [string]) -and ($r.checkedCount -is [int]))
    }
}

function Test-Matches($Actual, [hashtable]$Expected) {
    return $Actual.typesOk -and ($Actual.valid -eq $Expected.valid) -and
        [string]::Equals($Actual.code, $Expected.code, [System.StringComparison]::Ordinal) -and
        ($Actual.checkedCount -eq $Expected.checkedCount)
}

# Body returns @{ actual = <preflight result>; checks = <ordered name->bool>; evidence = <ordered> }.
# An exception is a harness ERROR, never an asserted refusal.
function Invoke-Group {
    param([string]$Name, [string]$Kind, [hashtable]$Expected, [scriptblock]$Body)
    $record = [ordered]@{
        name           = $Name
        kind           = $Kind
        expected       = $Expected
        actual         = $null
        checks         = $null
        evidence       = $null
        status         = 'ERROR'
        passed         = $false
        assertedRefusal = $false
        harnessError   = $null
    }
    try {
        $out = & $Body
        $record.actual = $out.actual
        $record.checks = $out.checks
        $record.evidence = $out.evidence
        $ok = (Test-Matches $out.actual $Expected)
        foreach ($k in $out.checks.Keys) { if ($out.checks[$k] -ne $true) { $ok = $false } }
        $record.passed = [bool]$ok
        $record.status = if ($ok) { 'PASS' } else { 'FAIL' }
        $record.assertedRefusal = [bool]($ok -and $Expected.valid -eq $false)
    } catch {
        $record.status = 'ERROR'
        $record.passed = $false
        $record.assertedRefusal = $false
        $record.harnessError = $_.Exception.Message
    }
    $cases.Add([pscustomobject]$record)
}

# Exclusive reopen proves the packet handle was released; the stream is always disposed.
function Test-ExclusiveReopen([string]$Path) {
    $fs = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try { return $true } finally { $fs.Dispose() }
}

try {
    if (-not (Test-Canonical $SourcePath)) { throw 'SourcePath must be a fully-qualified canonical path.' }
    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) { throw 'SourcePath is not an existing file.' }
    $sourceHashBefore = Get-Sha256Lower $SourcePath
    if ($sourceHashBefore -ne $acceptedSourceHash) { throw "Source hash mismatch: $sourceHashBefore" }

    if (-not (Test-Canonical $OutputDirectory)) { throw 'OutputDirectory must be a fully-qualified canonical path.' }
    if (Test-Path -LiteralPath $OutputDirectory) { throw 'OutputDirectory must be fresh (already exists).' }
    $null = New-Item -ItemType Directory -Path $OutputDirectory
    $resultsPath = Join-Path $OutputDirectory 'results.json'

    . $SourcePath
    if (-not (Get-Command Test-RequiredReadPacketPreflight -CommandType Function -ErrorAction SilentlyContinue)) {
        throw 'Test-RequiredReadPacketPreflight was not defined by the source.'
    }

    # Fixtures: three real required files, all under OutputDirectory.
    $fixtureDir = Join-Path $OutputDirectory 'fixtures'
    $null = New-Item -ItemType Directory -Path $fixtureDir
    $required = @()
    foreach ($n in 1..3) {
        $p = Join-Path $fixtureDir "required-$n.txt"
        [System.IO.File]::WriteAllText($p, "fixture $n`n", $utf8)
        if (-not (Test-Canonical $p)) { throw "Fixture path is not canonical: $p" }
        $required += $p
    }
    $script:grants = [object[]]@($required)
    $script:requiredReads = [object[]]@($required)
    $carrierText = (($required | ForEach-Object { "Read $_" }) -join "`n") + "`n"
    $carrierBytes = $utf8.GetBytes($carrierText)

    $packetOk = Join-Path $fixtureDir 'packet-control.md'
    [System.IO.File]::WriteAllBytes($packetOk, $carrierBytes)

    # Prerequisite positive control (not one of the five groups).
    Invoke-Group -Name 'prerequisite-positive-control' -Kind 'prerequisite' -Expected @{ valid = $true; code = 'OK'; checkedCount = 3 } -Body {
        @{ actual = (Invoke-Preflight $packetOk); checks = [ordered]@{}; evidence = [ordered]@{ packetBytes = (Get-Item -LiteralPath $packetOk).Length } }
    }

    # Group 1: zero-byte regular packet.
    $packetZero = Join-Path $fixtureDir 'packet-zero.md'
    [System.IO.File]::WriteAllBytes($packetZero, [byte[]]::new(0))
    Invoke-Group -Name 'group1-zero-byte-packet' -Kind 'group' -Expected @{ valid = $false; code = 'MISSING_CARRIER'; checkedCount = 0 } -Body {
        $len = (Get-Item -LiteralPath $packetZero).Length
        @{ actual = (Invoke-Preflight $packetZero); checks = [ordered]@{ packetIsZeroBytes = ($len -eq 0) }; evidence = [ordered]@{ packetBytes = $len } }
    }

    # Group 2: PacketPath is an existing directory.
    $packetDir = Join-Path $fixtureDir 'packet-directory'
    $null = New-Item -ItemType Directory -Path $packetDir
    Invoke-Group -Name 'group2-directory-packet' -Kind 'group' -Expected @{ valid = $false; code = 'PACKET_UNREADABLE'; checkedCount = 0 } -Body {
        @{ actual = (Invoke-Preflight $packetDir)
           checks = [ordered]@{ packetIsDirectory = (Test-Path -LiteralPath $packetDir -PathType Container) }
           evidence = [ordered]@{ packetPath = $packetDir } }
    }

    # Group 3: strict UTF-8 packet of exactly 1048576 bytes with multibyte filler.
    $packetExact = Join-Path $fixtureDir 'packet-exact-1mib.md'
    $euro = $utf8.GetBytes([string][char]0x20AC)   # 3 bytes
    $remaining = $maxPacketBytes - $carrierBytes.Length
    if ($remaining -lt 3) { throw 'Carrier text leaves no room for multibyte filler.' }
    $euroCount = [int][math]::Floor($remaining / 3)
    $asciiPad = $remaining - ($euroCount * 3)       # 0..2 ASCII bytes
    $exact = [byte[]]::new($maxPacketBytes)
    [System.Buffer]::BlockCopy($carrierBytes, 0, $exact, 0, $carrierBytes.Length)
    $pos = $carrierBytes.Length
    for ($i = 0; $i -lt $euroCount; $i++) { [System.Buffer]::BlockCopy($euro, 0, $exact, $pos, 3); $pos += 3 }
    for ($i = 0; $i -lt $asciiPad; $i++) { $exact[$pos++] = [byte][char]'x' }
    if ($pos -ne $maxPacketBytes) { throw "Exact packet construction miscounted: $pos" }
    [System.IO.File]::WriteAllBytes($packetExact, $exact)
    Invoke-Group -Name 'group3-exact-1mib-multibyte-packet' -Kind 'group' -Expected @{ valid = $true; code = 'OK'; checkedCount = 3 } -Body {
        $bytes = [System.IO.File]::ReadAllBytes($packetExact)
        $decoded = $strictUtf8.GetString($bytes)
        $multibyte = @($bytes | Where-Object { $_ -ge 0x80 }).Count
        @{ actual = (Invoke-Preflight $packetExact)
           checks = [ordered]@{
               bytesLengthExactly1048576 = ($bytes.Length -eq 1048576)
               containsMultibyteBytes    = ($multibyte -ge 3 -and $multibyte -eq 3 * $euroCount)
               strictUtf8Decodes         = ($decoded.Length -lt $bytes.Length)
               allCarriersPresent        = (@($required | Where-Object { $decoded.Contains($_, [System.StringComparison]::Ordinal) }).Count -eq 3)
           }
           evidence = [ordered]@{ bytesLength = $bytes.Length; multibyteByteCount = $multibyte; euroCount = $euroCount; asciiPad = $asciiPad; charLength = $decoded.Length } }
    }

    # Group 4: handle release after success and after malformed-UTF-8 failure.
    $packetBad = Join-Path $fixtureDir 'packet-malformed-utf8.md'
    $badBytes = [byte[]]($carrierBytes + [byte[]](0xC3, 0x28, 0xFF, 0xFE))
    [System.IO.File]::WriteAllBytes($packetBad, $badBytes)
    $badRejected = $false
    try { $null = $strictUtf8.GetString([System.IO.File]::ReadAllBytes($packetBad)) } catch [System.Text.DecoderFallbackException] { $badRejected = $true }
    Invoke-Group -Name 'group4a-handle-release-after-success' -Kind 'group' -Expected @{ valid = $true; code = 'OK'; checkedCount = 3 } -Body {
        $packetCopy = Join-Path $fixtureDir 'packet-release-success.md'
        [System.IO.File]::WriteAllBytes($packetCopy, $carrierBytes)
        $act = Invoke-Preflight $packetCopy
        @{ actual = $act; checks = [ordered]@{ exclusiveReopenSucceededAndDisposed = (Test-ExclusiveReopen $packetCopy) }; evidence = [ordered]@{ packet = $packetCopy } }
    }
    Invoke-Group -Name 'group4b-handle-release-after-malformed-utf8' -Kind 'group' -Expected @{ valid = $false; code = 'PACKET_UNREADABLE'; checkedCount = 0 } -Body {
        $act = Invoke-Preflight $packetBad
        @{ actual = $act
           checks = [ordered]@{ fixtureIsStrictlyMalformed = $badRejected; exclusiveReopenSucceededAndDisposed = (Test-ExclusiveReopen $packetBad) }
           evidence = [ordered]@{ packet = $packetBad; packetBytes = $badBytes.Length } }
    }

    # Group 5: two actual calls on the same valid packet give identical typed scalars.
    Invoke-Group -Name 'group5-repeat-identical-result' -Kind 'group' -Expected @{ valid = $true; code = 'OK'; checkedCount = 3 } -Body {
        $first = Invoke-Preflight $packetOk
        $second = Invoke-Preflight $packetOk
        $hashNow = Get-Sha256Lower $SourcePath
        @{ actual = $first
           checks = [ordered]@{
               secondCallMatchesExpected = (Test-Matches $second @{ valid = $true; code = 'OK'; checkedCount = 3 })
               identicalValid            = ($first.valid -is [bool] -and $second.valid -is [bool] -and $first.valid -eq $second.valid)
               identicalCode             = ($first.code -is [string] -and $second.code -is [string] -and [string]::Equals($first.code, $second.code, [System.StringComparison]::Ordinal))
               identicalCheckedCount     = ($first.checkedCount -is [int] -and $second.checkedCount -is [int] -and $first.checkedCount -eq $second.checkedCount)
               sourceHashUnchanged       = ($hashNow -eq $acceptedSourceHash)
           }
           evidence = [ordered]@{ second = $second; sourceHashAfterCalls = $hashNow } }
    }
} catch {
    $harnessError = $_.Exception.Message
} finally {
    try { $sourceHashAfter = Get-Sha256Lower $SourcePath } catch { $sourceHashAfter = $null }
}

$sourceUnchanged = ($null -ne $sourceHashBefore) -and ($sourceHashBefore -eq $sourceHashAfter)
if ($null -eq $harnessError -and -not $sourceUnchanged) { $harnessError = 'Source hash changed during run.' }
$caseErrors = @($cases | Where-Object { $_.status -eq 'ERROR' }).Count
$caseFails = @($cases | Where-Object { $_.status -eq 'FAIL' }).Count
$groupCount = @($cases | Where-Object { $_.kind -eq 'group' }).Count

$exitCode = 0
if ($null -ne $harnessError -or $caseErrors -gt 0) { $exitCode = 2 }
elseif ($caseFails -gt 0 -or $cases.Count -ne 7) { $exitCode = 1 }

$summary = [ordered]@{
    task             = 'REQUIRED_READ_REMAINING_FIVE_NO_OUTPUT_STOP_20261027'
    scope            = 'five remaining original B regression groups (7 records: group4 has two sub-cases) plus one prerequisite positive; first-three cases not repeated'
    sourcePath       = $SourcePath
    expectedHash     = $acceptedSourceHash
    sourceHashBefore = $sourceHashBefore
    sourceHashAfter  = $sourceHashAfter
    sourceUnchanged  = $sourceUnchanged
    harnessError     = $harnessError
    recordCount      = $cases.Count
    groupRecordCount = $groupCount
    failedCount      = $caseFails
    errorCount       = $caseErrors
    exitCode         = $exitCode
    cases            = $cases
}
if ($null -ne $resultsPath) {
    try { ($summary | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $resultsPath -Encoding utf8 }
    catch { Write-Error "Failed to write results.json: $($_.Exception.Message)" -ErrorAction Continue; $exitCode = 2 }
}

foreach ($c in $cases) { Write-Output ("{0}: {1}" -f $c.name, $c.status) }
if ($null -ne $harnessError) { Write-Error "HARNESS ERROR: $harnessError" -ErrorAction Continue }
exit $exitCode
