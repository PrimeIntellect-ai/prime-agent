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
import time

from review_goal_backoff_parity import TS_ARCHIVE_SHA256, sha256
from review_restore_notice_parity import texts
from review_agent_bounce_parity import Client
from review_draft_disconnect_parity import stop

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


def terminal_assistant(messages):
    assistants = [row for row in messages if row.get('role') == 'assistant']
    assert len(assistants) == 1, 'expected one terminal assistant message'
    return assistants[0]


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
    (agent / 'prompts').mkdir()
    (agent / 'prompts/transport-warm.md').write_text('Complete the transport fixture.')
    (agent / 'settings.json').write_text(json.dumps({'defaultProvider': 'fixture',
        'defaultModel': 'ca-fixture', 'prewarmPythonKernel': False,
        'retry': {'enabled': False}}))
    process, client = None, None
    log_path = root / 'daemon.log'
    log = log_path.open('wb')
    try:
        socket_path = root / 'd.sock'
        process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(socket_path)],
                                   cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        client = Client(socket_path, process)
        created = client.call('create', name='custom-ca-fixture', config={
            'cwd': str(cwd), 'agentDir': str(agent), 'sessionDir': str(sessions),
            'provider': 'fixture', 'model': 'ca-fixture', 'noExtensions': True,
            'noSkills': True, 'noTools': True, 'noContextFiles': True, 'telemetryDisabled': True})
        active = created.get('activeSessionId') or created.get('id')
        assert active, created
        client.call('attach', activeSessionId=active)
        # The ordinary UI requests its slash-command catalog before a turn.
        # This public read builds Rust's lazy core before user admission; a
        # real fixture template proves the build succeeded rather than
        # accepting its empty-on-build-error fallback. Cold admission is
        # separately blocked by the known #3560 bug, not normalized here.
        catalog = client.call('get_commands', activeSessionId=active)
        observation['startup_command_catalog'] = catalog
        assert any(row.get('name') == 'transport-warm' for row in catalog['commands']), catalog
        assert not server.requests, 'startup catalog unexpectedly invoked the provider'
        try:
            client.call('prompt_and_wait', activeSessionId=active, message=PROMPT)
        except AssertionError:
            # Certificate failure can surface as an unsuccessful wait response.
            # It is only valid after the actual terminal assistant error below;
            # any other command/transport failure remains red.
            response = client.wire[-1]
            assert not trusted and response.get('type') == 'response' and response.get('success') is False, response
            observation['prompt_wait_failure'] = response
        result = client.call('get_messages', activeSessionId=active)
        observation.update(messages=result, requests=server.requests,
                           handshake_attempts=server.handshake_attempts,
                           handshake_failures=server.handshake_failures)
        message = terminal_assistant(result['messages'])
        if trusted:
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
        observation['owned_before_shutdown'] = owned_processes(root)
        if process and process.poll() is None and client:
            try:
                client.call('shutdown', force=True)
                observation['wire'] = client.wire
                client.close()
                process.wait(timeout=15)
                observation['shutdown'] = 'owned supervisor and workers stopped'
            except Exception as error:
                observation['shutdown_error'] = str(error)
        if process:
            stop(process)
            observation['daemon_exit_code'] = process.returncode
        if client:
            observation['wire'] = client.wire
            client.close()
        log.close()
        observation['daemon_log'] = log_path.read_text(errors='replace')[-10000:]
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        confirm_cleanup(root, observation)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'runs': {}, 'scope': __doc__,
              'retry_scope': 'Set documented retry.enabled=false identically in both real runtimes; compare certificate outcome, not retry policy.',
              'dependency_scope': 'Warm ordinary startup get_commands before admission in both binaries. Cold lazy-first-prompt duplicate remains an unresolved dependency on #3560; no prompt deduplication or production repair in this TLS PR.',
              'execution_scope': 'Explicit owned daemon, ordinary create/attach/get_commands/prompt_and_wait/get_messages, graceful shutdown acknowledgement then close socket before waiting.',
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
