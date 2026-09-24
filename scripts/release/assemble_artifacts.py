#!/usr/bin/env python3
"""Assemble prime-agent release tarballs (Rust rewrite).

Mirrors the TS release pipeline (`~/prime-agent/scripts/assemble-release-archives.mjs`)
for the Rust workspace: stage the release binary plus the bundled kernel runtime,
skills, docs, and license metadata into a scratch tree, pack a deterministic
tarball with files at the tarball root, and emit `SHA256SUMS` plus a
TS-installer-compatible `manifest.json` (archive sha256, executable sha256,
platform alias).

Usage:
    python3 scripts/release/assemble_artifacts.py \
        --repo-root <repo> --version <x.y.z> --target <triple> \
        [--binary <path>] [--runtime-dir <dir>] [--out-dir <dir>] [--sha <commit>] \
        [--catalog-assets <dir>]

`--catalog-assets` is the directory holding the generated bundled catalog
assets (`models.bundled.json` + `mcp-services.bundled.json`); the packer
hard-fails without VALIDATED assets (version gates + >= 42 transport tuples +
>= 68 services — see scripts/release/bundle_catalog.py, the catalog spec §3.2
no-cold-start layer 2). CI generates them from the live catalog repo; offline
builds use `bundle_catalog.py generate --fixture`.

`--binary` defaults to `<repo>/target/<target>/release/prime-agent` (cross builds)
and falls back to `<repo>/target/release/prime-agent` (host builds).
`--runtime-dir` defaults to `<repo>/prime-agent-runtime` (the vendored sidecar
from the kernel-packaging lane).
`--sha` (the continuous-build stamp): a full 40-char git commit SHA. When
given, a `package.json` version manifest is staged beside the binary (TS
installer parity: it is one of NATIVE_RELEASE_ASSETS) whose `version` is
`<version>-continuous.<sha>`, so the shipped binary reports the exact commit it
was built from via `--version`; the manifest records the commit too. The
archive name keeps the bare `<version>` so rolling releases overwrite assets.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

# The bundled-catalog validation gate (same release-scripts directory).
from bundle_catalog import BUNDLED_CATALOG_FILES, validate_bundled_catalog_dir

# Tarball-root payload order mirrors the TS `binaryAssets` list so the
# installer lane can extract both distributions identically.
STAGED_ENTRIES = [
    "prime-agent",
    "prime-agent-runtime",
    "skills",
    "docs",
    "LICENSE",
    "README.md",
    # The bundled catalog assets (spec §3.2 layer 2): staged at the tarball
    # root beside the binary — the runtime resolves <packageDir>/<name> (the
    # TS binaryAssets ship them the same way).
    "models.bundled.json",
    "mcp-services.bundled.json",
]

# Rust target triple -> TS release-platform alias (the v1 installer schema).
TARGET_ALIASES = {
    "x86_64-unknown-linux-gnu": "linux-x64",
    "aarch64-unknown-linux-gnu": "linux-arm64",
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-apple-darwin": "darwin-x64",
    "x86_64-pc-windows-msvc": "win32-x64",
}

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")

# A git commit SHA as carried by `${GITHUB_SHA}` (full 40 hex chars, either
# case accepted).
SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")

# The continuous-build version stamp suffix (docs/installer-ci-design.md §4;
# the trailing SHA keeps the string inside semver prerelease syntax, which
# both VERSION_RE and the TS installer's release-directory pattern accept).
CONTINUOUS_SUFFIX = "continuous"


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--binary", type=Path, default=None)
    parser.add_argument("--runtime-dir", type=Path, default=None)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--sha", default=None,
                        help="full commit SHA to stamp into the binary's "
                             "version manifest (continuous builds)")
    parser.add_argument("--catalog-assets", type=Path, default=None,
                        help="directory with models.bundled.json + "
                             "mcp-services.bundled.json (see "
                             "scripts/release/bundle_catalog.py)")
    return parser.parse_args()


def resolve_binary(args: argparse.Namespace) -> Path:
    candidates = []
    if args.binary is not None:
        candidates.append(args.binary)
    else:
        candidates.append(args.repo_root / "target" / args.target / "release" / "prime-agent")
        candidates.append(args.repo_root / "target" / "release" / "prime-agent")
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    listed = ", ".join(str(candidate) for candidate in candidates)
    fail(f"no executable prime-agent binary found (looked at: {listed}); build first")


def validate_version(version: str) -> None:
    if not VERSION_RE.match(version):
        fail(f"invalid version {version!r} (expected semver like 0.1.0)")


def continuous_version(version: str, sha: str) -> str:
    """The stamped runtime version for a continuous build of `sha`.

    The bare `--version` keeps the archive/asset names stable (the rolling
    release overwrites same-named assets); only the binary's runtime version
    manifest carries the commit, so `prime-agent --version` reports exactly
    what was built.
    """
    stamped = f"{version}-{CONTINUOUS_SUFFIX}.{sha.lower()}"
    if not VERSION_RE.match(stamped):
        fail(f"stamped version {stamped!r} is not valid semver")
    return stamped


def validate_sha(sha: str) -> None:
    if not SHA_RE.match(sha):
        fail(f"invalid commit SHA {sha!r} (expected 40 hex chars)")


def stage_tree(staging: Path, args: argparse.Namespace, stamped_version: str | None) -> dict:
    """Copy the tarball payload into the staging dir; return per-entry facts.

    `stamped_version` is the continuous-build version stamp (None for plain
    releases); when set, a `package.json` manifest is staged beside the binary
    so `--version` reports it at runtime (the same exe-adjacent manifest the
    TS binaryAssets carry — the Rust binary resolves it from `current_exe()`).
    """
    binary = resolve_binary(args)
    runtime_dir = args.runtime_dir or (args.repo_root / "prime-agent-runtime")
    sources = {
        "prime-agent": binary,
        "prime-agent-runtime": runtime_dir,
        "skills": args.repo_root / "skills",
        "docs": args.repo_root / "docs",
        "LICENSE": args.repo_root / "LICENSE",
        "README.md": args.repo_root / "README.md",
    }
    if not runtime_dir.joinpath("pyproject.toml").is_file():
        fail(
            "kernel runtime sidecar not found at "
            f"{runtime_dir} (expected prime-agent-runtime with pyproject.toml); "
            "pass --runtime-dir or merge the kernel-packaging lane"
        )
    for name, source in sources.items():
        target_path = staging / name
        if not source.exists():
            fail(f"release payload entry {name!r} missing at {source}")
        if source.is_dir():
            shutil.copytree(source, target_path)
        else:
            shutil.copy2(source, target_path)
    os.chmod(staging / "prime-agent", 0o755)
    # The bundled catalog assets gate (spec §3.9): the release packer FAILS
    # without validated assets — generate them first (network for CI, a local
    # catalog checkout, or the offline --fixture snapshot) via
    # scripts/release/bundle_catalog.py.
    if args.catalog_assets is None:
        fail(
            "missing bundled catalog assets: run "
            "`python3 scripts/release/bundle_catalog.py generate "
            "--catalog-dir <prime-agent-catalog>` (CI: --network; offline "
            "builds: --fixture) and pass --catalog-assets <dir>"
        )
    catalog_assets = Path(args.catalog_assets)
    catalog_facts = validate_bundled_catalog_dir(catalog_assets)
    for name in BUNDLED_CATALOG_FILES:
        shutil.copyfile(catalog_assets / name, staging / name)
    payload = list(STAGED_ENTRIES)
    if stamped_version is not None:
        manifest = {
            "name": "prime-agent",
            "version": stamped_version,
            "description": "Prime Agent: the RLM coding agent (Rust build)",
            "bin": {"prime-agent": "prime-agent"},
            "piConfig": {"name": "prime-agent", "configDir": ".prime/agent"},
            "commit": args.sha,
        }
        (staging / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
        payload.append("package.json")
    return {
        "executable_sha256": sha256_file(staging / "prime-agent"),
        "payload": payload,
        "catalog_assets": catalog_facts,
    }


def _deterministic_member(member: tarfile.TarInfo) -> tarfile.TarInfo:
    """tarfile `filter`: fixed mtime/owner, deterministic modes, no links.

    Equivalent to GNU tar's `--sort=name --owner=0 --group=0 --numeric-owner
    --mtime=@0`; the binary keeps its exec bit, everything else is 0644/0755.
    """
    if member.issym() or member.islnk():
        raise ValueError(
            f"tarball payload contains a link entry {member.name!r}; "
            "the release payload must be plain files and directories"
        )
    member.uid = 0
    member.gid = 0
    member.uname = "root"
    member.gname = "root"
    member.mtime = 0
    if member.isdir():
        member.mode = 0o755
    elif member.name == "prime-agent":
        member.mode = 0o755
    else:
        member.mode = 0o644
    return member


def pack_tarball(staging: Path, out_path: Path, entries: list[str]) -> None:
    """Deterministic tar.gz with files at the tarball root.

    bsdtar vs GNU tar quirks are avoided by writing the archive through
    Python's tarfile with explicit member metadata.
    """
    staging_abs = staging.resolve()
    try:
        # Gzip mtime is pinned so two assemblies of identical input produce
        # byte-identical archives (the tar member metadata is pinned below).
        with open(out_path, "wb") as raw, \
             gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz, \
             tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(entries):
                path = staging_abs / name
                if path.is_dir():
                    archive.add(path, arcname=name, recursive=True,
                                filter=_deterministic_member)
                else:
                    archive.add(path, arcname=name, recursive=False,
                                filter=_deterministic_member)
    except ValueError as error:
        out_path.unlink(missing_ok=True)
        fail(str(error))


def main() -> int:
    args = parse_args()
    validate_version(args.version)
    stamped_version = None
    if args.sha is not None:
        validate_sha(args.sha)
        stamped_version = continuous_version(args.version, args.sha)
    if args.target not in TARGET_ALIASES:
        fail(f"unknown release target {args.target!r} (known: {', '.join(TARGET_ALIASES)})")

    out_dir = (args.out_dir or args.repo_root / "target" / "release" / "dist").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="prime-agent-archive-"))
    try:
        facts = stage_tree(staging, args, stamped_version)
        archive_name = f"prime-agent-{args.version}-{args.target}.tar.gz"
        archive_path = out_dir / archive_name
        pack_tarball(staging, archive_path, facts["payload"])
        archive_sha256 = sha256_file(archive_path)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    # The validated asset counts (models / transport tuples / services) ride
    # the build log; the manifest entry below stays the installer schema.
    print(f"bundled catalog assets: {json.dumps(facts['catalog_assets'])}")

    entry = {
        "version": f"v{args.version}",
        "platform": TARGET_ALIASES[args.target],
        "target": args.target,
        "file": archive_name,
        "sha256": archive_sha256,
        "executableSha256": facts["executable_sha256"],
    }

    # Merge-or-write semantics so a per-target run in each CI build job can be
    # combined: the promotion job collects every per-target entry instead.
    manifest_path = out_dir / "manifest.json"
    manifest = {"version": f"v{args.version}", "binaries": []}
    if args.sha is not None:
        manifest["commit"] = args.sha
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text())
        if existing.get("version") == manifest["version"] \
                and existing.get("commit") == manifest.get("commit"):
            manifest["binaries"] = existing["binaries"]
    manifest["binaries"] = [
        b for b in manifest["binaries"] if b.get("target") != args.target
    ] + [entry]
    manifest["binaries"].sort(key=lambda b: b["file"])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    sums_path = out_dir / "SHA256SUMS"
    lines = []
    for line in sums_path.read_text().splitlines() if sums_path.exists() else []:
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip() != archive_name:
            lines.append(line)
    lines.append(f"{archive_sha256}  {archive_name}")
    lines.sort(key=lambda line: line.split(None, 1)[1])
    sums_path.write_text("\n".join(lines) + "\n")

    print(json.dumps(entry, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
