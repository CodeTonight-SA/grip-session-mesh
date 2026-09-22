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

  Each task runs a generated .cmd launcher through run-hidden.vbs under
  wscript.exe, so NO console window appears at logon. Invoking the console
  program directly under an Interactive principal drew one visible window per
  task at every sign-in; see the comments in Install-MeshTask for the two
  alternatives (-Hidden, S4U) that were measured and rejected.
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

function New-MeshLauncher {
    # Write a per-service .cmd launcher holding the real command line and its
    # log redirection, and return its path - the Scheduled-Task way to mirror
    # launchd StandardOutPath / StandardErrorPath. All tokens are quoted so
    # paths with spaces (e.g. C:\Users\Andre Theart\...) are safe.
    #
    # Why a FILE and not an inline `cmd.exe /c "..."` argument: the task now
    # runs through run-hidden.vbs (see Install-MeshTask) to suppress the
    # console window, and that shim takes exactly ONE argument. Handing it a
    # file path keeps quoting to a single level instead of nesting quotes
    # inside quotes inside a WSH argument, which is where this breaks.
    #
    # The file is machine state - it holds absolute paths - so it lives beside
    # the logs under $HOME, never in the repo.
    param(
        [string]$Program,
        [string[]]$ProgArgs,
        [string]$OutLog,
        [string]$ErrLog,
        [string]$LauncherDir,
        [string]$Short
    )
    $parts = @('"{0}"' -f $Program)
    foreach ($a in $ProgArgs) { $parts += ('"{0}"' -f $a) }
    $line = ($parts -join ' ')
    $line += ' >> "{0}" 2>> "{1}"' -f $OutLog, $ErrLog

    $path = Join-Path $LauncherDir "$Short.cmd"
    # Oem, not ASCII or UTF8: cmd.exe reads a .cmd in the console OEM codepage.
    # ASCII would replace a non-ASCII path character (an accented user name)
    # with '?' and silently break the launcher for that user.
    Set-Content -Path $path -Value "@echo off`r`n$line" -Encoding Oem
    return $path
}

function Install-MeshTask {
    param(
        [string]$Name,
        [string]$Program,
        [string[]]$ProgArgs,
        [string]$Short,
        [string]$RepoDir,
        [string]$LogsDir,
        [string]$MeshUser,
        [string]$LauncherDir,
        [string]$VbsPath
    )
    $out = Join-Path $LogsDir "$Short.out.log"
    $err = Join-Path $LogsDir "$Short.err.log"
    $launcher = New-MeshLauncher -Program $Program -ProgArgs $ProgArgs -OutLog $out -ErrLog $err `
                                 -LauncherDir $LauncherDir -Short $Short

    # Run the launcher through run-hidden.vbs under wscript.exe (a GUI-subsystem
    # host) instead of invoking cmd.exe directly. Executing a console program
    # under an Interactive principal draws a VISIBLE console window at every
    # logon - one per task, three on screen every sign-in. Measured with a
    # controlled probe: cmd.exe direct -> a visible top-level window; the same
    # command through this shim -> none, with the task still in the Running
    # state so -RestartCount below still applies. Full path, not a bare name,
    # so resolution never depends on the task's inherited PATH.
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $action  = New-ScheduledTaskAction -Execute $wscript `
                                       -Argument ('"{0}" "{1}"' -f $VbsPath, $launcher) `
                                       -WorkingDirectory $RepoDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $MeshUser
    # -DontStopOnIdleEnd is defence in depth, and is deliberately NOT a fix for
    # anything observed. New-ScheduledTaskSettingsSet defaults StopOnIdleEnd to
    # true, which tells Task Scheduler to STOP a running task when the machine
    # stops being idle. It is inert while RunOnlyIfIdle stays false, so it has
    # never fired here - checked on DESKTOP-6KG0VQ4 2026-09-22, all three tasks
    # carried StopOnIdleEnd=true and none was stopped by it. But these are
    # long-lived daemons that must never be stopped by a policy nobody set on
    # purpose, and the default is one flag away from biting if RunOnlyIfIdle is
    # ever switched on. Setting it explicitly costs nothing and removes the
    # question.
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -DontStopOnIdleEnd `
        -MultipleInstances IgnoreNew
    # Interactive is deliberate, and the two alternatives were measured, not assumed:
    #   * -LogonType S4U runs non-interactively and would suppress the window by itself,
    #     but Register-ScheduledTask then fails with "Access is denied"
    #     (HRESULT 0x80070005) for a standard user - verified on Windows 11 Home. This
    #     script's contract is that it needs no elevation, so S4U would break it.
    #   * -Hidden on the settings set emits <Hidden>true</Hidden>, which hides the task
    #     in the Task Scheduler UI and does nothing to the window. It is the fix
    #     everybody reaches for first - do not.
    # The window is suppressed by run-hidden.vbs in the action above instead.
    $principal = New-ScheduledTaskPrincipal -UserId $MeshUser -LogonType Interactive -RunLevel Limited

    # Idempotent update via -Force (mirrors kickstart -k). NOT unregister-then-register:
    # this script runs under $ErrorActionPreference = 'Stop', so a Register failure after
    # an Unregister left the task DELETED and aborted the run, silently half-uninstalling
    # the mesh. Observed exactly that while testing an S4U principal - 'GRIP Mesh Bus' was
    # removed and never came back. -Force overwrites in one step, so a failed registration
    # leaves the previous task intact.
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
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
# Generated per-service .cmd launchers. Machine state (absolute paths), so they
# sit beside the logs under $HOME and are never committed to the repo.
$LauncherDir = Join-Path $HOME '.grip-session-mesh\launchers'
# The hidden-launch shim ships next to this script.
$VbsPath = Join-Path $scriptDir 'run-hidden.vbs'

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

# Fail loudly if the shim is missing rather than registering tasks that cannot
# start - a half-installed mesh is worse than a refused install.
if (-not (Test-Path -LiteralPath $VbsPath)) {
    throw "run-hidden.vbs not found at $VbsPath (it ships alongside this script)"
}

New-Item -ItemType Directory -Force -Path $LogsDir     | Out-Null
New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null

Install-MeshTask -Name 'GRIP Mesh Bus'    -Program $NodePath -ProgArgs @($busEntry)                  -Short 'bus'    -RepoDir $Repo -LogsDir $LogsDir -MeshUser $MeshUser -LauncherDir $LauncherDir -VbsPath $VbsPath
Install-MeshTask -Name 'GRIP Mesh Relay'  -Program $PyPath   -ProgArgs @($relayEntry, 'connect')     -Short 'relay'  -RepoDir $Repo -LogsDir $LogsDir -MeshUser $MeshUser -LauncherDir $LauncherDir -VbsPath $VbsPath
Install-MeshTask -Name 'GRIP Mesh Client' -Program $NodePath -ProgArgs @($clientEntry, $SessionName) -Short 'client' -RepoDir $Repo -LogsDir $LogsDir -MeshUser $MeshUser -LauncherDir $LauncherDir -VbsPath $VbsPath

Write-Host ""
Write-Host "grip-session-mesh persisted for session '$SessionName' (repo: $Repo)."
Write-Host "Three logon tasks run at sign-in and restart on failure:"
Write-Host "  GRIP Mesh Bus     -> node   $busEntry"
Write-Host "  GRIP Mesh Relay   -> python $relayEntry connect   ($PyPath)"
Write-Host "  GRIP Mesh Client  -> node   $clientEntry $SessionName"
Write-Host "Logs:      $LogsDir\{bus,relay,client}.{out,err}.log"
Write-Host "Launchers: $LauncherDir\{bus,relay,client}.cmd  (generated; run one by hand to debug)"
Write-Host "Each task runs its launcher through $VbsPath so no console window appears."
Write-Host "Note: the relay needs the shared team token at $HOME\.grip-session-mesh\token (placed by onboarding)."
Write-Host ""
Write-Host "Verify: Get-ScheduledTask -TaskName 'GRIP Mesh*'"
Write-Host "Remove: powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-windows.ps1"
