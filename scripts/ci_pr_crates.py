#!/usr/bin/env python3
"""Map a pull request's changed files to the crates its PR wave tests.

ci.yml's `changes` job resolves the selection: the test phase narrows to the
touched crates and their reverse dependencies (scripts/ci_test_shard.py
--crates) on PRs; push and merge-queue waves run the full union. The
mapping is fail-safe by construction: a selection that cannot be made is
the FULL selection — a wrong guess can
only cost runner minutes, never coverage.

The input is the pull-requests files API (`GET /repos/{o}/{r}/pulls/{n}/files`,
paginated by gh), one TSV row per file: `<filename>` TAB `<previous_filename>`
(the rename sidecar; empty for ordinary rows). The API's file field is named
`filename` (NOT `path` — the `gh pr view --json files` shape differs, and its
100-row cap silently under-maps large PRs).

The output is the job outputs (`crates` — a comma list, empty for the full
selection — and `scope`, the human-readable decision) written to the file in
`GITHUB_OUTPUT` (a plain report otherwise), plus a per-path report on stdout.

Usage (ci.yml):

    gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}/files" \
        --paginate --jq '.[] | [.filename, .previous_filename // ""] | @tsv' \
        > "${RUNNER_TEMP}/pr-files.tsv"
    python3 scripts/ci_pr_crates.py "${RUNNER_TEMP}/pr-files.tsv"

Tests: python3 scripts/test_ci_pr_crates.py  (make shard-gates runs it)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# The pulls/files API's own page ceiling: at or beyond it the list is
# truncated and the mapping is not trustworthy, so the full selection runs.
FILES_API_CEILING = 3000

# Conservative CI impact graph: some edges cover behavior beyond a direct
# Cargo.toml link. Over-selecting is safe; missing a dependent test is not.
# The changes job must select without installing Rust or running Cargo.
WORKSPACE_DEPS = {
    "pa-types": set(),
    "pa-telemetry": set(),
    "pa-ai": {"pa-types"},
    "pa-models": {"pa-ai"},
    "pa-agent": {"pa-ai", "pa-types"},
    "pa-core": {"pa-agent", "pa-ai", "pa-models", "pa-types", "pa-telemetry"},
    "pa-daemon": {"pa-core"},
    "pa-tui": {"pa-types", "pa-core"},
    "pa-cli": {"pa-types", "pa-telemetry", "pa-ai", "pa-models",
               "pa-agent", "pa-core", "pa-daemon", "pa-tui"},
}


def read_rows(path: Path) -> list[tuple[str, str]]:
    """The files-API rows, read raw: a leading-space path (` crates/...`)
    must stay the non-crate path it is, never be stripped into a crate
    mapping — the fields are tab-separated TSV, @tsv-escaped by jq, so no
    strip is needed or safe."""
    rows: list[tuple[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        name, _, previous = line.partition("\t")
        rows.append((name, previous))
    return rows


def select_crates(rows: list[tuple[str, str]]) -> list[str] | None:
    """The touched crates and reverse dependencies, or None for a full wave.

    Only known `crates/<pkg>/**` narrows. Everything else — the workflows,
    CI tooling, vendor/, the runtime sidecar, workspace-level Cargo files,
    install scripts, docs — affects more than any crate subset, and a rename
    counts both sides. An undecidable list (empty rows, the API ceiling or
    an unknown crate) fails safe to the full selection.
    """
    if not rows:
        return None
    if len(rows) >= FILES_API_CEILING:
        print(f"the PR has {len(rows)} changed files (the files API ceiling): "
              "the full selection runs")
        return None
    crates: set[str] = set()
    for name, previous in rows:
        if not name:
            # An empty filename column means the input is not the files
            # API's shape (a field-name regression): never select from it.
            print("an empty filename in the change list: the full selection runs")
            return None
        for candidate in (name, previous):
            if not candidate:
                continue  # an ordinary (non-rename) row has no removed side
            parts = candidate.split("/")
            if len(parts) >= 2 and parts[0] == "crates" and parts[1]:
                if parts[1] not in WORKSPACE_DEPS:
                    print(f"unknown crate {parts[1]}: the full selection runs")
                    return None
                crates.add(parts[1])
            else:
                print(f"non-crate path {candidate}: the full selection runs")
                return None
    # pa-types owns the shared wire vocabulary: run every workspace test for
    # its changes, including the independent pa-telemetry leaf crate.
    if "pa-types" in crates:
        return sorted(WORKSPACE_DEPS)
    # Walk upward through the DAG until no dependent is left unselected.
    while True:
        dependents = {crate for crate, deps in WORKSPACE_DEPS.items()
                      if deps & crates}
        expanded = crates | dependents
        if expanded == crates:
            return sorted(crates)
        crates = expanded


def write_outputs(crates: list[str] | None, output_path: str) -> None:
    lines = []
    if crates is None:
        lines.append("crates=")
        lines.append("scope=all")
    else:
        lines.append("crates=" + ",".join(crates))
        lines.append(f"scope=crates ({len(crates)}: {', '.join(crates)})")
    if output_path and output_path != "/dev/null":
        with open(output_path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    print("wave selection: " + lines[1].removeprefix("scope="))
    if crates:
        print("crates under test: " + ",".join(crates))


def main() -> int:
    rows = read_rows(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/dev/stdin"))
    crates = select_crates(rows)
    write_outputs(crates, os.environ.get("GITHUB_OUTPUT", "/dev/null"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
