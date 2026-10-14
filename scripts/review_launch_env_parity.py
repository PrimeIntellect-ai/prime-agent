#!/usr/bin/env python3
"""Actual daemon/kernel launch-env comparison; owned Linux CI processes only.

Exercises raw create wire (not TUI sender rendering), isolation, resident crash
recovery, owned recovery, promotion lifetime, and durable secret exclusion.
Requests/responses and actual provider tool results are retained. No ambient
credential is copied. Recovery kills only a descriptor- and cmdline-verified
worker belonging to this fixture, never a process found by name.
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
import time

from review_agent_bounce_parity import Client
from review_draft_disconnect_parity import digest, env_for, stop, TS_ARCHIVE_SHA256
from review_restore_notice_parity import texts

MARKER = 'LAUNCH_ENV_PARITY='
LIMIT = 35
CODE = """import os, json, subprocess, sys
keys = ('PA_ENV_MARKER', 'PA_ENV_BASE', 'PA_ENV_PRECEDENCE', 'PRIME_AGENT_INTERNAL_PARITY_CANARY')
result = {'env': {key: os.environ.get(key) for key in keys},
          'child_marker': subprocess.check_output([sys.executable, '-c', "import os; print(os.environ.get('PA_ENV_MARKER', 'ABSENT'))"], text=True).strip()}
print('LAUNCH_ENV_PARITY=' + json.dumps(result))"""


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.phase = None
        self.requests = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        phase = self.server.phase
        requests = self.server.requests.setdefault(phase, [])
        requests.append(body)
        if len(requests) == 1:
            offered = {tool.get('function', {}).get('name') for tool in body.get('tools', [])}
            name = next((name for name in ('python_repl', 'ipython') if name in offered), None)
            if name is None:
                self.send_error(422, 'missing real REPL tool')
                return
            delta = {'tool_calls': [{'index': 0, 'id': 'launch_' + phase, 'type': 'function',
                'function': {'name': name, 'arguments': json.dumps({'code': CODE})}}]}
            finish = 'tool_calls'
        else:
            delta, finish = {'content': 'Launch environment fixture complete.'}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'launch-env', 'object': 'chat.completion.chunk', 'created': 1,
                'model': 'parity-1', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', **delta}), chunk({}, finish))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def current_probe(requests, phase):
    assert len(requests) == 2, 'unexpected provider sequence'
    matches = [message for message in requests[-1]['messages'] if message.get('role') == 'tool'
               and message.get('tool_call_id') == 'launch_' + phase]
    assert len(matches) == 1, 'missing/duplicate current tool result'
    probes = [json.loads(line[len(MARKER):]) for text in texts(matches[0].get('content'))
              for line in text.splitlines() if line.startswith(MARKER)]
    assert len(probes) == 1, 'missing/duplicate current probe'
    return probes[0]


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
            except FileNotFoundError:
                pass
        if not alive:
            return
        threading.Event().wait(0.025)
    raise AssertionError('owned fixture processes remained after shutdown: ' + str(alive))


def restart(client, active, agent, binary, config, owned, observation, tracked):
    socket_path = agent.parent / 'd.sock'
    path, row = worker_descriptor(agent, active, socket_path)
    pid, identity = verify_worker(row, active, binary, socket_path)
    tracked.add((pid, identity))
    observation['killed_owned_worker_pid'] = pid
    os.kill(pid, signal.SIGKILL)
    wait_gone({(pid, identity)})
    if owned:
        # Observe the supervisor's death bookkeeping before the recovery action.
        deadline = time.monotonic() + LIMIT
        while time.monotonic() < deadline:
            try:
                changed = json.loads(path.read_text())
                if changed.get('pid') != pid or changed.get('lifecycle') != 'ready':
                    break
            except (OSError, ValueError):
                pass
            threading.Event().wait(0.025)
        else:
            raise AssertionError('owner recovery never observed worker death')
        # Same owner context; refreshed attach launchEnv is deliberately out of scope.
        client.call('attach', activeSessionId=active, recoveryConfig=config)
    new_path, new_row = worker_descriptor(agent, active, socket_path, previous=pid)
    assert new_path == path
    tracked.add(verify_worker(new_row, active, binary, socket_path))
    observation['replacement_worker_pid'] = new_row['pid']
    if not owned:
        client.call('attach', activeSessionId=active)


def run_case(binary, label, root, observed):
    env = env_for(root, label)
    env.update(PA_ENV_BASE='daemon-base', PA_ENV_PRECEDENCE='daemon', RLM_DEPTH='3')
    library = Path(os.environ['PI_PACKAGE_DIR'])
    env['PYTHONPATH'] = os.pathsep.join(str(path) for path in sorted((library / 'skills').glob('*/src')))
    provider = Provider()
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    models_path = root / 'agent/models.json'
    models = json.loads(models_path.read_text())
    models['providers']['parity-local']['baseUrl'] = 'http://127.0.0.1:%s/v1' % provider.server_port
    models_path.write_text(json.dumps(models))
    settings = root / 'agent/settings.json'
    settings.write_text(json.dumps({'prewarmPythonKernel': False, 'onboardingCompleted': True,
        'telemetry': {'noticeShown': True}, 'defaultProvider': 'parity-local', 'defaultModel': 'parity-1'}))
    log = open(root / 'daemon.log', 'wb')
    process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(root / 'd.sock')],
        cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    client = None
    probes = observed['probes'] = {}
    tracked = set()
    secret = 'fixture-launch-secret'
    config = {'cwd': str(root), 'agentDir': str(root / 'agent'), 'provider': 'parity-local',
        'model': 'parity-1', 'noExtensions': True, 'noContextFiles': True, 'telemetryDisabled': True}
    launch = {'PA_ENV_MARKER': secret, 'PA_ENV_PRECEDENCE': 'client', 'RLM_DEPTH': '9',
              'PRIME_AGENT_INTERNAL_PARITY_CANARY': 'must-not-inherit'}
    def create(name, lifecycle, forwarded):
        row = client.call('create', name=name, lifecycle=lifecycle, config=config, **forwarded)
        active = row.get('activeSessionId') or row.get('id')
        assert active
        header = json.loads(Path(row['sessionFile']).read_text().splitlines()[0])
        assert header.get('rlmDepth', 0) == 0, header
        client.call('attach', activeSessionId=active)
        _, descriptor = worker_descriptor(root / 'agent', active, root / 'd.sock')
        tracked.add(verify_worker(descriptor, active, binary, root / 'd.sock'))
        return active
    def probe(active, phase, expected_marker, expected_precedence):
        provider.phase = phase
        client.call('prompt_and_wait', activeSessionId=active, message='Probe ' + phase)
        result = current_probe(provider.requests[phase], phase)
        expected = {'env': {'PA_ENV_MARKER': expected_marker, 'PA_ENV_BASE': 'daemon-base',
            'PA_ENV_PRECEDENCE': expected_precedence, 'PRIME_AGENT_INTERNAL_PARITY_CANARY': None},
            'child_marker': expected_marker or 'ABSENT'}
        assert result == expected, (phase, result, expected)
        probes[phase] = result
    try:
        client = Client(root / 'd.sock', process)
        a = create('launch-a', 'resident', {'launchEnv': launch})
        b = create('launch-b', 'resident', {})
        probe(a, 'resident_initial', secret, 'client')
        probe(b, 'isolated_other', None, 'daemon')
        observed['resident_recovery'] = {}
        restart(client, a, root / 'agent', binary, config, False, observed['resident_recovery'], tracked)
        probe(a, 'resident_recovered', None, 'daemon')
        owner = create('launch-owned', 'client_owned', {'launchEnv': launch})
        probe(owner, 'owned_initial', secret, 'client')
        observed['owned_recovery'] = {}
        restart(client, owner, root / 'agent', binary, config, True, observed['owned_recovery'], tracked)
        probe(owner, 'owned_recovered', secret, 'client')
        client.call('promote_owned_session', activeSessionId=owner)
        observed['promoted_recovery'] = {}
        restart(client, owner, root / 'agent', binary, config, False, observed['promoted_recovery'], tracked)
        probe(owner, 'promoted_recovered', None, 'daemon')
        prepared = client.call('prepare_update_restart', updateId='launch-env-parity')
        assert secret not in json.dumps(prepared), 'launch secret leaked into update roster'
        for path in (root / 'agent').rglob('*.json'):
            if 'daemon-workers' in path.parts:
                assert secret not in path.read_text(), 'launch secret leaked into durable worker metadata'
        observed['durable_launch_secret_absent'] = True
        observed['prepare_update'] = prepared
    finally:
        observed['requests'] = provider.requests
        cleanup_error = None
        try:
            if client:
                observed['wire'] = client.wire
                if process.poll() is None:
                    client.call('shutdown', force=True)
                    process.wait(timeout=15)
                assert process.returncode == 0, 'supervisor did not shut down successfully'
                wait_gone(tracked)
                observed['cleanup_verified'] = True
            else:
                raise AssertionError('fixture supervisor did not establish cleanup control')
        except Exception as error:
            cleanup_error = error
            observed['cleanup_error'] = str(error)
        finally:
            if client:
                client.close()
            stop(process)
            log.close()
            observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-6000:]
            provider.shutdown()
            provider.server_close()
            thread.join(timeout=2)
        if cleanup_error:
            raise AssertionError('fixture cleanup failed: ' + str(cleanup_error)) from cleanup_error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'runs': {}, 'scope': 'Raw daemon create, actual REPL/subprocess env, '
        'resident/owned/promotion recovery lifetime, durable launch-env secret exclusion',
        'not_verified': ['TUI/ACP sender env collection', 'refreshed attach launchEnv recovery',
                         'rlm.spawn and minimal depth-0 root forwarding'],
        'normalization': 'Generated session IDs, roots, worker PIDs and timestamps excluded only from cross-run comparison; raw wire retained.'}
    try:
        assert sys.platform == 'linux', 'requires hosted Linux /proc ownership checks'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256, 'TS archive mismatch'
        receipt['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='launch-env-parity-', dir='/tmp') as folder:
            for label in ('ts', 'rust'):
                binary = Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                run = receipt['runs'][label] = {'binary_sha256': digest(binary)}
                try:
                    run_case(binary, label, Path(folder) / label, run)
                except Exception as error:
                    run['error'] = str(error)
        assert all('error' not in run for run in receipt['runs'].values()), receipt['runs']
        assert receipt['runs']['ts']['probes'] == receipt['runs']['rust']['probes'], 'environment behavior differs'
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'verified': receipt['verified'], 'receipt': str(args.receipt), 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
