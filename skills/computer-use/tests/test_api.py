"""Tests for the computer-use API surface and its backend seams.

Covers telemetry caps, the permissions snapshot with injected probes, the
capture surface with a stubbed screencapture, and the inject surface's
argument validation and error wrapping. The App dispatch tests patch the
inject/capture module seams with recording fakes; nothing here touches a
display, TCC, or a real app process.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import subprocess
import time
import tempfile
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import fakes
from computer_use import apps, capture, inject, permissions, telemetry
from computer_use import errors


class TelemetryEmitTests(unittest.IsolatedAsyncioTestCase):
    async def test_emit_passes_name_and_properties(self) -> None:
        with fakes.telemetry_recorder() as recorder:
            await telemetry._emit("computer_use_action", action="click", outcome="ok", duration_ms=12)
        self.assertEqual(
            recorder.events,
            [{"name": "computer_use_action", "properties": {"action": "click", "outcome": "ok", "duration_ms": 12}}],
        )

    async def test_emit_drops_long_name(self) -> None:
        with fakes.telemetry_recorder() as recorder:
            await telemetry._emit("x" * 65, platform="mac")
        self.assertEqual(recorder.events, [])

    async def test_emit_drops_empty_and_non_string_name(self) -> None:
        with fakes.telemetry_recorder() as recorder:
            await telemetry._emit("", platform="mac")
            await telemetry._emit(42, platform="mac")
        self.assertEqual(recorder.events, [])

    async def test_emit_keeps_first_twelve_properties(self) -> None:
        properties = {f"prop_{index}": index for index in range(14)}
        with fakes.telemetry_recorder() as recorder:
            await telemetry._emit("computer_use_session_started", **properties)
        kept = recorder.events[0]["properties"]
        self.assertEqual(len(kept), 12)
        self.assertEqual(sorted(kept), sorted(f"prop_{index}" for index in range(12)))

    async def test_emit_truncates_long_string_values(self) -> None:
        with fakes.telemetry_recorder() as recorder:
            await telemetry._emit("computer_use_session_started", platform="p" * 70)
        self.assertEqual(recorder.events[0]["properties"]["platform"], "p" * 64)

    async def test_emit_drops_non_primitive_values_and_keeps_primitives(self) -> None:
        with fakes.telemetry_recorder() as recorder:
            await telemetry._emit(
                "computer_use_action",
                action="click",
                junk_list=[1, 2],
                junk_dict={"a": 1},
                nothing=None,
                flag=True,
                ratio=0.5,
                count=3,
            )
        self.assertEqual(
            recorder.events[0]["properties"],
            {"action": "click", "flag": True, "ratio": 0.5, "count": 3},
        )

    async def test_emit_swallows_bridge_errors(self) -> None:
        with fakes.telemetry_recorder() as recorder:
            recorder.error = RuntimeError("bridge down")
            await telemetry._emit("computer_use_session_started", platform="mac")

    async def test_emit_bounds_a_stalled_bridge(self) -> None:
        async def stalled_host(request_type: str, payload: dict | None = None) -> dict:
            await asyncio.sleep(3600)
            return {}

        saved = telemetry.host_request
        telemetry.host_request = stalled_host
        try:
            start = time.monotonic()
            await telemetry._emit("computer_use_session_started", platform="mac")
            self.assertLess(time.monotonic() - start, 1.0)
        finally:
            telemetry.host_request = saved

    async def test_emit_noop_without_bridge(self) -> None:
        saved = telemetry.host_request
        telemetry.host_request = None
        try:
            await telemetry._emit("computer_use_session_started", platform="mac")
        finally:
            telemetry.host_request = saved


class PermissionsTests(unittest.TestCase):
    def test_status_maps_probe_results(self) -> None:
        status = permissions._status(ax_probe=fakes.probe(True), screen_probe=fakes.probe(None))
        self.assertEqual(
            status,
            {"accessibility": "ok", "screen_recording": "unknown", "help": list(permissions.HELP_LINES)},
        )

    def test_status_missing_grants(self) -> None:
        status = permissions._status(ax_probe=fakes.probe(False), screen_probe=fakes.probe(False))
        self.assertEqual(status["accessibility"], "missing")
        self.assertEqual(status["screen_recording"], "missing")

    def test_state_from_probe_mapping(self) -> None:
        self.assertEqual(permissions._state_from_probe(True), "ok")
        self.assertEqual(permissions._state_from_probe(False), "missing")
        self.assertEqual(permissions._state_from_probe(None), "unknown")

    def test_help_names_settings_paths_and_brand(self) -> None:
        joined = "\n".join(permissions.HELP_LINES)
        self.assertIn("System Settings > Privacy & Security > Accessibility", joined)
        self.assertIn("System Settings > Privacy & Security > Screen Recording", joined)
        self.assertIn("Prime Agent", joined)


class CaptureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.shots_dir = Path(self.tmp.name) / "shots"
        patcher = mock.patch.object(capture, "_SCREENSHOTS_DIR", self.shots_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tool = Path(self.tmp.name) / "screencapture"
        self.tool.write_text("#!/bin/sh\n", encoding="utf-8")
        patcher = mock.patch.object(capture, "_SCREENCAPTURE_TOOL", str(self.tool))
        patcher.start()
        self.addCleanup(patcher.stop)

    def capture_run(self, returncode: int = 0, stderr: bytes = b"", stdout: bytes = b"") -> mock.MagicMock:
        """Patch subprocess.run with a canned result that writes a fake PNG on success."""

        def run(command, capture_output, timeout):
            if returncode == 0:
                target = Path(command[5])
                target.parent.mkdir(parents=True, exist_ok=True)
                if command[3] == "-R":
                    region_width, region_height = (int(part) for part in command[4].split(",")[2:])
                else:
                    region_width, region_height = 400, 300
                target.write_bytes(
                    b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
                    + region_width.to_bytes(4, "big")
                    + region_height.to_bytes(4, "big")
                )
            return types.SimpleNamespace(returncode=returncode, stderr=stderr, stdout=stdout)

        recorder = mock.MagicMock(side_effect=run)
        patcher = mock.patch.object(capture.subprocess, "run", recorder)
        patcher.start()
        self.addCleanup(patcher.stop)
        return recorder

    def test_screenshot_window_runs_screencapture_and_returns_region(self) -> None:
        recorder = self.capture_run()
        result = capture._screenshot_window((10, 20), (400, 300))
        argv = recorder.call_args[0][0]
        self.assertEqual(argv[:5], [str(self.tool), "-x", "-o", "-R", "10,20,400,300"])
        path = Path(argv[5])
        self.assertEqual(path.parent, self.shots_dir)
        self.assertEqual(path.suffix, ".png")
        self.assertEqual(result, {"path": str(path), "width": 400, "height": 300})

    def test_screenshot_window_rejects_bad_regions(self) -> None:
        for origin, size in (
            ((10.5, 20), (400, 300)),
            ([10, 20], (400, 300)),
            ((10, 20), (0, 300)),
            ((10, 20), (400, 300, 1)),
        ):
            with self.subTest(origin=origin, size=size), self.assertRaises(errors.ComputerUseError) as caught:
                capture._screenshot_window(origin, size)
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    def test_screenshot_window_missing_window_maps_to_app_not_running(self) -> None:
        self.capture_run(returncode=1, stderr=b"screencapture: window not found")
        with self.assertRaises(errors.ComputerUseError) as caught:
            capture._screenshot_window((10, 20), (400, 300))
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")

    def test_screenshot_window_other_failure_maps_to_transport_error(self) -> None:
        self.capture_run(returncode=1, stderr=b"screencapture: bad flags")
        with self.assertRaises(errors.ComputerUseError) as caught:
            capture._screenshot_window((10, 20), (400, 300))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")

    def test_screenshot_window_timeout_maps_to_transport_error(self) -> None:
        recorder = mock.MagicMock()
        recorder.side_effect = subprocess.TimeoutExpired(cmd="screencapture", timeout=10)
        patcher = mock.patch.object(capture.subprocess, "run", recorder)
        patcher.start()
        self.addCleanup(patcher.stop)
        with self.assertRaises(errors.ComputerUseError) as caught:
            capture._screenshot_window((10, 20), (400, 300))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")


class InjectValidationTests(unittest.TestCase):
    def assert_invalid(self, call, *args, **kwargs) -> None:
        with self.assertRaises(errors.ComputerUseError) as caught:
            call(*args, **kwargs)
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    def test_click_rejects_bad_button_count_and_point(self) -> None:
        self.assert_invalid(inject._click, 123, (10, 20), "side")
        self.assert_invalid(inject._click, 123, (10, 20), "left", 0)
        self.assert_invalid(inject._click, 123, (10, 20), "left", True)
        self.assert_invalid(inject._click, 123, (10, "20"))
        self.assert_invalid(inject._click, 123, [10, 20])

    def test_drag_rejects_bad_points(self) -> None:
        self.assert_invalid(inject._drag, 123, (10, 20), (30,))
        self.assert_invalid(inject._drag, 123, "10,20", (30, 40))

    def test_scroll_rejects_bad_direction_pages_and_point(self) -> None:
        self.assert_invalid(inject._scroll, 123, "diagonal")
        self.assert_invalid(inject._scroll, 123, "up", 0)
        self.assert_invalid(inject._scroll, 123, "up", 1.5)
        self.assert_invalid(inject._scroll, 123, "up", 1, "10,20")

    def test_press_key_propagates_invalid_chord(self) -> None:
        self.assert_invalid(inject._press_key, 123, "cmd++c")
        self.assert_invalid(inject._press_key, 123, "notakey")

    def test_type_text_rejects_non_string(self) -> None:
        self.assert_invalid(inject._type_text, 123, 42)

    def test_type_text_empty_is_a_noop(self) -> None:
        with mock.patch.object(inject, "_require_mac", side_effect=AssertionError("must not post events")):
            self.assertIsNone(inject._type_text(123, ""))


class ScrollPointTests(unittest.TestCase):
    def test_point_carrying_scroll_sets_location(self) -> None:
        locations: list[tuple[object, tuple[int, ...]]] = []
        quartz = types.SimpleNamespace(
            kCGScrollEventUnitPixel=0,
            CGEventCreateScrollWheelEvent=lambda source, unit, count, dy, dx: {"dy": dy, "dx": dx},
            CGEventSetLocation=lambda event, point: locations.append((event, tuple(point))),
            CGEventPostToPid=lambda pid, event: None,
        )
        fake_mac = types.SimpleNamespace(quartz=quartz)
        with mock.patch.object(inject, "_require_mac", return_value=fake_mac):
            inject._scroll(123, "down", 2, point=(140, 160))
            inject._scroll(123, "down", 2)
        self.assertEqual(len(locations), 1)
        self.assertEqual(locations[0][1], (140, 160))


class InjectionFailureTests(unittest.TestCase):
    def test_click_wraps_cg_error_as_injection_failed(self) -> None:
        with mock.patch.object(inject, "_require_mac", side_effect=RuntimeError("boom")):
            with self.assertRaises(errors.ComputerUseError) as caught:
                inject._click(123, (10, 20))
        self.assertEqual(caught.exception.code, "INJECTION_FAILED")
        self.assertIn("click failed", caught.exception.message)
        self.assertIn("boom", caught.exception.message)
        self.assertEqual(caught.exception.details, {"pid": 123})

    def test_click_caps_wrapped_error_at_200_chars(self) -> None:
        with mock.patch.object(inject, "_require_mac", side_effect=RuntimeError("e" * 500)):
            with self.assertRaises(errors.ComputerUseError) as caught:
                inject._click(123, (10, 20))
        self.assertLessEqual(len(caught.exception.message), len("click failed: ") + 200)

    def test_drag_and_scroll_wrap_cg_errors(self) -> None:
        for name in ("drag", "scroll"):
            with self.subTest(action=name), mock.patch.object(inject, "_require_mac", side_effect=RuntimeError("boom")):
                with self.assertRaises(errors.ComputerUseError) as caught:
                    if name == "drag":
                        inject._drag(123, (10, 20), (30, 40))
                    else:
                        inject._scroll(123, "down", 2)
                self.assertEqual(caught.exception.code, "INJECTION_FAILED")


if __name__ == "__main__":
    unittest.main()


class AppTestCase(unittest.IsolatedAsyncioTestCase):
    """Shared faked-environment helper for App-level tests."""

    def make_env(self, **kwargs: Any) -> fakes.AppEnvironment:
        env = fakes.AppEnvironment(**kwargs)
        env.__enter__()
        self.addCleanup(env.__exit__, None, None, None)
        return env


class ModuleGetStateTests(AppTestCase):
    async def test_get_state_shape(self) -> None:
        import computer_use

        env = self.make_env()
        state = await computer_use.get_state()
        self.assertEqual(sorted(state), ["allowlist", "apps", "permissions", "platform"])
        self.assertEqual(state["apps"], [{"id": env.bundle, "name": env.name, "running": True}])
        self.assertEqual(state["permissions"]["accessibility"], "ok")
        self.assertEqual(state["permissions"]["screen_recording"], "ok")
        self.assertEqual(state["allowlist"]["allowed"], [env.bundle])
        self.assertEqual(state["platform"], "mac")

    async def test_get_state_emits_session_started_once(self) -> None:
        import computer_use

        env = self.make_env()
        await computer_use.get_state()
        await computer_use.get_state()
        started = [event for event in env.telemetry_recorder.events if event["name"] == "computer_use_session_started"]
        self.assertEqual(len(started), 1)
        self.assertEqual(started[0]["properties"], {"platform": "mac"})

    async def test_get_state_emits_get_state_action(self) -> None:
        import computer_use

        env = self.make_env()
        await computer_use.get_state()
        actions = [event for event in env.telemetry_recorder.events if event["name"] == "computer_use_action"]
        self.assertTrue(actions)
        self.assertEqual(actions[0]["properties"]["action"], "get_state")
        self.assertEqual(actions[0]["properties"]["outcome"], "ok")

    async def test_get_state_emit_false_is_silent(self) -> None:
        import computer_use

        env = self.make_env()
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            await computer_use.get_state(emit=False)
        self.assertEqual(env.telemetry_recorder.events, [])
        self.assertEqual(captured.getvalue(), "")

    async def test_get_state_prints_guidance_when_grants_missing(self) -> None:
        import computer_use

        self.make_env(permissions={"accessibility": "missing", "screen_recording": "missing", "help": ["grant line one", "grant line two"]})
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            await computer_use.get_state()
        output = captured.getvalue()
        self.assertIn("Prime Agent computer use needs macOS permissions", output)
        self.assertIn("grant line one", output)
        self.assertIn("grant line two", output)

    async def test_get_state_swallows_list_transport_error(self) -> None:
        import computer_use
        from computer_use import errors

        env = self.make_env()
        env.running_error = errors.ComputerUseError("TRANSPORT_ERROR", "no workspace")
        state = await computer_use.get_state()
        self.assertEqual(state["apps"], [])
        self.assertEqual(state["platform"], "mac")

    async def test_list_apps_shape(self) -> None:
        import computer_use

        env = self.make_env()
        self.assertEqual(await computer_use.list_apps(), [{"id": env.bundle, "name": env.name, "running": True}])

    async def test_permissions_status_shape(self) -> None:
        import computer_use

        self.make_env()
        status = await computer_use.permissions_status()
        self.assertEqual(sorted(status), ["accessibility", "help", "screen_recording"])
        self.assertEqual(status["accessibility"], "ok")
        self.assertEqual(status["screen_recording"], "ok")


class GetAppTests(AppTestCase):
    async def test_get_app_binds_and_loads_first_state(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        self.assertEqual(app.bundle_id, env.bundle)
        self.assertEqual(app.name, env.name)
        self.assertEqual(app.pid, env.pid)
        text = app.state
        self.assertIn(f"{env.name} ({env.bundle})", text)
        self.assertIn("window 'Main'", text)
        self.assertIn("indices [0]..[4]", text)
        self.assertIn("'Search'", text)
        self.assertIn("'Save'", text)

    async def test_get_app_denies_unallowed_app_with_actionable_reason(self) -> None:
        from computer_use import errors

        env = self.make_env(allowed=("com.other.app",))
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app()
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertIn(env.bundle, caught.exception.message)
        self.assertIn(str(env.settings_file), caught.exception.message)

    async def test_get_app_screen_locked(self) -> None:
        from computer_use import errors

        env = self.make_env()
        env.locked = True
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app()
        self.assertEqual(caught.exception.code, "SCREEN_LOCKED")

    async def test_get_app_ambiguous(self) -> None:
        from computer_use import errors
        from computer_use.apps import RunningApp

        env = self.make_env(allowed=("com.example.app", "com.example.two"))
        env.running = [
            RunningApp(bundle_id="com.example.app", name="Example", pid=4242, path=None),
            RunningApp(bundle_id="com.example.two", name="Example", pid=4243, path=None),
        ]
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app("Example")
        self.assertEqual(caught.exception.code, "AMBIGUOUS_APP")
        self.assertIn("com.example.two", caught.exception.message)

    async def test_get_app_launches_when_not_running(self) -> None:
        from computer_use.apps import RunningApp

        env = self.make_env()
        env.running = []
        env.launch_result = RunningApp(bundle_id=env.bundle, name=env.name, pid=5555, path=None)
        app = await env.get_app()
        self.assertEqual(env.launch_calls, [{"bundle_id": env.bundle}])
        self.assertEqual(app.pid, 5555)

    async def test_get_app_launch_denied_for_unallowed_bundle(self) -> None:
        from computer_use import errors
        from computer_use.apps import RunningApp

        env = self.make_env(allowed=("com.other.app",))
        env.running = []
        env.launch_result = RunningApp(bundle_id=env.bundle, name=env.name, pid=5555, path=None)
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app()
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")

    async def test_get_app_requires_accessibility(self) -> None:
        from computer_use import errors

        env = self.make_env(permissions={"accessibility": "missing", "screen_recording": "ok", "help": []})
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app()
        self.assertEqual(caught.exception.code, "PERMISSIONS_NOT_GRANTED")
        self.assertIn("Accessibility", caught.exception.message)

    async def test_get_app_without_backend_raises_transport_error(self) -> None:
        import computer_use
        from computer_use import errors

        self.make_env()
        computer_use._backend = lambda: None
        with self.assertRaises(errors.ComputerUseError) as caught:
            await computer_use.get_app("Example")
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("computer use backend unavailable", caught.exception.message)


class AppDispatchTests(AppTestCase):
    async def test_click_press_element_uses_ax_action(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.click(2)
        save_element = env.current["children"][2]
        self.assertEqual(env.ax_calls, [("perform_action", save_element, "AXPress")])
        self.assertEqual(env.recorder.calls_named("click"), [])

    async def test_click_by_index_uses_element_center(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.click(0)
        clicks = env.recorder.calls_named("click")
        self.assertEqual(len(clicks), 1)
        self.assertEqual(clicks[0]["point"], (120.0, 70.0))
        self.assertEqual(clicks[0]["button"], "left")
        self.assertEqual(clicks[0]["count"], 1)
        self.assertEqual(clicks[0]["pid"], env.pid)

    async def test_click_double_count_bypasses_press(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.click(2, count=2)
        clicks = env.recorder.calls_named("click")
        self.assertEqual(len(clicks), 1)
        self.assertEqual(clicks[0]["point"], (320.0, 102.0))
        self.assertEqual(clicks[0]["count"], 2)
        self.assertEqual(env.ax_calls, [])

    async def test_click_by_coords_translates_window_origin(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.click((10, 20))
        clicks = env.recorder.calls_named("click")
        self.assertEqual(clicks[0]["point"], (110.0, 70.0))

    async def test_click_stale_index(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        for index in (999, -1):
            with self.subTest(index=index), self.assertRaises(errors.ComputerUseError) as caught:
                await app.click(index)
            self.assertEqual(caught.exception.code, "ELEMENT_STALE")
            self.assertEqual(env.recorder.calls, [])

    async def test_click_invalid_target_button_count(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        for call, error_code in (
            (lambda: app.click("2"), "INVALID_ARGUMENT"),
            (lambda: app.click(0, button="side"), "INVALID_ARGUMENT"),
            (lambda: app.click(0, count=0), "INVALID_ARGUMENT"),
        ):
            with self.subTest(code=error_code), self.assertRaises(errors.ComputerUseError) as caught:
                await call()
            self.assertEqual(caught.exception.code, error_code)

    async def test_drag_translates_both_points(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.drag((10, 20), (30, 40))
        drags = env.recorder.calls_named("drag")
        self.assertEqual(len(drags), 1)
        self.assertEqual(drags[0]["start"], (110.0, 70.0))
        self.assertEqual(drags[0]["end"], (130.0, 90.0))

    async def test_scroll_by_index_passes_element_center_point(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.scroll(0, "down", 2)
        scrolls = env.recorder.calls_named("scroll")
        self.assertEqual(len(scrolls), 1)
        self.assertEqual(scrolls[0]["point"], (120.0, 70.0))
        self.assertEqual(scrolls[0]["direction"], "down")
        self.assertEqual(scrolls[0]["pages"], 2)

    async def test_scroll_by_coords_translates_point(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.scroll((5, 5), "up")
        scrolls = env.recorder.calls_named("scroll")
        self.assertEqual(scrolls[0]["point"], (105.0, 55.0))
        self.assertEqual(scrolls[0]["direction"], "up")
        self.assertEqual(scrolls[0]["pages"], 1)

    async def test_scroll_invalid_direction_and_pages(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        for call in (lambda: app.scroll(0, "diagonal"), lambda: app.scroll(0, "up", 0)):
            with self.assertRaises(errors.ComputerUseError) as caught:
                await call()
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    async def test_press_key_and_type_text_dispatch(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.press_key("cmd+shift+f")
        await app.type_text("hello")
        self.assertEqual(env.recorder.calls_named("press_key"), [{"pid": env.pid, "key": "cmd+shift+f"}])
        self.assertEqual(env.recorder.calls_named("type_text"), [{"pid": env.pid, "text": "hello"}])

    async def test_type_text_refuses_focused_secure_field(self) -> None:
        from computer_use import errors

        env = self.make_env()
        env.focused_index = 4  # the Password secure field
        env.secure_focus = True  # the live focus agrees
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.type_text("hunter2")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertIn("ask the user", caught.exception.message)
        self.assertEqual(env.recorder.calls_named("type_text"), [])

    def test_walk_prunes_self_referential_children(self) -> None:
        from computer_use import ax

        class FakeServices:
            kAXErrorSuccess = 0

            def _children(self, element):
                if element == "app":
                    return ["app", "menu"]  # app lists itself as a child
                return []

            def AXUIElementCopyAttributeValue(self, element, attribute, _):
                if attribute == "AXChildren":
                    return (0, self._children(element))
                return (-25212, None)

        siblings: list[dict[str, Any]] = []
        refs: list[Any] = []
        ax._walk(FakeServices(), "app", 1, siblings, refs)
        roles = [element["role"] for element in siblings]
        self.assertEqual(roles, [None])  # only the menu child survives; the self-child is pruned

    async def test_type_text_allows_focused_non_secure_field(self) -> None:
        env = self.make_env()
        env.focused_index = 1  # the Search text field
        app = await env.get_app()
        await app.type_text("hello")
        self.assertEqual(env.recorder.calls_named("type_text"), [{"pid": env.pid, "text": "hello"}])

    async def test_press_key_refuses_focused_secure_field(self) -> None:
        from computer_use import errors

        env = self.make_env()
        env.focused_index = 4  # the Password secure field
        env.secure_focus = True  # the live focus agrees
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.press_key("a")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.recorder.calls_named("press_key"), [])

    async def test_paste_refuses_focused_secure_field(self) -> None:
        from computer_use import errors

        env = self.make_env()
        env.focused_index = 4
        env.secure_focus = True  # the live focus agrees
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.paste("secret")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.clipboard_calls, [])

    async def test_element_drift_raises_stale(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        env.drift = True  # the live elements changed since the snapshot
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click(2)
        self.assertEqual(caught.exception.code, "ELEMENT_STALE")
        self.assertIn("re-observe", caught.exception.message)

    async def test_click_coords_outside_window_rejected(self) -> None:
        from computer_use import errors

        env = self.make_env()  # window rect 400x300
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click((400.0, 150.0))
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        self.assertIn("outside the observed window", caught.exception.message)
        self.assertEqual(env.recorder.calls_named("click"), [])

    async def test_ax_state_blocked_when_allowlist_revoked(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        fakes.write_settings(env.settings_tmp.name, allowed=())  # the user revoked the app
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.get_ax_state()
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")

    async def test_ax_state_blocked_when_screen_locked(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        env.locked = True
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.get_ax_state()
        self.assertEqual(caught.exception.code, "SCREEN_LOCKED")

    async def test_screenshot_blocked_when_allowlist_revoked(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        fakes.write_settings(env.settings_tmp.name, allowed=())  # the user revoked the app
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.get_screenshot(attach=False)
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertEqual(env.recorder.calls_named("screenshot_window"), [])

    async def test_action_telemetry_ok_and_error(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        await app.click(0)
        with self.assertRaises(errors.ComputerUseError):
            await app.click(999)
        actions = [event["properties"] for event in env.telemetry_recorder.events if event["name"] == "computer_use_action"]
        self.assertEqual(len(actions), 2)
        self.assertEqual(actions[0]["action"], "click")
        self.assertEqual(actions[0]["outcome"], "ok")
        self.assertIsInstance(actions[0]["duration_ms"], int)
        self.assertEqual(actions[1]["outcome"], "error")
        self.assertEqual(actions[1]["error_code"], "ELEMENT_STALE")

    async def test_screen_locked_blocks_actions(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        env.locked = True
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click(0)
        self.assertEqual(caught.exception.code, "SCREEN_LOCKED")
        self.assertEqual(env.recorder.calls, [])

    async def test_allowlist_recheck_blocks_actions(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        fakes.write_settings(Path(env.settings_tmp.name), allowed=("com.other.app",))
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click(0)
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertEqual(env.recorder.calls, [])


class AppElementActionTests(AppTestCase):
    async def test_set_value_on_editable_element(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.set_value(1, "typed")
        search_element = env.current["children"][1]
        self.assertEqual(env.ax_calls, [("set_value", search_element, "typed")])

    async def test_set_value_on_secure_field_refuses(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.set_value(4, "secret")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertIn("ask the user", caught.exception.message)
        self.assertEqual(env.ax_calls, [])

    async def test_set_value_on_non_editable_refuses(self) -> None:
        from computer_use import errors

        env = self.make_env()
        env.settable = False
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.set_value(1, "typed")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.ax_calls, [])

    async def test_set_value_invalid_value(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.set_value(1, 42)
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    async def test_select_text_finds_occurrence_and_sets_range_only(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.select_text(1, "ue")
        search_element = env.current["children"][1]
        self.assertEqual(env.ax_calls, [("select_text_range", search_element, 1, 2)])
        self.assertEqual(search_element["value"], "query")

    async def test_select_text_prefix_and_suffix_constrain_the_match(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.select_text(1, "er", prefix="u", suffix="y")
        search_element = env.current["children"][1]
        self.assertEqual(env.ax_calls, [("select_text_range", search_element, 2, 2)])
        self.assertEqual(search_element["value"], "query")

    async def test_select_text_on_secure_field_refuses(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.select_text(4, "secret")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.ax_calls, [])

    async def test_perform_secondary_action_validates_exposure(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.perform_secondary_action(3, "AXShowMenu")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        await app.perform_secondary_action(3, "AXPress")
        checkbox_element = env.current["children"][3]
        self.assertEqual(env.ax_calls, [("perform_action", checkbox_element, "AXPress")])

    async def test_paste_writes_clipboard_and_presses_cmd_v(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.paste("rich text", format="md")
        self.assertEqual(env.clipboard_calls, [("save", None), ("write", ("md", "rich text")), ("restore", {"string": "saved"})])
        self.assertEqual(env.recorder.calls_named("press_key"), [{"pid": env.pid, "key": "cmd+v"}])

    async def test_paste_invalid_format(self) -> None:
        from computer_use import errors

        env = self.make_env()
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.paste("text", format="rtf")
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(env.clipboard_calls, [])


class SettleTests(AppTestCase):
    async def test_injected_click_waits_for_the_ui_to_settle(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        env.fingerprint_values = [("Main", 5), ("Main", 6), ("Main", 6)]
        await app.click(0)
        self.assertGreaterEqual(env.fingerprint_reads, 3)  # polled until two reads agreed

    async def test_churning_app_settles_at_the_cap(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        import computer_use

        env.fingerprint_values = [("loading", 1), ("loading", 2)]
        with mock.patch.object(computer_use, "_SETTLE_MAX_SECONDS", 0.2), mock.patch.object(
            computer_use, "_SETTLE_POLL_SECONDS", 0.01
        ):
            started = time.monotonic()
            await app.click(0)
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.0)
        self.assertGreaterEqual(env.fingerprint_reads, 3)

    async def test_unreadable_fingerprint_settles_immediately(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        started = time.monotonic()
        await app.type_text("hello")  # fingerprint None -> no poll
        self.assertLess(time.monotonic() - started, 0.3)
        self.assertEqual(env.fingerprint_reads, 1)


class MovedWindowScaleTests(AppTestCase):
    async def test_the_capture_scale_survives_a_moved_window(self) -> None:
        env = self.make_env()
        env.recorder.screenshot = {"path": "/tmp/computer-use-fake.png", "width": 800, "height": 600}
        app = await env.get_app()
        await app.get_screenshot(attach=False)  # the rect was (100, 50, 400, 300), the png 800x600
        env.window_rect = (260.0, 12.0, 400.0, 300.0)  # the window moved, same size
        await app.get_ax_state()
        await app.click((400.0, 150.0))
        clicks = env.recorder.calls_named("click")
        self.assertEqual(clicks[-1]["point"], (460.0, 87.0))  # 260+400/2, 12+150/2

    async def test_a_resized_window_rejects_points_that_no_longer_fit(self) -> None:
        env = self.make_env()
        env.recorder.screenshot = {"path": "/tmp/computer-use-fake.png", "width": 800, "height": 600}
        app = await env.get_app()
        await app.get_screenshot(attach=False)
        env.window_rect = (100.0, 50.0, 200.0, 150.0)  # the window shrank
        await app.get_ax_state()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click((400.0, 100.0))  # in the old image, outside the live window
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")


class RetinaClickTests(AppTestCase):
    async def test_click_uses_window_pixels_one_to_one_on_a_one_x_capture(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        result = await app.get_screenshot(attach=False)
        self.assertEqual((result["width"], result["height"]), (400, 300))  # 1x fake: no scaling
        await app.click((100.0, 50.0))
        clicks = env.recorder.calls_named("click")
        self.assertEqual(clicks[-1]["point"], (200.0, 100.0))  # origin (100, 50) + the window pixels

    async def test_click_scales_a_two_x_capture_back_to_logical_window_space(self) -> None:
        env = self.make_env()
        env.recorder.screenshot = {"path": "/tmp/computer-use-fake.png", "width": 800, "height": 600}
        app = await env.get_app()
        await app.get_screenshot(attach=False)  # the window rect is 400x300, the PNG is 800x600
        await app.click((400.0, 150.0))
        clicks = env.recorder.calls_named("click")
        self.assertEqual(clicks[-1]["point"], (300.0, 125.0))  # 100+400/2, 50+150/2

    async def test_click_outside_the_captured_image_is_rejected(self) -> None:
        env = self.make_env()
        env.recorder.screenshot = {"path": "/tmp/computer-use-fake.png", "width": 800, "height": 600}
        app = await env.get_app()
        await app.get_screenshot(attach=False)
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click((800.0, 150.0))
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        self.assertIn("outside the captured image", caught.exception.message)

    async def test_a_stale_screenshot_never_scales_a_new_window_rect(self) -> None:
        env = self.make_env()
        env.recorder.screenshot = {"path": "/tmp/computer-use-fake.png", "width": 800, "height": 600}
        app = await env.get_app()
        await app.get_screenshot(attach=False)
        env.window_rect = (100.0, 50.0, 200.0, 150.0)  # the window resized; the shot is stale
        await app.get_ax_state()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click((400.0, 100.0))  # inside the old 800px image, outside the new window
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")


class OffLoopDispatchTests(AppTestCase):
    async def test_the_action_dispatch_runs_off_the_event_loop_thread(self) -> None:
        import threading

        from computer_use import inject as inject_module

        env = self.make_env()
        app = await env.get_app()
        threads: list[int] = []
        original = inject_module._click

        def recording_click(pid, point, button="left", count=1):
            threads.append(threading.get_ident())
            return original(pid, point, button=button, count=count)

        inject_module._click = recording_click
        try:
            await app.click(0)
        finally:
            inject_module._click = original
        self.assertEqual(len(threads), 1)
        self.assertNotEqual(threads[0], threading.get_ident())


class OffLoopThreadTests(AppTestCase):
    async def test_launch_runs_off_the_event_loop_thread(self) -> None:
        import threading

        env = self.make_env()
        env.running = []
        threads: list[int] = []
        original = env._launch
        launched = {"value": None}

        def recording_launch(spec):
            threads.append(threading.get_ident())
            launched["value"] = original(spec)
            return launched["value"]

        apps._launch = recording_launch
        app = await env.get_app("com.example.app")
        self.assertEqual(app.bundle_id, env.bundle)
        self.assertEqual(len(threads), 1)
        self.assertNotEqual(threads[0], threading.get_ident())

    async def test_screenshot_capture_runs_off_the_event_loop_thread(self) -> None:
        import threading

        from computer_use import capture as capture_module

        env = self.make_env()
        threads: list[int] = []
        original = capture_module._screenshot_window

        def recording_capture(origin, size, window_id=None):
            threads.append(threading.get_ident())
            return original(origin, size, window_id=window_id)

        capture_module._screenshot_window = recording_capture
        app = await env.get_app()
        result = await app.get_screenshot(attach=False)
        self.assertIn("path", result)
        self.assertEqual(len(threads), 1)
        self.assertNotEqual(threads[0], threading.get_ident())


class AppObservationTests(AppTestCase):
    async def test_get_ax_state_diff_flow(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        self.assertIn("'Search'", app.state)
        unchanged = await app.get_ax_state()
        self.assertEqual(unchanged, "(no changes since the previous observation)")
        env.set_tree(fakes.with_changed_value(fakes.small_tree(), "Search", "new query"))
        changed = await app.get_ax_state()
        self.assertIn("~", changed)
        self.assertIn("new query", changed)
        full = await app.get_ax_state(diff=False)
        self.assertIn("indices [0]..[4]", full)
        self.assertEqual(app.state, full)

    async def test_get_screenshot_captures_and_attaches(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        result = await app.get_screenshot()
        shots = env.recorder.calls_named("screenshot_window")
        self.assertEqual(shots, [{"origin": (100, 50), "size": (400, 300), "window_id": 4321}])
        self.assertEqual(result["path"], env.recorder.screenshot["path"])
        self.assertEqual(result["width"], 400)
        self.assertEqual(result["height"], 300)

    async def test_get_screenshot_attach_false_skips_attach(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.get_screenshot(attach=False)
        self.assertEqual(env.attach.paths, [])

    async def test_get_screenshot_swallows_attach_failure(self) -> None:
        env = self.make_env()
        env.attach.error = RuntimeError("non-vision model")
        app = await env.get_app()
        result = await app.get_screenshot()
        self.assertEqual(result["width"], 400)
        self.assertEqual(env.attach.paths, [result["path"]])

    async def test_get_screenshot_requires_screen_recording(self) -> None:
        from computer_use import errors

        env = self.make_env(permissions={"accessibility": "ok", "screen_recording": "missing", "help": []})
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.get_screenshot()
        self.assertEqual(caught.exception.code, "PERMISSIONS_NOT_GRANTED")

    async def test_get_screenshot_without_window_raises_transport_error(self) -> None:
        from computer_use import errors

        env = self.make_env()
        env.window_rect = None
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.get_screenshot()
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("no focused window", caught.exception.message)

    async def test_get_state_and_screenshot_shape(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        result = await app.get_state_and_screenshot(diff=False)
        self.assertEqual(sorted(result), ["screenshot", "state"])
        self.assertIn("'Search'", result["state"])
        self.assertEqual(result["screenshot"]["width"], 400)

    async def test_get_state_and_screenshot_swallows_capture_failure(self) -> None:
        from computer_use import errors

        env = self.make_env()
        env.recorder.screenshot_error = errors.ComputerUseError("TRANSPORT_ERROR", "capture failed")
        app = await env.get_app()
        result = await app.get_state_and_screenshot(diff=False)
        self.assertIsNone(result["screenshot"])
        self.assertIn("'Search'", result["state"])
