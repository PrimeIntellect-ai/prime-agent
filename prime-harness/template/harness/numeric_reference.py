"""Shared high-precision Decimal reference functions for harness scorers.

This module is stdlib-only and contains no response parsing, policy thresholds,
or report logic. Replay and measured model routing intentionally remain separate
pipelines while importing the same cancellation-sensitive reference.
"""

from __future__ import annotations

from decimal import Decimal, localcontext
from typing import Any


def decimal_expm1(value: Any, precision: int) -> Decimal:
    """Return cancellation-safe ``exp(value) - 1`` at Decimal precision."""
    if type(precision) is not int or not 2 <= precision <= 10_000:
        raise ValueError("precision must be an integer from 2 through 10000")
    argument = Decimal(str(value))
    if not argument.is_finite():
        raise ValueError("value must be finite")
    if argument.is_zero():
        return argument

    guard_digits = 12
    with localcontext() as work:
        work.prec = precision + guard_digits
        if abs(argument) <= Decimal("0.5"):
            # Direct exp()-1 first rounds exp(x) to 1 for tiny nonzero x. The
            # Taylor recurrence never forms that subtraction and preserves the
            # leading term at any representable exponent.
            term = argument
            total = argument
            for order in range(2, 4 * work.prec + 2):
                term = term * argument / Decimal(order)
                updated = total + term
                if updated == total:
                    break
                total = updated
            else:
                raise ArithmeticError("expm1 Taylor series did not converge")
        else:
            total = argument.exp(work) - Decimal(1)

    with localcontext() as result_context:
        result_context.prec = precision
        return +total
