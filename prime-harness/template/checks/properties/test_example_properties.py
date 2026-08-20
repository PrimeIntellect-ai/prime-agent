"""Example property tests — REPLACE with properties of your own code.

These demonstrate the patterns this project expects:
- Hypothesis generates and shrinks edge cases; seeds are managed by pytest
  (use `--hypothesis-seed=<n>` to reproduce, or rely on the failure blob).
- Properties assert *relations* (round-trips, invariances, metamorphic
  relations), not single hand-picked values.

The examples import only pytest + hypothesis (no project code), so the gate
passes on a fresh install once those are installed in the gate interpreter
(harness/doctor.py checks this).
"""

from __future__ import annotations

import math

from hypothesis import given, settings
from hypothesis import strategies as st

finite_floats = st.floats(allow_nan=False, allow_infinity=False, width=64)


def kahan_sum(values: list[float]) -> float:
    """Compensated summation — the kind of numerical kernel worth testing."""
    total = 0.0
    compensation = 0.0
    for value in values:
        y = value - compensation
        t = total + y
        compensation = (t - total) - y
        total = t
    return total


@settings(max_examples=200, deadline=None)
@given(st.lists(st.floats(min_value=-1e6, max_value=1e6), max_size=200))
def test_kahan_sum_matches_exact_sum(values: list[float]) -> None:
    exact = float(math.fsum(values))
    approx = kahan_sum(values)
    scale = 1.0 + abs(exact)
    assert abs(approx - exact) <= 1e-9 * scale


@settings(max_examples=200, deadline=None)
@given(st.lists(finite_floats.filter(lambda x: abs(x) < 1e100), max_size=100))
def test_sum_is_permutation_invariant_under_fsum(values: list[float]) -> None:
    # Metamorphic relation: exact summation must not depend on order.
    assert math.fsum(values) == math.fsum(list(reversed(values)))


safe_sqrt_square_floats = st.one_of(
    st.just(0.0),
    st.floats(min_value=1e-150, max_value=1e150, allow_nan=False, allow_infinity=False),
    st.floats(min_value=-1e150, max_value=-1e-150, allow_nan=False, allow_infinity=False),
)


@settings(max_examples=200, deadline=None)
@given(safe_sqrt_square_floats)
def test_sqrt_of_square_is_abs(x: float) -> None:
    # The classic assumption trap, stated correctly: sqrt(x^2) == |x|, not x.
    # Bound the domain so x*x neither underflows nor overflows in binary64;
    # otherwise the test would conflate this identity with floating-point range.
    assert math.isclose(math.sqrt(x * x), abs(x), rel_tol=1e-12)
