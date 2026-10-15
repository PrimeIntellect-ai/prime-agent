#!/usr/bin/env python3
"""Pinned real-binary Markdown assistant-history frames, including SGR and OSC8.

Compares the bounded transcript region between literal sentinel paragraphs, not
the unrelated app chrome. Does not claim streaming, scrolling or mouse parity.
Only hosted Linux runs execute binaries; raw PTY captures remain in the receipt.
"""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import struct
import subprocess
import sys
import tempfile
import termios
import unicodedata

from review_draft_disconnect_parity import (
    Screen, Supervisor, Terminal, actual_hello, digest, env_for,
    TS_ARCHIVE_SHA256, TS_SOURCE_COMMIT,
)

START, END = "MARKDOWN FRAME START", "MARKDOWN FRAME END"
CORPUS = {
    "adjacent_emphasis": "**bold***italic*\n**outer *inner***\n**outer *inner* tail***next*\n**outer `*` tail***next*\n" + r'''*a\*b* **a\**b**
***a\*b*** ~~a\~~b~~
*a\\* tail
**a *b** **a*b**''',
    "escaped_titles": r'''[t](https://example.com "a \"b\"")
[t](https://example.com 'a \'b\'')
[t](foo(bar) "title")
[t](foo\(bar\) "a \"b\"")
[t](foo(bar "title")''',
    "headings": "# Heading one\n## Heading two\n#### Heading four\n###### Heading six",
    "nested_lists": "1. parent\n   - child\n     - leaf\n   continuation\n2. sibling",
    "quotes": "> quoted **bold** and `code`\n> lazy continuation",
    "fences": "~~~python\nx = 1\nprint(x)\n~~~",
    "escapes_images": r"\*literal\* snake_case_name ![alt](url)\![link](url)",
    "unicode_wrap": "A **styledword**. Unicode café 界 words with `code` and trailing punctuation. " * 2,
}


class StyledScreen(Screen):
    """Reuse the existing VT grid; retain style/link state on every painted cell."""
    def __init__(self, width, height=40):
        super().__init__(width, height)
        self.stream = ""
        self.stream_decoder = codecs.getincrementaldecoder("utf-8")("strict")
        self.fg = self.bg = self.link = None
        self.mods = set()
        self.styles = [[None] * width for _ in range(height)]
        self.style_errors = []
        self.keyboard_controls = []

    def sgr(self, params):
        nums = [int(x or 0) for x in params.split(";")]
        i = 0
        while i < len(nums):
            n = nums[i]
            if n == 0:
                self.fg = self.bg = None
                self.mods.clear()
            elif n in (1, 2, 3, 4, 5, 7, 8, 9): self.mods.add(n)
            elif n == 22: self.mods.difference_update((1, 2))
            elif n in (23, 24, 25, 27, 28, 29): self.mods.discard(n - 20)
            elif n in (39, 49):
                if n == 39: self.fg = None
                else: self.bg = None
            elif 30 <= n <= 37 or 90 <= n <= 97:
                self.fg = ("indexed", n - 30 if n < 90 else n - 90 + 8)
            elif 40 <= n <= 47 or 100 <= n <= 107:
                self.bg = ("indexed", n - 40 if n < 100 else n - 100 + 8)
            elif n in (38, 48) and i + 1 < len(nums):
                mode = nums[i + 1]
                count = 1 if mode == 5 else (3 if mode == 2 else 0)
                if not count or i + 2 + count > len(nums):
                    self.style_errors.append(f"unsupported color SGR {params}")
                    return
                color = tuple(["indexed" if mode == 5 else "rgb"] + nums[i + 2:i + 2 + count])
                if n == 38: self.fg = color
                else: self.bg = color
                i += 1 + count
            else: self.style_errors.append(f"unsupported SGR {n}")
            i += 1

    def feed(self, data):
        self.stream += self.stream_decoder.decode(data)
        replies = []
        while self.stream:
            if self.stream.startswith("\x1b"):
                if len(self.stream) < 2: break
                if self.stream[1] in "]P_^":
                    end = re.search(r"\x07|\x1b\\", self.stream[2:])
                    if end is None: break
                    size = 2 + end.end()
                    token, self.stream = self.stream[:size], self.stream[size:]
                    if token.startswith("\x1b]8;"):
                        payload = token[2:-len(end.group())]
                        self.link = payload.split(";", 2)[2] or None
                    replies.extend(super().feed(token.encode()))
                    continue
                if self.stream[1] == "[":
                    hit = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", self.stream)
                    if hit is None: break
                    token, self.stream = self.stream[:hit.end()], self.stream[hit.end():]
                    params, _, command = hit.groups()
                    # These private controls configure/query keyboard input. They
                    # never modify painted cells; interpreting >4 as SGR4 would
                    # invent underline, and int('>4') is not a color parser.
                    if command == 'm' and params in ('>4;0', '>4;1', '>4;2'):
                        self.keyboard_controls.append(token)
                        continue
                    if command == 'u' and params == '?':
                        self.keyboard_controls.append(token)
                        # A flags response, even zero, advertises Kitty support.
                        # Stay silent; the following DA1 query is answered by the
                        # legacy Screen and settles crossterm's probe as non-Kitty.
                        continue
                    if command == 'u' and (re.fullmatch(r'[>=]\d+(?:;\d+)?', params)
                                            or re.fullmatch(r'<\d*', params)):
                        self.keyboard_controls.append(token)
                        continue
                    if params.startswith(('?', '<', '>')) and command not in 'hlnc':
                        self.style_errors.append(f"unsupported private VT command {token!r}")
                        continue
                    nums = [int(x) if x.isdigit() else 0 for x in params.lstrip("?<>").split(";")]
                    n = nums[0] or 1
                    if command == "m": self.sgr(params)
                    elif command == "J":
                        if nums[0] in (2, 3): self.styles = [[None] * self.width for _ in range(self.height)]
                        elif nums[0] == 0:
                            self.styles[self.row][self.col:] = [None] * (self.width - self.col)
                            for row in range(self.row + 1, self.height): self.styles[row] = [None] * self.width
                    elif command == "K":
                        start, end = (0, self.width) if nums[0] == 2 else ((0, self.col + 1) if nums[0] == 1 else (self.col, self.width))
                        self.styles[self.row][start:end] = [None] * (end - start)
                    elif command == "P":
                        row = self.styles[self.row]
                        row[self.col:] = (row[self.col + n:] + [None] * n)[:self.width - self.col]
                    elif command == "X":
                        end = min(self.width, self.col + n)
                        self.styles[self.row][self.col:end] = [None] * (end - self.col)
                    elif command not in "HfABCDGnc" and not (command in "hl" and params.startswith("?")):
                        self.style_errors.append(f"unsupported VT command {token!r}")
                    replies.extend(super().feed(token.encode()))
                    continue
                size = 3 if self.stream[1] in "()" else 2
                if len(self.stream) < size: break
                token, self.stream = self.stream[:size], self.stream[size:]
                if token[1] not in "78()=><":
                    self.style_errors.append(f"unsupported VT escape {token!r}")
                replies.extend(super().feed(token.encode()))
                continue
            char, self.stream = self.stream[0], self.stream[1:]
            if char == "\n" and self.row == self.height - 1:
                self.styles.pop(0)
                self.styles.append([None] * self.width)
            elif char >= " " and not unicodedata.combining(char):
                row, col = self.row, self.col
                if col >= self.width: col, row = 0, min(self.height - 1, row + 1)
                self.styles[row][col] = (self.fg, self.bg, tuple(sorted(self.mods)), self.link)
                if unicodedata.east_asian_width(char) in "WF" and col + 1 < self.width:
                    self.cells[row][col + 1] = " "
                    self.styles[row][col + 1] = None
                if char == "\u200d" or "\ufe00" <= char <= "\ufe0f":
                    self.style_errors.append("unsupported joined/variation-selector grapheme")
            elif unicodedata.combining(char) and self.col > 0:
                self.cells[self.row][self.col - 1] += char
            replies.extend(super().feed(char.encode()))
        return replies

    def region(self):
        lines = ["".join(row) for row in self.cells]
        starts = [(n, row.index(START)) for n, row in enumerate(lines) if START in row]
        ends = [n for n, row in enumerate(lines) if END in row]
        if len(starts) != 1 or len(ends) != 1 or ends[0] <= starts[0][0]:
            raise ValueError("complete bounded Markdown frame is not visible")
        first, left = starts[0]
        rows = []
        for y in range(first + 1, ends[0]):
            last = len(lines[y].rstrip())
            rows.append([(self.cells[y][x], None if self.cells[y][x].isspace() else self.styles[y][x])
                         for x in range(left, max(left, last))])
        while rows and not rows[0]: rows.pop(0)
        while rows and not rows[-1]: rows.pop()
        return rows


class StyledTerminal(Terminal):
    def __init__(self, command, root, env, width):
        self.master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~(termios.ECHO | termios.ICANON)
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, width, 0, 0))
        self.process = subprocess.Popen(command, cwd=root, env=env, stdin=slave,
                                        stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.screen, self.raw = StyledScreen(width), bytearray()


class MarkdownSupervisor(Supervisor):
    def __init__(self, path, hello, root, cwd):
        self.cwd = str(cwd)
        super().__init__(path, hello, 'markdown', root)

    def send(self, sock, data):
        if data.get('type') == 'response' and data.get('command') == 'attach':
            data['data']['snapshot']['state']['cwd'] = self.cwd
            data['data']['snapshot']['summary']['cwd'] = self.cwd
        elif data.get('type') == 'response' and data.get('command') in ('get_state', 'get_connection_state'):
            data['data']['cwd'] = self.cwd
        super().send(sock, data)


def assistant(text):
    return {"role": "assistant", "stopReason": "stop", "api": "openai-completions",
            "provider": "parity-local", "model": "parity-1", "timestamp": 1750000000000,
            "content": [{"type": "text", "text": f"{START}\n\n{text}\n\n{END}"}],
            "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}


def capture(kind, binary, root, hello, text, width, cwd):
    root.mkdir()
    env = env_for(root, kind)
    server = MarkdownSupervisor(root / "fixture.sock", hello, root, cwd)
    server.messages = [assistant(text)]
    terminal = None
    result = {"executed": False}
    try:
        terminal = StyledTerminal([str(binary), "--daemon-socket", str(server.path)], cwd, env, width)
        terminal.wait("Markdown history fully painted", lambda: START in terminal.screen.text()
                      and END in terminal.screen.text(), server)
        if terminal.screen.style_errors: raise RuntimeError(terminal.screen.style_errors)
        region = terminal.screen.region()
        painted = [style for row in region for char, style in row if not char.isspace()]
        if not painted:
            raise RuntimeError("Markdown corpus body was not painted")
        if r'\![link](url)' in text:
            targets = {style[3] for style in painted if style and style[3]}
            expected = cwd.as_uri() + '/url'
            if targets != {expected}:
                raise RuntimeError(f"relative hyperlink target differs: {targets!r} vs {expected!r}")
        if "**bold***italic*" in text and not all(any(style and modifier in style[2] for style in painted)
                                                 for modifier in (1, 3)):
            raise RuntimeError("actual PTY did not render both bold and italic modifiers")
        result.update(executed=True, styled_region=region, commands=server.commands,
                      osc8_observed=any(style and style[3] for style in painted),
                      keyboard_controls=terminal.screen.keyboard_controls,
                      explicit_session_cwd=str(cwd),
                      screen=terminal.screen.text())
    except Exception as error: result["error"] = f"{type(error).__name__}: {error}"
    finally:
        try:
            if terminal:
                result["raw_terminal"] = bytes(terminal.raw).decode("utf-8", "replace")
                terminal.close()
        finally:
            server.close()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    receipt = {"verified": False, "results": {}, "comparisons": {}, "corpus": CORPUS,
               "scope": "Actual assistant-history transcript region cells, foreground/background, modifiers and OSC8 at widths40/80/120; excludes chrome, streaming, scrolling and mouse actions.",
               "source_commit": TS_SOURCE_COMMIT,
               "ci": {k: os.environ.get(k) for k in ("GITHUB_RUN_ID", "GITHUB_SHA")}}
    try:
        if sys.platform != "linux": raise RuntimeError("binary execution requires hosted Linux")
        if digest(Path(os.environ["PA_TS_ARCHIVE"])) != TS_ARCHIVE_SHA256:
            raise RuntimeError("pinned official TS archive hash mismatch")
        receipt["ts_archive_sha256"] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix="pa-md-frames-") as temp:
            cwd = Path(temp) / 'project'
            cwd.mkdir()
            for kind in ("ts", "rust"):
                binary = Path(os.environ[f"PA_{kind.upper()}_BINARY"]).resolve()
                root = Path(temp) / kind
                root.mkdir()
                env = env_for(root, kind)
                hello = actual_hello(binary, root, env)
                side = receipt["results"][kind] = {"binary_sha256": digest(binary), "hello": hello, "cases": {}}
                version = subprocess.run([str(binary), "--version"], cwd=root, env=env,
                                         capture_output=True, text=True, timeout=15, check=True).stdout.strip()
                side["version"] = version
                if kind == "ts" and "0.9.8" not in version:
                    raise RuntimeError("unexpected TS binary version")
                for name, text in CORPUS.items():
                    for width in (40, 80, 120):
                        key = f"{name}-{width}"
                        side["cases"][key] = capture(kind, binary, root / key, hello, text, width, cwd)
        for key in receipt["results"]["ts"]["cases"]:
            a, b = [receipt["results"][kind]["cases"][key] for kind in ("ts", "rust")]
            receipt["comparisons"][key] = bool(a.get("executed") and b.get("executed")
                                                and a["styled_region"] == b["styled_region"])
        receipt["verified"] = bool(receipt["comparisons"] and all(receipt["comparisons"].values()))
    except Exception as error: receipt["error"] = f"{type(error).__name__}: {error}"
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"verified": receipt["verified"], "comparisons": receipt["comparisons"],
                      "error": receipt.get("error")}))
    return 0 if receipt["verified"] else 1


if __name__ == "__main__":
    sys.exit(main())
