"""Supertrend indicator and trend-following strategy."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

from primequant.data.loader import (
    CANON_CLOSE,
    CANON_HIGH,
    CANON_LOW,
    CANON_TIME,
)
from primequant.strategy.base import SignalResult, Strategy


def compute_supertrend(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    period: int = 10,
    multiplier: float = 3.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute Supertrend indicator, upper/lower bands, and trend direction.

    Returns:
        (supertrend, upper_band, lower_band, trend) where trend is +1 (bullish) or -1 (bearish).
    """
    n = len(close)
    if n == 0:
        return np.array([]), np.array([]), np.array([])

    # Compute True Range
    prev_close = np.roll(close, 1)
    prev_close[0] = close[0]

    tr1 = high - low
    tr2 = np.abs(high - prev_close)
    tr3 = np.abs(low - prev_close)
    tr = np.maximum(tr1, np.maximum(tr2, tr3))

    # Compute ATR via rolling mean
    atr = np.zeros(n, dtype=np.float64)
    if n >= period:
        # Simple rolling mean initialization
        cumsum = np.cumsum(tr)
        atr[period - 1] = cumsum[period - 1] / period
        for i in range(period, n):
            # RMA (Wilder's smoothing)
            atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
        # Backfill initial bars
        atr[: period - 1] = atr[period - 1]
    else:
        atr[:] = np.mean(tr) if n > 0 else 0.0

    hl2 = (high + low) / 2.0
    basic_ub = hl2 + (multiplier * atr)
    basic_lb = hl2 - (multiplier * atr)

    final_ub = np.zeros(n, dtype=np.float64)
    final_lb = np.zeros(n, dtype=np.float64)
    trend = np.zeros(n, dtype=np.int32)

    final_ub[0] = basic_ub[0]
    final_lb[0] = basic_lb[0]
    trend[0] = 1

    for i in range(1, n):
        # Final Upper Band
        if basic_ub[i] < final_ub[i - 1] or close[i - 1] > final_ub[i - 1]:
            final_ub[i] = basic_ub[i]
        else:
            final_ub[i] = final_ub[i - 1]

        # Final Lower Band
        if basic_lb[i] > final_lb[i - 1] or close[i - 1] < final_lb[i - 1]:
            final_lb[i] = basic_lb[i]
        else:
            final_lb[i] = final_lb[i - 1]

        # Trend direction
        if trend[i - 1] == 1:
            if close[i] < final_lb[i]:
                trend[i] = -1
            else:
                trend[i] = 1
        else:
            if close[i] > final_ub[i]:
                trend[i] = 1
            else:
                trend[i] = -1

    supertrend = np.where(trend == 1, final_lb, final_ub)
    return supertrend, trend


@dataclass
class SupertrendStrategy(Strategy):
    """Supertrend ATR trailing band trend-following strategy.

    - Long (+1.0 lots) when price is above Supertrend band (trend = +1).
    - Short (-1.0 lots if allow_short=True, else 0.0) when price is below Supertrend band (trend = -1).
    """

    period: int = 10
    multiplier: float = 3.0
    allow_short: bool = False
    name: str = "supertrend"

    def prepare(self, df: pl.DataFrame) -> pl.DataFrame:
        high = df[CANON_HIGH].to_numpy()
        low = df[CANON_LOW].to_numpy()
        close = df[CANON_CLOSE].to_numpy()

        st, trend = compute_supertrend(
            high=high,
            low=low,
            close=close,
            period=self.period,
            multiplier=self.multiplier,
        )

        return df.with_columns(
            pl.Series("supertrend", st),
            pl.Series("supertrend_trend", trend),
        )

    def signals(self, df: pl.DataFrame) -> SignalResult:
        prepared = self.prepare(df)
        if self.allow_short:
            target = (
                pl.when(pl.col("supertrend_trend") == 1)
                .then(1.0)
                .when(pl.col("supertrend_trend") == -1)
                .then(-1.0)
                .otherwise(0.0)
            )
        else:
            target = (
                pl.when(pl.col("supertrend_trend") == 1)
                .then(1.0)
                .otherwise(0.0)
            )

        out = prepared.with_columns(target.alias("target_lots"))
        return SignalResult(df=out.select(CANON_TIME, "target_lots"))
