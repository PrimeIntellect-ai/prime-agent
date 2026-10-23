#!/usr/bin/env python3
"""Real-daemon #3558 check: clear_queue empties the receiver and bounces agent messages to their sender.

Journal recovery is covered by the separate Rust
clear_queue_bounces_recovered_agent_messages_to_their_senders regression.
All processes, sockets, provider requests and session state belong to this fixture.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time

from lifecycle_lib import digest, env_for, stop

LIMIT = 35
MESSAGE = 'AGENT_BOUNCE_PARITY_MESSAGE'
USER = 'AGENT_BOUNCE_PARITY_USER'
OPENING = 'Your agent message was cleared from '
ENDING = "'s queue before delivery: "


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.arrived = threading.Condition()
        self.requests = []
        self.release = threading.Event()

    def wait_for(self, marker):
        with self.arrived:
            assert self.arrived.wait_for(lambda: any(marker in json.dumps(body)
                for body in self.requests), timeout=LIMIT), 'busy turn never reached provider: ' + marker


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with self.server.arrived:
            self.server.requests.append(body)
            self.server.arrived.notify_all()
        self.server.release.wait(LIMIT * 3)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass


class Client:
    def __init__(self, path, process):
        deadline = time.monotonic() + LIMIT
        while True:
            self.sock = socket.socket(socket.AF_UNIX)
            try:
                self.sock.connect(str(path))
                break
            except (FileNotFoundError, ConnectionRefusedError):
                self.sock.close()
                assert process.poll() is None, 'daemon exited before socket readiness'
                assert time.monotonic() < deadline, 'daemon socket never became ready'
                threading.Event().wait(0.025)
        self.sock.settimeout(LIMIT)
        self.reader = self.sock.makefile('rb')
        self.hello = json.loads(self.reader.readline())
        assert self.hello['type'] == 'daemon_hello', self.hello
        self.counter = 0
        self.wire = []

    def call(self, kind, **payload):
        self.counter += 1
        ident = str(self.counter)
        envelope = {'type': 'command', 'id': ident,
            'protocol': {'name': 'prime-agent.daemon', 'version': 7},
            'command': {'type': kind, **payload}}
        self.sock.sendall((json.dumps(envelope) + '\n').encode())
        deadline = time.monotonic() + LIMIT
        while time.monotonic() < deadline:
            line = self.reader.readline()
            assert line, 'daemon closed connection'
            response = json.loads(line)
            self.wire.append(response)
            if response.get('type') == 'response' and response.get('id') == ident:
                assert response.get('success'), response
                return response.get('data')
        raise TimeoutError('command never answered: ' + kind)

    def close(self):
        self.reader.close()
        self.sock.close()


def run_case(binary, root, long_name, observed):
    env = env_for(root)
    provider = Provider()
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    clients = []
    process = None
    try:
        models = {'providers': {'parity-local': {'api': 'openai-completions',
            'apiKey': 'fixture-only', 'baseUrl': 'http://127.0.0.1:%s/v1' % provider.server_port,
            'models': [{'id': 'parity-1', 'name': 'Parity 1', 'reasoning': False,
                        'contextWindow': 128000, 'maxTokens': 4096}]}}}
        (root / 'agent/models.json').write_text(json.dumps(models))
        (root / 'agent/settings.json').write_text(json.dumps({'prewarmPythonKernel': False,
            'defaultProvider': 'parity-local', 'defaultModel': 'parity-1',
            'onboardingCompleted': True, 'telemetry': {'noticeShown': True}}))
        path = root / 'd.sock'
        log = open(root / 'daemon.log', 'wb')
        try:
            process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(path)],
                cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            receiver_name = '界' * 16385 if long_name else 'bounce-target'
            sessions = []
            for name in ('bounce-source', receiver_name):
                client = Client(path, process)
                clients.append(client)
                config = {'cwd': str(root), 'agentDir': str(root / 'agent'),
                          'provider': 'parity-local', 'model': 'parity-1',
                          'noExtensions': True, 'noSkills': True, 'noTools': True,
                          'noContextFiles': True, 'telemetryDisabled': True}
                created = client.call('create', name=name, config=config)
                active = created.get('activeSessionId') or created.get('id')
                assert active, created
                client.call('attach', activeSessionId=active)
                sessions.append(active)
            source, receiver = sessions
            for client, active, marker in zip(clients, sessions, ('HOLD_SOURCE', 'HOLD_RECEIVER')):
                client.call('prompt', activeSessionId=active, message=marker)
                provider.wait_for(marker)
            receipt = clients[0].call('send_message', targetActiveSessionId=receiver,
                                     fromActiveSessionId=source, message=MESSAGE)
            observed['delivery_receipt'] = receipt
            clients[1].call('follow_up', activeSessionId=receiver, message=USER)
            cleared = clients[1].call('clear_queue', activeSessionId=receiver)
            observed['cleared'] = cleared
            assert cleared == {'steering': ['[agent-message from bounce-source]\n\n' + MESSAGE],
                               'followUp': [USER]}, cleared
            empty = clients[1].call('get_queue', activeSessionId=receiver)
            observed['receiver_after_clear'] = empty
            assert empty == {'steering': [], 'followUp': []}, empty
            queue = clients[0].call('get_queue', activeSessionId=source)
            deadline = time.monotonic() + LIMIT
            while not queue['steering'] and not queue['followUp']:
                assert time.monotonic() < deadline, 'sender bounce never arrived'
                threading.Event().wait(0.025)
                queue = clients[0].call('get_queue', activeSessionId=source)
            dropped = clients[0].call('clear_queue', activeSessionId=source)
            texts = dropped['steering'] + dropped['followUp']
            assert len(texts) == 1, dropped
            prefix, body = texts[0].split('\n\n', 1)
            assert prefix.startswith('[agent-message from '), prefix
            budget = 16384 - len(OPENING) - len(ENDING)
            expected = OPENING + receiver_name[:budget] + ENDING
            expected += MESSAGE[:16384 - len(expected)]
            assert body == expected, repr(body[:200])
            assert len(body) <= 16384, len(body)
            observed['bounce'] = {'message': texts[0], 'body_characters': len(body)}
            observed['sender_queue_observed'] = queue
            observed['hello'] = clients[0].hello
            observed['provider_request_count'] = len(provider.requests)
            observed['wire'] = [client.wire for client in clients]
        finally:
            # The supervisor owns detached workers. Ask it to shut those down
            # before ending its process group or removing their state tree.
            provider.release.set()
            if process and process.poll() is None and clients:
                try:
                    clients[0].call('shutdown', force=True)
                    process.wait(timeout=15)
                    observed['shutdown'] = 'owned supervisor and workers stopped'
                except Exception as error:
                    observed['shutdown_error'] = str(error)
            if process:
                stop(process)
            log.close()
            observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-6000:]
    finally:
        observed['wire'] = [client.wire for client in clients]
        for client in clients:
            client.close()
        provider.release.set()
        provider.shutdown()
        provider.server_close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'scenario': 'agent_bounce', 'status': 'failed',
        'scope': 'actual clear_queue response, emptied receiver queue and sender bounce',
        'recovery_scope': 'separate Rust journal reopen/clear regression',
        'cases': {}}
    try:
        with tempfile.TemporaryDirectory(prefix='pa-bounce-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            receipt['binary_sha256'] = digest(binary)
            for long_name in (False, True):
                key = 'long_receiver' if long_name else 'ordinary'
                observed = receipt['cases'][key] = {}
                run_case(binary, Path(folder) / key, long_name, observed)
        receipt['status'] = 'passed'
    except Exception as error:
        receipt['error'] = str(error)
        raise
    finally:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
