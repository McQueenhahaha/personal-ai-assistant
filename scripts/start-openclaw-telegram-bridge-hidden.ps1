$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
$BridgeScript = Join-Path $Root "src\openclaw-telegram-bridge.mjs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -and
    (
      $_.CommandLine -match [regex]::Escape($BridgeScript) -or
      $_.CommandLine -match "openclaw-telegram-bridge\.mjs"
    )
  } |
  Select-Object -First 1

if ($existing) {
  Write-Host "OpenClaw Telegram bridge is already running."
  return
}

$LogFile = Join-Path $LogDir "openclaw-telegram-bridge.log"
$ErrFile = Join-Path $LogDir "openclaw-telegram-bridge.err.log"
$RunScript = Join-Path $PSScriptRoot "run-openclaw-telegram-bridge.ps1"

Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"cd '$Root'; & '$RunScript' *> '$LogFile' 2> '$ErrFile'`"" `
  -WindowStyle Hidden

Write-Host "OpenClaw Telegram bridge start requested."
