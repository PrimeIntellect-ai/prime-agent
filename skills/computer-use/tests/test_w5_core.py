"""Tests for the core-fix batch: env-derived policy paths, the window-server
rect fallback, App.activate dispatch, the post-action settle, the -g launch
flag, and App.is_frontmost.

One class per fix, everything against fakes: the quartz seam stands in for
CGWindowListCopyWindowInfo, the AppEnvironment recorder stands in for the
apps module, and the path tests reload the modules with a patched
environment. No display, TCC grant, real app, or live framework is touched.
"""

from __future__ import annotations

import importlib
import os
import time
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import fakes
from computer_use import ax, capture, errors, policy

AGENT_DIR = "/tmp/prime-agent-cua-tests"


class AgentDirTests(unittest.TestCase):
    def test_agent_dir_reads_the_env_override(self) -> None:
        with mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": AGENT_DIR}):
            self.assertEqual(policy._agent_dir(), Path(AGENT_DIR))

    def test_agent_dir_expands_a_tilde_override(self) -> None:
        with mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": "~/cua-agent-dir"}):
            self.assertEqual(policy._agent_dir(), Path.home() / "cua-agent-dir")

    def test_agent_dir_falls_back_to_prime_agent_home(self) -> None:
        with mock.patch.dict(os.environ):
            os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
            self.assertEqual(policy._agent_dir(), Path.home() / ".prime" / "agent")


class PolicyPathTests(unittest.TestCase):
    """SETTINGS_PATH and STATE_DIR derive from the agent dir at module load."""

    def tearDown(self) -> None:
        importlib.reload(policy)  # recompute from the ambient environment for the next tests

    def test_paths_derive_from_the_env_override_on_load(self) -> None:
        with mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": AGENT_DIR}):
            importlib.reload(policy)
        self.assertEqual(policy.SETTINGS_PATH, Path(AGENT_DIR) / "settings" / "computer-use.toml")
        self.assertEqual(policy.STATE_DIR, Path(AGENT_DIR) / "state" / "computer-use")

    def test_paths_fall_back_to_prime_agent_home_without_override(self) -> None:
        with mock.patch.dict(os.environ):
            os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
            importlib.reload(policy)
        home = Path.home() / ".prime" / "agent"
        self.assertEqual(policy.SETTINGS_PATH, home / "settings" / "computer-use.toml")
        self.assertEqual(policy.STATE_DIR, home / "state" / "computer-use")


class ScreenshotsDirTests(unittest.TestCase):
    def test_screenshots_dir_reads_the_env_override(self) -> None:
        with mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": AGENT_DIR}):
            self.assertEqual(capture._screenshots_dir(), Path(AGENT_DIR) / "tmp" / "computer-use")

    def test_screenshots_dir_falls_back_to_prime_agent_home(self) -> None:
        with mock.patch.dict(os.environ):
            os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
            self.assertEqual(
                capture._screenshots_dir(),
                Path.home() / ".prime" / "agent" / "tmp" / "computer-use",
            )

    def test_module_dir_constant_derives_from_the_env_override_on_load(self) -> None:
        try:
            with mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": AGENT_DIR}):
                importlib.reload(capture)
            self.assertEqual(capture._SCREENSHOTS_DIR, Path(AGENT_DIR) / "tmp" / "computer-use")
        finally:
            importlib.reload(capture)  # recompute from the ambient environment for the next tests


class FakeWindowServer:
    """Fake quartz seam: canned window-info dicts plus the two list-option constants."""

    kCGWindowListOptionOnScreenOnly = 0x1
    kCGWindowListExcludeDesktopElements = 0x10

    def __init__(self, windows: list[dict[str, Any]] | None = None, error: BaseException | None = None) -> None:
        self.windows = windows if windows is not None else []
        self.error = error
        self.calls: list[tuple[int, int]] = []

    def CGWindowListCopyWindowInfo(self, options: int, window_id: int) -> list[dict[str, Any]]:
        self.calls.append((options, window_id))
        if self.error is not None:
            raise self.error
        return list(self.windows)


class WindowServerRectTests(unittest.TestCase):
    """ax._window_server_rect reads bounds from the window server by CGWindowID."""

    def fake_quartz(self, server: FakeWindowServer) -> None:
        patcher = mock.patch.object(ax, "_require_mac", return_value=types.SimpleNamespace(quartz=server))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_valid_bounds_return_as_a_float_rect(self) -> None:
        server = FakeWindowServer(
            windows=[{"kCGWindowBounds": {"X": 100.5, "Y": 50.25, "Width": 400, "Height": 300}}]
        )
        self.fake_quartz(server)
        rect = ax._window_server_rect(7)
        self.assertEqual(rect, (100.5, 50.25, 400.0, 300.0))
        self.assertTrue(all(isinstance(value, float) for value in rect))
        self.assertEqual(
            server.calls,
            [(
                FakeWindowServer.kCGWindowListOptionOnScreenOnly
                | FakeWindowServer.kCGWindowListExcludeDesktopElements,
                7,
            )],
        )

    def test_partial_bounds_default_missing_keys_to_zero(self) -> None:
        server = FakeWindowServer(windows=[{"kCGWindowBounds": {"X": 12}}])
        self.fake_quartz(server)
        self.assertEqual(ax._window_server_rect(3), (12.0, 0.0, 0.0, 0.0))

    def test_none_window_id_returns_none_without_touching_quartz(self) -> None:
        server = FakeWindowServer()
        self.fake_quartz(server)
        self.assertIsNone(ax._window_server_rect(None))
        self.assertEqual(server.calls, [])

    def test_entries_without_bounds_are_skipped_for_a_later_one(self) -> None:
        server = FakeWindowServer(
            windows=[
                {"owner": "com.example.app"},  # no kCGWindowBounds key
                {"kCGWindowBounds": None},
                {"kCGWindowBounds": {"X": 4, "Y": 5, "Width": 60, "Height": 20}},
            ]
        )
        self.fake_quartz(server)
        self.assertEqual(ax._window_server_rect(11), (4.0, 5.0, 60.0, 20.0))

    def test_no_bounds_in_any_entry_returns_none(self) -> None:
        server = FakeWindowServer(windows=[{"owner": "com.example.app"}, {"kCGWindowBounds": None}])
        self.fake_quartz(server)
        self.assertIsNone(ax._window_server_rect(11))

    def test_framework_exception_returns_none(self) -> None:
        server = FakeWindowServer(error=RuntimeError("quartz exploded"))
        self.fake_quartz(server)
        self.assertIsNone(ax._window_server_rect(9))

    def test_missing_framework_returns_none(self) -> None:
        # _require_mac raises TRANSPORT_ERROR off darwin; the rect stays unknown.
        patcher = mock.patch.object(
            ax,
            "_require_mac",
            side_effect=errors.ComputerUseError("TRANSPORT_ERROR", "needs darwin"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.assertIsNone(ax._window_server_rect(9))


class AppTestCase(unittest.IsolatedAsyncioTestCase):
    """Shared faked-environment helper for App-level tests."""

    def make_env(self, **kwargs: Any) -> fakes.AppEnvironment:
        env = fakes.AppEnvironment(**kwargs)
        env.__enter__()
        self.addCleanup(env.__exit__, None, None, None)
        return env


class AppActivateTests(AppTestCase):
    async def test_activate_dispatches_apps_activate_with_the_bound_pid(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.activate()
        self.assertEqual(env.recorder.calls_named("activate"), [{"pid": env.pid}])
        events = [
            event["properties"]
            for event in env.telemetry_recorder.events
            if event["name"] == "computer_use_action"
        ]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["action"], "activate")
        self.assertEqual(events[0]["outcome"], "ok")

    async def test_activate_vanished_pid_raises_app_not_running_without_dispatch(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        env.running = []  # the bound app quit
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.activate()
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")
        self.assertEqual(env.recorder.calls_named("activate"), [])

    def test_fake_activate_seam_fails_closed_for_an_absent_pid(self) -> None:
        env = self.make_env()
        env._activate(env.pid)
        self.assertEqual(env.recorder.calls_named("activate"), [{"pid": env.pid}])
        with self.assertRaises(errors.ComputerUseError) as caught:
            env._activate(999)
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")


class OpenCommandTests(unittest.TestCase):
    """_open_command launches in the background for every spec kind."""

    def test_open_command_carries_g_for_every_spec_kind(self) -> None:
        from computer_use import apps

        for spec, expected in (
            ("com.example.app", ["open", "-g", "-b", "com.example.app"]),
            ("Slack", ["open", "-g", "-a", "Slack"]),
            ({"bundle_id": "com.example.app"}, ["open", "-g", "-b", "com.example.app"]),
            ({"name": "Slack"}, ["open", "-g", "-a", "Slack"]),
            ({"path": "/Applications/Slack.app"}, ["open", "-g", "/Applications/Slack.app"]),
        ):
            with self.subTest(spec=spec):
                self.assertEqual(apps._open_command(spec), expected)


class AppFrontmostTests(AppTestCase):
    async def test_is_frontmost_true_when_the_bound_pid_is_frontmost(self) -> None:
        env = self.make_env()
        env.frontmost = env.pid
        app = await env.get_app()
        self.assertTrue(app.is_frontmost())

    async def test_is_frontmost_false_when_another_pid_is_frontmost(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        env.frontmost = None  # the workspace reports no frontmost app
        self.assertFalse(app.is_frontmost())
        env.frontmost = env.pid + 1  # another app owns the foreground
        self.assertFalse(app.is_frontmost())


class ActionSettleTests(AppTestCase):
    async def test_one_action_settles_after_the_dispatch(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        started = time.perf_counter()
        await app.press_key("a")
        elapsed = time.perf_counter() - started
        self.assertEqual(env.recorder.calls_named("press_key"), [{"pid": env.pid, "key": "a"}])
        self.assertGreaterEqual(elapsed, 0.10)  # loose bound below the ~0.12s settle

    async def test_failed_action_does_not_settle(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        started = time.perf_counter()
        with self.assertRaises(errors.ComputerUseError):
            await app.click(999)  # stale index fails inside the dispatch
        self.assertLess(time.perf_counter() - started, 0.10)


if __name__ == "__main__":
    unittest.main()
