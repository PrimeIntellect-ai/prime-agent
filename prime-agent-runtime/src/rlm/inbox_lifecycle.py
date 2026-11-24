"""The bash-done notice lifecycle of one finished command.

One state per finished bash command's notice, driven by the kernel: a
read before the notice leaves the kernel consumes it, and a read after
it left withdraws it.
"""

from __future__ import annotations

import enum


class NoticeLifecycle(enum.Enum):
    QUEUED = "queued"  # the command finished; its notice waits
    SENT = "sent"  # the notice left the kernel for the host
    CONSUMED = "consumed"  # read before the notice left the kernel
    WITHDRAWN = "withdrawn"  # read after the notice was sent
