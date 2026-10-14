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
        self.row = self.col = 0
        self.saved = (0, 0)
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
                    self.pending = self.pending[2 + end.end():]
                    continue
                if self.pending[1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", self.pending)
                    if match is None:
                        break
                    params, _, command = match.groups()
                    self.pending = self.pending[match.end():]
                    nums = [int(x) if x.isdigit() else 0 for x in params.lstrip("?<>").split(";")]
                    n = nums[0] or 1
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
                        if nums[0] in (2, 3):
                            self.cells = [[" "] * self.width for _ in range(self.height)]
                            self.styles = [[dict(self.sgr) for _ in range(self.width)] for _ in range(self.height)]
                        elif nums[0] == 0:
                            self.cells[self.row][self.col:] = [" "] * (self.width - self.col)
                            self.styles[self.row][self.col:] = [dict(self.sgr) for _ in range(self.width - self.col)]
                            for row in range(self.row + 1, self.height):
                                self.cells[row] = [" "] * self.width
                                self.styles[row] = [dict(self.sgr) for _ in range(self.width)]
                    elif command == "K":
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
                    continue
                command = self.pending[1]
                self.pending = self.pending[2:]
                if command == "7": self.saved = (self.row, self.col)
                elif command == "8": self.row, self.col = self.saved
                elif command in "()" and self.pending: self.pending = self.pending[1:]
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
            elif char >= " " and not unicodedata.combining(char):
                if self.col >= self.width: self.col = 0; self.row = min(self.height - 1, self.row + 1)
                self.cells[self.row][self.col] = char
                self.styles[self.row][self.col] = dict(self.sgr)
                self.col += 2 if unicodedata.east_asian_width(char) in "WF" else 1
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
