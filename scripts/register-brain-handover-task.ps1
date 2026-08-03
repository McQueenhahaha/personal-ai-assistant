param(
  [string]$TaskName = "PAI Brain Handover"
)

$ErrorActionPreference = "Stop"

# 注册"临终交接"计划任务：在系统即将睡眠或计划关机时触发，
# 把最新状态推给对端并让出大脑租约，使接管方不必等满 90 秒 TTL、
# 且拿到的是最新状态而不是几十秒前的快照。
#
# 覆盖有预警的死法；蓝屏/断电没有预警，仍由既有的周期同步兜底。
#
# 事件来源（均已在本机实测存在）：
#   Kernel-Power 506  系统进入新型待机
#   User32       1074 计划中的关机/重启
$RunScript  = Join-Path $PSScriptRoot "run-brain-handover.ps1"
$HiddenShim = Join-Path $PSScriptRoot "run-hidden.vbs"
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# 经 run-hidden.vbs 启动，避免每次睡眠都闪一下黑框
# （powershell -WindowStyle Hidden 是"先建窗口再隐藏"，本仓已有此约定）。
$Action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$HiddenShim`" `"$RunScript`""

function New-EventTrigger {
  param([string]$LogName, [string]$Source, [int]$EventId)
  $query = "<QueryList><Query Id='0' Path='$LogName'><Select Path='$LogName'>" +
           "*[System[Provider[@Name='$Source'] and EventID=$EventId]]" +
           "</Select></Query></QueryList>"
  $class = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
  $trigger = New-CimInstance -CimClass $class -ClientOnly
  $trigger.Enabled = $true
  $trigger.Subscription = $query
  return $trigger
}

$Triggers = @(
  (New-EventTrigger -LogName "System" -Source "Microsoft-Windows-Kernel-Power" -EventId 506),
  (New-EventTrigger -LogName "System" -Source "User32" -EventId 1074)
)

$Principal = New-ScheduledTaskPrincipal `
  -UserId $CurrentUser `
  -LogonType Interactive `
  -RunLevel Limited

# 时间窗很短：给 60 秒上限，超时宁可放弃也不要拖住系统进入睡眠。
$Settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 60) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
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
  -Description "Pushes the freshest state to the peer and releases the brain lease before this machine sleeps or shuts down." | Out-Null

Write-Host "Registered '$TaskName' on Kernel-Power 506 (entering standby) and User32 1074 (planned shutdown)."
