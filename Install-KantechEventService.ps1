#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Builds and installs the Kantech Door Event Monitor as a Windows service.

.NOTES
    Run once as Administrator. Re-run to update settings or rebuild.
#>

# Load .env
. (Join-Path $PSScriptRoot 'Load-Env.ps1')
Import-EnvFile

$MySqlHost     = $env:MYSQL_HOST
$MySqlPort     = $env:MYSQL_PORT
$MySqlDatabase = $env:MYSQL_DATABASE
$MySqlUser     = $env:MYSQL_USER
$MySqlPassword = $env:MYSQL_PASSWORD
$PollSeconds   = if ($env:EVENT_POLL_SECONDS) { $env:EVENT_POLL_SECONDS } else { '5' }

$ServiceName   = 'KantechEventMonitor'
$DisplayName   = 'Kantech Door Event Monitor'
$Description   = 'Monitors EntraPass door access events and streams them to MySQL in real time.'
$ProjectDir    = 'C:\Projects\Kantech'
$ExePath       = "$ProjectDir\KantechEventService.exe"
$CscPath       = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
$TemplateFile  = "$ProjectDir\KantechEventService.cs"
$BuildFile     = "$ProjectDir\KantechEventService.build.cs"

# ---------------------------------------------------------------------------
# Stop and remove existing service if present
# ---------------------------------------------------------------------------

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing service..."
    if ($existing.Status -eq 'Running') { Stop-Service -Name $ServiceName -Force }
    Start-Sleep -Seconds 2
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    Write-Host "Existing service removed."
}

# ---------------------------------------------------------------------------
# Inject credentials into source and compile
# ---------------------------------------------------------------------------

Write-Host "Building $ExePath..."

$src = Get-Content $TemplateFile -Raw
$src = $src `
    -replace '%%MYSQL_HOST%%',     $MySqlHost `
    -replace '%%MYSQL_PORT%%',     $MySqlPort `
    -replace '%%MYSQL_DATABASE%%', $MySqlDatabase `
    -replace '%%MYSQL_USER%%',     $MySqlUser `
    -replace '%%MYSQL_PASSWORD%%', $MySqlPassword `
    -replace '%%POLL_SECONDS%%',   $PollSeconds

Set-Content -Path $BuildFile -Value $src -Encoding UTF8

$compileArgs = @(
    "/target:exe",
    "/out:`"$ExePath`"",
    "/reference:C:\Windows\Microsoft.NET\Framework\v4.0.30319\System.ServiceProcess.dll",
    "/reference:C:\Windows\Microsoft.NET\Framework\v4.0.30319\System.dll",
    "`"$BuildFile`""
)

& $CscPath @compileArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed. Check errors above."
    exit 1
}

Remove-Item $BuildFile -Force
Write-Host "Build succeeded: $ExePath"

# ---------------------------------------------------------------------------
# Install the service
# ---------------------------------------------------------------------------

New-Service `
    -Name        $ServiceName `
    -DisplayName $DisplayName `
    -Description $Description `
    -BinaryPathName $ExePath `
    -StartupType Automatic | Out-Null

# Configure failure recovery: restart on failure (3 attempts)
sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null

Write-Host ""
Write-Host "Service '$ServiceName' installed."
Write-Host ""
Write-Host "Starting service..."
Start-Service -Name $ServiceName
Start-Sleep -Seconds 3
Get-Service -Name $ServiceName | Select-Object Name, Status, StartType
Write-Host ""
Write-Host "Log file: C:\Exports\Kantech\KantechEventService.log"
Write-Host "Event log: C:\Exports\Kantech\DoorEvents_YYYY-MM.log"
