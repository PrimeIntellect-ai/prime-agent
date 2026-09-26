#!/usr/bin/env python3
"""Assemble the prime-agent release artifact (kernel packaging).

Ports the TS release packaging (scripts/assemble-release-archives.mjs +
packages/coding-agent/scripts/copy-binary-assets.mjs) to this repo's layout:

  <out-dir>/prime-agent-<version>-<platform>/     staged exe-adjacent layout
  <out-dir>/prime-agent-<version>-<platform>.tar.gz
  <out-dir>/binaries.json                          release manifest (version pin)
  <out-dir>/SHA256SUMS                             integrity sums for the artifacts

The staged layout is the exe-adjacent packaging the binary resolves at
runtime (PI_PACKAGE_DIR override, else the directory of the executable):

  prime-agent            the binary (mode 755)
  package.json           version manifest ({"version": <version>, piConfig})
  README.md
  LICENSE
  models.bundled.json       bundled catalog assets (spec §3.2 layer 2),
  mcp-services.bundled.json staged beside the executable
  prime-agent-runtime/   the kernel runtime sidecar (dev caches excluded)
  skills/                built-in skills
  docs/                  user-facing docs

Run it as the packaging dry-run: it builds (or takes) the binary, stages,
validates, version-pins, hashes, and tars the artifact locally. No network
publishing happens here.

`--catalog-assets <dir>` supplies the generated bundled catalog assets
(scripts/release/bundle_catalog.py generates them); the packer hard-fails
without VALIDATED assets (version gates + >= 42 transport tuples + >= 68
services).
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The bundled-catalog validation gate lives in scripts/release/ (the same
# code the assemble_artifacts.py pipeline packs with).
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from bundle_catalog import BUNDLED_CATALOG_FILES, validate_bundled_catalog_dir  # noqa: E402
# The shipped-content policy (runtime dev-only files, user-facing docs) lives
# with the CI payload producer so the local dry-run and the published
# tarball carry identical content; this packer imports it instead of
# redefining it. verify_release.py already imports from the same module.
from assemble_artifacts import (  # noqa: E402
    RUNTIME_EXCLUDED_NAMES,
    RUNTIME_EXCLUDED_SUFFIXES,
    SHIPPED_DOC_ENTRIES,
)
# `--root` re-anchors asset discovery (workspace version, prime-agent-runtime,
# skills, docs, README) so integration tests can package synthetic trees.


# The TS copy-binary-assets exclusion set: development caches never ship and
# the staging walk rejects them (a stale .venv must not ride the artifact).
EXCLUDED_NAMES = {
    "node_modules",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".git",
    ".DS_Store",
}
EXCLUDED_SUFFIXES = (".pyc", ".egg-info")

# Required assets after staging (TS validateBinaryAssets + the bundled
# catalog assets the catalog spec §3.2 layer 2 requires): the kernel sidecar
# must carry its manifest and the REPL entry point, and the bundled catalog
# assets must sit beside the executable.
REQUIRED_FILES = (
    "prime-agent",
    "package.json",
    "README.md",
    "LICENSE",
    "models.bundled.json",
    "mcp-services.bundled.json",
    "prime-agent-runtime/pyproject.toml",
    "prime-agent-runtime/src/rlm/repl.py",
    # Every user-facing doc SHIPPED_DOC_ENTRIES gates the local dry-run too
    # (the adversarial-review docs gate: a curated doc missing from the
    # repo must fail packaging, not silently ship an empty docs entry).
    "docs/MODEL-SURFACE.md",
    "docs/RUST_QUICKSTART.md",
    "docs/keybindings.md",
    "docs/FEATURE_PARITY.md",
)
REQUIRED_DIRS = ("prime-agent-runtime/src/rlm", "skills")

# Tree assets copied with the exclusion filter; everything else is a single file.
TREE_ASSETS = ("prime-agent-runtime", "skills", "docs")


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--version", help="release version (default: workspace Cargo.toml)")
    parser.add_argument("--binary", type=Path, help="stage this binary instead of building")
    parser.add_argument("--skip-build", action="store_true",
                        help="reuse target/release/prime-agent without building")
    parser.add_argument("--out-dir", type=Path, help="output directory (default: target/release-package)")
    parser.add_argument("--platform", help="platform tag (default: derived from this machine)")
    parser.add_argument("--root", type=Path, default=ROOT,
                        help="package assets from this tree (default: the repo root)")
    parser.add_argument("--catalog-assets", type=Path, default=None,
                        help="directory with models.bundled.json + "
                             "mcp-services.bundled.json (see "
                             "scripts/release/bundle_catalog.py)")
    args = parser.parse_args(argv)
    return args


def workspace_version(root):
    """The [workspace.package] version from Cargo.toml."""
    in_workspace = False
    for line in (root / "Cargo.toml").read_text().splitlines():
        if line.startswith("["):
            in_workspace = line.strip() == "[workspace.package]"
            continue
        if in_workspace and line.strip().startswith("version"):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("error: could not read the workspace version from Cargo.toml")


def release_platform():
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine, machine)
    system = platform.system().lower()
    if system not in ("linux", "darwin", "windows"):
        raise SystemExit(f"error: unsupported release platform: {system}")
    return f"{system}-{arch}"


def include_path(relative, extra_excluded_names=frozenset(), extra_excluded_suffixes=()):
    parts = Path(relative).parts
    return not any(
        part in EXCLUDED_NAMES
        or part in extra_excluded_names
        or part.endswith(EXCLUDED_SUFFIXES)
        or part.endswith(extra_excluded_suffixes)
        for part in parts
    )


def copy_tree(source, target, extra_excluded_names=frozenset(),
              extra_excluded_suffixes=(), only_files=None):
    """Copy an asset tree, rejecting symlinks and excluded entries (the TS
    `includeBinaryAsset` filter: a stale `.venv` or cache never ships, and an
    unexpected symlink fails the packaging instead of riding the artifact).

    `extra_excluded_*` widen the exclusion set for one asset (the runtime's
    dev-only files); `only_files` restricts the TOP LEVEL to a whitelist (the
    user-facing docs subset) while nested content ships normally.
    """
    if not source.is_dir():
        raise SystemExit(f"error: missing packaging asset directory: {source}")

    def walk(source_dir, relative):
        for entry in sorted(source_dir.iterdir(), key=lambda item: item.name):
            if only_files is not None and not relative.parts and entry.name not in only_files:
                continue
            entry_relative = relative / entry.name
            if not include_path(entry_relative, extra_excluded_names, extra_excluded_suffixes):
                continue
            if entry.is_symlink():
                raise SystemExit(f"error: unexpected symlink in binary assets: {entry}")
            destination = target / entry_relative
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                walk(entry, entry_relative)
            elif entry.is_file():
                shutil.copy2(entry, destination)

    target.mkdir(parents=True, exist_ok=True)
    walk(source, Path("."))


def resolve_catalog_assets(args):
    """The bundled catalog assets (spec §3.2 layer 2): the packer
    hard-fails without validated assets — generate them first (network for
    CI, a local catalog checkout, or the offline --fixture snapshot) via
    scripts/release/bundle_catalog.py."""
    if args.catalog_assets is None:
        raise SystemExit(
            "error: missing bundled catalog assets: run "
            "`python3 scripts/release/bundle_catalog.py generate "
            "--catalog-dir <prime-agent-catalog>` (CI: --network; offline "
            "builds: --fixture) and pass --catalog-assets <dir>"
        )
    validate_bundled_catalog_dir(args.catalog_assets)
    return args.catalog_assets


def stage(root, binary, version, stage_dir, catalog_assets):
    stage_dir.mkdir(parents=True)
    staged_binary = stage_dir / "prime-agent"
    shutil.copy2(binary, staged_binary)
    staged_binary.chmod(0o755)
    # The bundled catalog assets ride beside the executable (the runtime's
    # <packageDir>/models.bundled.json resolution).
    for name in BUNDLED_CATALOG_FILES:
        shutil.copy2(catalog_assets / name, stage_dir / name)
    for name in TREE_ASSETS:
        if name == "prime-agent-runtime":
            copy_tree(root / name, stage_dir / name,
                      extra_excluded_names=RUNTIME_EXCLUDED_NAMES,
                      extra_excluded_suffixes=RUNTIME_EXCLUDED_SUFFIXES)
        elif name == "docs":
            copy_tree(root / name, stage_dir / name, only_files=SHIPPED_DOC_ENTRIES)
        else:
            copy_tree(root / name, stage_dir / name)
    shutil.copy2(root / "README.md", stage_dir / "README.md")
    # The license ships with the binary (TS binaryAssets keeps LICENSE beside
    # it; the release pipeline packages it the same way).
    shutil.copy2(root / "LICENSE", stage_dir / "LICENSE")
    # The version manifest: the binary's runtime package.json (TS
    # setBinaryVersion stamps the version here; cargo embeds it, so the
    # manifest records the pin and the staged binary must agree with it).
    (stage_dir / "package.json").write_text(
        json.dumps(
            {
                "name": "prime-agent",
                "version": version,
                "description": "Prime Agent: the RLM coding agent (Rust build)",
                "bin": {"prime-agent": "prime-agent"},
                "piConfig": {"name": "prime-agent", "configDir": ".prime/agent"},
            },
            indent=2,
        )
        + "\n"
    )


def validate(stage_dir, version):
    for name in REQUIRED_DIRS:
        if not (stage_dir / name).is_dir():
            raise SystemExit(f"error: missing binary asset directory: {name}")
    for name in REQUIRED_FILES:
        path = stage_dir / name
        if not path.is_file():
            raise SystemExit(f"error: missing binary asset: {name}")
    if not os.access(stage_dir / "prime-agent", os.X_OK):
        raise SystemExit("error: staged prime-agent is not executable")
    for path in sorted(stage_dir.rglob("*")):
        if path.is_symlink():
            raise SystemExit(f"error: unexpected symlink in binary assets: {path}")
        if not include_path(path.relative_to(stage_dir)):
            raise SystemExit(f"error: unexpected binary asset: {path}")


def pin_version(binary, stage_dir, version):
    """Two-sided version pin: the compiled-in version (probed with the
    manifest resolution pointed at an empty dir) and the staged manifest must
    both equal the requested release version."""
    with tempfile.TemporaryDirectory() as empty:
        probe = subprocess.run(
            [str(binary), "--version"],
            capture_output=True,
            text=True,
            env={**os.environ, "PI_PACKAGE_DIR": empty},
        )
    if probe.returncode != 0:
        raise SystemExit(f"error: prime-agent --version failed: {probe.stderr.strip()}")
    compiled = probe.stdout.strip()
    if compiled != version:
        raise SystemExit(
            f"error: version pin mismatch: binary reports {compiled!r}, release "
            f"version is {version!r}; rebuild the binary or pass --version {compiled}"
        )
    # The staged copy resolves the packaged manifest (exe-adjacent
    # package.json): it must report the same pinned version.
    probe = subprocess.run(
        [str(stage_dir / "prime-agent"), "--version"],
        capture_output=True,
        text=True,
        env={**os.environ, "PI_PACKAGE_DIR": str(stage_dir)},
    )
    if probe.returncode != 0:
        raise SystemExit(f"error: staged prime-agent --version failed: {probe.stderr.strip()}")
    staged = probe.stdout.strip()
    if staged != version:
        raise SystemExit(
            f"error: staged manifest version mismatch: {staged!r} != {version!r}"
        )


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_tar(stage_dir, output):
    entries = sorted(path for path in stage_dir.rglob("*"))
    # gzip default level 6 (the system `tar -czf` the TS packaging uses).
    with tarfile.open(output, "w:gz", compresslevel=6) as tar:
        for path in entries:
            tar.add(path, arcname=str(path.relative_to(stage_dir)), recursive=False)
    with tarfile.open(output) as tar:
        listed = sorted(name for name in tar.getnames() if name.strip())
    expected = sorted(
        str(path.relative_to(stage_dir))
        for path in stage_dir.rglob("*")
        if path.is_file() or path.is_dir()
    )
    if listed != expected:
        missing = set(expected) - set(listed)
        extra = set(listed) - set(expected)
        raise SystemExit(
            f"error: archive listing mismatch (missing {sorted(missing)}, unexpected {sorted(extra)})"
        )


def main(argv=None):
    args = parse_args(argv)
    root = args.root.resolve()
    version = args.version or workspace_version(root)
    tag = args.platform or release_platform()
    out_dir = (args.out_dir or root / "target" / "release-package").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    stage_dir = out_dir / f"prime-agent-{version}-{tag}"

    if args.binary:
        binary = args.binary.resolve()
        if not binary.is_file():
            raise SystemExit(f"error: binary not found: {binary}")
    elif args.skip_build:
        binary = root / "target" / "release" / "prime-agent"
        if not binary.is_file():
            raise SystemExit(f"error: no prebuilt binary at {binary}; drop --skip-build")
    else:
        print("building the release binary (cargo build --release -p pa-cli)…")
        subprocess.run(["cargo", "build", "--release", "-p", "pa-cli"], cwd=ROOT, check=True)
        binary = root / "target" / "release" / "prime-agent"

    if stage_dir.exists():
        shutil.rmtree(stage_dir)
    catalog_assets = resolve_catalog_assets(args)
    stage(root, binary, version, stage_dir, catalog_assets)
    validate(stage_dir, version)
    pin_version(binary, stage_dir, version)

    archive = out_dir / f"{stage_dir.name}.tar.gz"
    if archive.exists():
        archive.unlink()
    write_tar(stage_dir, archive)

    archive_sha = sha256_file(archive)
    executable_sha = sha256_file(stage_dir / "prime-agent")
    manifest = {
        "version": f"v{version}",
        "binaries": [
            {
                "platform": tag,
                "file": archive.name,
                "sha256": archive_sha,
                "executableSha256": executable_sha,
            }
        ],
    }
    (out_dir / "binaries.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (out_dir / "SHA256SUMS").write_text(f"{archive_sha}  {archive.name}\n")

    print(f"Created {archive}")
    print(f"Created {out_dir / 'binaries.json'}")
    print(f"Created {out_dir / 'SHA256SUMS'}")
    print(f"Staged layout at {stage_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
