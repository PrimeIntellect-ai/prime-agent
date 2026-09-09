from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

import pexpect
import pyte

from schema import ANSWER

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

    def answer_prefix(self) -> str | None:
        for row, line in enumerate(self.screen.display):
            word = line.strip()
            if not word or not ANSWER.startswith(word):
                continue
            column = line.index(word)
            cells = [self.screen.buffer[row][column + offset] for offset in range(len(word))]
            if all(cell.fg == "default" and cell.bg == "default" and not cell.italics for cell in cells):
                return word
        return None


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

    def until(self, predicate: Callable[[Display], bool], seconds: float) -> float:
        deadline = time.perf_counter() + seconds
        while time.perf_counter() < deadline:
            if self.pump() and predicate(self.display):
                return time.perf_counter()
        raise TimeoutError("Timed out waiting for the expected terminal state")

    def settle(self, seconds: float) -> None:
        deadline = time.perf_counter() + seconds
        while time.perf_counter() < deadline:
            self.pump()

    def ready(self) -> float:
        self.until(lambda display: "agents/resume" in display.text(), 30)
        self.child.send("benchready")
        echoed = self.until(lambda display: "benchready" in display.text(), 5)
        self.child.send("\x7f" * len("benchready"))
        self.until(lambda display: "benchready" not in display.text(), 5)
        return echoed - self.started

    def close(self, secret: str = "") -> None:
        raw, snapshot = "".join(self.raw), self.display.text()
        if secret:
            raw, snapshot = raw.replace(secret, "[REDACTED]"), snapshot.replace(secret, "[REDACTED]")
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
