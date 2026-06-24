$ErrorActionPreference = "Stop"

$Root = Split-Path (Split-Path $PSScriptRoot)
$DataDir = Join-Path $Root "data\admin-maintenance"
$RequestsDir = Join-Path $DataDir "requests"
$ResultsDir = Join-Path $DataDir "results"
$LogPath = Join-Path $DataDir "admin-maintenance.log"

foreach ($Dir in @($DataDir, $RequestsDir, $ResultsDir)) {
  if (-not (Test-Path -LiteralPath $Dir)) {
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  }
}

function Write-AdminMaintenanceLog {
  param(
    [string]$Message
  )

  $Timestamp = (Get-Date).ToString("o")
  Add-Content -Path $LogPath -Value "[$Timestamp] $Message" -Encoding UTF8
}

function Get-SafeResultPath {
  param(
    [string]$Id
  )

  if ([string]::IsNullOrWhiteSpace($Id) -or $Id -notmatch '^[A-Za-z0-9_.-]+$') {
    throw "request id must be a filename-safe token"
  }

  return (Join-Path $ResultsDir ($Id + ".json"))
}

function Write-AdminMaintenanceResult {
  param(
    [string]$Id,
    [string]$Action,
    [string]$Status,
    [string]$Output,
    [string]$Reason
  )

  $Result = [ordered]@{
    id = $Id
    action = $Action
    status = $Status
    output = $Output
    reason = $Reason
    finishedAt = (Get-Date).ToString("o")
  }

  $ResultPath = Get-SafeResultPath -Id $Id
  $Result | ConvertTo-Json -Depth 4 | Set-Content -Path $ResultPath -Encoding UTF8
}

$Whitelist = @{
  "dism-restorehealth" = {
    $Output = DISM.exe /Online /Cleanup-Image /RestoreHealth 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      throw "DISM.exe /RestoreHealth exited with code $LASTEXITCODE`r`n$Output"
    }
    $Output
  }
  "dism-scanhealth" = {
    $Output = DISM.exe /Online /Cleanup-Image /ScanHealth 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      throw "DISM.exe /ScanHealth exited with code $LASTEXITCODE`r`n$Output"
    }
    $Output
  }
  "sfc-scannow" = {
    $Output = sfc.exe /scannow 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      throw "sfc.exe /scannow exited with code $LASTEXITCODE`r`n$Output"
    }
    $Output
  }
  "defender-quickscan" = {
    Start-MpScan -ScanType QuickScan | Out-String
  }
  "defender-status" = {
    Get-MpComputerStatus | Out-String
  }
  "disk-reliability" = {
    Get-PhysicalDisk | Get-StorageReliabilityCounter | Out-String
  }
  "volume-status" = {
    (Get-Volume | Out-String) + (Get-PhysicalDisk | Out-String)
  }
}

$RequestFiles = Get-ChildItem -Path $RequestsDir -Filter "*.json" -File -ErrorAction SilentlyContinue

foreach ($RequestFile in $RequestFiles) {
  $Id = $RequestFile.BaseName
  $Action = ""

  try {
    $Request = Get-Content -Raw -Path $RequestFile.FullName | ConvertFrom-Json
    $Id = [string]$Request.id
    $Action = [string]$Request.action

    if ([string]::IsNullOrWhiteSpace($Id)) {
      throw "request id is empty"
    }
    [void](Get-SafeResultPath -Id $Id)

    if (-not $Whitelist.ContainsKey($Action)) {
      Write-AdminMaintenanceResult `
        -Id $Id `
        -Action $Action `
        -Status "rejected" `
        -Output "" `
        -Reason "action not in whitelist"
      Write-AdminMaintenanceLog "rejected id=$Id action=$Action reason=action not in whitelist"
      continue
    }

    try {
      $ScriptBlock = $Whitelist[$Action]
      $Output = $ScriptBlock.Invoke() | Out-String
      Write-AdminMaintenanceResult `
        -Id $Id `
        -Action $Action `
        -Status "ok" `
        -Output $Output `
        -Reason ""
      Write-AdminMaintenanceLog "ok id=$Id action=$Action"
    }
    catch {
      $ErrorText = $_ | Out-String
      Write-AdminMaintenanceResult `
        -Id $Id `
        -Action $Action `
        -Status "failed" `
        -Output $ErrorText `
        -Reason "action failed"
      Write-AdminMaintenanceLog "failed id=$Id action=$Action error=$($ErrorText.Trim())"
    }
  }
  catch {
    $ErrorText = $_ | Out-String
    $SafeId = $RequestFile.BaseName -replace '[^A-Za-z0-9_.-]', '_'
    if ([string]::IsNullOrWhiteSpace($SafeId)) {
      $SafeId = [guid]::NewGuid().ToString("N")
    }

    Write-AdminMaintenanceResult `
      -Id $SafeId `
      -Action $Action `
      -Status "failed" `
      -Output $ErrorText `
      -Reason "request failed before action execution"
    Write-AdminMaintenanceLog "failed id=$SafeId action=$Action error=$($ErrorText.Trim())"
  }
  finally {
    Remove-Item -Path $RequestFile.FullName -Force -ErrorAction SilentlyContinue
  }
}
