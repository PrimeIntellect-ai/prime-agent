import unittest
import json
from review_factory_navigation_parity import factory_click, FactorySupervisor, GRAPH
from review_dock_screen import DockScreen


class FactoryNavigationGuards(unittest.TestCase):
    def test_click_targets_the_observed_factory_cells(self):
        screen = DockScreen()
        screen.cells[3][5:12] = list('factory')
        self.assertEqual(factory_click(screen), '\x1b[<0;7;4M\x1b[<0;7;4m')

    def test_existing_factory_response_is_replaced_without_suppressing_errors(self):
        server = FactorySupervisor.__new__(FactorySupervisor)
        sent = []
        sock = type('Socket', (), {'sendall': lambda _self, value: sent.append(json.loads(value))})()
        server.send(sock, {'type': 'response', 'command': 'factory_activity',
                           'success': True, 'data': {'activity': [], 'jobs': []}})
        self.assertEqual(sent, [{'type': 'response', 'command': 'factory_activity',
                                'success': True, 'data': GRAPH}])

    def test_missing_factory_is_not_silently_clicked(self):
        with self.assertRaises(AssertionError):
            factory_click(DockScreen())


if __name__ == '__main__':
    unittest.main()
