param(
  [string]$InstallDir = "D:\AI\Ollama",
  [string]$ModelDir = "D:\AI\ollama-models"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is not available on this machine."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null

[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $ModelDir, "User")
$env:OLLAMA_MODELS = $ModelDir

Write-Host "Installing Ollama to $InstallDir"
winget install -e --id Ollama.Ollama --location $InstallDir --accept-package-agreements --accept-source-agreements

Write-Host ""
Write-Host "OLLAMA_MODELS is set to $ModelDir"
Write-Host "Restart Ollama from the Start menu if it was already running."
