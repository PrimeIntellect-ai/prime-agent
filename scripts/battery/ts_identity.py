#!/usr/bin/env python3
"""Shared ts-identity guard for the parity harnesses.

Every parity harness drives two products against each other: the deployed
TS `prime-agent` binary (the "ts" side) and a Rust build of this repo (the
"rust" side). The parity comparison is only a parity claim when the two
sides are two products. A Rust build symlinked onto the PATH as
`prime-agent` (seen in a sandbox harness run) plays a Rust build as the
"ts" side and reports false divergences — e.g. a bold-escape d_expanded
frame diff that current main cannot reproduce against the real TS binary.

Every harness that launches the PATH ts binary calls the guard before
launching anything, so no harness can run its "ts" side against a stale
Rust build misidentified as TS:

    sys.path.insert(
        0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery")
    )
    import ts_identity  # noqa: E402
    ts_identity.assert_ts_side_is_the_ts_product()

Harnesses with non-default binaries pass them explicitly (run_battery.py
drives target/release/prime-agent rather than the debug build, and its
flows accept --ts-bin/--rust-bin):

    ts_identity.assert_ts_side_is_the_ts_product(ts_bin, rust_bin)

The "same product" test is the `--version` first line: the deployed TS
release and a Rust build of this repo report different version lines, so
an exact match means the ts side is the Rust side. The manifest fallback
keeps the guard working against an unbuilt tree (the workspace version is
what a fresh build would report).
"""

import os
import re
import subprocess

#: The env override every harness honors for the rust build it drives.
RUST_BINARY_ENV = "PA_RUST_BINARY"

#: This repo's root (scripts/battery/ -> repo root).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def default_rust_binary():
    """The Rust build a harness drives (PA_RUST_BINARY or the debug build)."""
    return os.environ.get(
        RUST_BINARY_ENV, os.path.join(REPO_ROOT, "target", "debug", "prime-agent")
    )


def probe_version(command):
    """The first line of a prime-agent binary's `--version` output."""
    try:
        result = subprocess.run(
            f"{command} --version", shell=True, capture_output=True, text=True, timeout=60
        )
    except subprocess.TimeoutExpired:
        return ""
    line = result.stdout.strip().splitlines()
    return line[0] if line else ""


def rust_version(rust_bin=None):
    """The Rust side's `--version` line, from the build or the workspace manifest."""
    rust = rust_bin or default_rust_binary()
    if os.path.exists(rust):
        version = probe_version(rust)
        if version:
            return version
    cargo = os.path.join(REPO_ROOT, "Cargo.toml")
    with open(cargo, encoding="utf-8") as manifest:
        text = manifest.read()
    section = text.split("[workspace.package]", 1)[-1]
    match = re.search(r'^version = "([^"]+)"', section, re.MULTILINE)
    return match.group(1) if match else ""


def assert_ts_side_is_the_ts_product(ts_bin="prime-agent", rust_bin=None):
    """Fail fast when the ts binary is not the deployed TS build.

    `ts_bin` is the command the harness will launch as the ts side (the
    `prime-agent` on PATH by default); `rust_bin` is the Rust build the
    same harness drives (PA_RUST_BINARY or the debug build by default).
    Raises SystemExit (the harness's refusal) when the ts binary does not
    run at all, or when it reports the same `--version` line as the Rust
    build — i.e. when the "ts" side is actually this repo's Rust product.
    """
    ts_version = probe_version(ts_bin)
    if not ts_version:
        raise SystemExit(f"no working `{ts_bin}` for the ts side: the TS side cannot run")
    reference = rust_version(rust_bin)
    if reference and ts_version == reference:
        raise SystemExit(
            f"`{ts_bin}` (the ts side) reports version {ts_version!r}, the same "
            f"product as the Rust side ({reference!r}): point PATH at the "
            "deployed TS binary (e.g. /usr/local/bin/prime-agent from the "
            "release install)"
        )
