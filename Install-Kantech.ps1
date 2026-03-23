#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Interactive installer for the Kantech EntraPass MySQL integration.

.DESCRIPTION
    Prompts for all configuration values, writes .env, and installs the
    selected components. Re-run at any time to update settings or reinstall.

    Components:
      1) Nightly card export  - Windows Scheduled Task
      2) Door event monitor   - Windows Service
      3) MySQL views          - kantech_events view (run once)
      4) MySQL triggers       - change-log triggers (requires MySQL admin)
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectDir = $PSScriptRoot

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Header {
    param([string]$Title)
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor Cyan
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "  -- $Title" -ForegroundColor Yellow
}

function Prompt-Value {
    param([string]$Label, [string]$Default = '', [switch]$Secret)
    $display = if ($Secret -and $Default) { '(unchanged)' } elseif ($Default) { $Default } else { '' }
    $prompt  = if ($display) { "  $Label [$display]" } else { "  $Label" }
    $input = Read-Host $prompt
    if ([string]::IsNullOrWhiteSpace($input)) { return $Default }
    return $input.Trim()
}

function Prompt-Bool {
    param([string]$Label, [bool]$Default = $true)
    $d = if ($Default) { 'Y/n' } else { 'y/N' }
    $input = Read-Host "  $Label [$d]"
    if ([string]::IsNullOrWhiteSpace($input)) { return $Default }
    return ($input.Trim() -imatch '^y')
}

function Get-EnvOr {
    param([string]$Name, [string]$Default)
    $v = [System.Environment]::GetEnvironmentVariable($Name)
    if ($v) { $v } else { $Default }
}

function Load-ExistingEnv {
    $envFile = Join-Path $ProjectDir '.env'
    if (-not (Test-Path $envFile)) { return }
    Get-Content $envFile | Where-Object { $_ -match '^[A-Z_]+=.+$' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

function Backup-EnvFile {
    $envFile = Join-Path $ProjectDir '.env'
    if (-not (Test-Path $envFile)) { return }
    $stamp   = Get-Date -Format 'yyyyMMdd_HHmmss'
    $backDir = Join-Path $ProjectDir '.env.backups'
    if (-not (Test-Path $backDir)) { New-Item -ItemType Directory -Path $backDir | Out-Null }
    $dest = Join-Path $backDir ".env.$stamp"
    Copy-Item $envFile $dest
    Write-Host "  Existing .env backed up to: $dest" -ForegroundColor DarkGray
}

function Bool-Str { param([bool]$b) if ($b) { 'true' } else { 'false' } }

# ---------------------------------------------------------------------------
# Welcome
# ---------------------------------------------------------------------------

Write-Header "Kantech EntraPass MySQL Integration - Installer"
Write-Host ""
Write-Host "  This installer will:"
Write-Host "    - Prompt for all configuration settings"
Write-Host "    - Write .env (existing file will be backed up)"
Write-Host "    - Install the components you choose"
Write-Host ""
Write-Host "  Press ENTER at any prompt to keep the shown default."
Write-Host ""
$null = Read-Host "  Press ENTER to continue"

Load-ExistingEnv

# ---------------------------------------------------------------------------
# Section 1: EntraPass paths
# ---------------------------------------------------------------------------

Write-Header "Step 1 of 5 - EntraPass Paths"
Write-Host "  These paths point to your EntraPass installation." -ForegroundColor DarkGray
Write-Host "  Defaults match a standard EntraPass CE install." -ForegroundColor DarkGray

Write-Section "Advantage Database"
$DataDir    = Prompt-Value "EntraPass Data directory"    (Get-EnvOr 'KANTECH_DATA_DIR'    'C:\Program Files (x86)\Kantech\Server_CE\Data')
$ArchiveDir = Prompt-Value "EntraPass Archive directory" (Get-EnvOr 'KANTECH_ARCHIVE_DIR' 'C:\Program Files (x86)\Kantech\Server_CE\Archive')
$AsqlCmd    = Prompt-Value "asqlcmd.exe path"            (Get-EnvOr 'KANTECH_ASQLCMD'     'C:\Program Files (x86)\Advantage 12.0\ARC\asqlcmd.exe')

# ---------------------------------------------------------------------------
# Section 2: MySQL
# ---------------------------------------------------------------------------

Write-Header "Step 2 of 5 - MySQL Connection"
Write-Host "  Remote MySQL server that will receive the EntraPass data." -ForegroundColor DarkGray

Write-Section "Connection"
$MySqlHost     = Prompt-Value "MySQL host"                 (Get-EnvOr 'MYSQL_HOST'     '192.168.1.100')
$MySqlPort     = Prompt-Value "MySQL port"                 (Get-EnvOr 'MYSQL_PORT'     '3306')
$MySqlDatabase = Prompt-Value "MySQL database"             (Get-EnvOr 'MYSQL_DATABASE' 'kantech')
$MySqlUser     = Prompt-Value "MySQL user"                 (Get-EnvOr 'MYSQL_USER'     'kantech_user')
$MySqlPassword = Prompt-Value "MySQL password"             (Get-EnvOr 'MYSQL_PASSWORD' '') -Secret

# ---------------------------------------------------------------------------
# Section 3: Card export settings
# ---------------------------------------------------------------------------

Write-Header "Step 3 of 5 - Card Export Settings"
Write-Host "  The nightly export writes cardholder data to CSV + MySQL." -ForegroundColor DarkGray

Write-Section "Export"
$ExportOutputDir  = Prompt-Value "Output directory for CSV files"                (Get-EnvOr 'EXPORT_OUTPUT_DIR'  'C:\Exports\Kantech')
$ExportRetainDays = Prompt-Value "Days to keep old CSV files (0=forever)"        (Get-EnvOr 'EXPORT_RETAIN_DAYS' '30')
$ExportRunTime    = Prompt-Value "Run time in 24h format (e.g. 02:00)"           (Get-EnvOr 'EXPORT_RUN_TIME'    '02:00')

# ---------------------------------------------------------------------------
# Section 4: Monitor / service settings
# ---------------------------------------------------------------------------

Write-Header "Step 4 of 5 - Monitor Service Settings"
Write-Host "  The monitor service polls EntraPass and sends email alerts." -ForegroundColor DarkGray

Write-Section "Polling"
$PollSeconds = Prompt-Value "Poll interval in seconds (min 1, recommended 5)" (Get-EnvOr 'EVENT_POLL_SECONDS' '5')
$EventLogDir = Prompt-Value "Log output directory"                             (Get-EnvOr 'EVENT_LOG_DIR'      'C:\Exports\Kantech')

Write-Section "Enable/disable monitors"
$MonDoorEvents      = Prompt-Bool "Enable door event recording to MySQL"        ($env:MONITOR_DOOR_EVENTS      -ne 'false')
$MonDoorAlarms      = Prompt-Bool "Enable door alarm alerts (forced/held open)" ($env:MONITOR_DOOR_ALARMS      -ne 'false')
$MonAfterHours      = Prompt-Bool "Enable after-hours access alerts"            ($env:MONITOR_AFTER_HOURS      -ne 'false')
$MonRepeatedDenials = Prompt-Bool "Enable repeated denial alerts"               ($env:MONITOR_REPEATED_DENIALS -ne 'false')

Write-Section "SMTP email (no authentication)"
$SmtpHost = Prompt-Value "SMTP server host"            (Get-EnvOr 'SMTP_HOST' '192.168.1.1')
$SmtpPort = Prompt-Value "SMTP port"                   (Get-EnvOr 'SMTP_PORT' '25')
$SmtpFrom = Prompt-Value "From address"                (Get-EnvOr 'SMTP_FROM' 'kantech-alerts@school.org')
$SmtpTo   = Prompt-Value "To address(es) (comma-sep)" (Get-EnvOr 'SMTP_TO'   'admin@school.org')

Write-Section "Alert thresholds"
$HoursStart   = Prompt-Value "Business hours start (HH:MM 24h)"    (Get-EnvOr 'ALERT_HOURS_START'          '06:00')
$HoursEnd     = Prompt-Value "Business hours end (HH:MM 24h)"      (Get-EnvOr 'ALERT_HOURS_END'            '21:00')
$DenialCount  = Prompt-Value "Denial count to trigger alert"        (Get-EnvOr 'ALERT_DENIAL_COUNT'         '3')
$DenialWindow = Prompt-Value "Denial rolling window in minutes"     (Get-EnvOr 'ALERT_DENIAL_WINDOW_MINUTES' '15')

# ---------------------------------------------------------------------------
# Section 5: Component selection
# ---------------------------------------------------------------------------

Write-Header "Step 5 of 5 - Component Selection"
Write-Host "  Choose which components to install." -ForegroundColor DarkGray
Write-Host ""

$InstallCardExport = Prompt-Bool "Install nightly card export (Scheduled Task)"   $true
$InstallService    = Prompt-Bool "Install door event monitor (Windows Service)"    $true
$InstallViews      = Prompt-Bool "Create MySQL kantech_events view"                $false
$InstallTriggers   = Prompt-Bool "Apply MySQL change-log triggers (requires MySQL SUPER or log_bin_trust_function_creators=1)" $false

# ---------------------------------------------------------------------------
# Confirm and write .env
# ---------------------------------------------------------------------------

Write-Header "Writing Configuration"
Write-Host ""
Write-Host "  Settings to be written to .env:" -ForegroundColor White
Write-Host ("    MySQL:    {0}@{1}:{2}/{3}" -f $MySqlUser, $MySqlHost, $MySqlPort, $MySqlDatabase)
Write-Host ("    Export:   {0}, runs at {1}, keep {2}d" -f $ExportOutputDir, $ExportRunTime, $ExportRetainDays)
Write-Host ("    Service:  poll {0}s, logs to {1}" -f $PollSeconds, $EventLogDir)
Write-Host ("    Monitors: DoorEvents={0}  Alarms={1}  AfterHours={2}  Denials={3}" -f $MonDoorEvents, $MonDoorAlarms, $MonAfterHours, $MonRepeatedDenials)
Write-Host ("    SMTP:     {0} -> {1} via {2}:{3}" -f $SmtpFrom, $SmtpTo, $SmtpHost, $SmtpPort)
Write-Host ""

$confirm = Read-Host "  Write .env and install? [Y/n]"
if ($confirm -imatch '^n') {
    Write-Host "  Cancelled." -ForegroundColor Yellow
    exit 0
}

Backup-EnvFile

$envContent = @"
# =============================================================================
# Kantech EntraPass - Environment Configuration
# =============================================================================
# Loaded automatically by all scripts in this folder.
# Keep this file secure - it contains database credentials.
# Do NOT commit this file to source control.
# =============================================================================

# -----------------------------------------------------------------------------
# Advantage Database (EntraPass)
# -----------------------------------------------------------------------------
KANTECH_DATA_DIR=$DataDir
KANTECH_ARCHIVE_DIR=$ArchiveDir
KANTECH_ASQLCMD=$AsqlCmd

# -----------------------------------------------------------------------------
# MySQL - Remote database
# -----------------------------------------------------------------------------
MYSQL_HOST=$MySqlHost
MYSQL_PORT=$MySqlPort
MYSQL_DATABASE=$MySqlDatabase
MYSQL_USER=$MySqlUser
MYSQL_PASSWORD=$MySqlPassword

# -----------------------------------------------------------------------------
# Card export (Export-KantechCards.ps1 / Register-NightlyExport.ps1)
# EXPORT_RUN_TIME: 24h format, e.g. 02:00 = 2 AM
# EXPORT_RETAIN_DAYS: days to keep old CSV files (0 = keep forever)
# -----------------------------------------------------------------------------
EXPORT_OUTPUT_DIR=$ExportOutputDir
EXPORT_RETAIN_DAYS=$ExportRetainDays
EXPORT_RUN_TIME=$ExportRunTime

# -----------------------------------------------------------------------------
# Monitor service (Watch-Kantech.ps1 / Install-KantechEventService.ps1)
# EVENT_POLL_SECONDS: how often to check for new events (min 1, recommended 5)
# -----------------------------------------------------------------------------
EVENT_POLL_SECONDS=$PollSeconds
EVENT_LOG_DIR=$EventLogDir

# Enable/disable individual monitors (set to false to disable)
MONITOR_DOOR_EVENTS=$(Bool-Str $MonDoorEvents)
MONITOR_DOOR_ALARMS=$(Bool-Str $MonDoorAlarms)
MONITOR_AFTER_HOURS=$(Bool-Str $MonAfterHours)
MONITOR_REPEATED_DENIALS=$(Bool-Str $MonRepeatedDenials)

# -----------------------------------------------------------------------------
# Email alerts (no-auth SMTP)
# SMTP_TO: comma-separated list of recipients
# ALERT_HOURS_START / ALERT_HOURS_END: business hours in HH:MM (24h)
# ALERT_DENIAL_COUNT: denials within window to trigger alert
# ALERT_DENIAL_WINDOW_MINUTES: rolling window for repeated denial check
# -----------------------------------------------------------------------------
SMTP_HOST=$SmtpHost
SMTP_PORT=$SmtpPort
SMTP_FROM=$SmtpFrom
SMTP_TO=$SmtpTo

ALERT_HOURS_START=$HoursStart
ALERT_HOURS_END=$HoursEnd
ALERT_DENIAL_COUNT=$DenialCount
ALERT_DENIAL_WINDOW_MINUTES=$DenialWindow
"@

Set-Content -Path (Join-Path $ProjectDir '.env') -Value $envContent -Encoding UTF8
Write-Host "  .env written." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Install: Nightly card export (Scheduled Task)
# ---------------------------------------------------------------------------

if ($InstallCardExport) {
    Write-Header "Installing: Nightly Card Export"

    $taskName   = 'Kantech - Nightly Card Export'
    $scriptPath = Join-Path $ProjectDir 'Export-KantechCards.ps1'
    $scriptArgs = '-NonInteractive -NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '"'

    $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $scriptArgs
    $trigger   = New-ScheduledTaskTrigger -Daily -At $ExportRunTime
    $settings  = New-ScheduledTaskSettingsSet `
                     -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
                     -StartWhenAvailable `
                     -RunOnlyIfNetworkAvailable:$false `
                     -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "  Removed existing scheduled task."
    }

    Register-ScheduledTask `
        -TaskName    $taskName `
        -Description 'Exports EntraPass cardholder data to CSV and syncs to MySQL nightly' `
        -Action      $action `
        -Trigger     $trigger `
        -Settings    $settings `
        -Principal   $principal | Out-Null

    Write-Host "  Scheduled task '$taskName' registered." -ForegroundColor Green
    Write-Host "  Runs daily at $ExportRunTime under SYSTEM."
    Write-Host "  To test: Start-ScheduledTask -TaskName '$taskName'"
}

# ---------------------------------------------------------------------------
# Install: Door event monitor (Windows Service)
# ---------------------------------------------------------------------------

if ($InstallService) {
    Write-Header "Installing: Door Event Monitor Service"

    $ServiceName  = 'KantechEventMonitor'
    $DisplayName  = 'Kantech Door Event Monitor'
    $Description  = 'Monitors EntraPass door access events and streams them to MySQL in real time.'
    $ExePath      = Join-Path $ProjectDir 'KantechEventService.exe'
    $CscPath      = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
    $TemplateFile = Join-Path $ProjectDir 'KantechEventService.cs'
    $BuildFile    = Join-Path $ProjectDir 'KantechEventService.build.cs'

    if (-not (Test-Path $TemplateFile)) {
        Write-Warning "KantechEventService.cs not found at $TemplateFile - skipping."
    } elseif (-not (Test-Path $CscPath)) {
        Write-Warning "csc.exe not found at $CscPath - skipping."
    } else {
        $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Host "  Stopping existing service..."
            if ($existing.Status -eq 'Running') { Stop-Service -Name $ServiceName -Force }
            Start-Sleep -Seconds 2
            sc.exe delete $ServiceName | Out-Null
            Start-Sleep -Seconds 2
            Write-Host "  Existing service removed."
        }

        Write-Host "  Building $ExePath..."
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
            '/target:exe',
            ('/out:' + $ExePath),
            '/reference:C:\Windows\Microsoft.NET\Framework\v4.0.30319\System.ServiceProcess.dll',
            '/reference:C:\Windows\Microsoft.NET\Framework\v4.0.30319\System.dll',
            $BuildFile
        )

        & $CscPath @compileArgs
        Remove-Item $BuildFile -Force -ErrorAction SilentlyContinue

        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Compilation failed - service not installed."
        } else {
            Write-Host "  Build succeeded." -ForegroundColor Green

            New-Service `
                -Name           $ServiceName `
                -DisplayName    $DisplayName `
                -Description    $Description `
                -BinaryPathName $ExePath `
                -StartupType    Automatic | Out-Null

            sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null

            Write-Host "  Starting service..."
            Start-Service -Name $ServiceName
            Start-Sleep -Seconds 3
            $svc = Get-Service -Name $ServiceName
            $color = if ($svc.Status -eq 'Running') { 'Green' } else { 'Red' }
            Write-Host ("  Service status: {0}" -f $svc.Status) -ForegroundColor $color
            Write-Host "  Service log: $EventLogDir\KantechEventService.log"
        }
    }
}

# ---------------------------------------------------------------------------
# Install: MySQL views
# ---------------------------------------------------------------------------

if ($InstallViews) {
    Write-Header "Creating MySQL Views"
    $viewScript = Join-Path $ProjectDir 'Create-KantechEventsView.ps1'
    if (Test-Path $viewScript) {
        & powershell.exe -ExecutionPolicy Bypass -File $viewScript
    } else {
        Write-Warning "Create-KantechEventsView.ps1 not found - skipping."
    }
}

# ---------------------------------------------------------------------------
# Install: MySQL triggers
# ---------------------------------------------------------------------------

if ($InstallTriggers) {
    Write-Header "Applying MySQL Change-Log Triggers"
    Write-Host "  NOTE: Requires SUPER privilege or log_bin_trust_function_creators=1" -ForegroundColor Yellow
    $trigScript = Join-Path $ProjectDir 'Apply-Triggers.ps1'
    if (Test-Path $trigScript) {
        & powershell.exe -ExecutionPolicy Bypass -File $trigScript
    } else {
        Write-Warning "Apply-Triggers.ps1 not found - skipping."
    }
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Header "Installation Complete"
Write-Host ""
if ($InstallCardExport) {
    Write-Host ("  Card export:   Scheduled Task 'Kantech - Nightly Card Export' at {0}" -f $ExportRunTime) -ForegroundColor Green
}
if ($InstallService) {
    Write-Host "  Event monitor: Service 'KantechEventMonitor' (auto-start)" -ForegroundColor Green
}
if ($InstallViews) {
    Write-Host "  MySQL views:   kantech_events created" -ForegroundColor Green
}
if ($InstallTriggers) {
    Write-Host "  MySQL triggers: kantech_change_log + triggers applied" -ForegroundColor Green
}
Write-Host ""
Write-Host "  To re-run this installer after changing settings:"
Write-Host ('    powershell -ExecutionPolicy Bypass -File "' + $ProjectDir + '\Install-Kantech.ps1"')
Write-Host ""
