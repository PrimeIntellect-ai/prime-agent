#!/usr/bin/env python3
"""Package the Rust migration bridge consumed by historical npm self-updaters.

No npm lifecycle scripts run: migration occurs when the old CLI/TUI relaunches
dist/bundle/cli.js or its later cli-node.js fallback. Emit JSON metadata for
the release manifest and checksums. The earliest packages relaunch dist/cli.js.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path, PurePosixPath

FALLBACK_VERSION = "0.9.8"
# Independently checked against the published GitHub release SHA256SUMS.
FALLBACK_SHA256 = "d7b72785119efc28bfbca8ec4a7f47a1fcdcf47fcd8cebdb60bffaa79e3e1274"


def assemble(repo_root: Path, out_dir: Path, version: str, channel: str,
             fallback_tarball: Path) -> dict:
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError(f"Invalid release version: {version}")
    if channel not in ("stable", "beta"):
        raise ValueError(f"Invalid release channel: {channel}")
    fallback_bytes = fallback_tarball.read_bytes()
    if hashlib.sha256(fallback_bytes).hexdigest() != FALLBACK_SHA256:
        raise ValueError("TypeScript fallback does not match the pinned published v0.9.8 archive")
    with tarfile.open(fileobj=io.BytesIO(fallback_bytes)) as fallback_archive:
        fallback_package = json.load(fallback_archive.extractfile("package/package.json"))
    if fallback_package.get("name") != "prime-agent" or fallback_package.get("version") != FALLBACK_VERSION:
        raise ValueError("TypeScript fallback package identity does not match published v0.9.8")
    metadata = {
        "name": "prime-agent", "version": version,
        "description": "Prime Agent Rust migration launcher",
        "bin": {"prime-agent": "dist/bundle/cli.js"},
        "engines": {"node": ">=18"}, "os": ["darwin", "linux"],
        "primeAgentReleaseChannel": channel,
        "primeAgentRustBridge": True,
        "primeAgentTypeScriptFallback": {"directory": "legacy/prime-agent",
                                        "version": FALLBACK_VERSION, "sha256": FALLBACK_SHA256},
    }
    # Genuine fallback modules resolve dependencies through the enclosing
    # package's node_modules. npm resolves these BEFORE replacing the previous
    # install, including platform-specific dependencies. Copy no lifecycle
    # scripts: recovery works with --ignore-scripts and does not start migration
    # inside an npm installation transaction.
    for field in ("dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "overrides"):
        if field in fallback_package:
            metadata[field] = fallback_package[field]
    launcher = (Path(__file__).parent / "npm_bridge_assets/cli.cjs").read_bytes()
    files = {
        "package.json": (json.dumps(metadata, indent=2) + "\n").encode(),
        "dist/bundle/cli.js": launcher,
        # v0.9.5+ npm shims spawn this path, which the old updater captures as
        # its coordinator/relaunch entrypoint. Both names must survive npm's
        # package replacement with equivalent behavior.
        "dist/bundle/cli-node.js": launcher,
        # The first published packages used dist/cli.js. Require the bundled
        # launcher so its __dirname still resolves the package root correctly;
        # process.argv retains the original path captured by the old updater.
        "dist/cli.js": b'#!/usr/bin/env node\n"use strict";\nrequire("./bundle/cli.js");\n',
        "install-rust.sh": (repo_root / "install-rust.sh").read_bytes(),
    }
    modes = {}
    with tarfile.open(fileobj=io.BytesIO(fallback_bytes)) as fallback_archive:
        for member in fallback_archive:
            source = PurePosixPath(member.name)
            if source.is_absolute() or ".." in source.parts or source.parts[0] != "package":
                raise ValueError(f"Unsafe TypeScript fallback member: {member.name}")
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"Unsupported TypeScript fallback member: {member.name}")
            name = str(PurePosixPath("legacy/prime-agent", *source.parts[1:]))
            files[name] = fallback_archive.extractfile(member).read()
            modes[name] = member.mode & 0o777
    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / f"prime-agent-{version}.tgz"
    with archive.open("wb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as tar:
                for name, content in sorted(files.items()):
                    info = tarfile.TarInfo(f"package/{name}")
                    info.size = len(content)
                    info.mode = modes.get(name, 0o755 if name.endswith((".js", ".sh")) else 0o644)
                    tar.addfile(info, io.BytesIO(content))
    return {"version": version, "package": "prime-agent", "tarball": archive.name,
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--channel", choices=("stable", "beta"), default="stable")
    parser.add_argument("--fallback-tarball", type=Path, required=True,
                        help="checksum-pinned published TypeScript v0.9.8 npm archive")
    args = parser.parse_args()
    print(json.dumps(assemble(args.repo_root, args.out_dir, args.version, args.channel,
                              args.fallback_tarball)))
