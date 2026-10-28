import copy
import unittest

from check_link_frames import BEGIN, END, frames_equal, region
from lifecycle_lib import DockScreen


class LinkParityGuards(unittest.TestCase):
    def test_cell_size_query_is_answered_without_masking_unknown_queries(self):
        screen = DockScreen(width=80)
        self.assertEqual(screen.feed(b'\x1b[16t'), [b'\x1b[6;16;8t'])
        self.assertEqual(screen.unsupported_terminal, [])
        screen.feed(b'\x1b[17t')
        self.assertEqual(screen.unsupported_terminal, ['\x1b[17t'])

    def test_missing_targets_or_process_cleanup_cannot_pass(self):
        item = {'executed': True, 'cleanup_verified': True, 'target_check': True,
                'frames': {'paint': [[['x', {'4': True}]]]}}
        pair = {'ts': copy.deepcopy(item), 'rust': copy.deepcopy(item)}
        self.assertTrue(frames_equal(pair))
        for field in ('executed', 'cleanup_verified', 'target_check'):
            changed = copy.deepcopy(pair)
            changed['rust'][field] = False
            self.assertFalse(frames_equal(changed))
        for field in ('error', 'fixture_errors'):
            changed = copy.deepcopy(pair)
            changed['rust'][field] = 'fixture failure'
            self.assertFalse(frames_equal(changed))

    def test_text_styles_and_geometry_are_compared(self):
        item = {'executed': True, 'cleanup_verified': True, 'target_check': True,
                'frames': {'paint': [[['x', {'4': True}], [' ', {}]]]}}
        pair = {'ts': copy.deepcopy(item), 'rust': copy.deepcopy(item)}
        for cells in ([['y', {'4': True}], [' ', {}]],
                      [['x', {}], [' ', {}]],
                      [['x', {'4': True}], [' ', {'bg': ['ansi', 41]}]],
                      [[' ', {}], ['x', {'4': True}]]):
            changed = copy.deepcopy(pair)
            changed['rust']['frames']['paint'] = [cells]
            self.assertFalse(frames_equal(changed))

    def test_complete_region_keeps_trailing_colored_blanks(self):
        screen = DockScreen(width=80)
        screen.feed((BEGIN + '\r\n\x1b[41mRead docs  \x1b[0m\r\n' + END).encode())
        rows = region(screen)
        self.assertEqual(len(rows[1]), 80)
        self.assertEqual(rows[1][10], [' ', {'bg': ['ansi', 41]}])
        with self.assertRaises(ValueError):
            region(DockScreen(width=80))


if __name__ == '__main__':
    unittest.main()
