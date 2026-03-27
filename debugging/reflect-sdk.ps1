$dllPath = 'C:\Program Files (x86)\Kantech\EntraPassWeb\Tyco.Entrapass.SmartService.Client.dll'
Add-Type -Path $dllPath

$enc = New-Object Tyco.Entrapass.SmartService.Client.Business.Encryption
$key = '9a476835-601a-471b-b97d-79569325506d'

$pw1 = $enc.Encrypt('C@tsandD0gs!', $key)
$pw2 = $enc.Encrypt('12345678', $key)

Write-Host "rpelletier encrypted: $pw1"
Write-Host "RSU_87 encrypted: $pw2"
