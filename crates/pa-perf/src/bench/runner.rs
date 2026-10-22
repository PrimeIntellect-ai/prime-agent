//! The scenario runner: pty harness, daemon lifecycle, per-run corpus
//! restore, and the scenario mechanics. Unix-only.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Context;

use crate::bench::{BenchCorpus, BenchOptions, BenchResult, RunOptions, Scenario};
use crate::corpus::{self, CacheMode, CorpusOptions, Manifest};

use super::pty::{kitty_keystrokes, PtyChild};

/// The first paint's needle: the brand splash is the empty chat's header
/// (the corpus settings keep the TUI out of the first-run flow). Pinned
/// empirically against the real binary.
const FIRST_PAINT_NEEDLE: &[u8] = "▗▄▄█▀".as_bytes();

/// The ready needle: the tray's session-usage pill ("model · tokens
/// (percent)") — the first content the chat surface can only paint once
/// the daemon session is attached. A fresh session's usage is always
/// "0 (0%)".
const READY_NEEDLE: &str = "0 (0%)";

/// Repeated z characters distinguish editor input from corpus and chrome.
const EDITOR_PAYLOAD: &str = "zzzzzzzzzz";

/// One bench run's anchored paths.
struct RunCtx {
    binary: PathBuf,
    manifest: Manifest,
    corpus_root: PathBuf,
    project_dir: PathBuf,
    agent_dir: PathBuf,
    liveness: Duration,
}

impl RunCtx {
    /// The manifest's agent dir paths, from the corpus at `root`.
    fn load(binary: &Path, corpus_root: &Path, liveness: Duration) -> anyhow::Result<Self> {
        let manifest_path = corpus_root.join("corpus.json");
        let manifest: Manifest = serde_json::from_str(
            &std::fs::read_to_string(&manifest_path)
                .with_context(|| format!("read {}", manifest_path.display()))?,
        )
        .with_context(|| format!("parse {}", manifest_path.display()))?;
        Ok(Self {
            // Spawns run in the generated project directory. Resolve the
            // caller's path before changing cwd (including `make perf`).
            binary: binary
                .canonicalize()
                .with_context(|| format!("resolve benchmark binary {}", binary.display()))?,
            project_dir: manifest.paths.project_dir.clone(),
            agent_dir: manifest.paths.agent_dir.clone(),
            corpus_root: corpus_root
                .canonicalize()
                .with_context(|| format!("resolve corpus root {}", corpus_root.display()))?,
            manifest,
            liveness,
        })
    }
}

/// The child environment: hermetic (a clean env plus the isolation vars).
fn child_env(ctx: &RunCtx) -> Vec<(String, String)> {
    let mut env = vec![
        (
            "PRIME_AGENT_CODING_AGENT_DIR".to_string(),
            ctx.agent_dir.display().to_string(),
        ),
        ("DO_NOT_TRACK".to_string(), "1".to_string()),
        ("TERM".to_string(), "xterm-ghostty".to_string()),
        ("TERM_PROGRAM".to_string(), "ghostty".to_string()),
    ];
    // Preserve the staged product runtime and offline policy in child processes.
    for carry in [
        "PATH",
        "HOME",
        "TMPDIR",
        "PI_PACKAGE_DIR",
        "PRIME_AGENT_KERNEL_PYTHON",
        "UV_OFFLINE",
    ] {
        if let Some(value) = std::env::var_os(carry) {
            env.push((carry.to_string(), value.to_string_lossy().to_string()));
        }
    }
    env
}

// The single-scenario entry (`pa-perf bench`): one scenario over the given
// corpus — the debugging/investigation path.

/// Run one scenario `options.runs` times (plus one discarded warm-up), then
/// write the result JSON.
///
/// # Errors
///
/// Propagates spawn, needle-timeout, daemon, and IO failures.
pub(super) fn run(options: &BenchOptions) -> anyhow::Result<BenchResult> {
    anyhow::ensure!(options.runs > 0, "sampled runs must be positive");
    let ctx = RunCtx::load(
        &options.binary,
        &options.corpus,
        Duration::from_secs(options.liveness_secs),
    )?;
    let samples = sample_runs(&ctx, options.runs, |index| {
        scenario_once(&ctx, options.scenario, index)
    })?;
    // All-or-nothing: every run sampled, or the platform refused.
    let samples_rss_bytes: Option<Vec<u64>> = samples.iter().map(|&(_, rss)| rss).collect();
    let samples_ms: Vec<f64> = samples.into_iter().map(|(ms, _)| ms).collect();
    let result = build_result(&ctx, options.scenario, samples_ms, samples_rss_bytes);
    write_result(&result, &options.json)?;
    Ok(result)
}

/// Restore the manifest baseline before every standalone launch, including
/// its discarded warm-up. The scenario callback keeps this loop testable
/// with filesystem mutations instead of running the product.
fn sample_runs(
    ctx: &RunCtx,
    runs: usize,
    mut scenario: impl FnMut(usize) -> anyhow::Result<(f64, Option<u64>)>,
) -> anyhow::Result<Vec<(f64, Option<u64>)>> {
    let mut samples = Vec::with_capacity(runs + 1);
    let total = runs + 1;
    for index in 0..total {
        restore(ctx)?;
        let started = Instant::now();
        let outcome = scenario(index);
        if index == 0 {
            outcome?;
            continue;
        }
        let (sample, rss) = outcome.context("a sampled run failed")?;
        samples.push((sample, rss));
        println!(
            "run {index}/{runs}: {sample:.1}ms (wall {:.1}s)",
            started.elapsed().as_secs_f32()
        );
    }
    Ok(samples)
}

/// Return latency and owned-tree RSS for one scenario.
fn scenario_once(
    ctx: &RunCtx,
    scenario: Scenario,
    run: usize,
) -> anyhow::Result<(f64, Option<u64>)> {
    let (sample, rss, _) = launch(ctx, scenario, run)?;
    Ok((sample, rss))
}

/// The ONE launch path: the pre-started daemon for warm-* scenarios, the
/// scenario's own resume target + first needle, the post-launch mechanics,
/// and the daemon teardown on every path. Both `run()` (single scenario)
/// and `run_suite()` call this.
fn launch(
    ctx: &RunCtx,
    scenario: Scenario,
    run: usize,
) -> anyhow::Result<(f64, Option<u64>, Launch)> {
    let socket = run_socket(ctx, run);
    std::fs::create_dir_all(socket.parent().expect("a socket dir"))?;
    let mut daemon = if matches!(
        scenario,
        Scenario::WarmStart | Scenario::WarmReady | Scenario::AgentsViewWarm
    ) {
        // AgentsViewWarm pre-starts so both TUIs share the daemon the first
        // populate warms; the single-scenario path cannot express that (its
        // second launch would spawn a second daemon), so it runs the first
        // populate only and the sample is the suite's warm number.
        Some(start_daemon(ctx, &socket)?)
    } else {
        None
    };
    let outcome: anyhow::Result<(f64, Option<u64>, Launch)> = (|| {
        let (mut launched, held) = spawn_for_scenario(ctx, &socket, scenario, run)?;
        let (sample, extra) = launch_scenario(ctx, &mut launched, scenario, held)?;
        // Sample owned processes before any client or daemon teardown.
        let rss = sample_rss(
            launched.child.pid(),
            extra.as_ref().map(|extra| extra.child.pid()),
            daemon.as_ref().map(|owned| owned.child.id() as i32),
        )?;
        // Disconnect clients before waiting for daemon shutdown.
        if let Some(mut extra) = extra {
            extra.completed = true;
            extra.child.finish();
        }
        launched.child.finish();
        Ok((sample, rss, launched))
    })();
    let stopped = stop_daemon(&socket);
    // Socket closure alone does not reap a daemon we directly spawned.
    // Keep ownership through shutdown, and fail before the guard's forced
    // cleanup if it does not exit normally.
    let exited = if let Some(daemon) = &mut daemon {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = daemon.child.try_wait()? {
                break if status.success() {
                    Ok(())
                } else {
                    Err(anyhow::anyhow!("the owned daemon exited with {status}"))
                };
            }
            if Instant::now() >= deadline {
                break Err(anyhow::anyhow!(
                    "the owned daemon did not exit after shutdown"
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    } else {
        Ok(())
    };
    let result = outcome?;
    stopped?;
    exited.with_context(|| format!("{scenario:?} run {run} daemon cleanup"))?;
    Ok(result)
}

/// Sample owned process-tree RSS from Linux procfs.
#[cfg(target_os = "linux")]
fn sample_rss(
    tui_pid: i32,
    held_pid: Option<i32>,
    daemon_pid: Option<i32>,
) -> anyhow::Result<Option<u64>> {
    super::rss::sample(tui_pid, held_pid, daemon_pid)
}

/// RSS is unavailable without Linux procfs.
#[cfg(not(target_os = "linux"))]
fn sample_rss(
    _tui_pid: i32,
    _held_pid: Option<i32>,
    _daemon_pid: Option<i32>,
) -> anyhow::Result<Option<u64>> {
    Ok(None)
}

// The whole-suite driver (`pa-perf run`): generates the cold and warm
// corpora and runs every scenario on the corpus state it needs.

/// Run the full scenario schedule on freshly generated corpora, writing one
/// result JSON per scenario under `<out>/results/`.
///
/// # Errors
///
/// Propagates corpus-generation, spawn, needle-timeout, daemon, and IO
/// failures.
pub(super) fn run_suite(options: &RunOptions) -> anyhow::Result<Vec<BenchResult>> {
    anyhow::ensure!(options.runs > 0, "sampled runs must be positive");
    let liveness = Duration::from_secs(options.liveness_secs);
    let knobs = || CorpusOptions {
        seed: options.seed,
        ..options.profile.defaults()
    };
    println!("=== generating the cold corpus");
    corpus::regenerate_for_suite(&CorpusOptions {
        out: options.out.join("corpus-cold"),
        ..knobs()
    })?;
    println!("=== generating the warm corpus");
    corpus::regenerate_for_suite(&CorpusOptions {
        out: options.out.join("corpus-warm"),
        cache: CacheMode::Warm,
        ..knobs()
    })?;
    let cold_ctx = RunCtx::load(&options.binary, &options.out.join("corpus-cold"), liveness)?;
    let warm_ctx = RunCtx::load(&options.binary, &options.out.join("corpus-warm"), liveness)?;

    let mut samples: BTreeMap<Scenario, Vec<f64>> = BTreeMap::new();
    let mut rss_samples: BTreeMap<Scenario, Vec<Option<u64>>> = BTreeMap::new();
    let total = options.runs + 1;
    for index in 0..total {
        let started = Instant::now();
        // The schedule: cold scenarios on the cold corpus, warm-* on the
        // warm corpus. `launch_cold`/`launch_warm` below run one scenario
        // per launch; the cold-start/cold-ready (and warm-*) pairs share
        // one launch each (and therefore its single RSS sample).
        restore(&cold_ctx)?;
        let (start_sample, start_rss, launched) = launch(&cold_ctx, Scenario::ColdStart, index)?;
        let ready_sample = launched
            .ready_ms
            .context("the cold launch never attached")?;
        push(
            &mut samples,
            &mut rss_samples,
            index,
            Scenario::ColdStart,
            start_sample,
            start_rss,
        );
        push(
            &mut samples,
            &mut rss_samples,
            index,
            Scenario::ColdReady,
            ready_sample,
            start_rss,
        );
        for scenario in [
            Scenario::AgentsView,
            Scenario::AgentsViewWarm,
            Scenario::OpenSession,
            Scenario::SessionSwitch,
            Scenario::AtCompletion,
            Scenario::EditorReady,
            Scenario::ConcurrentSession,
        ] {
            restore(&cold_ctx)?;
            let (sample, rss, _) = launch(&cold_ctx, scenario, index)?;
            push(&mut samples, &mut rss_samples, index, scenario, sample, rss);
        }
        restore(&warm_ctx)?;
        let (start_sample, start_rss, launched) = launch(&warm_ctx, Scenario::WarmStart, index)?;
        let ready_sample = launched
            .ready_ms
            .context("the warm launch never attached")?;
        push(
            &mut samples,
            &mut rss_samples,
            index,
            Scenario::WarmStart,
            start_sample,
            start_rss,
        );
        push(
            &mut samples,
            &mut rss_samples,
            index,
            Scenario::WarmReady,
            ready_sample,
            start_rss,
        );
        println!(
            "run {index}/{} complete ({:.1}s)",
            options.runs,
            started.elapsed().as_secs_f32()
        );
    }

    let results_dir = options.out.join("results");
    std::fs::create_dir_all(&results_dir)?;
    let mut results = Vec::new();
    for (scenario, samples) in samples {
        if samples.len() != options.runs {
            anyhow::bail!(
                "{scenario:?} collected {} samples, expected {}",
                samples.len(),
                options.runs
            );
        }
        let ctx = corpus_for(scenario, &cold_ctx, &warm_ctx);
        // Every sample pushed its RSS twin; all-or-nothing across the runs.
        let samples_rss_bytes: Option<Vec<u64>> = rss_samples
            .remove(&scenario)
            .expect("every sample carries its RSS twin")
            .into_iter()
            .collect();
        let result = build_result(ctx, scenario, samples, samples_rss_bytes);
        let name = crate::report::key_of(scenario);
        // Per-profile unique names: the CI legs merge their artifacts into
        // one results dir, and same-named files would overwrite each other.
        let profile = crate::report::profile_key(options.profile);
        write_result(&result, &results_dir.join(format!("{profile}-{name}.json")))?;
        println!(
            "scenario={name} profile={} median={:.1}ms p95={:.1}ms",
            crate::report::profile_key(options.profile),
            result.median_ms,
            result.p95_ms
        );
        results.push(result);
    }
    Ok(results)
}

/// Keep result provenance paired with the corpus used by the schedule.
fn corpus_for<'a>(scenario: Scenario, cold: &'a RunCtx, warm: &'a RunCtx) -> &'a RunCtx {
    match scenario {
        Scenario::WarmStart | Scenario::WarmReady => warm,
        Scenario::ColdStart
        | Scenario::ColdReady
        | Scenario::AgentsView
        | Scenario::AgentsViewWarm
        | Scenario::OpenSession
        | Scenario::SessionSwitch
        | Scenario::AtCompletion
        | Scenario::EditorReady
        | Scenario::ConcurrentSession => cold,
    }
}

/// Push a sample and its RSS twin unless this is the discarded warm-up run.
fn push(
    samples: &mut BTreeMap<Scenario, Vec<f64>>,
    rss_samples: &mut BTreeMap<Scenario, Vec<Option<u64>>>,
    index: usize,
    scenario: Scenario,
    sample: f64,
    rss: Option<u64>,
) {
    if index > 0 {
        samples.entry(scenario).or_default().push(sample);
        rss_samples.entry(scenario).or_default().push(rss);
    }
}

/// Spawn the measured TUI and any concurrently held peer.
fn spawn_for_scenario(
    ctx: &RunCtx,
    socket: &Path,
    scenario: Scenario,
    run: usize,
) -> anyhow::Result<(Launch, Option<Launch>)> {
    let (resume, first_needle) = match scenario {
        Scenario::OpenSession | Scenario::ConcurrentSession => (
            Some(ctx.manifest.markers.huge.file.clone()),
            ctx.manifest.markers.huge.needle.as_bytes().to_vec(),
        ),
        Scenario::SessionSwitch => (
            Some(ctx.manifest.markers.switch_a.file.clone()),
            ctx.manifest.markers.switch_a.needle.as_bytes().to_vec(),
        ),
        Scenario::ColdStart
        | Scenario::ColdReady
        | Scenario::WarmStart
        | Scenario::WarmReady
        | Scenario::AgentsView
        | Scenario::AgentsViewWarm
        | Scenario::AtCompletion
        | Scenario::EditorReady => (None, FIRST_PAINT_NEEDLE.to_vec()),
    };
    let dump = ctx
        .corpus_root
        .join("failed-streams")
        .join(format!("{}-run{run}.bin", crate::report::key_of(scenario)));
    if scenario == Scenario::ConcurrentSession {
        // Keep the existing client drained while timing the shared-daemon open.
        let held_dump = ctx.corpus_root.join("failed-streams").join(format!(
            "{}-held-run{run}.bin",
            crate::report::key_of(scenario)
        ));
        let mut held = Launch::spawn(
            ctx,
            socket,
            Some(&ctx.manifest.markers.switch_a.file),
            ctx.manifest.markers.switch_a.needle.as_bytes(),
            held_dump,
            None,
        )?;
        let launch = Launch::spawn(
            ctx,
            socket,
            resume.as_deref(),
            &first_needle,
            dump,
            Some(&mut held),
        )?;
        return Ok((launch, Some(held)));
    }
    let mut launch = Launch::spawn(ctx, socket, resume.as_deref(), &first_needle, dump, None)?;
    if matches!(
        scenario,
        Scenario::ColdStart | Scenario::WarmStart | Scenario::ColdReady | Scenario::WarmReady
    ) {
        launch.wait_ready()?;
    }
    Ok((launch, None))
}

/// Run the action and retain extra clients until RSS is sampled.
fn launch_scenario(
    ctx: &RunCtx,
    launch: &mut Launch,
    scenario: Scenario,
    held: Option<Launch>,
) -> anyhow::Result<(f64, Option<Launch>)> {
    let outcome = post_launch(ctx, launch, scenario, held)?;
    launch.completed = true;
    Ok(outcome)
}

/// The scenario mechanics after the launch needle.
fn post_launch(
    ctx: &RunCtx,
    launch: &mut Launch,
    scenario: Scenario,
    held: Option<Launch>,
) -> anyhow::Result<(f64, Option<Launch>)> {
    match scenario {
        Scenario::ColdStart
        | Scenario::WarmStart
        | Scenario::OpenSession
        | Scenario::ConcurrentSession => Ok((launch.first_ms, held)),
        Scenario::EditorReady => {
            launch.wait_ready()?;
            Ok((editor_echo_ack(ctx, &mut launch.child)?, held))
        }
        Scenario::AgentsView => Ok((agents_view_populate(ctx, &mut launch.child)?, None)),
        Scenario::AgentsViewWarm => {
            // The first populate warms the daemon's in-process scan cache;
            // the second TUI measures the warm path on the same daemon.
            agents_view_populate(ctx, &mut launch.child)?;
            let socket = launch.socket.clone();
            let dump = ctx
                .corpus_root
                .join("failed-streams")
                .join("agents-view-warm-second.bin");
            let mut second = Launch::spawn(ctx, &socket, None, FIRST_PAINT_NEEDLE, dump, None)?;
            let sample = agents_view_populate(ctx, &mut second.child)?;
            Ok((sample, Some(second)))
        }
        Scenario::SessionSwitch => Ok((switch_to_target_b(ctx, &mut launch.child)?, None)),
        Scenario::AtCompletion => Ok((at_completion(ctx, &mut launch.child)?, None)),
        Scenario::ColdReady | Scenario::WarmReady => {
            Ok((launch.ready_ms.unwrap_or(launch.first_ms), None))
        }
    }
}

/// One TUI child plus its teardown: Drop finishes the child, so every path —
/// success, `?` bubbles, panics — cleans up.
struct Launch {
    child: PtyChild,
    socket: PathBuf,
    first_ms: f64,
    ready_ms: Option<f64>,
    spawned: Instant,
    liveness: Duration,
    /// Where the raw pty stream lands when the launch does NOT complete (the
    /// CI failure artifact for empty-tail debugging).
    stream_dump: Option<PathBuf>,
    completed: bool,
}

impl Launch {
    /// Spawn the TUI and measure its first paint while draining any held peer.
    fn spawn(
        ctx: &RunCtx,
        socket: &Path,
        resume: Option<&Path>,
        first_needle: &[u8],
        stream_dump: PathBuf,
        held: Option<&mut Launch>,
    ) -> anyhow::Result<Self> {
        let mut args = vec![
            "--daemon-socket".into(),
            socket.display().to_string().into(),
        ];
        if let Some(file) = resume {
            args.push("--resume".into());
            args.push(file.display().to_string().into());
        }
        let started = Instant::now();
        let child = PtyChild::spawn(
            &ctx.binary,
            &args,
            &child_env(ctx),
            &ctx.project_dir,
            120,
            36,
        )?;
        let what = if resume.is_some() {
            "the resumed transcript paint"
        } else {
            "the first paint"
        };
        let mut launch = Self {
            first_ms: 0.0,
            child,
            socket: socket.to_path_buf(),
            ready_ms: None,
            spawned: started,
            liveness: ctx.liveness,
            stream_dump: Some(stream_dump),
            completed: false,
        };
        if let Some(held) = held {
            launch.child.wait_from_pumping(
                launch.child.mark(),
                first_needle,
                what,
                started + ctx.liveness,
                Some(&mut held.child),
            )?;
        } else {
            launch.child.wait_from(
                launch.child.mark(),
                first_needle,
                what,
                started + ctx.liveness,
            )?;
        }
        launch.first_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(launch)
    }

    /// The ready metric: exec -> the tray's session-usage pill, the first
    /// attach-only content on the chat surface.
    fn wait_ready(&mut self) -> anyhow::Result<()> {
        self.child.wait_screen_contains(
            READY_NEEDLE,
            "the attach pill",
            self.spawned + self.liveness,
        )?;
        self.ready_ms = Some(self.spawned.elapsed().as_secs_f64() * 1000.0);
        Ok(())
    }
}

impl Drop for Launch {
    fn drop(&mut self) {
        if !self.completed {
            if let Some(path) = &self.stream_dump {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(path, &self.child.output);
            }
        }
        self.child.finish();
    }
}

/// The left-arrow opens the agents view; populate completes when the
/// roster settles (see [`roster_settled`]; the heading count repaints as
/// cell diffs, so the byte stream cannot see it — the screen model does).
/// The count includes the TUI's own fresh session (rendered as one more
/// inactive row).
fn agents_view_populate(ctx: &RunCtx, child: &mut PtyChild) -> anyhow::Result<f64> {
    let started = Instant::now();
    child.write(b"\x1b[D")?;
    wait_roster(ctx, child, ctx.manifest.markers.roster_inactive + 1)?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

/// The agents view opens on its first catalog page: the `Inactive (N)`
/// heading counts the loaded rows and the `M older sessions not loaded`
/// footer the rest, so the page is settled once both account for every
/// expected session. An unpaged roster has no footer.
fn roster_settled(screen: &str, expected: usize) -> bool {
    let loaded = screen
        .split_once("Inactive (")
        .and_then(|(_, rest)| rest.split_once(')'))
        .and_then(|(number, _)| number.parse::<usize>().ok());
    let unloaded = screen
        .lines()
        .find_map(|line| {
            let (number, _) = line.trim_start().split_once(" older sessions not loaded")?;
            number.parse::<usize>().ok()
        })
        .unwrap_or(0);
    loaded.is_some_and(|loaded| loaded + unloaded == expected)
}

fn wait_roster(ctx: &RunCtx, child: &mut PtyChild, expected: usize) -> anyhow::Result<Instant> {
    child.wait_screen(
        "the agents view roster",
        Instant::now() + ctx.liveness,
        |screen| roster_settled(screen, expected),
    )
}

/// From the opened session A: open the agents view, uniquely filter to
/// switch-b, and time enter -> B's transcript marker. The `zq` token in
/// switch-b's name matches no other row (no generated text carries the
/// letter z), so Enter always drills THE row.
fn switch_to_target_b(ctx: &RunCtx, child: &mut PtyChild) -> anyhow::Result<f64> {
    child.write(b"\x1b[D")?;
    // Wait for the settled roster before typing so the scan cannot swallow the query.
    wait_roster(ctx, child, ctx.manifest.markers.roster_inactive - 1)?;
    child.write(ctx.manifest.markers.switch_query.as_bytes())?;
    // The echoed query does not contain the row's "switch" prefix, so this
    // needle is the picker's result row, not the echo.
    child.wait_from(
        child.mark(),
        ctx.manifest.markers.switch_row.as_bytes(),
        "the switch-b picker row",
        Instant::now() + ctx.liveness,
    )?;
    let mark = child.mark();
    let started = Instant::now();
    child.write(b"\r")?;
    child.wait_from(
        mark,
        ctx.manifest.markers.switch_b.needle.as_bytes(),
        "the switch-b transcript",
        Instant::now() + ctx.liveness,
    )?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

/// The `@` completion: the trigger is the `@` keystroke alone; the needle
/// is the first painted completion menu row (the menu lists the project
/// tree's entries — `src/` is a top-level dir of the generated project
/// that the pre-menu screen never contains).
fn at_completion(ctx: &RunCtx, child: &mut PtyChild) -> anyhow::Result<f64> {
    let started = Instant::now();
    child.write(b"@")?;
    // The menu lists the project tree's entries — `src/` is a top-level
    // dir of the generated project that the pre-menu screen never contains
    // (the visible first rows are dirs, not the .rs files).
    child.wait_screen_contains(
        "src/",
        "the completion menu row",
        Instant::now() + ctx.liveness,
    )?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

/// Time the ten-character echo; verify its complete clear afterward.
fn editor_echo_ack(ctx: &RunCtx, child: &mut PtyChild) -> anyhow::Result<f64> {
    let started = Instant::now();
    // Plain repeated bytes are deduplicated under the advertised Kitty mode.
    child.write(&kitty_keystrokes('z' as u32, EDITOR_PAYLOAD.len()))?;
    child.wait_screen_contains(
        EDITOR_PAYLOAD,
        "the editor echo",
        Instant::now() + ctx.liveness,
    )?;
    let sample = started.elapsed().as_secs_f64() * 1000.0;
    // A missing full substring can still leave payload characters behind.
    let editor_rows = child.rows_containing(EDITOR_PAYLOAD)?;
    child.write(&kitty_keystrokes(0x7f, EDITOR_PAYLOAD.len()))?;
    child.wait_rows_lack(
        &editor_rows,
        "z",
        "the cleared editor",
        Instant::now() + ctx.liveness,
    )?;
    Ok(sample)
}

/// The per-run isolated socket path.
fn run_socket(ctx: &RunCtx, run: usize) -> PathBuf {
    ctx.corpus_root
        .join("bench-runs")
        .join(format!("run-{run}"))
        .join("daemon.sock")
}

/// Start the daemon (own session, detached) and wait for the socket to
/// accept — the observable readiness.
fn start_daemon(ctx: &RunCtx, socket: &Path) -> anyhow::Result<DaemonChild> {
    std::fs::create_dir_all(socket.parent().expect("a socket dir"))?;
    let args: [std::ffi::OsString; 4] = [
        "--mode".into(),
        "daemon".into(),
        "--daemon-socket".into(),
        socket.display().to_string().into(),
    ];
    let env = child_env(ctx);
    let mut command = std::process::Command::new(&ctx.binary);
    command
        .args(&args)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .current_dir(&ctx.project_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    pa_core::platform::process::set_new_session(&mut command);
    DaemonChild {
        child: command.spawn()?,
    }
    .wait_until_ready(socket, Instant::now() + Duration::from_secs(30))
}

/// Direct child ownership survives startup and normal protocol shutdown.
/// Drop is an error-path fallback, restricted to this exact child handle.
struct DaemonChild {
    child: std::process::Child,
}

impl DaemonChild {
    fn wait_until_ready(mut self, socket: &Path, deadline: Instant) -> anyhow::Result<Self> {
        loop {
            if let Some(status) = self.child.try_wait()? {
                anyhow::bail!("the daemon exited before socket readiness: {status}");
            }
            if socket_accepts(socket) {
                return Ok(self);
            }
            if Instant::now() >= deadline {
                anyhow::bail!("the daemon socket never accepted: {}", socket.display());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for DaemonChild {
    fn drop(&mut self) {
        if self.child.try_wait().is_ok_and(|status| status.is_some()) {
            return;
        }
        let _ = pa_core::platform::process::kill_pid(
            self.child.id() as i32,
            pa_core::platform::process::Signal::Kill,
        );
        let _ = self.child.wait();
    }
}

fn socket_accepts(socket: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(socket).is_ok()
}

/// Stop the daemon on `socket` by the shutdown protocol: the hello line,
/// the shutdown command, one response read, then wait until the socket no
/// longer accepts (the observable exit). A daemon that never stops fails
/// the run loudly — no pid sweeps.
fn stop_daemon(socket: &Path) -> anyhow::Result<()> {
    protocol_shutdown(socket);
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !socket_accepts(socket) {
            let _ = std::fs::remove_file(socket);
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    anyhow::bail!(
        "the daemon on {} kept accepting after the shutdown protocol; the run is not clean",
        socket.display()
    )
}

/// The daemon-shutdown protocol (the e2es' `graceful_shutdown` shape): the
/// hello line, the shutdown command, one response read.
fn protocol_shutdown(socket: &Path) {
    let Ok(stream) = std::os::unix::net::UnixStream::connect(socket) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    // The hello can stall too: bound every read, not just the reply.
    if reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)))
        .is_err()
    {
        return;
    }
    let mut hello = String::new();
    if !matches!(reader.read_line(&mut hello), Ok(bytes) if bytes > 0) {
        return;
    }
    let command = serde_json::json!({
        "type": "command",
        "id": "bench-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let Ok(mut line) = serde_json::to_string(&command) else {
        return;
    };
    line.push('\n');
    if writer.write_all(line.as_bytes()).is_err() {
        return;
    }
    let _ = writer.flush();
    let _ = reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = String::new();
    let _ = reader.read_line(&mut response);
}

/// Restore the corpus's exact generated state: delete every file under the
/// agent dir that the manifest does not list (the product's new session
/// files, sidecars, logs, leases), then prune the emptied dirs.
fn restore(ctx: &RunCtx) -> anyhow::Result<()> {
    let baseline: std::collections::HashSet<&str> =
        ctx.manifest.files.iter().map(String::as_str).collect();
    let mut dirs = Vec::new();
    let mut stack = vec![ctx.agent_dir.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            // Never follow product-created links outside the owned corpus.
            if entry.file_type()?.is_dir() {
                dirs.push(path.clone());
                stack.push(path);
            } else if !baseline.contains(path.to_string_lossy().as_ref()) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    for dir in dirs.iter().rev() {
        let _ = std::fs::remove_dir(dir);
    }
    Ok(())
}

/// The result object for one scenario's samples.
fn build_result(
    ctx: &RunCtx,
    scenario: Scenario,
    samples: Vec<f64>,
    samples_rss_bytes: Option<Vec<u64>>,
) -> BenchResult {
    let (median_ms, p95_ms) = stats(&samples);
    BenchResult {
        schema: 1,
        scenario,
        profile: crate::report::profile_key(ctx.manifest.profile),
        runs: samples.len(),
        median_ms,
        p95_ms,
        samples_ms: samples,
        samples_rss_bytes,
        needle: needle_of(scenario, ctx),
        binary: ctx.binary.display().to_string(),
        corpus: BenchCorpus {
            root: ctx.corpus_root.clone(),
            sessions: ctx.manifest.counts.sessions,
            total_rows: ctx.manifest.counts.total_rows,
            child_sessions: ctx.manifest.counts.child_sessions,
        },
    }
}

/// Median + p95 over the samples.
fn stats(samples: &[f64]) -> (f64, f64) {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let median = if sorted.len() % 2 == 1 {
        sorted[sorted.len() / 2]
    } else {
        (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) / 2.0
    };
    let p95_index = ((sorted.len() as f64 - 1.0) * 0.95).ceil() as usize;
    (median, sorted[p95_index.min(sorted.len() - 1)])
}

fn needle_of(scenario: Scenario, ctx: &RunCtx) -> String {
    match scenario {
        Scenario::ColdStart | Scenario::WarmStart => {
            "first paint (the brand splash over the empty new session)".to_string()
        }
        Scenario::ColdReady | Scenario::WarmReady => {
            "the attach pill (the tray's session-usage row)".to_string()
        }
        Scenario::AgentsView | Scenario::AgentsViewWarm => format!(
            "the settled roster (Inactive + not-yet-loaded = {})",
            ctx.manifest.markers.roster_inactive + 1
        ),
        Scenario::OpenSession => format!(
            "the huge session marker {}",
            ctx.manifest.markers.huge.needle
        ),
        Scenario::SessionSwitch => format!(
            "the enter drill-in to switch-b (its transcript marker {})",
            ctx.manifest.markers.switch_b.needle
        ),
        Scenario::AtCompletion => "the first @ completion menu row".to_string(),
        Scenario::EditorReady => {
            "the editor echo of ten typed characters (then backspace clears it)".to_string()
        }
        Scenario::ConcurrentSession => format!(
            "the huge session marker {} (opened while a second TUI holds switch-a)",
            ctx.manifest.markers.huge.needle
        ),
    }
}

fn write_result(result: &BenchResult, path: &Path) -> anyhow::Result<()> {
    let json = serde_json::to_string_pretty(result)?;
    std::fs::write(path, json).with_context(|| format!("write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_context(root: &Path) -> RunCtx {
        corpus::generate(&CorpusOptions {
            out: root.to_path_buf(),
            sessions: 3,
            rows: 100,
            huge_rows: 100,
            tree_parents: 0,
            cwd_files: 1,
            ..crate::corpus::Profile::Small.defaults()
        })
        .expect("generate the tiny corpus");
        // A relative file is sufficient: loading does not execute it.
        RunCtx::load(Path::new("Cargo.toml"), root, Duration::ZERO).expect("load corpus")
    }

    #[test]
    fn the_binary_path_is_anchored_before_entering_the_corpus_project() {
        let dir = tempfile::tempdir().expect("temp dir");
        let ctx = tiny_context(dir.path());
        let binary = Path::new("Cargo.toml");
        assert_eq!(
            ctx.binary,
            binary.canonicalize().expect("anchor the binary")
        );
    }

    #[test]
    fn relative_corpus_paths_anchor_the_socket_before_changing_project() {
        let dir = tempfile::tempdir_in(".").expect("relative corpus directory");
        // TempDir may return an absolute path even for a relative parent.
        // The directory lives in cwd, so its name is the caller's relative path.
        let relative_root = Path::new(dir.path().file_name().expect("temporary directory name"));
        assert!(
            relative_root.is_relative(),
            "exercise a relative caller path"
        );
        let ctx = tiny_context(relative_root);
        assert!(run_socket(&ctx, 0).is_absolute());
        assert_eq!(
            ctx.corpus_root,
            dir.path().canonicalize().expect("absolute root")
        );
        assert_ne!(ctx.project_dir, ctx.corpus_root);
    }

    #[test]
    fn warm_results_record_the_corpus_that_was_measured() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cold = tiny_context(&dir.path().join("cold"));
        let warm = tiny_context(&dir.path().join("warm"));
        for scenario in [
            Scenario::WarmStart,
            Scenario::WarmReady,
            Scenario::ColdStart,
        ] {
            let measured = corpus_for(scenario, &cold, &warm);
            let result = build_result(measured, scenario, vec![1.0, 2.0], None);
            let expected = if scenario == Scenario::ColdStart {
                &cold
            } else {
                &warm
            };
            assert_eq!(result.corpus.root, expected.corpus_root);
        }
    }

    #[test]
    fn zero_samples_fail_before_loading_or_generating_corpora() {
        let dir = tempfile::tempdir().expect("temp dir");
        let absent = dir.path().join("must-not-be-created");
        let standalone = run(&BenchOptions {
            binary: absent.clone(),
            corpus: absent.clone(),
            scenario: Scenario::ColdStart,
            runs: 0,
            json: absent.clone(),
            liveness_secs: 1,
        });
        assert_eq!(
            standalone.expect_err("zero runs rejected").to_string(),
            "sampled runs must be positive"
        );
        let suite = run_suite(&RunOptions {
            binary: absent.clone(),
            profile: crate::corpus::Profile::Small,
            out: absent.clone(),
            seed: 1,
            runs: 0,
            liveness_secs: 1,
        });
        assert_eq!(
            suite.expect_err("zero suite runs rejected").to_string(),
            "sampled runs must be positive"
        );
        assert!(!absent.exists(), "validation must precede output mutation");
    }

    #[test]
    fn a_first_paint_failure_retains_the_raw_stream() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let mut ctx = tiny_context(dir.path());
        let mock = dir.path().join("mock-ui");
        std::fs::write(
            &mock,
            "#!/bin/sh\nprintf 'diagnostic before missing paint\\n'\nexec /bin/cat\n",
        )
        .expect("write mock UI");
        std::fs::set_permissions(&mock, std::fs::Permissions::from_mode(0o700))
            .expect("executable mock");
        ctx.binary = mock;
        ctx.liveness = Duration::from_secs(1);
        let dump = dir.path().join("failed-streams/first.bin");
        let launched = Launch::spawn(
            &ctx,
            &dir.path().join("s"),
            None,
            b"absent paint",
            dump.clone(),
            None,
        );
        assert!(
            launched.is_err(),
            "the mock never paints the requested needle"
        );
        assert!(std::fs::read(&dump)
            .expect("failure dump")
            .windows(b"diagnostic before missing paint".len())
            .any(|bytes| bytes == b"diagnostic before missing paint"));
    }

    #[test]
    fn restore_removes_links_without_traversing_external_targets() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("corpus directory");
        let ctx = tiny_context(directory.path());
        let external = tempfile::tempdir().expect("external directory");
        let sentinel = external.path().join("sentinel");
        std::fs::write(&sentinel, b"external data").expect("external sentinel");
        let directory_link = ctx.agent_dir.join("outside-dir");
        let file_link = ctx.agent_dir.join("outside-file");
        symlink(external.path(), &directory_link).expect("directory link");
        symlink(&sentinel, &file_link).expect("file link");
        restore(&ctx).expect("restore without following links");
        assert_eq!(
            std::fs::read(&sentinel).expect("external file retained"),
            b"external data"
        );
        assert!(external.path().is_dir());
        assert!(std::fs::symlink_metadata(directory_link).is_err());
        assert!(std::fs::symlink_metadata(file_link).is_err());
        for file in &ctx.manifest.files {
            assert!(Path::new(file).exists(), "baseline file missing: {file}");
        }
    }

    #[test]
    fn every_standalone_sample_restores_the_manifest_baseline() {
        let dir = tempfile::tempdir().expect("temp dir");
        let ctx = tiny_context(dir.path());
        let sidecar = ctx.agent_dir.join("sessions/mock.window-cache.json");
        // Even the discarded warm-up starts from the original baseline.
        std::fs::write(&sidecar, "previous invocation").expect("old sidecar");
        let mut launches = Vec::new();
        let samples = sample_runs(&ctx, 2, |index| {
            assert!(
                !sidecar.exists(),
                "sample {index} inherited a prior sidecar"
            );
            for file in &ctx.manifest.files {
                assert!(Path::new(file).exists(), "baseline file missing: {file}");
            }
            std::fs::write(&sidecar, "written by the mock scenario")?;
            launches.push(index);
            Ok((index as f64, Some(index as u64)))
        })
        .expect("sample the mock scenario");
        assert_eq!(
            (launches, samples),
            (vec![0, 1, 2], vec![(1.0, Some(1)), (2.0, Some(2))],)
        );
    }

    #[test]
    fn a_daemon_startup_timeout_kills_and_reaps_its_owned_child() {
        let dir = tempfile::tempdir().expect("temp dir");
        let child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .expect("spawn the mock daemon, never the product");
        let pid = nix::unistd::Pid::from_raw(child.id() as i32);
        let result = DaemonChild { child }.wait_until_ready(&dir.path().join("s"), Instant::now());
        assert!(result.is_err());
        assert_eq!(
            nix::sys::signal::kill(pid, None),
            Err(nix::errno::Errno::ESRCH)
        );
    }

    #[test]
    fn a_measured_ui_disconnects_before_waiting_for_daemon_exit() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let mut ctx = tiny_context(dir.path());
        let binary = dir.path().join("mock-product.py");
        std::fs::write(
            &binary,
            include_str!("../../tests/fixtures/draining_daemon.py"),
        )
        .expect("write the mock modes");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make the mock executable");
        ctx.binary = binary;
        ctx.liveness = Duration::from_secs(10);
        let (sample, rss, launched) = launch(&ctx, Scenario::WarmStart, 0)
            .expect("the daemon must drain its measured UI connection before exit");
        assert!(sample >= 0.0);
        // Missing procfs must not become a zero RSS sample.
        #[cfg(target_os = "linux")]
        assert!(rss.is_some());
        #[cfg(not(target_os = "linux"))]
        assert!(rss.is_none());
        assert!(
            launched.ready_ms.is_some(),
            "the actual mock paint/attach ran"
        );
        assert_eq!(
            std::fs::read_to_string(run_socket(&ctx, 0).with_extension("drained"))
                .expect("the mock daemon reached normal drain completion"),
            "all UI/control connections closed\n"
        );
    }

    #[test]
    fn a_daemon_that_never_sends_hello_cannot_hang_shutdown() {
        use std::os::unix::net::UnixListener;

        let dir = tempfile::tempdir().expect("temp dir");
        // Keep the Unix socket path short on macOS too.
        let socket = dir.path().join("s");
        let listener = UnixListener::bind(&socket).expect("mock listener");
        let (release, released) = std::sync::mpsc::channel();
        let peer = std::thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("accept shutdown client");
            // The bounded watchdog also lets this test terminate on the
            // old implementation, where hello has no read timeout.
            let _ = released.recv_timeout(Duration::from_secs(8));
        });
        let started = Instant::now();
        protocol_shutdown(&socket);
        let elapsed = started.elapsed();
        let _ = release.send(());
        peer.join().expect("mock peer exited");
        assert!(
            elapsed < Duration::from_secs(7),
            "hello blocked for {elapsed:?}"
        );
    }
    #[test]
    fn roster_settled_accounts_for_unloaded_pages() {
        let large = "   ▗█▛▐█▙   ▗▄█▀▗█▀       prime agent v0.10.0
  ▗█▛ ▟██▙▄██▛ ▟▛         agents 0 running, 0 idle, 200 inactive

 >   Search sessions

Session                       Model                                 Cost  Age

Inactive (200)
• (no messages)               amazon.nova-2-lite-v1:0:medium       $0.00   4s
• huge corpus session         gpt-5.4:high                     $71727.10  29d
  ...
801 older sessions not loaded · scroll to load
↑/↓ navigate   Home/End first/last   Enter/→ open";
        assert!(roster_settled(large, 1001));
        assert!(!roster_settled(large, 1000));
        assert!(roster_settled("Inactive (11)\n• a\n• b", 11));
        assert!(!roster_settled("Inactive (7)\n• a\n• b", 11));
        assert!(roster_settled(
            "Inactive (199)\n2302 older sessions not loaded · scroll to load",
            2501,
        ));
    }
}
