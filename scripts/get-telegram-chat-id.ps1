param(
  [string]$TelegramBotToken = $env:TELEGRAM_BOT_TOKEN,
  [int]$WaitSeconds = 0
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root ".env"

if ([string]::IsNullOrWhiteSpace($TelegramBotToken) -and (Test-Path -Path $EnvFile)) {
  $line = Select-String -Path $EnvFile -Pattern '^TELEGRAM_BOT_TOKEN=(.+)$' | Select-Object -First 1
  if ($line -and $line.Matches[0].Groups[1].Value) {
    $TelegramBotToken = $line.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
  }
}

if ([string]::IsNullOrWhiteSpace($TelegramBotToken)) {
  throw "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or pass -TelegramBotToken."
}

try {
  $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$TelegramBotToken/getMe" -Method Get
  if ($me.ok -and $me.result.username) {
    Write-Host "This token belongs to bot: @$($me.result.username)"
    Write-Host "Open: https://t.me/$($me.result.username)"
  }
} catch {
  Write-Host "Could not verify bot identity before getUpdates."
}

Write-Host "Send a message such as /start or test to your bot, then run this script."
try {
  $uri = "https://api.telegram.org/bot$TelegramBotToken/getUpdates"
  if ($WaitSeconds -gt 0) {
    $uri = "$uri`?timeout=$WaitSeconds"
    Write-Host "Waiting up to $WaitSeconds seconds for a new Telegram message..."
  }
  $updates = Invoke-RestMethod -Uri $uri -Method Get
} catch {
  $message = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    $message = $_.ErrorDetails.Message
  }
  throw "Telegram getUpdates failed. Check that the token is copied exactly from @BotFather. Details: $message"
}

if (-not $updates.ok) {
  throw "Telegram returned ok=false: $($updates.description)"
}

if (-not $updates.result -or $updates.result.Count -eq 0) {
  Write-Host "No updates found yet."
  Write-Host "Open your bot in Telegram, send /start or any message, wait 2 seconds, then run this script again."
  return
}

$updates.result |
  ForEach-Object {
    $message = $_.message
    if (-not $message) { $message = $_.edited_message }
    if (-not $message) { return }

    [PSCustomObject]@{
      update_id = $_.update_id
      chat_id = $message.chat.id
      chat_type = $message.chat.type
      from = $message.from.username
      text = $message.text
      date = $message.date
    }
  } |
  Format-Table -AutoSize

Write-Host ""
Write-Host "Copy the chat_id value into .env as TELEGRAM_CHAT_ID=..."
