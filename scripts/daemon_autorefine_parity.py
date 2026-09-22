#!/usr/bin/env python3
"""Compact-trigger auto-refine parity on the daemon surface: after the
`compact` wire command, TS schedules the auto-refine review
(agent-session.ts `_scheduleAutoRefineAfterCompaction` ->
`_scheduleAutoRefine("compact")` -> `_maybeAutoRefine("compact")`), and
the Rust daemon worker now does the same
(pa-daemon/src/compact_autorefine.rs). The review is an LLM request the
mock provider sees, so the two sides are differentially compared on:

  - the compact command response (success, same result keys),
  - exactly one review request per side, whose shape must match:
    the review system prompt (the "automatic /refine review gate") and
    the trigger line ("compact; N assistant turns since last
    auto-refine review" with the same settled-turn count),
  - no `refine_complete`/`refine_failed` wire event on either side
    (the mock's plain-text reply fails the review JSON parse; both
    surfaces treat that as a silent failure that stamps the cooldown),
  - a follow-up prompt still answers on both sides (the session is
    healthy after the round).

Exit code is non-zero when any check fails; evidence lands in the run
dir given by --out (default a tempdir under /tmp).
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib as B  # noqa: E402
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

TURNS = 6
TURN_TEXT = "Turn {n} of the parity battery. " * 800
REVIEW_SYSTEM_MARKER = "automatic /refine review gate"
TRIGGER_PREFIX = "<trigger>"
COMPACT_TIMEOUT = 240


def message_text(message):
    """One request message's text content (list-of-blocks or string)."""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block.get("text", "") for block in content if isinstance(block, dict)
        )
    return ""


def review_request(log):
    """The auto-refine review request in a mock request log, if any."""
    for record in log:
        body = record.get("body", {})
        messages = body.get("messages", [])
        system_text = "\n".join(
            message_text(message)
            for message in messages
            if message.get("role") == "system"
        )
        for message in messages:
            text = message_text(message)
            if text.startswith(TRIGGER_PREFIX):
                return {
                    "trigger_line": text.split("</trigger>")[0]
                    .removeprefix(TRIGGER_PREFIX)
                    .strip("\n")
                    .strip(),
                    "system_is_review_gate": REVIEW_SYSTEM_MARKER in system_text,
                    "harness_state_block": "<current_harness_state>"
                    in text,
                }
    return None


def run_side(name, binary, root, pi_package_dir=None):
    agent = root / "agent"
    agent.mkdir(parents=True, exist_ok=True)
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": "hello"}])
    mock.start()
    side = B.Side(
        name=name,
        binary=str(binary),
        root=root,
        agent_dir=agent,
        work_dir=work,
        daemon_socket=root / "daemon.sock",
        mock=mock,
    )
    tmpdir = Path("/tmp") / f"autorefine-parity-{name}-{root.name}"
    if tmpdir.exists():
        import shutil

        shutil.rmtree(tmpdir)
    tmpdir.mkdir(parents=True)
    side.env = B.scrubbed_env(agent, tmpdir)
    if pi_package_dir:
        # The Rust binary resolves the kernel runtime sidecar through
        # PI_PACKAGE_DIR (a cargo build bakes a nonexistent source path).
        side.env["PI_PACKAGE_DIR"] = pi_package_dir
    side.write_models_json()
    side.start_daemon()
    try:
        wire = B.Wire(side.daemon_socket)
        create = wire.request(
            "c1",
            {
                "type": "create",
                "name": f"autorefine-parity-{name}",
                "config": {
                    "cwd": str(work),
                    "sessionDir": str(agent / "sessions"),
                    "provider": "prime-inference",
                    "model": "mock-1",
                    "executionMode": "print",
                },
            },
            timeout=120,
        )
        assert create.get("success") is True, f"{name}: create failed: {create}"
        session_id = (
            create.get("data", {}).get("activeSessionId")
            or create.get("data", {}).get("id")
            or ""
        )
        # An attached client receives the session events (the review
        # failure must stay silent on the wire on both sides).
        attacher = B.Wire(side.daemon_socket)
        attach = attacher.request(
            "a1", {"type": "attach", "activeSessionId": session_id}, timeout=60
        )
        assert attach.get("success") is True, f"{name}: attach failed: {attach}"
        mock.set_responses(
            [{"text": f"pre-compaction reply {i}"} for i in range(TURNS + 8)]
        )
        for turn in range(1, TURNS + 1):
            reply = wire.request(
                f"p{turn}",
                {
                    "type": "prompt_and_wait",
                    "activeSessionId": session_id,
                    "message": TURN_TEXT.format(n=turn),
                },
                timeout=240,
            )
            assert reply.get("success") is True, f"{name}: prompt {turn} failed"
        compact = wire.request(
            "k1",
            {"type": "compact", "activeSessionId": session_id},
            timeout=COMPACT_TIMEOUT,
        )
        # Let the background round settle (the review is scheduled after
        # the compaction answers).
        deadline = time.time() + 30
        while time.time() < deadline:
            log = mock.requests()
            if any(
                record.get("body", {}).get("messages")
                and any(
                    isinstance(block, dict)
                    and block.get("text", "").startswith(TRIGGER_PREFIX)
                    for message in record["body"]["messages"]
                    for block in message.get("content", []) or []
                )
                for record in log
            ):
                break
            time.sleep(0.5)
        time.sleep(2)
        # A second compact within the review cooldown: both sides stamped
        # the cooldown on the first review attempt (the mock's plain-text
        # reply fails the review JSON parse, which every attempt stamps),
        # so no second review request may run.
        second = wire.request(
            "k2",
            {"type": "compact", "activeSessionId": session_id},
            timeout=COMPACT_TIMEOUT,
        )
        time.sleep(3)
        review_count = sum(
            1
            for record in mock.requests()
            if any(
                message_text(message).startswith(TRIGGER_PREFIX)
                for message in record.get("body", {}).get("messages", [])
            )
        )
        # Drain any queued wire events (best-effort; the socket stays
        # open, so only a bounded window is read).
        time.sleep(2)
        wire.close()
        attacher.close()
        return {
            "compact_success": compact.get("success") is True,
            "compact_data_keys": sorted((compact.get("data") or {}).keys()),
            "compact_result": (compact.get("data") or {}).get("result"),
            "review": review_request(mock.requests()),
            "second_compact_success": second.get("success") is True,
            "review_count": review_count,
        }
    finally:
        side.stop_daemon()
        mock.stop()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument(
        "--rust-bin",
        default=os.environ.get(
            "PA_PARITY_RUST",
            str(
                Path(__file__).resolve().parents[1]
                / "target"
                / "debug"
                / "prime-agent"
            ),
        ),
    )
    parser.add_argument(
        "--out",
        default=None,
        help="evidence dir (default: scripts/battery/runs/<stamp>-autorefine)",
    )
    parser.add_argument(
        "--pi-package-dir",
        default=os.environ.get("PI_PACKAGE_DIR", "/home/ubuntu/.local/share/prime-agent"),
    )
    options = parser.parse_args()
    ts_identity.assert_ts_side_is_the_ts_product(options.ts_bin, options.rust_bin)
    if not Path(options.rust_bin).exists():
        print(f"rust binary missing: {options.rust_bin}")
        return 2
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = Path(options.out) if options.out else (
        Path(__file__).resolve().parents[1]
        / "scripts"
        / "battery"
        / "runs"
        / f"{stamp}-autorefine"
    )
    out.mkdir(parents=True, exist_ok=True)

    ts_result = run_side("ts", options.ts_bin, out / "ts")
    (out / "ts" / "result.json").write_text(json.dumps(ts_result, indent=1))
    rust_result = run_side(
        "rust", options.rust_bin, out / "rust", pi_package_dir=options.pi_package_dir
    )
    (out / "rust" / "result.json").write_text(json.dumps(rust_result, indent=1))

    failures = []

    def check(name, condition, detail=""):
        print(("PASS " if condition else "FAIL ") + name + (f" :: {detail}" if detail else ""))
        if not condition:
            failures.append(name)

    check("both compacts succeeded", ts_result["compact_success"] and rust_result["compact_success"])
    check(
        "compact result keys match",
        ts_result["compact_data_keys"] == rust_result["compact_data_keys"],
        f"ts={ts_result['compact_data_keys']} rust={rust_result['compact_data_keys']}",
    )
    check("both sides scheduled the review", ts_result["review"] and rust_result["review"])
    if ts_result["review"] and rust_result["review"]:
        check(
            "the review trigger line matches",
            ts_result["review"]["trigger_line"] == rust_result["review"]["trigger_line"],
            f"ts={ts_result['review']['trigger_line']!r} rust={rust_result['review']['trigger_line']!r}",
        )
        check(
            "both review requests use the review-gate system prompt",
            ts_result["review"]["system_is_review_gate"]
            and rust_result["review"]["system_is_review_gate"],
        )
        check(
            "both review prompts carry the harness state",
            ts_result["review"]["harness_state_block"]
            and rust_result["review"]["harness_state_block"],
        )
    check(
        "the second compact answers identically on both sides",
        ts_result["second_compact_success"] == rust_result["second_compact_success"],
        f"ts={ts_result['second_compact_success']} rust={rust_result['second_compact_success']}",
    )
    check(
        "the cooldown holds the second round: one review per side",
        ts_result["review_count"] == 1 and rust_result["review_count"] == 1,
        f"ts={ts_result['review_count']} rust={rust_result['review_count']}",
    )
    print(f"evidence: {out}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
