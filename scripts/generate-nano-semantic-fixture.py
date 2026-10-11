"""Capture reference semantic snapshots from a nano-rlm checkout (no dependencies).

Run: uv run --no-project -- python scripts/generate-nano-semantic-fixture.py /path/to/nano-rlm
"""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

if len(sys.argv) != 2:
    raise SystemExit('usage: generate-nano-semantic-fixture.py /path/to/nano-rlm')
revision = subprocess.check_output(['git', '-C', sys.argv[1], 'rev-parse', 'HEAD'], text=True).strip()
if not revision.startswith('4e9d230'):
    raise SystemExit('reference checkout must be nano-rlm@4e9d230')
spec = importlib.util.spec_from_file_location('nano_semantic', Path(sys.argv[1]) / 'src/rlm/semantic.py')
nano = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = nano
spec.loader.exec_module(nano)

cases = []
for scenario in ('continuation_retry', 'compaction_completed', 'compaction_failed', 'compaction_cancelled', 'child_result', 'child_failed', 'child_cancelled', 'agent_message', 'pending_compaction', 'spawn_retry'):
    tracker = nano.SemanticEdgeTracker()
    events = []
    ids = {}
    def emit(session, event):
        events.append({'session': session, 'event': event, 'expected': tracker.snapshot()})
    def register(session, parent=None, source=None):
        tracker.register_session(session, parent_session_id=parent, spawned_by_request_id=source)
        emit(session, dict(type='session_registered', session_id=session, parent_session_id=parent, spawned_by_request_id=source))
    def start(session, name, compaction=None):
        nano.uuid.uuid4 = lambda: SimpleNamespace(hex=name)
        request = tracker.start_request(session, compaction_id=compaction)
        ids[name] = session
        emit(session, dict(type='request_started', session_id=session, request_id=request, compaction_id=compaction))
        return request
    def finish(name):
        tracker.finish_request(name)
        emit(ids[name], dict(type='request_finished', request_id=name))
    def fail(name):
        tracker.fail_request(name)
        emit(ids[name], dict(type='request_failed', request_id=name))
    def compact(session, status, pending=False):
        nano.uuid.uuid4 = lambda: SimpleNamespace(hex='compact')
        c = tracker.begin_compaction(session)
        emit(session, dict(type='compaction_begun', session_id=session, compaction_id=c.compaction_id))
        start(session, 'summary', c.compaction_id)
        finish('summary')
        tracker.finish_compaction(c.compaction_id, status)
        emit(session, dict(type='compaction_finished', compaction_id=c.compaction_id, status=status))
        start(session, 'after_summary')
        finish('after_summary')
    register('root')
    start('root', 'r1'); finish('r1')
    if scenario == 'continuation_retry':
        start('root', 'failed'); fail('failed')
        start('root', 'r2'); finish('r2')
    elif scenario.startswith('compaction_'):
        compact('root', scenario.removeprefix('compaction_'))
    elif scenario in ('child_result', 'child_failed', 'child_cancelled', 'spawn_retry', 'pending_compaction'):
        register('child', 'root', 'r1')
        start('child', 'c1')
        if scenario == 'spawn_retry':
            fail('c1'); start('child', 'c2'); finish('c2')
        else:
            finish('c1')
        if scenario == 'child_cancelled':
            tracker.record_subagent_cancel('r1', 'child')
            emit('root', dict(type='child_cancelled', child_session_id='child', source_request_id='r1', target_request_id='c1'))
            tracker.record_subagent_cancel('r1', 'child')
            emit('root', dict(type='child_cancelled', child_session_id='child', source_request_id='r1', target_request_id='c1'))
        elif scenario != 'spawn_retry':
            # Finishing background work alone creates no child-to-parent edge.
            emit('root', dict(type='child_returned', session_id='root', child_session_id='child', request_id='c1'))
            kind = 'subagent_failed' if scenario == 'child_failed' else 'subagent_return'
            tracker.finish_subagent('child', edge_type=kind)
            event = dict(type='child_result_collected', child_session_id='child', request_id='c1', failed=kind == 'subagent_failed')
            emit('root', event)
            tracker.finish_subagent('child', edge_type=kind); emit('root', event)
        if scenario == 'pending_compaction':
            compact('root', 'completed', pending=True)
        else:
            start('root', 'r2'); finish('r2')
    else:
        tracker.deliver_message('root', 'sender', edge_type='agent_message')
        emit('root', dict(type='dependency_received', request_id='sender', kind='agent_message'))
        tracker.deliver_message('root', 'sender', edge_type='agent_message')
        emit('root', dict(type='dependency_received', request_id='sender', kind='agent_message'))
        start('root', 'failed'); fail('failed')
        start('root', 'r2'); finish('r2')
    cases.append({'name': scenario, 'steps': events})

out = Path(__file__).resolve().parents[1] / 'crates/pa-core/testdata/nano-semantic-edges-v1.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({'source': 'PrimeIntellect-ai/nano-rlm@4e9d230', 'cases': cases}, indent=2) + '\n')
print(f'Captured {len(cases)} scenarios and {sum(len(c["steps"]) for c in cases)} snapshots from nano-rlm')
