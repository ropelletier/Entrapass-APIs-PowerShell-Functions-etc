#Requires -Version 5.1
<#
.SYNOPSIS
    Live-monitors Kantech EntraPass door access events and streams them to MySQL.

.DESCRIPTION
    Polls the EntraPass archive table for the current day every few seconds,
    picks up new rows since the last processed PkSequence, joins them with
    Door/Card/EventType lookups, and inserts into MySQL.

    Handles the midnight day-rollover automatically (switches to the new
    archive file and resets the sequence tracker).

    Designed to run indefinitely as a Windows service via KantechEventService.exe.

.PARAMETER MySqlHost     Remote MySQL server hostname or IP
.PARAMETER MySqlPort     MySQL port (default 3306)
.PARAMETER MySqlDatabase Target database name
.PARAMETER MySqlUser     MySQL username
.PARAMETER MySqlPassword MySQL password
.PARAMETER PollSeconds   How often to poll for new events (default 5)
.PARAMETER LogDir        Directory for log files
#>

[CmdletBinding()]
param (
    [string]$ArchiveDir    = '',
    [string]$DataDir       = '',
    [string]$AsqlCmd       = '',
    [string]$MySqlHost     = '',
    [string]$MySqlPort     = '',
    [string]$MySqlDatabase = '',
    [string]$MySqlUser     = '',
    [string]$MySqlPassword = '',
    [int]$PollSeconds      = 0,
    [string]$LogDir        = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load .env — provides defaults for any param left blank
. (Join-Path $PSScriptRoot 'Load-Env.ps1')
Import-EnvFile

if (-not $ArchiveDir)    { $ArchiveDir    = $env:KANTECH_ARCHIVE_DIR }
if (-not $DataDir)       { $DataDir       = $env:KANTECH_DATA_DIR }
if (-not $AsqlCmd)       { $AsqlCmd       = $env:KANTECH_ASQLCMD }
if (-not $MySqlHost)     { $MySqlHost     = $env:MYSQL_HOST }
if (-not $MySqlPort)     { $MySqlPort     = $env:MYSQL_PORT }
if (-not $MySqlDatabase) { $MySqlDatabase = $env:MYSQL_DATABASE }
if (-not $MySqlUser)     { $MySqlUser     = $env:MYSQL_USER }
if (-not $MySqlPassword) { $MySqlPassword = $env:MYSQL_PASSWORD }
if ($PollSeconds -eq 0)  { $PollSeconds   = [int]$env:EVENT_POLL_SECONDS }
if (-not $LogDir)        { $LogDir        = $env:EVENT_LOG_DIR }

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $entry = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    $logFile = Join-Path $LogDir "DoorEvents_$(Get-Date -Format 'yyyy-MM').log"
    Add-Content -Path $logFile -Value $entry
    Write-Host $entry
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

$mysqlDll = Join-Path $PSScriptRoot 'MySqlConnector.dll'

foreach ($req in @($AsqlCmd, $mysqlDll)) {
    if (-not (Test-Path $req)) {
        Write-Log "Required file not found: $req" 'ERROR'; exit 1
    }
}

foreach ($dep in @('System.Buffers.dll','System.Runtime.CompilerServices.Unsafe.dll','System.Threading.Tasks.Extensions.dll','System.Memory.dll')) {
    $depPath = Join-Path $PSScriptRoot $dep
    if (Test-Path $depPath) { try { Add-Type -Path $depPath } catch {} }
}
try { Add-Type -Path $mysqlDll } catch { Write-Log "Failed to load MySqlConnector.dll: $_" 'ERROR'; exit 1 }

# ---------------------------------------------------------------------------
# MySQL helpers
# ---------------------------------------------------------------------------

function Connect-MySQL {
    $conn = New-Object MySqlConnector.MySqlConnection
    $conn.ConnectionString = "Server=$MySqlHost;Port=$MySqlPort;Database=$MySqlDatabase;Uid=$MySqlUser;Password=$MySqlPassword;SslMode=None;Connect Timeout=30;Connection Lifetime=300;"
    $conn.Open()
    return $conn
}

function Ensure-Tables {
    param($conn)
    $ddl = @"
CREATE TABLE IF NOT EXISTS kantech_door_events (
    EventID         BIGINT         NOT NULL AUTO_INCREMENT,
    ArchiveDate     DATE           NOT NULL,
    PkSequence      INT            NOT NULL,
    EventDateTime   DATETIME       NOT NULL,
    ServerDateTime  DATETIME       NOT NULL,
    EventTypeID     INT            NOT NULL,
    EventType       VARCHAR(255)   NOT NULL DEFAULT '',
    DoorID          INT            NULL,
    DoorName        VARCHAR(255)   NOT NULL DEFAULT '',
    CardholderID    INT            NULL,
    CardholderName  VARCHAR(255)   NOT NULL DEFAULT '',
    CardNumber      VARCHAR(50)    NOT NULL DEFAULT '',
    AccessGranted   TINYINT        NOT NULL DEFAULT 0,
    Cluster         INT            NOT NULL DEFAULT 0,
    Site            INT            NOT NULL DEFAULT 0,
    InsertedAt      DATETIME       NOT NULL,
    PRIMARY KEY (EventID),
    UNIQUE KEY uq_archive_seq (ArchiveDate, PkSequence),
    KEY idx_event_datetime (EventDateTime),
    KEY idx_cardholder   (CardholderID),
    KEY idx_door         (DoorID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kantech_event_cursor (
    CursorKey       VARCHAR(50)    NOT NULL,
    ArchiveDate     DATE           NOT NULL,
    LastPkSequence  INT            NOT NULL DEFAULT 0,
    UpdatedAt       DATETIME       NOT NULL,
    PRIMARY KEY (CursorKey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"@
    $cmd = $conn.CreateCommand()
    # Execute each statement separately
    foreach ($stmt in ($ddl -split ';' | Where-Object { $_.Trim() -ne '' })) {
        $cmd.CommandText = $stmt.Trim()
        $cmd.ExecuteNonQuery() | Out-Null
    }
}

function Get-Cursor {
    param($conn)
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT ArchiveDate, LastPkSequence FROM kantech_event_cursor WHERE CursorKey = 'main'"
    $reader = $cmd.ExecuteReader()
    if ($reader.Read()) {
        $result = @{ Date = $reader.GetDateTime(0).Date; Seq = $reader.GetInt32(1) }
    } else {
        $result = @{ Date = [datetime]::Today; Seq = 0 }
    }
    $reader.Close()
    return $result
}

function Save-Cursor {
    param($conn, [datetime]$date, [int]$seq)
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = @"
INSERT INTO kantech_event_cursor (CursorKey, ArchiveDate, LastPkSequence, UpdatedAt)
VALUES ('main', @d, @s, NOW())
ON DUPLICATE KEY UPDATE ArchiveDate=@d, LastPkSequence=@s, UpdatedAt=NOW()
"@
    $cmd.Parameters.AddWithValue('@d', $date.ToString('yyyy-MM-dd')) | Out-Null
    $cmd.Parameters.AddWithValue('@s', $seq) | Out-Null
    $cmd.ExecuteNonQuery() | Out-Null
}

# ---------------------------------------------------------------------------
# ADS query helper — runs asqlcmd and returns parsed rows as PSObjects
# ---------------------------------------------------------------------------

function Invoke-AdsQuery {
    param([string]$ConnStr, [string]$Sql)

    $tmpFile = [System.IO.Path]::GetTempFileName()
    try {
        & $AsqlCmd -CS $ConnStr -Q $Sql > $tmpFile 2>&1
        if ($LASTEXITCODE -ne 0) {
            $err = Get-Content $tmpFile -Raw
            throw "asqlcmd error: $err"
        }
        $lines = @(Get-Content $tmpFile | Where-Object { $_ -notmatch '^Finished\.' })
        if ($lines.Count -le 1) { return @() }
        return @($lines | ConvertFrom-Csv)
    } finally {
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Access-granted event type IDs (used to set AccessGranted flag)
# ---------------------------------------------------------------------------

$grantedTypes = @(202, 203, 225, 908, 913, 914, 934)   # Access granted variants

# ---------------------------------------------------------------------------
# Event type cache (loaded once, refreshed hourly)
# ---------------------------------------------------------------------------

$eventTypeCache   = @{}
$eventTypeCacheAt = [datetime]::MinValue
$dataCsConn       = "Data Source=$DataDir;ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;"

function Refresh-EventTypeCache {
    $rows = Invoke-AdsQuery -ConnStr $dataCsConn -Sql "SELECT PkEventType, Description FROM eventtype"
    $script:eventTypeCache = @{}
    foreach ($r in $rows) { $script:eventTypeCache[[int]$r.PkEventType] = $r.Description }
    $script:eventTypeCacheAt = [datetime]::Now
    Write-Log "Event type cache loaded ($($script:eventTypeCache.Count) types)"
}

# ---------------------------------------------------------------------------
# Main polling loop
# ---------------------------------------------------------------------------

Write-Log "Kantech door event monitor starting (poll every ${PollSeconds}s)"

$mysqlConn = Connect-MySQL
Write-Log "MySQL connected"
Ensure-Tables -conn $mysqlConn
Write-Log "MySQL tables verified"

$cursor = Get-Cursor -conn $mysqlConn
Write-Log "Resuming from archive date=$($cursor.Date.ToString('yyyy-MM-dd')), lastSeq=$($cursor.Seq)"

Refresh-EventTypeCache

# Prepare reusable INSERT command
$insertSql = @"
INSERT IGNORE INTO kantech_door_events
    (ArchiveDate, PkSequence, EventDateTime, ServerDateTime,
     EventTypeID, EventType, DoorID, DoorName,
     CardholderID, CardholderName, CardNumber,
     AccessGranted, Cluster, Site, InsertedAt)
VALUES
    (@ArchiveDate, @PkSequence, @EventDateTime, @ServerDateTime,
     @EventTypeID, @EventType, @DoorID, @DoorName,
     @CardholderID, @CardholderName, @CardNumber,
     @AccessGranted, @Cluster, @Site, NOW())
"@

$insertCmd = $mysqlConn.CreateCommand()
$insertCmd.CommandText = $insertSql
@('ArchiveDate','PkSequence','EventDateTime','ServerDateTime',
  'EventTypeID','EventType','DoorID','DoorName',
  'CardholderID','CardholderName','CardNumber',
  'AccessGranted','Cluster','Site') | ForEach-Object {
    $insertCmd.Parameters.AddWithValue("@$_", $null) | Out-Null
}

while ($true) {
    try {
        $today = [datetime]::Today

        # Day rollover: reset sequence for new archive file
        if ($cursor.Date -lt $today) {
            Write-Log "Day rollover: switching from $($cursor.Date.ToString('yyyy-MM-dd')) to $($today.ToString('yyyy-MM-dd'))"
            $cursor = @{ Date = $today; Seq = 0 }
        }

        # Hourly event type cache refresh
        if (([datetime]::Now - $eventTypeCacheAt).TotalHours -ge 1) {
            Refresh-EventTypeCache
        }

        # Reconnect MySQL if connection dropped
        if ($mysqlConn.State -ne 'Open') {
            Write-Log "MySQL reconnecting..." 'WARN'
            $mysqlConn.Close()
            $mysqlConn = Connect-MySQL
            $insertCmd.Connection = $mysqlConn
            Write-Log "MySQL reconnected"
        }

        $archiveTableName = $cursor.Date.ToString('yyyy-MM-dd')
        $archiveCsConn    = "Data Source=$ArchiveDir;ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;"

        # Fetch new rows since last processed sequence
        # Filter to door/card access event types only
        $sql = @"
SELECT
    e.PkSequence, e.DateTime, e.ServerDateTime,
    e.FkObjectMessage, e.Cluster, e.Site,
    e.Data1Object, e.FkData1,
    e.Data2Object, e.FkData2
FROM [$archiveTableName] e
WHERE e.PkSequence > $($cursor.Seq)
  AND (
      (e.FkObjectMessage >= 200 AND e.FkObjectMessage <= 235)
   OR e.FkObjectMessage IN (82,83,84,96,97,101,102,103,115,116,
                             500,501,502,503,504,505,510,511,566,567,
                             908,909,911,913,914)
  )
ORDER BY e.PkSequence ASC
"@

        $newEvents = @(Invoke-AdsQuery -ConnStr $archiveCsConn -Sql $sql)

        if ($newEvents.Count -gt 0) {
            # Collect unique Door IDs and Card IDs to resolve in batch
            $doorIds = ($newEvents | Where-Object { $_.Data1Object -eq '12' } | Select-Object -ExpandProperty FkData1 -Unique) -join ','
            $cardIds = ($newEvents | Where-Object { $_.Data2Object -eq '5'  } | Select-Object -ExpandProperty FkData2 -Unique) -join ','

            $doorMap = @{}
            $cardMap = @{}

            if ($doorIds) {
                $doorRows = Invoke-AdsQuery -ConnStr $dataCsConn -Sql "SELECT PkData, Description1 FROM Door WHERE PkData IN ($doorIds)"
                foreach ($d in $doorRows) { $doorMap[[int]$d.PkData] = $d.Description1 }
            }
            if ($cardIds) {
                $cardRows = Invoke-AdsQuery -ConnStr $dataCsConn -Sql "SELECT PkData, UserName, CardNumberFormatted FROM Card WHERE PkData IN ($cardIds)"
                foreach ($c in $cardRows) { $cardMap[[int]$c.PkData] = @{ Name = $c.UserName; Card = $c.CardNumberFormatted } }
            }

            $tx = $mysqlConn.BeginTransaction()
            $insertCmd.Transaction = $tx
            $inserted = 0

            foreach ($ev in $newEvents) {
                $evTypeId = [int]$ev.FkObjectMessage
                $evType   = if ($eventTypeCache.ContainsKey($evTypeId)) { $eventTypeCache[$evTypeId] } else { $evTypeId.ToString() }

                $doorId   = $null
                $doorName = ''
                if ($ev.Data1Object -eq '12' -and [int]$ev.FkData1 -gt 0) {
                    $doorId = [int]$ev.FkData1
                    $doorName = if ($doorMap.ContainsKey($doorId)) { $doorMap[$doorId] } else { "Door $doorId" }
                }

                $cardholderId   = $null
                $cardholderName = ''
                $cardNumber     = ''
                if ($ev.Data2Object -eq '5' -and [int]$ev.FkData2 -gt 0) {
                    $cardholderId = [int]$ev.FkData2
                    if ($cardMap.ContainsKey($cardholderId)) {
                        $cardholderName = $cardMap[$cardholderId].Name
                        $cardNumber     = $cardMap[$cardholderId].Card
                    }
                }

                $insertCmd.Parameters['@ArchiveDate'].Value    = $cursor.Date.ToString('yyyy-MM-dd')
                $insertCmd.Parameters['@PkSequence'].Value     = [int]$ev.PkSequence
                $insertCmd.Parameters['@EventDateTime'].Value  = [datetime]::Parse($ev.DateTime)
                $insertCmd.Parameters['@ServerDateTime'].Value = [datetime]::Parse($ev.ServerDateTime)
                $insertCmd.Parameters['@EventTypeID'].Value    = $evTypeId
                $insertCmd.Parameters['@EventType'].Value      = $evType
                $insertCmd.Parameters['@DoorID'].Value         = if ($null -ne $doorId) { $doorId } else { [DBNull]::Value }
                $insertCmd.Parameters['@DoorName'].Value       = $doorName
                $insertCmd.Parameters['@CardholderID'].Value   = if ($null -ne $cardholderId) { $cardholderId } else { [DBNull]::Value }
                $insertCmd.Parameters['@CardholderName'].Value = $cardholderName
                $insertCmd.Parameters['@CardNumber'].Value     = $cardNumber
                $insertCmd.Parameters['@AccessGranted'].Value  = if ($grantedTypes -contains $evTypeId) { 1 } else { 0 }
                $insertCmd.Parameters['@Cluster'].Value        = [int]$ev.Cluster
                $insertCmd.Parameters['@Site'].Value           = [int]$ev.Site

                $insertCmd.ExecuteNonQuery() | Out-Null
                $inserted++
            }

            $maxSeq = [int]($newEvents | Select-Object -Last 1).PkSequence
            $tx.Commit()
            Save-Cursor -conn $mysqlConn -date $cursor.Date -seq $maxSeq

            $cursor.Seq = $maxSeq
            Write-Log "Inserted $inserted events (seq $($cursor.Seq - $inserted + 1)..$($cursor.Seq))"
        }

    } catch {
        Write-Log "Poll error: $_" 'ERROR'
        # Brief pause before retry on error
        Start-Sleep -Seconds 15
    }

    Start-Sleep -Seconds $PollSeconds
}
