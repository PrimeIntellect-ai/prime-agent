#!/usr/bin/env python3
"""Check /new PTY behavior and /goal image rows in the actual binary.

Owned daemons, homes, kernel state and loopback providers only. Receipts retain
full model requests and terminal output; no product state or credentials are used.
Requires the kernel provisioned by lifecycle CI.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time

from lifecycle_lib import Terminal, digest, env_for, skill_pythonpath, stop, LIMIT

PROMPT = 'NEW_GOAL_PARITY_INITIAL_PROMPT'
SETTLED = 'Parity fixture settled'
NAME = 'Parity named session'
OBJECTIVE = 'Describe the attached parity image'
IMAGE = {'type': 'image', 'mimeType': 'image/png', 'data':
         'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII='}


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, goal):
        super().__init__(('127.0.0.1', 0), Handler)
        self.goal = goal
        self.requests = []
        self.errors = []
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            assert self.path == '/v1/chat/completions', self.path
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            self.server.requests.append(body)
            assert len(self.server.requests) <= 6, 'unexpected continuation loop'
            if self.server.goal and len(self.server.requests) == 1:
                offered = {t.get('function', {}).get('name') for t in body.get('tools', [])}
                name = next((n for n in ('python_repl', 'ipython') if n in offered), None)
                assert name, 'No supported REPL offered'
                delta = {'tool_calls': [{'index': 0, 'id': 'complete_goal', 'type': 'function',
                         'function': {'name': name, 'arguments': json.dumps({'code':
                                      'import goal\nawait goal.complete()'})}}]}
                finish = 'tool_calls'
            else:
                delta, finish = {'content': SETTLED}, 'stop'
            def chunk(value, reason=None):
                return {'id': 'new-goal-parity', 'object': 'chat.completion.chunk', 'created': 1,
                        'model': 'parity-1', 'choices': [{'index': 0, 'delta': value,
                                                       'finish_reason': reason}]}
            wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
                chunk({'role': 'assistant', **delta}), chunk({}, finish))) + 'data: [DONE]\n\n'
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(wire.encode())))
            self.end_headers()
            self.wfile.write(wire.encode())
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.server.errors.append(str(exc))
            self.send_error(500, str(exc))


def setup(root, provider):
    root.mkdir(parents=True)
    env = env_for(root)
    env['PA_COMPACTION_TRACE'] = 'stderr'
    env['PYTHONPATH'] = skill_pythonpath()
    env['PI_SESSION_DIR'] = env['PRIME_AGENT_SESSION_DIR'] = str(root / 'agent/sessions')
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'parity-local': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'http://127.0.0.1:%s/v1' % provider.server_address[1],
        'models': [{'id': 'parity-1', 'name': 'Parity 1', 'input': ['text', 'image'],
                    'reasoning': False, 'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    (root / 'agent/settings.json').write_text(json.dumps({'defaultProvider': 'parity-local',
        'defaultModel': 'parity-1', 'prewarmPythonKernel': False,
        'onboardingCompleted': True, 'onboardingShown': True,
        'telemetry': {'noticeShown': True}}))
    return env


def wait_for(predicate, label, process=None):
    deadline = time.monotonic() + LIMIT
    while time.monotonic() < deadline:
        if predicate():
            return
        if process is not None and process.poll() is not None:
            raise RuntimeError('binary exited while waiting for ' + label)
        threading.Event().wait(0.025)
    raise TimeoutError(label)


def session_rows(root):
    result = []
    for path in sorted((root / 'agent/sessions').rglob('*.jsonl')):
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        if rows and rows[0].get('type') == 'session':
            result.append({'path': str(path), 'rows': rows})
    return result


def new_case(binary, root, observation):
    provider = Provider(False)
    terminal = daemon = None
    path = root / 'daemon.sock'
    try:
        env = setup(root, provider)
        with (root / 'daemon.log').open('wb') as log:
            daemon = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(path)],
                cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        def ready():
            try:
                with socket.socket(socket.AF_UNIX) as sock:
                    sock.settimeout(1)
                    sock.connect(str(path))
                    with sock.makefile('rb') as stream:
                        hello = json.loads(stream.readline())
                    assert hello.get('type') == 'daemon_hello', hello
                    observation['daemon_hello'] = hello
                    return True
            except (FileNotFoundError, ConnectionRefusedError, socket.timeout):
                return False
        wait_for(ready, 'owned daemon readiness', daemon)
        terminal = Terminal([str(binary), '--daemon-socket', str(path), '--provider', 'parity-local',
                             '--model', 'parity-1'], root, env)
        terminal.wait('initial session attached', lambda: len(session_rows(root)) == 1
                      and bool(terminal.screen.text().strip()), provider)
        command = '/new --name "' + NAME + '" -- ' + PROMPT
        terminal.send(command)
        terminal.wait('command visibly typed', lambda: PROMPT in terminal.screen.text(), provider)
        observation['typed_screen'] = terminal.screen.text()
        terminal.send('\r')
        terminal.wait('new prompt visibly settled', lambda: SETTLED in terminal.screen.text(), provider)
        rows = session_rows(root)
        observation.update(screen=terminal.screen.text(), raw_terminal=terminal.raw.decode(errors='replace'),
                           sessions=rows, requests=provider.requests)
        named = [r for r in rows if any(e.get('type') == 'session_info' and e.get('name') == NAME
                                       for e in r['rows'])]
        assert len(rows) == 2 and len(named) == 1, 'new session/name did not persist'
        assert len(provider.requests) == 1, 'initial prompt did not execute exactly once'
        messages = provider.requests[0]['messages']
        content = [m['content'] for m in messages if m.get('role') == 'user'
                   and PROMPT in json.dumps(m.get('content'))]
        assert any(PROMPT in json.dumps(c) for c in content), 'initial prompt missing from provider'
        assert NAME in observation['screen'], 'named session not rendered'
        return {'session_count': len(rows), 'name': NAME, 'user_content': content,
                'settled_text': SETTLED, 'request_count': len(provider.requests)}
    finally:
        if terminal:
            observation.setdefault('screen', terminal.screen.text())
            observation.setdefault('raw_terminal', terminal.raw.decode(errors='replace'))
            terminal.close()
        if daemon:
            stop(daemon)
            observation['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')
        observation['worker_stderr_logs'] = {str(path.relative_to(root)): path.read_text(errors='replace')
            for path in (root / 'agent').rglob('worker-*.stderr.log')}
        observation.setdefault('requests', provider.requests)
        observation['provider_errors'] = provider.errors
        provider.close()


class Rpc:
    def __init__(self, binary, root, env):
        self.process = subprocess.Popen([str(binary), '--mode', 'rpc', '--provider', 'parity-local',
            '--model', 'parity-1'], cwd=root, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.lines = queue.Queue()
        self.frames, self.errors = [], []
        def read():
            for line in self.process.stdout:
                self.lines.put(line)
        def read_errors():
            for line in self.process.stderr:
                self.errors.append(line)
        self.readers = [threading.Thread(target=fn, daemon=True) for fn in (read, read_errors)]
        for thread in self.readers:
            thread.start()

    def send(self, frame):
        self.process.stdin.write(json.dumps(frame) + '\n')
        self.process.stdin.flush()

    def until(self, predicate):
        deadline = time.monotonic() + LIMIT
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=0.1)
            except queue.Empty:
                if self.process.poll() is not None:
                    raise RuntimeError('RPC exited: ' + ''.join(self.errors)[-2000:])
                continue
            frame = json.loads(line)
            self.frames.append(frame)
            if predicate(frame):
                return frame
        raise TimeoutError('RPC event/response readiness')

    def close(self):
        stop(self.process)
        for thread in self.readers:
            thread.join(timeout=2)
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.stderr.close()


def goal_case(binary, root, observation):
    provider = Provider(True)
    rpc = None
    try:
        env = setup(root, provider)
        rpc = Rpc(binary, root, env)
        rpc.send({'type': 'prompt', 'id': 'goal-image', 'message': '/goal ' + OBJECTIVE,
                  'images': [IMAGE]})
        response = rpc.until(lambda f: f.get('type') == 'response' and f.get('id') == 'goal-image')
        assert response.get('success'), response
        # The checked surface is the goal-context carrier. RPC's continuation
        # path publishes an active update before the model turn, but not the
        # tool's final complete update; query authoritative host state after
        # agent_end rather than trusting fixture answer text.
        rpc.until(lambda f: f.get('type') == 'agent_end')
        rpc.send({'type': 'get_state', 'id': 'settled-goal-state'})
        settled = rpc.until(lambda f: f.get('type') == 'response'
                            and f.get('id') == 'settled-goal-state')
        assert settled.get('success'), settled
        final_goal = settled.get('data', {}).get('goal', {})
        observation['final_goal'] = final_goal
        observation['goal_update_statuses'] = [f.get('goal', {}).get('status')
            for f in rpc.frames if f.get('type') == 'goal_update']
        assert final_goal.get('status') == 'complete', final_goal
        contexts = [f['message'] for f in rpc.frames if f.get('type') == 'message_end'
                    and f.get('message', {}).get('customType') == 'goal_context']
        observation.update(frames=rpc.frames, requests=provider.requests, sessions=session_rows(root))
        assert len(contexts) == 1, 'expected the actual goal-context message_end'
        content = contexts[0]['content']
        assert isinstance(content, list) and content[0]['type'] == 'text', content
        assert OBJECTIVE in content[0]['text'] and '[goal: continuation]' in content[0]['text'], content
        assert content[1:] == [IMAGE], 'goal image blocks changed/dropped'
        assert len(provider.requests) == 2, 'goal complete tool did not settle the turn'
        image_urls = [block.get('image_url') for m in provider.requests[0].get('messages', [])
                      for block in (m.get('content') if isinstance(m.get('content'), list) else [])
                      if block.get('type') == 'image_url']
        # The existing custom-message/provider image-routing limitation is recorded
        # separately; this PR repairs the goal context carrier, not model routing.
        observation['provider_image_urls'] = image_urls
        return {'content': content, 'display': contexts[0].get('display'),
                'complete': True, 'request_count': len(provider.requests)}
    finally:
        if rpc:
            rpc.close()
            observation.setdefault('frames', rpc.frames)
            observation['stderr'] = ''.join(rpc.errors)
        observation.setdefault('requests', provider.requests)
        observation['provider_errors'] = provider.errors
        provider.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'runs': {}, 'verified': False,
              'scope': {'new': 'Real PTY command, owned real daemon, persisted name and model initial prompt.',
                        'goal': 'Actual RPC image-bearing goal_context row and completed goal.',
                        'provider_images': 'Recorded only; existing model-routing limitation is not normalized into context-row evidence.',
                        'goal_updates': 'Recorded only: RPC publishes before continuation, not on goal.complete; final completion is verified by get_state after agent_end.'}}
    try:
        assert sys.platform == 'linux', 'requires Linux hosted CI'
        binary = Path(os.environ['PA_RUST_BINARY']).resolve()
        result['binary'] = {'path': str(binary), 'sha256': digest(binary)}
        with tempfile.TemporaryDirectory(prefix='new-goal-check-', dir='/tmp') as temp:
            for scenario, run in (('new', new_case), ('goal_images', goal_case)):
                observation = result['runs'][scenario] = {}
                try:
                    observation['surface'] = run(binary, Path(temp) / scenario, observation)
                except Exception as exc:
                    observation['error'] = str(exc)
        failures = {scenario: run['error'] for scenario, run in result['runs'].items() if 'error' in run}
        assert not failures, failures
        result['verified'] = True
    except Exception as exc:
        result['error'] = str(exc)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(args.receipt), 'verified': result['verified'], 'error': result.get('error')}))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
