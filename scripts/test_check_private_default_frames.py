"""Guard actual-startup receipt acceptance without choosing model priority."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock

from check_private_default_frames import PUBLIC, PRIVATE, WARNING, Screen, connection_model, wait_for_created_session, validate_observation, write_frame


def observation(scenario):
    warn = scenario == 'unavailable'
    return {'selected_model': PUBLIC,
            'available_ids': [PUBLIC] if scenario == 'unavailable' else [PUBLIC, PRIVATE],
            'fallback_message': WARNING + ' Using prime-inference/' + PUBLIC if warn else None,
            'frames': {f'{columns}x{rows}': {'columns': columns, 'rows': rows,
                       'input_preserved': True, 'selected_model_id_visible': True,
                       'warning_prefix_count': int(warn), 'warning_text_complete': True}
                       for columns, rows in ((120, 40), (80, 28))}}


class CaptureGuards(unittest.TestCase):
    def test_spawned_worker_waits_for_create_but_other_refusals_fail(self):
        terminal = Mock()
        def wait(_description, predicate):
            self.assertFalse(predicate())
            self.assertTrue(predicate())
        terminal.wait.side_effect = wait
        state = {'model': {'id': PUBLIC}}
        client = Mock()
        client.call.side_effect = [AssertionError({'success': False,
            'error': 'Unknown active session: fixture'}), state]
        self.assertEqual(wait_for_created_session(terminal, client, 'fixture'), state)
        self.assertEqual(client.call.call_count, 2)
        client.call.side_effect = [AssertionError({'success': False,
            'errorInfo': {'code': 'session_recovering', 'activeSessionId': 'fixture'}}), state]
        self.assertEqual(wait_for_created_session(terminal, client, 'fixture'), state)
        for message in ('Session worker is starting', 'Session worker is recovering',
                        'Session worker is not connected'):
            client.call.side_effect = [AssertionError({'success': False, 'error': message}), state]
            self.assertEqual(wait_for_created_session(terminal, client, 'fixture'), state)
        terminal.wait.side_effect = lambda _description, predicate: predicate()
        for message in ('Permission denied', 'Session worker is failed', 'Session worker is stopping',
                        'Daemon client is not attached to this session'):
            client.call.side_effect = AssertionError({'success': False, 'error': message})
            with self.assertRaises(AssertionError):
                wait_for_created_session(terminal, client, 'fixture')
        client.call.side_effect = AssertionError({'success': False,
            'errorInfo': {'code': 'session_recovering', 'activeSessionId': 'other'}})
        with self.assertRaises(AssertionError):
            wait_for_created_session(terminal, client, 'fixture')

    def test_both_connection_state_shapes_keep_the_same_model(self):
        model = {'id': PUBLIC, 'provider': 'prime-inference'}
        self.assertEqual(connection_model({'model': model}),
                         connection_model({'state': {'model': model}}))

    def test_characterization_does_not_approve_either_priority_policy(self):
        for selected in (PUBLIC, PRIVATE):
            value = observation('authorized')
            value['selected_model'] = selected
            validate_observation('authorized', value)

    def test_unavailable_or_excluded_private_model_is_rejected(self):
        for scenario in ('unavailable', 'excluded'):
            value = observation(scenario)
            value['selected_model'] = PRIVATE
            with self.assertRaisesRegex(AssertionError, 'unavailable or excluded'):
                validate_observation(scenario, value)

    def test_mismatched_authorization_state_is_rejected(self):
        for scenario in ('authorized', 'unavailable'):
            value = observation(scenario)
            value['available_ids'] = [PUBLIC] if scenario == 'authorized' else [PUBLIC, PRIVATE]
            with self.assertRaisesRegex(AssertionError, 'authorization fixture'):
                validate_observation(scenario, value)

    def test_missing_duplicate_warning_or_lost_input_is_rejected(self):
        for field, replacement in (('warning_prefix_count', 0), ('warning_prefix_count', 2),
                                   ('input_preserved', False), ('selected_model_id_visible', False),
                                   ('columns', 119), ('warning_text_complete', False)):
            value = observation('unavailable')
            value['frames']['120x40'][field] = replacement
            with self.assertRaises(AssertionError):
                validate_observation('unavailable', value)

    def test_unexpected_warning_outside_unavailable_case_is_rejected(self):
        for scenario in ('authorized', 'excluded'):
            value = observation(scenario)
            value['fallback_message'] = WARNING
            with self.assertRaisesRegex(AssertionError, 'unexpected warning'):
                validate_observation(scenario, value)

    def test_svg_escapes_real_cells_and_retains_matched_dimensions(self):
        screen = Screen(120, 40)
        screen.feed(b'<fixture>&')
        terminal = type('CapturedTerminal', (), {'screen': screen, 'raw': b'<fixture>&'})()
        with tempfile.TemporaryDirectory() as temp:
            frame = write_frame(Path(temp), 'capture', terminal)
            self.assertEqual((frame['columns'], frame['rows']), (120, 40))
            svg = (Path(temp) / 'capture.svg').read_text()
            self.assertIn('&lt;fixture&gt;&amp;', svg)
            self.assertNotIn('<fixture>', svg)


if __name__ == '__main__':
    unittest.main()
