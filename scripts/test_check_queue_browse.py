import unittest
from check_queue_browse import check_mutation, QueueSupervisor, USER_A, USER_B, INTERNAL


class QueueBrowseGuardTest(unittest.TestCase):
    def command(self, direction):
        return {'type': 'mutate_queued_message', 'activeSessionId': 's1', 'lane': 'steering',
            'index': 0, 'expectedText': USER_A, 'mutation': {'type': 'move', 'direction': direction}}

    def test_mutation_swaps_with_the_adjacent_user_row(self):
        check_mutation(self.command(2))
        with self.assertRaises(AssertionError):
            check_mutation(self.command(1))

    def test_rejects_wrong_source_lane_text_or_index(self):
        for field, value in [('lane', 'followUp'), ('index', 1), ('expectedText', 'wrong')]:
            command = self.command(2)
            command[field] = value
            with self.assertRaises(AssertionError):
                check_mutation(command)


    def test_subclass_handles_its_commands_without_transient_transport_errors(self):
        server = QueueSupervisor.__new__(QueueSupervisor)
        server.queue = {'steering': [USER_A, INTERNAL, USER_B], 'followUp': []}
        server.mutations, server.errors = [], []
        response = {'success': True, 'data': {}}
        self.assertTrue(server.extra_command({'type': 'get_queue'}, response))
        self.assertEqual(response['data'], server.queue)
        self.assertIsNot(response['data']['steering'], server.queue['steering'])
        self.assertTrue(server.extra_command(self.command(2), response))
        self.assertEqual(response['data'], {'status': 'applied'})
        self.assertEqual(server.queue, {'steering': [USER_B, INTERNAL, USER_A], 'followUp': []})
        self.assertEqual(server.errors, [])
        self.assertFalse(server.extra_command({'type': 'unsupported'}, response))


if __name__ == '__main__':
    unittest.main()
