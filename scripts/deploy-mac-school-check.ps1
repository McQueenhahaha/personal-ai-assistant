[CmdletBinding()]
param(
  [string]$MacHost,
  [string]$KeyPath
)

# 在 Mac 上安装/更新「定时学校检查」LaunchAgent。
#
# 只负责 plist —— run-school-check.sh 在 satellite/ 下，随 deploy-mac-brain.ps1
# 的整目录打包一起过去了，不需要在这里单独传。
#
# 与 deploy-mac-satellite.ps1 同样是「一个 agent 一个部署脚本」的既有模式。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$RepoRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($MacHost)) { $MacHost = $env:MAC_SATELLITE_HOST }
if ([string]::IsNullOrWhiteSpace($KeyPath)) { $KeyPath = $env:MAC_SATELLITE_KEY }
if ([string]::IsNullOrWhiteSpace($MacHost)) { throw "MAC_SATELLITE_HOST 未配置。" }
if ([string]::IsNullOrWhiteSpace($KeyPath)) { throw "MAC_SATELLITE_KEY 未配置。" }

if ($KeyPath -eq "~") {
  $KeyPath = $env:USERPROFILE
} elseif ($KeyPath.StartsWith("~/") -or $KeyPath.StartsWith("~\")) {
  $KeyPath = Join-Path $env:USERPROFILE $KeyPath.Substring(2)
}
$KeyPath = [System.IO.Path]::GetFullPath($KeyPath)

$SshCommon = @("-i", $KeyPath, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=15")

$MacUser = (& ssh @SshCommon $MacHost "id -un") | Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($MacUser)) {
  throw "无法连上 Mac 或取不到用户名。"
}
$MacUser = $MacUser.Trim()

$Label       = "com.pai.school-check"
$PlistSource = Join-Path $RepoRoot "satellite\$Label.plist"
$RemotePlist = "/Users/$MacUser/Library/LaunchAgents/$Label.plist"

# plist 里的 __PAI_USER__ 占位符要换成真实用户名（与 brain-supervisor 同一套做法）。
$TempPlist = Join-Path ([System.IO.Path]::GetTempPath()) "$Label.$([guid]::NewGuid().ToString('N')).plist"
$Text = [System.IO.File]::ReadAllText($PlistSource).Replace("__PAI_USER__", $MacUser)
[System.IO.File]::WriteAllText($TempPlist, $Text, [System.Text.UTF8Encoding]::new($false))

try {
  & scp @SshCommon $TempPlist "${MacHost}:$RemotePlist"
  if ($LASTEXITCODE -ne 0) { throw "传输 plist 失败。" }
} finally {
  Remove-Item -LiteralPath $TempPlist -Force -ErrorAction SilentlyContinue
}

# 包装脚本随 deploy-mac-brain.ps1 过去，但 tar 不保证执行位，显式补上。
& ssh @SshCommon $MacHost "chmod +x /Users/$MacUser/pai-brain/satellite/run-school-check.sh"
if ($LASTEXITCODE -ne 0) { throw "设置 run-school-check.sh 执行位失败。" }

& ssh @SshCommon $MacHost "launchctl unload $RemotePlist 2>/dev/null; launchctl load -w $RemotePlist"
if ($LASTEXITCODE -ne 0) { throw "加载 LaunchAgent 失败。" }

$Listed = (& ssh @SshCommon $MacHost "launchctl list | grep $Label") | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($Listed)) {
  throw "LaunchAgent 已加载但未出现在 launchctl list 中。"
}

Write-Host "已安装 $Label（每 300 秒一次）。"
Write-Host "  plist: $RemotePlist"
Write-Host "  状态 : $($Listed.Trim())"
