$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath("Desktop")
$Target = "powershell.exe"
$Icon = "D:\AI\Ollama\app.ico"
$CodexIcon = "C:\Program Files\WindowsApps\OpenAI.Codex_26.513.4821.0_x64__2p2nqsd0c76g0\app\Codex.exe"

$obsoleteShortcuts = @(
  "Start Personal AI Assistant.lnk",
  "Stop Personal AI Assistant.lnk",
  "Start Codex Admin + AI Assistant.lnk",
  "Setup Codex Admin Startup.lnk",
  "Disable Codex Admin Startup.lnk",
  "AI Assistant - Enable Admin Startup.lnk",
  "AI Assistant - Disable Admin Startup.lnk",
  "Export School Mail Snapshot.lnk"
)

foreach ($name in $obsoleteShortcuts) {
  $path = Join-Path $Desktop $name
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

$shortcuts = @(
  @{
    Name = "AI Assistant - Start.lnk"
    Script = "start-assistant.ps1"
    Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\scripts\start-assistant.ps1`""
    Icon = $Icon
    Description = "Start Ollama, OpenClaw, Telegram bridge, and the personal AI workers."
  },
  @{
    Name = "AI Assistant - Stop.lnk"
    Script = "stop-assistant.ps1"
    Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\scripts\stop-assistant.ps1`""
    Icon = $Icon
    Description = "Stop the personal AI assistant runtime."
  },
  @{
    Name = "AI Assistant - Start Admin.lnk"
    Script = "start-codex-admin.ps1"
    Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Root\scripts\start-codex-admin.ps1`""
    Icon = $CodexIcon
    Description = "Start Codex and the personal AI assistant with administrator privileges. Requires UAC approval."
  }
)

$shell = New-Object -ComObject WScript.Shell
foreach ($item in $shortcuts) {
  $shortcutPath = Join-Path $Desktop $item.Name
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = $item.Arguments
  $shortcut.WorkingDirectory = $Root
  if (Test-Path -LiteralPath $item.Icon) {
    $shortcut.IconLocation = $item.Icon
  }
  $shortcut.Description = $item.Description
  $shortcut.Save()
  Write-Host "Created $shortcutPath"
}
