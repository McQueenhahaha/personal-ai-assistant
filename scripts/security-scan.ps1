$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  $uvx = Get-Command uvx -ErrorAction SilentlyContinue
  if ($uvx) {
    & $uvx.Source semgrep --config auto src scripts
    exit $LASTEXITCODE
  }

  $semgrep = Get-Command semgrep -ErrorAction SilentlyContinue
  if ($semgrep) {
    & $semgrep.Source --config auto src scripts
    exit $LASTEXITCODE
  }

  Write-Error "Neither uvx nor semgrep was found. Install uv or semgrep, then rerun this script."
  exit 127
}
finally {
  Pop-Location
}
