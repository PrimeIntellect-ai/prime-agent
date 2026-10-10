#!/usr/bin/env python3
"""Offline regression cases for selecting rerun shard manifests."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ci_test_shard", HERE / "ci_test_shard.py")
shards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shards)


class AttemptAudit(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.ids = [next(f"pkg#test:unit-{n}" for n in range(100)
                         if shards.shard_of(f"pkg#test:unit-{n}", 2) == shard)
                    for shard in range(2)]

    def write(self, shard, attempt=1, rc=0, complete=True, legacy=False):
        suffix = "" if legacy else f"-attempt-{attempt}"
        path = self.directory / f"shard-manifest-{shard}{suffix}.json"
        unit = {"id": self.ids[shard - 1], "rc": rc, "seconds": 1.0,
                "failed_tests": ["failure"] if rc else []}
        shards.write_manifest(path, shard, 2, self.ids, [unit] if complete else [],
                              run_attempt=attempt, run_id="12345", commit_sha="a" * 40)
        if legacy:
            data = json.loads(path.read_text())
            data.pop("run_attempt")
            path.write_text(json.dumps(data))
        return path

    def run_summary(self, sha="a" * 40):
        env = dict(os.environ, GITHUB_RUN_ID="12345", GITHUB_SHA=sha)
        return subprocess.run([sys.executable, str(HERE / "ci_test_shard_summary.py"),
                               "--total", "2", "--dir", str(self.directory)],
                              capture_output=True, text=True, env=env, check=False)

    @staticmethod
    def rewrite(path, change):
        data = json.loads(path.read_text())
        change(data)
        path.write_text(json.dumps(data))

    def test_old_failed_new_pass_keeps_other_shard_original(self):
        self.write(1, 1, rc=1)
        self.write(2, 1)
        self.write(1, 2)
        result = self.run_summary()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("shard 1: selected attempt 2; retained prior attempts: 1", result.stdout)
        self.assertIn("shard 2: selected attempt 1; retained prior attempts: none", result.stdout)

    def test_new_failure_never_falls_back_to_old_green(self):
        self.write(1, 1)
        self.write(2, 1)
        self.write(1, 2, rc=1)
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("1 failing test binaries", result.stdout)

    def test_attempt_ten_outranks_nine_numerically(self):
        self.write(1, 9)
        self.write(2, 9)
        self.write(1, 10, rc=1)
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("selected attempt 10; retained prior attempts: 9", result.stdout)
        self.assertIn("1 failing test binaries", result.stdout)

    def test_new_partial_never_falls_back(self):
        self.write(1, 1)
        self.write(2, 1)
        self.write(1, 2, complete=False)
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("shard 1 is incomplete", result.stdout)

    def test_incomplete_latest_attempt_still_reports_mixed_scope(self):
        self.write(1, 1)
        self.write(2, 1)
        path = self.write(1, 2, complete=False)
        self.rewrite(path, lambda data: data.update(scope={"kind": "crates", "crates": ["pkg"]}))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("different selection scopes", result.stdout)
        self.assertIn("shard 1 is incomplete", result.stdout)

    def test_duplicate_same_attempt_is_ambiguous(self):
        self.write(1, 1, legacy=True)
        self.write(1, 1)
        self.write(2, 1)
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("duplicate manifests", result.stdout)

    def test_identity_mismatch_is_refused(self):
        self.write(1)
        self.write(2)
        result = self.run_summary(sha="b" * 40)
        self.assertEqual(result.returncode, 1)
        self.assertIn("identity", result.stdout)

    def test_retained_prior_attempt_with_wrong_identity_is_refused(self):
        prior = self.write(1, 1)
        self.write(1, 2)
        self.write(2, 1)
        data = json.loads(prior.read_text())
        data["run_id"] = "another-run"
        prior.write_text(json.dumps(data))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("identity mismatch", result.stdout)

    def test_malformed_json_root_is_diagnostic(self):
        self.write(1)
        path = self.write(2)
        path.write_text("[]")
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("JSON root must be an object", result.stdout)
        self.assertNotIn("Traceback", result.stderr)

    def test_selected_manifest_missing_units_is_diagnostic(self):
        self.write(1)
        path = self.write(2)
        self.rewrite(path, lambda data: data.pop("units"))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing enumeration or unit results", result.stdout)
        self.assertNotIn("Traceback", result.stderr)

    def test_falseish_string_complete_is_refused(self):
        path = self.write(1)
        self.write(2)
        self.rewrite(path, lambda data: data.update(complete="false"))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("complete must be literal true", result.stdout)

    def test_boolean_rc_is_refused(self):
        path = self.write(1)
        self.write(2)
        self.rewrite(path, lambda data: data["units"][0].update(rc=False))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("malformed enumeration or unit results", result.stdout)

    def test_non_string_unit_id_is_refused(self):
        path = self.write(1)
        self.write(2)
        self.rewrite(path, lambda data: data["units"][0].update(id=7))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("malformed enumeration or unit results", result.stdout)

    def test_non_string_selected_id_is_refused(self):
        path = self.write(1)
        self.write(2)
        self.rewrite(path, lambda data: data["selected_unit_ids"].append(7))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("malformed selected unit ids", result.stdout)

    def test_all_scope_cannot_carry_crates(self):
        path = self.write(1)
        self.write(2)
        self.rewrite(path, lambda data: data["scope"].update(crates=["pkg"]))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid selection scope", result.stdout)

    def test_malformed_scope_is_diagnostic(self):
        path = self.write(1)
        self.write(2)
        self.rewrite(path, lambda data: data.update(scope=[]))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid selection scope", result.stdout)
        self.assertNotIn("Traceback", result.stderr)

    def test_legacy_attempt_one_with_identity_is_accepted(self):
        self.write(1, legacy=True)
        self.write(2, legacy=True)
        result = self.run_summary()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_digest_mismatch_is_refused(self):
        path = self.write(1)
        self.write(2)
        data = json.loads(path.read_text())
        data["digest"] = "bad"
        path.write_text(json.dumps(data))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("digest mismatch", result.stdout)

    def test_wrong_shard_assignment_is_refused(self):
        path = self.write(1)
        self.write(2)
        data = json.loads(path.read_text())
        data["units"][0]["id"] = self.ids[1]
        path.write_text(json.dumps(data))
        result = self.run_summary()
        self.assertEqual(result.returncode, 1)
        self.assertIn("belongs to shard 2", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
