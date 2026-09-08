import ast
import math


def capability(skills, weights):
    if not weights or any(w < 0 or not math.isfinite(w) for w in weights.values()) or not math.isclose(sum(weights.values()), 1):
        raise ValueError("weights must be finite, nonnegative and sum to one")
    return sum(w for task, w in weights.items() if task in skills)


def metrics(before, after, elapsed, previous_rate=0.0):
    if elapsed <= 0 or not all(math.isfinite(v) for v in (before, after, elapsed, previous_rate)):
        raise ValueError("invalid metric input")
    delta = after - before
    rate = delta / elapsed
    return {"capability": after, "delta": delta, "wall_seconds": elapsed,
            "efficiency_per_second": rate, "rate_change": rate - previous_rate}


def objective(source, tree, cpu_seconds, peak_bytes):
    stack = [(tree, 1)]
    depth = 0
    while stack:
        node, level = stack.pop()
        depth = max(depth, level)
        stack.extend((child, level + 1) for child in ast.iter_child_nodes(node))
    return 1.0 - 0.001 * depth - len(source.encode()) / 1_000_000 - peak_bytes / 1_000_000_000 - cpu_seconds / 10


def confidence(successes, failures):
    if successes < 0 or failures < 0:
        raise ValueError("evidence cannot be negative")
    return (1 + successes) / (2 + successes + failures)
