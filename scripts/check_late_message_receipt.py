#!/usr/bin/env python3
"""Actual print-mode child fire-and-forget receipt after its REPL result lands.

The child send waits on a loopback gate. Only the child's second real model
request (containing its finished tool result) opens it. The parent remains in
its model request until the child's durable late receipt appears. This tests
late delivery/persistence without arbitrary task sleeps or stub host handlers.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from lifecycle_lib import digest, env_for, skill_pythonpath
from lifecycle_lib import OwnedProcesses, TAG, finish
from check_restore_notice import texts, probe_from

MESSAGE = 'LATE_RECEIPT_FIXTURE_MESSAGE'
PARENT_CELL = "late_child = await rlm.spawn('LATE_RECEIPT_CHILD', name='late-child')\nprint('LATE_SPAWN_HANDLE=' + __import__('json').dumps({'rlm_child_id': late_child.rlm_child_id, 'session_dir': str(late_child.session_dir)}))"


def late_entries(root):
    entries = []
    for path in root.rglob('*.jsonl'):
        for line in path.read_text().splitlines(keepends=True):
            if not line.strip():
                continue  # session readers also permit blank JSONL separators
            if not line.endswith('\n'):
                continue  # an in-progress append is not an observed complete entry
            row = json.loads(line)
            if row.get('type') == 'custom' and row.get('customType') == 'ipython_sent_agent_message':
                entries.append({'file': str(path), 'entry': row})
    return entries


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root):
        super().__init__(('127.0.0.1', 0), Handler)
        self.root = root
        self.gate = threading.Event()
        self.requests = {'parent': [], 'child': []}
        self.errors = []
        self.child_result_seen_before_release = False


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path != '/send-gate' or not self.server.gate.wait(75):
            self.send_error(504)
            return
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'OK')

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        child = any('LATE_RECEIPT_CHILD' in ''.join(texts(m.get('content')))
                    for m in body.get('messages', []) if m.get('role') == 'user')
        lane = 'child' if child else 'parent'
        requests = self.server.requests[lane]
        requests.append(body)
        count = len(requests)
        code = None
        if count == 1:
            if child:
                code = f'''import asyncio, urllib.request
async def fixture_delayed_send():
    await asyncio.to_thread(lambda: urllib.request.urlopen('http://127.0.0.1:{self.server.server_port}/send-gate', timeout=90).read())
    await agent_message.send('{MESSAGE}', receiver_role='parent')
fixture_send_task = asyncio.create_task(fixture_delayed_send())
print('LATE_CHILD_CELL_FINISHED')'''
            else:
                code = PARENT_CELL
        elif child and count == 2:
            results = [m for m in body.get('messages', []) if m.get('role') == 'tool'
                       and m.get('tool_call_id') == 'late_child_cell']
            if len(results) != 1 or 'LATE_CHILD_CELL_FINISHED' not in ''.join(texts(results[0].get('content'))):
                self.server.errors.append('gate opened without the actual completed child cell')
            else:
                self.server.child_result_seen_before_release = True
                self.server.gate.set()
        elif not child and count == 2:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if late_entries(self.server.root):
                    break
                threading.Event().wait(0.025)
            else:
                self.server.errors.append('actual late receipt never persisted')
        if code:
            offered = {tool['function']['name'] for tool in body.get('tools', [])}
            name = next((n for n in ('python_repl', 'ipython') if n in offered), None)
            if name is None:
                self.send_error(422)
                return
            delta = {'tool_calls': [{'index': 0, 'id': 'late_child_cell' if child else 'late_parent_cell',
                'type': 'function', 'function': {'name': name, 'arguments': json.dumps({'code': code})}}]}
            reason = 'tool_calls'
        else:
            delta, reason = {'content': 'Child complete.' if child else 'Parent complete.'}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'late-receipt-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                'model': 'late-receipt-fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', **delta}), chunk({}, reason))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def validate(observed):
    assert observed['child_result_seen_before_release'] is True
    assert observed['child_request_count'] == 2
    assert 2 <= observed['parent_request_count'] <= 4
    rows = observed['late_entries']
    assert len(rows) == 1, 'missing/duplicate persisted late receipt'
    payload = rows[0]['entry']['data']
    assert payload['toolCallId'] == 'late_child_cell', payload
    message = payload['message']
    assert message['message'] == MESSAGE and message['receiverRole'] == 'parent', message
    assert isinstance(message['id'], str) and message['id'], message
    assert message['deliveryStatus'] in ('delivered', 'queued'), message
    assert message['target']['sessionId'] == observed['parent_session_id'], message
    # The runtime activeSessionId may differ from the durable UUID. The durable
    # target and child-parent edge below identify the recipient.
    active_id = message['target'].get('activeSessionId')
    assert isinstance(active_id, str) and active_id.strip(), message
    assert rows[0]['file'] != observed['parent_session_file'], 'receipt must belong to child'
    handle = observed['spawn_handle']
    assert handle['rlm_child_id'] and handle['rlm_child_id'] in Path(handle['session_dir']).parts, handle
    assert Path(rows[0]['file']).parent.resolve() == Path(handle['session_dir']).resolve(), 'receipt not in actual spawned child session directory'
    header = observed['child_header']
    assert header.get('type') == 'session' and header.get('id'), header
    assert Path(header['parentSession']).resolve() == Path(observed['parent_session_file']).resolve(), 'wrong durable child-parent edge' 
    return {key: message[key] for key in ('message', 'receiverRole', 'deliveryStatus')}


def observe(binary, root, observed):
    env = env_for(root)
    env[TAG] = str(root)
    env['PYTHONPATH'] = skill_pythonpath()
    provider = Provider(root)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    (root / 'agent/settings.json').write_text(json.dumps({'prewarmPythonKernel': False}))
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1', 'models': [{
            'id': 'late-receipt-fixture', 'name': 'Late receipt fixture', 'reasoning': False,
            'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    scope = OwnedProcesses(binary, root, root / 'unused.sock')
    process = None
    output = (root / 'stdout.jsonl').open('w')
    error_log = (root / 'stderr.log').open('w')
    try:
        command = [str(binary), '--mode', 'json', '--provider', 'fixture', '--model',
                   'late-receipt-fixture', '--session-dir', str(root / 'sessions'), 'Run LATE_RECEIPT_PARENT.']
        process = subprocess.Popen(command, cwd=root, env=env, stdout=output,
            stderr=error_log, start_new_session=True)
        scope.register(process, command)
        process.wait(timeout=120)
        assert process.returncode == 0, process.returncode
        assert not provider.errors, provider.errors
        parents = list((root / 'sessions').glob('*.jsonl'))
        assert len(parents) == 1, parents
        header = json.loads(parents[0].read_text().splitlines()[0])
        assert header.get('type') == 'session', header
        observed.update(parent_session_id=header['id'], parent_session_file=str(parents[0]),
            child_result_seen_before_release=provider.child_result_seen_before_release,
            child_request_count=len(provider.requests['child']), parent_request_count=len(provider.requests['parent']),
            late_entries=late_entries(root))
        observed['spawn_handle'] = probe_from(provider.requests['parent'], 'LATE_SPAWN_HANDLE=')
        assert len(observed['late_entries']) == 1, observed['late_entries']
        child_file = Path(observed['late_entries'][0]['file'])
        observed['child_header'] = json.loads(child_file.read_text().splitlines()[0])
        observed['semantic_receipt'] = validate(observed)
    finally:
        provider.gate.set()
        observed['provider_requests'] = provider.requests
        finish(scope, None, None, observed)
        output.close()
        error_log.close()
        observed['stdout'] = (root / 'stdout.jsonl').read_text(errors='replace')
        observed['stderr'] = (root / 'stderr.log').read_text(errors='replace')[-10000:]
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    result = {'verified': False, 'scope': __doc__,
        'not_verified': [
        'pre-result receipt landing (Rust regression)', 'I/O failure (Rust regression)',
        'compaction/tree-navigation receipt restoration']}
    try:
        assert sys.platform == 'linux'
        with tempfile.TemporaryDirectory(prefix='pa-late-receipt-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observed = result['run'] = {'binary_sha256': digest(binary)}
            try:
                observe(binary, Path(folder) / 'rust', observed)
                observed['behavior_verified'] = True
            except Exception as error:
                observed['error'] = str(error)
            assert observed.get('behavior_verified') and observed.get('cleanup_verified') \
                and 'error' not in observed, 'actual late receipt observation failed'
        result['verified'] = True
    except Exception as error:
        result['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
