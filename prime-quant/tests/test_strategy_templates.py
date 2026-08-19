"""Tests for strategy templates (EMA and Supertrend)."""

from __future__ import annotations

import polars as pl
import pytest

from primequant.backtest.engine import run_backtest
from primequant.data.loader import CANON_TIME
from primequant.strategy import (
    EMAStrategy,
    FixedLotSizer,
    SupertrendStrategy,
)
from primequant.validate.ast_linter import lint_strategy_cls
from tests._fxdata import synthetic_fx


@pytest.fixture
def ohlcv_df() -> pl.DataFrame:
    return synthetic_fx(n_bars=250, seed=123)


class TestEMAStrategy:
    def test_ema_signals_shape_and_columns(self, ohlcv_df: pl.DataFrame) -> None:
        strat = EMAStrategy(fast=10, slow=25)
        res = strat.signals(ohlcv_df)

        assert res.df.height == ohlcv_df.height
        assert res.df.columns == [CANON_TIME, "target_lots"]
        assert res.positions().dtype == pl.Float64
        unique_pos = set(res.positions().unique().to_list())
        assert unique_pos.issubset({0.0, 1.0})

    def test_ema_allow_short(self, ohlcv_df: pl.DataFrame) -> None:
        strat = EMAStrategy(fast=10, slow=25, allow_short=True)
        res = strat.signals(ohlcv_df)

        unique_pos = set(res.positions().unique().to_list())
        assert unique_pos.issubset({-1.0, 0.0, 1.0})

    def test_ema_ast_lint_clean(self) -> None:
        lint_res = lint_strategy_cls(EMAStrategy)
        assert lint_res.ok
        assert not lint_res.has_errors
        assert lint_res.to_summary()["error_count"] == 0

    def test_ema_backtest_execution(self, ohlcv_df: pl.DataFrame) -> None:
        strat = EMAStrategy(fast=10, slow=25)
        bt = run_backtest(ohlcv_df, strat, sizer=FixedLotSizer(lots=1.0))

        assert len(bt.equity) == ohlcv_df.height
        assert bt.n_bars == ohlcv_df.height
        summary = bt.to_summary()
        assert isinstance(summary["sharpe"], float)


class TestSupertrendStrategy:
    def test_supertrend_signals_shape_and_columns(self, ohlcv_df: pl.DataFrame) -> None:
        strat = SupertrendStrategy(period=10, multiplier=3.0)
        res = strat.signals(ohlcv_df)

        assert res.df.height == ohlcv_df.height
        assert res.df.columns == [CANON_TIME, "target_lots"]
        assert res.positions().dtype == pl.Float64
        unique_pos = set(res.positions().unique().to_list())
        assert unique_pos.issubset({0.0, 1.0})

    def test_supertrend_allow_short(self, ohlcv_df: pl.DataFrame) -> None:
        strat = SupertrendStrategy(period=10, multiplier=3.0, allow_short=True)
        res = strat.signals(ohlcv_df)

        unique_pos = set(res.positions().unique().to_list())
        assert unique_pos.issubset({-1.0, 0.0, 1.0})

    def test_supertrend_ast_lint_clean(self) -> None:
        lint_res = lint_strategy_cls(SupertrendStrategy)
        assert lint_res.ok
        assert not lint_res.has_errors
        assert lint_res.to_summary()["error_count"] == 0

    def test_supertrend_backtest_execution(self, ohlcv_df: pl.DataFrame) -> None:
        strat = SupertrendStrategy(period=10, multiplier=3.0)
        bt = run_backtest(ohlcv_df, strat, sizer=FixedLotSizer(lots=1.0))

        assert len(bt.equity) == ohlcv_df.height
        assert bt.n_bars == ohlcv_df.height
        summary = bt.to_summary()
        assert isinstance(summary["sharpe"], float)
