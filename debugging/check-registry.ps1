$regPaths = @(
    'HKLM:\SOFTWARE\WOW6432Node\Kantech\EntraPass',
    'HKLM:\SOFTWARE\WOW6432Node\Kantech\EntraPass\Security',
    'HKLM:\SOFTWARE\WOW6432Node\Kantech\EntraPass\SmartService'
)
foreach ($rp in $regPaths) {
    if (Test-Path $rp) {
        Write-Host "=== $rp ==="
        $props = Get-ItemProperty $rp
        $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
            Write-Host "  $($_.Name) = $($_.Value)"
        }
    }
}
