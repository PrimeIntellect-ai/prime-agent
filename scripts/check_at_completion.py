#!/usr/bin/env python3
"""Hosted actual quoted @ completion keys and menu captures.

Ordinary PTY clients use a controlled protocol-7 peer with no selected model.
The actual binary enumerates a temporary project containing spaces. It must
refresh directory children after Tab, Enter, a typed quoted slash, and deleting
inside that quoted token.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

from check_agent_bounce import Client
from lifecycle_lib import DockScreen
from lifecycle_lib import Supervisor, Terminal, digest, env_for
from lifecycle_lib import OwnedProcesses, TAG, finish, process_identity

DIRECTORY = 'dir with spaces'
CHILD = 'only_child.rs'
APPLIED = '@"dir with spaces/"'
CASES = ('tab', 'enter', 'typed_slash', 'backspace', 'delete')


def completion_rows(text):
    """Match actual menu rows, excluding the editor's quoted token and chrome."""
    return [line.strip() for line in text.splitlines()
            if (CHILD in line or DIRECTORY + '/' in line)
            and '@' not in line]


def children_visible(text):
    return any(CHILD in row for row in completion_rows(text))


def frame(terminal):
    screen = terminal.screen
    assert not screen.unsupported_terminal, screen.unsupported_terminal
    assert not screen.unsupported_sgr, screen.unsupported_sgr
    return {'text': screen.text(), 'menu_rows': completion_rows(screen.text()),
            'children_visible': children_visible(screen.text()),
            'cursor': [screen.row, screen.col],
            'raw_ansi_complete_hex': bytes(terminal.raw).hex()}


def stable_frame(terminal, server, label, predicate):
    terminal.wait(label, lambda: predicate(terminal.screen.text()), server)
    previous, count = None, 0

    def stable():
        nonlocal previous, count
        current = terminal.screen.text()
        count = count + 1 if current == previous else 0
        previous = current
        return count >= 3 and predicate(current)

    terminal.wait(label + ' stable observable frame', stable, server)
    return frame(terminal)


def discover_direct(scope, command):
    """Recover an owned spawn even if its PTY constructor failed before assignment."""
    expected = [str(arg).encode() for arg in command]
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            identity, state = process_identity(pid)
            if state == 'Z':
                continue
            env = dict(item.split(b'=', 1) for item in (entry / 'environ').read_bytes().split(b'\0') if b'=' in item)
            argv = (entry / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            if env.get(TAG.encode()) != str(scope.root).encode() or argv != expected:
                continue
            scope.direct[pid] = (identity, expected)
            scope.targets[pid] = identity
            if not scope.ownership(pid, identity):
                scope.direct.pop(pid, None)
                scope.targets.pop(pid, None)
        except (OSError, ValueError):
            continue
    scope.discover()


def discover_hello(binary, root, observed):
    """Learn the real schema; graceful ACK + close + exit, with fallback RED."""
    root.mkdir(parents=True)
    env = env_for(root)
    env[TAG] = str(root)
    socket_path = root / 'hello.sock'
    scope = OwnedProcesses(binary, root, socket_path)
    process = client = None
    command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(socket_path)]
    with (root / 'hello.log').open('wb') as log:
        try:
            process = subprocess.Popen(command, cwd=root, env=env, stdout=log,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            scope.register(process, command)
            client = Client(socket_path, process)
            hello = client.hello
            assert hello.get('schemaId'), 'actual daemon greeting lacks schema identity'
            observed['hello'] = hello
        finally:
            discover_direct(scope, command)
            finish(scope, client, process, observed)
            observed['daemon_log'] = (root / 'hello.log').read_text(errors='replace')
    assert observed.get('cleanup_verified'), observed
    return hello


def close_terminal(terminal, scope, server, observed):
    """Exit using normal editor keys; forced PIDFD cleanup never passes."""
    observed['cleanup_verified'] = False
    errors = []
    try:
        discover_direct(scope, [str(scope.binary), '--daemon-socket', str(server.path)])
        if terminal is not None:
            terminal.send('\x15\x0b\x04')  # Delete both sides of cursor, Ctrl+D on empty input.
            deadline = time.monotonic() + 12
            while terminal.process.poll() is None and time.monotonic() < deadline:
                terminal.pump()
            assert terminal.process.poll() == 0, 'ordinary TUI exit did not complete cleanly'
        scope.wait_gone(3)
    except Exception as error:
        errors.append(str(error))
        observed['fallback_signals'] = []
        scope.discover()
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid in scope.live():
                if scope.send(pid, sig):
                    observed['fallback_signals'].append({'pid': pid, 'signal': sig.name})
            if terminal is not None:
                try:
                    terminal.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
        try:
            scope.wait_gone(3)
        except Exception as fallback_error:
            errors.append(str(fallback_error))
    finally:
        if terminal is not None:
            observed['raw_ansi_complete_hex'] = bytes(terminal.raw).hex()
            try:
                os.close(terminal.master)
            except OSError as error:
                errors.append('owned PTY close: ' + str(error))
        try:
            server.close()
        except Exception as error:
            errors.append('controlled supervisor cleanup: ' + str(error))
        observed['wire_commands'] = server.commands
        observed['fixture_errors'] = server.errors
        observed['owned_process_identities'] = dict(scope.targets)
    if server.errors:
        errors.append('controlled supervisor errors: ' + str(server.errors))
    if errors:
        observed['cleanup_errors'] = errors
        raise AssertionError('; '.join(errors))
    observed['cleanup_verified'] = True


def run_case(binary, root, hello, case, observed):
    root.mkdir(parents=True)
    env = env_for(root)
    env[TAG] = str(root)
    (root / DIRECTORY).mkdir()
    (root / DIRECTORY / CHILD).write_text('fixture child\n')
    socket_path = root / 'fixture.sock'
    server = Supervisor(socket_path, hello, 'at_completion', root)
    scope = OwnedProcesses(binary, root, socket_path)
    terminal = None
    observed['frames'] = {}
    observed['inputs'] = []
    command = [str(binary), '--daemon-socket', str(socket_path)]
    try:
        terminal = Terminal(command, root, env)
        scope.register(terminal.process, command)
        terminal.screen = DockScreen()
        terminal.wait('actual ordinary UI attached', lambda: server.attaches >= 1
                      and bool(terminal.screen.text().strip()), server)
        token = ('@"dir with spaces' if case == 'typed_slash' else
                 '@"dir with spaces/x' if case in ('backspace', 'delete') else '@dir')
        terminal.send(token)
        observed['inputs'].append(token.encode().hex())
        if case in ('tab', 'enter'):
            observed['frames']['before'] = stable_frame(terminal, server,
                'directory suggestion', lambda text: any(DIRECTORY + '/' in row
                                                        for row in completion_rows(text)))
        else:
            observed['frames']['before'] = stable_frame(terminal, server,
                'quoted token typed', lambda text: token in text)
        key = {'tab': '\t', 'enter': '\r', 'typed_slash': '/',
               'backspace': '\x7f', 'delete': '\x1b[D\x1b[3~'}[case]
        terminal.send(key)
        observed['inputs'].append(key.encode().hex())
        expected_token = APPLIED if case in ('tab', 'enter') else '@"dir with spaces/'
        observed['frames']['after'] = stable_frame(terminal, server,
            'directory action painted', lambda text: expected_token in text
            and (token not in text if case in ('backspace', 'delete') else True)
            and children_visible(text))
        assert not server.prompts, 'completion key accidentally submitted a prompt'
        assert observed['frames']['after']['children_visible'], 'directory children menu missing'
        observed['behavior_verified'] = True
    finally:
        close_terminal(terminal, scope, server, observed)


def verify(cases):
    """Fail closed on missing execution, cleanup or children menu."""
    for case in CASES:
        observed = cases[case]
        assert observed.get('behavior_verified') and observed.get('cleanup_verified'), case
        assert not observed.get('error') and not observed.get('cleanup_errors'), case
        assert observed['frames']['after']['children_visible'], case


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__,
        'not_verified': ['pixel/font equality', 'complete ranking matrix', 'in-flight search race timing',
                         'real daemon/provider completion transport', 'model inference', 'file submission']}
    try:
        assert sys.platform == 'linux', 'hosted Linux fixture only'
        with tempfile.TemporaryDirectory(prefix='pa-at-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            receipt.update(binary_sha256=digest(binary), hello_discovery={}, cases={})
            hello = discover_hello(binary, Path(folder) / 'hello', receipt['hello_discovery'])
            for case in CASES:
                observed = receipt['cases'][case] = {}
                try:
                    run_case(binary, Path(folder) / (case + ' project space'), hello, case, observed)
                except Exception as error:
                    observed['error'] = str(error)
            verify(receipt['cases'])
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
