# test-sdk-card.ps1 -- Prototype: write a card through the SmartLink SDK
# Must run in 32-bit PowerShell (SysWOW64) because the SDK is x86

param(
    [int]$CardholderID = 901,
    [string]$CardSlot  = '2',
    [string]$CardNumber = '8006:12345'
)

$ErrorActionPreference = 'Stop'

# Load SDK
$sdkPath = 'C:\Program Files (x86)\Kantech\SmartService\Kantech.SmartLinkSDK.dll'
Add-Type -Path $sdkPath
Write-Host "SDK loaded from $sdkPath"

# Helper: call generic method DataManager.GetComponentByID<Card>(int)
function Get-CardByID($dm, [int]$id) {
    $cardType = [Kantech.SmartLinkSDK.Card]
    $method = $dm.GetType().GetMethod('GetComponentByID', [type[]]@([int]))
    $generic = $method.MakeGenericMethod($cardType)
    return $generic.Invoke($dm, @($id))
}

# Connect to SmartService
$username = 'RSU_87'
$password = '12345678'
Write-Host "Connecting as $username ..."
$session = New-Object Kantech.SmartLinkSDK.OperatorSession($username, $password)
Write-Host "Session established. Key: $($session.SessionKey)"

# Get DataManager
$dm = $session.DataManager
Write-Host "DataManager ready."

# Load card by ID
Write-Host "Loading cardholder ID $CardholderID ..."
$card = Get-CardByID $dm $CardholderID
Write-Host "Loaded: $($card.UserName) (ID=$($card.ID), State=$($card.State))"
Write-Host "  Current CardNumber1: $($card.CardNumber1)"
Write-Host "  Current CardNumber2: $($card.CardNumber2)"
Write-Host "  Current CardNumber3: $($card.CardNumber3)"

# Set the card number on the requested slot
$propName = "CardNumber$CardSlot"
$displayPropName = "DisplayCardNumber$CardSlot"
Write-Host "Setting $propName = $CardNumber"
$card.$propName = $CardNumber
$card.$displayPropName = $true

# Save through the SDK (goes through SmartService WCF -> proper ADS path)
Write-Host "Saving changes..."
$card.SaveChanges()
Write-Host "SaveChanges() completed successfully!"

# Verify by reloading
$verify = Get-CardByID $dm $CardholderID
Write-Host ""
Write-Host "=== Verification (reloaded) ==="
Write-Host "  CardNumber1: $($verify.CardNumber1)"
Write-Host "  CardNumber2: $($verify.CardNumber2)"
Write-Host "  CardNumber3: $($verify.CardNumber3)"
Write-Host "  State: $($verify.State)"
Write-Host ""
Write-Host "Done! Check the EntraPass workstation -- the card should be visible immediately."
