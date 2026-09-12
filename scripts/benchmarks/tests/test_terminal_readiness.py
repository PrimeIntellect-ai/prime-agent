from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import termios
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pexpect

from terminal import MAX_PENDING_INPUT, PROBE_INTERVAL, Display, Terminal


class Clock:
    def __init__(self):
        self.now = 4.0

    def __call__(self):
        return self.now


class Editor:
    """A PTY fixture with independently delayed terminal mode, input, and rendering."""

    def __init__(
        self,
        clock,
        *,
        label="",
        raw_after=0,
        accept_after=0,
        process_after=0,
        render_delay=0,
        cleanup_delay=0,
        placeholder="",
        partial_cleanup=False,
        fragmented=False,
        exit_after=None,
        echo=False,
    ):
        self.clock = clock
        self.start = clock.now
        self.raw_at = self.start + raw_after
        self.accept_at = self.start + accept_after
        self.process_at = self.start + process_after
        self.render_delay = render_delay
        self.cleanup_delay = cleanup_delay
        self.placeholder = placeholder
        self.partial_cleanup = partial_cleanup
        self.fragmented = fragmented
        self.exit_at = None if exit_after is None else self.start + exit_after
        self.echo = echo
        self.child_fd = 123
        self.editor = ""
        self.sent = []
        self.events = []
        self.schedule(self.start, label + "\r\n")

    def schedule(self, when, event):
        self.events.append((when, event))
        self.events.sort(key=lambda item: item[0])

    def attrs(self, fd):
        assert fd == self.child_fd
        canonical = termios.ICANON if self.clock.now < self.raw_at else 0
        return [0, 0, 0, canonical | (termios.ECHO if self.echo else 0)]

    def send(self, text):
        self.sent.append((self.clock.now, text))
        assert "\r" not in text and "\n" not in text, "probe must never submit"
        if self.clock.now < self.accept_at:
            return len(text)
        self.schedule(max(self.clock.now, self.process_at), lambda: self.input(text))
        return len(text)

    def input(self, text):
        if text.startswith("\x7f"):
            count = 1 if self.partial_cleanup else len(text)
            self.editor = self.editor[: max(0, len(self.editor) - count)]
            delay = self.cleanup_delay
        else:
            self.editor += text
            delay = self.render_delay
        # Full redraw, hidden hardware cursor, and an optional empty-editor placeholder.
        visible = self.editor or self.placeholder
        frame = f"\x1b[?25l\x1b[3;1H\x1b[2K> {visible}\x1b[3;{3 + len(self.editor)}H"
        if self.fragmented:
            boundary = frame.index("> ") + 2
            self.schedule(self.clock.now + delay, "\x1b[?2026h" + frame[:boundary])
            self.schedule(self.clock.now + delay + 0.01, frame[boundary:] + "\x1b[?2026l")
        else:
            self.schedule(self.clock.now + delay, frame)

    def read_nonblocking(self, size, timeout):
        self.clock.now += 0.005
        if self.exit_at is not None and self.clock.now >= self.exit_at:
            raise pexpect.EOF("fixture exited")
        while self.events and self.events[0][0] <= self.clock.now:
            _, event = self.events.pop(0)
            if callable(event):
                event()
            else:
                return event
        raise pexpect.TIMEOUT("no output")


class ReadinessTests(unittest.TestCase):
    def launch(self, **options):
        clock = Clock()
        child = Editor(clock, **options)
        terminal = Terminal.__new__(Terminal)
        terminal.started = clock.now - 0.2  # Include spawn overhead, not just ready() time.
        terminal.child = child
        terminal._pending_input = b""
        terminal.display = Display(terminal._send)
        terminal.raw = []
        terminal.bytes = 0
        self.addCleanup(patch.stopall)
        patch("terminal.time.perf_counter", clock).start()
        patch("terminal.termios.tcgetattr", child.attrs).start()
        patch("terminal.os.write", side_effect=lambda _fd, data: child.send(data.decode())).start()
        # Different deterministic generations let the tests detect stale/buffered probes.
        patch("terminal.secrets.token_hex", side_effect=(f"{i:08x}" for i in range(1000))).start()
        return terminal, child, clock

    def test_changed_absent_and_stale_labels_do_not_gate_input(self):
        for label in ("agents/resume", "manage", "sessions / continue", "", "benchready"):
            with self.subTest(label=label):
                terminal, editor, _ = self.launch(label=label)
                elapsed = terminal.ready()
                self.assertGreaterEqual(elapsed, 0.2)
                self.assertLess(elapsed, 0.25)
                self.assertEqual(editor.editor, "")
                self.assertEqual([data for _, data in editor.sent], ["b00000000r", "\x7f" * 10])
                patch.stopall()

    def test_waits_for_raw_mode_even_without_new_output(self):
        terminal, editor, _ = self.launch(label="agents/resume", raw_after=0.4)
        elapsed = terminal.ready()
        self.assertGreaterEqual(editor.sent[0][0], editor.raw_at)
        self.assertGreaterEqual(elapsed, 0.6)
        self.assertEqual(editor.editor, "")

    def test_retries_input_dropped_after_raw_mode(self):
        terminal, editor, _ = self.launch(label="agents/resume", accept_after=0.35)
        elapsed = terminal.ready()
        self.assertGreater(elapsed, 0.55)
        self.assertGreater(len(editor.sent), 4)
        self.assertEqual(editor.editor, "")

    def test_delayed_input_detection_has_a_short_retry_bound(self):
        terminal, editor, _ = self.launch(accept_after=0.35)
        elapsed = terminal.ready()
        visible_at = terminal.started + elapsed
        self.assertLess(visible_at - editor.accept_at, PROBE_INTERVAL + 0.015)

    def test_buffered_retries_cannot_outlive_cleanup(self):
        terminal, editor, _ = self.launch(process_after=0.35)
        terminal.ready()
        self.assertGreater(len(editor.sent), 4)
        self.assertEqual(editor.editor, "")
        self.assertFalse(editor.events)
        self.assertEqual((terminal.display.screen.cursor.y, terminal.display.screen.cursor.x), (2, 2))

    def test_timing_stops_at_first_probe_not_latest_probe_or_cleanup(self):
        terminal, editor, clock = self.launch(process_after=0.35, cleanup_delay=0.2)
        elapsed = terminal.ready()
        self.assertGreater(elapsed, 0.55)
        self.assertLess(elapsed, 0.60)
        self.assertGreater(clock.now - terminal.started - elapsed, 0.19)
        self.assertEqual(editor.editor, "")

    def test_cleanup_allows_placeholder_with_same_leading_character(self):
        terminal, editor, _ = self.launch(placeholder="begin typing here")
        terminal.ready()
        self.assertEqual(editor.editor, "")
        self.assertIn("begin typing here", terminal.display.text())

    def test_partial_cleanup_is_a_failure_even_when_full_marker_disappears(self):
        terminal, editor, clock = self.launch(partial_cleanup=True)
        with self.assertRaisesRegex(TimeoutError, "editor probe cleanup"):
            terminal.ready(seconds=0.3)
        self.assertEqual(editor.editor, "b00000000")
        self.assertNotIn("b00000000r", terminal.display.text())
        self.assertLess(clock.now - editor.start, 0.31)

    def test_fragmented_redraw_cannot_report_partial_cleanup_as_empty(self):
        terminal, editor, _ = self.launch(partial_cleanup=True, fragmented=True)
        with self.assertRaisesRegex(TimeoutError, "editor probe cleanup"):
            terminal.ready(seconds=0.3)
        self.assertEqual(editor.editor, "b00000000")

    def test_echo_mode_never_counts_as_input_readiness(self):
        terminal, editor, _ = self.launch(label="agents/resume", echo=True)
        with self.assertRaisesRegex(TimeoutError, "noncanonical, no-echo terminal input"):
            terminal.ready(seconds=0.2)
        self.assertEqual(editor.sent, [])

    def test_failed_startup_preserves_eof_failure(self):
        terminal, editor, _ = self.launch(exit_after=0.1, accept_after=1)
        with self.assertRaisesRegex(RuntimeError, "exited before the measurement completed"):
            terminal.ready()
        self.assertEqual(editor.sent[-1][1], "\x7f" * 10)

    def test_never_ready_has_one_deadline_and_clears_last_probe(self):
        terminal, editor, clock = self.launch(raw_after=0.2, accept_after=5)
        with self.assertRaisesRegex(TimeoutError, "editor input rendering"):
            terminal.ready(seconds=0.4)
        self.assertLess(clock.now - editor.start, 0.41)
        self.assertEqual(editor.sent[-1][1], "\x7f" * 10)

    def test_cleanup_uses_remaining_deadline_not_an_extra_timeout(self):
        terminal, editor, clock = self.launch(accept_after=0.25, cleanup_delay=0.3)
        with self.assertRaisesRegex(TimeoutError, "editor probe cleanup"):
            terminal.ready(seconds=0.4)
        self.assertLess(clock.now - editor.start, 0.41)

    def test_saturated_writes_bound_retries_and_final_cleanup(self):
        terminal, editor, clock = self.launch()
        with patch("terminal.os.write", side_effect=BlockingIOError) as write:
            with self.assertRaisesRegex(TimeoutError, "editor input rendering"):
                terminal.ready(seconds=0.2)
        self.assertLess(clock.now - editor.start, 0.21)
        self.assertEqual(editor.sent, [])
        self.assertEqual(terminal._pending_input, b"\x7f" * 10)
        # One queued probe is retried, not an ever-growing list of probe generations.
        self.assertTrue(all(call.args[1] == b"b00000000r" for call in write.call_args_list[:-1]))
        self.assertEqual(write.call_args_list[-1].args[1], b"\x7f" * 10)
        self.assertLess(write.call_count, 50)

    def test_query_reply_backpressure_cannot_block_pump_or_readiness(self):
        terminal, editor, clock = self.launch(label="\x1b[6n")
        with patch("terminal.os.write", side_effect=BlockingIOError) as write:
            with self.assertRaises(TimeoutError):
                terminal.ready(seconds=0.2)
        self.assertLess(clock.now - editor.start, 0.21)
        self.assertEqual(editor.sent, [])
        self.assertEqual(terminal._pending_input, b"\x1b[1;1R")
        self.assertTrue(all(call.args[1] == b"\x1b[1;1R" for call in write.call_args_list))

    def test_pending_cleanup_cannot_pass_on_an_empty_redraw(self):
        terminal, editor, clock = self.launch()

        def write(_fd, data):
            if data.startswith(b"\x7f"):
                # An unrelated redraw looks empty, but none of the erase reached stdin.
                editor.schedule(clock.now, "\x1b[3;1H\x1b[2K> ")
                raise BlockingIOError
            return editor.send(data.decode())

        with patch("terminal.os.write", side_effect=write):
            with self.assertRaisesRegex(TimeoutError, "editor probe cleanup"):
                terminal.ready(seconds=0.2)
        self.assertEqual(editor.editor, "b00000000r")
        self.assertEqual(terminal._pending_input, b"\x7f" * 10)

    def test_failed_cleanup_write_does_not_mask_original_failure(self):
        terminal, editor, _ = self.launch(exit_after=0.015, accept_after=1)

        def write(_fd, data):
            if data.startswith(b"\x7f"):
                raise OSError("PTY closed")
            return editor.send(data.decode())

        with patch("terminal.os.write", side_effect=write):
            with self.assertRaisesRegex(RuntimeError, "exited before the measurement completed"):
                terminal.ready()


class InputQueueTests(unittest.TestCase):
    def setUp(self):
        self.terminal = Terminal.__new__(Terminal)
        self.terminal.child = SimpleNamespace(child_fd=123)
        self.terminal._pending_input = b""

    def test_short_writes_eagain_and_eintr_preserve_ordered_suffixes(self):
        with patch("terminal.os.write", side_effect=[3, BlockingIOError, InterruptedError, 2, 3]) as write:
            self.terminal._send("abcdef")
            self.assertEqual(self.terminal._pending_input, b"def")
            self.terminal._send("gh")
            self.assertEqual(self.terminal._pending_input, b"defgh")
            self.terminal._flush_input()
            self.assertEqual(self.terminal._pending_input, b"defgh")
            self.terminal._flush_input()
            self.assertEqual(self.terminal._pending_input, b"fgh")
            self.terminal._flush_input()
            self.assertEqual(self.terminal._pending_input, b"")
            self.terminal._flush_input()
        self.assertEqual(
            [call.args[1] for call in write.call_args_list],
            [b"abcdef", b"defgh", b"defgh", b"defgh", b"fgh"],
        )

    def test_zero_progress_does_not_spin_or_drop_bytes(self):
        with patch("terminal.os.write", return_value=0) as write:
            self.terminal._send("probe")
        self.assertEqual(write.call_count, 1)
        self.assertEqual(self.terminal._pending_input, b"probe")

    def test_query_flood_cannot_grow_the_pending_queue_without_bound(self):
        display = Display(self.terminal._send)
        with patch("terminal.os.write", side_effect=BlockingIOError):
            self.terminal._send("x" * MAX_PENDING_INPUT)
            with self.assertRaisesRegex(RuntimeError, "Terminal input queue exceeds 64 KiB"):
                display.feed("\x1b[6n")
        self.assertEqual(self.terminal._pending_input, b"x" * MAX_PENDING_INPUT)

    def test_pump_flushes_writes_even_when_child_has_no_output(self):
        self.terminal.child.read_nonblocking = Mock(side_effect=pexpect.TIMEOUT("no output"))
        with patch("terminal.os.write", side_effect=[BlockingIOError, 3]):
            self.terminal._send("abc")
            self.assertFalse(self.terminal.pump())
        self.assertEqual(self.terminal._pending_input, b"")


PTY_FIXTURE = r"""
import os, select, sys, termios, time, tty
mode, raw_delay, input_delay = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
attrs = termios.tcgetattr(0)
attrs[3] |= termios.ECHO | termios.ICANON
termios.tcsetattr(0, termios.TCSANOW, attrs)
os.write(1, b'changed startup header\r\n')
if mode == 'exit':
    os.write(1, b'fixture startup failed\r\n')
    raise SystemExit(3)
# If the harness sends during canonical startup, record it instead of hiding the bug.
if select.select([0], [], [], raw_delay)[0]:
    raise RuntimeError('input sent before raw mode')
if mode == 'echo':
    time.sleep(5)
    raise SystemExit(0)
tty.setraw(0)
accept_at = time.monotonic() + input_delay
text = ''
while True:
    byte = os.read(0, 1)
    if byte in (b'\r', b'\n'):
        raise RuntimeError('benchmark submitted a prompt')
    if byte == b'\x03':
        break
    if time.monotonic() < accept_at:
        continue
    if byte == b'\x7f':
        text = text[:-1]
    else:
        text += byte.decode()
    # Batched TUI-style full redraw with hidden cursor and arbitrary placeholder.
    visible = text or 'begin typing here'
    os.write(1, f'\x1b[?25l\x1b[3;1H\x1b[2K> {visible}\x1b[3;{3 + len(text)}H'.encode())
"""


SATURATED_PTY = r"""
import os, pathlib, signal, sys, time
from terminal import Terminal
root = pathlib.Path(sys.argv[1])
def guard(_signum, _frame):
    raise RuntimeError('saturated PTY exceeded outer guard')
signal.signal(signal.SIGALRM, guard)
signal.setitimer(signal.ITIMER_REAL, 2, 2)
terminal = Terminal(
    [sys.executable, '-c', "import os,time,tty; tty.setraw(0); os.write(1,b'raw-ready'); time.sleep(60)"],
    root, os.environ.copy(), root / 'saturated',
)
try:
    deadline = time.perf_counter() + 1
    while 'raw-ready' not in terminal.display.text():
        assert time.perf_counter() < deadline, 'fixture did not enter raw mode'
        terminal.pump()
    fd = terminal.child.child_fd
    was_blocking = os.get_blocking(fd)
    os.set_blocking(fd, False)
    try:
        while True:
            os.write(fd, b'x' * 4096)
    except BlockingIOError:
        pass
    finally:
        os.set_blocking(fd, was_blocking)
    started = time.perf_counter()
    try:
        terminal.ready(seconds=0.15)
        raise AssertionError('unresponsive editor was marked ready')
    except TimeoutError as error:
        assert 'editor input rendering' in str(error), str(error)
    elapsed = time.perf_counter() - started
    assert elapsed < 0.5, elapsed
    started = time.perf_counter()
    terminal.close()
    assert time.perf_counter() - started < 1.5, 'close blocked on saturated PTY'
    assert not terminal.child.isalive()
    print(f'saturated ready timed out in {elapsed:.3f}s; close stopped child')
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
    terminal.child.close(force=True)
"""


class RealPTYReadinessTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def launch(self, mode="editor", raw_delay=0.15, input_delay=0.2):
        root = self.root
        script = root / "editor.py"
        script.write_text(PTY_FIXTURE)
        terminal = Terminal(
            [sys.executable, str(script), mode, str(raw_delay), str(input_delay)],
            root,
            os.environ.copy(),
            root / "transcript",
        )
        self.addCleanup(terminal.close)
        return terminal

    def test_saturated_real_pty_respects_ready_and_close_bounds(self):
        result = subprocess.run(
            [sys.executable, "-c", SATURATED_PTY, str(self.root)],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            timeout=6,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("close stopped child", result.stdout)

    def test_real_pty_delayed_raw_mode_and_input_handler(self):
        terminal = self.launch()
        elapsed = terminal.ready(seconds=3)
        self.assertGreater(elapsed, 0.35)
        self.assertIn("begin typing here", terminal.display.text())
        self.assertNotIn("RuntimeError", "".join(terminal.raw))

    def test_real_failed_startup_keeps_raw_and_screen_diagnostics(self):
        terminal = self.launch(mode="exit")
        with self.assertRaisesRegex(RuntimeError, "exited before the measurement completed"):
            terminal.ready(seconds=1)
        terminal.close()
        self.assertIn("fixture startup failed", (self.root / "transcript.raw").read_text())
        self.assertIn("fixture startup failed", (self.root / "transcript.txt").read_text())

    def test_real_canonical_echo_does_not_accept_a_probe(self):
        terminal = self.launch(mode="echo", raw_delay=0.01, input_delay=0)
        with self.assertRaisesRegex(TimeoutError, "noncanonical, no-echo terminal input"):
            terminal.ready(seconds=0.25)
        self.assertIn("changed startup header", terminal.display.text())


if __name__ == "__main__":
    unittest.main()
