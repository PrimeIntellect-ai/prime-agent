#!/usr/bin/env python3
"""Produce the shipped binary and its split-debug decoder from one build.

Kevin's Option C shipping posture: the release build emits line tables and
does not strip at link (see [profile.release] in Cargo.toml). This step
splits that ONE linked image so the decoder's DWARF addresses match the
shipped binary exactly:

  - decoder: ``objcopy --only-keep-debug`` of the unstripped image, gzipped
    (~3x on DWARF), named ``prime-agent-<version>-<platform>.debug.gz`` —
    a SEPARATE release asset for offline symbolication, NEVER install
    payload (assemble_artifacts.py hard-fails if one enters a tarball).
  - shipped: ``objcopy --strip-debug`` of the same image, in place — DWARF
    gone, the static symbol table (function names in panic backtraces) and
    .dynsym (dynamic linking, the GLIBC baseline gate) stay.

Symbolication round-trip: ``gunzip`` the decoder, then
``llvm-symbolizer --obj <decoder-file> <addr...>`` with addresses from the
shipped binary's backtraces or ``nm``/``objdump -t``.

Usage:
    python3 scripts/release/split_debug.py \
        --binary target/x86_64-unknown-linux-gnu/release/prime-agent \
        --out target/x86_64-unknown-linux-gnu/dist \
        --version 0.1.0 --target x86_64-unknown-linux-gnu

The stripped image replaces the --binary path in place (the assembled
tarball and every downstream reference pick it up); the decoder lands in
--out. Both sha256s and sizes print for the release log and manifest
provenance.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Same platform alias map the assembler uses, so the decoder file name
# matches the release naming convention exactly.
from assemble_artifacts import TARGET_ALIASES


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        fail(f"{' '.join(args)} failed: {result.stderr.strip() or result.returncode}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def debug_sections(binary: Path) -> list[str]:
    """ELF .debug_* section names, so the split asserts on real evidence."""
    result = subprocess.run(["objdump", "-h", str(binary)], capture_output=True, text=True)
    if result.returncode != 0:
        fail(f"objdump -h failed on {binary}: {result.stderr.strip()}")
    return [
        line.split()[1]
        for line in result.stdout.splitlines()
        if line[:1].isspace() and ".debug" in line
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--version", required=True,
                        help="bare release version, e.g. 0.1.0")
    parser.add_argument("--target", required=True,
                        help="rust target triple (must be a known alias)")
    args = parser.parse_args()
    if args.target not in TARGET_ALIASES:
        fail(f"unknown release target {args.target!r} (known: {', '.join(TARGET_ALIASES)})")
    decoder_name = f"prime-agent-{args.version}-{TARGET_ALIASES[args.target]}.debug.gz"

    binary = args.binary
    if not binary.is_file() or not os.access(binary, os.X_OK):
        fail(f"no executable binary at {binary}")
    before = debug_sections(binary)
    if not before:
        fail(f"{binary} carries no .debug_* sections - build it with the "
             "line-tables profile before splitting (a stripped-at-link build "
             "has no DWARF to keep)")

    args.out.mkdir(parents=True, exist_ok=True)
    decoder = args.out / decoder_name
    with tempfile.TemporaryDirectory(prefix="split-debug-") as tmp:
        keep = Path(tmp) / "keep-debug"
        # only-keep-debug keeps section headers and every DWARF section and
        # drops the loaded contents — the decoder file, symbolization-wise
        # equivalent to the original for addr2line/llvm-symbolizer.
        run(["objcopy", "--only-keep-debug", str(binary), str(keep)])
        if not keep.is_file() or keep.stat().st_size == 0:
            fail("objcopy --only-keep-debug produced no decoder file")
        # gzip -n: no timestamp, deterministic asset bytes
        with keep.open("rb") as src, gzip.GzipFile(filename="", mode="wb",
                                                  fileobj=decoder.open("wb"),
                                                  mtime=0) as gz:
            shutil.copyfileobj(src, gz)

    stripped_tmp = binary.with_suffix(binary.suffix + ".stripped")
    run(["objcopy", "--strip-debug", str(binary), str(stripped_tmp)])
    after = debug_sections(stripped_tmp)
    if after:
        fail(f"--strip-debug left .debug_* sections behind: {after}")
    shipped_sha = sha256_file(stripped_tmp)
    os.replace(stripped_tmp, binary)

    print("split_debug:")
    print(f"  shipped:  {binary} {binary.stat().st_size} bytes sha256 {shipped_sha}")
    print(f"  decoder:  {decoder} {decoder.stat().st_size} bytes sha256 {sha256_file(decoder)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
