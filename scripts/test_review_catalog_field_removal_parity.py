import copy
import json
from pathlib import Path
import tempfile
import unittest

from review_catalog_field_removal_parity import (COUNT, CWD, REMOVED, seed, validate)


class CatalogFieldRemovalGuards(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.expected, self.transcripts = seed(self.root)

    def observation(self, kind):
        rows = copy.deepcopy(self.expected)
        for row in rows:
            row['path'] = str(self.root / 'agent/sessions' / row['path'])
            if kind == 'ts':
                row[REMOVED] = self.transcripts[row['id']]
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

    def check(self, observed, kind):
        return validate(observed, kind, self.root, self.expected, self.transcripts)

    def test_exact_ts_corpus_and_rust_omission_keep_same_stable_fields(self):
        self.assertEqual(self.check(self.observation('ts'), 'ts'),
                         self.check(self.observation('rust'), 'rust'))
        for path in (self.root / 'agent/sessions').glob('*.jsonl'):
            entries = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(entries[0]['type'], 'session')
            self.assertEqual(entries[0]['id'], path.stem)
            self.assertIn('café 界', entries[-1]['message']['content'][0]['text'])

    def test_rust_null_empty_or_text_key_fails_in_both_stream_and_final(self):
        for location in ('stream', 'final'):
            for value in (None, '', 'stale text'):
                observed = self.observation('rust')
                row = observed['frames'][0]['session'] if location == 'stream' else observed['final_data']['sessions'][0]
                row[REMOVED] = value
                self.raw(observed)
                with self.subTest(location=location, value=value), self.assertRaises(AssertionError):
                    self.check(observed, 'rust')

    def test_ts_missing_empty_or_firstmessage_alias_fails_in_stream_and_final(self):
        for location in ('stream', 'final'):
            for mode in ('missing', 'empty', 'first_message'):
                observed = self.observation('ts')
                row = observed['frames'][0]['session'] if location == 'stream' else observed['final_data']['sessions'][0]
                if mode == 'missing':
                    del row[REMOVED]
                else:
                    row[REMOVED] = '' if mode == 'empty' else row['firstMessage']
                self.raw(observed)
                with self.subTest(location=location, mode=mode), self.assertRaises(AssertionError):
                    self.check(observed, 'ts')

    def test_missing_duplicate_escaped_or_changed_stable_rows_fail(self):
        for location in ('stream', 'final'):
            for mode in ('missing', 'duplicate', 'escaped', 'changed'):
                observed = self.observation('rust')
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
                    self.check(observed, 'rust')

    def test_missing_raw_wrong_request_and_postterminal_frames_fail_closed(self):
        for mode in ('missing_raw', 'wrong_raw', 'wrong_request', 'after_final', 'failure'):
            observed = self.observation('rust')
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
                self.check(observed, 'rust')


if __name__ == '__main__':
    unittest.main()
