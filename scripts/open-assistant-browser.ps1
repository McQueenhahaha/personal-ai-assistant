$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ChromePath = if ($env:ASSISTANT_CHROME_PATH) {
  $env:ASSISTANT_CHROME_PATH
} else {
  "D:\Program Files\Google\Chrome\Application\chrome.exe"
}
$ProfilePath = if ($env:ASSISTANT_BROWSER_PROFILE) {
  [System.IO.Path]::GetFullPath($env:ASSISTANT_BROWSER_PROFILE)
} else {
  Join-Path $ProjectRoot "data\browser-profile"
}

if (-not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) {
  throw "找不到 Chrome：$ChromePath。请设置 ASSISTANT_CHROME_PATH 后重试。"
}

New-Item -ItemType Directory -Force -Path $ProfilePath | Out-Null

Write-Host "在这个窗口里登录你要让助手访问的网站，登录态会被助手复用。登完直接关窗口即可。"
Write-Host "浏览器资料目录：$ProfilePath"

Start-Process -FilePath $ChromePath -ArgumentList @(
  "--user-data-dir=`"$ProfilePath`"",
  "--no-first-run"
) -Wait
