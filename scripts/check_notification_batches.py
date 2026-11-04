#!/usr/bin/env python3
"""Observe actual notification batching against a captured TS queue control.

This checks the proposed Rust policy and records parity_equal separately.
It does not accept the deliberate change from TS one-notification turns.
"""
import argparse
import http.server
import time
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

from check_saved_catalog import CatalogClient
from lifecycle_lib import OwnedProcesses, TAG, digest, env_for, finish


MARKERS = ['BATCH_HOLD', 'BATCH_A', 'BATCH_B', 'USER_BOUNDARY', 'BATCH_C']
TS_OBSERVED = [[MARKERS[0]], [MARKERS[1]], [MARKERS[2]], [MARKERS[3]], [MARKERS[4]]]


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), BatchHandler)
        self.requests = []
        self.arrived = threading.Condition()
        self.release = threading.Event()


class BatchHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with self.server.arrived:
            self.server.requests.append(body)
            number = len(self.server.requests)
            self.server.arrived.notify_all()
        if self.path != '/v1/chat/completions' or number > 8:
            self.send_error(400)
            return
        if number == 1:
            self.server.release.wait(35)
        def chunk(delta, finish=None):
            return {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1,
                'model': 'parity-1', 'choices': [{'index': 0, 'delta': delta,
                                               'finish_reason': finish}]}
        data = (''.join('data: ' + json.dumps(c) + '\n\n' for c in (
            chunk({'role': 'assistant', 'content': 'Fixture complete.'}),
            chunk({}, 'stop'))) + 'data: [DONE]\n\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def observe(binary, root, receipt):
    env = env_for(root)
    env[TAG] = str(root)
    server = Server()
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
            client.call('prompt', activeSessionId=active, message=MARKERS[0])
            with server.arrived:
                assert server.arrived.wait_for(lambda: len(server.requests) == 1, timeout=15)
            def notice(text):
                return {'role': 'custom', 'customType': 'batch_fixture', 'content': text,
                        'display': True, 'timestamp': 1704067200000}
            for marker in MARKERS[1:3]:
                client.call('steer', activeSessionId=active, message=marker,
                            customMessage=notice(marker), expandPromptTemplates=False)
            client.call('follow_up', activeSessionId=active, message=MARKERS[3])
            client.call('follow_up', activeSessionId=active, message=MARKERS[4],
                        customMessage=notice(MARKERS[4]), expandPromptTemplates=False)
            before = receipt['queue_before'] = client.call('get_queue', activeSessionId=active)
            assert before == {'steering': MARKERS[1:3], 'followUp': MARKERS[3:5]}, before
            server.release.set()
            with server.arrived:
                assert server.arrived.wait_for(lambda: any(MARKERS[4] in json.dumps(body)
                    for body in server.requests), timeout=20), server.requests
            deadline = time.monotonic() + 15
            while True:
                state = client.call('get_state', activeSessionId=active)
                queue = client.call('get_queue', activeSessionId=active)
                if state.get('isStreaming') is False and queue == {'steering': [], 'followUp': []}:
                    break
                assert time.monotonic() < deadline, (state, queue)
                threading.Event().wait(0.025)
            receipt['queue_after'] = queue
            deliveries = []
            for body in server.requests:
                messages = body['messages']
                start = max((i for i, message in enumerate(messages)
                             if message.get('role') == 'assistant'), default=-1) + 1
                tail = json.dumps(messages[start:])
                deliveries.append([marker for marker in MARKERS if marker in tail])
            receipt.update(deliveries=deliveries, ts_observed_deliveries=TS_OBSERVED,
                           parity_equal=deliveries == TS_OBSERVED)
            assert deliveries == [[MARKERS[0]], MARKERS[1:3], [MARKERS[3]], [MARKERS[4]]], deliveries
            entries = [json.loads(line) for path in (root / 'agent/sessions').rglob('*.jsonl')
                       for line in path.read_text().splitlines() if line.strip()]
            custom = [row for row in entries if row.get('type') == 'custom_message'
                      and row.get('customType') == 'batch_fixture']
            receipt['persisted_notices'] = custom
            assert [row.get('content') for row in custom] == MARKERS[1:3] + [MARKERS[4]], custom
            receipt['batching_verified'] = True
        finally:
            server.release.set()
            receipt['http_requests'] = server.requests
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
    receipt = {'verified': False, 'scope': __doc__,
        'ts_reference': 'v0.9.8 / 7d442aafa985f9342134fac16c2ef41f03fb45c1',
        'ts_binary_sha256': 'e50d4e4cf5735ea16cee30c3ca48fccb628ae2169fc867c33d461b8a90e87bc5',
        'not_verified': ['MidRun tool interruption', 'cross-lane notification-only co-delivery',
                         'TUI frames', 'wire-byte equality', 'live Prime Inference']}
    try:
        binary = Path(os.environ['PA_RUST_BINARY']).resolve()
        receipt['binary_sha256'] = digest(binary)
        with tempfile.TemporaryDirectory(prefix='pa-notification-batch-', dir='/tmp') as folder:
            observe(binary, Path(folder), receipt)
        assert receipt.get('batching_verified') and receipt.get('cleanup_verified') \
            and receipt.get('provider_stopped'), receipt
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
