# Sync-Kantech.ps1
# Syncs skill files to remote server and/or pushes git changes.
# Saves choices as defaults in .sync-config.json (gitignored).

param(
    [switch]$NoPrompt   # use saved defaults without asking
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir  = $PSScriptRoot
$ConfigFile = Join-Path $ScriptDir '.sync-config.json'

# ---------------------------------------------------------------------------
# Defaults (used on first run or as fallback)
# ---------------------------------------------------------------------------
$Defaults = [ordered]@{
    RemoteHost        = 'rpadmin@10.10.100.10'
    RemoteSkillsDir   = '/opt/xerox-syslog/skills/'
    LocalSkillsDir    = '.claude/skills'
    GitRemote         = 'origin'
    GitBranch         = 'main'
    SyncSkills        = $true
    GitPush           = $true
    CommitMessageMode = 'auto'   # 'auto' | 'prompt'
}

# ---------------------------------------------------------------------------
# Load saved config (merge over defaults)
# ---------------------------------------------------------------------------
$Config = [ordered]@{}
foreach ($key in $Defaults.Keys) { $Config[$key] = $Defaults[$key] }
if (Test-Path $ConfigFile) {
    try {
        $saved = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        foreach ($key in $saved.PSObject.Properties.Name) {
            if ($Config.Contains($key)) {
                $Config[$key] = $saved.$key
            }
        }
    } catch {
        Write-Warning "Could not load .sync-config.json: $_"
    }
}

# ---------------------------------------------------------------------------
# Helper: prompt with current default shown
# ---------------------------------------------------------------------------
function Ask-String([string]$prompt, [string]$default) {
    $display = if ($default) { "$prompt [$default]: " } else { "${prompt}: " }
    $input = Read-Host $display
    if ([string]::IsNullOrWhiteSpace($input)) { $default } else { $input.Trim() }
}

function Ask-Bool([string]$prompt, [bool]$default) {
    $hint = if ($default) { 'Y/n' } else { 'y/N' }
    $input = Read-Host "$prompt [$hint]"
    if ([string]::IsNullOrWhiteSpace($input)) { return $default }
    return ($input.Trim() -match '^[Yy]')
}

# ---------------------------------------------------------------------------
# Prompt for choices (unless -NoPrompt)
# ---------------------------------------------------------------------------
if (-not $NoPrompt) {
    Write-Host ''
    Write-Host '=== Kantech Sync Configuration ===' -ForegroundColor Cyan
    Write-Host '(Press Enter to accept defaults shown in brackets)'
    Write-Host ''

    $Config['SyncSkills']        = Ask-Bool  'Sync skill files to remote server' $Config['SyncSkills']
    if ($Config['SyncSkills']) {
        $Config['RemoteHost']      = Ask-String 'Remote host (user@host)'          $Config['RemoteHost']
        $Config['RemoteSkillsDir'] = Ask-String 'Remote skills directory'           $Config['RemoteSkillsDir']
        $Config['LocalSkillsDir']  = Ask-String 'Local skills directory'            $Config['LocalSkillsDir']
    }

    $Config['GitPush']           = Ask-Bool  'Push to git remote'                  $Config['GitPush']
    if ($Config['GitPush']) {
        $Config['GitRemote']       = Ask-String 'Git remote'                        $Config['GitRemote']
        $Config['GitBranch']       = Ask-String 'Git branch'                        $Config['GitBranch']
        $Config['CommitMessageMode'] = Ask-String 'Commit message mode (auto/prompt)' $Config['CommitMessageMode']
    }

    Write-Host ''

    # Save config
    $Config | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8
    Write-Host "Defaults saved to .sync-config.json" -ForegroundColor DarkGray
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Sync skills
# ---------------------------------------------------------------------------
if ($Config['SyncSkills']) {
    $localSkills = Join-Path $ScriptDir $Config['LocalSkillsDir']
    if (-not (Test-Path $localSkills)) {
        Write-Warning "Local skills directory not found: $localSkills"
    } else {
        $files = @(Get-ChildItem $localSkills -File)
        if ($files.Count -eq 0) {
            Write-Warning "No files found in $localSkills"
        } else {
            Write-Host "Syncing $($files.Count) skill file(s) to $($Config['RemoteHost']):$($Config['RemoteSkillsDir'])..." -ForegroundColor Cyan
            foreach ($f in $files) {
                $dest = "$($Config['RemoteHost']):$($Config['RemoteSkillsDir'])$($f.Name)"
                Write-Host "  scp $($f.Name) -> $dest"
                scp $f.FullName $dest
                if ($LASTEXITCODE -ne 0) {
                    Write-Error "scp failed for $($f.Name)"
                }
            }
            Write-Host "Skills synced." -ForegroundColor Green
        }
    }
}

# ---------------------------------------------------------------------------
# Git push
# ---------------------------------------------------------------------------
if ($Config['GitPush']) {
    Push-Location $ScriptDir
    try {
        # Check for uncommitted changes
        $status = git status --porcelain 2>&1
        if ($status) {
            Write-Host ''
            Write-Host 'Uncommitted changes:' -ForegroundColor Yellow
            git status --short

            if ($Config['CommitMessageMode'] -eq 'prompt') {
                $msg = Ask-String 'Commit message' 'Update Kantech configuration'
            } else {
                $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
                $msg = "Auto-sync $timestamp"
            }

            Write-Host ''
            Write-Host "Committing: $msg" -ForegroundColor Cyan
            git add -A
            git commit -m $msg
            if ($LASTEXITCODE -ne 0) { Write-Error 'git commit failed' }
        } else {
            Write-Host 'No uncommitted changes.' -ForegroundColor DarkGray
        }

        Write-Host "Pushing to $($Config['GitRemote'])/$($Config['GitBranch'])..." -ForegroundColor Cyan
        git push $Config['GitRemote'] $Config['GitBranch']
        if ($LASTEXITCODE -ne 0) { Write-Error 'git push failed' }
        Write-Host 'Push complete.' -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
