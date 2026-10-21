//! The bench harness: the scenario set, the options, and the result types
//! (the unix-only runner lives in `runner`/`pty`).

use std::path::PathBuf;

use clap::ValueEnum;
use serde::{Deserialize, Serialize};

/// The measured scenario set. Each is timed from a triggering action to an
/// observable needle — literal paints as byte needles, cell-diffed content
/// through the vt100 screen model; the deadline only fails a broken run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Scenario {
    /// No daemon, cold corpus: exec -> the chat surface's first paint.
    ColdStart,
    /// The same launch as cold-start, timed to the attach: exec -> the
    /// tray's session-usage pill (the first content the surface can only
    /// paint once the daemon session is attached).
    ColdReady,
    /// Daemon pre-started, warm corpus: exec -> the first paint.
    WarmStart,
    /// The warm launch timed to the attach pill.
    WarmReady,
    /// Fresh daemon+TUI: left-arrow -> the settled first catalog page.
    AgentsView,
    /// The same daemon's second populate (its in-process scan cache warm):
    /// a second TUI's left-arrow -> the settled first catalog page.
    AgentsViewWarm,
    /// Fresh daemon: `--resume <huge session>` -> the huge marker paints.
    OpenSession,
    /// On session A: agents view -> uniquely filter to B -> enter -> B's
    /// transcript marker.
    SessionSwitch,
    /// The `@` keystroke -> the first completion menu row.
    AtCompletion,
}

/// Every bench knob for one scenario over one corpus.
#[derive(Debug, Clone)]
pub struct BenchOptions {
    /// The release binary under test (`target/release/prime-agent`).
    pub binary: PathBuf,
    /// The corpus root (holds `corpus.json`).
    pub corpus: PathBuf,
    pub scenario: Scenario,
    /// Sampled runs (one discarded warm-up always runs before them).
    pub runs: usize,
    /// Where the result JSON is written.
    pub json: PathBuf,
    /// The per-run liveness deadline (seconds) — a broken run fails
    /// instead of hanging.
    pub liveness_secs: u64,
}

/// The whole-suite driver: generates the cold and warm corpora, runs every
/// scenario on the corpus state it needs (cold scenarios on `--cache
/// cold`, warm-* on `--cache warm`), and writes one result JSON per
/// scenario.
#[derive(Debug, Clone)]
pub struct RunOptions {
    /// The release binary under test.
    pub binary: PathBuf,
    /// The named corpus profile.
    pub profile: crate::corpus::Profile,
    /// The output root: the two corpora and `results/` land under it.
    pub out: PathBuf,
    /// The deterministic seed.
    pub seed: u64,
    /// Sampled runs per scenario (one discarded warm-up always runs first).
    pub runs: usize,
    /// The per-run liveness deadline (seconds).
    pub liveness_secs: u64,
}

/// The measured outcome of one scenario over one corpus.
#[derive(Debug, Serialize, Deserialize)]
pub struct BenchResult {
    pub schema: u32,
    pub scenario: Scenario,
    pub profile: String,
    pub runs: usize,
    pub samples_ms: Vec<f64>,
    pub median_ms: f64,
    pub p95_ms: f64,
    pub needle: String,
    pub binary: String,
    pub corpus: BenchCorpus,
}

/// The corpus summary the result records (baseline keys use scenario/profile).
#[derive(Debug, Serialize, Deserialize)]
pub struct BenchCorpus {
    pub root: PathBuf,
    pub sessions: usize,
    pub total_rows: usize,
    pub child_sessions: usize,
    pub archive: usize,
}

/// Run one scenario over one corpus (`options.runs` sampled runs plus one
/// discarded warm-up), then write the result JSON.
///
/// # Errors
///
/// Propagates spawn, needle-timeout, daemon, and IO failures; errors
/// immediately on non-unix platforms.
#[cfg(unix)]
pub fn run(options: &BenchOptions) -> anyhow::Result<BenchResult> {
    runner::run(options)
}

/// Run the whole scenario suite on freshly generated corpora (`RunOptions`).
///
/// # Errors
///
/// Propagates corpus-generation, spawn, needle-timeout, daemon, and IO
/// failures; errors immediately on non-unix platforms.
#[cfg(unix)]
pub fn run_suite(options: &RunOptions) -> anyhow::Result<Vec<BenchResult>> {
    runner::run_suite(options)
}

#[cfg(not(unix))]
pub fn run(_options: &BenchOptions) -> anyhow::Result<BenchResult> {
    anyhow::bail!("the bench harness is unix-only")
}

#[cfg(not(unix))]
pub fn run_suite(_options: &RunOptions) -> anyhow::Result<Vec<BenchResult>> {
    anyhow::bail!("the bench harness is unix-only")
}

#[cfg(unix)]
mod pty;
/// The unix-only harness (pty, daemon lifecycle, scenario runners).
#[cfg(unix)]
mod runner;
