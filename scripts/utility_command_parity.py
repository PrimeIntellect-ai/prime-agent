#!/usr/bin/env python3
"""Per-command live A/B parity captures for the utility-commands lane
(`/btw`, `/side`, `/fast`, `/fullscreen`, `/reload`, `/rlm-max-depth`,
`/scoped-models`, `/settings`, `/name`+`/rename`, `/thinking`).

Both binaries run in tmux against their own mock provider and daemon (the
battery's isolation rules): each command drives one scripted interaction,
the frame lands under scripts/battery/runs/<stamp>/utility-commands/<side>/,
and the normalized frames byte-diff per command.

One-command re-run (from the repo root):

    python3 scripts/utility_command_parity.py [--ts-bin PATH] [--rust-bin PATH]

The Rust binary defaults to target/release/prime-agent.
"""

from __future__ import annotations

import argparse
import datetime
import difflib
import json
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "battery"))
import batterylib as B  # noqa: E402
import perf as P  # noqa: E402

FLOW = "utility-commands"


def normalize_frame(frame: str, side: B.Side) -> str:
    """Strip the volatile frame contents: versions, paths, ids, timestamps,
    and the usage/cost label (the Rust debug build reports 0.0.0)."""
    text = frame
    # Version labels (the TS release vs the Rust 0.0.0 build), paths, ids,
    # and cost figures are the volatile frame contents.
    text = re.sub(r"v\d+\.\d+\.\d+", "v<version>", text)
    home = str(Path.home())
    text = text.replace(str(side.work_dir), "<work>")
    # The TS product abbreviates the home prefix as `~`.
    text = text.replace("~/" + str(side.work_dir.relative_to(home)), "<work>")
    text = text.replace(str(side.agent_dir), "<agent>")
    text = text.replace(str(side.root), "<run>")
    text = re.sub(r"\$[0-9]+\.[0-9]+", "$<cost>", text)
    # Session ids and the elapsed clock digits on loaders.
    text = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<uuid>", text)
    # Layout noise: the TS inline surface appends rows into native
    # scrollback while the Rust surface repaints a fixed fullscreen frame,
    # so blank padding differs. The content sequence (non-blank rows) is
    # the comparable artifact.
    return "\n".join(
        line.rstrip() for line in text.splitlines() if line.strip()
    )


class UtilityParity:
    def __init__(self, ts_bin: str, rust_bin: str):
        self.stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.run_dir = Path(__file__).resolve().parents[1] / "scripts" / "battery" / "runs" / self.stamp
        self.run_dir.mkdir(parents=True)
        self.ts_bin = ts_bin
        self.rust_bin = rust_bin
        self.runid = "util" + self.stamp
        self.sides: dict[str, B.Side] = {}
        self.findings: list[dict] = []

    def make_side(self, name: str, binary: str) -> B.Side:
        root = self.run_dir / name
        root.mkdir(parents=True, exist_ok=True)
        agent = root / "agent"
        work = root / "work"
        work.mkdir(parents=True, exist_ok=True)
        if agent.exists():
            shutil.rmtree(agent)
        agent.mkdir(parents=True)
        mock = B.MockProvider(root, [])
        mock.set_responses([{"text": "the mock side answer"}])
        mock.start()
        tmpdir = Path("/tmp") / f"{self.runid}-{name}"
        if tmpdir.exists():
            shutil.rmtree(tmpdir)
        tmpdir.mkdir(parents=True)
        side = B.Side(
            name=name,
            binary=binary,
            root=root,
            agent_dir=agent,
            work_dir=work,
            daemon_socket=root / "daemon.sock",
            mock=mock,
        )
        side.env = B.scrubbed_env(agent, tmpdir)
        if name == "rust":
            side.env["PI_PACKAGE_DIR"] = str(Path(__file__).resolve().parents[1])
        side.env["PRIME_API_KEY"] = "sk-battery"
        side.write_models_json()
        self.sides[name] = side
        return side

    def evidence(self, side: B.Side, name: str, frame: str) -> None:
        (side.root / FLOW).mkdir(parents=True, exist_ok=True)
        (side.root / FLOW / name).write_text(frame)

    def record(self, summary: str, command: str, gap: bool) -> None:
        self.findings.append({"command": command, "summary": summary, "gap": gap})

    def launch(self, side: B.Side) -> str:
        """One settled interactive pane per side; every command drives it."""
        session = f"{self.runid}-{side.name}"
        argv = P.launch_argv(side, side.daemon_socket)
        B.tmux_launch(session, argv, side.env, side.work_dir)
        # A fresh install shows the trace-sharing notice on the TS side: press
        # through like the battery's f1 (Down + Enter = Not now).
        frame = B.tmux_wait_text(session, "Share agent traces|>|manage", timeout=30)
        if "Share agent traces" in frame:
            B.tmux_send(session, "Down")
            time.sleep(0.5)
            B.tmux_send(session, "Enter")
            time.sleep(2.0)
        # Wait for the settled main screen (two identical frames).
        deadline = time.time() + 30
        stable = False
        while time.time() < deadline and not stable:
            first = B.tmux_capture(session)
            time.sleep(1.5)
            second = B.tmux_capture(session)
            stable = first == second and (">" in first or "manage" in first)
        if not stable:
            self.record(f"{side.name}: TUI never reached a stable main screen", "launch", gap=True)
        return session

    def run_command(self, side: B.Side, session: str, steps: list[tuple[str, str]], name: str) -> str:
        """Send one command's keys, waiting for `settle` between them; the
        final frame is the capture."""
        for keys, settle in steps:
            B.tmux_send(session, keys, enter=keys != "Escape")
            time.sleep(settle)
        return B.tmux_capture(session)

    def run(self) -> int:
        for name, binary in (("ts", self.ts_bin), ("rust", self.rust_bin)):
            self.make_side(name, binary)
        frames: dict[str, dict[str, str]] = {"ts": {}, "rust": {}}
        for side_name in ("ts", "rust"):
            side = self.sides[side_name]
            session = self.launch(side)
            # /name + /rename: set through the alias, then report.
            frames[side_name]["name-set"] = self.run_command(
                side,
                session,
                [("/rename parity session", 1.5), ("/name", 2.0)],
                "name",
            )
            # /rlm-max-depth: view, then set.
            frames[side_name]["rlm-max-depth-view"] = self.run_command(
                side, session, [("/rlm-max-depth", 2.0)], "rlm-max-depth"
            )
            frames[side_name]["rlm-max-depth-set"] = self.run_command(
                side, session, [("/rlm-max-depth 3", 2.0)], "rlm-max-depth"
            )
            # /fast: the mock model is not fast-mode eligible, so the TS
            # unavailable status row shows on both sides.
            frames[side_name]["fast"] = self.run_command(
                side, session, [("/fast", 2.0)], "fast"
            )
            # /fullscreen: off then on — the persisted-preference status rows.
            frames[side_name]["fullscreen-off"] = self.run_command(
                side, session, [("/fullscreen off", 2.0)], "fullscreen"
            )
            frames[side_name]["fullscreen-on"] = self.run_command(
                side, session, [("/fullscreen on", 2.0)], "fullscreen"
            )
            # /reload: the guarded reload + outcome status.
            frames[side_name]["reload"] = self.run_command(
                side, session, [("/reload", 3.0)], "reload"
            )
            # /btw: the side-question pane, a follow-up, the notice, and esc.
            frames[side_name]["btw"] = self.run_command(
                side,
                session,
                [
                    ("/btw what is the mock answer", 4.0),
                    ("and follow up please", 4.0),
                    ("/model", 1.5),
                    ("Escape", 1.5),
                ],
                "btw",
            )
            # /settings: the menu frame, one row change, then esc.
            frames[side_name]["settings"] = self.run_command(
                side,
                session,
                [("/settings", 2.0), ("Enter", 1.5), ("Escape", 1.5)],
                "settings",
            )
            # /scoped-models: the selector frame, a toggle, then esc.
            frames[side_name]["scoped-models"] = self.run_command(
                side,
                session,
                [
                    ("/scoped-models", 2.0),
                    ("Enter", 1.5),
                    ("Escape", 1.5),
                ],
                "scoped-models",
            )
            # /thinking: the alias opens the effort surface.
            frames[side_name]["thinking"] = self.run_command(
                side,
                session,
                [("/thinking", 2.0), ("Escape", 1.5)],
                "thinking",
            )
            for capture_name, frame in frames[side_name].items():
                self.evidence(side, f"{capture_name}.txt", frame)
            B.tmux_kill(session)
            side.mock.stop()

        # Compare: normalized frames per command.
        report = [f"# Utility-command parity run {self.stamp}", ""]
        gaps = 0
        for capture_name in frames["ts"]:
            ts_text = normalize_frame(frames["ts"][capture_name], self.sides["ts"])
            rust_text = normalize_frame(frames["rust"][capture_name], self.sides["rust"])
            diff = list(
                difflib.unified_diff(
                    ts_text.splitlines(), rust_text.splitlines(), "ts", "rust", lineterm="", n=1
                )
            )
            match = not diff
            if not match:
                gaps += 1
            self.record(
                f"{capture_name}: {'identical (normalized)' if match else 'frames differ'}",
                capture_name,
                gap=not match,
            )
            report.append(f"## {capture_name}")
            report.append("")
            report.append(f"- ts: `{FLOW}/{capture_name}.txt`")
            report.append(f"- rust: `{FLOW}/{capture_name}.txt`")
            report.append(f"- verdict: {'match' if match else 'DIFF'}")
            if not match:
                report.append("")
                report.append("```diff")
                report.extend(diff[:40])
                report.append("```")
            report.append("")
        (self.run_dir / "utility-commands-report.md").write_text("\n".join(report) + "\n")
        (self.run_dir / "utility-commands-findings.json").write_text(
            json.dumps({"stamp": self.stamp, "findings": self.findings}, indent=2) + "\n"
        )
        print(f"frames: {self.run_dir}")
        for finding in self.findings:
            mark = "GAP " if finding["gap"] else "PASS"
            print(f"[{mark}] {finding['command']}: {finding['summary']}")
        print(f"report: {self.run_dir / 'utility-commands-report.md'}")
        return 1 if gaps else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument(
        "--rust-bin", default=str(Path(__file__).resolve().parents[1] / "target" / "release" / "prime-agent")
    )
    args = parser.parse_args()
    return UtilityParity(args.ts_bin, args.rust_bin).run()


if __name__ == "__main__":
    raise SystemExit(main())
