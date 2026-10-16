#!/usr/bin/env python3
"""Observe model.info and compact.status through actual TS/Rust daemon binaries.

Both sessions execute the same REPL cell before and after two explicit model
switches. The first cell builds the kernel; later probes must use its surviving
namespace, exercising the daemon's live-core rebind rather than fresh startup.
All provider requests and daemon responses are saved. Model facts and context
windows must match exactly. Other usage fields are reported, never normalized;
this verifier does not claim token-estimator parity. A retryable primary failure
then exercises backup-provider facts and automatic primary restoration.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time

from review_draft_disconnect_parity import env_for, stop
from review_goal_backoff_parity import TS_ARCHIVE_SHA256, sha256
from review_restore_notice_parity import texts

MARKER = 'MODEL_FACTS_PARITY='
CELL = """import json
from rlm import host_request
model_facts_probe_count = globals().get('model_facts_probe_count', 0) + 1
print('MODEL_FACTS_PARITY=' + json.dumps({'kernel_probe_count': model_facts_probe_count, 'model_info': await host_request('model.info', {}), 'compact_status': await host_request('compact.status', {})}))"""
MODELS = [
    {'id': 'facts-text', 'name': 'Facts text', 'reasoning': False,
     'input': ['text'], 'contextWindow': 128000, 'maxTokens': 4096},
    {'id': 'facts-vision', 'name': 'Facts vision', 'reasoning': False,
     'input': ['text', 'image'], 'contextWindow': 256000, 'maxTokens': 4096},
]
BACKUP = {**MODELS[1], 'id': 'facts-text', 'name': 'Facts backup'}
SEQUENCE = [MODELS[0], MODELS[1], MODELS[0], BACKUP, MODELS[0]]


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.requests = []
        self.phase = 0
        self.phase_requests = 0


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path not in ('/primary/v1/chat/completions', '/backup/v1/chat/completions'):
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append({'phase': self.server.phase, 'path': self.path, 'body': body})
        if self.server.phase == 3 and self.path.startswith('/primary/'):
            wire = json.dumps({'error': {'message': 'Fixture primary temporarily unavailable', 'type': 'server_error'}}).encode()
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(wire)))
            self.end_headers()
            self.wfile.write(wire)
            return
        self.server.phase_requests += 1
        if self.server.phase_requests == 1:
            offered = {tool.get('function', {}).get('name') for tool in body.get('tools', [])}
            name = next((name for name in ('python_repl', 'ipython') if name in offered), None)
            if name is None:
                self.send_error(422, 'No Python REPL offered')
                return
            delta = {'tool_calls': [{'index': 0, 'id': 'call_facts_%s' % self.server.phase,
                     'type': 'function', 'function': {'name': name,
                     'arguments': json.dumps({'code': CELL})}}]}
            finish = 'tool_calls'
        elif self.server.phase_requests == 2:
            delta, finish = {'content': 'Facts observed.'}, 'stop'
        else:
            self.send_error(422, 'Unexpected extra provider request')
            return
        def chunk(delta, reason=None):
            return {'id': 'facts-parity', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': body['model'], 'choices': [{'index': 0, 'delta': delta,
                                                        'finish_reason': reason}]}
        usage = {'id': 'facts-parity', 'object': 'chat.completion.chunk', 'created': 1,
                 'model': body['model'], 'choices': [],
                 'usage': {'prompt_tokens': 10, 'completion_tokens': 1, 'total_tokens': 11,
                           'prompt_tokens_details': {'cached_tokens': 0}}}
        wire = ''.join('data: ' + json.dumps(item) + '\n\n' for item in (
            chunk({'role': 'assistant', **delta}), chunk({}, finish), usage)) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def latest_probe(request, tool_call_id):
    found = []
    for message in request.get('messages', []):
        if message.get('role') == 'tool' and message.get('tool_call_id') == tool_call_id:
            for text in texts(message.get('content')):
                for line in text.splitlines():
                    if line.startswith(MARKER):
                        found.append(json.loads(line[len(MARKER):]))
    assert len(found) == 1, 'Expected one actual REPL result for ' + tool_call_id
    return found[0]


def verify_probe(probe, model, count, provider='fixture'):
    assert probe['kernel_probe_count'] == count, probe
    assert probe['model_info'] == {'provider': provider, 'id': model['id'],
                                   'input': model['input']}, probe
    assert probe['compact_status']['context_window'] == model['contextWindow'], probe
    assert probe['compact_status']['scheduled'] is False, probe


class Client:
    def __init__(self, sock, observation):
        self.sock = sock
        self.stream = sock.makefile('rb')
        self.observation = observation
        self.hello = self.read()
        assert self.hello['type'] == 'daemon_hello', self.hello
        self.next_id = 0

    def read(self):
        line = self.stream.readline()
        if not line:
            raise RuntimeError('Daemon closed its socket')
        frame = json.loads(line)
        self.observation.setdefault('frames', []).append(frame)
        return frame

    def request(self, command):
        self.next_id += 1
        request_id = 'facts-%s' % self.next_id
        envelope = {'type': 'command', 'id': request_id,
                    'protocol': self.hello['protocol'], 'command': command}
        if self.hello.get('clientId'):
            envelope['clientId'] = self.hello['clientId']
        self.observation.setdefault('commands', []).append(envelope)
        self.sock.sendall((json.dumps(envelope) + '\n').encode())
        while True:
            frame = self.read()
            if frame.get('type') == 'response' and frame.get('id') == request_id:
                assert frame.get('success') is True, frame
                return frame.get('data', {})

    def close(self):
        self.stream.close()
        self.sock.close()


def run_case(binary, label, root, observation):
    env = env_for(root, label)
    env['PRIME_AGENT_MODEL_PROVIDER'] = 'fixture'
    env['PRIME_AGENT_MODEL'] = 'facts-text'
    library = Path(os.environ['PI_PACKAGE_DIR']) / 'skills'
    skill_paths = sorted(str(path) for path in library.glob('*/src') if path.is_dir())
    assert skill_paths, 'Pinned TS fixture skill library missing'
    env['PYTHONPATH'] = os.pathsep.join(skill_paths)
    server = Server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'http://127.0.0.1:%s/primary/v1' % server.server_address[1], 'models': MODELS},
        'fixture-backup': {'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'http://127.0.0.1:%s/backup/v1' % server.server_address[1], 'models': [BACKUP]}}}))
    (root / 'agent/settings.json').write_text(json.dumps({
        'defaultProvider': 'fixture', 'defaultModel': 'facts-text',
        'prewarmPythonKernel': False, 'compaction': {'agentCallable': True},
        'providerBackupModel': 'fixture-backup/facts-text',
        'retry': {'enabled': True, 'maxRetries': 1, 'baseDelayMs': 1,
                  'failover': {'enabled': True, 'maxRetries': 0, 'baseDelayMs': 1, 'maxDelayMs': 1}},
        'onboardingCompleted': True, 'telemetry': {'noticeShown': True}}))
    path = root / 'daemon.sock'
    process = client = None
    try:
        with open(root / 'daemon.log', 'wb') as log:
            process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(path)],
                cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 75
            while time.monotonic() < deadline:
                assert process.poll() is None, 'Daemon exited before socket readiness'
                sock = socket.socket(socket.AF_UNIX)
                sock.settimeout(120)
                try:
                    sock.connect(str(path))
                    client = Client(sock, observation)
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    sock.close()
                    threading.Event().wait(0.025)
            assert client is not None, 'Daemon socket readiness deadline'
            created = client.request({'type': 'create', 'config': {
                'cwd': str(root), 'sessionDir': str(root / 'agent/sessions'),
                'provider': 'fixture', 'model': 'facts-text'}})
            session_id = created.get('activeSessionId') or created.get('id')
            assert session_id, created
            observation['probes'] = []
            for phase, model in enumerate(SEQUENCE):
                if phase in (1, 2):
                    client.request({'type': 'set_model', 'activeSessionId': session_id,
                                    'provider': 'fixture', 'modelId': model['id']})
                server.phase, server.phase_requests = phase, 0
                client.request({'type': 'prompt_and_wait', 'activeSessionId': session_id,
                                'message': 'Observe the model facts.'})
                rows = [row for row in server.requests if row['phase'] == phase]
                if phase == 3:
                    primary = [row for row in rows if row['path'].startswith('/primary/')]
                    assert primary, 'No actual retryable primary request'
                    assert all(row['body']['model'] == 'facts-text' for row in primary), primary
                    rows = [row for row in rows if row['path'].startswith('/backup/')]
                else:
                    assert all(row['path'].startswith('/primary/') for row in rows), rows
                requests = [row['body'] for row in rows]
                assert len(requests) == 2, requests
                assert all(body['model'] == model['id'] for body in requests), requests
                probe = latest_probe(requests[-1], 'call_facts_%s' % phase)
                observation['probes'].append(probe)
                if phase == 3:
                    # Observe before asserting cross-runtime parity: TS restores session
                    # facts at assistant message_end, before this backup tool executes.
                    # The Rust failover driver restores at turn settlement. Retain the
                    # actual facts; compare() must expose any difference.
                    assert probe['kernel_probe_count'] == phase + 1, probe
                    assert probe['compact_status']['scheduled'] is False, probe
                else:
                    verify_probe(probe, model, phase + 1)
            session_rows = [json.loads(line) for path in (root / 'agent/sessions').rglob('*.jsonl')
                            for line in path.read_text().splitlines()]
            changes = [{'provider': row['provider'], 'modelId': row['modelId']}
                       for row in session_rows if row.get('type') == 'model_change']
            observation['persisted_model_changes'] = changes
            backup_changes = [i for i, row in enumerate(changes) if row['provider'] == 'fixture-backup']
            assert len(backup_changes) == 1, changes
            assert changes[backup_changes[0] + 1:] == [
                {'provider': 'fixture', 'modelId': 'facts-text'}], 'Duplicate or missing persisted primary restore: %s' % changes
    finally:
        observation['provider_requests'] = server.requests
        if client is not None:
            client.close()
        if process is not None:
            stop(process)
        observation['daemon_log'] = (root / 'daemon.log').read_text() if (root / 'daemon.log').exists() else ''
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def compare(result):
    ts, rust = result['runs']['ts']['probes'], result['runs']['rust']['probes']
    assert len(ts) == len(rust) == len(SEQUENCE)
    result['complete_compact_status_equal'] = [
        a['compact_status'] == b['compact_status'] for a, b in zip(ts, rust)]
    for a, b in zip(ts, rust):
        assert a['model_info'] == b['model_info'], 'model.info differs'
        assert a['kernel_probe_count'] == b['kernel_probe_count'], 'kernel continuity differs'
        assert a['compact_status']['context_window'] == b['compact_status']['context_window'], 'context window differs'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'runs': {}, 'scope':
              'Actual daemon set_model, surviving kernel, model.info and compact.status context_window. '
              'Retryable primary failure -> backup-provider probe -> automatic primary restoration probe. '
              'Full compact.status values retained; token/percent estimator parity is not claimed.'}
    try:
        assert sys.platform == 'linux', 'Requires hosted Linux binaries and kernel'
        archive_hash = sha256(os.environ['PA_TS_ARCHIVE'])
        assert archive_hash == TS_ARCHIVE_SHA256, 'TS archive hash mismatch'
        result['ts_release_archive_sha256'] = archive_hash
        binaries = {label: Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                    for label in ('ts', 'rust')}
        result['binaries'] = {label: {'path': str(path), 'sha256': sha256(path)}
                              for label, path in binaries.items()}
        # Keep Unix socket paths short, independent of RUNNER_TEMP/TMPDIR lengths.
        with tempfile.TemporaryDirectory(prefix='facts-', dir='/tmp') as temp:
            for label, binary in binaries.items():
                observation = result['runs'][label] = {}
                try:
                    run_case(binary, label, Path(temp) / label, observation)
                except Exception as error:
                    observation['error'] = str(error)
        errors = {label: run['error'] for label, run in result['runs'].items() if 'error' in run}
        assert not errors, errors
        compare(result)
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(args.receipt), 'verified': result['verified'], 'error': result.get('error')}))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
