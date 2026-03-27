# Test: send encrypted username + password through REST Login endpoint
$webDir = 'C:\Program Files (x86)\Kantech\EntraPassWeb'
Add-Type -Path "$webDir\Tyco.Entrapass.SmartService.Client.dll"

$enc = New-Object Tyco.Entrapass.SmartService.Client.Business.Encryption
$key = '9a476835-601a-471b-b97d-79569325506d'
$encUser = $enc.Encrypt('rpelletier', $key)
$encPass = $enc.Encrypt('C@tsandD0gs!', $key)
$encProgram = $enc.Encrypt('KantechAPI', $key)
$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

Write-Host "EncUser: $encUser"
Write-Host "EncPass: $encPass"
Write-Host "EncProgram: $encProgram"

# Build the URL with ENCRYPTED username AND password
$url = "http://localhost:8801/SmartService/Login" +
       "?userName=$([uri]::EscapeDataString($encUser))" +
       "&password=$([uri]::EscapeDataString($encPass))" +
       "&encrypted=true" +
       "&languageBypassCode=" +
       "&LocalDateTime=$([uri]::EscapeDataString($now))" +
       "&DateFormat=yyyy-MM-dd" +
       "&TimeFormat=HH:mm:ss" +
       "&loginOnResume=0" +
       "&noMessage=0" +
       "&connectedProgram=$([uri]::EscapeDataString($encProgram))" +
       "&operatorLoginKey=$([uri]::EscapeDataString($encUser))"

Write-Host "`nURL: $url"
try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing
    Write-Host "Status: $($response.StatusCode)"
    $content = $response.Content
    # Check for SessionKey in XML
    if ($content -match 'SessionKey') {
        Write-Host "SUCCESS! Got session"
    }
    Write-Host "Response (first 500): $($content.Substring(0, [Math]::Min(500, $content.Length)))"
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $reader.ReadToEnd()
        Write-Host "Body: $($body.Substring(0, [Math]::Min(500, $body.Length)))"
    }
}
