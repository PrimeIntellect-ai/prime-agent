#!/usr/bin/env python3
"""Drive the real REPL through session-local/global memory CRUD and isolation.

Uses the restore-notice check's loopback-provider protocol and subprocess
isolation. Checks actual tool results and persisted files, not source strings.
Tool names (legacy ipython/python_repl) are selected from the binary's offer.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

from check_restore_notice import invoke, texts, Server
from lifecycle_lib import digest

MARKER = 'LOCAL_HARNESS_PARITY='
READ = """import os, json, dataclasses
state = rlm.get_harness_state()
def entry(value):
    if value is None:
        return None
    row = dataclasses.asdict(value)
    for key in ('created_at', 'updated_at'):
        row[key] = '<timestamp>'
    return row
result = {
    'env': {key: os.environ.get(key) for key in ('RLM_SESSION_DIR', 'RLM_HARNESS_STATE_DIR', 'RLM_GLOBAL_HARNESS_STATE_DIR')},
    'local': entry(state.get('memory', 'parity-local')),
    'global': entry(state.get('memory', 'parity-global', global_=True)),
    'deleted': entry(state.get('memory', 'parity-delete')),
    'local_ids': sorted(item.id for item in state.list('memory')),
    'global_ids': sorted(item.id for item in state.list('memory', global_=True)),
}
print('LOCAL_HARNESS_PARITY=' + json.dumps(result))"""
SETUP = """rlm.harness.create_memory(title='local initial', content='local initial body', id='parity-local')
rlm.harness.update_memory(id='parity-local', title='local updated', content='local updated body')
rlm.harness.create_memory(title='global initial', content='global initial body', id='parity-global', global_=True)
rlm.harness.update_memory(id='parity-global', title='global updated', content='global updated body', global_=True)
rlm.harness.create_memory(title='delete me', content='temporary', id='parity-delete')
assert rlm.harness.delete_memory('parity-delete') is True
rlm.harness.create_memory(title='delete global', content='temporary', id='parity-delete-global', global_=True)
assert rlm.harness.delete_memory('parity-delete-global', global_=True) is True
""" + READ


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
                     'type': 'function', 'function': {'name': name, 'arguments': json.dumps({
                         'code': SETUP if self.server.phase == 'setup' else READ})}}]}
            finish = 'tool_calls'
        else:
            delta, finish = {'content': 'Fixture complete.'}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'harness-parity', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'harness-fixture', 'choices': [{'index': 0, 'delta': delta,
                                                          'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(item) + '\n\n' for item in (
            chunk({'role': 'assistant', **delta}), chunk({}, finish))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def current_probe(requests, phase):
    """Read only this phase's completed tool call, never historical results."""
    assert requests, 'missing provider requests'
    tool_id = 'call_' + phase
    messages = requests[-1].get('messages', [])
    calls = [call for message in messages if message.get('role') == 'assistant'
             for call in message.get('tool_calls', []) if call.get('id') == tool_id]
    assert len(calls) == 1, 'missing or duplicate current phase tool call ' + tool_id
    results = [message for message in messages if message.get('role') == 'tool'
               and message.get('tool_call_id') == tool_id]
    assert len(results) == 1, 'missing or duplicate current phase tool result ' + tool_id
    probes = [json.loads(line[len(MARKER):]) for text in texts(results[0].get('content'))
              for line in text.splitlines() if line.startswith(MARKER)]
    assert len(probes) == 1, 'missing or duplicate current phase probe ' + tool_id
    return probes[0]


def stored(path):
    state = json.loads(path.read_text())
    rows = state['entries']['memory']
    for row in rows.values():
        for key in ('created_at', 'updated_at'):
            row[key] = '<timestamp>'
    return rows


def run_case(binary, root, observation):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp'):
        (root / name).mkdir(parents=True)
    cwd, agent, sessions = root / 'work', root / 'agent', root / 'sessions'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
           'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON') if key in os.environ}
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1',
               PI_OFFLINE='1', PI_CODING_AGENT_DIR=str(agent), PRIME_AGENT_CODING_AGENT_DIR=str(agent),
               PI_SESSION_DIR=str(sessions), PRIME_AGENT_SESSION_DIR=str(sessions),
               XDG_CONFIG_HOME=str(root / 'config'), XDG_CACHE_HOME=str(root / 'cache'),
               XDG_DATA_HOME=str(root / 'data'))
    # Never inject RLM_* harness paths, which would mask missing runtime exports.
    server = Server(root)
    server.RequestHandlerClass = Handler
    server.requests['other'] = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': 'http://127.0.0.1:%s/v1' % server.server_address[1],
        'models': [{'id': 'harness-fixture', 'name': 'Harness fixture', 'reasoning': False,
                    'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    (agent / 'settings.json').write_text(json.dumps({'defaultProvider': 'fixture',
        'defaultModel': 'harness-fixture', 'prewarmPythonKernel': False}))
    command = [str(binary), '--mode', 'json', '--provider', 'fixture', '--model',
               'harness-fixture', '--session-dir', str(sessions)]
    try:
        observation['version'] = invoke([str(binary), '--version'], cwd, env)['stdout'].strip()
        probes = {}
        original = None
        for phase in ('setup', 'resume', 'other'):
            server.phase = phase
            args = ['--resume', str(original)] if phase == 'resume' else []
            observation[phase] = invoke(command + args + ['Run the harness parity cell.'], cwd, env)
            observation[phase]['requests'] = server.requests[phase]
            probe = current_probe(server.requests[phase], phase)
            assert len(server.requests[phase]) == 2, 'unexpected provider request sequence'

            files = [p for p in sessions.rglob('*.jsonl')
                     if json.loads(p.read_text().splitlines()[0]).get('type') == 'session']
            if phase == 'setup':
                assert len(files) == 1, files
                original = files[0]
            current = original if phase != 'other' else next(p for p in files if p != original)
            session_id = json.loads(current.read_text().splitlines()[0])['id']
            artifact = root / 'session-artifacts' / session_id
            assert probe['env']['RLM_SESSION_DIR'] == str(artifact), probe['env']
            assert probe['env']['RLM_HARNESS_STATE_DIR'] == str(artifact / 'harness'), probe['env']
            # RLM_GLOBAL_HARNESS_STATE_DIR stays unset; the runtime resolves
            # PRIME_AGENT_CODING_AGENT_DIR/harness, checked on disk below.
            assert probe['env']['RLM_GLOBAL_HARNESS_STATE_DIR'] is None, probe['env']
            observation[phase]['kernel_env'] = probe.pop('env')
            assert probe['local_ids'] == ([] if phase == 'other' else ['parity-local']), probe
            assert probe['global_ids'] == ['parity-global'], probe
            assert probe['deleted'] is None, probe
            assert (probe['local'] is None) == (phase == 'other'), probe
            if phase != 'other':
                assert stored(artifact / 'harness' / 'harness_state.json') == {'parity-local': probe['local']}
            assert stored(agent / 'harness' / 'harness_state.json') == {'parity-global': probe['global']}
            for scope in ('local', 'global'):
                row = probe[scope]
                if row is not None:
                    assert row['scope'] == scope and row['id'] == 'parity-' + scope, row
                    assert row['title'] == scope + ' updated' and row['content'] == scope + ' updated body', row
            probes[phase] = probe
        assert probes['setup'] == probes['resume'], 'local/global CRUD did not survive resume'
        observation.update(probes=probes, offered_repl_tool_names=server.tool_names)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False,
        'tool_name_selection': 'Select offered python_repl or legacy ipython.',
        'scope': 'Actual REPL results and local/global files: CRUD, resume durability, fresh-session isolation.'}
    try:
        assert sys.platform == 'linux', 'requires Linux hosted CI binaries'
        with tempfile.TemporaryDirectory(prefix='local-harness-check-') as temp:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observation = result['run'] = {'binary': str(binary), 'binary_sha256': digest(binary)}
            try:
                run_case(binary, Path(temp) / 'rust', observation)
            except Exception as error:
                observation['error'] = str(error)
        assert 'error' not in observation, observation['error']
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(args.receipt), 'verified': result['verified'], 'error': result.get('error')}))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
