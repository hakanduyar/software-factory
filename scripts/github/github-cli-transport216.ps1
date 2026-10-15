#Requires -Version 7.6
Set-StrictMode -Version Latest

function Test-GitHubCliPathPin216 {
  [CmdletBinding()]
  [OutputType([bool])]
  param(
    [string]$Path,
    [string]$ExpectedSha256,
    [bool]$IsDirectory
  )
  try {
    if ([string]::IsNullOrEmpty($Path) -or $Path.IndexOf([char]0) -ge 0 -or -not [System.IO.Path]::IsPathFullyQualified($Path)) { return $false }
    $full = [System.IO.Path]::GetFullPath($Path)
    $seps = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if ($full.TrimEnd($seps) -cne $Path.TrimEnd($seps)) { return $false }
    if ($IsDirectory) {
      if (-not [System.IO.Directory]::Exists($full)) { return $false }
    } elseif (-not [System.IO.File]::Exists($full)) { return $false }
    $cur = $full
    while (-not [string]::IsNullOrEmpty($cur)) {
      if ([System.IO.File]::GetAttributes($cur).HasFlag([System.IO.FileAttributes]::ReparsePoint)) { return $false }
      $cur = [System.IO.Path]::GetDirectoryName($cur)
    }
    if (-not $IsDirectory) {
      if ($ExpectedSha256 -cnotmatch '^[0-9a-fA-F]{64}\z') { return $false }
      $actual = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.IO.File]::ReadAllBytes($full))).ToLowerInvariant()
      if ($actual -cne $ExpectedSha256.ToLowerInvariant()) { return $false }
    }
    return $true
  } catch { return $false }
}

function Invoke-GitHubCliBoundedProcess216 {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ExecutablePath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}\z')][string]$ExpectedExecutableSha256,
    [Parameter(Mandatory)][ValidateNotNull()][AllowEmptyString()][string[]]$Arguments,
    [Parameter(Mandatory)][ValidateRange(1, 30000)][int]$DeadlineMs,
    [Parameter(Mandatory)][ValidateRange(1, 8388608)][int]$StdoutMaxBytes,
    [Parameter(Mandatory)][ValidateRange(1, 65536)][int]$StderrMaxBytes
  )
  $ErrorActionPreference = 'Stop'
  if ($Arguments.Count -lt 1) { throw 'ARGUMENTS_INVALID' }
  foreach ($a in $Arguments) { if ($null -eq $a -or $a.IndexOf([char]0) -ge 0) { throw 'ARGUMENTS_INVALID' } }
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $ExecutablePath
  foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Environment['GH_PROMPT_DISABLED'] = '1'
  $psi.Environment['GH_NO_UPDATE_NOTIFIER'] = '1'
  $psi.Environment['GH_SPINNER_DISABLED'] = '1'
  $psi.Environment['NO_COLOR'] = '1'
  $p = [System.Diagnostics.Process]::new()
  $started = $false
  try {
    $p.StartInfo = $psi
    if (-not (Test-GitHubCliPathPin216 -Path $ExecutablePath -ExpectedSha256 $ExpectedExecutableSha256 -IsDirectory $false)) { throw 'EXECUTABLE_PIN_REFUSED' }
    [void]$p.Start()
    $started = $true
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try { $p.StandardInput.Close() } catch { }
    $st = @(
      @{ s = $p.StandardOutput.BaseStream; cap = [long]$StdoutMaxBytes; ms = [System.IO.MemoryStream]::new(); t = $null; buf = [byte[]]::new(8192); eof = $false; trunc = $false },
      @{ s = $p.StandardError.BaseStream; cap = [long]$StderrMaxBytes; ms = [System.IO.MemoryStream]::new(); t = $null; buf = [byte[]]::new(8192); eof = $false; trunc = $false }
    )
    $timedOut = $false
    $overflow = $false
    while (-not ($st[0].eof -and $st[1].eof)) {
      $remain = $DeadlineMs - [int]$sw.ElapsedMilliseconds
      if ($remain -le 0) { $timedOut = $true; break }
      $pending = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
      foreach ($x in $st) {
        if (-not $x.eof) {
          if ($null -eq $x.t) { $x.t = $x.s.ReadAsync($x.buf, 0, $x.buf.Length) }
          $pending.Add($x.t)
        }
      }
      [void][System.Threading.Tasks.Task]::WaitAny($pending.ToArray(), $remain)
      foreach ($x in $st) {
        if ($null -ne $x.t -and $x.t.IsCompleted) {
          $n = $x.t.GetAwaiter().GetResult()
          $x.t = $null
          if ($n -le 0) {
            $x.eof = $true
          } else {
            $room = $x.cap - $x.ms.Length
            $take = [Math]::Min([long]$n, [long]$room)
            if ($take -gt 0) { $x.ms.Write($x.buf, 0, [int]$take) }
            if ([long]$n -gt $take) { $x.trunc = $true; $overflow = $true }
          }
        }
      }
      if ($overflow) { break }
    }
    if (-not $timedOut -and -not $overflow) {
      $remain = $DeadlineMs - [int]$sw.ElapsedMilliseconds
      if ($remain -lt 1) { $remain = 1 }
      if (-not $p.WaitForExit($remain)) { $timedOut = $true }
    }
    if ($timedOut -or $overflow) {
      try { $p.Kill($true) } catch { }
      [void]$p.WaitForExit(5000)
    }
    $code = -1
    if ($p.HasExited) { $code = [int]$p.ExitCode }
    $enc = if ($st[0].trunc) { [System.Text.UTF8Encoding]::new($false, $false) } else { [System.Text.UTF8Encoding]::new($false, $true) }
    try { $text = $enc.GetString($st[0].ms.ToArray()) } catch { throw 'STDOUT_ENCODING_INVALID' }
    return [pscustomobject]@{
      exitCode = [int]$code
      timedOut = [bool]$timedOut
      stdout = [string]$text
      stdoutTruncated = [bool]$st[0].trunc
      stderrTruncated = [bool]$st[1].trunc
    }
  } finally {
    if ($started) {
      try { if (-not $p.HasExited) { $p.Kill($true); [void]$p.WaitForExit(5000) } } catch { }
    }
    $p.Dispose()
  }
}

function New-GitHubCliLifecycleTransport216 {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$GhPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}\z')][string]$ExpectedGhSha256,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Repository,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$TempRoot,
    [scriptblock]$ProcessRunner
  )
  $repoName = 'hakanduyar/software-factory'
  if ($Repository -cne $repoName) { throw 'CONFIG_INVALID' }
  $pinFn = ${function:Test-GitHubCliPathPin216}
  if (-not (& $pinFn -Path $GhPath -ExpectedSha256 $ExpectedGhSha256 -IsDirectory $false)) { throw 'EXECUTABLE_PIN_REFUSED' }
  if (-not (& $pinFn -Path $TempRoot -ExpectedSha256 '' -IsDirectory $true)) { throw 'TEMP_ROOT_INVALID' }
  if ($null -eq $ProcessRunner) {
    $runnerFn = ${function:Invoke-GitHubCliBoundedProcess216}
    $runner = {
      param($e, $a, $d, $o, $m)
      & $runnerFn -ExecutablePath $e -ExpectedExecutableSha256 $ExpectedGhSha256 -Arguments $a -DeadlineMs $d -StdoutMaxBytes $o -StderrMaxBytes $m
    }.GetNewClosure()
  } else {
    $runner = $ProcessRunner
  }

  $transport = {
    param($Operation, $Request)
    $bad = [pscustomobject]@{ ok = $false }
    $badFind = [pscustomobject]@{ ok = $false; complete = $false; issues = @() }
    $nl = [string][char]10
    $cr = [string][char]13
    $fb = $bad
    try {
      if ($Operation -isnot [string] -or $Request -isnot [hashtable]) { return $bad }
      if ($Operation -cnotin @('FIND', 'CREATE', 'READ')) { return $bad }
      if ($Operation -ceq 'FIND') { $fb = $badFind }
      if (-not $Request.ContainsKey('repo') -or $Request['repo'] -isnot [string] -or $Request['repo'] -cne $repoName) { return $fb }

      $urlBase = 'https://github.com/' + $repoName + '/issues/'
      $textRx = '^[\p{L}\p{Nd} .,()-]*\z'
      $idRx = '^[A-Za-z0-9._:-]{1,128}\z'
      $credRx = '(?i)sk-[A-Za-z0-9]{8}|ghp|github pat|access token|refresh token|oauth token|bearer|password|secret|api key|(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])|\.factory-data|\b(?:windows|users|home)\b'
      $jopts = [System.Text.Json.JsonDocumentOptions]::new()
      $jopts.MaxDepth = 64
      $kObj = [System.Text.Json.JsonValueKind]::Object
      $kArr = [System.Text.Json.JsonValueKind]::Array
      $kStr = [System.Text.Json.JsonValueKind]::String
      $kNum = [System.Text.Json.JsonValueKind]::Number
      $kNull = [System.Text.Json.JsonValueKind]::Null

      $sha = { param([string]$s) [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($s))).ToLowerInvariant() }
      $props = {
        param($el)
        $h = [hashtable]::new([System.StringComparer]::Ordinal)
        foreach ($pr in $el.EnumerateObject()) {
          if ($h.ContainsKey($pr.Name)) { return $null }
          $h[$pr.Name] = $pr.Value
        }
        $h
      }
      $textOk = {
        param($v, [int]$min, [int]$max)
        if ($v -isnot [string]) { return $false }
        if ($v.Length -lt $min -or $v.Length -gt $max) { return $false }
        if ($v -cnotmatch $textRx -or $v -cmatch '^ | \z') { return $false }
        if ($v -match $credRx) { return $false }
        $true
      }
      $createOk = {
        param($title, $body)
        if (-not (& $textOk $title 1 160)) { return $false }
        if ($body -isnot [string]) { return $false }
        $ln = $body.Split($nl)
        if ($ln.Count -ne 9) { return $false }
        $m0 = [regex]::Match($ln[0], '^<!-- (factory-task-[0-9a-f]{64}) -->\z')
        if (-not $m0.Success -or $ln[1] -cne '' -or $ln[2] -cne '<!-- factory-task-status:start -->' -or $ln[8] -cne '<!-- factory-task-status:end -->') { return $false }
        if (-not $ln[3].StartsWith('Task: ', [System.StringComparison]::Ordinal)) { return $false }
        $id = $ln[3].Substring(6)
        if ($id -cnotmatch $idRx -or $m0.Groups[1].Value -cne ('factory-task-' + (& $sha $id))) { return $false }
        if (-not $ln[4].StartsWith('Version: ', [System.StringComparison]::Ordinal) -or $ln[4].Substring(9) -cnotmatch '^[1-9][0-9]{0,18}\z') { return $false }
        $ver = 0L
        if (-not [long]::TryParse($ln[4].Substring(9), [ref]$ver)) { return $false }
        if (-not $ln[5].StartsWith('Status: ', [System.StringComparison]::Ordinal) -or $ln[5].Substring(8) -cnotin @('IN_PROGRESS', 'WAITING_FOR_REVIEW', 'BLOCKED', 'ACCEPTED_SCOPED')) { return $false }
        if (-not $ln[6].StartsWith('Next action: ', [System.StringComparison]::Ordinal) -or $ln[6].Substring(13) -cnotin @('RUN_FOCUSED_CHECKS', 'INDEPENDENT_REVIEW', 'RESUME_AUTHORIZED_WORK', 'WAIT_FOR_DEPENDENCY')) { return $false }
        if (-not $ln[7].StartsWith('Summary: ', [System.StringComparison]::Ordinal) -or -not (& $textOk $ln[7].Substring(9) 0 512)) { return $false }
        $true
      }
      $exec = {
        param([string[]]$argv)
        try {
          if (-not (& $pinFn -Path $GhPath -ExpectedSha256 $ExpectedGhSha256 -IsDirectory $false)) { return $null }
          $o = @(& $runner $GhPath $argv 30000 8388608 65536)
          if ($o.Count -ne 1 -or $o[0] -isnot [pscustomobject]) { return $null }
          $r = $o[0]
          $names = @($r.PSObject.Properties.Name)
          if ($names.Count -ne 5) { return $null }
          foreach ($w in @('exitCode', 'timedOut', 'stdout', 'stdoutTruncated', 'stderrTruncated')) { if ($names -cnotcontains $w) { return $null } }
          if ($r.exitCode -isnot [int] -or $r.timedOut -isnot [bool] -or $r.stdout -isnot [string] -or $r.stdoutTruncated -isnot [bool] -or $r.stderrTruncated -isnot [bool]) { return $null }
          if ($r.exitCode -ne 0 -or $r.timedOut -or $r.stdoutTruncated -or $r.stderrTruncated) { return $null }
          if ([System.Text.Encoding]::UTF8.GetByteCount($r.stdout) -gt 8388608) { return $null }
          return $r
        } catch { return $null }
      }

      if ($Operation -ceq 'READ') {
        if ($Request.Count -ne 2 -or -not $Request.ContainsKey('issueNumber')) { return $bad }
        $n = $Request['issueNumber']
        if (-not ($n -is [int] -or $n -is [long]) -or $n -lt 1 -or $n -gt 2147483647) { return $bad }
        $n = [int]$n
        $url = $urlBase + [string]$n
        $r = & $exec @('issue', 'view', [string]$n, '--repo', $repoName, '--json', 'number,url,state,title,body')
        if ($null -eq $r) { return $bad }
        $doc = $null
        try {
          $doc = [System.Text.Json.JsonDocument]::Parse($r.stdout, $jopts)
          if ($doc.RootElement.ValueKind -ne $kObj) { return $bad }
          $h = & $props $doc.RootElement
          if ($null -eq $h -or $h.Count -ne 5) { return $bad }
          foreach ($k in @('number', 'url', 'state', 'title', 'body')) { if (-not $h.ContainsKey($k)) { return $bad } }
          $num = 0
          if ($h['number'].ValueKind -ne $kNum -or -not $h['number'].TryGetInt32([ref]$num) -or $num -ne $n) { return $bad }
          foreach ($k in @('url', 'state', 'title', 'body')) { if ($h[$k].ValueKind -ne $kStr) { return $bad } }
          $u = $h['url'].GetString()
          $s = $h['state'].GetString()
          if ($u -cne $url -or $s -cnotin @('OPEN', 'CLOSED')) { return $bad }
          return [pscustomobject]@{ ok = $true; number = $n; url = $u; state = $s; title = $h['title'].GetString(); body = $h['body'].GetString() }
        } finally { if ($null -ne $doc) { $doc.Dispose() } }
      }

      if ($Operation -ceq 'FIND') {
        if ($Request.Count -ne 3 -or -not $Request.ContainsKey('stableMarker') -or -not $Request.ContainsKey('renderedMarker')) { return $badFind }
        $stable = $Request['stableMarker']
        $rendered = $Request['renderedMarker']
        if ($stable -isnot [string] -or $stable -cnotmatch '^factory-task-[0-9a-f]{64}\z') { return $badFind }
        if ($rendered -isnot [string] -or $rendered -cne ('<!-- ' + $stable + ' -->')) { return $badFind }
        $r = & $exec @('api', '--method', 'GET', ('repos/' + $repoName + '/issues?state=all&per_page=100'), '--paginate', '--slurp')
        if ($null -eq $r) { return $badFind }
        $doc = $null
        try {
          $doc = [System.Text.Json.JsonDocument]::Parse($r.stdout, $jopts)
          if ($doc.RootElement.ValueKind -ne $kArr) { return $badFind }
          $pages = 0
          $total = 0
          $seen = [System.Collections.Generic.HashSet[int]]::new()
          $hits = [System.Collections.Generic.List[object]]::new()
          foreach ($page in $doc.RootElement.EnumerateArray()) {
            if ($page.ValueKind -ne $kArr) { return $badFind }
            $pages++
            foreach ($it in $page.EnumerateArray()) {
              $total++
              if ($total -gt 1000) { return $badFind }
              if ($it.ValueKind -ne $kObj) { return $badFind }
              $h = & $props $it
              if ($null -eq $h -or -not $h.ContainsKey('number')) { return $badFind }
              $num = 0
              if ($h['number'].ValueKind -ne $kNum -or -not $h['number'].TryGetInt32([ref]$num) -or $num -lt 1) { return $badFind }
              if (-not $seen.Add($num)) { return $badFind }
              if ($h.ContainsKey('pull_request')) { continue }
              foreach ($k in @('html_url', 'state', 'body')) { if (-not $h.ContainsKey($k)) { return $badFind } }
              if ($h['html_url'].ValueKind -ne $kStr -or $h['state'].ValueKind -ne $kStr) { return $badFind }
              $u = $h['html_url'].GetString()
              if ($u -cne ($urlBase + [string]$num) -or $h['state'].GetString() -cnotin @('open', 'closed')) { return $badFind }
              if ($h['body'].ValueKind -eq $kNull) { continue }
              if ($h['body'].ValueKind -ne $kStr) { return $badFind }
              $cnt = 0
              foreach ($l in $h['body'].GetString().Split($nl)) {
                $ll = $l
                if ($ll.EndsWith($cr, [System.StringComparison]::Ordinal)) { $ll = $ll.Substring(0, $ll.Length - 1) }
                if ($ll -ceq $rendered) { $cnt++ }
              }
              if ($cnt -gt 1) { return $badFind }
              if ($cnt -eq 1) { $hits.Add([pscustomobject]@{ number = [int]$num; url = $u }) }
            }
          }
          if ($pages -lt 1) { return $badFind }
          return [pscustomobject]@{ ok = $true; complete = $true; issues = [object[]]$hits.ToArray() }
        } finally { if ($null -ne $doc) { $doc.Dispose() } }
      }

      if ($Request.Count -ne 3 -or -not $Request.ContainsKey('title') -or -not $Request.ContainsKey('body')) { return $bad }
      $title = $Request['title']
      $body = $Request['body']
      if (-not (& $createOk $title $body)) { return $bad }
      $createRx = '^' + [regex]::Escape($urlBase) + '([1-9][0-9]{0,9})\z'
      $bodyPath = Join-Path $TempRoot ('github-cli-body216-' + [guid]::NewGuid().ToString('N') + '.md')
      $made = $false
      $r = $null
      try {
        if (-not (& $pinFn -Path $TempRoot -ExpectedSha256 '' -IsDirectory $true)) { return $bad }
        $fs = [System.IO.FileStream]::new($bodyPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $made = $true
        try {
          $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($body)
          $fs.Write($bytes, 0, $bytes.Length)
        } finally { $fs.Dispose() }
        $r = & $exec @('issue', 'create', '--repo', $repoName, '--title', $title, '--body-file', $bodyPath)
      } finally {
        if ($made) {
          try {
            if ([System.IO.File]::Exists($bodyPath) -and -not [System.IO.File]::GetAttributes($bodyPath).HasFlag([System.IO.FileAttributes]::ReparsePoint)) { [System.IO.File]::Delete($bodyPath) }
          } catch { }
        }
      }
      if ($null -eq $r) { return $bad }
      $s = $r.stdout
      if ($s.EndsWith($cr + $nl, [System.StringComparison]::Ordinal)) { $s = $s.Substring(0, $s.Length - 2) }
      elseif ($s.EndsWith($nl, [System.StringComparison]::Ordinal)) { $s = $s.Substring(0, $s.Length - 1) }
      $m = [regex]::Match($s, $createRx)
      $n = 0
      if (-not $m.Success -or -not [int]::TryParse($m.Groups[1].Value, [ref]$n) -or $n -lt 1) { return $bad }
      return [pscustomobject]@{ ok = $true; number = $n; url = $s }
    } catch {
      return $fb
    }
  }.GetNewClosure()
  return $transport
}
