#Requires -Version 5.1
<#
.SYNOPSIS
    Combined Kantech EntraPass monitor — door events, door alarms,
    after-hours access, and repeated access denials.

.DESCRIPTION
    Runs as a Windows service via KantechEventService.exe.
    Each monitor is independently enabled/disabled via .env flags.

    MONITOR_DOOR_EVENTS      — stream archive events to MySQL (kantech_door_events)
    MONITOR_DOOR_ALARMS      — email on door forced open / held open too long
    MONITOR_AFTER_HOURS      — email on access granted outside business hours
    MONITOR_REPEATED_DENIALS — email when same card is denied N times in a window
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

# ---------------------------------------------------------------------------
# Load .env
# ---------------------------------------------------------------------------

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

# Monitor enable flags
$MonDoorEvents      = $env:MONITOR_DOOR_EVENTS      -ne 'false'
$MonDoorAlarms      = $env:MONITOR_DOOR_ALARMS      -ne 'false'
$MonAfterHours      = $env:MONITOR_AFTER_HOURS      -ne 'false'
$MonRepeatedDenials = $env:MONITOR_REPEATED_DENIALS -ne 'false'

# Email settings
$SmtpHost    = $env:SMTP_HOST
$SmtpPort    = if ($env:SMTP_PORT) { [int]$env:SMTP_PORT } else { 25 }
$SmtpFrom    = $env:SMTP_FROM
$SmtpTo      = $env:SMTP_TO

# Alert thresholds
$HoursStart          = if ($env:ALERT_HOURS_START) { [TimeSpan]::Parse($env:ALERT_HOURS_START) } else { [TimeSpan]::Parse('06:00') }
$HoursEnd            = if ($env:ALERT_HOURS_END)   { [TimeSpan]::Parse($env:ALERT_HOURS_END)   } else { [TimeSpan]::Parse('21:00') }
$DenialCount         = if ($env:ALERT_DENIAL_COUNT)           { [int]$env:ALERT_DENIAL_COUNT }           else { 3 }
$DenialWindowMinutes = if ($env:ALERT_DENIAL_WINDOW_MINUTES)  { [int]$env:ALERT_DENIAL_WINDOW_MINUTES }  else { 15 }

# Door alarm event type IDs (82=forced open, 84=held open too long)
$DoorAlarmTypeIDs = @(82, 84)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $entry = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    $logFile = Join-Path $LogDir "Kantech_$(Get-Date -Format 'yyyy-MM').log"
    Add-Content -Path $logFile -Value $entry
    Write-Host $entry
}

# ---------------------------------------------------------------------------
# Load MySqlConnector
# ---------------------------------------------------------------------------

$dllDir = $PSScriptRoot
foreach ($dep in @('System.Buffers.dll','System.Runtime.CompilerServices.Unsafe.dll','System.Threading.Tasks.Extensions.dll','System.Memory.dll')) {
    $p = Join-Path $dllDir $dep
    if (Test-Path $p) { try { Add-Type -Path $p } catch {} }
}
try {
    Add-Type -Path (Join-Path $dllDir 'MySqlConnector.dll')
} catch {
    Write-Log "Failed to load MySqlConnector.dll: $_" 'ERROR'; exit 1
}

# ---------------------------------------------------------------------------
# MySQL helpers
# ---------------------------------------------------------------------------

function Connect-MySQL {
    $conn = New-Object MySqlConnector.MySqlConnection
    $conn.ConnectionString = "Server=$MySqlHost;Port=$MySqlPort;Database=$MySqlDatabase;Uid=$MySqlUser;Password=$MySqlPassword;SslMode=None;Connect Timeout=30;Connection Lifetime=300;"
    $conn.Open()
    return $conn
}

function Exec-NonQuery {
    param($conn, [string]$sql, [hashtable]$params = @{})
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    foreach ($k in $params.Keys) { $cmd.Parameters.AddWithValue($k, $params[$k]) | Out-Null }
    $cmd.ExecuteNonQuery() | Out-Null
}

function Exec-Scalar {
    param($conn, [string]$sql, [hashtable]$params = @{})
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    foreach ($k in $params.Keys) { $cmd.Parameters.AddWithValue($k, $params[$k]) | Out-Null }
    return $cmd.ExecuteScalar()
}

function Ensure-Tables {
    param($conn)
    $tables = @(
        # Door events
        "CREATE TABLE IF NOT EXISTS kantech_door_events (
            EventID         BIGINT       NOT NULL AUTO_INCREMENT,
            ArchiveDate     DATE         NOT NULL,
            PkSequence      INT          NOT NULL,
            EventDateTime   DATETIME     NOT NULL,
            ServerDateTime  DATETIME     NOT NULL,
            EventTypeID     INT          NOT NULL,
            EventType       VARCHAR(255) NOT NULL DEFAULT '',
            DoorID          INT          NULL,
            DoorName        VARCHAR(255) NOT NULL DEFAULT '',
            CardholderID    INT          NULL,
            CardholderName  VARCHAR(255) NOT NULL DEFAULT '',
            CardNumber      VARCHAR(50)  NOT NULL DEFAULT '',
            AccessGranted   TINYINT      NOT NULL DEFAULT 0,
            Cluster         INT          NOT NULL DEFAULT 0,
            Site            INT          NOT NULL DEFAULT 0,
            InsertedAt      DATETIME     NOT NULL,
            PRIMARY KEY (EventID),
            UNIQUE KEY uq_archive_seq (ArchiveDate, PkSequence),
            KEY idx_event_datetime (EventDateTime),
            KEY idx_cardholder    (CardholderID),
            KEY idx_door          (DoorID)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

        # Resume cursor
        "CREATE TABLE IF NOT EXISTS kantech_event_cursor (
            CursorKey      VARCHAR(50) NOT NULL,
            ArchiveDate    DATE        NOT NULL,
            LastPkSequence INT         NOT NULL DEFAULT 0,
            UpdatedAt      DATETIME    NOT NULL,
            PRIMARY KEY (CursorKey)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

        # Alert deduplication
        "CREATE TABLE IF NOT EXISTS kantech_alerts_sent (
            AlertID   BIGINT       NOT NULL AUTO_INCREMENT,
            AlertType VARCHAR(50)  NOT NULL,
            AlertKey  VARCHAR(255) NOT NULL,
            SentAt    DATETIME     NOT NULL,
            PRIMARY KEY (AlertID),
            KEY idx_type_key_sent (AlertType, AlertKey, SentAt)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    )
    foreach ($t in $tables) {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $t
        $cmd.ExecuteNonQuery() | Out-Null
    }
}

# ---------------------------------------------------------------------------
# Cursor helpers
# ---------------------------------------------------------------------------

function Get-Cursor {
    param($conn)
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT ArchiveDate, LastPkSequence FROM kantech_event_cursor WHERE CursorKey = 'main'"
    $r = $cmd.ExecuteReader()
    if ($r.Read()) {
        $result = @{ Date = $r.GetDateTime(0).Date; Seq = $r.GetInt32(1) }
    } else {
        $result = @{ Date = [datetime]::Today; Seq = 0 }
    }
    $r.Close()
    return $result
}

function Save-Cursor {
    param($conn, [datetime]$date, [int]$seq)
    $sql = @'
INSERT INTO kantech_event_cursor (CursorKey, ArchiveDate, LastPkSequence, UpdatedAt)
VALUES ('main', @d, @s, NOW())
ON DUPLICATE KEY UPDATE ArchiveDate=@d, LastPkSequence=@s, UpdatedAt=NOW()
'@
    Exec-NonQuery $conn $sql @{ '@d' = $date.ToString('yyyy-MM-dd'); '@s' = $seq }
}

# ---------------------------------------------------------------------------
# Alert helpers
# ---------------------------------------------------------------------------

function Send-Alert {
    param([string]$Subject, [string]$Body)
    if (-not $SmtpHost -or -not $SmtpFrom -or -not $SmtpTo) {
        Write-Log "SMTP not configured - skipping email: $Subject" 'WARN'
        return
    }
    try {
        $recipients = $SmtpTo.Split(',') | ForEach-Object { $_.Trim() }
        Send-MailMessage -SmtpServer $SmtpHost -Port $SmtpPort -From $SmtpFrom `
            -To $recipients -Subject $Subject -Body $Body -ErrorAction Stop
        Write-Log "Email sent: $Subject"
    } catch {
        Write-Log "Email failed: $_" 'WARN'
    }
}

function Alert-Sent {
    param($conn, [string]$type, [string]$key, [int]$withinMinutes = 60)
    $sql = @'
SELECT COUNT(*) FROM kantech_alerts_sent
WHERE AlertType=@t AND AlertKey=@k AND SentAt >= NOW() - INTERVAL @m MINUTE
'@
    $count = Exec-Scalar $conn $sql @{ '@t' = $type; '@k' = $key; '@m' = $withinMinutes }
    return ([int]$count) -gt 0
}

function Record-Alert {
    param($conn, [string]$type, [string]$key)
    $sql = @'
INSERT INTO kantech_alerts_sent (AlertType, AlertKey, SentAt) VALUES (@t, @k, NOW())
'@
    Exec-NonQuery $conn $sql @{ '@t' = $type; '@k' = $key }
}

# ---------------------------------------------------------------------------
# ADS query helper
# ---------------------------------------------------------------------------

function Invoke-AdsQuery {
    param([string]$ConnStr, [string]$Sql)
    $tmpFile = [System.IO.Path]::GetTempFileName()
    try {
        & $AsqlCmd -CS $ConnStr -Q $Sql > $tmpFile 2>&1
        if ($LASTEXITCODE -ne 0) { throw "asqlcmd error: $(Get-Content $tmpFile -Raw)" }
        $lines = @(Get-Content $tmpFile | Where-Object { $_ -notmatch '^Finished\.' })
        if ($lines.Count -le 1) { return @() }
        return @($lines | ConvertFrom-Csv)
    } finally {
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

$monitors = @()
if ($MonDoorEvents)      { $monitors += 'DoorEvents' }
if ($MonDoorAlarms)      { $monitors += 'DoorAlarms' }
if ($MonAfterHours)      { $monitors += 'AfterHours' }
if ($MonRepeatedDenials) { $monitors += 'RepeatedDenials' }

Write-Log "Kantech monitor starting - active: $($monitors -join ', ') - poll every ${PollSeconds}s"

$mysqlConn = Connect-MySQL
Write-Log "MySQL connected"
Ensure-Tables -conn $mysqlConn
Write-Log "Tables verified"

# ---------------------------------------------------------------------------
# Event type cache (used by MONITOR_DOOR_EVENTS)
# ---------------------------------------------------------------------------

$eventTypeCache   = @{}
$eventTypeCacheAt = [datetime]::MinValue
$dataCsConn       = "Data Source=$DataDir;ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;"

function Refresh-EventTypeCache {
    $rows = Invoke-AdsQuery -ConnStr $dataCsConn -Sql "SELECT PkEventType, Description FROM eventtype"
    $script:eventTypeCache = @{}
    foreach ($r in $rows) { $script:eventTypeCache[[int]$r.PkEventType] = $r.Description }
    $script:eventTypeCacheAt = [datetime]::Now
    Write-Log "Event type cache refreshed ($($script:eventTypeCache.Count) types)"
}

# ---------------------------------------------------------------------------
# Door event INSERT command (reused across poll cycles)
# ---------------------------------------------------------------------------

$insertSql = @'
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
'@

$insertCmd = $mysqlConn.CreateCommand()
$insertCmd.CommandText = $insertSql
foreach ($p in @('ArchiveDate','PkSequence','EventDateTime','ServerDateTime',
                  'EventTypeID','EventType','DoorID','DoorName',
                  'CardholderID','CardholderName','CardNumber',
                  'AccessGranted','Cluster','Site')) {
    $insertCmd.Parameters.AddWithValue('@' + $p, $null) | Out-Null
}

$accessGrantedTypes = @(202, 203, 225, 908, 913, 914, 934)

# ---------------------------------------------------------------------------
# Main polling loop
# ---------------------------------------------------------------------------

if ($MonDoorEvents) {
    $cursor = Get-Cursor -conn $mysqlConn
    Write-Log "Door events: resuming from $($cursor.Date.ToString('yyyy-MM-dd')) seq=$($cursor.Seq)"
    Refresh-EventTypeCache
} else {
    $cursor = @{ Date = [datetime]::Today; Seq = 0 }
}

while ($true) {
    try {
        $today = [datetime]::Today

        # Day rollover
        if ($MonDoorEvents -and $cursor.Date -lt $today) {
            Write-Log "Day rollover: $($cursor.Date.ToString('yyyy-MM-dd')) -> $($today.ToString('yyyy-MM-dd'))"
            $cursor = @{ Date = $today; Seq = 0 }
        }

        # Hourly event type cache refresh
        if ($MonDoorEvents -and ([datetime]::Now - $eventTypeCacheAt).TotalHours -ge 1) {
            Refresh-EventTypeCache
        }

        # Reconnect if dropped
        if ($mysqlConn.State -ne 'Open') {
            Write-Log "MySQL reconnecting..." 'WARN'
            $mysqlConn.Close()
            $mysqlConn = Connect-MySQL
            $insertCmd.Connection = $mysqlConn
            Write-Log "MySQL reconnected"
        }

        # ---------------------------------------------------------------
        # MONITOR_DOOR_EVENTS — read archive, insert into MySQL
        # ---------------------------------------------------------------

        $newEvents = @()

        if ($MonDoorEvents) {
            $archiveCsConn = "Data Source=$ArchiveDir;ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;"
            $archiveTable  = $cursor.Date.ToString('yyyy-MM-dd')

            $archiveSql = "SELECT
                e.PkSequence, e.DateTime, e.ServerDateTime,
                e.FkObjectMessage, e.Cluster, e.Site,
                e.Data1Object, e.FkData1,
                e.Data2Object, e.FkData2
            FROM [$archiveTable] e
            WHERE e.PkSequence > $($cursor.Seq)
              AND (
                  (e.FkObjectMessage >= 200 AND e.FkObjectMessage <= 235)
               OR e.FkObjectMessage IN (82,83,84,96,97,101,102,103,115,116,
                                        500,501,502,503,504,505,510,511,566,567,
                                        908,909,911,913,914)
              )
            ORDER BY e.PkSequence ASC"

            $newEvents = @(Invoke-AdsQuery -ConnStr $archiveCsConn -Sql $archiveSql)

            if ($newEvents.Count -gt 0) {
                # Batch-resolve door and card names
                $doorIds = ($newEvents | Where-Object { $_.Data1Object -eq '12' } |
                            Select-Object -ExpandProperty FkData1 -Unique) -join ','
                $cardIds = ($newEvents | Where-Object { $_.Data2Object -eq '5'  } |
                            Select-Object -ExpandProperty FkData2 -Unique) -join ','

                $doorMap = @{}
                $cardMap = @{}

                if ($doorIds) {
                    $rows = Invoke-AdsQuery -ConnStr $dataCsConn -Sql "SELECT PkData, Description1 FROM Door WHERE PkData IN ($doorIds)"
                    foreach ($r in $rows) { $doorMap[[int]$r.PkData] = $r.Description1 }
                }
                if ($cardIds) {
                    $rows = Invoke-AdsQuery -ConnStr $dataCsConn -Sql "SELECT PkData, UserName, CardNumberFormatted FROM Card WHERE PkData IN ($cardIds)"
                    foreach ($r in $rows) { $cardMap[[int]$r.PkData] = @{ Name = $r.UserName; Card = $r.CardNumberFormatted } }
                }

                $tx = $mysqlConn.BeginTransaction()
                $insertCmd.Transaction = $tx
                $inserted = 0

                foreach ($ev in $newEvents) {
                    $evTypeId = [int]$ev.FkObjectMessage
                    $evType   = if ($eventTypeCache.ContainsKey($evTypeId)) { $eventTypeCache[$evTypeId] } else { $evTypeId.ToString() }

                    $doorId   = $null; $doorName = ''
                    if ($ev.Data1Object -eq '12' -and [int]$ev.FkData1 -gt 0) {
                        $doorId   = [int]$ev.FkData1
                        $doorName = if ($doorMap.ContainsKey($doorId)) { $doorMap[$doorId] } else { "Door $doorId" }
                    }

                    $cardholderId = $null; $cardholderName = ''; $cardNumber = ''
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
                    $insertCmd.Parameters['@AccessGranted'].Value  = if ($accessGrantedTypes -contains $evTypeId) { 1 } else { 0 }
                    $insertCmd.Parameters['@Cluster'].Value        = [int]$ev.Cluster
                    $insertCmd.Parameters['@Site'].Value           = [int]$ev.Site

                    $insertCmd.ExecuteNonQuery() | Out-Null
                    $inserted++
                }

                $maxSeq = [int]($newEvents | Select-Object -Last 1).PkSequence
                $tx.Commit()
                Save-Cursor -conn $mysqlConn -date $cursor.Date -seq $maxSeq
                $cursor.Seq = $maxSeq
                Write-Log "Door events: inserted $inserted (seq $($maxSeq - $inserted + 1)..$maxSeq)"
            }
        }

        # ---------------------------------------------------------------
        # MONITOR_DOOR_ALARMS — alert on forced-open / held-open events
        # ---------------------------------------------------------------

        if ($MonDoorAlarms -and $newEvents.Count -gt 0) {
            foreach ($ev in $newEvents) {
                $evTypeId = [int]$ev.FkObjectMessage
                if ($DoorAlarmTypeIDs -contains $evTypeId) {
                    $evType   = if ($eventTypeCache.ContainsKey($evTypeId)) { $eventTypeCache[$evTypeId] } else { "Event $evTypeId" }
                    $doorId   = if ($ev.Data1Object -eq '12' -and [int]$ev.FkData1 -gt 0) { [int]$ev.FkData1 } else { 0 }
                    $doorName = if ($doorId -gt 0 -and $doorMap.ContainsKey($doorId)) { $doorMap[$doorId] } else { "Door $doorId" }
                    $evTime   = [datetime]::Parse($ev.DateTime)

                    $alertKey = "$($cursor.Date.ToString('yyyy-MM-dd'))_$($ev.PkSequence)"
                    if (-not (Alert-Sent -conn $mysqlConn -type 'DoorAlarm' -key $alertKey -withinMinutes 1440)) {
                        $subject = "[Kantech Alert] Door Alarm: $evType"
                        $body    = "Door alarm at $($evTime.ToString('yyyy-MM-dd HH:mm:ss'))`n`nDoor:  $doorName`nEvent: $evType"
                        Send-Alert -Subject $subject -Body $body
                        Record-Alert -conn $mysqlConn -type 'DoorAlarm' -key $alertKey
                    }
                }
            }
        }

        # ---------------------------------------------------------------
        # MONITOR_AFTER_HOURS — alert on access granted outside hours
        # ---------------------------------------------------------------

        if ($MonAfterHours -and $newEvents.Count -gt 0) {
            foreach ($ev in $newEvents) {
                $evTypeId = [int]$ev.FkObjectMessage
                if ($accessGrantedTypes -contains $evTypeId) {
                    $evTime = [datetime]::Parse($ev.DateTime)
                    $tod    = $evTime.TimeOfDay
                    if ($tod -lt $HoursStart -or $tod -ge $HoursEnd) {
                        $cardholderId   = if ($ev.Data2Object -eq '5' -and [int]$ev.FkData2 -gt 0) { [int]$ev.FkData2 } else { 0 }
                        $cardholderName = if ($cardholderId -gt 0 -and $cardMap.ContainsKey($cardholderId)) { $cardMap[$cardholderId].Name } else { "ID $cardholderId" }
                        $cardNumber     = if ($cardholderId -gt 0 -and $cardMap.ContainsKey($cardholderId)) { $cardMap[$cardholderId].Card } else { '' }
                        $doorId         = if ($ev.Data1Object -eq '12' -and [int]$ev.FkData1 -gt 0) { [int]$ev.FkData1 } else { 0 }
                        $doorName       = if ($doorId -gt 0 -and $doorMap.ContainsKey($doorId)) { $doorMap[$doorId] } else { "Door $doorId" }

                        $alertKey = "$($cursor.Date.ToString('yyyy-MM-dd'))_$($ev.PkSequence)"
                        if (-not (Alert-Sent -conn $mysqlConn -type 'AfterHours' -key $alertKey -withinMinutes 1440)) {
                            $subject = "[Kantech Alert] After-Hours Access: $cardholderName"
                            $body    = "After-hours access at $($evTime.ToString('yyyy-MM-dd HH:mm:ss'))`n`nCardholder: $cardholderName`nCard:        $cardNumber`nDoor:        $doorName`nHours:       $($HoursStart.ToString('hh\:mm')) - $($HoursEnd.ToString('hh\:mm'))"
                            Send-Alert -Subject $subject -Body $body
                            Record-Alert -conn $mysqlConn -type 'AfterHours' -key $alertKey
                        }
                    }
                }
            }
        }

        # ---------------------------------------------------------------
        # MONITOR_REPEATED_DENIALS — rolling-window denial check
        # ---------------------------------------------------------------

        if ($MonRepeatedDenials) {
            $cmd = $mysqlConn.CreateCommand()
            $cmd.CommandText = "SELECT CardholderID, CardholderName, CardNumber, COUNT(*) AS cnt
                FROM kantech_door_events
                WHERE AccessGranted = 0
                  AND EventDateTime >= NOW() - INTERVAL @w MINUTE
                  AND CardholderID IS NOT NULL
                GROUP BY CardholderID, CardholderName, CardNumber
                HAVING COUNT(*) >= @threshold"
            $cmd.Parameters.AddWithValue('@w', $DenialWindowMinutes) | Out-Null
            $cmd.Parameters.AddWithValue('@threshold', $DenialCount) | Out-Null
            $dr = $cmd.ExecuteReader()
            $denials = @()
            while ($dr.Read()) {
                $denials += [PSCustomObject]@{
                    CardholderID   = $dr.GetValue(0)
                    CardholderName = $dr.GetValue(1).ToString()
                    CardNumber     = $dr.GetValue(2).ToString()
                    DenialCount    = [int]$dr.GetValue(3)
                }
            }
            $dr.Close()

            foreach ($d in $denials) {
                $alertKey = $d.CardholderID.ToString()
                if (-not (Alert-Sent -conn $mysqlConn -type 'RepeatedDenial' -key $alertKey -withinMinutes $DenialWindowMinutes)) {
                    $subject = "[Kantech Alert] Repeated Access Denials: $($d.CardholderName)"
                    $body    = "$($d.DenialCount) access denials in the last $DenialWindowMinutes minutes`n`nCardholder: $($d.CardholderName)`nCard:        $($d.CardNumber)`nDenials:     $($d.DenialCount) (threshold: $DenialCount)"
                    Send-Alert -Subject $subject -Body $body
                    Record-Alert -conn $mysqlConn -type 'RepeatedDenial' -key $alertKey
                }
            }
        }

    } catch {
        Write-Log "Poll error: $_" 'ERROR'
        Start-Sleep -Seconds 15
    }

    Start-Sleep -Seconds $PollSeconds
}
