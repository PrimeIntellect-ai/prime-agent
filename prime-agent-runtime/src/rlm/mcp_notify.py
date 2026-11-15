"""MCP server notifications: a bounded bus plus the kernel→host forwarder.

A server pushes notifications (tool/prompt/resource inventory changes,
`resources/updated`, log messages, progress) on the same long-lived session
that serves its tools. The kernel keeps them in a bounded, counted bus so the
model can pull them, and forwards the ones that matter to the host as
`mcp.notification` frames — the host turns each into a durable transcript row
and wakes the model for the significant kinds.

Two classes of notification, deliberately different:

- **Significant** (`tools_changed`, `prompts_changed`, `resources_changed`,
  `resource_updated`, `subscription_lost`): the model's picture of the server
  is now stale, so the host should act on it. Forwarded immediately.
- **Noisy** (`logging`, `progress`): informational, potentially high-rate.
  Buffered for the model to pull, and forwarded at most once per server+kind
  per coalescing window, merged into one counted entry — a chatty server must
  not be able to wake a model turn per log line.

Drops are counted, never silent: an entry evicted from the buffer or a frame
the host refused increments a counter that `mcp.notifications(...)` and
`mcp.notification_status()` report.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any

# Notification kinds (the wire vocabulary shared with the host).
TOOLS_CHANGED = "tools_changed"
PROMPTS_CHANGED = "prompts_changed"
RESOURCES_CHANGED = "resources_changed"
RESOURCE_UPDATED = "resource_updated"
LOGGING = "logging"
PROGRESS = "progress"
SUBSCRIPTION_LOST = "subscription_lost"

SIGNIFICANT: frozenset[str] = frozenset(
    {TOOLS_CHANGED, PROMPTS_CHANGED, RESOURCES_CHANGED, RESOURCE_UPDATED, SUBSCRIPTION_LOST}
)
NOISY: frozenset[str] = frozenset({LOGGING, PROGRESS})

MAX_BUFFERED = 256
MAX_FORWARD_BATCH = 8
COALESCE_WINDOW_SECONDS = 2.0
MAX_SUMMARY_CHARS = 500


def _summary(text: Any) -> str:
    """A bounded, single-line projection of a notification payload."""
    if text is None:
        return ""
    value = text if isinstance(text, str) else str(text)
    value = value.replace("\r", " ").replace("\n", " ").strip()
    if len(value) > MAX_SUMMARY_CHARS:
        return value[:MAX_SUMMARY_CHARS] + "…"
    return value


class NotificationBus:
    """Bounded per-server notification buffer with drop accounting."""

    def __init__(self) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=MAX_BUFFERED)
        self._pending: list[dict[str, Any]] = []
        self._seq = 0
        self._dropped = 0
        self._forwarded = 0
        self._forward_failed = 0
        self._last_noisy_forward: dict[tuple[str, str], float] = {}

    # -- ingestion ---------------------------------------------------------

    def submit(self, server: str, kind: str, summary: str = "", **extra: Any) -> dict[str, Any]:
        """Record one notification and queue it for forwarding.

        Returns the entry (with its sequence number) as it also sits in the
        pull buffer."""
        self._seq += 1
        entry: dict[str, Any] = {
            "seq": self._seq,
            "server": server,
            "kind": kind,
            "timestamp": time.time(),
            "summary": _summary(summary),
        }
        for key, value in extra.items():
            if isinstance(value, str):
                entry[key] = _summary(value)
            elif isinstance(value, (int, float, bool)) or value is None:
                entry[key] = value
        if len(self._entries) == self._entries.maxlen:
            self._dropped += 1
        self._entries.append(dict(entry))
        self._pending.append(dict(entry))
        return entry

    @property
    def pending(self) -> bool:
        return bool(self._pending)

    # -- pull (model-facing) ----------------------------------------------

    def snapshot(
        self,
        server: str | None = None,
        kind: str | None = None,
        since: int | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        selected = [
            dict(entry)
            for entry in self._entries
            if (server is None or entry["server"] == server)
            and (kind is None or entry["kind"] == kind)
            and (since is None or entry["seq"] > since)
        ][-max(1, limit) :]
        return {
            "notifications": selected,
            "nextSince": selected[-1]["seq"] if selected else (since or 0),
            "dropped": self._dropped,
        }

    def clear(self, server: str | None = None) -> int:
        if server is None:
            cleared = len(self._entries)
            self._entries.clear()
            return cleared
        kept = [entry for entry in self._entries if entry["server"] != server]
        cleared = len(self._entries) - len(kept)
        self._entries.clear()
        self._entries.extend(kept)
        return cleared

    def status(self) -> dict[str, Any]:
        buffered_by_kind: dict[str, int] = {}
        for entry in self._entries:
            buffered_by_kind[entry["kind"]] = buffered_by_kind.get(entry["kind"], 0) + 1
        return {
            "buffered": len(self._entries),
            "bufferedByKind": buffered_by_kind,
            "dropped": self._dropped,
            "forwarded": self._forwarded,
            "forwardFailed": self._forward_failed,
        }

    # -- host forwarding ---------------------------------------------------

    def take_forwardable(self, now: float | None = None) -> list[dict[str, Any]]:
        """The entries to send to the host now: significant ones immediately,
        noisy ones at most once per server+kind per coalescing window."""
        now = time.monotonic() if now is None else now
        batch: list[dict[str, Any]] = []
        remaining: list[dict[str, Any]] = []
        merged_noisy: dict[tuple[str, str], dict[str, Any]] = {}
        for entry in self._pending:
            if entry["kind"] in SIGNIFICANT:
                if len(batch) < MAX_FORWARD_BATCH:
                    batch.append(entry)
                else:
                    remaining.append(entry)
                continue
            key = (entry["server"], entry["kind"])
            if key in merged_noisy:
                merged_noisy[key]["count"] += 1
                merged_noisy[key]["summary"] = entry["summary"]
                merged_noisy[key]["seq"] = entry["seq"]
            else:
                merged = dict(entry)
                # A merged entry that waited out its window keeps its count.
                merged["count"] = entry.get("count", 1)
                merged_noisy[key] = merged
        for key, merged in merged_noisy.items():
            last = self._last_noisy_forward.get(key)
            if last is not None and now - last < COALESCE_WINDOW_SECONDS:
                remaining.append(merged)
                continue
            if len(batch) >= MAX_FORWARD_BATCH:
                remaining.append(merged)
                continue
            self._last_noisy_forward[key] = now
            batch.append(merged)
        self._pending = remaining
        return batch

    def seconds_until_forwardable(self, now: float | None = None) -> float:
        """How long the forwarder should sleep before the next noisy window
        opens; 0 when something is already forwardable."""
        if not self._pending:
            return 0.0
        now = time.monotonic() if now is None else now
        waits = [
            max(0.0, COALESCE_WINDOW_SECONDS - (now - self._last_noisy_forward[key]))
            for key in self._last_noisy_forward
        ]
        if any(entry["kind"] in SIGNIFICANT for entry in self._pending):
            return 0.0
        return min(waits) if waits else COALESCE_WINDOW_SECONDS

    def mark_forwarded(self, count: int) -> None:
        self._forwarded += count

    def mark_forward_failed(self, count: int) -> None:
        self._forward_failed += count
