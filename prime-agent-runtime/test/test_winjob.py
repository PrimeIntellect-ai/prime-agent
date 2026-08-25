# All tests mock the kernel32 boundary: CI is Ubuntu-only, so the real Win32
# calls are never exercised here (manual Windows runs only).
from __future__ import annotations

import ctypes
import unittest
from unittest import mock

from rlm import _winjob


class WinJobTest(unittest.TestCase):
    def setUp(self):
        self.k32 = mock.Mock()
        patcher = mock.patch.object(_winjob, "_kernel32", return_value=self.k32)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_create_job_sets_kill_on_close(self):
        self.k32.CreateJobObjectW.return_value = 314
        self.k32.SetInformationJobObject.return_value = 1

        self.assertEqual(_winjob.create_job(), 314)
        self.k32.CreateJobObjectW.assert_called_once_with(None, None)
        args = self.k32.SetInformationJobObject.call_args.args
        self.assertEqual(args[0], 314)
        self.assertEqual(args[1], 9)  # JobObjectExtendedLimitInformation
        info = ctypes.cast(
            args[2], ctypes.POINTER(_winjob._JOBOBJECT_EXTENDED_LIMIT_INFORMATION)
        ).contents
        self.assertEqual(
            info.BasicLimitInformation.LimitFlags, _winjob.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        self.assertEqual(info.BasicLimitInformation.LimitFlags, 0x2000)
        self.assertEqual(args[3], ctypes.sizeof(_winjob._JOBOBJECT_EXTENDED_LIMIT_INFORMATION))
        self.k32.CloseHandle.assert_not_called()

    def test_create_job_failure_paths(self):
        self.k32.CreateJobObjectW.return_value = None
        self.assertIsNone(_winjob.create_job())

        self.k32.CreateJobObjectW.return_value = 314
        self.k32.SetInformationJobObject.return_value = 0
        self.assertIsNone(_winjob.create_job())
        self.k32.CloseHandle.assert_called_once_with(314)

    def test_assign_passes_job_and_handle(self):
        self.k32.AssignProcessToJobObject.return_value = 1
        self.assertTrue(_winjob.assign(314, 555))
        self.k32.AssignProcessToJobObject.assert_called_once_with(314, 555)

        self.k32.AssignProcessToJobObject.return_value = 0
        self.assertFalse(_winjob.assign(314, 555))

    def test_is_empty_maps_active_processes(self):
        def query(job, info_class, buffer, size, returned):
            info = ctypes.cast(
                buffer, ctypes.POINTER(_winjob._JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
            ).contents
            info.ActiveProcesses = self.active
            self.assertEqual(job, 314)
            self.assertEqual(info_class, 1)  # JobObjectBasicAccountingInformation
            return 1

        self.k32.QueryInformationJobObject.side_effect = query
        self.active = 0
        self.assertTrue(_winjob.is_empty(314))
        self.active = 2
        self.assertFalse(_winjob.is_empty(314))

        self.k32.QueryInformationJobObject.side_effect = None
        self.k32.QueryInformationJobObject.return_value = 0
        self.assertIsNone(_winjob.is_empty(314))

    def test_terminate_and_close(self):
        self.k32.TerminateJobObject.return_value = 1
        self.assertTrue(_winjob.terminate(314))
        self.k32.TerminateJobObject.assert_called_once_with(314, 1)

        self.k32.TerminateJobObject.return_value = 0
        self.assertFalse(_winjob.terminate(314, exit_code=9))
        self.assertEqual(self.k32.TerminateJobObject.call_args.args, (314, 9))

        _winjob.close(314)
        self.k32.CloseHandle.assert_called_once_with(314)


class WinJobPosixDegradationTest(unittest.TestCase):
    def test_every_function_degrades_without_kernel32(self):
        # Unmocked on POSIX: ctypes has no WinDLL, so _kernel32 raises
        # AttributeError and every public function degrades.
        if hasattr(ctypes, "WinDLL"):
            self.skipTest("Windows host: kernel32 exists")
        self.assertIsNone(_winjob.create_job())
        self.assertFalse(_winjob.assign(1, 2))
        self.assertIsNone(_winjob.is_empty(1))
        self.assertFalse(_winjob.terminate(1))
        _winjob.close(1)  # must not raise


if __name__ == "__main__":
    unittest.main()
