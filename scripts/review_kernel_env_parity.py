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
from review_agent_bounce_parity import Client as BounceClient

MARKER = 'KERNEL_ENV_PARITY='
LIMIT = 35
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


def owned_kernel(pid, owner, fixture, identity=None):
    try:
        current, state = process_identity(pid)
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


def process_identity(pid):
    stat = Path('/proc/%d/stat' % pid).read_text()
    fields = stat[stat.rfind(')') + 2:].split()
    return 'proc:' + fields[19], fields[0]


def worker_descriptor(agent, active, socket_path, deadline=None, previous=None):
    deadline = deadline or time.monotonic() + LIMIT
    while time.monotonic() < deadline:
        candidates = list((agent / 'daemon-workers').rglob('*.json'))
        for path in candidates:
            try:
                row = json.loads(path.read_text())
                pid = row.get('pid')
                if (row.get('rootActiveSessionId') == active
                        and row.get('supervisorSocketPath') == str(socket_path)
                        and isinstance(pid, int) and pid > 0 and pid != previous):
                    return path, row
            except (OSError, ValueError):
                pass  # Atomic/transitional descriptor writes are not readiness.
        threading.Event().wait(0.025)
    raise AssertionError('fixture worker descriptor never reached readiness')


def verify_worker(row, active, binary, socket_path):
    pid = row['pid']
    assert row.get('rootActiveSessionId') == active, 'wrong descriptor identity'
    assert row.get('supervisorSocketPath') == str(socket_path), 'wrong supervisor descriptor'
    command = Path('/proc/%d/cmdline' % pid).read_bytes().split(b'\0')
    assert command[0] == str(binary).encode(), 'worker argv0 is not fixture binary'
    env = dict(item.split(b'=', 1) for item in Path('/proc/%d/environ' % pid).read_bytes().split(b'\0') if b'=' in item)
    for key, value in {
        'PRIME_AGENT_INTERNAL_DAEMON_WORKER': '1',
        'PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID': active,
        'PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET': str(socket_path),
    }.items():
        assert env.get(key.encode()) == value.encode(), 'wrong fixture worker env identity'
    worker_socket = str(row['socketPath']).encode()
    assert (worker_socket in command or env.get(b'PRIME_AGENT_INTERNAL_DAEMON_WORKER_SOCKET') == worker_socket), 'wrong worker socket identity'
    identity, state = process_identity(pid)
    assert row.get('processStartId') == identity and state != 'Z', 'wrong/reused worker PID'
    return pid, identity


def wait_gone(identities):
    deadline = time.monotonic() + LIMIT
    while time.monotonic() < deadline:
        alive = []
        for pid, identity in identities:
            try:
                current, state = process_identity(pid)
                if current == identity and state != 'Z':
                    alive.append(pid)
            except (FileNotFoundError, ProcessLookupError):
                pass
        if not alive:
            return
        threading.Event().wait(0.025)
    raise AssertionError('owned fixture processes remained after shutdown: ' + str(alive))



def finish_daemon(client, process):
    client.call('shutdown', force=True)
    client.close()
    process.wait(timeout=15)
    assert process.returncode == 0, 'fixture supervisor failed graceful shutdown'


class KernelClient(BounceClient):
    """Same daemon frames, with an explicit cold-kernel request budget."""
    def call(self, kind, timeout_seconds=LIMIT, **payload):
        self.counter += 1
        ident = str(self.counter)
        envelope = {'type': 'command', 'id': ident,
            'protocol': {'name': 'prime-agent.daemon', 'version': 7},
            'command': {'type': kind, **payload}}
        deadline = time.monotonic() + timeout_seconds
        previous_timeout = self.sock.gettimeout()
        try:
            self.sock.settimeout(timeout_seconds)
            self.sock.sendall((json.dumps(envelope) + '\n').encode())
            while time.monotonic() < deadline:
                self.sock.settimeout(max(0.001, deadline - time.monotonic()))
                line = self.reader.readline()
                assert line, 'daemon closed connection'
                response = json.loads(line)
                self.wire.append(response)
                if response.get('type') == 'response' and response.get('id') == ident:
                    assert response.get('success'), response
                    return response.get('data')
            raise TimeoutError('command never answered: ' + kind)
        finally:
            self.sock.settimeout(previous_timeout)


def signal_owned(pid, identity, validator, signum):
    """Pin the PID with a pidfd, then recheck exact ownership before signaling."""
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return False
    try:
        current, state = process_identity(pid)
        if current != identity or state == 'Z' or not validator():
            return False
        signal.pidfd_send_signal(fd, signum)
        return True
    except ProcessLookupError:
        return False
    finally:
        os.close(fd)


def live_identities(identities):
    alive = set()
    for pid, identity in identities:
        try:
            current, state = process_identity(pid)
            if current == identity and state != 'Z':
                alive.add((pid, identity))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return alive


def reap_leftovers(agent, binary, socket_path, descriptor, kernels, worker_pid, fixture, observation):
    """Best-effort exact-owned fallback; never clears the graceful-cleanup failure."""
    rows = [descriptor] if descriptor is not None else []
    for path in (agent / 'daemon-workers').rglob('*.json'):
        try:
            row = json.loads(path.read_text())
            if row.get('supervisorSocketPath') == str(socket_path):
                rows.append(row)
        except (OSError, ValueError):
            pass
    targets = {}
    owner_ids = {worker_pid} if worker_pid is not None else set()
    errors = observation['fallback_errors'] = []
    for row in rows:
        try:
            pid, identity = verify_worker(row, row['rootActiveSessionId'], binary, socket_path)
            owner_ids.add(pid)
            def valid_worker(row=row, pid=pid, identity=identity):
                try:
                    return verify_worker(row, row['rootActiveSessionId'], binary, socket_path) == (pid, identity)
                except (OSError, AssertionError):
                    return False
            targets[(pid, identity)] = valid_worker
        except (OSError, AssertionError, KeyError) as error:
            errors.append('worker ownership unavailable: ' + str(error))
    # Discover kernels even if the turn failed before the regular tracker saw
    # them, requiring the unique fixture tag and a verified fixture worker owner.
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            pid = int(entry.name)
            for owner in owner_ids:
                identity = owned_kernel(pid, owner, fixture, kernels.get(pid))
                if identity:
                    kernels[pid] = identity
                    targets[(pid, identity)] = lambda pid=pid, owner=owner, identity=identity: \
                        owned_kernel(pid, owner, fixture, identity) == identity
                    break
    observation['fallback_signals'] = []
    known_identities = set(targets) | set(kernels.items())
    if descriptor is not None and descriptor.get('processStartId'):
        known_identities.add((descriptor['pid'], descriptor['processStartId']))
    for signum in (signal.SIGTERM, signal.SIGKILL):
        for (pid, identity), validator in targets.items():
            try:
                if signal_owned(pid, identity, validator, signum):
                    observation['fallback_signals'].append({'pid': pid, 'signal': signum.name})
            except OSError as error:
                errors.append('owned signal failed: ' + str(error))
        deadline = time.monotonic() + (3 if signum == signal.SIGTERM else 2)
        remaining = live_identities(known_identities)
        while time.monotonic() < deadline:
            remaining = live_identities(known_identities)
            if not remaining:
                observation['fallback_processes_exited'] = True
                return
            threading.Event().wait(0.025)
    observation['fallback_processes_exited'] = False
    observation['fallback_remaining'] = sorted(remaining)


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
    socket_path = root / 'd.sock'
    log = open(root / 'daemon.log', 'wb')
    process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(socket_path)],
        cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    client = None
    tracker = None
    finished = threading.Event()
    kernels = {}
    tracked = set()
    primary_error = None
    worker_pid = None
    descriptor = None
    fixture = env['PA_KERNEL_ENV_FIXTURE_ID']
    try:
        client = KernelClient(socket_path, process)
        created = client.call('create', name='kernel-env-' + name, config={
            'cwd': str(cwd), 'agentDir': str(agent), 'sessionDir': str(root / 'sessions'),
            'provider': 'fixture', 'model': 'env-fixture', 'noExtensions': True,
            'noContextFiles': True, 'telemetryDisabled': True})
        active = created.get('activeSessionId') or created.get('id')
        assert active, 'create omitted active identity'
        _, descriptor = worker_descriptor(agent, active, socket_path)
        worker_pid, worker_identity = verify_worker(descriptor, active, binary, socket_path)
        tracked.add((worker_pid, worker_identity))
        def discover():
            while not finished.is_set():
                for entry in Path('/proc').iterdir():
                    if entry.name.isdigit():
                        pid = int(entry.name)
                        identity = owned_kernel(pid, worker_pid, fixture)
                        if identity:
                            kernels[pid] = identity
                finished.wait(0.025)
        tracker = threading.Thread(target=discover, daemon=True)
        tracker.start()
        # Raw daemon user input is identical in both products. This avoids TS's
        # CLI->daemon worker route vs Rust's in-process JSON route entirely.
        client.call('prompt_and_wait', timeout_seconds=90, activeSessionId=active, message='Run the kernel environment fixture cell.')
        observation['probe'] = current_probe(server.requests[name], name)
        assert observation['probe'] == expected(case), (observation['probe'], expected(case))
        ran = case['skill'] and (case['ambient'] is None or not case['ambient'].strip())
        assert invoked.exists() == ran, 'credential command ran outside its skill/ambient gate'
        observation['credential_command_ran'] = invoked.exists()
        assert kernels, 'successful fixture did not capture kernel ownership'
    except BaseException as error:
        primary_error = error
        observation['primary_error'] = str(error)
        raise
    finally:
        finished.set()
        if tracker:
            tracker.join(timeout=2)
        observation['owned_kernel_identities'] = dict(kernels)
        tracked.update(kernels.items())
        observation['requests'] = server.requests[name]
        cleanup_error = None
        try:
            assert client is not None, 'fixture did not establish cleanup control'
            observation['wire'] = client.wire
            finish_daemon(client, process)  # Close after ack, before waiting for TS exit.
            wait_gone(tracked)
            assert tracker is None or not tracker.is_alive(), 'kernel tracker did not stop'
            observation['cleanup_verified'] = True
        except Exception as error:
            cleanup_error = error
            observation['cleanup_error'] = str(error)
            observation['cleanup_verified'] = False
        finally:
            if client:
                client.close()
            stop(process)
            if cleanup_error:
                try:
                    reap_leftovers(agent, binary, socket_path, descriptor, kernels, worker_pid, fixture, observation)
                except Exception as error:
                    observation['fallback_error'] = str(error)
            log.close()
            observation['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-6000:]
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        if cleanup_error and primary_error is None:
            raise AssertionError('fixture cleanup failed: ' + str(cleanup_error)) from cleanup_error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'runs': {}, 'scope': 'Identical raw daemon create/prompt_and_wait + actual REPL kernel env + real bash output; '
        'command-backed credential, trimming, ambient precedence, custom skill gate, empty-prefix omission',
        'not_verified': ['Windows PYTHONUTF8 behavior (cross-compiled Rust regression only)',
                         'TUI/JSON CLI sender routing; runtime settings reload of captured env'],
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
