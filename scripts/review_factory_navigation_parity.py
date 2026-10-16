#!/usr/bin/env python3
"""Hosted actual Rust factory Left/Right navigation with raw PTY evidence.

Pinned TS daemon capability absence is recorded explicitly: there is no factory
page counterpart. A protocol fixture supplies one real-shaped run; actual Rust
input parsing, view rendering and fallback keys execute unchanged.
"""
import argparse
import copy
import json
import os
import select
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from review_agent_bounce_parity import Client
from review_dock_screen import DockScreen
from review_draft_disconnect_parity import Supervisor, Terminal, digest, env_for, TS_ARCHIVE_SHA256
from review_goal_fixture_lifecycle import OwnedProcesses, TAG, finish

RUN = 'factory-navigation-run'
GRAPH = {'runs': [{'run_id': RUN, 'spec_id': 'navigation-fixture', 'name': RUN,
    'state': 'running', 'machine': {'states': [{'id': 'work'}], 'transitions': []},
    'usage': {'running': 1}, 'nodes': [{'id': 'work', 'status': 'running', 'running': 1}]}]}


class FactorySupervisor(Supervisor):
    def send(self, sock, data):
        data = copy.deepcopy(data)
        if data.get('type') == 'daemon_hello':
            data['serverCapabilities'] = ['session_input_admission', 'factory_activity']
        if data.get('type') == 'response' and data.get('command') == 'factory_activity':
            # The base fixture already recognizes this lane with an empty
            # legacy response. Supply its graph shape without mutating errors.
            data['data'] = copy.deepcopy(GRAPH)
        super().send(sock, data)


def hello(binary, root, env, observed):
    path = root / 'hello.sock'
    scope = OwnedProcesses(binary, root, path)
    daemon = client = None
    with open(root / 'hello.log', 'wb') as log:
        try:
            command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(path)]
            daemon = subprocess.Popen(command, cwd=root, env=env, stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True)
            scope.register(daemon, command)
            client = Client(path, daemon)
            observed['hello'] = client.hello
        finally:
            finish(scope, client, daemon, observed)
    assert observed['cleanup_verified'], observed
    return observed['hello']


def factory_click(screen):
    for row_index, row in enumerate(screen.cells):
        text = ''.join(row)
        if 'factory' in text:
            return '\x1b[<0;%d;%dM\x1b[<0;%d;%dm' % ((text.index('factory') + 2, row_index + 1) * 2)
    raise AssertionError('factory dock click target absent')


def observe(binary, kind, root, observed):
    env = env_for(root, kind)
    env[TAG] = str(root)
    discovered = observed['hello_discovery'] = {}
    actual = hello(binary, root, env, discovered)
    if kind == 'ts':
        assert 'factory_activity' not in actual.get('serverCapabilities', []), actual
        observed.update(behavior_verified=True, cleanup_verified=True)
        return
    server = FactorySupervisor(root / 'ui.sock', actual, 'factory-navigation', root)
    scope = OwnedProcesses(binary, root, server.path)
    terminal = None
    observed['frames'] = {}
    try:
        command = [str(binary), '--daemon-socket', str(server.path)]
        terminal = Terminal(command, root, env)
        terminal.screen = DockScreen()
        scope.register(terminal.process, command)
        def snap(label, predicate):
            terminal.wait(label, lambda: predicate(terminal.screen.text()), server)
            observed['frames'][label] = {'text': terminal.screen.text(),
                'styles': copy.deepcopy(terminal.screen.styles)}
        snap('dock', lambda text: server.attaches > 0 and 'factory' in text
             and any(c.get('type') == 'factory_activity' for c in server.commands))
        terminal.send(factory_click(terminal.screen))
        snap('page', lambda text: RUN in text and 'actions:' not in text)
        terminal.send('\x1b[C')
        snap('right_opens_actions', lambda text: 'actions: ' + RUN in text)
        terminal.send('\x1b[D')
        snap('left_backs_out', lambda text: RUN in text and 'actions:' not in text)
        terminal.send('\x1b[D')
        terminal.send('FACTORY_CLOSED_INPUT_BARRIER')
        snap('left_closes_page', lambda text: 'FACTORY_CLOSED_INPUT_BARRIER' in text and RUN not in text)
        assert not server.prompts, 'navigation submitted a prompt'
        assert all(c.get('action') in ('graph', 'watch') for c in server.commands
                   if c.get('type') == 'factory_activity'), server.commands
        assert not terminal.screen.unsupported_sgr and not terminal.screen.unsupported_terminal
        observed['behavior_verified'] = True
    finally:
        try:
            if terminal:
                if terminal.process.poll() is None:
                    terminal.send('\x03\x03')
                    deadline = time.monotonic() + 8
                    while terminal.process.poll() is None and time.monotonic() < deadline:
                        terminal.pump()
                while select.select([terminal.master], [], [], 0)[0]:
                    before = len(terminal.raw)
                    terminal.pump()
                    if len(terminal.raw) == before:
                        break
                observed['raw_ansi_complete_hex'] = bytes(terminal.raw).hex()
                observed['ui_exit_code'] = terminal.process.poll()
                os.close(terminal.master)
        finally:
            try:
                server.close()
            finally:
                observed['commands'] = server.commands
                observed['fixture_errors'] = server.errors
                finish(scope, None, None, observed)
    assert observed['cleanup_verified'] and not server.errors, observed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__, 'runs': {}, 'not_verified': [
        'TS factory frame equality (no historical counterpart)', 'real factory execution',
        'rebound keybindings (unit regression)', 'action execution after Right confirmation']}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256
        receipt['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-fnav-', dir='/tmp') as folder:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ[f'PA_{kind.upper()}_BINARY']).resolve()
                observed = receipt['runs'][kind] = {'binary_sha256': digest(binary)}
                try:
                    observe(binary, kind, Path(folder) / kind, observed)
                except Exception as error:
                    observed['error'] = str(error)
            assert all(r.get('behavior_verified') and r.get('cleanup_verified') and 'error' not in r
                       for r in receipt['runs'].values()), 'actual factory navigation failed'
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
