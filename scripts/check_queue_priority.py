#!/usr/bin/env python3
"""Actual protocol-7 daemon check for a follow-up edited into steering.

The re-laned item keeps its existing admission priority, ahead of a later agent
message; the reverse move into a plain-user lane restores it. No model is external.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

from check_agent_bounce import Client, Provider
from lifecycle_lib import digest, env_for
from lifecycle_lib import OwnedProcesses, TAG, finish

EARLIER, DRAFT, EDITED = 'QUEUE_PRIORITY_EARLIER', 'QUEUE_PRIORITY_DRAFT', 'QUEUE_PRIORITY_EDITED'
AGENT = 'QUEUE_PRIORITY_AGENT'


def check_order(queue, agent_preview):
    assert queue == {'steering': [EARLIER, EDITED, agent_preview], 'followUp': []}, queue


def observe(binary, root, observed):
    env = env_for(root)
    env[TAG] = str(root)
    provider = Provider()
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    models = {'providers': {'parity-local': {'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1', 'models': [{
            'id': 'parity-1', 'name': 'Parity 1', 'reasoning': False, 'contextWindow': 128000, 'maxTokens': 4096}]}}}
    (root / 'agent/models.json').write_text(json.dumps(models))
    path = root / 'd.sock'
    scope = OwnedProcesses(binary, root, path)
    daemon = control = receiver = None
    log = open(root / 'daemon.log', 'wb')
    try:
        command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(path)]
        daemon = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        scope.register(daemon, command)
        control = Client(path, daemon)
        receiver = Client(path, daemon)
        config = {'cwd': str(root), 'agentDir': str(root / 'agent'), 'provider': 'parity-local',
            'model': 'parity-1', 'noExtensions': True, 'noSkills': True, 'noTools': True,
            'noContextFiles': True, 'telemetryDisabled': True}
        active = []
        for client, name in [(control, 'queue-source'), (receiver, 'queue-target')]:
            row = client.call('create', name=name, config=config)
            ident = row.get('activeSessionId') or row.get('id')
            assert ident, row
            active.append(ident)
            client.call('attach', activeSessionId=ident)
        source, target = active
        receiver.call('prompt', activeSessionId=target, message='QUEUE_PRIORITY_HOLD')
        provider.wait_for('QUEUE_PRIORITY_HOLD')
        receiver.call('steer', activeSessionId=target, message=EARLIER)
        delivered = control.call('send_message', targetActiveSessionId=target,
            fromActiveSessionId=source, message=AGENT)
        observed['delivery_receipt'] = delivered
        assert delivered['deliveryStatus'] == 'queued', delivered
        receiver.call('follow_up', activeSessionId=target, message=DRAFT)
        before = receiver.call('get_queue', activeSessionId=target)
        observed['before'] = before
        assert before['followUp'] == [DRAFT] and len(before['steering']) == 2, before
        agent_preview = before['steering'][1]
        assert agent_preview == 'Agent message received: ' + AGENT, before
        assert before['steering'][0] == EARLIER, before
        mutation = {'lane': 'followUp', 'index': 0, 'expectedText': DRAFT,
            'mutation': {'type': 'replace', 'text': EDITED, 'lane': 'steering'}}
        observed['mutation'] = mutation
        response = receiver.call('mutate_queued_message', activeSessionId=target, **mutation)
        assert response == {'status': 'applied'}, response
        after = receiver.call('get_queue', activeSessionId=target)
        observed['after'] = after
        check_order(after, agent_preview)
        # Reverse direction retains existing users; internal target-lane admission
        # in BOTH directions remains covered by the worker integration regression.
        receiver.call('follow_up', activeSessionId=target, message='QUEUE_REVERSE_EARLIER')
        index = after['steering'].index(EDITED)
        reverse = {'lane': 'steering', 'index': index, 'expectedText': EDITED,
            'mutation': {'type': 'replace', 'text': 'QUEUE_REVERSE_EDITED', 'lane': 'followUp'}}
        observed['reverse_mutation'] = reverse
        assert receiver.call('mutate_queued_message', activeSessionId=target, **reverse) == {'status': 'applied'}
        reverse_queue = receiver.call('get_queue', activeSessionId=target)
        observed['reverse_after'] = reverse_queue
        assert reverse_queue == {'steering': [EARLIER, agent_preview],
            'followUp': ['QUEUE_REVERSE_EARLIER', 'QUEUE_REVERSE_EDITED']}, reverse_queue
        assert not provider.release.is_set(), 'held turn was released before observations'
        observed['behavior_verified'] = True
    finally:
        observed['provider_requests'] = list(provider.requests)
        observed['wire'] = {'source': list(control.wire) if control else [], 'receiver': list(receiver.wire) if receiver else []}
        if receiver:
            receiver.close()
        provider.release.set()
        finish(scope, control, daemon, observed)
        log.close()
        observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-10000:]
        provider.shutdown()
        provider.server_close()
    assert observed['cleanup_verified'], observed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': __doc__,
        'not_verified': ['TUI key/render path', 'internal follow-up target lane (worker integration test covers it)',
            'forced Esc batch execution', 'restart recovery', 'full wire byte equality (IDs/timestamps differ)']}
    try:
        assert sys.platform == 'linux', 'hosted Linux only'
        with tempfile.TemporaryDirectory(prefix='pa-qpriority-', dir='/tmp') as folder:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observed = receipt['run'] = {'binary_sha256': digest(binary)}
            try:
                observe(binary, Path(folder) / 'rust', observed)
            except Exception as error:
                observed['error'] = str(error)
            assert observed.get('behavior_verified') and observed.get('cleanup_verified') \
                and 'error' not in observed, 'actual daemon observation failed'
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps({'verified': receipt['verified'], 'error': receipt.get('error')}))
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
