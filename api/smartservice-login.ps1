# SmartService login bridge
# Called by Node.js to obtain a session key via ENCRYPTEDLOGIN
# Reads credentials from env vars (KANTECH_ADMIN_USER, KANTECH_ADMIN_PASSWORD)
# or falls back to reading from the .env file in the project root
# Optional: SMARTSERVICE_URI (default: http://localhost:8801/SmartService)
# Outputs JSON: { "sessionKey": "...", "operator": "..." } or { "error": "..." }

$ErrorActionPreference = 'Stop'
$webDir = 'C:\Program Files (x86)\Kantech\EntraPassWeb'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

$Username = $env:KANTECH_ADMIN_USER
$Password = $env:KANTECH_ADMIN_PASSWORD
$Uri = if ($env:SMARTSERVICE_URI) { $env:SMARTSERVICE_URI } else { 'http://localhost:8801/SmartService' }

# Fall back to .env file if env vars not set or contain backslash-escaped chars
if (-not $Username -or -not $Password -or $Password -match '\\') {
    $envFile = Join-Path $projectRoot '.env'
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match '^\s*([^#=]+?)\s*=\s*(.+?)\s*$') {
                $k = $matches[1]
                $v = $matches[2]
                if ($k -eq 'KANTECH_ADMIN_USER') { $Username = $v }
                if ($k -eq 'KANTECH_ADMIN_PASSWORD') { $Password = $v }
            }
        }
    }
}

if (-not $Username -or -not $Password) {
    Write-Output '{"error":"KANTECH_ADMIN_USER and KANTECH_ADMIN_PASSWORD not found in env or .env file"}'
    exit 1
}

try {
    # Load required DLLs
    $dlls = @(
        "$webDir\netstandard.dll",
        "$webDir\Tyco.Entrapass.SmartService.Client.dll",
        "$webDir\Tyco.Entrapass.Web.Core.dll",
        "$webDir\Tyco.Entrapass.Web.Configuration.dll",
        "$webDir\Tyco.Core.dll",
        "$webDir\Microsoft.Extensions.DependencyInjection.dll",
        "$webDir\Microsoft.Extensions.DependencyInjection.Abstractions.dll",
        "$webDir\AutoMapper.dll",
        "$webDir\Newtonsoft.Json.dll"
    )
    foreach ($dll in $dlls) {
        if (Test-Path $dll) {
            try { Add-Type -Path $dll -ErrorAction SilentlyContinue } catch {}
        }
    }

    # Compile ISystem implementation
    $refs = @(
        "$webDir\Tyco.Entrapass.SmartService.Client.dll",
        "$webDir\netstandard.dll",
        'System.dll'
    )
    $systemCode = @"
using System;
using Tyco.Entrapass.SmartService.Client;
public class BridgeSystem : ISystem {
    public Uri Uri { get; set; }
    public string Username { get; set; }
    public string Password { get; set; }
}
"@
    $cp = New-Object System.CodeDom.Compiler.CompilerParameters
    $cp.ReferencedAssemblies.AddRange($refs)
    $cp.GenerateInMemory = $true
    $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
    $cr = $provider.CompileAssemblyFromSource($cp, $systemCode)
    if ($cr.Errors.Count -gt 0) {
        $errMsg = ($cr.Errors | ForEach-Object { $_.ToString() }) -join '; '
        Write-Output (ConvertTo-Json @{ error = "Compile error: $errMsg" } -Compress)
        exit 1
    }

    $systemType = $cr.CompiledAssembly.GetType('BridgeSystem')
    $system = [Activator]::CreateInstance($systemType)
    $system.Uri = [Uri]$Uri
    $system.Username = $Username
    $system.Password = $Password

    # Create context and login
    $ctx = [Tyco.Entrapass.SmartService.Client.SmartServiceContext]::Create()
    $appType = [Tyco.Entrapass.SmartService.Client.Business.Options.Authentication.LoginApplicationType]::EntraPassWeb
    $loginOptions = [Activator]::CreateInstance(
        [Tyco.Entrapass.SmartService.Client.Business.Options.Authentication.LoginOptions],
        @($system, $appType)
    )

    $result = [Tyco.Entrapass.SmartService.Client.SmartServiceContextExtensions]::Login($ctx, $loginOptions)
    if ($result) {
        $op = $ctx.SmartService.Operator
        Write-Output (ConvertTo-Json @{
            sessionKey = $op.SessionKey
            operator = $op.OperatorName
        } -Compress)
    } else {
        Write-Output (ConvertTo-Json @{ error = "Login returned false" } -Compress)
        exit 1
    }
} catch {
    $msg = $_.Exception.Message
    $inner = $_.Exception.InnerException
    while ($inner) {
        $msg += " -> $($inner.Message)"
        $inner = $inner.InnerException
    }
    Write-Output (ConvertTo-Json @{ error = $msg } -Compress)
    exit 1
}
