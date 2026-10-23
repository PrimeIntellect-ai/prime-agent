#!/usr/bin/env python3
"""Hosted actual RLM spawn, durable ledger and warm-list liveness check.

A real parent kernel admits a child with rlm.spawn. The synthetic provider holds
that child's turn while the daemon answers repeated list/roster reads. This checks
the live family plus real disk relocation/deletion, the ended child's current exit
sidecar and catalog wake restore. Historical flat-path tombstone rows are explicit
fixture inputs. Symlink retargeting and registration timing remain out of scope.
"""
import argparse
import http.server
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from check_agent_bounce import Client, LIMIT
from lifecycle_lib import digest, env_for, stop
from check_restore_notice import texts

PARENT = 'Create the ledger liveness fixture child.'
CHILD = 'LEDGER_LIVENESS_CHILD_HOLD'
NAME = 'ledger-fixture-child'
BILLING = 'LEDGER_CACHE_BILLING_TURN'
MARKER = 'LEDGER_LIVENESS_ADMITTED='
CODE = """import json
ledger_handle = await rlm.spawn('LEDGER_LIVENESS_CHILD_HOLD', name='ledger-fixture-child')
print('LEDGER_LIVENESS_ADMITTED=' + json.dumps({'child_id': ledger_handle.rlm_child_id}))"""


def admitted_probe(body):
    rows = [row for row in body.get('messages', [])
            if row.get('role') == 'tool' and row.get('tool_call_id') == 'ledger_spawn']
    assert len(rows) == 1, 'expected exactly one current ledger_spawn tool result'
    probes = [json.loads(line[len(MARKER):]) for row in rows
              for text in texts(row.get('content')) for line in text.splitlines()
              if line.startswith(MARKER)]
    assert len(probes) == 1 and probes[0].get('child_id'), 'expected one nonempty admission probe'
    return probes[0]


def owned_processes(root):
    expected = {('PI_CODING_AGENT_DIR=' + str(root / 'agent')).encode(),
                ('PRIME_AGENT_CODING_AGENT_DIR=' + str(root / 'agent')).encode()}
    found = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            environment = set((path / 'environ').read_bytes().split(b'\0'))
            if expected.isdisjoint(environment):
                continue
            start = (path / 'stat').read_text().rsplit(')', 1)[1].split()[19]
            found[int(path.name)] = start
        except (OSError, IndexError):
            continue
    return found


def confirm_cleanup(root, observed):
    deadline = time.monotonic() + 10
    remaining = owned_processes(root)
    while remaining and time.monotonic() < deadline:
        threading.Event().wait(0.025)
        remaining = owned_processes(root)
    observed['remaining_owned_processes'] = remaining
    # Failure stays red, even when fixture-owned fallback cleanup succeeds.
    if remaining:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid, start in remaining.items():
                if owned_processes(root).get(pid) == start:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + 5
            while owned_processes(root) and time.monotonic() < deadline:
                threading.Event().wait(0.025)
        observed['remaining_after_fallback'] = owned_processes(root)
    assert not remaining, 'owned detached processes survived normal shutdown'
    assert 'shutdown_error' not in observed, observed.get('shutdown_error')


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.arrived = threading.Condition()
        self.requests = []
        self.release = threading.Event()
        self.probe = None
        self.parent_calls = 0
        self.child_arrived = False
        self.billing_calls = 0
        self.restore_release = threading.Event()

    def ready(self):
        with self.arrived:
            assert self.arrived.wait_for(lambda: self.probe is not None and self.child_arrived,
                                         timeout=LIMIT * 2), 'actual spawn/tool result/child request never arrived'
            return self.probe


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        user_texts = [text for row in body.get('messages', []) if row.get('role') == 'user'
                      for text in texts(row.get('content'))]
        is_child = any(CHILD in text for text in user_texts)
        with self.server.arrived:
            self.server.requests.append(body)
            billing = any(BILLING in text for text in user_texts)
            if billing:
                self.server.billing_calls += 1
                delta, finish = {'content': 'Billing fixture completed.'}, 'stop'
            elif is_child:
                self.server.child_arrived = True
                delta, finish = {'content': 'Child fixture released.'}, 'stop'
            else:
                self.server.parent_calls += 1
                if self.server.parent_calls == 1:
                    offered = {tool.get('function', {}).get('name') for tool in body.get('tools', [])}
                    tool = next((name for name in ('python_repl', 'ipython') if name in offered), None)
                    if tool is None:
                        self.send_error(422, 'No real REPL tool offered')
                        return
                    delta = {'tool_calls': [{'index': 0, 'id': 'ledger_spawn', 'type': 'function',
                              'function': {'name': tool, 'arguments': json.dumps({'code': CODE})}}]}
                    finish = 'tool_calls'
                else:
                    self.server.probe = admitted_probe(body)
                    delta, finish = {'content': 'Parent fixture completed.'}, 'stop'
            self.server.arrived.notify_all()
        if billing and self.server.billing_calls > 1:
            # The restored session's new delivery remains in flight while
            # its catalog own-usage is compared with the original captured usage.
            self.server.restore_release.wait(LIMIT * 4)
        elif is_child:
            self.server.release.wait(LIMIT * 4)
        def chunk(delta, reason=None):
            return {'id': 'ledger-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'parity-1', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}],
                    'usage': {'prompt_tokens': 8, 'completion_tokens': 3, 'total_tokens': 11} if reason else None}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', **delta}), chunk({}, finish))) + 'data: [DONE]\n\n'
        encoded = wire.encode()
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass


def family_contract(rows, child_id, parent_active):
    selected = [row for row in rows if row.get('rlmChildId') == child_id]
    assert len(selected) == 1, 'expected one actual admitted child, got ' + repr(selected)
    row = selected[0]
    assert row.get('sessionName') == NAME, row
    assert row.get('rlmDepth') == 1, row
    assert row.get('parentActiveSessionId') == parent_active, row
    assert row.get('sessionFile') and Path(row['sessionFile']).is_file(), row
    # Only generated identities/paths are replaced, preserving relational facts.
    return {'name': row['sessionName'], 'depth': row['rlmDepth'], 'child': '<admitted-child>',
            'parent': '<resident-parent>', 'transcript_exists': True}


def catalog_row(view, path):
    rows = [row for row in view['sessions'] if Path(row['path']).resolve() == path.resolve()]
    assert len(rows) == 1, 'expected exactly one actual catalog path: ' + repr(rows)
    return rows[0]


def cache_boundaries(client, config, root, created, child, ledger_path, provider, observed):
    parent_file = Path(created['sessionFile'])
    child_file = Path(child['sessionFile'])
    child_active = child.get('activeSessionId') or child.get('id')
    assert child_active, child
    headers = [json.loads(line) for line in child_file.read_text().splitlines()
               if line.strip() and json.loads(line).get('type') == 'session']
    assert len(headers) == 1 and headers[0].get('id'), headers
    child_session_id = headers[0]['id']
    provider.release.set()
    client.call('wait_for_idle', activeSessionId=child_active)
    client.call('wait_for_idle', activeSessionId=created.get('activeSessionId') or created['id'])
    client.call('kill', activeSessionId=child_active)
    sidecar = child_file.with_suffix('.info-cache.json')
    observed['lease_exit_sidecar'] = {'path': str(sidecar), 'exists': sidecar.is_file()}
    if sidecar.is_file():
        data = json.loads(sidecar.read_text())
        generation = data['state']['generation']['len']
        offset = data['state']['offset']
        length = child_file.stat().st_size
        observed['lease_exit_sidecar'].update(version=data['version'], generation=generation,
            offset=offset, transcript_bytes=length, current=(generation == offset == length))
    assert observed['lease_exit_sidecar'].get('current'), 'ended child sidecar is not current'
    before = ledger_path.read_bytes()
    trace = observed['cache_boundaries'] = {'artifact_reads': [], 'setup':
        'actual spawned child transcript moved only after worker kill; historical flat-path tombstone fixture below'}
    relocated = root / 'agent/session-artifacts/ledger-moved/first' / child_file.name
    relocated.parent.mkdir(parents=True)
    child_file.rename(relocated)
    first = client.call('list_saved_sessions', cwd=str(root), scope='all')
    trace['artifact_reads'].append(first)
    first_matches = [row for row in first['sessions'] if Path(row['path']).resolve() == relocated.resolve()]
    assert len(first_matches) <= 1, first_matches
    trace['first_relocated_child_present'] = len(first_matches) == 1
    assert catalog_row(first, relocated)['id'] == child_session_id
    moved_again = root / 'agent/session-artifacts/ledger-moved/second' / child_file.name
    moved_again.parent.mkdir(parents=True)
    relocated.rename(moved_again)
    second = client.call('list_saved_sessions', cwd=str(root), scope='all')
    trace['artifact_reads'].append(second)
    recovered = [row for row in second['sessions'] if Path(row['path']).resolve() == moved_again.resolve()]
    removed = root / ('removed-' + child_file.name)
    moved_again.rename(removed)
    third = client.call('list_saved_sessions', cwd=str(root), scope='all')
    trace['artifact_reads'].append(third)
    stale = [row for row in third['sessions'] if row['id'] == child_session_id]
    trace['artifact_contract'] = {'relocation_recovered': len(recovered) == 1, 'removed_child_absent': not stale}
    assert trace['artifact_contract'] == {'relocation_recovered': True, 'removed_child_absent': True}, trace
    assert ledger_path.read_bytes() == before, 'artifact mutations unexpectedly changed ledger'
    # Restore the actual transcript so normal cleanup retains the original fixture layout.
    removed.rename(child_file)

    billing = client.call('create', name='ledger-billing-child', config=config)
    billing_active = billing.get('activeSessionId') or billing.get('id')
    billing_file = Path(billing['sessionFile'])
    client.call('prompt_and_wait', activeSessionId=billing_active, message=BILLING)
    client.call('kill', activeSessionId=billing_active)
    own_view = client.call('list_saved_sessions', cwd=str(root), scope='all')
    own = catalog_row(own_view, billing_file)
    usage = own.get('usage')
    assert usage and usage['inputTokens'] > 0 and usage['outputTokens'] > 0, own
    # Controlled, valid historic ledger input: unlike the initial admission this
    # edge is seeded by the fixture, never claimed to be an actual rlm.spawn.
    records = [
        {'v': 1, 'op': 'spawn', 'at': '2026-01-01T00:00:00Z', 'childId': 'fixture-flat-child',
         'parent': str(parent_file), 'child': str(billing_file), 'depth': 1, 'name': 'billing-child'},
        {'v': 1, 'op': 'delete', 'at': '2026-01-01T00:00:01Z', 'childId': 'fixture-flat-child',
         'child': str(billing_file), 'reason': 'user', 'usage': usage}]
    with ledger_path.open('a') as output:
        for record in records:
            output.write(json.dumps(record) + '\n')
    trace['seeded_historical_records'] = records
    archive = root / 'agent/sessions-archive' / billing_file.name
    archive.parent.mkdir(parents=True, exist_ok=True)
    billing_file.rename(archive)
    unchanged = ledger_path.read_bytes()
    warm = client.call('list_saved_sessions', cwd=str(root), scope='all')
    trace['bucket_warm'] = warm
    parent_before = catalog_row(warm, parent_file)
    trace['warm_bucket_matches_actual_usage'] = parent_before.get('deletedDescendantUsage') == usage
    assert trace['warm_bucket_matches_actual_usage'], parent_before
    wake = client.call('send_message', targetActiveSessionId=own['id'], message='Restore the billing fixture.')
    trace['actual_restore_wake'] = wake
    assert billing_file.is_file() and not archive.exists(), 'actual catalog wake did not restore transcript'
    restored = client.call('list_saved_sessions', cwd=str(root), scope='all')
    trace['bucket_after_actual_restore'] = restored
    parent_after = catalog_row(restored, parent_file)
    restored_child = catalog_row(restored, billing_file)
    trace['bucket_contract'] = {'restored_child_has_own_usage': restored_child.get('usage') == usage,
        'parent_bucket_withdrawn': 'deletedDescendantUsage' not in parent_after}
    assert trace['bucket_contract'] == {'restored_child_has_own_usage': True, 'parent_bucket_withdrawn': True}, trace
    assert ledger_path.read_bytes() == unchanged, 'actual restore unexpectedly appended ledger'
    trace['ledger_unchanged_across_boundary_operations'] = True
    return {'artifact': trace['artifact_contract'], 'bucket': trace['bucket_contract']}


def run_case(binary, root, observed):
    env = env_for(root)
    provider = Provider()
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    models = {'providers': {'parity-local': {'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'http://127.0.0.1:%s/v1' % provider.server_port,
        'models': [{'id': 'parity-1', 'name': 'Parity 1', 'reasoning': False,
                    'contextWindow': 128000, 'maxTokens': 4096}]}}}
    (root / 'agent/models.json').write_text(json.dumps(models))
    (root / 'agent/settings.json').write_text(json.dumps({'prewarmPythonKernel': False,
        'defaultProvider': 'parity-local', 'defaultModel': 'parity-1',
        'onboardingCompleted': True, 'telemetry': {'noticeShown': True}}))
    process, client = None, None
    log_path = root / 'daemon.log'
    try:
        with log_path.open('wb') as log:
            path = root / 'd.sock'
            process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(path)],
                cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            client = Client(path, process)
            config = {'cwd': str(root), 'agentDir': str(root / 'agent'), 'provider': 'parity-local',
                      'model': 'parity-1', 'noExtensions': True, 'noContextFiles': True,
                      'telemetryDisabled': True}
            created = client.call('create', name='ledger-fixture-parent', config=config)
            observed['created'] = created
            active = created.get('activeSessionId') or created.get('id')
            assert active and created.get('sessionFile'), created
            client.call('attach', activeSessionId=active)
            client.call('prompt', activeSessionId=active, message=PARENT)
            probe = provider.ready()
            child_id = probe['child_id']
            observed['admitted_tool_result'] = probe
            # Reads are immediate after observed admission and provider readiness,
            # never delayed to hide a liveness failure or retried until green.
            observed['lists'] = [client.call('list', all=True) for _ in range(2)]
            contracts = [family_contract(view['sessions'], child_id, active)
                         for view in observed['lists']]
            assert contracts[0] == contracts[1], 'warm list lost or changed child'
            roster = client.call('roster_subscribe')
            observed['roster'] = roster
            summaries = [entry.get('summary', {}) for entry in roster['roster']]
            roster_contract = family_contract(summaries, child_id, active)
            ledgers = list((root / 'agent/rlm-ledger').glob('*.jsonl'))
            ledger_rows = [json.loads(line) for path in ledgers for line in path.read_text().splitlines()]
            observed['ledger_rows'] = ledger_rows
            spawns = [row for row in ledger_rows if row.get('op') == 'spawn' and row.get('childId') == child_id]
            assert len(spawns) == 1, 'actual spawn did not produce one durable ledger edge'
            assert spawns[0]['depth'] == 1 and spawns[0]['name'] == NAME, spawns
            assert Path(spawns[0]['parent']).resolve() == Path(created['sessionFile']).resolve(), spawns
            listed = [row for row in observed['lists'][0]['sessions'] if row.get('rlmChildId') == child_id]
            assert Path(spawns[0]['child']).resolve() == Path(listed[0]['sessionFile']).resolve(), spawns
            assert Path(spawns[0]['child']).is_file(), spawns
            assert len(ledgers) == 1, ledgers
            cache_boundaries(client, config, root, created, listed[0], ledgers[0], provider, observed)
            return {'list': contracts, 'roster': roster_contract,
                    'durable_spawn': {'name': NAME, 'depth': 1, 'count': 1,
                                      'parent_matches_created_session': True, 'child_transcript_exists': True}}
    finally:
        observed['owned_before_shutdown'] = owned_processes(root)
        provider.release.set()
        provider.restore_release.set()
        if process and process.poll() is None and client:
            try:
                client.call('shutdown', force=True)
                observed['wire'] = client.wire
                client.close()
                process.wait(timeout=15)
                observed['shutdown'] = 'owned supervisor and workers stopped'
            except Exception as error:
                observed['shutdown_error'] = str(error)
        if process:
            stop(process)
        if client:
            observed['wire'] = client.wire
            client.close()
        observed['provider_requests'] = provider.requests
        if log_path.exists():
            observed['daemon_log'] = log_path.read_text(errors='replace')[-10000:]
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=5)
        confirm_cleanup(root, observed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'scope': __doc__,
              'not_verified': ['external symlink retarget on an active transcript',
                               'nonresident-child passivation/registration timing']}
    try:
        assert sys.platform == 'linux', 'hosted Linux CI only'
        with tempfile.TemporaryDirectory(prefix='pa-ledger-', dir='/tmp') as temporary:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observed = result['run'] = {'binary_sha256': digest(binary)}
            observed['contract'] = run_case(binary, Path(temporary) / 'rust', observed)
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(args.receipt), 'verified': result['verified'], 'error': result.get('error')}))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
