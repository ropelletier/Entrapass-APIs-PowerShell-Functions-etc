#Requires -Version 5.1
<#
.SYNOPSIS
    Exports Kantech EntraPass cardholder, card number, and access level data
    to a dated CSV file and upserts the records into a remote MySQL database.

.DESCRIPTION
    Uses asqlcmd.exe (bundled with Advantage Data Architect) to query the
    EntraPass Corporate Edition database, then:
      1. Writes a dated CSV to OutputDir
      2. Upserts all rows into a MySQL table (INSERT ... ON DUPLICATE KEY UPDATE)

    Cardholders with multiple cards produce multiple rows (one per card).
    Cardholders with no card assigned produce a single row with blank card fields.

    Designed to run nightly via Windows Task Scheduler.

.PARAMETER MySqlHost     Remote MySQL server hostname or IP
.PARAMETER MySqlPort     MySQL port (default 3306)
.PARAMETER MySqlDatabase Target database name
.PARAMETER MySqlUser     MySQL username
.PARAMETER MySqlPassword MySQL password
.PARAMETER OutputDir     Directory for CSV files (created if absent)
.PARAMETER RetainDays    Days to keep old CSVs (0 = forever, default 30)
#>

[CmdletBinding()]
param (
    [string]$DataDir       = '',
    [string]$AsqlCmd       = '',
    [string]$MySqlHost     = '',
    [string]$MySqlPort     = '',
    [string]$MySqlDatabase = '',
    [string]$MySqlUser     = '',
    [string]$MySqlPassword = '',
    [string]$OutputDir     = '',
    [int]$RetainDays       = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load .env — provides defaults for any param left blank
. (Join-Path $PSScriptRoot 'Load-Env.ps1')
Import-EnvFile

if (-not $DataDir)       { $DataDir       = $env:KANTECH_DATA_DIR }
if (-not $AsqlCmd)       { $AsqlCmd       = $env:KANTECH_ASQLCMD }
if (-not $MySqlHost)     { $MySqlHost     = $env:MYSQL_HOST }
if (-not $MySqlPort)     { $MySqlPort     = $env:MYSQL_PORT }
if (-not $MySqlDatabase) { $MySqlDatabase = $env:MYSQL_DATABASE }
if (-not $MySqlUser)     { $MySqlUser     = $env:MYSQL_USER }
if (-not $MySqlPassword) { $MySqlPassword = $env:MYSQL_PASSWORD }
if (-not $OutputDir)     { $OutputDir     = $env:EXPORT_OUTPUT_DIR }
if ($RetainDays -eq 0)   { $RetainDays    = [int]$env:EXPORT_RETAIN_DAYS }

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$logFile  = Join-Path $OutputDir 'Export-KantechCards.log'
$csvFile  = Join-Path $OutputDir "kantech_cards_$(Get-Date -Format 'yyyy-MM-dd').csv"
$tmpFile  = Join-Path $OutputDir "kantech_cards_$(Get-Date -Format 'yyyy-MM-dd_HHmmss').tmp"

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $entry = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $logFile -Value $entry
    Write-Host $entry
}

Write-Log 'Starting Kantech card export'

# ---------------------------------------------------------------------------
# Validate prerequisites
# ---------------------------------------------------------------------------

if (-not (Test-Path $AsqlCmd)) {
    Write-Log "asqlcmd.exe not found at: $AsqlCmd" 'ERROR'
    exit 1
}

$mysqlDll = Join-Path $PSScriptRoot 'MySqlConnector.dll'
if (-not (Test-Path $mysqlDll)) {
    Write-Log "MySqlConnector.dll not found at: $mysqlDll" 'ERROR'
    exit 1
}

# ---------------------------------------------------------------------------
# Query EntraPass database
# ---------------------------------------------------------------------------
# Access level join:
#   Card -> ItemCard (FkDataCard = PkData)  -> FkICDataAccessLevel
#   FkICDataAccessLevel -> AccessLevel (PkData) -> Description1
#
# Cards with no ItemCard row (no access level assigned) use LEFT JOINs
# so they still appear in the output.
#
# State values:  0=Active  1=Lost/Stolen  2=Inactive/Expired
# ---------------------------------------------------------------------------

$sql = @"
SELECT
    c.PkData                AS CardholderID,
    c.UserName              AS FullName,
    c.State                 AS State,
    c.Email                 AS Email,
    c.CreationDate          AS CreationDate,
    c.ExternalUserID        AS ExternalUserID,
    c.Info1                 AS Info1,
    c.Info2                 AS Info2,
    c.Info3                 AS Info3,
    c.Info4                 AS Info4,
    c.CardInfo1             AS CardInfo1,
    c.CardInfo2             AS CardInfo2,
    c.CardInfo3             AS CardInfo3,
    c.CardInfo4             AS CardInfo4,
    c.CardInfo5             AS CardInfo5,
    c.CardNumberCount       AS CardCount,
    n.CardNumberFormatted   AS CardNumberFormatted,
    n.CardNumber            AS CardNumberRaw,
    n.LostStolen            AS CardLostStolen,
    n.Deactivated           AS CardDeactivated,
    n.UseEndDate            AS CardHasExpiry,
    n.EndDate               AS CardEndDate,
    al.Description1         AS AccessLevel
FROM Card c
LEFT OUTER JOIN CardNumber n  ON c.PkData = n.PkCard
LEFT OUTER JOIN ItemCard   ic ON c.PkData = ic.FkDataCard
LEFT OUTER JOIN AccessLevel al ON ic.FkICDataAccessLevel = al.PkData
ORDER BY c.UserName, n.CardNumberFormatted
"@

$connString = "Data Source=$DataDir;ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;"

Write-Log "Querying EntraPass database at: $DataDir"

try {
    & $AsqlCmd -CS $connString -Q $sql > $tmpFile 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "asqlcmd failed (exit $LASTEXITCODE): $(Get-Content $tmpFile -Raw)" 'ERROR'
        Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
        exit 1
    }
} catch {
    Write-Log "Failed to run asqlcmd: $_" 'ERROR'
    exit 1
}

# Strip the trailing "Finished. Lines processed = N" summary line
$rawLines  = Get-Content $tmpFile
Remove-Item $tmpFile -Force
$dataLines = $rawLines | Where-Object { $_ -notmatch '^Finished\.' }
$rowCount  = $dataLines.Count - 1   # subtract header

Write-Log "Retrieved $rowCount rows from EntraPass"

# ---------------------------------------------------------------------------
# Write CSV
# ---------------------------------------------------------------------------

$dataLines | Set-Content -Path $csvFile -Encoding UTF8
Write-Log "CSV written: $csvFile"

# ---------------------------------------------------------------------------
# Parse CSV rows into objects
# (Use ConvertFrom-Csv on the clean data lines we already have in memory)
# ---------------------------------------------------------------------------

$records = $dataLines | ConvertFrom-Csv

# ---------------------------------------------------------------------------
# MySQL upsert
# ---------------------------------------------------------------------------

Write-Log "Connecting to MySQL at $MySqlHost`:$MySqlPort / $MySqlDatabase"

foreach ($dep in @('System.Buffers.dll','System.Runtime.CompilerServices.Unsafe.dll','System.Threading.Tasks.Extensions.dll','System.Memory.dll')) {
    $depPath = Join-Path $PSScriptRoot $dep
    if (Test-Path $depPath) { try { Add-Type -Path $depPath } catch {} }
}
try {
    Add-Type -Path $mysqlDll
} catch {
    Write-Log "Failed to load MySqlConnector.dll: $_" 'ERROR'
    exit 1
}

$mysqlConn = New-Object MySqlConnector.MySqlConnection
$mysqlConn.ConnectionString = "Server=$MySqlHost;Port=$MySqlPort;Database=$MySqlDatabase;Uid=$MySqlUser;Password=$MySqlPassword;SslMode=None;Connect Timeout=30;"

try {
    $mysqlConn.Open()
    Write-Log "MySQL connection established"
} catch {
    Write-Log "MySQL connection failed: $_" 'ERROR'
    exit 1
}

# ---------------------------------------------------------------------------
# Ensure table exists
# ---------------------------------------------------------------------------

$createTable = @"
CREATE TABLE IF NOT EXISTS kantech_cards (
    CardholderID        INT            NOT NULL,
    FullName            VARCHAR(255)   NOT NULL DEFAULT '',
    State               TINYINT        NOT NULL DEFAULT 0,
    StateLabel          VARCHAR(20)    NOT NULL DEFAULT '',
    Email               VARCHAR(255)   NOT NULL DEFAULT '',
    CreationDate        DATETIME       NULL,
    ExternalUserID      VARCHAR(100)   NOT NULL DEFAULT '',
    Info1               VARCHAR(255)   NOT NULL DEFAULT '',
    Info2               VARCHAR(255)   NOT NULL DEFAULT '',
    Info3               VARCHAR(255)   NOT NULL DEFAULT '',
    Info4               VARCHAR(255)   NOT NULL DEFAULT '',
    CardInfo1           VARCHAR(255)   NOT NULL DEFAULT '',
    CardInfo2           VARCHAR(255)   NOT NULL DEFAULT '',
    CardInfo3           VARCHAR(255)   NOT NULL DEFAULT '',
    CardInfo4           VARCHAR(255)   NOT NULL DEFAULT '',
    CardInfo5           VARCHAR(255)   NOT NULL DEFAULT '',
    CardCount           INT            NOT NULL DEFAULT 0,
    CardNumberFormatted VARCHAR(50)    NOT NULL DEFAULT '',
    CardNumberRaw       VARCHAR(30)    NOT NULL DEFAULT '',
    CardLostStolen      TINYINT        NOT NULL DEFAULT 0,
    CardDeactivated     TINYINT        NOT NULL DEFAULT 0,
    CardHasExpiry       TINYINT        NOT NULL DEFAULT 0,
    CardEndDate         DATETIME       NULL,
    AccessLevel         VARCHAR(255)   NOT NULL DEFAULT '',
    LastSynced          DATETIME       NOT NULL,
    PRIMARY KEY (CardholderID, CardNumberFormatted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"@

$cmd = $mysqlConn.CreateCommand()
$cmd.CommandText = $createTable
$cmd.ExecuteNonQuery() | Out-Null

# ---------------------------------------------------------------------------
# State label map
# ---------------------------------------------------------------------------

$stateMap = @{ '0'='Active'; '1'='Lost/Stolen'; '2'='Inactive' }

# ---------------------------------------------------------------------------
# Upsert helper
# ---------------------------------------------------------------------------

function ConvertTo-MySqlDateTime {
    param([string]$raw)
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -match '^\s*/') { return $null }
    try {
        $dt = [datetime]::Parse($raw)
        if ($dt.Year -le 1900) { return $null }
        return $dt.ToString('yyyy-MM-dd HH:mm:ss')
    } catch { return $null }
}

$upsertSql = @"
INSERT INTO kantech_cards
    (CardholderID, FullName, State, StateLabel, Email, CreationDate,
     ExternalUserID, Info1, Info2, Info3, Info4,
     CardInfo1, CardInfo2, CardInfo3, CardInfo4, CardInfo5,
     CardCount, CardNumberFormatted, CardNumberRaw,
     CardLostStolen, CardDeactivated, CardHasExpiry, CardEndDate,
     AccessLevel, LastSynced)
VALUES
    (@CardholderID, @FullName, @State, @StateLabel, @Email, @CreationDate,
     @ExternalUserID, @Info1, @Info2, @Info3, @Info4,
     @CardInfo1, @CardInfo2, @CardInfo3, @CardInfo4, @CardInfo5,
     @CardCount, @CardNumberFormatted, @CardNumberRaw,
     @CardLostStolen, @CardDeactivated, @CardHasExpiry, @CardEndDate,
     @AccessLevel, @LastSynced)
ON DUPLICATE KEY UPDATE
    FullName            = @FullName,
    State               = @State,
    StateLabel          = @StateLabel,
    Email               = @Email,
    CreationDate        = @CreationDate,
    ExternalUserID      = @ExternalUserID,
    Info1               = @Info1,
    Info2               = @Info2,
    Info3               = @Info3,
    Info4               = @Info4,
    CardInfo1           = @CardInfo1,
    CardInfo2           = @CardInfo2,
    CardInfo3           = @CardInfo3,
    CardInfo4           = @CardInfo4,
    CardInfo5           = @CardInfo5,
    CardCount           = @CardCount,
    CardNumberRaw       = @CardNumberRaw,
    CardLostStolen      = @CardLostStolen,
    CardDeactivated     = @CardDeactivated,
    CardHasExpiry       = @CardHasExpiry,
    CardEndDate         = @CardEndDate,
    AccessLevel         = @AccessLevel,
    LastSynced          = @LastSynced
"@

$upsertCmd = $mysqlConn.CreateCommand()
$upsertCmd.CommandText = $upsertSql

# Add parameters once, update values per row
$paramNames = @(
    'CardholderID','FullName','State','StateLabel','Email','CreationDate',
    'ExternalUserID','Info1','Info2','Info3','Info4',
    'CardInfo1','CardInfo2','CardInfo3','CardInfo4','CardInfo5',
    'CardCount','CardNumberFormatted','CardNumberRaw',
    'CardLostStolen','CardDeactivated','CardHasExpiry','CardEndDate',
    'AccessLevel','LastSynced'
)
foreach ($p in $paramNames) {
    $upsertCmd.Parameters.AddWithValue("@$p", $null) | Out-Null
}

$now        = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$upserted   = 0
$errors     = 0

# Wrap in a transaction for performance
$tx = $mysqlConn.BeginTransaction()
$upsertCmd.Transaction = $tx

try {
    foreach ($row in $records) {
        $stateCode  = $row.State.Trim()
        $stateLabel = if ($stateMap.ContainsKey($stateCode)) { $stateMap[$stateCode] } else { $stateCode }

        $upsertCmd.Parameters['@CardholderID'].Value        = [int]$row.CardholderID
        $upsertCmd.Parameters['@FullName'].Value            = $row.FullName
        $upsertCmd.Parameters['@State'].Value               = $stateCode
        $upsertCmd.Parameters['@StateLabel'].Value          = $stateLabel
        $upsertCmd.Parameters['@Email'].Value               = $row.Email
        $cd = ConvertTo-MySqlDateTime $row.CreationDate
        $upsertCmd.Parameters['@CreationDate'].Value        = if ($null -ne $cd) { $cd } else { [DBNull]::Value }
        $upsertCmd.Parameters['@ExternalUserID'].Value      = $row.ExternalUserID
        $upsertCmd.Parameters['@Info1'].Value               = $row.Info1
        $upsertCmd.Parameters['@Info2'].Value               = $row.Info2
        $upsertCmd.Parameters['@Info3'].Value               = $row.Info3
        $upsertCmd.Parameters['@Info4'].Value               = $row.Info4
        $upsertCmd.Parameters['@CardInfo1'].Value           = $row.CardInfo1
        $upsertCmd.Parameters['@CardInfo2'].Value           = $row.CardInfo2
        $upsertCmd.Parameters['@CardInfo3'].Value           = $row.CardInfo3
        $upsertCmd.Parameters['@CardInfo4'].Value           = $row.CardInfo4
        $upsertCmd.Parameters['@CardInfo5'].Value           = $row.CardInfo5
        $upsertCmd.Parameters['@CardCount'].Value           = [int]$row.CardCount
        $upsertCmd.Parameters['@CardNumberFormatted'].Value = $row.CardNumberFormatted
        $upsertCmd.Parameters['@CardNumberRaw'].Value       = $row.CardNumberRaw
        $upsertCmd.Parameters['@CardLostStolen'].Value      = [int]$row.CardLostStolen
        $upsertCmd.Parameters['@CardDeactivated'].Value     = [int]$row.CardDeactivated
        $upsertCmd.Parameters['@CardHasExpiry'].Value       = [int]$row.CardHasExpiry
        $ced = ConvertTo-MySqlDateTime $row.CardEndDate
        $upsertCmd.Parameters['@CardEndDate'].Value         = if ($null -ne $ced) { $ced } else { [DBNull]::Value }
        $upsertCmd.Parameters['@AccessLevel'].Value         = $row.AccessLevel
        $upsertCmd.Parameters['@LastSynced'].Value          = $now

        try {
            $upsertCmd.ExecuteNonQuery() | Out-Null
            $upserted++
        } catch {
            Write-Log "Row error (CardholderID=$($row.CardholderID)): $_" 'WARN'
            $errors++
        }
    }
    $tx.Commit()
    Write-Log "MySQL upsert complete: $upserted rows, $errors errors"
} catch {
    $tx.Rollback()
    Write-Log "Transaction rolled back: $_" 'ERROR'
    $mysqlConn.Close()
    exit 1
}

$mysqlConn.Close()

# ---------------------------------------------------------------------------
# Purge old CSV exports
# ---------------------------------------------------------------------------

if ($RetainDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$RetainDays)
    Get-ChildItem -Path $OutputDir -Filter 'kantech_cards_*.csv' |
        Where-Object LastWriteTime -lt $cutoff |
        ForEach-Object {
            Remove-Item $_.FullName -Force
            Write-Log "Purged old file: $($_.Name)"
        }
}

Write-Log "Export complete. $rowCount rows. CSV: $csvFile"
