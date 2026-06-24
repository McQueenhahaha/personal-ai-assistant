param(
  [Parameter(Mandatory)]
  [string]$Action,
  [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = "Stop"

if ($Action -notmatch '^[a-z][a-z0-9-]+$') {
  Write-Error "动作名不合法"
  exit 1
}

$Root = Split-Path (Split-Path $PSScriptRoot)
$DataDir = Join-Path $Root "data\admin-maintenance"
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
  requestedAt = (Get-Date).ToString("o")
}

$Request | ConvertTo-Json -Depth 4 | Set-Content -Path $RequestPath -Encoding UTF8

$TaskName = "PAI Admin Maintenance"
try {
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
}
catch {
  Write-Error "任务未注册, 请先以管理员运行 register-admin-maintenance-task.ps1"
  exit 1
}

$StartedAt = Get-Date
while (((Get-Date) - $StartedAt).TotalSeconds -lt $TimeoutSeconds) {
  if (Test-Path -LiteralPath $ResultPath) {
    $Result = Get-Content -Raw -Path $ResultPath | ConvertFrom-Json

    Write-Output "id: $($Result.id)"
    Write-Output "action: $($Result.action)"
    Write-Output "status: $($Result.status)"
    if (-not [string]::IsNullOrWhiteSpace([string]$Result.reason)) {
      Write-Output "reason: $($Result.reason)"
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Result.output)) {
      Write-Output ""
      Write-Output $Result.output
    }
    exit 0
  }

  Start-Sleep -Seconds 2
}

Write-Error "等待维护任务结果超时: id=$Id action=$Action timeout=${TimeoutSeconds}s"
exit 1
