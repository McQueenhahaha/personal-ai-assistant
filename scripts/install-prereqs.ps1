$ErrorActionPreference = "Stop"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is not available on this machine. Install App Installer from Microsoft Store first."
}

Write-Host "Installing Node.js LTS..."
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements

Write-Host "Installing Git..."
winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements

Write-Host ""
Write-Host "Done. Restart PowerShell, then run:"
Write-Host "  .\scripts\check-env.ps1"
