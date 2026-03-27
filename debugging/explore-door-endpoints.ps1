$ErrorActionPreference = 'Stop'
$ssDir = 'C:\Program Files (x86)\Kantech\SmartService'

try { Add-Type -Path "$ssDir\Kantech.SmartLinkSDK.dll" -ErrorAction SilentlyContinue } catch {}
$asm = [System.Reflection.Assembly]::LoadFrom("$ssDir\Kantech.WCF.SmartService.dll")

Write-Host "Loaded: $($asm.FullName)"

foreach ($t in $asm.GetTypes()) {
    if ($t.IsInterface) {
        $methods = $t.GetMethods()
        $doorMethods = $methods | Where-Object { $_.Name -match 'Door|Unlock|Lock|Arm|Disarm|Schedule|Output|Reader|OneTime' }
        if ($doorMethods) {
            Write-Host "`n=== $($t.FullName) ==="
            foreach ($m in $doorMethods) {
                Write-Host "`n  METHOD: $($m.Name)"
                foreach ($attr in $m.GetCustomAttributes($true)) {
                    $attrName = $attr.GetType().Name
                    if ($attrName -match 'WebGet|WebInvoke') {
                        $uriTemplate = try { $attr.UriTemplate } catch { '' }
                        $httpMethod = try { $attr.Method } catch { '' }
                        $reqFormat = try { $attr.RequestFormat } catch { '' }
                        $resFormat = try { $attr.ResponseFormat } catch { '' }
                        Write-Host "    [$attrName] Method=$httpMethod UriTemplate=$uriTemplate ReqFmt=$reqFormat ResFmt=$resFormat"
                    }
                }
                $params = ($m.GetParameters() | ForEach-Object { "$($_.ParameterType.Name) $($_.Name)" }) -join ', '
                Write-Host "    Params: ($params)"
                Write-Host "    Returns: $($m.ReturnType.Name)"
            }
        }
    }
}
