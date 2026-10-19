#!/usr/bin/env python3
"""Actual TS/Rust settings -> live mcp.config roundtrip for clientId/callbackPort.

This exercises real daemon/kernel config delivery before and after reload.
It never performs network OAuth, opens a browser or uses real credentials.
Hosted production OAuth tests separately check registration/authorize/token
redirects and zero/busy-port rejection; this receipt does not replace them.
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
from review_draft_disconnect_parity import env_for, digest, TS_ARCHIVE_SHA256
from review_goal_fixture_lifecycle import OwnedProcesses, TAG, finish
from review_restore_notice_parity import texts

MARKER = 'MCP_OAUTH_CONFIG_RESULT='
NAMES = ('fixture-oauth', 'fixture-default')
DEFAULT = {'type': 'http', 'url': 'https://fixture.invalid/default', 'oauth': True}
BEFORE = {'type': 'http', 'url': 'https://fixture.invalid/mcp', 'oauth': True,
          'clientId': 'fixture-client-before', 'callbackPort': 3118}
AFTER = {**BEFORE, 'clientId': 'fixture-client-after', 'callbackPort': 4118}
CELL = """from rlm import host_request
oauth_configs = {}
for name in ('fixture-oauth', 'fixture-default'):
    oauth_configs[name] = await host_request('mcp.config', {'server': name})
print('MCP_OAUTH_CONFIG_RESULT=' + __import__('json').dumps(oauth_configs))"""


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.phase = 'before'
        self.requests = {'before': [], 'after': []}
        self.errors = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests = self.server.requests[self.server.phase]
        requests.append(body)
        if len(requests) == 1:
            offered = {tool['function']['name'] for tool in body.get('tools', [])}
            name = next((n for n in ('python_repl', 'ipython') if n in offered), None)
            if name is None:
                self.server.errors.append('no Python REPL tool')
                self.send_error(422)
                return
            delta = {'tool_calls': [{'index': 0, 'id': 'oauth_config_' + self.server.phase,
                'type': 'function', 'function': {'name': name, 'arguments': json.dumps({'code': CELL})}}]}
            reason = 'tool_calls'
        else:
            delta, reason = {'content': 'Config fixture complete.'}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'oauth-config-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                'model': 'oauth-config-fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', **delta}), chunk({}, reason))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def extract(requests, phase):
    assert len(requests) == 2, 'unexpected provider sequence'
    rows = [row for row in requests[-1]['messages'] if row.get('role') == 'tool'
            and row.get('tool_call_id') == 'oauth_config_' + phase]
    assert len(rows) == 1, 'missing/duplicate current config result'
    probes = [json.loads(line[len(MARKER):]) for text in texts(rows[0].get('content'))
              for line in text.splitlines() if line.startswith(MARKER)]
    assert len(probes) == 1, 'missing/duplicate actual config probe'
    return probes[0]


def validate(observed):
    assert observed['before'] == {'fixture-oauth': BEFORE, 'fixture-default': DEFAULT}, observed
    assert observed['after'] == {'fixture-oauth': AFTER, 'fixture-default': DEFAULT}, observed


def observe(binary, kind, root, observed):
    env = env_for(root, kind)
    env[TAG] = str(root)
    provider = Provider()
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    settings = {'prewarmPythonKernel': False, 'mcpServers': {
        'fixture-oauth': BEFORE, 'fixture-default': DEFAULT}}
    settings_path = root / 'agent/settings.json'
    settings_path.write_text(json.dumps(settings))
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1', 'models': [{
            'id': 'oauth-config-fixture', 'name': 'OAuth config fixture', 'reasoning': False,
            'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    path = root / 'd.sock'
    scope = OwnedProcesses(binary, root, path)
    daemon = client = None
    log = (root / 'daemon.log').open('w')
    try:
        command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(path)]
        daemon = subprocess.Popen(command, cwd=root, env=env, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True)
        scope.register(daemon, command)
        client = Client(path, daemon)
        observed['hello'] = client.hello
        created = client.call('create', config={'cwd': str(root), 'agentDir': str(root / 'agent'),
            'provider': 'fixture', 'model': 'oauth-config-fixture', 'telemetryDisabled': True})
        active = created.get('activeSessionId') or created.get('sessionId') or created.get('id')
        assert active, created
        client.call('attach', activeSessionId=active)
        for phase in ('before', 'after'):
            provider.phase = phase
            if phase == 'after':
                settings['mcpServers']['fixture-oauth'] = AFTER
                settings_path.write_text(json.dumps(settings))
                client.call('reload', activeSessionId=active)
            client.call('prompt', activeSessionId=active, message='Probe OAuth config ' + phase)
            client.call('wait_for_idle', activeSessionId=active)
            observed[phase] = extract(provider.requests[phase], phase)
        assert not provider.errors, provider.errors
        validate(observed)
        observed['behavior_verified'] = True
    finally:
        observed['provider_requests'] = provider.requests
        observed['wire'] = list(client.wire) if client else []
        finish(scope, client, daemon, observed)
        log.close()
        observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-10000:]
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'runs': {}, 'scope': __doc__, 'not_verified': [
        'actual authorization browser callback or token exchange', 'credentialed Slack login',
        'live refresh-token compatibility', 'TUI rendering']}
    try:
        assert sys.platform == 'linux'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256
        result['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-oauth-config-', dir='/tmp') as folder:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ[f'PA_{kind.upper()}_BINARY']).resolve()
                observed = result['runs'][kind] = {'binary_sha256': digest(binary)}
                try:
                    observe(binary, kind, Path(folder) / kind, observed)
                except Exception as error:
                    observed['error'] = str(error)
            assert all(r.get('behavior_verified') and r.get('cleanup_verified') and 'error' not in r
                       for r in result['runs'].values()), 'actual OAuth config observation failed'
            for phase in ('before', 'after'):
                assert result['runs']['ts'][phase] == result['runs']['rust'][phase]
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
