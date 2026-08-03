param(
  [Parameter(Mandatory)]
  [string]$Action,
  [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$Whitelist = @("screen", "outlook")

# Default deny before creating a request or touching Task Scheduler.
if ($Whitelist -cnotcontains $Action) {
  Write-Error "交互式 action 不在白名单内"
  exit 1
}
if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 3600) {
  Write-Error "TimeoutSeconds 必须是 1-3600 的整数"
  exit 1
}

$InputJson = [Console]::In.ReadToEnd()
try {
  $InputData = $InputJson | ConvertFrom-Json -ErrorAction Stop
} catch {
  Write-Error "stdin 必须是合法 JSON"
  exit 1
}
$InputProperties = @($InputData.PSObject.Properties.Name)
if (
  $InputData -isnot [System.Management.Automation.PSCustomObject] -or
  $InputProperties.Count -ne 1 -or
  $InputProperties -cnotcontains "prompt" -or
  $InputData.prompt -isnot [string]
) {
  Write-Error "stdin 必须严格包含字符串字段 prompt"
  exit 1
}

$Root = Split-Path (Split-Path $PSScriptRoot)
$DataDir = Join-Path $Root "data\interactive"
$RequestsDir = Join-Path $DataDir "requests"
$ResultsDir = Join-Path $DataDir "results"

foreach ($Dir in @($DataDir, $RequestsDir, $ResultsDir)) {
  if (-not (Test-Path -LiteralPath $Dir)) {
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  }
}

$Id = "$(Get-Date -Format yyyyMMdd-HHmmss)-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$RequestPath = Join-Path $RequestsDir ($Id + ".json")
$ResultPath = Join-Path $ResultsDir ($Id + ".json")
$Request = [ordered]@{
  id = $Id
  action = $Action
  prompt = [string]$InputData.prompt
  timeoutSeconds = $TimeoutSeconds
  requestedAt = (Get-Date).ToString("o")
}
$Request | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $RequestPath -Encoding UTF8

try {
  Start-ScheduledTask -TaskName "PAI Interactive Task" -ErrorAction Stop
} catch {
  Write-Error "任务未注册，请先运行 scripts/register-interactive-task.ps1"
  exit 1
}

$Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $Deadline) {
  if (Test-Path -LiteralPath $ResultPath -PathType Leaf) {
    try {
      $Result = Get-Content -Raw -LiteralPath $ResultPath | ConvertFrom-Json -ErrorAction Stop
    } catch {
      Write-Error "交互式任务结果不是合法 JSON: id=$Id"
      exit 1
    }
    if ([string]$Result.id -cne $Id -or [string]$Result.action -cne $Action) {
      Write-Error "交互式任务结果与请求不匹配: id=$Id action=$Action"
      exit 1
    }
    if ([string]$Result.status -cne "ok") {
      $Reason = [string]$Result.reason
      $Output = [string]$Result.output
      Write-Error "交互式任务失败: id=$Id action=$Action reason=$Reason output=$Output"
      exit 1
    }

    [Console]::Out.WriteLine([string]$Result.output)
    exit 0
  }

  Start-Sleep -Milliseconds 200
}

Write-Error "等待交互式任务结果超时: id=$Id action=$Action timeout=${TimeoutSeconds}s"
exit 1
