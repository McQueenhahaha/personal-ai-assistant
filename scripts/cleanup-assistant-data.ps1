param(
  [int]$LogDays = 7,
  [int]$TempDays = 2,
  [int]$ComputeCacheDays = 7,
  [int]$DigestDays = 14,
  [int]$MailSnapshotDays = 14,
  [int]$QueueDoneDays = 14,
  [int]$QueueFailedDays = 30,
  [int]$ScreenshotDays = 3,
  [int]$BrowserCacheDays = 7,
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
    [int]$Days,
    # 有些文件的价值恰恰在于"长期保留"，通配清理会把它们一并删掉。
    [string[]]$Exclude = @()
  )

  if ($Days -lt 1) { return }
  if (-not (Test-Path -LiteralPath $Dir)) { return }
  if (-not (Test-InRoot -Path $Dir)) { throw "Refusing to clean outside project root: $Dir" }

  $cutoff = $Now.AddDays(-$Days)
  Get-ChildItem -LiteralPath $Dir -File -Filter $Filter -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $Exclude -notcontains $_.Name } |
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

# audit.jsonl 记录的是每一次特权判定与批准，长期保留正是它的用途；
# 而 data\logs 走的是 7 天通配清理，一直在把它整个删掉 —— 出事时最该查的
# 那份记录恰好没了。它现在才 1.8KB，不需要另建轮转或归档机制。
Remove-OldFiles -Dir (Join-Path $Root "data\logs") -Filter "*" -Days $LogDays -Exclude @("audit.jsonl")
Remove-OldFiles -Dir (Join-Path $Root "data\tmp") -Filter "*" -Days $TempDays
Remove-OldFiles -Dir (Join-Path $Root "data\appdata\NVIDIA\ComputeCache") -Filter "*" -Days $ComputeCacheDays
Remove-OldFiles -Dir (Join-Path $Root "data\digest-archive") -Filter "*.txt" -Days $DigestDays
Remove-OldFiles -Dir (Join-Path $Root "data\school-mail-drop") -Filter "outlook-*-snapshot-*.md" -Days $MailSnapshotDays
Remove-OldFiles -Dir (Join-Path $Root "data\personal-mail-drop") -Filter "gmail-snapshot-*.md" -Days $MailSnapshotDays

# 真正在长的是这两个，之前一个都没被扫到：截图 41MB、浏览器资料 122MB。
# 截图是屏幕内容，留着既占空间也是隐私面，3 天足够排障用。
Remove-OldFiles -Dir (Join-Path $Root "data\screenshots") -Filter "*.png" -Days $ScreenshotDays

# 浏览器资料**绝不能**整目录按天扫：Cookies、Login Data、Preferences 这些
# 长期不写，一扫就把登录态和配置删掉，下次 /web 全部要重新登录。
# 只清可重建的缓存子目录。
foreach ($cache in @("Default\Cache", "Default\Code Cache", "Default\GPUCache", "Default\Service Worker\CacheStorage", "GrShaderCache", "ShaderCache")) {
  Remove-OldFiles -Dir (Join-Path $Root "data\browser-profile\$cache") -Filter "*" -Days $BrowserCacheDays
}
Remove-OldQueueFiles -QueueRoot (Join-Path $Root "data\queues") -DoneDays $QueueDoneDays -FailedDays $QueueFailedDays

$mode = if ($DryRun) { "Dry run" } else { "Cleanup" }
$mb = [Math]::Round($DeletedBytes / 1MB, 2)
Write-Host "$mode complete. Files matched: $DeletedFiles. Space: $mb MB."
