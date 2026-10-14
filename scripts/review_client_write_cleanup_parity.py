#!/usr/bin/env python3
"""Real TS/Rust #3602 half-close comparison, with an owned blocked provider.

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

from review_agent_bounce_parity import Client, Provider, Handler, LIMIT
from review_draft_disconnect_parity import digest, env_for, stop, TS_ARCHIVE_SHA256

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


def canonical(value):
    """The pause lease is the only generated value in the compared responses."""
    if isinstance(value, dict):
        return {key: '<pause-id>' if key == 'pauseId' else canonical(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def run_case(binary, kind, root, observed):
    env = env_for(root, kind)
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
        # The write half remains open: no read EOF can trigger the ordinary
        # disconnect tail. B's enqueue must publish an event whose write fails.
        a.sock.shutdown(socket.SHUT_RD)
        b = WireClient(path, process)
        clients.append(b)
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
        observed['canonical_action_responses'] = canonical(responses)
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
    receipt = {'scenario': 'client_write_cleanup', 'verified': False, 'cases': {},
        'scope': 'real attached-client read-half-close, held pause release, second-client queue drain',
        'normalization': 'only generated pauseId in compared action response data; raw JSONL preserved',
        'not_covered': 'admission cancellation races or direct worker attach-state introspection'}
    try:
        archive = Path(os.environ['PA_TS_ARCHIVE'])
        assert digest(archive) == TS_ARCHIVE_SHA256, 'TS archive digest mismatch'
        receipt['ts_archive_sha256'] = digest(archive)
        with tempfile.TemporaryDirectory(prefix='pa-write-cleanup-', dir='/tmp') as folder:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ['PA_' + kind.upper() + '_BINARY']).resolve()
                receipt[kind + '_binary_sha256'] = digest(binary)
                observed = receipt['cases'][kind] = {}
                run_case(binary, kind, Path(folder) / kind, observed)
        assert receipt['cases']['ts']['canonical_action_responses'] == receipt['cases']['rust']['canonical_action_responses'], 'changed-action wire response data differs'
        assert receipt['cases']['ts']['before_provider_release'] == receipt['cases']['rust']['before_provider_release'], 'queued input shape differs'
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
        raise
    finally:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
