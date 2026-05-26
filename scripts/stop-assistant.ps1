$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
$DataDir = Join-Path $Root "data"
$RunningFlag = Join-Path $Root "data\assistant-running.flag"
$DesiredFlag = Join-Path $DataDir "assistant-desired-running.flag"
$SuspendedFlag = Join-Path $DataDir "assistant-suspended-for-game.flag"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "Stopping personal AI assistant..."

foreach ($flag in @($DesiredFlag, $SuspendedFlag)) {
  if (Test-Path -LiteralPath $flag) {
    Remove-Item -LiteralPath $flag -Force
  }
}

if (Test-Path -LiteralPath $RunningFlag) {
  Remove-Item -LiteralPath $RunningFlag -Force
}

try {
  & "$PSScriptRoot\stop-assistant-runtime.ps1" *> (Join-Path $LogDir "stop-runtime-from-stop.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "stop-runtime-from-stop.err.log") -Append
}

$patterns = @("watch-game-mode.ps1")

$currentPid = $PID

$processes = Get-CimInstance Win32_Process |
  Where-Object {
    if ($_.ProcessId -eq $currentPid) { return $false }
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

Write-Host "Personal AI assistant stopped."
