// The Tier-C/D ruling (fleet-uniform, 2026-09-28) - this target's own
// crate root: the same bounded-boundary disposition as src/lib.rs
// (large_futures/too_many_lines/the cast family; details there).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// The whole target drives /bin/sh interpreter wrappers and unix-only
// file permissions, so it stays off the windows cross-check (the same
// gate the sibling kernel targets carry).
#![cfg(unix)]

//! Verifier integration tests for the startup memo's generation contract
//! and the provisioner's mid-boot lifecycle edges (all on the
//! single-threaded `#[tokio::test]` runtime, whose scheduler runs a whole
//! wake chain - park, publish, clear, taker - in one drain; the fixtures
//! therefore observe state at drain boundaries and never rely on sleeping):
//!
//! - a settled boot's publisher clears only the memo generation it
//!   installed (TS `ensure()`'s `managerPromise === startup` guard): a
//!   boot doomed by a mid-flight `kill()` settles against a NEWER memo
//!   armed underneath it and must leave that memo alone;
//! - `kill()` before publication leaves no resident kernel (TS `kill()`
//!   clears `managerPromise`; the doomed boot's own settle kills its
//!   kernel instead of parking it);
//! - `dispose()` during a boot owns that boot: it waits the in-flight
//!   startup, and the disposed boot settles without parking a kernel
//!   (the atomic settle/publish's invariant).
//!
//! The kernel Python is ambient product state (the auto-bootstrapped kernel
//! venv); like `kernel_stop_revive.rs`, these tests skip (with a note) on
//! machines without a live install so the suite stays hermetic elsewhere.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_core::kernel::provisioner::{IpythonKernelProvisioner, IpythonKernelProvisionerOptions};
use pa_core::kernel::shared::{ExecuteOptions, ExecuteStatus};
use std::os::unix::fs::PermissionsExt;

/// The kernel Python with prime-agent-runtime installed (see
/// `kernel_stop_revive.rs`); skipped with a note when absent.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_CORE_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_CORE_KERNEL_PYTHON {} not found",
            explicit.display()
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live startup-memo test",
        candidate.display()
    );
    None
}

/// A kernel interpreter wrapper that counts spawns into `count` before
/// exec'ing the real kernel Python, so a test can pin exactly how many
/// kernels were armed. Lives in the session dir, which outlives the
/// kernel spawns the test observes.
fn counting_kernel(
    dir: &std::path::Path,
    python: &std::path::Path,
    count: &std::path::Path,
) -> PathBuf {
    let wrapper = dir.join("counting-python");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf x >> '{}'\nexec '{}' \"$@\"\n",
            count.display(),
            python.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    wrapper
}

/// Number of interpreter spawns recorded so far.
fn starts(count: &std::path::Path) -> u64 {
    count.metadata().map_or(0, |m| m.len())
}

/// A settled boot's publisher clears only the memo generation it installed
/// (TS `ensure()`'s `managerPromise === startup` guard). `kill()` clears the
/// memo mid-boot (the generation invalidation), a NEWER memo is armed before
/// the doomed boot settles, and the doomed settle's clear must leave that
/// newer memo alone: the late joiner below must land on the newer boot, and
/// exactly two interpreters may spawn.
#[tokio::test]
async fn stale_publisher_cannot_clear_a_newer_startup_memo() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    let wrapped = counting_kernel(dir.path(), &python, &count);
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(wrapped),
            ..Default::default()
        },
    );
    // Boot one, doomed by a kill before publication.
    let doomed = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    // The interpreter has spawned; the boot is still mid-handshake.
    tokio::time::timeout(Duration::from_secs(30), async {
        while starts(&count) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the fixture interpreter spawned");
    provisioner.kill();
    // Arm the NEWER generation while the doomed boot is still settling.
    let newer = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    // The doomed boot's settle (its memo clear) runs before this resolves.
    let settled = tokio::time::timeout(Duration::from_secs(30), doomed)
        .await
        .expect("the doomed boot settled")
        .unwrap();
    assert!(
        settled.is_err(),
        "a kill before publication must not deliver a kernel"
    );
    // The newer boot survived the doomed settle; the late ask joins it.
    let late = tokio::time::timeout(Duration::from_secs(30), provisioner.ensure(None, None))
        .await
        .expect("the late ask settled")
        .unwrap();
    let newer = tokio::time::timeout(Duration::from_secs(30), newer)
        .await
        .expect("the newer ask settled")
        .unwrap()
        .unwrap();
    assert_eq!(
        starts(&count),
        2,
        "the doomed boot and the newer one; a stale clear must not arm a duplicate"
    );
    for manager in [&late, &newer] {
        let result = manager
            .execute("1 + 1", ExecuteOptions::default())
            .await
            .unwrap();
        assert_eq!(result.status, ExecuteStatus::Ok);
    }
}

/// `kill()` before publication must not leave a resident kernel: the kill
/// clears the startup memo (TS `kill()` clears `managerPromise`), so the
/// doomed boot's own settle kills its kernel instead of parking it, and
/// the next `ensure()` boots fresh.
#[tokio::test]
async fn kill_during_boot_leaves_no_resident_kernel() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    let wrapped = counting_kernel(dir.path(), &python, &count);
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(wrapped),
            ..Default::default()
        },
    );
    let boot = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    // The interpreter has spawned but the boot has not published yet.
    tokio::time::timeout(Duration::from_secs(30), async {
        while starts(&count) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the fixture interpreter spawned");
    provisioner.kill();
    let settled = tokio::time::timeout(Duration::from_secs(30), boot)
        .await
        .expect("the doomed boot settled")
        .unwrap();
    assert!(
        settled.is_err(),
        "a kill before publication must not deliver a kernel"
    );
    assert!(
        provisioner.manager().is_none(),
        "no kernel may park after a kill"
    );
    assert!(!provisioner.has_running_kernel());
    // TS kill() clears the memo: the next ensure() starts a fresh boot.
    let fresh = tokio::time::timeout(Duration::from_secs(30), provisioner.ensure(None, None))
        .await
        .expect("the next ensure booted fresh")
        .unwrap();
    let result = fresh
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
    assert_eq!(
        starts(&count),
        2,
        "the doomed boot and the fresh boot, nothing else"
    );
}

/// `dispose()` during a boot owns that boot: it waits the in-flight
/// startup, and the disposed boot settles as a failure without ever
/// parking a kernel - the atomic settle/publish's invariant. A boot that
/// published between separate check and publish scopes could park a live
/// kernel into a provisioner that had already reported itself torn down.
#[tokio::test]
async fn dispose_during_boot_settles_it_without_parking() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    let wrapped = counting_kernel(dir.path(), &python, &count);
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(wrapped),
            ..Default::default()
        },
    );
    let boot = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    // The interpreter has spawned; the boot is still mid-handshake.
    tokio::time::timeout(Duration::from_secs(30), async {
        while starts(&count) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the fixture interpreter spawned");
    provisioner.dispose(None).await;
    let settled = tokio::time::timeout(Duration::from_secs(30), boot)
        .await
        .expect("the disposed boot settled")
        .unwrap();
    assert!(
        settled.is_err(),
        "the disposed provisioner must reject the boot"
    );
    assert!(
        provisioner.manager().is_none(),
        "no kernel may park into a disposed provisioner"
    );
    assert!(!provisioner.has_running_kernel());
    // And nothing may park afterwards either: the provisioner stays
    // disposed, and no further interpreter spawns.
    let error = provisioner
        .ensure(None, None)
        .await
        .expect_err("a disposed provisioner rejects new boots");
    assert!(error.to_string().contains("disposed"));
    assert_eq!(
        starts(&count),
        1,
        "exactly one interpreter: the disposed boot, no duplicates"
    );
}

/// The kill-vs-boot contract composes with #3257's panic-recovery: a
/// panicking boot settles and clears its memo, the re-armed boot is a
/// fresh generation, and `kill()` mid-re-armed-boot still leaves no
/// resident kernel - the doomed re-armed boot is killed by its own settle.
#[tokio::test]
async fn kill_during_the_re_armed_boot_leaves_no_resident_kernel() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    let wrapped = counting_kernel(dir.path(), &python, &count);
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(wrapped),
            ..Default::default()
        },
    );
    // F1's self-heal: a panicking progress callback kills the boot before
    // the interpreter spawns; the memo settles and the next ensure boots
    // fresh (the panic-cleanup ordering #3257 added).
    let progress: pa_core::kernel::bootstrap::KernelBootstrapProgressHandler =
        Arc::new(|_| panic!("progress callback panic"));
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        provisioner.ensure(Some(progress), None),
    )
    .await
    .expect("panicked startup settled")
    .expect_err("panicked callback must not report success");
    assert!(format!("{error:#}").contains("kernel startup task failed"));
    assert_eq!(
        starts(&count),
        0,
        "the panicked boot spawned no interpreter"
    );
    // The re-armed boot (a fresh generation): kill it before publication.
    let re_armed = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    tokio::time::timeout(Duration::from_secs(30), async {
        while starts(&count) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the re-armed interpreter spawned");
    provisioner.kill();
    let settled = tokio::time::timeout(Duration::from_secs(30), re_armed)
        .await
        .expect("the doomed re-armed boot settled")
        .unwrap();
    assert!(
        settled.is_err(),
        "a kill before publication must not deliver a kernel"
    );
    assert!(provisioner.manager().is_none());
    assert!(!provisioner.has_running_kernel());
    // The provisioner stays consistent: the next ensure boots fresh.
    let fresh = tokio::time::timeout(Duration::from_secs(30), provisioner.ensure(None, None))
        .await
        .expect("the next ensure booted fresh")
        .unwrap();
    let result = fresh
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
    assert_eq!(
        starts(&count),
        2,
        "the doomed re-armed boot and the fresh boot, nothing else"
    );
}

/// A kernel interpreter wrapper that counts spawns into `count` AND holds
/// the n-th interpreter (0-based, from the count file) until the fixture
/// creates `gates/gate<n>`, so a test controls exactly when each boot's
/// handshake may complete - a file barrier, never a timing assumption.
fn counting_gated_kernel(
    dir: &std::path::Path,
    python: &std::path::Path,
    count: &std::path::Path,
    gates: &std::path::Path,
) -> PathBuf {
    let wrapper = dir.join("counting-gated-python");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nn=$(wc -c < '{}')\nprintf x >> '{}'\nwhile [ ! -f '{}'/gate$n ]; do sleep 0.05; done\nexec '{}' \"$@\"\n",
            count.display(),
            count.display(),
            gates.display(),
            python.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    wrapper
}

/// Opens the fixture's gate0/gate1 files on any drop (a failing assert
/// included): a counting wrapper still polling its gate when the test
/// ends must not outlive the test as an orphan - released, it execs the
/// interpreter, whose stdin pipe is gone, and exits.
struct ReleaseGates(std::path::PathBuf);
impl Drop for ReleaseGates {
    fn drop(&mut self) {
        let _ = std::fs::write(self.0.join("gate0"), "");
        let _ = std::fs::write(self.0.join("gate1"), "");
    }
}

/// A doomed boot settling against a NEWER memo generation must not wipe
/// the newer boot's progress state: the settle's listener teardown and
/// the replayed-stage reset belong to the ACTIVE generation only. The
/// observable is the joiner replay - a late `ensure()` joiner of the
/// newer boot replays that boot's last stage to its fresh progress
/// handler; after the doomed settle the replay must still fire.
#[tokio::test]
async fn doomed_settle_keeps_the_newer_boot_listener_state() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    // The wrapper reads its ordinal from the count file BEFORE appending,
    // so the file must exist (empty) before the first spawn.
    std::fs::write(&count, "").unwrap();
    let gates = dir.path().join("gates");
    std::fs::create_dir_all(&gates).unwrap();
    let _release_gates = ReleaseGates(gates.clone());
    let wrapped = counting_gated_kernel(dir.path(), &python, &count, &gates);
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(wrapped),
            ..Default::default()
        },
    );
    // Boot A spawns its interpreter held at gate0 (its handshake cannot
    // complete until the fixture opens the gate, so its settle timing is
    // under the test's control, never a timing race).
    let doomed = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    tokio::time::timeout(Duration::from_secs(30), async {
        while starts(&count) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the fixture interpreter spawned");
    // A joiner of the doomed generation attaches its progress handler
    // first (replaying A's current stage) and parks on A's memo.
    let a_stages: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let a_progress: pa_core::kernel::bootstrap::KernelBootstrapProgressHandler = {
        let a_stages = a_stages.clone();
        Arc::new(move |message| a_stages.lock().unwrap().push(message.to_string()))
    };
    let a_joiner = tokio::spawn({
        let provisioner = provisioner.clone();
        let a_progress = a_progress.clone();
        async move { provisioner.ensure(Some(a_progress), None).await }
    });
    tokio::time::timeout(Duration::from_secs(30), async {
        while a_stages.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the doomed generation's joiner replayed A's stage");
    // The kill invalidates A's memo generation while A is still settling.
    provisioner.kill();
    // Boot B (the newer generation) registers a live progress listener
    // and reaches its first stage - which precedes its own interpreter
    // spawn, so the stage is observable while B's handshake is held at
    // gate1.
    let (stage_tx, stage_rx) = tokio::sync::oneshot::channel();
    let stage_tx = Arc::new(Mutex::new(Some(stage_tx)));
    let b_stages: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let progress_b: pa_core::kernel::bootstrap::KernelBootstrapProgressHandler = {
        let b_stages = b_stages.clone();
        Arc::new(move |message| {
            b_stages.lock().unwrap().push(message.to_string());
            if let Some(tx) = stage_tx.lock().unwrap().take() {
                let _ = tx.send(message.to_string());
            }
        })
    };
    let newer = tokio::spawn({
        let provisioner = provisioner.clone();
        let progress_b = progress_b.clone();
        async move { provisioner.ensure(Some(progress_b), None).await }
    });
    let first_stage = tokio::time::timeout(Duration::from_secs(30), stage_rx)
        .await
        .expect("the newer boot reached its first stage")
        .expect("stage signal");
    assert_eq!(first_stage, "Starting Python kernel...");
    // NOW the doomed boot settles (gate0 opens its handshake): whatever
    // it does to the shared progress state, the newer generation's
    // listener and replay stage must survive it.
    std::fs::write(gates.join("gate0"), "").unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(30), doomed)
        .await
        .expect("the doomed boot settled")
        .unwrap();
    assert!(
        settled.is_err(),
        "a boot doomed by kill() must settle as a failure"
    );
    // A late joiner of the NEWER boot replays its current stage to a
    // fresh handler: the doomed settle must not have wiped it.
    let (replay_tx, replay_rx) = tokio::sync::oneshot::channel();
    let replay_tx = Arc::new(Mutex::new(Some(replay_tx)));
    let progress_c: pa_core::kernel::bootstrap::KernelBootstrapProgressHandler =
        Arc::new(move |message| {
            if let Some(tx) = replay_tx.lock().unwrap().take() {
                let _ = tx.send(message.to_string());
            }
        });
    let joiner = tokio::spawn({
        let provisioner = provisioner.clone();
        let progress_c = progress_c.clone();
        async move { provisioner.ensure(Some(progress_c), None).await }
    });
    let replayed = tokio::time::timeout(Duration::from_secs(5), replay_rx)
        .await
        .expect("a late joiner must replay the active boot's stage")
        .expect("replay signal");
    assert_eq!(replayed, "Starting Python kernel...");
    // The killed generation's shared progress state died with the kill:
    // its joiner heard nothing after the kill (its one entry is the
    // pre-kill replay), and the newer boot's handler heard exactly its
    // own first stage - no stale replay of the killed boot's stage in
    // between.
    assert_eq!(
        *a_stages.lock().unwrap(),
        vec!["Starting Python kernel...".to_string()],
        "the killed generation's listener must not hear the newer boot"
    );
    assert_eq!(
        *b_stages.lock().unwrap(),
        vec![
            "Starting Python kernel...".to_string(),
            "Starting Python kernel...".to_string(),
        ],
        "the arming caller hears its own stage twice (fan-out + boot-local, the pre-existing main shape) and never the killed boot's stale replay first"
    );
    let a_settled = tokio::time::timeout(Duration::from_secs(30), a_joiner)
        .await
        .expect("the doomed generation's joiner settled")
        .unwrap();
    assert!(
        a_settled.is_err(),
        "a joiner of a killed boot must settle as a failure"
    );
    // Release the newer boot: it settles, serves, and the absolute spawn
    // count stays pinned - the doomed boot and the newer one, nothing
    // else.
    std::fs::write(gates.join("gate1"), "").unwrap();
    let manager = tokio::time::timeout(Duration::from_secs(30), newer)
        .await
        .expect("the newer boot settled")
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), joiner)
        .await
        .expect("the joiner settled")
        .unwrap()
        .unwrap();
    let result = manager
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
    assert_eq!(
        starts(&count),
        2,
        "the doomed boot and the newer boot, nothing else"
    );
}

/// A kernel interpreter wrapper whose FIRST invocation records the spawn
/// and fails fast (exit 1 before any handshake), while every later
/// invocation records the spawn and execs the real kernel Python: a
/// boot's first attempt fails retryably, and only a live generation's
/// retry may consume the second.
fn flaky_first_kernel(
    dir: &std::path::Path,
    python: &std::path::Path,
    count: &std::path::Path,
    flip: &std::path::Path,
    marker: &std::path::Path,
) -> PathBuf {
    let wrapper = dir.join("flaky-first-python");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf x >> '{}'\nif [ -f '{}' ]; then exec '{}' \"$@\"; fi\ntouch '{}' '{}'\nexit 1\n",
            count.display(),
            flip.display(),
            python.display(),
            flip.display(),
            marker.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    wrapper
}

/// A boot `kill()` invalidated must not RETRY: each attempt spawns an
/// interpreter and runs restore/bootstrap, and the doomed attempt's
/// settle only kills its kernel - the absolute spawn count pins that the
/// killed generation never consumed its retry after the backoff.
#[tokio::test]
async fn kill_during_the_retry_backoff_pins_the_spawn_count() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    std::fs::write(&count, "").unwrap();
    let flip = dir.path().join("flipped");
    let marker = dir.path().join("first-failed");
    let wrapped = flaky_first_kernel(dir.path(), &python, &count, &flip, &marker);
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(wrapped),
            ..Default::default()
        },
    );
    // Boot A's first attempt records its spawn and fails retryably.
    let doomed = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    tokio::time::timeout(Duration::from_secs(30), async {
        while !marker.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the first attempt failed fast");
    // The kill invalidates A's generation while A is still inside its
    // retry decision (the backoff window) - before it could retry.
    provisioner.kill();
    // Boot B (the newer generation) boots on the stable arm.
    let newer = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    let manager = tokio::time::timeout(Duration::from_secs(30), newer)
        .await
        .expect("the newer boot settled")
        .unwrap()
        .unwrap();
    // The doomed boot settles as a failure WITHOUT consuming its retry.
    let settled = tokio::time::timeout(Duration::from_secs(30), doomed)
        .await
        .expect("the doomed boot settled")
        .unwrap();
    assert!(settled.is_err(), "a killed boot settles as a failure");
    let result = manager
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
    assert_eq!(
        starts(&count),
        2,
        "the failed attempt and the newer boot, nothing else"
    );
}

/// A boot `kill()` invalidated must not report unavailable skills: the
/// callback shares the restore notice's mailbox, so a discarded kernel's
/// broken-import rows must not reach the next turn - while the LIVE
/// boot's report still must (the same bootstrap's broken import, the
/// same callback, exactly one report).
#[tokio::test]
async fn doomed_boot_does_not_report_unavailable_skills() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    std::fs::write(&count, "").unwrap();
    let gates = dir.path().join("gates");
    std::fs::create_dir_all(&gates).unwrap();
    let _release_gates = ReleaseGates(gates.clone());
    let wrapped = counting_gated_kernel(dir.path(), &python, &count, &gates);
    let reported: Arc<Mutex<Vec<pa_core::kernel::bootstrap::UnavailablePythonSkills>>> =
        Arc::new(Mutex::new(Vec::new()));
    let on_unavailable_skills = {
        let reported = Arc::clone(&reported);
        Arc::new(
            move |errors: &pa_core::kernel::bootstrap::UnavailablePythonSkills| {
                reported.lock().unwrap().push(errors.clone());
            },
        ) as pa_core::kernel::provisioner::UnavailableSkillsCallback
    };
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(wrapped),
            python_skills: vec![pa_core::kernel::bootstrap::KernelPythonSkill {
                name: "doomed-broken-skill".to_string(),
                import_name: "doomed_broken_skill".to_string(),
                package_path: PathBuf::from("/nonexistent/skill"),
                pyproject_path: PathBuf::from("/nonexistent/skill/pyproject.toml"),
            }],
            on_unavailable_skills: Some(on_unavailable_skills),
            ..Default::default()
        },
    );
    // Boot A spawns its interpreter held at gate0.
    let doomed = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    tokio::time::timeout(Duration::from_secs(30), async {
        while starts(&count) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the fixture interpreter spawned");
    // The kill invalidates A's generation while A is still settling.
    provisioner.kill();
    // Boot B arms fresh and spawns its own interpreter held at gate1.
    let newer = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    tokio::time::timeout(Duration::from_secs(30), async {
        while starts(&count) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the newer boot's interpreter spawned");
    // Release A: its bootstrap still parses its broken skill for a DEAD
    // generation - its report must not reach the mailbox.
    std::fs::write(gates.join("gate0"), "").unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(30), doomed)
        .await
        .expect("the doomed boot settled")
        .unwrap();
    assert!(settled.is_err(), "a killed boot settles as a failure");
    // Release B: the LIVE generation's report is the only one.
    std::fs::write(gates.join("gate1"), "").unwrap();
    let manager = tokio::time::timeout(Duration::from_secs(30), newer)
        .await
        .expect("the newer boot settled")
        .unwrap()
        .unwrap();
    let result = manager
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
    let reported = reported.lock().unwrap().clone();
    assert_eq!(
        reported.len(),
        1,
        "only the live generation reports unavailable skills: {reported:?}"
    );
    assert_eq!(
        reported[0],
        vec![(
            "doomed_broken_skill".to_string(),
            "No module named 'doomed_broken_skill'".to_string(),
        )],
        "the live boot's broken-import report"
    );
}
