"""Shared high-precision Decimal reference functions for harness scorers.

This module is stdlib-only and contains no response parsing, policy thresholds,
or report logic. Replay and measured model routing intentionally remain separate
pipelines while importing the same cancellation-sensitive reference.
"""

from __future__ import annotations

from decimal import Decimal, localcontext
from typing import Any


def decimal_expm1(value: Any, precision: int) -> Decimal:
    """Return ``exp(value) - 1`` under an explicit Decimal precision."""
    if type(precision) is not int or not 2 <= precision <= 10_000:
        raise ValueError("precision must be an integer from 2 through 10000")
    with localcontext() as context:
        context.prec = precision
        return Decimal(str(value)).exp(context) - Decimal(1)
