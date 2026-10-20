#!/usr/bin/env python3
"""Drive /settings through the PTY: the auto-compaction toggle and the percentage row.

Keep full frames and wire commands. No real inference, user home, or production
daemon is used.
"""
import argparse
import json
import os
import re
from pathlib import Path
import tempfile

from lifecycle_lib import Supervisor, Terminal, actual_hello, digest, env_for


def observe(binary, root):
    root.mkdir()
    env = env_for(root)
    hello = actual_hello(binary, root, env)
    server = Supervisor(root / 'ui.sock', hello, 'settings', root)
    terminal = None
    result = {'binary_sha256': digest(binary), 'executed': False}
    try:
        terminal = Terminal([str(binary), '--daemon-socket', str(server.path)], root, env)
        terminal.wait('initial attach', lambda: server.attaches > 0 and bool(terminal.screen.text().strip()), server)
        terminal.send('/settings')
        terminal.wait('settings typed', lambda: '/settings' in terminal.screen.text(), server)
        terminal.send('\r')
        terminal.wait('settings menu', lambda: 'Auto-compact' in terminal.screen.text(), server)
        result['settings_frame'] = terminal.screen.text()
        terminal.send('\r')
        terminal.wait('toggle delivered', lambda: any(c.get('type') == 'set_auto_compaction' for c in server.commands), server)
        terminal.wait('toggle rendered', lambda: any('Auto-compact' in row and 'true' in row for row in terminal.screen.text().splitlines()), server)
        result['toggle_frame'] = terminal.screen.text()
        result['toggle_rows'] = [re.sub(r'\s+', ' ', row.strip().lstrip('›> ').strip()) for row in terminal.screen.text().splitlines()
                                 if 'Auto-compact' in row and 'threshold' not in row]
        result['toggle_payloads'] = [json.dumps({k: c[k] for k in ('type', 'activeSessionId', 'enabled')}, sort_keys=True)
                                     for c in server.commands if c.get('type') == 'set_auto_compaction']
        # Search for the added row so other General settings can evolve independently.
        terminal.send('threshold')
        terminal.wait('percentage focused', lambda: any(row.strip().startswith('› Auto-compact threshold (%)') for row in terminal.screen.text().splitlines()), server)
        result['percentage_frame'] = terminal.screen.text()
        terminal.send('\r')
        path = root / 'agent/settings.json'
        terminal.wait('percentage persisted', lambda: json.loads(path.read_text()).get('compaction', {}).get('thresholdPercent') == 100, server)
        terminal.wait('percentage rendered', lambda: any('threshold (%)' in row and '100' in row for row in terminal.screen.text().splitlines()), server)
        result['changed_percentage_frame'] = terminal.screen.text()
        result['saved_percentage'] = json.loads(path.read_text())['compaction']['thresholdPercent']
        result['executed'] = True
    except Exception as error:
        result['error'] = str(error)
    finally:
        if terminal:
            terminal.close()
            result['terminal_raw_hex'] = terminal.raw.hex()
        server.close()
        result['commands'] = server.commands
        result['fixture_errors'] = server.errors
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'scope': 'Real client binary against an isolated synthetic daemon; model compaction execution is covered by Rust tests.'}
    with tempfile.TemporaryDirectory(prefix='autocompact-check-') as directory:
        receipt['result'] = result = observe(Path(os.environ['PA_RUST_BINARY']).resolve(), Path(directory) / 'rust')
    receipt['passed'] = bool(result.get('executed') and not result['fixture_errors']
                             and result.get('saved_percentage') == 100)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'passed': receipt['passed'], 'error': result.get('error')}))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
