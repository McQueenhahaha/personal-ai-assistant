$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
$RunningFlag = Join-Path $Root "data\assistant-running.flag"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "Stopping personal AI assistant runtime..."

if (Test-Path -LiteralPath $RunningFlag) {
  Remove-Item -LiteralPath $RunningFlag -Force
}

$patterns = @(
  "run-local-queue-loop.ps1",
  "run-codex-auto-worker-loop.ps1",
  "openclaw-telegram-bridge.mjs",
  "openclaw.mjs gateway",
  "ollama.exe runner",
  "ollama.exe serve",
  "ollama app.exe"
)

$currentPid = $PID

$processes = Get-CimInstance Win32_Process |
  Where-Object {
    if ($_.ProcessId -eq $currentPid) { return $false }
    if ($_.ExecutablePath -and $_.ExecutablePath -like "D:\AI\Ollama\ollama*.exe") { return $true }
    if ($_.ExecutablePath -and $_.ExecutablePath -like "D:\AI\npm-global\*") { return $true }
    $cmd = $_.CommandLine
    if (-not $cmd) { return $false }
    foreach ($pattern in $patterns) {
      if ($cmd -match [regex]::Escape($pattern)) { return $true }
    }
    return $false
  }

foreach ($process in $processes) {
  try {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    "Stopped $($process.Name) $($process.ProcessId): $($process.CommandLine)" |
      Out-File -FilePath (Join-Path $LogDir "stop-assistant.log") -Append
  } catch {
    $_ | Out-File -FilePath (Join-Path $LogDir "stop-assistant.err.log") -Append
  }
}

Write-Host "Personal AI assistant runtime stopped."
