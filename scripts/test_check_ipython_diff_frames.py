import unittest

from check_ipython_diff_frames import END, region
from lifecycle_lib import DockScreen


class EditFrameCaptureTests(unittest.TestCase):
    def test_capture_keeps_geometry_background_and_inverse(self):
        screen = DockScreen(width=80)
        screen.feed(('    ╰─ parity.py +1 -1\r\n\x1b[41;7m-1 a b\x1b[0m\r\n'
                     + END).encode())
        rows = region(screen, 'parity.py')
        self.assertEqual(''.join(cell[0] for cell in rows[0]), '    ╰─ parity.py +1 -1')
        self.assertEqual(rows[1][4], [' ', {'bg': ['ansi', 41], '7': True}])
        changed = DockScreen(width=80)
        changed.feed(('    ╰─ parity.py +1 -1\r\n-1 a b\r\n' + END).encode())
        self.assertNotEqual(region(changed, 'parity.py'), rows)

    def test_missing_frame_boundary_cannot_be_compared_as_empty(self):
        screen = DockScreen(width=80)
        screen.feed(b'    summary without the actual edited-file row')
        with self.assertRaises(ValueError):
            region(screen, 'parity.py')


if __name__ == '__main__':
    unittest.main()
