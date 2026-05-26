$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$OllamaExe = "D:\AI\Ollama\ollama.exe"
if (-not (Test-Path -Path $OllamaExe)) {
  $cmd = Get-Command ollama -ErrorAction SilentlyContinue
  if ($cmd) {
    $OllamaExe = $cmd.Source
  } else {
    throw "Ollama is not installed. Run scripts\install-ollama.ps1 first."
  }
}

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -Method Get -TimeoutSec 2 | Out-Null
  Write-Host "Ollama is already running."
  return
} catch {
  Write-Host "Starting Ollama server hidden..."
}

Start-Process -FilePath $OllamaExe -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -Method Get -TimeoutSec 5 | Out-Null
  Write-Host "Ollama server is ready."
} catch {
  Write-Warning "Ollama was started, but the API did not respond yet."
}
