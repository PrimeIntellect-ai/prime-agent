"""Fakes and fixtures for the Linux X11 backend tests.

Everything here runs without a display and without real X11 tools: a scripted
subprocess seam records argv and returns canned tool output, the golden
xwininfo tree fixture follows the exact xwininfo -root -tree -int output
format (verified against the upstream xwininfo.c printfs, including child
count lines, raw unescaped window names, and the trailing geometry pair),
and the generated fixtures exercise the observation caps. Like tests/fakes,
this module pins the test run to this worktree's own src tree.
"""

from __future__ import annotations

import contextlib
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from typing import Any, Iterator
from unittest import mock

SKILL_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = SKILL_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

TOOL_NAMES = ("xdotool", "xwininfo", "maim", "scrot")

XWININFO_ROOT_TREE = "\n".join(
    [
        "",
        "xwininfo: Window id: 63 (the root window) (has no name)",
        "",
        "  Root window id: 63 (the root window) (has no name)",
        "  Parent window id: 0 (none)",
        "     4 children:",
        '     104 "Notes: draft (v2)": ("notes" "Notes")  800x600+100+80  +100+80',
        "        1 children:",
        '        105 (has no name): ("notes" "Notes")  700x500+10+30  +110+110',
        '     220 "Slack - engineering": ("slack" "Slack")  1024x768+1920+0  +1920+0',
        "        1 children:",
        '        221 (has no name): ("slack" "Slack")  1000x700+12+40  +1932+40',
        "           1 children:",
        '           222 "terminal": ("xterm" "XTerm")  640x480-10-20  +1922+20',
        "     230 (has no name): ()  1x1+0+0  +0+0",
        '     240 "Ends: ("": ("weird" "Weird")  300x200+5+5  +5+5',
        '     250 (has no name): ("sh" "Sh")',
    ]
)


def minimal_png_bytes(width: int, height: int) -> bytes:
    """Build a minimal PNG header with the given IHDR dimensions."""
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
    )


def window_line(
    window_id: int,
    depth: int = 0,
    title: str | None = None,
    instance: str | None = None,
    res_class: str | None = None,
    width: int = 10,
    height: int = 10,
    rel_x: int = 0,
    rel_y: int = 0,
    abs_x: int | None = 0,
    abs_y: int | None = 0,
) -> str:
    """Build one realistic xwininfo tree line for a generated fixture."""
    indent = " " * (5 + 3 * depth)
    name = f' "{title}"' if title is not None else " (has no name)"
    if instance is None and res_class is None:
        klass = "()"
    else:
        instance_part = f'"{instance}"' if instance is not None else "(none)"
        class_part = f'"{res_class}"' if res_class is not None else "(none)"
        klass = f"({instance_part} {class_part})"
    geometry = f"  {width}x{height}+{rel_x}+{rel_y}"
    if abs_x is not None and abs_y is not None:
        geometry += f"  +{abs_x}+{abs_y}"
    return f"{indent}{window_id}{name}: {klass} {geometry}"


def chain_tree(root_id: int, length: int) -> str:
    """Build one nesting chain: root plus one child per depth level below it."""
    lines = [window_line(root_id)]
    for index in range(1, length + 1):
        lines.append(window_line(root_id + index, depth=index, title=f"node {index}"))
    return "\n".join(lines)


def flat_tree(root_id: int, children: int) -> str:
    """Build one window with the given number of direct children."""
    lines = [window_line(root_id)]
    for index in range(children):
        lines.append(window_line(root_id + 1000 + index, depth=1))
    return "\n".join(lines)


class X11Script:
    """Scripted subprocess.run seam: records every argv and answers with canned results.

    Rules match on the argv from index 1 (index 0 is the resolved tool path);
    the first matching rule answers, and an unmatched argv succeeds with
    empty output. A png rule writes a minimal PNG to the argv's last element.
    """

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.rules: list[dict[str, Any]] = []

    def on(
        self,
        *prefix: str,
        returncode: int = 0,
        stdout: bytes = b"",
        stderr: bytes = b"",
        png: tuple[int, int] | None = None,
        error: BaseException | None = None,
    ) -> None:
        """Queue one canned result for argv matching the given tail prefix."""
        self.rules.append(
            {
                "prefix": tuple(prefix),
                "returncode": returncode,
                "stdout": stdout,
                "stderr": stderr,
                "png": png,
                "error": error,
            }
        )

    def argvs(self, command: str | None = None) -> list[list[str]]:
        """Return the recorded argvs, optionally only those with the given subcommand."""
        if command is None:
            return self.calls
        return [argv for argv in self.calls if command in argv[1:]]

    def tool_calls(self, tool: str) -> list[list[str]]:
        """Return the recorded argvs run through the named tool, in order."""
        return [argv for argv in self.calls if Path(argv[0]).name == tool]

    def __call__(self, argv: list[str], capture_output: bool = True, timeout: float | None = None) -> Any:
        self.calls.append(list(argv))
        tail = tuple(argv[1:])
        for rule in self.rules:
            if tail[: len(rule["prefix"])] != rule["prefix"]:
                continue
            if rule["error"] is not None:
                raise rule["error"]
            if rule["png"] is not None:
                target = Path(argv[-1])
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(minimal_png_bytes(*rule["png"]))
            return types.SimpleNamespace(
                returncode=rule["returncode"], stdout=rule["stdout"], stderr=rule["stderr"]
            )
        return types.SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    def xwininfo_tree(self, output: str) -> None:
        """Serve one xwininfo root-tree output; a later call replaces the served tree."""
        self.rules.insert(
            0,
            {
                "prefix": ("-root", "-tree", "-int"),
                "returncode": 0,
                "stdout": output.encode("utf-8"),
                "stderr": b"",
                "png": None,
                "error": None,
            },
        )


@contextlib.contextmanager
def fake_x11(script: X11Script | None = None, tools: tuple[str, ...] = TOOL_NAMES) -> Iterator[X11Script]:
    """Patch the linux backend's subprocess seam, tool resolution, and DISPLAY env.

    tools lists the tools present on PATH (resolved to /usr/bin/<name> for
    deterministic argv assertions); DISPLAY is set to a fake value.
    """
    from computer_use import _linux

    script = script or X11Script()
    patchers = [
        mock.patch.object(_linux.subprocess, "run", script),
        mock.patch.object(
            _linux.shutil, "which", lambda name: f"/usr/bin/{name}" if name in tools else None
        ),
        mock.patch.dict(os.environ, {"DISPLAY": ":42"}),
    ]
    for patcher in patchers:
        patcher.start()
    try:
        yield script
    finally:
        for patcher in patchers:
            patcher.stop()


def without_display() -> Any:
    """Patch DISPLAY to a blank value so seams see no X server."""
    return mock.patch.dict(os.environ, {"DISPLAY": ""})


@contextlib.contextmanager
def linux_app_environment(
    script: X11Script | None = None,
    *,
    allowed: tuple[str, ...] = ("Notes", "Slack"),
    blocked: tuple[str, ...] = (),
    tree: str = XWININFO_ROOT_TREE,
) -> Iterator[X11Script]:
    """Patch the App layer for linux end-to-end tests on a scripted X11 server.

    backend() reports linux, the compat loader the App dispatches through
    returns the real _linux module running on the scripted X11 server,
    policy reads a fixture settings file, the screen reads unlocked, and the
    App-layer module state (bound apps, shown instructions) resets around the
    test. The mac modules are never touched.
    """
    import computer_use
    from computer_use import _linux, policy

    import fakes

    script = script or X11Script()
    script.xwininfo_tree(tree)
    settings_tmp = tempfile.TemporaryDirectory()
    settings_path = fakes.write_settings(settings_tmp.name, allowed=allowed, blocked=blocked)
    patchers = [
        mock.patch.object(_linux.subprocess, "run", script),
        mock.patch.object(_linux.shutil, "which", lambda name: f"/usr/bin/{name}"),
        mock.patch.dict(os.environ, {"DISPLAY": ":42"}),
        mock.patch.object(computer_use, "_backend", lambda: "linux"),
        mock.patch.object(computer_use, "_require_linux", lambda: _linux),
        mock.patch.object(policy, "SETTINGS_PATH", settings_path),
        mock.patch.object(policy, "_screen_locked", lambda: False),
        mock.patch.dict(computer_use._bound_apps, {}, clear=True),
        mock.patch.object(computer_use, "_instruction_shown", set()),
    ]
    for patcher in patchers:
        patcher.start()
    try:
        yield script
    finally:
        for patcher in patchers:
            patcher.stop()
        settings_tmp.cleanup()
