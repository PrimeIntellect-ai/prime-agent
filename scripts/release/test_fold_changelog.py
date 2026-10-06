#!/usr/bin/env python3
"""Test battery for the changelog fold (RELEASE-FLOW-PROPOSAL.md §8).

The fold is the release-PR's changelog half: it merges the workspace-level
`.changes/*.md` fragments into the root CHANGELOG.md section for a version
and consumes the fragments it folded. This battery pins the fold's
contracts on synthetic git repositories, with the security case first: a
fragment NAME is data, never a git pathspec - a file literally named
`:(top,glob)*.md` must fold its content without ever making a root-level
markdown file (README.md, CHANGELOG.md itself) a deletion candidate.

Run: python3 scripts/release/test_fold_changelog.py  (or: make fold-gates)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO = SCRIPTS_DIR.parent.parent

FOLD = SCRIPTS_DIR / "fold_changelog.py"


class FoldTestCase(unittest.TestCase):
    """A synthetic repository per test (the fold reads fragment add-dates
    and consumes fragments through git, so the fixtures must be real)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for cmd in (["git", "init", "-q", "."],
                    ["git", "config", "user.email", "t@t"],
                    ["git", "config", "user.name", "t"]):
            subprocess.run(cmd, cwd=self.root, check=True, capture_output=True)
        self.changes = self.root / ".changes"
        self.changes.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        self.tmp.cleanup()

    def commit(self, message):
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-q", "-m", message],
                       cwd=self.root, capture_output=True, check=False)

    def fold(self, version, *extra, expect=0):
        result = subprocess.run(
            [sys.executable, str(FOLD), "--version", version,
             "--repo-root", str(self.root), *extra],
            capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, expect,
                         f"fold rc={result.returncode}: {result.stderr}")
        return result

    def fragment(self, name, content, commit=True):
        # The fold's git rm prunes an emptied .changes directory; recreating
        # it keeps multi-fold fixtures working.
        self.changes.mkdir(exist_ok=True)
        path = self.changes / name
        path.write_text(content)
        if commit:
            self.commit(f"add {name}")
        return path


class ThePathspecSecurityCase(FoldTestCase):
    """A fragment name is data: root markdown files are never deletion
    candidates, whatever a fragment is called."""

    def test_a_pathspec_magic_named_fragment_never_touches_root_markdown(self):
        # The adversarial name: git parses it as pathspec magic that would
        # glob-match every ROOT *.md (README.md, CHANGELOG.md itself) and
        # stage their deletion. The fold must consume the file by its
        # literal name only.
        readme = self.root / "README.md"
        readme.write_text("# the project readme\n")
        note = self.root / "NOTES.md"
        note.write_text("# root-level notes\n")
        self.fragment(":(top,glob)*.md", "- the adversarial fragment\n")
        self.commit("root markdown fixtures")

        self.fold("0.10.0")

        changelog = (self.root / "CHANGELOG.md").read_text()
        self.assertIn("- the adversarial fragment", changelog)
        self.assertIn("## [0.10.0] - ", changelog)
        self.assertEqual(readme.read_text(), "# the project readme\n")
        self.assertEqual(note.read_text(), "# root-level notes\n")
        status = subprocess.run(["git", "status", "--porcelain"],
                                cwd=self.root, capture_output=True, text=True, check=True)
        for line in status.stdout.splitlines():
            self.assertFalse(
                line.lstrip("ADRMU? ") .startswith(("README.md", "NOTES.md")),
                f"a root markdown file became a fold candidate: {line}")
        self.assertFalse((self.changes / ":(top,glob)*.md").exists())

    def test_a_glob_named_fragment_does_not_consume_its_siblings(self):
        # A file literally named `*.md` must not glob its directory either:
        # the empty (skipped, never consumed) sibling survives it.
        self.fragment("*.md", "- the glob-named fragment\n")
        self.fragment("skipped.md", "", commit=False)
        self.commit("all fragments")

        self.fold("0.10.0")

        self.assertTrue((self.changes / "skipped.md").exists())


class TheFoldContracts(FoldTestCase):
    def test_the_first_fold_seeds_the_changelog_header(self):
        self.fragment("feature.md", "- the first feature\n")
        self.fold("0.10.0")
        changelog = (self.root / "CHANGELOG.md").read_text()
        self.assertIn("# Changelog", changelog)
        self.assertIn("packages/*/CHANGELOG.md", changelog)
        self.assertIn("## [0.10.0] - ", changelog)
        self.assertIn("- the first feature", changelog)

    def test_fragments_fold_in_add_date_order(self):
        self.fragment("late.md", "- the later feature\n")
        self.fragment("early.md", "- the earlier feature\n", commit=False)
        self.commit("the earlier fragment")
        self.fold("0.10.0")
        text = (self.root / "CHANGELOG.md").read_text()
        self.assertLess(text.index("- the earlier feature"),
                        text.index("- the later feature"))

    def test_empty_fragments_are_skipped_loudly_and_not_consumed(self):
        self.fragment("empty.md", "")
        self.fragment("real.md", "- the real feature\n")
        result = self.fold("0.10.0")
        self.assertIn("skipping empty fragment empty.md", result.stderr)
        self.assertTrue((self.changes / "empty.md").exists())
        self.assertFalse((self.changes / "real.md").exists())

    def test_readme_is_not_a_fragment(self):
        self.fragment("README.md", "# the pattern explanation\n")
        self.fragment("real.md", "- the real feature\n")
        self.fold("0.10.0")
        self.assertTrue((self.changes / "README.md").exists())
        self.assertFalse((self.changes / "real.md").exists())

    def test_a_fragmentless_release_still_writes_the_section(self):
        self.commit("an empty changes dir")
        self.fold("0.10.0")
        self.assertIn("## [0.10.0] - ", (self.root / "CHANGELOG.md").read_text())

    def test_a_double_fold_is_refused(self):
        self.fragment("feature.md", "- the feature\n")
        self.fold("0.10.0")
        self.fold("0.10.0", expect=1)

    def test_sections_insert_newest_first(self):
        self.fragment("one.md", "- the first release feature\n")
        self.fold("0.10.0")
        self.fragment("two.md", "- the second release feature\n")
        self.fold("0.11.0")
        text = (self.root / "CHANGELOG.md").read_text()
        self.assertLess(text.index("## [0.11.0]"), text.index("## [0.10.0]"))

    def test_a_stranded_unreleased_section_is_absorbed(self):
        self.fragment("feature.md", "- the feature\n")
        (self.root / "CHANGELOG.md").write_text(
            "# Changelog\n\n## [Unreleased]\n\n- the old-style entry\n")
        self.fold("0.10.0")
        text = (self.root / "CHANGELOG.md").read_text()
        self.assertIn("- the old-style entry", text)
        self.assertIn("## [0.10.0] - ", text)
        self.assertNotIn("## [Unreleased]", text)

    def test_an_eof_unreleased_heading_is_absorbed(self):
        self.fragment("feature.md", "- the feature\n")
        (self.root / "CHANGELOG.md").write_text(
            "# Changelog\n\n## [Unreleased]")
        self.fold("0.10.0")
        self.assertNotIn("## [Unreleased]", (self.root / "CHANGELOG.md").read_text())

    def test_prose_quoting_the_unreleased_heading_survives(self):
        self.fragment("feature.md", "- the feature\n")
        (self.root / "CHANGELOG.md").write_text(
            "# Changelog\n\nsee the `## [Unreleased]` literal in prose - "
            "this line survives verbatim.\n\n## [0.9.0] - old\n\n- old\n")
        self.fold("0.10.0")
        text = (self.root / "CHANGELOG.md").read_text()
        self.assertIn("this line survives verbatim.", text)
        self.assertIn("## [0.10.0] - ", text)

    def test_untracked_and_modified_fragments_are_consumed(self):
        self.fragment("tracked.md", "- the tracked feature\n")
        (self.changes / "tracked.md").write_text(
            "- the tracked feature, edited locally\n")
        self.fragment("untracked.md", "- the untracked feature\n", commit=False)
        result = self.fold("0.10.0")
        self.assertIn("consumed tracked.md", result.stdout)
        self.assertIn("consumed untracked.md", result.stdout)
        self.assertFalse(any(p.is_file() for p in self.changes.iterdir()))
        changelog = (self.root / "CHANGELOG.md").read_text()
        self.assertIn("- the tracked feature, edited locally", changelog)
        self.assertIn("- the untracked feature", changelog)

    def test_dry_run_writes_nothing(self):
        self.fragment("feature.md", "- the feature\n")
        self.fold("0.10.0", "--dry-run")
        self.assertFalse((self.root / "CHANGELOG.md").exists())
        self.assertTrue((self.changes / "feature.md").exists())

    def test_a_non_semver_version_is_refused(self):
        self.fragment("feature.md", "- the feature\n")
        result = subprocess.run(
            [sys.executable, str(FOLD), "--version", "0.10",
             "--repo-root", str(self.root)],
            capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("plain x.y.z", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
