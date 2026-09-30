"""Regression tests for the security-review fix batch (core lane).

One test per fix: the live secure-focus check, the stale-pid guard, AX
attribute caps and the click-count cap, unknown-grant fail-closed behavior,
telemetry error codes, fail-closed prelaunch gating, casefold name matching,
all-type clipboard save/restore, select_text failure modes, window_id
plumbing, and packaged app-instruction resolution. Everything runs against
fakes; no display, TCC grant, real app, or live framework is touched.
"""

from __future__ import annotations

import shutil
import tomllib
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import fakes
import computer_use
from computer_use import apps, ax, errors


class AppTestCase(unittest.IsolatedAsyncioTestCase):
    """Shared faked-environment helper for App-level tests."""

    def make_env(self, **kwargs: Any) -> fakes.AppEnvironment:
        env = fakes.AppEnvironment(**kwargs)
        env.__enter__()
        self.addCleanup(env.__exit__, None, None, None)
        return env


class LiveSecureFocusTests(AppTestCase):
    async def test_live_secure_focus_refuses_and_overrides_snapshot(self) -> None:
        env = self.make_env()
        env.focused_index = 1  # the snapshot's Search field: not secure
        env.secure_focus = True  # the live focus moved onto a secure field
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.type_text("hunter2")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.recorder.calls_named("type_text"), [])

    async def test_snapshot_fallback_when_live_focus_unavailable(self) -> None:
        env = self.make_env()
        env.focused_index = 4  # the Password secure field in the snapshot
        env.secure_focus = None  # the live read is unavailable
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.press_key("a")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")

    async def test_live_non_secure_focus_overrides_snapshot(self) -> None:
        env = self.make_env()
        env.focused_index = 4
        env.secure_focus = False  # focus moved off the secure field
        app = await env.get_app()
        await app.type_text("hello")
        self.assertEqual(env.recorder.calls_named("type_text"), [{"pid": env.pid, "text": "hello"}])


class StalePidGuardTests(AppTestCase):
    async def test_guard_rejects_vanished_pid(self) -> None:
        from computer_use.apps import RunningApp

        env = self.make_env()
        app = await env.get_app()
        env.running = []  # the bound app quit
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click(0)
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")
        self.assertEqual(env.recorder.calls, [])

    async def test_guard_rejects_reused_pid_owned_by_other_bundle(self) -> None:
        from computer_use.apps import RunningApp

        env = self.make_env()
        app = await env.get_app()
        env.running = [RunningApp(bundle_id="com.other.owner", name="Other", pid=env.pid, path=None)]
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click(0)
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertEqual(env.recorder.calls, [])


class AttributeCapTests(unittest.TestCase):
    def test_describe_caps_every_string_attribute(self) -> None:
        fake_services = types.SimpleNamespace(
            kAXErrorSuccess=0,
            AXUIElementCopyAttributeValue=lambda element, attribute, unused: (0, "x" * 5000),
            AXUIElementCopyActions=lambda element, unused: (0, ["act" * 3000, "AXPress"]),
        )
        described = ax._describe(fake_services, object())
        for key in ("role", "subrole", "title", "value", "description", "placeholder"):
            self.assertEqual(len(described[key]), 2001, key)
            self.assertTrue(described[key].endswith("…"), key)
        self.assertEqual(len(described["actions"][0]), 2001)
        self.assertTrue(described["actions"][0].endswith("…"))
        self.assertIn("AXPress", described["actions"])


class ClickCountCapTests(AppTestCase):
    async def test_click_count_capped_to_ten(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click(0, count=11)
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(env.recorder.calls, [])
        await app.click(0, count=10)
        clicks = env.recorder.calls_named("click")
        self.assertEqual(clicks[0]["count"], 10)


class UnknownGrantTests(AppTestCase):
    async def test_unknown_accessibility_is_not_granted(self) -> None:
        env = self.make_env(
            permissions={"accessibility": "unknown", "screen_recording": "ok", "help": []}
        )
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app()
        self.assertEqual(caught.exception.code, "PERMISSIONS_NOT_GRANTED")

    async def test_unknown_screen_recording_is_not_granted(self) -> None:
        env = self.make_env(
            permissions={"accessibility": "ok", "screen_recording": "unknown", "help": []}
        )
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.get_screenshot(attach=False)
        self.assertEqual(caught.exception.code, "PERMISSIONS_NOT_GRANTED")
        self.assertEqual(env.recorder.calls_named("screenshot_window"), [])


class TelemetryErrorCodeTests(AppTestCase):
    async def test_action_error_carries_outcome_error_and_error_code(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError):
            await app.click(999)
        events = [e["properties"] for e in env.telemetry_recorder.events if e["name"] == "computer_use_action"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["action"], "click")
        self.assertEqual(events[0]["outcome"], "error")
        self.assertEqual(events[0]["error_code"], "ELEMENT_STALE")
        self.assertIsInstance(events[0]["duration_ms"], int)


class FailClosedLaunchTests(AppTestCase):
    async def test_denied_name_never_launches(self) -> None:
        env = self.make_env(allowed=("com.other.app",))
        env.running = []
        with mock.patch.object(apps, "_bundle_for_name", return_value=env.bundle):
            with self.assertRaises(errors.ComputerUseError) as caught:
                await env.get_app("Example")
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertEqual(env.launch_calls, [])

    async def test_unresolvable_name_fails_closed_without_launching(self) -> None:
        env = self.make_env()
        env.running = []
        with mock.patch.object(apps, "_bundle_for_name", return_value=None):
            with self.assertRaises(errors.ComputerUseError) as caught:
                await env.get_app("Mystery App")
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertIn("fails closed", caught.exception.message)
        self.assertEqual(env.launch_calls, [])

    async def test_unreadable_path_fails_closed_without_launching(self) -> None:
        env = self.make_env()
        env.running = []
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app({"path": "/nonexistent/app.app"})
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertEqual(env.launch_calls, [])

    async def test_denied_bundle_id_string_never_launches(self) -> None:
        env = self.make_env(allowed=("com.other.app",))
        env.running = []
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app("com.denied.app")
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertEqual(env.launch_calls, [])

    async def test_allowed_resolved_name_launches_once(self) -> None:
        env = self.make_env()
        env.running = []
        with mock.patch.object(apps, "_bundle_for_name", return_value=env.bundle):
            app = await env.get_app("Example")
        self.assertEqual(env.launch_calls, ["Example"])
        self.assertEqual(app.bundle_id, env.bundle)


class CasefoldTests(unittest.TestCase):
    def test_name_matching_casefolds_unicode(self) -> None:
        from computer_use.apps import RunningApp

        running = [RunningApp(bundle_id="com.example.app", name="Weiß", pid=1, path=None)]
        with mock.patch.object(apps, "_running_apps", lambda: running):
            self.assertEqual(len(apps._resolve("weiss")), 1)
            self.assertEqual(len(apps._resolve("WEISS")), 1)
            self.assertEqual(apps._resolve("nope"), [])


class AllTypeClipboardTests(unittest.TestCase):
    def _fake_cocoa(self, pasteboard: Any) -> Any:
        return types.SimpleNamespace(
            NSPasteboard=types.SimpleNamespace(generalPasteboard=lambda: pasteboard),
            NSData=types.SimpleNamespace(dataWithBytes_length_=lambda data, length: (data, length)),
        )

    def test_save_and_restore_cover_every_pasteboard_type(self) -> None:
        class FakePasteboard:
            def __init__(self) -> None:
                self.restored: list[tuple[str, Any]] = []
                self.cleared = 0
                self._data = {
                    "public.utf8-plain-text": b"hello",
                    "public.png": b"\x89PNG fake",
                    "com.custom.type": b"\x01\x02",
                }

            def types(self) -> list[str]:
                return list(self._data)

            def dataForType_(self, type_name: str) -> bytes | None:
                return self._data.get(type_name)

            def clearContents(self) -> None:
                self.cleared += 1

            def setData_forType_(self, data: Any, type_name: str) -> None:
                self.restored.append((type_name, data))

        pasteboard = FakePasteboard()
        fake_mac = types.SimpleNamespace(cocoa=self._fake_cocoa(pasteboard))
        with mock.patch.object(computer_use, "_require_mac", lambda: fake_mac):
            saved = computer_use._save_clipboard()
            computer_use._restore_clipboard(saved)
        self.assertEqual(
            saved,
            {
                "public.utf8-plain-text": b"hello",
                "public.png": b"\x89PNG fake",
                "com.custom.type": b"\x01\x02",
            },
        )
        self.assertEqual(pasteboard.cleared, 1)
        self.assertEqual(sorted(pasteboard.restored)[0][0], "com.custom.type")
        self.assertEqual(len(pasteboard.restored), 3)

    def test_restore_of_empty_clipboard_only_clears(self) -> None:
        class EmptyPasteboard:
            def __init__(self) -> None:
                self.restored: list[tuple[str, Any]] = []
                self.cleared = 0

            def types(self) -> list[str]:
                return []

            def dataForType_(self, type_name: str) -> bytes | None:
                return None

            def clearContents(self) -> None:
                self.cleared += 1

            def setData_forType_(self, data: Any, type_name: str) -> None:
                self.restored.append((type_name, data))

        pasteboard = EmptyPasteboard()
        fake_mac = types.SimpleNamespace(cocoa=self._fake_cocoa(pasteboard))
        with mock.patch.object(computer_use, "_require_mac", lambda: fake_mac):
            self.assertIsNone(computer_use._save_clipboard())
            computer_use._restore_clipboard(None)
        self.assertEqual(pasteboard.cleared, 1)
        self.assertEqual(pasteboard.restored, [])


class SelectTextFailureModeTests(AppTestCase):
    async def test_missing_occurrence_raises_element_stale(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.select_text(1, "nope")
        self.assertEqual(caught.exception.code, "ELEMENT_STALE")
        self.assertEqual(env.ax_calls, [])
        self.assertEqual(env.current["children"][1]["value"], "query")

    async def test_multiple_occurrences_raise_action_unsupported(self) -> None:
        tree = fakes.window(
            children=[fakes.element(role="AXTextArea", title="Notes", value="ab cd ab")]
        )
        env = self.make_env(tree=tree)
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.select_text(0, "ab")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.ax_calls, [])
        self.assertEqual(tree["children"][0]["value"], "ab cd ab")

    async def test_unreadable_value_raises_action_unsupported(self) -> None:
        tree = fakes.window(children=[fakes.element(role="AXTextArea", title="Notes", value=None)])
        env = self.make_env(tree=tree)
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.select_text(0, "ab")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.ax_calls, [])


class WindowIdPlumbingTests(AppTestCase):
    async def test_screenshot_passes_the_ax_window_id(self) -> None:
        env = self.make_env()
        env.window_id = 4321
        app = await env.get_app()
        result = await app.get_screenshot(attach=False)
        shots = env.recorder.calls_named("screenshot_window")
        self.assertEqual(shots, [{"origin": (100, 50), "size": (400, 300), "window_id": 4321}])
        self.assertEqual(result["width"], 400)

    async def test_screenshot_without_window_id_keeps_region_capture(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.get_screenshot(attach=False)
        self.assertEqual(
            env.recorder.calls_named("screenshot_window"),
            [{"origin": (100, 50), "size": (400, 300)}],
        )


class PackagedInstructionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.packaged_dir = Path(ax.__file__).resolve().parent / "references" / "app-instructions"
        self.created_root = not self.packaged_dir.parent.exists()
        self.packaged_dir.mkdir(parents=True, exist_ok=True)
        self.addCleanup(self._cleanup)
        self.bundle = "com.example.app"
        self.packaged_file = self.packaged_dir / f"{self.bundle}.md"
        self.packaged_file.write_text("packaged instructions\n", encoding="utf-8")

    def _cleanup(self) -> None:
        if self.packaged_file.exists():
            self.packaged_file.unlink()
        if self.created_root and self.packaged_dir.parents[0].exists():
            shutil.rmtree(self.packaged_dir.parents[0])

    def test_instructions_resolve_from_the_packaged_path_first(self) -> None:
        self.assertTrue(str(ax._instructions_path(self.bundle)).endswith("src/computer_use/references/app-instructions/com.example.app.md"))
        self.assertEqual(ax._load_instructions(self.bundle), "packaged instructions")

    def test_packaged_file_ships_in_the_wheel(self) -> None:
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        with pyproject.open("rb") as handle:
            config = tomllib.load(handle)
        mapping = config["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]
        self.assertEqual(mapping["references/app-instructions"], "computer_use/references/app-instructions")

    def test_falls_back_to_the_skill_dir_without_packaged_files(self) -> None:
        self.packaged_file.unlink()
        self._cleanup()
        # Re-enter without the packaged file: the skill-dir layout resolves.
        self.assertTrue(str(ax._instructions_path(self.bundle)).endswith("references/app-instructions/com.example.app.md"))
        self.assertNotIn("src/computer_use/references", str(ax._instructions_path(self.bundle)))


if __name__ == "__main__":
    unittest.main()
