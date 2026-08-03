$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is not available. Run scripts\install-prereqs.ps1, restart PowerShell, then try again."
}

# 定时工作只在【持有大脑租约的那台机器】上运行。规则对称：无论大脑在 Windows
# 还是 Mac，非持有方都不该跑 —— canvas-reminders-sent.json 与 canvas-token-alert.json
# 都在灵魂包清单里，非持有方写下的去重状态会被同步用对端副本冲掉，
# 结果就是同一条作业提醒反复发送（school-check 已实测发生过同类刷屏）。
# 判定逻辑集中在 src/state/brain-guard.mjs，两个平台共用一份实现。
& node .\src\state\brain-guard.mjs | Out-Null
if ($LASTEXITCODE -ne 0) {
  $LogDir = Join-Path $Root "data\logs"
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $msg = "[" + (Get-Date -Format o) + "] Skipped: this node does not hold the brain lease."
  $msg | Out-File -FilePath (Join-Path $LogDir "canvas-check-skipped-not-brain.log") -Append -Encoding UTF8
  exit 0
}

node .\src\canvas-check.mjs
