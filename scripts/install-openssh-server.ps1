#Requires -Version 5.1
<#
  在这台 Windows 上安装并**加固** OpenSSH Server，使它成为网状拓扑中可被访问的节点。

  必须以管理员身份运行。

  加固要点（每一条都有理由，不要随手放宽）：
   1. sshd 只监听 Tailscale 那个地址，不监听 WLAN/以太网
      —— 这台机器的 WLAN 拿到的是运营商级 NAT 地址 100.86.x.x，
         与 Tailscale 同处 100.64.0.0/10。若按网段放行等于对整个运营商网络开门。
   2. 关闭密码登录，只认密钥
   3. 防火墙规则只放行**具体对端 IP**，且限定 Tailscale 接口
   4. 对端公钥写进 administrators_authorized_keys（本机账户属于管理员组，
      Windows OpenSSH 对管理员走这个文件），并加 forced-command 限死为
      satellite\windows-agent.ps1 —— 对端拿不到 shell
   5. 收紧 windows-agent.ps1 的 ACL，普通用户不可写
      —— 否则用户态代码能改写它，forced-command 就形同虚设
#>

param(
  [string]$PeerPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHIv6wx/Il9gtwMl5u/zabJsCrvaw63WpcMmKWsHsImH pai-mac-to-windows",
  [string]$PeerAddress   = "100.66.80.98",
  [string]$ListenAddress = "100.68.6.52"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "必须以管理员身份运行（右键 PowerShell -> 以管理员身份运行）。"
}

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$AgentPath  = Join-Path $RepoRoot "satellite\windows-agent.ps1"      # 源码（可编辑）
$DeployDir  = Join-Path $env:ProgramData "PAI"                       # 部署位置（仅管理员可写）
$DeployedAgent = Join-Path $DeployDir "windows-agent.ps1"
$SshDataDir = Join-Path $env:ProgramData "ssh"
$ConfigPath = Join-Path $SshDataDir "sshd_config"
$AdminKeys  = Join-Path $SshDataDir "administrators_authorized_keys"

if (-not (Test-Path -LiteralPath $AgentPath)) { throw "找不到受限代理：$AgentPath" }

Write-Host "== 1/7 安装 OpenSSH Server =="
# 通配符可能匹配到多个对象；必须取单个，否则 $cap.Name 是数组，
# 传给 Add-WindowsCapability 会抛错并中断整个脚本（曾实际发生）。
$cap = @(Get-WindowsCapability -Online -Name 'OpenSSH.Server*') |
       Sort-Object Name | Select-Object -First 1
if (-not $cap) { throw "系统里找不到 OpenSSH.Server 功能包。" }
if ($cap.State -ne 'Installed') {
  Write-Host "   正在安装 $($cap.Name)（需从 Windows Update 下载，可能几分钟）..."
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
  Write-Host "   已安装"
} else {
  Write-Host "   已是安装状态，跳过"
}
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  throw "sshd 服务未注册，功能包可能没装成功。"
}

Write-Host "== 2/7 生成主机密钥并首次启动 =="
if (-not (Test-Path -LiteralPath $SshDataDir)) {
  New-Item -ItemType Directory -Force -Path $SshDataDir | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
# 没有主机密钥时 sshd 起不来。正常首启会自动生成，但若上一次中途失败会留下空目录，
# 这里显式补一次（ssh-keygen -A 是幂等的）。
$hostKeys = @(Get-ChildItem $SshDataDir -Filter 'ssh_host_*_key' -Force -ErrorAction SilentlyContinue)
if ($hostKeys.Count -eq 0) {
  Write-Host "   未发现主机密钥，正在生成..."
  & "$env:WINDIR\System32\OpenSSH\ssh-keygen.exe" -A | Out-Null
}
# 没有配置文件时用官方模板铺一份，保证 sshd 能起来（第 3 步会覆盖成加固版）
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Copy-Item -LiteralPath "$env:WINDIR\System32\OpenSSH\sshd_config_default" -Destination $ConfigPath
  Write-Host "   已铺默认配置"
}
if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd }
Write-Host "   sshd 首次启动成功"
Stop-Service sshd

Write-Host "== 3/7 写入加固配置 =="
if ((Test-Path -LiteralPath $ConfigPath) -and -not (Test-Path -LiteralPath "$ConfigPath.orig")) {
  Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.orig"
  Write-Host "   原配置已备份到 sshd_config.orig"
}

$hardened = @"
# 由 scripts\install-openssh-server.ps1 生成 —— 手改前请先读该脚本顶部的说明。

# 只监听 Tailscale 地址。切勿改成 0.0.0.0：
# 本机 WLAN 是运营商级 NAT 地址(100.86.x.x)，与 Tailscale 同在 100.64.0.0/10，
# 监听全部地址等于把 SSH 暴露给运营商网络内的其他人。
ListenAddress $ListenAddress
Port 22

# 只认密钥
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
GSSAPIAuthentication no

# 不需要的通道一律关闭
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
X11Forwarding no
PermitUserEnvironment no

LogLevel INFO
Subsystem sftp sftp-server.exe

# Windows OpenSSH 规矩：属于 Administrators 组的账户走这个文件，
# 而不是 ~\.ssh\authorized_keys
Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
"@
[System.IO.File]::WriteAllText($ConfigPath, $hardened, [System.Text.UTF8Encoding]::new($false))

Write-Host "== 4/7 安装对端公钥（带 forced-command）=="
# forced-command：无论对端请求执行什么，sshd 只会运行这个代理；
# 真正的请求内容进入 SSH_ORIGINAL_COMMAND，由代理自行决定是否执行（默认拒绝）。
# 指向**部署副本**而不是仓库源文件（见第 5 步的说明）。
# 同时把仓库根目录作为参数传进去 —— 部署副本不在仓库里，无法靠 $PSScriptRoot 推断。
$restrictions = 'command="powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"' + $DeployedAgent + '\" -RepoRoot \"' + $RepoRoot + '\"",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc'
$keyLine = "$restrictions $PeerPublicKey"

$existing = @()
if (Test-Path -LiteralPath $AdminKeys) {
  $existing = @(Get-Content -LiteralPath $AdminKeys | Where-Object { $_ -notmatch 'pai-mac-to-windows' })
}
$lines = @($existing + $keyLine | Where-Object { $_ -and $_.Trim() })
[System.IO.File]::WriteAllLines($AdminKeys, $lines, [System.Text.UTF8Encoding]::new($false))

# administrators_authorized_keys 的 ACL 必须只有 Administrators 和 SYSTEM，
# 否则 sshd 会直接拒绝使用该文件。
icacls $AdminKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
Write-Host "   公钥已写入并锁定 ACL"

Write-Host "== 5/7 部署受限代理到受保护位置 =="
# 源码 / 部署副本分离 —— 这是 2026-08-03 踩坑后改的设计。
#
# 曾经的做法是直接把仓库里的 satellite\ 目录 ACL 收紧成仅管理员可写，
# 并让 forced-command 指向仓库内的文件。后果：开发流程被自己锁死 ——
# 以普通用户身份运行的 Codex 无法再修改该文件，任务静默失败。
#
# 正确做法：安全边界加在**部署副本**上，不是加在工作区源文件上。
#   仓库 satellite\windows-agent.ps1  = 源码，可自由编辑
#   $DeployedAgent                     = 部署副本，仅管理员可写
#   forced-command 指向部署副本
# 攻击者改仓库那份不产生任何效果 —— 除非有人以管理员身份重新运行本脚本。
if (-not (Test-Path -LiteralPath $DeployDir)) {
  New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null
}
Copy-Item -LiteralPath $AgentPath -Destination $DeployedAgent -Force

$acl = Get-Acl $DeployDir
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
foreach ($r in @(@('BUILTIN\Administrators','FullControl'), @('NT AUTHORITY\SYSTEM','FullControl'), @('BUILTIN\Users','ReadAndExecute'))) {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($r[0], $r[1], $inherit, 'None', 'Allow')))
}
Set-Acl -Path $DeployDir -AclObject $acl
Write-Host "   已部署到 $DeployedAgent（仅管理员可写）"
Write-Host "   仓库源文件保持可编辑"

Write-Host "== 6/7 防火墙：只放行指定对端 =="
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'PAI SSH (Tailscale peers only)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule `
  -DisplayName 'PAI SSH (Tailscale peers only)' `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 `
  -LocalAddress $ListenAddress -RemoteAddress $PeerAddress `
  -Profile Any | Out-Null
Write-Host "   仅允许 $PeerAddress -> $ListenAddress:22"

Write-Host "== 7/7 启动时序与失败恢复 =="
# 为什么需要这一步（2026-08-03 实测踩到）：
# sshd 设为 Automatic 时开机很早就启动，而我们让它只绑 Tailscale 地址
# ($ListenAddress)。开机那一刻 Tailscale 网卡往往还没就绪，bind 失败 ->
# 进程以 1067 (ERROR_PROCESS_ABORTED) 退出。默认又没有任何失败恢复动作
# (RESET_PERIOD=0)，于是服务死了就一直死着，链路静默中断。
#
# 两层保护：
#   1. 延迟启动 —— 让 Tailscale 先起来
#   2. 失败自动重启 —— 万一延迟仍不够，或运行中崩溃，Windows 会自己拉起
& sc.exe config sshd start= delayed-auto | Out-Null
& sc.exe failure sshd reset= 86400 actions= restart/30000/restart/60000/restart/120000 | Out-Null
Write-Host "   已设为延迟启动 + 失败后 30s/60s/120s 自动重启"

Start-Service sshd
Write-Host ""
Write-Host "完成。sshd 状态：$((Get-Service sshd).Status)"
Write-Host "监听：$ListenAddress:22  |  放行对端：$PeerAddress"
Write-Host "对端能做的事：仅 satellite\windows-agent.ps1 白名单内的动作（当前只有 health）"
