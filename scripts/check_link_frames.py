#!/usr/bin/env python3
"""Compare actual TS/Rust link frames and OSC 8 targets, with capability on/off.

Full-width styled cells between fixed assistant-text markers are compared.
No output geometry is normalized. Unchanged application chrome is excluded.
"""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import re
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
END = 'LINK_PARITY_END'
CASES = {'osc8': {'hyperlinks': True}, 'fallback': {'hyperlinks': False}}
BEGIN = 'LINK_PARITY_BEGIN'
LINKS = '[Read docs](https://example.invalid/docs) and www.example.invalid/help'
TARGETS = {'https://example.invalid/docs', 'http://www.example.invalid/help'}


def messages():
    return [{'role': 'assistant', 'content': [{'type': 'text',
        'text': BEGIN + '\n\n' + LINKS + '\n\n' + END}], 'stopReason': 'stop',
        'api': 'openai-completions', 'provider': 'parity-local', 'model': 'parity-1',
        'timestamp': 1750000000000, 'usage': {'input': 0, 'output': 0,
        'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 0,
        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}}}]


def region(screen):
    rows = [''.join(row) for row in screen.cells]
    starts = [i for i, row in enumerate(rows) if BEGIN in row]
    ends = [i for i, row in enumerate(rows) if END in row]
    if len(starts) != 1 or len(ends) != 1 or starts[0] >= ends[0]:
        raise ValueError('complete link frame is not visible')
    result = []
    for y in range(starts[0], ends[0]):
        text = rows[y]
        cells = []
        for x, char in enumerate(text):
            style = copy.deepcopy(screen.styles[y][x])
            # Foreground on a blank cell is invisible; background and inverse
            # remain visible and are compared. No geometry is normalized.
            if char.isspace() and not any(style.get(key) for key in ('4', '7', '9')):
                style = {key: value for key, value in style.items() if key == 'bg'}
            cells.append([char, style])
        result.append(cells)
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
    env['COLORTERM'] = 'truecolor'
    if case['hyperlinks']:
        env['TERM_PROGRAM'] = 'WezTerm'
    else:
        env['TERM'] = 'screen-256color'
    settings_path = root / 'agent/settings.json'
    settings = json.loads(settings_path.read_text())
    settings['chatDetail'] = 'overview'
    settings_path.write_text(json.dumps(settings))
    if kind == 'ts':
        env['PI_PACKAGE_DIR'] = str(binary.parent)
    hello = actual_hello(binary, root, env)
    if kind == 'ts':
        assert hello.get('appVersion') == '0.9.8', hello
        assert hello.get('runtime', {}).get('buildId') == TS_COMMIT, hello
    server = Supervisor(root / 'ui.sock', hello, 'link-frames', root)
    server.messages = messages()
    scope = OwnedProcesses(binary, root, server.path)
    terminal = None
    result = {'binary_sha256': digest(binary), 'hello': hello, 'frames': {},
              'fixture_messages': server.messages, 'initial_chat_detail': 'overview'}
    try:
        command = [str(binary), '--daemon-socket', str(server.path)]
        terminal = FrameTerminal(command, root, env, width)
        scope.register(terminal.process, command)
        terminal.send('FRAME0')
        terminal.wait('link frame painted', lambda:
            'FRAME0' in terminal.screen.text() and BEGIN in terminal.screen.text()
            and END in terminal.screen.text() and 'Read docs' in terminal.screen.text(), server)
        result['frames']['paint'] = region(terminal.screen)
        visible = '\n'.join(''.join(cell[0] for cell in row)
                            for row in result['frames']['paint'])
        assert ('(https://example.invalid/docs)' in visible) != case['hyperlinks'], visible
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
                targets = set(re.findall(r'\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)',
                                         bytes(terminal.raw).decode('utf-8', errors='replace'))) - {''}
                result['osc8_targets'] = sorted(targets)
                result['target_check'] = (TARGETS <= targets if case['hyperlinks']
                                          else TARGETS.isdisjoint(targets))
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


def frames_equal(pair):
    return bool(set(pair) == {'ts', 'rust'} and all(
        item.get('executed') and item.get('cleanup_verified') and item.get('target_check')
        and not item.get('error') and not item.get('fixture_errors')
        for item in pair.values()) and pair['ts']['frames'] == pair['rust']['frames'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__, 'cases': {}, 'comparisons': {},
               'not_verified': ['full wire-byte equality', 'mouse click handling', 'streaming'],
               'source_commit': TS_COMMIT}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256
        receipt['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-link-frames-', dir='/tmp') as folder:
            for name, case in CASES.items():
                for width in (80, 120):
                    key = f'{name}-{width}'
                    pair = receipt['cases'][key] = {}
                    for kind in ('ts', 'rust'):
                        binary = Path(os.environ[f'PA_{kind.upper()}_BINARY']).resolve()
                        pair[kind] = capture(binary, kind, case, width,
                            Path(folder) / f'{key}-{kind}')
                    receipt['comparisons'][key] = frames_equal(pair)
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
