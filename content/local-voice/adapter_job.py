"""Run one child in its own Windows job object (kill-on-close), so a timeout or the death of
this process ends the child's whole tree, not just its first process.

Why: a rewrite adapter's command is the venv
stub `.venv\\Scripts\\python.exe`. Killing the stub does end the real interpreter (the venv
launcher holds it in a kill-on-close job), but that launcher job allows silent breakaway, so
whatever the adapter starts (`claude -p` and its node tree, `lms`) escaped and ran on after a
timeout or Speak Stop, `claude -p` spending the plan meter. In this job, which has no silent
breakaway, those children stay in and die with it: on timeout (TerminateJobObject), and on Stop,
which kills speak.py's stub, so speak.py's interpreter dies and its handle to this job closes.
Same idea as src-tauri/src/proc_job.rs.

The job allows explicit breakaway (JOB_OBJECT_LIMIT_BREAKAWAY_OK, never SILENT_BREAKAWAY_OK,
which would let the adapter's interpreter escape): a child that must outlive the run, such as
the LM Studio server `lms server start` brings up, is spawned with CREATE_BREAKAWAY_FROM_JOB
(`breakaway_flags` below).

Accepted race, as in proc_job.rs: the child is assigned right after CreateProcess; a
grandchild started in those microseconds escapes. The venv stub needs far longer than that.
Off Windows this is plain subprocess.run.
"""
from __future__ import annotations

import os
import subprocess

JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
CREATE_BREAKAWAY_FROM_JOB = 0x01000000


def _kernel32():
    import ctypes
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k.SetInformationJobObject.restype = wintypes.BOOL
    k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k.AssignProcessToJobObject.restype = wintypes.BOOL
    k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k.TerminateJobObject.restype = wintypes.BOOL
    k.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k.CloseHandle.restype = wintypes.BOOL
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    return k


def _new_job(k):
    """A kill-on-close job that permits explicit breakaway; its handle is not inheritable."""
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class Extended(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", ctypes.c_uint64 * 6),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    job = k.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
    info = Extended()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
    if not k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                                     ctypes.byref(info), ctypes.sizeof(info)):
        err = ctypes.get_last_error()
        k.CloseHandle(job)
        raise OSError(err, "SetInformationJobObject failed")
    return job


def run(argv: list[str], *, input: str, timeout: float, creationflags: int = 0,
        job: bool = True) -> subprocess.CompletedProcess:
    """subprocess.run(argv, input=..., capture_output=True, text=True, encoding="utf-8",
    timeout=...) with the child's tree in a kill-on-close job. On timeout the whole job is
    terminated before TimeoutExpired propagates; the job handle is closed on every path.
    The child sees VIDAR_ADAPTER_JOB=1, so a helper it must keep alive knows that falling back
    inside this job would kill it with the run (tts_kokoro.py). `job=False` is plain
    subprocess.run, for a caller that cannot break away (`can_break_away`)."""
    if os.name != "nt" or not job:
        return subprocess.run(argv, input=input, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, creationflags=creationflags)
    k = _kernel32()
    job = _new_job(k)
    try:
        # errors="replace": a traceback the adapter prints before it reconfigures its streams
        # is in the locale code page; a strict decode would raise and lose the adapter's name.
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace", creationflags=creationflags,
                                env={**os.environ, "VIDAR_ADAPTER_JOB": "1"})
        if not k.AssignProcessToJobObject(job, int(proc._handle)):
            import ctypes

            err = ctypes.get_last_error()
            proc.kill()
            proc.communicate()
            raise OSError(err, f"Cannot Assign {argv[0]} to a Job")
        try:
            out, err_text = proc.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired:
            k.TerminateJobObject(job, 1)
            proc.kill()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pass  # a breakaway child still holds a pipe; the job's own tree is gone
            raise
        return subprocess.CompletedProcess(argv, proc.returncode, out, err_text)
    finally:
        k.CloseHandle(job)


def breakaway_flags() -> int:
    """CREATE_BREAKAWAY_FROM_JOB on Windows, for a child that must outlive this run."""
    return CREATE_BREAKAWAY_FROM_JOB if os.name == "nt" else 0


_CAN_BREAK_AWAY: bool | None = None


def can_break_away() -> bool:
    """Whether a child of this process may leave every job it is in, which a run in a job of
    ours needs when its adapter starts a process that must outlive the run (the Kokoro sidecar).
    False when a job above us forbids breakaway (Vidar started inside such a job; a terminal's
    job): a run in our job could then only start that process inside it, where it would die with
    the run, so the caller runs the adapter without our job instead. Probed once per process by
    creating this interpreter suspended with CREATE_BREAKAWAY_FROM_JOB and killing it before it
    runs a line; a refusal is ERROR_ACCESS_DENIED."""
    global _CAN_BREAK_AWAY
    if _CAN_BREAK_AWAY is not None:
        return _CAN_BREAK_AWAY
    if os.name != "nt":
        _CAN_BREAK_AWAY = True
        return True
    import sys

    create_suspended = 0x00000004
    try:
        p = subprocess.Popen([sys.executable, "-c", ""], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL,
                             creationflags=CREATE_BREAKAWAY_FROM_JOB | create_suspended | subprocess.CREATE_NO_WINDOW)
    except OSError as e:
        if getattr(e, "winerror", None) != 5:
            raise
        _CAN_BREAK_AWAY = False
        return False
    p.kill()
    p.wait()
    _CAN_BREAK_AWAY = True
    return True
