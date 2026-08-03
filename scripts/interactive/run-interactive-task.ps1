$ErrorActionPreference = "Stop"

$Root = Split-Path (Split-Path $PSScriptRoot)
$DataDir = Join-Path $Root "data\interactive"
$RequestsDir = Join-Path $DataDir "requests"
$ResultsDir = Join-Path $DataDir "results"
$LogPath = Join-Path $DataDir "interactive-task.log"
$ScreenshotScript = Join-Path $Root "scripts\take-screenshot.ps1"
$OutlookScript = Join-Path $Root "scripts\export-outlook-mail.ps1"

foreach ($Dir in @($DataDir, $RequestsDir, $ResultsDir)) {
  if (-not (Test-Path -LiteralPath $Dir)) {
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  }
}

function Write-InteractiveLog {
  param(
    [string]$Status,
    [string]$Id,
    [string]$Action,
    [string]$Detail
  )

  $Entry = [ordered]@{
    at = (Get-Date).ToString("o")
    status = $Status
    id = $Id
    action = $Action
    detail = $Detail
  } | ConvertTo-Json -Compress
  Add-Content -LiteralPath $LogPath -Value $Entry -Encoding UTF8
}

function Get-SafeResultPath {
  param([string]$Id)

  if ([string]::IsNullOrWhiteSpace($Id) -or $Id -notmatch '^[A-Za-z0-9_.-]+$') {
    throw "request id must be a filename-safe token"
  }
  return (Join-Path $ResultsDir ($Id + ".json"))
}

function Write-InteractiveResult {
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
  $Result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Get-SafeResultPath -Id $Id) -Encoding UTF8
}

function Convert-ToBoundedInteger {
  param(
    [object]$Value,
    [string]$Name,
    [int]$Minimum,
    [int]$Maximum
  )

  $Parsed = 0
  if (-not [int]::TryParse([string]$Value, [ref]$Parsed) -or $Parsed -lt $Minimum -or $Parsed -gt $Maximum) {
    throw "$Name must be an integer between $Minimum and $Maximum"
  }
  return $Parsed
}

function Get-OutlookExportOptions {
  param([string]$Prompt)

  $Days = 7
  $MaxMessages = 40
  if ([string]::IsNullOrWhiteSpace($Prompt)) {
    return @{ Days = $Days; MaxMessages = $MaxMessages }
  }

  $Structured = $null
  try { $Structured = $Prompt | ConvertFrom-Json -ErrorAction Stop } catch { $Structured = $null }
  if ($Structured -is [System.Management.Automation.PSCustomObject]) {
    $Names = @($Structured.PSObject.Properties.Name)
    foreach ($Name in $Names) {
      if (@("days", "maxMessages") -cnotcontains $Name) {
        throw "unsupported Outlook prompt field: $Name"
      }
    }
    if ($Names -ccontains "days") {
      $Days = Convert-ToBoundedInteger -Value $Structured.days -Name "days" -Minimum 1 -Maximum 365
    }
    if ($Names -ccontains "maxMessages") {
      $MaxMessages = Convert-ToBoundedInteger -Value $Structured.maxMessages -Name "maxMessages" -Minimum 1 -Maximum 500
    }
  } else {
    $DaysMatch = [regex]::Match($Prompt, '(?i)(?:days?|天数|最近|过去)\s*[:=]?\s*(\d{1,3})')
    $MaxMatch = [regex]::Match($Prompt, '(?i)(?:maxMessages|max|count|数量|最多)\s*[:=]?\s*(\d{1,3})')
    if ($DaysMatch.Success) {
      $Days = Convert-ToBoundedInteger -Value $DaysMatch.Groups[1].Value -Name "days" -Minimum 1 -Maximum 365
    }
    if ($MaxMatch.Success) {
      $MaxMessages = Convert-ToBoundedInteger -Value $MaxMatch.Groups[1].Value -Name "maxMessages" -Minimum 1 -Maximum 500
    }
  }

  return @{ Days = $Days; MaxMessages = $MaxMessages }
}

$Whitelist = @{
  "screen" = {
    if (-not (Test-Path -LiteralPath $ScreenshotScript -PathType Leaf)) {
      throw "screenshot script not found"
    }
    & $ScreenshotScript 2>&1 | Out-String
  }
  "outlook" = {
    param([string]$Prompt)
    if (-not (Test-Path -LiteralPath $OutlookScript -PathType Leaf)) {
      throw "Outlook export script not found"
    }
    $Options = Get-OutlookExportOptions -Prompt $Prompt
    & $OutlookScript -Days $Options.Days -MaxMessages $Options.MaxMessages *>&1 | Out-String
  }
}

$RequestFiles = @(Get-ChildItem -LiteralPath $RequestsDir -Filter "*.json" -File -ErrorAction SilentlyContinue)
foreach ($RequestFile in $RequestFiles) {
  $Id = $RequestFile.BaseName
  $Action = ""

  try {
    $Request = Get-Content -Raw -LiteralPath $RequestFile.FullName | ConvertFrom-Json -ErrorAction Stop
    $Id = [string]$Request.id
    $Action = [string]$Request.action
    $Prompt = [string]$Request.prompt
    [void](Get-SafeResultPath -Id $Id)

    if ($Whitelist.Keys -cnotcontains $Action) {
      Write-InteractiveResult -Id $Id -Action $Action -Status "rejected" -Output "" -Reason "action not in whitelist"
      Write-InteractiveLog -Status "rejected" -Id $Id -Action $Action -Detail "action not in whitelist"
      continue
    }

    try {
      $Output = if ($Action -ceq "outlook") {
        $Whitelist[$Action].Invoke($Prompt) | Out-String
      } else {
        $Whitelist[$Action].Invoke() | Out-String
      }
      Write-InteractiveResult -Id $Id -Action $Action -Status "ok" -Output $Output.Trim() -Reason ""
      Write-InteractiveLog -Status "ok" -Id $Id -Action $Action -Detail "completed"
    } catch {
      $ErrorText = $_ | Out-String
      Write-InteractiveResult -Id $Id -Action $Action -Status "failed" -Output $ErrorText -Reason "action failed"
      Write-InteractiveLog -Status "failed" -Id $Id -Action $Action -Detail $ErrorText.Trim()
    }
  } catch {
    $ErrorText = $_ | Out-String
    $SafeId = $RequestFile.BaseName -replace '[^A-Za-z0-9_.-]', '_'
    if ([string]::IsNullOrWhiteSpace($SafeId)) {
      $SafeId = [guid]::NewGuid().ToString("N")
    }
    Write-InteractiveResult -Id $SafeId -Action $Action -Status "failed" -Output $ErrorText -Reason "request failed before action execution"
    Write-InteractiveLog -Status "failed" -Id $SafeId -Action $Action -Detail $ErrorText.Trim()
  } finally {
    Remove-Item -LiteralPath $RequestFile.FullName -Force -ErrorAction SilentlyContinue
  }
}
