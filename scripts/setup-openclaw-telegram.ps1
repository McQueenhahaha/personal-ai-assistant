param(
  [string]$TelegramBotToken = $env:TELEGRAM_BOT_TOKEN
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

if ([string]::IsNullOrWhiteSpace($TelegramBotToken)) {
  $TelegramBotToken = Get-DotEnvValue "TELEGRAM_BOT_TOKEN"
}

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
  throw "openclaw is not available. Run scripts\install-openclaw.ps1 first."
}

if ([string]::IsNullOrWhiteSpace($TelegramBotToken)) {
  throw "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or pass -TelegramBotToken."
}

Write-Host "Adding Telegram channel to OpenClaw..."
openclaw channels add --channel telegram --token $TelegramBotToken

Write-Host ""
Write-Host "Channel status:"
openclaw channels list

Write-Host ""
Write-Host "Start or restart the gateway, then DM the bot from Telegram:"
Write-Host "  openclaw gateway"
Write-Host "  openclaw pairing list telegram"
Write-Host "  openclaw pairing approve telegram <code>"
