#!/usr/bin/env python3
"""Hosted actual factory harness validator API receipt.

Rust executes real harness writes through its kernel. Historical TS absence
is scoped to its actual capability advertisement, not full behavior parity.
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

from review_kernel_env_parity import KernelClient as Client
from review_draft_disconnect_parity import digest, env_for, TS_ARCHIVE_SHA256
from review_goal_fixture_lifecycle import OwnedProcesses, TAG, finish
from review_restore_notice_parity import texts

MARKER = 'FACTORY_VALIDATION_RESULT='
CELL = '''import json
fixture_harness = rlm.get_harness_state()
fixture_results = []
for label, retries in [('positive', 1), ('zero', 0), ('malformed', 'bad')]:
    try:
        value = fixture_harness.create_factory('Validation fixture', 'Production harness write',
            id='fixture-' + label, dag={'nodes': [{'id': 'watcher', 'lifecycle': 'resident',
                'subagent': {'prompt': 'Watch fixture'}, 'retries': retries}]})
        fixture_results.append({'case': label, 'stored': fixture_harness.get('factory', 'fixture-' + label) is not None})
    except ValueError as error:
        fixture_results.append({'case': label, 'error': str(error),
            'stored': fixture_harness.get('factory', 'fixture-' + label) is not None})
print('FACTORY_VALIDATION_RESULT=' + json.dumps(fixture_results))'''


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.requests = []
        self.parent_requests = []
        self.errors = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        parent = any('FACTORY_VALIDATION_PARENT' in ''.join(texts(m.get('content')))
                     for m in body.get('messages', []) if m.get('role') == 'user')
        if not parent:
            self.server.errors.append('unexpected child or unrelated provider request')
            self.send_error(422)
            return
        self.server.parent_requests.append(body)
        if len(self.server.parent_requests) == 1:
            offered = [t['function']['name'] for t in body.get('tools', [])]
            repl = next((name for name in ('python_repl', 'ipython') if name in offered), None)
            assert repl is not None, offered
            delta = {'tool_calls': [{'index': 0, 'id': 'factory_probe', 'type': 'function',
                'function': {'name': repl, 'arguments': json.dumps({'code': CELL})}}]}
            reason = 'tool_calls'
        else:
            delta, reason = {'content': 'Factory validation probe complete.'}, 'stop'
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


def validate(probe):
    assert len(probe) == 3, probe
    positive, zero, malformed = probe
    assert positive['case'] == 'positive' and positive['stored'] is False, positive
    assert 'resident node watcher cannot declare retries' in positive['error'], positive
    assert zero == {'case': 'zero', 'stored': True}, zero
    assert malformed['case'] == 'malformed' and malformed['stored'] is False, malformed
    assert 'retries must be an integer between 0 and 10' in malformed['error'], malformed


def observe(binary, kind, root, observed):
    env = env_for(root, kind)
    env[TAG] = str(root)
    server = Provider()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (root / 'agent/settings.json').write_text(json.dumps({'factory': {'enabled': True},
        'prewarmPythonKernel': False, 'defaultProvider': 'parity-local', 'defaultModel': 'parity-1'}))
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
        caps = control.hello.get('serverCapabilities', [])
        if kind == 'ts':
            assert 'factory_activity' not in caps, 'TS unexpectedly advertises factory'
            observed['factory_lane_advertised'] = False
        else:
            created = control.call('create', config={'cwd': str(root), 'agentDir': str(root / 'agent'),
                'provider': 'parity-local', 'model': 'parity-1', 'telemetryDisabled': True})
            active = created.get('activeSessionId') or created.get('id')
            assert active, created
            control.call('attach', activeSessionId=active)
            control.call('prompt', activeSessionId=active, message='Run FACTORY_VALIDATION_PARENT')
            control.call('wait_for_idle', timeout_seconds=120, activeSessionId=active)
            observed['probe'] = extract(server.parent_requests)
            validate(observed['probe'])
            assert not server.errors, server.errors
        observed['behavior_verified'] = True
    finally:
        observed['provider_requests'] = server.requests
        observed['provider_errors'] = server.errors
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
    result = {'verified': False, 'scope': __doc__, 'runs': {}, 'not_verified': [
        'TS factory behavior (no advertised historical counterpart)', 'TUI', 'factory execution and recovery', 'TS validator equality']}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256
        result['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-factory-', dir='/tmp') as folder:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ[f'PA_{kind.upper()}_BINARY']).resolve()
                observed = result['runs'][kind] = {'binary_sha256': digest(binary)}
                try:
                    observe(binary, kind, Path(folder) / kind, observed)
                except Exception as error:
                    observed['error'] = str(error)
            assert all(r.get('behavior_verified') and r.get('cleanup_verified') and 'error' not in r
                       for r in result['runs'].values()), 'actual factory observation failed'
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
