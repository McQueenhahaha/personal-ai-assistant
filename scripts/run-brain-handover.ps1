$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 临终交接：在本机即将睡眠/关机时，把最新状态推给对端并让出大脑租约。
# 由事件触发的计划任务调用（Kernel-Power 506 = 进入新型待机，User32 1074 = 计划关机）。
#
# 必须快：系统给的时间窗很短，来不及就放弃。推送失败不是灾难 ——
# 本机已经在本地让出租约，对端仍会按既有的 TTL 逻辑接管，只是拿到的状态旧一些。
# 这正是"有预警的死亡"与"蓝屏断电"之间的差别。
$LogDir = Join-Path $Root "data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "brain-handover.log"

try {
  $result = & node .\src\brain\handover.mjs 2>&1 | Out-String
  $line = "[" + (Get-Date -Format o) + "] " + $result.Trim()
} catch {
  $line = "[" + (Get-Date -Format o) + "] handover script failed: " + $_.Exception.Message
}

[System.IO.File]::AppendAllText($LogFile, $line + "`r`n", [System.Text.UTF8Encoding]::new($false))
