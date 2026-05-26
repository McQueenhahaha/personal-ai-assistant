param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("local", "codex")]
  [string]$Queue,

  [Parameter(Mandatory = $true)]
  [string]$Title,

  [Parameter(Mandatory = $true)]
  [string]$Prompt,

  [string]$TaskType = "general",
  [string]$Priority = "normal",
  [string]$Source = "manual"
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
$Inbox = Join-Path $Root "data\queues\$Queue\inbox"
New-Item -ItemType Directory -Force -Path $Inbox | Out-Null

$SafeTitle = ($Title -replace '[^a-zA-Z0-9_-]+', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($SafeTitle)) { $SafeTitle = "task" }
if ($SafeTitle.Length -gt 80) { $SafeTitle = $SafeTitle.Substring(0, 80) }

$Name = "{0}-{1}.json" -f ((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ss-fffZ")), $SafeTitle
$File = Join-Path $Inbox $Name

$Payload = @{
  id = [System.IO.Path]::GetFileNameWithoutExtension($Name)
  title = $Title
  taskType = $TaskType
  source = $Source
  priority = $Priority
  prompt = $Prompt
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 8

$Payload | Set-Content -Path $File -Encoding UTF8
Write-Host "Created $Queue task: $File"
