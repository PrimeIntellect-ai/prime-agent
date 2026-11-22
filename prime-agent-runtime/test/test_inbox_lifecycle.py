from __future__ import annotations

import unittest

from rlm.inbox_lifecycle import (
    IllegalTransition,
    NoticeLifecycle,
    advance,
)

Q, C, W, F, D, X, E = (
    NoticeLifecycle.QUEUED,
    NoticeLifecycle.CONSUMED,
    NoticeLifecycle.WOKEN,
    NoticeLifecycle.FOLDED,
    NoticeLifecycle.DELIVERED,
    NoticeLifecycle.WITHDRAWN,
    NoticeLifecycle.EXPIRED,
)


class NoticeLifecycleTest(unittest.TestCase):
    def test_only_the_design_note_transitions_are_legal(self):
        legal = {
            Q: {C, W, F, X, E},
            W: {D},
            F: {D, X, E},
            C: set(),
            D: set(),
            X: set(),
            E: set(),
        }
        for current in NoticeLifecycle:
            for target in NoticeLifecycle:
                with self.subTest(current=current, target=target):
                    if target in legal[current]:
                        self.assertIs(advance(current, target), target)
                        continue
                    with self.assertRaises(IllegalTransition) as raised:
                        advance(current, target)
                    self.assertEqual(raised.exception.legal, legal[current])
                    names = ", ".join(sorted(s.value for s in legal[current])) or "none (terminal)"
                    self.assertEqual(
                        str(raised.exception),
                        f"illegal notice transition {current.value} -> {target.value}; legal: {names}",
                    )


if __name__ == "__main__":
    unittest.main()
