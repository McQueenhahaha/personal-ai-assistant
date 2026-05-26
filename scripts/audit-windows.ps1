param(
  [int]$Top = 20
)

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
$ArchiveDir = Join-Path $Root "data\digest-archive"
if (-not (Test-Path $ArchiveDir)) {
  New-Item -ItemType Directory -Force -Path $ArchiveDir | Out-Null
}

function Format-Size {
  param([double]$Bytes)
  if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
  if ($Bytes -ge 1MB) { return "{0:N2} MB" -f ($Bytes / 1MB) }
  if ($Bytes -ge 1KB) { return "{0:N2} KB" -f ($Bytes / 1KB) }
  return "$Bytes B"
}

function Get-ChildFolderSizes {
  param([string]$Path)

  if (-not (Test-Path $Path)) { return @() }

  Get-ChildItem -Path $Path -Directory -Force -ErrorAction SilentlyContinue |
    ForEach-Object {
      $sum = Get-ChildItem -Path $_.FullName -File -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
      [PSCustomObject]@{
        Path = $_.FullName
        Bytes = [double]($sum.Sum)
        Size = Format-Size ([double]($sum.Sum))
      }
    }
}

$candidateRoots = @(
  $env:USERPROFILE,
  "$env:USERPROFILE\Downloads",
  "$env:USERPROFILE\Documents",
  "$env:USERPROFILE\AppData\Local",
  "$env:ProgramFiles",
  ${env:ProgramFiles(x86)},
  "C:\XboxGames",
  "C:\Program Files (x86)\Steam\steamapps\common"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$folderRows = foreach ($rootPath in $candidateRoots) {
  Get-ChildFolderSizes -Path $rootPath
}

$gameProcessPattern = "steam|epic|battle.net|riot|xbox|ubisoft|ea|gog|minecraft|valorant|league|fortnite|genshin|hoyoplay"
$processRows = Get-Process |
  Where-Object { $_.ProcessName -match $gameProcessPattern -or $_.WorkingSet64 -gt 1GB } |
  Sort-Object WorkingSet64 -Descending |
  Select-Object -First $Top ProcessName, Id, @{Name="Memory"; Expression={ Format-Size $_.WorkingSet64 }}

$report = @()
$report += "Windows read-only audit"
$report += "Generated: $(Get-Date -Format o)"
$report += ""
$report += "Largest folders:"
$report += ($folderRows | Sort-Object Bytes -Descending | Select-Object -First $Top Path, Size | Format-Table -AutoSize | Out-String)
$report += ""
$report += "Game launchers / high-memory processes:"
$report += ($processRows | Format-Table -AutoSize | Out-String)
$report += ""
$report += "No files were deleted and no processes were stopped."

$outFile = Join-Path $ArchiveDir ("windows-audit-{0}.txt" -f ((Get-Date).ToString("yyyyMMdd-HHmmss")))
$report -join "`r`n" | Set-Content -Path $outFile -Encoding UTF8
Write-Host "Wrote audit report: $outFile"
