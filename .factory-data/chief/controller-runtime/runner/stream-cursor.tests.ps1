Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'stream-cursor.ps1')

function Assert-True([bool]$Cond, [string]$Msg) { if (-not $Cond) { throw "ASSERT FAILED: $Msg" } }

function Append-Bytes([string]$Path, [byte[]]$Bytes) {
    $fs = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try { $fs.Write($Bytes, 0, $Bytes.Length) } finally { $fs.Dispose() }
}

function New-Scratch {
    $root = Join-Path $PSScriptRoot 'test-artifacts'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $dir = Join-Path $root ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

$utf8 = [System.Text.Encoding]::UTF8
$emoji = [char]::ConvertFromUtf32(0x1F600)
$emojiBytes = $utf8.GetBytes($emoji)

# Group 1: split multibyte inside a JSON value, multiple completed objects, no errors
$dir1 = New-Scratch
$f1 = Join-Path $dir1 'stream.jsonl'
[System.IO.File]::WriteAllBytes($f1, [byte[]]@())
$prefix = $utf8.GetBytes('{"type":"a","v":"')
Append-Bytes $f1 $prefix
Append-Bytes $f1 $emojiBytes[0..1]
$s1 = @{}
$r1a = Read-AppendedJsonLines -Path $f1 -State $s1
Assert-True (@($r1a.events).Count -eq 0) 'g1: split-value prefix must emit zero events'
Assert-True (-not $r1a.hasError) 'g1: split-value prefix must not error'
$tail1 = $utf8.GetBytes($emoji) | Select-Object -Skip 2
$rest = $utf8.GetBytes('"}' + "`n" + '{"type":"b"}' + "`n")
Append-Bytes $f1 ([byte[]]$tail1)
Append-Bytes $f1 $rest
$r1b = Read-AppendedJsonLines -Path $f1 -State $s1
Assert-True (@($r1b.events).Count -eq 2) 'g1: two completed JSON objects must be emitted exactly once'
Assert-True (@($r1b.events)[0].v -eq $emoji) 'g1: reassembled multibyte value must match original emoji'
Assert-True (@($r1b.errors).Count -eq 0) 'g1: no errors expected for well-formed input'

# Group 2: restart with nonempty pendingBytes split inside a quoted JSON value, exact offset, then zero-event repeat
$dir2 = New-Scratch
$f2 = Join-Path $dir2 'stream.jsonl'
[System.IO.File]::WriteAllBytes($f2, [byte[]]@())
$prefix2 = $utf8.GetBytes('{"type":"u","v":"')
Append-Bytes $f2 $prefix2
Append-Bytes $f2 $emojiBytes[0..1]
$s2 = @{}
$r2a = Read-AppendedJsonLines -Path $f2 -State $s2
Assert-True (@($r2a.events).Count -eq 0) 'g2: split multibyte prefix must emit zero events before restart'
Assert-True (@($s2.pendingBytes).Count -gt 0) 'g2: pendingBytes must be nonempty before restart'
$json2 = $s2 | ConvertTo-Json -Depth 10
$s2restored = $json2 | ConvertFrom-Json -AsHashtable -Depth 10
Assert-True ($s2restored.byteOffset -eq $s2.byteOffset) 'g2: restored byteOffset must match original'
Assert-True (@($s2restored.pendingBytes).Count -eq @($s2.pendingBytes).Count) 'g2: restored pendingBytes count must match original'
$tail2 = [byte[]]($emojiBytes[2..3] + $utf8.GetBytes('"}' + "`n"))
Append-Bytes $f2 $tail2
$r2b = Read-AppendedJsonLines -Path $f2 -State $s2restored
Assert-True (@($r2b.events).Count -eq 1) 'g2: restored partial bytes plus remainder must yield exactly one event'
Assert-True (@($r2b.events)[0].v -eq $emoji) 'g2: reassembled multibyte value after restart must match original emoji'
$expectedOffset2 = ([System.IO.File]::ReadAllBytes($f2)).Length
Assert-True ($r2b.offset -eq $expectedOffset2) 'g2: offset after restart poll must equal exact file length'
$r2c = Read-AppendedJsonLines -Path $f2 -State $s2restored
Assert-True (@($r2c.events).Count -eq 0) 'g2: repeated poll after restart must remain zero events'

# Group 3: Final parses valid unterminated object once, repeated final zero events, later append refused
$dir3 = New-Scratch
$f3 = Join-Path $dir3 'stream.jsonl'
[System.IO.File]::WriteAllBytes($f3, [byte[]]@())
Append-Bytes $f3 $utf8.GetBytes('{"ok":true}')
$s3 = @{}
$r3a = Read-AppendedJsonLines -Path $f3 -State $s3 -Final
Assert-True (@($r3a.events).Count -eq 1) 'g3: final unterminated valid object must be parsed exactly once'
Assert-True ($r3a.final -eq $true) 'g3: final flag must be set'
$r3b = Read-AppendedJsonLines -Path $f3 -State $s3 -Final
Assert-True (@($r3b.events).Count -eq 0) 'g3: repeated final poll must emit zero events'
Append-Bytes $f3 $utf8.GetBytes('{"late":1}' + "`n")
$threw3 = $false
try { Read-AppendedJsonLines -Path $f3 -State $s3 } catch { $threw3 = $true }
Assert-True $threw3 'g3: bytes appended after finalization must be refused'

# Group 4: malformed+valid line, invalid UTF8 line, malformed final tail, sticky hasError, bounded reasons
$dir4 = New-Scratch
$f4 = Join-Path $dir4 'stream.jsonl'
[System.IO.File]::WriteAllBytes($f4, [byte[]]@())
Append-Bytes $f4 $utf8.GetBytes('{bad json' + "`r`n" + '{"good":1}' + "`n")
Append-Bytes $f4 ([byte[]](0xC0, 0x80) + $utf8.GetBytes("`n"))
$s4 = @{}
$r4a = Read-AppendedJsonLines -Path $f4 -State $s4
Assert-True (@($r4a.events).Count -eq 1) 'g4: valid line must still be parsed alongside a malformed one'
Assert-True (@($r4a.errors).Count -ge 2) 'g4: malformed JSON and invalid UTF8 lines must both report errors'
foreach ($e in @($r4a.errors)) { Assert-True ($e.Length -lt 200 -and $e -notmatch '\{') 'g4: error reasons must be bounded and must not contain raw payload text' }
Assert-True ($r4a.hasError -eq $true) 'g4: hasError must become true after malformed evidence'
Append-Bytes $f4 $utf8.GetBytes('{truncated tail')
$r4b = Read-AppendedJsonLines -Path $f4 -State $s4 -Final
Assert-True (@($r4b.errors).Count -ge 1) 'g4: malformed final tail must report an error'
Assert-True ($r4b.hasError -eq $true) 'g4: hasError must remain sticky true through finalization'

# Group 5: wrong path, truncated file, malformed persisted state must refuse before any mutation
$dir5 = New-Scratch
$f5 = Join-Path $dir5 'stream.jsonl'
$f5other = Join-Path $dir5 'other.jsonl'
[System.IO.File]::WriteAllBytes($f5, $utf8.GetBytes('{"n":1}' + "`n"))
[System.IO.File]::WriteAllBytes($f5other, [byte[]]@())
$s5 = @{}
Read-AppendedJsonLines -Path $f5 -State $s5 | Out-Null
$threwPath = $false
try { Read-AppendedJsonLines -Path $f5other -State $s5 } catch { $threwPath = $true }
Assert-True $threwPath 'g5: reusing State against a different canonical path must be refused'

$fullBytes = [System.IO.File]::ReadAllBytes($f5)
$s5trunc = @{ canonicalPath = (Resolve-Path $f5).ProviderPath; byteOffset = [int64]$fullBytes.Length; pendingBytes = @(); final = $false; hasError = $false }
[System.IO.File]::WriteAllBytes($f5, [byte[]]@())
$threwTrunc = $false
try { Read-AppendedJsonLines -Path $f5 -State $s5trunc } catch { $threwTrunc = $true }
Assert-True $threwTrunc 'g5: a file shorter than the recorded offset must be refused as truncated evidence'

$resolvedPath5 = (Resolve-Path $f5other).ProviderPath
$badStates = @(
    @{ canonicalPath = $resolvedPath5; byteOffset = 0; pendingBytes = 65; final = $false; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = $true; pendingBytes = @(); final = $false; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = 0.5; pendingBytes = @(); final = $false; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = -1; pendingBytes = @(); final = $false; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = 9007199254740992; pendingBytes = @(); final = $false; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = 'zero'; pendingBytes = @(); final = $false; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = 0; pendingBytes = @(300); final = $false; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = 0; pendingBytes = @(1.5); final = $false; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = 0; pendingBytes = @(); final = 'no'; hasError = $false },
    @{ canonicalPath = $resolvedPath5; byteOffset = 0; pendingBytes = @(); final = $false; hasError = 1 },
    @{ canonicalPath = $resolvedPath5; byteOffset = 0; pendingBytes = @(); final = $false }
)
foreach ($bad in $badStates) {
    $probe = $bad.Clone()
    $threwBad = $false
    try { Read-AppendedJsonLines -Path $f5other -State $probe } catch { $threwBad = $true }
    Assert-True $threwBad "g5: malformed persisted state must be refused: $($bad | ConvertTo-Json -Compress)"
    Assert-True ($probe.byteOffset -eq $bad.byteOffset) 'g5: refused malformed state must not have its byteOffset silently mutated'
}

Write-Output 'GROUP1 PASS'
Write-Output 'GROUP2 PASS'
Write-Output 'GROUP3 PASS'
Write-Output 'GROUP4 PASS'
Write-Output 'GROUP5 PASS'
Write-Output 'ALL TESTS PASSED'
# Regression: a lone NUL byte (0) as unterminated tail must survive via truthiness-free pendingBytes reload
$dirR = New-Scratch
$fR = Join-Path $dirR 'stream.jsonl'
[System.IO.File]::WriteAllBytes($fR, [byte[]]@())
Append-Bytes $fR ([byte[]]@(0))
$sR = @{}
$rRa = Read-AppendedJsonLines -Path $fR -State $sR
Assert-True (@($rRa.events).Count -eq 0) 'regression: lone NUL tail must emit zero events on first poll'
Assert-True (@($sR.pendingBytes).Count -eq 1) 'regression: pendingBytes must retain the single zero byte, not be treated as falsy'
$rRb = Read-AppendedJsonLines -Path $fR -State $sR
Assert-True (@($rRb.events).Count -eq 0) 'regression: no-new-byte poll must still emit zero events'
Assert-True (@($sR.pendingBytes).Count -eq 1) 'regression: pendingBytes must still retain the single zero byte after a no-op poll'
$jsonR = $sR | ConvertTo-Json -Depth 10
$sRrestored = $jsonR | ConvertFrom-Json -AsHashtable -Depth 10
Assert-True (@($sRrestored.pendingBytes).Count -eq 1) 'regression: restored state must still have the single zero byte pending'
$rRc = Read-AppendedJsonLines -Path $fR -State $sRrestored
Assert-True (@($rRc.events).Count -eq 0) 'regression: restored-state poll with no new bytes must emit zero events'
Assert-True (@($sRrestored.pendingBytes).Count -eq 1) 'regression: pendingBytes must remain the single zero byte after restored no-op poll'
$rRd = Read-AppendedJsonLines -Path $fR -State $sRrestored -Final
Assert-True (@($rRd.errors).Count -ge 1) 'regression: finalizing a malformed single-byte tail must surface an error, not silently drop it'
Assert-True ($rRd.hasError -eq $true) 'regression: hasError must become sticky true after the malformed final tail'
$rRe = Read-AppendedJsonLines -Path $fR -State $sRrestored -Final
Assert-True (@($rRe.events).Count -eq 0) 'regression: repeated final poll must emit zero events'
Assert-True ($rRe.hasError -eq $true) 'regression: hasError must remain sticky true on repeated final poll'
