#!/usr/bin/env python3
"""Package hosted builds using the existing release assembler; never publish results."""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

from provenance import file_sha256 as digest, harness_sha256

TARGET = 'x86_64-unknown-linux-gnu'
IMAGE = 'ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02'
MAX_BINARY_BYTES = 512 * 1024 ** 2
MAX_EXPORT_BYTES = 1024 ** 3


def regular(path: Path, parent: Path) -> Path:
    if not path.is_absolute() or parent.resolve(strict=True) != parent.absolute():
        raise ValueError('expected canonical build directory')
    if path.is_symlink() or not path.is_file():
        raise ValueError('expected regular binary')
    resolved = path.resolve(strict=True)
    resolved.relative_to(parent.resolve(strict=True))
    if not 0 < resolved.stat().st_size <= MAX_BINARY_BYTES:
        raise ValueError('binary size out of bounds')
    return resolved


def test_executable(records: Path, metadata: Path, source: Path) -> Path:
    packages = [p for p in json.loads(metadata.read_text())['packages'] if p['name'] == 'pa-core'
                and Path(p['manifest_path']) == source / 'crates/pa-core/Cargo.toml']
    if len(packages) != 1:
        raise ValueError('missing or duplicate pa-core package identity')
    if records.stat().st_size > 32 * 1024 ** 2:
        raise ValueError('oversized Cargo records')
    matches = []
    for line in records.read_text().splitlines():
        row = json.loads(line)
        target = row.get('target', {})
        if (row.get('reason') == 'compiler-artifact' and row.get('package_id') == packages[0]['id']
                and target.get('name') == 'pa_core'
                and target.get('kind') == ['lib'] and row.get('profile', {}).get('test') is True
                and row.get('executable')):
            matches.append(Path(row['executable']))
    if len(matches) != 1:
        raise ValueError('expected exactly one pa-core library test executable')
    return regular(matches[0], source / 'target' / TARGET / 'release' / 'deps')


def elf_requirements(binary: Path) -> dict:
    symbols = subprocess.check_output(['objdump', '-T', str(binary)], text=True)
    versions = {tuple(map(int, match.split('.'))) for match in re.findall(r'GLIBC_([0-9.]+)', symbols)}
    if not versions or max(versions) > (2, 35):
        raise ValueError('ELF exceeds GLIBC 2.35 baseline or lacks inspectable GLIBC symbols')
    dynamic = subprocess.check_output(['readelf', '-d', str(binary)], text=True)
    return {'max_glibc': '.'.join(map(str, max(versions))),
            'needed': re.findall(r'\(NEEDED\).*\[([^\]]+)\]', dynamic)}


def validate_identity(sha: str, builder: str, base: str, head: str, side: str) -> None:
    if any(not re.fullmatch('[0-9a-f]{40}', value) for value in (sha, builder, base, head)):
        raise ValueError('requires immutable full commit SHAs')
    if side not in ('base', 'head') or sha != {'base': base, 'head': head}[side]:
        raise ValueError('source does not match requested comparison side')


def pack_test(binary: Path, output: Path) -> None:
    with output.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as archive:
            member = tarfile.TarInfo('pa-core-tests')
            member.size = binary.stat().st_size
            member.mode = 0o755
            with binary.open('rb') as payload:
                archive.addfile(member, payload)


def payload_inventory(out: Path) -> dict:
    files = sorted(out.iterdir())
    if len(files) > 8:
        raise ValueError('unexpected export file count')
    sizes = {p.name: regular(p, out).stat().st_size for p in files}
    if sum(sizes.values()) > MAX_EXPORT_BYTES:
        raise ValueError('export exceeds total upload limit')
    return {p.name: {'sha256': digest(p), 'bytes': sizes[p.name]} for p in files}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'tooling', 'out', 'cargo-records', 'cargo-metadata', 'wheel-python'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('sha', 'builder-sha', 'base-sha', 'head-sha', 'repository', 'source-repository', 'workflow-ref'):
        parser.add_argument('--' + name, required=True)
    for name in ('run-id', 'run-attempt', 'pr'):
        parser.add_argument('--' + name, type=int, required=True)
    parser.add_argument('--side', choices=('base', 'head'), required=True)
    args = parser.parse_args()
    validate_identity(args.sha, args.builder_sha, args.base_sha, args.head_sha, args.side)
    if args.repository != 'PrimeIntellect-ai/prime-agent' or min(args.run_id, args.run_attempt, args.pr) <= 0:
        parser.error('invalid GitHub receipt identity')
    if not re.fullmatch(r'[A-Za-z0-9-]+/[A-Za-z0-9_.-]+', args.source_repository):
        parser.error('invalid source repository')
    source, tooling = args.source.resolve(strict=True), args.tooling.resolve(strict=True)
    for root, expected in ((source, args.sha), (tooling, args.builder_sha)):
        if subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() != expected:
            raise ValueError('checkout revision mismatch')
    args.out.mkdir(parents=True, exist_ok=False)
    out = args.out.resolve()
    section = (source / 'Cargo.toml').read_text().split('[workspace.package]', 1)[1].split('\n[', 1)[0]
    version = re.search(r'^version\s*=\s*"([^"]+)"', section, re.MULTILINE).group(1)
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?', version):
        raise ValueError('invalid workspace version')
    binary = regular(source / 'target' / TARGET / 'release' / 'prime-agent', source / 'target')
    test = test_executable(args.cargo_records, args.cargo_metadata, source)
    requirements = {name: elf_requirements(path) for name, path in (('cli', binary), ('pa_core_tests', test))}
    release = tooling / 'scripts' / 'release'
    catalog = out / 'catalog'
    subprocess.run([sys.executable, str(release / 'bundle_catalog.py'), 'generate', '--fixture', '--out', str(catalog)], check=True)
    subprocess.run([sys.executable, str(release / 'split_debug.py'), '--binary', str(binary),
                    '--shipped', str(out / 'prime-agent'), '--out', str(out),
                    '--version', version, '--target', TARGET], check=True)
    decoder = out / f'prime-agent-{version}-linux-x64.debug.gz'
    subprocess.run([sys.executable, str(release / 'assemble_artifacts.py'), '--repo-root', str(source),
                    '--version', version, '--target', TARGET, '--sha', args.sha,
                    '--binary', str(out / 'prime-agent'), '--decoder', str(decoder),
                    '--catalog-assets', str(catalog), '--out-dir', str(out)], check=True)
    shutil.rmtree(catalog)
    (out / 'prime-agent').unlink()
    test_dir = out / 'tests'
    test_dir.mkdir()
    shutil.copyfile(test, test_dir / 'pa-core-tests')
    subprocess.run(['objcopy', '--strip-debug', str(test_dir / 'pa-core-tests')], check=True)
    (test_dir / 'pa-core-tests').chmod(0o755)
    pack_test(test_dir / 'pa-core-tests', out / 'pa-core-tests.tar.gz')
    shutil.rmtree(test_dir)
    wheels = out / 'runtime-wheels'
    wheels.mkdir()
    packages = [source / 'prime-agent-runtime', *(source / 'skills' / name for name in
                ('agent-message', 'agent-observe', 'attach-image', 'compact', 'edit',
                 'goal', 'refine', 'rlm-heartbeat', 'websearch'))]
    subprocess.run([str(args.wheel_python), '-m', 'pip', 'wheel', '--no-index', '--no-cache-dir',
                    '--no-deps', '--no-build-isolation', '--wheel-dir', str(wheels),
                    *(str(path) for path in packages)], check=True, timeout=180)
    built = sorted(wheels.iterdir())
    if len(built) != len(packages) or any(not p.name.endswith('-py3-none-any.whl') for p in built):
        raise ValueError('unexpected bundled runtime wheels')
    # Reuse the release packer's deterministic plain-file policy.
    sys.path.insert(0, str(release))
    from assemble_artifacts import pack_tarball
    pack_tarball(wheels, out / 'runtime-wheels.tar.gz', [p.name for p in built])
    shutil.rmtree(wheels)
    payloads = payload_inventory(out)
    receipt = {'schema': 1, 'repository': args.repository, 'pr': args.pr,
               'source_repository': args.source_repository,
               'run_id': args.run_id, 'run_attempt': args.run_attempt, 'workflow_ref': args.workflow_ref,
               'builder_sha': args.builder_sha, 'side': args.side, 'source_sha': args.sha,
               'harness_sha256': harness_sha256(),
               'base_sha': args.base_sha, 'head_sha': args.head_sha, 'target': TARGET, 'build_image': IMAGE,
               'rustc': subprocess.check_output(['rustc', '-vV'], text=True).strip(),
               'cargo_lock_sha256': digest(source / 'Cargo.lock'),
               'profile': 'release; locked; incremental=0; jobs=2; no shared cache',
               'runtime_profile': 'bundled source and prebuilt pure Python wheels; dependencies supplied by locked image',
               'catalog_profile': 'synthetic offline fixture catalogs',
               'test_scope': 'pa-core library tests; fixture-dependent tests may require source paths',
               'elf_requirements': requirements, 'payloads': payloads,
               'accuracy_attested': False}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
