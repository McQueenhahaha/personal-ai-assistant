$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$TaskName = "Personal AI School Check"
$ScriptPath = Join-Path $Root "scripts\run-school-check.ps1"
$HiddenRunner = Join-Path $Root "scripts\run-hidden.vbs"
$LogDir = Join-Path $Root "data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Argument = "`"$HiddenRunner`" `"$ScriptPath`""
$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $Argument -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Checks school mail at configured times and sends deadline reminders." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "The script uses SCHOOL_TIMEZONE from .env (default: UTC)."
