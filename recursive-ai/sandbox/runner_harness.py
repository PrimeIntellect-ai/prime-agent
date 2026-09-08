"""Trusted image entrypoint. NEVER import or execute this file on the host."""
import builtins
import json
import os
from pathlib import Path
import resource
import sys
import time
import tracemalloc

SAFE = {name: getattr(builtins, name) for name in
        ("len", "range", "min", "max", "abs", "sum", "sorted", "enumerate", "zip", "reversed", "all", "any", "int", "bool", "list", "tuple")}


def main():
    request = json.loads(sys.stdin.buffer.read(2_000_001))
    if request.get("probe"):
        status = dict(line.split(":", 1) for line in open("/proc/self/status") if ":" in line)
        readonly = bool(os.statvfs("/").f_flag & os.ST_RDONLY)
        print(json.dumps({"uid": os.getuid(), "readonly": readonly,
                          "seccomp": int(status["Seccomp"]), "no_new_privs": int(status["NoNewPrivs"]),
                          "caps": int(status["CapEff"].strip(), 16),
                          "cpu_max": Path("/sys/fs/cgroup/cpu.max").read_text().strip(),
                          "memory_max": Path("/sys/fs/cgroup/memory.max").read_text().strip(),
                          "swap_max": Path("/sys/fs/cgroup/memory.swap.max").read_text().strip(),
                          "pids_max": Path("/sys/fs/cgroup/pids.max").read_text().strip()}))
        return
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    namespace = {"__builtins__": SAFE}
    exec(compile(request["source"], "candidate", "exec"), namespace)
    function = namespace["binary_search"]
    original = json.dumps(request["cases"], separators=(",", ":"))
    tracemalloc.start()
    start = time.process_time()
    results = [function(*case) for case in request["cases"]]
    elapsed = time.process_time() - start
    _, peak = tracemalloc.get_traced_memory()
    if any(type(value) is not int for value in results):
        raise ValueError("outputs must be integers")
    if json.dumps(request["cases"], separators=(",", ":")) != original:
        raise ValueError("candidate mutated inputs")
    print(json.dumps({"outputs": results, "cpu_seconds": elapsed, "peak_bytes": peak}, allow_nan=False))


if __name__ == "__main__":
    main()
