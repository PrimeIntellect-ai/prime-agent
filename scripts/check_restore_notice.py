#!/usr/bin/env python3
"""Check real resume behavior and #3525's restore notice.

Runs a setup, resume, and acknowledgement fixture. The binary must revive a
namespace while resetting cwd/env, and the notice must disclose that reset.
All provider traffic, homes, sessions, and subprocesses belong to this fixture.
"""
import argparse
import http.server
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time

from lifecycle_lib import digest, skill_pythonpath

RESET = ("The working directory and environment variables were reset to the session defaults; "
         "re-apply any os.chdir(...) or os.environ[...] changes you still need.")
PROBE = "RESTORE_PARITY_RESULT="
SKILL_PROBE = 'HEADLESS_SKILL_AVAILABILITY='
SKILLS = {'agent-message': 'agent_message', 'agent-observe': 'agent_observe',
          'rlm-heartbeat': 'rlm_heartbeat'}
SETUP = """print('HEADLESS_SKILL_AVAILABILITY=' + __import__('json').dumps({name: name in globals() for name in ('agent_message', 'agent_observe', 'rlm_heartbeat')}))
# Explicit equal fixture imports isolate restore from the deliberate headless skill gate.
import agent_observe, rlm_heartbeat
import os
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

    def __init__(self, root):
        super().__init__(('127.0.0.1', 0), Handler)
        self.phase = 'setup'
        self.requests = {'setup': [], 'resume': []}
        self.tool_names = {}
        self.root = root
        self.snapshot_ready = False


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
                self.send_error(422, 'No supported Python REPL tool offered')
                return
            self.server.tool_names[self.server.phase] = name
            delta = {'tool_calls': [{'index': 0, 'id': 'call_' + self.server.phase,
                     'type': 'function', 'function': {'name': name,
                     'arguments': json.dumps({'code': SETUP if self.server.phase == 'setup' else READ})}}]}
            finish = 'tool_calls'
        else:
            if self.server.phase == 'setup':
                # Observe the real debounced snapshot before ending either process.
                # Rust's existing print shutdown only disposes descendant kernels;
                # the fixture does not claim root shutdown/flush parity.
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    paths = list(self.server.root.rglob('kernel-state.dill'))
                    if any(path.stat().st_size > 0 for path in paths):
                        self.server.snapshot_ready = True
                        break
                    threading.Event().wait(0.025)
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



def skill_availability(requests):
    preimports = probe_from(requests, SKILL_PROBE)
    system = '\n'.join(text for message in requests[0].get('messages', [])
                       if message.get('role') == 'system'
                       for text in texts(message.get('content')))
    inventory = re.search(r'<available_skills>(.*?)</available_skills>', system, re.S)
    assert inventory, 'missing actual model-visible skill inventory'
    names = set(re.findall(r'<name>(.*?)</name>', inventory.group(1)))
    return {'preimports': preimports,
            'model_visible': {name: name in names for name in SKILLS}}


def validate_skill_availability(actual):
    """Print mode hides the unwired agent-observe and rlm-heartbeat skills."""
    assert actual == {
        'preimports': {'agent_message': True, 'agent_observe': False, 'rlm_heartbeat': False},
        'model_visible': {'agent-message': True, 'agent-observe': False, 'rlm-heartbeat': False}}, actual


def run_case(binary, root, observation):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp'):
        (root / name).mkdir(parents=True)
    cwd, agent, sessions = root / 'work', root / 'agent', root / 'sessions'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
           'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON') if key in os.environ}
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1',
               PI_OFFLINE='1', PI_CODING_AGENT_DIR=str(agent),
               PRIME_AGENT_CODING_AGENT_DIR=str(agent), PI_SESSION_DIR=str(sessions),
               PRIME_AGENT_SESSION_DIR=str(sessions), XDG_CONFIG_HOME=str(root / 'config'),
               XDG_CACHE_HOME=str(root / 'cache'), XDG_DATA_HOME=str(root / 'data'),
               PYTHONPATH=skill_pythonpath())
    server = Server(root)
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
        observation.update(setup_stdout=setup['stdout'], setup_stderr=setup['stderr'],
                           setup_requests=server.requests['setup'],
                           snapshot_ready_before_setup_completion=server.snapshot_ready)
        observation['skill_availability'] = skill_availability(server.requests['setup'])
        setup_probe = probe_from(server.requests['setup'], 'RESTORE_PARITY_SETUP=')
        observation['setup'] = setup_probe
        assert setup_probe == {'cwd': str(cwd / 'moved'), 'env': 'changed'}, setup_probe
        session_files = list(sessions.rglob('*.jsonl'))
        session_files = [p for p in session_files if json.loads(p.read_text().splitlines()[0]).get('type') == 'session']
        assert len(session_files) == 1, 'expected one persisted session: %s' % session_files
        snapshots = list(root.rglob('kernel-state.dill'))
        assert len(snapshots) == 1 and snapshots[0].stat().st_size, 'setup did not persist a kernel snapshot'
        assert server.snapshot_ready, 'debounced snapshot never became ready before setup completion'
        assert not notices_in(server.requests['setup'][0]), 'fresh session emitted a restore notice'
        server.phase = 'resume'
        resume = invoke(command + ['--resume', str(session_files[0]), 'Read the restored state.',
                                   'Acknowledge the restore notice.'], cwd, env)
        observation.update(setup_stdout=setup['stdout'], resume_stdout=resume['stdout'],
                           stderr={'setup': setup['stderr'], 'resume': resume['stderr']},
                           request_sequence={phase: [{'number': i + 1,
                               'roles': [m.get('role') for m in body.get('messages', [])],
                               'restore_notices': notices_in(body)}
                               for i, body in enumerate(requests)]
                               for phase, requests in server.requests.items()})
        actual = probe_from(server.requests['resume'], PROBE)
        assert actual == {'marker': 'namespace-survived', 'cwd': str(cwd), 'env': None}, actual
        # A restore triggered by the first cell is queued for the next user turn;
        # the acknowledgement prompt must carry it. Every request is recorded.
        notice_request_numbers = [i + 1 for i, body in enumerate(server.requests['resume'])
                                  if notices_in(body)]
        notices = notices_in(server.requests['resume'][-1])
        assert len(notices) == 1, 'restore notice missing from acknowledgement request: %s' % notices
        notice = notices[0]
        assert 'revived from your previous session' in notice and 'restore_parity_marker' in notice, notice
        # Persisted/renderable notice is inspected separately from the provider request.
        entries = [json.loads(line) for line in session_files[0].read_text().splitlines()]
        stored = [row for row in entries if row.get('customType') == 'ipython_state_restored']
        assert len(stored) == 1 and stored[0].get('display') is True, stored
        stored_notice = '\n'.join(texts(stored[0].get('content')))
        assert stored_notice in notice, 'provider must receive the persisted notice'
        assert RESET in stored_notice, stored_notice
        return {'version': version['stdout'].strip(), 'setup': setup_probe,
                'restored': {**actual, 'cwd': '<session-cwd>'},
                'notice': stored_notice, 'notice_request_numbers': notice_request_numbers,
                'request_sequence': observation['request_sequence'],
                'offered_repl_tool_names': server.tool_names,
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
    binary = Path(os.environ['PA_RUST_BINARY']).resolve()
    assert sys.platform == 'linux', 'requires Linux hosted CI'
    result = {'binary': {'path': str(binary), 'sha256': digest(binary)},
              'tool_name_normalization': 'Select offered python_repl or legacy ipython.',
              'fixture_prerequisites': [
                  'Wait for observable nonempty debounced snapshot before setup final answer.',
                  'Print shutdown disposes descendants but does not await root snapshot.',
                  'Initial preimports and prompt inventory are asserted before explicit restore imports.'],
              'run': {}, 'verified': False}
    try:
        with tempfile.TemporaryDirectory(prefix='restore-notice-check-') as temp:
            observation = result['run']
            observation.update(run_case(binary, Path(temp) / 'rust', observation))
        validate_skill_availability(observation['skill_availability'])
        assert observation['request_counts'] == {'setup': 2, 'resume': 3}, observation['request_counts']
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
