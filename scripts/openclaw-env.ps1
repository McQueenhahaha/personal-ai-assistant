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
$EnvFile = Join-Path $ProjectRoot ".env"

if (Test-Path -Path $EnvFile) {
  foreach ($rawLine in Get-Content -Path $EnvFile -Encoding UTF8) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      continue
    }

    $normalized = $line
    if ($normalized.StartsWith("export ")) {
      $normalized = $normalized.Substring(7).Trim()
    }

    $eq = $normalized.IndexOf("=")
    if ($eq -le 0) {
      continue
    }

    $key = $normalized.Substring(0, $eq).Trim()
    $value = $normalized.Substring($eq + 1).Trim()
    if ($value.Length -ge 2 -and (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      )) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    if (-not (Test-Path "Env:$key")) {
      Set-Item "Env:$key" $value
    }
  }
}

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
