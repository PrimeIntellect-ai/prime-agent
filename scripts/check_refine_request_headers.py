#!/usr/bin/env python3
"""Capture actual refinement HTTP identity using synthetic team auth.

The official TS v0.9.8 Darwin arm64 binary was observed with the same
loopback provider, model, synthetic auth and direct daemon refine command.
It sends X-Prime-Team-ID: team-1 and Authorization: Bearer fixture-only.
This checks those changed headers, not unrelated SDK headers or wire bytes.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

from check_minimum_reasoning import Handler, Server
from check_saved_catalog import CatalogClient
from lifecycle_lib import OwnedProcesses, TAG, digest, env_for, finish


class IdentityHandler(Handler):
    def do_POST(self):
        self.server.received_headers.append(dict(self.headers))
        super().do_POST()


def observe(binary, root, receipt):
    env = env_for(root)
    env[TAG] = str(root)
    server = Server('refine')
    server.received_headers = []
    server.RequestHandlerClass = IdentityHandler
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
            receipt['result'] = client.call('refine', activeSessionId=active,
                                            instructions='Fixture no-op refinement')
            assert server.error is None, server.error
            assert len(server.received_headers) == len(server.requests) == 1, server.requests
            headers = {key.lower(): value for key, value in server.received_headers[0].items()}
            actual = {key: headers.get(key) for key in ('authorization', 'x-prime-team-id')}
            expected = {'authorization': 'Bearer fixture-only', 'x-prime-team-id': 'team-1'}
            receipt.update(rust_identity=actual, ts_observed_identity=expected,
                           identity_equal=actual == expected)
            assert actual == expected, actual
            assert server.requests[0]['auxiliary'], server.requests
            receipt['refine_verified'] = True
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
    receipt = {'verified': False, 'scope': __doc__,
        'ts_reference': 'v0.9.8 / 7d442aafa985f9342134fac16c2ef41f03fb45c1',
        'ts_binary_sha256': 'e50d4e4cf5735ea16cee30c3ca48fccb628ae2169fc867c33d461b8a90e87bc5',
        'not_verified': ['auto-review HTTP execution', 'TUI frames',
                         'full HTTP or daemon wire-byte equality', 'live Prime Inference']}
    try:
        binary = Path(os.environ['PA_RUST_BINARY']).resolve()
        receipt['binary_sha256'] = digest(binary)
        with tempfile.TemporaryDirectory(prefix='pa-refine-identity-', dir='/tmp') as folder:
            observe(binary, Path(folder), receipt)
        assert receipt.get('refine_verified') and receipt.get('cleanup_verified') \
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
