#!/usr/bin/env python3
"""Fold .changes/ fragments into the root CHANGELOG.md (TS `release.mjs` parity).

The changelog half of the release-PR flow (RELEASE-FLOW-PROPOSAL.md §1 + §8):
`release-prepare` bumps the workspace version and folds the workspace-level
`.changes/*.md` fragments into a `## [X.Y.Z] - YYYY-MM-DD` section of the root
CHANGELOG.md, then git-rms the consumed fragments - the same fold the TS
product ran (scripts/lib/changelog-fragments.mjs), ported to one workspace
changelog (the product is one binary; per-crate fragments would only add
taxonomy).

Fragments:
- `.changes/<branch-slug>.md`, one or more user-facing bullet lines.
- sorted by git add-date (`git log --diff-filter=A`, the TS sort), then path;
  files with no recorded add-date sort last, then by path - the order is
  deterministic on every run.
- EMPTY fragments are skipped LOUDLY and NOT consumed: nothing is ever lost
  silently (delete the file or add content).
- README.md is not a fragment (the pattern's explanation lives there).

The changelog:
- a missing CHANGELOG.md is seeded here: a header pointing at the
  TypeScript product's changelogs on the v0.9.8 tag for historical notes;
  Rust releases do not back-fill that content.
- a stray `## [Unreleased]` section is absorbed into the new section (an
  old-style entry is never stranded).
- folding a version that already has a section is refused (a double fold).
- sections are newest-first: the new section is inserted before the first
  existing one.
- a fragmentless release still writes the section: an empty release is
  recorded as such instead of silently skipping the changelog (a deliberate
  divergence from the TS per-package skip - the TS only skipped packages that
  had nothing; the one workspace changelog always gets its release section).

Usage:
    python3 scripts/release/fold_changelog.py --version <x.y.z> [--date YYYY-MM-DD] \
        [--repo-root .] [--changes-dir .changes] [--changelog CHANGELOG.md] [--dry-run]
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
UNRELEASED_RE = re.compile(
    # Line-anchored (^ or after a newline, so prose or a fenced example
    # quoting the literal heading mid-line cannot match) and tolerant of a
    # missing trailing newline (the stranded-EOF-heading case). Group 1
    # carries the preceding newline so the replacement keeps the section
    # on its own line.
    r"(^|\n)## \[Unreleased\][ \t]*\n?([\s\S]*?)(?=\n## \[|$)")
SECTION_START_RE = re.compile(r"^## \[", re.M)

# The seed header: written when CHANGELOG.md does not exist yet. Historical
# TypeScript release notes stay linked to their immutable release tag.
SEED_HEADER = """# Changelog

Release notes for Prime Agent. Historical TypeScript release notes are
recorded in the [TypeScript changelog](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.9.8/packages/coding-agent/CHANGELOG.md).
"""


def fragment_sort_key(repo: Path, path: Path) -> tuple[int, str]:
    """The TS sort: git add-date first, untracked files last, then path."""
    out = subprocess.run(
        ["git", "log", "--diff-filter=A", "--format=%ct", "-1", "--", path.name],
        cwd=path.parent, capture_output=True, text=True, check=False,
    )
    try:
        return (int(out.stdout.strip()), path.name)
    except ValueError:
        return (2**62, path.name)


def list_fragments(changes_dir: Path) -> list[Path]:
    if not changes_dir.is_dir():
        return []
    files = [
        p for p in changes_dir.iterdir()
        if p.is_file() and p.suffix == ".md" and p.name != "README.md"
    ]
    return sorted(files, key=lambda p: fragment_sort_key(p.parent, p))


def build_section(version: str, date: str, texts: list[str],
                  unreleased: str | None) -> str:
    parts = []
    if unreleased and unreleased.strip():
        parts.append(f"{unreleased.strip()}\n")
    parts.extend(f"{text.strip()}\n" for text in texts if text.strip())
    header = f"## [{version}] - {date}"
    return f"{header}\n\n{''.join(parts)}" if parts else f"{header}\n"


def fold(repo: Path, changes_dir: Path, changelog: Path, version: str,
         date: str, dry_run: bool) -> int:
    fragments = list_fragments(changes_dir)
    texts = {p: p.read_text() for p in fragments}
    consumed = [p for p in fragments if texts[p].strip()]
    for p in fragments:
        if not texts[p].strip():
            print(f"warning: skipping empty fragment {p.name}; "
                  "delete it or add content", file=sys.stderr)

    content = changelog.read_text() if changelog.is_file() else SEED_HEADER
    if re.search(rf"^## \[{re.escape(version)}\] - ", content, re.M):
        sys.exit(f"CHANGELOG already carries a [{version}] section: "
                 "refusing to fold")

    unreleased = UNRELEASED_RE.search(content)
    section = build_section(version, date, [texts[p] for p in consumed],
                            unreleased.group(2) if unreleased else None)
    if unreleased:
        content = UNRELEASED_RE.sub(
            lambda m: (m.group(1) or "") + section, content, count=1)
    else:
        first = SECTION_START_RE.search(content)
        if first:
            at = first.start()
            content = content[:at] + section + "\n" + content[at:]
        else:
            content = content.rstrip("\n") + "\n\n" + section
    content = content.rstrip("\n") + "\n"

    print(f"{'would fold' if dry_run else 'folding'} {len(consumed)} "
          f"non-empty fragment(s) into {changelog.name} "
          f"for [{version}] - {date}")
    if dry_run:
        print("--- section ---")
        print(section)
        print("would git rm: "
              + (", ".join(p.name for p in consumed) if consumed else "(none)"))
        return 0

    changelog.write_text(content)
    if consumed:
        # A fragment that is folded must be gone when the fold returns,
        # whatever its git state: `git rm` refuses untracked paths outright
        # and modified ones without -f, and any refusal would leave the fold
        # half-applied (CHANGELOG.md written, the fragment still present,
        # and a retry refused by the section guard). -f +
        # --ignore-unmatch removes tracked fragments despite local edits;
        # the unlink sweep then removes whatever git cannot, so no
        # half-fold can exist in any working-tree state.
        # A fragment name is DATA, never a pathspec: a file literally named
        # `:(top,glob)*.md` would be parsed as git pathspec magic and delete
        # matching ROOT markdown files (README.md, CHANGELOG.md itself) -
        # the fold would then stage their deletion. The `:(literal)` prefix
        # disables magic and globbing for every name, and with cwd pinned to
        # the fragments directory the deletion candidates are exactly the
        # consumed fragments; the unlink sweep uses the very same scoped
        # paths. A root-level file is never a deletion candidate.
        subprocess.run(["git", "rm", "-q", "-f", "--ignore-unmatch", "--",
                        *[f":(literal){path.name}" for path in consumed]],
                       cwd=changes_dir, check=False)
        for path in consumed:
            if path.is_file():
                path.unlink()
            print(f"consumed {path.name}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", required=True,
                    help="the release version (x.y.z, no v prefix)")
    ap.add_argument("--date", default=time.strftime("%Y-%m-%d", time.gmtime()),
                    help="the release date (YYYY-MM-DD; default: today UTC)")
    ap.add_argument("--repo-root", default=".",
                    help="the repository root (default: the current directory)")
    ap.add_argument("--changes-dir", default=".changes",
                    help="the fragment directory (default: .changes)")
    ap.add_argument("--changelog", default="CHANGELOG.md",
                    help="the changelog file (default: CHANGELOG.md)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the section + the would-consume list; write nothing")
    args = ap.parse_args()
    if not SEMVER_RE.fullmatch(args.version):
        sys.exit(f"version {args.version!r} must be plain x.y.z")
    repo = Path(args.repo_root).resolve()
    return fold(repo, repo / args.changes_dir, repo / args.changelog,
                args.version, args.date, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
