#!/usr/bin/env python3
"""Hosted actual factory page navigation with raw PTY evidence: Right and
Enter on a run header are inert, the stop key only arms, Left closes. Enter
on a state opens its child session without ending the app, and Left in the
child returns to the page with the same run and state selected.

A protocol fixture supplies one real-shaped run; actual input parsing, view
rendering and fallback keys execute unchanged.
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

RUN = 'factory-navigation-run'
CHILD = 'factory-navigation-child'
GRAPH = {'runs': [{'run_id': RUN, 'spec_id': 'navigation-fixture', 'name': RUN,
    'state': 'running', 'machine': {'states': [{'id': 'work'}], 'transitions': []},
    'usage': {'running': 1}, 'nodes': [{'id': 'work', 'status': 'running', 'running': 1,
    'instances': [{'status': 'running', 'child': 'work-1'}]}]}]}
# The roster row the page resolves the state's child through: a live depth-1
# subagent of the fixture session s1.
ROSTER = [{'agentId': 'work-agent', 'summary': {'runtimeKind': 'subagent',
    'rlmChildId': 'work-1', 'parentActiveSessionId': 's1', 'activeSessionId': CHILD,
    'rlmDepth': 1}}]
STATE_SELECTED = '\u25b8 \u25cf work'


class FactorySupervisor(Supervisor):
    def extra_command(self, command, response):
        return command.get('type') == 'cancel_rlm_child'

    def send(self, sock, data):
        data = copy.deepcopy(data)
        if data.get('type') == 'response' and data.get('command') == 'cancel_rlm_child':
            return  # A real socket sink that never replies to the confirmed stop.
        if data.get('type') == 'daemon_hello':
            data['serverCapabilities'] = ['session_input_admission', 'factory_activity']
        if data.get('type') == 'response' and data.get('command') == 'factory_activity':
            # The base fixture already recognizes this lane with an empty
            # legacy response. Supply its graph shape without mutating errors.
            data['data'] = copy.deepcopy(GRAPH)
        if data.get('type') == 'response' and data.get('command') == 'roster_subscribe':
            data['data'] = {'roster': copy.deepcopy(ROSTER)}
        if data.get('type') == 'response' and data.get('command') == 'attach' \
                and self.attach_target() == CHILD:
            # The base fixture attaches every session as s1; the child keeps
            # its own identity so the roster and the handoff can tell them apart.
            snapshot = data['data']['snapshot']
            data['data']['activeSessionId'] = snapshot['activeSessionId'] = CHILD
            snapshot['summary']['id'] = snapshot['state']['activeSessionId'] = CHILD
            snapshot['state'].update(sessionId='fixture-child', sessionName='Child fixture')
        super().send(sock, data)

    def attach_target(self):
        with self.lock:
            attaches = [c for c in self.commands if c.get('type') == 'attach']
        return attaches[-1].get('activeSessionId') if attaches else None


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


def observe(binary, root, observed):
    env = env_for(root)
    env[TAG] = str(root)
    discovered = observed['hello_discovery'] = {}
    actual = hello(binary, root, env, discovered)
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
        snap('page', lambda text: RUN in text and '\u2190 back' in text and 'Ctrl+X stop' in text)
        # Right and Enter on the selected run header are inert; the stop
        # key's armed prompt is the barrier proving they were handled.
        terminal.send('\x1b[C\x1b[C\r\r')
        terminal.send('\x18')
        snap('right_enter_inert_then_stop_armed', lambda text: RUN in text
             and 'again to confirm' in text)
        terminal.send('\x1b[C')
        snap('other_key_disarms', lambda text: RUN in text and 'again to confirm' not in text)
        terminal.send('\x1b[D')
        terminal.send('FACTORY_CLOSED_INPUT_BARRIER')
        snap('left_closes_page', lambda text: 'FACTORY_CLOSED_INPUT_BARRIER' in text and RUN not in text)
        # Reopen the page, select the state, and open its child: the app must
        # stay up and attach the child, which shows its depth label.
        terminal.send(factory_click(terminal.screen))
        snap('page_reopened', lambda text: RUN in text and '\u2190 back' in text)
        terminal.send('\x1b[B')
        snap('state_selected', lambda text: STATE_SELECTED in text)
        terminal.send('\r')
        snap('child_opened', lambda text: 'depth 1' in text and server.attach_target() == CHILD)
        # Left on the child's empty editor leaves it: the page is back on the
        # same run and state, and its Left closes to the chat as before.
        terminal.send('\x1b[D')
        snap('page_returned_on_the_state', lambda text: server.attach_target() == 's1'
             and RUN in text and STATE_SELECTED in text and '\u25b8 factory: ' not in text)
        terminal.send('\x1b[D')
        snap('returned_page_closes', lambda text: 'FACTORY_CLOSED_INPUT_BARRIER' in text
             and RUN not in text)
        # A confirmed child stop must leave navigation and paint responsive
        # even while the daemon never replies to that request.
        terminal.send(factory_click(terminal.screen))
        snap('stop_page', lambda text: RUN in text and '\u2190 back' in text)
        terminal.send('\x1b[B\x18')
        snap('child_stop_armed', lambda text: STATE_SELECTED in text and 'again to confirm' in text)
        terminal.send('\x18')
        terminal.wait('child stop reached hanging sink', lambda: any(
            c.get('type') == 'cancel_rlm_child' for c in server.commands), server)
        started = time.monotonic()
        terminal.send('\x1b[DSTOP_PENDING_INPUT_BARRIER')
        snap('child_stop_does_not_block_navigation', lambda text:
             'STOP_PENDING_INPUT_BARRIER' in text and RUN not in text)
        observed['stop_navigation_seconds'] = time.monotonic() - started
        assert observed['stop_navigation_seconds'] < 3, 'child stop blocked the UI until its timeout'
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
    receipt = {'verified': False, 'scope': __doc__, 'not_verified': [
        'real factory execution',
        'rebound keybindings (unit regression)', 'stop execution after the second press']}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        with tempfile.TemporaryDirectory(prefix='pa-fnav-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observed = receipt['run'] = {'binary_sha256': digest(binary)}
            try:
                observe(binary, Path(folder) / 'rust', observed)
            except Exception as error:
                observed['error'] = str(error)
            assert observed.get('behavior_verified') and observed.get('cleanup_verified') \
                and 'error' not in observed, 'actual factory navigation failed'
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
