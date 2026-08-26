"""Windows Job Object containment for bash() children: one kill-on-close job
per BashHandle, so the child and every descendant (breakaway is never set)
dies when the job is terminated or its last handle closes -- including on
kernel crash, since the OS closes handles. spawn_in_job() creates the child
CREATE_SUSPENDED and atomically inside its job (PROC_THREAD_ATTRIBUTE_JOB_LIST
at CreateProcessW time), so no assignment window exists. Stdlib ctypes only;
degrades to None/False where kernel32 is missing. Honest note: CI is
Ubuntu-only, so all tests mock the kernel32 boundary (`_kernel32`)."""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import os
import subprocess
import threading
from typing import BinaryIO

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectBasicAccountingInformation, _JobObjectExtendedLimitInformation = 1, 9
_INT64, _SIZE_T, _DWORD = ctypes.c_int64, ctypes.c_size_t, wintypes.DWORD
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_RESUME_FAILED = 0xFFFFFFFF  # (DWORD)-1 from ResumeThread
_PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000D  # value 13 | PROC_THREAD_ATTRIBUTE_INPUT
_PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002  # value 2 | PROC_THREAD_ATTRIBUTE_INPUT
_EXTENDED_STARTUPINFO_PRESENT = 0x00080000
_CREATE_SUSPENDED = 0x4
_CREATE_UNICODE_ENVIRONMENT = 0x400
_STARTF_USESTDHANDLES = 0x100
_HANDLE_FLAG_INHERIT = 0x1
_GENERIC_READ = 0x80000000
_FILE_SHARE_READ_WRITE = 0x3
_OPEN_EXISTING = 3
_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 0x102
_INFINITE = 0xFFFFFFFF


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


class _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", _INT64), ("TotalKernelTime", _INT64),
        ("ThisPeriodTotalUserTime", _INT64), ("ThisPeriodTotalKernelTime", _INT64),
        ("TotalPageFaultCount", _DWORD), ("TotalProcesses", _DWORD),
        ("ActiveProcesses", _DWORD), ("TotalTerminatedProcesses", _DWORD)]


# Fixed-width Win64 ABI types on every host: wintypes.DWORD is 8-byte c_ulong on LP64 POSIX.
_DWORD32, _WORD16, _PTR, _WSTR = ctypes.c_uint32, ctypes.c_uint16, ctypes.c_void_p, ctypes.c_wchar_p


class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", _DWORD32), ("lpReserved", _WSTR), ("lpDesktop", _WSTR),
        ("lpTitle", _WSTR), ("dwX", _DWORD32), ("dwY", _DWORD32),
        ("dwXSize", _DWORD32), ("dwYSize", _DWORD32), ("dwXCountChars", _DWORD32),
        ("dwYCountChars", _DWORD32), ("dwFillAttribute", _DWORD32), ("dwFlags", _DWORD32),
        ("wShowWindow", _WORD16), ("cbReserved2", _WORD16),
        ("lpReserved2", _PTR), ("hStdInput", _PTR),
        ("hStdOutput", _PTR), ("hStdError", _PTR)]


class _STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", _STARTUPINFOW), ("lpAttributeList", _PTR)]


class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", _PTR), ("hThread", _PTR),
        ("dwProcessId", _DWORD32), ("dwThreadId", _DWORD32)]


_kernel32_cache: ctypes.WinDLL | None = None  # type: ignore[name-defined]


def _kernel32():
    global _kernel32_cache
    if _kernel32_cache is None:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # HANDLE argtypes/restype are mandatory: c_int truncates 64-bit handles.
        h, b, i, p = wintypes.HANDLE, wintypes.BOOL, ctypes.c_int, wintypes.LPVOID
        w = wintypes.LPCWSTR
        for name, argtypes, restype in (
            ("CreateJobObjectW", [p, w], h),
            ("SetInformationJobObject", [h, i, p, _DWORD], b),
            ("QueryInformationJobObject", [h, i, p, _DWORD, p], b),
            ("TerminateJobObject", [h, wintypes.UINT], b),
            ("CloseHandle", [h], b),
            ("CreatePipe", [p, p, p, _DWORD], b),
            ("SetHandleInformation", [h, _DWORD, _DWORD], b),
            ("CreateFileW", [w, _DWORD, _DWORD, p, _DWORD, _DWORD, h], h),
            ("InitializeProcThreadAttributeList", [p, _DWORD, _DWORD, p], b),
            ("UpdateProcThreadAttribute", [p, _DWORD, _SIZE_T, p, _SIZE_T, p, p], b),
            ("DeleteProcThreadAttributeList", [p], None),
            ("CreateProcessW", [w, wintypes.LPWSTR, p, p, b, _DWORD, p, w, p, p], b),
            ("ResumeThread", [h], _DWORD),  # (DWORD)-1 on failure
            ("WaitForSingleObject", [h, _DWORD], _DWORD),
            ("GetExitCodeProcess", [h, p], b),
            ("TerminateProcess", [h, wintypes.UINT], b),
        ):
            fn = getattr(k32, name)
            fn.argtypes, fn.restype = argtypes, restype
        _kernel32_cache = k32
    return _kernel32_cache


def _last_error() -> int:
    return ctypes.get_last_error() if hasattr(ctypes, "get_last_error") else 0


def _open_reader(handle: int) -> BinaryIO:
    """Wrap the pipe HANDLE in a binary reader, consuming the HANDLE on every path."""
    # Windows-only module, so the import cannot live at the top on POSIX.
    import msvcrt

    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY)
    except BaseException:
        _kernel32().CloseHandle(handle)
        raise
    try:
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)  # the CRT fd owns the handle now; closing it closes both
        raise


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


class JobProcess:
    """Minimal Popen-like surface for a child spawn_in_job() created suspended."""

    def __init__(self, hprocess: int, hthread: int, pid: int, stdout: BinaryIO) -> None:
        self.pid = pid
        self.stdout: BinaryIO | None = stdout
        # Guards every (_exit_code, _hprocess, _hthread, _waiters) transition; never held blocking.
        self._lock = threading.Lock()
        self._hprocess: int | None = hprocess
        self._hthread: int | None = hthread
        self._exit_code: int | None = None
        self._waiters = 0  # wait() calls with a blocking WFSO in flight
        self._close_requested = False

    def resume(self) -> bool:
        """Release the suspended primary thread; the handle stays open on failure."""
        with self._lock:
            if self._hthread is None or _kernel32().ResumeThread(self._hthread) == _RESUME_FAILED:
                return False
            _kernel32().CloseHandle(self._hthread)
            self._hthread = None
            return True

    def close(self) -> None:
        """Release the process handle (idempotent); owned by BashHandle after reap."""
        with self._lock:
            self._close_requested = True
            self._close_hprocess_locked()

    def _cache_exit_code_locked(self) -> int:
        # Runs under the lock after a signaled wait, so never the STILL_ACTIVE(259) sentinel.
        k32 = _kernel32()
        code = _DWORD()
        if not k32.GetExitCodeProcess(self._hprocess, ctypes.byref(code)):
            # Handles stay open (nothing cached) so a retry is possible.
            raise OSError(f"GetExitCodeProcess failed: {_last_error()}")
        self._exit_code = int(code.value)
        if self._hthread is not None:
            k32.CloseHandle(self._hthread)
            self._hthread = None
        return self._exit_code

    def _close_hprocess_locked(self) -> None:
        # Closing a handle mid-WaitForSingleObject is UB: the last returning waiter closes it.
        if self._close_requested and self._waiters == 0 and self._hprocess is not None:
            _kernel32().CloseHandle(self._hprocess)
            self._hprocess = None

    def poll(self) -> int | None:
        # WaitForSingleObject(0) never blocks, so it may run under the lock.
        with self._lock:
            if self._exit_code is not None:
                return self._exit_code
            if self._hprocess is None:
                raise OSError("process handle closed")
            result = _kernel32().WaitForSingleObject(self._hprocess, 0)
            if result == _WAIT_TIMEOUT:
                return None
            if result != _WAIT_OBJECT_0:
                raise OSError(f"WaitForSingleObject failed: {_last_error()}")
            return self._cache_exit_code_locked()

    def wait(self, timeout: float | None = None) -> int:
        # Convert before registering: int(nan/inf) raises and would leak _waiters forever.
        millis = _INFINITE if timeout is None else max(0, int(timeout * 1000))
        with self._lock:
            if self._exit_code is not None:
                return self._exit_code
            if self._hprocess is None:
                raise OSError("process handle closed")
            hprocess = self._hprocess
            self._waiters += 1  # keeps the handle open while the wait runs
        result = None
        try:
            result = _kernel32().WaitForSingleObject(hprocess, millis)
        finally:
            with self._lock:
                try:
                    # Cache while the handle is still valid: the deferred close
                    # fires the moment _waiters drops to zero.
                    if result == _WAIT_OBJECT_0 and self._exit_code is None:
                        self._cache_exit_code_locked()
                finally:
                    self._waiters -= 1
                    self._close_hprocess_locked()  # last waiter after a close() request closes
        with self._lock:
            # A code cached concurrently during the wait wins, even over WAIT_FAILED.
            if self._exit_code is not None:
                return self._exit_code
            if result == _WAIT_TIMEOUT:
                raise subprocess.TimeoutExpired(f"pid {self.pid}", timeout or 0)
            raise OSError(f"WaitForSingleObject failed: {_last_error()}")

    def kill(self) -> None:
        with self._lock:
            if self._exit_code is not None or self._hprocess is None:
                return
            ok = bool(_kernel32().TerminateProcess(self._hprocess, 1))
        if not ok and self.poll() is None:
            raise OSError(f"TerminateProcess failed: {_last_error()}")


def spawn_in_job(job: int, argv: list[str], cwd: str, env: dict[str, str]) -> JobProcess:
    """Create argv suspended and atomically inside the caller-owned job (JOB_LIST
    attribute, no assignment window); raises OSError on any failure (nothing spawned)."""
    try:
        k32 = _kernel32()
    except (OSError, AttributeError) as exc:
        raise OSError("kernel32 unavailable") from exc
    read_handle = write_handle = nul_handle = None
    attr_list = None
    proc = None
    try:
        read_out, write_out = wintypes.HANDLE(), wintypes.HANDLE()
        if not k32.CreatePipe(ctypes.byref(read_out), ctypes.byref(write_out), None, 0):
            raise OSError(f"CreatePipe failed: {_last_error()}")
        read_handle, write_handle = int(read_out.value or 0), int(write_out.value or 0)
        if not k32.SetHandleInformation(write_handle, _HANDLE_FLAG_INHERIT, _HANDLE_FLAG_INHERIT):
            raise OSError(f"SetHandleInformation failed: {_last_error()}")
        nul = k32.CreateFileW(
            "NUL", _GENERIC_READ, _FILE_SHARE_READ_WRITE, None, _OPEN_EXISTING, 0, None)
        if not nul or nul == _INVALID_HANDLE_VALUE:
            raise OSError(f"CreateFileW(NUL) failed: {_last_error()}")
        nul_handle = int(nul)
        if not k32.SetHandleInformation(nul_handle, _HANDLE_FLAG_INHERIT, _HANDLE_FLAG_INHERIT):
            raise OSError(f"SetHandleInformation failed: {_last_error()}")
        # Two-call protocol: the sizing call fails with ERROR_INSUFFICIENT_BUFFER.
        size = ctypes.c_size_t(0)
        k32.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
        if not size.value:
            raise OSError(f"InitializeProcThreadAttributeList sizing failed: {_last_error()}")
        buffer = ctypes.create_string_buffer(size.value)
        if not k32.InitializeProcThreadAttributeList(buffer, 2, 0, ctypes.byref(size)):
            raise OSError(f"InitializeProcThreadAttributeList failed: {_last_error()}")
        attr_list = buffer
        jobs = (wintypes.HANDLE * 1)(job)
        if not k32.UpdateProcThreadAttribute(
            attr_list, 0, _PROC_THREAD_ATTRIBUTE_JOB_LIST, ctypes.byref(jobs),
            ctypes.sizeof(jobs), None, None):
            raise OSError(f"UpdateProcThreadAttribute failed: {_last_error()}")
        # HANDLE_LIST blocks concurrent spawns' handle leaks; both arrays outlive CreateProcessW.
        inheritable = (wintypes.HANDLE * 2)(write_handle, nul_handle)
        if not k32.UpdateProcThreadAttribute(
            attr_list, 0, _PROC_THREAD_ATTRIBUTE_HANDLE_LIST, ctypes.byref(inheritable),
            ctypes.sizeof(inheritable), None, None):
            raise OSError(f"UpdateProcThreadAttribute failed: {_last_error()}")
        startup = _STARTUPINFOEXW()
        startup.StartupInfo.cb = ctypes.sizeof(_STARTUPINFOEXW)
        startup.StartupInfo.dwFlags = _STARTF_USESTDHANDLES
        startup.StartupInfo.hStdInput = nul_handle
        startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = write_handle
        startup.lpAttributeList = ctypes.cast(attr_list, wintypes.LPVOID)
        # CreateProcessW may rewrite lpCommandLine in place: a writable buffer is mandatory.
        cmdline = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
        # Sorted case-insensitively per CreateProcessW; the implicit terminator is the second NUL.
        env_block = ctypes.create_unicode_buffer(
            "\0".join(
                f"{key}={value}" for key, value in sorted(env.items(), key=lambda kv: kv[0].upper())
            ) + "\0")
        info = _PROCESS_INFORMATION()
        flags = _EXTENDED_STARTUPINFO_PRESENT | _CREATE_SUSPENDED | _CREATE_UNICODE_ENVIRONMENT
        if not k32.CreateProcessW(
            None, cmdline, None, None, True, flags, env_block, cwd,
            ctypes.byref(startup), ctypes.byref(info)):
            raise OSError(f"CreateProcessW failed: {_last_error()}")
        try:
            # _open_reader consumes the read handle on every path: drop it at the call.
            reader_handle, read_handle = read_handle, None
            proc = JobProcess(
                int(info.hProcess or 0), int(info.hThread or 0), int(info.dwProcessId),
                _open_reader(reader_handle))
        except BaseException:
            # No JobProcess owns these yet; the caller's kill-on-close job reaps the child.
            for handle in (info.hProcess, info.hThread):
                if handle:
                    k32.CloseHandle(handle)
            raise
    finally:
        if attr_list is not None:
            k32.DeleteProcThreadAttributeList(attr_list)
        for handle in (write_handle, nul_handle):
            if handle is not None:
                k32.CloseHandle(handle)
        if read_handle is not None:  # only when _open_reader was never invoked
            k32.CloseHandle(read_handle)
    return proc


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
