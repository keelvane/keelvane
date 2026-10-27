# Per-user logon task for the service. No admin rights. Only task names that start with "Keelvane" are accepted.
param([Parameter(Mandatory)][ValidateSet('create','has','remove')][string]$Action, [Parameter(Mandatory)][string]$Name,
      [string]$Execute, [string]$Argument, [string]$WorkDir)
$ErrorActionPreference = 'Stop'
if ($Name -notlike 'Keelvane*') { throw 'task name must start with Keelvane' }
switch ($Action) {
  'has' { if (-not (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)) { exit 3 } }
  'remove' { if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $Name -Confirm:$false } }
  'create' {
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $act = New-ScheduledTaskAction -Execute $Execute -Argument $Argument -WorkingDirectory $WorkDir
    $trg = New-ScheduledTaskTrigger -AtLogOn -User $me
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    $pri = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $Name -Action $act -Trigger $trg -Settings $set -Principal $pri -Force | Out-Null
  }
}
