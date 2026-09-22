//! Lock-convention compatibility, binary level: the TS `prime-agent` and the
//! Rust `prime-agent` must agree on the lock artifact at `<file>.lock`.
//!
//! The TS product locks files with `proper-lockfile`: an empty DIRECTORY at
//! `{file}.lock` whose mtime is refreshed while held and judged for
//! staleness on contention. Its release path `rmdir`s the lock path, so a
//! regular FILE there is fatal to the TS product (`ENOTDIR`), and a stale
//! directory is reclaimed as a crashed holder's artifact. Pre-compat Rust
//! builds created flock FILEs there, which wedged real TS installs. These
//! tests pin the ground truth with the installed TS binary (fixture agent
//! dirs only; skipped when the binary is absent) and assert the Rust side
//! produces exactly the artifacts the TS side tolerates.
//!
//! Note the deliberate asymmetry: when a stale FILE artifact blocks it, the
//! Rust binary heals the artifact and proceeds (self-healing its own legacy
//! output), while the TS binary fails. Both behaviors are asserted as-is.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;

use pa_core::platform::LockDir;

/// The TS binary ground truth, located like `differential_cli.rs`
/// (`PA_TS_BINARY` or `prime-agent` on PATH; skipped when absent).
fn ts_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PA_TS_BINARY") {
        return Some(PathBuf::from(path));
    }
    let found = Command::new("which")
        .arg("prime-agent")
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    let path = String::from_utf8_lossy(&found.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn sandbox(prefix: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "pa-cli-lock-compat-{prefix}-{}",
        std::process::id()
    ));
    for dir in ["home", "cwd", "agent", "tmp"] {
        std::fs::create_dir_all(base.join(dir)).expect("create sandbox directory");
    }
    base
}

fn run(binary: &Path, args: &[&str], sandbox: &Path) -> (Option<i32>, String, String) {
    let output = Command::new("timeout")
        .arg("30")
        .arg(binary)
        .args(args)
        // Fixture agent dir only: never the ambient installation.
        .env("PRIME_AGENT_CODING_AGENT_DIR", sandbox.join("agent"))
        .env("HOME", sandbox.join("home"))
        .env("TMPDIR", sandbox.join("tmp"))
        .env("PI_OFFLINE", "1")
        .current_dir(sandbox.join("cwd"))
        .output()
        .expect("failed to spawn binary under test");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn settings_path(sandbox: &Path) -> PathBuf {
    sandbox.join("agent").join("settings.json")
}

fn lock_path(sandbox: &Path) -> PathBuf {
    settings_path(sandbox).with_extension("json.lock")
}

/// Write a stale FILE artifact at the lock path (a pre-compat Rust flock
/// lock) with an mtime past every staleness threshold in play.
fn seed_stale_lock_file(sandbox: &Path) {
    let path = lock_path(sandbox);
    std::fs::write(&path, "pre-compat flock artifact").expect("seed stale lock file");
    age(&path);
}

/// Write a stale lock DIRECTORY artifact at the lock path: exactly what a
/// crashed TS (or Rust) holder leaves behind.
fn seed_stale_lock_dir(sandbox: &Path) {
    let path = lock_path(sandbox);
    std::fs::create_dir(&path).expect("seed stale lock directory");
    age(&path);
}

/// Set a path's mtime far past every staleness threshold in play.
fn age(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("path to cstring");
    let ancient = libc::timespec {
        tv_sec: 1_000_000_000,
        tv_nsec: 0,
    };
    let times = [ancient, ancient];
    let result = unsafe { libc::utimensat(-1, c_path.as_ptr(), times.as_ptr(), 0) };
    assert_eq!(result, 0, "aging {}", path.display());
}

fn assert_server_added(output: &str, name: &str) {
    assert!(
        output.contains(&format!("Added MCP server \"{name}\".")),
        "expected {name} to be added, stdout: {output:?}"
    );
}

fn assert_settings_has_server(sandbox: &Path, name: &str) {
    let content = std::fs::read_to_string(settings_path(sandbox)).expect("settings.json written");
    let value: serde_json::Value = serde_json::from_str(&content).expect("settings.json parses");
    assert!(
        value
            .get("mcpServers")
            .and_then(|servers| servers.get(name))
            .is_some(),
        "settings.json must contain server {name}: {content}"
    );
}

#[test]
fn ts_binary_fails_on_stale_lock_file_artifact() {
    // The regression that wedged a real TS install: a pre-compat Rust flock
    // FILE at `<file>.lock`. The TS release path rmdir()s the lock path and
    // dies with ENOTDIR; the write is refused.
    let Some(ts) = ts_binary() else {
        eprintln!("SKIPPED: TS prime-agent binary not found (set PA_TS_BINARY)");
        return;
    };
    let sandbox = sandbox("ts-stale-file");
    seed_stale_lock_file(&sandbox);
    let (exit, stdout, stderr) = run(
        &ts,
        &[
            "mcp",
            "add",
            "http-one",
            "--url",
            "https://example.invalid/mcp",
        ],
        &sandbox,
    );
    assert_eq!(exit, Some(1), "stdout: {stdout:?}, stderr: {stderr:?}");
    assert!(
        stderr.contains("ENOTDIR"),
        "the TS binary must surface the ENOTDIR lock failure: {stderr:?}"
    );
    assert!(
        lock_path(&sandbox).is_file(),
        "the TS binary must leave the foreign file artifact untouched"
    );
    assert!(
        !settings_path(&sandbox).exists(),
        "a refused lock must mean a refused write"
    );
}

#[test]
fn ts_binary_reclaims_stale_lock_directory_artifact() {
    // A crashed TS (or Rust) holder leaves an empty lock directory. The TS
    // product judges it stale, reclaims it, and proceeds.
    let Some(ts) = ts_binary() else {
        eprintln!("SKIPPED: TS prime-agent binary not found (set PA_TS_BINARY)");
        return;
    };
    let sandbox = sandbox("ts-stale-dir");
    seed_stale_lock_dir(&sandbox);
    let (exit, stdout, stderr) = run(
        &ts,
        &[
            "mcp",
            "add",
            "http-two",
            "--url",
            "https://example.invalid/mcp",
        ],
        &sandbox,
    );
    assert_eq!(exit, Some(0), "stdout: {stdout:?}, stderr: {stderr:?}");
    assert_server_added(&stdout, "http-two");
    assert_settings_has_server(&sandbox, "http-two");
    assert!(
        !lock_path(&sandbox).exists(),
        "the released lock directory must be gone"
    );
}

#[test]
fn ts_binary_sees_a_rust_held_lock_as_contention() {
    // A Rust-held lock must be indistinguishable from a TS-held lock: an
    // empty directory at the lock path, fresh mtime, and the TS side reports
    // plain contention (ELOCKED) and cleans up after itself.
    let Some(ts) = ts_binary() else {
        eprintln!("SKIPPED: TS prime-agent binary not found (set PA_TS_BINARY)");
        return;
    };
    let sandbox = sandbox("interop");
    // Hold the lock the way the Rust production code does.
    let guard = LockDir::acquire(&settings_path(&sandbox), std::time::Duration::from_secs(10))
        .expect("Rust acquires the lock");
    assert!(
        lock_path(&sandbox).is_dir(),
        "the Rust lock artifact is a directory"
    );
    let (exit, stdout, stderr) = run(
        &ts,
        &[
            "mcp",
            "add",
            "http-three",
            "--url",
            "https://example.invalid/mcp",
        ],
        &sandbox,
    );
    assert_eq!(exit, Some(1), "stdout: {stdout:?}, stderr: {stderr:?}");
    assert!(
        stderr.contains("Lock file is already being held"),
        "the TS binary must report contention, not ENOTDIR: {stderr:?}"
    );
    assert!(
        lock_path(&sandbox).is_dir(),
        "the TS failure must not clobber the live Rust lock"
    );
    drop(guard);
    let (exit, stdout, stderr) = run(
        &ts,
        &[
            "mcp",
            "add",
            "http-three",
            "--url",
            "https://example.invalid/mcp",
        ],
        &sandbox,
    );
    assert_eq!(exit, Some(0), "stdout: {stdout:?}, stderr: {stderr:?}");
    assert_server_added(&stdout, "http-three");
    assert_settings_has_server(&sandbox, "http-three");
}

#[test]
fn rust_binary_reclaims_stale_lock_directory_artifact() {
    let rust = PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    let sandbox = sandbox("rs-stale-dir");
    seed_stale_lock_dir(&sandbox);
    let (exit, stdout, stderr) = run(
        &rust,
        &[
            "mcp",
            "add",
            "http-four",
            "--url",
            "https://example.invalid/mcp",
        ],
        &sandbox,
    );
    assert_eq!(exit, Some(0), "stdout: {stdout:?}, stderr: {stderr:?}");
    assert_server_added(&stdout, "http-four");
    assert_settings_has_server(&sandbox, "http-four");
    assert!(
        !lock_path(&sandbox).exists(),
        "the released lock directory must be gone"
    );
}

#[test]
fn rust_binary_heals_stale_lock_file_artifact() {
    // Pre-compat Rust builds left flock FILEs at the lock path. The Rust
    // binary removes the foreign artifact and proceeds; the TS binary cannot.
    let rust = PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    let sandbox = sandbox("rs-stale-file");
    seed_stale_lock_file(&sandbox);
    let (exit, stdout, stderr) = run(
        &rust,
        &[
            "mcp",
            "add",
            "http-five",
            "--url",
            "https://example.invalid/mcp",
        ],
        &sandbox,
    );
    assert_eq!(exit, Some(0), "stdout: {stdout:?}, stderr: {stderr:?}");
    assert_server_added(&stdout, "http-five");
    assert_settings_has_server(&sandbox, "http-five");
    assert!(
        !lock_path(&sandbox).exists(),
        "the healed artifact must be gone; release removes the lock directory"
    );
}
