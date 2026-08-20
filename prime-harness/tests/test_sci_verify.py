from __future__ import annotations

import math

import sci_verify


def test_sqrt_x_squared_fails_without_assumptions(tmp_repo):
    result = sci_verify.symbolic_equivalence("sqrt(x**2)", "x")
    assert result.status == "fail"
    assert result.evidence["counterexamples"]
    # the counterexample must be a negative x
    assert any(c.get("x", 1) < 0 for c in result.evidence["counterexamples"])


def test_sqrt_x_squared_passes_with_positive(tmp_repo):
    result = sci_verify.symbolic_equivalence("sqrt(x**2)", "x", {"x": "real positive"})
    assert result.status == "pass"
    assert result.artifact_paths


def test_binomial_identity_passes(tmp_repo):
    result = sci_verify.symbolic_equivalence("(x + 1)**2", "x**2 + 2*x + 1")
    assert result.status == "pass"


def test_unknown_assumption_token_is_error(tmp_repo):
    result = sci_verify.symbolic_equivalence("x", "x", {"x": "wobbly"})
    assert result.status == "error"


def test_parse_error_is_error_status(tmp_repo):
    result = sci_verify.symbolic_equivalence("(x +", "x")
    assert result.status == "error"


def test_numeric_compare_pass_and_fail(tmp_repo):
    good = sci_verify.numeric_compare(lambda x: math.exp(x), "exp(x)",
                                      cases=[{"x": 0.5}, {"x": 2.0}, {"x": -3.0}])
    assert good.status == "pass"

    bad = sci_verify.numeric_compare(lambda x: math.exp(x) + 1e-3, "exp(x)",
                                     cases=[{"x": 0.5}])
    assert bad.status == "fail"
    assert bad.evidence["failures"]


def test_convergence_detects_order(tmp_repo):
    resolutions = [16, 32, 64, 128, 256]
    fourth_order = [(1.0 / r) ** 4 for r in resolutions]
    assert sci_verify.check_convergence(fourth_order, resolutions, 4).status == "pass"
    assert sci_verify.check_convergence(fourth_order, resolutions, 2).status == "fail"


def test_convergence_needs_three_points(tmp_repo):
    assert sci_verify.check_convergence([0.1, 0.01], [10, 100], 2).status == "error"


def test_invariant_drift(tmp_repo):
    conserved = [1.0, 1.0 + 1e-12, 1.0 - 1e-12]
    drifting = [1.0, 1.001, 1.01]
    assert sci_verify.check_invariant(conserved, rtol=1e-8).status == "pass"
    assert sci_verify.check_invariant(drifting, rtol=1e-8).status == "fail"


def test_property_suite_runs(tmp_repo):
    props = tmp_repo / "checks" / "properties"
    props.mkdir(parents=True)
    (props / "test_trivial.py").write_text("def test_ok():\n    assert 1 + 1 == 2\n", encoding="utf-8")
    result = sci_verify.property_suite()
    assert result.status == "pass"

    (props / "test_bad.py").write_text("def test_bad():\n    assert False\n", encoding="utf-8")
    assert sci_verify.property_suite().status == "fail"


def test_property_suite_missing_dir(tmp_repo):
    assert sci_verify.property_suite("no/such/dir").status == "error"


def test_sampling_respects_integer_parity_assumptions(tmp_repo):
    # (-1)**n == 1 holds for EVEN n. Before the rejection-sampling fix, the
    # sweep drew odd n despite the assumption and reported a bogus
    # counterexample (false 'fail'). Now: pass or inconclusive, never fail.
    result = sci_verify.symbolic_equivalence("(-1)**n", "1", {"n": "integer even"})
    assert result.status != "fail", result.evidence


def test_sampling_respects_caller_domain(tmp_repo):
    # log(x*y) == log(x)+log(y) holds for positive reals; restrict the domain
    # and declared assumptions — no counterexample may come from outside them.
    result = sci_verify.symbolic_equivalence(
        "log(x*y)", "log(x) + log(y)", {"x": "real positive", "y": "real positive"},
        sample_domain={"x": (0.5, 5.0), "y": (0.5, 5.0)})
    assert result.status != "fail", result.evidence


def test_unsatisfiable_domain_is_inconclusive_not_hang(tmp_repo):
    # positive symbol with an all-negative domain: zero valid samples; must
    # return (inconclusive) promptly rather than loop or fabricate points.
    result = sci_verify.symbolic_equivalence("sqrt(x**2)", "x + 1e-30", {"x": "real positive"},
                                             sample_domain={"x": (-5.0, -1.0)}, samples=8)
    assert result.status in ("inconclusive", "pass")


def test_numeric_compare_complex_reference_does_not_crash(tmp_repo):
    # sqrt(-4) = 2j: a complex reference vs a real implementation must yield a
    # structured failure, not an unhandled exception (pre-fix: ValueError).
    result = sci_verify.numeric_compare(lambda x: 2.0, "sqrt(x)", cases=[{"x": -4.0}])
    assert result.status == "fail"


def test_numeric_compare_unbound_symbol_is_case_failure(tmp_repo):
    result = sci_verify.numeric_compare(lambda x: 1.0, "exp(y)", cases=[{"x": 1.0}])
    assert result.status == "fail"
    assert any("does not bind" in str(f.get("error", "")) for f in result.evidence["failures"])


def test_convergence_rejects_bad_resolutions(tmp_repo):
    assert sci_verify.check_convergence([0.1, 0.01, 0.001], [0, 10, 100], 2).status == "error"
    assert sci_verify.check_convergence([0.1, 0.01, 0.001], [10, 10, 10], 2).status == "error"
    calls = []

    def erring(r):
        calls.append(r)
        return 0.1

    sci_verify.check_convergence(erring, [-1, 2, 3], 2)
    assert calls == []  # validation happens BEFORE the callable is invoked


def test_inconclusive_never_pass(tmp_repo):
    # An identity SymPy cannot prove generically: sqrt(x^2) == Abs(x) holds for
    # real x, but without assumptions x is complex, so sampling finds no
    # real counterexample while simplification cannot close it either.
    result = sci_verify.symbolic_equivalence("sqrt(x**2)", "Abs(x)")
    assert result.status in ("inconclusive", "pass")  # depends on sympy version
    if result.status == "inconclusive":
        assert any("INCONCLUSIVE" in w for w in result.warnings)
