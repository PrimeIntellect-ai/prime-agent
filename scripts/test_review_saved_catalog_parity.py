import copy
import json
from pathlib import Path
import tempfile
import unittest

from review_saved_catalog_parity import (COUNT, PAGE, TARGET, TRANSCRIPT_TARGET,
    normalize, same_rows, seed, ts_ignores_paging, validate_query)


class SavedCatalogGuards(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.expected = seed(self.root)

    def call(self, rows=None, remaining=0, cursor=None):
        rows = copy.deepcopy(self.expected if rows is None else rows)
        for row in rows:
            row['path'] = str(self.root / 'agent/sessions' / row['path'])
        data = {'sessions': rows, 'remaining': remaining}
        if cursor is not None:
            data['nextCursor'] = cursor
        frames = [{'type': 'session_list_item', 'id': '1',
            'command': 'list_saved_sessions', 'session': row} for row in rows]
        frames.append({'type': 'session_list_progress', 'id': '1',
            'command': 'list_saved_sessions', 'loaded': len(rows), 'total': len(rows)})
        frames.append({'type': 'response', 'id': '1', 'success': True,
            'command': 'list_saved_sessions', 'data': data})
        request = {'type': 'command', 'id': '1',
            'command': {'type': 'list_saved_sessions', 'cwd': '/tmp/catalog-paging-fixture',
                        'scope': 'all'}}
        return {'paging': {}, 'frames': frames, 'final_data': data,
            'raw_received_hex': [(json.dumps(frame) + '\n').encode().hex() for frame in frames],
            'raw_sent_hex': [(json.dumps(request) + '\n').encode().hex()]}

    def refresh_raw(self, call):
        call['raw_received_hex'] = [(json.dumps(frame) + '\n').encode().hex()
                                    for frame in call['frames']]

    def check(self, call, rows=None, **kwargs):
        return validate_query(call, self.root, self.expected if rows is None else rows,
                              ordered=True, remaining=0, **kwargs)

    def test_fixture_is_valid_ordered_and_old_target_is_beyond_first_page(self):
        files = sorted((self.root / 'agent/sessions').glob('*.jsonl'))
        self.assertGreater(len(files), PAGE)
        self.assertEqual(len(files), COUNT)
        mtimes = [path.stat().st_mtime_ns for path in files]
        self.assertEqual(len(set(mtimes)), COUNT)
        self.assertEqual(mtimes, sorted(mtimes))
        for path in files:
            entries = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(entries[0]['type'], 'session')
            self.assertEqual(entries[0]['id'], path.stem)
            self.assertEqual(entries[-1]['message']['role'], 'assistant')
        self.assertNotIn(TARGET, json.dumps(self.expected[:PAGE]))
        self.assertEqual(self.expected[-1]['name'], TARGET)
        self.assertIn(TRANSCRIPT_TARGET, self.expected[-1]['allMessagesText'])
        self.assertNotIn(TRANSCRIPT_TARGET, self.expected[-1]['firstMessage'])
        self.assertEqual(self.check(self.call()), self.expected)

    def test_rejects_missing_duplicate_wrong_or_transcript_truncated_rows(self):
        for mutate in (
            lambda rows: rows.pop(),
            lambda rows: rows.append(copy.deepcopy(rows[0])),
            lambda rows: rows[0].update(name='wrong'),
            lambda rows: rows[-1].update(allMessagesText=rows[-1]['firstMessage']),
        ):
            call = self.call()
            mutate(call['final_data']['sessions'])
            self.refresh_raw(call)
            with self.assertRaises(AssertionError):
                self.check(call)
        escaped = self.call()
        escaped['final_data']['sessions'][0]['path'] = '/ambient/session.jsonl'
        with self.assertRaises(AssertionError):
            self.check(escaped)

    def test_pages_cover_full_catalog_once_and_wrong_boundary_is_rejected(self):
        first = self.call(self.expected[:PAGE], COUNT - PAGE, 'boundary')
        validate_query(first, self.root, self.expected[:PAGE], ordered=True,
                       remaining=COUNT - PAGE, cursor=True)
        rest = self.call(self.expected[PAGE:])
        self.check(rest, self.expected[PAGE:])
        joined = normalize(first['final_data']['sessions'] + rest['final_data']['sessions'], self.root)
        self.assertEqual(joined, self.expected)
        for key, value in (('remaining', 0), ('nextCursor', '')):
            broken = copy.deepcopy(first)
            broken['final_data'][key] = value
            self.refresh_raw(broken)
            with self.assertRaises(AssertionError):
                validate_query(broken, self.root, self.expected[:PAGE], ordered=True,
                               remaining=COUNT - PAGE, cursor=True)
        with self.assertRaises(AssertionError):
            self.check(self.call(self.expected[PAGE - 1:]), self.expected[PAGE:])
        with self.assertRaises(AssertionError):
            self.check(self.call(self.expected[PAGE:], cursor='not-finished'), self.expected[PAGE:])

    def test_deleted_cursor_boundary_still_requires_the_complete_older_tail(self):
        boundary = self.root / 'agent/sessions' / self.expected[PAGE - 1]['path']
        boundary.unlink()
        self.assertFalse(boundary.exists())
        tail = self.expected[PAGE:]
        self.assertEqual(self.check(self.call(tail), tail), tail)
        self.assertEqual(tail[-1]['name'], TARGET)
        with self.assertRaises(AssertionError):
            self.check(self.call(tail[1:]), tail)

    def test_raw_terminal_and_stream_disagreement_fail_closed(self):
        for mode in ('missing_raw', 'bad_raw', 'wrong_request', 'wrong_stream',
                     'duplicate_stream', 'wrong_order', 'no_stream', 'after_final'):
            call = self.call()
            if mode == 'missing_raw':
                call['raw_received_hex'] = []
            elif mode == 'bad_raw':
                call['raw_received_hex'][0] = b'{}\n'.hex()
            elif mode == 'wrong_request':
                call['raw_sent_hex'] = [b'{"id":"elsewhere","command":{}}\n'.hex()]
            elif mode == 'wrong_stream':
                call['frames'][0] = copy.deepcopy(call['frames'][0])
                call['frames'][0]['session']['allMessagesText'] = 'lost transcript'
            elif mode == 'duplicate_stream':
                call['frames'].insert(0, copy.deepcopy(call['frames'][0]))
            elif mode == 'wrong_order':
                call['frames'][0], call['frames'][1] = call['frames'][1], call['frames'][0]
            elif mode == 'no_stream':
                call['frames'] = call['frames'][-2:]
            else:
                call['frames'].append(copy.deepcopy(call['frames'][0]))
            if mode not in ('missing_raw', 'bad_raw', 'wrong_request'):
                self.refresh_raw(call)
            with self.subTest(mode=mode), self.assertRaises(AssertionError):
                self.check(call)
        # Dropped streamed items are legal under real Rust backpressure.
        call = self.call()
        del call['frames'][1:PAGE]
        self.refresh_raw(call)
        self.check(call)

    def test_ts_baseline_order_is_not_misrepresented_as_paging_parity(self):
        call = self.call(list(reversed(self.expected)))
        del call['final_data']['remaining']
        self.refresh_raw(call)
        rows = validate_query(call, self.root, self.expected)
        same_rows(rows, self.expected)
        ts_ignores_paging(call)
        for extra in ({'remaining': 0}, {'nextCursor': 'new-ts-cursor'}):
            broken = copy.deepcopy(call)
            broken['final_data'].update(extra)
            with self.assertRaises(AssertionError):
                ts_ignores_paging(broken)
        with self.assertRaises(AssertionError):
            validate_query(self.call(self.expected[:PAGE]), self.root, self.expected)


if __name__ == '__main__':
    unittest.main()
