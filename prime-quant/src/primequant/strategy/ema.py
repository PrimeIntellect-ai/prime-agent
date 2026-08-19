"""Exponential Moving Average (EMA) crossover strategy."""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl

from primequant.data.loader import CANON_CLOSE, CANON_TIME
from primequant.strategy.base import SignalResult, Strategy


@dataclass
class EMAStrategy(Strategy):
    """Exponential Moving Average (EMA) crossover strategy.

    Computes fast and slow EMAs on canonical close price:
    - When fast EMA > slow EMA: long signal (+1.0 target lots).
    - When fast EMA < slow EMA: short signal (-1.0 target lots if allow_short=True, else 0.0).
    """

    fast: int = 12
    slow: int = 26
    allow_short: bool = False
    name: str = "ema_cross"

    def prepare(self, df: pl.DataFrame) -> pl.DataFrame:
        return df.with_columns(
            pl.col(CANON_CLOSE).ewm_mean(span=self.fast, adjust=False).alias("ema_fast"),
            pl.col(CANON_CLOSE).ewm_mean(span=self.slow, adjust=False).alias("ema_slow"),
        )

    def signals(self, df: pl.DataFrame) -> SignalResult:
        prepared = self.prepare(df)
        if self.allow_short:
            target = (
                pl.when(pl.col("ema_fast") > pl.col("ema_slow"))
                .then(1.0)
                .when(pl.col("ema_fast") < pl.col("ema_slow"))
                .then(-1.0)
                .otherwise(0.0)
            )
        else:
            target = (
                pl.when(pl.col("ema_fast") > pl.col("ema_slow"))
                .then(1.0)
                .otherwise(0.0)
            )
        out = prepared.with_columns(target.alias("target_lots"))
        return SignalResult(df=out.select(CANON_TIME, "target_lots"))
