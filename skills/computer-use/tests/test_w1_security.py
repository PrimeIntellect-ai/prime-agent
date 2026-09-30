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


class LockProbeFailClosedTests(AppTestCase):
    async def test_an_unreadable_lock_session_fails_closed(self) -> None:
        import computer_use
        from computer_use import policy as policy_module

        env = self.make_env()
        saved = policy_module._screen_locked
        policy_module._screen_locked = lambda: True  # the probe failed: unverifiable
        try:
            with self.assertRaises(errors.ComputerUseError) as caught:
                await computer_use.get_app(env.bundle)
        finally:
            policy_module._screen_locked = saved
        self.assertEqual(caught.exception.code, "SCREEN_LOCKED")


class DottedNameResolutionTests(AppTestCase):
    async def test_a_dotted_display_name_resolves_before_launch(self) -> None:
        from computer_use.apps import RunningApp

        env = self.make_env()
        env.running = []
        # "Acme 1.0" looks like a bundle id (it has a dot) but Spotlight
        # resolves it as a display name to the real bundle id
        with mock.patch.object(apps, "_bundle_for_name", return_value=env.bundle):
            app = await env.get_app("Acme 1.0")
        self.assertEqual(app.bundle_id, env.bundle)
        self.assertEqual(env.launch_calls, [{"bundle_id": env.bundle}])

    async def test_a_dotted_bundle_id_for_a_running_app_stays_a_bundle_id(self) -> None:
        env = self.make_env()
        # the running app owns the dotted bundle id: no name resolution runs
        app = await env.get_app(env.bundle)
        self.assertEqual(app.bundle_id, env.bundle)

    async def test_an_unresolvable_dotted_string_stays_a_bundle_id(self) -> None:
        from computer_use.apps import RunningApp

        env = self.make_env(allowed=("com.mystery.app",))
        env.running = []
        env.launch_result = RunningApp(bundle_id="com.mystery.app", name="Mystery", pid=9999, path=None)
        with mock.patch.object(apps, "_bundle_for_name", return_value=None):
            app = await env.get_app("com.mystery.app")
        self.assertEqual(app.bundle_id, "com.mystery.app")
        self.assertEqual(env.launch_calls, [{"bundle_id": "com.mystery.app"}])


class SecureFocusFailClosedTests(AppTestCase):
    async def test_unavailable_live_focus_fails_closed(self) -> None:
        env = self.make_env()
        env.focused_index = 4  # the Password secure field in the snapshot
        env.secure_focus = None  # the live read failed
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.press_key("a")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertIn("could not verify", caught.exception.message)
        self.assertEqual(caught.exception.details, {"live": False})

    async def test_unavailable_live_focus_fails_closed_over_a_non_secure_snapshot(self) -> None:
        env = self.make_env()
        env.focused_index = 1  # the Search field: not secure in the snapshot
        env.secure_focus = None  # the live read failed
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.type_text("hunter2")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.recorder.calls_named("type_text"), [])


class LockProbeNoneSessionTests(unittest.TestCase):
    def test_a_null_session_dictionary_reads_as_locked(self) -> None:
        from computer_use import policy

        class NullSessionQuartz:
            @staticmethod
            def CGSessionCopyCurrentDictionary():
                return None  # pyobjc maps the NULL CFTypeRef to None, no raise

        saved_locked = policy._locked_from_session
        policy._locked_from_session = lambda session: (_ for _ in ()).throw(AssertionError("must not run"))
        try:
            import computer_use._compat as compat
            original = compat._require_mac
            compat._require_mac = lambda: types.SimpleNamespace(
                quartz=types.SimpleNamespace(CGSessionCopyCurrentDictionary=NullSessionQuartz.CGSessionCopyCurrentDictionary)
            )
            try:
                self.assertTrue(policy._screen_locked())
            finally:
                compat._require_mac = original
        finally:
            policy._locked_from_session = saved_locked


class TruncationMarkerTests(unittest.TestCase):
    def test_a_bounded_away_walk_is_marked_truncated(self) -> None:
        services = types.SimpleNamespace(
            kAXErrorSuccess=0,
            AXUIElementSetMessagingTimeout=lambda element, seconds: None,
            AXUIElementCreateApplication=lambda pid: "app",
            AXUIElementCopyAttributeValue=lambda element, attribute, unused: (
                0,
                {
                    "AXFocusedWindow": "window",
                    "AXChildren": ["child"],
                    "AXRole": "AXGroup",
                    "AXTitle": None,
                    "AXPosition": None,
                    "AXSize": None,
                    "_AXWindowID": 1,
                }[attribute],
            ),
        )
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=services)):
            with mock.patch.object(ax, "_MAX_ELEMENTS", 0):
                observation = ax._observe(4242)
        self.assertTrue(observation.truncated)


class SpotlightEscapeTests(unittest.TestCase):
    def test_display_name_metacharacters_are_escaped(self) -> None:
        from computer_use.apps import _escape_spotlight

        self.assertEqual(_escape_spotlight("Acme 1.0"), "Acme 1.0")
        self.assertEqual(_escape_spotlight("We*rd ?Name"), "We\\*rd \\?Name")
        self.assertEqual(_escape_spotlight('Say "hi"'), 'Say \\"hi\\"')

    def test_an_ambiguous_installed_name_raises_instead_of_guessing(self) -> None:
        from computer_use.apps import RunningApp

        def fake_run(command, capture_output, text, timeout):
            return types.SimpleNamespace(
                returncode=0, stdout="/app/one.app\n/app/two.app\n", stderr=""
            )

        with mock.patch.object(apps.subprocess, "run", side_effect=fake_run):
                with mock.patch.object(
                    apps,
                    "_bundle_id_for_bundle_dir",
                    side_effect=lambda path: "com.one" if "one" in path else "com.two",
                ):
                    with self.assertRaises(errors.ComputerUseError) as caught:
                        apps._bundle_for_name("Duplicate")
        self.assertEqual(caught.exception.code, "AMBIGUOUS_APP")
        self.assertIn("com.one", caught.exception.message)
        self.assertIn("com.two", caught.exception.message)


class SnapshotConsistencyTests(AppTestCase):
    async def test_a_reobserve_during_the_capture_cannot_retag_the_shot(self) -> None:
        from computer_use import capture as capture_module

        env = self.make_env()
        app = await env.get_app()
        observation_at_capture = {"value": None}

        def recording_capture(origin, size, window_id=None):
            # a concurrent get_ax_state swaps the focused window mid-capture
            env.window_id = 9999
            env.window_rect = (10.0, 10.0, 100.0, 100.0)
            observation_at_capture["value"] = window_id
            return {"path": "/tmp/fake.png", "width": 400, "height": 300}

        original = capture_module._screenshot_window
        capture_module._screenshot_window = recording_capture
        try:
            result = await app.get_screenshot(attach=False)
        finally:
            capture_module._screenshot_window = original
        # the shot is tagged with the window it captured, not the new focus
        self.assertEqual(observation_at_capture["value"], 4321)
        self.assertEqual(app._shot_window_id, 4321)


class GuardedBindTests(AppTestCase):
    async def test_the_bind_refreshes_under_guard(self) -> None:
        from computer_use import errors as error_module

        env = self.make_env()
        env.running = []
        # the app launches, then the user revokes it before the first read
        original = env._launch

        def launching_then_revoked(spec):
            result = original(spec)
            env.running = []
            return result

        apps._launch = launching_then_revoked
        try:
            with self.assertRaises(error_module.ComputerUseError) as caught:
                await env.get_app()
        finally:
            apps._launch = original
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")


class ChangeCountRestoreTests(AppTestCase):
    async def test_a_same_text_copy_with_different_rich_data_is_kept(self) -> None:
        import computer_use

        env = self.make_env()
        app = await env.get_app()
        saved = computer_use._clipboard_unchanged
        computer_use._clipboard_unchanged = lambda count, text: False  # the count moved: rich data changed
        try:
            await app.paste("payload")
        finally:
            computer_use._clipboard_unchanged = saved
        self.assertNotIn(("restore", {"string": "saved"}), env.clipboard_calls)


class BuiltinDenyInvariantTests(unittest.TestCase):
    def test_a_settings_instance_cannot_allow_a_builtin_system_deny_entry(self) -> None:
        from computer_use import policy

        settings = policy.Settings(allowed=("com.apple.loginwindow",), system_deny=("com.custom.deny",))
        result = policy._gate("com.apple.loginwindow", settings)
        self.assertFalse(result.allowed)
        self.assertIn("system deny-list", result.reason)


class GateOrderingTests(AppTestCase):
    async def test_locked_screen_wins_over_the_secure_field_refusal(self) -> None:
        env = self.make_env()
        env.focused_index = 4
        env.secure_focus = True
        app = await env.get_app()
        env.locked = True
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.press_key("a")
        self.assertEqual(caught.exception.code, "SCREEN_LOCKED")
        self.assertEqual(env.recorder.calls, [])

    async def test_revoked_allowlist_wins_over_the_secure_field_refusal(self) -> None:
        env = self.make_env()
        env.focused_index = 4
        env.secure_focus = True
        app = await env.get_app()
        fakes.write_settings(env.settings_tmp.name, allowed=())
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.type_text("secret")
        self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        self.assertEqual(env.recorder.calls, [])

    async def test_revoked_accessibility_grant_reports_permissions_not_granted(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        env.permissions = {"accessibility": "missing", "screen_recording": "ok", "help": []}
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.click(0)
        self.assertEqual(caught.exception.code, "PERMISSIONS_NOT_GRANTED")
        self.assertIn("revoke", caught.exception.message)
        self.assertEqual(env.recorder.calls, [])


class LaunchGateTests(AppTestCase):
    async def test_missing_grant_never_launches_the_app(self) -> None:
        env = self.make_env(permissions={"accessibility": "missing", "screen_recording": "ok", "help": []})
        env.running = []
        with self.assertRaises(errors.ComputerUseError) as caught:
            await env.get_app("com.example.app")
        self.assertEqual(caught.exception.code, "PERMISSIONS_NOT_GRANTED")
        self.assertEqual(env.launch_calls, [])


class LiveSecureRefTests(AppTestCase):
    async def test_set_value_refuses_a_field_that_turned_secure_after_the_snapshot(self) -> None:
        env = self.make_env()
        env.live_secure_ref = True  # the live subrole is AXSecureTextField
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.set_value(1, "secret")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertIn("secure field", caught.exception.message)
        self.assertEqual(env.ax_calls, [])

    async def test_select_text_refuses_a_field_that_turned_secure_after_the_snapshot(self) -> None:
        env = self.make_env()
        env.live_secure_ref = True
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.select_text(1, "que")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.ax_calls, [])


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
        # the launch targets the resolved bundle id, not the mutable name
        self.assertEqual(env.launch_calls, [{"bundle_id": env.bundle}])
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

    def test_one_failing_type_never_blocks_the_remaining_restore(self) -> None:
        class HalfFailingPasteboard:
            def __init__(self) -> None:
                self.restored: list[tuple[str, Any]] = []
                self.cleared = 0

            def clearContents(self) -> None:
                self.cleared += 1

            def setData_forType_(self, data: Any, type_name: str) -> None:
                if type_name == "com.custom.type":
                    raise RuntimeError("this type cannot be written")
                self.restored.append((type_name, data))

        pasteboard = HalfFailingPasteboard()
        fake_mac = types.SimpleNamespace(cocoa=self._fake_cocoa(pasteboard))
        saved = {"public.utf8-plain-text": b"hello", "public.png": b"\x89PNG fake", "com.custom.type": b"\x01\x02"}
        with mock.patch.object(computer_use, "_require_mac", lambda: fake_mac):
            computer_use._restore_clipboard(saved)
        self.assertEqual(pasteboard.cleared, 1)
        self.assertEqual(
            sorted(name for name, _data in pasteboard.restored),
            ["public.png", "public.utf8-plain-text"],
        )

    def test_empty_snapshot_restores_as_clear_and_none_never_touches_the_pasteboard(self) -> None:
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
            # an empty pasteboard snapshots as an empty dict, not None
            self.assertEqual(computer_use._save_clipboard(), {})
            computer_use._restore_clipboard({})
        self.assertEqual(pasteboard.cleared, 1)
        self.assertEqual(pasteboard.restored, [])
        # a failed snapshot (None) never touches the pasteboard
        self.assertEqual(pasteboard.cleared, 1)
        computer_use._restore_clipboard(None)
        self.assertEqual(pasteboard.cleared, 1)


class ClipboardWriteFailureTests(AppTestCase):
    async def test_a_failed_write_restores_the_snapshot(self) -> None:
        import computer_use

        env = self.make_env()
        app = await env.get_app()
        original = env._write_clipboard

        def failing_write(text, format):
            raise RuntimeError("pasteboard refused the write")

        computer_use._write_clipboard = failing_write
        try:
            with self.assertRaises(errors.ComputerUseError) as caught:
                await app.paste("payload")
        finally:
            computer_use._write_clipboard = original
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        # the cleared pasteboard is restored, not left empty
        self.assertIn(("restore", {"string": "saved"}), env.clipboard_calls)


class ClipboardSnapshotTests(AppTestCase):
    async def test_failed_snapshot_aborts_before_touching_the_clipboard(self) -> None:
        import computer_use

        env = self.make_env()
        app = await env.get_app()
        saved_snapshot = computer_use._save_clipboard
        computer_use._save_clipboard = lambda: None  # the snapshot failed
        try:
            with self.assertRaises(errors.ComputerUseError) as caught:
                await app.paste("payload")
        finally:
            computer_use._save_clipboard = saved_snapshot
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("snapshot", caught.exception.message)
        self.assertEqual(env.clipboard_calls, [])
        self.assertEqual(env.recorder.calls_named("press_key"), [])

    async def test_user_copy_during_the_paste_window_survives(self) -> None:
        import computer_use

        env = self.make_env()
        env.pasteboard_holds_payload = False  # the clipboard changed mid-paste
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.paste("payload")
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("clipboard changed", caught.exception.message)
        # the payload is never sent, the user's copy is never restored over
        self.assertEqual(env.recorder.calls_named("press_key"), [])
        self.assertEqual(
            env.clipboard_calls,
            [("save", None), ("write", ("text", "payload"))],
        )


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

    async def test_a_window_without_an_id_fails_closed(self) -> None:
        from computer_use import errors as error_module

        env = self.make_env()
        env.window_id = None
        app = await env.get_app()
        with self.assertRaises(error_module.ComputerUseError) as caught:
            await app.get_screenshot(attach=False)
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("cannot be scoped", caught.exception.message)
        self.assertEqual(env.recorder.calls_named("screenshot_window"), [])  # never a region capture


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
