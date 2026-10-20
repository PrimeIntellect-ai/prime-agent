#!/usr/bin/env python3
"""Compare real TS/Rust kernel mcp.config before and after a live settings reload.

Both owned daemon binaries execute identical cells through an offline provider.
The shared public reload command refreshes settings between probes. Rust must
keep its kernel (and already registered host handler) alive; TS's reload rebuild
is recorded explicitly. Exact config objects are compared without filtering.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

from review_goal_backoff_parity import TS_ARCHIVE_SHA256, sha256
from review_restore_notice_parity import texts

MARKER = 'LIVE_MCP_PARITY_RESULT='
CELL = """import os, json
from rlm import host_request
live_mcp_result = {'pid': os.getpid(), 'configs': {}}
for live_mcp_name in ['fixture-before', 'fixture-after']:
    live_mcp_result['configs'][live_mcp_name] = await host_request('mcp.config', {'server': live_mcp_name})
print('LIVE_MCP_PARITY_RESULT=' + json.dumps(live_mcp_result))"""
BEFORE = {'type': 'stdio', 'command': 'python3', 'args': ['-c', 'print("before")']}
AFTER = {'type': 'stdio', 'command': 'python3', 'args': ['-c', 'print("after")']}


def latest_probe(requests):
    # Later turns carry earlier tool results in history. The final request
    # must contain this phase's newly executed cell, not the old marker.
    assert requests, 'missing provider requests'
    for message in reversed(requests[-1].get('messages', [])):
        if message.get('role') != 'tool':
            continue
        for text in reversed(list(texts(message.get('content')))):
            for line in reversed(text.splitlines()):
                if line.startswith(MARKER):
                    return json.loads(line[len(MARKER):])
    raise AssertionError('missing actual tool result ' + MARKER)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.phase = 'before'
        self.requests = {'before': [], 'after': []}
        self.tools = {}
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
            offered = {tool.get('function', {}).get('name') for tool in body.get('tools', [])}
            name = next((name for name in ('python_repl', 'ipython') if name in offered), None)
            if name is None:
                self.server.errors.append('No supported REPL tool offered')
                self.send_error(422)
                return
            self.server.tools[self.server.phase] = name
            delta = {'tool_calls': [{'index': 0, 'id': 'call_live_mcp_' + self.server.phase,
                     'type': 'function', 'function': {'name': name,
                     'arguments': json.dumps({'code': CELL})}}]}
            finish = 'tool_calls'
        elif len(requests) == 2:
            delta, finish = {'content': 'Live MCP probe complete.'}, 'stop'
        else:
            self.server.errors.append('Unexpected extra provider request')
            self.send_error(422)
            return
        def chunk(value, reason=None):
            return {'id': 'live-mcp-parity', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'mcp-fixture', 'choices': [{'index': 0, 'delta': value,
                                                       'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(item) + '\n\n' for item in (
            chunk({'role': 'assistant', **delta}), chunk({}, finish))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


class Client:
    """Bounded JSONL client using each real daemon's advertised protocol."""
    def __init__(self, path, process):
        self.frames = []
        self.buffer = b''
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('daemon exited before socket readiness')
            connection = socket.socket(socket.AF_UNIX)
            try:
                connection.connect(str(path))
                self.socket = connection
                break
            except (FileNotFoundError, ConnectionRefusedError):
                connection.close()
                threading.Event().wait(0.025)
        else:
            raise TimeoutError('daemon socket readiness')
        self.hello = self.read(deadline)
        assert self.hello.get('type') == 'daemon_hello', self.hello
        self.protocol = self.hello['protocol']
        self.sequence = 0

    def read(self, deadline):
        while b'\n' not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('daemon response deadline')
            self.socket.settimeout(remaining)
            data = self.socket.recv(65536)
            if not data:
                raise RuntimeError('daemon closed socket')
            self.buffer += data
        line, self.buffer = self.buffer.split(b'\n', 1)
        frame = json.loads(line)
        self.frames.append(frame)
        return frame

    def request(self, command):
        self.sequence += 1
        request_id = 'live-mcp-' + str(self.sequence)
        envelope = {'type': 'command', 'id': request_id,
                    'protocol': self.protocol, 'command': command}
        self.socket.sendall((json.dumps(envelope) + '\n').encode())
        deadline = time.monotonic() + 90
        while True:
            frame = self.read(deadline)
            if frame.get('type') == 'response' and frame.get('id') == request_id:
                assert frame.get('success') is True, frame
                return frame.get('data') or {}


def stop(process):
    # Signal only the owned process group; the fixture never touches live services.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def validate_observation(observation, label):
    assert observation['before']['configs'] == {'fixture-before': BEFORE, 'fixture-after': {}}, observation['before']
    assert observation['after']['configs'] == {'fixture-before': {}, 'fixture-after': AFTER}, observation['after']
    observation['kernel_pid_equal'] = observation['before']['pid'] == observation['after']['pid']
    if label == 'rust':
        assert observation['kernel_pid_equal'], 'Rust replaced the kernel; stale-handler regression was not exercised'


def run_case(binary, label, root, observation):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp'):
        (root / name).mkdir(parents=True)
    agent, cwd = root / 'agent', root / 'work'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
           'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON') if key in os.environ}
    if label == 'ts':
        env['PI_PACKAGE_DIR'] = os.environ['PI_PACKAGE_DIR']
    library = Path(os.environ['PI_PACKAGE_DIR']) / 'skills'
    env['PYTHONPATH'] = os.pathsep.join(sorted(str(p) for p in library.glob('*/src') if p.is_dir()))
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1', PRIME_AGENT_TELEMETRY_ORIGIN='test',
               PI_OFFLINE='1', PI_CODING_AGENT_DIR=str(agent),
               PRIME_AGENT_CODING_AGENT_DIR=str(agent), PI_SESSION_DIR=str(root / 'sessions'),
               PRIME_AGENT_SESSION_DIR=str(root / 'sessions'), XDG_CONFIG_HOME=str(root / 'config'),
               XDG_CACHE_HOME=str(root / 'cache'), XDG_DATA_HOME=str(root / 'data'))
    settings = {'defaultProvider': 'fixture', 'defaultModel': 'mcp-fixture',
                'prewarmPythonKernel': False, 'mcpServers': {'fixture-before': BEFORE}}
    settings_path = agent / 'settings.json'
    settings_path.write_text(json.dumps(settings))
    server = Server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'http://127.0.0.1:%s/v1' % server.server_address[1],
        'models': [{'id': 'mcp-fixture', 'name': 'MCP fixture', 'reasoning': False,
                    'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    path = root / 'daemon.sock'
    client = None
    active = None
    with (root / 'daemon.log').open('w') as log:
        process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(path)],
                                   cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            client = Client(path, process)
            created = client.request({'type': 'create', 'config': {'cwd': str(cwd),
                'sessionDir': str(root / 'sessions'), 'provider': 'fixture', 'model': 'mcp-fixture'}})
            active = created.get('activeSessionId') or created.get('sessionId') or created.get('id')
            assert active, created
            client.request({'type': 'attach', 'activeSessionId': active})
            for phase in ('before', 'after'):
                server.phase = phase
                if phase == 'after':
                    settings['mcpServers'] = {'fixture-after': AFTER}
                    settings_path.write_text(json.dumps(settings))
                    # Identical public command to both runtimes. Rust does not
                    # rebuild the core: the same registered handler must read live.
                    client.request({'type': 'reload', 'activeSessionId': active})
                client.request({'type': 'prompt', 'activeSessionId': active,
                                'message': 'Probe live MCP configuration: ' + phase})
                client.request({'type': 'wait_for_idle', 'activeSessionId': active})
                observation[phase] = latest_probe(server.requests[phase])
            assert not server.errors, server.errors
            assert {k: len(v) for k, v in server.requests.items()} == {'before': 2, 'after': 2}
            validate_observation(observation, label)
        finally:
            if client is not None:
                if active is not None:
                    try:
                        client.request({'type': 'kill', 'activeSessionId': active})
                    except Exception as error:
                        observation['cleanup_error'] = str(error)
                observation['daemon_frames'] = client.frames
                client.socket.close()
            stop(process)
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            observation['provider_requests'] = server.requests
            observation['offered_repl_tools'] = server.tools
            observation['daemon_log'] = (root / 'daemon.log').read_text()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'runs': {}, 'comparison': 'Exact mcp.config objects before/after public reload',
              'kernel_lifecycle_scope': 'TS reload may rebuild; Rust must keep the existing kernel/host handler.',
              'tool_name_selection': 'Offered python_repl or legacy ipython; identical cell code.'}
    try:
        assert sys.platform == 'linux', 'requires hosted Linux CI'
        archive_hash = sha256(os.environ['PA_TS_ARCHIVE'])
        result['ts_release_archive_sha256'] = archive_hash
        assert archive_hash == TS_ARCHIVE_SHA256, 'TS release archive hash mismatch'
        binaries = {label: Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                    for label in ('ts', 'rust')}
        result['binaries'] = {label: {'path': str(path), 'sha256': sha256(path)}
                              for label, path in binaries.items()}
        with tempfile.TemporaryDirectory(prefix='live-mcp-parity-') as temp:
            for label, binary in binaries.items():
                observation = {}
                result['runs'][label] = observation
                try:
                    run_case(binary, label, Path(temp) / label, observation)
                except Exception as error:
                    observation['error'] = str(error)
        errors = {label: value['error'] for label, value in result['runs'].items() if 'error' in value}
        assert not errors, errors
        cleanup_errors = {label: value['cleanup_error'] for label, value in result['runs'].items()
                          if 'cleanup_error' in value}
        assert not cleanup_errors, cleanup_errors
        for phase in ('before', 'after'):
            assert result['runs']['ts'][phase]['configs'] == result['runs']['rust'][phase]['configs']
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(args.receipt), 'verified': result['verified'], 'error': result.get('error')}))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
