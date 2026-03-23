#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Builds and installs the Kantech API (Node.js) as a Windows service.

.DESCRIPTION
    Compiles KantechApiService.cs with the local node.exe path and port baked in,
    then installs and starts the service. Re-run to update settings or rebuild.

    The service starts node.exe api\server.js and restarts it automatically if it crashes.

.NOTES
    Run once as Administrator. Re-run any time to update settings or rebuild.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load .env
. (Join-Path $PSScriptRoot 'Load-Env.ps1')
Import-EnvFile

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

$ServiceName  = 'KantechApiServer'
$DisplayName  = 'Kantech API Server'
$Description  = 'Kantech EntraPass REST API (Node.js + Express) on port 3000.'
$ProjectDir   = $PSScriptRoot
$ExePath      = Join-Path $ProjectDir 'KantechApiService.exe'
$CscPath      = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
$TemplateFile = Join-Path $ProjectDir 'KantechApiService.cs'
$BuildFile    = Join-Path $ProjectDir 'KantechApiService.build.cs'

$ApiPort = if ($env:API_PORT) { $env:API_PORT } else { '3000' }
$LogDir  = if ($env:EVENT_LOG_DIR) { $env:EVENT_LOG_DIR } else { 'C:\Exports\Kantech' }

# Locate node.exe
$NodeExe = $null
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
foreach ($candidate in @(
    'C:\Program Files (x86)\nodejs\node.exe',
    'C:\Program Files\nodejs\node.exe',
    $(if ($nodeCmd) { $nodeCmd.Source } else { '' })
)) {
    if ($candidate -and (Test-Path $candidate)) { $NodeExe = $candidate; break }
}

if (-not $NodeExe) {
    Write-Error "node.exe not found. Install Node.js or set the path manually in this script."
    exit 1
}

Write-Host "Using node.exe: $NodeExe"
Write-Host "API port:       $ApiPort"
Write-Host "Log directory:  $LogDir"
Write-Host ""

# ---------------------------------------------------------------------------
# Verify api\server.js and dependencies exist
# ---------------------------------------------------------------------------

$serverJs    = Join-Path $ProjectDir 'api\server.js'
$nodeModules = Join-Path $ProjectDir 'api\node_modules'

if (-not (Test-Path $serverJs)) {
    Write-Error "api\server.js not found. Run: cd C:\Projects\Kantech\api && npm install"
    exit 1
}

if (-not (Test-Path $nodeModules)) {
    Write-Host "api\node_modules not found - running npm install..."
    $npm = Join-Path (Split-Path $NodeExe) 'npm.cmd'
    & $npm --prefix (Join-Path $ProjectDir 'api') install
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit 1 }
    Write-Host "npm install complete."
}

# ---------------------------------------------------------------------------
# Stop and remove existing service
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
# Compile service binary
# ---------------------------------------------------------------------------

Write-Host "Building $ExePath..."

$src = Get-Content $TemplateFile -Raw
$src = $src `
    -replace '%%NODE_EXE%%', ($NodeExe -replace '\\', '\\') `
    -replace '%%API_PORT%%', $ApiPort `
    -replace '%%LOG_DIR%%',  ($LogDir  -replace '\\', '\\')

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
    Write-Error "Compilation failed. Check errors above."
    exit 1
}

Write-Host "Build succeeded: $ExePath"

# ---------------------------------------------------------------------------
# Install the service
# ---------------------------------------------------------------------------

New-Service `
    -Name           $ServiceName `
    -DisplayName    $DisplayName `
    -Description    $Description `
    -BinaryPathName $ExePath `
    -StartupType    Automatic | Out-Null

# Restart on failure: restart after 10s (attempt 1), 30s (attempt 2), 60s (attempt 3)
sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null

Write-Host ""
Write-Host "Service '$ServiceName' installed."
Write-Host ""
Write-Host "Starting service..."
Start-Service -Name $ServiceName
Start-Sleep -Seconds 4
Get-Service -Name $ServiceName | Select-Object Name, Status, StartType

Write-Host ""
Write-Host "Service log:  $LogDir\KantechApiService.log"
Write-Host "API base URL: http://localhost:$ApiPort/api/v1/"
Write-Host ""
Write-Host "First-time setup - create an API key:"
Write-Host "  cd C:\Projects\Kantech\api"
Write-Host "  node manage-keys.js create `"Admin`" 365"
Write-Host ""
