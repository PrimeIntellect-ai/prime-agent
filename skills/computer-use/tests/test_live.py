"""Opt-in live pyobjc smoke tests, guarded by PRIME_CUA_LIVE=1.

One smoke per live _backend path: framework imports, the session-lock probe,
and the real TCC probes. None of them read app content, post input events,
or capture the screen. Set PRIME_CUA_LIVE=1 to run them deliberately.
"""

from __future__ import annotations

import os
import shutil
import unittest

from computer_use import permissions, policy

LIVE = os.environ.get("PRIME_CUA_LIVE") == "1"

SKIP_REASON = "live smoke; set PRIME_CUA_LIVE=1 to enable"


@unittest.skipUnless(LIVE, SKIP_REASON)
class LiveFrameworkSmokes(unittest.TestCase):
    def test_application_services_imports_for_ax(self) -> None:
        import ApplicationServices

        self.assertTrue(hasattr(ApplicationServices, "AXIsProcessTrustedWithOptions"))
        self.assertTrue(hasattr(ApplicationServices, "kAXTrustedCheckOptionPrompt"))

    def test_quartz_imports_for_inject(self) -> None:
        import Quartz

        self.assertEqual(Quartz.kCGEventFlagMaskCommand, 1 << 20)
        self.assertEqual(Quartz.kCGEventFlagMaskShift, 1 << 17)
        self.assertEqual(Quartz.kCGEventFlagMaskControl, 1 << 18)
        self.assertEqual(Quartz.kCGEventFlagMaskAlternate, 1 << 19)
        self.assertTrue(hasattr(Quartz, "CGEventCreateMouseEvent"))
        self.assertTrue(hasattr(Quartz, "CGEventPostToPid"))

    def test_screencapture_tool_present(self) -> None:
        self.assertIsNotNone(shutil.which("screencapture"))


@unittest.skipUnless(LIVE, SKIP_REASON)
class LiveProbeSmokes(unittest.TestCase):
    def test_screen_locked_returns_bool(self) -> None:
        self.assertIsInstance(policy._screen_locked(), bool)

    def test_permissions_status_reports_shape(self) -> None:
        status = permissions._status()
        self.assertEqual(sorted(status), ["accessibility", "help", "screen_recording"])
        self.assertIn(status["accessibility"], ("ok", "missing", "unknown"))
        self.assertIn(status["screen_recording"], ("ok", "missing", "unknown"))
        self.assertTrue(status["help"])


if __name__ == "__main__":
    unittest.main()
