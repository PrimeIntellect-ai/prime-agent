#!/usr/bin/env python3
"""SGR-aware variant of the existing binary comparator's Screen.

Supports the cursor/erase/color vocabulary already used by its terminal capture.
Unsupported SGR is disclosed; raw ANSI is the audit ground truth. This does not
claim a complete terminal emulator or pixel-exact font rendering.
"""
import codecs
import re
import unicodedata

class DockScreen:
    """Existing xterm cell capture with explicit per-cell SGR attributes."""
    def __init__(self, width=120, height=40):
        self.width, self.height = width, height
        self.cells = [[" "] * width for _ in range(height)]
        self.styles = [[{} for _ in range(width)] for _ in range(height)]
        self.sgr = {}
        self.unsupported_sgr = []
        self.unsupported_terminal = []
        self.keyboard_controls = []
        self.autowrap = True
        self.alternate = None
        self.row = self.col = 0
        self.saved = (0, 0, {})
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.cells)

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        replies = []
        while self.pending:
            if self.pending[0] == "\x1b":
                if len(self.pending) < 2:
                    break
                if self.pending[1] in "]P_^":
                    end = re.search(r"\x07|\x1b\\", self.pending[2:])
                    if end is None:
                        break
                    sequence = self.pending[:2 + end.end()]
                    # OSC titles/hyperlinks do not move terminal cells. DCS,
                    # APC and PM can carry graphics or sixel: never silently
                    # accept their unknown effect on the captured frame.
                    payload = self.pending[2:2 + end.start()]
                    osc_kind = payload.split(';', 1)[0]
                    # Pinned TS asks for the default foreground/background via
                    # OSC10;? / OSC11;? (actual failed hosted receipt). Queries
                    # do not paint or set a color; a legacy PTY may stay silent.
                    # Color-setting variants remain unsupported and fail closed.
                    color_query = payload in ('10;?', '11;?')
                    if self.pending[1] != ']' or (not color_query and osc_kind not in ('0', '1', '2', '7', '8', '52', '133')):
                        self.unsupported_terminal.append(sequence)
                    self.pending = self.pending[2 + end.end():]
                    continue
                if self.pending[1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", self.pending)
                    if match is None:
                        break
                    params, intermediate, command = match.groups()
                    sequence = self.pending[:match.end()]
                    self.pending = self.pending[match.end():]
                    nums = [int(x) if x.isdigit() else 0 for x in params.lstrip("?<>").split(";")]
                    n = nums[0] or 1
                    if intermediate and not (command == 'q' and intermediate == ' '):
                        self.unsupported_terminal.append(sequence)
                        continue
                    # Actual hosted TS/Rust captures contain these keyboard
                    # protocol controls. They do not paint cells and must not
                    # be interpreted as SGR4 (underline) after stripping >.
                    if command == 'm' and params in ('>4;0', '>4;1', '>4;2'):
                        self.keyboard_controls.append(sequence)
                        continue
                    if command == 'u' and params == '?':
                        self.keyboard_controls.append(sequence)
                        # Even a zero-flags reply advertises Kitty support to
                        # crossterm (vendor terminal/sys/unix.rs:255). This PTY
                        # emits legacy keys: stay silent on the Kitty query.
                        # The following DA1 query's response settles non-Kitty
                        # through KeyboardEnhancementFlagsFilter instead.
                        continue
                    if command == 'u' and (re.fullmatch(r'[>=]\d+(?:;\d+)?', params)
                                           or re.fullmatch(r'<\d*', params)):
                        self.keyboard_controls.append(sequence)
                        continue
                    if params.startswith(('?', '<', '>')) and command not in 'hlnc':
                        self.unsupported_terminal.append(sequence)
                        continue
                    if command == "m": self.apply_sgr(nums)
                    elif command in "Hf":
                        self.row = min(self.height - 1, max(0, (nums[0] or 1) - 1))
                        self.col = min(self.width - 1, max(0, ((nums[1] if len(nums) > 1 else 1) or 1) - 1))
                    elif command == "A": self.row = max(0, self.row - n)
                    elif command == "B": self.row = min(self.height - 1, self.row + n)
                    elif command == "C": self.col = min(self.width - 1, self.col + n)
                    elif command == "D": self.col = max(0, self.col - n)
                    elif command == "G": self.col = min(self.width - 1, n - 1)
                    elif command == "J":
                        if nums[0] == 2:
                            self.cells = [[" "] * self.width for _ in range(self.height)]
                            self.styles = [[dict(self.sgr) for _ in range(self.width)] for _ in range(self.height)]
                        elif nums[0] == 0:
                            self.cells[self.row][self.col:] = [" "] * (self.width - self.col)
                            self.styles[self.row][self.col:] = [dict(self.sgr) for _ in range(self.width - self.col)]
                            for row in range(self.row + 1, self.height):
                                self.cells[row] = [" "] * self.width
                                self.styles[row] = [dict(self.sgr) for _ in range(self.width)]
                        elif nums[0] != 3:  # ED3 clears scrollback, not visible cells.
                            self.unsupported_terminal.append(sequence)
                    elif command == "K":
                        if nums[0] not in (0, 1, 2):
                            self.unsupported_terminal.append(sequence)
                            continue
                        start, end = (0, self.width) if nums[0] == 2 else ((0, self.col + 1) if nums[0] == 1 else (self.col, self.width))
                        self.cells[self.row][start:end] = [" "] * (end - start)
                        self.styles[self.row][start:end] = [dict(self.sgr) for _ in range(end - start)]
                    elif command == "P":
                        line = self.cells[self.row]
                        line[self.col:] = (line[self.col + n:] + [" "] * n)[:self.width - self.col]
                        styles = self.styles[self.row]
                        styles[self.col:] = (styles[self.col + n:] + [dict(self.sgr) for _ in range(n)])[:self.width - self.col]
                    elif command == "X":
                        end = min(self.width, self.col + n)
                        self.cells[self.row][self.col:end] = [" "] * (end - self.col)
                        self.styles[self.row][self.col:end] = [dict(self.sgr) for _ in range(end - self.col)]
                    elif command == "n" and nums[0] == 6:
                        replies.append(f"\x1b[{self.row + 1};{self.col + 1}R".encode())
                    elif command == "c": replies.append(b"\x1b[?1;2c")
                    elif command in 'hl' and params.startswith('?'):
                        for mode in nums:
                            if mode == 7:
                                self.autowrap = command == 'h'
                            elif mode == 1049:
                                if command == 'h' and self.alternate is None:
                                    self.alternate = (self.cells, self.styles, self.row, self.col,
                                                      dict(self.sgr), self.autowrap)
                                    self.cells = [[' '] * self.width for _ in range(self.height)]
                                    self.styles = [[{} for _ in range(self.width)] for _ in range(self.height)]
                                    self.row = self.col = 0
                                elif command == 'l' and self.alternate is not None:
                                    self.cells, self.styles, self.row, self.col, self.sgr, self.autowrap = self.alternate
                                    self.alternate = None
                            elif mode not in (12, 25, 1000, 1002, 1003, 1004, 1006, 2004, 2026):
                                self.unsupported_terminal.append(sequence)
                    elif command == 'q' and intermediate == ' ':
                        pass  # Cursor presentation, not cell geometry.
                    else:
                        self.unsupported_terminal.append(sequence)
                    continue
                command = self.pending[1]
                if command in '()' and len(self.pending) < 3:
                    break
                self.pending = self.pending[2:]
                if command == "7": self.saved = (self.row, self.col, dict(self.sgr))
                elif command == "8":
                    self.row, self.col, saved_sgr = self.saved
                    self.sgr = dict(saved_sgr)
                elif command in "()" and self.pending:
                    charset = self.pending[0]
                    self.pending = self.pending[1:]
                    if charset != 'B':
                        self.unsupported_terminal.append('\x1b' + command + charset)
                else:
                    self.unsupported_terminal.append('\x1b' + command)
                continue
            char, self.pending = self.pending[0], self.pending[1:]
            if char == "\r": self.col = 0
            elif char == "\n":
                self.row += 1
                if self.row >= self.height:
                    self.cells.pop(0); self.cells.append([" "] * self.width)
                    self.styles.pop(0); self.styles.append([dict(self.sgr) for _ in range(self.width)])
                    self.row = self.height - 1
            elif char == "\b": self.col = max(0, self.col - 1)
            elif char == '\t': self.col = min(self.width - 1, ((self.col // 8) + 1) * 8)
            elif char >= " " and not unicodedata.combining(char):
                if self.col >= self.width:
                    if self.autowrap:
                        self.col = 0
                        self.row += 1
                        if self.row == self.height:
                            self.cells.pop(0); self.cells.append([' '] * self.width)
                            self.styles.pop(0); self.styles.append([dict(self.sgr) for _ in range(self.width)])
                            self.row = self.height - 1
                    else:
                        self.col = self.width - 1
                self.cells[self.row][self.col] = char
                self.styles[self.row][self.col] = dict(self.sgr)
                self.col += 2 if unicodedata.east_asian_width(char) in "WF" else 1
            elif char not in ('\x00', '\x07') and not unicodedata.combining(char):
                self.unsupported_terminal.append(char)
        return replies

    def apply_sgr(self, nums):
        i = 0
        while i < len(nums):
            value = nums[i]
            if value == 0:
                self.sgr = {}
            elif value in (1, 2, 3, 4, 7, 9):
                self.sgr[str(value)] = True
            elif value in (22, 23, 24, 27, 29):
                for key in {22: ('1', '2'), 23: ('3',), 24: ('4',), 27: ('7',), 29: ('9',)}[value]:
                    self.sgr.pop(key, None)
            elif 30 <= value <= 37 or 90 <= value <= 97:
                self.sgr['fg'] = ['ansi', value]
            elif 40 <= value <= 47 or 100 <= value <= 107:
                self.sgr['bg'] = ['ansi', value]
            elif value in (39, 49):
                self.sgr.pop('fg' if value == 39 else 'bg', None)
            elif value in (38, 48) and i + 1 < len(nums):
                count = {5: 1, 2: 3}.get(nums[i + 1])
                if count is not None and i + 2 + count <= len(nums):
                    self.sgr['fg' if value == 38 else 'bg'] = nums[i + 1:i + 2 + count]
                    i += 1 + count
                else:
                    self.unsupported_sgr.append(nums[i:])
                    break
            else:
                self.unsupported_sgr.append([value])
            i += 1

    def dock_styles(self):
        return [{"text": ''.join(row).rstrip(), "styles": [dict(style) for style in self.styles[index]]}
                for index, row in enumerate(self.cells)
                if 'subagents' in ''.join(row) or 'running' in ''.join(row)]
