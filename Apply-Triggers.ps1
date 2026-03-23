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
$conn.ConnectionString = "Server=$env:MYSQL_HOST;Port=$env:MYSQL_PORT;Database=$env:MYSQL_DATABASE;Uid=$env:MYSQL_USER;Password=$env:MYSQL_PASSWORD;SslMode=None;Connect Timeout=30;AllowUserVariables=True;"
$conn.Open()
Write-Host "Connected"

$sql = Get-Content (Join-Path $PSScriptRoot 'Create-ChangeLogTriggers.sql') -Raw
$sql = $sql -replace 'DELIMITER \$\$', '' -replace 'DELIMITER ;', ''
$statements = $sql -split '\$\$' | Where-Object { $_.Trim() -ne '' }

$ok = 0; $err = 0
foreach ($stmt in $statements) {
    $s = $stmt.Trim()
    if (-not $s) { continue }
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $s
    try { $cmd.ExecuteNonQuery() | Out-Null; $ok++ }
    catch { Write-Host ('ERR: ' + $_.Exception.Message.Split("`n")[0]); $err++ }
}
$conn.Close()
Write-Host ('Done: ' + $ok + ' OK, ' + $err + ' errors')
