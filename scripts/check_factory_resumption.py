#!/usr/bin/env python3
"""Hosted real-daemon factory recovery receipt.

The kernel runs a real factory child, fails its declared JSON output,
resumes the same entry, and binds the second child's valid output.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from check_kernel_env import KernelClient as Client
from lifecycle_lib import digest, env_for
from lifecycle_lib import OwnedProcesses, TAG, finish
from check_restore_notice import texts

MARKER = 'FACTORY_RECOVERY_RESULT='
CELL = '''import asyncio, json, time
factory_harness = rlm.get_harness_state()
factory_harness.create_factory('Recovery fixture', 'Actual factory output recovery', id='recovery-fixture', machine={
    'states': [{'id': 'work', 'entry': True, 'max_entries': 1,
                'subagent': {'prompt': 'FACTORY_RECOVERY_CHILD'},
                'outputs': [{'name': 'data', 'type': 'json'}]},
               {'id': 'verified', 'max_entries': 1,
                'subagent': {'prompt': 'FACTORY_RECOVERY_CHILD_VERIFY'}}],
    'transitions': [{'from': 'work', 'to': 'verified',
        'when': {'output': 'data', 'path': 'ok', 'op': 'eq', 'value': True}}]})
factory_started = await rlm.factory.run('recovery-fixture')
print('FACTORY_RECOVERY_RESULT=' + json.dumps(factory_started))'''


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.requests = []
        self.parent_requests = []
        self.child_requests = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        parent = any('FACTORY_PARENT_PROBE' in ''.join(texts(m.get('content')))
                     for m in body.get('messages', []) if m.get('role') == 'user')
        child = not parent and any('FACTORY_RECOVERY_CHILD' in ''.join(texts(m.get('content')))
                    for m in body.get('messages', []) if m.get('role') == 'user')
        if child:
            self.server.child_requests.append(body)
            delta = {'content': 'first attempt has no JSON' if len(self.server.child_requests) == 1
                     else '```json\n{"data": {"ok": true}}\n```'}
            reason = 'stop'
        else:
            self.server.parent_requests.append(body)
            if len(self.server.parent_requests) == 1:
                offered = [t['function']['name'] for t in body.get('tools', [])]
                assert 'python_repl' in offered, offered
                delta = {'tool_calls': [{'index': 0, 'id': 'factory_probe', 'type': 'function',
                    'function': {'name': 'python_repl', 'arguments': json.dumps({'code': CELL})}}]}
                reason = 'tool_calls'
            else:
                delta, reason = {'content': 'Factory probe complete.'}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'factory-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                'model': 'factory-fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', **delta}), chunk({}, reason))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def extract(requests):
    assert len(requests) == 2, 'unexpected parent provider sequence'
    results = [m for m in requests[-1]['messages'] if m.get('role') == 'tool'
               and m.get('tool_call_id') == 'factory_probe']
    assert len(results) == 1, 'missing/duplicate current tool result'
    values = [json.loads(line[len(MARKER):]) for content in texts(results[0].get('content'))
              for line in content.splitlines() if line.startswith(MARKER)]
    assert len(values) == 1, 'missing/duplicate actual factory receipt'
    return values[0]


def count(row, snake, camel):
    assert not (snake in row and camel in row), 'ambiguous duplicate wire keys'
    return row[snake] if snake in row else row[camel]


def validate(probe):
    assert probe['paused']['state'] == 'paused', probe
    assert probe['done']['state'] == 'done', probe
    nodes = probe['done']['nodes']
    assert sorted(n['id'] for n in nodes) == ['verified', 'work'], nodes
    verified = next(n for n in nodes if n['id'] == 'verified')
    assert verified['status'] == 'done' and count(verified, 'entries_used', 'entriesUsed') == 1 and verified['attempts'] == 1, verified
    node = next(n for n in nodes if n['id'] == 'work')
    assert count(node, 'entries_used', 'entriesUsed') == 1 and node['attempts'] == 2, node
    assert node['status'] == 'done', node


def observe(binary, root, observed):
    env = env_for(root)
    env[TAG] = str(root)
    server = Provider()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (root / 'agent/settings.json').write_text(json.dumps({'factory': {'enabled': True},
        'prewarmPythonKernel': False, 'defaultProvider': 'parity-local', 'defaultModel': 'parity-1',
        'onboardingCompleted': True, 'onboardingShown': True, 'telemetry': {'noticeShown': True}}))
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'parity-local': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'models': [{
            'id': 'parity-1', 'name': 'Factory fixture', 'reasoning': False,
            'contextWindow': 128000, 'maxTokens': 4096}]}}}))
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
        observed['hello'] = control.hello
        created = control.call('create', config={'cwd': str(root), 'agentDir': str(root / 'agent'),
            'provider': 'parity-local', 'model': 'parity-1', 'telemetryDisabled': True,
            'noExtensions': True, 'noContextFiles': True})
        active = created.get('activeSessionId') or created.get('id')
        assert active, created
        control.call('attach', activeSessionId=active)
        control.call('prompt', activeSessionId=active, message='Run FACTORY_PARENT_PROBE')
        control.call('wait_for_idle', timeout_seconds=120, activeSessionId=active)
        started = extract(server.parent_requests[:2])
        observed['started'] = started
        run_id = started['run_id']
        def settled():
            snapshots = []
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                status = control.call('factory_activity', activeSessionId=active,
                                      action='status', runId=run_id)
                snapshots.append(status)
                if status['state'] != 'running':
                    return status
                threading.Event().wait(0.025)
            observed.setdefault('timed_out_snapshots', []).extend(snapshots)
            raise AssertionError('factory did not leave running after parent turn completed')
        paused = settled()
        assert paused['state'] == 'paused', paused
        observed['resume_response'] = control.call('factory_activity', activeSessionId=active,
            action='resume', runId=run_id)
        observed['probe'] = {'paused': paused, 'done': settled()}
        validate(observed['probe'])
        assert len(server.child_requests) == 3, 'not two producer attempts plus one guarded verifier'
        observed['behavior_verified'] = True
    finally:
        observed['provider_requests'] = server.requests
        observed['wire'] = list(control.wire) if control else []
        finish(scope, control, daemon, observed)
        log.close()
        observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-10000:]
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'scope': __doc__, 'not_verified': [
        'TUI',
        'worker-death respawn (separate executor regression)', 'pause/stop races (separate regressions)']}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        with tempfile.TemporaryDirectory(prefix='pa-factory-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observed = result['run'] = {'binary_sha256': digest(binary)}
            try:
                observe(binary, Path(folder) / 'rust', observed)
            except Exception as error:
                observed['error'] = str(error)
            assert observed.get('behavior_verified') and observed.get('cleanup_verified') \
                and 'error' not in observed, 'actual factory observation failed'
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
