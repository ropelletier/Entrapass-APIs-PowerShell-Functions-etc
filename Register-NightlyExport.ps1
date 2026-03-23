#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Registers the Kantech card export as a nightly Windows Scheduled Task.

.NOTES
    Run this script once as Administrator to set up the schedule.
    The task runs daily at 2:00 AM under the SYSTEM account.
#>

# Load .env
. (Join-Path $PSScriptRoot 'Load-Env.ps1')
Import-EnvFile

$taskName    = 'Kantech - Nightly Card Export'
$taskDescr   = 'Exports EntraPass cardholder data to CSV and syncs to MySQL nightly'
$scriptPath  = 'C:\Projects\Kantech\Export-KantechCards.ps1'
$runTime     = if ($env:EXPORT_RUN_TIME) { $env:EXPORT_RUN_TIME } else { '02:00' }

# Script runs without args — it loads .env itself at runtime
$scriptArgs = "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument $scriptArgs

$trigger = New-ScheduledTaskTrigger -Daily -At $runTime

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false `
    -MultipleInstances IgnoreNew

# Runs as SYSTEM - no password needed, has local file access
$principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest

# Remove existing task if present
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task."
}

Register-ScheduledTask `
    -TaskName    $taskName `
    -Description $taskDescr `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -Principal   $principal

Write-Host ""
Write-Host "Scheduled task '$taskName' registered."
Write-Host "Runs daily at $runTime under SYSTEM account."
Write-Host ""
Write-Host "To run it immediately for testing:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
