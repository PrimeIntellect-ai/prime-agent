import json
import threading
import unittest
from check_factory_navigation import dock_click, FactorySupervisor, GRAPH, LIBRARY, OVERVIEW
from lifecycle_lib import DockScreen


class FactoryNavigationGuards(unittest.TestCase):
    def test_click_targets_the_observed_machines_cells(self):
        screen = DockScreen()
        screen.cells[3][5:12] = list('machine')
        self.assertEqual(dock_click(screen), '\x1b[<0;7;4M\x1b[<0;7;4m')

    def test_each_factory_action_gets_its_shape_without_suppressing_errors(self):
        server = FactorySupervisor.__new__(FactorySupervisor)
        server.lock = threading.Lock()
        sent = []
        sock = type('Socket', (), {'sendall': lambda _self, value: sent.append(json.loads(value))})()
        for action, shape in (('library', LIBRARY), ('overview', OVERVIEW), ('graph', GRAPH)):
            server.commands = [{'type': 'factory_activity', 'action': action}]
            server.send(sock, {'type': 'response', 'command': 'factory_activity',
                               'success': True, 'data': {'activity': [], 'jobs': []}})
            self.assertEqual(sent[-1], {'type': 'response', 'command': 'factory_activity',
                                        'success': True, 'data': shape})

    def test_missing_machines_group_is_not_silently_clicked(self):
        with self.assertRaises(AssertionError):
            dock_click(DockScreen())


if __name__ == '__main__':
    unittest.main()
