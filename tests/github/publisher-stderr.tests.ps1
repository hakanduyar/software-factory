#Requires -Version 7.6
param([Parameter(Mandatory)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '../../scripts/github/github-cli-transport216.ps1')
function Get-LifecycleHash {
  param([byte[]]$Bytes)
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-LifecycleFileHash { param([string]$Path) Get-LifecycleHash ([IO.File]::ReadAllBytes($Path)) }
function PutJson($path,$obj){[IO.File]::WriteAllText($path,($obj|ConvertTo-Json -Depth 18 -Compress),[Text.UTF8Encoding]::new($false))}
function PutText($path,$text){[IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($false))}
function Assert($condition,$message){if(-not $condition){throw ('ASSERT: '+$message)}}
Assert ([IO.Path]::IsPathFullyQualified($EvidenceRoot)) 'absolute evidence root required'
Assert (-not (Test-Path -LiteralPath $EvidenceRoot)) 'fresh evidence root required'
[void][IO.Directory]::CreateDirectory($EvidenceRoot)
$pwshPath=[Environment]::ProcessPath
$pwshSha=Get-LifecycleFileHash $pwshPath
$secrets=@('sk-ABCDEFGH12345678','ghp_SECRETTOKENVALUE','C:\Users\someone\secret.txt','https://example.invalid/path?token=QUERYSECRET','Bearer ZZZTOKEN')
function Invoke-ChildProcess([string]$script){
  Invoke-GitHubCliBoundedProcess216 -ExecutablePath $pwshPath -ExpectedExecutableSha256 $pwshSha -Arguments @('-NoProfile','-NonInteractive','-Command',$script) -DeadlineMs 20000 -StdoutMaxBytes 65536 -StderrMaxBytes 65536
}
function Assert-NoRaw($obj,[string]$what){
  $json=$obj|ConvertTo-Json -Depth 8 -Compress
  foreach($s in $secrets+@('someone','QUERYSECRET','example.invalid')){Assert (-not $json.Contains($s)) ($what+' leaked '+$s)}
}
function Check($name,[scriptblock]$test){& $test;Write-Output ('PASS '+$name)}

Check 'actual pwsh child nonzero yields typed safe category without raw stderr' {
  $r=Invoke-ChildProcess '[Console]::Error.WriteLine("HTTP 404: Not Found (https://example.invalid/path?token=QUERYSECRET) C:\Users\someone\secret.txt sk-ABCDEFGH12345678"); exit 3'
  Assert ($r.exitCode -eq 3 -and -not $r.timedOut) 'nonzero observed'
  $d=$r.failureDiagnostic
  Assert (Test-GitHubCliFailureDiagnostic216 $d) 'diagnostic validates'
  Assert ($d.category -ceq 'NOT_FOUND' -and $d.exitCode -eq 3 -and $d.stderrEncoding -ceq 'VALID' -and -not $d.stderrTruncated) 'known category'
  Assert-NoRaw $r 'runner result'
  $u=Invoke-ChildProcess '[Console]::Error.WriteLine("Bearer ZZZTOKEN something novel ghp_SECRETTOKENVALUE"); exit 1'
  Assert ($u.failureDiagnostic.category -ceq 'UNKNOWN') 'unrecognized maps UNKNOWN'
  Assert-NoRaw $u 'unknown result'
  $ok=Invoke-ChildProcess 'exit 0'
  Assert (@($ok.PSObject.Properties.Name).Count -eq 5 -and -not ($ok.PSObject.Properties.Name -contains 'failureDiagnostic')) 'success shape unchanged'
}

function New-TransportFor($runner){
  $temp=Join-Path $EvidenceRoot ('t'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($temp)
  New-GitHubCliLifecycleTransport216 -GhPath $pwshPath -ExpectedGhSha256 $pwshSha -Repository 'hakanduyar/software-factory' -TempRoot $temp -ProcessRunner $runner
}
$readArgs=@{repo='hakanduyar/software-factory';issueNumber=67}
$goodJson='{"number":67,"url":"https://github.com/hakanduyar/software-factory/issues/67","state":"OPEN","title":"T","body":"B"}'

Check 'transport returns only validated safe diagnostic on failure' {
  $real={param($e,$a,$d,$o,$m) Invoke-ChildProcess '[Console]::Error.WriteLine("HTTP 403 forbidden C:\Users\someone\x https://example.invalid/?token=QUERYSECRET"); exit 1'}
  $t=New-TransportFor $real
  $res=& $t 'READ' $readArgs
  Assert (-not $res.ok -and $res.diagnostic.category -ceq 'PERMISSION_DENIED' -and (Test-GitHubCliFailureDiagnostic216 $res.diagnostic)) 'typed diagnostic on failure'
  Assert-NoRaw $res 'transport result'
  $bad={param($e,$a,$d,$o,$m) [pscustomobject]@{exitCode=[int]2;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false;failureDiagnostic=[pscustomobject]@{category='RAW: sk-ABCDEFGH12345678';exitCode=2;timedOut=$false;stderrTruncated=$false;stderrEncoding='VALID'}}}
  $res=& (New-TransportFor $bad) 'READ' $readArgs
  Assert (-not $res.ok -and -not ($res.PSObject.Properties.Name -contains 'diagnostic')) 'malformed diagnostic omitted, still failure'
  Assert-NoRaw $res 'malformed result'
  $old5={param($e,$a,$d,$o,$m) [pscustomobject]@{exitCode=[int]4;timedOut=$false;stdout='';stdoutTruncated=$false;stderrTruncated=$false}}
  $res=& (New-TransportFor $old5) 'READ' $readArgs
  Assert (-not $res.ok -and $res.diagnostic.category -ceq 'UNKNOWN' -and $res.diagnostic.stderrEncoding -ceq 'NOT_OBSERVED') 'old 5-field nonzero stays failure with derived diagnostic'
  $boom={param($e,$a,$d,$o,$m) throw 'secret C:\Users\someone raw exception'}
  $res=& (New-TransportFor $boom) 'READ' $readArgs
  Assert (-not $res.ok -and $res.diagnostic.category -ceq 'UNAVAILABLE' -and $res.diagnostic.exitCode -eq -1) 'exception is honest unavailable'
  Assert-NoRaw $res 'exception result'
  $six0={param($e,$a,$d,$o,$m) [pscustomobject]@{exitCode=[int]0;timedOut=$false;stdout='{}';stdoutTruncated=$false;stderrTruncated=$false;failureDiagnostic=$null}}
  Assert (-not (& (New-TransportFor $six0) 'READ' $readArgs).ok) 'success with extra field fails closed'
}

Check 'old 5-field runner success compatibility' {
  $okRunner={param($e,$a,$d,$o,$m) [pscustomobject]@{exitCode=[int]0;timedOut=$false;stdout=$goodJson;stdoutTruncated=$false;stderrTruncated=$false}}.GetNewClosure()
  $res=& (New-TransportFor $okRunner) 'READ' $readArgs
  Assert ($res.ok -and $res.number -eq 67 -and -not ($res.PSObject.Properties.Name -contains 'diagnostic')) 'success public shape unchanged'
}
