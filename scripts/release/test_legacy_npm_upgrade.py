#!/usr/bin/env python3
"""Opt-in integration test: published TS npm CLI -> Rust bridge -> real Rust.

Supply a released npm tarball and its SHA256SUMS, a candidate native archive,
and optionally a prepared npm prefix to avoid reinstalling historical deps.
Dependency installation needs network; the actual update uses only localhost.
No npm lifecycle scripts execute, and every installation/state path is isolated.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

import npm_bridge
from test_legacy_upgrade import archive_identity, digest, execute, isolated_environment, publish_archive, release_server


def exercise(args, root: Path) -> dict:
    archive = args.previous_archive.resolve()
    checksum = next((line.split()[0] for line in args.previous_checksums.read_text().splitlines()
                     if len(line.split()) == 2 and line.split()[1].lstrip('*') == archive.name), None)
    if checksum != digest(archive):
        raise ValueError('Historical npm artifact checksum mismatch')
    with tarfile.open(archive) as package:
        source = json.load(package.extractfile('package/package.json'))
    assert source['name'] == 'prime-agent'
    source_entrypoint = source['bin']['prime-agent']
    if source_entrypoint not in ('dist/cli.js', 'dist/bundle/cli.js'):
        raise ValueError(f'Unknown historical entrypoint: {source_entrypoint}')
    version, platform = archive_identity(args.archive)
    feed = root / 'feed'
    publish_archive(feed, args.archive)
    release = feed / 'releases' / f'v{version}'
    channel = 'beta' if '-beta' in source['version'] else 'stable'
    bridge = npm_bridge.assemble(Path(__file__).resolve().parents[2], release, version, channel, args.fallback_tarball)
    manifest = {'version': version, 'package': 'prime-agent',
                'tarball': f'releases/v{version}/{bridge["tarball"]}',
                'binaries': [{'platform': platform, 'file': args.archive.name, 'sha256': digest(args.archive)}]}
    (feed / ('beta.json' if channel == 'beta' else 'latest.json')).write_text(json.dumps(manifest))
    steps = []
    with release_server(feed) as base:
        env = isolated_environment(root / 'user', base)
        prefix = root / 'npm prefix'
        if args.previous_prefix:
            shutil.copytree(args.previous_prefix, prefix, symlinks=True)
        env.update({'npm_config_prefix': str(prefix), 'npm_config_cache': str(root / 'npm cache'),
                    'npm_config_ignore_scripts': 'true', 'npm_config_audit': 'false', 'npm_config_fund': 'false',
                    'npm_config_update_notifier': 'false',
                    'PRIME_AGENT_RUST_PREFIX': str(root / 'rust prefix'), 'PRIME_AGENT_ALLOW_HTTP': '1',
                    'PRIME_AGENT_DAEMON_SOCKET': str(root / 'daemon.sock')})
        env['PATH'] = str(prefix / 'bin') + os.pathsep + env['PATH']
        if not args.previous_prefix:
            steps.append(execute(['npm', 'install', '-g', str(archive)], env))
        package_dir = prefix / 'lib/node_modules/prime-agent'
        cli = package_dir / source_entrypoint
        with tarfile.open(archive) as package:
            assert cli.read_bytes() == package.extractfile(f'package/{source_entrypoint}').read(), 'Prepared prefix is not the supplied released CLI'
        old = execute(['node', str(cli), '--version'], env)
        assert (old['stdout'] + old['stderr']).strip() == source['version'], old
        steps.append(old)
        state = Path(env['PRIME_AGENT_CODING_AGENT_DIR'])
        witness = state / 'skills/upgrade-witness/SKILL.md'
        witness.parent.mkdir(parents=True)
        witness.write_text('# Preserve this skill\n')
        update = execute(['node', str(cli), 'update', '--force'], env)
        steps.append(update)
        # The old updater launches the bridge as its coordinator. No manual
        # curl/reinstall/bridge invocation is permitted before this assertion.
        # Some earliest clients never relaunch; their explicit opt-in case
        # verifies activation through the next ordinary version command.
        native = Path(env['PRIME_AGENT_RUST_PREFIX']) / 'bin/prime-agent'
        activated_during_update = native.is_file()
        if not activated_during_update and not args.allow_deferred_activation:
            diagnostic = subprocess.run(['node', str(cli), '--version'], env=env, cwd=env['HOME'], capture_output=True, text=True, timeout=180)
            raise RuntimeError(json.dumps({'message': 'Old update did not activate the Rust installation', 'steps': steps, 'bridge_diagnostic': {'exit_code': diagnostic.returncode, 'stdout': diagnostic.stdout, 'stderr': diagnostic.stderr}}, indent=2))
        assert 'could not coordinate' not in update['stderr'].lower(), update
        assert 'could not restart' not in update['stderr'].lower(), update
        probe = execute(['node', str(cli), '--version'], env)
        assert probe['stdout'].strip() == version, probe
        assert native.is_file(), 'Normal relaunch did not activate Rust'
        steps.append(probe)
        steps.append(execute(['node', str(cli), '--help'], env))
        assert witness.read_text() == '# Preserve this skill\n'
        assert json.loads((package_dir / 'package.json').read_text())['primeAgentRustBridge'] is True
    return {'status': 'passed', 'source_version': source['version'], 'target_version': version,
            'source_sha256': checksum, 'activation': 'during update' if activated_during_update else 'first normal relaunch',
            'source_entrypoint': source_entrypoint, 'channel': channel, 'candidate_sha256': digest(args.archive),
            'bridge_sha256': bridge['sha256'], 'coverage': ['real published npm CLI update', 'bridge relaunch',
            'Rust activation', 'version/help', 'user skill preservation', 'paths with spaces'],
            'not_covered': ['TUI /update', 'running daemon handoff', 'session continuation', 'kernel bootstrap', 'second Rust update'], 'steps': steps}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-archive', type=Path, required=True)
    parser.add_argument('--previous-checksums', type=Path, required=True)
    parser.add_argument('--previous-prefix', type=Path)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--fallback-tarball', type=Path, required=True)
    parser.add_argument('--allow-deferred-activation', action='store_true',
                        help='Older updaters without a coordinator may activate Rust on the next normal command')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    args.archive = args.archive.resolve()
    with tempfile.TemporaryDirectory(prefix='pa-npm-', dir='/tmp') as directory:
        try:
            report = exercise(args, Path(directory))
        except (AssertionError, OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
            report = {'status': 'failed', 'error': str(error)}
    rendered = json.dumps(report, indent=2)
    if args.report:
        args.report.write_text(rendered + '\n')
    print(rendered)
    return int(report['status'] != 'passed')


if __name__ == '__main__':
    raise SystemExit(main())
