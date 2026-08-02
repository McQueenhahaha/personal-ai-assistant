param(
  [string]$TaskName = "Personal AI Bridge Watchdog"
)

$ErrorActionPreference = "Stop"

$RunScript = Join-Path $PSScriptRoot "run-bridge-watchdog.ps1"
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunScript`""

$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$TimeTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$Triggers = @($LogonTrigger, $TimeTrigger)

$Principal = New-ScheduledTaskPrincipal `
  -UserId $CurrentUser `
  -LogonType Interactive `
  -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Triggers `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Restarts the Telegram bridge when its process is missing or its heartbeat is stale." | Out-Null

Write-Host "Registered task '$TaskName' to run at logon and every 5 minutes indefinitely."
