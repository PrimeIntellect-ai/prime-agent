"""Guard exact changed-surface receipts without running product binaries."""
import ast
import json
import unittest

import check_observe_selectors as fixture


class SelectorReceiptTests(unittest.TestCase):
    def test_normalized_suffix_is_unique_and_preserves_case_hyphen_probe(self):
        value = fixture.suffix('abcd-00112233', ['abcd-00112233', 'different-99992233'])
        self.assertEqual(value, '0011-2233')
        self.assertEqual(fixture.suffix('abcd-00112233', ['abcd-00112233', 'abcd-00112233']), value)

    def test_colliding_suffix_extends_before_selection(self):
        value = fixture.suffix('abc000112233', ['abc000112233', 'def000112233'])
        normalized = value.replace('-', '').lower()
        self.assertTrue('abc000112233'.endswith(normalized))
        self.assertFalse('def000112233'.endswith(normalized))

    def test_current_probe_rejects_stale_or_duplicate_tool_results(self):
        message = {'role': 'tool', 'tool_call_id': 'observe_current',
                   'content': fixture.MARKER + json.dumps({'actual': True})}
        call = {'role': 'assistant', 'tool_calls': [{'id': 'observe_current'}]}
        requests = [{}, {'messages': [call, message]}]
        self.assertEqual(fixture.current_probe(requests, 'current'), {'actual': True})
        for messages in ([call, {**message, 'tool_call_id': 'observe_previous'}], [call, message, message]):
            with self.assertRaises(AssertionError):
                fixture.current_probe([{}, {'messages': messages}], 'current')

    def test_current_probe_needs_actual_current_assistant_call(self):
        with self.assertRaises(AssertionError):
            fixture.current_probe([{}, {'messages': [{'role': 'tool', 'tool_call_id': 'observe_current',
                'content': fixture.MARKER + '{}'}]}], 'current')

    def test_correct_transcript_and_both_actual_ids_required(self):
        agent = {'activeSessionId': 'actual-a', 'sessionId': 'durable-a'}
        row = {'get': {'value': {'agent': agent}}, 'recent': {'value': {
            'agent': agent, 'messages': [{'role': 'custom', 'customType': 'agent_message', 'text': '[task from parent]\n\nOBSERVE_TASK_A'}]}}}
        expected = {'active': 'actual-a', 'durable': 'durable-a'}
        self.assertEqual(fixture.selected(row, expected, 'OBSERVE_TASK_A'), {
            'selection': 'child-a', 'transcript_marker': 'OBSERVE_TASK_A'})
        row['recent']['value']['messages'].append({'role': 'custom', 'customType': 'agent_message', 'text': '[task from parent]\n\nOBSERVE_TASK_B'})
        with self.assertRaises(AssertionError):
            fixture.selected(row, expected, 'OBSERVE_TASK_A')
        row['recent']['value']['messages'] = [{'role': 'custom', 'customType': 'agent_message', 'text': '[task from parent]\n\nOBSERVE_TASK_B'}]
        with self.assertRaises(AssertionError):
            fixture.selected(row, expected, 'OBSERVE_TASK_A')
        row['get']['value']['agent'] = {'activeSessionId': 'actual-a', 'sessionId': 'wrong-durable'}
        with self.assertRaises(AssertionError):
            fixture.selected(row, expected, 'OBSERVE_TASK_A')

    def test_foreign_error_and_ambiguity_cannot_be_success_or_other_error(self):
        error = 'agent suffix is not reachable'
        row = {'get': {'error': error}, 'recent': {'error': error}}
        self.assertEqual(fixture.rejected(row, 'foreign-family'), {'rejection': 'foreign-family'})
        row['get'] = {'value': {'agent': {'activeSessionId': 'foreign'}}}
        with self.assertRaises(AssertionError):
            fixture.rejected(row, 'foreign-family')
        row = {'get': {'error': 'No live session'}, 'recent': {'error': 'No live session'}}
        with self.assertRaises(AssertionError):
            fixture.rejected(row, 'ambiguous')
        row = {operation: {'error': 'Ambiguous active session: matches a,b'} for operation in ('get', 'recent')}
        self.assertEqual(fixture.rejected(row, 'ambiguous'), {'rejection': 'ambiguous'})

    def test_child_hold_matches_current_task_not_root_digest_or_history(self):
        self.assertEqual(fixture.child_task({'messages': [{'role': 'user', 'content': '[task from parent]\n\nOBSERVE_TASK_A'}]}), 'OBSERVE_TASK_A')
        self.assertIsNone(fixture.child_task({'messages': [
            {'role': 'user', 'content': 'digest includes OBSERVE_TASK_A'},
            {'role': 'user', 'content': 'Run parent selector baseline.'}]}))
        self.assertIsNone(fixture.child_task({'messages': [{'role': 'assistant', 'content': 'OBSERVE_TASK_A'}]}))

    def children(self, ready=True):
        return {'children': [
            {'session_name': name, 'rlm_child_id': child_id, 'status': 'running', 'label': task,
             'active_session_id': active, 'session_id': durable}
            for name, child_id, task, active, durable in (
                ('observe-child-a', 'child-a', 'OBSERVE_TASK_A', 'active-a', 'durable-a'),
                ('observe-child-b', 'child-b', 'OBSERVE_TASK_B', 'active-b' if ready else None, 'durable-b' if ready else None))]}

    def test_actual_identity_poll_keeps_first_and_every_ready_snapshot(self):
        first, ready = self.children(False), self.children()
        polls, observation = [], {'spawn_setup': first}
        def read(number, remaining):
            polls.append((number, remaining))
            return ready
        times = iter([100, 101, 102])
        rows = fixture.await_child_identities(first, read, observation, clock=lambda: next(times), budget=5)
        self.assertEqual(rows['observe-child-b']['active_session_id'], 'active-b')
        self.assertEqual(polls, [(1, 4)])
        self.assertIs(observation['spawn_setup'], first)
        self.assertEqual(observation['identity_polls'], [ready])

    def test_already_ready_children_need_no_additional_model_turn(self):
        def forbidden(*_args):
            self.fail('readiness was already observed')
        observation = {}
        rows = fixture.await_child_identities(self.children(), forbidden, observation, clock=lambda: 100)
        self.assertEqual(len(rows), 2)
        self.assertEqual(observation['identity_polls'], [])

    def test_identity_wait_deadline_is_strict_and_never_sleeps_or_retries(self):
        times = iter([100, 106])
        def forbidden(*_args):
            self.fail('deadline expired before another model turn')
        with self.assertRaisesRegex(AssertionError, 'before deadline'):
            fixture.await_child_identities(self.children(False), forbidden, {}, clock=lambda: next(times), budget=5)
        times = iter([100, 101, 106])
        observation = {}
        with self.assertRaisesRegex(AssertionError, 'exceeded deadline'):
            fixture.await_child_identities(self.children(False), lambda *_args: self.children(),
                                          observation, clock=lambda: next(times), budget=5)
        self.assertEqual(observation['identity_polls'], [self.children()])

    def test_identity_ready_rejects_duplicate_ids_changed_handle_or_wrong_task(self):
        expected = {'observe-child-a': 'child-a', 'observe-child-b': 'child-b'}
        for key, bad in (('active_session_id', 'active-a'), ('session_id', 'durable-a'),
                         ('rlm_child_id', 'other-child'), ('label', 'OBSERVE_TASK_A'), ('status', 'completed')):
            snapshot = self.children()
            snapshot['children'][1][key] = bad
            with self.assertRaises(AssertionError, msg=key):
                fixture.ready_children(snapshot, expected)

    def test_partial_publication_rejects_malformed_ids_before_any_poll(self):
        for key in ('active_session_id', 'session_id'):
            for value in (123, '', False, []):
                snapshot = self.children(False)
                snapshot['children'][0][key] = value
                def forbidden(*_args):
                    self.fail('malformed publication must fail before a readiness poll')
                with self.assertRaisesRegex(AssertionError, 'invalid published'):
                    fixture.await_child_identities(snapshot, forbidden, {}, clock=lambda: 100)

    def test_partial_publication_rejects_duplicates_before_any_poll(self):
        for duplicate_key, missing_key in (('active_session_id', 'session_id'), ('session_id', 'active_session_id')):
            snapshot = self.children()
            snapshot['children'][1][duplicate_key] = snapshot['children'][0][duplicate_key]
            snapshot['children'][1][missing_key] = None
            def forbidden(*_args):
                self.fail('duplicate publication must fail before a readiness poll')
            with self.assertRaisesRegex(AssertionError, 'duplicate published'):
                fixture.await_child_identities(snapshot, forbidden, {}, clock=lambda: 100)

    def test_foreign_topology_requires_real_other_parent_edges_not_a_sibling_root(self):
        parent = {'active': 'main-a', 'durable': 'main-s'}
        other = {'active': 'other-a', 'durable': 'other-s'}
        foreign = {'active': 'foreign-a', 'durable': 'foreign-s'}
        agent = {'activeSessionId': 'foreign-a', 'sessionId': 'foreign-s', 'runtimeKind': 'subagent',
                 'parentActiveSessionId': 'other-a', 'parentSessionId': 'other-s'}
        fixture.validate_foreign_agent(agent, foreign, other, parent)
        for key, value in (('runtimeKind', 'top-level'), ('parentActiveSessionId', 'main-a'), ('parentSessionId', 'main-s')):
            with self.assertRaises(AssertionError):
                fixture.validate_foreign_agent({**agent, key: value}, foreign, other, parent)
        with self.assertRaises(AssertionError):
            fixture.validate_foreign_agent(agent, foreign, parent, parent)

    def test_roster_retains_valid_root_sibling_but_rejects_its_child(self):
        parent, other, a, b, foreign = [{'active': name} for name in ('parent', 'other', 'a', 'b', 'foreign')]
        roster = {'current': {'activeSessionId': 'parent'}, 'agents': [
            {'activeSessionId': 'other', 'relationship': 'sibling'},
            {'activeSessionId': 'a', 'relationship': 'child'}, {'activeSessionId': 'b', 'relationship': 'child'}]}
        fixture.validate_roster(roster, parent, other, a, b, foreign)
        for extra in ({'activeSessionId': 'foreign', 'relationship': 'child'}, {'activeSessionId': 'foreign', 'relationship': 'sibling'}):
            with self.assertRaises(AssertionError):
                fixture.validate_roster({**roster, 'agents': roster['agents'] + [extra]}, parent, other, a, b, foreign)
        with self.assertRaises(AssertionError):
            fixture.validate_roster({**roster, 'agents': roster['agents'][1:]}, parent, other, a, b, foreign)

    def test_captured_custom_kickoff_shape_and_mixed_foreign_preview_guard(self):
        agent = {'activeSessionId': 'actual-a', 'sessionId': 'durable-a'}
        messages = [{'role': 'custom', 'customType': 'harness_digest', 'text': '[harness-digest]'},
                    {'role': 'custom', 'customType': 'agent_message', 'text': '[task from parent]\n\nOBSERVE_TASK_A'}]
        row = {'get': {'value': {'agent': agent}}, 'recent': {'value': {'agent': agent, 'messages': messages}}}
        expected = {'active': 'actual-a', 'durable': 'durable-a'}
        fixture.selected(row, expected, 'OBSERVE_TASK_A')
        messages.append({'role': 'custom', 'customType': 'agent_message', 'text': '[task from parent]\n\nOBSERVE_TASK_FOREIGN'})
        with self.assertRaises(AssertionError):
            fixture.selected(row, expected, 'OBSERVE_TASK_A')
        messages[:] = [{'role': 'user', 'text': '[task from parent]\n\nOBSERVE_TASK_A'}]
        with self.assertRaises(AssertionError):
            fixture.selected(row, expected, 'OBSERVE_TASK_A')

    def test_single_foreign_child_uses_same_strict_identity_readiness_guards(self):
        snapshot = {'children': [{'session_name': 'observe-foreign-child', 'rlm_child_id': 'foreign-child',
            'label': 'OBSERVE_TASK_FOREIGN', 'status': 'running', 'active_session_id': 'foreign-a', 'session_id': 'foreign-s'}]}
        rows = fixture.await_child_identities(snapshot, lambda *_args: self.fail('already ready'), {},
                                              expected_tasks=fixture.FOREIGN_CHILD_TASKS, clock=lambda: 100)
        self.assertEqual(rows['observe-foreign-child']['active_session_id'], 'foreign-a')
        snapshot['children'][0]['active_session_id'] = 123
        snapshot['children'][0]['session_id'] = None
        with self.assertRaises(AssertionError):
            fixture.await_child_identities(snapshot, lambda *_args: self.fail('malformed publication'), {},
                                           expected_tasks=fixture.FOREIGN_CHILD_TASKS, clock=lambda: 100)

    def test_identical_cell_uses_actual_skill_functions(self):
        code = fixture.cell({'exact': 'actual-a', 'foreign_suffix': 'FFF-123'})
        tree = ast.parse(code)
        calls = {node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute)}
        self.assertTrue({'list_agents', 'get_agent', 'recent_messages'} <= calls)
        self.assertIn("'foreign_suffix': 'FFF-123'", code)


if __name__ == '__main__':
    unittest.main()
