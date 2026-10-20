#!/usr/bin/env python3
"""Capture mandatory-thinking summary/refiner requests from the real binary.

Python cells run through the offered REPL tool. Only auxiliary request thinking
controls are checked: prompt wording, token budgets, and UI frames are not.
Branch summary uses an owned daemon and its real navigate_tree command. The owned
supervisor shuts down workers and kernels before temporary files are removed.
All providers, homes, sessions, and subprocesses belong to this fixture.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time

from check_restore_notice import invoke, probe_from, texts
from check_kernel_env import KernelClient
from lifecycle_lib import OwnedProcesses, TAG, digest, finish, skill_pythonpath

MARKER = 'MINIMUM_REASONING_RESULT='


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, scenario):
        super().__init__(('127.0.0.1', 0), Handler)
        self.scenario = scenario
        self.requests = []
        self.main_requests = 0
        self.tool_name = None
        self.error = None


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        auxiliary = not body.get('tools')
        self.server.requests.append({'auxiliary': auxiliary, 'body': body})
        if len(self.server.requests) > 12:
            self.server.error = 'request limit exceeded'
            self.send_error(422, self.server.error)
            return
        if auxiliary:
            content = ('{"summary":"No durable change justified","rationale":"Fixture only",'
                       '"expectedOutcome":"No change","edits":[]}'
                       if self.server.scenario == 'refine' else
                       '## Goal\nVerify auxiliary thinking controls.\n## Progress\nSeed fixture complete.')
            delta, finish = {'content': content}, 'stop'
        else:
            self.server.main_requests += 1
            number = self.server.main_requests
            if number == 1 or self.server.scenario == 'branch':
                # Enough history for a real summary after a second user turn.
                delta, finish = {'content': 'Seed observation. ' * 300}, 'stop'
            elif number == 2:
                offered = {tool.get('function', {}).get('name') for tool in body.get('tools', [])}
                name = next((name for name in ('python_repl', 'ipython') if name in offered), None)
                if name is None:
                    self.server.error = 'no supported REPL tool offered'
                    self.send_error(422, self.server.error)
                    return
                self.server.tool_name = name
                scenario = self.server.scenario
                code = (f'import {scenario}, json\n'
                        f'result = await {scenario}.run("Verify mandatory thinking")\n'
                        f'print({MARKER!r} + json.dumps(result))')
                delta = {'tool_calls': [{'index': 0, 'id': 'call_schedule', 'type': 'function',
                         'function': {'name': name, 'arguments': json.dumps({'code': code})}}]}
                finish = 'tool_calls'
            else:
                delta, finish = {'content': 'Fixture complete.'}, 'stop'
        def chunk(value, reason=None):
            return {'id': 'minimum-reasoning', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'mandatory-fixture', 'choices': [{'index': 0, 'delta': value,
                                                            'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(item) + '\n\n' for item in (
            chunk({'role': 'assistant', **delta}), chunk({}, finish))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def summarize_branch(client, active, session_file):
    entries = [json.loads(line) for line in session_file.read_text().splitlines()]
    target = next(row['id'] for row in entries
                  if row.get('type') == 'message' and row.get('message', {}).get('role') == 'assistant')
    moved = client.call('navigate_tree', timeout_seconds=60, activeSessionId=active,
                        targetId=target, summarize=True,
                        customInstructions='Verify mandatory thinking')
    assert moved.get('cancelled') is not True, moved


def wait_for_operation(server, scenario, sessions, timeout_seconds=90):
    """Turn-idle can precede the deferred operation and its continuation."""
    deadline = time.monotonic() + timeout_seconds
    while True:
        assert server.error is None, server.error
        bodies = [row['body'] for row in server.requests]
        probe_ready = any(line.startswith(MARKER)
            for body in bodies for message in body.get('messages', [])
            if message.get('role') == 'tool'
            for text in texts(message.get('content')) for line in text.splitlines())
        scheduled = ({'scheduled': True} if scenario == 'branch' else
                     probe_from(bodies, MARKER) if probe_ready else None)
        entries = []
        complete = True
        for path in sessions.rglob('*.jsonl'):
            try:
                data = path.read_bytes()
            except FileNotFoundError:
                complete = False  # Listed inode retired before the read.
                break
            # Both writers terminate persisted records with a newline. Do not
            # decode an in-flight tail, which may even split a UTF-8 character.
            # Malformed complete records and other I/O errors remain failures.
            if data and not data.endswith(b'\n'):
                complete = False
                break
            entries.extend(json.loads(line) for line in data.splitlines() if line.strip())
        outcomes = [entry for entry in entries if
                    (scenario == 'compact' and entry.get('type') == 'compaction') or
                    (scenario == 'refine' and entry.get('customType') == 'refinement_outcome') or
                    (scenario == 'branch' and entry.get('type') == 'branch_summary')]
        if scheduled is not None and complete and outcomes:
            return scheduled, outcomes
        if time.monotonic() >= deadline:
            raise AssertionError('timed out waiting for current scheduled probe and durable '
                                 + scenario + ' outcome')
        threading.Event().wait(0.025)


def run_case(binary, scenario, root, observation):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp'):
        (root / name).mkdir(parents=True)
    agent, sessions, cwd = root / 'agent', root / 'sessions', root / 'work'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
           'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON') if key in os.environ}
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1',
               PI_OFFLINE='1', PI_CODING_AGENT_DIR=str(agent),
               PRIME_AGENT_CODING_AGENT_DIR=str(agent), PI_SESSION_DIR=str(sessions),
               PRIME_AGENT_SESSION_DIR=str(sessions), XDG_CONFIG_HOME=str(root / 'config'),
               XDG_CACHE_HOME=str(root / 'cache'), XDG_DATA_HOME=str(root / 'data'),
               PYTHONPATH=skill_pythonpath())
    env[TAG] = str(root)
    server = Server(scenario)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        # The custom loader honors provider-level compat (it ignores model-level
        # compat). Require the exact zai wire toggle, not another adapter's format.
        'compat': {'thinkingFormat': 'zai'},
        'baseUrl': 'http://127.0.0.1:%s/v1' % server.server_address[1],
        'models': [{'id': 'mandatory-fixture', 'name': 'Mandatory thinking fixture',
                    'reasoning': True, 'input': ['text'], 'contextWindow': 128000,
                    'maxTokens': 8192,
                    'thinkingLevelMap': {'off': None, 'minimal': None, 'low': 'low',
                                         'medium': None, 'high': 'high', 'xhigh': None, 'max': 'max'}}]}}}))
    (agent / 'settings.json').write_text(json.dumps({
        'defaultProvider': 'fixture', 'defaultModel': 'mandatory-fixture',
        'prewarmPythonKernel': False, 'compaction': {'enabled': False, 'keepRecentTokens': 100,
                                                   'reserveTokens': 1024},
        'autoRefine': {'enabled': False}}))
    socket_path = root / 'daemon.sock'
    scope = OwnedProcesses(binary, root, socket_path)
    process = client = None
    primary_error = None
    log = (root / 'daemon.log').open('wb')
    try:
        observation['version'] = invoke([str(binary), '--version'], cwd, env)
        command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(socket_path)]
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
                                   stderr=log, start_new_session=True)
        scope.register(process, command)
        client = KernelClient(socket_path, process)
        observation['daemon_hello'] = client.hello
        created = client.call('create', config={
            'cwd': str(cwd), 'agentDir': str(agent), 'sessionDir': str(sessions),
            'provider': 'fixture', 'model': 'mandatory-fixture', 'thinkingLevel': 'low',
            'telemetryDisabled': True, 'noExtensions': True, 'noContextFiles': True})
        active = created.get('activeSessionId') or created.get('id')
        assert active, created
        for message in ('Seed the fixture.', 'Schedule the requested auxiliary operation.'):
            client.call('prompt_and_wait', timeout_seconds=90,
                        activeSessionId=active, message=message)
        assert server.error is None, server.error
        if scenario == 'branch':
            session_files = list(sessions.rglob('*.jsonl'))
            assert len(session_files) == 1, session_files
            summarize_branch(client, active, session_files[0])
        scheduled, outcomes = wait_for_operation(server, scenario, sessions)
        observation['scheduled'] = scheduled
        assert scheduled.get('scheduled') is True, scheduled
        auxiliary = [row['body'] for row in server.requests if row['auxiliary']]
        assert auxiliary, 'scheduled operation made no auxiliary provider request'
        controls = [{key: body[key] for key in ('enable_thinking', 'thinking', 'reasoning_effort',
                    'reasoning', 'chat_template_kwargs') if key in body} for body in auxiliary]
        expected = {'enable_thinking': True}
        assert all(control == expected for control in controls), {'expected': expected, 'actual': controls}
        observation.update(controls=controls, outcome_count=len(outcomes), tool_name=server.tool_name)
        return {'scheduled': scheduled['scheduled'], 'completed': bool(outcomes)}
    except BaseException as error:
        primary_error = error
        observation['primary_error'] = str(error)
        raise
    finally:
        observation['requests'] = server.requests
        observation['daemon_wire'] = list(client.wire) if client else []
        # Owning the supervisor gives an acknowledged shutdown before temporary files vanish.
        finish(scope, client, process, observation)
        log.close()
        observation['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-6000:]
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive(), 'fixture provider did not stop'
        if not observation['cleanup_verified'] and primary_error is None:
            raise AssertionError('fixture cleanup failed: ' + observation['cleanup_error'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'runs': {},
              'scope': 'Compaction, branch summary, and refinement auxiliary requests enable mandatory thinking; no frame claim.',
              'fixture_compat_scope': 'Provider-level zai compat; model-level compat is not relied on.',
              'check': 'Each operation schedules and persists a completed outcome. Every captured auxiliary request must match the exact expected control; request counts and full bodies remain in runs.'}
    try:
        assert sys.platform == 'linux', 'requires Linux hosted CI'
        binary = Path(os.environ['PA_RUST_BINARY']).resolve()
        result['binary'] = {'path': str(binary), 'sha256': digest(binary)}
        with tempfile.TemporaryDirectory(prefix='minimum-reasoning-check-') as temp:
            for scenario in ('compact', 'branch', 'refine'):
                observation = result['runs'][scenario] = {}
                run_case(binary, scenario, Path(temp) / scenario, observation)
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
