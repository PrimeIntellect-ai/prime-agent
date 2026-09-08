from benchmarks.task_suite import SPEC, PUBLIC


def build_context(active, failures):
    return {"specification": SPEC, "public_cases": PUBLIC,
            "sources": [v["source"] for v in active.values()],
            "recent_failed_gates": failures[-3:]}
