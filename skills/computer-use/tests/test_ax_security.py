"""Regression tests for the review fixes in ax.py and the live AX seams.

Covers the AXValue unwrap (geometry is an opaque AXValueRef on macOS), the
per-reference messaging timeout, the observe deadline, the fail-closed live
focus read, and the settle fingerprint. Everything runs against fakes: no
display, TCC grant, real app, or live framework is touched.
"""

from __future__ import annotations

import time
import types
import unittest
from typing import Any
from unittest import mock

import fakes  # inserts the skill's src tree into sys.path
from computer_use import ax, errors


class FakeAXValueRef:
    """Stand-in for the opaque AXValueRef macOS returns for AXPosition/AXSize."""


class FakeAXApp:
    """A minimal fake AX application serving observe/fingerprint/focus reads."""

    def __init__(self) -> None:
        self.timeout_refs: list[Any] = []
        self.children = [FakeAXValueRef()]
        self.focused: Any = None
        self.focus_error = False
        self.position = FakeAXValueRef()

    def AXUIElementCreateApplication(self, pid: int) -> "FakeAXApp":
        return self

    def AXUIElementSetMessagingTimeout(self, element: Any, seconds: float) -> None:
        self.timeout_refs.append(element)

    def AXUIElementCopyAttributeValue(self, element: Any, attribute: str, unused: Any) -> Any:
        if attribute == "AXFocusedWindow":
            return (self.kAXErrorSuccess, self)
        if attribute == "AXChildren":
            return (self.kAXErrorSuccess, list(self.children))
        if attribute == "AXTitle":
            return (self.kAXErrorSuccess, "Main")
        if attribute == "AXRole":
            return (self.kAXErrorSuccess, "AXGroup")
        if attribute == "AXSubrole":
            return (self.kAXErrorSuccess, None)
        if attribute == "AXFocusedUIElement":
            if self.focus_error:
                return (-25204, None)  # kAXErrorCannotComplete
            return (self.kAXErrorSuccess, self.focused)
        if attribute == "AXPosition" or attribute == "AXSize":
            return (self.kAXErrorSuccess, self.position)
        if attribute == "_AXWindowID":
            return (self.kAXErrorSuccess, 7)
        return (self.kAXErrorSuccess, None)

    kAXErrorSuccess = 0


class FakeAxValueServices(FakeAXApp):
    """Fake services decoding the opaque geometry refs like pyobjc's manual binding."""

    kAXValueCGPointType = 1
    kAXValueCGSizeType = 2

    def AXValueGetValue(self, value: Any, value_type: int, unused: Any) -> Any:
        if value is self.position and value_type == self.kAXValueCGPointType:
            return (True, (100.0, 50.0))
        if value is self.position and value_type == self.kAXValueCGSizeType:
            return (True, (400.0, 300.0))
        return (False, None)


class PointUnwrapTests(unittest.TestCase):
    def test_point_unwraps_an_ax_value_ref(self) -> None:
        services = FakeAxValueServices()
        self.assertEqual(ax._point(services, services.position), (100.0, 50.0))

    def test_point_unwraps_the_size_kind_when_the_point_kind_refuses(self) -> None:
        class SizeOnlyServices(FakeAxValueServices):
            def AXValueGetValue(self, value: Any, value_type: int, unused: Any) -> Any:
                if value is self.position and value_type == self.kAXValueCGSizeType:
                    return (True, (120.0, 30.0))
                return (False, None)

        services = SizeOnlyServices()
        self.assertEqual(ax._point(services, services.position), (120.0, 30.0))

    def test_point_keeps_the_bridge_friendly_fallbacks(self) -> None:
        services = types.SimpleNamespace()
        self.assertEqual(ax._point(services, types.SimpleNamespace(x=1, y=2)), (1.0, 2.0))
        self.assertEqual(ax._point(services, {"x": 3, "y": 4}), (3.0, 4.0))
        self.assertEqual(ax._point(services, (5.0, 6.0)), (5.0, 6.0))
        self.assertIsNone(ax._point(services, "not geometry"))
        self.assertIsNone(ax._point(services, None))

    def test_point_tolerates_services_without_ax_value_support(self) -> None:
        services = types.SimpleNamespace()
        self.assertEqual(ax._point(services, (7.0, 8.0)), (7.0, 8.0))


class MessagingTimeoutTests(unittest.TestCase):
    def test_observe_bounds_the_window_and_child_refs_not_just_the_app(self) -> None:
        app = FakeAxValueServices()
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=app)):
            observation = ax._observe(4242)
        self.assertIs(observation.window_title, "Main")
        self.assertEqual(observation.window_id, 7)
        self.assertIn(app, app.timeout_refs)  # the app element itself
        self.assertIn(app.children[0], app.timeout_refs)  # the walked child ref

    def test_window_fingerprint_bounds_the_read(self) -> None:
        app = FakeAxValueServices()
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=app)):
            self.assertEqual(ax._window_fingerprint(4242)[:2], ("Main", 1))
        self.assertTrue(app.timeout_refs)


class ObserveDeadlineTests(unittest.TestCase):
    def test_walk_stops_at_the_deadline(self) -> None:
        services = types.SimpleNamespace(
            kAXErrorSuccess=0,
            AXUIElementCopyAttributeValue=lambda element, attribute, unused: (0, ["child"])
            if attribute == "AXChildren"
            else (-25212, None),
            AXUIElementSetMessagingTimeout=lambda element, seconds: None,
        )
        siblings: list[dict[str, Any]] = []
        refs: list[Any] = []
        deadline = time.monotonic() - 1  # already elapsed
        ax._walk(services, "root", 1, siblings, refs, deadline=deadline)
        self.assertEqual(siblings, [])
        self.assertEqual(refs, [])


class FocusedIsSecureTests(unittest.TestCase):
    def test_focus_read_failure_reports_none(self) -> None:
        app = FakeAxValueServices()
        app.focus_error = True
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=app)):
            self.assertIsNone(ax._focused_is_secure(4242))

    def test_successful_read_with_no_focus_reports_false(self) -> None:
        app = FakeAxValueServices()
        app.focused = None
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=app)):
            self.assertFalse(ax._focused_is_secure(4242))

    def test_secure_focus_reads_the_live_role_and_subrole(self) -> None:
        app = FakeAxValueServices()

        class SecureFocus:
            pass

        focus = SecureFocus()
        app.focused = focus
        calls: list[str] = []

        def copy(element: Any, attribute: str, unused: Any) -> Any:
            calls.append(attribute)
            if attribute == "AXFocusedUIElement":
                return (app.kAXErrorSuccess, focus)
            if attribute == "AXRole":
                return (app.kAXErrorSuccess, "AXTextField")
            if attribute == "AXSubrole":
                return (app.kAXErrorSuccess, "AXSecureTextField")
            return (app.kAXErrorSuccess, None)

        app.AXUIElementCopyAttributeValue = copy
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=app)):
            self.assertTrue(ax._focused_is_secure(4242))
        self.assertIn("AXSubrole", calls)


class IsSettablePlaceholderTests(unittest.TestCase):
    def test_is_settable_passes_the_out_parameter_placeholder(self) -> None:
        calls: list[int] = []

        def strict_is_settable(ref: Any, attribute: str, unused: Any) -> Any:
            calls.append(len([ref, attribute, unused]))
            return (0, True)

        services = types.SimpleNamespace(
            kAXErrorSuccess=0, AXUIElementIsAttributeSettable=strict_is_settable
        )
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=services)):
            self.assertTrue(ax._is_settable("ref", "AXValue"))
        self.assertEqual(calls, [3])  # (ref, attribute, placeholder)


class LiveIsSecureFailClosedTests(unittest.TestCase):
    def test_an_unreadable_live_field_reports_none(self) -> None:
        class FailingReads:
            def AXUIElementCopyAttributeValue(self, element, attribute, unused):
                raise RuntimeError("read failed")

        services = types.SimpleNamespace(kAXErrorSuccess=0)
        services.AXUIElementCopyAttributeValue = FailingReads().AXUIElementCopyAttributeValue
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=services)):
            self.assertIsNone(ax._live_is_secure("ref"))

    def test_a_secure_focus_value_is_never_read_for_the_fingerprint(self) -> None:
        read_attributes: list[str] = []

        class SecureFocus:
            pass

        class Services:
            kAXErrorSuccess = 0

            def AXUIElementSetMessagingTimeout(self, element, seconds):
                pass

            def AXUIElementCreateApplication(self, pid):
                return self

            def AXUIElementCopyAttributeValue(self, element, attribute, unused):
                read_attributes.append(attribute)
                if attribute == "AXFocusedWindow":
                    return (0, "window")
                if attribute == "AXFocusedUIElement":
                    return (0, SecureFocus())
                if attribute == "AXRole":
                    return (0, "AXTextField")
                if attribute == "AXSubrole":
                    return (0, "AXSecureTextField")
                raise AssertionError(f"AXValue was read on a secure field: {attribute}")

        services = Services()
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=services)):
            fingerprint = ax._window_fingerprint(4242)
        self.assertEqual(fingerprint, (None, 0, "AXTextField", "AXSecureTextField", ""))
        self.assertNotIn("AXValue", read_attributes)

    def test_a_described_field_with_an_unreadable_subrole_never_carries_a_value(self) -> None:
        class Services:
            kAXErrorSuccess = 0

            def AXUIElementSetMessagingTimeout(self, element, seconds):
                pass

            def AXUIElementCopyAttributeValue(self, element, attribute, unused):
                if attribute == "AXRole":
                    return (0, "AXTextField")
                if attribute == "AXSubrole":
                    return (-25212, None)  # the subrole read itself fails
                if attribute == "AXValue":
                    return (0, "hunter2")
                return (0, None)

        services = Services()
        described = ax._describe(services, "element")
        self.assertEqual(described["subrole"], "AXSecureTextField")  # fail closed: treated as secure
        self.assertIsNone(described["value"])  # the password never enters the tree


class ObservationBoundTests(unittest.TestCase):
    def test_window_title_is_capped_like_every_attribute(self) -> None:
        window = types.SimpleNamespace(role="AXWindow")
        services = types.SimpleNamespace(
            kAXErrorSuccess=0,
            AXUIElementCreateApplication=lambda pid: "app",
            AXUIElementCopyAttributeValue=lambda element, attribute, unused: (
                0,
                {
                    "AXFocusedWindow": window,
                    "AXTitle": "t" * 5000,
                    "AXRole": "AXGroup",
                    "AXChildren": [],
                    "AXPosition": None,
                    "AXSize": None,
                    "_AXWindowID": 3,
                    "AXSubrole": None,
                    "AXValue": None,
                    "AXDescription": None,
                    "AXPlaceholderValue": None,
                }[attribute],
            ),
            AXUIElementSetMessagingTimeout=lambda element, seconds: None,
        )
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=services)):
            observation = ax._observe(4242)
        self.assertEqual(len(observation.window_title), 2001)
        self.assertTrue(observation.window_title.endswith("…"))

    def test_action_names_are_bounded_in_count(self) -> None:
        services = types.SimpleNamespace(
            kAXErrorSuccess=0,
            AXUIElementCopyActions=lambda element, unused: (0, [f"AXAction{index}" for index in range(500)]),
        )
        actions = ax._actions(services, "element")
        self.assertEqual(len(actions), ax._MAX_ACTIONS)
        self.assertEqual(actions[0], "AXAction0")


class ShippedInstructionFilesTests(unittest.TestCase):
    def test_the_shipped_guides_are_keyed_by_their_bundle_ids(self) -> None:
        # the loader looks up {bundle_id}.md; the shipped files must match it
        self.assertTrue(ax._load_instructions("com.tinyspeck.slackmacgap"))
        self.assertTrue(ax._load_instructions("notion.id"))

    def test_display_name_keys_do_not_load_the_guides(self) -> None:
        # the pre-review slack.md / notion.md keys never resolve
        self.assertIsNone(ax._load_instructions("slack"))
        self.assertIsNone(ax._load_instructions("notion"))


class LiveIsSecureTests(unittest.TestCase):
    def test_live_is_secure_reads_the_live_subrole(self) -> None:
        app = FakeAxValueServices()

        def copy(element: Any, attribute: str, unused: Any) -> Any:
            if attribute == "AXRole":
                return (app.kAXErrorSuccess, "AXTextField")
            if attribute == "AXSubrole":
                return (app.kAXErrorSuccess, "AXSecureTextField")
            return (app.kAXErrorSuccess, None)

        app.AXUIElementCopyAttributeValue = copy
        with mock.patch.object(ax, "_require_mac", lambda: types.SimpleNamespace(app_services=app)):
            self.assertTrue(ax._live_is_secure("ref"))


if __name__ == "__main__":
    unittest.main()
