<#
.SYNOPSIS
    Monitors EntraPass ADS tables, files, services, and event log for changes.

.DESCRIPTION
    Takes a baseline snapshot, then polls every N seconds. Any insert, update,
    or delete across watched tables is logged to watch-changes.jsonl with a
    before/after diff. Also monitors the Data directory for file writes and
    watches Windows Event Log for EntraPass entries.

    Run this BEFORE making changes in the EntraPass desktop, then stop it after.
    The output reveals exactly what the desktop application does under the hood.

.PARAMETER PollSeconds
    How often to poll the database (default: 2).

.PARAMETER OutputFile
    Path to the JSONL output file.

.PARAMETER Tables
    Comma-separated list of table names to watch. Defaults to all card/user tables.

.EXAMPLE
    # Start monitoring, make changes in EntraPass desktop, then Ctrl+C to stop
    .\Watch-KantechChanges.ps1

.EXAMPLE
    # Fast polling, custom output
    .\Watch-KantechChanges.ps1 -PollSeconds 1 -OutputFile C:\temp\changes.jsonl

.EXAMPLE
    # Skip Procmon (if not needed)
    .\Watch-KantechChanges.ps1 -NoProcmon
#>

[CmdletBinding()]
param(
    [int]    $PollSeconds = 2,
    [string] $OutputFile  = 'C:\Projects\Kantech\logs\watch-changes.jsonl',
    [string] $Tables      = 'Card,CardNumber,ItemCard,CardAccessGroup,ItemCardAccessGroup,CardLastAction,DeletedCard,AccessLevel,ItemAccessLevel,Audit,Schedule,Controller,Panel,Door,SysOption',
    [switch] $NoProcmon
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Load env
# ---------------------------------------------------------------------------
. (Join-Path $PSScriptRoot 'Load-Env.ps1')
Import-EnvFile -EnvFile (Join-Path $PSScriptRoot '.env')

$asqlcmd  = $env:KANTECH_ASQLCMD
$dataDir  = $env:KANTECH_DATA_DIR
$connStr  = "Data Source=$dataDir;ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;"

# ---------------------------------------------------------------------------
# Procmon
# ---------------------------------------------------------------------------
$procmonExe  = 'C:\Projects\Kantech\Procmon64.exe'
$procmonPml  = $null   # set below once OutputFile is resolved
$procmonProc = $null

function Start-Procmon {
    param([string]$PmlPath)
    if (-not (Test-Path $procmonExe)) {
        Write-Warning "Procmon64.exe not found at $procmonExe - skipping kernel capture."
        return $null
    }
    # /AcceptEula    — suppress license dialog
    # /Quiet         — no GUI prompts
    # /Minimized     — start minimized
    # /BackingFile   — capture file path (PML format)
    $procArgs = @("/AcceptEula", "/Quiet", "/Minimized", "/BackingFile", "`"$PmlPath`"")
    $proc = Start-Process -FilePath $procmonExe -ArgumentList $procArgs -PassThru -WindowStyle Minimized
    Write-Host "  Procmon PID $($proc.Id) capturing to: $PmlPath" -ForegroundColor DarkGray
    return $proc
}

function Stop-Procmon {
    param([System.Diagnostics.Process]$Proc, [string]$PmlPath)
    if (-not $Proc -or $Proc.HasExited) { return }
    # /Terminate saves the backing file and exits cleanly
    Start-Process -FilePath $procmonExe -ArgumentList "/Terminate" -Wait -WindowStyle Hidden
    Write-Host "  Procmon capture saved: $PmlPath" -ForegroundColor DarkGray
    Write-Host "  Open in Procmon and filter: Process Name  contains  EpCe OR EntraPass OR Kantech" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Log {
    param([hashtable]$Entry)
    $Entry['ts'] = (Get-Date).ToUniversalTime().ToString('o')
    $json = $Entry | ConvertTo-Json -Compress -Depth 10
    Add-Content -Path $OutputFile -Value $json -Encoding UTF8
}

function Invoke-AdsQuery {
    param([string]$Sql)
    $result = & $asqlcmd -CS $connStr -Q $Sql 2>&1
    if ($LASTEXITCODE -ne 0) { return @() }

    $lines = ($result -join "`n") -split "`r?`n" |
             Where-Object { $_ -and $_ -notmatch '^Finished\.' }

    if ($lines.Count -le 1) { return @() }

    # Parse CSV
    $csv = $lines -join "`n"
    try {
        return $csv | ConvertFrom-Csv
    } catch {
        return @()
    }
}

function Get-TableSnapshot {
    param([string]$Table)
    try {
        $rows = Invoke-AdsQuery "SELECT * FROM $Table ORDER BY 1, 2"
        # Convert to hashtable keyed by serialized row for fast diffing
        $snap = [ordered]@{}
        foreach ($row in $rows) {
            $key = ($row.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '|'
            $snap[$key] = $row
        }
        return $snap
    } catch {
        return [ordered]@{}
    }
}

function Diff-Snapshots {
    param(
        [string]     $Table,
        [hashtable]  $Before,
        [hashtable]  $After
    )
    $changes = @()

    # Rows in After but not Before = INSERT
    foreach ($key in $After.Keys) {
        if (-not $Before.ContainsKey($key)) {
            $changes += @{ operation = 'INSERT'; table = $Table; row = $After[$key] }
        }
    }

    # Rows in Before but not After = DELETE
    foreach ($key in $Before.Keys) {
        if (-not $After.ContainsKey($key)) {
            $changes += @{ operation = 'DELETE'; table = $Table; row = $Before[$key] }
        }
    }

    return $changes
}

function Get-ServiceSnapshot {
    $services = @('EpCeServiceGateway','Kantech.SmartService','KantechApiServer','KantechEventMonitor')
    $snap = @{}
    foreach ($svc in $services) {
        try {
            $s = Get-Service $svc -ErrorAction SilentlyContinue
            $snap[$svc] = if ($s) { $s.Status.ToString() } else { 'NotFound' }
        } catch { $snap[$svc] = 'Error' }
    }
    return $snap
}

# ---------------------------------------------------------------------------
# Setup output
# ---------------------------------------------------------------------------
$logDir = Split-Path $OutputFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$tableList   = $Tables -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$procmonPml  = $OutputFile -replace '\.jsonl$','.pml'

Write-Host ''
Write-Host 'Kantech Change Watcher' -ForegroundColor Cyan
Write-Host "  Output    : $OutputFile"
Write-Host "  Procmon   : $(if ($NoProcmon) { 'disabled' } else { $procmonPml })"
Write-Host "  Poll      : every ${PollSeconds}s"
Write-Host "  Tables    : $($tableList -join ', ')"
Write-Host ''

# Start Procmon before baseline so we capture everything from t=0
if (-not $NoProcmon) {
    Write-Host 'Starting Procmon kernel capture...' -ForegroundColor Yellow
    $procmonProc = Start-Procmon -PmlPath $procmonPml
    Start-Sleep -Milliseconds 800   # give Procmon time to initialise before we snapshot
}

Write-Host 'Taking baseline snapshot...' -ForegroundColor Yellow

# ---------------------------------------------------------------------------
# Baseline snapshot
# ---------------------------------------------------------------------------
$dbSnapshot  = @{}
foreach ($table in $tableList) {
    Write-Host "  $table..." -NoNewline
    $dbSnapshot[$table] = Get-TableSnapshot -Table $table
    Write-Host " $($dbSnapshot[$table].Count) rows" -ForegroundColor DarkGray
}

$svcSnapshot = Get-ServiceSnapshot
$fileEvents  = [System.Collections.Generic.List[string]]::new()

Write-Log @{
    type       = 'BASELINE'
    tables     = ($tableList | ForEach-Object { @{ table = $_; rowCount = $dbSnapshot[$_].Count } })
    services   = $svcSnapshot
    procmonPml = if ($NoProcmon) { $null } else { $procmonPml }
}

# ---------------------------------------------------------------------------
# File system watcher
# ---------------------------------------------------------------------------
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path                = $dataDir
$watcher.Filter              = '*.*'
$watcher.NotifyFilter        = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName
$watcher.IncludeSubdirectories = $false
$watcher.EnableRaisingEvents = $true

$fileAction = {
    $path = $Event.SourceEventArgs.FullPath
    $type = $Event.SourceEventArgs.ChangeType
    $script:fileEvents.Add("$type|$path")
}
Register-ObjectEvent $watcher Changed -Action $fileAction | Out-Null
Register-ObjectEvent $watcher Created -Action $fileAction | Out-Null
Register-ObjectEvent $watcher Renamed -Action $fileAction | Out-Null

Write-Host ''
Write-Host "Baseline complete. Watching for changes... (Ctrl+C to stop)" -ForegroundColor Green
Write-Host ''

# ---------------------------------------------------------------------------
# Poll loop
# ---------------------------------------------------------------------------
$pollCount = 0

try {
    while ($true) {
        Start-Sleep -Seconds $PollSeconds
        $pollCount++
        $anyChange = $false

        # --- Database diff ---
        foreach ($table in $tableList) {
            $newSnap = Get-TableSnapshot -Table $table
            $changes = Diff-Snapshots -Table $table -Before $dbSnapshot[$table] -After $newSnap

            if ($changes.Count -gt 0) {
                $anyChange = $true
                foreach ($change in $changes) {
                    Write-Host "  [$table] $($change.operation)" -ForegroundColor $(
                        if ($change.operation -eq 'INSERT') { 'Green' }
                        elseif ($change.operation -eq 'DELETE') { 'Red' }
                        else { 'Yellow' }
                    )
                    # Show changed columns
                    $change.row.PSObject.Properties | ForEach-Object {
                        if ($_.Value) {
                            Write-Host "    $($_.Name) = $($_.Value)" -ForegroundColor DarkGray
                        }
                    }
                    Write-Log @{
                        type      = 'DB_CHANGE'
                        operation = $change.operation
                        table     = $change.table
                        row       = $change.row
                        poll      = $pollCount
                    }
                }
                $dbSnapshot[$table] = $newSnap
            }
        }

        # --- Service diff ---
        $newSvc = Get-ServiceSnapshot
        foreach ($svc in $newSvc.Keys) {
            if ($newSvc[$svc] -ne $svcSnapshot[$svc]) {
                $anyChange = $true
                Write-Host "  [SERVICE] $svc : $($svcSnapshot[$svc]) -> $($newSvc[$svc])" -ForegroundColor Magenta
                Write-Log @{
                    type    = 'SERVICE_CHANGE'
                    service = $svc
                    before  = $svcSnapshot[$svc]
                    after   = $newSvc[$svc]
                    poll    = $pollCount
                }
                $svcSnapshot[$svc] = $newSvc[$svc]
            }
        }

        # --- File events ---
        if ($fileEvents.Count -gt 0) {
            $anyChange = $true
            # Deduplicate (rapid writes trigger multiple events)
            $unique = $fileEvents | Sort-Object -Unique
            $fileEvents.Clear()
            foreach ($ev in $unique) {
                $parts = $ev -split '\|', 2
                Write-Host "  [FILE] $($parts[0]) : $(Split-Path $parts[1] -Leaf)" -ForegroundColor Cyan
                Write-Log @{
                    type      = 'FILE_CHANGE'
                    changeType = $parts[0]
                    path      = $parts[1]
                    poll      = $pollCount
                }
            }
        }

        # --- Windows Event Log (last 5s) ---
        try {
            $since = (Get-Date).AddSeconds(-($PollSeconds + 1))
            $evtLogs = @('Application','System')
            foreach ($log in $evtLogs) {
                $evts = Get-EventLog -LogName $log -After $since -EntryType Error,Warning,Information -ErrorAction SilentlyContinue |
                        Where-Object { $_.Source -match 'Kantech|EntraPass|EpCe|Gateway' }
                foreach ($evt in $evts) {
                    $anyChange = $true
                    Write-Host "  [EVENT] [$log] $($evt.Source): $($evt.Message.Substring(0, [Math]::Min(120,$evt.Message.Length)))" -ForegroundColor DarkYellow
                    Write-Log @{
                        type      = 'EVENT_LOG'
                        log       = $log
                        source    = $evt.Source
                        eventId   = $evt.EventID
                        entryType = $evt.EntryType.ToString()
                        message   = $evt.Message
                        poll      = $pollCount
                    }
                }
            }
        } catch { }

        if ($anyChange) {
            Write-Host ''
        }
    }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    Unregister-Event -SourceIdentifier * -ErrorAction SilentlyContinue

    if (-not $NoProcmon -and $procmonProc) {
        Write-Host 'Stopping Procmon...' -ForegroundColor Yellow
        Stop-Procmon -Proc $procmonProc -PmlPath $procmonPml
    }

    Write-Host ''
    Write-Host "Stopped after $pollCount polls." -ForegroundColor Cyan
    Write-Host "  JSONL  : $OutputFile" -ForegroundColor Cyan
    if (-not $NoProcmon -and $procmonPml) {
        Write-Host "  PML    : $procmonPml  (open in Procmon64.exe)" -ForegroundColor Cyan
        Write-Host "  Filter : Process Name  contains  EpCe" -ForegroundColor DarkGray
        Write-Host "  Filter : Process Name  contains  EntraPass" -ForegroundColor DarkGray
    }
    Write-Log @{ type = 'STOPPED'; polls = $pollCount; procmonPml = $procmonPml }
}
