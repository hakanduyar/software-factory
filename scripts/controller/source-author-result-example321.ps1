# SourceAuthorResultExampleValidatorProposal321/v1 - definitions only, pure, no IO. SOURCE_ONLY_NOT_RUN.
function Stop-SrcEx321 {
    param([string]$Code)
    throw ('SOURCE_EXAMPLE321_INVALID:' + $Code)
}

function GetSrcExString321 {
    param(
        [System.Text.Json.JsonElement]$Element,
        [string]$Code
    )
    $value = $null
    $bad = $false
    try { $value = $Element.GetString() }
    catch [System.InvalidOperationException] { $bad = $true }
    catch [System.Management.Automation.MethodInvocationException] {
        if ($_.Exception.InnerException -is [System.InvalidOperationException]) { $bad = $true } else { throw }
    }
    if ($bad) { Stop-SrcEx321 'JSON' }
    return $value
}

function AssertSourceAuthorResultExample321 {
    [CmdletBinding()]
    param(
        [object]$ExampleJson,
        [object]$PacketText,
        [object]$ExpectedChangedPaths
    )
    if ($ExampleJson -isnot [string] -or $PacketText -isnot [string] -or $ExpectedChangedPaths -isnot [object[]]) { Stop-SrcEx321 'TYPE' }
    $utf8 = [System.Text.Encoding]::UTF8
    if ($utf8.GetByteCount([string]$PacketText) -gt 131072) { Stop-SrcEx321 'BOUND' }
    if ($utf8.GetByteCount([string]$ExampleJson) -gt 2048) { Stop-SrcEx321 'EXAMPLE_BOUND' }
    if ($ExpectedChangedPaths.Count -lt 1 -or $ExpectedChangedPaths.Count -gt 32) { Stop-SrcEx321 'BOUND' }
    $expected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($p in $ExpectedChangedPaths) {
        if ($p -isnot [string]) { Stop-SrcEx321 'TYPE' }
        if ([string]::IsNullOrWhiteSpace($p) -or $p.Length -gt 2048) { Stop-SrcEx321 'BOUND' }
        if (-not $expected.Add($p)) { Stop-SrcEx321 'PATHS' }
    }

    $options = New-Object System.Text.Json.JsonDocumentOptions
    $options.MaxDepth = 4
    $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
    $options.AllowTrailingCommas = $false
    $doc = $null
    $bad = $false
    try { $doc = [System.Text.Json.JsonDocument]::Parse([string]$ExampleJson, $options) } catch { $bad = $true }
    if ($bad) { Stop-SrcEx321 'JSON' }

    try {
        $kObject = [System.Text.Json.JsonValueKind]::Object
        $kArray = [System.Text.Json.JsonValueKind]::Array
        $kString = [System.Text.Json.JsonValueKind]::String
        $kNull = [System.Text.Json.JsonValueKind]::Null
        $root = $doc.RootElement
        if ($root.ValueKind -ne $kObject) { Stop-SrcEx321 'SHAPE' }
        $required = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($k in 'summary', 'changedPaths', 'commandsRun', 'validationResults', 'fingerprint', 'checkpointRef', 'blockers', 'recommendedNextAction') { [void]$required.Add($k) }
        $props = [System.Collections.Generic.Dictionary[string, System.Text.Json.JsonElement]]::new([System.StringComparer]::Ordinal)
        foreach ($prop in $root.EnumerateObject()) {
            if (-not $required.Contains($prop.Name) -or $props.ContainsKey($prop.Name)) { Stop-SrcEx321 'SHAPE' }
            $props.Add($prop.Name, $prop.Value)
        }
        if ($props.Count -ne 8) { Stop-SrcEx321 'SHAPE' }

        foreach ($name in 'summary', 'recommendedNextAction') {
            $e = $props[$name]
            if ($e.ValueKind -ne $kString) { Stop-SrcEx321 'SHAPE' }
            $s = GetSrcExString321 $e 'SHAPE'
            if ([string]::IsNullOrWhiteSpace($s) -or $s.Length -gt 512) { Stop-SrcEx321 'SHAPE' }
        }
        foreach ($name in 'checkpointRef', 'fingerprint') {
            if ($props[$name].ValueKind -ne $kNull) { Stop-SrcEx321 'CLAIM' }
        }
        foreach ($name in 'commandsRun', 'blockers') {
            $e = $props[$name]
            if ($e.ValueKind -ne $kArray) { Stop-SrcEx321 'SHAPE' }
            if ($e.GetArrayLength() -ne 0) { Stop-SrcEx321 'CLAIM' }
        }
        $v = $props['validationResults']
        if ($v.ValueKind -ne $kArray) { Stop-SrcEx321 'SHAPE' }
        if ($v.GetArrayLength() -ne 1) { Stop-SrcEx321 'CLAIM' }
        foreach ($item in $v.EnumerateArray()) {
            if ($item.ValueKind -ne $kString -or -not ((GetSrcExString321 $item 'CLAIM') -ceq 'NOT_RUN')) { Stop-SrcEx321 'CLAIM' }
        }

        $cp = $props['changedPaths']
        if ($cp.ValueKind -ne $kArray) { Stop-SrcEx321 'SHAPE' }
        $n = $cp.GetArrayLength()
        if ($n -lt 1 -or $n -gt 32) { Stop-SrcEx321 'BOUND' }
        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($item in $cp.EnumerateArray()) {
            if ($item.ValueKind -ne $kString) { Stop-SrcEx321 'SHAPE' }
            $s = GetSrcExString321 $item 'SHAPE'
            if ([string]::IsNullOrWhiteSpace($s) -or $s.Length -gt 2048) { Stop-SrcEx321 'BOUND' }
            if (-not $seen.Add($s)) { Stop-SrcEx321 'PATHS' }
        }
        if (-not $seen.SetEquals($expected)) { Stop-SrcEx321 'PATHS' }

        if (([string]$PacketText).IndexOf([string]$ExampleJson, [System.StringComparison]::Ordinal) -lt 0) { Stop-SrcEx321 'SHAPE' }
    }
    finally {
        $doc.Dispose()
    }
    return $true
}
