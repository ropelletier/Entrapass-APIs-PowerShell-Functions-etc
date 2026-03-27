# Try to understand how SmartService login works
# The SmartSdkDll.dll is the native unmanaged DLL that does the actual work

# Let's check if there's a SmartLink.ini or similar config
$paths = @(
    'C:\Program Files (x86)\Kantech\SmartService\SmartLink.ini',
    'C:\Program Files (x86)\Kantech\SmartService\SmartLink.cfg',
    'C:\Program Files (x86)\Kantech\Smartlink_CE\SmartLink.ini',
    'C:\Program Files (x86)\Kantech\Smartlink_CE\SmartLink.cfg',
    'C:\Program Files (x86)\Kantech\Server_CE\SmartLink.ini'
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        Write-Host "FOUND: $p"
        Get-Content $p | Select-Object -First 30
    }
}

# Check the Smartlink_CE directory for any data/config
Write-Host "`n=== Smartlink_CE directory ==="
if (Test-Path 'C:\Program Files (x86)\Kantech\Smartlink_CE') {
    Get-ChildItem 'C:\Program Files (x86)\Kantech\Smartlink_CE' -Recurse | ForEach-Object {
        Write-Host $_.FullName
    }
}

# Check registry for SmartLink/SmartService config
Write-Host "`n=== Registry - SmartLink ==="
$regPaths = @(
    'HKLM:\SOFTWARE\WOW6432Node\Kantech\SmartLink',
    'HKLM:\SOFTWARE\WOW6432Node\Kantech\SmartService',
    'HKLM:\SOFTWARE\Kantech\SmartLink',
    'HKLM:\SOFTWARE\Kantech\SmartService'
)
foreach ($rp in $regPaths) {
    if (Test-Path $rp) {
        Write-Host "FOUND: $rp"
        Get-ItemProperty $rp | Format-List
    }
}

# Check if the native SmartSdkDll.dll exports anything useful
Write-Host "`n=== SmartSdkDll.dll exports ==="
$dumpbin = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio*' -Recurse -Filter 'dumpbin.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($dumpbin) {
    & $dumpbin.FullName /exports 'C:\Program Files (x86)\Kantech\SmartService\SmartSdkDll.dll' 2>&1 | Select-Object -First 50
} else {
    Write-Host "dumpbin not found, trying strings approach"
    $bytes = [System.IO.File]::ReadAllBytes('C:\Program Files (x86)\Kantech\SmartService\SmartSdkDll.dll')
    # Find ASCII strings that look like function names
    $sb = New-Object System.Text.StringBuilder
    $strings = @()
    foreach ($b in $bytes) {
        if ($b -ge 0x20 -and $b -le 0x7E) {
            [void]$sb.Append([char]$b)
        } else {
            if ($sb.Length -ge 8) {
                $s = $sb.ToString()
                if ($s -match 'Login|Encrypt|Password|Session|Operator|WebDll|WebSend|Service|Register') {
                    $strings += $s
                }
            }
            [void]$sb.Clear()
        }
    }
    $strings | Select-Object -Unique | ForEach-Object { Write-Host $_ }
}
