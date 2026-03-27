# SmartService Door API Explorer Script - Fixed version
Write-Host "========================================"
Write-Host "SmartService Door API Explorer v3"
Write-Host "========================================"

# Load the SmartService Client DLL
$entrapassPath = "C:\Program Files (x86)\Kantech\EntraPassWeb\"

Write-Host "`nLoading SmartService Client DLL..."
try {
    Add-Type -Path ($entrapassPath + "Tyco.Entrapass.SmartService.Client.dll")
    Write-Host "OK: SmartService Client DLL loaded"
} catch {
    Write-Host "ERROR: Failed to load SmartService Client DLL: $_"
    exit 1
}

# Get all loaded assemblies and find ours
Write-Host "`n========================================"
Write-Host "Exploring SmartService Client Assembly..."
Write-Host "========================================"

$smartServiceClientAsm = [System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.FullName -match 'Tyco.Entrapass.SmartService.Client' } | Select-Object -First 1

if ($smartServiceClientAsm) {
    Write-Host "Loaded SmartService Client assembly: $($smartServiceClientAsm.FullName)"
    
    # Get all namespaces
    Write-Host "`nAll namespaces in SmartService Client:"
    $smartServiceClientAsm.GetTypes() | ForEach-Object { $_.Namespace } | Sort-Object -Unique | ForEach-Object {
        Write-Host "  - $_"
    }
    
    # Find door-related types
    Write-Host "`n========================================"
    Write-Host "Door-related types in SmartService Client:"
    Write-Host "========================================"
    
    $doorTypes = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -match 'Door|Lock|Control|Command|Service' }
    Write-Host "Found $($doorTypes.Count) types matching Door/Lock/Control/Command/Service"
    $doorTypes | ForEach-Object {
        Write-Host "`nType: $($_.FullName)"
        if ($_.IsInterface) {
            Write-Host "  [Interface]"
        } elseif ($_.IsClass) {
            Write-Host "  [Class]"
        }
        if ($_.BaseType) {
            Write-Host "  Base Type: $($_.BaseType.Name)"
        }
        
        # Show methods and properties
        $members = $_.GetMembers() | Where-Object { $_.MemberType -match 'Method|Property' }
        if ($members) {
            Write-Host "  Members ($($members.Count)):"
            $members | ForEach-Object {
                Write-Host "    - $($_.Name) [$($_.MemberType)]"
            }
        }
    }
    
    # Specifically look for Business namespace
    Write-Host "`n========================================"
    Write-Host "Business Namespace Types..."
    Write-Host "========================================"
    
    $businessTypes = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Namespace -eq 'Tyco.Entrapass.SmartService.Client.Business' }
    Write-Host "Found $($businessTypes.Count) types in Business namespace:"
    $businessTypes | ForEach-Object {
        Write-Host "`nType: $($_.FullName)"
        if ($_.IsInterface) {
            Write-Host "  [Interface]"
            Write-Host "  Members:"
            $_.GetMembers() | ForEach-Object {
                Write-Host "    - $($_.Name) [$($_.MemberType)]"
            }
        }
    }
    
    # Look specifically for ISmartService and IDoorService
    Write-Host "`n========================================"
    Write-Host "Searching for Key Interfaces..."
    Write-Host "========================================"
    
    $iSmartService = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'ISmartService' }
    $iDoorService = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'IDoorService' }
    
    if ($iSmartService) {
        Write-Host "`nFound ISmartService!"
        Write-Host "ISmartService Members:"
        $iSmartService.GetMembers() | ForEach-Object {
            Write-Host "  - $($_.Name) [$($_.MemberType)]"
        }
    }
    
    if ($iDoorService) {
        Write-Host "`nFound IDoorService!"
        Write-Host "IDoorService Members:"
        $iDoorService.GetMembers() | ForEach-Object {
            Write-Host "  - $($_.Name) [$($_.MemberType)]"
        }
    }
    
} else {
    Write-Host "Could not get SmartService Client assembly"
}

Write-Host "`nExploration Complete"
