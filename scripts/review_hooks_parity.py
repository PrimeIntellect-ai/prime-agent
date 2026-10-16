#!/usr/bin/env python3
"""Hosted binary evidence for hooks and unchanged hook-disabled conversations.

Uses the CI-pinned TS release and prebuilt Rust binaries. No provider credentials,
installs, PTY input, timing benchmarks, or external model requests. TS v0.9.8 is
only the baseline for ordinary prompt/resume behavior, not the Codex hook API.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import tempfile
import threading

from hooks_transport_probe import Fixture, verify_cli, verify_daemon
from hooks_compaction_probe import verify_compaction_cancellation
from review_draft_disconnect_parity import TS_ARCHIVE_SHA256, digest
from review_restore_notice_parity import invoke, texts

PROMPTS = ['HOOK_PARITY_FIRST', 'HOOK_PARITY_RESUME']
ANSWERS = ['Hook-free first answer.', 'Hook-free resumed answer.']


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.requests = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        if len(self.server.requests) > 2:
            self.send_error(429, 'fixture request bound exceeded')
            return
        answer = ANSWERS[len(self.server.requests) - 1]
        def chunk(delta, reason=None):
            return {'id': 'hooks-parity', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'hooks-fixture', 'choices': [{'index': 0, 'delta': delta,
                                                          'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', 'content': answer}), chunk({}, 'stop')))
        wire += 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        self.wfile.write(wire.encode())


def conversation(rows):
    """Retain exact user/assistant text, excluding unrelated custom metadata."""
    result = []
    for row in rows:
        message = row.get('message', {}) if row.get('type') == 'message' else {}
        if message.get('role') in ('user', 'assistant'):
            result.append({'role': message['role'], 'text': ''.join(texts(message.get('content')))})
    return result


def observe_baseline(binary, kind, root, result):
    root.mkdir()
    root = root.resolve()
    for name in ('agent', 'sessions', 'work'):
        (root / name).mkdir()
    env = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ')
           if key in os.environ}
    if kind == 'ts':
        env['PI_PACKAGE_DIR'] = os.environ['PI_PACKAGE_DIR']
    env.update(DO_NOT_TRACK='1', PI_OFFLINE='1',
               PRIME_AGENT_HOOK_ACTIVE='1',
               PRIME_AGENT_KERNEL_PYTHON=str(root / 'nonexistent-kernel'),
               PRIME_AGENT_CODING_AGENT_DIR=str(root / 'agent'),
               PI_CODING_AGENT_DIR=str(root / 'agent'))
    provider = Provider()
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    try:
        (root / 'agent/models.json').write_text(json.dumps({'providers': {'fixture': {
            'api': 'openai-completions', 'apiKey': 'fixture-only',
            'baseUrl': f'http://127.0.0.1:{provider.server_address[1]}/v1',
            'models': [{'id': 'hooks-fixture', 'name': 'Hooks fixture', 'reasoning': False,
                        'contextWindow': 128000, 'maxTokens': 4096}]}}}))
        (root / 'agent/settings.json').write_text(json.dumps({
            'defaultProvider': 'fixture', 'defaultModel': 'hooks-fixture',
            'prewarmPythonKernel': False}))
        command = [str(binary), '--mode', 'json', '--provider', 'fixture', '--model',
                   'hooks-fixture', '--session-dir', str(root / 'sessions')]
        result['first'] = invoke(command + [PROMPTS[0]], root / 'work', env)
        sessions = [p for p in (root / 'sessions').glob('*.jsonl')
                    if json.loads(p.read_text().splitlines()[0]).get('type') == 'session']
        assert len(sessions) == 1, 'expected one durable conversation'
        result['resume'] = invoke(command + ['--resume', str(sessions[0]), PROMPTS[1]],
                                  root / 'work', env)
        rows = [json.loads(line) for line in sessions[0].read_text().splitlines()]
        result['raw_transcript'] = rows
        result['conversation'] = conversation(rows)
        expected = [{'role': role, 'text': text} for prompt, answer in zip(PROMPTS, ANSWERS)
                    for role, text in [('user', prompt), ('assistant', answer)]]
        assert result['conversation'] == expected, result['conversation']
        assert len(provider.requests) == 2, 'unexpected continuation/provider retry'
        for phase, answer in zip(('first', 'resume'), ANSWERS):
            assert answer in result[phase]['stdout'], 'visible final answer missing'
        result['verified'] = True
    finally:
        result['provider_requests'] = provider.requests
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'tested_github_sha': os.environ.get('GITHUB_SHA'),
        'scope': 'Rust hook transports and child exclusion; TS/Rust hook-disabled fresh prompt and resume.',
        'intentional_difference': 'Codex command hooks are a Rust feature addition, not TS hook parity.',
        'normalization': 'Conversation compares exact role/text only. Generated IDs, timestamps, model usage and system prompts remain in raw evidence but are not equality targets.',
        'not_verified': ['TUI frame parity', 'full daemon wire byte parity', 'startup performance',
                         'Python code execution', 'TS support for Codex hooks'],
        'baseline': {}, 'hooks': {}}
    try:
        assert digest(Path(os.environ['PA_TS_ARCHIVE'])) == TS_ARCHIVE_SHA256, 'TS archive mismatch'
        receipt['ts_archive_sha256'] = TS_ARCHIVE_SHA256
        rust = Path(os.environ['PA_RUST_BINARY']).resolve()
        daemon = rust.with_name('pa-daemon')
        receipt['rust_daemon_sha256'] = digest(daemon)
        with tempfile.TemporaryDirectory(prefix='hooks-ci-', dir='/tmp') as folder:
            root = Path(folder)
            for kind in ('ts', 'rust'):
                binary = Path(os.environ['PA_' + kind.upper() + '_BINARY']).resolve()
                result = receipt['baseline'][kind] = {'binary_sha256': digest(binary)}
                observe_baseline(binary, kind, root / kind, result)
            assert receipt['baseline']['ts']['conversation'] == receipt['baseline']['rust']['conversation']
            for mode in ('print', 'rpc', 'supervisor', 'direct'):
                directory = root / mode
                directory.mkdir()
                fixture = Fixture(directory, hooks=True)
                try:
                    result = (verify_cli(str(rust), mode, fixture) if mode in ('print', 'rpc')
                              else verify_daemon(str(daemon), mode == 'direct', fixture))
                    receipt['hooks'][mode] = result
                finally:
                    receipt.setdefault('hook_evidence', {})[mode] = {
                        str(path.relative_to(directory)): path.read_text(errors='replace')
                        for path in directory.rglob('*') if path.is_file()
                        and (path.suffix == '.jsonl' or path.name in
                             ('pre.json', 'post.json', 'start.json', 'prompt.json', 'stop.json', 'end.json', 'frames.json')
                             or path.name.startswith('stderr-'))}
            verify_compaction_cancellation(rust, daemon, root,
                                           receipt.setdefault('compaction_cancellation', {}))
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = f'{type(error).__name__}: {error}'
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'verified': receipt['verified'], 'receipt': str(args.receipt),
                      'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
