$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$DataDir = Join-Path $Root "data"
$LogDir = Join-Path $DataDir "logs"
$DesiredFlag = Join-Path $DataDir "assistant-desired-running.flag"
$CatchupFlag = Join-Path $DataDir "school-game-catchup-needed.flag"
$manualArgs = @("--force-school", "--school", "--force-game", "--game", "--force-personal", "--personal", "--mail", "--check-only")
$manualRun = $false
foreach ($arg in $args) {
  if ($manualArgs -contains $arg) {
    $manualRun = $true
    break
  }
}

# 定时检查只在【当前持有大脑的那台机器】上运行。
#
# 为什么必须这样（2026-08-03 实测的真实故障）：
# school-check-state.json 在灵魂包清单里。当大脑在另一台时，本机是待命节点，
# supervisor 每约 35 秒 pullSoul 一次、用对端副本覆盖本地状态。
# 而定时检查若仍在本机运行，它刚存下的去重状态(seenGameKeys / lastDigestKey)
# 会在几十秒内被冲掉 —— 于是每次运行都判定为"首次发送"，
# 同一批游戏资讯每 5 分钟重发一次。用户实际被这样刷屏过。
#
# 手动触发(带 --force-* 等参数)不受此限制：那是用户明确要求的一次性动作。
# 没有租约文件时视为单机模式，照常运行。
if (-not $manualRun) {
  $LeaseFile = Join-Path $DataDir "state/brain-lease.json"
  if (Test-Path -LiteralPath $LeaseFile) {
    $SelfId = "windows"
    if ($env:BRAIN_NODE_ID) { $SelfId = $env:BRAIN_NODE_ID }
    $Holder = ""
    try {
      $Holder = (Get-Content -Raw -LiteralPath $LeaseFile | ConvertFrom-Json).holder
    } catch {
      $Holder = ""
    }
    if ($Holder -and ($Holder -ne $SelfId)) {
      New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
      $msg = "[" + (Get-Date -Format o) + "] Skipped: brain is on '" + $Holder + "', not this node ('" + $SelfId + "')."
      $msg | Out-File -FilePath (Join-Path $LogDir "school-check-skipped-not-brain.log") -Append -Encoding UTF8
      exit 0
    }
  }
}

if ((-not $manualRun) -and (-not (Test-Path -LiteralPath $DesiredFlag))) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  "[$(Get-Date -Format o)] Skipped scheduled check because assistant is not marked as desired-running." |
    Out-File -FilePath (Join-Path $LogDir "school-check-skipped-not-running.log") -Append -Encoding UTF8
  exit 0
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

if ((-not ($args -contains "--ignore-game-mode")) -and (Test-GameRunning)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  @(
    "missedAt=$((Get-Date).ToString('o'))",
    "reason=Tarkov running",
    "action=force school, personal mail, and game news after game closes"
  ) | Set-Content -LiteralPath $CatchupFlag -Encoding UTF8
  "[$(Get-Date -Format o)] Skipped school/game/mail check because Tarkov is running." |
    Out-File -FilePath (Join-Path $LogDir "school-check-skipped-for-game.log") -Append -Encoding UTF8
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is not available. Run scripts\install-prereqs.ps1, restart PowerShell, then try again."
}

$nodeArgs = @($args)
if ((-not $manualRun) -and (Test-Path -LiteralPath $CatchupFlag)) {
  "[$(Get-Date -Format o)] Running catch-up check after a game-mode skip." |
    Out-File -FilePath (Join-Path $LogDir "school-check-catchup.log") -Append -Encoding UTF8
  $nodeArgs += @("--force-school", "--force-personal", "--force-game")
}

& node .\src\school-check.mjs @nodeArgs
$exitCode = $LASTEXITCODE
if ($exitCode -eq 0 -and (Test-Path -LiteralPath $CatchupFlag)) {
  Remove-Item -LiteralPath $CatchupFlag -Force
}
exit $exitCode
