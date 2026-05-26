param(
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"

$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($current)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $Elevated) {
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated" `
    -Verb RunAs
  return
}

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

try {
  & "$PSScriptRoot\stop-assistant-runtime.ps1" *> (Join-Path $LogDir "start-codex-admin-prestop.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "start-codex-admin-prestop.err.log") -Append -Encoding UTF8
}

try {
  & "$PSScriptRoot\start-assistant.ps1" *> (Join-Path $LogDir "start-assistant-admin.log")
} catch {
  $_ | Out-File -FilePath (Join-Path $LogDir "start-assistant-admin.err.log") -Append -Encoding UTF8
}

$codexProcesses = @(Get-Process -Name "Codex" -ErrorAction SilentlyContinue | Where-Object { $_.Path })
$codexPath = $codexProcesses |
  Select-Object -ExpandProperty Path -First 1

foreach ($process in $codexProcesses) {
  try {
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    "Stopped existing Codex process $($process.Id): $($process.Path)" |
      Out-File -FilePath (Join-Path $LogDir "start-codex-admin-codex-restart.log") -Append -Encoding UTF8
  } catch {
    $_ | Out-File -FilePath (Join-Path $LogDir "start-codex-admin-codex-restart.err.log") -Append -Encoding UTF8
  }
}

Start-Sleep -Seconds 2

if ($codexPath -and (Test-Path -LiteralPath $codexPath)) {
  Start-Process -FilePath $codexPath -WorkingDirectory $Root
  return
}

$codexPackage = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($codexPackage) {
  $codexExe = Join-Path $codexPackage.InstallLocation "app\Codex.exe"
  if (Test-Path -LiteralPath $codexExe) {
    Start-Process -FilePath $codexExe -WorkingDirectory $Root
    return
  }
}

throw "Could not find Codex.exe. Start Codex manually, then run this shortcut again."
