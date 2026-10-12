#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'packet-preflight.ps1')

$script:checks = 0
$script:skipped = 0

function Assert-That {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw ('FAILED: ' + $Name) }
    $script:checks++
}

function Get-TestSha {
    param([string]$Text)
    return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
}

function Write-TestFile {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function New-TestReq {
    param([string]$Id, [string]$Path, [string]$Sha, [string]$Excerpt, $ExcerptSha = $null)
    if ($null -eq $ExcerptSha) { $ExcerptSha = Get-TestSha $Excerpt }
    return [ordered]@{ id = $Id; sourcePath = $Path; sourceSha256 = $Sha; excerpt = $Excerpt; excerptSha256 = $ExcerptSha }
}

function Invoke-TestCase {
    param($Reqs, [string]$PayloadSha, [string]$PayloadFile)
    $ticket = [ordered]@{ schema = 'PacketPreflightTicket/v1'; payloadSha256 = $PayloadSha; requirements = @($Reqs) }
    $tp = Join-Path $script:tmp ('t-' + [guid]::NewGuid().ToString('N') + '.json')
    Write-TestFile -Path $tp -Text ($ticket | ConvertTo-Json -Depth 6 -Compress)
    $out = @(Invoke-PacketPreflight -TicketPath $tp -PayloadPath $PayloadFile -EvidenceRoot $script:root)
    Assert-That ($out.Count -eq 1) 'exactly one object returned'
    return $out[0]
}

function Assert-Refused {
    param($Result, [string]$Name)
    Assert-That ($Result.status -eq 'REFUSED') ($Name + ': refused')
    Assert-That ([regex]::IsMatch($Result.reason, '^[a-z_]+$')) ($Name + ': bounded reason')
}

$script:tmp = $null
try {
    $script:tmp = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ('pf-test-' + [guid]::NewGuid().ToString('N'))))
    $script:root = Join-Path $script:tmp 'root'
    $outside = Join-Path $script:tmp 'outside'
    [void][System.IO.Directory]::CreateDirectory((Join-Path $script:root 'decl'))
    [void][System.IO.Directory]::CreateDirectory($outside)

    $nl = [string][char]10
    $ex1 = 'rule alpha: exact declaration excerpt one'
    $ex2 = 'rule beta: exact declaration excerpt two'
    $sourceText = 'SOURCE' + $nl + $ex1 + $nl + $ex2 + $nl
    $payloadText = 'PACKET' + $nl + $ex1 + $nl + $ex2 + $nl + 'END' + $nl
    $payloadShortText = 'PACKET' + $nl + $ex1 + $nl + 'END' + $nl

    $srcFile = Join-Path (Join-Path $script:root 'decl') 'source02.txt'
    $payloadFile = Join-Path $script:tmp 'payload.txt'
    $payloadShortFile = Join-Path $script:tmp 'payload-short.txt'
    $secretFile = Join-Path $outside 'secret.txt'
    Write-TestFile $srcFile $sourceText
    Write-TestFile $payloadFile $payloadText
    Write-TestFile $payloadShortFile $payloadShortText
    Write-TestFile $secretFile $sourceText

    $srcSha = Get-TestSha $sourceText
    $payloadSha = Get-TestSha $payloadText
    $rel = 'decl/source02.txt'
    $good = @((New-TestReq 'R1' $rel $srcSha $ex1), (New-TestReq 'R2' $srcFile $srcSha $ex2))

    # valid declaration packet passes with a bounded structured result
    $r = Invoke-TestCase $good $payloadSha $payloadFile
    Assert-That ($r.status -eq 'PASS') 'valid packet passes'
    Assert-That ($r.requirementCount -eq 2) 'valid packet requirement count'
    Assert-That ($r.payloadSha256 -eq $payloadSha) 'valid packet payload hash'
    Assert-That ($r.schema -eq 'PacketPreflightResult/v1') 'result schema'
    Assert-That (@($r.PSObject.Properties).Count -eq 5) 'result is bounded to five fields'

    # schema must be present, a scalar string, and exactly the declared version
    $schemaTicket = [ordered]@{ payloadSha256 = $payloadSha; requirements = @($good) }
    $tp = Join-Path $script:tmp 'schema-missing.json'
    Write-TestFile -Path $tp -Text ($schemaTicket | ConvertTo-Json -Depth 6 -Compress)
    $r = Invoke-PacketPreflight -TicketPath $tp -PayloadPath $payloadFile -EvidenceRoot $script:root
    Assert-Refused $r 'missing schema'
    $schemaTicket = [ordered]@{ schema = @('PacketPreflightTicket/v1'); payloadSha256 = $payloadSha; requirements = @($good) }
    $tp = Join-Path $script:tmp 'schema-array.json'
    Write-TestFile -Path $tp -Text ($schemaTicket | ConvertTo-Json -Depth 6 -Compress)
    $r = Invoke-PacketPreflight -TicketPath $tp -PayloadPath $payloadFile -EvidenceRoot $script:root
    Assert-Refused $r 'array schema'

    # missing requirement partitions
    $r = Invoke-TestCase @() $payloadSha $payloadFile
    Assert-Refused $r 'empty requirements'
    $noExcerpt = [ordered]@{ id = 'R1'; sourcePath = $rel; sourceSha256 = $srcSha; excerptSha256 = (Get-TestSha $ex1) }
    $r = Invoke-TestCase @($noExcerpt) $payloadSha $payloadFile
    Assert-Refused $r 'requirement without excerpt'

    # duplicate ids
    $r = Invoke-TestCase @((New-TestReq 'R1' $rel $srcSha $ex1), (New-TestReq 'R1' $rel $srcSha $ex2)) $payloadSha $payloadFile
    Assert-Refused $r 'duplicate ids'

    # stale source hash
    $r = Invoke-TestCase @((New-TestReq 'R1' $rel (Get-TestSha 'older source') $ex1)) $payloadSha $payloadFile
    Assert-Refused $r 'stale source hash'

    # excerpt absent from payload while the payload hash is valid
    $r = Invoke-TestCase $good (Get-TestSha $payloadShortText) $payloadShortFile
    Assert-Refused $r 'excerpt absent from payload'

    # tampered payload hash
    $r = Invoke-TestCase $good (Get-TestSha 'tampered') $payloadFile
    Assert-Refused $r 'tampered payload hash'

    # wrong excerpt hash
    $r = Invoke-TestCase @((New-TestReq 'R1' $rel $srcSha $ex1 (Get-TestSha 'other excerpt'))) $payloadSha $payloadFile
    Assert-Refused $r 'wrong excerpt hash'

    # path escape: dot-dot and absolute outside the root
    $r = Invoke-TestCase @((New-TestReq 'R1' '../outside/secret.txt' $srcSha $ex1)) $payloadSha $payloadFile
    Assert-Refused $r 'dot-dot escape'
    $r = Invoke-TestCase @((New-TestReq 'R1' $secretFile $srcSha $ex1)) $payloadSha $payloadFile
    Assert-Refused $r 'absolute outside root'

    # symlink traversal, when the platform allows creating one
    $link = Join-Path $script:root 'link.txt'
    $made = $false
    try {
        [void](New-Item -ItemType SymbolicLink -Path $link -Target $secretFile -ErrorAction Stop)
        $made = $true
    }
    catch { $made = $false }
    if ($made) {
        $r = Invoke-TestCase @((New-TestReq 'R1' 'link.txt' $srcSha $ex1)) $payloadSha $payloadFile
        Assert-Refused $r 'symlink source'
    }
    else { $script:skipped++ }

    # missing ticket file
    $r = Invoke-PacketPreflight -TicketPath (Join-Path $script:tmp 'absent.json') -PayloadPath $payloadFile -EvidenceRoot $script:root
    Assert-Refused $r 'missing ticket'

    Write-Host ('packet-preflight tests: ' + $script:checks + ' checks passed, ' + $script:skipped + ' skipped')
}
finally {
    if ($null -ne $script:tmp -and [System.IO.Directory]::Exists($script:tmp) -and ([System.IO.Path]::GetFileName($script:tmp)).StartsWith('pf-test-')) {
        Remove-Item -LiteralPath $script:tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
