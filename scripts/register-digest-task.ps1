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

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Description "Send the personal AI digest to Telegram." `
  -Force

Write-Host "Registered task '$TaskName' at $Time."
