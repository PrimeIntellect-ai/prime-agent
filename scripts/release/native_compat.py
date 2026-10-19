"""Preserve the archive contract enforced by shipped TypeScript installers.

The old installer validates these files before invoking the executable. Keep
authentic assets so its installed-release validation and rollback continue to
work; the Rust executable uses its own renderer and image implementation.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tarfile
from pathlib import Path, PurePosixPath

ASSET_DIR = Path(__file__).resolve().parent / "native-compat"
PHOTON_SHA256 = "10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c"
COMPAT_ASSETS = (
    "theme/prime.json",
    "export-html/template.html",
    "photon_rs_bg.wasm",
    "PHOTON-LICENSE.md",
)
REQUIRED_NATIVE_FILES = (
    "prime-agent", "package.json", "install.sh",
    "prime-agent-runtime/pyproject.toml", "prime-agent-runtime/src/rlm/repl.py",
    *COMPAT_ASSETS,
)


def stage_native_compat(staging: Path) -> list[str]:
    """Stage authentic legacy assets and a usable Rust repair installer."""
    photon = ASSET_DIR / "photon_rs_bg.wasm"
    if hashlib.sha256(photon.read_bytes()).hexdigest() != PHOTON_SHA256:
        raise ValueError("legacy Photon compatibility asset checksum mismatch")
    for name in COMPAT_ASSETS:
        target = staging / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ASSET_DIR / name, target)
    # This file is validated, not executed, by the already-running TS installer.
    # Ship the maintained Rust installer so manual repair uses current code.
    shutil.copyfile(ASSET_DIR.parents[2] / "install-rust.sh", staging / "install.sh")
    return ["theme", "export-html", "photon_rs_bg.wasm", "PHOTON-LICENSE.md", "install.sh"]


def validate_compatibility_archive(path: Path) -> None:
    """Raise ValueError for an archive the historical native updater rejects.

    Windows never used the POSIX native TS installer. Its archive only needs
    the common package version metadata; platform checks live in verify_release.
    """
    with tarfile.open(path, "r:gz") as archive:
        members = {}
        for member in archive.getmembers():
            if member.name.startswith("/") or ".." in PurePosixPath(member.name).parts or "\\" in member.name:
                raise ValueError(f"escaping member in compatibility archive: {member.name}")
            if not member.isfile() and not member.isdir():
                raise ValueError(f"non-regular member in compatibility archive: {member.name}")
            if member.name in members:
                raise ValueError(f"duplicate member in compatibility archive: {member.name}")
            members[member.name] = member
        windows = "prime-agent.exe" in members
        required = ("package.json",) if windows else REQUIRED_NATIVE_FILES
        for name in required:
            member = members.get(name)
            if member is None or not member.isfile() or member.size == 0:
                raise ValueError(f"missing regular compatibility asset: {name}")
        package = json.load(archive.extractfile("package.json"))
        if not isinstance(package.get("version"), str) or not package["version"]:
            raise ValueError("compatibility package.json has no version")
        if not windows:
            photon = archive.extractfile("photon_rs_bg.wasm").read()
            if hashlib.sha256(photon).hexdigest() != PHOTON_SHA256:
                raise ValueError("legacy Photon compatibility asset checksum mismatch")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs="+", type=Path)
    for archive_path in parser.parse_args().archives:
        validate_compatibility_archive(archive_path)
        print(f"Native compatibility verified: {archive_path}")
