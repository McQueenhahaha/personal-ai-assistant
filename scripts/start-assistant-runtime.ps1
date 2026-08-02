$ErrorActionPreference = "Continue"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
$RunningFlag = Join-Path $Root "data\assistant-running.flag"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RunningFlag) | Out-Null
"started $(Get-Date -Format o)" | Set-Content -Path $RunningFlag -Encoding UTF8

Write-Host "Starting personal AI assistant runtime..."

try {
  & "$PSScriptRoot\start-ollama-hidden.ps1" *> (Join-Path $LogDir "start-ollama.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "start-ollama.err.log") -Append
}

try {
  & "$PSScriptRoot\start-local-queue-loop-hidden.ps1" *> (Join-Path $LogDir "start-local-queue-loop.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "start-local-queue-loop.err.log") -Append
}

# OpenClaw gateway 已退休（2026-08-02）。不要恢复这段启动。
# 原因：gateway 的 .openclaw/openclaw.json 里 channels.telegram 用的是与 .env
# 完全相同的 bot token。Telegram getUpdates 是单消费者语义 —— gateway 与
# src/openclaw-telegram-bridge.mjs 同时轮询时，消息会被随机一方吞掉且不留痕迹
# （表现为"发了命令助手不回"）。两者还会互相覆盖 setMyCommands 的命令菜单。
# 桥现在以 TELEGRAM_DIRECT_MODE=true 直连，不需要 gateway。
# try {
#   & "$PSScriptRoot\start-openclaw-gateway-hidden.ps1" *> (Join-Path $LogDir "start-openclaw.log")
# } catch {
#   $_ | Out-File -FilePath (Join-Path $LogDir "start-openclaw.err.log") -Append
# }

try {
  & "$PSScriptRoot\start-openclaw-telegram-bridge-hidden.ps1" *> (Join-Path $LogDir "start-openclaw-telegram-bridge.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "start-openclaw-telegram-bridge.err.log") -Append
}

try {
  & "$PSScriptRoot\start-codex-auto-worker-hidden.ps1" *> (Join-Path $LogDir "start-codex-auto-worker.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "start-codex-auto-worker.err.log") -Append
}

# P5.5 游走大脑：必须启动，否则 Windows 回来不会自动收回大脑，
# "Windows 挂了 Mac 接管" 这条 HA 路径也是关着的（2026-08-02 前一直漏挂）。
# 放在桥之后启动：supervisor 的 ensureBrainServices 会确保桥在跑，先后顺序不冲突。
# start-brain-supervisor-hidden.ps1 自带 "already running" 守卫，可重复调用。
try {
  & "$PSScriptRoot\start-brain-supervisor-hidden.ps1" *> (Join-Path $LogDir "start-brain-supervisor.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "start-brain-supervisor.err.log") -Append
}

try {
  & "$PSScriptRoot\run-local-queue.ps1" *> (Join-Path $LogDir "run-local-queue-on-start.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "run-local-queue-on-start.err.log") -Append
}

Write-Host "Personal AI assistant runtime start requested."
