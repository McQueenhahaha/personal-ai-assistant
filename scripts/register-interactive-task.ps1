# 注册到当前普通用户的交互式会话；不需要管理员权限，也不创建任何触发器。
param(
  [string]$TaskName = "PAI Interactive Task"
)

$ErrorActionPreference = "Stop"
$RunnerScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "interactive\run-interactive-task.ps1")).Path
$HiddenShim = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "run-hidden.vbs")).Path
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$HiddenShim`" `"$RunnerScript`""
$Principal = New-ScheduledTaskPrincipal `
  -UserId $CurrentUser `
  -LogonType Interactive `
  -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 65) `
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
  -Description "Runs approved desktop-session actions for the personal AI assistant."
Register-ScheduledTask -TaskName $TaskName -InputObject $Task | Out-Null

Write-Host "已注册计划任务: $TaskName"
Write-Host "LogonType: Interactive；RunLevel: Limited；无触发器。"
