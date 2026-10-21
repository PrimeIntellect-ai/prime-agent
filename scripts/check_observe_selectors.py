#!/usr/bin/env python3
"""Actual resident agent_observe selector check.

Only identity/transcript selection, ambiguity and family rejection are checked.
Full summary/preview objects remain in the receipt; passive hydration, transient
progress events and preview fidelity are excluded.
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

from check_agent_bounce import Client
from lifecycle_lib import digest, skill_pythonpath
from lifecycle_lib import OwnedProcesses, TAG, finish, verify_worker
from check_restore_notice import texts

MARKER = 'OBSERVE_SELECTORS_PARITY='
LIMIT = 35
MAIN_CHILD_TASKS = {'observe-child-a': 'OBSERVE_TASK_A', 'observe-child-b': 'OBSERVE_TASK_B'}
FOREIGN_CHILD_TASKS = {'observe-foreign-child': 'OBSERVE_TASK_FOREIGN'}
ALL_TASKS = set(MAIN_CHILD_TASKS.values()) | set(FOREIGN_CHILD_TASKS.values())


class ObserveClient(Client):
    def call(self, kind, timeout_seconds=LIMIT, **payload):
        self.counter += 1
        ident = str(self.counter)
        envelope = {'type': 'command', 'id': ident,
            'protocol': {'name': 'prime-agent.daemon', 'version': 7},
            'command': {'type': kind, **payload}}
        self.sent.append(envelope)
        deadline = time.monotonic() + timeout_seconds
        previous_timeout = self.sock.gettimeout()
        try:
            self.sock.settimeout(timeout_seconds)
            self.sock.sendall((json.dumps(envelope) + '\n').encode())
            while time.monotonic() < deadline:
                self.sock.settimeout(max(0.001, deadline - time.monotonic()))
                line = self.reader.readline()
                assert line, 'daemon closed connection'
                response = json.loads(line)
                self.wire.append(response)
                if response.get('type') == 'response' and response.get('id') == ident:
                    assert response.get('success'), response
                    return response.get('data')
            raise TimeoutError('command never answered: ' + kind)
        finally:
            self.sock.settimeout(previous_timeout)

    def __init__(self, path, process):
        super().__init__(path, process)
        self.sent = []


def cell(selectors):
    return """import json, agent_observe
selectors = """ + repr(selectors) + """
result = {'roster': await agent_observe.list_agents(), 'selectors': {}}
for label, target in selectors.items():
    row = result['selectors'][label] = {}
    for operation in ('get', 'recent'):
        try:
            value = (await agent_observe.get_agent(target) if operation == 'get'
                     else await agent_observe.recent_messages(target, limit=8, max_chars=800))
            row[operation] = {'value': value}
        except Exception as error:
            row[operation] = {'error': str(error)}
print('OBSERVE_SELECTORS_PARITY=' + json.dumps(result))
"""


class Provider(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Handler)
        self.phase, self.code = None, None
        self.requests = {}
        self.child_requests = {}
        self.children_arrived = threading.Condition()
        self.release_children = threading.Event()
        self.child_reply_timeout = False


def child_task(body):
    users = [message for message in body.get('messages', []) if message.get('role') == 'user']
    text = '\n'.join(texts(users[-1].get('content'))).strip() if users else ''
    tasks = {f'[task from parent]\n\n{task}': task for task in ALL_TASKS}
    return tasks.get(text)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        task = child_task(body)
        if task:
            with self.server.children_arrived:
                self.server.child_requests.setdefault(task, []).append(body)
                self.server.children_arrived.notify_all()
            # Keep the actual spawned child live; no settle/passive hydration is exercised.
            if not self.server.release_children.wait(300):
                self.server.child_reply_timeout = True
            phase, requests = task, self.server.child_requests[task]
            code = None
        else:
            phase = self.server.phase
            requests = self.server.requests.setdefault(phase, [])
            requests.append(body)
            code = self.server.code
        if code is not None and len(requests) == 1:
            offered = {tool.get('function', {}).get('name') for tool in body.get('tools', [])}
            name = next((name for name in ('python_repl', 'ipython') if name in offered), None)
            if name is None:
                self.send_error(422, 'no actual REPL tool offered')
                return
            delta = {'tool_calls': [{'index': 0, 'id': 'observe_' + phase, 'type': 'function',
                'function': {'name': name, 'arguments': json.dumps({'code': code})}}]}
            reason = 'tool_calls'
        else:
            delta, reason = {'content': 'TRANSCRIPT_' + phase.upper()}, 'stop'
        def chunk(delta, reason=None):
            return {'id': 'observe-selectors', 'object': 'chat.completion.chunk', 'created': 1,
                'model': 'observe-fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
        wire = ''.join('data: ' + json.dumps(row) + '\n\n' for row in (
            chunk({'role': 'assistant', **delta}), chunk({}, reason))) + 'data: [DONE]\n\n'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(wire.encode())))
        self.end_headers()
        try:
            self.wfile.write(wire.encode())
        except (BrokenPipeError, ConnectionResetError):
            pass  # Actual shutdown interrupts the held child's connection.


def current_probe(requests, phase):
    assert len(requests) == 2, 'unexpected actual provider sequence'
    ident = 'observe_' + phase
    calls = [call for message in requests[-1]['messages'] if message.get('role') == 'assistant'
             for call in message.get('tool_calls', []) if call.get('id') == ident]
    assert len(calls) == 1, 'missing/duplicate current observe tool call'
    matches = [message for message in requests[-1]['messages'] if message.get('role') == 'tool'
               and message.get('tool_call_id') == ident]
    assert len(matches) == 1, 'missing/duplicate current observe tool result'
    probes = [json.loads(line[len(MARKER):]) for text in texts(matches[0].get('content'))
              for line in text.splitlines() if line.startswith(MARKER)]
    assert len(probes) == 1, 'missing/duplicate current observe marker'
    return probes[0]


def suffix(identifier, all_ids):
    normalize = lambda value: value.replace('-', '').lower()
    identifier = normalize(identifier)
    for size in range(8, len(identifier) + 1):
        candidate = identifier[-size:]
        if sum(value.endswith(candidate) for value in {normalize(value) for value in all_ids}) == 1:
            # Exercise both case and hyphen normalization, not just a substring.
            return candidate[:4].upper() + '-' + candidate[4:].upper()
    raise AssertionError('fixture did not generate a unique ID suffix')


READ_CHILDREN = """import json, dataclasses
print('OBSERVE_SELECTORS_PARITY=' + json.dumps({'children': [dataclasses.asdict(row) for row in await rlm.list_subagents()]}, default=str))
"""


def ready_children(snapshot, expected_child_ids, expected_tasks=MAIN_CHILD_TASKS):
    children = snapshot['children']
    assert len(children) == len(expected_tasks), 'unexpected spawned-child roster size'
    rows = {row['session_name']: row for row in children}
    assert set(rows) == set(expected_tasks), 'unexpected/duplicate child names'
    for name, task in expected_tasks.items():
        row = rows[name]
        assert row['rlm_child_id'] == expected_child_ids[name], 'spawned child identity changed'
        assert row['status'] == 'running', 'spawned child settled before identity proof'
        assert row.get('label') == task, 'spawned child task/name mismatch'
    complete = True
    for key in ('active_session_id', 'session_id'):
        ids = [row[key] for row in children]
        published = [value for value in ids if value is not None]
        assert all(isinstance(value, str) and value for value in published), 'invalid published live child ID'
        assert len(set(published)) == len(published), 'duplicate published live child IDs'
        complete = complete and len(published) == len(expected_tasks)
    # Only explicit None is a transient admission/publication state. Validate
    # every present ID first, even if another field has not been published.
    return rows if complete else None


def await_child_identities(first, read_snapshot, observation, clock=time.monotonic, budget=LIMIT, expected_tasks=MAIN_CHILD_TASKS):
    expected = {row['session_name']: row['rlm_child_id'] for row in first['children']}
    assert all(isinstance(value, str) and value for value in expected.values()), 'invalid spawned child handles'
    assert len(set(expected.values())) == len(expected_tasks), 'duplicate spawned child handles'
    deadline = clock() + budget
    observation['identity_polls'] = []
    rows = ready_children(first, expected, expected_tasks)
    while rows is None:
        remaining = deadline - clock()
        assert remaining > 0, 'spawned children did not publish live IDs before deadline'
        # Each poll executes the actual RLM host read in another REPL tool call.
        # The request itself yields to publication; no fixed sleep grants readiness.
        snapshot = read_snapshot(len(observation['identity_polls']) + 1, remaining)
        observation['identity_polls'].append(snapshot)
        assert clock() < deadline, 'spawned child identity observation exceeded deadline'
        rows = ready_children(snapshot, expected, expected_tasks)
    return rows


def validate_foreign_agent(agent, foreign, other_parent, parent):
    assert other_parent['active'] != parent['active'] and other_parent['durable'] != parent['durable'], 'foreign parent aliases main parent'
    assert agent['activeSessionId'] == foreign['active'] and agent['sessionId'] == foreign['durable'], agent
    assert agent['runtimeKind'] == 'subagent', agent
    assert agent['parentSessionId'] == other_parent['durable'], agent
    assert agent['parentActiveSessionId'] == other_parent['active'], agent


def validate_roster(roster, parent, other_parent, a, b, foreign):
    family = [roster['current']] + roster['agents']
    family_ids = {row.get('activeSessionId') for row in family}
    assert family_ids == {parent['active'], other_parent['active'], a['active'], b['active']}, roster
    assert foreign['active'] not in family_ids, roster
    expected = {other_parent['active']: 'sibling', a['active']: 'child', b['active']: 'child'}
    for active, relationship in expected.items():
        assert any(row.get('activeSessionId') == active and row.get('relationship') == relationship
                   for row in roster['agents']), roster


def selected(row, expected, marker):
    for operation in ('get', 'recent'):
        value = row[operation]['value']
        assert value['agent']['activeSessionId'] == expected['active'], value
        assert value['agent']['sessionId'] == expected['durable'], value
    messages = row['recent']['value']['messages']
    task_texts = [message.get('text') for message in messages
                  if message.get('role') == 'custom' and message.get('customType') == 'agent_message']
    assert task_texts == ['[task from parent]\n\n' + marker], messages
    assert not any('OBSERVE_TASK_B' in message.get('text', '') for message in messages), messages
    assert not any('OBSERVE_TASK_FOREIGN' in message.get('text', '') for message in messages), messages
    return {'selection': 'child-a', 'transcript_marker': marker}


def rejected(row, kind):
    errors = [row[operation].get('error', '') for operation in ('get', 'recent')]
    assert all(errors), row  # A successful foreign/ambiguous read is never accepted.
    if kind == 'ambiguous':
        assert all('Ambiguous active session' in error for error in errors), errors
    else:
        assert all('is not reachable' in error for error in errors), errors
    return {'rejection': kind}


def run_case(binary, root, observation):
    for directory in ('home', 'tmp', 'work', 'agent', 'sessions'):
        (root / directory).mkdir(parents=True)
    root = root.resolve()
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ',
        'PRIME_AGENT_KERNEL_PYTHON', 'PA_E2E_KERNEL_PYTHON') if key in os.environ}
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), DO_NOT_TRACK='1', PI_OFFLINE='1',
        PI_CODING_AGENT_DIR=str(root / 'agent'), PRIME_AGENT_CODING_AGENT_DIR=str(root / 'agent'),
        PI_SESSION_DIR=str(root / 'sessions'), PRIME_AGENT_SESSION_DIR=str(root / 'sessions'),
        XDG_CONFIG_HOME=str(root / 'config'), XDG_CACHE_HOME=str(root / 'cache'), XDG_DATA_HOME=str(root / 'data'),
        PYTHONPATH=skill_pythonpath())
    env[TAG] = str(root)
    provider = Provider()
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'fixture': {
        'api': 'openai-completions', 'apiKey': 'synthetic-only',
        'baseUrl': 'http://127.0.0.1:%s/v1' % provider.server_port,
        'models': [{'id': 'observe-fixture', 'name': 'Observe Fixture', 'reasoning': False,
                    'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    (root / 'agent/settings.json').write_text(json.dumps({'prewarmPythonKernel': False,
        'defaultProvider': 'fixture', 'defaultModel': 'observe-fixture'}))
    socket_path = root / 'd.sock'
    scope = OwnedProcesses(binary, root, socket_path)
    log = (root / 'daemon.log').open('wb')
    command = [str(binary), '--mode', 'daemon', '--daemon-socket', str(socket_path)]
    process = subprocess.Popen(command, cwd=root / 'work', env=env, stdout=log,
                               stderr=subprocess.STDOUT, start_new_session=True)
    client, primary = None, None
    done = threading.Event()
    tracker_errors = []
    def discover():
        while not done.is_set():
            try:
                scope.discover()
            except Exception as error:
                tracker_errors.append(str(error))
                return
            done.wait(0.025)
    tracker = threading.Thread(target=discover, daemon=True)
    try:
        scope.register(process, command)
        client = ObserveClient(socket_path, process)
        tracker.start()
        config = {'cwd': str(root / 'work'), 'agentDir': str(root / 'agent'),
                  'sessionDir': str(root / 'sessions'), 'provider': 'fixture', 'model': 'observe-fixture',
                  'noExtensions': True, 'noContextFiles': True, 'telemetryDisabled': True}
        created = observation['created'] = {}
        def create(name):
            options = {'config': dict(config), 'name': name, 'lifecycle': 'resident'}
            value = client.call('create', **options)
            row = {'active': value.get('activeSessionId') or value.get('id'),
                   'durable': value['sessionId'], 'file': value['sessionFile'], 'raw': value}
            assert row['active'], 'create omitted actual active identity'
            created[name] = row
            deadline = time.monotonic() + LIMIT
            while True:
                scope.discover()
                matches = []
                for path in (root / 'agent/daemon-workers').rglob('*.json'):
                    try:
                        descriptor = json.loads(path.read_text())
                        if descriptor.get('rootActiveSessionId') == row['active']:
                            pid, identity = verify_worker(descriptor, row['active'], binary, socket_path)
                            assert scope.ownership(pid, identity), 'worker lacked fixture ownership'
                            matches.append((pid, identity))
                    except (OSError, ValueError):
                        pass  # Atomic/transitional descriptor reads are not readiness.
                if matches:
                    assert len(matches) == 1, 'duplicate descriptor identity'
                    observation.setdefault('worker_identities', {})[name] = matches[0]
                    break
                assert time.monotonic() < deadline, 'actual worker descriptor never ready'
                threading.Event().wait(0.025)
            return row
        parent = create('observe-parent')
        other_parent = create('observe-other-parent')
        # Parentless roots are siblings in both products. An actual child of
        # that sibling is outside this root's nuclear family (nephew/niece).
        provider.phase = 'foreign_spawn_setup'
        provider.code = """import json, dataclasses
await rlm.spawn('OBSERVE_TASK_FOREIGN', name='observe-foreign-child', model='fixture/observe-fixture')
print('OBSERVE_SELECTORS_PARITY=' + json.dumps({'children': [dataclasses.asdict(row) for row in await rlm.list_subagents()]}, default=str))
"""
        client.call('prompt_and_wait', timeout_seconds=90, activeSessionId=other_parent['active'],
                    message='Spawn an actual child in the other parent family.')
        foreign_setup = current_probe(provider.requests['foreign_spawn_setup'], 'foreign_spawn_setup')
        foreign_observation = observation['foreign_setup'] = {'spawn_setup': foreign_setup}
        with provider.children_arrived:
            assert provider.children_arrived.wait_for(lambda: 'OBSERVE_TASK_FOREIGN' in provider.child_requests,
                timeout=LIMIT), 'foreign child never reached its actual model request'
        def read_foreign_identity(number, remaining):
            phase = 'foreign_identity_poll_%d' % number
            provider.phase, provider.code = phase, READ_CHILDREN
            client.call('prompt_and_wait', timeout_seconds=remaining, activeSessionId=other_parent['active'],
                        message='Read actual foreign child identity readiness.')
            return current_probe(provider.requests[phase], phase)
        foreign_rows = await_child_identities(foreign_setup, read_foreign_identity, foreign_observation,
                                              expected_tasks=FOREIGN_CHILD_TASKS)
        foreign_row = foreign_rows['observe-foreign-child']
        foreign = {'active': foreign_row['active_session_id'], 'durable': foreign_row['session_id'], 'raw': foreign_row}
        created['observe-foreign-child'] = foreign
        provider.phase = 'foreign_topology'
        provider.code = """import json, agent_observe
print('OBSERVE_SELECTORS_PARITY=' + json.dumps(await agent_observe.get_agent('observe-foreign-child')))
"""
        client.call('prompt_and_wait', timeout_seconds=90, activeSessionId=other_parent['active'],
                    message='Observe the actual foreign child parent edges.')
        foreign_agent = current_probe(provider.requests['foreign_topology'], 'foreign_topology')['agent']
        observation['foreign_agent'] = foreign_agent
        validate_foreign_agent(foreign_agent, foreign, other_parent, parent)
        provider.phase = 'spawn_setup'
        provider.code = """import json, dataclasses
await rlm.spawn('OBSERVE_TASK_A', name='observe-child-a', model='fixture/observe-fixture')
await rlm.spawn('OBSERVE_TASK_B', name='observe-child-b', model='fixture/observe-fixture')
print('OBSERVE_SELECTORS_PARITY=' + json.dumps({'children': [dataclasses.asdict(row) for row in await rlm.list_subagents()]}, default=str))
"""
        client.call('prompt_and_wait', timeout_seconds=90, activeSessionId=parent['active'], message='Run actual resident selector spawn setup.')
        setup = current_probe(provider.requests['spawn_setup'], 'spawn_setup')
        observation['spawn_setup'] = setup
        with provider.children_arrived:
            assert provider.children_arrived.wait_for(lambda: set(provider.child_requests) == ALL_TASKS,
                timeout=LIMIT), 'spawned children never reached their actual model requests'
        def read_identity_snapshot(number, remaining):
            phase = 'identity_poll_%d' % number
            provider.phase, provider.code = phase, READ_CHILDREN
            client.call('prompt_and_wait', timeout_seconds=remaining, activeSessionId=parent['active'],
                        message='Read actual spawned child identity readiness.')
            return current_probe(provider.requests[phase], phase)
        rows = await_child_identities(setup, read_identity_snapshot, observation)
        def child(name):
            row = rows[name]
            value = {'active': row['active_session_id'], 'durable': row['session_id'], 'raw': row}
            assert value['active'] and value['durable'], 'live spawn omitted actual IDs'
            created[name] = value
            return value
        a, b = child('observe-child-a'), child('observe-child-b')
        ids = [row[key] for row in created.values() for key in ('active', 'durable')]
        probes = observation['probes'] = {}
        contract = observation['contract'] = {}
        def probe(phase, selectors):
            provider.phase, provider.code = phase, cell(selectors)
            client.call('prompt_and_wait', timeout_seconds=90, activeSessionId=parent['active'],
                        message='Run the resident observe selectors fixture: ' + phase)
            value = current_probe(provider.requests[phase], phase)
            probes[phase] = value
            validate_roster(value['roster'], parent, other_parent, a, b, foreign)
            return value['selectors']
        basic = probe('baseline', {'exact': a['active'], 'active_suffix': suffix(a['active'], ids),
            'durable_suffix': suffix(a['durable'], ids), 'name': 'observe-child-a',
            'foreign_suffix': suffix(foreign['active'], ids)})
        for name in ('exact', 'active_suffix', 'durable_suffix', 'name'):
            contract[name] = selected(basic[name], a, 'OBSERVE_TASK_A')
        contract['foreign_suffix'] = rejected(basic['foreign_suffix'], 'foreign-family')
        client.call('rename', activeSessionId=b['active'], name=a['active'])
        collision = probe('collision', {'exact_id_over_name': a['active']})
        contract['exact_id_over_name'] = selected(collision['exact_id_over_name'], a, 'OBSERVE_TASK_A')
        client.call('rename', activeSessionId=b['active'], name='observe-child-b')
        # Parent and child belong to distinct name namespaces, but both are
        # reachable from the parent.
        client.call('rename', activeSessionId=parent['active'], name='observe-child-a')
        ambiguous = probe('ambiguity', {'duplicate_name': 'observe-child-a'})
        contract['duplicate_name'] = rejected(ambiguous['duplicate_name'], 'ambiguous')
        # Selection is proven only for resident rows; no hydration or full summary equality.
        assert len(observation['worker_identities']) == 2, 'missing owned root-worker proof'
        assert set(provider.child_requests) == ALL_TASKS, 'missing live spawned-child proof'
        assert all(len(requests) == 1 for requests in provider.child_requests.values()), 'child retried/finished during selection'
        assert not provider.child_reply_timeout, 'held child completed before selector proof'
        observation['summary_field_presence'] = {
            phase: {name: {operation: sorted(row[operation]['value']['agent'])
                for operation in ('get', 'recent') if 'value' in row[operation]}
                for name, row in value['selectors'].items()}
            for phase, value in probes.items()}

    except BaseException as error:
        primary = error
        observation['primary_error'] = str(error)
        raise
    finally:
        done.set()
        if tracker.ident is not None:
            tracker.join(timeout=2)
        # Shutdown must interrupt the held child turns before provider teardown.
        finish(scope, client, process, observation)
        provider.release_children.set()
        observation['requests'] = provider.requests
        observation['held_child_requests'] = provider.child_requests
        observation['child_reply_timeout'] = provider.child_reply_timeout
        observation['sent_wire'] = client.sent if client else []
        observation['received_wire'] = client.wire if client else []
        observation['tracker_errors'] = tracker_errors
        if tracker_errors or tracker.is_alive():
            observation['cleanup_verified'] = False
            observation['cleanup_error'] = 'ownership tracker failed: ' + str(tracker_errors)
        log.close()
        observation['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)
        if not observation['cleanup_verified'] and primary is None:
            raise AssertionError('owned observe fixture cleanup failed: ' + observation.get('cleanup_error', 'unknown'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'verified': False, 'scope': 'Resident agent_observe.get/recent/list: exact active ID, '
        'normalized active/durable ID suffix, exact name, exact ID/name precedence, ambiguous name, foreign family rejection.',
        'not_verified': ['Passive child hydration', 'Transient progress-note event retention',
            'latestMessage/full summary fields', 'Tool/image/bash preview fidelity', 'TUI/ACP presentation'],
        'normalization': 'Dynamic IDs verified exactly inside the run, then recorded by selected fixture identity. '
            'All summary/preview objects remain raw.'}
    try:
        assert sys.platform == 'linux', 'requires hosted Linux binaries'
        temp = tempfile.TemporaryDirectory(prefix='observe-selectors-')
        try:
            binary = Path(os.environ['PA_RUST_BINARY']).resolve()
            observation = receipt['run'] = {'binary': str(binary), 'binary_sha256': digest(binary)}
            run_case(binary, Path(temp.name) / 'rust', observation)
            receipt['verified'] = True
        finally:
            primary_pending = sys.exc_info()[0] is not None
            try:
                temp.cleanup()
            except Exception as cleanup_error:
                receipt['directory_cleanup_error'] = str(cleanup_error)
                receipt['verified'] = False
                if not primary_pending:
                    raise  # Preserve an earlier probe error instead of replacing it.

    except Exception as error:
        receipt['error'] = str(error)
        receipt['verified'] = False
    finally:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print('resident observe selectors verified:', receipt['verified'])
    return 0 if receipt['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
