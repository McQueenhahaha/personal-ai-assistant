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

# 定时工作只在【持有大脑租约的那台机器】上运行。规则对称：无论大脑在 Windows
# 还是 Mac，非持有方都不该跑 —— 否则它写下的去重状态会被灵魂包同步用对端副本冲掉，
# 导致每次运行都判"首次发送"，同一批内容反复推送（2026-08-03 实测的刷屏故障）。
# 判定逻辑集中在 src/state/brain-guard.mjs，两个平台共用一份实现。
# 手动触发不受此限制：那是用户明确要求的一次性动作。
if (-not $manualRun) {
  & node .\src\state\brain-guard.mjs | Out-Null
  if ($LASTEXITCODE -ne 0) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $msg = "[" + (Get-Date -Format o) + "] Skipped: this node does not hold the brain lease."
    $msg | Out-File -FilePath (Join-Path $LogDir "school-check-skipped-not-brain.log") -Append -Encoding UTF8
    exit 0
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
