#!/usr/bin/env python3
"""Install the Prime Harness into a target repository.

Copies template/ into the target, merges .gitignore entries, and never
overwrites modified files unless --force. Idempotent: re-running against an
installed target reports "unchanged" and touches nothing.

Usage:
  python install.py <target-repo> [--force] [--check] [--dry-run]
"""

from __future__ import annotations

import argparse
import filecmp
import shutil
import subprocess
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent / "template"

GITIGNORE_BLOCK = [
    "# prime-harness runtime state (evidence db, gate logs, child results)",
    "artifacts/harness/",
]

NEXT_STEPS = """
Next steps
----------
1. cd {target}
2. python harness/doctor.py            # preflight; fix any FAILs
3. Review and customize:
     harness/manifest.json             # your real gate commands
     harness/roster.yaml               # specialist roles for your domain
     .prime/agent/APPEND_SYSTEM.md     # operating policy
4. Start Prime Agent from the repo root (a NEW session is required for the
   Python-backed skills to install into the kernel).
5. In the session:  /harness-task my-first-task <objective>
   Bounded autonomous bursts:  harness/burst.sh feature "<prompt>"  (or burst.ps1)
6. Outside the kernel, generate durable telemetry:
   python -S harness/scorecard.py --output artifacts/harness/scorecard-latest.json

The four skills (harness_orchestrator, sci_verify, evidence_ledger,
external_critic) appear in <available_skills> once the session starts.
""".rstrip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="path to the target repository root")
    parser.add_argument("--force", action="store_true", help="overwrite files that differ from the template")
    parser.add_argument("--check", action="store_true", help="run harness/doctor.py after installing")
    parser.add_argument("--dry-run", action="store_true", help="report actions without writing")
    args = parser.parse_args()

    target = Path(args.target).resolve()
    if not target.is_dir():
        sys.exit(f"error: target {target} is not a directory")
    if not (target / ".git").exists():
        print(f"warning: {target} is not a git repository root — the harness expects one "
              f"(worktrees, commit provenance, changed-file gates)")
    if not TEMPLATE.is_dir():
        sys.exit(f"error: template directory missing at {TEMPLATE}")

    copied, skipped_same, skipped_diff, overwritten = [], [], [], []

    for source in sorted(TEMPLATE.rglob("*")):
        if source.is_dir() or "__pycache__" in source.parts:
            continue
        rel = source.relative_to(TEMPLATE)
        dest = target / rel
        if dest.exists():
            if filecmp.cmp(str(source), str(dest), shallow=False):
                skipped_same.append(rel)
                continue
            if not args.force:
                skipped_diff.append(rel)
                continue
            if not args.dry_run:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(source), str(dest))
            overwritten.append(rel)
        else:
            if not args.dry_run:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(source), str(dest))
            copied.append(rel)

    prefix = "[dry-run] " if args.dry_run else ""

    # .gitignore merge (append-only, marker-guarded)
    gitignore = target / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8") if gitignore.is_file() else ""
    missing_lines = [line for line in GITIGNORE_BLOCK if line not in existing.splitlines()]
    if any(not line.startswith("#") for line in missing_lines):
        if not args.dry_run:
            with gitignore.open("a", encoding="utf-8", newline="\n") as handle:
                if existing and not existing.endswith("\n"):
                    handle.write("\n")
                handle.write("\n".join(missing_lines) + "\n")
        print(f"{prefix}updated .gitignore (+{sum(1 for l in missing_lines if not l.startswith('#'))} entries)")
    print(f"{prefix}installed to {target}")
    print(f"  new files:        {len(copied)}")
    print(f"  unchanged:        {len(skipped_same)}")
    if overwritten:
        print(f"  overwritten:      {len(overwritten)} (--force)")
    if skipped_diff:
        print(f"  kept local edits: {len(skipped_diff)} (template differs; use --force to overwrite)")
        for rel in skipped_diff:
            print(f"    - {rel}")

    if args.check and not args.dry_run:
        print("\nrunning doctor...\n")
        result = subprocess.run([sys.executable, str(target / "harness" / "doctor.py")], cwd=str(target))
        print(NEXT_STEPS.format(target=target))
        return result.returncode
    print(NEXT_STEPS.format(target=target))
    return 0


if __name__ == "__main__":
    sys.exit(main())
