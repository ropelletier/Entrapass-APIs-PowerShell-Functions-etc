<#
.SYNOPSIS
    Analyzes the output of Watch-KantechChanges.ps1 and summarizes what changed.

.DESCRIPTION
    Reads watch-changes.jsonl and produces a human-readable report showing:
    - Which tables were modified and in what order
    - The exact rows inserted/deleted
    - File and service changes
    - A suggested API sequence to replicate the operation

.EXAMPLE
    .\Analyze-KantechChanges.ps1
    .\Analyze-KantechChanges.ps1 -InputFile C:\temp\changes.jsonl
#>

param(
    [string]$InputFile = 'C:\Projects\Kantech\logs\watch-changes.jsonl'
)

if (-not (Test-Path $InputFile)) {
    Write-Error "File not found: $InputFile"
    exit 1
}

$entries = @()
foreach ($line in Get-Content $InputFile -Encoding UTF8) {
    $line = $line.Trim()
    if ($line) {
        try { $entries += $line | ConvertFrom-Json } catch { }
    }
}

$dbChanges  = $entries | Where-Object type -eq 'DB_CHANGE'
$fileChgs   = $entries | Where-Object type -eq 'FILE_CHANGE'
$svcChgs    = $entries | Where-Object type -eq 'SERVICE_CHANGE'
$evtChgs    = $entries | Where-Object type -eq 'EVENT_LOG'

Write-Host ''
Write-Host '===== Kantech Change Analysis =====' -ForegroundColor Cyan
Write-Host "  Source: $InputFile"
Write-Host "  Entries: $($entries.Count)  |  DB changes: $($dbChanges.Count)  |  File: $($fileChgs.Count)  |  Service: $($svcChgs.Count)  |  EventLog: $($evtChgs.Count)"
Write-Host ''

# --- DB changes in chronological order ---
if ($dbChanges.Count -gt 0) {
    Write-Host '--- Database Changes (chronological) ---' -ForegroundColor Yellow
    $seq = 1
    foreach ($c in $dbChanges) {
        $color = if ($c.operation -eq 'INSERT') { 'Green' } elseif ($c.operation -eq 'DELETE') { 'Red' } else { 'Yellow' }
        Write-Host "  [$seq] [$($c.ts)] $($c.operation) $($c.table)" -ForegroundColor $color
        # Print non-empty fields
        $c.row.PSObject.Properties | Where-Object { $_.Value } | ForEach-Object {
            Write-Host "       $($_.Name) = $($_.Value)" -ForegroundColor DarkGray
        }
        $seq++
    }
    Write-Host ''

    # Summary by table
    Write-Host '--- Changes by Table ---' -ForegroundColor Yellow
    $dbChanges | Group-Object table | ForEach-Object {
        $inserts = ($_.Group | Where-Object operation -eq 'INSERT').Count
        $deletes = ($_.Group | Where-Object operation -eq 'DELETE').Count
        Write-Host ("  {0,-30} INSERT:{1,3}  DELETE:{2,3}" -f $_.Name, $inserts, $deletes)
    }
    Write-Host ''
}

# --- File changes ---
if ($fileChgs.Count -gt 0) {
    Write-Host '--- File Changes ---' -ForegroundColor Yellow
    $fileChgs | Group-Object { Split-Path $_.path -Leaf } | ForEach-Object {
        Write-Host "  $($_.Name)  ($($_.Count) events)"
    }
    Write-Host ''
}

# --- Service changes ---
if ($svcChgs.Count -gt 0) {
    Write-Host '--- Service Changes ---' -ForegroundColor Magenta
    foreach ($s in $svcChgs) {
        Write-Host "  $($s.service): $($s.before) -> $($s.after)"
    }
    Write-Host ''
}

# --- Event log ---
if ($evtChgs.Count -gt 0) {
    Write-Host '--- Windows Event Log ---' -ForegroundColor DarkYellow
    foreach ($e in $evtChgs) {
        Write-Host "  [$($e.source)] EventID $($e.eventId): $($e.message.Substring(0,[Math]::Min(100,$e.message.Length)))"
    }
    Write-Host ''
}

# --- Suggested API replication ---
Write-Host '--- Suggested API Operations to Replicate ---' -ForegroundColor Cyan
$cardInserts   = $dbChanges | Where-Object { $_.table -eq 'Card'       -and $_.operation -eq 'INSERT' }
$numInserts    = $dbChanges | Where-Object { $_.table -eq 'CardNumber' -and $_.operation -eq 'INSERT' }
$numDeletes    = $dbChanges | Where-Object { $_.table -eq 'CardNumber' -and $_.operation -eq 'DELETE' }
$itemInserts   = $dbChanges | Where-Object { $_.table -eq 'ItemCard'   -and $_.operation -eq 'INSERT' }
$cardDeletes   = $dbChanges | Where-Object { $_.table -eq 'Card'       -and $_.operation -eq 'DELETE' }

foreach ($r in $cardInserts) {
    Write-Host "  POST /api/v1/users  { name: '$($r.row.UserName)', ... }" -ForegroundColor Green
}
foreach ($r in $numInserts) {
    Write-Host "  POST /api/v1/cards  { cardholderID: $($r.row.PkCard), cardNumber: '$($r.row.CardNumberFormatted)', cardSlot: $([int]$r.row.CardPosition + 1) }" -ForegroundColor Green
}
foreach ($r in $numDeletes) {
    Write-Host "  DELETE /api/v1/cards/$($r.row.CardNumberFormatted)" -ForegroundColor Red
}
foreach ($r in $cardDeletes) {
    Write-Host "  DELETE /api/v1/users/$($r.row.PkData)  # $($r.row.UserName)" -ForegroundColor Red
}
if ($itemInserts.Count -gt 0) {
    Write-Host "  NOTE: ItemCard had $($itemInserts.Count) INSERT(s) - access level assignments may need an API endpoint" -ForegroundColor Yellow
}

Write-Host ''
