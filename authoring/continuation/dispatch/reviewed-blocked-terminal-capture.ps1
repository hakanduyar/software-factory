# Reviewed blocked terminal capture A pending.
# Reads one BLOCKED OperationalRunReceipt/v2 file once and binds its bytes to an independently captured host hash.
# No writes; no fixture/evidence/native-budget/ACK/state semantics here.

function Get-BlockedSettlementTerminalCapture {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$ExpectedBlockedReview,
        [AllowNull()][object]$TerminalReceiptPath,
        [AllowNull()][object]$TerminalSha256
    )
    $failure = 'REVIEWED_BLOCKED_TERMINAL_CAPTURE_INVALID'
    $maxBytes = 4194304
    $stream = $null
    $isolated = $null
    try {
        # Capture phase: metadata first, then scalar clones, all before any IO.
        if ($null -eq $ExpectedBlockedReview) { throw $failure }
        $expProps = @($ExpectedBlockedReview.PSObject.Properties)
        if ($expProps.Count -ne 2) { throw $failure }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($pr in $expProps) {
            if ($pr.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $failure }
            if (-not $seen.Add([string]$pr.Name)) { throw $failure }
        }
        if (-not $seen.Contains('reviewSha256') -or -not $seen.Contains('evidenceSha256')) { throw $failure }

        $clones = @{}
        foreach ($n in @('reviewSha256', 'evidenceSha256')) {
            $v = $ExpectedBlockedReview.PSObject.Properties[$n].Value
            if ($v -isnot [string] -or $v.Length -ne 64 -or -not ($v -cmatch '^[0-9a-f]{64}\z')) { throw $failure }
            $clones[$n] = New-Object string (, $v.ToCharArray())
        }
        $expReview = [string]$clones['reviewSha256']
        $expEvidence = [string]$clones['evidenceSha256']

        if ($TerminalReceiptPath -isnot [string] -or [string]::IsNullOrWhiteSpace($TerminalReceiptPath)) { throw $failure }
        if ($TerminalSha256 -isnot [string] -or $TerminalSha256.Length -ne 64 -or -not ($TerminalSha256 -cmatch '^[0-9a-f]{64}\z')) { throw $failure }
        $path = New-Object string (, ([string]$TerminalReceiptPath).ToCharArray())
        $wantSha = New-Object string (, ([string]$TerminalSha256).ToCharArray())
        if (-not [System.IO.Path]::IsPathFullyQualified($path)) { throw $failure }

        # Read phase: regular leaf only, bounded cap+1 read, one buffer for hash and parse.
        $info = New-Object System.IO.FileInfo $path
        if (-not $info.Exists) { throw $failure }
        if (($info.Attributes -band ([System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint)) -ne 0) { throw $failure }
        $stream = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $buffer = New-Object byte[] ($maxBytes + 1)
        $total = 0
        while ($total -lt $buffer.Length) {
            $got = $stream.Read($buffer, $total, $buffer.Length - $total)
            if ($got -le 0) { break }
            $total += $got
        }
        if ($total -le 0 -or $total -gt $maxBytes) { throw $failure }
        $bytes = New-Object byte[] $total
        [System.Array]::Copy($buffer, $bytes, $total)
        $stream.Dispose()
        $stream = $null

        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $hex = ([System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')).ToLowerInvariant() } finally { $sha.Dispose() }
        if (-not [string]::Equals($hex, $wantSha, [System.StringComparison]::Ordinal)) { throw $failure }

        $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes)
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        $terminal = ConvertFrom-Json -InputObject $text -DateKind String -NoEnumerate
        if ($null -eq $terminal -or $terminal -isnot [System.Management.Automation.PSCustomObject]) { throw $failure }

        # Receipt phase: accepted reader plus independent disposition-hash comparison.
        $sv = $terminal.PSObject.Properties['schemaVersion']
        $st = $terminal.PSObject.Properties['status']
        $rd = $terminal.PSObject.Properties['reviewedDisposition']
        if ($null -eq $sv -or $null -eq $st -or $null -eq $rd) { throw $failure }
        foreach ($m in @($sv, $st, $rd)) {
            if ($m.MemberType -ne [System.Management.Automation.PSMemberTypes]::NoteProperty) { throw $failure }
        }
        if ($sv.Value -isnot [string] -or -not ($sv.Value -ceq 'OperationalRunReceipt/v2')) { throw $failure }
        if ($st.Value -isnot [string] -or -not ($st.Value -ceq 'BLOCKED')) { throw $failure }
        # The actual accepted reader is dot-sourced only inside a private dynamic module scope, never into the caller.
        $readerPath = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'continuity') 'reconcile.ps1'
        $isolated = New-Module -Name ('BlockedTerminalReader_' + [guid]::NewGuid().ToString('N')) -ArgumentList $readerPath -ScriptBlock {
            param($ReaderPath)
            . $ReaderPath
            Export-ModuleMember -Function @()
        }
        $receiptOk = & $isolated { param($r) Test-OperationalReceipt $r } $terminal
        if ($receiptOk -isnot [bool] -or $receiptOk -ne $true) { throw $failure }
        $disp = $rd.Value
        if ($disp -isnot [System.Management.Automation.PSCustomObject]) { throw $failure }
        $gotReview = $disp.PSObject.Properties['reviewSha256'].Value
        $gotEvidence = $disp.PSObject.Properties['evidenceSha256'].Value
        if ($gotReview -isnot [string] -or $gotEvidence -isnot [string]) { throw $failure }
        if (-not [string]::Equals($gotReview, $expReview, [System.StringComparison]::Ordinal)) { throw $failure }
        if (-not [string]::Equals($gotEvidence, $expEvidence, [System.StringComparison]::Ordinal)) { throw $failure }

        $result = [pscustomobject]@{
            schema         = 'BlockedSettlementTerminalCapture/v1'
            terminal       = $terminal
            expected       = [pscustomobject]@{ reviewSha256 = $expReview; evidenceSha256 = $expEvidence }
            terminalSha256 = $hex
            receiptPath    = $path
        }
        return $result
    } catch {
        throw $failure
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $isolated) { Remove-Module -ModuleInfo $isolated -Force -ErrorAction SilentlyContinue }
    }
}
