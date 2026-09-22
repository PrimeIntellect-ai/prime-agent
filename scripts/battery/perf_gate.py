#!/usr/bin/env python3
"""Regression gate for the perf wave: compare a fresh results.json against
the recorded baseline and flag Rust regressions beyond a threshold.

The gate compares the RUST side's own medians against the baseline's rust
medians (an absolute regression check): the TS side is the ground truth and
its numbers move with the TS release, but a Rust metric that got >10% worse
than the recorded baseline is a regression regardless of TS.

Higher-is-worse for every metric compared here.

Usage:
    python3 scripts/battery/perf_gate.py --results <run>/results.json \
        [--baseline scripts/battery/perf-baseline.json] [--threshold 1.10]

Not part of the product.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# results[dim][side] -> the metrics the gate tracks (all lower-is-better).
TRACKED = {
    "startup_typing": ["ready_s_median", "typing_ms_median", "typing_ms_p95"],
    "idle_rss": ["total_mb_median"],
    "load_rss": ["total_mb"],
    "resume": ["ready_s_median"],
    "kernel_spawn": [
        "create_to_first_cell_s_cold_median",
        "prompt_to_first_cell_s_warm_median",
    ],
    "streaming": ["settle_s_median"],
    "sustained_cpu": [
        "tui_idle_mean_pct",
        "tui_plain_mean_pct",
        "tui_code_mean_pct",
        "tui_tool_mean_pct",
        "typing_ms_median",
    ],
    "compaction": ["compact_s_median"],
    "export": ["export_s_median"],
    "daemon_overhead": ["delta_kb_median", "per_session_kb_median"],
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    here = Path(__file__).resolve().parent
    parser.add_argument("--results", required=True)
    parser.add_argument("--baseline", default=str(here / "perf-baseline.json"))
    parser.add_argument("--threshold", type=float, default=1.10)
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="dims absent from the fresh run are warnings, not failures",
    )
    args = parser.parse_args()

    fresh = json.loads(Path(args.results).read_text())
    baseline = json.loads(Path(args.baseline).read_text())
    fresh_results = fresh.get("results", {})
    baseline_results = baseline.get("results", {})

    regressions = []
    warnings = []
    checked = 0
    for dim, metrics in TRACKED.items():
        fresh_dim = fresh_results.get(dim)
        base_dim = baseline_results.get(dim)
        if not isinstance(fresh_dim, dict) or not isinstance(base_dim, dict):
            message = f"{dim}: not evaluable (missing from "
            message += "fresh run)" if base_dim else "(missing from baseline)"
            (warnings if args.allow_missing else regressions).append(message)
            continue
        for metric in metrics:
            fresh_value = fresh_dim.get("rust", {}).get(metric)
            base_value = base_dim.get("rust", {}).get(metric)
            if fresh_value is None or base_value is None:
                (warnings if args.allow_missing else regressions).append(
                    f"{dim}.{metric}: not evaluable (fresh={fresh_value} baseline={base_value})"
                )
                continue
            checked += 1
            ratio = float(fresh_value) / float(base_value)
            if ratio > args.threshold:
                regressions.append(
                    f"REGRESSION {dim}.{metric}: rust {fresh_value} vs baseline "
                    f"{base_value} (ratio {ratio:.2f} > {args.threshold})"
                )
            else:
                print(
                    f"ok {dim}.{metric}: rust {fresh_value} vs baseline "
                    f"{base_value} (ratio {ratio:.2f})"
                )

    for message in warnings:
        print(f"WARN {message}")
    if regressions:
        for message in regressions:
            print(message, file=sys.stderr)
        print(
            f"FAIL: {len(regressions)} regression(s) beyond "
            f"{args.threshold:.2f}x the recorded baseline ({checked} metrics checked)",
            file=sys.stderr,
        )
        return 1
    print(f"PASS: no rust regression beyond {args.threshold:.2f}x ({checked} metrics checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
