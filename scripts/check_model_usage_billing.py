#!/usr/bin/env python3
"""Read billed rows through the actual daemon's saved-session catalog.

The TS reference values were captured from the official v0.9.8 Darwin arm64
binary e50d4e4cf5735ea16cee30c3ca48fccb628ae2169fc867c33d461b8a90e87bc5.
They are observations, not a claim that this Rust feature matches TS.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from check_saved_catalog import CatalogClient
from lifecycle_lib import OwnedProcesses, TAG, digest, env_for, finish

CWD = '/tmp/model-usage-billing-fixture'
USAGE = {'input': 10, 'output': 2, 'cacheRead': 0, 'cacheWrite': 0,
         'totalTokens': 12, 'cost': {'input': 0.01, 'output': 0.02,
         'cacheRead': 0, 'cacheWrite': 0, 'total': 0.03}}
SINGLE = {'inputTokens': 10, 'outputTokens': 2, 'cost': 0.03}
DOUBLE = {'inputTokens': 20, 'outputTokens': 4, 'cost': 0.06}
TS_OBSERVED = {'baseline': SINGLE, 'model_usage': SINGLE, 'compaction': DOUBLE}


def seed(root):
    stamp = '2024-01-01T00:00:00.000Z'
    for kind in TS_OBSERVED:
        ident = 'billing-' + kind
        rows = [
            {'type': 'session', 'version': 3, 'id': ident,
             'timestamp': stamp, 'cwd': CWD, 'rlmDepth': 0},
            {'type': 'session_state', 'id': 'state', 'parentId': None,
             'timestamp': stamp, 'state': {'status': 'archived'}},
            {'type': 'message', 'id': 'assistant', 'parentId': 'state',
             'timestamp': stamp, 'message': {'role': 'assistant',
             'content': [{'type': 'text', 'text': 'Billed fixture reply'}],
             'stopReason': 'stop', 'api': 'openai-completions',
             'provider': 'parity-local', 'model': 'parity-1',
             'timestamp': 1704067200000, 'usage': USAGE}},
        ]
        if kind == 'model_usage':
            rows.append({'type': 'custom', 'id': 'bill', 'parentId': 'assistant',
                         'timestamp': stamp, 'customType': 'model_usage',
                         'data': {'source': 'refine', 'provider': 'parity-local',
                                  'modelId': 'parity-1', 'usage': USAGE}})
        if kind == 'compaction':
            rows.append({'type': 'compaction', 'id': 'bill', 'parentId': 'assistant',
                         'timestamp': stamp, 'summary': 'Summary',
                         'firstKeptEntryId': 'assistant', 'tokensBefore': 12,
                         'usage': USAGE})
        (root / 'agent/sessions' / (ident + '.jsonl')).write_text(
            ''.join(json.dumps(row) + '\n' for row in rows))


def observe(binary, root, receipt):
    env = env_for(root)
    env[TAG] = str(root)
    seed(root)
    path = root / 'd.sock'
    scope = OwnedProcesses(binary, root, path)
    client = daemon = None
    with open(root / 'daemon.log', 'wb') as log:
        try:
            command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(path)]
            daemon = subprocess.Popen(command, cwd=root, env=env, stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True)
            scope.register(daemon, command)
            client = CatalogClient(path, daemon)
            receipt['hello'] = client.hello
            data = client.call('list_saved_sessions', cwd=CWD, scope='all')
            receipt['catalog'] = data
            actual = {row['id'].removeprefix('billing-'): row.get('usage')
                      for row in data['sessions']}
            receipt['rust_observed'] = actual
            receipt['ts_observed'] = TS_OBSERVED
            receipt['parity_equal'] = actual == TS_OBSERVED
            assert actual == {'baseline': SINGLE, 'model_usage': DOUBLE,
                              'compaction': DOUBLE}, actual
            receipt['billing_verified'] = True
        finally:
            receipt['raw_received_hex'] = list(client.received) if client else []
            receipt['raw_sent_hex'] = list(client.sent) if client else []
            finish(scope, client, daemon, receipt)
            log.flush()
            receipt['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-3000:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__,
               'not_verified': ['TUI frames', 'provider calls', 'TS/Rust wire-byte equality'],
               'ts_reference': 'v0.9.8 / 7d442aafa985f9342134fac16c2ef41f03fb45c1'}
    try:
        binary = Path(os.environ['PA_RUST_BINARY']).resolve()
        receipt['binary_sha256'] = digest(binary)
        with tempfile.TemporaryDirectory(prefix='pa-billing-', dir='/tmp') as folder:
            observe(binary, Path(folder), receipt)
        assert receipt.get('billing_verified') and receipt.get('cleanup_verified'), receipt
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2))
    print(json.dumps({'verified': receipt['verified'],
                      'parity_equal': receipt.get('parity_equal'),
                      'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
