#Requires -Version 5.1
<#
  Windows 侧受限代理 —— SSH forced-command 的目标。

  本脚本的部署副本是 Mac / 树莓派 等对端进入这台 Windows 的**唯一入口**：
  authorized_keys 里那把公钥被 command="...windows-agent.ps1" 限定，
  对端无论请求执行什么，sshd 都只会跑这个脚本，真正的请求内容出现在
  环境变量 SSH_ORIGINAL_COMMAND 里，由本脚本自行决定要不要执行。

  安全立场：**默认拒绝**。SSH_ORIGINAL_COMMAND 只接受精确字面量 health/run。
  run 的 JSON 载荷只从 stdin 读取，再交给仓库内的固定处理器表；prompt 始终
  只是数据，不会进入命令行，也不会交给 shell 解释。

  注意：部署到 ProgramData 的副本必须由管理员持有、普通用户不可写 —— 否则
  forced-command 的限制就形同虚设。仓库内源码保持可编辑，由安装脚本复制并锁定。
#>

param(
  [string]$RepoRoot
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$Root = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  Split-Path -Parent $PSScriptRoot
} else {
  [System.IO.Path]::GetFullPath($RepoRoot)
}
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

function Write-AgentJson {
  param([object]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 10))
}

function Write-AgentFailure {
  param(
    [string]$ErrorCode,
    [string]$Detail,
    [string]$LogDetail = $Detail
  )
  Write-AgentLog -Result $ErrorCode -Detail $LogDetail
  Write-AgentJson ([ordered]@{
    ok = $false
    error = $ErrorCode
    detail = $Detail
  })
}

# SSH_ORIGINAL_COMMAND 完全由对端控制，视为不可信输入。
# 只做**精确匹配**，不做解析、不做拼接、不传给任何 shell。
$Request = ""
if ($null -ne $env:SSH_ORIGINAL_COMMAND) {
  $Request = [string]$env:SSH_ORIGINAL_COMMAND
}

$Allowed = @("health", "run")

# 用 -cnotcontains / switch -CaseSensitive 而不是默认的大小写不敏感版本：
# 这是自家组件之间的协议，要的是可预测的精确匹配。放任大小写会让白名单
# 在增长后出现"我以为没放行、其实放行了"的惊喜。
if ($Allowed -cnotcontains $Request) {
  Write-AgentFailure `
    -ErrorCode "not-allowed" `
    -Detail "SSH_ORIGINAL_COMMAND 只允许精确字面量 health 或 run" `
    -LogDetail "request not in exact allowlist"
  exit 1
}

switch -CaseSensitive ($Request) {
  "health" {
    try {
      # 只读：报告本机身份与能力，不碰任何状态
      $leaseFile = Join-Path $Root "data\state\brain-lease.json"
      $leaseHolder = "unknown"
      if (Test-Path -LiteralPath $leaseFile) {
        try { $leaseHolder = (Get-Content -Raw -LiteralPath $leaseFile | ConvertFrom-Json).holder } catch { $leaseHolder = "unreadable" }
      }
      $bridge = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*openclaw-telegram-bridge*' })

      Write-AgentJson ([ordered]@{
        node         = "windows"
        ok           = $true
        hostname     = $env:COMPUTERNAME
        leaseHolder  = $leaseHolder
        bridgeCount  = $bridge.Count
        capabilities = @("files","browser","screen","canvas","outlook","maintenance","codex","gui-control")
        at           = (Get-Date).ToUniversalTime().ToString("o")
      })

      Write-AgentLog -Result "ok" -Detail "health"
      exit 0
    } catch {
      Write-AgentFailure -ErrorCode "handler-failed" -Detail "健康检查失败" -LogDetail $_.Exception.Message
      exit 1
    }
  }

  "run" {
    try {
      if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        Write-AgentFailure -ErrorCode "handler-failed" -Detail "项目根目录不存在" -LogDetail $Root
        exit 1
      }

      $RunnerPath = Join-Path $Root "src\satellite\windows.mjs"
      if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) {
        Write-AgentFailure -ErrorCode "handler-failed" -Detail "Windows 固定处理器入口不存在" -LogDetail $RunnerPath
        exit 1
      }

      $Node = Get-Command "node.exe" -CommandType Application -ErrorAction Stop | Select-Object -First 1
      $PayloadJson = [Console]::In.ReadToEnd()

      # 只启动写死的 node 入口，命令行里没有 prompt 或载荷的任何内容。
      # UseShellExecute=false；完整 JSON 仅写入子进程 stdin。
      $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
      $StartInfo.FileName = $Node.Source
      $StartInfo.Arguments = '"' + $RunnerPath + '"'
      $StartInfo.WorkingDirectory = $Root
      $StartInfo.UseShellExecute = $false
      $StartInfo.CreateNoWindow = $true
      $StartInfo.RedirectStandardInput = $true
      $StartInfo.RedirectStandardOutput = $true
      $StartInfo.RedirectStandardError = $true
      $StartInfo.StandardOutputEncoding = $Utf8NoBom
      $StartInfo.StandardErrorEncoding = $Utf8NoBom

      $Process = [System.Diagnostics.Process]::new()
      $Process.StartInfo = $StartInfo
      if (-not $Process.Start()) {
        throw "无法启动 Windows 固定处理器"
      }
      $StdoutTask = $Process.StandardOutput.ReadToEndAsync()
      $StderrTask = $Process.StandardError.ReadToEndAsync()
      $Process.StandardInput.Write($PayloadJson)
      $Process.StandardInput.Close()
      $Process.WaitForExit()
      $Stdout = $StdoutTask.GetAwaiter().GetResult()
      $Stderr = $StderrTask.GetAwaiter().GetResult()
      $ExitCode = $Process.ExitCode
      $Process.Dispose()

      $Lines = @($Stdout -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
      if ($Lines.Count -ne 1) {
        throw "固定处理器没有返回单行 JSON；stderr=$($Stderr.Trim())"
      }
      try {
        $Response = $Lines[0] | ConvertFrom-Json -ErrorAction Stop
      } catch {
        throw "固定处理器返回了无效 JSON"
      }
      if ($null -eq $Response.PSObject.Properties["ok"] -or $Response.ok -isnot [bool]) {
        throw "固定处理器响应缺少布尔 ok"
      }

      [Console]::Out.WriteLine($Lines[0])
      if ($Response.ok -eq $true -and $ExitCode -eq 0) {
        Write-AgentLog -Result "ok" -Detail "run"
        exit 0
      }

      $ResultCode = if ($null -ne $Response.PSObject.Properties["error"]) {
        [string]$Response.error
      } else {
        "handler-failed"
      }
      Write-AgentLog -Result $ResultCode -Detail "run failed"
      exit 1
    } catch {
      Write-AgentFailure -ErrorCode "handler-failed" -Detail "Windows 处理器启动或响应失败" -LogDetail $_.Exception.Message
      exit 1
    }
  }
}
