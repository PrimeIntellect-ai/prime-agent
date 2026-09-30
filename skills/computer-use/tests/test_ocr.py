"""Tests for the Vision OCR surface with a fake request runner.

The runner is patched with canned observations, so nothing here needs macOS
frameworks, a display, or a capture; the PRIME_CUA_LIVE=1 smoke runs real
recognition over a PNG built by hand with zlib and struct (no PIL).
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import struct
import subprocess
import tempfile
import types
import unittest
import zlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from computer_use import capture, errors, ocr

_FRAMEWORKS = (types.ModuleType("Quartz"), types.ModuleType("Vision"))

LIVE = os.environ.get("PRIME_CUA_LIVE") == "1"
VISION_INSTALLED = importlib.util.find_spec("Vision") is not None
SKIP_REASON = "live OCR smoke; set PRIME_CUA_LIVE=1 and install pyobjc-framework-Vision to enable"


@contextlib.contextmanager
def fake_runner(
    result: list[dict[str, Any]] | Exception,
) -> Iterator[list[tuple[str, Any, Any]]]:
    """Patch the request runner with a canned result or failure, recording its calls."""
    calls: list[tuple[str, Any, Any]] = []
    original = ocr._recognize

    def runner(path: str, quartz: Any, vision: Any) -> list[dict[str, Any]]:
        calls.append((path, quartz, vision))
        if isinstance(result, Exception):
            raise result
        return result

    ocr._recognize = runner
    try:
        yield calls
    finally:
        ocr._recognize = original


class GetTextRegionsTests(unittest.IsolatedAsyncioTestCase):
    async def test_converts_vision_bbox_to_normalized_top_left_region(self) -> None:
        observation = {"text": "Hello", "confidence": 0.875, "bbox": (0.25, 0.5, 0.5, 0.2)}
        with fake_runner([observation]) as calls:
            regions = await ocr._get_text_regions("shot.png", frameworks=_FRAMEWORKS)
        self.assertEqual(
            regions,
            [{"text": "Hello", "confidence": 0.875, "x": 0.25, "y": 0.3, "width": 0.5, "height": 0.2}],
        )
        self.assertEqual(calls[0][0], "shot.png")
        self.assertIs(calls[0][1], _FRAMEWORKS[0])
        self.assertIs(calls[0][2], _FRAMEWORKS[1])

    async def test_clamps_coordinates_into_the_image(self) -> None:
        observation = {"text": "edge", "confidence": 0.5, "bbox": (0.9, 0.9, 0.2, 0.2)}
        with fake_runner([observation]):
            regions = await ocr._get_text_regions("shot.png", frameworks=_FRAMEWORKS)
        self.assertEqual(
            regions,
            [{"text": "edge", "confidence": 0.5, "x": 0.9, "y": 0.0, "width": 0.2, "height": 0.2}],
        )

    async def test_sorts_top_to_bottom_then_left_to_right(self) -> None:
        observations = [
            {"text": "middle", "confidence": 1.0, "bbox": (0.3, 0.4, 0.4, 0.1)},
            {"text": "high-right", "confidence": 1.0, "bbox": (0.6, 0.8, 0.2, 0.05)},
            {"text": "bottom", "confidence": 1.0, "bbox": (0.05, 0.1, 0.3, 0.05)},
            {"text": "high-left", "confidence": 1.0, "bbox": (0.1, 0.8, 0.2, 0.05)},
        ]
        with fake_runner(observations):
            regions = await ocr._get_text_regions("shot.png", frameworks=_FRAMEWORKS)
        self.assertEqual(
            [region["text"] for region in regions],
            ["high-left", "high-right", "middle", "bottom"],
        )

    async def test_caps_regions_at_400(self) -> None:
        observations = [
            {"text": f"t{index}", "confidence": 1.0, "bbox": (index / 1000.0, 0.0, 0.05, 0.001)}
            for index in range(450)
        ]
        with fake_runner(observations):
            regions = await ocr._get_text_regions("shot.png", frameworks=_FRAMEWORKS)
        self.assertEqual(
            regions,
            [
                {
                    "text": f"t{index}",
                    "confidence": 1.0,
                    "x": index / 1000.0,
                    "y": 1.0 - 0.001,
                    "width": 0.05,
                    "height": 0.001,
                }
                for index in range(400)
            ],
        )

    async def test_wraps_framework_failures_as_transport_errors(self) -> None:
        with fake_runner(RuntimeError("x" * 300)):
            with self.assertRaises(errors.ComputerUseError) as caught:
                await ocr._get_text_regions("shot.png", frameworks=_FRAMEWORKS)
        error = caught.exception
        self.assertEqual(error.code, "TRANSPORT_ERROR")
        self.assertIn("vision text recognition failed", error.message)
        self.assertIn("x" * 200, error.message)
        self.assertNotIn("x" * 201, error.message)

    async def test_rejects_bad_paths(self) -> None:
        with fake_runner([]) as calls:
            with self.assertRaises(errors.ComputerUseError) as wrong_type:
                await ocr._get_text_regions(123, frameworks=_FRAMEWORKS)
            with self.assertRaises(errors.ComputerUseError) as empty:
                await ocr._get_text_regions("", frameworks=_FRAMEWORKS)
        self.assertEqual(wrong_type.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(empty.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(calls, [])

    async def test_empty_observations_return_no_regions(self) -> None:
        with fake_runner([]):
            regions = await ocr._get_text_regions("shot.png", frameworks=_FRAMEWORKS)
        self.assertEqual(regions, [])

    async def test_frameworks_tuple_is_matched_by_module_name(self) -> None:
        extended = (
            types.ModuleType("Cocoa"),
            types.ModuleType("Quartz"),
            types.ModuleType("ApplicationServices"),
            types.ModuleType("Vision"),
        )
        observation = {"text": "A", "confidence": 1.0, "bbox": (0.0, 0.0, 0.5, 0.5)}
        with fake_runner([observation]) as calls:
            regions = await ocr._get_text_regions("shot.png", frameworks=extended)
        self.assertIs(calls[0][1], extended[1])
        self.assertIs(calls[0][2], extended[3])
        self.assertEqual(regions[0]["text"], "A")

    async def test_frameworks_tuple_without_vision_fails_closed(self) -> None:
        with fake_runner([]) as calls:
            with self.assertRaises(errors.ComputerUseError) as caught:
                await ocr._get_text_regions("shot.png", frameworks=(types.ModuleType("Quartz"),))
        self.assertEqual(caught.exception.code, "TRANSPORT_ERROR")
        self.assertEqual(calls, [])

    async def test_ocr_never_captures(self) -> None:
        def boom(*args: Any, **kwargs: Any) -> None:
            raise AssertionError("ocr must never capture or attach")

        original_screenshot = capture._screenshot_window
        original_attach = capture._attach_image_if_available
        original_run = subprocess.run
        capture._screenshot_window = boom
        capture._attach_image_if_available = boom
        subprocess.run = boom
        try:
            observation = {"text": "A", "confidence": 1.0, "bbox": (0.0, 0.0, 1.0, 1.0)}
            with fake_runner([observation]):
                regions = await ocr._get_text_regions("shot.png", frameworks=_FRAMEWORKS)
        finally:
            capture._screenshot_window = original_screenshot
            capture._attach_image_if_available = original_attach
            subprocess.run = original_run
        self.assertEqual([region["text"] for region in regions], ["A"])


_FONT: dict[str, tuple[str, ...]] = {
    "P": ("###..", "#...#", "#...#", "####.", "#....", "#....", "#...."),
    "R": ("####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"),
    "I": (".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."),
    "M": ("#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"),
    "E": ("#####", "#....", "#....", "####.", "#....", "#....", "#####"),
    "A": (".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
    "G": (".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."),
    "N": ("#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"),
    "T": ("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."),
    " ": (".....", ".....", ".....", ".....", ".....", ".....", "....."),
}


def _write_png(path: Path, width: int, height: int, rows: list[list[int]]) -> None:
    """Write one 8-bit grayscale PNG with zlib-compressed scanlines."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        size = struct.pack(">I", len(data))
        checksum = struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return size + tag + data + checksum

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def _render_text(text: str, scale: int, gap: int, pad: int) -> tuple[int, int, list[list[int]]]:
    """Render text in the 5x7 font onto a white canvas as black pixels."""
    glyphs = [_FONT[character] for character in text]
    glyph_width, glyph_height = 5 * scale, 7 * scale
    width = len(glyphs) * glyph_width + (len(glyphs) - 1) * gap + 2 * pad
    height = glyph_height + 2 * pad
    rows = [[255] * width for _ in range(height)]
    offset = pad
    for glyph in glyphs:
        for row, pixels in enumerate(glyph):
            for column, pixel in enumerate(pixels):
                if pixel == "#":
                    for y in range(pad + row * scale, pad + (row + 1) * scale):
                        for x in range(offset + column * scale, offset + (column + 1) * scale):
                            rows[y][x] = 0
        offset += glyph_width + gap
    return width, height, rows


@unittest.skipUnless(LIVE and VISION_INSTALLED, SKIP_REASON)
class LiveOcrSmokeTests(unittest.IsolatedAsyncioTestCase):
    async def test_recognizes_hand_built_png(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cua-ocr-") as tmp:
            path = Path(tmp) / "ocr.png"
            width, height, rows = _render_text("PRIME AGENT", scale=16, gap=32, pad=48)
            _write_png(path, width, height, rows)
            regions = await ocr._get_text_regions(str(path))
        self.assertTrue(regions)
        joined = "".join(region["text"] for region in regions).upper()
        self.assertIn("PRIME", joined.replace(" ", ""))
        self.assertIn("AGENT", joined)
        for region in regions:
            self.assertEqual(
                sorted(region), ["confidence", "height", "text", "width", "x", "y"]
            )
            self.assertIsInstance(region["text"], str)
            self.assertIsInstance(region["confidence"], float)
            for key in ("x", "y", "width", "height"):
                self.assertGreaterEqual(region[key], 0.0)
                self.assertLessEqual(region[key], 1.0)


if __name__ == "__main__":
    unittest.main()
