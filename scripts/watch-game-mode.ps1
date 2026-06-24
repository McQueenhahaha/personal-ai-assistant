$ErrorActionPreference = "Continue"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root "data"
$LogDir = Join-Path $DataDir "logs"
$DesiredFlag = Join-Path $DataDir "assistant-desired-running.flag"
$RunningFlag = Join-Path $DataDir "assistant-running.flag"
$SuspendedFlag = Join-Path $DataDir "assistant-suspended-for-game.flag"
$CodexWorkerLock = Join-Path $DataDir "state\codex-auto-worker.lock"
$LogFile = Join-Path $LogDir "game-mode-watch.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-WatchLog {
  param([string]$Message)
  "[$(Get-Date -Format o)] $Message" | Out-File -FilePath $LogFile -Append -Encoding UTF8
}

function Get-GameProcessNames {
  $raw = $env:GAME_MODE_PROCESS_NAMES
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $raw = "EscapeFromTarkov,EscapeFromTarkov_BE"
  }

  return $raw -split "," |
    ForEach-Object { $_.Trim() -replace "\.exe$", "" } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
}

function Test-GameRunning {
  foreach ($name in Get-GameProcessNames) {
    if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
      return $true
    }
  }
  return $false
}

$interval = 15
if ($env:GAME_MODE_CHECK_SECONDS -match "^\d+$") {
  $interval = [Math]::Max(5, [int]$env:GAME_MODE_CHECK_SECONDS)
}

$maxWaitMinutes = 10
if (-not [string]::IsNullOrWhiteSpace($env:GAME_MODE_MAX_WAIT_MINUTES)) {
  try {
    $maxWaitMinutes = [Math]::Max(0, [int]$env:GAME_MODE_MAX_WAIT_MINUTES)
  } catch {
    $maxWaitMinutes = 10
  }
}

$gameWaitStartedAt = $null

Write-WatchLog "Game mode watcher started. Processes: $((Get-GameProcessNames) -join ', '); interval: ${interval}s"

while (Test-Path -LiteralPath $DesiredFlag) {
  $gameRunning = Test-GameRunning
  $isSuspended = Test-Path -LiteralPath $SuspendedFlag

  if (-not $gameRunning) {
    $gameWaitStartedAt = $null
  }

  if ($gameRunning -and -not $isSuspended) {
    if ($null -eq $gameWaitStartedAt) {
      $gameWaitStartedAt = Get-Date
    }

    $codexTaskRunning = Test-Path -LiteralPath $CodexWorkerLock
    $waitTimedOut = $false
    if ($maxWaitMinutes -le 0) {
      $waitTimedOut = $true
    } else {
      $waitTimedOut = ((Get-Date) - $gameWaitStartedAt).TotalMinutes -ge $maxWaitMinutes
    }

    if ($codexTaskRunning -and -not $waitTimedOut) {
      Write-WatchLog "检测到游戏，等待当前 Codex 任务完成后再挂起…"
    } else {
      "suspended $(Get-Date -Format o)" | Set-Content -Path $SuspendedFlag -Encoding UTF8
      Write-WatchLog "检测到游戏，挂起助手运行时。"
      try {
        & "$PSScriptRoot\stop-assistant-runtime.ps1" *> (Join-Path $LogDir "game-mode-stop-runtime.log")
      } catch {
        $_ | Out-File -FilePath (Join-Path $LogDir "game-mode-stop-runtime.err.log") -Append
      }
    }
  }

  if ((-not $gameRunning) -and $isSuspended) {
    Remove-Item -LiteralPath $SuspendedFlag -Force -ErrorAction SilentlyContinue
    Write-WatchLog "Tarkov closed. Resuming assistant runtime."
    try {
      & "$PSScriptRoot\start-assistant-runtime.ps1" *> (Join-Path $LogDir "game-mode-start-runtime.log")
    } catch {
      $_ | Out-File -FilePath (Join-Path $LogDir "game-mode-start-runtime.err.log") -Append
    }
  }

  Start-Sleep -Seconds $interval
}

Remove-Item -LiteralPath $SuspendedFlag -Force -ErrorAction SilentlyContinue
Write-WatchLog "Game mode watcher stopped because desired-running flag is missing."
