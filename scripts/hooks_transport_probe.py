#!/usr/bin/env python3
"""Offline hook transport verifier; uses built binaries and the existing faux provider.

Example:
  python3 scripts/hooks_transport_probe.py --cli target/debug/prime-agent \
    --daemon target/debug/pa-daemon --output /tmp/hooks-transport.json
No builds, dependencies, real credentials, external services, or host configuration.
Headless timing is process-cold/warm-cache wall time, never OS-cache-cold.
The optional --first-paint mode measures a separate private PTY render milestone.
"""
import argparse
import hashlib
import fcntl
import json
import os
from pathlib import Path
import queue
import pty
import selectors
import signal
import socket
import statistics
import struct
import subprocess
import tempfile
import termios
import threading
import time

TIMEOUT = 30


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def write_json(path, value):
    path.write_text(json.dumps(value))


LIFECYCLE_MARKERS = {'SessionStart': 'start.json', 'UserPromptSubmit': 'prompt.json',
                     'Stop': 'stop.json', 'SessionEnd': 'end.json'}


def add_lifecycle_hooks(config):
    for event, marker in LIFECYCLE_MARKERS.items():
        config['hooks'][event] = [{'hooks': [{'type': 'command',
            'command': 'cat > ' + marker, 'timeout': 2}]}]
    return config


def install_startup_guard(fixture):
    source = fixture.cwd / '.prime/hooks.json'
    write_json(source, {'hooks': {'SessionStart': [{'hooks': [{
        'type': 'command', 'command': 'printf started > startup-hook-ran; sleep 60',
        'timeout': 2}]}]}})
    digest = hashlib.sha256(os.fsencode(source.resolve()) + b'\0' +
                            os.fsencode(fixture.cwd.resolve()) + b'\0' + source.read_bytes()).hexdigest()
    write_json(fixture.agent / 'hook-trust.json', {'version': 1, 'trusted': [digest]})


class Fixture:
    def __init__(self, root, hooks):
        # Resolve macOS /tmp before session lease acquisition; lexical paths
        # change after a missing parent is created and invalidate that lease.
        root = root.resolve()
        self.root = root
        self.cwd = root / 'project'
        self.agent = root / 'agent'
        self.cwd.mkdir()
        self.agent.mkdir(mode=0o700)
        (self.agent / 'sessions').mkdir()
        (self.cwd / '.git').mkdir()
        (self.cwd / '.prime').mkdir()
        (self.cwd / 'edit.txt').write_text('before\n')
        self.script = root / 'script.json'
        write_json(self.script, {'responses': [
            {'content': [
                {'type': 'toolCall', 'id': 'hook-denied-call', 'name': 'bash',
                 'arguments': {'command': 'printf unsafe > forbidden-marker'}},
                {'type': 'toolCall', 'id': 'hook-observed-call', 'name': 'edit',
                 'arguments': {'path': 'edit.txt', 'edits': [{'oldText': 'before', 'newText': 'after'}]}},
            ]},
            {'text': 'transport complete', 'delayMs': 250},
        ]})
        if hooks:
            source = self.cwd / '.prime/hooks.json'
            write_json(source, add_lifecycle_hooks({'hooks': {
                'PreToolUse': [{'matcher': '^Bash$', 'hooks': [{'type': 'command',
                    'command': 'cat > pre.json; printf transport-veto >&2; exit 2', 'timeout': 3}]}],
                'PostToolUse': [{'matcher': '^edit$', 'hooks': [{'type': 'command',
                    'command': 'cat > post.json', 'timeout': 3, 'async': True}]}],
            }}))
            digest = hashlib.sha256(os.fsencode(source.resolve()) + b'\0' +
                                    os.fsencode(self.cwd.resolve()) + b'\0' + source.read_bytes()).hexdigest()
            write_json(self.agent / 'hook-trust.json', {'version': 1, 'trusted': [digest]})
        self.env = os.environ.copy()
        for key in ('PRIME_AGENT_AGENT_DIR', 'PRIME_AGENT_SESSION_DIR',
                    'PRIME_AGENT_CODING_AGENT_SESSION_DIR', 'PRIME_AGENT_MODEL',
                    'PRIME_AGENT_MODEL_PROVIDER', 'PRIME_AGENT_HOOK_ACTIVE', 'RLM_DEPTH'):
            self.env.pop(key, None)
        self.env.update(PRIME_AGENT_CODING_AGENT_DIR=str(self.agent),
                        PRIME_AGENT_KERNEL_PYTHON=str(root / 'nonexistent-kernel-python'),
                        DO_NOT_TRACK='1', PI_OFFLINE='1', PRIME_AGENT_FAUX_SCRIPT=self.script.read_text(),
                        PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS='1000')

    def use_daemon_tools(self):
        # Real daemon agent sessions expose python_repl only. Explicit invalid
        # interpreter disables bootstrap; the allowed call returns a real error.
        write_json(self.script, {'engine': 'faux', 'responses': [
            {'content': [
                {'type': 'toolCall', 'id': 'hook-denied-call', 'name': 'python_repl',
                 'arguments': {'code': 'print("denied")'}},
                {'type': 'toolCall', 'id': 'hook-observed-call', 'name': 'python_repl',
                 'arguments': {'code': 'print("allowed")'}},
            ]}, {'text': 'transport complete', 'delayMs': 250}]})
        source = self.cwd / '.prime/hooks.json'
        write_json(source, add_lifecycle_hooks({'hooks': {
            'PreToolUse': [{'matcher': '^python_repl$', 'hooks': [{'type': 'command',
                'command': 'payload=$(cat); case "$payload" in *hook-denied-call*) '
                           'printf "%s" "$payload" > pre.json; printf transport-veto >&2; exit 2;; esac',
                'timeout': 3}]}],
            'PostToolUse': [{'matcher': '^python_repl$', 'hooks': [{'type': 'command',
                'command': 'cat > post.json', 'timeout': 3, 'async': True}]}],
        }}))
        digest = hashlib.sha256(os.fsencode(source.resolve()) + b'\0' +
            os.fsencode(self.cwd.resolve()) + b'\0' + source.read_bytes()).hexdigest()
        write_json(self.agent / 'hook-trust.json', {'version': 1, 'trusted': [digest]})
        self.daemon_tools = True
        self.env['PRIME_AGENT_FAUX_SCRIPT'] = self.script.read_text()

    def verify(self, frames):
        require(not (self.cwd / 'forbidden-marker').exists(), 'denied bash executed')
        daemon_tools = getattr(self, 'daemon_tools', False)
        if not daemon_tools:
            require((self.cwd / 'edit.txt').read_text() == 'after\n', 'allowed edit did not execute')
        pre = json.loads((self.cwd / 'pre.json').read_text())
        post = json.loads((self.cwd / 'post.json').read_text())
        require(pre['hook_event_name'] == 'PreToolUse' and pre['tool_name'] == ('python_repl' if daemon_tools else 'Bash'), 'pre payload')
        require(post['hook_event_name'] == 'PostToolUse' and post['tool_name'] == ('python_repl' if daemon_tools else 'edit'), 'post payload')
        require(pre['session_id'] == post['session_id'], 'event session identity changed')
        require('tool_response' in post, 'observer missing raw tool result')
        require(post['tool_use_id'] == 'hook-observed-call', 'observer received wrong call')
        if daemon_tools:
            require('PRIME_AGENT_KERNEL_PYTHON' in json.dumps(post['tool_response']),
                    'observer did not receive the original disabled-kernel error')
        self.verify_lifecycle(pre['session_id'])
        transcripts = list(self.agent.rglob('*.jsonl'))
        raw = '\n'.join(p.read_text() for p in transcripts)
        require('hook-denied-call' in raw and 'hook-observed-call' in raw,
                'raw transcript lost original model tool calls')
        durable = Path(pre['transcript_path'])
        rows = [json.loads(line) for line in durable.read_text().splitlines()]
        denied = [row['message'] for row in rows if row.get('type') == 'message'
                  and row.get('message', {}).get('role') == 'toolResult'
                  and row['message'].get('toolCallId') == 'hook-denied-call']
        require(len(denied) == 1, 'expected one original denied tool result')
        require(denied[0]['isError'] is True, 'denial lost error flag')
        require(denied[0]['content'] == [{'type': 'text',
                'text': 'Blocked by a PreToolUse hook: transport-veto'}],
                'denial lost hook attribution or original reason')
        header = rows[0]
        require(header['id'] == pre['session_id'], 'hook identity differs from durable transcript')
        return {'pre_session_id': pre['session_id'], 'transcript_files': len(transcripts),
                'frames': len(frames), 'denied_marker_absent': True, 'observer_received_result': True,
                'lifecycle_payloads_verified': ['SessionStart', 'UserPromptSubmit', 'Stop']}


    def verify_lifecycle(self, session_id, ended=False):
        events = ['SessionEnd'] if ended else ['SessionStart', 'UserPromptSubmit', 'Stop']
        for event in events:
            payload = json.loads((self.cwd / LIFECYCLE_MARKERS[event]).read_text())
            require(payload['hook_event_name'] == event, f'{event} payload event')
            require(payload['session_id'] == session_id, f'{event} session identity')
            require(Path(payload['cwd']).resolve() == self.cwd.resolve(), f'{event} cwd')
            require('transcript_path' in payload, f'{event} missing transcript path')
            if event == 'SessionStart':
                require(payload['source'] == 'startup', 'start source')
            elif event == 'UserPromptSubmit':
                require(payload['prompt'] == 'run tools', 'submitted prompt changed')
            elif event == 'Stop':
                require(payload['stop_hook_active'] is False, 'unexpected stop continuation')
                require(payload['last_assistant_message'] == 'transport complete', 'stop text changed')
            else:
                require(payload['reason'] == 'other', 'end reason')


class Child:
    def __init__(self, argv, fixture):
        self.stderr_path = fixture.root / ('stderr-' + str(time.monotonic_ns()) + '.log')
        self.stderr = self.stderr_path.open('wb')
        self.process = subprocess.Popen(argv, cwd=fixture.cwd, env=fixture.env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, start_new_session=True)
        self.lines = queue.Queue()
        def drain():
            for line in self.process.stdout:
                self.lines.put(line)
            self.lines.put(None)
        self.reader = threading.Thread(target=drain, daemon=True)
        self.reader.start()

    def receive(self):
        line = self.lines.get(timeout=TIMEOUT)
        require(line is not None, 'child ended: ' + self.stderr_path.read_text())
        return json.loads(line)

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=5)
        self.stderr.close()
        self.reader.join(timeout=2)


class Client:
    def __init__(self, connection, private=False):
        self.connection = connection
        self.private = private
        self.frames = []
        self.counter = 0
        if isinstance(connection, socket.socket):
            connection.settimeout(TIMEOUT)
            self.reader = connection.makefile('rb')

    def receive(self):
        if isinstance(self.connection, Child):
            value = self.connection.receive()
        elif self.private:
            def exact(size):
                data = self.reader.read(size)
                require(len(data) == size, 'short private frame')
                return data
            header_size, body_size = struct.unpack('>II', exact(8))
            require(header_size + body_size < 16 * 1024 * 1024, 'oversized private frame')
            header = json.loads(exact(header_size))
            value = json.loads(exact(body_size))
            if header.get('outboundType') == 'response':
                value['id'] = header.get('requestId')
        else:
            value = json.loads(self.reader.readline())
        self.frames.append(value)
        return value

    def send(self, command):
        self.counter += 1
        request_id = str(self.counter)
        if self.private:
            header = json.dumps({'kind': 'command', 'requestId': request_id,
                                 'commandType': command['type']}).encode()
            body = json.dumps(command).encode()
            self.connection.sendall(struct.pack('>II', len(header), len(body)) + header + body)
        elif isinstance(self.connection, Child):
            self.connection.process.stdin.write((json.dumps(dict(command, id=request_id)) + '\n').encode())
            self.connection.process.stdin.flush()
        else:
            frame = {'type': 'command', 'id': request_id,
                     'protocol': {'name': 'prime-agent.daemon', 'version': 7}, 'command': command}
            self.connection.sendall((json.dumps(frame) + '\n').encode())
        return request_id

    def request(self, command):
        request_id = self.send(command)
        while True:
            response = self.receive()
            if response.get('id') == request_id:
                require(response.get('success'), 'request failed: ' + json.dumps(response))
                return response.get('data', {})

    def settled(self):
        while True:
            value = self.receive()
            if value.get('event', value).get('type') == 'agent_end':
                return

    def close(self):
        if isinstance(self.connection, socket.socket):
            self.reader.close()
            self.connection.close()


def connect(path):
    deadline = time.monotonic() + TIMEOUT
    while True:
        connection = socket.socket(socket.AF_UNIX)
        try:
            connection.connect(str(path))
            return connection
        except (FileNotFoundError, ConnectionRefusedError):
            connection.close()
            require(time.monotonic() < deadline, 'socket did not become ready')
            time.sleep(.01)


def verify_cli(binary, mode, fixture):
    fixture.use_daemon_tools()
    child = Child([binary, '--mode', 'json', '-p', 'run tools'] if mode == 'print'
                  else [binary, '--mode', 'rpc'], fixture)
    started = time.monotonic()
    frames = []
    try:
        if mode == 'print':
            while True:
                line = child.lines.get(timeout=TIMEOUT)
                if line is None:
                    break
                frames.append(json.loads(line))
            require(child.process.wait(timeout=5) == 0, child.stderr_path.read_text())
        else:
            client = Client(child)
            client.request({'type': 'get_state'})
            client.request({'type': 'prompt', 'message': 'run tools'})
            client.settled()
            frames = client.frames
        result = fixture.verify(frames)
        result['elapsed_ms'] = (time.monotonic() - started) * 1000
        if mode == 'rpc':
            child.process.stdin.close()
            require(child.process.wait(timeout=10) == 0, child.stderr_path.read_text())
        fixture.verify_lifecycle(result['pre_session_id'], ended=True)
        result['session_end_verified'] = True
        return result
    finally:
        child.close()


def verify_daemon(binary, direct, fixture):
    fixture.use_daemon_tools()
    path = fixture.root / 'daemon.sock'
    child = Child([binary, 'supervisor', '--socket', str(path), '--agent-dir', str(fixture.agent)], fixture)
    control = None
    peer = None
    started = time.monotonic()
    try:
        control = Client(connect(path))
        require(control.receive()['type'] == 'daemon_hello', 'supervisor hello')
        ready_ms = (time.monotonic() - started) * 1000
        create_at = time.monotonic()
        created = control.request({'type': 'create', 'config': {
            'cwd': str(fixture.cwd), 'sessionDir': str(fixture.agent / 'sessions'),
            'script': str(fixture.script)}})
        create_ms = (time.monotonic() - create_at) * 1000
        session_id = created.get('id', created.get('sessionId'))
        require(session_id, 'create missing session id')
        client = control
        if direct:
            ticket = control.request({'type': 'get_direct_worker_transport', 'activeSessionId': session_id})
            peer = Client(connect(Path(ticket['socketPath'])), private=True)
            peer.receive()
            peer.request(dict(type='peer_auth', purpose='session_client',
                              **{k: ticket[k] for k in ('grantId', 'token', 'workerInstanceId')}))
            client = peer
        client.request({'type': 'attach', 'activeSessionId': session_id})
        client.request({'type': 'prompt', 'activeSessionId': session_id, 'message': 'run tools'})
        client.settled()
        write_json(fixture.root / 'frames.json', client.frames)
        result = fixture.verify(client.frames)
        load_at = time.monotonic()
        client.request({'type': 'get_messages', 'activeSessionId': session_id})
        result.update(supervisor_ready_ms=ready_ms, create_ms=create_ms,
                      loaded_messages_ms=(time.monotonic() - load_at) * 1000)
        if not direct:
            # Raw create used by rlm.spawn: real child worker, no Python kernel.
            parent_payload = (fixture.cwd / 'pre.json').read_bytes()
            parent_file = Path(json.loads(parent_payload)['transcript_path'])
            child_root = fixture.root / 'child'
            child_root.mkdir()
            child_fixture = Fixture(child_root, hooks=True)
            child_fixture.use_daemon_tools()
            child_source = child_fixture.cwd / '.prime/hooks.json'
            child_config = json.loads(child_source.read_text())
            child_config['hooks'].update({
                'SessionStart': [{'hooks': [{'type': 'command', 'command': 'cat > start.json', 'timeout': 2}]}],
                'SessionEnd': [{'hooks': [{'type': 'command', 'command': 'cat > end.json', 'timeout': 2}]}],
            })
            write_json(child_source, child_config)
            child_digest = hashlib.sha256(os.fsencode(child_source.resolve()) + b'\0' +
                os.fsencode(child_fixture.cwd.resolve()) + b'\0' + child_source.read_bytes()).hexdigest()
            parent_source = fixture.cwd / '.prime/hooks.json'
            parent_digest = hashlib.sha256(os.fsencode(parent_source.resolve()) + b'\0' +
                os.fsencode(fixture.cwd.resolve()) + b'\0' + parent_source.read_bytes()).hexdigest()
            # Public config fingerprints: this fixture owns exactly these approvals.
            write_json(fixture.agent / 'hook-trust.json',
                       {'version': 1, 'trusted': [parent_digest, child_digest]})
            child_fixture.agent = fixture.agent
            child_sessions = fixture.agent / 'session-artifacts' / 'probe-child'
            child_sessions.mkdir(parents=True)
            created_child = control.request({'type': 'create', 'name': 'hook-probe-child',
                'config': {'cwd': str(child_fixture.cwd), 'sessionDir': str(child_sessions),
                    'script': str(child_fixture.script), 'childScript': str(child_fixture.script),
                    'rlmDepth': 1, 'rlmMaxDepth': 2, 'parentSessionPath': str(parent_file)},
                'runtimeMetadata': {'kind': 'subagent', 'rlmChildId': 'probe-child',
                    'parentActiveSessionId': session_id, 'parentSessionId': result['pre_session_id'],
                    'parentSessionFile': str(parent_file), 'rlmDepth': 1, 'createdAt': 0},
                'lifecycle': 'resident'})
            child_id = created_child.get('id', created_child.get('sessionId'))
            require(child_id and child_id != session_id, 'subagent worker identity reused')
            control.request({'type': 'attach', 'activeSessionId': child_id})
            control.request({'type': 'prompt', 'activeSessionId': child_id, 'message': 'child tools'})
            control.settled()
            # Codex hooks exclude depth>0 children, even with exact trusted config.
            control.request({'type': 'kill', 'activeSessionId': child_id})
            for marker in ('pre.json', 'post.json', *LIFECYCLE_MARKERS.values()):
                require(not (child_fixture.cwd / marker).exists(), f'subagent hook executed: {marker}')
            require((fixture.cwd / 'pre.json').read_bytes() == parent_payload,
                    'child hook overwrote parent payload')
            child_files = []
            for candidate in child_sessions.glob('*.jsonl'):
                lines = candidate.read_text().splitlines()
                if lines and json.loads(lines[0]).get('type') == 'session':
                    child_files.append(candidate)
            require(len(child_files) == 1, 'expected one child durable transcript')
            child_file = child_files[0]
            child_raw = child_file.read_text()
            header = json.loads(child_raw.splitlines()[0])
            require(header['type'] == 'session', 'child file is not a durable transcript')
            require(header['rlmDepth'] == 1, 'child transcript lost RLM depth')
            require(Path(header['parentSession']).resolve() == parent_file.resolve(),
                    'child transcript parent identity changed')
            require(header['id'] != result['pre_session_id'], 'child transcript identity reused')
            require('transport-veto' not in child_raw, 'child inherited parent veto')
            require('PRIME_AGENT_KERNEL_PYTHON' in child_raw, 'child missing original disabled-kernel error')
            require('hook-denied-call' in child_raw and 'hook-observed-call' in child_raw,
                    'child transcript lost original tool calls')
            result['subagent_isolation'] = {'session_id': header['id'], 'rlm_depth': 1,
                'hooks_excluded': True, 'kernel_disabled_error_preserved': True,
                'original_tool_calls_preserved': True}
        control.request({'type': 'kill', 'activeSessionId': session_id})
        fixture.verify_lifecycle(result['pre_session_id'], ended=True)
        result['session_end_verified'] = True
        return result
    finally:
        try:
            if peer:
                peer.close()
            if control:
                try:
                    control.request({'type': 'shutdown'})
                    child.process.wait(timeout=10)
                finally:
                    control.close()
        finally:
            child.close()


def timing_probe(binary, root, samples):
    fixture = Fixture(root, hooks=False)
    fixture.env['PRIME_AGENT_FAUX_SCRIPT'] = json.dumps({'responses': ['benchmark answer']})
    durations = []
    for _ in range(samples):
        started = time.monotonic()
        result = subprocess.run([binary, '-p', 'hello'], cwd=fixture.cwd, env=fixture.env,
                                capture_output=True, timeout=TIMEOUT, check=False)
        require(result.returncode == 0, result.stderr.decode(errors='replace'))
        durations.append((time.monotonic() - started) * 1000)
    sessions = list((fixture.agent / 'sessions').rglob('*.jsonl'))
    require(sessions, 'headless timing did not persist a resumable session')
    resume_times = []
    for _ in range(samples):
        started = time.monotonic()
        result = subprocess.run([binary, '--resume', str(sessions[0]), '-p', 'resume'],
                                cwd=fixture.cwd, env=fixture.env, capture_output=True,
                                timeout=TIMEOUT, check=False)
        require(result.returncode == 0, result.stderr.decode(errors='replace'))
        resume_times.append((time.monotonic() - started) * 1000)
    install_startup_guard(fixture)
    load_times = []
    for _ in range(samples):
        started = time.monotonic()
        child = Child([binary, '--mode', 'rpc', '--resume', str(sessions[0])], fixture)
        try:
            state = Client(child).request({'type': 'get_state'})
            require(state.get('messageCount', 0) > 0, 'RPC resume did not load prior messages')
            load_times.append((time.monotonic() - started) * 1000)
            require(not (fixture.cwd / 'startup-hook-ran').exists(),
                    'SessionStart ran while loading a session without a model request')
        finally:
            child.close()
    return {'session_load_ready_ms': load_times, 'hanging_startup_hook_not_run_on_load': True,
            'resume_complete_turn_ms': resume_times, 'samples_ms': durations, 'first_process_ms': durations[0],
            'warm_median_ms': statistics.median(durations[1:] or durations),
            'metric': 'headless complete-turn wall time; not first paint or OS-cache-cold'}


def first_paint_probe(binary, root, samples):
    """Read only a private PTY; never inject keystrokes into any terminal."""
    fixture = Fixture(root, hooks=False)
    install_startup_guard(fixture)
    fixture.env.update(TERM='xterm-256color', TERM_PROGRAM='hook-probe',
                       PRIME_AGENT_DAEMON_SOCKET=str(root / 'paint.sock'))
    write_json(fixture.script, {'responses': ['paint answer']})
    fixture.env['PRIME_AGENT_FAUX_SCRIPT'] = str(fixture.script)
    results = []
    for sample in range(samples):
        path = root / f'paint-{sample}.sock'
        fixture.env['PRIME_AGENT_DAEMON_SOCKET'] = str(path)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        started = time.monotonic()
        child = subprocess.Popen([binary], cwd=fixture.cwd, env=fixture.env,
                                 stdin=slave, stdout=slave, stderr=slave,
                                 preexec_fn=controlling_terminal)
        os.close(slave)
        collected = bytearray()
        selector = selectors.DefaultSelector()
        selector.register(master, selectors.EVENT_READ)
        primary_error = None
        try:
            while b'\x1b[?2026l' not in collected:
                require(time.monotonic() - started < TIMEOUT,
                        'first synchronized paint deadline; PTY tail: ' + repr(bytes(collected[-2000:])))
                for _, _ in selector.select(timeout=.1):
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        raise AssertionError('PTY ended before first paint: ' + repr(bytes(collected[-2000:]))) from error
                    require(chunk, 'PTY closed before first paint')
                    collected.extend(chunk)
                    require(len(collected) < 2 * 1024 * 1024, 'PTY output exceeded cap')
            require(b'\x1b[?1049h' in collected, 'paint marker occurred before alternate screen')
            require(not (fixture.cwd / 'startup-hook-ran').exists(),
                    'SessionStart executed before the first model request')
            results.append((time.monotonic() - started) * 1000)
        except BaseException as error:
            primary_error = error
        finally:
            # Closing the controlling PTY first releases terminal-driver waits
            # on macOS; retaining its master while waiting can stall reaping.
            selector.close()
            os.close(master)
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    # Darwin may reject group signaling while terminal hangup
                    # is already retiring the group. Reap the exact owned child.
                    pass
                child.kill()
            cleanup_error = None
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired as error:
                cleanup_error = error
            if path.exists():
                control = Client(connect(path))
                try:
                    control.receive()
                    control.request({'type': 'shutdown'})
                finally:
                    control.close()
            if cleanup_error:
                raise RuntimeError(f'PTY cleanup failed for owned pid {child.pid}; '
                                   f'original error: {primary_error!r}; '
                                   f'captured tail: {bytes(collected[-2000:])!r}') from cleanup_error
            if primary_error:
                raise primary_error
    return {'samples_ms': results, 'first_process_ms': results[0],
            'warm_median_ms': statistics.median(results[1:] or results),
            'metric': 'spawn to first synchronized alternate-screen paint; no terminal input injected'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', required=True, type=lambda p: str(Path(p).resolve()))
    parser.add_argument('--daemon', type=lambda p: str(Path(p).resolve()))
    parser.add_argument('--baseline-cli', type=lambda p: str(Path(p).resolve()))
    parser.add_argument('--samples', type=int, default=3)
    parser.add_argument('--first-paint', action='store_true', help='read a private PTY until first paint')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    require(1 <= args.samples <= 10, 'samples must be 1..10')
    report = {'offline': True, 'transports': {}, 'timing': {}}
    # Short root keeps Unix socket paths below macOS's 104-byte limit.
    with tempfile.TemporaryDirectory(prefix='hook-probe-', dir='/tmp') as temporary:
        root = Path(temporary)
        for mode in ('print', 'rpc', 'supervisor', 'direct'):
            if mode in ('supervisor', 'direct') and not args.daemon:
                continue
            directory = root / mode
            directory.mkdir()
            fixture = Fixture(directory, hooks=True)
            report['transports'][mode] = (verify_cli(args.cli, mode, fixture) if mode in ('print', 'rpc')
                                           else verify_daemon(args.daemon, mode == 'direct', fixture))
        for label, binary in [('modified', args.cli), ('baseline', args.baseline_cli)]:
            if binary:
                directory = root / ('timing-' + label)
                directory.mkdir()
                report['timing'][label] = timing_probe(binary, directory, args.samples)
                if args.first_paint:
                    paint_dir = root / ('paint-' + label)
                    paint_dir.mkdir()
                    report['timing'][label]['first_paint'] = first_paint_probe(binary, paint_dir, args.samples)
    report['not_measured'] = ['OS-cache-cold launch', 'isolated session-load CPU time',
                              'Python-kernel rlm.spawn API path', 'Linux execution']
    if not args.first_paint:
        report['not_measured'].append('TUI first paint')
    output = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(output + '\n')
    print(output)


if __name__ == '__main__':
    main()
