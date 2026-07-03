#Requires -Version 5.1
<#
.SYNOPSIS
  install-windows.ps1 - persist grip-session-mesh across reboots via Scheduled Tasks.

.DESCRIPTION
  Windows mirror of deploy/launchd/install-macos.sh. Registers three per-user
  ONLOGON Scheduled Tasks (bus, relay, per-session client). Each task starts at
  logon (New-ScheduledTaskTrigger -AtLogOn) and restarts on failure
  (RestartCount + RestartInterval) - the Task Scheduler equivalent of launchd's
  RunAtLoad + KeepAlive - so the mesh survives reboots and process death.
  Idempotent: an existing task is Unregister-ed then re-registered. Runs as the
  current user with no elevation (a per-user ONLOGON task needs no admin).

  The receive Monitor is intentionally NOT a task: it surfaces messages into a
  live Claude session, so each session starts its own.

  NO secret or token is written by this script. The relay reads the shared token
  at runtime from $HOME\.grip-session-mesh\token (placed by onboarding).

.PARAMETER SessionName
  Mesh session name for the client task. Defaults to a slug of $env:COMPUTERNAME.

.PARAMETER Repo
  Path to the grip-session-mesh checkout. Defaults to this script's ..\.. (repo root).

.PARAMETER Python
  Explicit python interpreter for the relay. If omitted, auto-detects one that can
  import 'websockets' (tries $HOME\.grip\venv, $HOME\.claude\venv, then python/python3 on PATH).

.PARAMETER Uninstall
  Remove the three tasks and exit (same as uninstall-windows.ps1).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -SessionName fabio-desktop

.LINK
  Verify:  Get-ScheduledTask -TaskName "GRIP Mesh*"
  Remove:  deploy\windows\uninstall-windows.ps1
#>
[CmdletBinding()]
param(
    [string]$SessionName,
    [string]$Repo,
    [string]$Python,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# --- stable task-name contract (shared with uninstall-windows.ps1) ---------
$TaskNames = @('GRIP Mesh Bus', 'GRIP Mesh Relay', 'GRIP Mesh Client')

function Get-ScriptDir {
    if ($PSScriptRoot) { return $PSScriptRoot }
    return (Split-Path -Parent $MyInvocation.MyCommand.Path)
}

function Get-SessionSlug {
    # Mirror macOS: lowercase, spaces -> '-', drop anything not [a-z0-9-].
    $slug = "$env:COMPUTERNAME".ToLower()
    $slug = $slug -replace ' ', '-'
    $slug = $slug -replace '[^a-z0-9-]', ''
    if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'grip-mesh' }
    return $slug
}

function Resolve-MeshPython {
    param([string]$Explicit)
    # Explicit choice wins; warn (do not hard-fail) if it cannot import websockets.
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) {
            throw "python not found at -Python path: $Explicit"
        }
        & $Explicit -c "import websockets" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "the -Python interpreter cannot import 'websockets' (pip install websockets). Using it anyway."
        }
        return $Explicit
    }
    $candidates = @(
        (Join-Path $HOME '.grip\venv\Scripts\python.exe'),
        (Join-Path $HOME '.claude\venv\Scripts\python.exe')
    )
    foreach ($name in @('python', 'python3')) {
        $onPath = Get-Command $name -ErrorAction SilentlyContinue
        if ($onPath) { $candidates += $onPath.Source }
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) {
            & $c -c "import websockets" 2>$null
            if ($LASTEXITCODE -eq 0) { return $c }
        }
    }
    throw "no python with 'websockets' found (pip install websockets). Pass -Python <path> to override."
}

function New-MeshCmdArgument {
    # Build a `cmd.exe /c` line that runs Program with ProgArgs and appends
    # stdout/stderr to the log files - the Scheduled-Task way to mirror launchd
    # StandardOutPath / StandardErrorPath. All tokens are quoted so paths with
    # spaces (e.g. C:\Users\Andre Theart\...) are safe; cmd strips only the
    # outer pair, leaving the inner command and redirections intact.
    param(
        [string]$Program,
        [string[]]$ProgArgs,
        [string]$OutLog,
        [string]$ErrLog
    )
    $parts = @('"{0}"' -f $Program)
    foreach ($a in $ProgArgs) { $parts += ('"{0}"' -f $a) }
    $inner = ($parts -join ' ')
    $inner += ' >> "{0}" 2>> "{1}"' -f $OutLog, $ErrLog
    return '/c "{0}"' -f $inner
}

function Install-MeshTask {
    param(
        [string]$Name,
        [string]$Program,
        [string[]]$ProgArgs,
        [string]$Short,
        [string]$RepoDir,
        [string]$LogsDir,
        [string]$MeshUser
    )
    $out = Join-Path $LogsDir "$Short.out.log"
    $err = Join-Path $LogsDir "$Short.err.log"
    $arg = New-MeshCmdArgument -Program $Program -ProgArgs $ProgArgs -OutLog $out -ErrLog $err

    $action  = New-ScheduledTaskAction -Execute $env:ComSpec -Argument $arg -WorkingDirectory $RepoDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $MeshUser
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $MeshUser -LogonType Interactive -RunLevel Limited

    # Idempotent update: if the task exists, remove then re-register (mirrors kickstart -k).
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
    # Start now so the mesh runs immediately, not only at next logon (mirrors launchd bootstrap).
    Start-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    Write-Host "registered + started: $Name"
}

function Remove-MeshTasks {
    param([string[]]$Names)
    foreach ($name in $Names) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "removed $name"
        }
        else {
            Write-Host "not present: $name"
        }
    }
}

# --- main -------------------------------------------------------------------
if ($Uninstall) {
    Remove-MeshTasks -Names $TaskNames
    Write-Host "grip-session-mesh scheduled tasks removed."
    return
}

$scriptDir = Get-ScriptDir
if (-not $Repo) { $Repo = Join-Path $scriptDir '..\..' }
$Repo = (Resolve-Path -LiteralPath $Repo).Path
if (-not $SessionName) { $SessionName = Get-SessionSlug }
$MeshUser = "$env:USERDOMAIN\$env:USERNAME"
$LogsDir  = Join-Path $HOME '.grip-session-mesh\logs'

# node is required for the bus + client tasks.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node not found on PATH (install Node.js)" }
$NodePath = $node.Source

# a python that can import websockets is required for the relay task.
$PyPath = Resolve-MeshPython -Explicit $Python

# the server must be built before the bus task can start.
$busEntry    = Join-Path $Repo 'server\dist\index.js'
$relayEntry  = Join-Path $Repo 'relay\mesh_relay.py'
$clientEntry = Join-Path $Repo 'client\mesh-client.js'
if (-not (Test-Path -LiteralPath $busEntry)) {
    throw "build the server first: npm install --prefix server && npm run build --prefix server"
}

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

Install-MeshTask -Name 'GRIP Mesh Bus'    -Program $NodePath -ProgArgs @($busEntry)                  -Short 'bus'    -RepoDir $Repo -LogsDir $LogsDir -MeshUser $MeshUser
Install-MeshTask -Name 'GRIP Mesh Relay'  -Program $PyPath   -ProgArgs @($relayEntry, 'connect')     -Short 'relay'  -RepoDir $Repo -LogsDir $LogsDir -MeshUser $MeshUser
Install-MeshTask -Name 'GRIP Mesh Client' -Program $NodePath -ProgArgs @($clientEntry, $SessionName) -Short 'client' -RepoDir $Repo -LogsDir $LogsDir -MeshUser $MeshUser

Write-Host ""
Write-Host "grip-session-mesh persisted for session '$SessionName' (repo: $Repo)."
Write-Host "Three logon tasks run at sign-in and restart on failure:"
Write-Host "  GRIP Mesh Bus     -> node   $busEntry"
Write-Host "  GRIP Mesh Relay   -> python $relayEntry connect   ($PyPath)"
Write-Host "  GRIP Mesh Client  -> node   $clientEntry $SessionName"
Write-Host "Logs: $LogsDir\{bus,relay,client}.{out,err}.log"
Write-Host "Note: the relay needs the shared team token at $HOME\.grip-session-mesh\token (placed by onboarding)."
Write-Host ""
Write-Host "Verify: Get-ScheduledTask -TaskName 'GRIP Mesh*'"
Write-Host "Remove: powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-windows.ps1"
