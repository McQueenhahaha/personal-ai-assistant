param(
  [int]$Days = 7,
  [int]$MaxMessages = 40,
  [string]$AccountContains = "rmit.edu.au",
  [string]$OutDir,
  [int]$SyncWaitSeconds = 45,
  [switch]$NoSync
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\openclaw-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $Root "data\school-mail-drop"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Convert-ToSnippet {
  param([string]$Text, [int]$MaxLength = 1400)
  if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
  $clean = ($Text -replace "`r", "`n") -replace "`n{3,}", "`n`n"
  $clean = $clean.Trim()
  if ($clean.Length -gt $MaxLength) {
    return $clean.Substring(0, $MaxLength) + "`n..."
  }
  return $clean
}

function Start-OutlookSync {
  param(
    [object]$Namespace,
    [int]$WaitSeconds
  )

  if ($WaitSeconds -lt 0) { $WaitSeconds = 0 }

  try {
    $Namespace.SendAndReceive($false)
  } catch {
    Write-Warning "Outlook Send/Receive did not start: $($_.Exception.Message)"
  }

  try {
    for ($i = 1; $i -le $Namespace.SyncObjects.Count; $i++) {
      try {
        $Namespace.SyncObjects.Item($i).Start()
      } catch {
        continue
      }
    }
  } catch {
    Write-Warning "Outlook SyncObjects were not available: $($_.Exception.Message)"
  }

  if ($WaitSeconds -gt 0) {
    Start-Sleep -Seconds $WaitSeconds
  }
}

$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace("MAPI")
if (-not $NoSync) {
  Start-OutlookSync -Namespace $namespace -WaitSeconds $SyncWaitSeconds
}
$cutoff = (Get-Date).AddDays(-1 * [Math]::Abs($Days))
$messages = New-Object System.Collections.Generic.List[object]

for ($i = 1; $i -le $namespace.Stores.Count; $i++) {
  $store = $namespace.Stores.Item($i)
  $storeName = [string]$store.DisplayName
  if ($storeName -notmatch [regex]::Escape($AccountContains)) { continue }

  try {
    $inbox = $store.GetDefaultFolder(6)
  } catch {
    continue
  }

  $items = $inbox.Items
  $items.Sort("[ReceivedTime]", $true)
  $checked = 0

  foreach ($item in $items) {
    if ($messages.Count -ge $MaxMessages) { break }
    if ($checked -ge ($MaxMessages * 8)) { break }
    $checked++

    try {
      if ([string]$item.MessageClass -notlike "IPM.Note*") { continue }
      $received = [datetime]$item.ReceivedTime
      if ($received -lt $cutoff) { break }

      $messages.Add([pscustomobject]@{
        Store = $storeName
        Subject = [string]$item.Subject
        From = [string]$item.SenderName
        SenderEmail = [string]$item.SenderEmailAddress
        Received = $received
        Body = Convert-ToSnippet ([string]$item.Body)
      })
    } catch {
      continue
    }
  }
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ssZ")
$outFile = Join-Path $OutDir "outlook-rmit-snapshot-$stamp.md"

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# RMIT Outlook snapshot")
$lines.Add("")
$lines.Add("- Exported: $((Get-Date).ToString("o"))")
$lines.Add("- Account filter: $AccountContains")
$lines.Add("- Window: last $Days day(s)")
$lines.Add("- Messages: $($messages.Count)")
$lines.Add("")

foreach ($message in $messages) {
  $lines.Add("## $($message.Subject)")
  $lines.Add("")
  $lines.Add("- From: $($message.From) <$($message.SenderEmail)>")
  $lines.Add("- Received: $($message.Received.ToString("yyyy-MM-dd HH:mm"))")
  $lines.Add("- Mailbox: $($message.Store)")
  $lines.Add("")
  $lines.Add($message.Body)
  $lines.Add("")
}

$lines | Set-Content -LiteralPath $outFile -Encoding UTF8
Write-Host "Exported $($messages.Count) Outlook message(s) to $outFile"
