[CmdletBinding()]
param(
  [string]$MacHost,
  [string]$KeyPath
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

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

function Invoke-NativeResult {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList
  )

  $PreviousEap = $ErrorActionPreference
  $NativeException = $null
  $NativeOutput = @()
  $ExitCode = -1
  try {
    $ErrorActionPreference = "Continue"
    try {
      $global:LASTEXITCODE = 0
      $NativeOutput = @(& $FilePath @ArgumentList 2>&1)
      $ExitCode = $LASTEXITCODE
    } catch {
      $NativeException = $_
    }
  } finally {
    $ErrorActionPreference = $PreviousEap
  }

  [pscustomobject]@{
    ExitCode = $ExitCode
    Output = $NativeOutput
    Exception = $NativeException
  }
}

function Invoke-NativeChecked {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$FailureMessage
  )

  $Result = Invoke-NativeResult -FilePath $FilePath -ArgumentList $ArgumentList
  if ($null -ne $Result.Exception -or $Result.ExitCode -ne 0) {
    $Detail = [string](($Result.Output | Select-Object -Last 1))
    if ([string]::IsNullOrWhiteSpace($Detail) -and $null -ne $Result.Exception) {
      $Detail = $Result.Exception.Exception.Message
    }
    if ([string]::IsNullOrWhiteSpace($Detail)) {
      $Detail = "退出码 $($Result.ExitCode)"
    }
    throw "$FailureMessage：$Detail"
  }
  return $Result
}

$TempRoot = [System.IO.Path]::GetTempPath()
$TempDir = $null
try {
  $MacHostPlaceholder = "user@100.x.y.z"
  if ([string]::IsNullOrWhiteSpace($MacHost)) {
    $MacHost = if ([string]::IsNullOrWhiteSpace($env:MAC_SATELLITE_HOST)) {
      $MacHostPlaceholder
    } else {
      $env:MAC_SATELLITE_HOST
    }
  }
  if ($MacHost -eq $MacHostPlaceholder -or $MacHost.StartsWith("-") -or $MacHost -match '\s') {
    throw "MAC_SATELLITE_HOST 未配置或格式不合法（当前：$MacHost）。"
  }
  if ([string]::IsNullOrWhiteSpace($KeyPath)) {
    $KeyPath = if ([string]::IsNullOrWhiteSpace($env:MAC_SATELLITE_KEY)) {
      "~/.ssh/pai_mac"
    } else {
      $env:MAC_SATELLITE_KEY
    }
  }

  $ResolvedKeyPath = Resolve-KeyPath $KeyPath
  if (-not (Test-Path -LiteralPath $ResolvedKeyPath -PathType Leaf)) {
    throw "找不到 SSH 密钥：$ResolvedKeyPath"
  }

  $RepoRoot = Split-Path $PSScriptRoot -Parent
  $PlistSource = Join-Path $RepoRoot "satellite\com.pai.brain-supervisor.plist"
  if (-not (Test-Path -LiteralPath $PlistSource -PathType Leaf)) {
    throw "找不到 LaunchAgent 模板：$PlistSource"
  }

  $SshCommon = @(
    "-i", $ResolvedKeyPath,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new"
  )

  $UserResult = Invoke-NativeChecked `
    -FilePath "ssh" `
    -ArgumentList (@($SshCommon) + @($MacHost, "id", "-un")) `
    -FailureMessage "无法通过 SSH 获取 Mac 用户名"
  $MacUser = [string]($UserResult.Output | Select-Object -Last 1)
  $MacUser = $MacUser.Trim()
  if ($MacUser -notmatch '^[a-z_][a-z0-9_-]*$') {
    throw "Mac 用户名格式异常：$MacUser"
  }

  $MacHome = "/Users/$MacUser"
  $MacBrainRoot = "$MacHome/pai-brain"
  $RemoteArchive = "$MacBrainRoot/pai-brain-deploy.tar.gz"
  $RemotePlist = "$MacHome/Library/LaunchAgents/com.pai.brain-supervisor.plist"
  Invoke-NativeChecked `
    -FilePath "ssh" `
    -ArgumentList (@($SshCommon) + @(
      $MacHost,
      "mkdir",
      "-p",
      $MacBrainRoot,
      "$MacBrainRoot/data/logs",
      "$MacBrainRoot/data/state",
      "$MacHome/Library/LaunchAgents"
    )) `
    -FailureMessage "创建 Mac 大脑目录失败" | Out-Null

  $TempDir = Join-Path $TempRoot ("pai-mac-brain-" + [guid]::NewGuid().ToString("N"))
  [void](New-Item -ItemType Directory -Path $TempDir)
  $ArchivePath = Join-Path $TempDir "pai-brain-deploy.tar.gz"
  $PreparedPlist = Join-Path $TempDir "com.pai.brain-supervisor.plist"

  Invoke-NativeChecked `
    -FilePath "tar" `
    -ArgumentList @(
      "-czf", $ArchivePath,
      "-C", $RepoRoot,
      "src", "satellite", "scripts", "config", "package.json"
    ) `
    -FailureMessage "打包 Mac 大脑代码失败" | Out-Null

  $PlistText = [System.IO.File]::ReadAllText($PlistSource)
  $PlistText = $PlistText.Replace("__PAI_USER__", $MacUser)
  [System.IO.File]::WriteAllText($PreparedPlist, $PlistText, [System.Text.UTF8Encoding]::new($false))

  Invoke-NativeChecked `
    -FilePath "scp" `
    -ArgumentList (@($SshCommon) + @($ArchivePath, "${MacHost}:$RemoteArchive")) `
    -FailureMessage "上传 Mac 大脑代码包失败" | Out-Null
  Invoke-NativeChecked `
    -FilePath "ssh" `
    -ArgumentList (@($SshCommon) + @($MacHost, "tar", "-xzf", $RemoteArchive, "-C", $MacBrainRoot)) `
    -FailureMessage "解压 Mac 大脑代码包失败" | Out-Null
  Invoke-NativeChecked `
    -FilePath "ssh" `
    -ArgumentList (@($SshCommon) + @($MacHost, "rm", "-f", $RemoteArchive)) `
    -FailureMessage "清理 Mac 大脑远端代码包失败" | Out-Null
  Invoke-NativeChecked `
    -FilePath "scp" `
    -ArgumentList (@($SshCommon) + @($PreparedPlist, "${MacHost}:$RemotePlist")) `
    -FailureMessage "上传大脑 LaunchAgent plist 失败" | Out-Null

  # 首次部署没有已加载的 agent，unload 失败属于正常情况。Invoke-NativeResult 会在
  # PS 5.1 下临时使用 EAP=Continue，并捕获 NativeCommandError。
  try {
    $UnloadResult = Invoke-NativeResult `
      -FilePath "ssh" `
      -ArgumentList (@($SshCommon) + @($MacHost, "launchctl", "unload", $RemotePlist))
  } catch {
    # 忽略：未加载过就是正常情况。
  } finally {
    $global:LASTEXITCODE = 0
  }

  Invoke-NativeChecked `
    -FilePath "ssh" `
    -ArgumentList (@($SshCommon) + @($MacHost, "launchctl", "load", "-w", $RemotePlist)) `
    -FailureMessage "加载 Mac 大脑 LaunchAgent 失败" | Out-Null

  $SupervisorPattern = "$MacBrainRoot/src/brain/supervisor.mjs"
  $SupervisorRunning = $false
  for ($Attempt = 0; $Attempt -lt 5; $Attempt += 1) {
    $Probe = Invoke-NativeResult `
      -FilePath "ssh" `
      -ArgumentList (@($SshCommon) + @($MacHost, "pgrep", "-f", $SupervisorPattern))
    if ($Probe.ExitCode -eq 0) {
      $SupervisorRunning = $true
      break
    }
    if ($Probe.ExitCode -ne 1 -or $null -ne $Probe.Exception) {
      throw "验证 Mac supervisor 进程失败（退出码 $($Probe.ExitCode)）"
    }
    Start-Sleep -Seconds 2
  }
  if (-not $SupervisorRunning) {
    throw "Mac supervisor 未在预期时间内启动"
  }

  Write-Host "Mac 大脑代码与 LaunchAgent 已部署。"
  Write-Host "LaunchAgent：$RemotePlist"
  Write-Host "Supervisor 进程：运行中"
}
finally {
  if (-not [string]::IsNullOrWhiteSpace($TempDir)) {
    $ResolvedTempDir = [System.IO.Path]::GetFullPath($TempDir)
    $ResolvedTempRoot = [System.IO.Path]::GetFullPath($TempRoot)
    if ($ResolvedTempDir.StartsWith($ResolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $ResolvedTempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  [Console]::OutputEncoding = $PreviousConsoleEncoding
}
