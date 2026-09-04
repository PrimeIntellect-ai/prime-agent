"""Process-wide execution restrictions for inspection-only agent kernels."""

from __future__ import annotations

import ctypes
import errno
import platform
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class _Architecture:
    audit_arch: int
    seccomp_syscall: int
    exec_syscalls: tuple[int, ...]
    cross_process_syscalls: tuple[int, ...]
    rejects_x32: bool = False


_ARCHITECTURES = {
    "x86_64": _Architecture(
        0xC000003E,
        317,
        (59, 322),
        (101, 310, 311),
        rejects_x32=True,
    ),
    "amd64": _Architecture(
        0xC000003E,
        317,
        (59, 322),
        (101, 310, 311),
        rejects_x32=True,
    ),
    "aarch64": _Architecture(0xC00000B7, 277, (221, 281), (117, 270, 271)),
    "arm64": _Architecture(0xC00000B7, 277, (221, 281), (117, 270, 271)),
}

_BPF_LD_W_ABS = 0x20
_BPF_JMP_JEQ_K = 0x15
_BPF_JMP_JGE_K = 0x35
_BPF_RET_K = 0x06
_SECCOMP_RET_KILL_PROCESS = 0x80000000
_SECCOMP_RET_ERRNO = 0x00050000
_SECCOMP_RET_ALLOW = 0x7FFF0000
_PR_SET_NO_NEW_PRIVS = 38
_SECCOMP_SET_MODE_FILTER = 1
_SECCOMP_FILTER_FLAG_TSYNC = 1
_X32_SYSCALL_BIT = 0x40000000

_enforced = False


class _SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint32),
    ]


class _SockFprog(ctypes.Structure):
    _fields_ = [
        ("len", ctypes.c_ushort),
        ("filter", ctypes.POINTER(_SockFilter)),
    ]


def _architecture() -> _Architecture:
    if sys.platform != "linux":
        raise RuntimeError("inspection-only execution requires Linux seccomp enforcement")
    machine = platform.machine().lower()
    architecture = _ARCHITECTURES.get(machine)
    if architecture is None:
        raise RuntimeError(
            f"inspection-only execution does not support Linux architecture {machine!r}"
        )
    return architecture


def _filter_values(architecture: _Architecture) -> list[tuple[int, int, int, int]]:
    deny = _SECCOMP_RET_ERRNO | errno.EPERM
    values = [
        (_BPF_LD_W_ABS, 0, 0, 4),
        (_BPF_JMP_JEQ_K, 1, 0, architecture.audit_arch),
        (_BPF_RET_K, 0, 0, _SECCOMP_RET_KILL_PROCESS),
        (_BPF_LD_W_ABS, 0, 0, 0),
    ]
    if architecture.rejects_x32:
        values.extend(
            [
                (_BPF_JMP_JGE_K, 0, 1, _X32_SYSCALL_BIT),
                (_BPF_RET_K, 0, 0, deny),
            ]
        )
    for syscall_number in (
        *architecture.exec_syscalls,
        *architecture.cross_process_syscalls,
    ):
        values.extend(
            [
                (_BPF_JMP_JEQ_K, 0, 1, syscall_number),
                (_BPF_RET_K, 0, 0, deny),
            ]
        )
    values.append((_BPF_RET_K, 0, 0, _SECCOMP_RET_ALLOW))
    return values


def _install_seccomp(architecture: _Architecture) -> None:
    values = _filter_values(architecture)
    filters = (_SockFilter * len(values))(
        *(_SockFilter(*value) for value in values)
    )
    program = _SockFprog(len(filters), filters)
    libc = ctypes.CDLL(None, use_errno=True)

    libc.prctl.argtypes = [
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    libc.prctl.restype = ctypes.c_int
    libc.syscall.argtypes = [
        ctypes.c_long,
        ctypes.c_uint,
        ctypes.c_uint,
        ctypes.POINTER(_SockFprog),
    ]
    libc.syscall.restype = ctypes.c_long

    ctypes.set_errno(0)
    no_new_privileges = libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    if no_new_privileges != 0:
        error_number = ctypes.get_errno()
        detail = errno.errorcode.get(error_number, str(error_number))
        raise RuntimeError(
            f"inspection-only execution could not set no_new_privs: {detail}"
        )

    ctypes.set_errno(0)
    installed = libc.syscall(
        architecture.seccomp_syscall,
        _SECCOMP_SET_MODE_FILTER,
        _SECCOMP_FILTER_FLAG_TSYNC,
        ctypes.byref(program),
    )
    if installed != 0:
        error_number = ctypes.get_errno()
        detail = (
            f"thread {installed} rejected synchronization"
            if installed > 0
            else errno.errorcode.get(error_number, str(error_number))
        )
        raise RuntimeError(
            f"inspection-only execution could not install seccomp: {detail}"
        )


def _install_audit_hook() -> None:
    blocked_events = frozenset(
        {
            "os.exec",
            "os.fork",
            "os.forkpty",
            "os.posix_spawn",
            "os.spawn",
            "os.system",
            "subprocess.Popen",
        }
    )
    message = "inspection-only execution profile blocks external process execution"

    def audit(event: str, args: tuple[object, ...]) -> None:
        del args
        if event in blocked_events:
            raise PermissionError(message)

    sys.addaudithook(audit)


def enforce_inspection_only() -> None:
    """Deny process execution and cross-process memory access in all threads."""
    global _enforced
    if _enforced:
        return
    architecture = _architecture()
    _install_seccomp(architecture)
    _install_audit_hook()
    _enforced = True


__all__ = ["enforce_inspection_only"]
