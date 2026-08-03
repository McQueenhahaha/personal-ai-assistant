#Requires -Version 5.1
<#
  Windows 侧受限代理 —— SSH forced-command 的目标。

  它是 Mac / 树莓派 等对端进入这台 Windows 的**唯一入口**：
  authorized_keys 里那把公钥被 command="...windows-agent.ps1" 限定，
  对端无论请求执行什么，sshd 都只会跑这个脚本，真正的请求内容出现在
  环境变量 SSH_ORIGINAL_COMMAND 里，由本脚本自行决定要不要执行。

  安全立场：**默认拒绝**。只有下面 $Allowed 里显式列出的动作才会执行。
  第一阶段仅开放 health（只读、无副作用），用于验证链路。
  后续要开放派活能力时，在 $Allowed 里增加分支，并保证每个分支
  本身不接受任意命令字符串。

  注意：本文件必须由管理员持有、普通用户不可写 —— 否则用户态代码可以改写它，
  forced-command 的限制就形同虚设。安装脚本会收紧 ACL。
#>

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root "data\logs"
$LogFile = Join-Path $LogDir "windows-agent.log"

function Write-AgentLog {
  param([string]$Result, [string]$Detail)
  try {
    if (-not (Test-Path -LiteralPath $LogDir)) {
      New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    }
    $entry = [ordered]@{
      at       = (Get-Date).ToUniversalTime().ToString("o")
      from     = $env:SSH_CLIENT
      request  = $env:SSH_ORIGINAL_COMMAND
      result   = $Result
      detail   = $Detail
    } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($LogFile, "$entry`r`n", [System.Text.UTF8Encoding]::new($false))
  } catch {
    # 日志失败不能影响判定结果，更不能把异常抛回给对端
  }
}

# SSH_ORIGINAL_COMMAND 完全由对端控制，视为不可信输入。
# 只做**精确匹配**，不做解析、不做拼接、不传给任何 shell。
$Request = ""
if ($null -ne $env:SSH_ORIGINAL_COMMAND) {
  $Request = $env:SSH_ORIGINAL_COMMAND.Trim()
}

$Allowed = @("health")

# 用 -cnotcontains / switch -CaseSensitive 而不是默认的大小写不敏感版本：
# 这是自家组件之间的协议，要的是可预测的精确匹配。放任大小写会让白名单
# 在增长后出现"我以为没放行、其实放行了"的惊喜。
if ($Allowed -cnotcontains $Request) {
  Write-AgentLog -Result "denied" -Detail "not in allowlist"
  [Console]::Error.WriteLine("windows-agent: 拒绝。本代理当前只接受：$($Allowed -join ', ')")
  exit 1
}

switch -CaseSensitive ($Request) {
  "health" {
    # 只读：报告本机身份与能力，不碰任何状态
    $leaseFile = Join-Path $Root "data\state\brain-lease.json"
    $leaseHolder = "unknown"
    if (Test-Path -LiteralPath $leaseFile) {
      try { $leaseHolder = (Get-Content -Raw -LiteralPath $leaseFile | ConvertFrom-Json).holder } catch { $leaseHolder = "unreadable" }
    }
    $bridge = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*openclaw-telegram-bridge*' })

    [ordered]@{
      node         = "windows"
      ok           = $true
      hostname     = $env:COMPUTERNAME
      leaseHolder  = $leaseHolder
      bridgeCount  = $bridge.Count
      capabilities = @("files","browser","screen","canvas","outlook","maintenance","codex","gui-control")
      at           = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json -Compress

    Write-AgentLog -Result "ok" -Detail "health"
    exit 0
  }
}
