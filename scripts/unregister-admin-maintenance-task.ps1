$ErrorActionPreference = "Stop"

$TaskName = "PAI Admin Maintenance"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($null -ne $Task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已删除计划任务: $TaskName"
}
else {
  Write-Host "计划任务不存在: $TaskName"
}
