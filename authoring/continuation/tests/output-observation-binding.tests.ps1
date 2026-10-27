param([Parameter(Mandatory)][string]$SourcePath,[Parameter(Mandatory)][string]$OutputDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath($SourcePath)
$pin='32b8fe6d4a3a3de77e89473066ea84d7790e59523f64b754aeffb57a69f7c81b'
# Portable output: caller supplies a new absolute directory; no existing files are changed.
if([IO.Path]::GetFullPath($OutputDirectory) -cne $OutputDirectory -or (Test-Path -LiteralPath $OutputDirectory)){throw 'OUTPUT_BOUNDARY'}
if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin){throw 'SOURCE_PIN'}
$null=New-Item -ItemType Directory -Path $OutputDirectory
. $source
# Explicit composition doubles, never an authenticated capture or genuine SDK positive.
$script:case=''; $script:calls=0; $script:sdkCalls=0
$script:h='a'*64; $script:t='b'*64
$script:e=[pscustomobject]@{schema='ManagedNativeAdvisoryEvidence/v1';manifestPath='C:\owned\manifest.json';manifestSha256=$script:h;terminalPath='C:\owned\terminal.json';terminalSha256=$script:t;ticketPath='C:\owned\ticket.json';runId='COMPOSITION_ONLY';attempt=[long]1}
function New-CompositionCapture([int]$index){
 $c=[pscustomobject]@{RunId='COMPOSITION_ONLY';Attempt=[long]1;SessionId='composition-session';RunDir='C:\owned';Pid=[long]1234;TransportExitCode=[long]0;ManifestPath=$script:e.manifestPath;ManifestSha256=$script:h;TerminalPath=$script:e.terminalPath;TerminalSha256=$script:t;TicketPath=$script:e.ticketPath;TicketSha256=('c'*64);StartPath='C:\owned\start.json';StartSha256=('d'*64);RequestSha256=('e'*64);ArtifactPath='C:\owned\artifact';ArtifactState='ABSENT';Authority=[pscustomobject]@{mode='observe-only-v1'};Budget=[pscustomobject]@{elapsedMs=[long]100};DeclaredReferences=[object[]]@([pscustomobject]@{Role='STDOUT';Path='C:\owned\stdout';DeclaredSha256=('f'*64);DeclaredLength=[long]42});VerifiedReferences=[object[]]@([pscustomobject]@{Role='STDOUT';Path='C:\owned\stdout';VerifiedSha256=('f'*64);VerifiedLength=[long]42});Inputs=[object[]]@();StreamedInputs=[object[]]@()}
 if($index -eq 2){switch($script:case){'changed-pid'{$c.Pid=[long]9999};'changed-rundir'{$c.RunDir='C:\different'};'changed-exit'{$c.TransportExitCode=[long]7};'changed-authority'{$c.Authority.mode='different'}}}
 if($script:case -eq 'missing-start-both'){$c.PSObject.Properties.Remove('StartPath');$c.PSObject.Properties.Remove('StartSha256');$c.PSObject.Properties.Remove('RequestSha256')}
 if($script:case -eq 'ordinal-dictionary-change'){
  $d=[System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  $d.Add('A',$(if($index -eq 1){'first'}else{'CHANGED'}));$d.Add('a','last')
  $c.Authority=$d
 }
 return $c
}
function Get-ManagedNativeCapturedFacts {
 param($ManifestPath,$ExpectedManifestSha256,$TerminalPath,$ExpectedTerminalSha256,$TicketPath,$RunId,$Attempt,[switch]$ForOutputObservation)
 $script:calls++
 if(-not $ForOutputObservation -or $ManifestPath -cne $script:e.manifestPath -or $ExpectedManifestSha256 -cne $script:h -or $TerminalPath -cne $script:e.terminalPath -or $ExpectedTerminalSha256 -cne $script:t -or $TicketPath -cne $script:e.ticketPath -or $RunId -cne $script:e.runId -or $Attempt -ne 1){throw 'MOCK_CALL_BINDING'}
 [pscustomobject]@{Valid=$false;Facts=$null;Code='OBSERVE_ONLY_TRANSPORT_CAPTURE';ObservationCapture=(New-CompositionCapture $script:calls)}
}
function Get-ManagedNativeSdkObservation {
 param($StdoutPath,$ExpectedStdoutSha256,$ExpectedStdoutLength,$ExpectedSessionId)
 $script:sdkCalls++
 if($StdoutPath -cne 'C:\owned\stdout' -or $ExpectedStdoutSha256 -cne ('f'*64) -or $ExpectedStdoutLength -ne 42 -or $ExpectedSessionId -cne 'composition-session'){throw 'MOCK_SDK_BINDING'}
 [pscustomobject]@{Schema='ManagedNativeSdkObservation/v1';Status='OBSERVED';Code='SDK_RESULT_OBSERVED';VerifiedRaw=[pscustomobject]@{Path='C:\owned\stdout';Sha256=('f'*64);Length=[long]42};SdkOutcome='SUCCESS';SdkSubtype='success';SdkStopReason=$null;SdkTerminalReason='success';SdkErrors=$null;SdkReportedOutputTokens=[long]10;RecountedOutputTokens=[long]10;RecountStatus='COMPLETE';Consistency='MATCH';MessageStarts=[long]1;NoAcceptedUsage=$true;NoReceipt=$true;NoCompletion=$true;NoDispatch=$true}
}
$rows=[System.Collections.Generic.List[object]]::new()
foreach($spec in @(@('unchanged-composition','OBSERVED'),@('changed-pid','INVALID'),@('changed-rundir','INVALID'),@('changed-exit','INVALID'),@('missing-start-both','INVALID'),@('ordinal-dictionary-change','INVALID'),@('changed-authority','INVALID'))){
 $script:case=$spec[0];$script:calls=0;$script:sdkCalls=0
 try{
  $r=Get-ManagedNativeOutputObservation -Evidence $script:e
  $pass=($r.Status -ceq $spec[1]) -and ($r.NoAcceptedUsage -eq $true) -and ($r.NoReceipt -eq $true) -and ($r.NoCompletion -eq $true) -and ($r.NoDispatch -eq $true)
  $rows.Add([pscustomobject]@{case=$script:case;kind='LABELLED_COMPOSITION_DOUBLES_NOT_AUTHENTICATED';expected=$spec[1];actual=$r.Status;code=$r.Code;captureCalls=$script:calls;sdkCalls=$script:sdkCalls;pass=$pass;exception=$null})
 }catch{$rows.Add([pscustomobject]@{case=$script:case;kind='LABELLED_COMPOSITION_DOUBLES_NOT_AUTHENTICATED';expected=$spec[1];actual='HARNESS_EXCEPTION';code=$null;captureCalls=$script:calls;sdkCalls=$script:sdkCalls;pass=$false;exception=$_.Exception.GetType().FullName})}
}
$post=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if($post -cne $pin){throw 'SOURCE_CHANGED'}
$result=[pscustomobject]@{schema='OutputBindingCompositionDiagnosis/v1';observedUtc=[datetime]::UtcNow.ToString('o');source=$source;sourceSha256=$pin;sourceUnchanged=$true;genuineManagedPositive='NOT_AVAILABLE';providerCalls=0;childProcesses=0;rows=$rows.ToArray();passed=@($rows|Where-Object pass).Count;failed=@($rows|Where-Object {-not $_.pass}).Count}
$path=Join-Path $OutputDirectory 'results.json'
[IO.File]::WriteAllText($path,($result|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))
[pscustomobject]@{path=$path;sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant();passed=$result.passed;failed=$result.failed}|ConvertTo-Json -Compress
if($result.failed -gt 0){exit 1}
