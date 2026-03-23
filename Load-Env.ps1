<#
.SYNOPSIS
    Loads key=value pairs from a .env file into the current PowerShell session
    as script-scoped variables. Called by all scripts in this folder.

.PARAMETER EnvFile
    Path to the .env file. Defaults to .env in the same directory as this script.
#>
function Import-EnvFile {
    param(
        [string]$EnvFile = (Join-Path $PSScriptRoot '.env')
    )

    if (-not (Test-Path $EnvFile)) {
        Write-Warning "No .env file found at: $EnvFile"
        Write-Warning "Copy .env.example to .env and fill in your values."
        return
    }

    $count = 0
    foreach ($line in Get-Content $EnvFile) {
        # Skip blank lines and comments
        if ($line -match '^\s*$' -or $line -match '^\s*#') { continue }

        if ($line -match '^\s*([^=]+?)\s*=\s*(.*)\s*$') {
            $key   = $Matches[1].Trim()
            $value = $Matches[2].Trim()
            # Set in both the caller's scope and as an env var
            Set-Variable -Name $key -Value $value -Scope Script -Force
            [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
            $count++
        }
    }
    return $count
}
