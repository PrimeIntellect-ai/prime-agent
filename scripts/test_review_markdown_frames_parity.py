#!/usr/bin/env python3
"""Lightweight capture parser checks; never execute product binaries."""
import unittest
from review_markdown_frames_parity import StyledScreen, START, END, CORPUS


class CaptureTests(unittest.TestCase):
    def test_fragmented_sgr_and_osc8_keep_cell_attributes(self):
        screen = StyledScreen(40)
        chunks = [b'\x1b[38;2;1;', b'2;3m\x1b[1mA\x1b[22mB',
                  b'\x1b]8;;https://example.com\x1b\\C\x1b]8;;\x1b\\', b'D']
        for chunk in chunks:
            screen.feed(chunk)
        self.assertEqual(screen.cells[0][:4], list('ABCD'))
        self.assertEqual(screen.styles[0][:4], [
            (('rgb', 1, 2, 3), None, (1,), None),
            (('rgb', 1, 2, 3), None, (), None),
            (('rgb', 1, 2, 3), None, (), 'https://example.com'),
            (('rgb', 1, 2, 3), None, (), None)])
        self.assertEqual(screen.style_errors, [])

    def test_repaint_clears_stale_text_and_style(self):
        screen = StyledScreen(40)
        screen.feed(b'\x1b[1mABCDE\r\x1b[0mXY\x1b[K')
        self.assertEqual(screen.cells[0][:5], list('XY   '))
        self.assertEqual(screen.styles[0][2:5], [None] * 3)

    def test_sentinel_crop_preserves_indentation_and_nonblank_styles(self):
        screen = StyledScreen(40)
        screen.feed(f'  {START}\r\n    '.encode() + b'\x1b[3mtext\x1b[0m\r\n' + f'  {END}'.encode())
        self.assertEqual(screen.region(), [[(' ', None), (' ', None)] +
                         [(char, (None, None, (3,), None)) for char in 'text']])

    def test_title_corpus_has_single_backslash_escapes(self):
        self.assertIn(r'\"b\"', CORPUS['escaped_titles'])
        self.assertNotIn(r'\\"', CORPUS['escaped_titles'])


if __name__ == '__main__':
    unittest.main()
