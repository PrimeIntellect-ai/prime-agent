"""Example symbolic invariants that pass on a fresh harness install.

Replace these demonstrations with invariants of the target scientific code.
"""

from __future__ import annotations

import sympy as sp


def test_quarter_turn_preserves_quadratic_norm() -> None:
    x, y = sp.symbols("x y", real=True)
    transformed = (-y) ** 2 + x**2
    assert sp.simplify(transformed - (x**2 + y**2)) == 0


def test_sqrt_square_uses_absolute_value_for_real_inputs() -> None:
    x = sp.symbols("x", real=True)
    assert sp.simplify(sp.sqrt(x**2) - sp.Abs(x)) == 0
