param(
  [string[]]$Times = @("08:00", "20:00"),
  [string]$TaskName = "Personal AI Canvas Check"
)

$ErrorActionPreference = "Stop"

$RunScript = Join-Path $PSScriptRoot "run-canvas-check.ps1"
$HiddenRunner = Join-Path $PSScriptRoot "run-hidden.vbs"
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$HiddenRunner`" `"$RunScript`""

$Triggers = foreach ($Time in $Times) {
  New-ScheduledTaskTrigger -Daily -At $Time
}
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Triggers `
  -Principal $Principal `
  -Description "Check Canvas assignment due dates and send Telegram reminders." `
  -Force

Write-Host "Registered task '$TaskName' at $($Times -join ', ')."
