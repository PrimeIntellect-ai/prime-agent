#!/usr/bin/env python3
"""Bounded artifact validation and offline input preparation; no candidate execution."""
from __future__ import annotations
import argparse
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import tarfile
from provenance import file_sha256

MAX_FILE = 512 * 1024 ** 2
MAX_TOTAL = 1024 ** 3


def portable_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (path.is_absolute() or '\\' in name
            or any(part == '..' or ':' in part or part.endswith((' ', '.'))
                   or PureWindowsPath(part).is_reserved() for part in path.parts)):
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


def prepare(artifact: Path, destination: Path, sha: str, run_id: int, attempt: int, *, expected=None) -> dict:
    receipt_path = artifact / 'receipt.json'
    if receipt_path.is_symlink() or not receipt_path.is_file() or receipt_path.stat().st_size > 1024 ** 2:
        raise ValueError('invalid receipt')
    receipt = json.loads(receipt_path.read_text())
    if (receipt.get('repository') != 'PrimeIntellect-ai/prime-agent' or receipt.get('source_sha') != sha
            or receipt.get('run_id') != run_id or receipt.get('run_attempt') != attempt):
        raise ValueError('artifact receipt identity mismatch')
    if expected is not None and any(receipt.get(field) != value for field, value in expected.items()):
        raise ValueError('artifact builder or comparison identity mismatch')
    payloads = receipt.get('payloads', {})
    if not isinstance(payloads, dict) or not 1 <= len(payloads) <= 8 or not {'manifest.json', 'runtime-wheels.tar.gz'} <= set(payloads):
        raise ValueError('invalid payload inventory')
    total = 0
    for name, item in payloads.items():
        if not isinstance(name, str) or Path(name).name != name:
            raise ValueError('unsafe payload name')
        portable_path(name)
        path = artifact / name
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE:
            raise ValueError('invalid payload file')
        total += path.stat().st_size
        if item != {'bytes': path.stat().st_size, 'sha256': file_sha256(path)}:
            raise ValueError('payload checksum mismatch')
    if total > MAX_TOTAL:
        raise ValueError('oversized build payload')
    if (artifact / 'manifest.json').stat().st_size > 1024 ** 2:
        raise ValueError('oversized manifest JSON')
    manifest = json.loads((artifact / 'manifest.json').read_text())
    binaries = [row for row in manifest.get('binaries', []) if row.get('target') == 'x86_64-unknown-linux-gnu']
    if manifest.get('commit') != sha or len(binaries) != 1 or binaries[0]['file'] not in payloads:
        raise ValueError('missing exact Linux release payload')
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(artifact / binaries[0]['file'], 'r:gz') as archive:
        extract(archive, destination)
    if file_sha256(destination / 'prime-agent') != binaries[0]['executableSha256']:
        raise ValueError('release executable mismatch')
    wheel_dir = destination / 'runtime-wheels'
    wheel_dir.mkdir()
    with tarfile.open(artifact / 'runtime-wheels.tar.gz', 'r:gz') as archive:
        extract(archive, wheel_dir, max_file=16 * 1024 ** 2, max_total=64 * 1024 ** 2)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('base-artifact', 'head-artifact', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('base-sha', 'head-sha', 'event-head-sha', 'builder-sha', 'workflow-ref', 'source-repository'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--run-id', type=int, required=True)
    parser.add_argument('--run-attempt', type=int, required=True)
    parser.add_argument('--pr', type=int, required=True)
    args = parser.parse_args()
    if min(args.run_id, args.run_attempt, args.pr) <= 0:
        parser.error('requires positive GitHub identifiers')
    if not all(re.fullmatch('[0-9a-f]{40}', sha) for sha in (args.base_sha, args.head_sha, args.event_head_sha, args.builder_sha)):
        parser.error('requires full SHAs')
    args.out.mkdir(parents=True, exist_ok=False)
    inputs = args.out
    receipts = {}
    for side in ('base', 'head'):
        receipts[side] = prepare(getattr(args, side + '_artifact'), inputs / side,
                                 getattr(args, side + '_sha'), args.run_id, args.run_attempt,
                                 expected={'side': side, 'base_sha': args.base_sha,
                                           'head_sha': args.event_head_sha if side == 'base' else args.head_sha,
                                           'builder_sha': args.builder_sha, 'workflow_ref': args.workflow_ref,
                                           'source_repository': 'PrimeIntellect-ai/prime-agent' if side == 'base' else args.source_repository,
                                           'pr': args.pr})
    plan = {'base_sha': args.base_sha, 'head_sha': args.head_sha,
            'run_id': args.run_id, 'run_attempt': args.run_attempt,
            'builder_sha': args.builder_sha, 'receipts': receipts}
    (inputs / 'prepared.json').write_text(json.dumps(plan, indent=2) + '\n')
    # A restrictive operator umask must not make read-only inputs inaccessible.
    for path in (inputs, *inputs.rglob('*')):
        mode = path.lstat().st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise ValueError('unexpected prepared input type')
        path.chmod(0o755 if stat.S_ISDIR(mode) or path.name == 'prime-agent' else 0o644)


if __name__ == '__main__':
    main()
