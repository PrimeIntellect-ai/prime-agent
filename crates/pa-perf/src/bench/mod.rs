//! The bench harness: the scenario set, the options, and the result types
//! (the unix-only runner lives in `runner`/`pty`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The measured scenario set. Each is timed from a triggering action to an
/// observable content needle (event-driven; the deadline only fails a
/// broken run).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scenario {
    /// No daemon, cold corpus: exec -> the chat surface's first paint.
    ColdStart,
    /// Daemon pre-started, warm corpus: exec -> the first paint.
    WarmStart,
    /// Fresh daemon+TUI: left-arrow -> the agents view's completed roster
    /// (`Inactive (N)` heading with the manifest's exact count).
    AgentsView,
    /// The same daemon's second populate (the process-cache-warm scan):
    /// a second TUI's left-arrow -> the completed roster.
    AgentsViewWarm,
    /// Fresh daemon: `--resume <huge session>` -> the huge marker paints.
    OpenSession,
    /// On session A: agents view -> filter to B -> enter -> B's marker.
    SessionSwitch,
    /// The `@` file completion over the project tree: `@` -> the marker
    /// file's menu row.
    AtCompletion,
}

impl Scenario {
    /// Parse the CLI name.
    ///
    /// # Errors
    ///
    /// Errors on an unknown scenario name.
    pub fn parse(name: &str) -> anyhow::Result<Self> {
        match name {
            "cold-start" => Ok(Self::ColdStart),
            "warm-start" => Ok(Self::WarmStart),
            "agents-view" => Ok(Self::AgentsView),
            "agents-view-warm" => Ok(Self::AgentsViewWarm),
            "open-session" => Ok(Self::OpenSession),
            "session-switch" => Ok(Self::SessionSwitch),
            "at-completion" => Ok(Self::AtCompletion),
            other => anyhow::bail!("unknown scenario {other:?}"),
        }
    }
}

/// Every bench knob.
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
    /// When set, the raw pty stream of the LAST run lands here (needle
    /// debugging).
    pub debug_stream: Option<PathBuf>,
    /// Needle-discovery aid: keep pumping the pty this many ms after the
    /// needle (the debug stream then shows the later frames).
    pub settle_ms: u64,
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

/// Run the scenario `options.runs` times (plus one discarded warm-up), then
/// write the result JSON.
///
/// # Errors
///
/// Propagates spawn, needle-timeout, daemon, and IO failures; errors
/// immediately on non-unix platforms.
#[cfg(unix)]
pub fn run(options: &BenchOptions) -> anyhow::Result<BenchResult> {
    runner::run(options)
}

/// The bench is unix-only (the pty harness); non-unix callers get a clear
/// error instead of a compile break.
#[cfg(not(unix))]
pub fn run(_options: &BenchOptions) -> anyhow::Result<BenchResult> {
    anyhow::bail!("the bench harness is unix-only")
}

#[cfg(unix)]
mod pty;
/// The unix-only harness (pty, daemon lifecycle, scenario runners).
#[cfg(unix)]
mod runner;
