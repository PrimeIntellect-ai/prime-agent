#!/usr/bin/env python3
"""Check actual reconnect banners and their SemVer restart advice.

An all-numeric prerelease suffix is older than its release, so it never asks for
a window restart. Raw screens and actual versions are retained. The ordinary
post-reconnect command catalog response is held until capture so a resync cannot
erase the transient status before paint. This checks version advice, not restart
durability. No fake renderer or extracted comparator executes here.
"""
import argparse
import errno
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import threading
import uuid

from lifecycle_lib import Supervisor, Terminal, actual_hello, digest, env_for, fixture_state


def runtime_version(binary, root, env):
    import subprocess
    probe = subprocess.run([str(binary), '--version'], cwd=root, env=env,
                           text=True, capture_output=True, timeout=10, check=True)
    matches = re.findall(r'\d+\.\d+\.\d+(?:[-+][\w.+-]+)?', probe.stdout)
    if len(matches) != 1:
        raise RuntimeError('cannot identify actual runtime version: ' + probe.stdout)
    return matches[0]


class RestartSupervisor(Supervisor):
    def __init__(self, *args):
        self.release_catalog = threading.Event()
        self.catalog_held = threading.Event()
        super().__init__(*args)

    def send(self, sock, data):
        if self.closed and data.get('type') == 'response' and data.get('command') == 'get_commands':
            # A resync rebuild can clear the transcript after the status shows.
            # Hold that rebuild at its ordinary catalog request so a real
            # terminal frame can expose the banner.
            self.catalog_held.set()
            if not self.release_catalog.wait(35):
                raise TimeoutError('restart catalog gate was not released')
        if data.get('type') == 'response' and data.get('command') in ('attach', 'list'):
            # Announced restart recovery locates its durable session in list
            # before attaching it, unlike the ordinary transport EOF path.
            summary = fixture_state(self.root, 's1')
            summary.update(id='s1', sessionFile=str(self.root / 'agent/sessions/fixture.jsonl'))
            if data['command'] == 'attach':
                payload = dict(data['data'])
                payload['snapshot'] = dict(payload['snapshot'], summary=summary)
                data = dict(data, data=payload)
            else:
                data = dict(data, data={'sessions': [summary]})
        super().send(sock, data)

    def restart(self, version):
        # The client reserves the versioned restart banner for an announced
        # daemon shutdown/update. A bare EOF exercises transport recovery and
        # emits a different generic reconnect status.
        with self.lock:
            connections = [connection for connection in self.sockets if connection.fileno() >= 0]
            self.hello = dict(self.hello, appVersion=version,
                              supervisorGeneration=str(uuid.uuid4()))
            self.closed = True
        for connection in connections:
            try:
                self.send(connection, {'type': 'daemon_closing', 'reason': 'shutdown'})
                self.send(connection, {'type': 'session_closed', 'activeSessionId': 's1',
                                       'reason': 'shutdown'})
                connection.shutdown(socket.SHUT_RDWR)
            except OSError as error:
                if error.errno not in (errno.EBADF, errno.EPIPE, errno.ECONNRESET, errno.ENOTCONN):
                    raise


def run_case(binary, root, hello, client, name, observed=None):
    root.mkdir()
    env = env_for(root)
    base = client.split('+')[0].split('-')[0]
    parts = [int(x) for x in base.split('.')]
    newer = f'{parts[0] + 1}.0.0'
    versions = {'same': client, 'newer': newer, 'older': '0.0.0',
                'metadata': base + '+fixture', 'numeric_prerelease': base + '-20'}
    daemon = versions[name]
    observed = observed if observed is not None else {}
    observed.update(daemon_version=daemon, client_version=client, executed=False)
    path = root / 'fixture.sock'
    fixture_hello = dict(hello, socketPath=str(path), supervisorSocketPath=str(path))
    server = RestartSupervisor(path, fixture_hello, 'restart', root)
    terminal = None
    try:
        terminal = Terminal([str(binary), '--daemon-socket', str(server.path)], root, env)
        terminal.wait('initial real TUI attach', lambda: server.attaches >= 1
                      and bool(terminal.screen.text().strip()), server)
        terminal.send('RECONNECT_VERSION_PARITY')
        terminal.wait('ordinary prompt editor ready', lambda:
                      'RECONNECT_VERSION_PARITY' in terminal.screen.text(), server)
        terminal.send('\r')
        terminal.wait('initial turn settled through actual TUI subscription', lambda:
                      'Fixture settled 1' in terminal.screen.text(), server)
        server.restart(daemon)
        terminal.wait('reattach banner rendered', lambda: server.post_close_attached
                      and 'Daemon restarted (v' in terminal.screen.text(), server)
        screen = terminal.screen.text()
        actual_advice = 'restart the window to pick up the update.' in screen
        expected_advice = name == 'newer'
        assert actual_advice == expected_advice, (name, screen)
        if name == 'same':
            expected = f'Daemon restarted (v{daemon}) - reconnected'
        elif expected_advice:
            expected = (f'Daemon restarted (v{daemon}), this window still runs v{client} '
                        '- restart the window to pick up the update.')
        else:
            expected = f'Daemon restarted (v{daemon}), this window runs v{client}.'
        # Reflow is terminal layout only; all rendered cells and raw bytes are retained.
        assert expected in ' '.join(screen.split()), (expected, screen)
        observed.update({'daemon_version': daemon, 'client_version': client,
                'restart_advice': actual_advice, 'expected_banner': expected,
                'screen': screen, 'raw_ansi': terminal.raw.decode('utf-8', 'replace'),
                'wire_commands': server.commands, 'executed': True})
        return observed
    except Exception as error:
        observed['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        server.release_catalog.set()
        observed['resync_catalog_held'] = server.catalog_held.is_set()
        observed['wire_commands'] = list(server.commands)
        observed['fixture_errors'] = list(server.errors)
        observed['post_close_attached'] = server.post_close_attached
        observed['socket_connection_count'] = len(server.sockets)
        observed['diagnostic_logs'] = {str(path.relative_to(root)): path.read_text(errors='replace')[-12000:]
                                       for path in (root / 'agent/logs').glob('*.log')}
        if terminal is not None:
            observed['screen'] = terminal.screen.text()
            observed['raw_ansi'] = terminal.raw.decode('utf-8', 'replace')
        if terminal is not None:
            terminal.close()
        server.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    receipt = {'scenario': 'reconnect_version',
               'fixture': 'Announced shutdown/session_closed, durable attach/list identity, successor hello; ordinary resync command catalog response held until actual banner capture.',
               'scope': 'Actual rendered version advice; not restart durability or uninterrupted banner visibility.',
               'cases': {}, 'passed': False}
    try:
        with tempfile.TemporaryDirectory(prefix='pa-reconnect-check-', dir='/tmp') as temp:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            root = Path(temp) / 'rust'
            root.mkdir()
            env = env_for(root)
            client = runtime_version(binary, root, env)
            # Fixture expects a current stable binary; prerelease algorithm edges
            # are separately covered by red-first exact production-module tests.
            assert '-' not in client and '+' not in client, client
            hello = actual_hello(binary, root, env)
            receipt.update(binary_sha256=digest(binary), actual_hello=hello, client_version=client)
            for name in ('same', 'newer', 'older', 'metadata', 'numeric_prerelease'):
                observed = receipt['cases'][name] = {}
                run_case(binary, root / name, hello, client, name, observed)
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
