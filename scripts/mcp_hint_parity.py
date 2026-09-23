#!/usr/bin/env python3
"""`/plugins` vs `/mcp` pinned-definition hint parity verifier.

The MCP catalog-source-unavailable hint (`service-catalog.ts:1081,1102` in
TS, `catalog_plugin_views.rs` in the Rust port) claims a connection record
outlived its catalog entry. The claim is honest only when a validated
remote catalog snapshot is in hand to PROVE the service is gone — TS always
has its catalog (compiled into the deployed release), so it never claims
absence it cannot prove; the Rust port falls silent when it has no snapshot
(the fetch never ran, failed, or the bundled asset is missing).

The gating matrix, driven like a user in tmux on both products with the
SAME seeded fixtures (a pending `linear` record whose service IS in the
catalog, and a pending `vanished-fixture` record whose service is in NO
source):

+---------------------------+--------------------+------------------+
| cell                      | surface            | expected hint    |
+---------------------------+--------------------+------------------+
| ts_vanished               | /plugins picker    | SHOWN, byte-     |
|                           | (compiled catalog) | exact TS string  |
| ts_linear                 | /plugins picker    | hidden           |
| rust_vanished_cached      | /mcp view (the     | SHOWN, byte-     |
|                           | snapshot cache)    | exact TS string  |
| rust_linear_cached        | /mcp view          | hidden           |
| rust_vanished_uncached    | /mcp view (no      | hidden (the fix: |
|                           | snapshot at all)   | no provable      |
|                           |                    | absence, no hint)|
| rust_linear_uncached      | /mcp view          | hidden           |
+---------------------------+--------------------+------------------+

Every cell also asserts the row itself: the pinned row keeps its label
("Vanished Fixture") and stays `Not connected`; the resolved linear row
stays `Needs verification` with its catalog description as the detail.
The vanished row's line and the hint line are byte-compared across the
two products (identical wording, placement, and timing is the lane's
parity bar).

Frames land in --out-dir (one .txt per cell) plus report.txt; the exit
code is non-zero when any expectation fails.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

WIDTH, HEIGHT = 140, 40

#: The hint under test, byte-exact (TS `service-catalog.ts:1082`); the
#: picker renders its detail line with one leading space.
HINT = "This service's catalog source is unavailable; its connection keeps the pinned definition."
HINT_LINE = " " + HINT

#: TS 0.9.5 compiled-catalog linear description prefix (the resolved row's
#: detail line).
LINEAR_DESCRIPTION_PREFIX = "Search, create and update Linear issues"

#: The two pending connection records, byte-identical on both products:
#: `linear` resolves against the catalog; `vanished-fixture` is in NO source.
RECORDS = {
    "version": 1,
    "connections": {
        "linear": {
            "connectionId": "linear",
            "serviceId": "linear",
            "endpoint": "https://mcp.linear.app/mcp",
            "label": "Linear",
            "status": "pending",
            "createdAt": 1,
            "updatedAt": 1,
        },
        "vanished-fixture": {
            "connectionId": "vanished-fixture",
            "serviceId": "vanished-fixture",
            "endpoint": "https://vanished.example/mcp",
            "label": "Vanished Fixture",
            "status": "pending",
            "createdAt": 1,
            "updatedAt": 1,
        },
    },
}

#: The fetch lane's snapshot envelope (pa-models `SnapshotFile`, the TS
#: `CatalogCache` disk form): this catalog url, public scope, any age.
CATALOG_URL = (
    "https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog"
    "/main/plugins/catalog.v2.json"
)
FETCHED_AT = 1_790_082_036_135

#: The repo-relative fixture the pa-core/e2e parity corpus already pins:
#: the real catalog document, so the cached side's roster byte-matches the
#: deployed TS release's compiled catalog.
FIXTURE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "crates", "pa-core", "tests", "fixtures", "mcp", "plugins-catalog.v2.json",
)

#: The faux provider contract (visual_parity's TS_SCRIPT_MODEL): both
#: products boot against a scripted provider with zero turns — the /plugins
#: and /mcp surfaces read the service catalog and the records, never the
#: model.
FAUX_MODEL = "faux-1"
FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "responses": [],
}


def tmux(*args, check=True):
    result = subprocess.run(["tmux", *args], capture_output=True, text=True, check=False)
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def ansi_stripped(text: str) -> str:
    text = re.sub(r"\x1b\][^\x07]*(\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[()][0-9A-B]", "", text)
    return text


def capture(session: str) -> str:
    # Plain `-p` (tmux's rendered text): escape sequences are dropped by
    # tmux itself. `-p -e` instead splits an escape sequence at a wrapped
    # line boundary and strands its tail in the captured text (observed:
    # the splash's colorized "prime agent \x1b[38;2;16" line), corrupting
    # every byte-level assertion downstream.
    raw = tmux("capture-pane", "-t", session, "-p")
    lines = [ansi_stripped(line).rstrip() for line in raw.splitlines()]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def wait_for(session: str, needle: str, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in capture(session):
            return
        time.sleep(0.4)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def launch(session: str, agent_dir: str, command: str, tmp_dir: str) -> None:
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", str(WIDTH), "-y", str(HEIGHT))
    time.sleep(0.5)
    os.makedirs(tmp_dir, exist_ok=True)
    # TMPDIR must stay SHORT: the daemon's per-session worker sockets land in
    # `<TMPDIR>/prime-agent-<uid>/worker-<id>.sock`, and a unix domain socket
    # path caps at 108 bytes (observed: `listen EINVAL` with the deep
    # worktree path; the battery sandboxes live under short /tmp paths for
    # the same reason). Keep it private to this worktree, just shallow.
    socket_probe = os.path.join(tmp_dir, "prime-agent-1000", "worker-xxxxxxxxxxxx-yyyyyyyyyyyy.sock")
    if len(socket_probe) >= 108:
        raise RuntimeError(
            f"TMPDIR {tmp_dir} is too deep for the worker unix sockets ({len(socket_probe)} >= 108)"
        )
    env = (
        f"HOME={agent_dir}/home TMPDIR={tmp_dir} "
        f"PRIME_AGENT_CODING_AGENT_DIR={agent_dir} "
        f"PRIME_AGENT_DISABLE_ANALYTICS=1 {command}"
    )
    tmux("send-keys", "-t", session, env, "Enter")


def close(session: str) -> None:
    tmux("send-keys", "-t", session, "Escape")
    time.sleep(1.0)


def capture_cell(session: str, command: str, query: str, row_label: str, out_dir: str, name: str) -> str:
    """Open the picker/view, type the query, wait for the row, capture."""
    tmux("send-keys", "-t", session, command, "Enter")
    time.sleep(1.5)
    tmux("send-keys", "-t", session, query)
    wait_for(session, row_label, 20.0)
    time.sleep(1.0)
    frame = capture(session)
    with open(os.path.join(out_dir, f"{name}.txt"), "w") as handle:
        handle.write(frame + "\n")
    close(session)
    return frame


def side_row(frame: str, label: str) -> str:
    """The rendered row line for `label` (the picker's MenuRow line)."""
    for line in frame.splitlines():
        if line.strip().startswith("›") and label in line:
            return line.rstrip()
    return ""


def hint_line(frame: str) -> str:
    """The rendered hint detail line, byte-exact, when present."""
    for line in frame.splitlines():
        if line.strip() == HINT:
            return line
    return ""


def lines_below_row(frame: str, row: str) -> list:
    """Every rendered line under `row` until the key hint."""
    lines = frame.splitlines()
    for index, line in enumerate(lines):
        if line == row:
            below = []
            for follow in lines[index + 1 :]:
                if "navigate" in follow and "close" in follow:
                    break
                below.append(follow)
            return below
    return []


def default_ts_binary() -> str:
    """The TS side's launch command. The deployed 0.9.5 release binary
    predates the service catalog (#2330): it has neither /plugins nor the
    pinned-definition hint. The parity ground truth is the TS-main CLI
    bundle in the read-only checkout (queue_edit_parity's rule); the
    deployed release is the fallback."""
    override = os.environ.get("PA_TS_BINARY")
    if override:
        return override
    ts_main_cli = os.path.join(
        "/home/ubuntu", "prime-agent", "packages", "coding-agent", "dist", "bundle", "cli.js"
    )
    if os.path.exists(ts_main_cli):
        return f"node {ts_main_cli}"
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    candidates = sorted(glob.glob(os.path.join(releases, "0.9.5-linux-x64-*", "prime-agent")))
    if not candidates:
        raise SystemExit("no TS-main checkout and no deployed 0.9.5 release; set PA_TS_BINARY")
    return candidates[-1]


def runtime_package_dir() -> str:
    """The installed TS release that ships prime-agent-runtime (the Rust
    kernel's sidecar). No release on this box carries a bundled
    mcp-services.bundled.json, so the uncached cell stays provably
    uncached."""
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    candidates = sorted(
        entry
        for entry in glob.glob(os.path.join(releases, "*"))
        if os.path.isdir(os.path.join(entry, "prime-agent-runtime"))
    )
    if not candidates:
        raise SystemExit("no release with prime-agent-runtime/ found; set PI_PACKAGE_DIR")
    return candidates[-1]


def short_tmp(side: str) -> str:
    """A worktree-private but SHALLOW TMPDIR (see launch): deep paths break
    the worker unix sockets with EINVAL."""
    base = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".pt"
    )
    return os.path.join(base, side)


def faux_script_path(agent_dir: str) -> str:
    """The faux script lives beside the side's agent dir (inside the
    harness's out-dir, never in the repo tree)."""
    return os.path.join(os.path.dirname(agent_dir), "faux-script.json")


def seed_agent_dir(agent_dir: str, cache: bool, ts_extension: bool) -> None:
    os.makedirs(os.path.join(agent_dir, "sessions"), exist_ok=True)
    os.makedirs(os.path.join(agent_dir, "home"), exist_ok=True)
    os.makedirs(os.path.join(agent_dir, "tmp"), exist_ok=True)
    os.makedirs(os.path.join(agent_dir, "extensions"), exist_ok=True)
    with open(os.path.join(agent_dir, "mcp-connections.json"), "w") as handle:
        json.dump(RECORDS, handle)
    if cache:
        with open(FIXTURE) as handle:
            payload = json.load(handle)
        with open(os.path.join(agent_dir, "mcp-service-catalog.v2.json"), "w") as handle:
            json.dump(
                {"url": CATALOG_URL, "scope": "public", "fetchedAt": FETCHED_AT, "payload": payload},
                handle,
            )
    # Onboarding must never appear: the trace-opt-in prompt (TS's final
    # onboarding question) and the telemetry notice would swallow the
    # /plugins and /mcp keys. Both products read the same settings keys
    # (TS-parity wire identifiers).
    with open(os.path.join(agent_dir, "settings.json"), "w") as handle:
        json.dump(
            {
                "onboardingShown": True,
                "agentTraces": {"enabled": True},
                "telemetry": {"noticeShown": True},
            },
            handle,
        )
    # The faux provider keeps the boot deterministic: no provider auth, no
    # model-catalog fetch, no kernel rebuild (the visual-parity battery
    # contract; the Rust build reads PRIME_AGENT_FAUX_SCRIPT natively, the
    # TS checkout through the shared ts_faux_extension.js sandbox driver).
    with open(faux_script_path(agent_dir), "w") as handle:
        json.dump(FAUX_SCRIPT, handle)
    if ts_extension:
        with open(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "ts_faux_extension.js"),
            encoding="utf-8",
        ) as handle:
            extension = handle.read()
        with open(os.path.join(agent_dir, "extensions", "mcp-hint-faux.js"), "w") as handle:
            handle.write(extension)


def run_ts(ts_binary: str, out_dir: str, results: list) -> None:
    agent_dir = os.path.join(out_dir, "ts-agent")
    os.makedirs(agent_dir, exist_ok=True)
    seed_agent_dir(agent_dir, cache=False, ts_extension=True)
    session = "mcp-hint-ts"
    launch(
        session,
        agent_dir,
        (
            f"PRIME_AGENT_FAUX_SCRIPT={faux_script_path(agent_dir)} "
            f"{ts_binary} --daemon-socket {agent_dir}/daemon.sock --model {FAUX_MODEL}"
        ),
        short_tmp("ts"),
    )
    # Mode-neutral settled-editor needle (queue_edit_parity's proven boot
    # marker): TS-main opens in Details mode, the Rust build in Collapsed
    # mode.
    wait_for(session, "mode (Ctrl+O to expand)", 120.0)
    time.sleep(2.0)
    try:
        results.append(("ts_vanished", capture_cell(session, "/plugins", "vanished", "Vanished Fixture", out_dir, "ts_vanished")))
        results.append(("ts_linear", capture_cell(session, "/plugins", "linear", "Linear", out_dir, "ts_linear")))
    finally:
        tmux("kill-session", "-t", session, check=False)


def run_rust(rust_binary: str, out_dir: str, results: list, cache: bool) -> None:
    suffix = "cached" if cache else "uncached"
    agent_dir = os.path.join(out_dir, f"rust-{suffix}-agent")
    os.makedirs(agent_dir, exist_ok=True)
    seed_agent_dir(agent_dir, cache=cache, ts_extension=False)
    session = f"mcp-hint-rs-{suffix}"
    package_dir = os.environ.get("PI_PACKAGE_DIR") or runtime_package_dir()
    launch(
        session,
        agent_dir,
        (
            f"PI_PACKAGE_DIR={package_dir} "
            f"PI_OFFLINE=1 "
            f"PRIME_AGENT_FAUX_SCRIPT={faux_script_path(agent_dir)} "
            f"{rust_binary} --daemon-socket {agent_dir}/daemon.sock --model {FAUX_MODEL}"
        ),
        short_tmp(suffix),
    )
    wait_for(session, "mode (Ctrl+O to expand)", 150.0)
    time.sleep(2.0)
    try:
        results.append(
            (
                f"rust_vanished_{suffix}",
                capture_cell(session, "/mcp", "vanished", "Vanished Fixture", out_dir, f"rust_vanished_{suffix}"),
            )
        )
        results.append(
            (
                f"rust_linear_{suffix}",
                capture_cell(session, "/mcp", "linear", "Linear", out_dir, f"rust_linear_{suffix}"),
            )
        )
    finally:
        tmux("kill-session", "-t", session, check=False)


def check_cell(name: str, frame: str, report: list) -> bool:
    """The matrix expectation for one cell. The row always stays; the hint
    only when the cell names it."""
    ok = True
    row = side_row(frame, "Vanished Fixture") if "vanished" in name else side_row(frame, "Linear")
    if not row:
        report.append(f"FAIL {name}: the row never rendered")
        return False
    # The pinned row is deterministic (never one-click connectable -> the
    # muted "Not connected"); the linear row's trailing status is
    # record/grant-state dependent (a fresh pending record without a
    # credential is the stale-connection state -> "Connect"), so it is
    # recorded for the frame diff rather than hard-asserted.
    expect_status = "Not connected" if "vanished" in name else None
    if expect_status and not row.endswith(expect_status):
        report.append(f"FAIL {name}: row {row!r} does not end with {expect_status!r}")
        ok = False
    else:
        report.append(f"ok   {name}: row {row.strip()!r}")
    hint = hint_line(frame)
    if "vanished" in name and ("uncached" not in name):
        if not hint:
            report.append(f"FAIL {name}: the pinned hint is MISSING")
            return False
        if hint != HINT_LINE:
            report.append(f"FAIL {name}: hint line {hint!r} != {HINT_LINE!r}")
            ok = False
        else:
            report.append(f"ok   {name}: hint line byte-exact {hint!r}")
    else:
        if hint:
            report.append(f"FAIL {name}: the hint must stay hidden, found {hint!r}")
            ok = False
        else:
            report.append(f"ok   {name}: hint hidden")
    if "linear" in name:
        # The resolved row's detail block carries the catalog description
        # (the Rust view renders a status-head line above it — the
        # sanctioned extension — so search the whole block).
        details = " ".join(line.strip() for line in lines_below_row(frame, row))
        if LINEAR_DESCRIPTION_PREFIX not in details:
            report.append(f"FAIL {name}: linear detail block {details!r} lacks the catalog description")
            ok = False
        else:
            report.append(f"ok   {name}: linear detail carries the catalog description")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rust-binary", help="path to the Rust prime-agent build")
    parser.add_argument("--ts-binary", help="path to the deployed TS release binary")
    parser.add_argument("--out-dir", required=True, help="directory for the captured frames and report")
    parser.add_argument("--side", choices=["both", "ts", "rust"], default="both")
    args = parser.parse_args()
    # Each product resolves only when this run drives it: a single-side
    # capture must not exit before launching when the unselected product is
    # unavailable (the identity guard compares the pair, so it needs both).
    rust_binary = None
    ts_binary = None
    if args.side in ("both", "rust"):
        rust_binary = args.rust_binary or ts_identity.default_rust_binary()
    if args.side in ("both", "ts"):
        ts_binary = args.ts_binary or default_ts_binary()
    if rust_binary and ts_binary:
        ts_identity.assert_ts_side_is_the_ts_product(ts_binary, rust_binary)
    os.makedirs(args.out_dir, exist_ok=True)

    results: list = []
    def reap(suffix: str) -> None:
        needle = os.path.join(args.out_dir, suffix)
        batterylib.reap_daemons(
            socket_paths=[os.path.join(needle, "daemon.sock")],
            needles=[needle, short_tmp(suffix)],
        )

    if args.side in ("both", "ts"):
        try:
            run_ts(ts_binary, args.out_dir, results)
        finally:
            reap("ts-agent")
    if args.side in ("both", "rust"):
        for cache in (True, False):
            suffix = "cached" if cache else "uncached"
            try:
                run_rust(rust_binary, args.out_dir, results, cache=cache)
            finally:
                reap(f"rust-{suffix}-agent")
    if args.side in ("ts", "rust"):
        print(f"captured the {args.side} side to {args.out_dir}")
        return 0

    report = [
        f"ts binary:   {ts_binary}",
        f"rust binary: {rust_binary}",
    ]
    outcomes = [check_cell(name, frame, report) for name, frame in results]
    ok = all(outcomes)
    report.append("MATRIX: " + ("PASS" if ok else "FAIL"))
    text = "\n".join(report)
    print(text)
    with open(os.path.join(args.out_dir, "report.txt"), "w") as handle:
        handle.write(text + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
