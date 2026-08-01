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

function Initialize-LogFile {
  param(
    [string]$Path,
    [string]$StartMarker
  )

  if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -gt 5MB) {
    $RotatedPath = Join-Path `
      (Split-Path -Parent $Path) `
      ("{0}.1{1}" -f [System.IO.Path]::GetFileNameWithoutExtension($Path), [System.IO.Path]::GetExtension($Path))
    if (Test-Path -LiteralPath $RotatedPath) {
      Remove-Item -LiteralPath $RotatedPath -Force
    }
    Move-Item -LiteralPath $Path -Destination $RotatedPath
  }

  Add-Content -LiteralPath $Path -Value $StartMarker -Encoding utf8
}

$StartedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$StartMarker = "===== gateway start $StartedAt ====="
Initialize-LogFile -Path $LogFile -StartMarker $StartMarker
Initialize-LogFile -Path $ErrFile -StartMarker $StartMarker

Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"cd '$Root'; . '.\scripts\openclaw-env.ps1'; openclaw gateway *>> '$LogFile' 2>> '$ErrFile'`"" `
  -WindowStyle Hidden

Write-Host "OpenClaw gateway start requested."
