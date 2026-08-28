# KernelBench Level 1 with Prime AVO

This runner evaluates Prime's agentic CUDA optimization behavior against the
official 100-problem KernelBench Level-1 deck. Every problem gets an isolated
Git workspace, protected reference/evaluator files, a durable Prime session,
an AVO trace, and a fresh host grade.

The protected acceptance test recognizes the exact immutable starting-solution
digest so the pre-edit AVO baseline can run. After `solution.py` changes, that
same command fails unless the candidate compiles, is correct, passes the static
custom-kernel check, and exceeds 1.0x speedup. A merely correct but slower
kernel therefore cannot satisfy the AVO coding gate.

The runner adds a stricter policy boundary on top of the upstream pattern
checker: cuBLAS, cuDNN, CUTLASS, ATen/PyTorch C++ compute calls, and dynamic
PyTorch operator fallbacks are rejected. This prevents a dummy `__global__`
function from disguising a library wrapper as a custom kernel.
Protected `sitecustomize.py` and `pytest.ini` files also remove the writable
workspace from Python's dependency lookup and disable candidate-provided pytest
configuration/plugins, so a passing receipt must come from the real evaluator.

The host reports both KernelBench metrics:

- `fast_0`: the solution is correct, passes the official static checker, and
  did not modify protected evaluator inputs;
- `fast_1`: `fast_0` plus measured speedup greater than 1.0 over local PyTorch
  eager execution.

## Prerequisites

Clone and prepare the official repository separately:

```bash
git clone https://github.com/ScalingIntelligence/KernelBench.git
cd KernelBench
uv sync
```

Local CUDA evaluation also needs `nvcc` and a compiler supported by the local
CUDA toolkit. The runner uses GCC/G++ 13 and targets NVIDIA Ampere because that
matches the calibrated machine. Scores are hardware-specific and must include
the GPU name.

From `packages/coding-agent`:

```bash
npm run eval:kernelbench -- \
  --problem 1 \
  --kernelbench-root /home/lewbei/deep_learning/avo-test/KernelBench \
  --provider google-vertex \
  --model gemini-3.7-flash
```

Run or resume all Level-1 problems:

```bash
npm run eval:kernelbench -- \
  --all --resume \
  --kernelbench-root /home/lewbei/deep_learning/avo-test/KernelBench \
  --output ~/.cache/prime-agent/kernelbench/gemini-3.7-flash-level1 \
  --provider google-vertex \
  --model gemini-3.7-flash
```

Each completed problem writes `result.json`, `host-grade.log`, the final
workspace, transcript, and session JSONL immediately. `report.json` and
`report.md` are rewritten after every problem, so an interrupted run can resume
without losing completed work.

On GPUs with limited VRAM, OOM or infrastructure failures must be reported
separately from model correctness. Do not compare an RTX 3050 score directly
with an L40S/H100 score.
