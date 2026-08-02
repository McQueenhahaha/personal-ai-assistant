function Get-BridgeRestartState {
  param(
    [Parameter(Mandatory = $true)]
    [int]$CurrentBackoffSeconds,

    [Parameter(Mandatory = $true)]
    [double]$RanSeconds,

    [Parameter(Mandatory = $true)]
    [int]$ExitCode
  )

  $backoffSeconds = $CurrentBackoffSeconds
  if ($RanSeconds -gt 60) {
    $backoffSeconds = 2
  }

  if ($ExitCode -eq 0) {
    return [PSCustomObject]@{
      WaitSeconds = 2
      NextBackoffSeconds = $backoffSeconds
    }
  }

  return [PSCustomObject]@{
    WaitSeconds = $backoffSeconds
    NextBackoffSeconds = [Math]::Min(30, $backoffSeconds * 2)
  }
}

Export-ModuleMember -Function Get-BridgeRestartState
