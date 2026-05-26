$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OpenClawHome = Join-Path $ProjectRoot ".openclaw"
$OpenClawState = Join-Path $OpenClawHome "state"
$OpenClawConfig = Join-Path $OpenClawHome "openclaw.json"
$NpmGlobal = "D:\AI\npm-global"
$OllamaBin = "D:\AI\Ollama"
$OllamaModels = "D:\AI\ollama-models"
$GogCli = "D:\AI\gogcli"
$TempDir = Join-Path $ProjectRoot "data\tmp"
$AppDataDir = Join-Path $ProjectRoot "data\appdata"
$NpmCache = Join-Path $AppDataDir "npm-cache"
$PythonUserRoot = Join-Path $AppDataDir "Python"

if (-not (Test-Path -Path $OpenClawHome)) {
  New-Item -ItemType Directory -Force -Path $OpenClawHome | Out-Null
}

if (-not (Test-Path -Path $OpenClawState)) {
  New-Item -ItemType Directory -Force -Path $OpenClawState | Out-Null
}

if (-not (Test-Path -Path $TempDir)) {
  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
}

if (-not (Test-Path -Path $AppDataDir)) {
  New-Item -ItemType Directory -Force -Path $AppDataDir | Out-Null
}

foreach ($dir in @($NpmGlobal, $NpmCache)) {
  if (-not (Test-Path -Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
}

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($machinePath -or $userPath) {
  $pythonScriptPaths = @()
  if (Test-Path -Path $PythonUserRoot) {
    $pythonScriptPaths = Get-ChildItem -Path $PythonUserRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "Scripts" } |
      Where-Object { Test-Path -Path $_ }
  }
  $pathParts = @($NpmGlobal, $OllamaBin, $GogCli) + $pythonScriptPaths + @($machinePath, $userPath)
  $env:Path = ($pathParts | Where-Object { $_ }) -join ";"
}

$env:OPENCLAW_HOME = $OpenClawHome
$env:OPENCLAW_STATE_DIR = $OpenClawState
$env:OPENCLAW_CONFIG_PATH = $OpenClawConfig
$env:OLLAMA_MODELS = $OllamaModels
$env:NPM_CONFIG_PREFIX = $NpmGlobal
$env:NPM_CONFIG_CACHE = $NpmCache
$env:TEMP = $TempDir
$env:TMP = $TempDir
$env:APPDATA = $AppDataDir
