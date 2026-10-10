# /// script
# requires-python = ">=3.11"
# dependencies = ["pygame-ce>=2.5"]
# ///
"""Catch: white circles fall in five columns; the bowl at the bottom catches them.

The game serves JSON lines on localhost for the decision-api loop:
  {"op": "observe"}                         -> game state as text plus the rendered frame (System 1's input)
  {"op": "act", "action": "wait" | "goto_far_left" | "goto_left" | "goto_middle" | "goto_right" | "goto_far_right"}
  {"op": "overlay", "system1": {...}, "system2": {...}}
It prints "PORT <n>" once listening. The clock starts on the first observe.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import random
import socketserver
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

GAME_W, H, PANEL_W = 720, 720, 400
W = GAME_W + PANEL_W
POSITIONS = ["far_left", "left", "middle", "right", "far_right"]
COLUMNS = len(POSITIONS)
COL_W = GAME_W / COLUMNS
GOTO = {f"goto_{name}": col for col, name in enumerate(POSITIONS, start=1)}
RIM_Y = 596
BOWL_W, BOWL_DEPTH = 104, 30
RADIUS = 15
FALL_SPEED = 300  # px/s for every circle: about 2 s from the top to the line
MOVE_SPEED = 4 * COL_W / 0.01  # px/s: column 1 to 5 within 10 ms, so a single frame
TRAIL_S = 0.12  # how long the afterimage of a move lingers
PICTURE_ROWS = 8
FRAME_SIDE = 360  # the rendered frame's width and height in the observation
FPS, VIDEO_FPS = 60, 30
MIN_GAP_S = 0.3
RATE_MIN, RATE_MAX = 0.3, 1 / MIN_GAP_S
SLIDER_Y = H - 52

WHITE = (255, 255, 255)
MUTED = (120, 120, 120)
FAINT = (40, 40, 40)
BLACK = (0, 0, 0)

# The compact brand butterfly from the TUI splash (pa-tui `PRIME_COMPACT_BUTTERFLY_LOGO`).
LOGO = [
    "                 ▗▄▄█▀",
    "   ███▄       ▗▄███▀",
    "  ▗█▛▐█▙   ▗▄█▀▗█▀",
    " ▗█▛ ▟██▙▄██▛ ▟▛",
    " ▗▟▌ ▐███▛▘▗▄█▖",
    "▟███▄  ▄▄▟███▀",
    "▜█▛▀▘  ▜█▛▀▘",
]
# Quadrants per block character: upper-left, upper-right, lower-left, lower-right.
QUADRANTS = {
    "▗": "0001", "▖": "0010", "▘": "1000", "▝": "0100", "▄": "0011", "▀": "1100",
    "▌": "1010", "▐": "0101", "█": "1111", "▛": "1110", "▜": "1101", "▙": "1011", "▟": "0111",
}


def col_center(col: int) -> float:
    return (col - 0.5) * COL_W


@dataclass
class Circle:
    col: int
    y: float
    done: bool = False


class Game:
    def __init__(self, seconds: float, seed: int | None) -> None:
        self.rng = random.Random(seed)
        self.seconds = seconds
        self.lock = threading.Lock()
        self.started = False
        self.finished = False
        self.elapsed = 0.0
        self.circles: list[Circle] = []
        self.effects: list[tuple[str, float, float, float]] = []
        self.bowl_x = col_center(3)
        self.trail: list[tuple[float, float]] = []
        self.target_col = 3
        self.caught = self.missed = 0
        self.rate = 2.0
        self.next_spawn = 0.6
        self.system1: dict = {}
        self.system2: dict = {}
        self.frame: str | None = None
        self.latencies: list[float] = []
        self.goal_changed_at: float | None = None

    def bowl_col(self) -> int:
        return min(COLUMNS, max(1, int(self.bowl_x // COL_W) + 1))

    def handle(self, request: dict) -> dict:
        op = request.get("op")
        if op == "observe":
            self.started = True
            return self.observe()
        if op == "act":
            action = str(request.get("action"))
            if action in GOTO:
                self.target_col = GOTO[action]
            elif action != "wait":
                return {"ok": False, "error": f"unknown action {action!r}"}
            return {"ok": True}
        if op == "overlay":
            self.system1 = request.get("system1") or {}
            goal = (request.get("system2") or {}).get("goal")
            if goal != self.system2.get("goal"):
                self.goal_changed_at = time.monotonic()
            self.system2 = request.get("system2") or {}
            if isinstance(self.system1.get("latency_ms"), (int, float)):
                self.latencies = (self.latencies + [float(self.system1["latency_ms"])])[-90:]
            return {"ok": True}
        return {"ok": False, "error": f"unknown op {op!r}"}

    def observe(self) -> dict:
        rows = [["."] * COLUMNS for _ in range(PICTURE_ROWS)]
        for c in self.circles:
            if not c.done and 0 <= c.y <= RIM_Y:
                rows[min(PICTURE_ROWS - 1, int(c.y / (RIM_Y / PICTURE_ROWS)))][c.col - 1] = "o"
        bowl_row = ["."] * COLUMNS
        bowl_row[self.bowl_col() - 1] = "U"
        return {
            "picture": ["".join(row) for row in rows] + ["".join(bowl_row)],
            "bowl": POSITIONS[self.bowl_col() - 1],
            "caught": self.caught,
            "missed": self.missed,
            "done": self.finished,
            "image": self.frame,
        }

    def update(self, dt: float) -> None:
        now = time.monotonic()
        limit = MOVE_SPEED * dt
        self.bowl_x += max(-limit, min(limit, col_center(self.target_col) - self.bowl_x))
        self.trail = [p for p in self.trail if now - p[1] < TRAIL_S] + [(self.bowl_x, now)]
        self.effects = [e for e in self.effects if now - e[3] < 1.0]
        if not self.started or self.finished:
            return
        self.elapsed += dt
        if self.elapsed >= self.seconds:
            self.finished = True
            return
        self.next_spawn -= dt
        if self.next_spawn <= 0:
            self.circles.append(Circle(self.rng.randint(1, COLUMNS), -RADIUS))
            self.next_spawn = max(MIN_GAP_S, self.rng.uniform(0.8, 1.2) / self.rate)
        for c in self.circles:
            if c.done:
                continue
            c.y += FALL_SPEED * dt
            if c.y + RADIUS < RIM_Y:
                continue
            c.done = True
            x = col_center(c.col)
            if c.col == self.bowl_col():
                self.caught += 1
                self.effects.append(("catch", x, RIM_Y, now))
            else:
                self.missed += 1
                self.effects.append(("miss", x, RIM_Y, now))
        self.circles = [c for c in self.circles if not c.done]

    def set_rate(self, rate: float) -> None:
        self.rate = max(RATE_MIN, min(RATE_MAX, rate))
        self.next_spawn = min(self.next_spawn, max(MIN_GAP_S, 1.2 / self.rate))


def slider_rate(x: float) -> float:
    left, right = GAME_W + 36, W - 36
    return RATE_MIN + (RATE_MAX - RATE_MIN) * max(0.0, min(1.0, (x - left) / (right - left)))


def serve(game: Game) -> int:
    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            for line in self.rfile:
                try:
                    request = json.loads(line)
                    with game.lock:
                        response = game.handle(request)
                except ValueError as error:
                    response = {"ok": False, "error": str(error)}
                self.wfile.write((json.dumps(response) + "\n").encode())
                self.wfile.flush()

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = Server(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


class Renderer:
    def __init__(self, pygame) -> None:
        self.pg = pygame
        from pygame import gfxdraw

        self.gfx = gfxdraw
        self.screen = pygame.display.set_mode((W, H))
        from pygame._sdl2.video import Window

        Window.from_display_module().focus()
        self.ghosts = pygame.Surface((GAME_W, H))
        self.ghost_rect = pygame.Rect(0, RIM_Y - 20, GAME_W, H - RIM_Y + 20)
        pygame.display.set_caption("Catch - Prime Agent decision api")
        sans = "/System/Library/Fonts/HelveticaNeue.ttc"
        mono = "/System/Library/Fonts/SFNSMono.ttf"

        def font(path: str, size: int):
            return pygame.font.Font(path if os.path.exists(path) else None, size)

        self.f_time = font(sans, 34)
        self.f_small = font(sans, 15)
        self.f_label = font(sans, 12)
        self.f_action = font(mono, 28)
        self.f_value = font(mono, 15)
        self.f_goal = font(sans, 17)
        self.f_brand = font(sans, 22)

    def frame_data_url(self) -> str:
        """The play area (never the side panel) as one downscaled PNG data
        URL: the observation's image for vision-capable decision models."""
        play = self.screen.subsurface(self.pg.Rect(0, 0, GAME_W, H))
        small = self.pg.transform.smoothscale(play, (FRAME_SIDE, FRAME_SIDE))
        buffer = io.BytesIO()
        self.pg.image.save(small, buffer, ".png")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()

    def text(self, font, value: str, color, pos, anchor: str = "topleft") -> None:
        surface = font.render(value, True, color)
        self.screen.blit(surface, surface.get_rect(**{anchor: pos}))

    def label(self, value: str, pos) -> None:
        x, y = pos
        for char in value:
            surface = self.f_label.render(char, True, MUTED)
            self.screen.blit(surface, (x, y))
            x += surface.get_width() + 2

    def circle(self, x: float, y: float, r: int, color, surface=None) -> None:
        surface = surface or self.screen
        self.gfx.filled_circle(surface, int(x), int(y), r, color)
        self.gfx.aacircle(surface, int(x), int(y), r, color)

    def figure(self, x: float, color=WHITE, surface=None) -> None:
        surface = surface or self.screen
        xi = int(round(x))
        bowl = [(xi + math.cos(math.pi * i / 32) * BOWL_W / 2, RIM_Y + math.sin(math.pi * i / 32) * BOWL_DEPTH) for i in range(33)]
        self.gfx.filled_polygon(surface, bowl, color)
        self.gfx.aapolygon(surface, bowl, color)
        line = self.pg.draw.line
        line(surface, color, (xi - 28, RIM_Y + 20), (xi - 14, 670), 3)
        line(surface, color, (xi + 28, RIM_Y + 20), (xi + 14, 670), 3)
        self.circle(xi, 650, 9, color, surface)
        line(surface, color, (xi, 662), (xi, 698), 3)
        line(surface, color, (xi, 698), (xi - 10, 716), 3)
        line(surface, color, (xi, 698), (xi + 10, 716), 3)

    def afterimage(self, game: Game, now: float) -> None:
        trail = game.trail
        if max((abs(x - game.bowl_x) for x, _ in trail), default=0.0) < 1:
            return
        self.ghosts.fill(BLACK, self.ghost_rect)
        for (x0, t0), (x1, t1) in zip(trail, trail[1:]):
            steps = max(1, int(abs(x1 - x0) / 10))
            for i in range(steps):
                f = i / steps
                fade = 1 - (now - (t0 + (t1 - t0) * f)) / TRAIL_S
                if fade > 0:
                    self.figure(x0 + (x1 - x0) * f, (int(110 * fade * fade),) * 3, self.ghosts)
        blurred = self.pg.transform.gaussian_blur(self.ghosts.subsurface(self.ghost_rect), 5)
        self.screen.blit(blurred, self.ghost_rect.topleft, special_flags=self.pg.BLEND_ADD)

    def logo(self, x0: int, y0: int, quadrant: int = 2) -> None:
        # Terminal cells are twice as tall as wide, so each quadrant is 1:2.
        for row, chars in enumerate(LOGO):
            for col, char in enumerate(chars):
                for i, bit in enumerate(QUADRANTS.get(char, "0000")):
                    if bit == "1":
                        x = x0 + (col * 2 + i % 2) * quadrant
                        y = y0 + (row * 2 + i // 2) * quadrant * 2
                        self.pg.draw.rect(self.screen, WHITE, (x, y, quadrant, quadrant * 2))

    def wrap(self, value: str, font, width: int) -> list[str]:
        lines, current = [], ""
        for word in value.split():
            candidate = f"{current} {word}".strip()
            if font.size(candidate)[0] <= width:
                current = candidate
            else:
                lines.append(current)
                current = word
        return lines + ([current] if current else [])

    def draw(self, game: Game) -> None:
        screen, now = self.screen, time.monotonic()
        screen.fill(BLACK)
        for x in range(5, GAME_W, 14):
            self.pg.draw.rect(screen, MUTED, (x, RIM_Y - 1, 4, 2))
        for c in game.circles:
            self.circle(col_center(c.col), c.y, RADIUS, WHITE)
        for kind, x, y, t0 in game.effects:
            t = (now - t0) / (0.5 if kind == "catch" else 1.0)
            if t < 1:
                shade = int(255 * (1 - t))
                if kind == "catch":
                    self.gfx.aacircle(screen, int(x), int(y), int(RADIUS + 34 * t), (shade,) * 3)
                else:
                    self.pg.draw.line(screen, (shade,) * 3, (x - 14, y), (x + 14, y), 2)
        self.afterimage(game, now)
        self.figure(game.bowl_x)

        left = max(0.0, game.seconds - game.elapsed)
        self.text(self.f_time, f"{int(left) // 60}:{int(left) % 60:02d}", WHITE, (GAME_W // 2, 24), "midtop")
        self.text(self.f_small, f"{game.caught} caught   {game.missed} dropped", MUTED, (GAME_W // 2, 66), "midtop")
        if not game.started:
            self.text(self.f_small, "waiting for agent", MUTED, (GAME_W // 2, H // 2), "center")
        if game.finished:
            self.text(self.f_time, f"{game.caught} / {game.caught + game.missed}", WHITE, (GAME_W // 2, H // 2 - 30), "center")
            self.text(self.f_small, "caught", MUTED, (GAME_W // 2, H // 2 + 6), "center")

        x0 = GAME_W + 36
        self.pg.draw.line(screen, FAINT, (GAME_W, 0), (GAME_W, H))
        self.logo(x0, 40)
        self.text(self.f_brand, "prime agent", WHITE, (x0 + 104, 50))
        self.text(self.f_label, "decision api", MUTED, (x0 + 105, 80))

        s1, s2 = game.system1, game.system2
        self.label("SYSTEM 1", (x0, 150))
        self.text(self.f_label, str(s1.get("model") or "-"), MUTED, (W - 36, 150), "topright")
        action = str(s1.get("action") or "-")
        label = POSITIONS[GOTO[action] - 1].replace("_", "-") if action in GOTO else action
        self.text(self.f_action, label, WHITE, (x0, 176))
        confidence = s1.get("confidence")
        if isinstance(confidence, (int, float)):
            self.text(self.f_value, f"{confidence:.2f}", MUTED, (W - 36, 186), "topright")
        latency = s1.get("latency_ms")
        self.text(self.f_label, "latency", MUTED, (x0, 230))
        self.text(self.f_value, f"{latency:.0f} ms" if isinstance(latency, (int, float)) else "-", WHITE, (W - 36, 227), "topright")
        if len(game.latencies) > 1:
            top = max(400.0, max(game.latencies))
            span = PANEL_W - 72
            points = [
                (x0 + span * i / (len(game.latencies) - 1), 300 - 44 * value / top)
                for i, value in enumerate(game.latencies)
            ]
            self.pg.draw.aalines(screen, WHITE, False, points)
            self.pg.draw.line(screen, FAINT, (x0, 300), (W - 36, 300))

        self.pg.draw.line(screen, FAINT, (x0, 336), (W - 36, 336))
        self.label("SYSTEM 2", (x0, 362))
        self.text(self.f_label, str(s2.get("model") or "-"), MUTED, (W - 36, 362), "topright")
        lines = self.wrap(str(s2.get("goal") or "-"), self.f_goal, PANEL_W - 72)[:8]
        for i, line in enumerate(lines):
            self.text(self.f_goal, line, WHITE, (x0, 392 + i * 25))
        if game.goal_changed_at is not None:
            self.text(self.f_label, f"updated {now - game.goal_changed_at:.0f} s ago", MUTED, (x0, 400 + len(lines) * 25))

        right = W - 36
        self.pg.draw.line(screen, FAINT, (x0, SLIDER_Y - 50), (right, SLIDER_Y - 50))
        self.label("CIRCLES", (x0, SLIDER_Y - 30))
        self.text(self.f_value, f"{game.rate:.1f} / s", WHITE, (right, SLIDER_Y - 33), "topright")
        knob = x0 + (right - x0) * (game.rate - RATE_MIN) / (RATE_MAX - RATE_MIN)
        self.pg.draw.line(screen, FAINT, (x0, SLIDER_Y), (right, SLIDER_Y), 2)
        self.pg.draw.line(screen, WHITE, (x0, SLIDER_Y), (knob, SLIDER_Y), 2)
        self.circle(knob, SLIDER_Y, 7, WHITE)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=120)
    parser.add_argument("--record", type=Path, help="write an mp4 of the run (needs ffmpeg)")
    parser.add_argument("--summary", type=Path, help="write the final score as json")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    if args.headless:
        os.environ["SDL_VIDEODRIVER"] = "dummy"
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    import pygame

    pygame.init()
    game = Game(args.seconds, args.seed)
    renderer = Renderer(pygame)
    renderer.draw(game)
    game.frame = renderer.frame_data_url()
    print(f"PORT {serve(game)}", flush=True)

    video = None
    frames = 0
    record_start = 0.0
    finished_at = None
    clock = pygame.time.Clock()
    last = time.monotonic()
    dragging = False
    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                finished_at = finished_at or 0.0
            elif event.type == pygame.MOUSEBUTTONDOWN and event.pos[0] > GAME_W and abs(event.pos[1] - SLIDER_Y) < 18:
                dragging = True
            elif event.type == pygame.MOUSEBUTTONUP:
                dragging = False
            if dragging and event.type in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEMOTION):
                with game.lock:
                    game.set_rate(slider_rate(event.pos[0]))
        now = time.monotonic()
        with game.lock:
            game.update(min(0.05, now - last))
            renderer.draw(game)
            game.frame = renderer.frame_data_url()
            started, finished = game.started, game.finished
        last = now
        pygame.display.flip()
        if args.record and started and video is None:
            video = subprocess.Popen(
                ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                 "-r", str(VIDEO_FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                 "-pix_fmt", "yuv420p", str(args.record)],
                stdin=subprocess.PIPE,
            )
            record_start = now
        if video is not None:
            frame = pygame.image.tobytes(renderer.screen, "RGB")
            while frames < int((now - record_start) * VIDEO_FPS):
                video.stdin.write(frame)
                frames += 1
        if finished and finished_at is None:
            finished_at = now
        if finished_at is not None and (finished_at == 0.0 or now - finished_at > 3):
            break
        clock.tick(FPS)
    if video is not None:
        video.stdin.close()
        video.wait()
    if args.summary:
        args.summary.write_text(json.dumps({"caught": game.caught, "missed": game.missed, "seconds": game.elapsed}))
    pygame.quit()
    sys.exit(0)


if __name__ == "__main__":
    main()
