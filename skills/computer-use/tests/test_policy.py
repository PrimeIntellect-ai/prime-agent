"""Tests for computer_use.policy: gate outcomes, settings loading, lock core."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fakes
from computer_use import policy

ALLOWED_BUNDLE = "com.example.app"
OTHER_BUNDLE = "com.other.app"
BLOCKED_BUNDLE = "com.blocked.app"
CUSTOM_DENY_BUNDLE = "com.custom.deny"
BUILTIN_DENY_BUNDLES = ("com.apple.loginwindow", "com.apple.ScreenSaver")


class GateTests(unittest.TestCase):
    def test_allowed_app_passes(self) -> None:
        settings = policy.Settings(allowed=(ALLOWED_BUNDLE,))
        result = policy._gate(ALLOWED_BUNDLE, settings)
        self.assertTrue(result.allowed)
        self.assertEqual(result.reason, "")

    def test_not_in_allowlist_denies_with_actionable_reason(self) -> None:
        settings = policy.Settings(allowed=(ALLOWED_BUNDLE,))
        result = policy._gate(OTHER_BUNDLE, settings)
        self.assertFalse(result.allowed)
        self.assertIn(OTHER_BUNDLE, result.reason)
        self.assertIn("allowlist", result.reason.lower())
        self.assertIn(str(policy.SETTINGS_PATH), result.reason)

    def test_blocked_deny_mentions_bundle_and_settings_path(self) -> None:
        settings = policy.Settings(allowed=(BLOCKED_BUNDLE,), blocked=(BLOCKED_BUNDLE,))
        result = policy._gate(BLOCKED_BUNDLE, settings)
        self.assertFalse(result.allowed)
        self.assertIn(BLOCKED_BUNDLE, result.reason)
        self.assertIn(str(policy.SETTINGS_PATH), result.reason)

    def test_blocked_wins_over_allowed(self) -> None:
        settings = policy.Settings(allowed=(BLOCKED_BUNDLE,), blocked=(BLOCKED_BUNDLE,))
        self.assertFalse(policy._gate(BLOCKED_BUNDLE, settings).allowed)

    def test_builtin_system_deny_enforced_on_default_settings(self) -> None:
        for bundle in BUILTIN_DENY_BUNDLES:
            with self.subTest(bundle=bundle):
                self.assertFalse(policy._gate(bundle, policy.Settings()).allowed)

    def test_system_deny_wins_over_allowed(self) -> None:
        settings = policy.Settings(allowed=BUILTIN_DENY_BUNDLES)
        for bundle in BUILTIN_DENY_BUNDLES:
            with self.subTest(bundle=bundle):
                self.assertFalse(policy._gate(bundle, settings).allowed)

    def test_system_deny_from_file_unions_builtin(self) -> None:
        settings = policy.Settings(allowed=(ALLOWED_BUNDLE,), system_deny=(CUSTOM_DENY_BUNDLE,))
        self.assertFalse(policy._gate(CUSTOM_DENY_BUNDLE, settings).allowed)
        for bundle in BUILTIN_DENY_BUNDLES:
            with self.subTest(bundle=bundle):
                self.assertFalse(policy._gate(bundle, settings).allowed)

    def test_gate_result_carries_risk_label(self) -> None:
        settings = policy.Settings(allowed=(ALLOWED_BUNDLE,), risk={ALLOWED_BUNDLE: "high"})
        self.assertEqual(policy._gate(ALLOWED_BUNDLE, settings).risk, "high")

    def test_gate_result_risk_defaults_to_medium(self) -> None:
        settings = policy.Settings(allowed=(ALLOWED_BUNDLE,))
        self.assertEqual(policy._gate(ALLOWED_BUNDLE, settings).risk, "medium")


class LoadSettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_missing_file_returns_tolerant_defaults(self) -> None:
        settings = policy._load_settings(self.dir / "missing.toml")
        self.assertEqual(settings, policy.Settings())
        self.assertFalse(settings.allowed)

    def test_reads_fixture_file(self) -> None:
        path = fakes.write_settings(
            self.dir,
            allowed=(ALLOWED_BUNDLE,),
            blocked=(BLOCKED_BUNDLE,),
            system_deny=(CUSTOM_DENY_BUNDLE,),
            risk={ALLOWED_BUNDLE: "low"},
        )
        settings = policy._load_settings(path)
        self.assertEqual(settings.allowed, (ALLOWED_BUNDLE,))
        self.assertEqual(settings.blocked, (BLOCKED_BUNDLE,))
        self.assertEqual(settings.risk, {ALLOWED_BUNDLE: "low"})
        self.assertTrue(policy._gate(ALLOWED_BUNDLE, settings).allowed)
        self.assertFalse(policy._gate(CUSTOM_DENY_BUNDLE, settings).allowed)
        for bundle in BUILTIN_DENY_BUNDLES:
            with self.subTest(bundle=bundle):
                self.assertFalse(policy._gate(bundle, settings).allowed)

    def test_bad_toml_returns_defaults(self) -> None:
        bad = self.dir / "bad.toml"
        bad.write_text("not [valid {{{ toml", encoding="utf-8")
        self.assertEqual(policy._load_settings(bad), policy.Settings())


class ParseSettingsTests(unittest.TestCase):
    def test_contract_shape(self) -> None:
        settings = policy._parse_settings(
            fakes.raw_settings(
                allowed=[ALLOWED_BUNDLE],
                blocked=[BLOCKED_BUNDLE],
                system_deny=[CUSTOM_DENY_BUNDLE],
                risk={ALLOWED_BUNDLE: "high", BLOCKED_BUNDLE: "low"},
            )
        )
        self.assertEqual(settings.allowed, (ALLOWED_BUNDLE,))
        self.assertEqual(settings.blocked, (BLOCKED_BUNDLE,))
        self.assertEqual(settings.risk, {ALLOWED_BUNDLE: "high", BLOCKED_BUNDLE: "low"})
        self.assertTrue(policy._gate(ALLOWED_BUNDLE, settings).allowed)
        self.assertFalse(policy._gate(CUSTOM_DENY_BUNDLE, settings).allowed)

    def test_junk_input_never_raises(self) -> None:
        for raw in (None, 42, "string", {"apps": 42, "system_deny": "no", "risk": {"x": 1}}):
            with self.subTest(raw=raw):
                self.assertIsInstance(policy._parse_settings(raw), policy.Settings)

    def test_valid_risk_labels_kept(self) -> None:
        settings = policy._parse_settings({"risk": {ALLOWED_BUNDLE: "low", OTHER_BUNDLE: "high"}})
        self.assertEqual(settings.risk, {ALLOWED_BUNDLE: "low", OTHER_BUNDLE: "high"})


class AllowlistSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.fixture = fakes.write_settings(
            self.dir,
            allowed=(ALLOWED_BUNDLE,),
            blocked=(BLOCKED_BUNDLE,),
            system_deny=(CUSTOM_DENY_BUNDLE,),
            risk={ALLOWED_BUNDLE: "high"},
        )

    def test_summary_reads_settings_path_at_call_time(self) -> None:
        with mock.patch.object(policy, "SETTINGS_PATH", self.fixture):
            summary = policy._allowlist_summary()
        self.assertEqual(
            summary,
            {
                "allowed": [ALLOWED_BUNDLE],
                "blocked": [BLOCKED_BUNDLE],
                "system_deny": list(policy.SYSTEM_DENY) + [CUSTOM_DENY_BUNDLE],
                "risk": {ALLOWED_BUNDLE: "high"},
            },
        )

    def test_summary_reflects_settings_changes_between_calls(self) -> None:
        with mock.patch.object(policy, "SETTINGS_PATH", self.fixture):
            first = policy._allowlist_summary()
            fakes.write_settings(self.dir, allowed=(ALLOWED_BUNDLE, OTHER_BUNDLE))
            second = policy._allowlist_summary()
        self.assertEqual(first["allowed"], [ALLOWED_BUNDLE])
        self.assertEqual(second["allowed"], [ALLOWED_BUNDLE, OTHER_BUNDLE])


class GateAppTests(unittest.TestCase):
    def test_gate_app_loads_settings_then_decides(self) -> None:
        fixture = policy.Settings(allowed=(ALLOWED_BUNDLE,), risk={ALLOWED_BUNDLE: "low"})
        with mock.patch.object(policy, "_load_settings", return_value=fixture):
            allowed_result = policy._gate_app(ALLOWED_BUNDLE)
            denied_result = policy._gate_app(OTHER_BUNDLE)
        self.assertTrue(allowed_result.allowed)
        self.assertEqual(allowed_result.risk, "low")
        self.assertFalse(denied_result.allowed)


class LockCoreTests(unittest.TestCase):
    def test_locked_session_is_locked(self) -> None:
        self.assertTrue(policy._locked_from_session(fakes.LOCKED_SESSION))

    def test_unlocked_session_is_not_locked(self) -> None:
        self.assertFalse(policy._locked_from_session(fakes.UNLOCKED_SESSION))

    def test_session_without_key_proceeds(self) -> None:
        self.assertFalse(policy._locked_from_session({"kCGSessionLoginsAtConsole": True}))

    def test_none_session_proceeds(self) -> None:
        self.assertFalse(policy._locked_from_session(None))

    def test_non_dict_session_proceeds(self) -> None:
        self.assertFalse(policy._locked_from_session("junk"))


if __name__ == "__main__":
    unittest.main()
