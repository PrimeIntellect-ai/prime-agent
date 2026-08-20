"""sci-verify — deterministic scientific verification oracles.

Converts "the model thinks the result is right" into an executable evidence
bundle. Every check writes its full evidence to an artifact file and returns
a compact VerificationResult; bulky data never has to enter model context.

Doctrine (also enforced by messaging in results):
- symbolic equality is meaningless without explicit assumptions;
- numerical agreement at one precision is not proof — use the ladder;
- randomized tests must record their seeds;
- an inconclusive result must never be reported as a pass.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from ._common import atomic_write_json, harness_dir, repo_root, run_with_tree_kill, utc_now_iso

__all__ = [
    "VerificationResult",
    "symbolic_equivalence",
    "numeric_compare",
    "check_convergence",
    "check_invariant",
    "property_suite",
    "run_suite",
    "run",
]

_STATUSES = ("pass", "fail", "inconclusive", "error")

# Symbol assumption tokens accepted by symbolic_equivalence
_ALLOWED_ASSUMPTIONS = {
    "real", "positive", "negative", "nonnegative", "nonpositive",
    "nonzero", "integer", "rational", "complex", "finite", "even", "odd",
}


@dataclass
class VerificationResult:
    status: str
    method: str
    claim: str
    assumptions: dict[str, Any] = field(default_factory=dict)
    evidence: dict[str, Any] = field(default_factory=dict)
    artifact_paths: list[str] = field(default_factory=list)
    reproducibility: str = ""
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def __post_init__(self) -> None:
        if self.status not in _STATUSES:
            raise ValueError(f"status must be one of {_STATUSES}, got {self.status!r}")


def _write_evidence(method: str, payload: dict[str, Any]) -> Path:
    out_dir = harness_dir() / "verify"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = utc_now_iso().replace(":", "").replace("+", "Z")
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:8]
    path = out_dir / f"{stamp}-{method}-{digest}.json"
    atomic_write_json(path, payload)
    return path


# ---------------------------------------------------------------------------
# Symbolic equivalence (SymPy, assumption-aware, with numeric falsification)
# ---------------------------------------------------------------------------


def _build_symbols(names: Iterable[str], assumptions: dict[str, str] | None) -> dict[str, Any]:
    import sympy

    assumptions = assumptions or {}
    table: dict[str, Any] = {}
    for name in names:
        flags: dict[str, bool] = {}
        for token in re.split(r"[\s,]+", assumptions.get(name, "").strip()):
            if not token:
                continue
            if token not in _ALLOWED_ASSUMPTIONS:
                raise ValueError(
                    f"unknown assumption {token!r} for symbol {name!r}; allowed: {sorted(_ALLOWED_ASSUMPTIONS)}"
                )
            flags[token] = True
        table[name] = sympy.Symbol(name, **flags)
    return table


def _satisfies_assumptions(symbol: Any, value: float) -> bool:
    """Does a concrete real value satisfy the symbol's declared assumptions?"""
    if getattr(symbol, "is_integer", None) and value != int(value):
        return False
    if getattr(symbol, "is_even", None) and int(value) % 2 != 0:
        return False
    if getattr(symbol, "is_odd", None) and int(value) % 2 == 0:
        return False
    if getattr(symbol, "is_positive", None) and not value > 0:
        return False
    if getattr(symbol, "is_negative", None) and not value < 0:
        return False
    if getattr(symbol, "is_nonnegative", None) and value < 0:
        return False
    if getattr(symbol, "is_nonpositive", None) and value > 0:
        return False
    if getattr(symbol, "is_nonzero", None) and value == 0:
        return False
    return True


def _sample_value(rng: random.Random, name: str, symbol: Any, domain: dict[str, tuple[float, float]] | None) -> float | None:
    """One candidate draw honoring sign/integer assumptions and the caller's
    domain. Returns None when the constrained range is empty."""
    low, high = -10.0, 10.0
    if domain and name in domain:
        low, high = domain[name]
    if getattr(symbol, "is_positive", None):
        low = max(low, 1e-6)
    elif getattr(symbol, "is_nonnegative", None):
        low = max(low, 0.0)
    if getattr(symbol, "is_negative", None):
        high = min(high, -1e-6)
    elif getattr(symbol, "is_nonpositive", None):
        high = min(high, 0.0)
    if low > high:
        return None
    if getattr(symbol, "is_integer", None):
        low_int, high_int = math.ceil(low), math.floor(high)
        if low_int > high_int:
            return None
        return float(rng.randint(low_int, high_int))
    return rng.uniform(low, high)


def _sample_assignment(
    rng: random.Random,
    symbols: dict[str, Any],
    domain: dict[str, tuple[float, float]] | None,
    max_attempts_per_symbol: int = 100,
) -> dict[Any, float] | None:
    """Rejection-sample a full assignment satisfying every assumption; None if
    any symbol's constraints cannot be met (bounded — never loops forever)."""
    subs: dict[Any, float] = {}
    for name, symbol in symbols.items():
        value: float | None = None
        for _ in range(max_attempts_per_symbol):
            candidate = _sample_value(rng, name, symbol, domain)
            if candidate is not None and _satisfies_assumptions(symbol, candidate):
                value = candidate
                break
        if value is None:
            return None
        subs[symbol] = value
    return subs


def symbolic_equivalence(
    lhs: str,
    rhs: str,
    assumptions: dict[str, str] | None = None,
    sample_domain: dict[str, tuple[float, float]] | None = None,
    *,
    samples: int = 64,
    seed: int = 0,
    tol: float = 1e-9,
) -> VerificationResult:
    """Are two expressions equal under the declared assumptions?

    Outcomes: pass (proved symbolically), fail (numeric counterexample found),
    inconclusive (neither proof nor counterexample), error (parse failure).
    """
    import sympy

    claim = f"({lhs}) == ({rhs}) under {assumptions or {}}"
    try:
        probe_l = sympy.sympify(lhs)
        probe_r = sympy.sympify(rhs)
        names = sorted({s.name for s in probe_l.free_symbols | probe_r.free_symbols})
        symbols = _build_symbols(names, assumptions)
        expr_l = sympy.sympify(lhs, locals=symbols)
        expr_r = sympy.sympify(rhs, locals=symbols)
    except (sympy.SympifyError, ValueError, TypeError, SyntaxError) as exc:
        return VerificationResult(status="error", method="symbolic", claim=claim,
                                  evidence={"parse_error": str(exc)})

    diff = expr_l - expr_r
    simplified = sympy.simplify(diff)
    payload: dict[str, Any] = {
        "claim": claim, "lhs": lhs, "rhs": rhs,
        "assumptions": assumptions or {}, "simplified_difference": str(simplified),
        "seed": seed, "samples": samples, "tol": tol, "sympy_version": sympy.__version__,
    }
    warnings: list[str] = []

    proved = simplified == 0
    if not proved:
        equals = diff.equals(0)  # SymPy's own structural+numeric test; may return None
        if equals is True:
            proved = True
            warnings.append("proved via Expr.equals (numeric-assisted), not pure simplification")

    if proved:
        artifact = _write_evidence("symbolic", {**payload, "outcome": "pass"})
        return VerificationResult(
            status="pass", method="symbolic-simplify", claim=claim,
            assumptions=assumptions or {}, evidence={"simplified_difference": str(simplified)},
            artifact_paths=[str(artifact)], warnings=warnings,
            reproducibility=f"sci_verify.symbolic_equivalence({lhs!r}, {rhs!r}, {assumptions!r}, seed={seed})",
        )

    # Numeric falsification sweep (samples always honor the declared assumptions)
    rng = random.Random(seed)
    counterexamples: list[dict[str, Any]] = []
    evaluated = skipped = 0
    for _ in range(samples):
        subs = _sample_assignment(rng, symbols, sample_domain)
        if subs is None:
            skipped += 1
            continue
        try:
            value = complex(diff.evalf(subs=subs, chop=False))
        except (TypeError, ValueError, ZeroDivisionError):
            skipped += 1
            continue
        if math.isnan(value.real) or math.isnan(value.imag):
            skipped += 1
            continue
        evaluated += 1
        scale = 1.0 + max(abs(complex(expr_l.evalf(subs=subs))), abs(complex(expr_r.evalf(subs=subs))))
        if abs(value) > tol * scale:
            # defense in depth: never report a counterexample that violates assumptions
            if not all(_satisfies_assumptions(sym, val) for sym, val in subs.items()):
                skipped += 1
                continue
            counterexamples.append({str(k): float(v) for k, v in subs.items()} | {"|difference|": abs(value)})
            if len(counterexamples) >= 3:
                break

    payload |= {"evaluated": evaluated, "skipped": skipped, "counterexamples": counterexamples}
    artifact = _write_evidence("symbolic", payload)
    repro = f"sci_verify.symbolic_equivalence({lhs!r}, {rhs!r}, {assumptions!r}, seed={seed}, samples={samples})"

    if counterexamples:
        return VerificationResult(
            status="fail", method="numeric-falsification", claim=claim,
            assumptions=assumptions or {},
            evidence={"counterexamples": counterexamples, "simplified_difference": str(simplified)},
            artifact_paths=[str(artifact)], reproducibility=repro, warnings=warnings,
        )
    if evaluated == 0:
        warnings.append("no sample point could be evaluated — domain likely excludes all samples")
    warnings.append(
        "not proved symbolically and no counterexample found — this is INCONCLUSIVE, not a pass; "
        "consider tighter assumptions, a different canonical form, or an independent CAS"
    )
    return VerificationResult(
        status="inconclusive", method="symbolic+sampling", claim=claim,
        assumptions=assumptions or {},
        evidence={"simplified_difference": str(simplified), "evaluated": evaluated, "skipped": skipped},
        artifact_paths=[str(artifact)], reproducibility=repro, warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Precision-ladder numeric comparison (mpmath via SymPy)
# ---------------------------------------------------------------------------


def numeric_compare(
    implementation: Callable[..., float],
    reference: Callable[..., Any] | str,
    cases: Sequence[dict[str, float]],
    *,
    precisions_bits: Sequence[int] = (53, 106, 212),
    rel_tol: float = 1e-9,
    abs_tol: float = 1e-12,
    claim: str = "implementation matches reference",
) -> VerificationResult:
    """Compare an implementation against a high-precision reference.

    `reference` is either a callable evaluated per case (use mpmath types for
    full-precision benefit) or a SymPy expression string whose free symbols
    match the case keys. Agreement at 53 bits that degrades as reference
    precision increases is flagged, not passed.
    """
    import mpmath
    import sympy

    ref_expr = None
    if isinstance(reference, str):
        ref_expr = sympy.sympify(reference)

    rows: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    warnings: list[str] = []

    for index, case in enumerate(cases):
        try:
            impl_value = float(implementation(**case))
        except Exception as exc:  # implementation under test may raise
            failures.append({"case": case, "error": f"implementation raised {exc!r}"})
            continue
        # Evaluate the reference across the ladder, keeping full-precision
        # mpf/mpc objects for arithmetic (strings are for evidence only —
        # round-tripping through Python complex/float would defeat the ladder).
        ladder_values: list[Any] = []
        ladder_display: dict[int, str] = {}
        case_error: str | None = None
        for bits in precisions_bits:
            digits = max(8, int(bits * 0.30103) + 2)
            try:
                with mpmath.workprec(bits):
                    if ref_expr is not None:
                        number = ref_expr.evalf(digits, subs=case)
                        if number.free_symbols:
                            case_error = ("reference does not bind symbols "
                                          f"{sorted(str(s) for s in number.free_symbols)}")
                            break
                        ref_val = number._to_mpmath(bits)
                    else:
                        ref_val = reference(**case)
                    ladder_values.append(ref_val)
                    ladder_display[bits] = mpmath.nstr(ref_val, digits)
            except Exception as exc:
                case_error = f"reference raised {exc!r}"
                break
        if case_error is not None:
            failures.append({"case": case, "error": case_error})
            continue
        with mpmath.workprec(precisions_bits[-1]):
            ref_high = ladder_values[-1]
            if len(ladder_values) >= 2:
                drift = abs(ladder_values[-1] - ladder_values[0])
                if drift > (abs_tol + rel_tol * abs(ref_high)) * 10:
                    warnings.append(f"case {index}: reference drifts across the precision ladder — "
                                    "reference may be unstable")
            err = abs(impl_value - ref_high)  # abs() of mpc/mpf is mpf
            bound = abs_tol + rel_tol * abs(ref_high)
            ok = bool(err <= bound)
        rows.append({"case": case, "impl": impl_value, "reference_ladder": ladder_display,
                     "abs_error": float(err), "bound": float(bound), "ok": ok})
        if not ok:
            failures.append({"case": case, "impl": impl_value,
                             "reference": ladder_display[precisions_bits[-1]], "abs_error": float(err)})

    payload = {"claim": claim, "precisions_bits": list(precisions_bits),
               "rel_tol": rel_tol, "abs_tol": abs_tol, "rows": rows, "failures": failures}
    artifact = _write_evidence("numeric", payload)
    status = "fail" if failures else ("pass" if rows else "error")
    if not rows and not failures:
        warnings.append("no cases supplied")
    return VerificationResult(
        status=status, method="precision-ladder", claim=claim,
        evidence={"cases": len(rows), "failures": failures[:5]},
        artifact_paths=[str(artifact)], warnings=warnings,
        reproducibility=f"sci_verify.numeric_compare(..., precisions_bits={list(precisions_bits)})",
    )


# ---------------------------------------------------------------------------
# Convergence order and invariants
# ---------------------------------------------------------------------------


def check_convergence(
    errors: Sequence[float] | Callable[[int], float],
    resolutions: Sequence[int],
    expected_order: float,
    *,
    tolerance: float = 0.5,
    claim: str = "solution converges at the expected order",
) -> VerificationResult:
    """Least-squares observed order from log(error) vs log(h), h = 1/resolution."""
    resolutions = list(resolutions)
    if any(not isinstance(r, (int, float)) or r <= 0 for r in resolutions):
        return VerificationResult(status="error", method="convergence", claim=claim,
                                  evidence={"reason": "resolutions must be positive numbers",
                                            "resolutions": resolutions})
    if len(resolutions) < 3 or len(set(resolutions)) < 3:
        return VerificationResult(status="error", method="convergence", claim=claim,
                                  evidence={"reason": "need >= 3 distinct (resolution, error) pairs",
                                            "resolutions": resolutions})
    if callable(errors):
        errors = [float(errors(r)) for r in resolutions]
    errors = [float(e) for e in errors]
    if len(errors) != len(resolutions):
        return VerificationResult(status="error", method="convergence", claim=claim,
                                  evidence={"reason": "errors and resolutions differ in length"})
    if any(e <= 0 for e in errors):
        return VerificationResult(status="error", method="convergence", claim=claim,
                                  evidence={"reason": "errors must be positive", "errors": errors})
    xs = [math.log(1.0 / r) for r in resolutions]
    ys = [math.log(e) for e in errors]
    n = len(xs)
    mean_x, mean_y = sum(xs) / n, sum(ys) / n
    denom = sum((x - mean_x) ** 2 for x in xs)
    observed = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denom
    monotone = all(errors[i + 1] < errors[i] for i in range(n - 1))
    ok = abs(observed - expected_order) <= tolerance and monotone
    payload = {"claim": claim, "resolutions": list(resolutions), "errors": errors,
               "observed_order": observed, "expected_order": expected_order,
               "tolerance": tolerance, "monotone_decreasing": monotone}
    artifact = _write_evidence("convergence", payload)
    warnings = [] if monotone else ["errors are not monotonically decreasing under refinement"]
    return VerificationResult(
        status="pass" if ok else "fail", method="convergence-order", claim=claim,
        evidence={"observed_order": round(observed, 4), "expected_order": expected_order,
                  "monotone_decreasing": monotone},
        artifact_paths=[str(artifact)], warnings=warnings,
        reproducibility=f"sci_verify.check_convergence(errors={errors}, resolutions={list(resolutions)}, expected_order={expected_order})",
    )


def check_invariant(
    series: Sequence[float],
    *,
    rtol: float = 1e-8,
    name: str = "invariant",
    claim: str | None = None,
) -> VerificationResult:
    """Bounded relative drift of a conserved quantity over a trajectory."""
    series = [float(x) for x in series]
    claim = claim or f"{name} is conserved to rtol={rtol}"
    if len(series) < 2:
        return VerificationResult(status="error", method="invariant", claim=claim,
                                  evidence={"reason": "need >= 2 samples"})
    ref = series[0]
    scale = max(abs(ref), 1e-300)
    drift = max(abs(x - ref) for x in series) / scale
    payload = {"claim": claim, "name": name, "rtol": rtol, "samples": len(series),
               "initial": ref, "max_relative_drift": drift}
    artifact = _write_evidence("invariant", payload)
    return VerificationResult(
        status="pass" if drift <= rtol else "fail", method="invariant-drift", claim=claim,
        evidence={"max_relative_drift": drift, "rtol": rtol, "samples": len(series)},
        artifact_paths=[str(artifact)],
        reproducibility=f"sci_verify.check_invariant(<series>, rtol={rtol}, name={name!r})",
    )


# ---------------------------------------------------------------------------
# Property tests and the composite gate
# ---------------------------------------------------------------------------


def property_suite(
    path: str = "checks/properties",
    *,
    timeout_seconds: int = 900,
) -> VerificationResult:
    """Run the Hypothesis/pytest property suite in a subprocess.

    (The suite lives under checks/ — NOT "verification/", which Prime Agent's
    autonomous gate excludes from its changed-workspace detection.)
    """
    root = repo_root()
    target = root / path
    claim = f"property suite {path} passes"
    if not target.exists():
        return VerificationResult(status="error", method="property", claim=claim,
                                  evidence={"reason": f"{target} does not exist"})
    cmd = [sys.executable, "-m", "pytest", "-q", "--tb=short", str(target)]
    returncode, stdout, stderr, timed_out = run_with_tree_kill(cmd, timeout=timeout_seconds, cwd=str(root))
    if timed_out:
        return VerificationResult(status="error", method="property", claim=claim,
                                  evidence={"reason": f"timed out after {timeout_seconds}s (process tree killed)"})
    tail = "\n".join((stdout + "\n" + stderr).strip().splitlines()[-30:])
    artifact = _write_evidence("property", {"claim": claim, "command": cmd,
                                            "returncode": returncode,
                                            "stdout": stdout[-20000:], "stderr": stderr[-20000:]})
    if returncode == 0:
        status = "pass"
    elif returncode == 5:  # pytest: no tests collected
        status = "inconclusive"
    else:
        status = "fail"
    return VerificationResult(
        status=status, method="hypothesis-pytest", claim=claim,
        evidence={"returncode": returncode, "tail": tail},
        artifact_paths=[str(artifact)],
        reproducibility=" ".join(cmd),
        warnings=["no tests collected"] if status == "inconclusive" else [],
    )


def run_suite(profile: str = "default", *, timeout_seconds: int = 3600) -> VerificationResult:
    """Run the composite gate (harness/verify.py) — the same command the
    autonomous gate runs — and return its structured verdict."""
    root = repo_root()
    gate = root / "harness" / "verify.py"
    claim = f"composite gate profile {profile!r} passes"
    if not gate.is_file():
        return VerificationResult(status="error", method="gate", claim=claim,
                                  evidence={"reason": f"{gate} not found"})
    cmd = [sys.executable, str(gate), "--profile", profile, "--json"]
    returncode, stdout, stderr, timed_out = run_with_tree_kill(cmd, timeout=timeout_seconds, cwd=str(root))
    if timed_out:
        return VerificationResult(status="error", method="gate", claim=claim,
                                  evidence={"reason": f"timed out after {timeout_seconds}s (process tree killed)"})
    verdict: dict[str, Any] | None = None
    for line in reversed((stdout + "\n" + stderr).strip().splitlines()):
        if line.startswith("GATE_RESULT "):
            try:
                verdict = json.loads(line[len("GATE_RESULT "):])
            except json.JSONDecodeError:
                pass
            break
    if verdict is None:
        return VerificationResult(status="error", method="gate", claim=claim,
                                  evidence={"reason": "no GATE_RESULT line in gate output",
                                            "stdout_tail": stdout[-1500:]},
                                  reproducibility=" ".join(cmd))
    return VerificationResult(
        status="pass" if returncode == 0 else "fail", method="composite-gate", claim=claim,
        evidence=verdict, artifact_paths=[verdict.get("log_dir", "")],
        reproducibility=" ".join(cmd),
    )


def run(profile: str = "default") -> VerificationResult:
    """Module entry point: run the composite verification gate."""
    return run_suite(profile)
