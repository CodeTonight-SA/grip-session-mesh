' run-hidden.vbs -- run one command file with NO console window, and WAIT.
'
' Why this exists. A Scheduled Task whose principal is Interactive draws a
' visible console window for a console program (cmd.exe, node, python). Three
' obvious fixes do not work:
'
'   * -Hidden on New-ScheduledTaskSettingsSet emits <Hidden>true</Hidden>,
'     which hides the task in the Task Scheduler UI and has no effect on the
'     window. It is the fix everybody reaches for first.
'   * -LogonType S4U does run non-interactively and would suppress the window,
'     but registering an S4U task needs rights a standard user does not have
'     unelevated -- measured on Windows 11 Home: "Access is denied",
'     HRESULT 0x80070005. This installer's stated contract is that it needs no
'     elevation, so S4U would break it.
'   * pythonw.exe has no console, but Node ships no "nodew", so it would fix
'     one task of three.
'
' WshShell.Run with intWindowStyle 0 hides the window, needs no privilege, and
' wscript.exe is itself a GUI-subsystem host so it allocates no console either.
'
' bWaitOnReturn is TRUE, and that is load-bearing. These are long-lived daemons.
' Returning immediately would let the wscript host exit, Task Scheduler would
' mark the task completed, and -RestartCount/-RestartInterval would never fire
' -- silently discarding the keep-alive this installer exists to provide (the
' Task Scheduler equivalent of launchd's KeepAlive). Waiting keeps the task in
' the Running state for as long as the daemon lives, so a crash still restarts.
'
' Usage:  wscript.exe run-hidden.vbs <path-to-.cmd>
' Exactly ONE argument, always a file path. One level of quoting, no nested
' quote parsing to get wrong -- the redirection lives inside the .cmd file.

If WScript.Arguments.Count <> 1 Then
  WScript.Quit 2
End If

Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run("""" & WScript.Arguments(0) & """", 0, True)
