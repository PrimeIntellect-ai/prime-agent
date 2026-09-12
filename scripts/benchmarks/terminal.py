from __future__ import annotations

import secrets
import termios
import time
from collections.abc import Callable
from pathlib import Path

import pexpect
import pyte

# Bound input-handler detection delay without adding a fixed wait to fast startup.
PROBE_INTERVAL = 0.02

QUERIES = {
    "\x1b[6n": "\x1b[1;1R",
    "\x1b[?6n": "\x1b[?1;1R",
    "\x1b[c": "\x1b[?1;2c",
    "\x1b[0c": "\x1b[?1;2c",
    "\x1b[>c": "\x1b[>0;276;0c",
    "\x1b[>0c": "\x1b[>0;276;0c",
    "\x1b[?u": "\x1b[?0u",
    "\x1b[?2026$p": "\x1b[?2026;2$y",
    "\x1b[14t": "\x1b[4;640;960t",
    "\x1b[16t": "\x1b[6;16;8t",
    "\x1b[18t": "\x1b[8;40;120t",
}
for terminator in ("\x07", "\x1b\\"):
    QUERIES[f"\x1b]11;?{terminator}"] = "\x1b]11;rgb:0000/0000/0000\x1b\\"
    QUERIES[f"\x1b]10;?{terminator}"] = "\x1b]10;rgb:eeee/eeee/eeee\x1b\\"


class Display:
    def __init__(self, reply: Callable[[str], object]):
        self.screen = pyte.Screen(120, 40)
        self.stream = pyte.Stream(self.screen)
        self.reply = reply
        self.pending = ""

    def feed(self, chunk: str) -> None:
        self.pending += chunk
        while True:
            matches = [(self.pending.find(query), query) for query in QUERIES if query in self.pending]
            if not matches:
                break
            position, query = min(matches)
            self.stream.feed(self.pending[:position])
            self.reply(QUERIES[query])
            self.pending = self.pending[position + len(query) :]
        keep = max(
            (
                length
                for query in QUERIES
                for length in range(1, len(query))
                if self.pending.endswith(query[:length])
            ),
            default=0,
        )
        if keep:
            self.stream.feed(self.pending[:-keep])
            self.pending = self.pending[-keep:]
        else:
            self.stream.feed(self.pending)
            self.pending = ""

    def text(self) -> str:
        return "\n".join(row.rstrip() for row in self.screen.display)


class Terminal:
    def __init__(self, command: list[str], cwd: Path, env: dict[str, str], transcript: Path):
        self.started = time.perf_counter()
        self.child = pexpect.spawn(
            command[0],
            command[1:],
            cwd=str(cwd),
            env=env,
            encoding="utf-8",
            codec_errors="replace",
            dimensions=(40, 120),
            echo=False,
        )
        self.child.delaybeforesend = 0
        self.display = Display(self.child.send)
        self.transcript = transcript
        self.raw: list[str] = []
        self.bytes = 0

    def pump(self) -> bool:
        try:
            chunk = self.child.read_nonblocking(65536, timeout=0.005)
        except pexpect.TIMEOUT:
            return False
        except pexpect.EOF as error:
            raise RuntimeError("Prime Agent exited before the measurement completed") from error
        self.bytes += len(chunk)
        if self.bytes > 8_000_000:
            raise RuntimeError("Terminal transcript exceeds 8 MB")
        self.raw.append(chunk)
        self.display.feed(chunk)
        return True

    def settle(self, seconds: float) -> None:
        deadline = time.perf_counter() + seconds
        while time.perf_counter() < deadline:
            self.pump()

    def ready(self, seconds: float = 30) -> float:
        deadline = time.perf_counter() + seconds
        probes: list[str] = []
        next_probe = 0.0
        echoed: float | None = None
        origin: tuple[int, int] | None = None
        needs_clear = False
        stage = "noncanonical, no-echo terminal input"
        # Keep the ten-character input workload identical across benchmark revisions.
        erase = "\x7f" * 10
        try:
            while time.perf_counter() < deadline:
                updated = self.pump()
                # pyte shifts DEC private modes by five bits. Do not inspect a partial
                # synchronized TUI frame, especially while the editor row is cleared.
                updated = updated and (2026 << 5) not in self.display.screen.mode
                flags = termios.tcgetattr(self.child.child_fd)[3]
                if flags & (termios.ICANON | termios.ECHO):
                    continue
                now = time.perf_counter()
                if origin is not None:
                    cursor = self.display.screen.cursor
                    # A shortened marker is not a cleared editor. Verify the cursor
                    # returns to the insertion point, allowing any empty-editor placeholder.
                    if (
                        updated
                        and (cursor.y, cursor.x) == origin
                        and not any(probe in self.display.text() for probe in probes)
                    ):
                        assert echoed is not None
                        return echoed - self.started
                    continue
                if updated and probes:
                    text = self.display.text()
                    if echoed is None and any(probe in text for probe in probes):
                        echoed = now
                        stage = "latest editor probe rendering"
                    if echoed is not None:
                        for row, line in enumerate(self.display.screen.display):
                            column = line.find(probes[-1])
                            if column >= 0:
                                origin = (row, column)
                                self.child.send(erase)
                                needs_clear = False
                                stage = "editor probe cleanup"
                                break
                if echoed is None and now >= next_probe:
                    # Raw mode can precede the editor's input handler. Balanced retries
                    # replace dropped/partial probes without accumulating editor text.
                    if needs_clear:
                        self.child.send(erase)
                    probe = "b" + secrets.token_hex(4) + "r"
                    self.child.send(probe)
                    probes.append(probe)
                    needs_clear = True
                    next_probe = now + PROBE_INTERVAL
                    stage = "editor input rendering"
                # Once any probe renders, stop retrying and acknowledge the newest one
                # before clearing: older queued retries must not outlive cleanup.
            raise TimeoutError(f"Timed out waiting for {stage}")
        finally:
            if needs_clear:
                try:
                    self.child.send(erase)
                except (OSError, pexpect.EOF):
                    pass

    def close(self) -> None:
        raw, snapshot = "".join(self.raw), self.display.text()
        self.transcript.with_suffix(".raw").write_text(raw)
        self.transcript.with_suffix(".txt").write_text(snapshot)
        try:
            if self.child.isalive():
                self.child.sendcontrol("c")
                time.sleep(0.15)
                if self.child.isalive():
                    self.child.sendcontrol("c")
        except (OSError, pexpect.EOF):
            pass
        finally:
            self.child.close(force=True)
