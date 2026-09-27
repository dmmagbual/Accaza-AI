# Registers a scheduled task that starts the laptop worker (hidden) whenever you sign in.
#   powershell -ExecutionPolicy Bypass -File worker\install-startup.ps1            install and start now
#   powershell -ExecutionPolicy Bypass -File worker\install-startup.ps1 -Remove    remove it
param([switch]$Remove)
$Name = "Accaza AI laptop worker"
if ($Remove) {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'worker[\\/]index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host "Removed."; return
}
$Script = Join-Path $PSScriptRoot "start-worker.ps1"
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
Start-ScheduledTask -TaskName $Name
Write-Host "Installed and started: '$Name'. It starts hidden each time you sign in."
Write-Host "Logs: $env:USERPROFILE\.accaza-ai\logs"
