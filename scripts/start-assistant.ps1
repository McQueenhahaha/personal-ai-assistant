$ErrorActionPreference = "Continue"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root "data"
$LogDir = Join-Path $DataDir "logs"
$DesiredFlag = Join-Path $DataDir "assistant-desired-running.flag"
$WatcherScript = Join-Path $PSScriptRoot "watch-game-mode.ps1"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
"desired $(Get-Date -Format o)" | Set-Content -Path $DesiredFlag -Encoding UTF8

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

Write-Host "Starting personal AI assistant..."

try {
  & "$PSScriptRoot\cleanup-assistant-data.ps1" *> (Join-Path $LogDir "cleanup-on-start.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "cleanup-on-start.err.log") -Append
}

$existingWatcher = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "powershell.exe" -and
    $_.CommandLine -and
    $_.CommandLine -match [regex]::Escape($WatcherScript)
  } |
  Select-Object -First 1

if (-not $existingWatcher) {
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatcherScript`"" `
    -WindowStyle Hidden
}

if (Test-GameRunning) {
  "suspended $(Get-Date -Format o)" | Set-Content -Path (Join-Path $DataDir "assistant-suspended-for-game.flag") -Encoding UTF8
  Write-Host "Tarkov is running. Assistant will stay suspended and resume after the game closes."
} else {
  & "$PSScriptRoot\start-assistant-runtime.ps1"
}

Write-Host "Personal AI assistant start requested."
