param(
  [string]$Model = "qwen3:8b"
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$env:OLLAMA_MODELS = [Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User")
if ([string]::IsNullOrWhiteSpace($env:OLLAMA_MODELS)) {
  $env:OLLAMA_MODELS = "D:\AI\ollama-models"
  [Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $env:OLLAMA_MODELS, "User")
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  $possible = @(
    "D:\AI\Ollama\ollama.exe",
    "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
  ) | Where-Object { Test-Path -Path $_ } | Select-Object -First 1

  if ($possible) {
    $env:Path = "$(Split-Path -Parent $possible);$env:Path"
  } else {
    throw "ollama is not available. Run scripts\install-ollama.ps1 first."
  }
}

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -Method Get -TimeoutSec 3 | Out-Null
} catch {
  Write-Host "Starting ollama serve in the background..."
  Start-Process -FilePath (Get-Command ollama).Source -ArgumentList "serve" -WindowStyle Hidden
  Start-Sleep -Seconds 5
}

Write-Host "Pulling local model: $Model"
ollama pull $Model

Write-Host ""
Write-Host "Installed models:"
ollama list
