$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"
Import-Module "$PSScriptRoot\bridge-keepalive.psm1" -Force

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
$KeepaliveLog = Join-Path $LogDir "brain-supervisor-keepalive.log"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $Root

$backoffSeconds = 2
while ($true) {
  $startedAt = [DateTimeOffset]::UtcNow
  & node .\src\brain\supervisor.mjs @args
  $exitCode = $LASTEXITCODE
  $ranSeconds = ([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds
  $restart = Get-BridgeRestartState `
    -CurrentBackoffSeconds $backoffSeconds `
    -RanSeconds $ranSeconds `
    -ExitCode $exitCode
  $backoffSeconds = $restart.NextBackoffSeconds

  $entry = [PSCustomObject]@{
    at = [DateTimeOffset]::UtcNow.ToString("o")
    exitCode = $exitCode
    waitSeconds = $restart.WaitSeconds
  } | ConvertTo-Json -Compress
  [System.IO.File]::AppendAllText($KeepaliveLog, "$entry`r`n", $Utf8NoBom)

  Start-Sleep -Seconds $restart.WaitSeconds
}
