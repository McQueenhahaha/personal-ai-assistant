$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is not available. Run scripts\install-prereqs.ps1, restart PowerShell, then try again."
}

Write-Host "Installing OpenClaw globally with npm..."
npm install -g openclaw@latest

Write-Host ""
Write-Host "OpenClaw version:"
openclaw --version

Write-Host ""
Write-Host "Next:"
Write-Host "  openclaw onboard --install-daemon"
Write-Host "  openclaw dashboard"
