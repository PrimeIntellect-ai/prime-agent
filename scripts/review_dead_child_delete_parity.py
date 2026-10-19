#!/usr/bin/env python3
"""Hosted real TS/Rust RLM child deletion baseline and Rust idempotent retry.

A real kernel admits a child whose model request is held. The ordinary daemon
kill command is accepted by both implementations. Rust closes its separate
child worker and removes its projection. TS hosts the child in its parent worker
and its plain kill leaves the spawn edge live; its immediate projection is
retained in the receipt without claiming delete parity. Rust recognizes rlmLedgerDelete and persists
its edge boundary; pinned TS ignores that Rust-native marker (raw ledger
absence is retained as an explicit difference). The new dead-PID and
interrupted-cleanup branches are separately exercised by hosted Unix supervisor
regressions; this fixture does not manufacture a process death or claim parity
for historical TS retry errors.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from review_ledger_liveness_parity import Provider, PARENT, NAME
from review_agent_bounce_parity import Client
from review_draft_disconnect_parity import digest, env_for, TS_ARCHIVE_SHA256
from review_goal_fixture_lifecycle import OwnedProcesses, TAG, finish, verify_worker, process_identity


def delete_contract(rows, child_id):
    deletes = [row for row in rows if row.get('op') == 'delete' and row.get('childId') == child_id]
    assert deletes, 'the actual child deletion did not persist its boundary'
    assert all(row.get('reason') == 'user' for row in deletes), deletes
    return deletes


def observe(binary, kind, root, observed):
    env = env_for(root, kind)
    env[TAG] = str(root)
    library = Path(os.environ['PI_PACKAGE_DIR']) / 'skills'
    env['PYTHONPATH'] = os.pathsep.join(str(p) for p in library.glob('*/src') if p.is_dir())
    provider = Provider()
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'parity-local': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1', 'models': [{
            'id': 'parity-1', 'name': 'Parity 1', 'reasoning': False,
            'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    (root / 'agent/settings.json').write_text(json.dumps({'prewarmPythonKernel': False,
        'defaultProvider': 'parity-local', 'defaultModel': 'parity-1'}))
    path = root / 'd.sock'
    scope = OwnedProcesses(binary, root, path)
    daemon = control = None
    log = open(root / 'daemon.log', 'wb')
    try:
        command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(path)]
        daemon = subprocess.Popen(command, cwd=root, env=env, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True)
        scope.register(daemon, command)
        control = Client(path, daemon)
        created = control.call('create', config={'cwd': str(root), 'agentDir': str(root / 'agent'),
            'provider': 'parity-local', 'model': 'parity-1', 'telemetryDisabled': True})
        active = created.get('activeSessionId') or created.get('id')
        assert active, created
        control.call('attach', activeSessionId=active)
        control.call('prompt', activeSessionId=active, message=PARENT)
        child_id = provider.ready()['child_id']
        listed = control.call('list', all=True)
        rows = [r for r in listed['sessions'] if r.get('rlmChildId') == child_id]
        assert len(rows) == 1 and rows[0].get('sessionName') == NAME, rows
        row = rows[0]
        child_active = row.get('activeSessionId') or row.get('id')
        assert child_active and row.get('parentActiveSessionId') == active, row
        observed['child_before'] = row
        descriptors = [json.loads(p.read_text()) for p in (root / 'agent/daemon-workers').rglob('*.json')]
        worker_root = child_active if kind == 'rust' else active
        child_descriptors = [d for d in descriptors if d.get('rootActiveSessionId') == worker_root]
        assert len(child_descriptors) == 1, child_descriptors
        pid, identity = verify_worker(child_descriptors[0], worker_root, binary, path)
        if kind == 'ts':
            assert row['workerPid'] == pid, 'TS child is not in the verified parent worker'
        observed['worker_layout'] = 'separate child worker' if kind == 'rust' else 'shared parent worker'
        scope.discover()
        observed['child_process_identity'] = {'pid': pid, 'start_id': identity}
        payload = {'activeSessionId': child_active, 'rlmLedgerDelete': 'user', 'rlmChildId': child_id}
        observed['delete_response'] = control.call('kill', **payload)
        after_list = control.call('list', all=True)
        observed['sessions_after'] = after_list
        if kind == 'rust':
            assert not any(r.get('activeSessionId') == child_active for r in after_list['sessions']), after_list
            observed['child_session_closed'] = True
            deadline = time.monotonic() + 15
            while True:
                try:
                    current, state = process_identity(pid)
                    stopped = current != identity or state == 'Z'
                except FileNotFoundError:
                    stopped = True
                if stopped:
                    break
                assert time.monotonic() < deadline, 'actual child worker did not exit after kill'
                threading.Event().wait(0.025)
            observed['child_worker_stopped'] = True
        else:
            observed['ts_child_projection_after_raw_kill'] = [r for r in after_list['sessions']
                if r.get('rlmChildId') == child_id]
            current, state = process_identity(pid)
            assert current == identity and state != 'Z', 'TS unexpectedly lost the shared parent worker'
            observed['shared_parent_worker_alive'] = True
        def ledger():
            return [json.loads(line) for p in (root / 'agent/rlm-ledger').glob('*.jsonl')
                    for line in p.read_text().splitlines()]
        observed['ledger_after'] = ledger()
        if kind == 'ts':
            assert not [r for r in observed['ledger_after']
                        if r.get('op') == 'delete' and r.get('childId') == child_id], observed['ledger_after']
            observed['intentional_difference'] = 'TS does not recognize the Rust-native rlmLedgerDelete kill marker'
        else:
            boundary = delete_contract(observed['ledger_after'], child_id)
            assert len(boundary) == 1, 'expected exactly one original deletion boundary'
            observed['retry_response'] = control.call('kill', **payload)
            observed['ledger_after_retry'] = ledger()
            # No second deletion boundary; usage amendments, if any, retain
            # their actual rows and are not normalized out of this count.
            after = delete_contract(observed['ledger_after_retry'], child_id)
            assert after == boundary, 'idempotent retry changed the original boundary'
        observed['behavior_verified'] = True
    finally:
        observed['wire'] = list(control.wire) if control else []
        observed['provider_requests'] = provider.requests
        provider.release.set()
        finish(scope, control, daemon, observed)
        log.close()
        observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-10000:]
        provider.shutdown()
        provider.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'scope': __doc__, 'runs': {}, 'not_verified': [
        'dead PID and interrupted cleanup (hosted Unix supervisor tests)',
        'parent kernel registry removal', 'TS repeated-delete behavior', 'TUI']}
    try:
        assert sys.platform == 'linux'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256
        result['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-ddelete-', dir='/tmp') as folder:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ[f'PA_{kind.upper()}_BINARY']).resolve()
                observed = result['runs'][kind] = {'binary_sha256': digest(binary)}
                try:
                    observe(binary, kind, Path(folder) / kind, observed)
                except Exception as error:
                    observed['error'] = str(error)
            assert all(r.get('behavior_verified') and r.get('cleanup_verified') and 'error' not in r
                       for r in result['runs'].values()), 'actual delete verification failed'
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
