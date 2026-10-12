param(
  [Parameter(Mandatory)][string]$SourcePath,
  [Parameter(Mandatory)][string]$SelectedPath,
  [Parameter(Mandatory)][string]$ExpectedPath,
  [Parameter(Mandatory)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$code = 'REVIEWED_BLOCKED_PREDECESSOR_INVALID'
$groups = New-Object System.Collections.Generic.List[string]

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERT FAILED: $Message" }
}

function Get-FileSha([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Invalid([scriptblock]$Action, [string]$Name) {
  $message = $null
  try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
  Assert-True ($null -ne $message) "$Name must throw"
  Assert-True ($message -like "*$code*") "$Name must throw $code but threw: $message"
}

function New-Ordered([object]$Source, [string[]]$Names) {
  $o = [pscustomobject]@{}
  foreach ($n in $Names) { $o | Add-Member -NotePropertyName $n -NotePropertyValue $Source.$n }
  $o
}

$selectedFields = 'id','owner','provider','route','claimId','intentId','kind','receiptSha','planSha','statePath'
$expectedFields = 'reviewSha256','evidenceSha256'

$inputShaBefore = [ordered]@{
  selected = Get-FileSha $SelectedPath
  expected = Get-FileSha $ExpectedPath
}
$sourceSha = Get-FileSha $SourcePath

. $SourcePath

$selected = (Get-Content -LiteralPath $SelectedPath -Raw | ConvertFrom-Json).selected
$expected = Get-Content -LiteralPath $ExpectedPath -Raw | ConvertFrom-Json
$stateDir = Split-Path $selected.statePath -Parent
$selectedJsonBefore = $selected | ConvertTo-Json -Compress
$expectedJsonBefore = $expected | ConvertTo-Json -Compress

# Group 1: actual 10-field selected + expected 61 baseline
$r = Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $selected -ExpectedBlockedReview $expected -StateDir $stateDir
Assert-True ($r.schema -eq 'ReviewedBlockedPredecessorCapture/v1') 'schema'
foreach ($f in $selectedFields) {
  Assert-True ($r.previousSelectedClaim.$f -ceq $selected.$f) "selected clone $f"
}
foreach ($f in $expectedFields) {
  Assert-True ($r.expectedReview.$f -ceq $expected.$f) "expected clone $f"
}
Assert-True (@($r.previousSelectedClaim.PSObject.Properties).Count -eq 10) 'selected clone has 10 fields'
Assert-True (@($r.expectedReview.PSObject.Properties).Count -eq 2) 'expected clone has 2 fields'
Assert-True ($r.stateDirFull -ceq [System.IO.Path]::GetFullPath($stateDir)) 'stateDirFull canonical'
Assert-True (-not [object]::ReferenceEquals($r.previousSelectedClaim, $selected)) 'selected not aliased'
Assert-True (-not [object]::ReferenceEquals($r.expectedReview, $expected)) 'expected not aliased'
$groups.Add('actual-baseline')

# Group 2: wrong StateDir canonical path refusal
$wrongDir = Join-Path $stateDir 'wrong-partition'
Assert-Invalid { Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $selected -ExpectedBlockedReview $expected -StateDir $wrongDir } 'wrong StateDir'
$groups.Add('wrong-statedir')

# Group 3: reordered exact-name properties accepted
$selReordered = New-Ordered $selected ($selectedFields[($selectedFields.Count - 1)..0])
$expReordered = New-Ordered $expected ($expectedFields[($expectedFields.Count - 1)..0])
$r2 = Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $selReordered -ExpectedBlockedReview $expReordered -StateDir $stateDir
foreach ($f in $selectedFields) { Assert-True ($r2.previousSelectedClaim.$f -ceq $selected.$f) "reordered selected $f" }
foreach ($f in $expectedFields) { Assert-True ($r2.expectedReview.$f -ceq $expected.$f) "reordered expected $f" }
$groups.Add('reordered-properties')

# Group 4: explicit null is stable invalid
$selNull = New-Ordered $selected $selectedFields
$selNull.owner = $null
Assert-Invalid { Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $selNull -ExpectedBlockedReview $expected -StateDir $stateDir } 'null selected field'
$expNull = New-Ordered $expected $expectedFields
$expNull.evidenceSha256 = $null
Assert-Invalid { Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $selected -ExpectedBlockedReview $expNull -StateDir $stateDir } 'null expected field'
$groups.Add('explicit-null')

# Group 5: ScriptProperty owner counter stays 0 (metadata refused before getter)
$counter = @{ n = 0 }
$selGetter = New-Ordered $selected ($selectedFields | Where-Object { $_ -ne 'owner' })
$selGetter | Add-Member -MemberType ScriptProperty -Name owner -Value ({ $counter.n++; 'getter-owner' }).GetNewClosure()
Assert-Invalid { Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $selGetter -ExpectedBlockedReview $expected -StateDir $stateDir } 'ScriptProperty owner'
Assert-True ($counter.n -eq 0) "ScriptProperty getter must not run, count=$($counter.n)"
$groups.Add('scriptproperty-getter-zero')

# Group 6: returned clone mutation leaves originals unchanged
$r3 = Get-ReviewedBlockedPredecessorCapture -PreviousSelectedClaim $selected -ExpectedBlockedReview $expected -StateDir $stateDir
$r3.previousSelectedClaim.id = 'mutated'
$r3.expectedReview.reviewSha256 = 'mutated'
Assert-True (($selected | ConvertTo-Json -Compress) -ceq $selectedJsonBefore) 'selected JSON unchanged after clone mutation'
Assert-True (($expected | ConvertTo-Json -Compress) -ceq $expectedJsonBefore) 'expected JSON unchanged after clone mutation'
$groups.Add('clone-integrity')

$inputShaAfter = [ordered]@{
  selected = Get-FileSha $SelectedPath
  expected = Get-FileSha $ExpectedPath
}
Assert-True ($inputShaAfter.selected -eq $inputShaBefore.selected) 'selected file SHA preserved'
Assert-True ($inputShaAfter.expected -eq $inputShaBefore.expected) 'expected file SHA preserved'
Assert-True ((Get-FileSha $SourcePath) -eq $sourceSha) 'source SHA preserved'

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$outputPath = Join-Path $OutputDir 'reviewed-blocked-predecessor-capture.public-tests-result.json'
$result = [ordered]@{
  schema = 'CapturePublicTestsResult/v1'
  passed = $true
  groups = @($groups)
  outputPath = $outputPath
  inputSha = [ordered]@{ before = $inputShaBefore; after = $inputShaAfter }
  sourceSha = $sourceSha
}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $outputPath -Encoding UTF8
$result | ConvertTo-Json -Depth 6