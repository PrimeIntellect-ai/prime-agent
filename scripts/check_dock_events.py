#!/usr/bin/env python3
"""Hosted actual TUI dock reactions, styled frames and raw ANSI.

The ordinary client receives controlled protocol-7 roster/goal events after
observable attach. No headless flags, provider or live sessions are used.
Behavioral assertions cover event-driven refresh of the one-line dock, which
expands into per-group rows on focus, and the live title cost.
"""
import argparse
import json
import os
import re
from pathlib import Path
import sys
import tempfile
import threading

from lifecycle_lib import DockScreen
from lifecycle_lib import Supervisor, Terminal, actual_hello, digest, env_for


def parent():
    return {'agentId': 's1', 'status': 'idle', 'summary': {
        'sessionId': 'fixture-durable', 'activeSessionId': 's1', 'sessionFile': '/fixture/root.jsonl',
        'lifecycle': 'live', 'runtimeKind': 'top-level', 'usage': {'cost': 0}}}


def child(ident, status, cost):
    return {'agentId': ident, 'status': status, 'summary': {
        'sessionId': ident + '-durable', 'activeSessionId': ident + '-active',
        'sessionFile': '/fixture/' + ident + '.jsonl', 'sessionName': ident,
        'lifecycle': 'live', 'runtimeKind': 'subagent', 'parentActiveSessionId': 's1',
        'parentSessionPath': '/fixture/root.jsonl', 'usage': {'cost': cost},
        'activity': 'working' if status == 'running' else 'idle',
        'isSessionActive': status == 'running'}}


def usage(cost):
    return {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 0,
            'cost': {'input': 0, 'output': cost, 'cacheRead': 0, 'cacheWrite': 0, 'total': cost}}


class DockSupervisor(Supervisor):
    def __init__(self, path, hello, root):
        assert 'agent_roster' in hello.get('serverCapabilities', []), 'actual binary does not advertise roster protocol'
        self.roster = [parent(), child('c1', 'running', 0.42)]
        self.write_lock = threading.Lock()
        self.emitted = []
        self.context_responses = []
        super().__init__(path, hello, 'dock', root)

    def send(self, sock, data):
        if data.get('type') == 'daemon_hello':
            # The base fixture advertises only prompt admission. This fixture
            # also implements roster snapshot/deltas, gated on agent_roster.
            data = dict(data, serverCapabilities=['session_input_admission', 'agent_roster'])
        elif data.get('type') == 'response' and data.get('command') == 'roster_subscribe':
            data = dict(data, data={'roster': self.roster})
        elif data.get('type') == 'response' and data.get('command') == 'attach':
            data['data']['snapshot']['state']['sessionName'] = 'Dock fixture'
            data['data']['snapshot']['summary'].update(sessionId='fixture-durable',
                activeSessionId='s1', sessionFile='/fixture/root.jsonl', sessionName='Dock fixture')
        elif data.get('type') == 'response' and data.get('command') == 'get_context_tree':
            # The top bar reads roster usage; the context tree must describe
            # the same fixture family.
            children = [{
                'id': row['summary']['sessionId'], 'label': row['agentId'],
                'status': 'active' if row['status'] == 'running' else 'completed',
                'ownUsage': usage(row['summary']['usage']['cost']),
                'totalUsage': usage(row['summary']['usage']['cost']), 'children': []}
                for row in self.roster if row['agentId'] != 's1']
            data = dict(data, data={'id': 'root', 'label': 'Dock fixture', 'status': 'active',
                'ownUsage': usage(0), 'totalUsage': usage(sum(
                    node['totalUsage']['cost']['total'] for node in children)), 'children': children})
            self.context_responses.append(data)
        with self.write_lock:
            super().send(sock, data)

    def emit(self, frame):
        self.emitted.append(frame)
        # These are ordinary broadcast events, not prompt replies or key input.
        for sock in list(self.sockets):
            try:
                self.send(sock, frame)
            except (BrokenPipeError, OSError):
                pass  # A closed startup discovery connection is not a subscriber.

    def roster_delta(self, changed, removed=(), resync=False):
        if resync:
            self.roster = []
        rows = {row['agentId']: row for row in self.roster}
        rows.update({row['agentId']: row for row in changed})
        for ident in removed:
            rows.pop(ident, None)
        self.roster = list(rows.values())
        self.emit({'type': 'roster_update', 'changed': changed, 'removed': list(removed), 'resync': resync})

    def goal(self, status):
        self.emit({'type': 'session_event', 'activeSessionId': 's1', 'event': {
            'type': 'goal_update', 'goal': {'active': True, 'status': status,
                'goalId': 'dock-goal', 'objective': 'Dock fixture objective', 'tokensUsed': 0,
                'timeUsedSeconds': 12, 'continuationsUsed': 0}}})


def running_visible(text, count, expanded=False):
    # The collapsed dock reads "N subagent(s)"; the focused (expanded) dock's
    # subagents row reads the "N running · …" breakdown.
    label = 'running' if expanded else 'subagents?'
    return re.search(r'(?<!\d)' + str(count) + r'\s+' + label + r'\b', text) is not None


def visible_cost(text):
    costs = re.findall(r'\$(\d+\.\d{2})(?!\d)', text)
    assert len(costs) == 1, 'fixture frame must paint one unambiguous title cost'
    return costs[0]


def cost_ready(text, expected):
    try:
        return visible_cost(text) == expected
    except AssertionError:
        return False  # A partial repaint is not a completed frame.


def capture(terminal, root, offset):
    return {'text': terminal.screen.text().replace(str(root), '<fixture-root>'),
            'dock_styled_rows': terminal.screen.dock_styles(),
            'raw_ansi_since_previous_hex': bytes(terminal.raw[offset:]).hex(),
            'unsupported_sgr': terminal.screen.unsupported_sgr.copy(),
            'keyboard_controls': terminal.screen.keyboard_controls.copy(),
            'unsupported_terminal': terminal.screen.unsupported_terminal.copy()}


def run_case(binary, root, observed):
    root.mkdir()
    env = env_for(root)
    hello = actual_hello(binary, root, env)
    server = DockSupervisor(root / 'fixture.sock', hello, root)
    terminal = None
    observed['frames'] = {}
    offset = 0
    try:
        terminal = Terminal([str(binary), '--daemon-socket', str(server.path)], root, env)
        terminal.screen = DockScreen()
        def snap(name, predicate):
            nonlocal offset
            terminal.wait(name, lambda: predicate(terminal.screen.text()), server)
            # Require two unchanged captures of the affected dock attributes;
            # this is observable frame readiness rather than a fixed sleep.
            previous = terminal.screen.dock_styles()
            stable = [0]
            def ready():
                nonlocal previous
                current = terminal.screen.dock_styles()
                stable[0] = stable[0] + 1 if current == previous else 0
                previous = current
                return stable[0] >= 2 and predicate(terminal.screen.text())
            terminal.wait(name + ' stable dock', ready, server)
            observed['frames'][name] = capture(terminal, root, offset)
            offset = len(terminal.raw)
        snap('snapshot', lambda text: server.attaches >= 1 and running_visible(text, 1) and '$0.42' in text)
        server.roster_delta([child('c2', 'running', 0.49)])
        snap('roster_added', lambda text: running_visible(text, 2)
             and cost_ready(text, '0.91'))
        server.goal('active')
        snap('goal_active', lambda text: 'Pursuing goal (12s)' in text)
        before_focus = terminal.screen.dock_styles()
        terminal.send('\x1b[B')  # Same ordinary Down key from an empty editor.
        terminal.wait('dock focus changes rendered attributes',
            lambda: terminal.screen.dock_styles() != before_focus, server)
        snap('dock_focused', lambda text: running_visible(text, 2, expanded=True))
        assert observed['frames']['dock_focused']['dock_styled_rows'] != before_focus
        terminal.send('\x1b')
        terminal.wait('Escape restores editor focus', lambda: terminal.screen.dock_styles() == before_focus, server)
        terminal.send('DOCK_EDITOR_FOCUS_PROBE')
        snap('editor_restored', lambda text: 'DOCK_EDITOR_FOCUS_PROBE' in text)
        terminal.send('\x15')  # Clear draft without submitting a prompt.
        terminal.wait('draft cleared', lambda: 'DOCK_EDITOR_FOCUS_PROBE' not in terminal.screen.text(), server)
        server.roster_delta([child('c1', 'idle', 0.42)], removed=['c2'])
        snap('child_settled', lambda text: running_visible(text, 0) and '$0.42' in text)
        server.roster_delta([], removed=['c1'])
        snap('child_removed', lambda text: cost_ready(text, '0.00')
             and running_visible(text, 0))
        server.roster_delta([parent(), child('c3', 'running', 0.73)], resync=True)
        snap('roster_restored', lambda text: running_visible(text, 1)
             and cost_ready(text, '0.73'))
        server.goal('paused')
        snap('goal_paused', lambda text: 'Goal paused (12s)' in text)
        assert not server.prompts, 'focus interactions accidentally submitted a prompt'
        assert not terminal.screen.unsupported_sgr, 'unsupported SGR makes attribute evidence incomplete'
        assert not terminal.screen.unsupported_terminal, 'unsupported terminal geometry makes frame evidence incomplete'
        observed['title_costs'] = {phase: visible_cost(frame['text']) for phase, frame in observed['frames'].items()}
        expected_costs = {'snapshot': '0.42', 'roster_added': '0.91', 'goal_active': '0.91',
            'dock_focused': '0.91', 'editor_restored': '0.91', 'child_settled': '0.42',
            'child_removed': '0.00', 'roster_restored': '0.73', 'goal_paused': '0.73'}
        assert observed['title_costs'] == expected_costs, 'actual title cost reaction differs'
        observed['behavior_verified'] = True
    finally:
        try:
            if terminal:
                observed['raw_ansi_complete_hex'] = bytes(terminal.raw).hex()
                terminal.close()
        finally:
            try:
                server.close()
            finally:
                observed['emitted_events'] = server.emitted
                observed['commands'] = server.commands
                observed['context_responses'] = server.context_responses
                observed['fixture_errors'] = server.errors
        assert not server.errors, server.errors
        observed['cleanup_verified'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__,
        'frame_scope': '120x40 decoded text + dock SGR cells and complete raw ANSI, not pixels/font rendering.',
        'not_verified': ['actual daemon roster production', 'new-session/no-session fallback', 'agents-view lazy query search']}
    try:
        assert sys.platform == 'linux', 'hosted Linux binary fixture only'
        with tempfile.TemporaryDirectory(prefix='pa-dock-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observed = receipt['run'] = {'binary_sha256': digest(binary)}
            try:
                run_case(binary, Path(folder) / 'rust', observed)
            except Exception as error:
                observed['error'] = str(error)
            assert 'error' not in observed, 'actual binary scenario failed'
        receipt['verified'] = True  # Only the explicitly scoped reaction assertions.
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
