# Quick debug: check what the param receives
param(
    [string]$Password = 'C@tsandD0gs!'
)
Write-Host "Password: [$Password]"
Write-Host "Length: $($Password.Length)"
Write-Host "Chars: $(($Password.ToCharArray() | ForEach-Object { [int]$_ }) -join ',')"
