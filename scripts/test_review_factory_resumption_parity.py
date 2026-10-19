import copy
import json
import unittest
from review_factory_resumption_parity import MARKER, extract, validate


class FactoryReceiptGuards(unittest.TestCase):
    def probe(self):
        return {'paused': {'state': 'paused'}, 'done': {'state': 'done', 'nodes': [
            {'id': 'work', 'status': 'done', 'entries_used': 1, 'attempts': 2},
            {'id': 'verified', 'status': 'done', 'entries_used': 1, 'attempts': 1}]}}

    def test_rejects_missing_resume_extra_entry_or_extra_attempt(self):
        validate(self.probe())
        for key, value in [('entries_used', 2), ('attempts', 1), ('attempts', 3), ('status', 'error')]:
            probe = self.probe()
            probe['done']['nodes'][0][key] = value
            with self.assertRaises(AssertionError):
                validate(probe)

    def test_accepts_explicit_wire_camel_case_without_ignoring_duplicates(self):
        probe = self.probe()
        for row in probe['done']['nodes']:
            row['entriesUsed'] = row.pop('entries_used')
        validate(probe)
        probe['done']['nodes'][0]['entries_used'] = 1
        with self.assertRaises(AssertionError):
            validate(probe)

    def test_rejects_missing_or_historical_tool_receipt(self):
        probe = self.probe()
        tool = {'role': 'tool', 'tool_call_id': 'factory_probe',
                'content': MARKER + json.dumps(probe)}
        rows = [{}, {'messages': [tool]}]
        self.assertEqual(extract(rows), probe)
        for changed in [[{'messages': [tool]}, {'messages': []}],
                        [{}, {'messages': [tool, copy.deepcopy(tool)]}],
                        [{}, {'messages': [{**tool, 'tool_call_id': 'historical'}]}]]:
            with self.assertRaises(AssertionError):
                extract(changed)


if __name__ == '__main__':
    unittest.main()
