"""Regression cases for the Linux review's target and input boundaries."""

from __future__ import annotations

import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fakes_linux import X11Script, fake_x11, linux_app_environment, window_line
from computer_use import _linux, capture
from computer_use.errors import ComputerUseError


class LinuxReviewTests(unittest.TestCase):
    def test_click_and_scroll_address_the_bound_window_even_if_occluded(self) -> None:
        script = X11Script()
        with fake_x11(script):
            _linux._click(220, (1, 2), count=2)
            _linux._scroll(220, "down", point=(1, 2))
        buttons = script.argvs("click")
        self.assertEqual(len(buttons), 2)
        for argv in buttons:
            self.assertEqual(argv[2:4], ["--window", "220"])

    def test_drag_refuses_when_motion_cannot_be_scoped(self) -> None:
        script = X11Script()
        with fake_x11(script), self.assertRaises(ComputerUseError) as caught:
            _linux._drag(220, (1, 2), (3, 4))
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(script.calls, [])

    def test_missing_maim_never_captures_a_different_focused_window(self) -> None:
        script = X11Script()
        script.on("-u", png=(100, 100))
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            capture, "_SCREENSHOTS_DIR", Path(directory)
        ), fake_x11(script, tools=("xdotool", "xwininfo", "scrot")):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._screenshot_window(220)
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertEqual(script.tool_calls("scrot"), [])

    def test_a_title_forged_class_cannot_authorize_a_different_window(self) -> None:
        script = X11Script()
        forged = window_line(220, title="fake", instance="notes", res_class="Notes")
        script.xwininfo_tree('     104 "evil\n' + forged + '\n": ("evil" "Evil")  10x10+0+0  +0+0')
        script.on("search", stdout=b"104\n220\n")
        script.on("getwindowclassname", "220", stdout=b"Evil\n")
        script.on("getwindowname", "220", stdout=b"real title\n")
        with fake_x11(script):
            self.assertEqual(_linux._resolve_app("Notes"), [])

    def test_hidden_windows_never_become_bind_candidates(self) -> None:
        script = X11Script()
        script.xwininfo_tree(window_line(220, title="hidden", instance="notes", res_class="Notes"))
        script.on("search", stdout=b"")
        with fake_x11(script):
            self.assertEqual(_linux._resolve_app("Notes"), [])

    def test_keyboard_input_refuses_an_unknown_secure_focus(self) -> None:
        import computer_use

        with linux_app_environment() as script:
            app = asyncio.run(computer_use.get_app("Notes"))
            for call in (lambda: app.type_text("password"), lambda: app.press_key("Return")):
                with self.assertRaises(ComputerUseError) as caught:
                    asyncio.run(call())
                self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(script.argvs("type") + script.argvs("key"), [])

    def test_option_shaped_text_is_literal_and_long_text_has_a_sufficient_budget(self) -> None:
        calls: list[tuple[list[str], float]] = []

        def run(argv: list[str], *, capture_output: bool, timeout: float) -> subprocess.CompletedProcess[bytes]:
            calls.append((argv, timeout))
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        text = "--window 999 " + "a" * 900
        with fake_x11(), mock.patch.object(_linux.subprocess, "run", run):
            _linux._type_text(220, text)
        argv, timeout = calls[0]
        self.assertEqual(argv[-2:], ["--", text])
        self.assertGreater(timeout, len(text) * _linux._TYPE_DELAY_MS / 1000)


if __name__ == "__main__":
    unittest.main()
