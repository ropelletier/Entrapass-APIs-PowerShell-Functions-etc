# SmartService Door Control API - Comprehensive Report
Write-Host "========================================"
Write-Host "SmartService Door Control API Report"
Write-Host "========================================"

$entrapassPath = "C:\Program Files (x86)\Kantech\EntraPassWeb\"
Add-Type -Path ($entrapassPath + "Tyco.Entrapass.SmartService.Client.dll")

$smartServiceClientAsm = [System.AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.FullName -match 'Tyco.Entrapass.SmartService.Client' } | Select-Object -First 1

if ($smartServiceClientAsm) {
    Write-Host "`n1. DOOR CONTROL OPERATIONS"
    Write-Host "=========================="
    
    Write-Host "`nLock/Unlock Operations:"
    Write-Host "  * Unlock: UnlockAsync(doorId: Int32, cancellationToken)"
    Write-Host "  * Lock: LockAsync(doorId: Int32, cancellationToken)"
    Write-Host "  * UnlockTemporary: UnlockTemporaryAsync(doorId: Int32, duration: TimeSpan, cancellationToken)"
    
    Write-Host "`nArm/Disarm Operations:"
    Write-Host "  * Arm: ArmAsync(doorId: Int32, forceSend?: bool, cancellationToken)"
    Write-Host "  * Disarm: DisarmAsync(doorId: Int32, forceSend?: bool, cancellationToken)"
    
    Write-Host "`nReader Control Operations:"
    Write-Host "  * EnableReader: EnableReaderAsync(doorId: Int32, force: bool, cancellationToken)"
    Write-Host "  * DisableReader: DisableReaderAsync(doorId: Int32, force: bool, cancellationToken)"
    
    Write-Host "`nOutput Control Operations:"
    Write-Host "  * ActiveOutput: ActiveOutputAsync(outputId: Int32, cancellationToken)"
    Write-Host "  * DeactiveOutput: DeactiveOutputAsync(outputId: Int32, cancellationToken)"
    
    Write-Host "`nSchedule Operations:"
    Write-Host "  * DoorBackToSchedule: DoorBackToScheduleAsync(doorId: Int32, cancellationToken)"
    Write-Host "  * DoorContactBackToSchedule: DoorContactBackToScheduleAsync(doorId: Int32, cancellationToken)"
    Write-Host "  * ModifySchedule: ModifyScheduleAsync(doorId: Int32, scheduleId: Int32, cancellationToken)"
    
    Write-Host "`nAccess Operations:"
    Write-Host "  * OneTimeAccess: OneTimeAccessAsync(doorId: Int32, cancellationToken)"
    
    Write-Host "`n`n2. QUERY/RETRIEVAL OPERATIONS"
    Write-Host "=============================="
    
    Write-Host "`nKey Methods:"
    Write-Host "  * GetListAsync: Get all doors"
    Write-Host "  * GetAsync: Get specific door by ID"
    Write-Host "  * GetFeaturesAsync: Get door features (elevators, time & attendance)"
    Write-Host "  * GetLastAccessAsync: Get last access event for door"
    Write-Host "  * GetOutputListAsync: Get associated outputs for door"
    Write-Host "  * GetScheduleListAsync: Get access schedules for door"
    Write-Host "  * GetAccessLevelAsync: Get access levels for door"
    
    Write-Host "`n`n3. SUGGESTED REST ENDPOINTS"
    Write-Host "===========================`n"
    
    Write-Host "Base URL: http://localhost:8801/SmartService/"
    
    Write-Host "`nQuery Endpoints:"
    Write-Host "  GET /api/doors - List all doors"
    Write-Host "  GET /api/doors/{doorId} - Get specific door"
    Write-Host "  GET /api/doors/{doorId}/features - Get door features"
    Write-Host "  GET /api/doors/{doorId}/last-access - Get last access event"
    Write-Host "  GET /api/doors/{doorId}/outputs - Get associated outputs"
    Write-Host "  GET /api/doors/{doorId}/schedules - Get access schedules"
    Write-Host "  GET /api/doors/{doorId}/access-level - Get access levels"
    
    Write-Host "`nControl Endpoints:"
    Write-Host "  POST /api/doors/{doorId}/unlock - Unlock door"
    Write-Host "  POST /api/doors/{doorId}/lock - Lock door"
    Write-Host "  POST /api/doors/{doorId}/unlock-temporary - Unlock for duration"
    Write-Host "  POST /api/doors/{doorId}/arm - Arm door alarm"
    Write-Host "  POST /api/doors/{doorId}/disarm - Disarm door alarm"
    Write-Host "  POST /api/doors/{doorId}/enable-reader - Enable reader"
    Write-Host "  POST /api/doors/{doorId}/disable-reader - Disable reader"
    Write-Host "  POST /api/doors/{doorId}/active-output - Activate output"
    Write-Host "  POST /api/doors/{doorId}/deactive-output - Deactivate output"
    Write-Host "  POST /api/doors/{doorId}/one-time-access - Grant one-time access"
    Write-Host "  POST /api/doors/{doorId}/back-to-schedule - Return to schedule"
    Write-Host "  POST /api/doors/{doorId}/modify-schedule - Change schedule"
    
    Write-Host "`n`n4. AVAILABLE INTERFACES AND SERVICES"
    Write-Host "===================================="
    
    $services = $smartServiceClientAsm.GetTypes() | Where-Object { $_.IsInterface -and $_.Namespace -like '*Business.Services*' } | Select-Object -First 20
    Write-Host "`nAvailable Service Interfaces:"
    $services | ForEach-Object {
        Write-Host "  * $($_.Name)"
    }
    
    Write-Host "`n`n5. DATA MODELS"
    Write-Host "==============="
    
    $DoorModel = $smartServiceClientAsm.GetTypes() | Where-Object { $_.Name -eq 'DoorModel' }
    if ($DoorModel) {
        Write-Host "`nDoorModel key properties:"
        $DoorModel.GetProperties() | Where-Object { $_.Name -match 'Id|Name|Description|Alarm|Arm|Contact|Lock' } | ForEach-Object {
            Write-Host "  * $($_.Name): $($_.PropertyType.Name)"
        }
    }
}

Write-Host "`n`n6. IMPLEMENTATION SUMMARY"
Write-Host "========================="

Write-Host "`nKey Findings:"
Write-Host "  1. SmartService exposes IDoorService interface with comprehensive door control"
Write-Host "  2. All operations are async (UnlockAsync, LockAsync, etc.) for non-blocking execution"
Write-Host "  3. Door control includes: lock/unlock, arm/disarm, reader control, output activation"
Write-Host "  4. Schedule management: can modify door schedules and revert to scheduled state"
Write-Host "  5. Access control: supports one-time access grants"

Write-Host "`nAuthentication:"
Write-Host "  - Use IAuthenticationService for login/logout"
Write-Host "  - Obtain session token via Login method"
Write-Host "  - All subsequent service calls require authentication context"

Write-Host "`nError Handling:"
Write-Host "  - Operations return async Task<T> for proper async/await patterns"
Write-Host "  - Exceptions should include CommandResultModel with status information"

Write-Host "`nPerformance Considerations:"
Write-Host "  - Use async methods to avoid blocking"
Write-Host "  - Batch door operations when possible (GetListAsync)"
Write-Host "  - Cache door features/schedules if unchanged frequently"

Write-Host "`n========================================"
Write-Host "Report Complete"
Write-Host "========================================"
