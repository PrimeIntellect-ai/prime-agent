from __future__ import annotations

import errno
import platform
import sys
import unittest
from pathlib import Path
from unittest import mock

from rlm import inspection


class InspectionFilterTest(unittest.TestCase):
    def test_x86_filter_rejects_the_entire_x32_syscall_range(self) -> None:
        architecture = inspection._ARCHITECTURES["x86_64"]
        values = inspection._filter_values(architecture)
        deny = inspection._SECCOMP_RET_ERRNO | errno.EPERM

        self.assertEqual(architecture.seccomp_syscall, 317)
        self.assertEqual(architecture.exec_syscalls, (59, 322))
        self.assertEqual(architecture.cross_process_syscalls, (101, 310, 311))
        self.assertEqual(
            values[4:6],
            [
                (
                    inspection._BPF_JMP_JGE_K,
                    0,
                    1,
                    inspection._X32_SYSCALL_BIT,
                ),
                (inspection._BPF_RET_K, 0, 0, deny),
            ],
        )
        self.assertNotIn(0x4000003B, [value[3] for value in values[6:]])
        self.assertNotIn(0x40000142, [value[3] for value in values[6:]])

    def test_arm64_filter_uses_native_exec_syscalls_without_x32_guard(self) -> None:
        architecture = inspection._ARCHITECTURES["arm64"]
        values = inspection._filter_values(architecture)

        self.assertEqual(architecture.seccomp_syscall, 277)
        self.assertEqual(architecture.exec_syscalls, (221, 281))
        self.assertEqual(architecture.cross_process_syscalls, (117, 270, 271))
        self.assertNotIn(inspection._BPF_JMP_JGE_K, [value[0] for value in values])

    def test_fails_closed_off_linux(self) -> None:
        with mock.patch.object(inspection.sys, "platform", "darwin"):
            with self.assertRaisesRegex(RuntimeError, "requires Linux seccomp"):
                inspection._architecture()

    def test_fails_closed_on_an_unknown_linux_architecture(self) -> None:
        with mock.patch.object(inspection.sys, "platform", "linux"), mock.patch.object(
            inspection.platform, "machine", return_value="riscv64"
        ):
            with self.assertRaisesRegex(RuntimeError, "does not support Linux architecture"):
                inspection._architecture()

    def test_tsync_uses_the_architecture_syscall_and_rejects_any_nonzero_result(
        self,
    ) -> None:
        class FakeFunction:
            def __init__(self, result: int):
                self.result = result
                self.calls: list[tuple[object, ...]] = []
                self.argtypes: list[object] | None = None
                self.restype: object | None = None

            def __call__(self, *args: object) -> int:
                self.calls.append(args)
                return self.result

        class FakeLibc:
            def __init__(self) -> None:
                self.prctl = FakeFunction(0)
                self.syscall = FakeFunction(42)

        libc = FakeLibc()
        architecture = inspection._ARCHITECTURES["x86_64"]
        with mock.patch.object(inspection.ctypes, "CDLL", return_value=libc):
            with self.assertRaisesRegex(
                RuntimeError, "thread 42 rejected synchronization"
            ):
                inspection._install_seccomp(architecture)

        self.assertEqual(
            libc.prctl.argtypes,
            [
                inspection.ctypes.c_int,
                inspection.ctypes.c_ulong,
                inspection.ctypes.c_ulong,
                inspection.ctypes.c_ulong,
                inspection.ctypes.c_ulong,
            ],
        )
        self.assertEqual(
            libc.syscall.argtypes,
            [
                inspection.ctypes.c_long,
                inspection.ctypes.c_uint,
                inspection.ctypes.c_uint,
                inspection.ctypes.POINTER(inspection._SockFprog),
            ],
        )
        self.assertEqual(libc.syscall.calls[0][0:3], (317, 1, 1))

    @unittest.skipUnless(
        sys.platform == "linux"
        and platform.machine().lower() in inspection._ARCHITECTURES,
        "requires supported Linux seccomp",
    )
    def test_tsync_restricts_a_thread_created_before_enforcement(self) -> None:
        import json
        import os
        import subprocess
        import textwrap

        script = textwrap.dedent(
            """
            import ctypes
            import errno
            import json
            import platform
            import threading
            from rlm.inspection import enforce_inspection_only

            ready = threading.Event()
            execute = threading.Event()
            done = threading.Event()
            result = {}

            def worker():
                ready.set()
                execute.wait(5)
                libc = ctypes.CDLL(None, use_errno=True)
                libc.execve.argtypes = [
                    ctypes.c_char_p,
                    ctypes.POINTER(ctypes.c_char_p),
                    ctypes.POINTER(ctypes.c_char_p),
                ]
                libc.execve.restype = ctypes.c_int
                argv = (ctypes.c_char_p * 2)(b"/prime-agent-missing", None)
                envp = (ctypes.c_char_p * 1)(None)
                ctypes.set_errno(0)
                result["execve"] = [
                    libc.execve(b"/prime-agent-missing", argv, envp),
                    ctypes.get_errno(),
                ]
                machine = platform.machine().lower()
                execveat_number = 322 if machine in ("x86_64", "amd64") else 281
                ctypes.set_errno(0)
                result["execveat"] = [
                    libc.syscall(
                        execveat_number,
                        -100,
                        b"/prime-agent-missing",
                        argv,
                        envp,
                        0,
                    ),
                    ctypes.get_errno(),
                ]
                done.set()

            thread = threading.Thread(target=worker)
            thread.start()
            assert ready.wait(5)
            enforce_inspection_only()
            execute.set()
            assert done.wait(5)
            thread.join(5)

            try:
                __import__("os").system("true")
            except PermissionError:
                result["audit"] = "blocked"
            else:
                raise AssertionError("Python audit hook allowed os.system")

            libc = ctypes.CDLL(None, use_errno=True)
            libc.syscall.restype = ctypes.c_long
            machine = platform.machine().lower()
            cross_process_syscalls = (
                (101, 310, 311)
                if machine in ("x86_64", "amd64")
                else (117, 270, 271)
            )
            for name, number in zip(
                ("ptrace", "process_vm_readv", "process_vm_writev"),
                cross_process_syscalls,
            ):
                ctypes.set_errno(0)
                result[name] = [libc.syscall(number, -1, 0, 0, 0, 0, 0), ctypes.get_errno()]

            if machine in ("x86_64", "amd64"):
                for name, number in (
                    ("x32_execve", 0x40000208),
                    ("x32_execveat", 0x40000221),
                ):
                    ctypes.set_errno(0)
                    result[name] = [libc.syscall(number, 0, 0, 0, 0, 0), ctypes.get_errno()]

            print(json.dumps(result))
            """
        )
        environment = dict(os.environ)
        source_root = Path(str(inspection.__file__))
        environment["PYTHONPATH"] = str(source_root.parents[1])
        completed = subprocess.run(
            [sys.executable, "-c", script],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["execve"], [-1, errno.EPERM])
        self.assertEqual(result["execveat"], [-1, errno.EPERM])
        self.assertEqual(result["audit"], "blocked")
        self.assertEqual(result["ptrace"], [-1, errno.EPERM])
        self.assertEqual(result["process_vm_readv"], [-1, errno.EPERM])
        self.assertEqual(result["process_vm_writev"], [-1, errno.EPERM])
        if platform.machine().lower() in ("x86_64", "amd64"):
            self.assertEqual(result["x32_execve"], [-1, errno.EPERM])
            self.assertEqual(result["x32_execveat"], [-1, errno.EPERM])


if __name__ == "__main__":
    unittest.main()
