$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$LoopScript = Join-Path $PSScriptRoot "run-codex-auto-worker-loop.ps1"

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "powershell.exe" -and
    $_.CommandLine -and
    $_.CommandLine -match [regex]::Escape($LoopScript)
  } |
  Select-Object -First 1

if ($existing) {
  Write-Host "Codex auto worker loop is already running."
  return
}

Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LoopScript`"" `
  -WindowStyle Hidden

Write-Host "Codex auto worker loop start requested."
