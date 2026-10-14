//! The `pa-perf` CLI: `corpus`, `bench`, and `report`.

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use pa_perf::bench::{BenchOptions, Scenario};
use pa_perf::corpus::{self, CacheMode, CorpusOptions, Profile};
use pa_perf::report::{self, Baseline};

#[derive(Parser)]
#[command(name = "pa-perf", about = "prime-agent performance tooling", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate a deterministic corpus under an isolated agent dir.
    Corpus(CorpusArgs),
    /// Drive the real release binary under a pty and measure a scenario.
    Bench(BenchArgs),
    /// Compare result JSONs against the baseline; fail on >2x regressions.
    Report(ReportArgs),
}

#[derive(clap::Args)]
struct CorpusArgs {
    /// The named profile providing the default knob values.
    #[arg(long, default_value = "small")]
    profile: String,
    /// The corpus root: created, then canonicalized (macOS /tmp -> /private/tmp).
    #[arg(long)]
    out: PathBuf,
    /// The deterministic seed.
    #[arg(long, default_value_t = 7)]
    seed: u64,
    /// Top-level sessions in the sessions dir.
    #[arg(long)]
    sessions: Option<usize>,
    /// Rows per session.
    #[arg(long)]
    rows: Option<usize>,
    /// Rows per subagent child session.
    #[arg(long)]
    child_rows: Option<usize>,
    /// Rows of the one huge session.
    #[arg(long)]
    huge_rows: Option<usize>,
    /// Subagent children per parent per level.
    #[arg(long)]
    fanout: Option<usize>,
    /// Subagent tree depth.
    #[arg(long)]
    depth: Option<u32>,
    /// How many sessions grow a subagent tree.
    #[arg(long)]
    tree_parents: Option<usize>,
    /// One parent grows this many direct children (0 disables).
    #[arg(long)]
    wide_children: Option<usize>,
    /// Sessions in sessions-archive/.
    #[arg(long)]
    archive: Option<usize>,
    /// Files in the generated project dir.
    #[arg(long)]
    cwd_files: Option<usize>,
    /// Write the per-session artifact partitions (on|off).
    #[arg(long, default_value = "on")]
    artifacts: String,
    /// Run the product's window-store open over the session files,
    /// writing their window-cache sidecars (warm|cold).
    #[arg(long, default_value = "cold")]
    cache: String,
}

#[derive(clap::Args)]
struct BenchArgs {
    /// The release binary under test.
    #[arg(long, default_value = "target/release/prime-agent")]
    binary: PathBuf,
    /// The corpus root (holds corpus.json).
    #[arg(long)]
    corpus: PathBuf,
    /// The scenario to measure.
    #[arg(long)]
    scenario: String,
    /// Sampled runs (a warm-up run is always discarded first).
    #[arg(long, default_value_t = 10)]
    runs: usize,
    /// Where the result JSON is written.
    #[arg(long)]
    json: PathBuf,
    /// The per-run liveness deadline (seconds).
    #[arg(long, default_value_t = 180)]
    liveness_secs: u64,
    /// Dump the raw pty stream of the last run here (needle debugging).
    #[arg(long)]
    debug_stream: Option<PathBuf>,
    /// Keep pumping the pty this many ms after the needle (needle
    /// discovery: the debug stream then shows the later frames).
    #[arg(long, default_value_t = 0)]
    settle_ms: u64,
}

#[derive(clap::Args)]
struct ReportArgs {
    /// One or more bench result JSONs.
    #[arg(long, num_args = 1..)]
    results: Vec<PathBuf>,
    /// The committed baseline file.
    #[arg(long, default_value = "crates/pa-perf/baseline.json")]
    baseline: PathBuf,
    /// Where the markdown table is written (stdout when absent).
    #[arg(long)]
    markdown: Option<PathBuf>,
}

fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Corpus(args) => corpus_command(args),
        Command::Bench(args) => bench_command(args),
        Command::Report(args) => report_command(args),
    }
}

fn corpus_command(args: CorpusArgs) -> anyhow::Result<()> {
    let profile = profile_of(&args.profile)?;
    let mut options = CorpusOptions {
        out: args.out.clone(),
        ..profile.defaults()
    };
    options.seed = args.seed;
    if let Some(value) = args.sessions {
        options.sessions = value;
    }
    if let Some(value) = args.rows {
        options.rows = value;
    }
    if let Some(value) = args.child_rows {
        options.child_rows = value;
    }
    if let Some(value) = args.huge_rows {
        options.huge_rows = value;
    }
    if let Some(value) = args.fanout {
        options.fanout = value;
    }
    if let Some(value) = args.depth {
        options.depth = value;
    }
    if let Some(value) = args.tree_parents {
        options.tree_parents = value;
    }
    if let Some(value) = args.wide_children {
        options.wide_children = value;
    }
    if let Some(value) = args.archive {
        options.archive = value;
    }
    if let Some(value) = args.cwd_files {
        options.cwd_files = value;
    }
    options.artifacts = match args.artifacts.as_str() {
        "on" => true,
        "off" => false,
        other => anyhow::bail!("unknown artifacts mode {other:?} (on|off)"),
    };
    options.cache = match args.cache.as_str() {
        "cold" => CacheMode::Cold,
        "warm" => CacheMode::Warm,
        other => anyhow::bail!("unknown cache mode {other:?} (cold|warm)"),
    };
    let manifest = corpus::generate(&options)?;
    println!(
        "corpus: profile={} sessions={} rows={} total_rows={} child_sessions={} archive={} cache={}",
        args.profile,
        manifest.counts.sessions,
        options.rows,
        manifest.counts.total_rows,
        manifest.counts.child_sessions,
        manifest.counts.archive,
        match options.cache {
            CacheMode::Cold => "cold",
            CacheMode::Warm => "warm",
        },
    );
    println!("huge needle: {}", manifest.markers.huge.needle);
    println!("manifest: {}", manifest.paths.manifest_file.display());
    Ok(())
}

fn bench_command(args: BenchArgs) -> anyhow::Result<()> {
    let options = BenchOptions {
        binary: args.binary,
        corpus: args.corpus,
        scenario: Scenario::parse(&args.scenario)?,
        runs: args.runs,
        json: args.json,
        liveness_secs: args.liveness_secs,
        debug_stream: args.debug_stream,
        settle_ms: args.settle_ms,
    };
    let result = pa_perf::bench::run(&options)?;
    println!(
        "scenario={} profile={} median={:.1}ms p95={:.1}ms runs={}",
        pa_perf::report::key_of(result.scenario),
        result.profile,
        result.median_ms,
        result.p95_ms,
        result.runs,
    );
    Ok(())
}

fn report_command(args: ReportArgs) -> anyhow::Result<()> {
    let mut results = Vec::new();
    for path in &args.results {
        let result: pa_perf::bench::BenchResult =
            serde_json::from_str(&std::fs::read_to_string(path)?)?;
        results.push(result);
    }
    let baseline: Baseline = serde_json::from_str(&std::fs::read_to_string(&args.baseline)?)?;
    let report = report::report(&results, &baseline);
    match &args.markdown {
        Some(path) => std::fs::write(path, &report.markdown)?,
        None => println!("{}", report.markdown),
    }
    if report.regressions.is_empty() {
        println!("no >2x regressions against the baseline");
        Ok(())
    } else {
        anyhow::bail!("regressions over 2x: {}", report.regressions.join(", "));
    }
}

fn profile_of(name: &str) -> anyhow::Result<Profile> {
    match name {
        "small" => Ok(Profile::Small),
        "medium" => Ok(Profile::Medium),
        "large" => Ok(Profile::Large),
        "xl" => Ok(Profile::Xl),
        other => anyhow::bail!("unknown profile {other:?} (small|medium|large|xl)"),
    }
}
