"""The bash-done notice lifecycle of one finished command.

One state per finished bash command's notice. The kernel drives
``QUEUED -> CONSUMED | WITHDRAWN`` (a read of the finished result); the
daemon's queue admission does the wake, fold, and delivery moves.
Every other move is an error that names the legal set.
"""

from __future__ import annotations

import enum


class NoticeLifecycle(enum.Enum):
    QUEUED = "queued"  # the command finished; its notice waits
    CONSUMED = "consumed"  # read before the notice left the kernel
    WOKEN = "woken"  # the wake policy admitted it
    FOLDED = "folded"  # combined into a summary line
    DELIVERED = "delivered"  # reached the model (wake or fold)
    WITHDRAWN = "withdrawn"  # read after the notice was sent, before delivery
    EXPIRED = "expired"  # a durability cap passed


_LEGAL: dict[NoticeLifecycle, frozenset[NoticeLifecycle]] = {
    NoticeLifecycle.QUEUED: frozenset(
        {
            NoticeLifecycle.CONSUMED,
            NoticeLifecycle.WOKEN,
            NoticeLifecycle.FOLDED,
            NoticeLifecycle.WITHDRAWN,
            NoticeLifecycle.EXPIRED,
        }
    ),
    NoticeLifecycle.WOKEN: frozenset({NoticeLifecycle.DELIVERED}),
    NoticeLifecycle.FOLDED: frozenset(
        {NoticeLifecycle.DELIVERED, NoticeLifecycle.WITHDRAWN, NoticeLifecycle.EXPIRED}
    ),
    NoticeLifecycle.CONSUMED: frozenset(),
    NoticeLifecycle.DELIVERED: frozenset(),
    NoticeLifecycle.WITHDRAWN: frozenset(),
    NoticeLifecycle.EXPIRED: frozenset(),
}


class IllegalTransition(ValueError):
    def __init__(self, current: NoticeLifecycle, target: NoticeLifecycle) -> None:
        self.current = current
        self.target = target
        self.legal = _LEGAL[current]
        names = ", ".join(sorted(state.value for state in self.legal)) or "none (terminal)"
        super().__init__(
            f"illegal notice transition {current.value} -> {target.value}; legal: {names}"
        )


def advance(current: NoticeLifecycle, target: NoticeLifecycle) -> NoticeLifecycle:
    """Return ``target`` when the move is legal, else raise IllegalTransition."""
    if target not in _LEGAL[current]:
        raise IllegalTransition(current, target)
    return target
