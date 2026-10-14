#Requires -Version 7.6
Set-StrictMode -Version Latest

function Invoke-DurableGitHubTaskCreate {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$EventPath,
    [Parameter(Mandatory)][hashtable]$Configuration,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$StateDir,
    [Parameter(Mandatory)][scriptblock]$Transport
  )
  $nl = [string][char]10
  $ctx = @{ task = $null; key = $null; attempt = 0 }
  $mk = {
    param([string]$St, [string]$Code, $Map = $null, [bool]$Rep = $false)
    $o = [ordered]@{ status = $St; code = $Code; taskId = $ctx.task; eventKey = $ctx.key; attempt = $ctx.attempt; replay = $Rep }
    if ($null -ne $Map) { $o['mapping'] = $Map }
    [pscustomobject]$o
  }
  $sha = { param([byte[]]$b) [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
  $shaS = { param([string]$s) & $sha ([System.Text.Encoding]::UTF8.GetBytes($s)) }
  $isInt = { param($v) ($v -is [int] -or $v -is [long]) }
  $repo = 'hakanduyar/software-factory'
  $hexRx = '^[0-9a-f]{64}\z'
  $lock = $null
  try {
    if ($Configuration.Count -ne 2 -or -not $Configuration.ContainsKey('repo') -or -not $Configuration.ContainsKey('markerNamespace') -or
        $Configuration['repo'] -isnot [string] -or $Configuration['repo'] -cne $repo -or
        $Configuration['markerNamespace'] -isnot [string] -or $Configuration['markerNamespace'] -cne 'factory-task') {
      return (& $mk 'REFUSED' 'CONFIG_INVALID')
    }
    $full = [System.IO.Path]::GetFullPath($EventPath)
    if (-not [System.IO.File]::Exists($full)) { return (& $mk 'REFUSED' 'EVENT_MISSING') }
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $snap = & $sha $bytes
    $snapSame = { try { (& $sha ([System.IO.File]::ReadAllBytes($full))) -ceq $snap } catch { $false } }
    $ev = [hashtable]::new([System.StringComparer]::Ordinal)
    $doc = $null
    try {
      $doc = [System.Text.Json.JsonDocument]::Parse([System.Text.UTF8Encoding]::new($false, $true).GetString($bytes))
      if ($doc.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'root' }
      foreach ($p in $doc.RootElement.EnumerateObject()) {
        if ($ev.ContainsKey($p.Name)) { throw 'dup' }
        $vk = $p.Value.ValueKind
        if ($vk -eq [System.Text.Json.JsonValueKind]::String) { $ev[$p.Name] = $p.Value.GetString() }
        elseif ($vk -eq [System.Text.Json.JsonValueKind]::Number) { $ev[$p.Name] = [pscustomobject]@{ raw = $p.Value.GetRawText() } }
        else { throw 'type' }
      }
    } catch { return (& $mk 'REFUSED' 'EVENT_MALFORMED') } finally { if ($null -ne $doc) { $doc.Dispose() } }
    if ($ev.Count -ne 7) { return (& $mk 'REFUSED' 'EVENT_KEYS_INVALID') }
    foreach ($w in @('schema', 'taskId', 'canonicalVersion', 'publicTitle', 'publicSummary', 'publicStatus', 'nextAction')) {
      if (-not $ev.ContainsKey($w)) { return (& $mk 'REFUSED' 'EVENT_KEYS_INVALID') }
    }
    $id = $ev['taskId']; $title = $ev['publicTitle']; $sum = $ev['publicSummary']
    $stt = $ev['publicStatus']; $nxt = $ev['nextAction']; $vr = $ev['canonicalVersion']
    $ver = 0L
    if ($ev['schema'] -isnot [string] -or $ev['schema'] -cne 'GitHubCreateEvent/v1' -or
        $id -isnot [string] -or $id -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z' -or
        $stt -isnot [string] -or $stt -cnotin @('IN_PROGRESS', 'WAITING_FOR_REVIEW', 'BLOCKED', 'ACCEPTED_SCOPED') -or
        $nxt -isnot [string] -or $nxt -cnotin @('RUN_FOCUSED_CHECKS', 'INDEPENDENT_REVIEW', 'RESUME_AUTHORIZED_WORK', 'WAIT_FOR_DEPENDENCY') -or
        $vr -isnot [pscustomobject] -or $vr.raw -cnotmatch '^[1-9][0-9]{0,18}\z' -or -not [long]::TryParse($vr.raw, [ref]$ver)) {
      return (& $mk 'REFUSED' 'EVENT_FIELDS_INVALID')
    }
    $cred = '(?i)sk-[A-Za-z0-9]{8}|ghp|github pat|access token|refresh token|oauth token|bearer|password|secret|api key|(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])|\.factory-data|\b(?:windows|users|home)\b'
    foreach ($t in @(@($title, 1, 160), @($sum, 0, 512))) {
      $c = $null; $v = $t[0]
      if ($v -isnot [string]) { $c = 'PUBLIC_TEXT_TYPE' }
      elseif ($v.Length -lt $t[1] -or $v.Length -gt $t[2]) { $c = 'PUBLIC_TEXT_LENGTH' }
      elseif ($v -cnotmatch '^[\p{L}\p{Nd} .,()\-]*\z' -or $v -cmatch '^ | \z') { $c = 'PUBLIC_TEXT_CHARACTERS' }
      elseif ($v -match $cred) { $c = 'PUBLIC_TEXT_CREDENTIAL_PATTERN' }
      if ($null -ne $c) { return (& $mk 'REFUSED' $c) }
    }
    $tkey = & $shaS $id
    $token = 'factory-task-' + $tkey
    $rendered = '<!-- ' + $token + ' -->'
    $startM = '<!-- factory-task-status:start -->'; $endM = '<!-- factory-task-status:end -->'
    $region = $startM + $nl + 'Task: ' + $id + $nl + 'Version: ' + [string]$ver + $nl + 'Status: ' + $stt + $nl + 'Next action: ' + $nxt + $nl + 'Summary: ' + $sum + $nl + $endM
    $body = $rendered + $nl + $nl + $region
    $pay = & $shaS ($title + $nl + $region)
    $ctx.task = $id
    $ctx.key = & $shaS ($id + '|' + [string]$ver + '|' + $pay)
    $expUrl = { param($n) 'https://github.com/' + $repo + '/issues/' + [string]$n }

    $sd = [System.IO.Path]::GetFullPath($StateDir)
    $stPath = Join-Path $sd 'github-task-lifecycle.state.json'
    [System.IO.Directory]::CreateDirectory($sd) | Out-Null
    try {
      $lock = [System.IO.FileStream]::new((Join-Path $sd 'github-task-lifecycle.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] { return (& $mk 'LOCKED' 'LOCKED') }

    $st = $null
    if ([System.IO.File]::Exists($stPath)) {
      try {
        $st = [System.IO.File]::ReadAllText($stPath) | ConvertFrom-Json -AsHashtable -DateKind String
        if ($st -isnot [hashtable] -or $st.Count -ne 3 -or -not (& $isInt $st['schema']) -or $st['schema'] -ne 1 -or $st['tasks'] -isnot [hashtable] -or $st['events'] -isnot [hashtable]) { throw 'x' }
        foreach ($k in @($st['tasks'].Keys)) {
          $t = $st['tasks'][$k]
          if ($t -isnot [hashtable] -or $t.Count -ne 11) { throw 'x' }
          foreach ($f in @('taskId', 'repo', 'marker', 'snapshotSha', 'payloadDigest', 'canonicalVersion', 'title', 'region', 'phase', 'attempts', 'issueNumber')) { if (-not $t.ContainsKey($f)) { throw 'x' } }
          if ($t['taskId'] -isnot [string] -or $t['taskId'] -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z' -or $k -cne (& $shaS $t['taskId']) -or
              $t['repo'] -cne $repo -or $t['marker'] -cne ('factory-task-' + $k) -or
              $t['snapshotSha'] -isnot [string] -or $t['snapshotSha'] -cnotmatch $hexRx -or
              $t['title'] -isnot [string] -or $t['region'] -isnot [string] -or
              $t['payloadDigest'] -isnot [string] -or $t['payloadDigest'] -cne (& $shaS ($t['title'] + $nl + $t['region'])) -or
              -not (& $isInt $t['canonicalVersion']) -or $t['canonicalVersion'] -lt 1 -or
              $t['phase'] -isnot [string] -or $t['phase'] -cnotin @('CREATE_MAY_HAVE_SENT', 'MAPPED') -or
              -not (& $isInt $t['attempts']) -or $t['attempts'] -lt 0 -or ($t['phase'] -ceq 'CREATE_MAY_HAVE_SENT' -and $t['attempts'] -lt 1)) { throw 'x' }
          $in = $t['issueNumber']
          if ($null -ne $in -and (-not (& $isInt $in) -or $in -lt 1 -or $in -gt 2147483647)) { throw 'x' }
          if ($t['phase'] -ceq 'MAPPED' -and $null -eq $in) { throw 'x' }
        }
        foreach ($k in @($st['events'].Keys)) {
          $e = $st['events'][$k]
          if ($k -cnotmatch $hexRx -or $e -isnot [hashtable] -or $e.Count -ne 5) { throw 'x' }
          foreach ($f in @('taskId', 'canonicalVersion', 'payloadDigest', 'phase', 'attempts')) { if (-not $e.ContainsKey($f)) { throw 'x' } }
          if ($e['taskId'] -isnot [string] -or -not (& $isInt $e['canonicalVersion']) -or $e['payloadDigest'] -isnot [string] -or $e['payloadDigest'] -cnotmatch $hexRx -or
              $e['phase'] -isnot [string] -or $e['phase'] -cnotin @('CREATE_MAY_HAVE_SENT', 'MAPPED') -or -not (& $isInt $e['attempts']) -or $e['attempts'] -lt 0 -or $e['canonicalVersion'] -lt 1 -or $e['taskId'] -cnotmatch '^[A-Za-z0-9._:-]{1,128}\z' -or -not $st['tasks'].ContainsKey((& $shaS $e['taskId']))) { throw 'x' }
          $tk = $st['tasks'][(& $shaS $e['taskId'])]
          if ($k -cne (& $shaS ($e['taskId'] + '|' + [string]$e['canonicalVersion'] + '|' + $e['payloadDigest'])) -or ($e['phase'] -ceq 'CREATE_MAY_HAVE_SENT' -and $e['attempts'] -lt 1) -or $e['attempts'] -gt $tk['attempts'] -or ($e['canonicalVersion'] -eq $tk['canonicalVersion'] -and ($e['payloadDigest'] -cne $tk['payloadDigest'] -or $e['phase'] -cne $tk['phase'] -or $e['attempts'] -ne $tk['attempts'])) -or ($e['canonicalVersion'] -gt $tk['canonicalVersion'] -and $e['phase'] -cne 'CREATE_MAY_HAVE_SENT')) { throw 'x' }
        }
      } catch { return (& $mk 'REFUSED' 'STATE_CORRUPT') }
    } else {
      $st = @{ schema = 1; tasks = @{}; events = @{} }
    }
    $save = {
      $tmp = Join-Path $sd ('github-task-lifecycle.' + [guid]::NewGuid().ToString('N') + '.tmp')
      try {
        [System.IO.File]::WriteAllText($tmp, ($st | ConvertTo-Json -Depth 6 -Compress), [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::Move($tmp, $stPath, $true)
      } finally { if ([System.IO.File]::Exists($tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }
    }
    $setT = {
      param($v, $tt, $rg, $ph, $nm, $a)
      $st['tasks'][$tkey] = @{ taskId = $id; repo = $repo; marker = $token; snapshotSha = $snap; payloadDigest = (& $shaS ($tt + $nl + $rg)); canonicalVersion = [long]$v; title = $tt; region = $rg; phase = $ph; attempts = [long]$a; issueNumber = $nm }
    }
    $setE = {
      param($ph, $a)
      $st['events'][$ctx.key] = @{ taskId = $id; canonicalVersion = $ver; payloadDigest = $pay; phase = $ph; attempts = [long]$a }
    }
    $call = {
      param([string]$op, [hashtable]$rq)
      try { $o = @(& $Transport $op $rq) } catch { return $null }
      if ($o.Count -ne 1 -or $o[0] -isnot [pscustomobject]) { return $null }
      $o[0]
    }
    $rd = {
      param([int]$n)
      $r = & $call 'READ' @{ repo = $repo; issueNumber = $n }
      try {
        if ($null -eq $r -or $r.ok -isnot [bool] -or -not $r.ok) { return @{ code = 'READ_FAILED' } }
        if (-not (& $isInt $r.number) -or $r.number -ne $n -or $r.url -isnot [string] -or $r.url -cne (& $expUrl $n) -or
            $r.title -isnot [string] -or $r.body -isnot [string] -or $r.state -isnot [string]) { return @{ code = 'READ_MISMATCH' } }
        if ($r.state -cne 'OPEN') { return @{ code = 'ISSUE_CLOSED' } }
        return @{ code = 'OK'; title = $r.title; body = $r.body }
      } catch { return @{ code = 'READ_FAILED' } }
    }
    $struct = {
      param([string]$b)
      $lines = $b.Split($nl)
      $m = 0; $mi = -1; $s = -1; $sc = 0; $e = -1; $ec = 0
      for ($i = 0; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]
        if ($l -ceq $rendered) { $m++; $mi = $i } elseif ($l -ceq $startM) { $sc++; $s = $i } elseif ($l -ceq $endM) { $ec++; $e = $i }
      }
      $m -eq 1 -and $sc -eq 1 -and $ec -eq 1 -and $mi -lt $s -and $s -lt $e -and
        $b.IndexOf($token, [System.StringComparison]::Ordinal) -eq $b.LastIndexOf($token, [System.StringComparison]::Ordinal) -and
        $lines[$s + 1] -ceq ('Task: ' + $id)
    }
    $cls = {
      param([string]$ttl, [string]$b, [string]$ct, [string]$cr, $ot, $oreg)
      if ($ttl -ceq $ct -and $b -ceq ($rendered + $nl + $nl + $cr)) { return 'C' }
      if ($null -ne $ot -and $ttl -ceq $ot -and $b -ceq ($rendered + $nl + $nl + $oreg)) { return 'O' }
      if (($ttl -ceq $ct -or ($null -ne $ot -and $ttl -ceq $ot)) -and (& $struct $b)) { return 'S' }
      'X'
    }

    $task = $st['tasks'][$tkey]
    $isNewer = $false; $oT = $null; $oR = $null; $att = 0L
    if ($null -ne $task) {
      $att = [long]$task['attempts']; $ctx.attempt = $att
      if ($ver -lt $task['canonicalVersion']) { return (& $mk 'REFUSED' 'STALE_VERSION') }
      if ($ver -eq $task['canonicalVersion'] -and $pay -cne (& $shaS ($task['title'] + $nl + $task['region']))) { return (& $mk 'REFUSED' 'DIGEST_CONFLICT') }
      if ($ver -gt $task['canonicalVersion']) { $isNewer = $true; $oT = $task['title']; $oR = $task['region'] }
    }
    $mapped = ($null -ne $task -and $task['phase'] -ceq 'MAPPED')
    $num = $null
    if ($mapped) {
      $num = [int]$task['issueNumber']
    } else {
      if (-not (& $snapSame)) { return (& $mk 'REFUSED' 'SNAPSHOT_CHANGED') }
      $f = & $call 'FIND' @{ repo = $repo; stableMarker = $token; renderedMarker = $rendered }
      $fi = $null
      try { if ($null -ne $f -and $f.ok -is [bool] -and $f.ok -and $f.complete -is [bool] -and $f.complete -and $f.issues -is [array]) { $fi = @($f.issues) } } catch { $fi = $null }
      if ($null -eq $fi) { return (& $mk 'REFUSED' 'LOOKUP_INCOMPLETE') }
      if ($fi.Count -gt 1) { return (& $mk 'REFUSED' 'DUPLICATE_MATCH') }
      if ($fi.Count -eq 1) {
        try {
          $x = $fi[0]
          if ((& $isInt $x.number) -and $x.number -ge 1 -and $x.number -le 2147483647 -and $x.url -is [string] -and $x.url -ceq (& $expUrl $x.number)) { $num = [int]$x.number }
        } catch { $num = $null }
        if ($null -eq $num) { return (& $mk 'REFUSED' 'LOOKUP_INVALID') }
      } elseif ($null -ne $task) {
        return (& $mk 'REFUSED' 'AMBIGUOUS_NO_MATCH')
      }
    }

    if ($null -eq $num) {
      if (-not (& $snapSame)) { return (& $mk 'REFUSED' 'SNAPSHOT_CHANGED') }
      & $setT $ver $title $region 'CREATE_MAY_HAVE_SENT' $null 1
      & $setE 'CREATE_MAY_HAVE_SENT' 1
      $ctx.attempt = 1
      & $save
      try {
        $cr = & $call 'CREATE' @{ repo = $repo; title = $title; body = $body }
        $n = $null
        try { if ($null -ne $cr -and $cr.ok -is [bool] -and $cr.ok -and (& $isInt $cr.number) -and $cr.number -ge 1 -and $cr.number -le 2147483647 -and $cr.url -is [string] -and $cr.url -ceq (& $expUrl $cr.number)) { $n = [int]$cr.number } } catch { $n = $null }
        if ($null -eq $n) { return (& $mk 'UNKNOWN_SEND' 'CREATE_INVALID_RESPONSE') }
        $rr = & $rd $n
        if ($rr['code'] -cne 'OK' -or (& $cls $rr['title'] $rr['body'] $title $region $null $null) -cne 'C') { return (& $mk 'UNKNOWN_SEND' 'CREATE_READBACK_FAILED') }
        if (-not (& $snapSame)) { return (& $mk 'UNKNOWN_SEND' 'SNAPSHOT_CHANGED') }; & $setT $ver $title $region 'MAPPED' $n 1
        & $setE 'MAPPED' 1
        & $save
        return (& $mk 'MAPPED' 'CREATED' @{ taskId = $id; repo = $repo; issueNumber = $n; stableMarker = $token })
      } catch { return (& $mk 'UNKNOWN_SEND' 'CREATE_AMBIGUOUS') }
    }

    $rr = & $rd $num
    if ($rr['code'] -cne 'OK') { return (& $mk 'REFUSED' $rr['code']) }
    $k = & $cls $rr['title'] $rr['body'] $title $region $oT $oR; if (-not (& $snapSame)) { return (& $mk 'REFUSED' 'SNAPSHOT_CHANGED') }
    $map = @{ taskId = $id; repo = $repo; issueNumber = $num; stableMarker = $token }
    if ($mapped) {
      if ($k -ceq 'C') {
        if ($isNewer) {
          & $setT $ver $title $region 'MAPPED' $num $att
          & $setE 'MAPPED' $att
          & $save
          return (& $mk 'MAPPED' 'VERSION_ADVANCED' $map)
        }
        return (& $mk 'MAPPED' 'REPLAY' $map $true)
      }
      if ($k -ceq 'O' -or $k -ceq 'S') { return (& $mk 'MAPPED_NEEDS_UPDATE' 'NEEDS_UPDATE' $map) }
      return (& $mk 'REFUSED' 'READ_MISMATCH')
    }
    if ($k -ceq 'C') {
      & $setT $ver $title $region 'MAPPED' $num $att
      & $setE 'MAPPED' $att
      & $save
      return (& $mk 'MAPPED' 'ADOPTED' $map)
    }
    if ($k -ceq 'O') {
      & $setT $task['canonicalVersion'] $oT $oR 'MAPPED' $num $att
      & $setE 'CREATE_MAY_HAVE_SENT' $att
      & $save
      return (& $mk 'MAPPED_NEEDS_UPDATE' 'ADOPTED_NEEDS_UPDATE' $map)
    }
    return (& $mk 'REFUSED' 'READ_MISMATCH')
  } catch {
    return (& $mk 'REFUSED' 'UNEXPECTED_FAILURE')
  } finally {
    if ($null -ne $lock) { $lock.Dispose() }
  }
}
