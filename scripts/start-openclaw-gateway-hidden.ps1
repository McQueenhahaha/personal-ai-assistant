$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
  throw "OpenClaw is not installed."
}

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -and
    $_.CommandLine -match "openclaw.mjs" -and
    $_.CommandLine -match "gateway"
  } |
  Select-Object -First 1

if ($existing) {
  Write-Host "OpenClaw gateway appears to be running."
  return
}

$LogFile = Join-Path $LogDir "openclaw-gateway.log"
$ErrFile = Join-Path $LogDir "openclaw-gateway.err.log"

Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"cd '$Root'; . '.\scripts\openclaw-env.ps1'; openclaw gateway *> '$LogFile' 2> '$ErrFile'`"" `
  -WindowStyle Hidden

Write-Host "OpenClaw gateway start requested."
