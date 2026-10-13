#!/usr/bin/env python3
"""Compare actual TS/Rust reconnect banners, recording the SemVer correction.

The pinned TS runtime treats an all-numeric suffix as another release segment;
Rust deliberately corrects that invalid precedence. Raw screens and both actual
versions are retained. No fake renderer or extracted comparator executes here.
"""
import argparse
import json
import os
from pathlib import Path
import re
import tempfile

from review_draft_disconnect_parity import (Supervisor, Terminal, actual_hello,
                                           digest, env_for, TS_ARCHIVE_SHA256)


def runtime_version(binary, root, env):
    import subprocess
    probe = subprocess.run([str(binary), '--version'], cwd=root, env=env,
                           text=True, capture_output=True, timeout=10, check=True)
    matches = re.findall(r'\d+\.\d+\.\d+(?:[-+][\w.+-]+)?', probe.stdout)
    if len(matches) != 1:
        raise RuntimeError('cannot identify actual runtime version: ' + probe.stdout)
    return matches[0]


def run_case(kind, binary, root, hello, client, name):
    root.mkdir()
    env = env_for(root, kind)
    base = client.split('+')[0].split('-')[0]
    parts = [int(x) for x in base.split('.')]
    newer = f'{parts[0] + 1}.0.0'
    versions = {'same': client, 'newer': newer, 'older': '0.0.0',
                'metadata': base + '+fixture', 'numeric_prerelease': base + '-20'}
    daemon = versions[name]
    server = Supervisor(root / 'fixture.sock', hello, 'queued_close', root)
    terminal = None
    try:
        terminal = Terminal([str(binary), '--daemon-socket', str(server.path)], root, env)
        terminal.wait('initial real TUI attach', lambda: server.attaches >= 1
                      and bool(terminal.screen.text().strip()), server)
        # New connections receive this successor's version; initial hello is untouched.
        server.hello = dict(hello, appVersion=daemon)
        terminal.send('RECONNECT_VERSION_PARITY')
        terminal.wait('ordinary prompt editor', lambda:
                      'RECONNECT_VERSION_PARITY' in terminal.screen.text(), server)
        terminal.send('\r')
        terminal.wait('reattach banner rendered', lambda: server.post_close_attached
                      and 'Daemon restarted (v' in terminal.screen.text(), server)
        screen = terminal.screen.text()
        actual_advice = 'restart the window to pick up the update.' in screen
        # This explicitly documents the baseline TS defect corrected by #3566.
        expected_advice = name == 'newer' or (kind == 'ts' and name == 'numeric_prerelease')
        assert actual_advice == expected_advice, (kind, name, screen)
        if name == 'same':
            expected = f'Daemon restarted (v{daemon}) - reconnected'
        elif expected_advice:
            expected = (f'Daemon restarted (v{daemon}), this window still runs v{client} '
                        '- restart the window to pick up the update.')
        else:
            expected = f'Daemon restarted (v{daemon}), this window runs v{client}.'
        # Reflow is terminal layout only; all rendered cells and raw bytes are retained.
        assert expected in ' '.join(screen.split()), (expected, screen)
        return {'daemon_version': daemon, 'client_version': client,
                'restart_advice': actual_advice, 'expected_banner': expected,
                'screen': screen, 'raw_ansi': terminal.raw.decode('utf-8', 'replace'),
                'wire_commands': server.commands, 'executed': True}
    finally:
        if terminal is not None:
            terminal.close()
        server.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    receipt = {'scenario': 'reconnect_version', 'ts_archive_expected_sha256': TS_ARCHIVE_SHA256,
               'intentional_difference': 'TS interprets numeric prerelease -20 as a release segment; Rust correctly treats it as older than the release.',
               'observations': {}, 'passed': False}
    try:
        receipt['ts_archive_sha256'] = digest(Path(os.environ['PA_TS_ARCHIVE']))
        assert receipt['ts_archive_sha256'] == TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-reconnect-parity-', dir='/tmp') as temp:
            for kind, variable in (('ts', 'PA_TS_BINARY'), ('rust', 'PA_RUST_BINARY')):
                binary = Path(os.environ[variable]).resolve()
                root = Path(temp) / kind
                root.mkdir()
                env = env_for(root, kind)
                client = runtime_version(binary, root, env)
                # Fixture expects current stable binaries; prerelease algorithm edges
                # are separately covered by red-first exact production-module tests.
                assert '-' not in client and '+' not in client, client
                hello = actual_hello(binary, root, env)
                receipt['observations'][kind] = {'binary_sha256': digest(binary),
                                                'actual_hello': hello, 'client_version': client,
                                                'cases': {}}
                for name in ('same', 'newer', 'older', 'metadata', 'numeric_prerelease'):
                    receipt['observations'][kind]['cases'][name] = run_case(
                        kind, binary, root / name, hello, client, name)
            ts, rust = (receipt['observations'][kind]['cases'] for kind in ('ts', 'rust'))
            for name in ('same', 'newer', 'older', 'metadata'):
                assert ts[name]['restart_advice'] == rust[name]['restart_advice'], name
            assert ts['numeric_prerelease']['restart_advice'] is True
            assert rust['numeric_prerelease']['restart_advice'] is False
            receipt['passed'] = True
    except Exception as error:
        receipt['error'] = f'{type(error).__name__}: {error}'
    Path(args.receipt).parent.mkdir(parents=True, exist_ok=True)
    Path(args.receipt).write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'scenario': receipt['scenario'], 'passed': receipt['passed'],
                      'error': receipt.get('error')}))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
