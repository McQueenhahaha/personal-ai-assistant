param(
  [string]$TaskName = "Personal AI Local Queue Worker"
)

$ErrorActionPreference = "Stop"

$RunScript = Join-Path $PSScriptRoot "run-local-queue.ps1"
$HiddenRunner = Join-Path $PSScriptRoot "run-hidden.vbs"
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$HiddenRunner`" `"$RunScript`""

$Trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Description "Process routine local AI tasks from D:\AI\personal-ai-assistant\data\queues\local\inbox every minute." `
  -Force

Write-Host "Registered task '$TaskName' to run every minute."
