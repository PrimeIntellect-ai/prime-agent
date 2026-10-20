#!/usr/bin/env python3
"""Actual ordinary PTY queue browsing and mutation check.

Browsing visits only user rows and swaps with the adjacent user row. Full decoded
styled frames and raw ANSI are retained. A protocol fixture controls only the
queue snapshot; the client parses real input and constructs mutations.
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

from check_agent_bounce import Client
from lifecycle_lib import DockScreen
from lifecycle_lib import Supervisor, Terminal, digest, env_for
from lifecycle_lib import OwnedProcesses, TAG, finish

USER_A, USER_B = 'QUEUE_BROWSE_USER_A', 'QUEUE_BROWSE_USER_B'
INTERNAL = 'Agent message received: QUEUE_BROWSE_INTERNAL'
DRAFT = 'QUEUE_BROWSE_DRAFT'
OLDER, NEWER, LATER = '\x1b[1;3A', '\x1b[1;3B', '\x1b[1;7B'


def check_mutation(command):
    expected = {'type': 'mutate_queued_message', 'activeSessionId': 's1',
        'lane': 'steering', 'index': 0, 'expectedText': USER_A,
        'mutation': {'type': 'move', 'direction': 2}}
    assert command == expected, command


class QueueSupervisor(Supervisor):
    def __init__(self, path, hello, root, internal_only):
        self.queue = {'steering': [INTERNAL] if internal_only else [USER_A, INTERNAL, USER_B], 'followUp': []}
        self.mutations = []
        super().__init__(path, hello, 'queue-browse', root)

    def actions(self):
        return {'queuedCount': len(self.queue['steering']), 'steering': self.queue['steering'][:], 'followUps': []}

    def send(self, sock, data):
        data = copy.deepcopy(data)
        name = data.get('command')
        if data.get('type') == 'daemon_hello':
            # Advertise the actual queue-mutation protocol this subclass owns.
            # The base fixture server deliberately omits this capability.
            data['serverCapabilities'] = ['session_input_admission', 'queue_message_mutation']
        if data.get('type') == 'response':
            if name == 'attach':
                data['data']['snapshot']['state']['sessionActions'] = self.actions()
            elif name in ('get_state', 'get_connection_state'):
                data['data']['sessionActions'] = self.actions()
        super().send(sock, data)


    def extra_command(self, command, response):
        name = command['type']
        if name == 'get_queue':
            response['data'] = copy.deepcopy(self.queue)
            return True
        if name != 'mutate_queued_message':
            return False
        assert command['lane'] == 'steering', command
        assert command['mutation']['type'] == 'move', command
        index = command['index']
        assert self.queue['steering'][index] == command['expectedText'], command
        target = index + command['mutation']['direction']
        assert 0 <= target < len(self.queue['steering']), command
        self.queue['steering'][index], self.queue['steering'][target] = self.queue['steering'][target], self.queue['steering'][index]
        self.mutations.append(copy.deepcopy(command))
        response['data'] = {'status': 'applied'}
        return True


def discover_hello(binary, root, env, observed):
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
            hello = client.hello
            assert hello.get('schemaId'), hello
            assert 'queue_message_mutation' in hello.get('serverCapabilities', []), hello
            observed['hello'] = hello
        finally:
            finish(scope, client, daemon, observed)
    assert observed['cleanup_verified'], observed
    return hello


def frame(terminal):
    return {'text': terminal.screen.text(), 'styles': terminal.screen.styles,
        'unsupported_sgr': terminal.screen.unsupported_sgr[:],
        'unsupported_terminal': terminal.screen.unsupported_terminal[:]}


def observe(binary, root, internal_only, observed):
    env = env_for(root)
    env[TAG] = str(root)
    hello_cleanup = observed['hello_discovery'] = {}
    hello = discover_hello(binary, root, env, hello_cleanup)
    server = QueueSupervisor(root / 'ui.sock', hello, root, internal_only)
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
            observed['frames'][label] = copy.deepcopy(frame(terminal))
        snap('initial', lambda text: server.attaches > 0 and '1 agent message' in text)
        terminal.send(DRAFT)
        snap('draft', lambda text: DRAFT in text)
        if internal_only:
            assert 'to browse and edit queued messages' not in terminal.screen.text()
            terminal.send(OLDER)
            # The next typed character is an input-order barrier: Alt+Up was
            # handled before this character, so no absence-by-sleep assertion.
            terminal.send('_BARRIER')
            snap('internal_only_input', lambda text: DRAFT + '_BARRIER' in text)
            assert 'enter steers' not in terminal.screen.text()
        else:
            terminal.send(OLDER)
            snap('newest', lambda text: 'steering 2' in text and 'enter steers' in text)
            terminal.send(OLDER)
            snap('older', lambda text: 'steering 1' in text and 'enter steers' in text)
            terminal.send(OLDER)
            # At the oldest boundary, an input barrier proves the no-op was
            # processed; restore text so the reorder expectedText stays original.
            terminal.send('_BARRIER')
            snap('oldest', lambda text: USER_A + '_BARRIER' in text)
            terminal.send('\x7f' * len('_BARRIER'))
            snap('oldest_restored', lambda text: USER_A + '_BARRIER' not in text and 'steering 1' in text)
            terminal.send(LATER)
            terminal.wait('reorder command', lambda: len(server.mutations) == 1, server)
            check_mutation(server.mutations[0])
            snap('reordered', lambda text: 'steering 2' in text and 'enter steers' in text)
            assert server.queue == {'steering': [USER_B, INTERNAL, USER_A], 'followUp': []}, server.queue
        assert not server.prompts, 'browse submitted a prompt'
        assert not terminal.screen.unsupported_sgr and not terminal.screen.unsupported_terminal, 'unsupported terminal sequences'
        observed['behavior_verified'] = True
    finally:
        try:
            if terminal:
                if terminal.process.poll() is None:
                    terminal.send('\x03\x03')
                    deadline = time.monotonic() + 8
                    while terminal.process.poll() is None and time.monotonic() < deadline:
                        terminal.pump()
                # Drain already-readable final output after process exit too.
                while select.select([terminal.master], [], [], 0)[0]:
                    before = len(terminal.raw)
                    terminal.pump()
                    if len(terminal.raw) == before:
                        break  # PTY EOF remains readable.
                observed['raw_ansi_complete_hex'] = bytes(terminal.raw).hex()
                observed['ui_exit_code'] = terminal.process.poll()
                # Do not call the older Terminal.close() force-stop helper.
                # Strict cleanup observes graceful exit or leaves this case RED.
                os.close(terminal.master)
        finally:
            try:
                server.close()
            finally:
                observed['commands'] = server.commands
                observed['mutations'] = server.mutations
                observed['queue_after'] = server.queue
                observed['fixture_errors'] = server.errors
                finish(scope, None, None, observed)
    assert observed['cleanup_verified'], observed
    assert not server.errors, server.errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__, 'runs': {},
        'not_verified': ['real daemon queue admission (separate queue_priority check)',
            'pixel/font equality', 'delete/replace/attachments', 'wire-typed child and continuation riders (Rust units)']}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        with tempfile.TemporaryDirectory(prefix='pa-qbrowse-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            receipt['binary_sha256'] = digest(binary)
            for internal_only in (False, True):
                label = 'internal_only' if internal_only else 'mixed'
                observed = receipt['runs'][label] = {}
                try:
                    observe(binary, Path(folder) / label, internal_only, observed)
                except Exception as error:
                    observed['error'] = str(error)
            assert all(run.get('behavior_verified') and run.get('cleanup_verified') and 'error' not in run
                for run in receipt['runs'].values()), 'actual PTY check failed'
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
