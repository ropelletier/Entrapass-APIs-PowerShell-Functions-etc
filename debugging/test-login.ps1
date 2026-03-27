# Use the EntraPassWeb SmartService client to login properly
$ErrorActionPreference = 'Stop'

$webDir = 'C:\Program Files (x86)\Kantech\EntraPassWeb'

# Load all required DLLs
$dlls = @(
    "$webDir\Tyco.Entrapass.SmartService.Client.dll",
    "$webDir\Tyco.Entrapass.Web.Core.dll",
    "$webDir\Tyco.Entrapass.Web.Configuration.dll"
)
foreach ($dll in $dlls) {
    if (Test-Path $dll) {
        try { Add-Type -Path $dll -ErrorAction SilentlyContinue } catch {}
    }
}

$asm = [System.Reflection.Assembly]::LoadFrom("$webDir\Tyco.Entrapass.SmartService.Client.dll")

# Create a minimal ISystem implementation
$systemCode = @"
using Tyco.Entrapass.SmartService.Client;
public class SimpleSystem : ISystem {
    public string Username { get; set; }
    public string Password { get; set; }
}
"@

Add-Type -TypeDefinition $systemCode -ReferencedAssemblies @("$webDir\Tyco.Entrapass.SmartService.Client.dll")

$system = New-Object SimpleSystem
$system.Username = 'rpelletier'
$system.Password = 'C@tsandD0gs!'

# Create LoginOptions
$loginOptions = New-Object Tyco.Entrapass.SmartService.Client.Business.Options.Authentication.LoginOptions
$loginOptions.System = $system
$loginOptions.Encrypted = $false
$loginOptions.Message = $false

Write-Host "LoginOptions created: User=$($system.Username), Encrypted=$($loginOptions.Encrypted)"

# Create SmartServiceContext and try to login
$ctx = New-Object Tyco.Entrapass.SmartService.Client.SmartServiceContext
Write-Host "SmartServiceContext created"

# The context needs to know the SmartService URL
# Check if SmartService has a URL property
$ctxType = $ctx.GetType()
foreach ($p in $ctxType.GetProperties([System.Reflection.BindingFlags]'Public,NonPublic,Instance')) {
    Write-Host "  CTX PROP: $($p.PropertyType.Name) $($p.Name)"
}
foreach ($f in $ctxType.GetFields([System.Reflection.BindingFlags]'Public,NonPublic,Instance')) {
    Write-Host "  CTX FIELD: $($f.FieldType.Name) $($f.Name)"
}

# Try the sync Login extension method
try {
    $result = [Tyco.Entrapass.SmartService.Client.SmartServiceContextExtensions]::Login($ctx, $loginOptions)
    Write-Host "Login result: $result"
} catch {
    Write-Host "Login failed: $($_.Exception.Message)"
    Write-Host "Inner: $($_.Exception.InnerException.Message)"
}
