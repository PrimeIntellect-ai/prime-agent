#!/usr/bin/env python3
"""Real-daemon #3602 half-close check, with an owned blocked provider.

Only fixture-created daemon trees are stopped. Provider arrival, not elapsed
sleep, proves the initial turn is busy and the queued prompt actually drains.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import signal
import time
import subprocess
import tempfile
import threading

from check_agent_bounce import Client, Provider, Handler, LIMIT
from lifecycle_lib import digest, env_for, stop

FIRST = 'WRITE_CLEANUP_INITIAL_BUSY_TURN'
SECOND = 'WRITE_CLEANUP_QUEUED_SECOND_CLIENT'


class CompletionHandler(Handler):
    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with self.server.arrived:
            self.server.requests.append(body)
            self.server.arrived.notify_all()
        self.server.release.wait(LIMIT * 3)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        frames = [
            {'choices': [{'index': 0, 'delta': {'role': 'assistant',
                'content': 'Fixture turn completed.'}, 'finish_reason': None}]},
            {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
        ]
        try:
            for frame in frames:
                self.wfile.write(('data: ' + json.dumps(frame) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class RecordedIO:
    def __init__(self, inner, wire, direction):
        self.inner, self.wire, self.direction = inner, wire, direction

    def __getattr__(self, key):
        return getattr(self.inner, key)

    def sendall(self, data):
        self.wire.append({'direction': self.direction, 'utf8': data.decode()})
        return self.inner.sendall(data)

    def readline(self):
        data = self.inner.readline()
        self.wire.append({'direction': self.direction, 'utf8': data.decode()})
        return data


class WireClient(Client):
    def __init__(self, path, process):
        super().__init__(path, process)
        self.raw_wire = []
        self.sock = RecordedIO(self.sock, self.raw_wire, 'out')
        self.reader = RecordedIO(self.reader, self.raw_wire, 'in')
        self.closed = False

    def close(self):
        if not self.closed:
            super().close()
            self.closed = True


def owned_processes(root):
    """Linux hosted receipt: exact unique fixture agent-dir environment ownership."""
    expected = ('PRIME_AGENT_CODING_AGENT_DIR=' + str(root / 'agent')).encode()
    owned = []
    for directory in Path('/proc').iterdir():
        if directory.name.isdigit():
            try:
                if expected in (directory / 'environ').read_bytes().split(b'\0'):
                    owned.append(int(directory.name))
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
    return owned


def settle_owned_processes(root, observed):
    deadline = time.monotonic() + LIMIT
    while owned_processes(root) and time.monotonic() < deadline:
        threading.Event().wait(0.025)
    remaining = owned_processes(root)
    observed['remaining_owned_processes'] = remaining
    if remaining:
        # Failed cleanup never becomes a green receipt. Best-effort signals
        # recheck exact fixture ownership before touching each detached process.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid in owned_processes(root):
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
        raise RuntimeError('owned fixture processes survived shutdown: ' + str(remaining))


def validate_rename_trigger(data, active):
    assert isinstance(data, dict), 'rename trigger omitted its session summary'
    assert data.get('activeSessionId') == active, 'rename summary changed session identity'
    assert data.get('sessionName') == 'Write cleanup fixture', 'rename summary has wrong name'
    assert isinstance(data.get('workerPid'), int), 'rename summary omitted worker identity'


def pause_released(client, active, pause_id):
    """A non-owner cannot release this lease; success means cleanup removed it."""
    try:
        client.call('release_session_input_pause', activeSessionId=active, pauseId=pause_id)
        return True
    except AssertionError:
        response = client.wire[-1]
        assert response.get('command') == 'release_session_input_pause' and response.get('success') is False, response
        assert response.get('error') == 'Session input pause is owned by another client: ' + pause_id, response
        return False


def run_case(binary, root, observed):
    env = env_for(root)
    provider = Provider()
    provider.RequestHandlerClass = CompletionHandler
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    clients = []
    process = None
    log = None
    primary_error = None
    try:
        models = {'providers': {'parity-local': {'api': 'openai-completions',
            'apiKey': 'fixture-only', 'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1',
            'models': [{'id': 'parity-1', 'name': 'Parity 1', 'reasoning': False,
                        'contextWindow': 128000, 'maxTokens': 4096}]}}}
        (root / 'agent/models.json').write_text(json.dumps(models))
        (root / 'agent/settings.json').write_text(json.dumps({'prewarmPythonKernel': False,
            'defaultProvider': 'parity-local', 'defaultModel': 'parity-1',
            'onboardingCompleted': True, 'telemetry': {'noticeShown': True}}))
        path = root / 'd.sock'
        log = open(root / 'daemon.log', 'wb')
        process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(path)],
            cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        observer = WireClient(path, process)
        clients.append(observer)
        config = {'cwd': str(root), 'agentDir': str(root / 'agent'),
                  'provider': 'parity-local', 'model': 'parity-1',
                  'noExtensions': True, 'noSkills': True, 'noTools': True,
                  'noContextFiles': True, 'telemetryDisabled': True}
        created = observer.call('create', config=config)
        active = created.get('activeSessionId') or created.get('id')
        assert active, created
        a = WireClient(path, process)
        clients.append(a)
        a.call('attach', activeSessionId=active)
        responses = observed['action_responses'] = {}
        responses['start_busy_turn'] = a.call('prompt', activeSessionId=active, message=FIRST)
        provider.wait_for(FIRST)
        responses['acquire_pause'] = a.call('acquire_session_input_pause',
            activeSessionId=active, leaseKey='write-cleanup-gate')
        assert isinstance(responses['acquire_pause']['pauseId'], str), responses
        b = WireClient(path, process)
        clients.append(b)
        pause_id = responses['acquire_pause']['pauseId']
        before = b.call('get_state', activeSessionId=active)
        assert before['attachedClients'] == 1, before
        assert not pause_released(b, active, pause_id), 'pause was not held before disconnect'
        # A rename is a legal non-input action while a pause is held; it publishes
        # the attached event that must fail its write to A. A keeps its write half
        # open, so no read EOF can clean up.
        a.sock.shutdown(socket.SHUT_RD)
        trigger = observed['rename_trigger_response'] = b.call('set_session_name',
            activeSessionId=active, name='Write cleanup fixture')
        validate_rename_trigger(trigger, active)
        deadline = time.monotonic() + LIMIT
        observations = observed['disconnect_observations'] = []
        while True:
            state = b.call('get_state', activeSessionId=active)
            detached = state['attachedClients'] == 0
            released = pause_released(b, active, pause_id)
            observations.append({'attachedClients': state['attachedClients'], 'pause_released': released})
            if detached and released:
                break
            assert time.monotonic() < deadline, 'failed write did not detach A and release its pause'
            threading.Event().wait(0.025)
        responses['enqueue_second_client'] = b.call('prompt',
            activeSessionId=active, message=SECOND, streamingBehavior='followUp')
        observed['before_provider_release'] = b.call('get_queue', activeSessionId=active)
        queued = observed['before_provider_release']
        assert SECOND in queued['steering'] + queued['followUp'], queued
        provider.release.set()
        # This marker can only arrive if the dead client's held pause released;
        # a passing wait_for_idle alone could overlook a paused queued prompt.
        provider.wait_for(SECOND)
        responses['settle_second_client'] = b.call('wait_for_idle', activeSessionId=active)
        responses['queue_after_drain'] = b.call('get_queue', activeSessionId=active)
        assert responses['queue_after_drain'] == {'steering': [], 'followUp': []}, responses
        observed['action_responses'] = responses
        observed['hello'] = observer.hello
        observed['provider_requests'] = provider.requests
    except Exception as error:
        primary_error = error
        observed['primary_error'] = str(error)
        raise
    finally:
        cleanup_error = None
        provider.release.set()
        if process and process.poll() is None and clients:
            try:
                clients[0].call('shutdown', force=True)
                # The daemon's close waits for every fixture peer to close.
                # The SECOND provider-arrival proof already finished above.
                for client in clients:
                    client.close()
                process.wait(timeout=15)
                observed['shutdown'] = 'owned supervisor and workers stopped'
            except Exception as error:
                observed['shutdown_error'] = str(error)
                cleanup_error = error
        elif process:
            cleanup_error = RuntimeError('daemon exited before owned shutdown acknowledgement')
        if process:
            stop(process)
        observed['raw_wire'] = [client.raw_wire for client in clients]
        observed['parsed_wire'] = [client.wire for client in clients]
        for client in clients:
            client.close()
        if log:
            log.close()
            observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-6000:]
        provider.shutdown()
        provider.server_close()
        try:
            settle_owned_processes(root, observed)
        except Exception as error:
            cleanup_error = cleanup_error or error
        if cleanup_error:
            observed['verified'] = False
            observed['cleanup_error'] = str(cleanup_error)
            if primary_error is None:
                raise RuntimeError('fixture cleanup failed: ' + str(cleanup_error)) from cleanup_error
    observed['verified'] = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'scenario': 'client_write_cleanup', 'verified': False,
        'scope': 'real attached-client read-half-close, rename triggers failed write, observed detach and non-owner pause-release probe, then second-client queue drain',
        'not_covered': 'admission cancellation races or direct worker attach-state introspection'}
    try:
        with tempfile.TemporaryDirectory(prefix='pa-write-cleanup-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            receipt['binary_sha256'] = digest(binary)
            observed = receipt['case'] = {}
            run_case(binary, Path(folder) / 'rust', observed)
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
        raise
    finally:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
