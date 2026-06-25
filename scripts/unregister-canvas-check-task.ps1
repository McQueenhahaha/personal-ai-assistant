param(
  [string]$TaskName = "Personal AI Canvas Check"
)

$ErrorActionPreference = "Stop"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Unregistered task: $TaskName"
} else {
  Write-Host "Task does not exist: $TaskName"
}
