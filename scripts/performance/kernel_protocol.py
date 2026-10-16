from __future__ import annotations

import json
import os
import selectors
import signal
import subprocess
import time
from collections import deque
from contextlib import suppress
from pathlib import Path

CELL_REPEATS = 50
SHELL_REPEATS = 5
MIXED_CELLS = 35
OUTPUT_BYTES = 32 * 1024
FRAME_ROWS = 10_000
FRAME_COLUMNS = 8

BASH_EMPTY = "_r = await bash(':')\nassert _r.exit_code == 0 and _r.output == ''"
GIT_STATUS = "_r = await bash('git status --porcelain')\nassert _r.exit_code == 0 and _r.output == ''"
BASH_OUTPUT = (
    f"_r = await bash(\"printf '%{OUTPUT_BYTES}s' ''\")\n"
    f"assert _r.exit_code == 0 and len(_r.output) == {OUTPUT_BYTES}\nprint(_r.output, end='')"
)


class Kernel:
    def __init__(self, command: list[str], cwd: Path, env: dict[str, str], transcript: Path):
        self.transcript = transcript
        self.stderr = transcript.with_suffix(".stderr").open("wb")
        self.selector = selectors.DefaultSelector()
        self.raw: list[bytes] = []
        self.pending = b""
        self.lines: deque[bytes] = deque()
        self.bytes = 0
        self.sequence = 0
        self.started = time.perf_counter()
        try:
            self.process = subprocess.Popen(
                command,
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=self.stderr,
                bufsize=0,
                start_new_session=True,
            )
        except Exception:
            self.stderr.close()
            self.selector.close()
            raise
        assert self.process.stdout is not None
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def event(self, deadline: float) -> dict:
        while not self.lines:
            remaining = deadline - time.perf_counter()
            if remaining <= 0 or not self.selector.select(remaining):
                raise TimeoutError("Timed out waiting for the kernel protocol")
            assert self.process.stdout is not None
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("Kernel exited before completing the request")
            self.bytes += len(chunk)
            if self.bytes > 8_000_000:
                raise RuntimeError("Kernel transcript exceeds 8 MB")
            self.raw.append(chunk)
            chunks = (self.pending + chunk).split(b"\n")
            self.pending = chunks.pop()
            self.lines.extend(chunks)
        event = json.loads(self.lines.popleft())
        if not isinstance(event, dict) or not isinstance(event.get("event"), str):
            raise ValueError("Invalid kernel protocol event")
        return event

    def ready(self) -> tuple[float, str]:
        event = self.event(time.perf_counter() + 30)
        if event.get("event") != "ready" or event.get("protocol") != 3:
            raise ValueError("Expected kernel protocol 3 ready event")
        return time.perf_counter() - self.started, str(event.get("python", "unknown"))

    def send(self, request: dict) -> None:
        assert self.process.stdin is not None
        data = memoryview((json.dumps(request) + "\n").encode())
        while data:
            written = self.process.stdin.write(data)
            if not written:
                raise RuntimeError("Kernel protocol write failed")
            data = data[written:]

    def done(self, request_id: str, *, interrupted: bool = False) -> list[dict]:
        deadline = time.perf_counter() + 30
        events = []
        while True:
            event = self.event(deadline)
            events.append(event)
            if event.get("event") == "done" and event.get("id") == request_id:
                if interrupted:
                    if event.get("status") != "error" or not any(
                        e.get("ename") == "KeyboardInterrupt" and e.get("id") == request_id for e in events
                    ):
                        raise RuntimeError("Kernel did not acknowledge the interrupt")
                elif event.get("status") != "ok":
                    raise RuntimeError(f"Kernel request failed: {str(events)[-400:]}")
                return events

    def request(self, kind: str, **fields: object) -> list[dict]:
        self.sequence += 1
        request_id = str(self.sequence)
        self.send({"type": kind, "id": request_id, **fields})
        return self.done(request_id)

    def execute(self, code: str) -> list[dict]:
        return self.request("execute", code=code)

    def batch(self, code: str, repeats: int, *, output_bytes: int | None = None) -> float:
        started = time.perf_counter()
        for _ in range(repeats):
            events = self.execute(code)
            if output_bytes is not None:
                output = "".join(e.get("text", "") for e in events if e["event"] == "stdout")
                if len(output.encode()) != output_bytes:
                    raise RuntimeError("Kernel output was truncated or missing")
        return (time.perf_counter() - started) / repeats

    def mixed(self) -> float:
        started = time.perf_counter()
        for index in range(MIXED_CELLS):
            self.execute(GIT_STATUS if index % 4 == 0 else "pass")
        return time.perf_counter() - started

    def interrupt(self) -> float:
        self.sequence += 1
        request_id = str(self.sequence)
        self.send(
            {
                "type": "execute",
                "id": request_id,
                "code": "import asyncio\nprint('interrupt-ready', flush=True)\nawait asyncio.sleep(60)",
            }
        )
        deadline = time.perf_counter() + 30
        while True:
            event = self.event(deadline)
            if (
                event.get("id") == request_id
                and event["event"] == "stdout"
                and "interrupt-ready" in event.get("text", "")
            ):
                break
            if event["event"] in ("error", "done"):
                raise RuntimeError("Interrupt fixture did not reach the running state")
        started = time.perf_counter()
        self.send({"type": "interrupt", "id": request_id})
        self.done(request_id, interrupted=True)
        elapsed = time.perf_counter() - started
        self.execute("assert 1 + 1 == 2")
        return elapsed

    def close(self) -> None:
        try:
            if self.process.poll() is None:
                self.send({"type": "shutdown"})
                self.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            with suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        finally:
            for stream in (self.process.stdin, self.process.stdout):
                if stream is not None:
                    stream.close()
            self.selector.close()
            self.stderr.close()
            self.transcript.with_suffix(".jsonl").write_bytes(b"".join(self.raw))
