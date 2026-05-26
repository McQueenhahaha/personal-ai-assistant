param(
  [string]$Account = $env:GOG_ACCOUNT,
  [string]$Query = "in:inbox newer_than:7d -category:promotions -category:social -in:drafts",
  [int]$MaxMessages = 30,
  [string]$OutDir
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot

function Get-DotEnvValue {
  param([string]$Name)

  $envFile = Join-Path $Root ".env"
  if (-not (Test-Path -LiteralPath $envFile)) { return $null }

  $line = Get-Content -LiteralPath $envFile -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -First 1
  if (-not $line) { return $null }

  return (($line -replace "^\s*$([regex]::Escape($Name))\s*=", "").Trim().Trim('"').Trim("'"))
}

if ([string]::IsNullOrWhiteSpace($Account)) {
  $Account = Get-DotEnvValue "GOG_ACCOUNT"
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $Root "data\personal-mail-drop"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not (Get-Command gog -ErrorAction SilentlyContinue)) {
  throw "gog is not available. Make sure D:\AI\gogcli is installed and openclaw-env.ps1 was loaded."
}

function ConvertTo-ProcessArgument {
  param([string]$Argument)

  if ($null -eq $Argument) { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }

  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0

  foreach ($char in $Argument.ToCharArray()) {
    if ($char -eq '\') {
      $backslashes += 1
      continue
    }

    if ($char -eq '"') {
      [void]$builder.Append('\' * (($backslashes * 2) + 1))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }

    if ($backslashes -gt 0) {
      [void]$builder.Append('\' * $backslashes)
      $backslashes = 0
    }
    [void]$builder.Append($char)
  }

  if ($backslashes -gt 0) {
    [void]$builder.Append('\' * ($backslashes * 2))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

$gogArgs = @("gmail", "search", $Query, "--max", [string]$MaxMessages, "--plain", "--gmail-no-send")
if (-not [string]::IsNullOrWhiteSpace($Account)) {
  $gogArgs += @("--account", $Account)
}

$gogExe = (Get-Command gog).Source
$stdoutFile = New-TemporaryFile
$stderrFile = New-TemporaryFile
try {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $gogExe
  $startInfo.Arguments = ($gogArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $exitCode = $process.ExitCode

  $stdout | Set-Content -LiteralPath $stdoutFile -Encoding UTF8
  $stderr | Set-Content -LiteralPath $stderrFile -Encoding UTF8
} finally {
  if ($process) { $process.Dispose() }
}

$output = @(
  if (Test-Path -LiteralPath $stdoutFile) {
    Get-Content -LiteralPath $stdoutFile -Encoding UTF8
  }
)
$stderrOutput = @(
  if (Test-Path -LiteralPath $stderrFile) {
    Get-Content -LiteralPath $stderrFile -Encoding UTF8 |
      Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and
        $_ -notmatch "^\s*# Next page:\s+--page\s+"
      }
  }
)

Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue

if ($exitCode -ne 0) {
  $joinedOutput = (@($stderrOutput) + @($output)) -join [Environment]::NewLine
  throw "gog Gmail export failed: $joinedOutput"
}

if ($stderrOutput.Count -gt 0) {
  Write-Warning (($stderrOutput | Select-Object -First 5) -join [Environment]::NewLine)
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ssZ")
$outFile = Join-Path $OutDir "gmail-snapshot-$stamp.md"
$lines = @(
  "Subject: Gmail snapshot",
  "From: gog gmail",
  "Date: $((Get-Date).ToString('o'))",
  "",
  "# Gmail snapshot",
  "",
  "- Query: $Query",
  "- Max messages: $MaxMessages",
  "- Account: $Account",
  "",
  '```text'
) + $output + @(
  '```',
  ""
)

$lines | Set-Content -LiteralPath $outFile -Encoding UTF8
Write-Host "Exported Gmail snapshot to $outFile"
