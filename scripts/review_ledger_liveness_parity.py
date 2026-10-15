#!/usr/bin/env python3
"""Hosted actual TS/Rust RLM spawn, durable ledger and warm-list liveness comparison.

A real parent kernel admits a child with rlm.spawn. The synthetic provider holds
that child's turn while both daemons answer repeated list/roster reads. This is
live-family baseline parity, not a TS proof of external symlink retargeting or
passivation/registration timing; those boundaries are recorded as out of scope.
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

from review_agent_bounce_parity import Client, LIMIT
from review_draft_disconnect_parity import digest, env_for, stop, TS_ARCHIVE_SHA256
from review_restore_notice_parity import texts

PARENT = 'Create the ledger liveness fixture child.'
CHILD = 'LEDGER_LIVENESS_CHILD_HOLD'
NAME = 'ledger-fixture-child'
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
            if is_child:
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
        if is_child:
            self.server.release.wait(LIMIT * 4)
        def chunk(delta, reason=None):
            return {'id': 'ledger-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'parity-1', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
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


def run_case(binary, kind, root, observed):
    env = env_for(root, kind)
    library = Path(os.environ['PI_PACKAGE_DIR']) / 'skills'
    env['PYTHONPATH'] = os.pathsep.join(sorted(str(path) for path in library.glob('*/src') if path.is_dir()))
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
            return {'list': contracts, 'roster': roster_contract,
                    'durable_spawn': {'name': NAME, 'depth': 1, 'count': 1,
                                      'parent_matches_created_session': True, 'child_transcript_exists': True}}
    finally:
        observed['owned_before_shutdown'] = owned_processes(root)
        provider.release.set()
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
    result = {'verified': False, 'scope': __doc__, 'runs': {},
              'not_compared': ['external symlink retarget on an active transcript',
                               'nonresident-child passivation/registration timing',
                               'whole wire equality: full raw responses preserved; compare declared family contract']}
    try:
        assert sys.platform == 'linux', 'hosted Linux CI only'
        assert digest(os.environ['PA_TS_ARCHIVE']) == TS_ARCHIVE_SHA256, 'TS archive hash mismatch'
        result['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-ledger-', dir='/tmp') as temporary:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ['PA_' + kind.upper() + '_BINARY']).resolve()
                observed = result['runs'][kind] = {'binary_sha256': digest(binary)}
                try:
                    observed['contract'] = run_case(binary, kind, Path(temporary) / kind, observed)
                except Exception as error:
                    observed['error'] = str(error)
            errors = {kind: run['error'] for kind, run in result['runs'].items() if 'error' in run}
            assert not errors, errors
            assert result['runs']['ts']['contract'] == result['runs']['rust']['contract'], 'family contract mismatch'
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(args.receipt), 'verified': result['verified'], 'error': result.get('error')}))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
