$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is not available. Run scripts\install-prereqs.ps1, restart PowerShell, then try again."
}

node .\src\index.mjs digest
