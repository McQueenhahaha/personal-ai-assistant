$ErrorActionPreference = "Stop"

$TaskName = "Personal AI Assistant Autostart"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已删除计划任务: $TaskName"
} else {
  Write-Host "计划任务不存在，无需删除: $TaskName"
}
