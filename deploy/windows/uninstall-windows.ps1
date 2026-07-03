#Requires -Version 5.1
<#
.SYNOPSIS
  uninstall-windows.ps1 - stop + remove the grip-session-mesh Scheduled Tasks.

.DESCRIPTION
  Windows mirror of deploy/launchd/uninstall-macos.sh. Removes the three per-user
  ONLOGON tasks registered by install-windows.ps1. Idempotent: a missing task is
  reported and skipped, never an error. Writes no secret or token.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-windows.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Stable task-name contract (kept in sync with install-windows.ps1).
$TaskNames = @('GRIP Mesh Bus', 'GRIP Mesh Relay', 'GRIP Mesh Client')

foreach ($name in $TaskNames) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "removed $name"
    }
    else {
        Write-Host "not present: $name"
    }
}
Write-Host "grip-session-mesh scheduled tasks removed."
