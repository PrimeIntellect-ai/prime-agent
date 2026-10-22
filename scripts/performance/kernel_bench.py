#!/usr/bin/env python3
"""Historical kernel protocol probes, without model or provider traffic."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

from kernel_protocol import (BASH_EMPTY, BASH_OUTPUT, CELL_REPEATS, GIT_STATUS,
                             OUTPUT_BYTES, SHELL_REPEATS, Kernel)
from provenance import harness_sha256


def measure(runtime: Path, evidence: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="pa-kernel-", dir="/tmp") as temporary:
        root = Path(temporary)
        (root / "home").mkdir()
        subprocess.run(["git", "init", "-q", str(root / "work")], check=True)
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(root / "home"),
               "TMPDIR": str(root), "UV_OFFLINE": "1", "OPENBLAS_NUM_THREADS": "1",
               "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
        command = [str(runtime), "-m", "rlm.repl"]
        kernel = Kernel(command, root / "work", env, evidence / "kernel")
        try:
            startup, version = kernel.ready()
            metrics = {"kernel_start_ms": startup * 1000}
            kernel.execute("from rlm import bash")
            kernel.batch("pass", 5)
            kernel.batch(BASH_EMPTY, 1)
            for name, code, repeats, output in (
                ("cell_ms", "pass", CELL_REPEATS, None), ("bash_ms", BASH_EMPTY, SHELL_REPEATS, None),
                ("git_status_ms", GIT_STATUS, SHELL_REPEATS, None), ("shell_output_ms", BASH_OUTPUT, SHELL_REPEATS, OUTPUT_BYTES),
                ("file_io_ms", f"from pathlib import Path\n_io = b'x' * 32768\n_io_path = Path({str(root / 'io.bin')!r})\n_io_path.write_bytes(_io)\nassert _io_path.read_bytes() == _io", 10, None),
            ):
                metrics[name] = kernel.batch(code, repeats, output_bytes=output) * 1000
            metrics["mixed_ms"] = kernel.mixed() * 1000
            metrics["interrupt_ms"] = kernel.interrupt() * 1000
            kernel.execute("import pandas as pd\nframe = pd.DataFrame({'value': range(10000)})\npayload = list(range(10000))")
            started = time.perf_counter()
            events = kernel.request("snapshot", path=str(root / "state.pkl"), manifest_path=str(root / "manifest.json"))
            metrics["snapshot_ms"] = (time.perf_counter() - started) * 1000
            if not {"frame", "payload"} <= set(events[-1].get("saved", [])):
                raise RuntimeError("snapshot omitted fixture state")
            kernel.close()
            kernel = Kernel(command, root / "work", env, evidence / "restore")
            kernel.ready()
            started = time.perf_counter()
            events = kernel.request("restore", path=str(root / "state.pkl"))
            metrics["restore_ms"] = (time.perf_counter() - started) * 1000
            if events[-1].get("failed") or not {"frame", "payload"} <= set(events[-1].get("restored", [])):
                raise RuntimeError("restore omitted fixture state")
            kernel.execute("assert frame.shape == (10000, 1)\nassert int(frame['value'].sum()) == 49995000\nassert payload == list(range(10000))")
            return {"metrics": metrics, "python": version}
        finally:
            kernel.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for side in ("base", "head"):
        parser.add_argument(f"--{side}-runtime", type=Path, required=True)
        parser.add_argument(f"--{side}-sha", required=True)
        parser.add_argument(f"--{side}-runtime-manifest", type=Path)
    parser.add_argument("--trials", type=int, default=10)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.trials <= 30:
        parser.error("trials must be 1..30")
    if not all(re.fullmatch('[0-9a-f]{40}', sha) for sha in (args.base_sha, args.head_sha)):
        parser.error('requires full lowercase commit SHAs')
    args.out.mkdir(parents=True, exist_ok=False)
    report = {"schema": 1, "base_sha": args.base_sha, "head_sha": args.head_sha, "trials": args.trials,
              "harness_sha256": harness_sha256(), "sides": {}}
    for side in ("base", "head"):
        runtime = getattr(args, f"{side}_runtime").absolute()
        report["sides"][side] = {"runtime_command_sha256": hashlib.sha256(runtime.read_bytes()).hexdigest(),
                                  "runtime_manifest_sha256": hashlib.sha256(getattr(args, f'{side}_runtime_manifest').read_bytes()).hexdigest() if getattr(args, f'{side}_runtime_manifest') else None,
                                  "samples": {"kernel": []}}
    try:
        for trial in range(args.trials):
            for side in (("base", "head") if trial % 2 == 0 else ("head", "base")):
                evidence = args.out / f"{trial}-{side}"
                evidence.mkdir()
                report["sides"][side]["samples"]["kernel"].append(measure(getattr(args, f"{side}_runtime").absolute(), evidence))
        report["status"] = "completed"
    except Exception:
        report["status"] = "failed"
        raise
    finally:
        (args.out / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
