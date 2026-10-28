#!/usr/bin/env python3
"""Compare actual TS/Rust edit-diff PTY frames and the Ctrl+O detail cycle.

The captured region is the edited-file summary and its diff rows, excluding
unchanged tool headers and app chrome. Semantic fixtures use each product's
native details payload; the receipt records that wire difference explicitly.
"""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

from lifecycle_lib import (DockScreen, OwnedProcesses, Supervisor, TAG, Terminal,
                           actual_hello, digest, env_for, finish)

TS_ARCHIVE_SHA256 = '83fb09129bf78e3e60268212cd70932166591b15188caa70c1b0efbcc76235e2'
TS_COMMIT = '7d442aafa985f9342134fac16c2ef41f03fb45c1'
END = 'PARITY_DIFF_END'
CASES = {
    'ascii': {'path': 'parity-diff.py', 'oldStr': 'x = 1\ny = 3\n',
              'newStr': 'x = 2\ny = 3\n', 'startLine': 10,
              'diff': '-10 x = 1\n+10 x = 2\n 11 y = 3'},
    'unicode': {'path': 'parity-unicode.py', 'oldStr': "label = 'café界'\n",
                'newStr': "label = 'hello界'\n", 'startLine': 1,
                'diff': "-1 label = 'café界'\n+1 label = 'hello界'"},
}


def messages(kind, case):
    usage = {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0,
             'totalTokens': 0, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0,
                                     'cacheWrite': 0, 'total': 0}}
    def assistant(content, stop):
        return {'role': 'assistant', 'content': content, 'stopReason': stop,
                'api': 'openai-completions', 'provider': 'parity-local',
                'model': 'parity-1', 'timestamp': 1750000000000, 'usage': usage}
    diff = {key: value for key, value in case.items()
            if key in (('path', 'oldStr', 'newStr', 'startLine') if kind == 'ts'
                       else ('path', 'diff'))}
    return [
        assistant([{'type': 'toolCall', 'id': 'edit-cell', 'name': 'ipython',
                    'arguments': {'code': 'edit_file()'}}], 'toolUse'),
        {'role': 'toolResult', 'toolCallId': 'edit-cell', 'toolName': 'ipython',
         'content': [], 'isError': False, 'timestamp': 1750000000001,
         'details': {'status': 'ok', 'durationMs': 5,
                     'result': 'Edited ' + case['path'], 'diffs': [diff]}},
        assistant([{'type': 'text', 'text': END}], 'stop'),
    ]


def region(screen, path):
    rows = [''.join(row) for row in screen.cells]
    starts = [i for i, row in enumerate(rows) if path in row and '╰─' in row]
    ends = [i for i, row in enumerate(rows) if END in row]
    if len(starts) != 1 or len(ends) != 1 or starts[0] >= ends[0]:
        raise ValueError('complete edited-file frame is not visible')
    result = []
    for y in range(starts[0], ends[0]):
        text = rows[y].rstrip()
        cells = []
        for x, char in enumerate(text):
            style = copy.deepcopy(screen.styles[y][x])
            # Foreground on a blank cell is invisible; background and inverse
            # remain visible and are compared. No geometry is normalized.
            if char.isspace():
                style = {key: value for key, value in style.items() if key in ('bg', '7')}
            cells.append([char, style])
        result.append(cells)
    while result and not result[-1]:
        result.pop()
    return result


class FrameTerminal(Terminal):
    def __init__(self, command, root, env, width):
        self.master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~(termios.ECHO | termios.ICANON)
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, width, 0, 0))
        self.process = subprocess.Popen(command, cwd=root, env=env, stdin=slave,
            stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.screen, self.raw = DockScreen(width), bytearray()


def capture(binary, kind, case, width, root):
    root.mkdir()
    env = env_for(root)
    env[TAG] = str(root)
    if kind == 'ts':
        env['PI_PACKAGE_DIR'] = str(binary.parent)
    hello = actual_hello(binary, root, env)
    if kind == 'ts':
        assert hello.get('appVersion') == '0.9.8', hello
        assert hello.get('runtime', {}).get('buildId') == TS_COMMIT, hello
    server = Supervisor(root / 'ui.sock', hello, 'edit-diff-frames', root)
    server.messages = messages(kind, case)
    scope = OwnedProcesses(binary, root, server.path)
    terminal = None
    result = {'binary_sha256': digest(binary), 'hello': hello, 'frames': {},
              'fixture_messages': server.messages}
    try:
        command = [str(binary), '--daemon-socket', str(server.path)]
        terminal = FrameTerminal(command, root, env, width)
        scope.register(terminal.process, command)
        needle = '-' + str(case['startLine']) + ' '
        for index, (phase, expanded) in enumerate([
            ('overview', False), ('details', True), ('all', True), ('overview_again', False)]):
            barrier = f'FRAME{index}'
            terminal.send(('\x0f' if index else '') + barrier)
            terminal.wait(phase + ' input and diff painted', lambda:
                barrier in terminal.screen.text() and case['path'] in terminal.screen.text()
                and END in terminal.screen.text()
                and (needle in terminal.screen.text()) == expanded, server)
            result['frames'][phase] = region(terminal.screen, case['path'])
        assert not server.prompts, 'frame check submitted a prompt'
        assert not terminal.screen.unsupported_sgr, terminal.screen.unsupported_sgr
        assert not terminal.screen.unsupported_terminal, terminal.screen.unsupported_terminal
        result['executed'] = True
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}'
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
                result['raw_ansi_hex'] = bytes(terminal.raw).hex()
                result['exit_code'] = terminal.process.poll()
                os.close(terminal.master)
        finally:
            try:
                server.close()
            finally:
                result['commands'] = server.commands
                result['fixture_errors'] = server.errors
                finish(scope, None, None, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__, 'cases': {}, 'comparisons': {},
               'not_verified': ['wire byte equality: TS carries raw old/new strings; Rust carries generated diff text',
                                'real kernel edit execution', 'mouse selection', 'streaming'],
               'source_commit': TS_COMMIT}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256
        receipt['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-diff-frames-', dir='/tmp') as folder:
            for name, case in CASES.items():
                for width in (80, 120):
                    key = f'{name}-{width}'
                    pair = receipt['cases'][key] = {}
                    for kind in ('ts', 'rust'):
                        binary = Path(os.environ[f'PA_{kind.upper()}_BINARY']).resolve()
                        pair[kind] = capture(binary, kind, case, width,
                            Path(folder) / f'{key}-{kind}')
                    receipt['comparisons'][key] = bool(all(
                        item.get('executed') and item.get('cleanup_verified')
                        and not item.get('error') and not item.get('fixture_errors')
                        for item in pair.values()) and pair['ts']['frames'] == pair['rust']['frames'])
        receipt['verified'] = bool(receipt['comparisons'] and all(receipt['comparisons'].values()))
    except Exception as error:
        receipt['error'] = f'{type(error).__name__}: {error}'
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'verified': receipt['verified'], 'comparisons': receipt['comparisons'],
                      'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
