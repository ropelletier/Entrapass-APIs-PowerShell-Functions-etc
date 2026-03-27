# Get SmartService endpoints for door control
Write-Host "========================================"
Write-Host "SmartService Door Control Endpoints"
Write-Host "========================================"

$entrapassPath = "C:\Program Files (x86)\Kantech\EntraPassWeb\"

Add-Type -Path ($entrapassPath + "Tyco.Entrapass.SmartService.Client.dll")

$smartServiceClientAsm = [System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.FullName -match 'Tyco.Entrapass.SmartService.Client' } | Select-Object -First 1

if ($smartServiceClientAsm) {
    # Look for service interfaces in Business.Services namespace
    Write-Host "`n=== Services in Business.Services namespace ==="
    $services = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Namespace -like '*Business.Services*' }
    Write-Host "Found $($services.Count) service types:"
    
    $services | ForEach-Object {
        Write-Host "`n  Type: $($_.Name)"
        if ($_.IsInterface) {
            Write-Host "    [Interface]"
        } elseif ($_.IsClass) {
            Write-Host "    [Class]"
        }
    }
    
    # Get Door-specific service extension methods
    Write-Host "`n=== Door Operation Methods (DoorServiceExtensions) ==="
    $doorExtensions = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'DoorServiceExtensions' }
    if ($doorExtensions) {
        $methods = $doorExtensions.GetMembers() | Where-Object { $_.MemberType -eq 'Method' }
        
        Write-Host "Lock/Unlock Operations:"
        @('Unlock', 'Lock', 'UnlockTemporary', 'ArmAsync', 'DisarmAsync') | ForEach-Object {
            $methodName = $_
            $method = $methods | Where-Object { $_.Name -eq $methodName }
            if ($method) {
                Write-Host "  - $($method[0].Name)"
            }
        }
        
        Write-Host "`nReader Operations:"
        @('EnableReader', 'DisableReader') | ForEach-Object {
            $methodName = $_
            $method = $methods | Where-Object { $_.Name -eq $methodName }
            if ($method) {
                Write-Host "  - $($method[0].Name)"
            }
        }
        
        Write-Host "`nOutput Operations:"
        @('ActiveOutput', 'DeactiveOutpus') | ForEach-Object {
            $methodName = $_
            $method = $methods | Where-Object { $_.Name -eq $methodName }
            if ($method) {
                Write-Host "  - $($method[0].Name)"
            }
        }
        
        Write-Host "`nSchedule Operations:"
        @('DoorBackToSchedule', 'DoorContactBackToSchedule', 'ModifySchedule') | ForEach-Object {
            $methodName = $_
            $method = $methods | Where-Object { $_.Name -eq $methodName }
            if ($method) {
                Write-Host "  - $($method[0].Name)"
            }
        }
        
        Write-Host "`nAccess Operations:"
        @('OneTimeAccess') | ForEach-Object {
            $methodName = $_
            $method = $methods | Where-Object { $_.Name -eq $methodName }
            if ($method) {
                Write-Host "  - $($method[0].Name)"
            }
        }
    }
    
    # Look for Controller operations
    Write-Host "`n=== Controller Operations (ControllerServiceExtensions) ==="
    $controllerExtensions = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'ControllerServiceExtensions' }
    if ($controllerExtensions) {
        Write-Host "Found ControllerServiceExtensions with methods for device management"
    }
    
    # Look for Command classes/models
    Write-Host "`n=== Command/Control Models ==="
    $commandTypes = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -match 'Command|Control' -and $_.Namespace -like '*Models*' }
    if ($commandTypes) {
        Write-Host "Found command/control types:"
        $commandTypes | ForEach-Object {
            Write-Host "  - $($_.FullName)"
        }
    }
}

Write-Host "`n========================================"
Write-Host "`nBased on the reflection, SmartService provides:"
Write-Host "  - DoorServiceExtensions with methods:"
Write-Host "    * Unlock / UnlockAsync / UnlockTemporary"
Write-Host "    * Lock / LockAsync"
Write-Host "    * ArmAsync / DisarmAsync"
Write-Host "    * ActiveOutput / DeactiveOutpus"
Write-Host "    * EnableReader / DisableReader"
Write-Host "    * DoorBackToSchedule / DoorContactBackToSchedule"
Write-Host "    * OneTimeAccess"
Write-Host "`nThese are accessible via the SmartService REST API at http://localhost:8801/SmartService/"
Write-Host "========================================"
