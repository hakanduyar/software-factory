function Test-MetadataJsonElementUnique {
    param([System.Text.Json.JsonElement]$Element)
    $kind = $Element.ValueKind
    if ($kind -eq [System.Text.Json.JsonValueKind]::Object) {
        $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($prop in $Element.EnumerateObject()) {
            if (-not $seen.Add($prop.Name)) { throw 'METADATA_JSON_DUPLICATE' }
            Test-MetadataJsonElementUnique -Element $prop.Value
        }
    }
    elseif ($kind -eq [System.Text.Json.JsonValueKind]::Array) {
        foreach ($item in $Element.EnumerateArray()) {
            Test-MetadataJsonElementUnique -Element $item
        }
    }
}

function ConvertTo-StrictMetadataDocument {
    param(
        [object]$JsonText,
        [object]$MaxUtf8Bytes
    )

    if ($JsonText -isnot [string]) { throw 'METADATA_JSON_TYPE' }
    if ($MaxUtf8Bytes -isnot [int] -and $MaxUtf8Bytes -isnot [long]) { throw 'METADATA_JSON_TYPE' }
    if ($MaxUtf8Bytes -lt 1 -or $MaxUtf8Bytes -gt 131072) { throw 'METADATA_JSON_BOUND' }

    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    $count = 0
    try { $count = $encoding.GetByteCount($JsonText) } catch { throw 'METADATA_JSON_ENCODING' }
    if ($count -gt $MaxUtf8Bytes) { throw 'METADATA_JSON_BOUND' }

    $text = $JsonText
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }

    $options = New-Object System.Text.Json.JsonDocumentOptions
    $options.MaxDepth = 16
    $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
    $options.AllowTrailingCommas = $false
    $doc = $null
    try { $doc = [System.Text.Json.JsonDocument]::Parse($text, $options) } catch { throw 'METADATA_JSON_PARSE' }

    $failure = $null
    try {
        Test-MetadataJsonElementUnique -Element $doc.RootElement
    }
    catch {
        $failure = 'METADATA_JSON_PARSE'
        if ($_.Exception.Message -eq 'METADATA_JSON_DUPLICATE') { $failure = 'METADATA_JSON_DUPLICATE' }
    }
    if ($null -ne $failure) {
        $doc.Dispose()
        throw $failure
    }
    return ,$doc
}
