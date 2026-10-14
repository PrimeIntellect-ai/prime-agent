#!/usr/bin/env python3
"""Actual pinned TS/Rust REPL comparison for bash prefix and Serper wiring.

Only synthetic credentials and loopback provider traffic. The same Python cell
reads the kernel env and runs the real bash() helper. Windows PYTHONUTF8 is not
verified by this Linux comparison; the separate Windows test is cross-compiled.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time
import sys
import tempfile
import threading

from review_restore_notice_parity import texts, Server, sha256, TS_ARCHIVE_SHA256
from review_draft_disconnect_parity import stop

MARKER = 'KERNEL_ENV_PARITY='
CODE = '''import os, json
shell = await bash("printf '%s' \\"${PA_PREFIX_SENTINEL:-ABSENT}\\"")
print('KERNEL_ENV_PARITY=' + json.dumps({'serper': os.environ.get('SERPER_API_KEY'),
    'prefix': os.environ.get('PRIME_AGENT_BASH_COMMAND_PREFIX'),
    'bash_output': shell.output, 'bash_exit': shell.exit_code}))'''
CASES = {
    'command_key_and_prefix': {'skill': True, 'ambient': None, 'prefix': 'export PA_PREFIX_SENTINEL=prefix-ran'},
    'ambient_key_wins': {'skill': True, 'ambient': ' ambient-fixture ', 'prefix': ''},
    'no_skill_no_command': {'skill': False, 'ambient': None, 'prefix': ''},
    'blank_ambient_resolves': {'skill': True, 'ambient': '  ', 'prefix': ''},
}


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
                self.send_error(422, 'missing offered REPL tool')
                return
            delta = {'tool_calls': [{'index': 0, 'id': 'kernel_' + self.server.phase,
                'type': 'function', 'function': {'name': name, 'arguments': json.dumps({'code': CODE})}}]}
            finish = 'tool_calls'
        else:
            delta, finish = {'content': 'Kernel environment fixture complete.'}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'kernel-env', 'object': 'chat.completion.chunk', 'created': 1,
                'model': 'env-fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(item) + '\n\n' for item in (
            chunk({'role': 'assistant', **delta}), chunk({}, finish))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def current_probe(requests, phase):
    assert len(requests) == 2, 'unexpected provider sequence'
    results = [message for message in requests[-1]['messages'] if message.get('role') == 'tool'
               and message.get('tool_call_id') == 'kernel_' + phase]
    assert len(results) == 1, 'missing/duplicate current tool result'
    probes = [json.loads(line[len(MARKER):]) for text in texts(results[0].get('content'))
              for line in text.splitlines() if line.startswith(MARKER)]
    assert len(probes) == 1, 'missing/duplicate current kernel probe'
    return probes[0]


def expected(case):
    key = case['ambient']
    if case['skill'] and (key is None or not key.strip()):
        key = 'resolved-fixture-key'
    prefix = case['prefix'] or None
    return {'serper': key, 'prefix': prefix,
            'bash_output': 'prefix-ran' if prefix else 'ABSENT', 'bash_exit': 0}


def proc_identity(pid):
    stat = Path('/proc/%d/stat' % pid).read_text()
    fields = stat[stat.rfind(')') + 2:].split()
    return 'proc:' + fields[19], fields[0]


def owned_kernel(pid, owner, fixture, identity=None):
    try:
        current, state = proc_identity(pid)
        if state == 'Z' or (identity is not None and current != identity):
            return None
        env = dict(item.split(b'=', 1) for item in Path('/proc/%d/environ' % pid).read_bytes().split(b'\0') if b'=' in item)
        if (env.get(b'PRIME_AGENT_KERNEL_OWNER_PID') != str(owner).encode()
                or env.get(b'PA_KERNEL_ENV_FIXTURE_ID') != fixture.encode()):
            return None
        command = Path('/proc/%d/cmdline' % pid).read_bytes().split(b'\0')
        if not command or not command[0] or b'python' not in Path(command[0].decode()).name.encode():
            return None
        return current
    except (OSError, ValueError, UnicodeError):
        return None


def same_live_process(pid, identity):
    try:
        current, state = proc_identity(pid)
        return current == identity and state != 'Z'
    except FileNotFoundError:
        return False


def invoke_clean(command, cwd, env, observation):
    # Continuously discover only kernels bearing BOTH this root's unique fixture
    # tag and this exact invocation's kernel-owner pid. Preserve process start
    # identity so a recycled pid cannot become a cleanup signal target.
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, start_new_session=True)
    tracked = {}
    finished = threading.Event()
    fixture = env['PA_KERNEL_ENV_FIXTURE_ID']
    def discover():
        while not finished.is_set():
            for entry in Path('/proc').iterdir():
                if entry.name.isdigit():
                    pid = int(entry.name)
                    identity = owned_kernel(pid, process.pid, fixture)
                    if identity:
                        tracked[pid] = identity
            finished.wait(0.025)
    tracker = threading.Thread(target=discover, daemon=True)
    tracker.start()
    cleanup_error = None
    try:
        stdout, stderr = process.communicate(timeout=75)
        if process.returncode:
            raise RuntimeError('binary exited %s: %s' % (process.returncode, stderr[-3000:]))
        return {'exit_code': process.returncode, 'stdout': stdout, 'stderr': stderr}
    finally:
        finished.set()
        tracker.join(timeout=2)
        stop(process)  # Only the invocation's own process group.
        observation['owned_kernel_identities'] = dict(tracked)
        if process.returncode == 0:
            assert tracked, 'successful fixture did not capture kernel ownership'
        # Gracefully stop any remaining identity-verified detached kernels. This
        # is fixture cleanup, not a claim of equivalent shutdown behavior.
        for pid, identity in tracked.items():
            if owned_kernel(pid, process.pid, fixture, identity):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            remaining = {pid: identity for pid, identity in tracked.items()
                if same_live_process(pid, identity)}
            if not remaining:
                break
            threading.Event().wait(0.025)
        else:
            # A final narrowly owned kill avoids leaving a CI kernel behind,
            # but escalation is a failed cleanup receipt, never parity success.
            cleanup_error = 'kernel did not stop after SIGTERM: ' + str(list(remaining))
            for pid, identity in remaining.items():
                if owned_kernel(pid, process.pid, fixture, identity):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        assert not tracker.is_alive(), 'kernel ownership tracker did not stop'
        observation['cleanup_verified'] = cleanup_error is None
        if cleanup_error:
            raise AssertionError(cleanup_error)


def run_case(binary, label, name, case, root, observation):
    for directory in ('home', 'tmp', 'work', 'agent', 'sessions'):
        (root / directory).mkdir(parents=True)
    agent, cwd = root / 'agent', root / 'work'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
        'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON') if key in os.environ}
    library = Path(os.environ['PI_PACKAGE_DIR'])
    if label == 'ts':
        env['PI_PACKAGE_DIR'] = str(library)
    env['PYTHONPATH'] = os.pathsep.join(str(path) for path in sorted((library / 'skills').glob('*/src')))
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1', PI_OFFLINE='1',
        PI_CODING_AGENT_DIR=str(agent), PRIME_AGENT_CODING_AGENT_DIR=str(agent),
        PI_SESSION_DIR=str(root / 'sessions'), PRIME_AGENT_SESSION_DIR=str(root / 'sessions'),
        XDG_CONFIG_HOME=str(root / 'config'), XDG_CACHE_HOME=str(root / 'cache'), XDG_DATA_HOME=str(root / 'data'))
    env['PA_KERNEL_ENV_FIXTURE_ID'] = str(root.resolve())
    if case['ambient'] is not None:
        env['SERPER_API_KEY'] = case['ambient']
    # Explicit identical custom skill avoids differences in bundled inventory.
    # Bundled websearch is disabled in every case; only this custom skill gates
    # injection, exercising the documented bundled-or-custom skill condition.
    if case['skill']:
        skill = agent / 'skills' / 'websearch' / 'SKILL.md'
        skill.parent.mkdir(parents=True)
        skill.write_text('---\nname: websearch\ndescription: Synthetic environment fixture\n---\nNo network work.\n')
    invoked = root / 'credential-command-invoked'
    command = "!printf ' resolved-fixture-key '; printf invoked > " + shlex.quote(str(invoked))
    (agent / 'auth.json').write_text(json.dumps({'serper': {'type': 'api_key', 'key': command}}))
    server = Server(root)
    server.RequestHandlerClass = Handler
    server.phase = name
    server.requests = {name: []}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'http://127.0.0.1:%s/v1' % server.server_address[1],
        'models': [{'id': 'env-fixture', 'name': 'Environment fixture', 'reasoning': False,
                    'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    (agent / 'settings.json').write_text(json.dumps({'defaultProvider': 'fixture',
        'defaultModel': 'env-fixture', 'prewarmPythonKernel': False,
        'shellCommandPrefix': case['prefix'], 'bundledSkills': {'websearch': False}}))
    try:
        observation['run'] = invoke_clean([str(binary), '--mode', 'json', '--provider', 'fixture',
            '--model', 'env-fixture', '--session-dir', str(root / 'sessions'),
            'Run the kernel environment fixture cell.'], cwd, env, observation)
        observation['probe'] = current_probe(server.requests[name], name)
        assert observation['probe'] == expected(case), (observation['probe'], expected(case))
        ran = case['skill'] and (case['ambient'] is None or not case['ambient'].strip())
        assert invoked.exists() == ran, 'credential command ran outside its skill/ambient gate'
        observation['credential_command_ran'] = invoked.exists()
    finally:
        observation['requests'] = server.requests[name]
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'runs': {}, 'scope': 'Actual REPL kernel env + real bash output; '
        'command-backed credential, trimming, ambient precedence, custom skill gate, empty-prefix omission',
        'not_verified': ['Windows PYTHONUTF8 behavior (cross-compiled Rust regression only)',
                         'TUI frame comparison; runtime settings reload of captured env'],
        'normalization': 'Identical synthetic scalar results; legacy offered ipython/python_repl tool name selected per binary. Raw traffic retained.'}
    try:
        assert sys.platform == 'linux', 'requires hosted Linux binaries'
        assert sha256(os.environ['PA_TS_ARCHIVE']) == TS_ARCHIVE_SHA256, 'TS release archive mismatch'
        receipt['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='kernel-env-parity-', dir='/tmp') as folder:
            for label in ('ts', 'rust'):
                binary = Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                run = receipt['runs'][label] = {'binary_sha256': sha256(binary), 'cases': {}}
                for name, case in CASES.items():
                    observation = run['cases'][name] = {}
                    try:
                        run_case(binary, label, name, case, Path(folder) / label / name, observation)
                    except Exception as error:
                        observation['error'] = str(error)
        assert all('error' not in case for run in receipt['runs'].values() for case in run['cases'].values()), receipt['runs']
        for name in CASES:
            assert receipt['runs']['ts']['cases'][name]['probe'] == receipt['runs']['rust']['cases'][name]['probe']
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'verified': receipt['verified'], 'receipt': str(args.receipt), 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
