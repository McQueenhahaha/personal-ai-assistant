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

try {
  & "$PSScriptRoot\start-openclaw-gateway-hidden.ps1" *> (Join-Path $LogDir "start-openclaw.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "start-openclaw.err.log") -Append
}

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

try {
  & "$PSScriptRoot\run-local-queue.ps1" *> (Join-Path $LogDir "run-local-queue-on-start.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "run-local-queue-on-start.err.log") -Append
}

Write-Host "Personal AI assistant runtime start requested."
