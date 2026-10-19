#!/usr/bin/env python3
"""Restamp the continuous build's artifacts into a release-channel set.

The beta (nightly) release consumes the `continuous` workflow's artifacts
instead of rebuilding the 4-target matrix: `continuous` already built the
exact parent commit the nightly tag names (its own gates — GLIBC baseline,
split-debug, payload guards — ran green there, and nightly.yml waits out
that run before cutting the tag). The only differences between a continuous
artifact set and a release one are version-shaped, so this script restamps
them without touching the built bytes:

  - the tarball's inner `package.json` (the runtime version manifest the
    shipped binary reports via `--version`; see pa-cli config::version)
    moves from `<version>-continuous.<sha>` to the release version, keeping
    the `commit` provenance;
  - the archive, its SHA256SUMS line, and the (Linux) split-debug decoder
    rename to the release version;
  - the per-target manifest.json moves to the release version (per-binary
    and decoder rows kept in sync; `executableSha256`/`buildId` unchanged —
    the binaries are the continuous build's).

Everything else is verified, never rebuilt: the incoming archive must match
its own SHA256SUMS + manifest (an intact download), carry exactly the
continuous payload (assemble's designed entries plus `package.json`), be
stamped with the expected commit, and keep its decoder matching the
shipped ELF. Deterministic repacking reuses assemble_artifacts's own packer,
so the restamped archive is byte-equivalent to one assembled at the release
version from the same tree.

Usage (release.yml's consume job):

    python3 scripts/release/restamp_continuous.py \
        --incoming <dir with artifacts-<target>/ subdirs> \
        --version <x.y.z[-beta.N]> \
        --expect-commit <40-hex sha> \
        --out-dir <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

# Same-directory release scripts (the packer + gates are reused, never re-implemented).
from assemble_artifacts import (
    TARGET_ALIASES,
    fail_if_decoder_in_archive,
    pack_tarball,
    sha256_file,
)
from bundle_catalog import validate_bundled_catalog_dir
from native_compat import validate_compatibility_archive
from verify_release import CONTINUOUS_EXTRA_TOP_LEVEL, CONTINUOUS_SUFFIX, EXPECTED_TOP_LEVEL, NATIVE_COMPAT_TOP_LEVEL

# The runner-host target triple -> the binary this process can execute
# (installer.rs `target_for` parity: the same four continuous targets).
HOST_TARGETS = {
    ("linux", "x86_64"): "x86_64-unknown-linux-gnu",
    ("linux", "aarch64"): "aarch64-unknown-linux-gnu",
    ("macos", "aarch64"): "aarch64-apple-darwin",
    ("macos", "x86_64"): "x86_64-apple-darwin",
}


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def host_target() -> str | None:
    return HOST_TARGETS.get((platform.system().lower(), platform.machine()))


def read_sums(path: Path) -> dict[str, str]:
    """SHA256SUMS rows as {basename: digest}."""
    sums: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, name = line.split(None, 1)
        sums[Path(name.strip()).name] = digest.strip()
    return sums


def _member_target(archive: Path, staging: Path, member: tarfile.TarInfo) -> Path:
    """The extraction path for one member, proven inside `staging` first.

    A member name with an absolute path or a `..` component would write
    OUTSIDE the staging tree (the tarfile tar-slip class); the payload gate
    below runs only after the whole archive is read, so the traversal check
    belongs here, before any byte is written.
    """
    candidate = staging / member.name
    if member.name.startswith("/") or ".." in Path(member.name).parts:
        fail(f"archive {archive.name} carries an escaping member {member.name!r}; "
             "refusing to extract outside the staging tree")
    resolved = candidate.resolve()
    if staging.resolve() not in resolved.parents and resolved != staging.resolve():
        fail(f"archive {archive.name} carries an escaping member {member.name!r}; "
             "refusing to extract outside the staging tree")
    return candidate


def unpack_archive(archive: Path, staging: Path) -> list[str]:
    """Extract a plain-file archive to `staging`; return its top-level entries."""
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        for member in members:
            if member.issym() or member.islnk():
                fail(f"archive {archive.name} contains a link entry {member.name!r}; "
                     "refusing to restamp a payload the packer never produces")
            target = _member_target(archive, staging, member)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                assert source is not None
                with source, open(target, "wb") as sink:
                    shutil.copyfileobj(source, sink)
                target.chmod(member.mode)
    return sorted({member.name.split("/", maxsplit=1)[0] for member in members})


def glibc_baseline_ok(binary: Path) -> bool:
    """No symbol above GLIBC_2.35 (the Ubuntu 22.04 release baseline).

    The continuous build gated this inside its build container; the restamp
    re-proves it on the host it can execute.
    """
    result = subprocess.run(["objdump", "-T", str(binary)],
                            capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return False
    versions = [tuple(int(part) for part in symbol.split("_", 1)[1].split("."))
                for symbol in re.findall(r"GLIBC_[0-9.]+", result.stdout)]
    return bool(versions) and max(versions) <= (2, 35)


def restamp_target(incoming: Path, out_dir: Path, version: str,
                   expect_commit: str) -> dict:
    manifest = json.loads((incoming / "manifest.json").read_text(encoding="utf-8"))
    binaries = manifest["binaries"]
    if len(binaries) != 1:
        fail(f"{incoming.name}: expected exactly one binary row, found {len(binaries)}")
    binary = binaries[0]
    target = binary["target"]
    alias = TARGET_ALIASES[target]
    staged_commit = str(manifest.get("commit", "")).lower()
    if staged_commit != expect_commit:
        fail(f"{incoming.name}: artifact commit {staged_commit!r} != the tag's "
             f"parent {expect_commit!r}: these are not the continuous builds "
             "of the commit this release names")
    old_version = manifest["version"].removeprefix("v")
    old_archive_name = binary["file"]

    # 1. The download is intact: its own SHA256SUMS + manifest must agree.
    archive = incoming / old_archive_name
    if not archive.is_file():
        fail(f"{incoming.name}: archive {old_archive_name} missing")
    archive_sha = sha256_file(archive)
    sums = read_sums(incoming / "SHA256SUMS")
    if sums.get(old_archive_name) != archive_sha or binary["sha256"] != archive_sha:
        fail(f"{incoming.name}: {old_archive_name} does not match its "
             "SHA256SUMS/manifest digest — the download is not intact")

    # 2. The decoder rows (Linux) must be present and match their files.
    decoders = manifest.get("decoders", [])
    decoder_files = sorted(incoming.glob("*.debug.gz"))
    if target.endswith("-unknown-linux-gnu"):
        if len(decoders) != 1 or len(decoder_files) != 1:
            fail(f"{incoming.name}: a Linux target requires exactly one decoder "
                 f"(manifest rows {len(decoders)}, files {len(decoder_files)})")
        if sha256_file(decoder_files[0]) != decoders[0]["sha256"]:
            fail(f"{incoming.name}: the decoder does not match its manifest sha256")
        if sums.get(decoder_files[0].name) != decoders[0]["sha256"]:
            fail(f"{incoming.name}: the decoder's SHA256SUMS line does not match")
    elif decoders or decoder_files:
        fail(f"{incoming.name}: unexpected decoder artifacts on {target}")

    validate_compatibility_archive(archive)

    # 3. Unpack; assert the continuous payload shape.
    staging = Path(tempfile.mkdtemp(prefix="prime-agent-restamp-"))
    try:
        entries = unpack_archive(archive, staging)
        expected = sorted(EXPECTED_TOP_LEVEL | CONTINUOUS_EXTRA_TOP_LEVEL | NATIVE_COMPAT_TOP_LEVEL)
        if entries != expected:
            fail(f"{incoming.name}: payload {entries} != the continuous "
                 f"payload {expected}; refusing to restamp a foreign archive")
        package = json.loads((staging / "package.json").read_text(encoding="utf-8"))
        stamped = f"{old_version}-{CONTINUOUS_SUFFIX}.{expect_commit}"
        if package.get("version") != stamped:
            fail(f"{incoming.name}: package.json version "
                 f"{package.get('version')!r} != the continuous stamp "
                 f"{stamped!r}: not a continuous build's artifact")
        if sha256_file(staging / "prime-agent") != binary["executableSha256"]:
            fail(f"{incoming.name}: the staged binary does not match the "
                 "manifest's executableSha256")
        validate_bundled_catalog_dir(staging)

        # 4. The runtime version manifest moves to the release version; the
        #    built bytes stay the continuous build's.
        package["version"] = version
        (staging / "package.json").write_text(json.dumps(package, indent=2) + "\n")

        # 5. Repack deterministically (the same packer that built the archive).
        new_archive_name = f"prime-agent-{version}-{alias}.tar.gz"
        target_dir = out_dir / incoming.name
        target_dir.mkdir(parents=True, exist_ok=True)
        new_archive = target_dir / new_archive_name
        pack_tarball(staging, new_archive, entries)
        fail_if_decoder_in_archive(new_archive)
        new_sha = sha256_file(new_archive)

        # 6. The decoder rides along unchanged (bytes), renamed to the release version.
        new_lines = [f"{new_sha}  {new_archive_name}"]
        if target.endswith("-unknown-linux-gnu"):
            new_decoder_name = f"prime-agent-{version}-{alias}.debug.gz"
            shutil.copyfile(decoder_files[0], target_dir / new_decoder_name)
            new_lines.append(f"{decoders[0]['sha256']}  {new_decoder_name}")
            decoders[0]["file"] = new_decoder_name
        (target_dir / "SHA256SUMS").write_text("\n".join(new_lines) + "\n")

        # 7. The per-target manifest moves to the release version, keeping
        #    the commit provenance of the build it consumed.
        binary["version"] = f"v{version}"
        binary["file"] = new_archive_name
        binary["sha256"] = new_sha
        manifest["version"] = f"v{version}"
        (target_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

        # 8. The live gates, on the target this host can execute: the shipped
        #    binary's `--version` must report the release version (the runtime
        #    version manifest is what the update flow reads), and a GNU target
        #    re-proves the GLIBC baseline. The other targets' binaries cannot
        #    execute here; verify_release.py livechecked each on its native
        #    continuous runner (the manifest's `commit` row names that build).
        livecheck = None
        if target == host_target():
            env = {k: v for k, v in os.environ.items() if k != "PI_PACKAGE_DIR"}
            run = subprocess.run([str(staging / "prime-agent"), "--version"],
                                 capture_output=True, text=True, env=env,
                                 cwd=staging, check=False)
            detail = (run.stdout or run.stderr).strip() or f"rc={run.returncode}"
            if run.returncode != 0 or run.stdout.strip() != version:
                fail(f"{incoming.name}: the restamped binary reports {detail!r}, "
                     f"expected {version!r} — the runtime version manifest did not take")
            if target.endswith("-unknown-linux-gnu") \
                    and not glibc_baseline_ok(staging / "prime-agent"):
                fail(f"{incoming.name}: the binary requires symbols above "
                     "GLIBC_2.35 — above the Ubuntu 22.04 release baseline")
            livecheck = version
        return {
            "target": target,
            "platform": alias,
            "file": new_archive_name,
            "sha256": new_sha,
            "commit": expect_commit,
            "executableSha256": binary["executableSha256"],
            "livecheck": livecheck,
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--incoming", required=True, type=Path,
                        help="directory holding the downloaded artifacts-<target> sets")
    parser.add_argument("--version", required=True,
                        help="the release version to stamp (e.g. 0.9.8-beta.1)")
    parser.add_argument("--expect-commit", required=True,
                        help="the 40-hex commit the artifacts must be stamped with")
    parser.add_argument("--out-dir", required=True, type=Path,
                        help="directory to write the restamped artifacts-<target> sets to")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.expect_commit):
        fail(f"invalid commit {args.expect_commit!r} (expected 40 hex chars)")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", args.version):
        fail(f"invalid version {args.version!r}")

    incoming = [p for p in sorted(args.incoming.iterdir()) if p.is_dir()]
    if not incoming:
        fail(f"no artifacts-* directories under {args.incoming}")
    results = [restamp_target(directory, args.out_dir, args.version,
                              args.expect_commit.lower())
               for directory in incoming]
    for result in results:
        print(json.dumps(result, indent=2))
    livechecked = [r["target"] for r in results if r["livecheck"]]
    print(f"restamped {len(results)} target sets to {args.version} "
          f"(continuous commit {args.expect_commit}; "
          f"livechecked: {', '.join(livechecked) or 'none on this host'}); "
          "the built bytes are unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
