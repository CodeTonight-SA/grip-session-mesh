"""Forward anchors for deploy/windows/install-windows.ps1.

These pin four regressions that were live in commit d6b8f07. Each is cheap to
reintroduce, because in every case the wrong version looks more obvious than
the right one.

Scope, stated plainly so nobody over-trusts them: this is a SOURCE-SHAPE audit.
It proves the installer still wires the task the way that was measured to work.
It does NOT prove a window fails to appear -- that needs a Windows desktop and
a real logon, and was verified by hand with a controlled probe (cmd.exe direct
-> a visible top-level window; the same command through run-hidden.vbs -> none,
with the task still in the Running state). Anyone changing this area should
redo that probe rather than trusting these tests alone.

There is also no CI in this repository, so these run only when somebody runs
them. An anchor bound to no gate is a reminder, not a guarantee.

audit() is a pure function over the two file texts so it can be pointed at any
revision -- which is how it was shown to go red against d6b8f07 before it was
trusted to pass here (tests-must-be-able-to-fail.md, mandate 3).
"""

from pathlib import Path

import pytest

WINDOWS_DIR = Path(__file__).resolve().parent.parent
INSTALLER = WINDOWS_DIR / "install-windows.ps1"
SHIM = WINDOWS_DIR / "run-hidden.vbs"

NEWLINE = chr(10)


def _code_only(text: str, comment_prefix: str) -> str:
    """Drop whole-line comments before auditing.

    Load-bearing, not tidiness. Every invariant below is a substring match, and
    the fix deliberately documents each rejected alternative BY NAME in a
    comment -- "-LogonType S4U ... Access is denied", "NOT unregister-then-
    register". Auditing the raw text therefore flags the EXPLANATION as if it
    were the defect. This test did exactly that on its first run.

    It matters beyond neatness: if explaining a rejected approach trips the
    gate, the cheapest way to go green is to delete the explanation.

    Only whole-line comments are dropped, so a prefix inside a string literal
    is still audited and nothing real is hidden from the check.
    """
    kept = [
        line for line in text.splitlines()
        if not line.lstrip().startswith(comment_prefix)
    ]
    return NEWLINE.join(kept)


def audit(installer: str, shim: str) -> list[str]:
    """Return one string per violated invariant. Empty list means clean."""
    installer = _code_only(installer, "#")
    shim = _code_only(shim, "'")
    bad: list[str] = []

    # 1. The action must not invoke a console program directly. Under an
    #    Interactive principal that draws a visible console window at every
    #    logon -- three of them, which is the bug this file exists to pin.
    if "-Execute $env:ComSpec" in installer:
        bad.append("action executes $env:ComSpec directly -> visible console window")
    if "run-hidden.vbs" not in installer:
        bad.append("installer no longer routes the action through run-hidden.vbs")

    # 2. S4U suppresses the window on its own, but cannot be registered without
    #    elevation ("Access is denied", HRESULT 0x80070005, Windows 11 Home),
    #    and this installer's contract is that it needs none.
    if "-LogonType S4U" in installer:
        bad.append("principal is S4U -> Register-ScheduledTask denied for a standard user")

    # 3. Unregister-then-register DELETES the existing task when the register
    #    that follows fails, and the script runs under ErrorActionPreference
    #    'Stop'. Observed half-uninstalling the mesh. -Force overwrites in one
    #    step and leaves the old task intact when registration fails.
    if "Unregister-ScheduledTask -TaskName $Name" in installer:
        bad.append("unregister-then-register reintroduced -> a failed register destroys the task")
    if "-Principal $principal -Force" not in installer:
        bad.append("Register-ScheduledTask no longer uses -Force")

    # 4. The shim must HIDE (window style 0) and must WAIT (bWaitOnReturn True).
    #    Not waiting lets the wscript host exit, so Task Scheduler marks the
    #    task completed and -RestartCount never fires -- silently discarding the
    #    keep-alive this installer exists to provide. That failure stays
    #    invisible until something crashes and does not come back.
    if ", 0, True)" not in shim:
        bad.append("run-hidden.vbs must call Run(cmd, 0, True): 0 hides, True keeps the task Running")

    # 5. New-ScheduledTaskSettingsSet defaults StopOnIdleEnd to true, which
    #    stops a RUNNING task the moment the machine stops being idle. These
    #    are long-lived daemons. It is inert while RunOnlyIfIdle stays false,
    #    so this pins an explicit setting rather than a fix for an observed
    #    failure -- the honest reason to keep it is that nothing should stop
    #    the mesh because of a default nobody chose.
    if "-DontStopOnIdleEnd" not in installer:
        bad.append("settings omit -DontStopOnIdleEnd -> idle policy may stop a long-lived daemon")

    return bad


@pytest.fixture(scope="module")
def sources() -> tuple[str, str]:
    assert INSTALLER.is_file(), "missing " + str(INSTALLER)
    assert SHIM.is_file(), "missing " + str(SHIM) + " -- the installer throws without it"
    return INSTALLER.read_text(encoding="utf-8"), SHIM.read_text(encoding="utf-8")


def test_installer_wiring_has_no_known_regressions(sources: tuple[str, str]) -> None:
    findings = audit(*sources)
    assert findings == [], "install-windows.ps1 regressed:" + NEWLINE + NEWLINE.join(findings)


def test_audit_detects_the_original_defect() -> None:
    """The audit must fail the shape that shipped in d6b8f07.

    Without this, audit() could be gutted to `return []` and the test above
    would still pass -- a green test holding the defect in place.
    """
    findings = audit(
        installer=(
            "$action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument $arg" + NEWLINE
            + "$principal = New-ScheduledTaskPrincipal -LogonType Interactive" + NEWLINE
            + "Unregister-ScheduledTask -TaskName $Name -Confirm:$false" + NEWLINE
            + "Register-ScheduledTask -TaskName $Name -Principal $principal | Out-Null" + NEWLINE
        ),
        shim="",
    )
    joined = " ".join(findings)
    assert "$env:ComSpec directly" in joined
    assert "run-hidden.vbs" in joined
    assert "destroys the task" in joined
    assert "-Force" in joined
    assert "keeps the task Running" in joined
    assert "-DontStopOnIdleEnd" in joined


def test_audit_rejects_a_non_waiting_shim() -> None:
    """A shim that returns immediately is the silent RestartCount killer."""
    findings = audit(
        INSTALLER.read_text(encoding="utf-8"),
        shim='sh.Run(WScript.Arguments(0), 0, False)',
    )
    assert any("keeps the task Running" in f for f in findings)


def test_a_comment_naming_a_rejected_alternative_is_not_a_finding() -> None:
    """Documenting why S4U was rejected must not read as USING S4U.

    This was the audit's own first false positive.
    """
    installer = INSTALLER.read_text(encoding="utf-8")
    assert "LogonType S4U" in installer, "the comment naming the rejected alternative is gone"
    assert audit(installer, SHIM.read_text(encoding="utf-8")) == []
