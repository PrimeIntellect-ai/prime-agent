#!/usr/bin/env python3
import ast
import asyncio
import contextlib
import io
import json
from pathlib import Path
import tempfile
import types
import copy
import unittest
from review_late_message_receipt_parity import MESSAGE, PARENT_CELL, late_entries, validate


class LateReceiptGuards(unittest.TestCase):
    def good(self):
        return {'child_result_seen_before_release': True, 'child_request_count': 2,
            'parent_request_count': 3, 'parent_session_id': 'fixture-parent',
            'parent_session_file': '/fixture/parent.jsonl',
            'spawn_handle': {'rlm_child_id': 'fixture-child', 'session_dir': '/fixture/fixture-child'},
            'child_header': {'type': 'session', 'id': 'child-durable', 'parentSession': '/fixture/parent.jsonl'},
            'late_entries': [{'file': '/fixture/fixture-child/child.jsonl', 'entry': {'data': {
                'toolCallId': 'late_child_cell', 'message': {'id': 'fixture-id',
                    'message': MESSAGE, 'receiverRole': 'parent', 'deliveryStatus': 'queued',
                    'target': {'sessionId': 'fixture-parent', 'activeSessionId': 'fixture-parent'}}}}}]}

    def test_spawn_handle_cell_serializes_actual_path_objects(self):
        async def spawn(*args, **kwargs):
            return types.SimpleNamespace(rlm_child_id='child-fixture',
                                         session_dir=Path('/fixture/child-fixture'))
        code = compile(PARENT_CELL, 'spawn-cell', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            asyncio.run(eval(code, {'rlm': types.SimpleNamespace(spawn=spawn)}))
        self.assertEqual(json.loads(output.getvalue().strip().removeprefix('LATE_SPAWN_HANDLE=')),
                         {'rlm_child_id': 'child-fixture', 'session_dir': '/fixture/child-fixture'})

    def test_blank_and_partial_jsonl_are_not_complete_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'child.jsonl'
            row = {'type': 'custom', 'customType': 'ipython_sent_agent_message', 'data': {}}
            path.write_text('\n' + json.dumps(row) + '\n' + '{"partial":')
            self.assertEqual(late_entries(Path(directory)), [{'file': str(path), 'entry': row}])
            path.write_text('{malformed complete row}\n')
            with self.assertRaises(json.JSONDecodeError):
                late_entries(Path(directory))

    def test_runtime_and_durable_parent_ids_may_differ(self):
        changed = self.good()
        changed['late_entries'][0]['entry']['data']['message']['target']['activeSessionId'] = 'runtime-parent'
        self.assertEqual(validate(changed), validate(self.good()))
        for active_id in ['', '   ', None, 42]:
            changed['late_entries'][0]['entry']['data']['message']['target']['activeSessionId'] = active_id
            with self.assertRaises(AssertionError):
                validate(changed)
        del changed['late_entries'][0]['entry']['data']['message']['target']['activeSessionId']
        with self.assertRaises(AssertionError):
            validate(changed)

    def test_actual_late_payload_and_readiness_are_required(self):
        validate(self.good())
        for key, value in [('child_result_seen_before_release', False),
                           ('child_request_count', 1), ('parent_request_count', 1),
                           ('late_entries', [])]:
            changed = {**self.good(), key: value}
            with self.assertRaises(AssertionError):
                validate(changed)
        for key, value in [('message', 'foreign'), ('receiverRole', 'child'),
                           ('deliveryStatus', 'failed'), ('id', '')]:
            changed = self.good()
            changed['late_entries'][0]['entry']['data']['message'][key] = value
            with self.assertRaises(AssertionError):
                validate(changed)
        changed = self.good()
        changed['late_entries'][0]['entry']['data']['message']['target']['sessionId'] = 'foreign'
        with self.assertRaises(AssertionError):
            validate(changed)
        changed = self.good()
        changed['late_entries'].append(copy.deepcopy(changed['late_entries'][0]))
        with self.assertRaises(AssertionError):
            validate(changed)
        changed = self.good()
        changed['late_entries'][0]['file'] = '/fixture/foreign/child.jsonl'
        with self.assertRaises(AssertionError):
            validate(changed)
        changed = self.good()
        changed['child_header']['parentSession'] = '/fixture/foreign-parent.jsonl'
        with self.assertRaises(AssertionError):
            validate(changed)
        changed = self.good()
        changed['late_entries'][0]['entry']['data']['toolCallId'] = 'historical' 
        with self.assertRaises(AssertionError):
            validate(changed)


if __name__ == '__main__':
    unittest.main()
