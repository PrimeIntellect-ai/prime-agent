#!/usr/bin/env python3
"""Actual TS/Rust saved-catalog baseline and Rust paging evidence.

No UI/frame parity is claimed. Historical TS ignores optional limit/cursor;
Rust intentionally adds a bounded walk. Both actual daemons read the same
synthetic saved-session corpus without create, prompt, provider or kernel.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from review_agent_bounce_parity import Client
from review_draft_disconnect_parity import digest, env_for, TS_ARCHIVE_SHA256
from review_goal_fixture_lifecycle import OwnedProcesses, TAG, finish

COUNT = 205
PAGE = 200
BASE_MS = 1704067200000
CWD = '/tmp/catalog-paging-fixture'
TARGET = 'SAVED_CATALOG_OLD_NAME_SEARCH_TARGET'
TRANSCRIPT_TARGET = 'SAVED_CATALOG_OLD_ASSISTANT_WIRE_TARGET'
FIELDS = ('path', 'id', 'cwd', 'name', 'messageCount', 'firstMessage', 'allMessagesText')


def iso(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat(
        timespec='milliseconds').replace('+00:00', 'Z')


def seed(root):
    directory = root / 'agent/sessions'
    directory.mkdir(parents=True, exist_ok=True)
    expected = []
    for index in range(COUNT):
        ident = f'catalog-{index:03}'
        stamp = BASE_MS + index * 10000
        user = f'Catalog user {index:03}'
        assistant = TRANSCRIPT_TARGET if index == 0 else f'Catalog assistant {index:03}'
        name = TARGET if index == 0 else f'Catalog row {index:03}'
        entries = [
            {'type': 'session', 'version': 3, 'id': ident, 'timestamp': iso(stamp),
             'cwd': CWD, 'rlmDepth': 0},
            {'type': 'session_info', 'id': ident + '-info', 'parentId': None,
             'timestamp': iso(stamp), 'name': name},
            {'type': 'session_state', 'id': ident + '-state', 'parentId': ident + '-info',
             'timestamp': iso(stamp), 'state': {'status': 'archived'}},
            {'type': 'message', 'id': ident + '-user', 'parentId': ident + '-state',
             'timestamp': iso(stamp), 'message': {'role': 'user', 'content': user,
                                                'timestamp': stamp}},
            {'type': 'message', 'id': ident + '-assistant', 'parentId': ident + '-user',
             'timestamp': iso(stamp + 1000), 'message': {'role': 'assistant',
                 'content': [{'type': 'text', 'text': assistant}],
                 'provider': 'parity-local', 'model': 'parity-1', 'timestamp': stamp + 1000}},
        ]
        path = directory / (ident + '.jsonl')
        path.write_text(''.join(json.dumps(row) + '\n' for row in entries))
        ns = stamp * 1000000
        os.utime(path, ns=(ns, ns))
        assert path.stat().st_mtime_ns == ns, 'fixture filesystem lost deterministic mtime'
        expected.append(dict(zip(FIELDS, (path.name, ident, CWD, name,
            2, user, user + ' ' + assistant))))
    return list(reversed(expected))


def normalize(rows, root):
    assert isinstance(rows, list), 'catalog sessions is not an array'
    normalized = []
    for row in rows:
        assert isinstance(row, dict) and isinstance(row.get('path'), str), row
        path = Path(row['path'])
        assert path.parent == root / 'agent/sessions', 'row escaped owned fixture directory'
        value = {field: row[field] for field in FIELDS}
        value['path'] = path.name  # Only the isolated per-binary root differs.
        normalized.append(value)
    ids = [row['id'] for row in normalized]
    assert len(set(ids)) == len(ids), 'duplicate catalog rows'
    return normalized


def same_rows(actual, expected):
    assert sorted(actual, key=lambda row: row['id']) == sorted(
        expected, key=lambda row: row['id']), 'catalog stable fields differ (including allMessagesText)'


def ts_ignores_paging(call):
    assert set(call['final_data']) == {'sessions'}, 'TS paging shape changed; inspect before updating expectation'


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
        # Preserve exact bytes after the separately recorded actual daemon hello.
        self.received, self.sent = [], []
        self.reader = RawReader(self.reader, self.received)
        self.sock = RawSocket(self.sock, self.sent)


def query(client, observed, label, **paging):
    call = observed['queries'][label] = {'paging': paging}
    start, raw_start, sent_start = len(client.wire), len(client.received), len(client.sent)
    try:
        data = client.call('list_saved_sessions', cwd=CWD, scope='all', **paging)
        call['final_data'] = data
        return call
    finally:
        call['frames'] = client.wire[start:]
        call['raw_received_hex'] = client.received[raw_start:]
        call['raw_sent_hex'] = client.sent[sent_start:]


def validate_query(call, root, expected, *, ordered=False, remaining=None, cursor=False):
    data = call['final_data']
    assert isinstance(data, dict), 'catalog final data is not an object'
    rows = normalize(data.get('sessions'), root)
    same_rows(rows, expected)
    if ordered:
        assert rows == expected, 'Rust catalog is not deterministic newest-first'
    finals = [frame for frame in call['frames'] if frame.get('type') == 'response']
    assert len(finals) == 1, 'missing/duplicate terminal response'
    final = finals[0]
    assert final.get('success') is True and final.get('command') == 'list_saved_sessions', final
    assert final.get('data') == data and call['frames'][-1] == final, 'final is not the stream terminator'
    assert call['raw_received_hex'] and call['raw_sent_hex'], 'missing raw traffic'
    assert [json.loads(bytes.fromhex(line)) for line in call['raw_received_hex']] == call['frames'], 'raw/decoded receipt mismatch'
    request, = [json.loads(bytes.fromhex(line)) for line in call['raw_sent_hex']]
    assert request['id'] == final['id'], 'request/response ID mismatch'
    assert request['command'] == {'type': 'list_saved_sessions', 'cwd': CWD,
                                  'scope': 'all', **call['paging']}, request
    items = []
    progress = []
    for frame in call['frames'][:-1]:
        assert frame.get('id') == final['id'] and frame.get('command') == 'list_saved_sessions', frame
        if frame.get('type') == 'session_list_item':
            items.append(frame['session'])
        else:
            assert frame.get('type') == 'session_list_progress', frame
            assert 0 <= frame['loaded'] <= frame['total'], frame
            progress.append(frame)
    # Rust may drop progress/item frames under backpressure. Final rows are
    # authoritative; streamed rows must be unique, correct members of that final.
    streamed = normalize(items, root)
    assert streamed and progress, 'no catalog stream observed'
    by_id = {row['id']: row for row in rows}
    assert all(by_id.get(row['id']) == row for row in streamed), 'stream/final disagreement'
    if ordered:
        streamed_ids = {row['id'] for row in streamed}
        assert streamed == [row for row in rows if row['id'] in streamed_ids], 'Rust stream order differs from final'
    if remaining is not None:
        assert data.get('remaining') == remaining, 'incorrect remaining count'
        if cursor:
            assert isinstance(data.get('nextCursor'), str) and data['nextCursor'], 'missing continuation'
        else:
            assert data.get('nextCursor') is None, 'completed catalog still has a cursor'
    return rows


def observe(binary, kind, root, observed, ts_cursor=None):
    env = env_for(root, kind)
    env[TAG] = str(root)
    (root / 'agent/settings.json').write_text(json.dumps({
        'prewarmPythonKernel': False, 'sessionArchiveMaxSessions': 'off',
        'sessionArchiveMaxAgeDays': 'off',
        'onboardingCompleted': True, 'telemetry': {'noticeShown': True}}))
    expected = seed(root)
    observed['fixture'] = {'count': COUNT, 'page_size': PAGE, 'mtime_base_ms': BASE_MS,
        'mtime_step_ms': 10000, 'session_archive_max_sessions': 'off',
        'session_archive_max_age_days': 'off',
        'expected_newest_first_ids': [row['id'] for row in expected],
        'old_search_target_id': expected[-1]['id'], 'name_search_target': TARGET,
        'assistant_wire_target': TRANSCRIPT_TARGET}
    observed['queries'] = {}
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
            baseline = query(client, observed, 'unbounded')
            observed['baseline_rows'] = validate_query(baseline, root, expected,
                ordered=kind == 'rust', remaining=0 if kind == 'rust' else None)
            if kind == 'ts':
                ts_ignores_paging(baseline)
            first = query(client, observed, 'limit_200', limit=PAGE)
            if kind == 'rust':
                validate_query(first, root, expected[:PAGE], ordered=True,
                               remaining=COUNT - PAGE, cursor=True)
                cursor = first['final_data']['nextCursor']
                observed['continuation_cursor'] = cursor
            else:
                # Historical TS has no paging semantics. Unexpected acceptance is
                # RED, not silently reclassified as intentional parity.
                validate_query(first, root, expected)
                ts_ignores_paging(first)
                cursor = ts_cursor
                assert isinstance(cursor, str) and cursor, 'actual Rust cursor unavailable'
                observed['optional_paging_behavior'] = 'limit and cursor ignored; complete catalog returned'
            rest = query(client, observed, 'continuation', cursor=cursor)
            validate_query(rest, root, expected[PAGE:] if kind == 'rust' else expected,
                ordered=kind == 'rust', remaining=0 if kind == 'rust' else None)
            if kind == 'rust':
                joined = normalize(first['final_data']['sessions'] + rest['final_data']['sessions'], root)
                assert joined == expected, 'pages did not cover full catalog exactly once'
                assert TARGET not in json.dumps(first['final_data']['sessions'])
                assert rest['final_data']['sessions'][-1]['name'] == TARGET
                assert TRANSCRIPT_TARGET in rest['final_data']['sessions'][-1]['allMessagesText']
            else:
                ts_ignores_paging(rest)
            boundary = expected[PAGE - 1]
            boundary_path = root / 'agent/sessions' / boundary['path']
            boundary_path.unlink()
            observed['deleted_cursor_file'] = boundary['path']
            after = query(client, observed, 'continuation_after_cursor_delete', cursor=cursor)
            validate_query(after, root, expected[PAGE:] if kind == 'rust' else [
                row for row in expected if row['id'] != boundary['id']],
                ordered=kind == 'rust', remaining=0 if kind == 'rust' else None)
            if kind == 'ts':
                ts_ignores_paging(after)
            for rows in (observed['baseline_rows'], after['final_data']['sessions']):
                target, = [row for row in rows if row['id'] == expected[-1]['id']]
                assert target['name'] == TARGET
                assert TRANSCRIPT_TARGET in target['allMessagesText']
            scope.discover()
            assert set(scope.targets) == set(scope.direct), 'catalog unexpectedly spawned a worker/kernel'
            observed['behavior_verified'] = True
        finally:
            observed['wire'] = list(client.wire) if client else []
            observed['raw_received_hex'] = list(client.received) if client else []
            observed['raw_sent_hex'] = list(client.sent) if client else []
            finish(scope, client, daemon, observed)
            log.flush()
            observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-10000:]
    assert observed['cleanup_verified'], observed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__, 'runs': {},
        'normalization': 'owned path basename only; baseline order compared as an ID-keyed set',
        'intentional_difference': 'Rust limit/cursor pages newest-mtime-first; historical TS ignores both optional fields',
        'not_verified': ['TUI frames or keyboard/search interactions', 'paint latency',
                         'large-transcript timing', 'provider/kernel execution', 'concurrent catalog mutations']}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256, 'TS archive digest mismatch'
        receipt['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-catalog-', dir='/tmp') as folder:
            for kind in ('rust', 'ts'):
                binary = Path(os.environ[f'PA_{kind.upper()}_BINARY']).resolve()
                observed = receipt['runs'][kind] = {'binary_sha256': digest(binary)}
                try:
                    observe(binary, kind, Path(folder) / kind, observed,
                            receipt['runs'].get('rust', {}).get('continuation_cursor'))
                except Exception as error:
                    observed['error'] = str(error)
            assert all(run.get('behavior_verified') and run.get('cleanup_verified')
                       and 'error' not in run for run in receipt['runs'].values()), 'actual catalog comparison failed'
            same_rows(receipt['runs']['ts']['baseline_rows'], receipt['runs']['rust']['baseline_rows'])
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
