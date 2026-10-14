#!/usr/bin/env python3
"""Hosted actual TS/Rust TUI dock reactions, styled frames and raw ANSI.

Both ordinary clients receive controlled protocol-7 roster/goal events after
observable attach. No headless flags, provider or live sessions are used. The
receipt records full-frame differences instead of normalizing TS's boxed dock
into Rust's one-line dock. Behavioral assertions cover event-driven refresh;
full-frame/style equality is reported separately and never claimed by them.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

from review_dock_screen import DockScreen
from review_draft_disconnect_parity import (
    Supervisor, Terminal, actual_hello, digest, env_for, TS_ARCHIVE_SHA256,
)


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


class DockSupervisor(Supervisor):
    def __init__(self, path, hello, root):
        self.roster = [parent(), child('c1', 'running', 0.42)]
        self.write_lock = threading.Lock()
        self.emitted = []
        super().__init__(path, hello, 'dock', root)

    def send(self, sock, data):
        if data.get('type') == 'response' and data.get('command') == 'roster_subscribe':
            data = dict(data, data={'roster': self.roster})
        elif data.get('type') == 'response' and data.get('command') == 'attach':
            data['data']['snapshot']['state']['sessionName'] = 'Dock fixture'
            data['data']['snapshot']['summary'].update(sessionId='fixture-durable',
                activeSessionId='s1', sessionFile='/fixture/root.jsonl', sessionName='Dock fixture')
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


def running_visible(text, kind, count):
    return (str(count) + ' running') in text if kind == 'ts' else (str(count) + ' subagents') in text


def capture(terminal, root, offset):
    return {'text': terminal.screen.text().replace(str(root), '<fixture-root>'),
            'dock_styled_rows': terminal.screen.dock_styles(),
            'raw_ansi_since_previous_hex': bytes(terminal.raw[offset:]).hex(),
            'unsupported_sgr': terminal.screen.unsupported_sgr.copy()}


def run_case(binary, kind, root, observed):
    root.mkdir()
    env = env_for(root, kind)
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
        snap('snapshot', lambda text: server.attaches >= 1 and running_visible(text, kind, 1) and '$0.42' in text)
        server.roster_delta([child('c2', 'running', 0.49)])
        snap('roster_added', lambda text: running_visible(text, kind, 2) and '$0.91' in text)
        server.goal('active')
        snap('goal_active', lambda text: 'Pursuing goal (12s)' in text)
        before_focus = terminal.screen.dock_styles()
        terminal.send('\x1b[B')  # Same ordinary Down key from an empty editor.
        terminal.wait('dock focus changes rendered attributes',
            lambda: terminal.screen.dock_styles() != before_focus, server)
        snap('dock_focused', lambda text: running_visible(text, kind, 2))
        assert observed['frames']['dock_focused']['dock_styled_rows'] != before_focus
        terminal.send('\x1b')
        terminal.wait('Escape restores editor focus', lambda: terminal.screen.dock_styles() == before_focus, server)
        terminal.send('DOCK_EDITOR_FOCUS_PROBE')
        snap('editor_restored', lambda text: 'DOCK_EDITOR_FOCUS_PROBE' in text)
        terminal.send('\x15')  # Clear draft without submitting a prompt.
        terminal.wait('draft cleared', lambda: 'DOCK_EDITOR_FOCUS_PROBE' not in terminal.screen.text(), server)
        server.roster_delta([child('c1', 'idle', 0.42)], removed=['c2'])
        snap('child_settled', lambda text: running_visible(text, kind, 0) and '$0.42' in text)
        server.roster_delta([], removed=['c1'])
        snap('child_removed', lambda text: '$0.42' not in text and '2 running' not in text and '2 subagents' not in text)
        server.roster_delta([parent(), child('c3', 'running', 0.73)], resync=True)
        snap('roster_restored', lambda text: running_visible(text, kind, 1) and '$0.73' in text)
        server.goal('paused')
        snap('goal_paused', lambda text: 'Goal paused (12s)' in text)
        assert not server.prompts, 'focus interactions accidentally submitted a prompt'
        assert not terminal.screen.unsupported_sgr, 'unsupported SGR makes attribute evidence incomplete'
        observed['behavior_verified'] = True
    finally:
        if terminal:
            observed['raw_ansi_complete_hex'] = bytes(terminal.raw).hex()
            terminal.close()
        server.close()
        observed['emitted_events'] = server.emitted
        observed['commands'] = server.commands
        observed['fixture_errors'] = server.errors
        assert not server.errors, server.errors
        observed['cleanup_verified'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'runs': {}, 'scope': __doc__,
        'frame_scope': '120x40 decoded text + dock SGR cells and complete raw ANSI, not pixels/font rendering.',
        'preexisting_ts_limitation': 'Pinned TS uses a boxed running/idle/inactive dock; Rust uses a one-line fixed-group dock. Layouts are not normalized into equality.',
        'not_verified': ['frame/style equality', 'actual daemon roster production', 'new-session/no-session fallback', 'agents-view lazy query search']}
    try:
        assert sys.platform == 'linux', 'hosted Linux binary fixture only'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256, 'TS archive mismatch'
        receipt['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-dock-', dir='/tmp') as folder:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ['PA_' + kind.upper() + '_BINARY']).resolve()
                observed = receipt['runs'][kind] = {'binary_sha256': digest(binary)}
                try:
                    run_case(binary, kind, Path(folder) / kind, observed)
                except Exception as error:
                    observed['error'] = str(error)
            assert all('error' not in run for run in receipt['runs'].values()), 'actual binary scenario failed'
            frames = receipt['runs']['ts']['frames']
            assert frames.keys() == receipt['runs']['rust']['frames'].keys(), 'different phases executed'
            receipt['frame_diffs'] = {phase: {
                'text_equal': frame['text'] == receipt['runs']['rust']['frames'][phase]['text'],
                'dock_attributes_equal': frame['dock_styled_rows'] == receipt['runs']['rust']['frames'][phase]['dock_styled_rows']}
                for phase, frame in frames.items()}
        receipt['verified'] = True  # Only the explicitly scoped reaction assertions.
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
