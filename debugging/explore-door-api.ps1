# SmartService Door API Explorer Script
Write-Host "========================================"
Write-Host "SmartService Door API Explorer"
Write-Host "========================================"

# Load the required DLLs
$entrapassPath = "C:\Program Files (x86)\Kantech\EntraPassWeb\"
$smartservicePath = "C:\Program Files (x86)\Kantech\SmartService\"

Write-Host "`nLoading SmartService Client DLL..."
try {
    Add-Type -Path ($entrapassPath + "Tyco.Entrapass.SmartService.Client.dll")
    Write-Host "OK: SmartService Client DLL loaded"
} catch {
    Write-Host "ERROR: Failed to load SmartService Client DLL: $_"
}

Write-Host "`nLoading SmartLinkSDK DLL..."
try {
    Add-Type -Path ($smartservicePath + "Kantech.SmartLinkSDK.dll")
    Write-Host "OK: SmartLinkSDK DLL loaded"
} catch {
    Write-Host "ERROR: Failed to load SmartLinkSDK DLL: $_"
}

Write-Host "`nLoading SmartSdkDll..."
try {
    Add-Type -Path ($smartservicePath + "SmartSdkDll.dll")
    Write-Host "OK: SmartSdkDll loaded"
} catch {
    Write-Host "ERROR: Failed to load SmartSdkDll: $_"
}

# Find IDoorService interface
Write-Host "`n========================================"
Write-Host "Searching for IDoorService interface..."
Write-Host "========================================"

try {
    $doorServiceType = [Type]::GetType("Tyco.Entrapass.SmartService.Client.Business.IDoorService")
    if ($doorServiceType) {
        Write-Host "`nFound IDoorService interface!"
        Write-Host "Members of IDoorService:"
        $doorServiceType.GetMembers() | ForEach-Object {
            Write-Host "  - $($_.Name) [$($_.MemberType)]"
        }
    } else {
        Write-Host "IDoorService interface not found"
    }
} catch {
    Write-Host "Error searching for IDoorService: $_"
}

# Find ISmartService interface
Write-Host "`n========================================"
Write-Host "Searching for ISmartService interface..."
Write-Host "========================================"

try {
    $smartServiceType = [Type]::GetType("Tyco.Entrapass.SmartService.Client.Business.ISmartService")
    if ($smartServiceType) {
        Write-Host "`nFound ISmartService interface!"
        Write-Host "All members of ISmartService:"
        $smartServiceType.GetMembers() | ForEach-Object {
            Write-Host "  - $($_.Name) [$($_.MemberType)]"
        }
        
        Write-Host "`nDoor-related members in ISmartService:"
        $smartServiceType.GetMembers() | Where-Object { $_.Name -match 'Door' -or $_.Name -match 'Lock' } | ForEach-Object {
            Write-Host "  - $($_.Name) [$($_.MemberType)]"
        }
    } else {
        Write-Host "ISmartService interface not found"
    }
} catch {
    Write-Host "Error searching for ISmartService: $_"
}

# Search for door-related types in SmartLinkSDK
Write-Host "`n========================================"
Write-Host "Door-related types in SmartLinkSDK..."
Write-Host "========================================"

try {
    $assembly = [System.Reflection.Assembly]::LoadFrom($smartservicePath + "Kantech.SmartLinkSDK.dll")
    Write-Host "Loaded SmartLinkSDK assembly"
    
    $doorTypes = $assembly.GetTypes() | Where-Object { $_.Name -match 'Door|Lock|Control|Command' }
    Write-Host "Found $($doorTypes.Count) door-related types:"
    $doorTypes | ForEach-Object {
        Write-Host "  - $($_.FullName)"
    }
    
} catch {
    Write-Host "Error with SmartLinkSDK: $_"
}

# Search in SmartSdkDll
Write-Host "`n========================================"
Write-Host "Door-related types in SmartSdkDll..."
Write-Host "========================================"

try {
    $assembly2 = [System.Reflection.Assembly]::LoadFrom($smartservicePath + "SmartSdkDll.dll")
    Write-Host "Loaded SmartSdkDll assembly"
    
    $doorTypes2 = $assembly2.GetTypes() | Where-Object { $_.Name -match 'Door|Lock|Control|Command' }
    Write-Host "Found $($doorTypes2.Count) door-related types:"
    $doorTypes2 | ForEach-Object {
        Write-Host "  - $($_.FullName)"
    }
    
} catch {
    Write-Host "Error with SmartSdkDll: $_"
}

# Search for all namespaces
Write-Host "`n========================================"
Write-Host "All namespaces in SmartLinkSDK..."
Write-Host "========================================"

try {
    $assembly = [System.Reflection.Assembly]::LoadFrom($smartservicePath + "Kantech.SmartLinkSDK.dll")
    $assembly.GetTypes() | ForEach-Object { $_.Namespace } | Sort-Object -Unique | ForEach-Object {
        Write-Host "  - $_"
    }
} catch {
    Write-Host "Error: $_"
}

Write-Host "`n========================================"
Write-Host "Exploration Complete"
Write-Host "========================================"
