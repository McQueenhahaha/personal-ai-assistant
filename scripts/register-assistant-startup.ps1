param(
  [int]$DelaySeconds = 60
)

$ErrorActionPreference = "Stop"

$TaskName = "Personal AI Assistant Autostart"
$StartScript = Join-Path $PSScriptRoot "start-assistant.ps1"
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$trigger.Delay = "PT${DelaySeconds}S"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""

$principal = New-ScheduledTaskPrincipal `
  -UserId $CurrentUser `
  -LogonType Interactive `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Starts the personal AI assistant at user logon after a short delay." | Out-Null

Write-Host "已注册计划任务: $TaskName"
Write-Host "登录后延迟启动秒数: $DelaySeconds"
