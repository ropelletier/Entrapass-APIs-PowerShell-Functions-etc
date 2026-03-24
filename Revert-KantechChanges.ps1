<#
.SYNOPSIS
    Reverts Kantech API database changes within a specified time range.

.DESCRIPTION
    Reads api-backup.jsonl (written by the API before every INSERT/UPDATE/DELETE)
    and replays the inverse SQL in reverse chronological order.

    By default runs in -WhatIf mode — prints the SQL that WOULD be executed
    without touching the database.  Pass -Execute to actually apply the reverts.

.PARAMETER From
    Start of the time range (inclusive).  Any format PowerShell can parse.
    Examples:  "2026-03-24 10:15:00"   "today"   "2026-03-24T10:18:00Z"

.PARAMETER To
    End of the time range (inclusive).  Defaults to now.

.PARAMETER Execute
    Actually run the revert SQL.  Without this flag the script is read-only.

.PARAMETER BackupFile
    Path to api-backup.jsonl.  Defaults to C:\Projects\Kantech\logs\api-backup.jsonl.

.EXAMPLE
    # Preview what would be reverted in the last 10 minutes
    .\Revert-KantechChanges.ps1 -From "2026-03-24 10:10:00"

.EXAMPLE
    # Actually revert all changes from a specific minute
    .\Revert-KantechChanges.ps1 -From "2026-03-24 10:18:00" -To "2026-03-24 10:19:00" -Execute
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$From,

    [string]$To,

    [switch]$Execute,

    [string]$BackupFile = 'C:\Projects\Kantech\logs\api-backup.jsonl'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Load env + build ADS connection
# ---------------------------------------------------------------------------
. (Join-Path $PSScriptRoot 'Load-Env.ps1')
Import-EnvFile -EnvFile (Join-Path $PSScriptRoot '.env')

$asqlcmd = $env:KANTECH_ASQLCMD
$dataDir  = $env:KANTECH_DATA_DIR
$connStr  = "Data Source=$dataDir;ServerType=ADS_LOCAL_SERVER;TableType=ADT;Collation=GENERAL_VFP_CI_AS_1252;"

if (-not (Test-Path $asqlcmd)) {
    Write-Error "asqlcmd.exe not found at: $asqlcmd"
    exit 1
}

# ---------------------------------------------------------------------------
# Parse time range
# ---------------------------------------------------------------------------
try   { $fromDt = [datetime]::Parse($From) }
catch { Write-Error "Cannot parse -From date: '$From'"; exit 1 }

$toDt = if ($To) {
    try   { [datetime]::Parse($To) }
    catch { Write-Error "Cannot parse -To date: '$To'"; exit 1 }
} else {
    [datetime]::UtcNow
}

Write-Host ""
Write-Host "Kantech Change Revert" -ForegroundColor Cyan
Write-Host "  Backup file : $BackupFile"
Write-Host "  From        : $($fromDt.ToString('yyyy-MM-dd HH:mm:ss')) UTC"
Write-Host "  To          : $($toDt.ToString('yyyy-MM-dd HH:mm:ss')) UTC"
Write-Host "  Mode        : $(if ($Execute) { 'EXECUTE (live changes!)' } else { 'WhatIf (read-only preview)' })"
Write-Host ""

# ---------------------------------------------------------------------------
# Read + filter backup entries
# ---------------------------------------------------------------------------
if (-not (Test-Path $BackupFile)) {
    Write-Error "Backup file not found: $BackupFile"
    exit 1
}

$entries = @()
foreach ($line in Get-Content $BackupFile -Encoding UTF8) {
    $line = $line.Trim()
    if (-not $line) { continue }
    try {
        $entry = $line | ConvertFrom-Json
        $entryTs = [datetime]::Parse($entry.ts).ToUniversalTime()
        if ($entryTs -ge $fromDt.ToUniversalTime() -and $entryTs -le $toDt.ToUniversalTime()) {
            $entries += $entry
        }
    } catch {
        Write-Warning "Skipping unparseable line: $($line.Substring(0, [Math]::Min(80,$line.Length)))"
    }
}

if ($entries.Count -eq 0) {
    Write-Host "No backup entries found in the specified time range." -ForegroundColor Yellow
    exit 0
}

# Reverse chronological — undo most recent change first
$entries = $entries | Sort-Object { [datetime]::Parse($_.ts) } -Descending

Write-Host "Found $($entries.Count) backup entries to revert (most recent first):" -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# Helper: run SQL via asqlcmd
# ---------------------------------------------------------------------------
function Invoke-AdsSql {
    param([string]$Sql)
    $result = & $asqlcmd -CS $connStr -Q $Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "asqlcmd failed (exit $LASTEXITCODE): $result"
    }
    return $result
}

# ---------------------------------------------------------------------------
# Process each entry
# ---------------------------------------------------------------------------
$succeeded = 0
$failed    = 0
$skipped   = 0

foreach ($entry in $entries) {
    $ts        = $entry.ts
    $operation = $entry.operation
    $table     = $entry.table
    $reqId     = $entry.reqId

    # Entries with no revertSqls (e.g. BACKUP_ERROR or unknown INSERT)
    if ($null -eq $entry.revertSqls -or $entry.revertSqls.Count -eq 0) {
        Write-Host "[$ts] reqId=$reqId  $operation $table" -ForegroundColor Yellow
        Write-Host "  !! No revert SQL available" -ForegroundColor Yellow
        if ($entry.note)  { Write-Host "  Note: $($entry.note)" -ForegroundColor Yellow }
        if ($entry.error) { Write-Host "  Error: $($entry.error)" -ForegroundColor Red }
        $skipped++
        Write-Host ""
        continue
    }

    Write-Host "[$ts] reqId=$reqId  $operation $table" -ForegroundColor Cyan
    foreach ($sql in $entry.revertSqls) {
        Write-Host "  SQL: $sql" -ForegroundColor Gray
    }

    if (-not $Execute) {
        Write-Host "  (skipped — run with -Execute to apply)" -ForegroundColor DarkGray
        $skipped++
    } else {
        $allOk = $true
        foreach ($sql in $entry.revertSqls) {
            try {
                Invoke-AdsSql -Sql $sql | Out-Null
                Write-Host "  OK" -ForegroundColor Green
            } catch {
                Write-Host "  FAILED: $_" -ForegroundColor Red
                $allOk = $false
                $failed++
            }
        }
        if ($allOk) { $succeeded++ }
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "---"
if ($Execute) {
    Write-Host "Reverted: $succeeded   Failed: $failed   Skipped (no SQL): $skipped"
} else {
    Write-Host "$($entries.Count) entries previewed.  Run with -Execute to apply."
}
Write-Host ""
