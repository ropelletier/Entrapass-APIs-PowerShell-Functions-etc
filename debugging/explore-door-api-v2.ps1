# SmartService Door API Explorer Script - Analyzing loaded assemblies
Write-Host "========================================"
Write-Host "SmartService Door API Explorer v2"
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

# Get all loaded assemblies
Write-Host "`n========================================"
Write-Host "Exploring SmartService Client Assembly..."
Write-Host "========================================"

# Try to get the assembly by name
$smartServiceClientAsm = [System.Reflection.Assembly]::GetAssemblyByName("Tyco.Entrapass.SmartService.Client")
if ($smartServiceClientAsm) {
    Write-Host "Loaded SmartService Client assembly"
    
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
    Write-Host "Found $($doorTypes.Count) types:"
    $doorTypes | ForEach-Object {
        Write-Host "`n  Type: $($_.FullName)"
        if ($_.IsInterface) {
            Write-Host "    [Interface]"
        } elseif ($_.IsClass) {
            Write-Host "    [Class]"
        }
        
        # Show methods and properties
        $members = $_.GetMembers() | Where-Object { $_.MemberType -match 'Method|Property' }
        if ($members) {
            Write-Host "    Members: $($members.Count)"
            $members | ForEach-Object {
                Write-Host "      - $($_.Name) [$($_.MemberType)]"
            }
        }
    }
    
    # Specifically look for IDoorService and ISmartService
    Write-Host "`n========================================"
    Write-Host "Searching for Business Interfaces..."
    Write-Host "========================================"
    
    $businessTypes = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Namespace -match 'Business' }
    Write-Host "Types in Business namespace:"
    $businessTypes | ForEach-Object {
        Write-Host "  - $($_.FullName) [$($_.BaseType.Name)]"
        if ($_.IsInterface) {
            Write-Host "    INTERFACE MEMBERS:"
            $_.GetMembers() | ForEach-Object {
                Write-Host "      - $($_.Name)"
            }
        }
    }
} else {
    Write-Host "Could not get SmartService Client assembly"
}

# Also check what's in AppDomain
Write-Host "`n========================================"
Write-Host "All loaded assemblies in AppDomain:"
Write-Host "========================================"
[System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.FullName -match 'Kantech|Tyco|Entrapass|SmartService|Smart' } | ForEach-Object {
    Write-Host "  - $($_.FullName)"
}

Write-Host "`nExploration Complete"
