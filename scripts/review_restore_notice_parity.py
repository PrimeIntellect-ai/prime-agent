#!/usr/bin/env python3
"""Compare real TS/Rust resume behavior, recording #3525's intended notice addition.

Runs the same two-turn fixture against the pinned TS 0.9.8 release and Rust.
Both must revive a namespace while resetting cwd/env; Rust alone must disclose
that reset. Only the exact added sentence is excluded from notice parity.
All provider traffic, homes, sessions, and subprocesses belong to this fixture.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading

from review_goal_backoff_parity import TS_ARCHIVE_SHA256, sha256

RESET = ("The working directory and environment variables were reset to the session defaults; "
         "re-apply any os.chdir(...) or os.environ[...] changes you still need.")
PROBE = "RESTORE_PARITY_RESULT="
SETUP = """import os
restore_parity_marker = 'namespace-survived'
os.mkdir('moved')
os.chdir('moved')
os.environ['PA_RESTORE_PARITY_PROBE'] = 'changed'
print('RESTORE_PARITY_SETUP=' + __import__('json').dumps({'cwd': os.getcwd(), 'env': os.environ.get('PA_RESTORE_PARITY_PROBE')}))"""
READ = """import os
print('RESTORE_PARITY_RESULT=' + __import__('json').dumps({'marker': restore_parity_marker, 'cwd': os.getcwd(), 'env': os.environ.get('PA_RESTORE_PARITY_PROBE')}))"""


def texts(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from texts(item)
    elif isinstance(value, dict):
        # Content blocks have one text member. Avoid matching tool-call arguments.
        if isinstance(value.get('text'), str):
            yield value['text']


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.phase = 'setup'
        self.requests = {'setup': [], 'resume': []}


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
            delta = {'tool_calls': [{'index': 0, 'id': 'call_' + self.server.phase,
                     'type': 'function', 'function': {'name': 'ipython',
                     'arguments': json.dumps({'code': SETUP if self.server.phase == 'setup' else READ})}}]}
            finish = 'tool_calls'
        else:
            delta, finish = {'content': 'Fixture complete.'}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'restore-parity', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'restore-fixture', 'choices': [{'index': 0, 'delta': delta,
                                                          'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(item) + '\n\n' for item in (
            chunk({'role': 'assistant', **delta}), chunk({}, finish))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def invoke(command, cwd, env):
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=75)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate(timeout=5)
        raise RuntimeError('binary timed out: ' + stderr[-2000:])
    if process.returncode:
        raise RuntimeError('binary exited %s: %s' % (process.returncode, stderr[-3000:]))
    return {'exit_code': process.returncode, 'stdout': stdout, 'stderr': stderr}


def probe_from(requests, marker):
    for body in requests:
        for message in body.get('messages', []):
            if message.get('role') != 'tool':
                continue
            for text in texts(message.get('content')):
                for line in text.splitlines():
                    if line.startswith(marker):
                        return json.loads(line[len(marker):])
    raise AssertionError('missing actual tool result ' + marker)


def notices_in(request):
    return [text for message in request.get('messages', [])
            if message.get('role') != 'assistant'
            for text in texts(message.get('content')) if '[python-state-restored]' in text]


def run_case(binary, label, root):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp'):
        (root / name).mkdir(parents=True)
    cwd, agent, sessions = root / 'work', root / 'agent', root / 'sessions'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
           'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON', 'PYTHONPATH') if key in os.environ}
    if label == 'ts' and 'PI_PACKAGE_DIR' in os.environ:
        env['PI_PACKAGE_DIR'] = os.environ['PI_PACKAGE_DIR']
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1',
               PI_OFFLINE='1', PI_CODING_AGENT_DIR=str(agent),
               PRIME_AGENT_CODING_AGENT_DIR=str(agent), PI_SESSION_DIR=str(sessions),
               PRIME_AGENT_SESSION_DIR=str(sessions), XDG_CONFIG_HOME=str(root / 'config'),
               XDG_CACHE_HOME=str(root / 'cache'), XDG_DATA_HOME=str(root / 'data'))
    server = Server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'http://127.0.0.1:%s/v1' % server.server_address[1],
        'models': [{'id': 'restore-fixture', 'name': 'Restore fixture', 'reasoning': False,
                    'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    (agent / 'settings.json').write_text(json.dumps({'defaultProvider': 'fixture',
        'defaultModel': 'restore-fixture', 'prewarmPythonKernel': False}))
    command = [str(binary), '--mode', 'json', '--provider', 'fixture', '--model',
               'restore-fixture', '--session-dir', str(sessions)]
    try:
        version = invoke([str(binary), '--version'], cwd, env)
        setup = invoke(command + ['Set up the restore fixture.'], cwd, env)
        session_files = list(sessions.rglob('*.jsonl'))
        session_files = [p for p in session_files if json.loads(p.read_text().splitlines()[0]).get('type') == 'session']
        assert len(session_files) == 1, 'expected one persisted session: %s' % session_files
        snapshots = list(root.rglob('kernel-state.dill'))
        assert len(snapshots) == 1 and snapshots[0].stat().st_size, 'setup did not persist a kernel snapshot'
        setup_probe = probe_from(server.requests['setup'], 'RESTORE_PARITY_SETUP=')
        assert setup_probe == {'cwd': str(cwd / 'moved'), 'env': 'changed'}, setup_probe
        assert not notices_in(server.requests['setup'][0]), 'fresh session emitted a restore notice'
        server.phase = 'resume'
        resume = invoke(command + ['--resume', str(session_files[0]), 'Read the restored state.'], cwd, env)
        actual = probe_from(server.requests['resume'], PROBE)
        assert actual == {'marker': 'namespace-survived', 'cwd': str(cwd), 'env': None}, actual
        notices = notices_in(server.requests['resume'][0])
        assert len(notices) == 1, 'restore notice must precede the first resumed model request: %s' % notices
        notice = notices[0]
        assert 'revived from your previous session' in notice and 'restore_parity_marker' in notice, notice
        # Persisted/renderable notice is inspected separately from the provider request.
        entries = [json.loads(line) for line in session_files[0].read_text().splitlines()]
        stored = [row for row in entries if row.get('customType') == 'ipython_state_restored']
        assert len(stored) == 1 and stored[0].get('display') is True, stored
        stored_notice = '\n'.join(texts(stored[0].get('content')))
        assert stored_notice in notice, 'provider must receive the persisted notice'
        assert (RESET in stored_notice) == (label == 'rust'), stored_notice
        return {'version': version['stdout'].strip(), 'setup': setup_probe,
                'restored': {**actual, 'cwd': '<session-cwd>'},
                'notice': stored_notice, 'notice_before_first_request': True,
                'request_counts': {k: len(v) for k, v in server.requests.items()},
                'display': stored[0]['display'], 'details': stored[0].get('details'),
                'setup_stdout': setup['stdout'], 'resume_stdout': resume['stdout'],
                'stderr': {'setup': setup['stderr'], 'resume': resume['stderr']}}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    binaries = {label: Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                for label in ('ts', 'rust')}
    assert sys.platform == 'linux', 'requires Linux hosted CI'
    archive_hash = sha256(os.environ['PA_TS_ARCHIVE'])
    assert archive_hash == TS_ARCHIVE_SHA256, 'TS release archive hash mismatch'
    result = {'ts_release_archive_sha256': archive_hash,
              'binaries': {label: {'path': str(path), 'sha256': sha256(path)}
                           for label, path in binaries.items()},
              'intended_difference': RESET, 'runs': {}, 'verified': False}
    try:
        with tempfile.TemporaryDirectory(prefix='restore-notice-parity-') as temp:
            for label, binary in binaries.items():
                result['runs'][label] = run_case(binary, label, Path(temp) / label)
        ts, rust = result['runs']['ts'], result['runs']['rust']
        assert rust['notice'].removesuffix('\n' + RESET) == ts['notice'], 'additional notice difference'
        assert rust['restored'] == ts['restored'], 'restored state differs'
        assert rust['request_counts'] == ts['request_counts'] == {'setup': 2, 'resume': 2}
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
