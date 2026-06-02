# Watchdog tick for autoresearch mission `cortex-roundtrip-omo-omc`.
#
# Invoked by the Windows Scheduled Task `Cortex Autoresearch Watchdog`.
# Runs one iteration of the autoresearch runner, tees output to a per-tick
# log, and edge-triggers a webhook notification when a failure streak crosses
# the alert threshold. A recovery notification fires once the streak ends.
#
# Manual invocation:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/autoresearch/watchdog-tick.ps1
#
# Synthetic alert (does not run an iteration, does not touch notification-state.json):
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/autoresearch/watchdog-tick.ps1 -TestAlert
#
# Reset alerting state (clears consecutive_fails / alert_fired_for_streak):
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/autoresearch/watchdog-tick.ps1 -ResetAlertState
#
# Notification channels (configure either or both via .env):
#   CORTEX_AR_DISCORD_WEBHOOK=https://discord.com/api/webhooks/.../...
#   CORTEX_AR_SLACK_WEBHOOK=https://hooks.slack.com/services/.../...
#   CORTEX_AR_ALERT_THRESHOLD=2          # consecutive fails before alerting (default 2)
# If neither webhook is set, alerting is dormant; tick still runs.
#
# Exit code is propagated from the runner (0 = iteration passed, 1 = failed).

param(
  [switch]$TestAlert,
  [switch]$ResetAlertState
)

$ErrorActionPreference = 'Continue'

$workdir = 'D:\Dev Work (SSD)\cortex'
Set-Location -LiteralPath $workdir

# ── Load .env into process env (scheduled tasks don't inherit shell env) ──
if (Test-Path .env) {
  Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$') {
      $k = $Matches[1]
      $v = $Matches[2].Trim().Trim('"').Trim("'")
      if (-not [Environment]::GetEnvironmentVariable($k, 'Process')) {
        [Environment]::SetEnvironmentVariable($k, $v, 'Process')
      }
    }
  }
}

$missionDir = Join-Path $workdir '.omc/autoresearch/cortex-roundtrip-omo-omc'
$logDir = Join-Path $missionDir 'watchdog-logs'
$null = New-Item -ItemType Directory -Force -Path $logDir
$ts = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss\Z')
$log = Join-Path $logDir "tick-$ts.log"
$statePath = Join-Path $missionDir 'state.json'
$notifPath = Join-Path $missionDir 'notification-state.json'

$alertThreshold = if ($env:CORTEX_AR_ALERT_THRESHOLD) { [int]$env:CORTEX_AR_ALERT_THRESHOLD } else { 2 }

# ── Reset mode ─────────────────────────────────────────────────────────
if ($ResetAlertState) {
  if (Test-Path $notifPath) { Remove-Item $notifPath -Force }
  Write-Host "[notify] alerting state reset; consecutive_fails=0"
  exit 0
}

# ── Notification helpers ──────────────────────────────────────────────
function Send-DiscordAlert {
  param([string]$Title, [string]$Body, [int]$Color = 15158332)
  $url = $env:CORTEX_AR_DISCORD_WEBHOOK
  if (-not $url) { return $false }
  try {
    $payload = @{
      username = 'cortex-roundtrip watchdog'
      embeds = @(@{
        title = $Title
        description = $Body
        color = $Color
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
      })
    } | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 10 | Out-Null
    return $true
  } catch {
    Write-Host "[notify] Discord post failed: $($_.Exception.Message)"
    return $false
  }
}

function Send-SlackAlert {
  param([string]$Title, [string]$Body)
  $url = $env:CORTEX_AR_SLACK_WEBHOOK
  if (-not $url) { return $false }
  try {
    $payload = @{ text = "*$Title*`n$Body" } | ConvertTo-Json -Depth 4 -Compress
    Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 10 | Out-Null
    return $true
  } catch {
    Write-Host "[notify] Slack post failed: $($_.Exception.Message)"
    return $false
  }
}

function Send-Alert {
  param([string]$Title, [string]$Body, [int]$Color = 15158332)
  $sent = @()
  if (Send-DiscordAlert -Title $Title -Body $Body -Color $Color) { $sent += 'discord' }
  if (Send-SlackAlert   -Title $Title -Body $Body)               { $sent += 'slack'   }
  if ($sent.Count -eq 0) {
    Write-Host "[notify] no webhook configured; alert suppressed (would have fired: $Title)"
  } else {
    Write-Host "[notify] sent: $($sent -join ', ')  ::  $Title"
  }
}

# ── Synthetic alert ──────────────────────────────────────────────────
if ($TestAlert) {
  Send-Alert -Title '[TEST] cortex-roundtrip watchdog alert' `
             -Body "Synthetic alert from watchdog-tick.ps1 -TestAlert at $((Get-Date).ToUniversalTime().ToString('o')). No iteration was run; notification-state.json untouched." `
             -Color 3447003
  exit 0
}

# ── Notification state I/O ────────────────────────────────────────────
function Read-NotifState {
  if (Test-Path $notifPath) {
    try { return Get-Content $notifPath -Raw | ConvertFrom-Json } catch { }
  }
  return [PSCustomObject]@{
    consecutive_fails = 0
    alert_fired_for_streak = $false
    streak_started_at = $null
    last_alert_iteration = $null
    last_alert_at = $null
    last_recovery_at = $null
    alert_threshold = $alertThreshold
  }
}

function Write-NotifState {
  param($n)
  $n | ConvertTo-Json -Depth 4 | Set-Content -Path $notifPath -Encoding utf8 -NoNewline
}

# ── Run one iteration via the runner ─────────────────────────────────
$env:CORTEX_AR_CEILING = 'watchdog-30m'

$node = (Get-Command node -ErrorAction Stop).Source
$tsx = Join-Path $workdir 'node_modules/tsx/dist/cli.mjs'
$runner = Join-Path $workdir 'scripts/autoresearch/run-iteration.ts'

"=== watchdog tick $ts ===" | Tee-Object -FilePath $log
& $node $tsx $runner *>&1 | Tee-Object -FilePath $log -Append
$exit = $LASTEXITCODE
"=== exit $exit ===" | Tee-Object -FilePath $log -Append

# ── Read state, update notification-state, possibly alert ───────────
if (-not (Test-Path $statePath)) {
  Write-Host "[notify] state.json missing; skipping alerting"
  exit $exit
}

try {
  $state = Get-Content $statePath -Raw | ConvertFrom-Json
} catch {
  Write-Host "[notify] state.json parse failed: $($_.Exception.Message)"
  exit $exit
}

$notif = Read-NotifState
$currentPass = [bool]$state.last_pass
$currentIter = "iteration-$(([int]$state.iteration_count).ToString('0000'))"
$nowIso = (Get-Date).ToUniversalTime().ToString('o')

if ($currentPass) {
  # Recovery transition?
  if ($notif.alert_fired_for_streak) {
    $streakLen = [int]$notif.consecutive_fails
    $streakStart = $notif.streak_started_at
    $title = "[RESOLVED] cortex-roundtrip watchdog recovered at $currentIter"
    $body = @"
Streak of $streakLen consecutive failures has ended.
Streak started: $streakStart
Recovery iteration: $currentIter  score=$($state.last_score)
"@
    Send-Alert -Title $title -Body $body -Color 3066993  # green
    $notif.last_recovery_at = $nowIso
  }
  $notif.consecutive_fails = 0
  $notif.alert_fired_for_streak = $false
  $notif.streak_started_at = $null
} else {
  $notif.consecutive_fails = [int]$notif.consecutive_fails + 1
  if (-not $notif.streak_started_at) { $notif.streak_started_at = $nowIso }

  if ($notif.consecutive_fails -ge $alertThreshold -and -not $notif.alert_fired_for_streak) {
    # Edge-trigger: streak just crossed threshold
    $runId = $state.current_run_id
    $evalRel = ".omc/autoresearch/cortex-roundtrip-omo-omc/runs/$runId/evaluations/$currentIter.json"
    $evalAbs = Join-Path $workdir $evalRel

    $errSummary = '(evaluation file not parseable)'
    if (Test-Path $evalAbs) {
      try {
        $eval = Get-Content $evalAbs -Raw | ConvertFrom-Json
        $te = $eval.measured.total_errors
        $tc = $eval.measured.total_calls
        $rp = $eval.measured.recall_p95_ms
        $ip = $eval.measured.ingest_p95_ms
        $firstErrs = if ($eval.errors.Count -gt 0) {
          ($eval.errors | Select-Object -First 3 | ForEach-Object {
            $msg = if ($_.message) { $_.message.Substring(0,[Math]::Min(160,$_.message.Length)) } else { '' }
            "$($_.call): $msg"
          }) -join "`n"
        } else { '(zero recorded errors - failure was threshold-driven, not error-driven)' }
        $errSummary = "errors=$te/$tc, recall_p95=${rp}ms, ingest_p95=${ip}ms`n`nFirst failures:`n$firstErrs"
      } catch { }
    }

    $title = "[FAIL] cortex-roundtrip watchdog $($notif.consecutive_fails) consecutive fails (threshold $alertThreshold)"
    $body = @"
Streak length: $($notif.consecutive_fails)
Streak started: $($notif.streak_started_at)
Current iteration: $currentIter  score=$($state.last_score)
Run: $($state.current_run_id)
Tick log: $log
Evaluation: $evalRel

$errSummary
"@
    Send-Alert -Title $title -Body $body
    $notif.alert_fired_for_streak = $true
    $notif.last_alert_iteration = $currentIter
    $notif.last_alert_at = $nowIso
  } else {
    Write-Host "[notify] fail recorded (consecutive=$($notif.consecutive_fails) threshold=$alertThreshold); alert suppressed"
  }
}

$notif.alert_threshold = $alertThreshold
Write-NotifState $notif

exit $exit