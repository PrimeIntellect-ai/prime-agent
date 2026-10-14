#!/usr/bin/env python3
"""Compare real TS/Rust resume behavior, recording #3525's intended notice addition.

Runs the same setup, resume, and acknowledgement fixture against the pinned TS 0.9.8 release and Rust.
Both must revive a namespace while resetting cwd/env; Rust alone must disclose
that reset. Notice parity excludes the exact added sentence, requires the shared
baseline names to survive, and allows Rust-only names that this workspace's own
bundled skills contribute (the pinned reference predates them).
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
import time

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


NAMES_MARKER = 'These names are available again: '


def names_of(notice: str) -> tuple[list[str], str]:
    """Split one restore notice into its restored-names list and normalized text."""
    prefix, _, rest = notice.partition(NAMES_MARKER)
    listing, terminator, tail = rest.partition('.')
    names = [name.strip() for name in listing.split(',') if name.strip()]
    normalized = prefix + NAMES_MARKER + '<names>' + terminator + tail
    return names, normalized


def _skill_packages(skills_root: Path) -> set[str]:
    names: set[str] = set()
    if skills_root.is_dir():
        for package in skills_root.glob('*/src/*'):
            if package.is_dir() and (package / '__init__.py').is_file():
                names.add(package.name)
    return names


def bundled_python_imports(repo_root: Path, ts_package_dir: Path | None = None) -> set[str]:
    """Rust-workspace-bundled skill packages the pinned TS package lacks.

    The pinned TS reference predates skills bundled only in the Rust
    workspace, so the Rust kernel can restore names the reference never
    imported; this derivation names exactly those packages - packages the
    reference also bundles stay under the shared-baseline subset check -
    so an undeclared restored global still fails the verifier. With no
    ts_package_dir (a local run) the whole workspace set is the allowance.
    """
    workspace = _skill_packages(repo_root / 'skills')
    if ts_package_dir is None:
        return workspace
    return workspace - _skill_packages(ts_package_dir / 'skills')


def compare_notices(ts_notice: str, rust_notice: str, allowed: set[str]) -> dict:
    """Validate the notice pair: shared baseline survives, extras declared, text equal modulo names."""
    assert NAMES_MARKER in ts_notice and NAMES_MARKER in rust_notice, 'restore names marker missing'
    ts_names, ts_normalized = names_of(ts_notice)
    rust_notice = rust_notice.removesuffix('\n' + RESET)
    rust_names, rust_normalized = names_of(rust_notice)
    additional = sorted(set(rust_names) - set(ts_names))
    assert set(ts_names) <= set(rust_names), 'shared baseline names missing from the Rust notice'
    assert set(additional) <= set(allowed), 'undeclared additional Rust notice names: %r' % additional
    assert rust_normalized == ts_normalized, 'additional notice difference'
    return {'restored_names': {'ts': ts_names, 'rust': rust_names},
            'additional_rust_names': additional,
            'bundled_python_imports': sorted(allowed)}


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


def run_case(binary, label, root, observation):
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
    # Both runtimes receive the same fixture skill library through PYTHONPATH;
    # the Rust binary additionally bundles this workspace's own skills, whose
    # restored names the pinned reference cannot have — the allowance for those
    # is derived and bounded in compare_notices.
    library = Path(os.environ['PI_PACKAGE_DIR']) / 'skills'
    skill_paths = sorted(str(path) for path in library.glob('*/src') if path.is_dir())
    env['PYTHONPATH'] = os.pathsep.join(skill_paths + [env.get('PYTHONPATH', '')])
    observation['fixture_pythonpath'] = env['PYTHONPATH']
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
        # TS queues a restore triggered by the first cell for the next user turn
        # (sendCustomMessage(nextTurn), consumed during prompt preparation).
        # Submit the same acknowledgement prompt to both binaries and record
        # every request, including any pre-existing delivery-timing difference.
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
        assert (RESET in stored_notice) == (label == 'rust'), stored_notice
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
    binaries = {label: Path(os.environ['PA_' + label.upper() + '_BINARY']).resolve()
                for label in ('ts', 'rust')}
    assert sys.platform == 'linux', 'requires Linux hosted CI'
    archive_hash = sha256(os.environ['PA_TS_ARCHIVE'])
    assert archive_hash == TS_ARCHIVE_SHA256, 'TS release archive hash mismatch'
    result = {'ts_release_archive_sha256': archive_hash,
              'binaries': {label: {'path': str(path), 'sha256': sha256(path)}
                           for label, path in binaries.items()},
              'intended_difference': RESET,
              'tool_name_normalization': 'Select offered python_repl or legacy ipython; identical cell code.',
              'fixture_prerequisites': [
                  'Wait for observable nonempty debounced snapshot before setup final answer in both binaries.',
                  'Existing Rust print shutdown disposes descendants but does not await root snapshot; no disposal parity claimed.',
                  'Both kernels receive the same pinned TS skills/src library via PYTHONPATH; this is fixture setup, not a production namespace claim.'],
              'names_normalization': 'The pinned TS reference predates skills bundled only in the Rust workspace: the shared baseline must survive (every TS name in the Rust names list) while the Rust binary\'s own bundled skills may add names; the notice text compares with the names segment normalized, and additional Rust names are recorded as additional_rust_names.',
              'runs': {}, 'verified': False}
    try:
        with tempfile.TemporaryDirectory(prefix='restore-notice-parity-') as temp:
            for label, binary in binaries.items():
                observation = {}
                result['runs'][label] = observation
                try:
                    observation.update(run_case(binary, label, Path(temp) / label, observation))
                except Exception as error:
                    observation['error'] = str(error)
        ts, rust = result['runs']['ts'], result['runs']['rust']
        errors = {label: run['error'] for label, run in result['runs'].items() if 'error' in run}
        assert not errors, errors
        ts_package_dir = os.environ.get('PI_PACKAGE_DIR')
        allowed = bundled_python_imports(
            Path(__file__).resolve().parents[1],
            Path(ts_package_dir) if ts_package_dir else None,
        )
        result.update(compare_notices(ts['notice'], rust['notice'], allowed))
        assert rust['restored'] == ts['restored'], 'restored state differs'
        assert rust['request_counts'] == ts['request_counts'] == {'setup': 2, 'resume': 3}
        result['notice_timing_equal'] = ts['notice_request_numbers'] == rust['notice_request_numbers']
        result['timing_scope'] = ('Observed, not normalized: #3525 changes only notice_content and its tests; '
                                  'kernel boot and next-turn queue timing are unchanged from base Rust. '
                                  'Both binaries must deliver the notice by the acknowledgement prompt.')
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
