"""Tests for computer_use.errors against the frozen code table."""

from __future__ import annotations

import unittest

from computer_use import errors

FROZEN_CODES = (
    "ACTION_UNSUPPORTED",
    "AMBIGUOUS_APP",
    "APP_LAUNCH_FAILED",
    "APP_NOT_ALLOWED",
    "APP_NOT_RUNNING",
    "ELEMENT_STALE",
    "INJECTION_FAILED",
    "INVALID_ARGUMENT",
    "PERMISSIONS_NOT_GRANTED",
    "PERMISSIONS_PENDING",
    "SCREEN_LOCKED",
    "TRANSPORT_ERROR",
    "USER_STOPPED",
)


class CodesTableTests(unittest.TestCase):
    def test_table_covers_every_frozen_code_exactly_once(self) -> None:
        self.assertEqual(sorted(errors.CODES), sorted(FROZEN_CODES))

    def test_table_maps_codes_to_display_names(self) -> None:
        for code in FROZEN_CODES:
            with self.subTest(code=code):
                name = errors.CODES[code]
                self.assertIsInstance(name, str)
                self.assertTrue(name)


class ComputerUseErrorTests(unittest.TestCase):
    def test_construction_and_derived_name(self) -> None:
        error = errors.ComputerUseError("ELEMENT_STALE", "index 5 is gone")
        self.assertEqual(error.code, "ELEMENT_STALE")
        self.assertEqual(error.name, errors.CODES["ELEMENT_STALE"])
        self.assertEqual(error.message, "index 5 is gone")
        self.assertIsNone(error.details)

    def test_details_passthrough_and_default(self) -> None:
        details = {"index": 5, "snapshot": 2}
        error = errors.ComputerUseError("INVALID_ARGUMENT", "bad target", details)
        self.assertEqual(error.details, details)
        self.assertIsNone(errors.ComputerUseError("SCREEN_LOCKED", "locked").details)

    def test_str_format(self) -> None:
        error = errors.ComputerUseError("ELEMENT_STALE", "index 5 is gone")
        expected = f"{errors.CODES['ELEMENT_STALE']} (ELEMENT_STALE): index 5 is gone"
        self.assertEqual(str(error), expected)

    def test_raises_as_exception(self) -> None:
        with self.assertRaises(errors.ComputerUseError):
            raise errors.ComputerUseError("USER_STOPPED", "stopped")


if __name__ == "__main__":
    unittest.main()
