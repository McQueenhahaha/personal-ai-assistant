param(
  [string]$TelegramChatId
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

function Get-DotEnvValue {
  param([string]$Name)

  $root = Split-Path -Parent $PSScriptRoot
  $envFile = Join-Path $root ".env"
  if (-not (Test-Path -LiteralPath $envFile)) { return $null }

  $line = Get-Content -LiteralPath $envFile -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -First 1
  if (-not $line) { return $null }

  return (($line -replace "^\s*$([regex]::Escape($Name))\s*=", "").Trim().Trim('"').Trim("'"))
}

if ([string]::IsNullOrWhiteSpace($TelegramChatId)) {
  $TelegramChatId = Get-DotEnvValue "TELEGRAM_CHAT_ID"
}

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
  throw "openclaw is not available. Run scripts\install-openclaw.ps1 first."
}

if ([string]::IsNullOrWhiteSpace($TelegramChatId)) {
  throw "Telegram chat id missing. Set TELEGRAM_CHAT_ID in .env or pass -TelegramChatId."
}

$batchItems = @(
  [pscustomobject]@{
    path = "commands.ownerAllowFrom"
    value = @("telegram:$TelegramChatId")
  }
)
$batch = ConvertTo-Json -InputObject $batchItems -Depth 8

$root = Split-Path -Parent $PSScriptRoot
$tempDir = Join-Path $root "data\tmp"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$tempFile = Join-Path $tempDir "openclaw-owner-config.json"
$batch | Set-Content -Path $tempFile -Encoding UTF8

openclaw config set --batch-file $tempFile
Write-Host "Configured OpenClaw owner as telegram:$TelegramChatId"
