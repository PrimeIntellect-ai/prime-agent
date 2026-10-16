#!/usr/bin/env python3
"""Capture mandatory-thinking summary/refiner requests from real TS/Rust binaries.

The pinned TS v0.9.8 release and the current Rust binary run identical Python
cells through their offered REPL tool. Only auxiliary request thinking controls
are compared, recording TS summary thinking-off as the intended correction:
prompt wording, token budgets, and whole UI/frame parity are not
claimed. Branch summary uses an owned daemon and its real navigate_tree command.
All providers, homes, sessions, and subprocesses belong to this fixture.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import sys
import socket
import subprocess
import time
import tempfile
import threading

from review_goal_backoff_parity import TS_ARCHIVE_SHA256, sha256
from review_restore_notice_parity import invoke, probe_from
from review_draft_disconnect_parity import stop

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


def summarize_branch(binary, root, cwd, env, session_file, observation):
    entries = [json.loads(line) for line in session_file.read_text().splitlines()]
    target = next(row['id'] for row in entries
                  if row.get('type') == 'message' and row.get('message', {}).get('role') == 'assistant')
    path = root / 'daemon.sock'
    with (root / 'daemon.log').open('wb') as log:
        process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(path)],
                                   cwd=cwd, env=env, stdout=log, stderr=log, start_new_session=True)
        connection = None
        try:
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                assert process.poll() is None, 'owned daemon exited before socket readiness'
                try:
                    connection = socket.socket(socket.AF_UNIX)
                    connection.settimeout(60)
                    connection.connect(str(path))
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    connection.close()
                    connection = None
                    threading.Event().wait(0.05)
            assert connection is not None, 'owned daemon socket never became ready'
            with connection.makefile('rb') as reader:
                hello = json.loads(reader.readline())
                assert hello.get('type') == 'daemon_hello', hello
                observation['daemon_hello'] = hello
                def command(identifier, payload):
                    connection.sendall((json.dumps({'type': 'command', 'id': identifier,
                        'protocol': hello['protocol'], 'command': payload}) + '\n').encode())
                    deadline = time.monotonic() + 60
                    while time.monotonic() < deadline:
                        line = reader.readline()
                        assert line, 'owned daemon closed before response'
                        row = json.loads(line)
                        observation.setdefault('daemon_wire', []).append(row)
                        if row.get('type') == 'response' and row.get('id') == identifier:
                            assert row.get('success') is True, row
                            return row
                    raise TimeoutError('no response for ' + identifier)
                created = command('create', {'type': 'create', 'sessionPath': str(session_file),
                    'config': {'cwd': str(cwd), 'sessionDir': str(session_file.parent)}})
                active = created['data'].get('id') or created['data'].get('sessionId')
                assert active, created
                moved = command('branch', {'type': 'navigate_tree', 'activeSessionId': active,
                    'targetId': target, 'summarize': True,
                    'customInstructions': 'Verify mandatory thinking'})
                assert moved.get('data', {}).get('cancelled') is not True, moved
        finally:
            if connection is not None:
                connection.close()
            stop(process)
            observation['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')


def run_case(binary, label, scenario, root, observation):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp'):
        (root / name).mkdir(parents=True)
    agent, sessions, cwd = root / 'agent', root / 'sessions', root / 'work'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
           'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON') if key in os.environ}
    library = Path(os.environ['PI_PACKAGE_DIR']) / 'skills'
    paths = sorted(str(path) for path in library.glob('*/src') if path.is_dir())
    for skill in ('compact', 'refine'):
        assert (library / skill / 'src' / skill / '__init__.py').is_file(), skill + ' skill missing'
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1', PRIME_AGENT_TELEMETRY_ORIGIN='test',
               PI_OFFLINE='1', PI_CODING_AGENT_DIR=str(agent),
               PRIME_AGENT_CODING_AGENT_DIR=str(agent), PI_SESSION_DIR=str(sessions),
               PRIME_AGENT_SESSION_DIR=str(sessions), XDG_CONFIG_HOME=str(root / 'config'),
               XDG_CACHE_HOME=str(root / 'cache'), XDG_DATA_HOME=str(root / 'data'),
               PYTHONPATH=os.pathsep.join(paths))
    if label == 'ts':
        env['PI_PACKAGE_DIR'] = os.environ['PI_PACKAGE_DIR']
    server = Server(scenario)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        # Provider-level compat is supported by both loaders. TS also merges
        # model-level compat; Rust's existing custom loader ignores that field.
        # Keep this fixture on their common configuration surface and require
        # the exact zai wire toggle, without accepting another adapter's format.
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
    command = [str(binary), '--mode', 'json', '--provider', 'fixture', '--model',
               'mandatory-fixture', '--thinking', 'low', '--session-dir', str(sessions),
               'Seed the fixture.', 'Schedule the requested auxiliary operation.']
    try:
        observation['version'] = invoke([str(binary), '--version'], cwd, env)
        observation['process'] = invoke(command, cwd, env)
        assert server.error is None, server.error
        bodies = [row['body'] for row in server.requests]
        if scenario == 'branch':
            session_files = list(sessions.rglob('*.jsonl'))
            assert len(session_files) == 1, session_files
            summarize_branch(binary, root, cwd, env, session_files[0], observation)
            scheduled = {'scheduled': True}
        else:
            scheduled = probe_from(bodies, MARKER)
        observation['scheduled'] = scheduled
        assert scheduled.get('scheduled') is True, scheduled
        auxiliary = [row['body'] for row in server.requests if row['auxiliary']]
        assert auxiliary, 'scheduled operation made no auxiliary provider request'
        controls = [{key: body[key] for key in ('enable_thinking', 'thinking', 'reasoning_effort',
                    'reasoning', 'chat_template_kwargs') if key in body} for body in auxiliary]
        expected = {'enable_thinking': label == 'rust' or scenario == 'refine'}
        assert all(control == expected for control in controls), {'expected': expected, 'actual': controls}
        # A scheduled cell alone is insufficient: check the persisted operation result.
        entries = [json.loads(line) for path in sessions.rglob('*.jsonl')
                   for line in path.read_text().splitlines() if line.strip()]
        outcomes = [entry for entry in entries if
                    (scenario == 'compact' and entry.get('type') == 'compaction') or
                    (scenario == 'refine' and entry.get('customType') == 'refinement_outcome') or
                    (scenario == 'branch' and entry.get('type') == 'branch_summary')]
        assert outcomes, 'no durable completed ' + scenario + ' outcome'
        observation.update(controls=controls, outcome_count=len(outcomes), tool_name=server.tool_name)
        return {'scheduled': scheduled['scheduled'], 'completed': bool(outcomes)}
    finally:
        observation['requests'] = server.requests
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'runs': {},
              'scope': 'Compaction, branch summary, and refinement auxiliary thinking controls; no frame parity claim.',
              'intended_difference': 'TS v0.9.8 compaction and branch summary requests disable zai thinking; Rust enables mandatory thinking. Refinement enables thinking in both.',
              'fixture_compat_scope': 'Provider-level zai compat used identically by both custom-model loaders; model-level compat is not relied on.',
              'comparison': 'Both schedule and persist completed outcomes. Every captured auxiliary request must match the exact expected control; request counts and full bodies remain in runs.'}
    try:
        assert sys.platform == 'linux', 'requires Linux hosted CI and pinned Linux TS binary'
        archive_hash = sha256(os.environ['PA_TS_ARCHIVE'])
        assert archive_hash == TS_ARCHIVE_SHA256, 'TS archive hash mismatch'
        result['ts_release_archive_sha256'] = archive_hash
        binaries = {label: Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                    for label in ('ts', 'rust')}
        result['binaries'] = {label: {'path': str(path), 'sha256': sha256(path)}
                              for label, path in binaries.items()}
        with tempfile.TemporaryDirectory(prefix='minimum-reasoning-parity-') as temp:
            for scenario in ('compact', 'branch', 'refine'):
                results = {}
                for label, binary in binaries.items():
                    observation = {}
                    result['runs'][scenario + '_' + label] = observation
                    results[label] = run_case(binary, label, scenario,
                                             Path(temp) / scenario / label, observation)
                assert results['ts'] == results['rust'], results
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
