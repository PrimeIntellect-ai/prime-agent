"""Readiness-driven cancellation checks against real hosted CLI/daemon binaries."""
import hashlib
import json
import os
import time

from hooks_transport_probe import Child, Client, Fixture, connect, require, write_json


def wait_for(predicate, message, timeout=5):
    deadline = time.monotonic() + timeout
    while not predicate():
        require(time.monotonic() < deadline, message)
        time.sleep(.01)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def prepare(root):
    fixture = Fixture(root, hooks=False)
    write_json(fixture.agent / 'settings.json', {
        'compaction': {'enabled': False, 'keepRecentTokens': 10},
        'prewarmPythonKernel': False})
    write_json(fixture.script, {'engine': 'faux', 'responses': [
        {'text': 'First answer with enough history to summarize.'},
        {'text': 'Second answer retained after the earlier conversation.'}]})
    fixture.env['PRIME_AGENT_FAUX_SCRIPT'] = fixture.script.read_text()
    source = fixture.cwd / '.prime/hooks.json'
    write_json(source, {'hooks': {'PreCompact': [{'hooks': [{
        'type': 'command', 'timeout': 60,
        'command': 'cat >> compact-input.jsonl; printf "\\n" >> compact-input.jsonl; '
                   'echo $$ > hook.pid; touch hook-ready; '
                   'while [ ! -f release-hook ]; do sleep 0.05; done'}]}]}})
    digest = hashlib.sha256(os.fsencode(source.resolve()) + b'\0' +
                            os.fsencode(fixture.cwd.resolve()) + b'\0' + source.read_bytes()).hexdigest()
    write_json(fixture.agent / 'hook-trust.json', {'version': 1, 'trusted': [digest]})
    return fixture


def seed(client, session_id=None):
    for text in ('First conversation to summarize with enough words.',
                 'Second conversation to keep with enough words.'):
        command = {'type': 'prompt', 'message': text}
        if session_id:
            command['activeSessionId'] = session_id
        client.request(command)
        client.settled()


def ready(fixture):
    wait_for(lambda: (fixture.cwd / 'hook-ready').exists(), 'PreCompact never became ready')
    pid = int((fixture.cwd / 'hook.pid').read_text())
    require(alive(pid), 'hook exited before host cancellation')
    return pid


def evidence(fixture, pid, elapsed):
    wait_for(lambda: not alive(pid), 'cancellation left hook process alive')
    inputs = [json.loads(line) for line in (fixture.cwd / 'compact-input.jsonl').read_text().splitlines()
              if line.strip()]
    require(len(inputs) == 1, 'PreCompact invoked more than once')
    require(inputs[0]['hook_event_name'] == 'PreCompact' and inputs[0]['trigger'] == 'manual',
            'unexpected compaction payload')
    require(elapsed < 5, 'host waited for the 60-second hook timeout')
    return {'verified': True, 'hook_invocations': 1, 'hook_process_terminated': True,
            'cancel_to_settle_ms': elapsed * 1000, 'input': inputs[0]}


def daemon_cancel(binary, root, abort_first):
    fixture = prepare(root)
    path = fixture.root / 'daemon.sock'
    child = Child([str(binary), 'supervisor', '--socket', str(path),
                   '--agent-dir', str(fixture.agent)], fixture)
    control = cancel = None
    try:
        control = Client(connect(path))
        control.receive()
        created = control.request({'type': 'create', 'config': {
            'cwd': str(fixture.cwd), 'sessionDir': str(fixture.agent / 'sessions'),
            'script': str(fixture.script)}})
        session_id = created.get('id', created.get('sessionId'))
        require(session_id, 'missing daemon session')
        control.request({'type': 'attach', 'activeSessionId': session_id})
        seed(control, session_id)
        control.request({'type': 'prompt', 'activeSessionId': session_id, 'message': '/compact'})
        pid = ready(fixture)
        # A separate connection must be able to cancel a busy slash command.
        cancel = Client(connect(path))
        cancel.receive()
        cancel.connection.settimeout(5)
        started = time.monotonic()
        if abort_first:
            cancel.request({'type': 'abort', 'activeSessionId': session_id})
            wait_for(lambda: not alive(pid), 'daemon abort did not cancel PreCompact')
            cancel.request({'type': 'kill', 'activeSessionId': session_id})
        cancel.request({'type': 'shutdown'})
        child.process.wait(timeout=5)
        return evidence(fixture, pid, time.monotonic() - started)
    finally:
        # Release on failure so cleanup cannot leave the intentionally slow hook.
        (fixture.cwd / 'release-hook').touch()
        if cancel:
            cancel.close()
        if control:
            control.close()
        child.close()


def rpc_cancel(binary, root, slash):
    fixture = prepare(root)
    child = Child([str(binary), '--mode', 'rpc'], fixture)
    client = Client(child)
    try:
        client.request({'type': 'get_state'})
        seed(client)
        compact_id = client.send({'type': 'prompt', 'message': '/compact'} if slash else {'type': 'compact'})
        pid = ready(fixture)
        started = time.monotonic()
        abort_id = client.send({'type': 'abort'})
        # One reader; no competing reads against the pending command response.
        deadline = time.monotonic() + 5
        pending = {compact_id, abort_id}
        while pending:
            line = child.lines.get(timeout=max(.001, deadline - time.monotonic()))
            require(line is not None, 'RPC exited before acknowledging abort')
            frame = json.loads(line)
            if frame.get('id') == abort_id:
                require(frame.get('success'), 'RPC abort rejected')
            pending.discard(frame.get('id'))
            require(time.monotonic() < deadline, 'RPC abort did not settle')
        wait_for(lambda: not alive(pid), 'RPC abort did not cancel PreCompact')
        child.process.stdin.close()
        require(child.process.wait(timeout=5) == 0, 'RPC shutdown failed')
        return evidence(fixture, pid, time.monotonic() - started)
    finally:
        (fixture.cwd / 'release-hook').touch()
        child.close()


def verify_compaction_cancellation(cli, daemon, root, results):
    for name in ('daemon_abort', 'daemon_shutdown', 'rpc_compact_abort', 'rpc_slash_abort'):
        directory = root / name
        directory.mkdir()
        result = results[name] = {'verified': False}
        try:
            result.update(daemon_cancel(daemon, directory, name == 'daemon_abort')
                          if name.startswith('daemon')
                          else rpc_cancel(cli, directory, name == 'rpc_slash_abort'))
        finally:
            result['raw_evidence'] = {
                str(path.relative_to(directory)): path.read_text(errors='replace')
                for path in directory.rglob('*') if path.is_file() and
                (path.name.startswith('stderr-') or path.name in ('hook.pid', 'compact-input.jsonl'))}
    return results
