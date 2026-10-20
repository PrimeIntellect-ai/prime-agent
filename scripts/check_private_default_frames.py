#!/usr/bin/env python3
"""Actual fresh-startup model and warning captures, without inference.

Uses the shared fingerprinted authorization-cache format with synthetic key/team
and disables all external networking in a hosted-only network namespace. This
measures fresh process startup from controlled cache states, not live catalog
fetch timing. The current scoped-selection policy is characterized, not approved.
"""
import argparse
import fcntl
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

from lifecycle_lib import Screen, digest, stop
from lifecycle_lib import OwnedProcesses, TAG, finish
from check_kernel_env import KernelClient

PUBLIC = 'z-ai/glm-5.3'
PRIVATE = 'internal/glm-5.3-fast'
KEY = 'startup-fixture-key-not-a-real-credential'
TEAM = 'startup-fixture-team'
INPUT = 'STARTUP_CAPTURE_INPUT'
WARNING = 'Default model prime-inference/' + PRIVATE + ' is not available.'
DIMENSIONS = ((120, 40), (80, 28))
LIMIT = 45


def private_item():
    return {'id': PRIVATE, 'display_name': 'Private startup B',
            'pricing': {'input_usd_per_mtok': 1, 'output_usd_per_mtok': 1},
            'specs': {'context_window': 128000, 'max_output_tokens': 8192,
                      'supports_reasoning': True,
                      'modalities': {'input': ['text'], 'output': ['text']}}}


def cache_document(authorized):
    fingerprint = hmac.new(KEY.encode(),
        b'prime-agent:private-prime-authorization:v1\0' + TEAM.encode(), hashlib.sha256).hexdigest()
    return {'fingerprint': fingerprint, 'refreshedAt': int(time.time() * 1000),
            'data': [private_item()] if authorized else []}


def prepare(root, scenario):
    for name in ('home', 'agent', 'sessions', 'work', 'tmp', 'xdg'):
        (root / name).mkdir(parents=True)
    agent = root / 'agent'
    (agent / 'auth.json').write_text(json.dumps({'prime-inference': {
        'type': 'api_key', 'key': KEY, 'primeTeam': {'teamId': TEAM, 'name': 'Synthetic team'}}}))
    (agent / 'auth.json').chmod(0o600)
    (agent / 'prime-inference-private-models.json').write_text(
        json.dumps(cache_document(scenario != 'unavailable')))
    (agent / 'prime-inference-private-models.json').chmod(0o600)
    scope = [PUBLIC] if scenario == 'excluded' else [PUBLIC, PRIVATE]
    (agent / 'settings.json').write_text(json.dumps({
        'defaultProvider': 'prime-inference', 'defaultModel': PRIVATE,
        'enabledModels': ['prime-inference/' + value for value in scope],
        'prewarmPythonKernel': False, 'onboardingCompleted': True,
        'onboardingShown': True, 'telemetry': {'noticeShown': True},
        'autoRefine': {'enabled': False}}))
    (agent / 'models.json').write_text(json.dumps({'providers': {'prime-inference': {
        'api': 'openai-completions', 'baseUrl': 'https://api.pinference.ai/api/v1',
        'models': [{'id': PUBLIC, 'name': 'Public startup A',
                    'reasoning': True, 'input': ['text'],
                    'contextWindow': 128000, 'maxTokens': 8192}]}}}))
    env = {name: os.environ[name] for name in ('PATH', 'LANG', 'LC_ALL', 'TZ') if name in os.environ}
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'),
               XDG_CONFIG_HOME=str(root / 'xdg'), XDG_CACHE_HOME=str(root / 'xdg'),
               XDG_DATA_HOME=str(root / 'xdg'), TERM='xterm-256color', COLORTERM='truecolor',
               PI_CODING_AGENT_DIR=str(agent), PRIME_AGENT_CODING_AGENT_DIR=str(agent),
               PI_SESSION_DIR=str(root / 'sessions'), PRIME_AGENT_SESSION_DIR=str(root / 'sessions'),
               PI_OFFLINE='1', DO_NOT_TRACK='1')
    env[TAG] = str(root)
    return env


class Terminal:
    def __init__(self, command, cwd, env):
        self.master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~(termios.ECHO | termios.ICANON)
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave,
            stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.screen, self.raw = Screen(120, 40), bytearray()
        self.resize_events = [{'raw_offset': 0, 'columns': 120, 'rows': 40}]

    def pump(self):
        if select.select([self.master], [], [], 0.05)[0]:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                data = b''
            self.raw.extend(data)
            for reply in self.screen.feed(data):
                os.write(self.master, reply)

    def wait(self, description, predicate):
        deadline = time.monotonic() + LIMIT
        while time.monotonic() < deadline:
            self.pump()
            assert self.process.poll() is None, 'TUI exited before ' + description
            if predicate():
                return
        raise AssertionError('TUI readiness timed out: ' + description)

    def resize(self, columns, rows):
        self.resize_events.append({'raw_offset': len(self.raw), 'columns': columns, 'rows': rows})
        self.screen = Screen(columns, rows)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)

    def close(self):
        stop(self.process)
        os.close(self.master)


def write_frame(directory, name, terminal):
    text = terminal.screen.text()
    (directory / (name + '.txt')).write_text(text + '\n')
    width, height = terminal.screen.width, terminal.screen.height
    lines = ''.join('<tspan x="12" y="' + str(22 + row * 18) + '">' + html.escape(line)
                    + '</tspan>' for row, line in enumerate(text.splitlines()))
    # A readable rendering of actual captured cells; raw ANSI retains original
    # colors/attributes. This SVG is not an OS-terminal pixel screenshot.
    (directory / (name + '.svg')).write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width * 10 + 24}" height="{height * 18 + 24}">'
        '<rect width="100%" height="100%" fill="#111"/><text fill="#eee" '
        'font-family="monospace" font-size="16" xml:space="preserve">' + lines + '</text></svg>')
    return {'columns': width, 'rows': height, 'text': text,
            'raw_end_offset': len(terminal.raw),
            'warning_prefix_count': text.count('Default model prime-inference/'),
            'input_preserved': INPUT in text}


def active_worker(agent, socket_path):
    candidates = []
    for path in (agent / 'daemon-workers').rglob('*.json'):
        try:
            value = json.loads(path.read_text())
            if value.get('supervisorSocketPath') == str(socket_path):
                candidates.append(value['rootActiveSessionId'])
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            pass
    ids = set(candidates)
    assert len(ids) <= 1, 'ambiguous fixture worker identity'
    return next(iter(ids)) if ids else None


def connection_model(state):
    return state.get('model') or state.get('state', {}).get('model')


def wait_for_created_session(terminal, client, active):
    state = None

    def created():
        nonlocal state
        try:
            state = client.call('get_connection_state', activeSessionId=active)
            return True
        except AssertionError as error:
            # A descriptor identifies the spawned worker, not a completed create.
            # Only this explicit transitional response is pending readiness;
            # transport errors and every other daemon refusal still fail.
            response = error.args[0] if error.args else None
            if isinstance(response, dict) and response.get('success') is False:
                info = response.get('errorInfo') or {}
                if (response.get('error') == 'Unknown active session: ' + active
                        # The daemon reports worker lifecycle before accepting
                        # forwarded state requests.
                        or response.get('error') in ('Session worker is starting',
                            'Session worker is recovering', 'Session worker is not connected')
                        or (info.get('code') == 'session_recovering'
                            and info.get('activeSessionId') == active)):
                    return False
            raise

    terminal.wait('fresh session create completed', created)
    return state


def validate_observation(scenario, observed):
    permitted = [PUBLIC, PRIVATE] if scenario == 'authorized' else [PUBLIC]
    assert observed['selected_model'] in permitted, 'selected an unavailable or excluded model'
    available = observed['available_ids']
    assert PUBLIC in available, 'public fixture model is not available'
    assert (PRIVATE in available) == (scenario != 'unavailable'), 'authorization fixture was not adopted'
    expected_warning = scenario == 'unavailable'
    if expected_warning:
        assert observed['fallback_message'] and WARNING in observed['fallback_message'], 'missing warning on attach'
        assert 'Using prime-inference/' + observed['selected_model'] in observed['fallback_message'], 'warning names the wrong fallback'
    else:
        assert not observed['fallback_message'], 'unexpected warning on attach'
    for size, frame in observed['frames'].items():
        assert size == f"{frame['columns']}x{frame['rows']}", 'mismatched terminal dimensions'
        assert frame['input_preserved'], 'input disappeared across redraw'
        assert frame['selected_model_id_visible'], 'model state has not reached the visible startup frame'
        if frame['warning_prefix_count']:
            assert frame['warning_text_complete'], 'visible warning was clipped'
        expected = int(expected_warning) if size == '120x40' else None
        if expected is not None:
            assert frame['warning_prefix_count'] == expected, 'wrong initial visible warning count'
        else:
            assert frame['warning_prefix_count'] <= int(expected_warning), 'duplicate or unexpected resized warning'


def capture(binary, scenario, root, directory, observed):
    env = prepare(root, scenario)
    socket_path = root / 'd.sock'
    scope = OwnedProcesses(binary, root, socket_path)
    process = client = terminal = None
    primary = None
    log = (root / 'daemon.log').open('wb')
    directory.mkdir(parents=True)
    try:
        command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(socket_path)]
        process = subprocess.Popen(command, cwd=root / 'work', env=env, stdout=log,
                                   stderr=log, start_new_session=True)
        scope.register(process, command)
        client = KernelClient(socket_path, process)
        observed['hello'] = client.hello
        command = [str(binary), '--daemon-socket', str(socket_path)]
        terminal = Terminal(command, root / 'work', env)
        scope.register(terminal.process, command)
        terminal.wait('fresh worker descriptor', lambda: active_worker(root / 'agent', socket_path))
        active = active_worker(root / 'agent', socket_path)
        state = wait_for_created_session(terminal, client, active)
        attached = client.call('attach', activeSessionId=active)
        observed.update(active_session_id=active, state=state, attach=attached)
        model = connection_model(state)
        assert isinstance(model, dict) and model.get('provider') == 'prime-inference', state
        selected = model.get('id')
        observed['selected_model'] = selected
        summary = attached.get('snapshot', {}).get('summary', {})
        observed['fallback_message'] = summary.get('modelFallbackMessage')
        terminal.wait('visible startup frame', lambda: bool(terminal.screen.text().strip()))
        os.write(terminal.master, INPUT.encode())
        expected_warning = scenario == 'unavailable'
        terminal.wait('editor, selected model and startup warning', lambda: INPUT in terminal.screen.text()
            and selected in terminal.screen.text()
            and (not expected_warning or 'Default model prime-inference/' in terminal.screen.text()))
        observed['frames'] = {}
        for columns, rows in DIMENSIONS:
            if terminal.screen.width != columns:
                terminal.resize(columns, rows)
                os.write(terminal.master, b'_NARROW')
                terminal.wait('resized editor and selected model', lambda:
                    INPUT + '_NARROW' in terminal.screen.text() and selected in terminal.screen.text())
            frame = write_frame(directory, f'{columns}x{rows}', terminal)
            message = observed['fallback_message']
            frame['warning_text_complete'] = not message or ''.join(message.split()) in ''.join(frame['text'].split())
            frame['selected_model_name_visible'] = bool(model.get('name')) and model['name'] in frame['text']
            frame['selected_model_id_visible'] = selected in frame['text']
            observed['frames'][f'{columns}x{rows}'] = frame
        # Observe availability only after capturing natural startup. Refreshing
        # metadata beforehand could itself trigger a redraw or clear a notice.
        models = client.call('get_available_models', activeSessionId=active)
        observed['available_ids'] = [row['id'] for row in models['models']
                                     if row.get('provider') == 'prime-inference']
        after_refresh = client.call('get_connection_state', activeSessionId=active)
        refreshed_model = connection_model(after_refresh) or {}
        assert (refreshed_model.get('provider'), refreshed_model.get('id')) == (
            model['provider'], selected), 'catalog read retargeted the active model'
        validate_observation(scenario, observed)
        observed['warning_present_after_resize'] = observed['frames']['80x28']['warning_prefix_count'] == 1
        observed['capture_verified'] = True
    except BaseException as error:
        primary = error
        observed['error'] = str(error)
        raise
    finally:
        if terminal:
            (directory / 'terminal.ansi').write_bytes(terminal.raw)
            observed['resize_events'] = terminal.resize_events
            if 'frames' not in observed:
                observed['last_frame'] = write_frame(directory, 'failure', terminal)
            terminal.close()
        observed['wire'] = list(client.wire) if client else []
        finish(scope, client, process, observed)
        log.close()
        observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-6000:]
        if not observed['cleanup_verified'] and primary is None:
            raise AssertionError('owned startup fixture cleanup failed')


def run(args):
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
    routes = subprocess.check_output(['ip', 'route', 'show', 'default'], text=True).strip()
    routes_v6 = subprocess.check_output(['ip', '-6', 'route', 'show', 'default'], text=True).strip()
    assert not routes and not routes_v6, 'capture namespace must have no external route'
    result = {'validation_passed': False, 'runs': {}, 'network_default_route': routes,
        'network_ipv6_default_route': routes_v6,
        'scope': 'Actual fresh TUI startup against owned daemons, matched PTY dimensions, signed synthetic authorization-cache states; no inference or external networking.',
        'limits': 'Does not exercise live catalog fetch timing or OS terminal font/pixel fidelity. SVGs render captured cells; raw ANSI preserves original attributes.',
        'source': {key: os.environ.get(key) for key in ('GITHUB_RUN_ID', 'GITHUB_SHA')}}
    try:
        if os.environ.get('GITHUB_EVENT_PATH'):
            event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
            result['source']['pull_request_head_sha'] = event.get('pull_request', {}).get('head', {}).get('sha')
        binary = Path(os.environ['PA_RUST_BINARY']).resolve()
        result['binary'] = {'path': str(binary), 'sha256': digest(binary)}
        output = args.receipt.with_suffix('')
        errors = []
        with tempfile.TemporaryDirectory(prefix='pa-startup-') as temp:
            for scenario in ('authorized', 'unavailable', 'excluded'):
                observed = result['runs'][scenario] = {}
                try:
                    capture(binary, scenario, Path(temp) / scenario, output / scenario, observed)
                except Exception as error:
                    errors.append({'case': scenario, 'error': str(error)})
        assert not errors, errors
        result['validation_passed'] = True
    except BaseException as error:
        result['error'] = str(error)
        raise
    finally:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(result, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--isolated-network', action='store_true')
    args = parser.parse_args()
    args.receipt = args.receipt.resolve()
    assert sys.platform == 'linux' and os.environ.get('GITHUB_ACTIONS') == 'true', 'hosted Linux CI only'
    repo = Path(__file__).resolve().parent.parent
    assert args.receipt != repo and repo not in args.receipt.parents, 'receipt must be outside repository'
    if not args.isolated_network:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps({'validation_passed': False,
            'error': 'network namespace capture child has not completed'}) + '\n')
        names = ('PATH', 'LANG', 'LC_ALL', 'TZ', 'PA_RUST_BINARY', 'GITHUB_ACTIONS',
                 'GITHUB_RUN_ID', 'GITHUB_SHA', 'GITHUB_EVENT_PATH')
        values = [name + '=' + os.environ[name] for name in names if name in os.environ]
        return subprocess.run(['sudo', '-n', 'unshare', '--net', '/usr/bin/env', *values,
            sys.executable, str(Path(__file__).resolve()), '--isolated-network',
            '--receipt', str(args.receipt)], check=False).returncode
    run(args)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
