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
        env.secure_focus = True  # the live focus moved onto a secure field
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.type_text("hunter2")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertEqual(env.recorder.calls_named("type_text"), [])

    async def test_snapshot_fallback_when_live_focus_unavailable(self) -> None:
        env = self.make_env()
        env.secure_focus = None  # the live read is unavailable
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.press_key("a")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")

    async def test_live_non_secure_focus_overrides_snapshot(self) -> None:
        env = self.make_env()
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
        env.secure_focus = None  # the live read failed
        app = await env.get_app()
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.press_key("a")
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertIn("could not verify", caught.exception.message)
        self.assertEqual(caught.exception.details, {"live": False})

    async def test_unavailable_live_focus_fails_closed_over_a_non_secure_snapshot(self) -> None:
        env = self.make_env()
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
        computer_use._clipboard_unchanged = lambda count: False  # the count moved: rich data changed
        try:
            with self.assertRaises(errors.ComputerUseError) as caught:
                await app.paste("payload")
        finally:
            computer_use._clipboard_unchanged = saved
        # the replacement rich data is never pasted, and the copy is kept:
        # the restore never lands over it
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("clipboard changed during the paste", caught.exception.message)
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
        env.secure_focus = True
        app = await env.get_app()
        env.locked = True
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.press_key("a")
        self.assertEqual(caught.exception.code, "SCREEN_LOCKED")
        self.assertEqual(env.recorder.calls, [])

    async def test_revoked_allowlist_wins_over_the_secure_field_refusal(self) -> None:
        env = self.make_env()
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


class PasteLockSnapshotTests(AppTestCase):
    async def test_the_snapshot_is_taken_while_the_paste_lock_is_held(self) -> None:
        env = self.make_env()
        app = await env.get_app()

        class RecordingLock:
            """A lock stand-in that records whether it is currently held."""

            def __init__(self) -> None:
                self.held = False
                self.toggle_history: list[bool] = []

            def __enter__(self) -> "RecordingLock":
                self.held = True
                self.toggle_history.append(True)
                return self

            def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
                self.held = False
                self.toggle_history.append(False)

        lock = RecordingLock()
        held_at_snapshot: list[bool] = []
        env_save = computer_use._save_clipboard  # the environment fake, still called below

        def recording_save() -> dict[str, Any]:
            # the moment of the snapshot: was the paste lock already held?
            held_at_snapshot.append(lock.held)
            return env_save()

        with mock.patch.object(computer_use, "_PASTE_LOCK", lock), mock.patch.object(
            computer_use, "_save_clipboard", recording_save
        ):
            await app.paste("payload")

        # the instrumented lock was actually acquired and released during the paste
        self.assertEqual(lock.toggle_history, [True, False])
        # the snapshot ran while the lock was held: save, write, paste, and
        # restore are one lock-held transaction, so a concurrent paste can
        # never snapshot or restore the other paste's payload
        self.assertEqual(held_at_snapshot, [True])
        # and the paste itself still completed its clipboard transaction
        self.assertEqual(
            env.clipboard_calls,
            [("save", None), ("write", ("text", "payload")), ("restore", {"string": "saved"})],
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


class ElementSnapshotRaceTests(AppTestCase):
    async def test_element_captures_one_observation_for_refs_and_tree(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        old_refs = [
            {"role": "AXButton", "title": "A"},
            {"role": "AXTextField", "title": "B"},
        ]
        old_tree = [
            {"role": "AXButton", "title": "A", "children": []},
            {"role": "AXTextField", "title": "B", "children": []},
        ]
        new_observation = types.SimpleNamespace(
            refs=[{"role": "AXButton", "title": "A"}],
            tree=[{"role": "AXButton", "title": "A", "children": []}],
        )

        class SwappingObservation:
            """The current snapshot; a concurrent refresh publishes mid-read."""

            @property
            def refs(self):
                # the refresh lands between the refs read and the tree read
                app._observation = new_observation
                return old_refs

            @property
            def tree(self):
                return old_tree

        app._observation = SwappingObservation()
        element, ref = app._element(1)
        self.assertEqual(element["role"], "AXTextField")
        self.assertIs(ref, old_refs[1])


class QueuedPasteGateTests(AppTestCase):
    async def test_a_queued_paste_rechecks_the_gates_under_the_lock(self) -> None:
        env = self.make_env()
        app = await env.get_app()

        class RecordingLock:
            """A lock stand-in that records whether it is currently held."""

            def __init__(self) -> None:
                self.held = False

            def __enter__(self) -> "RecordingLock":
                self.held = True
                return self

            def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
                self.held = False

        lock = RecordingLock()
        held_at_focus: list[bool] = []
        held_at_guard: list[bool] = []
        real_focus = app._refuse_secure_focus
        real_guard = app._guard

        def recording_focus() -> None:
            held_at_focus.append(lock.held)
            real_focus()

        def recording_guard() -> None:
            held_at_guard.append(lock.held)
            real_guard()

        with mock.patch.object(computer_use, "_PASTE_LOCK", lock), mock.patch.object(
            app, "_refuse_secure_focus", recording_focus
        ), mock.patch.object(app, "_guard", recording_guard):
            await app.paste("payload")

        self.assertTrue(held_at_focus, "the paste checks the secure focus")
        self.assertTrue(all(held_at_focus), "every secure-focus check runs under the paste lock")
        self.assertIn(True, held_at_guard, "the guard recheck runs under the paste lock")
        self.assertEqual(
            env.clipboard_calls,
            [("save", None), ("write", ("text", "payload")), ("restore", {"string": "saved"})],
        )


class TruncatedDiffWarningTests(AppTestCase):
    async def test_a_truncated_diff_keeps_the_truncated_warning(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.get_ax_state()
        truncated = ax._observe(4242)._replace(truncated=True)
        with mock.patch.object(ax, "_observe", lambda pid: truncated):
            text = await app.get_ax_state()
        self.assertIn("(no changes since the previous observation)", text)
        self.assertIn("TRUNCATED: the observation stopped at its element/depth/time bounds, some controls are hidden", text)


class CappedTitleStaleTests(AppTestCase):
    async def test_a_capped_title_element_is_not_always_stale(self) -> None:
        real_fingerprint = ax._live_fingerprint
        env = self.make_env()
        app = await env.get_app()
        long_title = "T" * (ax._MAX_ATTRIBUTE_CHARS + 50)
        app._observation = fakes.observation(
            [{"role": "AXButton", "title": ax._cap(long_title), "children": []}]
        )
        live_services = types.SimpleNamespace(
            kAXErrorSuccess=0,
            AXUIElementSetMessagingTimeout=lambda element, seconds: None,
            AXUIElementCopyAttributeValue=lambda element, attribute, unused: (
                0,
                {"AXRole": "AXButton", "AXTitle": long_title}[attribute],
            ),
        )
        with mock.patch.object(
            ax, "_require_mac", lambda: types.SimpleNamespace(app_services=live_services)
        ), mock.patch.object(ax, "_live_fingerprint", real_fingerprint):
            element, ref = app._element(0)
        self.assertEqual(element["title"], ax._cap(long_title))


class UnreadableWindowIdShotTests(AppTestCase):
    async def test_an_unreadable_window_id_refuses_to_scale_the_old_shot(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.get_screenshot(attach=False)
        self.assertEqual(app._shot_window_id, 4321)
        app._observation = ax._observe(4242)._replace(window_id=None)
        with self.assertRaises(errors.ComputerUseError) as caught:
            app._window_point((10.0, 10.0))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")

    async def test_a_matching_window_id_still_scales_the_shot(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.get_screenshot(attach=False)
        self.assertEqual(app._shot_window_id, 4321)
        point = app._window_point((10.0, 10.0))
        self.assertEqual(point, (110.0, 60.0))


class WindowPointSnapshotTests(AppTestCase):
    async def test_window_point_captures_one_observation(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        await app.get_screenshot(attach=False)  # the shot: window id 4321, rect (100, 50, 400, 300)
        new_observation = ax._observe(4242)  # the refresh that lands mid-read

        class SwappingObservation:
            """The old snapshot; a concurrent refresh publishes mid-read."""

            @property
            def window_rect(self):
                # the refresh lands between the rect read and the id read
                app._observation = new_observation
                return (300.0, 50.0, 400.0, 300.0)  # the old window's origin

            @property
            def window_id(self):
                return 9999  # the old window's id

        app._observation = SwappingObservation()
        # never the old window's rect with the new window's id: the captured
        # snapshot rejects the stale window instead of misdirecting the click
        with self.assertRaises(errors.ComputerUseError) as caught:
            app._window_point((10.0, 10.0))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")


class DisplacedPayloadTests(AppTestCase):
    async def test_a_copy_during_the_gate_rechecks_aborts_the_paste(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        env.pasteboard_holds_payload = True
        real_refuse = app._refuse_secure_focus
        refuse_calls: list[int] = []

        def copying_refuse() -> None:
            refuse_calls.append(1)
            if len(refuse_calls) >= 2:
                # a copy lands during the pre-press gate recheck, after the
                # payload verification has already passed
                env.pasteboard_holds_payload = False
            real_refuse()

        with mock.patch.object(app, "_refuse_secure_focus", copying_refuse):
            with self.assertRaises(errors.ComputerUseError) as caught:
                await app.paste("payload")
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("clipboard changed during the paste", caught.exception.message)

    async def test_a_same_text_copy_during_the_gate_rechecks_aborts_the_paste(self) -> None:
        real_unchanged = computer_use._clipboard_unchanged  # before the fakes patch it away
        env = self.make_env()
        app = await env.get_app()
        env.pasteboard_holds_payload = True
        env.clipboard_change_count = 3
        real_refuse = app._refuse_secure_focus
        refuse_calls: list[int] = []

        def copying_refuse() -> None:
            refuse_calls.append(1)
            if len(refuse_calls) >= 2:
                # a same-text copy carrying different rich data moves the
                # change count while the payload string still matches
                env.clipboard_change_count = 4
            real_refuse()

        with mock.patch.object(app, "_refuse_secure_focus", copying_refuse), mock.patch.object(
            computer_use, "_clipboard_unchanged", real_unchanged
        ):
            with self.assertRaises(errors.ComputerUseError) as caught:
                await app.paste("payload")
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("clipboard changed during the paste", caught.exception.message)

    async def test_an_unreadable_change_count_fails_the_paste_closed(self) -> None:
        real_unchanged = computer_use._clipboard_unchanged  # before the fakes patch it away
        env = self.make_env()
        app = await env.get_app()
        env.pasteboard_holds_payload = True
        env.clipboard_change_count = None  # the count token is unreadable
        pasteboard = types.SimpleNamespace(
            dataForType_=lambda type_: b"payload",  # the string matches; rich data cannot be verified
        )
        fake_mac = types.SimpleNamespace(
            cocoa=types.SimpleNamespace(
                NSPasteboard=types.SimpleNamespace(generalPasteboard=lambda: pasteboard),
                NSPasteboardTypeString="string",
            )
        )
        with mock.patch.object(computer_use, "_clipboard_unchanged", real_unchanged), mock.patch.object(
            computer_use, "_require_mac", lambda: fake_mac
        ):
            with self.assertRaises(errors.ComputerUseError) as caught:
                await app.paste("payload")
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("clipboard changed during the paste", caught.exception.message)
        # an unverifiable pasteboard never restores over the concurrent copy
        self.assertNotIn(("restore", {"string": "saved"}), env.clipboard_calls)


class SystemDenyRecoveryTests(unittest.TestCase):
    def test_the_system_deny_refusal_does_not_suggest_an_allowlist_override(self) -> None:
        from computer_use import policy

        result = policy._gate("com.apple.loginwindow", policy.Settings())
        self.assertFalse(result.allowed)
        self.assertIn("always refused", result.reason)
        self.assertIn("will NOT allow it", result.reason)
        self.assertNotIn("To allow an app, add its bundle id", result.reason)

    def test_a_custom_deny_names_the_real_key_and_is_not_called_an_os_auth_surface(self) -> None:
        from computer_use import policy

        settings = policy.Settings(system_deny=("com.custom.deny",))
        result = policy._gate("com.custom.deny", settings)
        self.assertFalse(result.allowed)
        self.assertIn("top-level `system_deny`", result.reason)
        self.assertIn("will NOT allow it", result.reason)
        self.assertNotIn("OS authentication", result.reason)
        self.assertNotIn("apps.system_deny", result.reason)


class FirstDiffGuideTests(AppTestCase):
    async def test_the_guide_survives_the_first_diff_after_a_growth_from_empty(self) -> None:
        env = self.make_env(
            bundle="com.tinyspeck.slackmacgap",
            tree=fakes.window(children=[]),
        )
        app = await env.get_app()  # the bind renders the empty window: no guide yet
        self.assertNotIn("Compose without sending", app._state)
        env.set_tree(fakes.small_tree())  # the app gains its first elements
        text = await app.get_ax_state()  # the default diff path
        self.assertIn("Compose without sending", text, "the per-app guide must reach the caller")

    async def test_the_guide_is_shown_exactly_once(self) -> None:
        env = self.make_env(
            bundle="com.tinyspeck.slackmacgap",
            tree=fakes.window(children=[]),
        )
        app = await env.get_app()
        env.set_tree(fakes.small_tree())
        first = await app.get_ax_state()
        second = await app.get_ax_state()
        self.assertIn("Compose without sending", first)
        self.assertNotIn("Compose without sending", second)


class RestoreAfterSettleTests(AppTestCase):
    async def test_the_restore_waits_for_the_paste_to_settle(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        order: list[str] = []
        real_settle = app._settle
        real_restore = computer_use._restore_clipboard

        def settle_recording() -> None:
            order.append("settle")
            real_settle()

        def restore_recording(saved: Any) -> None:
            order.append("restore")
            real_restore(saved)

        with mock.patch.object(app, "_settle", settle_recording), mock.patch.object(
            computer_use, "_restore_clipboard", restore_recording
        ):
            await app.paste("payload")
        self.assertEqual(order, ["settle", "restore"], "the clipboard is restored only after the app consumed the paste")
        self.assertEqual(
            env.clipboard_calls,
            [("save", None), ("write", ("text", "payload")), ("restore", {"string": "saved"})],
        )

    async def test_an_unconsumed_paste_preserves_the_payload_and_says_so(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        # a busy app: the focused value never changes, so no consumption signal exists
        env.paste_baselines = [(env.paste_focus_before, "unchanged value")]
        status = await app.paste("payload")
        self.assertIn("could not be verified", status)
        self.assertIn(("write", ("text", "payload")), env.clipboard_calls)
        self.assertNotIn(("restore", {"string": "saved"}), env.clipboard_calls)

    async def test_a_verified_paste_restores_the_clipboard(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        status = await app.paste("payload")
        self.assertIn("restored", status)
        self.assertEqual(
            env.clipboard_calls,
            [("save", None), ("write", ("text", "payload")), ("restore", {"string": "saved"})],
        )

    async def test_a_preexisting_value_proves_nothing_about_consumption(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        # the focused field already carried the payload before the paste, and
        # a busy app's consumption is still pending: no attributable transition
        env.paste_baselines = [(env.paste_focus_before, "payload")]
        status = await app.paste("payload")
        self.assertIn("could not be verified", status)
        self.assertNotIn(("restore", {"string": "saved"}), env.clipboard_calls)

    async def test_an_unreadable_baseline_read_proves_nothing_about_consumption(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        env.paste_baselines = [None, (env.paste_focus_before, "payload")]
        status = await app.paste("payload")
        self.assertIn("could not be verified", status)
        self.assertNotIn(("restore", {"string": "saved"}), env.clipboard_calls)

    async def test_a_valueless_baseline_proves_nothing_about_consumption(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        # the baseline read is unreadable, and the app stays busy afterwards
        env.paste_baselines = [None, (env.paste_focus_before, "payload")]
        status = await app.paste("payload")
        self.assertIn("could not be verified", status)
        self.assertNotIn(("restore", {"string": "saved"}), env.clipboard_calls)

    async def test_a_focus_move_proves_nothing_about_consumption(self) -> None:
        env = self.make_env()
        app = await env.get_app()
        # focus A holds "draft"; while cmd+v is queued the focus moves to B,
        # whose preexisting value already carries the payload - a false transition
        env.paste_focus_moved = True
        env.paste_value_after_move = "payload"
        status = await app.paste("payload")
        self.assertIn("could not be verified", status)
        self.assertNotIn(("restore", {"string": "saved"}), env.clipboard_calls)

    async def test_a_copy_during_the_baseline_read_aborts_the_paste(self) -> None:
        env = self.make_env()
        app = await env.get_app()

        def copying_during_baseline() -> None:
            # a user copy lands while the baseline read runs
            env.pasteboard_holds_payload = False

        env.paste_baseline_side_effect = copying_during_baseline
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.paste("payload")
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("clipboard changed during the paste", caught.exception.message)

    async def test_a_focus_move_onto_secure_during_the_baseline_read_aborts(self) -> None:
        env = self.make_env()
        app = await env.get_app()

        def focusing_secure_during_baseline() -> None:
            # the focus moves onto a password field while the baseline read runs
            env.secure_focus = True

        env.paste_baseline_side_effect = focusing_secure_during_baseline
        with self.assertRaises(errors.ComputerUseError) as caught:
            await app.paste("payload")
        self.assertIn(caught.exception.code, ("ACTION_UNSUPPORTED", "TRANSPORT_ERROR"))
        self.assertNotIn(("press_key", {"pid": env.pid, "key": "cmd+v"}), env.recorder.calls)


if __name__ == "__main__":
    unittest.main()
