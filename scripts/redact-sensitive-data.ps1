param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ChangedFiles = 0
$SkippedFiles = 0

function Test-InRoot {
  param([string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  return $resolved.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)
}

function Redact-Text {
  param([string]$Text)

  $result = $Text
  $result = [regex]::Replace($result, '/bot\d+:[A-Za-z0-9_-]+', '/bot[REDACTED]')
  $result = [regex]::Replace($result, '\b\d{6,}:[A-Za-z0-9_-]{20,}\b', '[TELEGRAM_BOT_TOKEN]')
  $result = [regex]::Replace($result, '\bAIza[0-9A-Za-z_-]{20,}\b', '[GOOGLE_API_KEY]')
  $result = [regex]::Replace($result, '\bGOCSPX-[A-Za-z0-9_-]+\b', '[GOOGLE_CLIENT_SECRET]')
  $result = [regex]::Replace($result, '\bya29\.[0-9A-Za-z._-]+\b', '[GOOGLE_ACCESS_TOKEN]')
  $result = [regex]::Replace($result, '\bsk-proj-[A-Za-z0-9_-]{20,}\b', '[OPENAI_API_KEY]')
  $result = [regex]::Replace($result, '\bsk-[A-Za-z0-9_-]{20,}\b', '[OPENAI_API_KEY]')
  $result = [regex]::Replace(
    $result,
    '(?i)(\\?"(?:client_secret|refresh_token|access_token|id_token|api_key|token|password|pass|cookie|secret)\\?"\s*:\s*\\?")[^"\\]+(\\?")',
    '$1[REDACTED]$2'
  )
  $result = [regex]::Replace($result, '(?i)(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+', '$1[REDACTED]')
  $result = [regex]::Replace($result, '(?i)(TOKEN|KEY|SECRET|PASSWORD|PASS|COOKIE)\s*=\s*["'']?[^"''\s;]+', '$1=[REDACTED]')
  return $result
}

function Redact-File {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (-not (Test-InRoot -Path $Path)) { throw "Refusing to edit outside project root: $Path" }

  $info = Get-Item -LiteralPath $Path
  if ($info.Length -gt 20MB) { return }

  try {
    $text = [System.IO.File]::ReadAllText($info.FullName, [System.Text.Encoding]::UTF8)
    $redacted = Redact-Text -Text $text
  } catch {
    $script:SkippedFiles += 1
    return
  }
  if ($redacted -eq $text) { return }

  $script:ChangedFiles += 1
  if (-not $DryRun) {
    try {
      [System.IO.File]::WriteAllText($info.FullName, $redacted, [System.Text.UTF8Encoding]::new($false))
    } catch {
      $script:ChangedFiles -= 1
      $script:SkippedFiles += 1
    }
  }
}

$targets = @()
foreach ($dir in @("data\logs", "data\queues", "data\tmp\codex-auto")) {
  $full = Join-Path $Root $dir
  if (Test-Path -LiteralPath $full) {
    $targets += Get-ChildItem -LiteralPath $full -File -Recurse -Include *.log,*.jsonl,*.json,*.txt,*.md -ErrorAction SilentlyContinue
  }
}

$openClawDir = Join-Path $Root ".openclaw"
if (Test-Path -LiteralPath $openClawDir) {
  $targets += Get-ChildItem -LiteralPath $openClawDir -File -Filter "openclaw.json.bak*" -ErrorAction SilentlyContinue
  $targets += Get-ChildItem -LiteralPath $openClawDir -File -Filter "openclaw.json.last-good" -ErrorAction SilentlyContinue
}

$targets | Sort-Object FullName -Unique | ForEach-Object { Redact-File -Path $_.FullName }

$mode = if ($DryRun) { "Dry run" } else { "Redaction" }
Write-Host "$mode complete. Files changed: $ChangedFiles. Files skipped: $SkippedFiles."
