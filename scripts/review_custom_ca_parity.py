#!/usr/bin/env python3
"""Hosted-only real TS/Rust HTTPS custom-root and unknown-issuer comparison.

The provider and private CA are synthetic, loopback-only and fixture-owned.
This verifies provider transport, not native OS loading, catalog/OAuth clients,
WebSockets, live Keychain updates, or same-process root-cache refresh.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import sys
import tempfile
import threading

from review_goal_backoff_parity import TS_ARCHIVE_SHA256, sha256
from review_restore_notice_parity import texts

PROMPT = 'Complete the custom CA transport fixture.'
ANSWER = 'Custom CA transport completed.'


def certificate(root, name):
    key, cert = root / (name + '.key'), root / (name + '.pem')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-keyout', str(key), '-out', str(cert), '-days', '1',
                    '-subj', '/CN=Prime Agent fixture ' + name,
                    '-addext', 'basicConstraints=critical,CA:TRUE',
                    '-addext', 'keyUsage=critical,keyCertSign,cRLSign,digitalSignature',
                    '-addext', 'subjectAltName=IP:127.0.0.1'],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    key.chmod(0o600)
    return key, cert


def server_certificate(root, ca_key, ca_cert):
    key, csr, cert = root / 'server.key', root / 'server.csr', root / 'server.pem'
    extensions = root / 'server.extensions'
    extensions.write_text('basicConstraints=critical,CA:FALSE\n'
                          'keyUsage=critical,digitalSignature,keyEncipherment\n'
                          'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n')
    subprocess.run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes',
                    '-keyout', str(key), '-out', str(csr), '-subj', '/CN=Prime Agent TLS fixture'],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    subprocess.run(['openssl', 'x509', '-req', '-in', str(csr), '-CA', str(ca_cert),
                    '-CAkey', str(ca_key), '-CAcreateserial', '-out', str(cert),
                    '-days', '1', '-sha256', '-extfile', str(extensions)],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    key.chmod(0o600)
    return key, cert


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append({'path': self.path, 'authorization': self.headers.get('Authorization'),
                                     'body': body})
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        def chunk(delta, finish=None):
            return {'id': 'ca-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'ca-fixture', 'choices': [{'index': 0, 'delta': delta,
                                                       'finish_reason': finish}]}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', 'content': ANSWER}), chunk({}, 'stop')))
        wire += 'data: [DONE]\n\n'
        encoded = wire.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, key, cert):
        super().__init__(('127.0.0.1', 0), Handler)
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(cert, key)
        self.requests, self.handshake_failures = [], []
        self.handshake_attempts = 0

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        self.handshake_attempts += 1
        try:
            return self.context.wrap_socket(connection, server_side=True), address
        except ssl.SSLError as error:
            self.handshake_failures.append(str(error))
            connection.close()
            raise


def completed_messages(stdout):
    events = [json.loads(line) for line in stdout.splitlines() if line.startswith('{')]
    return [event['message'] for event in events if event.get('type') == 'message_end'
            and isinstance(event.get('message'), dict)
            and event['message'].get('role') == 'assistant']


def request_contract(request):
    body = request['body']
    users = ['\n'.join(texts(row.get('content'))) for row in body.get('messages', [])
             if row.get('role') == 'user']
    count = users.count(PROMPT)
    assert count == 1, 'expected current fixture prompt exactly once'
    # Harness digests and unrelated prompt layers are outside the TLS contract.
    # Every raw message remains in the receipt's captured provider request.
    return {'path': request['path'], 'authorization': request['authorization'],
            'model': body.get('model'), 'stream': body.get('stream'),
            'current_prompt': PROMPT, 'current_prompt_count': count}


def run_case(binary, label, root, trusted, key, cert, ca_cert, unrelated, observation):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp'):
        (root / name).mkdir(parents=True)
    agent, sessions, cwd = root / 'agent', root / 'sessions', root / 'work'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
           'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON') if key in os.environ}
    if label == 'ts':
        env['PI_PACKAGE_DIR'] = os.environ['PI_PACKAGE_DIR']
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1',
               PI_OFFLINE='1', PI_CODING_AGENT_DIR=str(agent), PRIME_AGENT_CODING_AGENT_DIR=str(agent),
               PI_SESSION_DIR=str(sessions), PRIME_AGENT_SESSION_DIR=str(sessions),
               XDG_CONFIG_HOME=str(root / 'config'), XDG_CACHE_HOME=str(root / 'cache'),
               XDG_DATA_HOME=str(root / 'data'), NO_PROXY='127.0.0.1,localhost',
               no_proxy='127.0.0.1,localhost', NODE_EXTRA_CA_CERTS=str(ca_cert if trusted else unrelated))
    server = Server(key, cert)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'https://127.0.0.1:%s/v1' % server.server_address[1],
        'models': [{'id': 'ca-fixture', 'name': 'CA fixture', 'reasoning': False,
                    'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    (agent / 'settings.json').write_text(json.dumps({'defaultProvider': 'fixture',
        'defaultModel': 'ca-fixture', 'prewarmPythonKernel': False}))
    command = [str(binary), '--mode', 'json', '--provider', 'fixture', '--model',
               'ca-fixture', '--session-dir', str(sessions), PROMPT]
    process = None
    try:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=75)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate(timeout=5)
            observation.update(stdout=stdout, stderr=stderr, timed_out=True)
            raise AssertionError('actual binary timed out')
        observation.update(exit_code=process.returncode, stdout=stdout, stderr=stderr,
                           requests=server.requests, handshake_attempts=server.handshake_attempts,
                           handshake_failures=server.handshake_failures)
        messages = completed_messages(stdout)
        assert len(messages) == 1, 'expected one completed assistant message'
        message = messages[0]
        if trusted:
            assert process.returncode == 0, 'trusted custom-root process failed'
            assert message.get('stopReason') == 'stop', message
            answer = '\n'.join(texts(message.get('content')))
            assert answer == ANSWER, message
            assert len(server.requests) == 1, 'expected one actual provider request'
            contract = request_contract(server.requests[0])
            assert contract == {'path': '/v1/chat/completions', 'authorization': 'Bearer fixture-only',
                                'model': 'ca-fixture', 'stream': True, 'current_prompt': PROMPT,
                                'current_prompt_count': 1}, contract
            return {'outcome': 'completed', 'answer': answer, 'request': contract}
        assert server.handshake_attempts > 0, 'binary never attempted TLS'
        assert not server.requests, 'untrusted CA allowed an HTTP request'
        assert message.get('stopReason') == 'error' and message.get('errorMessage'), message
        return {'outcome': 'certificate_refused', 'http_requests': 0,
                'assistant_stop_reason': message['stopReason']}
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=5)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'runs': {}, 'scope': __doc__,
              'prompt_scope': 'Compare current fixture prompt once, auth, model, stream and outcome. Harness digests/unrelated layers excluded; raw messages retained.',
              'cache_scope': 'Each case starts a fresh actual process. No assertion about in-process native-store refresh or TS native-root caching.'}
    try:
        assert sys.platform == 'linux', 'requires hosted Linux CI'
        archive_hash = sha256(os.environ['PA_TS_ARCHIVE'])
        assert archive_hash == TS_ARCHIVE_SHA256, 'pinned TS archive mismatch'
        binaries = {label: Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                    for label in ('ts', 'rust')}
        result.update(ts_release_archive_sha256=archive_hash,
                      binaries={label: {'path': str(path), 'sha256': sha256(path)}
                                for label, path in binaries.items()})
        with tempfile.TemporaryDirectory(prefix='custom-ca-parity-') as temporary:
            root = Path(temporary)
            ca_key, ca_cert = certificate(root, 'trusted')
            key, cert = server_certificate(root, ca_key, ca_cert)
            _, unrelated = certificate(root, 'unrelated')
            for scenario, trusted in [('trusted_custom_ca', True), ('untrusted_custom_ca', False)]:
                runs = result['runs'][scenario] = {}
                for label, binary in binaries.items():
                    observation = runs[label] = {}
                    try:
                        observation['contract'] = run_case(binary, label, root / scenario / label,
                                                           trusted, key, cert, ca_cert, unrelated, observation)
                    except Exception as error:
                        observation['error'] = str(error)
                errors = {label: run['error'] for label, run in runs.items() if 'error' in run}
                assert not errors, errors
                assert runs['ts']['contract'] == runs['rust']['contract'], scenario + ' contract mismatch'
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(args.receipt), 'verified': result['verified'],
                      'error': result.get('error')}))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
