#!/usr/bin/env python3
"""Decision-only regression tests; these never launch either product binary."""
import unittest

from review_restore_notice_parity import NAMES_MARKER, RESET, compare_notices


def notice(names):
    body = 'Your Python kernel state was revived from your previous session. '
    return '[python-state-restored]\n\n' + body + NAMES_MARKER + ', '.join(names) + '.'


BASE = ['agent_message', 'agent_observe', 'goal', 'os', 'restore_parity_marker', 'rlm_heartbeat']


class NoticeComparisonTests(unittest.TestCase):
    def test_a_declared_bundled_skill_name_is_accepted_and_recorded(self) -> None:
        summary = compare_notices(notice(BASE), notice(BASE + ['computer_use']) + '\n' + RESET, {'computer_use'})
        self.assertEqual(summary['additional_rust_names'], ['computer_use'])
        self.assertEqual(summary['bundled_python_imports'], ['computer_use'])

    def test_a_missing_shared_baseline_name_fails(self) -> None:
        with self.assertRaises(AssertionError) as caught:
            compare_notices(notice(BASE), notice([name for name in BASE if name != 'goal']), set())
        self.assertIn('shared baseline names missing', str(caught.exception))

    def test_an_undeclared_additional_rust_name_fails(self) -> None:
        with self.assertRaises(AssertionError) as caught:
            compare_notices(notice(BASE), notice(BASE + ['debug_secret']), {'computer_use'})
        self.assertIn('undeclared additional Rust notice names', str(caught.exception))
        self.assertIn('debug_secret', str(caught.exception))

    def test_a_missing_names_marker_fails(self) -> None:
        with self.assertRaises(AssertionError) as caught:
            compare_notices('[python-state-restored]\n\nno names here', notice(BASE), set())
        self.assertIn('restore names marker missing', str(caught.exception))

    def test_the_allowance_subtracts_the_pinned_ts_packages(self) -> None:
        import tempfile
        from pathlib import Path

        from review_restore_notice_parity import bundled_python_imports

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for skill, package in (("computer-use", "computer_use"), ("goal", "goal")):
                package_dir = root / "skills" / skill / "src" / package
                package_dir.mkdir(parents=True)
                (package_dir / "__init__.py").write_text("")
            ts = root / "ts-package"
            (ts / "skills" / "goal" / "src" / "goal").mkdir(parents=True)
            (ts / "skills" / "goal" / "src" / "goal" / "__init__.py").write_text("")
            self.assertEqual(bundled_python_imports(root, ts), {"computer_use"})
            self.assertEqual(bundled_python_imports(root), {"computer_use", "goal"})

    def test_a_notice_difference_outside_the_names_segment_still_fails(self) -> None:
        altered = notice(BASE).replace('revived', 'restored')
        with self.assertRaises(AssertionError) as caught:
            compare_notices(notice(BASE), altered, set())
        self.assertIn('additional notice difference', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
