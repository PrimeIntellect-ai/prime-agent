#!/usr/bin/env python3
"""Validate commit-bound release artifacts and prepare bounded offline inputs."""
from __future__ import annotations
import argparse
import gzip
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile

from provenance import file_sha256

MAX_FILE = 512 * 1024 ** 2
MAX_TOTAL = 1024 ** 3
MAX_MANIFEST_BYTES = 1024 ** 2
TARGET = 'x86_64-unknown-linux-gnu'


class _CappedReader:
    """Reject oversized TAR metadata reads before allocation."""

    def __init__(self, stream):
        self._stream = stream
        stream.seek(0, os.SEEK_END)
        self._length = stream.tell()
        stream.seek(0)

    def read(self, size=-1):
        if size is None or size < 0:
            size = self._length
        if size > self._length:
            raise ValueError('artifact exceeds expanded size limit')
        return self._stream.read(size)

    def seek(self, offset, whence=os.SEEK_SET):
        return self._stream.seek(offset, whence)

    def tell(self):
        return self._stream.tell()


def portable_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('unsafe portable artifact path')
    return path


def extract(archive: tarfile.TarFile, destination: Path, *, max_file=MAX_FILE, max_total=MAX_TOTAL) -> None:
    seen = set()
    total = 0
    for member in archive:
        path = portable_path(member.name)
        if (str(path) in seen or len(seen) >= 10000
                or not (member.isdir() or member.isfile()) or not 0 <= member.size <= max_file):
            raise ValueError('unsafe or oversized artifact member')
        seen.add(str(path))
        total += member.size
        if total > max_total:
            raise ValueError('artifact exceeds expanded size limit')
        target = destination.joinpath(*path.parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('xb') as output:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise ValueError('truncated artifact')
                    output.write(chunk)
                    remaining -= len(chunk)
            target.chmod(0o755 if path.name == 'prime-agent' else 0o644)


def prepare(artifact: Path, destination: Path, sha: str) -> None:
    manifest_path = artifact / 'manifest.json'
    if (manifest_path.is_symlink() or not manifest_path.is_file()
            or manifest_path.stat().st_size > MAX_MANIFEST_BYTES):
        raise ValueError('invalid release manifest')
    manifest = json.loads(manifest_path.read_text())
    binaries = [row for row in manifest.get('binaries', []) if row.get('target') == TARGET]
    if manifest.get('commit') != sha or len(binaries) != 1:
        raise ValueError('release manifest does not name the exact comparison commit')
    name = binaries[0].get('file')
    if not isinstance(name, str) or Path(name).name != name:
        raise ValueError('unsafe release payload name')
    portable_path(name)
    payload = artifact / name
    if payload.is_symlink() or not payload.is_file() or not 0 < payload.stat().st_size <= MAX_FILE:
        raise ValueError('missing or invalid release payload')
    if file_sha256(payload) != binaries[0].get('sha256'):
        raise ValueError('release payload checksum mismatch')
    destination.mkdir(parents=True, exist_ok=False)
    # Bound extension metadata before tarfile can allocate its declared size.
    with open(payload, 'rb') as compressed:
        with gzip.GzipFile(fileobj=compressed) as stream, tempfile.TemporaryFile() as expanded:
            total = 0
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                total += len(chunk)
                if total > MAX_TOTAL:
                    raise ValueError('artifact exceeds expanded size limit')
                expanded.write(chunk)
            expanded.seek(0)
            with tarfile.open(fileobj=_CappedReader(expanded), mode='r:') as archive:
                extract(archive, destination)
    if file_sha256(destination / 'prime-agent') != binaries[0].get('executableSha256'):
        raise ValueError('release executable mismatch')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('base-artifact', 'head-artifact', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('base-sha', 'head-sha'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    if not all(re.fullmatch('[0-9a-f]{40}', sha) for sha in (args.base_sha, args.head_sha)):
        parser.error('requires full lowercase commit SHAs')
    args.out.mkdir(parents=True, exist_ok=False)
    for side in ('base', 'head'):
        prepare(getattr(args, side + '_artifact'), args.out / side, getattr(args, side + '_sha'))
    # A restrictive operator umask must not make read-only inputs inaccessible.
    for path in (args.out, *args.out.rglob('*')):
        mode = path.lstat().st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise ValueError('unexpected prepared input type')
        path.chmod(0o755 if stat.S_ISDIR(mode) or path.name == 'prime-agent' else 0o644)


if __name__ == '__main__':
    main()
