#!/usr/bin/env python3
"""Actual TS/Rust print background completion wake, held until the first turn ends.

Both binaries receive identical REPL cells. A loopback HTTP gate holds the
background process. Expected difference: TS 0.9.8 --print exits after its
first turn without waiting for the command, so its gate opens only when the
process is gone (no wake, no notice); Rust print waits for it on purpose, so
its gate opens once the first turn ended, and the completion must wake a
second turn and persist the notice.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading

from review_draft_disconnect_parity import env_for, digest, TS_ARCHIVE_SHA256
from review_goal_fixture_lifecycle import OwnedProcesses, TAG, finish
from review_restore_notice_parity import texts, probe_from

START = 'PRINT_BASH_STARTED='
DONE = 'PRINT_BASH_FINISHED='


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.release = threading.Event()
        self.requests = []
        self.errors = []
        self.waiting_seen = False
        self.first_turn_ended = False
        self.gate_timed_out = False


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path != '/background':
            self.send_error(404)
            return
        if not self.server.release.wait(75):
            self.server.gate_timed_out = True
            self.send_error(504)
            return
        payload = b'BG_DONE'
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        count = len(self.server.requests)
        offered = {tool['function']['name'] for tool in body.get('tools', [])}
        name = next((n for n in ('python_repl', 'ipython') if n in offered), None)
        if count == 1:
            command = shlex.join(['python3', '-c',
                f"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:{self.server.server_port}/background', timeout=90).read().decode())"])
            code = 'h = bash(' + repr(command) + ")\nprint('PRINT_BASH_STARTED=' + __import__('json').dumps({'pid': h.pid}))"
        elif count == 3:
            notice = [t for m in body.get('messages', []) if m.get('role') == 'user'
                      for t in texts(m.get('content')) if '[bash-done pid:' in t]
            if not notice:
                self.server.errors.append('wake request lacks actual bash completion notice')
            code = "print('PRINT_BASH_FINISHED=' + __import__('json').dumps({'completed': 'BG_DONE' in h.output()}))"
        else:
            code = None
        if count not in (1, 2, 3, 4) or (code and name is None):
            self.server.errors.append('unexpected provider sequence')
            self.send_error(422)
            return
        if code:
            delta = {'tool_calls': [{'index': 0, 'id': 'print_bash_' + str(count), 'type': 'function',
                'function': {'name': name, 'arguments': json.dumps({'code': code})}}]}
            reason = 'tool_calls'
        else:
            delta, reason = {'content': 'WAITING' if count == 2 else 'COMPLETED WOKEN'}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'print-bash-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                'model': 'print-bash-fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', **delta}), chunk({}, reason))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def validate(observed):
    assert observed['first_turn_ended_before_release'] is True
    assert observed['request_count'] == 4
    assert observed['finished'] == {'completed': True}
    assert observed['notice']['exit_code'] == 0
    assert observed['notice']['display'] is True
    assert observed['notice']['matches_started_pid'] is True


def validate_ts(observed):
    # TS --print ends with its first turn: no wake request, no notice.
    assert observed['first_turn_ended_before_release'] is True
    assert observed['request_count'] == 2
    assert observed['notice_count'] == 0
    assert observed['gate_timed_out'] is False


def observe(binary, kind, root, observed):
    env = env_for(root, kind)
    env[TAG] = str(root)
    provider = Provider()
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    (root / 'agent/settings.json').write_text(json.dumps({'prewarmPythonKernel': False}))
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1', 'models': [{
            'id': 'print-bash-fixture', 'name': 'Print bash fixture', 'reasoning': False,
            'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    scope = OwnedProcesses(binary, root, root / 'unused.sock')
    process = None
    events = []
    stderr_path = root / 'stderr.log'
    stderr = stderr_path.open('w')
    try:
        command = [str(binary), '--mode', 'json', '--provider', 'fixture', '--model',
                   'print-bash-fixture', '--session-dir', str(root / 'sessions'), 'Run the print bash fixture.']
        process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE,
            stderr=stderr, text=True, start_new_session=True)
        scope.register(process, command)
        def read_events():
            for line in process.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    events.append({'unparsed': line})
                    continue
                events.append(event)
                message = event.get('message', {})
                if event.get('type') == 'message_end' and message.get('role') == 'assistant':
                    if list(texts(message.get('content'))) == ['WAITING']:
                        provider.waiting_seen = True
                if event.get('type') == 'turn_end' and provider.waiting_seen and not provider.first_turn_ended:
                    provider.first_turn_ended = True
                    if kind != 'ts':
                        provider.release.set()
        reader = threading.Thread(target=read_events, daemon=True)
        reader.start()
        process.wait(timeout=110)
        reader.join(timeout=5)
        assert not reader.is_alive(), 'stdout reader never finished'
        assert process.returncode == 0, process.returncode
        assert not provider.errors, provider.errors
        started = probe_from(provider.requests, START)
        rows = [json.loads(line) for path in (root / 'sessions').rglob('*.jsonl')
                for line in path.read_text().splitlines()]
        notices = [row for row in rows if row.get('type') == 'custom_message'
                   and row.get('customType') == 'async_bash_completion']
        if kind == 'ts':
            observed.update(first_turn_ended_before_release=provider.first_turn_ended,
                request_count=len(provider.requests), notice_count=len(notices),
                gate_timed_out=provider.gate_timed_out)
            validate_ts(observed)
            return
        finished = probe_from(provider.requests, DONE)
        assert len(notices) == 1, notices
        notice = notices[0]
        observed.update(first_turn_ended_before_release=provider.first_turn_ended,
            request_count=len(provider.requests), finished=finished,
            raw_notice=notice, notice={'exit_code': notice.get('details', {}).get('exitCode'),
                'display': notice.get('display'),
                'matches_started_pid': f"[bash-done pid:{started['pid']} exit:0]" in '\n'.join(texts(notice.get('content')))})
        validate(observed)
    finally:
        provider.release.set()
        observed['provider_requests'] = provider.requests
        observed['events'] = events
        finish(scope, None, None, observed)
        stderr.close()
        observed['stderr'] = stderr_path.read_text(errors='replace')[-10000:]
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'runs': {}, 'scope': __doc__, 'not_verified': [
        'RPC wake/replacement (Rust e2e)', 'inline child background wake (Rust e2e)',
        'late agent-message receipt delivery (Rust regression)', 'full prompt/frame parity']}
    try:
        assert sys.platform == 'linux'
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256
        result['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        with tempfile.TemporaryDirectory(prefix='pa-print-bash-', dir='/tmp') as folder:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ[f'PA_{kind.upper()}_BINARY']).resolve()
                observed = result['runs'][kind] = {'binary_sha256': digest(binary)}
                try:
                    observe(binary, kind, Path(folder) / kind, observed)
                    observed['behavior_verified'] = True
                except Exception as error:
                    observed['error'] = str(error)
            assert all(r.get('behavior_verified') and r.get('cleanup_verified') and 'error' not in r
                       for r in result['runs'].values()), 'actual print bash observation failed'
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
