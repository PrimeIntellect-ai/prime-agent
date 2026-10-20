#!/usr/bin/env python3
"""Actual unbounded catalog evidence for the allMessagesText removal.

The key must be omitted in streamed and terminal rows; the selected stable
fields match the seeded sessions. No provider, kernel, create command or UI is exercised.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from check_agent_bounce import Client
from lifecycle_lib import digest, env_for
from lifecycle_lib import OwnedProcesses, TAG, finish

COUNT = 3
BASE_MS = 1704067200000
STAMP = '2024-01-01T00:00:00.000Z'
CWD = '/tmp/catalog-field-removal-fixture'
FIELDS = ('path', 'id', 'cwd', 'name', 'messageCount', 'firstMessage')
REMOVED = 'allMessagesText'


def seed(root):
    directory = root / 'agent/sessions'
    directory.mkdir(parents=True, exist_ok=True)
    expected = []
    for index in range(COUNT):
        ident = f'field-removal-{index}'
        name = f'Field removal row {index}'
        user = f'FIELD_REMOVAL_USER_{index}'
        assistant = f'FIELD_REMOVAL_ASSISTANT_{index} café 界'
        entries = [
            {'type': 'session', 'version': 3, 'id': ident, 'timestamp': STAMP,
             'cwd': CWD, 'rlmDepth': 0},
            {'type': 'session_info', 'id': ident + '-info', 'parentId': None,
             'timestamp': STAMP, 'name': name},
            {'type': 'message', 'id': ident + '-user', 'parentId': ident + '-info',
             'timestamp': STAMP, 'message': {'role': 'user', 'content': user,
                                            'timestamp': BASE_MS + index * 10000}},
            {'type': 'message', 'id': ident + '-assistant', 'parentId': ident + '-user',
             'timestamp': STAMP, 'message': {'role': 'assistant',
                 'content': [{'type': 'text', 'text': assistant}], 'provider': 'parity-local',
                 'model': 'parity-1', 'timestamp': BASE_MS + index * 10000 + 1000}},
        ]
        path = directory / (ident + '.jsonl')
        path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in entries))
        ns = (BASE_MS + index * 10000) * 1000000
        os.utime(path, ns=(ns, ns))
        assert path.stat().st_mtime_ns == ns, 'fixture lost deterministic mtime'
        expected.append(dict(zip(FIELDS, (path.name, ident, CWD, name, 2, user))))
    return expected


def stable_rows(rows, root):
    assert isinstance(rows, list), 'sessions is not an array'
    values = []
    for row in rows:
        assert isinstance(row, dict), row
        path = Path(row['path'])
        assert path.parent == root / 'agent/sessions', 'catalog escaped owned fixture'
        value = {field: row[field] for field in FIELDS}
        value['path'] = path.name  # The sole normalization: per-run owned root.
        values.append(value)
    ids = [row['id'] for row in values]
    assert len(set(ids)) == len(ids), 'duplicate catalog rows'
    return sorted(values, key=lambda row: row['id'])


def check_rows(rows, root, expected):
    assert stable_rows(rows, root) == sorted(expected, key=lambda row: row['id']), 'stable catalog fields differ'
    for row in rows:
        assert REMOVED not in row, 'allMessagesText must be OMITTED, not null or empty'


class RawReader:
    def __init__(self, reader, received):
        self.reader, self.received = reader, received

    def readline(self):
        line = self.reader.readline()
        self.received.append(line.hex())
        return line

    def close(self):
        self.reader.close()


class RawSocket:
    def __init__(self, sock, sent):
        self.sock, self.sent = sock, sent

    def sendall(self, data):
        self.sent.append(data.hex())
        self.sock.sendall(data)

    def close(self):
        self.sock.close()


class CatalogClient(Client):
    def __init__(self, path, process):
        super().__init__(path, process)
        self.received, self.sent = [], []
        # Hello is retained decoded separately; all subsequent traffic is raw.
        self.reader = RawReader(self.reader, self.received)
        self.sock = RawSocket(self.sock, self.sent)


def validate(observed, root, expected):
    frames, data = observed['frames'], observed['final_data']
    assert isinstance(data, dict), 'terminal data is not an object'
    check_rows(data.get('sessions'), root, expected)
    assert observed['raw_received_hex'] and observed['raw_sent_hex'], 'missing raw traffic'
    assert [json.loads(bytes.fromhex(line)) for line in observed['raw_received_hex']] == frames, 'raw/decoded traffic mismatch'
    final, = [frame for frame in frames if frame.get('type') == 'response']
    assert frames[-1] == final and final.get('success') is True, 'missing successful terminal response'
    assert final.get('command') == 'list_saved_sessions' and final.get('data') == data, final
    request, = [json.loads(bytes.fromhex(line)) for line in observed['raw_sent_hex']]
    assert request['id'] == final['id'] and request['command'] == {
        'type': 'list_saved_sessions', 'cwd': CWD, 'scope': 'all'}, request
    streamed, progress = [], []
    for frame in frames[:-1]:
        assert frame.get('id') == final['id'] and frame.get('command') == 'list_saved_sessions', frame
        if frame.get('type') == 'session_list_item':
            streamed.append(frame['session'])
        else:
            assert frame.get('type') == 'session_list_progress', frame
            assert 0 <= frame['loaded'] <= frame['total'], frame
            progress.append(frame)
    # Three small rows must all stream; no large-store/backpressure claim.
    assert progress, 'missing catalog progress'
    check_rows(streamed, root, expected)
    return stable_rows(data['sessions'], root)


def observe(binary, root, observed):
    env = env_for(root)
    env[TAG] = str(root)
    (root / 'agent/settings.json').write_text(json.dumps({
        'prewarmPythonKernel': False, 'sessionArchiveMaxSessions': 'off',
        'sessionArchiveMaxAgeDays': 'off', 'onboardingCompleted': True,
        'telemetry': {'noticeShown': True}}))
    expected = seed(root)
    observed['fixture'] = {'count': COUNT, 'mtime_base_ms': BASE_MS, 'mtime_step_ms': 10000,
        'archive_max_sessions': 'off', 'archive_max_age_days': 'off',
        'expected_stable_rows': expected}
    path = root / 'd.sock'
    scope = OwnedProcesses(binary, root, path)
    daemon = client = None
    with open(root / 'daemon.log', 'wb') as log:
        try:
            command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(path)]
            daemon = subprocess.Popen(command, cwd=root, env=env, stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True)
            scope.register(daemon, command)
            client = CatalogClient(path, daemon)
            observed['hello'] = client.hello
            try:
                observed['final_data'] = client.call('list_saved_sessions', cwd=CWD, scope='all')
            finally:
                observed['frames'] = list(client.wire)
                observed['raw_received_hex'] = list(client.received)
                observed['raw_sent_hex'] = list(client.sent)
            observed['stable_rows'] = validate(observed, root, expected)
            scope.discover()
            assert set(scope.targets) == set(scope.direct), 'catalog unexpectedly spawned worker/kernel'
            observed['behavior_verified'] = True
        finally:
            finish(scope, client, daemon, observed)
            log.flush()
            observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-10000:]
    assert observed['cleanup_verified'], observed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__,
        'normalization': 'owned path basename; compare rows by durable ID, not stream order',
        'not_verified': ['UI frames or input',
            'performance or heap reduction', 'sidecar old/new compatibility (catalog-only CLI does not emit lease sidecars)',
            'provider/kernel execution', 'large-store backpressure']}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        with tempfile.TemporaryDirectory(prefix='pa-cat-field-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observed = receipt['run'] = {'binary_sha256': digest(binary)}
            try:
                observe(binary, Path(folder) / 'rust', observed)
            except Exception as error:
                observed['error'] = f'{type(error).__name__}: {error}'
            assert observed.get('behavior_verified') and observed.get('cleanup_verified') \
                and 'error' not in observed, 'actual field removal check failed'
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = f'{type(error).__name__}: {error}'
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
