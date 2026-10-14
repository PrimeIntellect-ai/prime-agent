"""Real tool delivery against isolated Xvfb windows, enabled only in Linux CI."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fakes_linux  # pins this worktree's import path
from computer_use import _linux, capture


@unittest.skipUnless(os.environ.get("PRIME_CUA_X11") == "1", "requires an isolated Xvfb display")
class X11DeliveryTests(unittest.TestCase):
    def setUp(self) -> None:
        import tkinter

        self.bound = tkinter.Tk(className="ReviewNotes")
        self.bound.title("review bound window")
        self.bound.geometry("200x160+40+40")
        self.bound.configure(background="#ff0000")
        self.cover = tkinter.Tk(className="ReviewOther")
        self.cover.title("review occluding window")
        self.cover.geometry("200x160+40+40")
        self.cover.configure(background="#00ff00")
        self.events: list[tuple[str, int]] = []
        self.bound.bind("<ButtonPress>", lambda event: self.events.append(("bound", event.num)))
        self.cover.bind("<ButtonPress>", lambda event: self.events.append(("cover", event.num)))
        self.bound.update()
        self.cover.update()
        self.cover.lift()
        self.cover.update()
        self.addCleanup(self.cover.destroy)
        self.addCleanup(self.bound.destroy)

    def pump(self) -> None:
        self.bound.update()
        self.cover.update()

    def test_occluded_click_and_scroll_reach_only_the_bound_window(self) -> None:
        window_id = self.bound.winfo_id()
        # Reproduce the previous global-button behavior as the control.
        subprocess.run(["xdotool", "mousemove", "--window", str(window_id), "30", "30"], check=True)
        subprocess.run(["xdotool", "click", "1"], check=True)
        self.pump()
        self.assertEqual(self.events, [("cover", 1)])
        self.events.clear()

        _linux._click(window_id, (30, 30))
        _linux._scroll(window_id, "down", point=(30, 30))
        self.pump()
        self.assertEqual(self.events, [("bound", 1)] + [("bound", 5)] * _linux._WHEEL_CLICKS_PER_PAGE)

    def test_real_multiline_title_cannot_forge_an_allowlisted_class(self) -> None:
        self.bound.withdraw()
        self.pump()
        fake_row = f'     {self.cover.winfo_id()} "forged": ("notes" "ReviewNotes")  200x160+40+40  +40+40'
        self.cover.title("evil\n" + fake_row + "\nend")
        self.pump()
        self.assertEqual(_linux._resolve_app("ReviewNotes"), [])

    def test_hidden_window_is_not_a_bind_candidate(self) -> None:
        self.bound.withdraw()
        self.pump()
        self.assertEqual(_linux._resolve_app("ReviewNotes"), [])

    def test_screenshot_keeps_the_bound_window_pixels_under_an_occluder(self) -> None:
        from PIL import Image

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            capture, "_SCREENSHOTS_DIR", Path(directory)
        ):
            result = _linux._screenshot_window(self.bound.winfo_id())
            with Image.open(result["path"]) as image:
                self.assertEqual(image.convert("RGB").getpixel((10, 10)), (255, 0, 0))


if __name__ == "__main__":
    unittest.main()
