#!/usr/bin/env python3
"""Drive real TS/Rust REPLs through session-local/global memory CRUD and isolation.

Uses the restore-notice verifier's loopback-provider protocol and subprocess
isolation. Compares actual tool results and persisted files, not source strings.
Only volatile timestamps, fixture roots and generated session IDs are normalized.
Tool names (legacy ipython/python_repl) are selected from each binary's offer.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

from review_restore_notice_parity import invoke, texts, Server, sha256, TS_ARCHIVE_SHA256

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


def run_case(binary, label, root, observation):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp'):
        (root / name).mkdir(parents=True)
    cwd, agent, sessions = root / 'work', root / 'agent', root / 'sessions'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
           'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON', 'PYTHONPATH') if key in os.environ}
    library = Path(os.environ['PI_PACKAGE_DIR'])
    if label == 'ts':
        env['PI_PACKAGE_DIR'] = str(library)
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1',
               PI_OFFLINE='1', PI_CODING_AGENT_DIR=str(agent), PRIME_AGENT_CODING_AGENT_DIR=str(agent),
               PI_SESSION_DIR=str(sessions), PRIME_AGENT_SESSION_DIR=str(sessions),
               XDG_CONFIG_HOME=str(root / 'config'), XDG_CACHE_HOME=str(root / 'cache'),
               XDG_DATA_HOME=str(root / 'data'))
    # Common skill imports only; never inject RLM_* harness paths, which would
    # mask the missing runtime exports this PR repairs.
    env['PYTHONPATH'] = os.pathsep.join(sorted(str(p) for p in (library / 'skills').glob('*/src')
                                              if p.is_dir()) + [env.get('PYTHONPATH', '')])
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
            # The effective global destination is checked on disk below; record
            # any optional explicit global env export difference without hiding it.
            expected_global_env = str(agent / 'harness') if label == 'ts' else None
            assert probe['env']['RLM_GLOBAL_HARNESS_STATE_DIR'] == expected_global_env, probe['env']
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
    result = {'verified': False, 'runs': {}, 'normalization': [
        'Volatile created_at/updated_at timestamps only in HarnessEntry objects.',
        'Fixture roots/session IDs checked exactly within each run, then excluded from cross-run entry comparison.',
        'Select offered python_repl or legacy ipython; identical cell code.'],
        'scope': 'Actual REPL results and local/global files: CRUD, resume durability, fresh-session isolation. No TUI frame or daemon-wire parity claim.'}
    try:
        assert sys.platform == 'linux', 'requires Linux hosted CI binaries'
        result['ts_release_archive_sha256'] = sha256(os.environ['PA_TS_ARCHIVE'])
        assert result['ts_release_archive_sha256'] == TS_ARCHIVE_SHA256, 'TS archive hash mismatch'
        with tempfile.TemporaryDirectory(prefix='local-harness-parity-') as temp:
            for label in ('ts', 'rust'):
                binary = Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                observation = {'binary': str(binary), 'binary_sha256': sha256(binary)}
                result['runs'][label] = observation
                try:
                    run_case(binary, label, Path(temp) / label, observation)
                except Exception as error:
                    observation['error'] = str(error)
        errors = {label: run['error'] for label, run in result['runs'].items() if 'error' in run}
        assert not errors, errors
        ts, rust = result['runs']['ts'], result['runs']['rust']
        assert ts['probes'] == rust['probes'], 'TS/Rust memory behavior differs'
        result['global_env_exports'] = {label: {phase: run[phase]['kernel_env']['RLM_GLOBAL_HARNESS_STATE_DIR']
            for phase in ('setup', 'resume', 'other')} for label, run in result['runs'].items()}
        result['global_env_scope'] = ('Known provisioning difference: TS explicitly exports its agent/harness directory; '
            'Rust leaves RLM_GLOBAL_HARNESS_STATE_DIR unset and the common runtime resolves '
            'PRIME_AGENT_CODING_AGENT_DIR/harness. Both exact environments are asserted, '
            'and the effective global files and complete entries must match.')
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'receipt': str(args.receipt), 'verified': result['verified'], 'error': result.get('error')}))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
