$ErrorActionPreference = "Continue"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
$RunningFlag = Join-Path $Root "data\assistant-running.flag"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$pollSeconds = 20
$envFile = Join-Path $Root ".env"
if (Test-Path -Path $envFile) {
  $match = Select-String -Path $envFile -Pattern '^CODEX_QUEUE_MONITOR_POLL_SECONDS=(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($match -and $match.Matches[0].Groups[1].Value) {
    $pollSeconds = [int]$match.Matches[0].Groups[1].Value
  }
}

while ($true) {
  if (-not (Test-Path -LiteralPath $RunningFlag)) {
    break
  }

  try {
    $timestamp = Get-Date -Format o
    $output = & "$PSScriptRoot\run-codex-queue-monitor.ps1" 2>&1
    foreach ($line in $output) {
      [System.IO.File]::AppendAllText(
        (Join-Path $LogDir "codex-queue-monitor-loop.log"),
        "[$timestamp] $line`r`n",
        $Utf8NoBom
      )
    }
  } catch {
    $_ | Out-File -FilePath (Join-Path $LogDir "codex-queue-monitor-loop.err.log") -Append
  }

  Start-Sleep -Seconds $pollSeconds
}
