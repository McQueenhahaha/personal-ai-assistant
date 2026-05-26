$ErrorActionPreference = "Continue"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$pollSeconds = 60
$envFile = Join-Path $Root ".env"
if (Test-Path -Path $envFile) {
  $match = Select-String -Path $envFile -Pattern '^QUEUE_POLL_SECONDS=(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($match -and $match.Matches[0].Groups[1].Value) {
    $pollSeconds = [int]$match.Matches[0].Groups[1].Value
  }
}

while ($true) {
  try {
    & "$PSScriptRoot\run-local-queue.ps1" *> (Join-Path $LogDir "local-queue-loop.log")
  } catch {
    $_ | Out-File -FilePath (Join-Path $LogDir "local-queue-loop.err.log") -Append
  }

  Start-Sleep -Seconds $pollSeconds
}
