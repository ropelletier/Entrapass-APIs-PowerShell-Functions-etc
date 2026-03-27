# Extract Door Control Methods from SmartService Client
Write-Host "========================================"
Write-Host "Door Control Methods in SmartService"
Write-Host "========================================"

$entrapassPath = "C:\Program Files (x86)\Kantech\EntraPassWeb\"

Add-Type -Path ($entrapassPath + "Tyco.Entrapass.SmartService.Client.dll")

$smartServiceClientAsm = [System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.FullName -match 'Tyco.Entrapass.SmartService.Client' } | Select-Object -First 1

if ($smartServiceClientAsm) {
    # Find DoorServiceExtensions
    Write-Host "`n=== DoorServiceExtensions ==="
    $doorExtensions = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'DoorServiceExtensions' }
    if ($doorExtensions) {
        Write-Host "Door Control Methods:"
        $doorExtensions.GetMembers() | Where-Object { $_.MemberType -eq 'Method' } | ForEach-Object {
            Write-Host "  - $($_.Name)"
        }
    }
    
    # Find door-related interfaces in Business namespace
    Write-Host "`n=== Business Namespace Interfaces ==="
    $businessTypes = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Namespace -eq 'Tyco.Entrapass.SmartService.Client.Business' -and $_.IsInterface }
    Write-Host "Found $($businessTypes.Count) interfaces in Business namespace:"
    $businessTypes | ForEach-Object {
        Write-Host "`nInterface: $($_.Name)"
        $_.GetMembers() | Where-Object { $_.MemberType -eq 'Method' } | ForEach-Object {
            Write-Host "  - $($_.Name)"
        }
    }
    
    # Find door-related models
    Write-Host "`n=== Door Models (from Tyco.Entrapass.SmartService.Client.Business.Models.Doors) ==="
    $doorModels = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Namespace -eq 'Tyco.Entrapass.SmartService.Client.Business.Models.Doors' }
    Write-Host "Found $($doorModels.Count) door model types:"
    $doorModels | ForEach-Object {
        Write-Host "`n  Type: $($_.Name)"
        if ($_.IsClass) {
            Write-Host "    [Class]"
        } elseif ($_.IsInterface) {
            Write-Host "    [Interface]"
        }
        $properties = $_.GetProperties() | Select-Object -First 10
        if ($properties) {
            Write-Host "    Properties:"
            $properties | ForEach-Object {
                Write-Host "      - $($_.Name) : $($_.PropertyType.Name)"
            }
        }
    }
}
