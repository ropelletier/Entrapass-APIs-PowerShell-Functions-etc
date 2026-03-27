# Examine WCF SmartService structure and REST endpoints
Write-Host "========================================"
Write-Host "WCF SmartService Endpoint Analysis"
Write-Host "========================================"

$entrapassPath = "C:\Program Files (x86)\Kantech\EntraPassWeb\"
$smartservicePath = "C:\Program Files (x86)\Kantech\SmartService\"

Add-Type -Path ($entrapassPath + "Tyco.Entrapass.SmartService.Client.dll")

$smartServiceClientAsm = [System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.FullName -match 'Tyco.Entrapass.SmartService.Client' } | Select-Object -First 1

if ($smartServiceClientAsm) {
    # Look for interfaces that would define WCF service contracts
    Write-Host "`n=== Looking for Service Contract Interfaces ==="
    
    # Get IDoorService interface details
    Write-Host "`nIDoorService Methods:"
    $IDoorService = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'IDoorService' }
    if ($IDoorService) {
        $IDoorService.GetMembers() | Where-Object { $_.MemberType -eq 'Method' } | ForEach-Object {
            $method = $_
            Write-Host "  - $($method.Name)"
            
            # Get return type and parameter types
            $returnType = $method.ReturnType.Name
            $parameters = $method.GetParameters()
            if ($parameters.Count -gt 0) {
                $paramList = ($parameters | ForEach-Object { "$($_.Name): $($_.ParameterType.Name)" }) -join ", "
                Write-Host "      Params: [$paramList]"
            }
        }
    }
    
    # Look for Unlock/Lock method signatures specifically
    Write-Host "`n=== Unlock/Lock Method Details ==="
    
    # Get the actual method from DoorService class
    $DoorService = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'DoorService' }
    if ($DoorService) {
        $methods = $DoorService.GetMembers() | Where-Object { $_.MemberType -eq 'Method' }
        
        @('Unlock', 'Lock', 'UnlockTemporary') | ForEach-Object {
            $methodName = $_
            $method = $methods | Where-Object { $_.Name -eq $methodName }
            if ($method) {
                Write-Host "`n  $($method[0].Name):"
                foreach ($m in $method) {
                    Write-Host "    Signature: $($m.ReturnType.Name) $($m.Name)("
                    $m.GetParameters() | ForEach-Object {
                        Write-Host "      $($_.ParameterType.Name) `$$($_.Name),"
                    }
                    Write-Host "    )"
                }
            }
        }
    }
    
    # Check for any custom attributes on service types
    Write-Host "`n=== Service Configuration Details ==="
    $IDoorService | ForEach-Object {
        $type = $_
        Write-Host "IDoorService Attributes:"
        $type.GetCustomAttributes() | ForEach-Object {
            Write-Host "  - $($_.GetType().Name): $($_.GetType().FullName)"
        }
    }
    
    # Get DoorModel details
    Write-Host "`n=== DoorModel Structure ==="
    $DoorModel = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'DoorModel' }
    if ($DoorModel) {
        Write-Host "DoorModel Properties:"
        $DoorModel.GetProperties() | Select-Object -First 15 | ForEach-Object {
            Write-Host "  - $($_.Name): $($_.PropertyType.Name)"
        }
    }
}

Write-Host "`n========================================"
Write-Host "REST Endpoint Mapping"
Write-Host "========================================"
Write-Host "Based on WCF REST standards and the SmartService implementation,"
Write-Host "the following endpoints should be available:"
Write-Host ""
Write-Host "Door Operations (http://localhost:8801/SmartService/):"
Write-Host "  GET    /smartservice/doors"
Write-Host "  GET    /smartservice/doors/{doorId}"
Write-Host "  POST   /smartservice/doors/{doorId}/unlock"
Write-Host "  POST   /smartservice/doors/{doorId}/lock"
Write-Host "  POST   /smartservice/doors/{doorId}/unlock-temporary"
Write-Host "  POST   /smartservice/doors/{doorId}/enable-reader"
Write-Host "  POST   /smartservice/doors/{doorId}/disable-reader"
Write-Host "  POST   /smartservice/doors/{doorId}/active-output"
Write-Host "  POST   /smartservice/doors/{doorId}/deactive-output"
Write-Host "  POST   /smartservice/doors/{doorId}/one-time-access"
Write-Host "========================================"
