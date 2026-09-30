"""Regression tests for the security-review fixes in capture.py and inject.py.

Covers window-scoped capture (M4), the PNG hygiene sweep (M4), absolute-path
tool resolution (m2), and the stable error contract for OSError paths (m3).
Every subprocess and framework seam is faked: no display, no real capture,
no input posting.
"""

from __future__ import annotations

import os
import tempfile
import time
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

from computer_use import capture, inject
from computer_use.errors import ComputerUseError

_STALE_AGE_SECONDS = 24 * 60 * 60 + 60


def fake_png_bytes(width: int, height: int) -> bytes:
    """Build a minimal PNG header with the given IHDR dimensions."""
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
    )


class _CaptureTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.shots_dir = Path(self.tmp.name) / "shots"
        self.tool = Path(self.tmp.name) / "screencapture"
        self.tool.write_text("#!/bin/sh\n", encoding="utf-8")
        for patcher in (
            mock.patch.object(capture, "_SCREENSHOTS_DIR", self.shots_dir),
            mock.patch.object(capture, "_SCREENCAPTURE_TOOL", str(self.tool)),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def capture_run(
        self, png: bytes | None = None, returncode: int = 0, stderr: bytes = b""
    ) -> mock.MagicMock:
        """Patch subprocess.run with a canned result that also writes a fake PNG.

        png=None writes a region-matched header, b"" writes nothing, other bytes
        are written verbatim for invalid-output cases.
        """
        def run(command, capture_output, timeout):
            if returncode == 0:
                target = Path(command[5])
                target.parent.mkdir(parents=True, exist_ok=True)
                if png is None:
                    if command[3] == "-R":
                        region_width, region_height = (int(part) for part in command[4].split(",")[2:])
                    else:
                        region_width, region_height = 400, 300
                    target.write_bytes(fake_png_bytes(region_width, region_height))
                elif png:
                    target.write_bytes(png)
            return types.SimpleNamespace(returncode=returncode, stderr=stderr, stdout=b"")

        recorder = mock.MagicMock(side_effect=run)
        patcher = mock.patch.object(capture.subprocess, "run", recorder)
        patcher.start()
        self.addCleanup(patcher.stop)
        return recorder

    def write_shot(self, name: str, age_seconds: float) -> Path:
        """Create one fake screenshot file with the given age."""
        self.shots_dir.mkdir(parents=True, exist_ok=True)
        path = self.shots_dir / name
        path.write_bytes(b"png")
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))
        return path


class WindowScopedCaptureTests(_CaptureTestCase):
    def test_window_id_captures_that_window_only(self) -> None:
        recorder = self.capture_run()
        result = capture._screenshot_window((10, 20), (400, 300), window_id=4321)
        argv = recorder.call_args[0][0]
        self.assertEqual(argv, [str(self.tool), "-x", "-o", "-l", "4321", argv[5]])
        self.assertEqual(Path(argv[5]).parent, self.shots_dir)
        self.assertEqual(result, {"path": argv[5], "width": 400, "height": 300})

    def test_without_window_id_falls_back_to_region(self) -> None:
        recorder = self.capture_run()
        capture._screenshot_window((10, 20), (400, 300))
        argv = recorder.call_args[0][0]
        self.assertEqual(argv[:5], [str(self.tool), "-x", "-o", "-R", "10,20,400,300"])
        self.assertEqual(Path(argv[5]).parent, self.shots_dir)

    def test_bad_window_id_is_invalid_argument(self) -> None:
        for bad in ("4321", 1.5, True):
            with self.subTest(bad=bad), self.assertRaises(ComputerUseError) as caught:
                capture._screenshot_window((0, 0), (5, 5), window_id=bad)
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")


class PngHygieneTests(_CaptureTestCase):
    def test_sweep_deletes_files_older_than_a_day(self) -> None:
        stale = self.write_shot("stale.png", _STALE_AGE_SECONDS)
        fresh = self.write_shot("fresh.png", 60)
        self.capture_run()
        capture._screenshot_window((0, 0), (5, 5))
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_sweep_keeps_at_most_the_twenty_most_recent(self) -> None:
        paths = [self.write_shot(f"shot-{index}.png", 3600 + (25 - index)) for index in range(25)]
        self.capture_run()
        capture._screenshot_window((0, 0), (5, 5))
        survivors = [path for path in paths if path.exists()]
        self.assertEqual(survivors, paths[5:])

    def test_sweep_failure_never_breaks_the_capture(self) -> None:
        undeletable = self.shots_dir / "stale-dir"
        undeletable.mkdir(parents=True)
        stamp = time.time() - _STALE_AGE_SECONDS
        os.utime(undeletable, (stamp, stamp))
        self.capture_run()
        result = capture._screenshot_window((0, 0), (5, 5))
        self.assertTrue(result["path"].endswith(".png"))
        self.assertTrue(undeletable.exists())


class AbsoluteToolPathTests(_CaptureTestCase):
    def test_prefers_the_absolute_tool_path(self) -> None:
        recorder = self.capture_run()
        capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(recorder.call_args[0][0][0], str(self.tool))

    def test_falls_back_to_which_when_absolute_tool_is_missing(self) -> None:
        missing = str(Path(self.tmp.name) / "missing-screencapture")
        with mock.patch.object(capture, "_SCREENCAPTURE_TOOL", missing):
            with mock.patch.object(capture.shutil, "which", return_value="/opt/cua/screencapture"):
                recorder = self.capture_run()
                capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(recorder.call_args[0][0][0], "/opt/cua/screencapture")

    def test_which_results_are_made_absolute(self) -> None:
        missing = str(Path(self.tmp.name) / "missing-screencapture")
        with mock.patch.object(capture, "_SCREENCAPTURE_TOOL", missing):
            with mock.patch.object(capture.shutil, "which", return_value="rel/screencapture"):
                recorder = self.capture_run()
                capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(recorder.call_args[0][0][0], os.path.abspath("rel/screencapture"))

    def test_no_tool_anywhere_maps_to_transport_error(self) -> None:
        missing = str(Path(self.tmp.name) / "missing-screencapture")
        with mock.patch.object(capture, "_SCREENCAPTURE_TOOL", missing):
            with mock.patch.object(capture.shutil, "which", return_value=None):
                self.capture_run()
                with self.assertRaises(ComputerUseError) as caught:
                    capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("not available", caught.exception.message)


class ErrorContractTests(_CaptureTestCase):
    def test_unusable_screenshot_dir_maps_to_transport_error(self) -> None:
        blocked = Path(self.tmp.name) / "blocked"
        blocked.write_text("not a directory", encoding="utf-8")
        with mock.patch.object(capture, "_SCREENSHOTS_DIR", blocked):
            with self.assertRaises(ComputerUseError) as caught:
                capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("screenshot directory unavailable", caught.exception.message)

    def test_inject_oserror_maps_to_transport_error(self) -> None:
        class NoFrameworkAccess:
            def __getattr__(self, name: str):
                raise PermissionError("no cg access")

        backends = types.SimpleNamespace(quartz=NoFrameworkAccess())
        with mock.patch.object(inject, "_require_mac", return_value=backends):
            for call, args in (
                (inject._click, (123, (1, 2))),
                (inject._drag, (123, (1, 2), (3, 4))),
                (inject._scroll, (123, "up")),
                (inject._press_key, (123, "a")),
                (inject._type_text, (123, "hi")),
            ):
                with self.subTest(call=call.__name__), self.assertRaises(ComputerUseError) as caught:
                    call(*args)
                self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
                self.assertIn(call.__name__, caught.exception.message)
                self.assertEqual(caught.exception.details, {"pid": 123})

    def test_inject_non_os_exceptions_stay_injection_failed(self) -> None:
        class ExplodingFramework:
            def __getattr__(self, name: str):
                raise RuntimeError("boom")

        backends = types.SimpleNamespace(quartz=ExplodingFramework())
        with mock.patch.object(inject, "_require_mac", return_value=backends):
            with self.assertRaises(ComputerUseError) as caught:
                inject._click(123, (1, 2))
        self.assertEqual(caught.exception.code, "INJECTION_FAILED")


class FileModesTests(_CaptureTestCase):
    def test_tmp_dir_is_private(self) -> None:
        self.capture_run()
        capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(os.stat(self.shots_dir).st_mode & 0o777, 0o700)

    def test_written_png_is_owner_only(self) -> None:
        self.capture_run()
        result = capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(os.stat(result["path"]).st_mode & 0o777, 0o600)

    def test_chmod_failures_never_break_the_capture(self) -> None:
        self.capture_run()
        with mock.patch.object(capture.os, "chmod", side_effect=PermissionError("nope")):
            result = capture._screenshot_window((0, 0), (5, 5))
        self.assertTrue(result["path"].endswith(".png"))


class SymlinkGuardTests(_CaptureTestCase):
    def test_symlinked_dir_is_refused(self) -> None:
        real = Path(self.tmp.name) / "elsewhere"
        real.mkdir()
        link = Path(self.tmp.name) / "linked-shots"
        link.symlink_to(real)
        with mock.patch.object(capture, "_SCREENSHOTS_DIR", link):
            with self.assertRaises(ComputerUseError) as caught:
                capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("symlink", caught.exception.message)

    def test_symlinked_parent_component_is_refused(self) -> None:
        fake_home = Path(self.tmp.name) / "fake-home"
        real = fake_home / "real-parent"
        real.mkdir(parents=True)
        linked_parent = fake_home / ".prime" / "agent"
        linked_parent.parent.mkdir(parents=True, exist_ok=True)
        linked_parent.symlink_to(real)
        shots = linked_parent / "tmp" / "shots"
        with mock.patch.object(capture, "_SCREENSHOTS_DIR", shots):
            with mock.patch.object(capture.Path, "home", return_value=fake_home):
                with self.assertRaises(ComputerUseError) as caught:
                    capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("symlink", caught.exception.message)
        self.assertFalse(shots.exists())

    def test_guard_ignores_system_symlinks_outside_home(self) -> None:
        elsewhere = Path(self.tmp.name) / "plain-shots"
        elsewhere.mkdir()
        with mock.patch.object(capture, "_SCREENSHOTS_DIR", elsewhere):
            self.capture_run()
            result = capture._screenshot_window((0, 0), (5, 5))
        self.assertTrue(result["path"].endswith(".png"))

    def test_non_regular_target_is_refused(self) -> None:
        fixed = uuid.uuid4()
        with mock.patch.object(capture, "uuid4", return_value=fixed):
            blocked = self.shots_dir / f"{fixed}.png"
            self.shots_dir.mkdir(parents=True, exist_ok=True)
            blocked.mkdir()
            self.capture_run()
            with self.assertRaises(ComputerUseError) as caught:
                capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("not a regular file", caught.exception.message)

    def test_symlinked_target_is_refused(self) -> None:
        fixed = uuid.uuid4()
        with mock.patch.object(capture, "uuid4", return_value=fixed):
            self.shots_dir.mkdir(parents=True, exist_ok=True)
            link = self.shots_dir / f"{fixed}.png"
            link.symlink_to(self.tool)
            self.capture_run()
            with self.assertRaises(ComputerUseError) as caught:
                capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("not a regular file", caught.exception.message)


class PngDimensionTests(_CaptureTestCase):
    def test_invalid_png_is_rejected(self) -> None:
        self.capture_run(png=b"not a png at all")
        with self.assertRaises(ComputerUseError) as caught:
            capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("valid PNG", caught.exception.message)

    def test_missing_png_is_rejected(self) -> None:
        self.capture_run(png=b"")
        with self.assertRaises(ComputerUseError) as caught:
            capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("readable PNG", caught.exception.message)

    def test_zero_dimension_png_is_rejected(self) -> None:
        self.capture_run(png=fake_png_bytes(0, 0))
        with self.assertRaises(ComputerUseError) as caught:
            capture._screenshot_window((0, 0), (5, 5))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("empty PNG", caught.exception.message)

    def test_region_capture_far_beyond_rect_is_rejected(self) -> None:
        self.capture_run(png=fake_png_bytes(4000, 3000))
        with self.assertRaises(ComputerUseError) as caught:
            capture._screenshot_window((0, 0), (400, 300))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("far from the requested", caught.exception.message)

    def test_region_capture_at_two_x_retina_scale_is_allowed(self) -> None:
        self.capture_run(png=fake_png_bytes(800, 600))
        result = capture._screenshot_window((0, 0), (400, 300))
        self.assertEqual((result["width"], result["height"]), (400, 300))

    def test_window_capture_is_not_rect_checked(self) -> None:
        self.capture_run(png=fake_png_bytes(4000, 3000))
        result = capture._screenshot_window((0, 0), (400, 300), window_id=77)
        self.assertEqual((result["width"], result["height"]), (400, 300))


if __name__ == "__main__":
    unittest.main()
