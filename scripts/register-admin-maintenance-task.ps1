# 此脚本本身需要以管理员身份运行一次，因为注册 RunLevel Highest 计划任务需要管理员权限。
# 注册后，非提权派发方只需写请求并调用 Start-ScheduledTask，不再弹 UAC。

$ErrorActionPreference = "Stop"

$TaskName = "PAI Admin Maintenance"
$RunnerScript = Join-Path $PSScriptRoot "admin-maintenance\run-admin-maintenance.ps1"
$RunnerScript = (Resolve-Path -LiteralPath $RunnerScript).Path
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerScript`""

$Principal = New-ScheduledTaskPrincipal `
  -UserId $CurrentUser `
  -LogonType Interactive `
  -RunLevel Highest

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$Task = New-ScheduledTask `
  -Action $Action `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Runs approved elevated maintenance actions for the personal AI assistant."

Register-ScheduledTask `
  -TaskName $TaskName `
  -InputObject $Task | Out-Null

Write-Host "已注册计划任务: $TaskName"
Write-Host "RunLevel: Highest；无触发器。之后可由 Start-ScheduledTask 按需触发，不再弹 UAC。"
