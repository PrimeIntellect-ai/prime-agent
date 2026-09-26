#!/usr/bin/env python3
"""Fail-closed promotion check for optional Linux decoder assets.

Usage: python3 scripts/release/verify_decoders.py incoming
"""
import gzip
import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


def check(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build_id(data, path):
    path.write_bytes(data)
    result = subprocess.run(["readelf", "-n", str(path)],
                            capture_output=True, text=True)
    found = re.search(r"Build ID: ([0-9a-f]+)", result.stdout) if result.returncode == 0 else None
    check(found is not None, f"missing GNU build ID in {path}: {result.stderr.strip()}")
    return found.group(1)


def verify(incoming):
    directories = sorted(p for p in incoming.iterdir() if p.is_dir())
    check(bool(directories), "no build artifact directories")
    for directory in directories:
        manifest = json.loads((directory / "manifest.json").read_text())
        binaries = manifest["binaries"]
        check(len(binaries) == 1, f"{directory}: expected one binary per target")
        binary = binaries[0]
        target = binary["target"]
        decoders = manifest.get("decoders", [])
        files = sorted(directory.glob("*.debug.gz"))
        if target.endswith("-unknown-linux-gnu"):
            check(len(decoders) == len(files) == 1,
                  f"{directory}: Linux requires exactly one decoder")
            decoder = decoders[0]
            expected = f"prime-agent-{manifest['version'].removeprefix('v')}-{binary['platform']}.debug.gz"
            check(decoder["target"] == target and decoder["file"] == expected
                  and files[0].name == expected,
                  f"{directory}: decoder name/target mismatch")
            decoder_bytes = files[0].read_bytes()
            check(digest(decoder_bytes) == decoder["sha256"],
                  f"{directory}: decoder SHA-256 mismatch")
            sums = (directory / "SHA256SUMS").read_text().splitlines()
            check(sums.count(f"{decoder['sha256']}  {expected}") == 1,
                  f"{directory}: decoder missing from SHA256SUMS")
            with tarfile.open(directory / binary["file"], "r:gz") as tar:
                members = [m for m in tar.getmembers() if m.name == "prime-agent"]
                check(len(members) == 1 and members[0].isfile(),
                      f"{directory}: no unique installed ELF")
                installed = tar.extractfile(members[0]).read()
            check(digest(installed) == binary["executableSha256"]
                  == decoder["executableSha256"],
                  f"{directory}: installed ELF SHA mismatch")
            try:
                debug_bytes = gzip.decompress(decoder_bytes)
            except (OSError, EOFError) as error:
                raise ValueError(f"{directory}: corrupt decoder: {error}") from error
            with tempfile.TemporaryDirectory(prefix="verify-decoder-") as tmp:
                folder = Path(tmp)
                installed_id = build_id(installed, folder / "installed")
                decoder_id = build_id(debug_bytes, folder / "decoder")
            check(installed_id == decoder_id == decoder["buildId"],
                  f"{directory}: installed ELF/decoder build ID mismatch")
            print(f"{target}: installed ELF {digest(installed)}, "
                  f"decoder {digest(decoder_bytes)}, build ID {installed_id}: OK")
        else:
            check(not decoders and not files,
                  f"{directory}: unexpected decoder on non-Linux target")


if __name__ == "__main__":
    try:
        verify(Path(sys.argv[1]))
    except (ValueError, OSError, KeyError, IndexError) as error:
        sys.exit(f"decoder promotion verification failed: {error}")
