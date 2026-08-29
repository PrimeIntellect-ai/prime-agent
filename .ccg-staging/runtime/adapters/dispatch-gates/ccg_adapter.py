"""Thin dispatch-gates adapter for the portable CCG router."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RUNTIME_ROOT))
from ccg_runtime.core import CcgRouter


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dispatch-gates-ccg-adapter")
    parser.add_argument("--config", required=True)
    parser.add_argument("--request", choices=("goal-task", "goal-dispatch", "goal-execute"), default="goal-dispatch")
    arguments = parser.parse_args(argv)
    print(json.dumps(CcgRouter(arguments.config).route(arguments.request), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
