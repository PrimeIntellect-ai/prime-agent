//! The scenario runner: pty harness, daemon lifecycle, per-run corpus
//! restore, and the scenario mechanics. Unix-only.

use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Context;

use crate::bench::{BenchCorpus, BenchOptions, BenchResult, Scenario};
use crate::corpus::Manifest;

use super::pty::PtyChild;

/// The first paint's needle: the brand splash is the empty chat's header
/// (the corpus settings keep the TUI out of the first-run flow). Pinned
/// empirically against the real binary.
pub(super) const FIRST_PAINT_NEEDLE: &[u8] = "▗▄▄█▀".as_bytes();

/// One bench run's anchored paths.
struct RunCtx {
    binary: PathBuf,
    manifest: Manifest,
    corpus_root: PathBuf,
    project_dir: PathBuf,
    agent_dir: PathBuf,
    liveness: Duration,
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
    // PI_PACKAGE_DIR carries the packaged runtime dir to the binary and its
    // workers (a release binary resolves prime-agent-runtime/ beside the
    // executable or through it); PATH/HOME/TMPDIR are the ambient basics.
    for carry in ["PATH", "HOME", "TMPDIR", "PI_PACKAGE_DIR"] {
        if let Some(value) = std::env::var_os(carry) {
            env.push((carry.to_string(), value.to_string_lossy().to_string()));
        }
    }
    env
}

/// Run the scenario `options.runs` times (plus one discarded warm-up), then
/// write the result JSON.
///
/// # Errors
///
/// Propagates spawn, needle-timeout, daemon, and IO failures.
pub fn run(options: &BenchOptions) -> anyhow::Result<BenchResult> {
    let manifest_path = options.corpus.join("corpus.json");
    let manifest: Manifest = serde_json::from_str(
        &std::fs::read_to_string(&manifest_path)
            .with_context(|| format!("read {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parse {}", manifest_path.display()))?;
    let ctx = RunCtx {
        binary: options.binary.clone(),
        project_dir: manifest.paths.project_dir.clone(),
        agent_dir: manifest.paths.agent_dir.clone(),
        corpus_root: options.corpus.clone(),
        manifest,
        liveness: Duration::from_secs(options.liveness_secs),
    };

    // One discarded warm-up run: the first exec of the binary (and the
    // corpus's page cache) must not land in a sample.
    let mut samples = Vec::with_capacity(options.runs + 1);
    let total = options.runs + 1;
    for index in 0..total {
        let started = Instant::now();
        let outcome = sample_once(&ctx, options, index);
        if index == 0 {
            outcome?;
            continue;
        }
        let sample = outcome.context("a sampled run failed")?;
        samples.push(sample);
        println!(
            "run {index}/{}: {sample:.1}ms (wall {:.1}s)",
            options.runs,
            started.elapsed().as_secs_f32()
        );
    }
    let (median_ms, p95_ms) = stats(&samples);
    let result = BenchResult {
        schema: 1,
        scenario: options.scenario,
        profile: profile_name(ctx.manifest.profile),
        runs: samples.len(),
        samples_ms: samples,
        median_ms,
        p95_ms,
        needle: needle_of(options.scenario, &ctx),
        binary: options.binary.display().to_string(),
        corpus: BenchCorpus {
            root: options.corpus.clone(),
            sessions: ctx.manifest.counts.sessions,
            total_rows: ctx.manifest.counts.total_rows,
            child_sessions: ctx.manifest.counts.child_sessions,
            archive: ctx.manifest.counts.archive,
        },
    };
    let json = serde_json::to_string_pretty(&result)?;
    std::fs::write(&options.json, &json)
        .with_context(|| format!("write {}", options.json.display()))?;
    Ok(result)
}

/// The manifest profile's lowercase name (`format!("{:?}")` is `small`...).
fn profile_name(profile: crate::corpus::Profile) -> String {
    match profile {
        crate::corpus::Profile::Small => "small".to_string(),
        crate::corpus::Profile::Medium => "medium".to_string(),
        crate::corpus::Profile::Large => "large".to_string(),
        crate::corpus::Profile::Xl => "xl".to_string(),
    }
}

fn needle_of(scenario: Scenario, ctx: &RunCtx) -> String {
    match scenario {
        Scenario::ColdStart | Scenario::WarmStart => {
            "first paint (the brand splash over the empty new session)".to_string()
        }
        Scenario::AgentsView | Scenario::AgentsViewWarm => format!(
            "the populate anchor row (the oldest session's search hit: {})",
            ctx.manifest.markers.populate_anchor
        ),
        Scenario::OpenSession => {
            format!(
                "the huge session marker {}",
                ctx.manifest.markers.huge.needle
            )
        }
        Scenario::SessionSwitch => format!(
            "the enter drill-in to switch-b (its transcript marker {})",
            ctx.manifest.markers.switch_b.needle
        ),
        Scenario::AtCompletion => format!("@ completion row {}", ctx.manifest.markers.at_file),
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

/// One scenario pass; returns the sample in ms.
fn sample_once(ctx: &RunCtx, options: &BenchOptions, run: usize) -> anyhow::Result<f64> {
    restore(ctx)?;
    let run_dir = ctx
        .corpus_root
        .join("bench-runs")
        .join(format!("run-{run}"));
    std::fs::create_dir_all(&run_dir)?;
    let socket = run_dir.join("daemon.sock");
    if matches!(
        options.scenario,
        Scenario::WarmStart | Scenario::AgentsViewWarm
    ) {
        start_daemon(ctx, &socket)?;
    }

    let (resume, first_needle) = match options.scenario {
        Scenario::OpenSession => (
            Some(ctx.manifest.markers.huge.file.clone()),
            ctx.manifest.markers.huge.needle.as_bytes().to_vec(),
        ),
        Scenario::SessionSwitch => (
            Some(ctx.manifest.markers.switch_a.file.clone()),
            ctx.manifest.markers.switch_a.needle.as_bytes().to_vec(),
        ),
        _ => (None, FIRST_PAINT_NEEDLE.to_vec()),
    };
    let mut launch = Launch::spawn(ctx, &socket, resume.as_deref(), &first_needle)?;
    launch.debug_stream = options.debug_stream.clone();
    let sample = match options.scenario {
        Scenario::ColdStart | Scenario::WarmStart | Scenario::OpenSession => launch.first_ms,
        Scenario::AgentsView => agents_view_populate(ctx, &mut launch.child)?,
        Scenario::AgentsViewWarm => {
            let warm = agents_view_populate(ctx, &mut launch.child)?;
            // The first populate warmed the daemon's in-process scan cache;
            // the second TUI measures the warm path on the same daemon.
            let mut second = Launch::spawn(ctx, &socket, None, FIRST_PAINT_NEEDLE)?;
            second.debug_stream = options.debug_stream.clone();
            agents_view_populate(ctx, &mut second.child)?;
            warm
        }
        Scenario::SessionSwitch => switch_to_target_b(ctx, &mut launch.child)?,
        Scenario::AtCompletion => at_completion(ctx, &mut launch.child)?,
    };
    if options.settle_ms > 0 {
        launch.child.drain(Duration::from_millis(options.settle_ms));
    }
    stop_daemon(&socket);
    Ok(sample)
}

/// One TUI child plus its teardown: Drop finishes the child (and dumps the
/// raw pty stream for needle debugging), so every path — success, `?`
/// bubbles, panics — cleans up and leaves the evidence behind.
struct Launch {
    child: PtyChild,
    debug_stream: Option<std::path::PathBuf>,
    first_ms: f64,
}

impl Launch {
    /// Spawn the TUI (fresh daemon when none listens on `socket`), wait the
    /// first needle (the brand-splash paint, or the resumed transcript's
    /// marker), and record exec -> needle.
    fn spawn(
        ctx: &RunCtx,
        socket: &Path,
        resume: Option<&Path>,
        first_needle: &[u8],
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
        let mut child = PtyChild::spawn(
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
        let result = child.wait_from(child.mark(), first_needle, what, started + ctx.liveness);
        if let Err(error) = result {
            let stream = std::mem::take(&mut child.output);
            let _ = std::fs::write(
                std::env::temp_dir().join("pa-perf-failed-stream.bin"),
                &stream,
            );
            return Err(error);
        }
        Ok(Self {
            child,
            debug_stream: None,
            first_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

impl Drop for Launch {
    fn drop(&mut self) {
        if let Some(path) = self.debug_stream.take() {
            std::fs::write(path, &self.child.output).ok();
        }
        self.child.finish();
    }
}

/// The left-arrow opens the agents view; the populate-completion needle is
/// the oldest session's search-result row (its name fragment the query does
/// not echo), which can only paint once the roster scan delivered the last
/// (oldest) session. Returns the left-arrow -> needle time.
fn agents_view_populate(ctx: &RunCtx, child: &mut PtyChild) -> anyhow::Result<f64> {
    let needle = ctx.manifest.markers.populate_anchor.as_bytes();
    let mark = child.mark();
    let started = Instant::now();
    child.write(b"\x1b[D")?;
    child.wait_from(
        mark,
        b"Search sessions",
        "the agents view opening",
        Instant::now() + ctx.liveness,
    )?;
    child.write(ctx.manifest.markers.populate_query.as_bytes())?;
    child.wait_from(
        mark,
        needle,
        "the populate anchor row",
        Instant::now() + ctx.liveness,
    )?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

/// From the opened session A: open the agents view, filter the rows to the
/// switch-b target, and time enter -> B's transcript marker. The switch-b
/// row is one of the newest sessions, so it streams early — the filter
/// needle does not wait for the whole roster.
fn switch_to_target_b(ctx: &RunCtx, child: &mut PtyChild) -> anyhow::Result<f64> {
    let mark = child.mark();
    child.write(b"\x1b[D")?;
    // Wait the view's search composer before typing: keys written
    // mid-transition would race the mount.
    child.wait_from(
        mark,
        b"Search sessions",
        "the agents view opening",
        Instant::now() + ctx.liveness,
    )?;
    // The query matches exactly one row (the `zqmark` name; the echoed
    // query lacks the row's "switch" prefix), so the empty-picker -> hit
    // transition paints the row fully and Enter drills THE row.
    child.write(ctx.manifest.markers.switch_query.as_bytes())?;
    let mark = child.mark();
    child.wait_from(
        mark,
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

/// The `@` file-completion scenario: the trigger is the `@` keystroke; the
/// needle is the corpus marker file's menu row.
fn at_completion(ctx: &RunCtx, child: &mut PtyChild) -> anyhow::Result<f64> {
    let at_file = ctx.manifest.markers.at_file.as_bytes().to_vec();
    let mark = child.mark();
    let started = Instant::now();
    child.write(b"@")?;
    child.write(b"zzq-corpus")?;
    child.wait_from(
        mark,
        &at_file,
        "the @ completion row",
        Instant::now() + ctx.liveness,
    )?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

/// Start the daemon (own session, detached) and wait for the socket to
/// accept — the observable readiness.
fn start_daemon(ctx: &RunCtx, socket: &Path) -> anyhow::Result<()> {
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
    // SAFETY: the pre-exec hook runs in the child only.
    unsafe {
        command.pre_exec(|| {
            nix::unistd::setsid()?;
            Ok(())
        });
    }
    command.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if socket_accepts(socket) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    anyhow::bail!("the daemon socket never accepted: {}", socket.display())
}

fn socket_accepts(socket: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(socket).is_ok()
}

/// Stop the daemon on `socket`: the protocol shutdown first; then, if the
/// socket file survives, sweep /proc for processes whose cmdline carries the
/// run's socket path (never a name-based kill) and signal those pids.
fn stop_daemon(socket: &Path) {
    protocol_shutdown(socket);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !socket.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if socket.exists() {
        for pid in pids_holding(socket) {
            let pid = nix::unistd::Pid::from_raw(pid);
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGTERM);
        }
        std::thread::sleep(Duration::from_secs(2));
        for pid in pids_holding(socket) {
            let pid = nix::unistd::Pid::from_raw(pid);
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
        }
    }
    let _ = std::fs::remove_file(socket);
}

/// The daemon-shutdown protocol (the e2es' `graceful_shutdown` shape): the
/// hello line, the shutdown command, one response read.
fn protocol_shutdown(socket: &Path) {
    let Ok(stream) = std::os::unix::net::UnixStream::connect(socket) else {
        return;
    };
    let _ = stream.shutdown(Shutdown::Write);
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello); // daemon_hello
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

/// Pids whose cmdline carries `path` (linux /proc sweep; empty elsewhere).
fn pids_holding(path: &Path) -> Vec<i32> {
    let mut pids = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return pids;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Ok(pid) = name.to_string_lossy().parse::<i32>() else {
            continue;
        };
        if let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) {
            let text = String::from_utf8_lossy(&cmdline).replace('\0', " ");
            if text.contains(&path.display().to_string()) {
                pids.push(pid);
            }
        }
    }
    pids
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
        for entry in std::fs::read_dir(&dir)?.flatten() {
            let path = entry.path();
            if path.is_dir() {
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
