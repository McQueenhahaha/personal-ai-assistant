param(
  [string]$TaskName = "Personal AI Bridge Watchdog"
)

$ErrorActionPreference = "Stop"

$RunScript = Join-Path $PSScriptRoot "run-bridge-watchdog.ps1"
$HiddenShim = Join-Path $PSScriptRoot "run-hidden.vbs"
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# 经 run-hidden.vbs 启动，不要直接 -Execute "powershell.exe"：
# powershell.exe -WindowStyle Hidden 是"先创建控制台窗口再隐藏"，每次运行都会闪一下黑框。
# 本任务每 5 分钟跑一次，直接调会变成持续骚扰。
# run-hidden.vbs 用 shell.Run <cmd>, 0, False 启动，全程无窗口 ——
# Personal AI School Check / Personal AI Canvas Check 用的都是这个外壳，保持一致。
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$HiddenShim`" `"$RunScript`""

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
