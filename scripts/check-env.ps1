$ErrorActionPreference = "Continue"
. "$PSScriptRoot\openclaw-env.ps1"

function Test-Tool {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    Write-Host "[missing] $Name"
    return
  }

  Write-Host "[found]   $Name -> $($cmd.Source)"
  try {
    & $Name --version
  } catch {
    Write-Host "          version check failed: $($_.Exception.Message)"
  }
}

Write-Host "Checking local assistant prerequisites..."
Test-Tool "node"
Test-Tool "npm"
Test-Tool "git"
Test-Tool "openclaw"
Test-Tool "winget"
