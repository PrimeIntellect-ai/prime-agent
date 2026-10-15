import unittest
from review_factory_navigation_parity import factory_click, FactorySupervisor, GRAPH
from review_dock_screen import DockScreen


class FactoryNavigationGuards(unittest.TestCase):
    def test_click_targets_the_observed_factory_cells(self):
        screen = DockScreen()
        screen.cells[3][5:12] = list('factory')
        self.assertEqual(factory_click(screen), '\x1b[<0;7;4M\x1b[<0;7;4m')

    def test_only_factory_commands_are_claimed_before_unknown_errors(self):
        server = FactorySupervisor.__new__(FactorySupervisor)
        response = {}
        self.assertTrue(server.extra_command({'type': 'factory_activity', 'action': 'graph'}, response))
        self.assertEqual(response, {'data': GRAPH})
        self.assertFalse(server.extra_command({'type': 'unowned'}, {}))
        with self.assertRaises(AssertionError):
            server.extra_command({'type': 'factory_activity', 'action': 'stop'}, {})

    def test_missing_factory_is_not_silently_clicked(self):
        with self.assertRaises(AssertionError):
            factory_click(DockScreen())


if __name__ == '__main__':
    unittest.main()
