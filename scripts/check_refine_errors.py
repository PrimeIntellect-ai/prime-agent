#!/usr/bin/env python3
"""Observe actual refinement errors for each provider failure fixture."""
import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

from check_saved_catalog import CatalogClient
from lifecycle_lib import OwnedProcesses, TAG, digest, env_for, finish


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, scenario):
        super().__init__(('127.0.0.1', 0), ErrorHandler)
        self.scenario, self.requests, self.received_headers = scenario, [], []


class ErrorHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append({'path': self.path, 'body': body})
        self.server.received_headers.append(dict(self.headers))
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        if self.server.scenario == 'provider_error':
            data = json.dumps({'error': {'message': 'fixture token budget invalid',
                'type': 'invalid_request_error', 'code': 'invalid_request_error'}}).encode()
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
        else:
            content = '{"summary":"cut' if self.server.scenario == 'length' else 'not-json'
            reason = 'length' if self.server.scenario == 'length' else 'stop'
            def chunk(delta, finish=None):
                return {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'parity-1', 'choices': [{'index': 0, 'delta': delta,
                                                   'finish_reason': finish}]}
            data = (''.join('data: ' + json.dumps(c) + '\n\n' for c in (
                chunk({'role': 'assistant', 'content': content}), chunk({}, reason)))
                + 'data: [DONE]\n\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


CASES = ('length', 'provider_error', 'normal_invalid')


def observe(binary, root, case, receipt):
    env = env_for(root)
    env[TAG] = str(root)
    server = Server(case)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (root / 'agent/auth.json').write_text(json.dumps({'prime-inference': {
        'type': 'api_key', 'key': 'fixture-only',
        'primeTeam': {'teamId': 'team-1', 'name': 'Test Team'}}}))
    (root / 'agent/models.json').write_text(json.dumps({'providers': {
        'prime-inference': {'api': 'openai-completions',
        'baseUrl': f'http://127.0.0.1:{server.server_port}/v1',
        'models': [{'id': 'parity-1', 'name': 'Parity', 'reasoning': False,
                    'input': ['text'], 'contextWindow': 128000, 'maxTokens': 8192}]}}}))
    (root / 'agent/settings.json').write_text(json.dumps({
        'defaultProvider': 'prime-inference', 'defaultModel': 'parity-1',
        'auxiliaryModel': 'prime-inference/parity-1',
        'prewarmPythonKernel': False, 'autoRefine': {'enabled': False},
        'onboardingCompleted': True}))
    path = root / 'd.sock'
    scope = OwnedProcesses(binary, root, path)
    process = client = None
    with open(root / 'daemon.log', 'wb') as log:
        try:
            command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(path)]
            process = subprocess.Popen(command, cwd=root, env=env, stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True)
            scope.register(process, command)
            client = CatalogClient(path, process)
            receipt['hello'] = client.hello
            created = client.call('create', config={
                'cwd': str(root), 'agentDir': str(root / 'agent'),
                'sessionDir': str(root / 'agent/sessions'),
                'provider': 'prime-inference', 'model': 'parity-1',
                'telemetryDisabled': True, 'noExtensions': True, 'noContextFiles': True})
            active = created.get('activeSessionId') or created.get('id')
            assert active, created
            try:
                client.call('refine', activeSessionId=active,
                            instructions='Fixture no-op refinement')
            except AssertionError as error:
                response = error.args[0]
                assert isinstance(response, dict) and response.get('command') == 'refine', response
                assert response.get('success') is False and isinstance(response.get('error'), str), response
                actual = response['error']
            else:
                raise AssertionError('refine must report the fixture failure')
            assert len(server.requests) == 1, server.requests
            receipt['actual_error'] = actual
            if case == 'length':
                body = server.requests[0]['body']
                budget = body.get('max_tokens', body.get('max_completion_tokens'))
                assert isinstance(budget, int) and budget > 0, body
                receipt['requested_output_tokens'] = budget
                assert actual == ('Refinement failed: the model hit its output limit '
                                  f'({budget} tokens, prime-inference/parity-1)'), actual
            elif case == 'provider_error':
                assert actual.startswith('Refinement failed: ') \
                    and 'fixture token budget invalid' in actual, actual
            else:
                assert actual == 'Refiner did not return a JSON object', actual
            receipt['behavior_verified'] = True
        finally:
            receipt['http_requests'] = server.requests
            receipt['http_headers'] = server.received_headers
            receipt['raw_daemon_sent_hex'] = list(client.sent) if client else []
            receipt['raw_daemon_received_hex'] = list(client.received) if client else []
            finish(scope, client, process, receipt)
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            receipt['provider_stopped'] = not thread.is_alive()
            log.flush()
            receipt['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-3000:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__, 'cases': {},
        'not_verified': ['auto-review HTTP execution', 'TUI frames',
                         'full daemon wire-byte equality', 'live Prime Inference']}
    try:
        binary = Path(os.environ['PA_RUST_BINARY']).resolve()
        receipt['binary_sha256'] = digest(binary)
        with tempfile.TemporaryDirectory(prefix='pa-refine-errors-', dir='/tmp') as folder:
            for case in CASES:
                observed = receipt['cases'][case] = {}
                try:
                    observe(binary, Path(folder) / case, case, observed)
                except Exception as error:
                    observed['error'] = str(error)
        receipt['verified'] = all(c.get('behavior_verified') and c.get('cleanup_verified')
            and c.get('provider_stopped') and not c.get('error')
            for c in receipt['cases'].values())
        if not receipt['verified']:
            receipt['error'] = 'one or more output controls failed; see cases'
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
