param(
  [int]$LogDays = 7,
  [int]$TempDays = 2,
  [int]$ComputeCacheDays = 7,
  [int]$DigestDays = 14,
  [int]$MailSnapshotDays = 14,
  [int]$QueueDoneDays = 14,
  [int]$QueueFailedDays = 30,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Now = Get-Date
$DeletedBytes = 0L
$DeletedFiles = 0

function Test-InRoot {
  param([string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  return $resolved.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)
}

function Remove-OldFiles {
  param(
    [string]$Dir,
    [string]$Filter,
    [int]$Days
  )

  if ($Days -lt 1) { return }
  if (-not (Test-Path -LiteralPath $Dir)) { return }
  if (-not (Test-InRoot -Path $Dir)) { throw "Refusing to clean outside project root: $Dir" }

  $cutoff = $Now.AddDays(-$Days)
  Get-ChildItem -LiteralPath $Dir -File -Filter $Filter -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
      if (-not (Test-InRoot -Path $_.FullName)) {
        throw "Refusing to delete outside project root: $($_.FullName)"
      }

      $script:DeletedFiles += 1
      $script:DeletedBytes += $_.Length

      if ($DryRun) {
        Write-Host "Would delete: $($_.FullName)"
      } else {
        Remove-Item -LiteralPath $_.FullName -Force
        Write-Host "Deleted: $($_.FullName)"
      }
    }
}

function Remove-OldQueueFiles {
  param(
    [string]$QueueRoot,
    [int]$DoneDays,
    [int]$FailedDays
  )

  if (-not (Test-Path -LiteralPath $QueueRoot)) { return }
  if (-not (Test-InRoot -Path $QueueRoot)) { throw "Refusing to clean outside project root: $QueueRoot" }

  $targets = Get-ChildItem -LiteralPath $QueueRoot -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @("done", "failed", "outbox") }

  foreach ($target in $targets) {
    $days = if ($target.Name -eq "failed") { $FailedDays } else { $DoneDays }
    foreach ($filter in @("*.txt", "*.md", "*.json")) {
      Remove-OldFiles -Dir $target.FullName -Filter $filter -Days $days
    }
  }
}

Remove-OldFiles -Dir (Join-Path $Root "data\logs") -Filter "*" -Days $LogDays
Remove-OldFiles -Dir (Join-Path $Root "data\tmp") -Filter "*" -Days $TempDays
Remove-OldFiles -Dir (Join-Path $Root "data\appdata\NVIDIA\ComputeCache") -Filter "*" -Days $ComputeCacheDays
Remove-OldFiles -Dir (Join-Path $Root "data\digest-archive") -Filter "*.txt" -Days $DigestDays
Remove-OldFiles -Dir (Join-Path $Root "data\school-mail-drop") -Filter "outlook-rmit-snapshot-*.md" -Days $MailSnapshotDays
Remove-OldFiles -Dir (Join-Path $Root "data\personal-mail-drop") -Filter "gmail-snapshot-*.md" -Days $MailSnapshotDays
Remove-OldQueueFiles -QueueRoot (Join-Path $Root "data\queues") -DoneDays $QueueDoneDays -FailedDays $QueueFailedDays

$mode = if ($DryRun) { "Dry run" } else { "Cleanup" }
$mb = [Math]::Round($DeletedBytes / 1MB, 2)
Write-Host "$mode complete. Files matched: $DeletedFiles. Space: $mb MB."
