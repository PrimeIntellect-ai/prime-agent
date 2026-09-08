import json
from core.ast_validator import parse, validate
from benchmarks.task_suite import PUBLIC
from benchmarks.holdout_suite import samples
from evaluator.property_checks import generalization_cases
from evaluator.oracle import expected
from core.ledger import objective

GATES = ["syntax", "ast_safety", "isolation_boot", "public", "regression",
         "holdout", "generalization", "performance", "differential", "determinism"]


class Verifier:
    def __init__(self, runner):
        self.runner = runner

    def verify(self, source, active):
        gates = []
        measurements = {}
        tree = None
        def check(code, cases):
            result = self.runner.execute(code, cases)
            if result["outputs"] != expected(cases):
                raise ValueError("output mismatch")
            return result
        for number, name in enumerate(GATES, 1):
            try:
                if number == 1:
                    tree = parse(source)
                elif number == 2:
                    validate(tree)
                elif number == 3:
                    self.runner.boot()
                elif number == 4:
                    check(source, PUBLIC)
                elif number == 5:
                    regression = PUBLIC + generalization_cases()
                    check(source, regression)
                    for skill in active.values():
                        check(skill["source"], regression)
                elif number == 6:
                    check(source, samples(128))
                elif number == 7:
                    check(source, generalization_cases())
                elif number == 8:
                    cases = [(list(range(10000)), i) for i in (0, 1, 5000, 9999, 10000)]
                    measurements = check(source, cases)
                    if measurements["cpu_seconds"] > 0.2 or measurements["peak_bytes"] > 8_000_000:
                        raise ValueError("resource threshold exceeded")
                elif number == 9:
                    check(source, samples(1000))
                else:
                    cases = samples(64)
                    outputs = [json.dumps(check(source, cases)["outputs"], separators=(",", ":")) for _ in range(3)]
                    if len(set(outputs)) != 1:
                        raise ValueError("nondeterministic outputs")
                gates.append({"number": number, "name": name, "passed": True})
            except Exception as error:
                # Do not expose holdout data or candidate-generated exceptions to synthesis.
                gates.append({"number": number, "name": name, "passed": False, "error_type": type(error).__name__})
                return {"passed": False, "gates": gates}
        return {"passed": True, "gates": gates,
                "objective": objective(source, tree, measurements["cpu_seconds"], measurements["peak_bytes"]),
                "measurements": {k: measurements[k] for k in ("cpu_seconds", "peak_bytes")}}
