"""Windows Job Object containment for bash() children: one kill-on-close job
per BashHandle, so the child and every descendant (breakaway is never set)
dies when the job is terminated or its last handle closes -- including on
kernel crash, since the OS closes handles. resume_process() releases a
CREATE_SUSPENDED child once it is inside its job. Stdlib ctypes only; degrades
to None/False where kernel32 is missing. Honest note: CI is Ubuntu-only, so
all tests mock the kernel32 boundary (`_kernel32`)."""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectBasicAccountingInformation, _JobObjectExtendedLimitInformation = 1, 9
_INT64, _SIZE_T, _DWORD = ctypes.c_int64, ctypes.c_size_t, wintypes.DWORD
_TH32CS_SNAPTHREAD = 0x4
_THREAD_SUSPEND_RESUME = 0x2
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_RESUME_FAILED = 0xFFFFFFFF  # (DWORD)-1 from ResumeThread


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", _INT64), ("PerJobUserTimeLimit", _INT64),
        ("LimitFlags", _DWORD), ("MinimumWorkingSetSize", _SIZE_T),
        ("MaximumWorkingSetSize", _SIZE_T), ("ActiveProcessLimit", _DWORD),
        ("Affinity", _SIZE_T), ("PriorityClass", _DWORD), ("SchedulingClass", _DWORD)]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS), ("ProcessMemoryLimit", _SIZE_T),
        ("JobMemoryLimit", _SIZE_T), ("PeakProcessMemoryUsed", _SIZE_T),
        ("PeakJobMemoryUsed", _SIZE_T)]


class _THREADENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", _DWORD), ("cntUsage", _DWORD), ("th32ThreadID", _DWORD),
        ("th32OwnerProcessID", _DWORD), ("tpBasePri", wintypes.LONG),
        ("tpDeltaPri", wintypes.LONG), ("dwFlags", _DWORD)]


class _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", _INT64), ("TotalKernelTime", _INT64),
        ("ThisPeriodTotalUserTime", _INT64), ("ThisPeriodTotalKernelTime", _INT64),
        ("TotalPageFaultCount", _DWORD), ("TotalProcesses", _DWORD),
        ("ActiveProcesses", _DWORD), ("TotalTerminatedProcesses", _DWORD)]


_kernel32_cache: ctypes.WinDLL | None = None  # type: ignore[name-defined]


def _kernel32():
    global _kernel32_cache
    if _kernel32_cache is None:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # HANDLE argtypes/restype are mandatory: c_int truncates 64-bit handles.
        h, b, i, p = wintypes.HANDLE, wintypes.BOOL, ctypes.c_int, wintypes.LPVOID
        for name, argtypes, restype in (
            ("CreateJobObjectW", [p, wintypes.LPCWSTR], h),
            ("SetInformationJobObject", [h, i, p, _DWORD], b),
            ("QueryInformationJobObject", [h, i, p, _DWORD, p], b),
            ("AssignProcessToJobObject", [h, h], b),
            ("TerminateJobObject", [h, wintypes.UINT], b),
            ("CloseHandle", [h], b),
            ("CreateToolhelp32Snapshot", [_DWORD, _DWORD], h),
            ("Thread32First", [h, p], b),
            ("Thread32Next", [h, p], b),
            ("OpenThread", [_DWORD, wintypes.BOOL, _DWORD], h),
            ("ResumeThread", [h], _DWORD),  # (DWORD)-1 on failure
        ):
            fn = getattr(k32, name)
            fn.argtypes, fn.restype = argtypes, restype
        _kernel32_cache = k32
    return _kernel32_cache


def create_job() -> int | None:
    """A new kill-on-close job handle, or None when jobs are unavailable."""
    try:
        k32 = _kernel32()
        if not (job := k32.CreateJobObjectW(None, None)):
            return None
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
            job, _JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return None
        return job
    except (OSError, AttributeError):
        return None


def assign(job: int, process_handle: int) -> bool:
    """Assign a process (by OS HANDLE, e.g. Popen._handle) to the job."""
    try:
        return bool(_kernel32().AssignProcessToJobObject(job, process_handle))
    except (OSError, AttributeError):
        return False


def resume_process(pid: int) -> bool:
    """Resume every suspended thread of pid; False when nothing was resumed."""
    try:
        k32 = _kernel32()
        snapshot = k32.CreateToolhelp32Snapshot(_TH32CS_SNAPTHREAD, 0)
        # Toolhelp returns INVALID_HANDLE_VALUE, not NULL, on failure.
        if not snapshot or snapshot == _INVALID_HANDLE_VALUE:
            return False
        resumed = False
        try:
            entry = _THREADENTRY32()
            entry.dwSize = ctypes.sizeof(entry)  # unset => ERROR_INVALID_PARAMETER
            more = k32.Thread32First(snapshot, ctypes.byref(entry))
            while more:
                if entry.th32OwnerProcessID == pid:
                    thread = k32.OpenThread(_THREAD_SUSPEND_RESUME, False, entry.th32ThreadID)
                    if not thread:
                        return False
                    prev = k32.ResumeThread(thread)
                    k32.CloseHandle(thread)
                    if prev == _RESUME_FAILED:
                        return False
                    resumed = True
                more = k32.Thread32Next(snapshot, ctypes.byref(entry))
        finally:
            k32.CloseHandle(snapshot)
        return resumed
    except (OSError, AttributeError):
        return False


def is_empty(job: int) -> bool | None:
    """True/False = job has no/some live processes; None = query failed."""
    try:
        info = _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
        ok = _kernel32().QueryInformationJobObject(
            job, _JobObjectBasicAccountingInformation, ctypes.byref(info), ctypes.sizeof(info), None
        )
        return info.ActiveProcesses == 0 if ok else None
    except (OSError, AttributeError):
        return None


def terminate(job: int, exit_code: int = 1) -> bool:
    try:
        return bool(_kernel32().TerminateJobObject(job, exit_code))
    except (OSError, AttributeError):
        return False


def close(job: int) -> None:
    """Close the handle; closing the LAST handle fires kill-on-close."""
    try:
        _kernel32().CloseHandle(job)
    except (OSError, AttributeError):
        pass
