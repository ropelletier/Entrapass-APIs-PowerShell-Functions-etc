#Requires -Version 5.1
. (Join-Path $PSScriptRoot 'Load-Env.ps1')
Import-EnvFile

$dllDir = $PSScriptRoot
foreach ($dep in @('System.Buffers.dll','System.Runtime.CompilerServices.Unsafe.dll','System.Threading.Tasks.Extensions.dll','System.Memory.dll')) {
    $p = Join-Path $dllDir $dep
    if (Test-Path $p) { try { Add-Type -Path $p } catch {} }
}
Add-Type -Path (Join-Path $dllDir 'MySqlConnector.dll')

$conn = New-Object MySqlConnector.MySqlConnection
$conn.ConnectionString = "Server=$env:MYSQL_HOST;Port=$env:MYSQL_PORT;Database=$env:MYSQL_DATABASE;Uid=$env:MYSQL_USER;Password=$env:MYSQL_PASSWORD;SslMode=None;Connect Timeout=30;"
$conn.Open()

$cmd = $conn.CreateCommand()
$cmd.CommandText = @"
CREATE OR REPLACE VIEW kantech_events AS
SELECT
    e.EventDateTime                                                         AS ``datetime``,
    REPLACE(REPLACE(REPLACE(e.DoorName,'RSU_87, ',''),'Carmel Elementary','CES'),'Caravel','CMS')
                                                                            AS ``door``,
    e.CardholderName                                                        AS ``username``,
    CONCAT(UPPER(SUBSTR(c.AccessLevel,1,1)), LOWER(SUBSTR(c.AccessLevel,2)))
                                                                            AS ``Name_exp_4``,
    e.EventType                                                             AS ``event``
FROM kantech_door_events e
LEFT JOIN (
    SELECT CardholderID, MIN(AccessLevel) AS AccessLevel
    FROM kantech_cards
    GROUP BY CardholderID
) c ON e.CardholderID = c.CardholderID
ORDER BY e.EventDateTime DESC
"@

$cmd.ExecuteNonQuery() | Out-Null
Write-Host "View 'kantech_events' created."

# Show 5 sample rows
$cmd.CommandText = "SELECT * FROM kantech_events LIMIT 5"
$r = $cmd.ExecuteReader()
Write-Host ('{0,-22}  {1,-22}  {2,-25}  {3,-20}  {4}' -f 'datetime','door','username','Name_exp_4','event')
Write-Host ('{0,-22}  {1,-22}  {2,-25}  {3,-20}  {4}' -f '--------','----','--------','----------','-----')
while ($r.Read()) {
    Write-Host ('{0,-22}  {1,-22}  {2,-25}  {3,-20}  {4}' -f $r.GetValue(0), $r.GetValue(1), $r.GetValue(2), $r.GetValue(3), $r.GetValue(4))
}
$r.Close()
$conn.Close()
