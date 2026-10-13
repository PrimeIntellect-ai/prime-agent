#!/usr/bin/env python3
"""Observe /settings in pinned TS and Rust binaries with the same PTY input.

Keep full frames and wire commands, compare the existing auto-compaction toggle,
and record the requested Rust-only percentage row as an explicit feature addition.
No real inference, user home, or production daemon is used.
"""
import argparse
import difflib
import json
import os
import re
from pathlib import Path
import tempfile

from review_draft_disconnect_parity import (
    Supervisor, Terminal, actual_hello, digest, env_for,
)


def observe(binary, kind, root):
    root.mkdir()
    env = env_for(root, kind)
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
        if kind == 'rust':
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
    receipt = {'intended_addition': 'Rust adds the requested 1–100% auto-compaction percentage row; TS 0.9.8 has no such row.',
               'existing_layout_difference': 'Rust already groups settings into tabs; the full frame diff preserves that difference.',
               'scope': 'Real client binaries against an isolated synthetic daemon; model compaction execution is covered by Rust tests.',
               'results': {}}
    with tempfile.TemporaryDirectory(prefix='autocompact-parity-') as directory:
        root = Path(directory)
        for kind, name in [('ts', 'PA_TS_BINARY'), ('rust', 'PA_RUST_BINARY')]:
            receipt['results'][kind] = observe(Path(os.environ[name]).resolve(), kind, root / kind)
    ts, rust = (receipt['results'][kind] for kind in ('ts', 'rust'))
    receipt['frame_diff'] = list(difflib.unified_diff(ts.get('settings_frame', '').splitlines(), rust.get('settings_frame', '').splitlines(), fromfile='TS', tofile='Rust'))
    receipt['toggle_wire_equal'] = ts.get('toggle_payloads') == rust.get('toggle_payloads') and bool(ts.get('toggle_payloads'))
    receipt['toggle_rows_equal'] = ts.get('toggle_rows') == rust.get('toggle_rows') and bool(ts.get('toggle_rows'))
    receipt['passed'] = all(result.get('executed') and not result['fixture_errors'] for result in (ts, rust)) and receipt['toggle_wire_equal'] and receipt['toggle_rows_equal'] and rust.get('saved_percentage') == 100
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: receipt[key] for key in ('passed', 'toggle_wire_equal', 'toggle_rows_equal')}))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
