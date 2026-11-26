# Compact step summaries - demo frames

These PNGs show the `Compact steps` setting (`/settings`, Display) on the synthetic session in
`crates/pa-tui/tests/fixtures/compact-steps-demo.jsonl`. They are rendered from the real TUI,
headlessly: `pa-tui-replay` prints one styled frame as ANSI, and a small converter turns the
ANSI into a PNG. Nothing here is a screenshot of a live terminal.

| File | Command |
| --- | --- |
| `01-before.png` | `pa-tui-replay FIXTURE --frame 120x40 --color` |
| `02-compact.png` | `pa-tui-replay FIXTURE --frame 120x40 --color --compact-steps` |
| `03-thought-expanded.png` | `pa-tui-replay FIXTURE --frame 120x40 --color --compact-steps --expand-entry 1` |
| `04-tool-expanded.png` | `pa-tui-replay FIXTURE --frame 120x40 --color --compact-steps --expand-entry 2` |
| `05-all-expanded.png` | `pa-tui-replay FIXTURE --frame 120x40 --color --compact-steps --expand-all` |

`FIXTURE=crates/pa-tui/tests/fixtures/compact-steps-demo.jsonl`. Run each command from the repo
root after `cargo build -p pa-tui --bin pa-tui-replay`, redirect its stdout to `frame.ansi`, then
run the converter below. The thinking time in `03` is absent on purpose: a session file records no
measured thinking time, so a file replay cannot show `Thought for 3.2s`. The live path shows the
measured duration and `a_live_thought_reports_its_thinking_time` asserts it.

## Converter

Requires Pillow and a monospace font (Menlo on macOS). It parses the SGR subset the TUI emits:
16-colour, 256-colour, truecolor and bold. `48;...` (background) is skipped because the TUI paints
the same colour as the canvas.

```python
#!/usr/bin/env python3
"""Convert a pa-tui ANSI frame (from `pa-tui-replay --color`) to a PNG.

Usage: ansi2png.py FRAME.ansi OUT.png [--size 15]

Parses the SGR subset pa-tui emits (16-colour, 256-colour, truecolor, bold,
default fg) and draws a cell grid on a dark background. Cursor-addressing
sequences are not emitted by pa-tui frames; anything else is skipped.
"""
import argparse, re, sys
from PIL import Image, ImageDraw, ImageFont

BASIC = [(40,44,52),(224,108,117),(152,195,121),(229,192,123),(97,175,239),(198,120,221),(86,182,194),(171,178,191)]
def basic(i, bright=False):
    c = BASIC[i % 8]
    return tuple(min(255, int(v*1.35)) for v in c) if bright else c
def xterm(i):
    if i < 16: return basic(i % 8, i >= 8)
    if i >= 232:
        v = 8 + (i-232)*10
        return (v, v, v)
    i -= 16
    r, g, b = i//36, (i % 36)//6, i % 6
    f = [0, 95, 135, 175, 215, 255]
    return (f[r], f[g], f[b])

def parse(text):
    rows, cur, fg, bold, col = [], [], (220,220,220), False, 0
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\x1b":
            j = text.find("m", i)
            if j == -1: break
            parts = [p for p in text[i+2:j].split(";")] or ["0"]
            k = 0
            while k < len(parts):
                p = parts[k]
                if p in ("0", ""): fg, bold = (220,220,220), False
                elif p == "1": bold = True
                elif p == "22": bold = False
                elif p == "39": fg = (220,220,220)
                elif p == "38":
                    if k+1 < len(parts) and parts[k+1] == "5": fg = xterm(int(parts[k+2])); k += 2
                    elif k+1 < len(parts) and parts[k+1] == "2": fg = (int(parts[k+2]), int(parts[k+3]), int(parts[k+4])); k += 4
                elif p == "48":
                    # background: the TUI paints the same colour as the canvas, so skip it
                    if k+1 < len(parts) and parts[k+1] == "5": k += 2
                    elif k+1 < len(parts) and parts[k+1] == "2": k += 4
                elif p.isdigit() and 30 <= int(p) <= 37: fg = basic(int(p)-30)
                elif p.isdigit() and 90 <= int(p) <= 97: fg = basic(int(p)-90, True)
                k += 1
            i = j+1
            continue
        if ch == "\n":
            rows.append(cur); cur = []; col = 0; i += 1; continue
        if ch in "\r": i += 1; continue
        cur.append((col, ch, fg)); col += 1; i += 1
    rows.append(cur)
    return rows

def render(ansi_path, out_path, size=15, pad=18, bg=(24,26,31), font_path="/System/Library/Fonts/Menlo.ttc"):
    text = open(ansi_path, "r", encoding="utf-8", errors="replace").read()
    rows = parse(text)
    font = ImageFont.truetype(font_path, size)
    adv = font.getlength("M"); lh = int(size*1.42)
    cols = max((len(r) for r in rows), default=80)
    img = Image.new("RGB", (int(pad*2 + adv*cols), int(pad*2 + lh*len(rows))), bg)
    d = ImageDraw.Draw(img)
    for ri, row in enumerate(rows):
        y = pad + ri*lh
        for col, ch, fg in row:
            if ch == " ": continue
            d.text((pad + col*adv, y), ch, font=font, fill=fg)
    img.save(out_path, optimize=True)
    return img.size

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("ansi"); ap.add_argument("out")
    ap.add_argument("--size", type=int, default=15)
    a = ap.parse_args()
    print(render(a.ansi, a.out, a.size))
```
