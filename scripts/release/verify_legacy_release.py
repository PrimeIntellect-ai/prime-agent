#!/usr/bin/env python3
"""Verify a candidate with the real published native TypeScript updater.

Downloads immutable previous-release artifacts and verifies their published
checksums before running the isolated migration harness. No user install is used.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from test_legacy_upgrade import archive_identity, digest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--previous-version", default="0.9.8")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    _, platform = archive_identity(args.candidate)
    version = args.previous_version
    if version not in {"0.9.5", "0.9.6", "0.9.7", "0.9.8"}:
        parser.error("previous version must be a published native TS release (0.9.5–0.9.8)")
    name = f"prime-agent-{version}-{platform}.tar.gz"
    base = f"https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v{version}"
    with tempfile.TemporaryDirectory(prefix="prime-legacy-release-") as temporary:
        root = Path(temporary)
        for filename in (name, "SHA256SUMS"):
            subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                            "--connect-timeout", "15", "--max-time", "300",
                            f"{base}/{filename}", "--output", str(root / filename)], check=True)
        rows = [line.split() for line in (root / "SHA256SUMS").read_text().splitlines()]
        hashes = [row[0] for row in rows if len(row) == 2 and row[1] == name]
        if len(hashes) != 1 or hashes[0] != digest(root / name):
            raise ValueError("published TS artifact failed checksum verification")
        installer = root / "install.sh"
        with tarfile.open(root / name) as archive:
            member = archive.getmember("install.sh")
            if not member.isfile():
                raise ValueError("published installer is not a regular file")
            installer.write_bytes(archive.extractfile(member).read())
        result = subprocess.run([
            sys.executable, str(Path(__file__).with_name("test_legacy_upgrade.py")),
            "--archive", str(args.candidate.resolve()),
            "--previous-archive", str(root / name),
            "--installer-file", str(installer), "--entrypoint", "cli",
            "--report", str(args.report.resolve()),
        ])
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
