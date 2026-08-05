$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$WatcherScript = Join-Path $PSScriptRoot "watch-game-mode.ps1"

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "powershell.exe" -and
    $_.CommandLine -and
    $_.CommandLine -match [regex]::Escape($WatcherScript)
  } |
  Select-Object -First 1

if ($existing) {
  Write-Host "Game mode watcher is already running."
  return
}

Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatcherScript`"" `
  -WindowStyle Hidden

Write-Host "Game mode watcher start requested."
