#!/usr/bin/env python3
"""Real-binary settings frames and key behavior: pinned TS, base Rust, PR Rust.

Uses isolated model/settings directories and the existing schema-aware loopback
supervisor. No model requests or production daemon/state are used. Raw ANSI,
cell frames, command observations, settings, and frame diffs remain auditable.
"""
import argparse
import difflib
import json
import os
from pathlib import Path
import sys
import tempfile

from review_draft_disconnect_parity import (
    Supervisor, Terminal, TS_ARCHIVE_SHA256, actual_hello, digest, env_for,
)


class SettingsSupervisor(Supervisor):
    """Add the existing reload response to the shared supervisor fixture."""
    def send(self, sock, data):
        if data.get("type") == "response" and data.get("command") == "reload":
            expected = "unexpected command: reload"
            if expected in self.errors:
                self.errors.remove(expected)
            data = dict(data, success=True, data={})
            data.pop("error", None)
        super().send(sock, data)


def settings(root):
    return json.loads((root / "agent/settings.json").read_text())


def row_has(terminal, label, value):
    return any(label in line and value in line for line in terminal.screen.text().splitlines())


def capture(kind, binary, root, artifacts):
    root.mkdir()
    env = env_for(root, "ts" if kind == "ts" else "rust")
    hello = actual_hello(binary, root, env)
    server = SettingsSupervisor(root / "fixture.sock", hello, "control", root)
    terminal = None
    result = {"kind": kind, "binary_sha256": digest(binary), "frames": {}, "shared_actions": [],
              "intended_extension": kind == "pr"}
    # Saved state is never deleted by the frontend toggle.
    saved = root / "agent/harness/harness_state.json"
    saved.parent.mkdir()
    saved.write_text('{"schema":1,"entries":{},"refinements":[]}')
    saved_before = saved.read_bytes()
    try:
        terminal = Terminal([str(binary), "--daemon-socket", str(server.path)], root, env)
        terminal.wait("initial attach", lambda: server.attaches >= 1 and bool(terminal.screen.text().strip()), server)

        def frame(name):
            text = terminal.screen.text().replace(str(root), "<fixture>")
            result["frames"][name] = text
            (artifacts / f"{kind}-{name}.txt").write_text(text)

        def open_menu():
            terminal.send("/settings")
            terminal.wait("settings command visible", lambda: "/settings" in terminal.screen.text(), server)
            terminal.send("\r")
            terminal.wait("settings menu", lambda: "Auto-compact" in terminal.screen.text() and
                          "Type to search" in terminal.screen.text(), server)

        open_menu()
        frame("default-settings")
        terminal.send("quiet")
        terminal.wait("quiet setting search", lambda: any(line.rstrip().endswith("quiet") for line in terminal.screen.text().splitlines()) and
                      "Quiet startup" in terminal.screen.text(), server)
        frame("quiet-before")
        for value in (True, False):
            terminal.send("\r")
            terminal.wait(f"quiet persisted {value}", lambda: settings(root).get("quietStartup") is value, server)
            terminal.wait(f"quiet rendered {value}", lambda: row_has(terminal, "Quiet startup", str(value).lower()), server)
            result["shared_actions"].append({"key": "Enter", "quietStartup": value, "visible_value": str(value).lower()})
            frame(f"quiet-{str(value).lower()}")
        terminal.send("\x1b")
        terminal.wait("menu closed", lambda: "Quiet startup" not in terminal.screen.text(), server)
        if kind in ("base", "pr"):
            open_menu()
            terminal.send("5")
            terminal.wait("Agents tab", lambda: "Skill commands" in terminal.screen.text(), server)
            frame("agents-default")
            result["harness_row_present"] = "Harness refinements" in terminal.screen.text()
            if kind == "pr":
                if not row_has(terminal, "Harness refinements", "true"):
                    raise AssertionError("new toggle must render enabled by default")
                terminal.send("harness")
                terminal.wait("harness search", lambda: any(line.rstrip().endswith("harness") for line in terminal.screen.text().splitlines()) and
                              row_has(terminal, "Harness refinements", "true"), server)
                for value in (False, True):
                    terminal.send("\r")
                    terminal.wait(f"harness persisted {value}", lambda: settings(root).get("harnessRefinements") is value, server)
                    terminal.wait(f"harness rendered {value}", lambda: row_has(terminal, "Harness refinements", str(value).lower()), server)
                    frame(f"harness-{str(value).lower()}")
                terminal.send("\x1b")
                terminal.wait("harness menu closed", lambda: "Harness refinements" not in terminal.screen.text(), server)
                # Reopening verifies the persisted value is read by the normal settings seam.
                open_menu()
                terminal.send("5")
                terminal.wait("persisted harness enabled on reopen", lambda: row_has(terminal, "Harness refinements", "true"), server)
                frame("harness-reopened")
        result["saved_state_unchanged"] = saved.read_bytes() == saved_before
        result["settings"] = settings(root)
        result["commands"] = server.commands
        result["success"] = True
    except Exception as error:
        result["success"] = False
        result["error"] = f"{type(error).__name__}: {error}"
        if terminal is not None:
            result["failure_frame"] = terminal.screen.text()
    finally:
        if terminal is not None:
            (artifacts / f"{kind}.ansi").write_bytes(terminal.raw)
            terminal.close()
        server.close()
    return result


def comparison(results, artifacts):
    errors = []
    for kind, result in results.items():
        if not result.get("success"):
            errors.append(f"{kind}: {result.get('error')}")
        if not result.get("saved_state_unchanged"):
            errors.append(f"{kind}: saved harness state changed")
    expected = [{"key": "Enter", "quietStartup": value, "visible_value": str(value).lower()} for value in (True, False)]
    for kind in ("ts", "base", "pr"):
        if results[kind]["shared_actions"] != expected:
            errors.append(f"{kind}: shared Enter toggle contract did not match")
    diffs = {}
    for frame in ("default-settings", "quiet-before", "quiet-true", "quiet-false", "agents-default"):
        base = results["base"]["frames"].get(frame, "")
        pr = results["pr"]["frames"].get(frame, "")
        diff = "\n".join(difflib.unified_diff(base.splitlines(), pr.splitlines(), fromfile="base", tofile="pr", lineterm=""))
        diffs[f"base-vs-pr/{frame}"] = diff
        (artifacts / f"base-vs-pr-{frame}.diff").write_text(diff)
        if frame != "agents-default" and base != pr:
            errors.append(f"unexpected base-to-PR frame change: {frame}")
        if frame == "agents-default":
            without_new_row = "\n".join(line for line in pr.splitlines() if "Harness refinements" not in line)
            if base.rstrip() != without_new_row.rstrip():
                errors.append("Agents frame changed beyond the intended new row")
    for frame in ("default-settings", "quiet-before", "quiet-true", "quiet-false"):
        reference = results["ts"]["frames"].get(frame, "")
        base = results["base"]["frames"].get(frame, "")
        diff = "\n".join(difflib.unified_diff(reference.splitlines(), base.splitlines(), fromfile="TS-0.9.8", tofile="base-Rust", lineterm=""))
        diffs[f"ts-vs-base/{frame}"] = diff
        (artifacts / f"ts-vs-base-{frame}.diff").write_text(diff)
    if results["base"].get("harness_row_present") or not results["pr"].get("harness_row_present"):
        errors.append("the new Agents row is not isolated to the PR")
    return {"errors": errors, "passed": not errors, "frame_diffs": diffs,
            "scope": "Real rendered cell frames and shared Enter/persist/visible-value behavior. TS-to-base layout differences are retained, not normalized away. Base-to-PR unchanged surfaces must be equal; the new Agents row is an intentional extension. No daemon protocol changes or engine context equivalence are claimed by this UI fixture."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    receipt_path = args.receipt.resolve()
    artifacts = receipt_path.parent
    artifacts.mkdir(parents=True, exist_ok=True)
    receipt = {"head": os.environ.get("EXPECTED_HEAD"), "base": os.environ.get("BASE_SHA"), "results": {}}
    try:
        if sys.platform != "linux":
            raise RuntimeError("official pinned binary fixture requires Linux")
        archive = Path(os.environ["PA_TS_ARCHIVE"])
        receipt["ts_archive_sha256"] = digest(archive)
        if receipt["ts_archive_sha256"] != TS_ARCHIVE_SHA256:
            raise RuntimeError("official TS archive SHA-256 mismatch")
        with tempfile.TemporaryDirectory(prefix="pa-settings-parity-") as temp:
            for kind, key in (("ts", "PA_TS_BINARY"), ("base", "PA_BASE_BINARY"), ("pr", "PA_RUST_BINARY")):
                receipt["results"][kind] = capture(kind, Path(os.environ[key]).resolve(), Path(temp) / kind, artifacts)
        receipt["comparison"] = comparison(receipt["results"], artifacts)
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    passed = receipt.get("comparison", {}).get("passed", False)
    print(json.dumps({"receipt": str(receipt_path), "passed": passed, "error": receipt.get("error"),
                      "comparison_errors": receipt.get("comparison", {}).get("errors", [])}))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
