#!/usr/bin/env python3
"""Post-run daemon-leak checker (the #221 verification pattern).

Wraps a harness run, waits `--wait` seconds after it exits, then asserts
that no NEW prime-agent/pa-daemon process (a daemon, its supervisor, or a
worker) survived the run. The process table is snapshotted before the
run: daemons that already lived on the box (other lanes, interactive
sessions, this harness's own agent) are ignored; only the delta fails.

    python3 scripts/battery/reap_check.py [--wait 30] [--label NAME] -- <command...>

Exit 0 = every daemon the run spawned is gone; exit 1 = leaked
processes (their pid + argv printed as evidence). The wait covers the
respawn window: a killed main daemon is relaunched by its supervisor
within ~1.5s, so a 30s quiet window means the whole tree is down.

Not part of the product; verifier only.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

#: Executable basenames that mark a process as one of the products'
#: processes. Matching argv[0] (never "any argv part"): a substring match
#: would flag unrelated processes that merely quote the product's name
#: (observed: another agent's bash gate wrapper embedding the
#: "prime-agent-complete:" marker string).
PRODUCT_BASENAMES = ("prime-agent", "pa-daemon")


def snapshot() -> dict[int, str]:
    """Live product processes: {pid: argv string}."""
    out: dict[int, str] = {}
    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        pid = int(proc_dir.name)
        if pid == os.getpid():
            continue
        try:
            argv = [
                part.decode(errors="replace")
                for part in (proc_dir / "cmdline").read_bytes().split(b"\0")
                if part
            ]
        except OSError:
            continue
        if argv and os.path.basename(argv[0]) in PRODUCT_BASENAMES:
            out[pid] = " ".join(argv)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wait", type=float, default=30.0)
    parser.add_argument("--label", default=None)
    parser.add_argument(
        "--needle",
        default=None,
        help="count only survivors whose argv references this path (for "
        "harnesses with known tempdir prefixes, so concurrent daemons "
        "other agents spawn on a shared box are not misattributed)",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("no command given (use `-- <command...>`)")

    label = args.label or " ".join(args.command)
    before = snapshot()
    # Popen (not run): the direct child's pid must be excludable from the
    # survivor set when the checked command itself names a product binary
    # in its own argv (e.g. provider_error_probe --binary .../prime-agent).
    child = subprocess.Popen(args.command)
    exit_code = child.wait()
    deadline = time.time() + args.wait
    while time.time() < deadline:
        time.sleep(min(1.0, deadline - time.time()))
    after = snapshot()
    survivors = {pid: argv for pid, argv in after.items() if pid not in before and pid != child.pid}
    if args.needle:
        survivors = {pid: argv for pid, argv in survivors.items() if args.needle in argv}
    if survivors:
        print(f"REAP FAIL [{label}]: {len(survivors)} product process(es) survived the run")
        for pid, argv in sorted(survivors.items()):
            print(f"  pid {pid}: {argv}")
        return 1
    if exit_code != 0:
        print(f"REAP OK [{label}]: no leaked daemons (harness itself exited {exit_code})")
        return exit_code
    print(f"REAP OK [{label}]: zero product processes remain {args.wait:g}s post-exit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
