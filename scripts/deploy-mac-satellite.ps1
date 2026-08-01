[CmdletBinding()]
param(
  [string]$MacHost = "user@100.x.y.z",
  [string]$KeyPath = "~/.ssh/pai_mac"
)

$ErrorActionPreference = "Stop"

# Mac 侧结果含中文；PS 5.1 默认按 ANSI 解码原生命令输出会乱码，导致 ConvertFrom-Json 失败。
$PreviousConsoleEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Resolve-KeyPath {
  param([string]$PathValue)

  if ($PathValue -eq "~") {
    return $env:USERPROFILE
  }
  if ($PathValue.StartsWith("~/") -or $PathValue.StartsWith("~\")) {
    return Join-Path $env:USERPROFILE $PathValue.Substring(2)
  }
  return [System.IO.Path]::GetFullPath($PathValue)
}

function Invoke-NativeChecked {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$FailureMessage
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage（退出码 $LASTEXITCODE）"
  }
}

$ResolvedKeyPath = Resolve-KeyPath $KeyPath
if (-not (Test-Path -LiteralPath $ResolvedKeyPath -PathType Leaf)) {
  throw "找不到 SSH 密钥：$ResolvedKeyPath"
}

$RepoRoot = Split-Path $PSScriptRoot -Parent
$AgentSource = Join-Path $RepoRoot "satellite\mac-agent.mjs"
$PlistSource = Join-Path $RepoRoot "satellite\com.pai.satellite.plist"
if (-not (Test-Path -LiteralPath $AgentSource -PathType Leaf)) {
  throw "找不到 Mac 代理脚本：$AgentSource"
}
if (-not (Test-Path -LiteralPath $PlistSource -PathType Leaf)) {
  throw "找不到 LaunchAgent 模板：$PlistSource"
}

$SshCommon = @(
  "-i", $ResolvedKeyPath,
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new"
)

$MacUserOutput = & ssh @SshCommon $MacHost id -un
if ($LASTEXITCODE -ne 0) {
  throw "无法通过 SSH 获取 Mac 用户名（退出码 $LASTEXITCODE）"
}
$MacUser = [string]($MacUserOutput | Select-Object -Last 1)
$MacUser = $MacUser.Trim()
if ($MacUser -notmatch '^[a-z_][a-z0-9_-]*$') {
  throw "Mac 用户名格式异常：$MacUser"
}

$MacSatelliteRoot = "/Users/$MacUser/pai-satellite"
$RemoteAgent = "$MacSatelliteRoot/mac-agent.mjs"
$RemotePlist = "/Users/$MacUser/Library/LaunchAgents/com.pai.satellite.plist"
$RemoteDirectories = @(
  "$MacSatelliteRoot/inbox",
  "$MacSatelliteRoot/outbox",
  "$MacSatelliteRoot/done",
  "$MacSatelliteRoot/work",
  "/Users/$MacUser/Library/LaunchAgents"
)

Invoke-NativeChecked `
  -FilePath "ssh" `
  -ArgumentList (@($SshCommon) + @($MacHost, "mkdir", "-p") + $RemoteDirectories) `
  -FailureMessage "创建 Mac 卫星目录失败"

$TempRoot = [System.IO.Path]::GetTempPath()
$TempDir = Join-Path $TempRoot ("pai-mac-satellite-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $TempDir)

try {
  $PreparedPlist = Join-Path $TempDir "com.pai.satellite.plist"
  $PlistText = [System.IO.File]::ReadAllText($PlistSource)
  $PlistText = $PlistText.Replace("__PAI_USER__", $MacUser)
  [System.IO.File]::WriteAllText($PreparedPlist, $PlistText, [System.Text.UTF8Encoding]::new($false))

  Invoke-NativeChecked `
    -FilePath "scp" `
    -ArgumentList (@($SshCommon) + @($AgentSource, "${MacHost}:$RemoteAgent")) `
    -FailureMessage "上传 Mac 代理脚本失败"
  Invoke-NativeChecked `
    -FilePath "scp" `
    -ArgumentList (@($SshCommon) + @($PreparedPlist, "${MacHost}:$RemotePlist")) `
    -FailureMessage "上传 LaunchAgent plist 失败"

  # 首次部署时没有已加载的 agent，unload 必然失败；PowerShell 会把原生命令的 stderr
  # 包成 NativeCommandError 导致中断，所以整体包 try/catch 并显式吞掉。
  try {
    $PreviousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & ssh @SshCommon $MacHost launchctl unload $RemotePlist *> $null
  } catch {
    # 忽略：未加载过就是正常情况
  } finally {
    $ErrorActionPreference = $PreviousEap
    $global:LASTEXITCODE = 0
  }
  Invoke-NativeChecked `
    -FilePath "ssh" `
    -ArgumentList (@($SshCommon) + @($MacHost, "launchctl", "load", "-w", $RemotePlist)) `
    -FailureMessage "加载 Mac LaunchAgent 失败"

  $ProbeId = "probe-" + [guid]::NewGuid().ToString("N")
  $ProbeTimeoutMs = 120000
  $ProbeFile = Join-Path $TempDir "$ProbeId.json"
  $ProbeTask = [ordered]@{
    id = $ProbeId
    prompt = "请只回复：Mac 卫星探针成功。不要执行其他操作。"
    kind = "mac-general"
    createdAt = [DateTime]::UtcNow.ToString("o")
    timeoutMs = $ProbeTimeoutMs
  }
  $ProbeJson = $ProbeTask | ConvertTo-Json -Depth 3
  [System.IO.File]::WriteAllText($ProbeFile, $ProbeJson, [System.Text.UTF8Encoding]::new($false))

  Invoke-NativeChecked `
    -FilePath "scp" `
    -ArgumentList (@($SshCommon) + @($ProbeFile, "${MacHost}:$MacSatelliteRoot/inbox/$ProbeId.json")) `
    -FailureMessage "投递 Mac 卫星探针失败"

  Write-Host "探针任务已投递：$ProbeId，等待卫星结果..."
  $ProbeDeadline = [DateTime]::UtcNow.AddMilliseconds($ProbeTimeoutMs + 60000)
  $ProbeResult = $null
  while ([DateTime]::UtcNow -lt $ProbeDeadline) {
    # 结果文件尚未生成时 cat 会写 stderr，PowerShell 会包成 NativeCommandError；
    # 这是轮询的正常状态，必须吞掉而不是中断。
    $PreviousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $ProbeOutput = & ssh @SshCommon $MacHost cat "$MacSatelliteRoot/outbox/$ProbeId.json" 2>$null
    $ProbeExitCode = $LASTEXITCODE
    $ErrorActionPreference = $PreviousEap
    if ($ProbeExitCode -eq 0) {
      $ProbeResult = ($ProbeOutput -join "`n") | ConvertFrom-Json
      break
    }
    if ($ProbeExitCode -ne 1) {
      throw "读取 Mac 卫星探针结果失败（退出码 $ProbeExitCode）"
    }
    Start-Sleep -Seconds 5
  }

  if ($null -eq $ProbeResult) {
    throw "Mac 卫星探针超时"
  }

  Invoke-NativeChecked `
    -FilePath "ssh" `
    -ArgumentList (@($SshCommon) + @($MacHost, "rm", "-f", "$MacSatelliteRoot/outbox/$ProbeId.json")) `
    -FailureMessage "清理 Mac 卫星探针结果失败"

  if ($ProbeResult.id -ne $ProbeId) {
    throw "Mac 卫星探针返回了错误的任务 id"
  }
  if (-not $ProbeResult.ok) {
    throw "Mac 卫星探针失败：$($ProbeResult.error)"
  }

  Write-Host "Mac 卫星部署成功。"
  Write-Host "LaunchAgent：$RemotePlist"
  Write-Host "探针结果：$($ProbeResult.result)"
}
finally {
  $ResolvedTempDir = [System.IO.Path]::GetFullPath($TempDir)
  $ResolvedTempRoot = [System.IO.Path]::GetFullPath($TempRoot)
  if ($ResolvedTempDir.StartsWith($ResolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $ResolvedTempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
