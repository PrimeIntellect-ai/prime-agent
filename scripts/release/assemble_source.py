#!/usr/bin/env python3
"""Assemble the prime-agent source tarball (the homebrew-core build input).

Homebrew-core builds formulas from source, so the homebrew-core submission
candidate pins a release source tarball rather than a prebuilt archive:
`prime-agent-<version>-src.tar.gz`, assembled here from the repo tree at
HEAD (`git archive`) with the two validated bundled catalog assets copied
into the tarball root. The content contract mirrors the binary tarballs
(assemble_artifacts.py): the shipped binary payloads stage
models.bundled.json + mcp-services.bundled.json at the archive root, and
the formula installs the same assets beside the built binary, so source
and binary distributions carry one identical payload layout.

Usage:
    python3 scripts/release/assemble_source.py \
        --repo-root <repo> --version <x.y.z> --out-dir <dir> \
        --catalog-assets <dir>

`--catalog-assets` is the directory holding the generated bundled catalog
assets (models.bundled.json + mcp-services.bundled.json); the packer
hard-fails without VALIDATED assets (version gates + >= 42 transport
tuples + >= 68 services — see scripts/release/bundle_catalog.py, the
catalog spec §3.2 no-cold-start layer 2), exactly like assemble_artifacts.
CI generates them from the fixture snapshot per build job; offline runs use
`bundle_catalog.py generate --fixture`.

`--version` must be a BARE semver (no prerelease/continuous suffix). The
homebrew-core candidate pins a stable release, the betas publish the
nightly channel, and the release workflow gates this step to stable tags,
so anything but `x.y.z` hard-fails.

Also written into --out-dir:
  SHA256SUMS    the one-row checksum for the source tarball
                ("<sha256>  prime-agent-<version>-src.tar.gz"), merging into
                the promote job's combined SHA256SUMS like a build job's
                rows;
  manifest.json EXACTLY {"version": "v<x.y.z>", "binaries": []}. The
                promote job's merge step reads every artifact dir's
                manifest.json and extends its binaries list; the empty
                list is a no-op there, and the src tarball must NOT appear
                as a binaries row because the channel-manifest
                completeness gate asserts the platform set of the update
                channel (a source row would also fail its per-platform
                file-name shape).

Determinism: the archive is packed through Python's tarfile with member
metadata pinned (mtime 0, uid/gid 0, uname/gname root, dirs 0755, plain
files 0644 or 0755 by the git tree's exec bit) and gzip mtime 0, the same
discipline as assemble_artifacts.pack_tarball, so two assemblies of the
same commit produce byte-identical archives. The staged content is the
committed tree (`git archive`), so a dirty worktree never leaks into the
tarball, and the packed modes derive from the git tree's exec bits — a host
umask (extraction or catalog-asset copy) cannot shift them.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

# The same release-scripts directory: the helpers this assembler reuses
# (fail/sha256_file) and the bundled-catalog gate, exactly the way
# assemble_artifacts.py imports bundle_catalog.
from assemble_artifacts import (
    BUNDLED_CATALOG_FILES,
    fail,
    sha256_file,
    validate_bundled_catalog_dir,
)

# A BARE stable semver only. assemble_artifacts.VERSION_RE accepts the
# prerelease/continuous suffixes the binary packer stamps (beta tags,
# continuous builds); the source tarball pins a stable release, so any
# suffix hard-fails here (the release workflow gates the assemble step to
# stable tags; this validation keeps the script itself honest).
BARE_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")

# The tagged tree must build the formula's install set: the workspace
# (Cargo.toml/Cargo.lock/crates), the crossterm patch (vendor/), and the
# shipped payload the formula installs beside the binary
# (assemble_artifacts.STAGED_ENTRIES minus the binary itself, plus the
# catalog assets staged below). A tree that lost any of these builds a
# formula that cannot compile or install — fail the release, not the tap.
REQUIRED_TREE_ENTRIES = (
    "Cargo.toml",
    "Cargo.lock",
    "crates",
    "vendor",
    "prime-agent-runtime",
    "skills",
    "LICENSE",
    "README.md",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--catalog-assets", required=True, type=Path,
                        help="directory with models.bundled.json + "
                             "mcp-services.bundled.json (see "
                             "scripts/release/bundle_catalog.py)")
    return parser.parse_args()


def validate_version(version: str) -> None:
    if not BARE_VERSION_RE.match(version):
        fail(
            f"invalid version {version!r} (source tarballs are cut only for "
            "bare stable semver like 1.0.0; prerelease, beta, and "
            "continuous suffixes build no source artifact)"
        )


def export_tree(repo_root: Path, staging: Path) -> None:
    """Extract the git tree at HEAD into `staging` (`git archive`).

    The archive is the COMMITTED tree, so a dirty worktree never leaks
    into the tarball. Extraction is member-by-member (the
    restamp_continuous.unpack_archive discipline: plain files and
    directories only, every member inside `staging`) because a git tree
    with a link or a submodule would need link-aware packing this
    assembler deliberately does not implement — fail loudly instead.
    """
    result = subprocess.run(
        ["git", "-C", str(repo_root), "archive", "--format=tar", "HEAD"],
        capture_output=True,
    )
    if result.returncode != 0:
        message = result.stderr.decode(errors="replace").strip()
        fail(f"git archive HEAD failed in {repo_root}: {message}")
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        for member in archive.getmembers():
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                fail(f"git archive carries an escaping member {member.name!r}")
            target = staging / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                assert source is not None
                with source, open(target, "wb") as sink:
                    shutil.copyfileobj(source, sink)
                # The committed mode exactly (git stores 0755/0644), so a
                # host umask cannot strip the tree's exec bits.
                os.chmod(target, member.mode)
            else:
                fail(
                    f"git tree member {member.name!r} is not a plain file "
                    "or directory; the source payload must be a plain tree"
                )


def stage_catalog_assets(staging: Path, catalog_assets: Path) -> dict:
    """Validate both bundled assets and copy them into the staging root.

    The same release gate as assemble_artifacts.stage_tree: the packer
    FAILS without VALIDATED assets (spec §3.9), and the assets sit at the
    tarball root so the formula (and the binary payloads) resolve them
    beside the installed package.
    """
    facts = validate_bundled_catalog_dir(catalog_assets)
    for name in BUNDLED_CATALOG_FILES:
        shutil.copyfile(catalog_assets / name, staging / name)
    return facts


def check_required_tree(staging: Path) -> None:
    missing = [name for name in REQUIRED_TREE_ENTRIES
               if not (staging / name).exists()]
    if missing:
        fail(
            "the tagged tree is missing the formula build/install inputs: "
            + ", ".join(missing)
        )


def _deterministic_source_member(member: tarfile.TarInfo) -> tarfile.TarInfo:
    """tarfile `filter`: fixed mtime/owner, deterministic modes, no links.

    The assemble_artifacts._deterministic_member discipline, except the
    source tree keeps the git tree's exec bit (a source tarball must
    round-trip the tagged tree, and stripping the bit would mutate the
    test scripts and installers a formula patch or an auditor might run):
    directories 0755, executables 0755, everything else 0644. Deriving
    the mode from the exec bit (not the staged file mode) keeps the packed
    archive umask-independent.
    """
    if member.issym() or member.islnk():
        raise ValueError(
            f"tarball payload contains a link entry {member.name!r}; "
            "the source payload must be plain files and directories"
        )
    member.uid = 0
    member.gid = 0
    member.uname = "root"
    member.gname = "root"
    member.mtime = 0
    if member.isdir():
        member.mode = 0o755
    else:
        member.mode = 0o755 if member.mode & 0o111 else 0o644
    return member


def pack_source_tarball(staging: Path, out_path: Path) -> None:
    """Deterministic tar.gz of the whole staging tree, files at the root.

    The pack mirrors assemble_artifacts.pack_tarball over the staging
    directory's full sorted top-level entry list (tarfile's recursive add
    walks each directory in sorted order): pinned member metadata, PAX
    format, gzip mtime 0, so two assemblies of the same commit are
    byte-identical.
    """
    staging_abs = staging.resolve()
    entries = sorted(path.name for path in staging_abs.iterdir())
    try:
        with open(out_path, "wb") as raw, \
             gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz, \
             tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name in entries:
                path = staging_abs / name
                if path.is_dir():
                    archive.add(path, arcname=name, recursive=True,
                                filter=_deterministic_source_member)
                else:
                    archive.add(path, arcname=name, recursive=False,
                                filter=_deterministic_source_member)
    except ValueError as error:
        out_path.unlink(missing_ok=True)
        fail(str(error))


def main() -> int:
    args = parse_args()
    validate_version(args.version)
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="prime-agent-source-"))
    try:
        export_tree(args.repo_root, staging)
        catalog_facts = stage_catalog_assets(staging, args.catalog_assets)
        check_required_tree(staging)
        archive_name = f"prime-agent-{args.version}-src.tar.gz"
        archive_path = out_dir / archive_name
        pack_source_tarball(staging, archive_path)
        archive_sha256 = sha256_file(archive_path)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    print(f"bundled catalog assets: {json.dumps(catalog_facts)}")

    # The one-row checksum the promote job's merge collects alongside every
    # build job's rows; the empty-binaries manifest keeps the src tarball
    # out of the channel manifest's platform set (see the module docstring).
    (out_dir / "SHA256SUMS").write_text(
        f"{archive_sha256}  {archive_name}\n", encoding="utf-8")
    (out_dir / "manifest.json").write_text(
        json.dumps({"version": f"v{args.version}", "binaries": []}, indent=2)
        + "\n", encoding="utf-8")

    print(json.dumps({
        "version": f"v{args.version}",
        "file": archive_name,
        "sha256": archive_sha256,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
