"""The bash-done notice lifecycle of one finished command.

One state per finished bash command's notice, driven by the kernel: a
read before the notice leaves the kernel consumes it, and a read after
it left withdraws it. Every other move is an error that names the legal
set.
"""

from __future__ import annotations

import enum


class NoticeLifecycle(enum.Enum):
    QUEUED = "queued"  # the command finished; its notice waits
    SENT = "sent"  # the notice left the kernel for the host
    CONSUMED = "consumed"  # read before the notice left the kernel
    WITHDRAWN = "withdrawn"  # read after the notice was sent


_LEGAL: dict[NoticeLifecycle, frozenset[NoticeLifecycle]] = {
    NoticeLifecycle.QUEUED: frozenset({NoticeLifecycle.CONSUMED, NoticeLifecycle.SENT}),
    NoticeLifecycle.SENT: frozenset({NoticeLifecycle.WITHDRAWN}),
    NoticeLifecycle.CONSUMED: frozenset(),
    NoticeLifecycle.WITHDRAWN: frozenset(),
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
