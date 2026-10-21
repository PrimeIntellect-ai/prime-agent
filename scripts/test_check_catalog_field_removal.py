import copy
import json
from pathlib import Path
import tempfile
import unittest

from check_catalog_field_removal import COUNT, CWD, REMOVED, seed, validate


class CatalogFieldRemovalGuards(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.expected = seed(self.root)

    def observation(self):
        rows = copy.deepcopy(self.expected)
        for row in rows:
            row['path'] = str(self.root / 'agent/sessions' / row['path'])
        frames = [{'type': 'session_list_item', 'id': '1',
            'command': 'list_saved_sessions', 'session': copy.deepcopy(row)} for row in rows]
        frames.append({'type': 'session_list_progress', 'id': '1',
            'command': 'list_saved_sessions', 'loaded': COUNT, 'total': COUNT})
        data = {'sessions': rows}
        frames.append({'type': 'response', 'id': '1', 'command': 'list_saved_sessions',
                       'success': True, 'data': data})
        observed = {'frames': frames, 'final_data': data, 'raw_sent_hex': [json.dumps({
            'id': '1', 'type': 'command', 'command': {'type': 'list_saved_sessions',
                'cwd': CWD, 'scope': 'all'}}).encode().hex()]}
        self.raw(observed)
        return observed

    def raw(self, observed):
        observed['raw_received_hex'] = [(json.dumps(frame) + '\n').encode().hex()
                                       for frame in observed['frames']]

    def check(self, observed):
        return validate(observed, self.root, self.expected)

    def test_omission_keeps_seeded_stable_fields(self):
        self.assertEqual(self.check(self.observation()),
                         sorted(self.expected, key=lambda row: row['id']))
        for path in (self.root / 'agent/sessions').glob('*.jsonl'):
            entries = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(entries[0]['type'], 'session')
            self.assertEqual(entries[0]['id'], path.stem)
            self.assertIn('café 界', entries[-1]['message']['content'][0]['text'])

    def test_null_empty_or_text_key_fails_in_both_stream_and_final(self):
        for location in ('stream', 'final'):
            for value in (None, '', 'stale text'):
                observed = self.observation()
                row = observed['frames'][0]['session'] if location == 'stream' else observed['final_data']['sessions'][0]
                row[REMOVED] = value
                self.raw(observed)
                with self.subTest(location=location, value=value), self.assertRaises(AssertionError):
                    self.check(observed)

    def test_missing_duplicate_escaped_or_changed_stable_rows_fail(self):
        for location in ('stream', 'final'):
            for mode in ('missing', 'duplicate', 'escaped', 'changed'):
                observed = self.observation()
                rows = [frame['session'] for frame in observed['frames'] if frame['type'] == 'session_list_item'] if location == 'stream' else observed['final_data']['sessions']
                if mode == 'missing':
                    if location == 'stream':
                        observed['frames'].pop(0)
                    else:
                        rows.pop()
                elif mode == 'duplicate':
                    if location == 'stream':
                        observed['frames'].insert(0, copy.deepcopy(observed['frames'][0]))
                    else:
                        rows.append(copy.deepcopy(rows[0]))
                else:
                    rows[0]['path' if mode == 'escaped' else 'name'] = '/ambient/escaped.jsonl' if mode == 'escaped' else 'wrong'
                self.raw(observed)
                with self.subTest(location=location, mode=mode), self.assertRaises(AssertionError):
                    self.check(observed)

    def test_missing_raw_wrong_request_and_postterminal_frames_fail_closed(self):
        for mode in ('missing_raw', 'wrong_raw', 'wrong_request', 'after_final', 'failure'):
            observed = self.observation()
            if mode == 'missing_raw':
                observed['raw_received_hex'] = []
            elif mode == 'wrong_raw':
                observed['raw_received_hex'][0] = b'{}\n'.hex()
            elif mode == 'wrong_request':
                observed['raw_sent_hex'] = [b'{"id":"wrong","command":{}}'.hex()]
            else:
                if mode == 'after_final':
                    observed['frames'].append(copy.deepcopy(observed['frames'][0]))
                else:
                    observed['frames'][-1]['success'] = False
                self.raw(observed)
            with self.subTest(mode=mode), self.assertRaises(AssertionError):
                self.check(observed)


if __name__ == '__main__':
    unittest.main()
