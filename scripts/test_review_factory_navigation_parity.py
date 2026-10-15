import unittest
from review_factory_navigation_parity import factory_click
from review_dock_screen import DockScreen


class FactoryNavigationGuards(unittest.TestCase):
    def test_click_targets_the_observed_factory_cells(self):
        screen = DockScreen()
        screen.cells[3][5:12] = list('factory')
        self.assertEqual(factory_click(screen), '\x1b[<0;7;4M\x1b[<0;7;4m')

    def test_missing_factory_is_not_silently_clicked(self):
        with self.assertRaises(AssertionError):
            factory_click(DockScreen())


if __name__ == '__main__':
    unittest.main()
