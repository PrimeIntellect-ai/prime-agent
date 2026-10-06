#!/usr/bin/env python3
"""Test battery for the PR-files-to-crates mapping (ci.yml's changes job).

The contracts, pinned on real pulls/files-API shapes (the `filename` +
`previous_filename` rows — the API's own field names, so a field-name
regression fails safe instead of silently narrowing to nothing):
  - a crate-only PR maps to those crates and their transitive dependents;
  - ANY non-crate path - and a rename's removed side too - fails safe to
    the full selection;
  - an undecidable list (empty input, an empty filename row, the API's
    3000-file ceiling) fails safe to the full selection, never to an empty
    selection: a narrowed wave that runs nothing would masquerade as green.

Run: python3 scripts/test_ci_pr_crates.py  (or: make shard-gates)
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import ci_pr_crates  # noqa: E402  (the tool under test)

MAPPER = SCRIPTS_DIR / "ci_pr_crates.py"


def run_mapper(rows: list[str]) -> tuple[int, str, dict[str, str]]:
    output = Path(tempfile.mkdtemp()) / "github-output"
    env = dict(os.environ)
    env["GITHUB_OUTPUT"] = str(output)
    listing = Path(tempfile.mkdtemp()) / "pr-files.tsv"
    listing.write_text("\n".join(rows) + "\n", encoding="utf-8")
    result = subprocess.run([sys.executable, str(MAPPER), str(listing)],
                            capture_output=True, text=True, env=env, check=False)
    outputs = {}
    for line in output.read_text().splitlines():
        key, _, value = line.partition("=")
        outputs[key] = value
    return result.returncode, result.stdout, outputs


class TheMappingTestCase(unittest.TestCase):

    def test_a_crate_only_pr_narrows_to_those_crates(self):
        rc, out, outputs = run_mapper([
            "crates/pa-daemon/src/main.rs",
            "crates/pa-daemon/src/roster.rs",
            "crates/pa-tui/src/view/runs.rs",
        ])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "pa-cli,pa-daemon,pa-tui")
        self.assertIn("crates (3: pa-cli, pa-daemon, pa-tui)", outputs["scope"])

    def test_any_non_crate_path_fails_safe_to_the_full_selection(self):
        rc, out, outputs = run_mapper([
            "crates/pa-core/src/lib.rs",
            ".github/workflows/ci.yml",
        ])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "")
        self.assertEqual(outputs["scope"], "all")
        self.assertIn("non-crate path .github/workflows/ci.yml", out)

    def test_a_renames_removed_side_counts_too(self):
        # A rename from a non-crate path INTO a crate: the PR removed the
        # old path, so the full selection runs.
        rc, out, outputs = run_mapper([
            "crates/pa-cli/src/new.rs\tdocs/old-location.md",
        ])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "")
        self.assertIn("non-crate path docs/old-location.md", out)

    def test_a_rename_within_crates_narrows_to_both_crates(self):
        rc, out, outputs = run_mapper([
            "crates/pa-tui/src/editor/selection.rs\tcrates/pa-tui/src/selection.rs",
        ])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "pa-cli,pa-tui")

    def test_pa_types_only_runs_every_crate(self):
        rc, out, outputs = run_mapper(["crates/pa-types/src/lib.rs"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], ",".join(sorted(ci_pr_crates.WORKSPACE_DEPS)))

    def test_pa_tui_only_runs_pa_cli_too(self):
        rc, out, outputs = run_mapper(["crates/pa-tui/src/lib.rs"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "pa-cli,pa-tui")

    def test_pa_telemetry_only_runs_all_dependents(self):
        rc, out, outputs = run_mapper(["crates/pa-telemetry/src/lib.rs"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"],
                         "pa-cli,pa-core,pa-daemon,pa-telemetry,pa-tui")

    def test_an_unknown_crate_fails_safe(self):
        rc, out, outputs = run_mapper(["crates/pa-future/src/lib.rs"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "")
        self.assertIn("unknown crate pa-future", out)

    def test_an_empty_filename_row_fails_safe(self):
        # The field-name regression the reviewer demanded pinned: a row whose
        # filename column is empty (e.g. reading `.path` from the files API,
        # whose field is `filename`) must never narrow the wave to nothing -
        # the run fails safe to the full selection instead.
        rc, out, outputs = run_mapper([
            "\tcrates/pa-core/src/lib.rs",
            "crates/pa-daemon/src/lib.rs",
        ])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "")
        self.assertEqual(outputs["scope"], "all")
        self.assertIn("empty filename", out)

    def test_a_null_field_read_also_fails_safe(self):
        # jq renders a missing field as the string "null": not a crate path,
        # so the full selection runs (nothing narrows on a broken column).
        rc, out, outputs = run_mapper([
            "null\tdocs/removed.md",
            "crates/pa-core/src/lib.rs",
        ])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "")

    def test_an_empty_list_fails_safe_to_the_full_selection(self):
        rc, out, outputs = run_mapper([])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "")
        self.assertEqual(outputs["scope"], "all")

    def test_a_whitespace_prefixed_path_is_a_non_crate_path(self):
        # The fields are read raw: a path with a leading space (or any
        # non-crate prefix) must never be stripped into a crate mapping.
        rc, out, outputs = run_mapper([
            " crates/pa-core/src/lib.rs",
            "crates/pa-tui/src/lib.rs",
        ])
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "")
        self.assertIn("non-crate path  crates/pa-core/src/lib.rs", out)

    def test_the_files_api_ceiling_fails_safe(self):
        rows = ["crates/pa-core/src/lib.rs"] * ci_pr_crates.FILES_API_CEILING
        rc, out, outputs = run_mapper(rows)
        self.assertEqual(rc, 0, out)
        self.assertEqual(outputs["crates"], "")
        self.assertIn("ceiling", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
