"""Pure fake tests for the Linux X11 backend (_linux.py).

Everything here runs on this mac without a display and without X11 tools:
subprocess calls are faked through fakes_linux, argv is asserted exactly,
and the golden xwininfo fixture is parsed offline. Live smokes are gated
behind PRIME_CUA_LIVE=1 plus a DISPLAY and the xdotool tool, so they never
run here.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fakes
import fakes_linux
from fakes_linux import X11Script, chain_tree, fake_x11, flat_tree, without_display, window_line
import computer_use
from computer_use import _compat, _linux, errors
from computer_use.errors import ComputerUseError

LIVE = (
    os.environ.get("PRIME_CUA_LIVE") == "1"
    and bool(os.environ.get("DISPLAY"))
    and shutil.which("xdotool") is not None
)
LIVE_SKIP = "live smoke; set PRIME_CUA_LIVE=1 with DISPLAY and xdotool to enable"

SEAMS = (
    "_click",
    "_drag",
    "_focused_is_secure",
    "_list_apps",
    "_live_fingerprint",
    "_observe",
    "_press_key",
    "_resolve_app",
    "_screenshot_window",
    "_scroll",
    "_search_windows",
    "_type_text",
)


class ModuleSurfaceTests(unittest.TestCase):
    def test_module_imports_and_exposes_seams(self) -> None:
        self.assertEqual(_linux.__name__, "computer_use._linux")
        for name in SEAMS:
            with self.subTest(seam=name):
                self.assertTrue(callable(getattr(_linux, name, None)))

    def test_require_linux_raises_off_linux(self) -> None:
        with self.assertRaises(ComputerUseError) as caught:
            _compat._require_linux()
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("xdotool", caught.exception.message)

    def test_require_linux_loads_module_when_backend_is_linux(self) -> None:
        with mock.patch.object(_compat, "_backend", return_value="linux"):
            loaded = _compat._require_linux()
        self.assertIs(loaded, _linux)
        for name in SEAMS:
            with self.subTest(seam=name):
                self.assertTrue(callable(getattr(loaded, name, None)))


class TreeParseTests(unittest.TestCase):
    def test_golden_tree_parses_exactly(self) -> None:
        windows = _linux._parse_tree(fakes_linux.XWININFO_ROOT_TREE)
        self.assertEqual(
            windows,
            [
                _linux._Window(104, 0, "Notes: draft (v2)", "notes", "Notes", 800, 600, 100, 80, 100, 80),
                _linux._Window(105, 1, None, "notes", "Notes", 700, 500, 10, 30, 110, 110),
                _linux._Window(220, 0, "Slack - engineering", "slack", "Slack", 1024, 768, 1920, 0, 1920, 0),
                _linux._Window(221, 1, None, "slack", "Slack", 1000, 700, 12, 40, 1932, 40),
                _linux._Window(222, 2, "terminal", "xterm", "XTerm", 640, 480, -10, -20, 1922, 20),
                _linux._Window(230, 0, None, None, None, 1, 1, 0, 0, 0, 0),
                _linux._Window(240, 0, 'Ends: ("', "weird", "Weird", 300, 200, 5, 5, 5, 5),
                _linux._Window(250, 0, None, "sh", "Sh", None, None, None, None, None, None),
            ],
        )

    def test_unsupported_encoding_name_keeps_the_window(self) -> None:
        line = window_line(330, instance="enc", res_class="Enc")
        line = line.replace(" (has no name):", " (name in unsupported encoding ATOM 0x12):")
        parsed = _linux._parse_tree(line)
        self.assertEqual(
            parsed,
            [_linux._Window(330, 0, None, "enc", "Enc", 10, 10, 0, 0, 0, 0)],
        )

    def test_generated_tree_matches_golden_shape(self) -> None:
        windows = _linux._parse_tree(chain_tree(900, 2))
        self.assertEqual(
            [window.depth for window in windows], [0, 1, 2]
        )
        self.assertEqual([window.title for window in windows], [None, "node 1", "node 2"])


class ObserveTests(unittest.TestCase):
    def test_observe_builds_an_ax_compatible_snapshot(self) -> None:
        script = X11Script()
        script.xwininfo_tree(fakes_linux.XWININFO_ROOT_TREE)
        with fake_x11(script):
            observation = _linux._observe(220)
        xterm_element = {
            "role": "window",
            "subrole": "XTerm",
            "title": "terminal",
            "value": None,
            "description": None,
            "placeholder": None,
            "actions": [],
            "position": [1922.0, 20.0],
            "size": [640.0, 480.0],
            "children": [],
        }
        self.assertEqual(
            observation,
            _linux.Observation(
                window_title="Slack - engineering",
                tree=[
                    {
                        "role": "window",
                        "subrole": "Slack",
                        "title": None,
                        "value": None,
                        "description": None,
                        "placeholder": None,
                        "actions": [],
                        "position": [1932.0, 40.0],
                        "size": [1000.0, 700.0],
                        "children": [xterm_element],
                    }
                ],
                refs=[221, 222],
                window_rect=(1920.0, 0.0, 1024.0, 768.0),
                focused_index=None,
                window_id=220,
            ),
        )

    def test_observed_tree_renders_through_the_diff_engine(self) -> None:
        from computer_use import diff

        script = X11Script()
        script.xwininfo_tree(fakes_linux.XWININFO_ROOT_TREE)
        with fake_x11(script):
            observation = _linux._observe(220)
        self.assertEqual(
            diff._serialize(observation.tree),
            [
                "[0] window (Slack) @ (1932, 40) 1000x700",
                "  [1] window (XTerm) 'terminal' @ (1922, 20) 640x480",
            ],
        )

    def test_observe_uses_the_root_tree_argv(self) -> None:
        script = X11Script()
        script.xwininfo_tree(fakes_linux.XWININFO_ROOT_TREE)
        with fake_x11(script):
            _linux._observe(104)
        self.assertEqual(
            script.calls,
            [["/usr/bin/xwininfo", "-root", "-tree", "-int"]],
        )

    def test_observe_missing_window_raises_app_not_running(self) -> None:
        script = X11Script()
        script.xwininfo_tree(fakes_linux.XWININFO_ROOT_TREE)
        with fake_x11(script):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._observe(99999)
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")

    def test_observe_never_finds_the_root_window(self) -> None:
        script = X11Script()
        script.xwininfo_tree(fakes_linux.XWININFO_ROOT_TREE)
        with fake_x11(script):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._observe(63)
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")

    def test_observe_caps_depth_like_the_mac_walk(self) -> None:
        script = X11Script()
        script.xwininfo_tree(chain_tree(900, 20))
        with fake_x11(script):
            observation = _linux._observe(900)
        self.assertEqual(observation.refs, [901 + index for index in range(_linux._MAX_DEPTH)])

    def test_observe_caps_elements_like_the_mac_walk(self) -> None:
        script = X11Script()
        script.xwininfo_tree(flat_tree(800, 1600))
        with fake_x11(script):
            observation = _linux._observe(800)
        self.assertEqual(len(observation.refs), _linux._MAX_ELEMENTS)

    def test_observe_xwininfo_failure_raises_transport_error(self) -> None:
        script = X11Script()
        script.on("-root", "-tree", "-int", returncode=1, stderr=b"xwininfo: Can't open display :42\n")
        with fake_x11(script):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._observe(104)
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("exit code 1", caught.exception.message)


class DiscoveryTests(unittest.TestCase):
    def test_search_windows_matches_class_and_parses_ids(self) -> None:
        script = X11Script()
        script.on("search", "--onlyvisible", "--class", stdout=b"220\n221\n")
        with fake_x11(script):
            found = _linux._search_windows("slack")
        self.assertEqual(found, [220, 221])
        self.assertEqual(
            script.calls, [["/usr/bin/xdotool", "search", "--onlyvisible", "--class", "slack"]]
        )

    def test_search_windows_by_name_without_onlyvisible(self) -> None:
        script = X11Script()
        with fake_x11(script):
            _linux._search_windows("Slack - engineering", by="name", only_visible=False)
        self.assertEqual(script.calls, [["/usr/bin/xdotool", "search", "--name", "Slack - engineering"]])

    def test_search_windows_no_match_reads_empty(self) -> None:
        script = X11Script()
        script.on("search", returncode=1)
        with fake_x11(script):
            self.assertEqual(_linux._search_windows("nothing"), [])

    def test_search_windows_failure_raises_transport_error(self) -> None:
        script = X11Script()
        script.on("search", returncode=1, stderr=b"Error: Can't open display: (null)\n")
        with fake_x11(script):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._search_windows("slack")
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("Can't open display", caught.exception.message)

    def test_list_apps_dedups_classes_in_first_seen_order(self) -> None:
        script = X11Script()
        script.xwininfo_tree(fakes_linux.XWININFO_ROOT_TREE)
        with fake_x11(script):
            apps = _linux._list_apps()
        self.assertEqual(
            apps,
            [
                {"id": "Notes", "name": "Notes", "running": True},
                {"id": "Slack", "name": "Slack", "running": True},
                {"id": "XTerm", "name": "XTerm", "running": True},
                {"id": "Weird", "name": "Weird", "running": True},
                {"id": "Sh", "name": "Sh", "running": True},
            ],
        )

    def test_resolve_app_matches_wm_class_casefolded(self) -> None:
        script = X11Script()
        script.xwininfo_tree(fakes_linux.XWININFO_ROOT_TREE)
        with fake_x11(script):
            found = _linux._resolve_app("nOtEs")
        self.assertEqual([window.window_id for window in found], [104, 105])
        self.assertEqual({window.wm_class for window in found}, {"Notes"})

    def test_resolve_app_dict_spec_and_no_match(self) -> None:
        script = X11Script()
        script.xwininfo_tree(fakes_linux.XWININFO_ROOT_TREE)
        with fake_x11(script):
            self.assertEqual(_linux._resolve_app({"bundle_id": "Slack"})[0].window_id, 220)
            self.assertEqual(_linux._resolve_app("firefox"), [])

    def test_resolve_app_rejects_unresolvable_specs(self) -> None:
        for bad in ("", "   ", {"path": "/usr/bin/firefox"}, {"weird": "x"}, 5):
            with self.subTest(spec=bad):
                with self.assertRaises(ComputerUseError) as caught:
                    _linux._resolve_app(bad)
                self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")


class InputArgvTests(unittest.TestCase):
    def test_click_moves_then_clicks_with_rounded_ints(self) -> None:
        script = X11Script()
        with fake_x11(script):
            _linux._click(220, (10.6, 20.4), count=1)
        self.assertEqual(
            script.calls,
            [
                ["/usr/bin/xdotool", "mousemove", "--window", "220", "11", "20"],
                ["/usr/bin/xdotool", "click", "1"],
            ],
        )

    def test_click_repeats_and_buttons(self) -> None:
        script = X11Script()
        with fake_x11(script):
            _linux._click(220, (1, 2), button="left", count=3)
            _linux._click(220, (1, 2), button="middle")
            _linux._click(220, (1, 2), button="right", count=2)
        self.assertEqual(
            script.calls,
            [
                ["/usr/bin/xdotool", "mousemove", "--window", "220", "1", "2"],
                ["/usr/bin/xdotool", "click", "--repeat", "3", "1"],
                ["/usr/bin/xdotool", "mousemove", "--window", "220", "1", "2"],
                ["/usr/bin/xdotool", "click", "2"],
                ["/usr/bin/xdotool", "mousemove", "--window", "220", "1", "2"],
                ["/usr/bin/xdotool", "click", "--repeat", "2", "3"],
            ],
        )

    def test_click_rejects_bad_button_count_and_point(self) -> None:
        for kwargs in (
            {"button": "side"},
            {"count": 0},
            {"count": True},
            {"point": (1,)},
            {"point": (1, "2")},
            {"point": (1, True)},
        ):
            with self.subTest(kwargs=kwargs):
                with fake_x11(X11Script()):
                    with self.assertRaises(ComputerUseError) as caught:
                        _linux._click(220, kwargs.get("point", (1, 2)), button=kwargs.get("button", "left"), count=kwargs.get("count", 1))
                self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    def test_drag_presses_moves_and_releases(self) -> None:
        script = X11Script()
        with fake_x11(script):
            _linux._drag(220, (1, 2), (30.6, 40.7))
        self.assertEqual(
            script.calls,
            [
                ["/usr/bin/xdotool", "mousemove", "--window", "220", "1", "2"],
                ["/usr/bin/xdotool", "mousedown", "1"],
                ["/usr/bin/xdotool", "mousemove", "--window", "220", "31", "41"],
                ["/usr/bin/xdotool", "mouseup", "1"],
            ],
        )

    def test_scroll_moves_then_repeats_wheel_clicks(self) -> None:
        script = X11Script()
        with fake_x11(script):
            _linux._scroll(220, "down", pages=2, point=(50, 60))
            _linux._scroll(220, "up")
        expected_click = [
            "/usr/bin/xdotool",
            "click",
            "--repeat",
            str(2 * _linux._WHEEL_CLICKS_PER_PAGE),
            "--delay",
            str(_linux._WHEEL_REPEAT_DELAY_MS),
            "5",
        ]
        self.assertEqual(
            script.calls,
            [
                ["/usr/bin/xdotool", "mousemove", "--window", "220", "50", "60"],
                expected_click,
                [
                    "/usr/bin/xdotool",
                    "click",
                    "--repeat",
                    str(_linux._WHEEL_CLICKS_PER_PAGE),
                    "--delay",
                    str(_linux._WHEEL_REPEAT_DELAY_MS),
                    "4",
                ],
            ],
        )

    def test_scroll_directions_and_rejections(self) -> None:
        script = X11Script()
        with fake_x11(script):
            _linux._scroll(220, "left", point=(0, 0))
            _linux._scroll(220, "right", point=(0, 0))
        self.assertEqual([argv[-1] for argv in script.argvs("click")], ["6", "7"])
        with fake_x11(X11Script()):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._scroll(220, "sideways")
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
            with self.assertRaises(ComputerUseError) as caught:
                _linux._scroll(220, "up", pages=0)
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    def test_press_key_translates_chords_to_keysyms(self) -> None:
        cases = {
            "cmd+shift+f": "shift+super+f",
            "ctrl+alt+t": "alt+ctrl+t",
            "Return": "Return",
            "enter": "Return",
            "space": "space",
            "Delete": "BackSpace",
            "ctrl+delete": "ctrl+BackSpace",
            "ForwardDelete": "Delete",
            "PageUp": "Prior",
            "shift+pagedown": "shift+Next",
            "alt+F5": "alt+F5",
            "super+c": "super+c",
        }
        for chord, keysym in cases.items():
            with self.subTest(chord=chord):
                script = X11Script()
                with fake_x11(script):
                    _linux._press_key(220, chord)
                self.assertEqual(
                    script.calls,
                    [["/usr/bin/xdotool", "key", "--window", "220", keysym]],
                )

    def test_press_key_rejects_bad_chords(self) -> None:
        for bad in ("", "cmd+shift", "hyper+x", "F13", "ctrl+notakey"):
            with self.subTest(key=bad):
                with fake_x11(X11Script()):
                    with self.assertRaises(ComputerUseError) as caught:
                        _linux._press_key(220, bad)
                self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    def test_type_text_uses_window_and_delay(self) -> None:
        script = X11Script()
        with fake_x11(script):
            _linux._type_text(220, "h\u00e9llo")
            _linux._type_text(220, "")
        self.assertEqual(
            script.calls,
            [
                [
                    "/usr/bin/xdotool",
                    "type",
                    "--window",
                    "220",
                    "--delay",
                    str(_linux._TYPE_DELAY_MS),
                    "h\u00e9llo",
                ]
            ],
        )
        with fake_x11(X11Script()):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._type_text(220, 42)
            self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    def test_failed_xdotool_input_raises_injection_failed_with_capped_stderr(self) -> None:
        script = X11Script()
        script.on("key", returncode=1, stderr=b"x" * 500)
        with fake_x11(script):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._press_key(220, "Return")
        self.assertEqual(caught.exception.code, "INJECTION_FAILED")
        self.assertIn("key failed with exit code 1", caught.exception.message)
        self.assertIn("x" * _linux._ERROR_LIMIT, caught.exception.message)
        self.assertNotIn("x" * (_linux._ERROR_LIMIT + 1), caught.exception.message)


class ErrorTaxonomyTests(unittest.TestCase):
    def test_missing_display_is_transport_error(self) -> None:
        for seam in (
            lambda: _linux._click(220, (1, 2)),
            lambda: _linux._observe(220),
            lambda: _linux._screenshot_window(220),
            lambda: _linux._list_apps(),
        ):
            with self.subTest(seam=seam):
                with without_display():
                    with self.assertRaises(ComputerUseError) as caught:
                        seam()
                    self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
                    self.assertIn("DISPLAY", caught.exception.message)

    def test_missing_tool_is_transport_error_naming_the_tool(self) -> None:
        script = X11Script()
        with fake_x11(script, tools=("xwininfo", "maim", "scrot")):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._click(220, (1, 2))
            self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
            self.assertIn("xdotool", caught.exception.message)

    def test_timeout_and_oserror_are_transport_errors(self) -> None:
        for error in (
            subprocess.TimeoutExpired(cmd=["xdotool"], timeout=10),
            OSError("No such file or directory"),
        ):
            with self.subTest(error=type(error).__name__):
                script = X11Script()
                script.on("mousemove", error=error)
                with fake_x11(script):
                    with self.assertRaises(ComputerUseError) as caught:
                        _linux._click(220, (1, 2))
                self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")

    def test_bad_window_id_is_invalid_argument(self) -> None:
        for bad in ("220", 22.5, True, None):
            with self.subTest(window_id=bad):
                with fake_x11(X11Script()):
                    with self.assertRaises(ComputerUseError) as caught:
                        _linux._click(bad, (1, 2))
                self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")


class FingerprintTests(unittest.TestCase):
    def test_live_fingerprint_reads_the_title(self) -> None:
        script = X11Script()
        script.on("getwindowname", stdout="Main \u2014 Doc\n".encode("utf-8"))
        with fake_x11(script):
            self.assertEqual(_linux._live_fingerprint(220), ("window", "Main \u2014 Doc"))
        self.assertEqual(script.calls, [["/usr/bin/xdotool", "getwindowname", "220"]])

    def test_live_fingerprint_unreadable_title_reads_none(self) -> None:
        script = X11Script()
        script.on("getwindowname", returncode=1, stderr=b"xdo error\n")
        with fake_x11(script):
            self.assertEqual(_linux._live_fingerprint(220), ("window", None))
        script = X11Script()
        with fake_x11(script):
            self.assertEqual(_linux._live_fingerprint(220), ("window", None))

    def test_focused_is_secure_is_always_unknown(self) -> None:
        with fake_x11(X11Script()):
            self.assertIsNone(_linux._focused_is_secure(220))


class CaptureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.shots_dir = Path(self.tmp.name) / "shots"
        patcher = mock.patch.object(_linux.capture, "_SCREENSHOTS_DIR", self.shots_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_maim_captures_the_bound_window(self) -> None:
        script = X11Script()
        script.on("-i", png=(640, 480))
        with fake_x11(script):
            result = _linux._screenshot_window(220)
        argv = script.calls[0]
        self.assertEqual(argv[:3], ["/usr/bin/maim", "-i", "220"])
        self.assertEqual(Path(argv[3]), self.shots_dir / Path(argv[3]).name)
        self.assertEqual(result["path"], argv[3])
        self.assertEqual(result["width"], 640)
        self.assertEqual(result["height"], 480)
        self.assertEqual(result, {"path": argv[3], "width": 640, "height": 480})

    def test_maim_failure_falls_back_to_scrot(self) -> None:
        script = X11Script()
        script.on("-i", returncode=1, stderr=b"maim: failed to take screenshot")
        script.on("-u", png=(400, 300))
        with fake_x11(script):
            result = _linux._screenshot_window(220)
        self.assertEqual(script.calls[0][:2], ["/usr/bin/maim", "-i"])
        self.assertEqual(script.calls[1][:3], ["/usr/bin/scrot", "-u", "-o"])
        self.assertEqual(result["width"], 400)
        self.assertEqual(result["height"], 300)

    def test_missing_maim_uses_scrot_directly(self) -> None:
        script = X11Script()
        script.on("-u", png=(100, 100))
        with fake_x11(script, tools=("xdotool", "xwininfo", "scrot")):
            result = _linux._screenshot_window(220)
        self.assertEqual(len(script.calls), 1)
        self.assertEqual(script.calls[0][:3], ["/usr/bin/scrot", "-u", "-o"])
        self.assertEqual(result["width"], 100)

    def test_both_capture_tools_missing_raises(self) -> None:
        with fake_x11(X11Script(), tools=("xdotool", "xwininfo")):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._screenshot_window(220)
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("maim", caught.exception.message)
        self.assertIn("scrot", caught.exception.message)

    def test_every_attempt_failing_raises_with_the_reasons(self) -> None:
        script = X11Script()
        script.on("-i", returncode=1, stderr=b"maim: window gone")
        script.on("-u", returncode=1, stderr=b"giblib error: cannot open X display")
        with fake_x11(script):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._screenshot_window(220)
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("maim failed with exit code 1", caught.exception.message)
        self.assertIn("scrot failed with exit code 1", caught.exception.message)

    def test_invalid_png_output_falls_back_then_raises(self) -> None:
        script = X11Script()
        script.on("-i")
        with fake_x11(script, tools=("xdotool", "xwininfo", "maim")):
            with self.assertRaises(ComputerUseError) as caught:
                _linux._screenshot_window(220)
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertIn("maim", caught.exception.message)

    def test_bad_window_id_is_invalid_argument(self) -> None:
        for bad in ("220", 22.5, True):
            with self.subTest(window_id=bad):
                with fake_x11(X11Script()):
                    with self.assertRaises(ComputerUseError) as caught:
                        _linux._screenshot_window(bad)
                self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")


class AppLinuxDispatchTests(unittest.TestCase):
    """End-to-end App-layer linux tests: the dispatch reaches the real _linux backend."""

    def bind_notes(self, script: fakes_linux.X11Script):
        import asyncio

        import computer_use

        return asyncio.run(computer_use.get_app("notes"))

    def assert_action_event(self, event: dict, expected: dict) -> None:
        """Assert one computer_use_action event, ignoring the elapsed duration."""
        self.assertEqual(event["name"], "computer_use_action")
        properties = event["properties"]
        self.assertIsInstance(properties.pop("duration_ms"), int)
        self.assertEqual(properties, expected)

    def test_get_app_binds_the_topmost_window_and_observes(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = asyncio.run(computer_use.get_app("notes"))
            self.assertEqual(app.bundle_id, "Notes")
            self.assertEqual(app.name, "Notes")
            self.assertEqual(app.pid, 104)
            self.assertIn("window 'Notes: draft (v2)'", app.state)
            self.assertIn("[0] window (Notes) @ (110, 110) 700x500", app.state)
            again = asyncio.run(computer_use.get_app("notes"))
        self.assertIs(again, app)

    def test_get_app_binds_one_window_of_a_multiwindow_app(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment():
            app = asyncio.run(computer_use.get_app("slack"))
        self.assertEqual(app.pid, 220)
        self.assertEqual(app.bundle_id, "Slack")

    def test_get_app_gates_the_wm_class(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment(allowed=()):
            with self.assertRaises(ComputerUseError) as caught:
                asyncio.run(computer_use.get_app("notes"))
            self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
        with fakes_linux.linux_app_environment(blocked=("Notes",)):
            with self.assertRaises(ComputerUseError) as caught:
                asyncio.run(computer_use.get_app("notes"))
            self.assertEqual(caught.exception.code, "APP_NOT_ALLOWED")
            self.assertIn("blocked list", caught.exception.message)

    def test_get_app_not_running_on_linux(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment():
            with self.assertRaises(ComputerUseError) as caught:
                asyncio.run(computer_use.get_app("firefox"))
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")
        self.assertIn("linux desktop", caught.exception.message)

    def test_get_app_rejects_unresolvable_specs(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment():
            with self.assertRaises(ComputerUseError) as caught:
                asyncio.run(computer_use.get_app({"path": "/usr/bin/firefox"}))
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    def test_click_element_translates_to_a_window_relative_center(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            asyncio.run(app.click(0))
        self.assertEqual(
            script.tool_calls("xdotool"),
            [
                ["/usr/bin/xdotool", "getwindowname", "105"],
                ["/usr/bin/xdotool", "mousemove", "--window", "104", "360", "280"],
                ["/usr/bin/xdotool", "click", "1"],
            ],
        )

    def test_click_tuple_stays_window_relative(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            asyncio.run(app.click((10, 20), button="right", count=2))
        self.assertEqual(
            script.tool_calls("xdotool"),
            [
                ["/usr/bin/xdotool", "mousemove", "--window", "104", "10", "20"],
                ["/usr/bin/xdotool", "click", "--repeat", "2", "3"],
            ],
        )

    def test_click_outside_the_observed_window_is_rejected(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            with self.assertRaises(ComputerUseError) as caught:
                asyncio.run(app.click((5000, 5)))
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")
        self.assertIn("outside the observed window", caught.exception.message)

    def test_drag_scroll_keys_and_type_dispatch_to_linux(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            asyncio.run(app.drag((1, 2), (3, 4)))
            asyncio.run(app.scroll(0, "down", pages=2))
            asyncio.run(app.press_key("cmd+s"))
            asyncio.run(app.type_text("hello there"))
        self.assertEqual(
            script.tool_calls("xdotool"),
            [
                ["/usr/bin/xdotool", "mousemove", "--window", "104", "1", "2"],
                ["/usr/bin/xdotool", "mousedown", "1"],
                ["/usr/bin/xdotool", "mousemove", "--window", "104", "3", "4"],
                ["/usr/bin/xdotool", "mouseup", "1"],
                ["/usr/bin/xdotool", "getwindowname", "105"],
                ["/usr/bin/xdotool", "mousemove", "--window", "104", "360", "280"],
                ["/usr/bin/xdotool", "click", "--repeat", "20", "--delay", "50", "5"],
                ["/usr/bin/xdotool", "key", "--window", "104", "super+s"],
                ["/usr/bin/xdotool", "type", "--window", "104", "--delay", "12", "hello there"],
            ],
        )

    def test_element_stale_when_the_live_title_changes(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            script.on("getwindowname", stdout=b"renamed\n")
            with self.assertRaises(ComputerUseError) as caught:
                asyncio.run(app.click(0))
        self.assertEqual(caught.exception.code, "ELEMENT_STALE")

    def test_guard_rejects_a_gone_window(self) -> None:
        import asyncio

        import computer_use

        gone_tree = fakes_linux.window_line(
            220, title="Slack - engineering", instance="slack", res_class="Slack",
            width=1024, height=768, rel_x=0, rel_y=0, abs_x=0, abs_y=0,
        )
        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            script.xwininfo_tree(gone_tree)
            with self.assertRaises(ComputerUseError) as caught:
                asyncio.run(app.click((1, 1)))
        self.assertEqual(caught.exception.code, "APP_NOT_RUNNING")

    def test_screenshot_dispatches_to_maim(self) -> None:
        import asyncio

        import computer_use

        with tempfile.TemporaryDirectory() as tmp:
            shots_dir = Path(tmp) / "shots"
            with mock.patch.object(_linux.capture, "_SCREENSHOTS_DIR", shots_dir):
                with fakes_linux.linux_app_environment() as script:
                    script.on("-i", png=(800, 600))
                    app = self.bind_notes(script)
                    result = asyncio.run(app.get_screenshot(attach=False))
        self.assertEqual(script.tool_calls("maim"), [["/usr/bin/maim", "-i", "104", result["path"]]])
        self.assertEqual(result["width"], 800)
        self.assertEqual(result["height"], 600)

    def test_unsupported_actions_raise_with_a_linux_gap_and_telemetry(self) -> None:
        import asyncio

        import computer_use

        calls = {
            "paste": lambda app: app.paste("secret"),
            "set_value": lambda app: app.set_value(0, "value"),
            "select_text": lambda app: app.select_text(0, "value"),
            "secondary": lambda app: app.perform_secondary_action(0, "AXPress"),
        }
        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            for action, call in calls.items():
                with fakes.telemetry_recorder() as recorder:
                    with self.subTest(action=action):
                        with self.assertRaises(ComputerUseError) as caught:
                            asyncio.run(call(app))
                        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
                        self.assertIn("not available on the Linux X11 backend", caught.exception.message)
                        self.assert_action_event(
                            recorder.events[-1],
                            {"action": action, "outcome": "error", "error_code": "ACTION_UNSUPPORTED"},
                        )

    def test_activate_on_linux_raises_action_unsupported(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            with fakes.telemetry_recorder() as recorder:
                with self.assertRaises(ComputerUseError) as caught:
                    asyncio.run(app.activate())
            self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
            self.assertIn("focus control is not available on the linux X11 backend yet", caught.exception.message)
            self.assertIn("keyboard flows that need app focus are unsupported there", caught.exception.message)
            self.assert_action_event(
                recorder.events[-1],
                {"action": "activate", "outcome": "error", "error_code": "ACTION_UNSUPPORTED"},
            )

    def test_is_frontmost_on_linux_raises_action_unsupported(self) -> None:
        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            with self.assertRaises(ComputerUseError) as caught:
                app.is_frontmost()
            self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
            self.assertIn("focus control is not available on the linux X11 backend yet", caught.exception.message)

    def test_get_text_regions_on_linux_names_the_gap(self) -> None:
        import asyncio

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            with self.assertRaises(ComputerUseError) as caught:
                asyncio.run(app.get_text_regions())
        self.assertEqual(caught.exception.code, "ACTION_UNSUPPORTED")
        self.assertIn("not available on the Linux X11 backend yet", caught.exception.message)
        self.assertIn("get_ax_state", caught.exception.message)

    def test_action_telemetry_flows_on_the_linux_path(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            with fakes.telemetry_recorder() as recorder:
                asyncio.run(app.click(0))
            self.assert_action_event(recorder.events[-1], {"action": "click", "outcome": "ok"})

    def test_get_ax_state_diffs_on_the_linux_path(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            app = self.bind_notes(script)
            second = asyncio.run(app.get_ax_state())
        self.assertEqual(second, "(no changes since the previous observation)")

    def test_list_apps_permissions_and_state_report_linux(self) -> None:
        import asyncio

        import computer_use

        with fakes_linux.linux_app_environment() as script:
            apps = asyncio.run(computer_use.list_apps())
            status = asyncio.run(computer_use.permissions_status())
            state = asyncio.run(computer_use.get_state(emit=False))
        self.assertEqual(apps[0], {"id": "Notes", "name": "Notes", "running": True})
        self.assertEqual(status["accessibility"], "unknown")
        self.assertEqual(status["screen_recording"], "unknown")
        self.assertIn("Linux", status["help"][0])
        self.assertEqual(state["platform"], "linux")
        self.assertEqual(state["allowlist"]["allowed"], ["Notes", "Slack"])
        self.assertEqual(state["permissions"]["accessibility"], "unknown")


@unittest.skipUnless(LIVE, LIVE_SKIP)
class LiveLinuxSmokes(unittest.TestCase):
    def test_require_linux_module_and_seams(self) -> None:
        loaded = _compat._require_linux()
        for name in SEAMS:
            with self.subTest(seam=name):
                self.assertTrue(callable(getattr(loaded, name, None)))

    def test_list_apps_shape(self) -> None:
        apps = _linux._list_apps()
        for app in apps:
            self.assertEqual(sorted(app), ["id", "name", "running"])
            self.assertTrue(app["running"])


if __name__ == "__main__":
    unittest.main()
