param(
  [string]$OutFile,
  [int]$Display = -1
)

$ErrorActionPreference = "Stop"

try {
  . "$PSScriptRoot\openclaw-env.ps1"
  $env:APPDATA = [Environment]::GetFolderPath("ApplicationData")

  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms

  $Root = Split-Path -Parent $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($OutFile)) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ss-fffZ")
    $OutFile = Join-Path $Root "data\screenshots\screen-$stamp.png"
  } elseif (-not [IO.Path]::IsPathRooted($OutFile)) {
    $OutFile = Join-Path $Root $OutFile
  }
  $OutFile = [IO.Path]::GetFullPath($OutFile)
  $dataPrefix = [IO.Path]::GetFullPath((Join-Path $Root "data")) + [IO.Path]::DirectorySeparatorChar
  if (-not $OutFile.StartsWith($dataPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutFile must be inside the project's data directory."
  }

  $screens = @([System.Windows.Forms.Screen]::AllScreens)
  if ($screens.Count -eq 0) {
    throw "No displays were detected in the current desktop session."
  }
  if ($Display -ge 0) {
    if ($Display -ge $screens.Count) {
      throw "Display index $Display is out of range. Detected $($screens.Count) display(s)."
    }
    $screen = $screens[$Display]
  } else {
    $screen = $screens | Where-Object { $_.Primary } | Select-Object -First 1
  }
  if (-not $screen) {
    throw "The primary display could not be identified."
  }

  $parent = Split-Path -Parent $OutFile
  New-Item -ItemType Directory -Force -Path $parent | Out-Null

  $bounds = $screen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  # 用 Write-Output 而不是 [Console]::Out.WriteLine —— 后者直接写进程的 stdout 句柄，
  # 绕开 PowerShell 的成功流：子进程调用(spawnSync 读管道)拿得到，但**进程内 & 调用拿不到**。
  # 交互式 runner 正是进程内调用，曾因此拿到空输出、报"没有返回预期目录内的 PNG 绝对路径"。
  # Write-Output 两种调用方式都能捕获。
  Write-Output $OutFile
} catch {
  [Console]::Error.WriteLine("Screenshot failed: $($_.Exception.Message)")
  exit 1
}
