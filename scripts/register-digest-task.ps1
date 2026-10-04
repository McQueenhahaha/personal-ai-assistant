param(
  [string]$Time = "08:30",
  [string]$TaskName = "Personal AI Digest"
)

$ErrorActionPreference = "Stop"

$RunScript = Join-Path $PSScriptRoot "run-digest.ps1"
$HiddenRunner = Join-Path $PSScriptRoot "run-hidden.vbs"
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$HiddenRunner`" `"$RunScript`""

$Trigger = New-ScheduledTaskTrigger -Daily -At $Time
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Send the personal AI digest to Telegram." `
  -Force

Write-Host "Registered task '$TaskName' at $Time."
