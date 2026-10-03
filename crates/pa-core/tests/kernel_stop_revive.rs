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

//! Verifier integration tests for the revivable kernel stop (TS #2483's
//! `stopKernel`): a snapshot-flushing stop that keeps the provisioner
//! usable, so a settled child's kernel releases without ending the
//! session — the next `ensure()` boots a fresh kernel that serves the
//! flushed namespace (the port's `stop_kernel`, the TS inline arm).
//!
//! The kernel Python is ambient product state (the auto-bootstrapped
//! kernel venv); like `kernel_snapshot_resume.rs`, these tests skip
//! (with a note) on machines without a live install so the suite stays
//! hermetic elsewhere. `PA_CORE_KERNEL_PYTHON` points at an explicit
//! interpreter.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_core::kernel::provisioner::{IpythonKernelProvisioner, IpythonKernelProvisionerOptions};
use pa_core::kernel::shared::{
    host_handler, ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelShutdownOptions,
};

/// The kernel Python with prime-agent-runtime installed (see
/// `kernel_snapshot_resume.rs`); skipped with a note when absent.
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
        "kernel python {} not found; skipping live stop-revive test",
        candidate.display()
    );
    None
}

/// `stop_kernel` stays revivable (TS `stopKernel()` stays revivable): the
/// stop flushes the snapshot and releases the kernel, the next `ensure()`
/// boots a fresh kernel, and the revived namespace still serves the
/// variables the flush carried — while `dispose` was never called.
#[tokio::test]
async fn stop_kernel_flushes_the_snapshot_and_the_next_ensure_revives_it() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let artifacts = dir.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(python),
            snapshot_dir: Some(artifacts.clone()),
            ..Default::default()
        },
    );
    let first = provisioner.ensure(None, None).await.unwrap();
    let written = first
        .execute("marker = 2483", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(written.status, ExecuteStatus::Ok);
    // The stop flushes the snapshot and releases the kernel without
    // disposing the provisioner (the settled-child release arm).
    provisioner
        .stop_kernel(Some(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        }))
        .await;
    assert!(
        provisioner.manager().is_none(),
        "the stop released the kernel"
    );
    assert!(
        artifacts.join("kernel-state.dill").exists(),
        "the stop flushed the namespace snapshot"
    );
    // The revival: a fresh kernel boots and serves the flushed namespace.
    let revived = provisioner.ensure(None, None).await.unwrap();
    let check = revived
        .execute("marker", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(check.status, ExecuteStatus::Ok);
    assert_eq!(check.result.as_deref(), Some("2483"));
}

/// An idle stop is a no-op (no kernel, no snapshot churn) and a second
/// stop supersedes the first (TS `pendingStop` last-writer-wins): the
/// provisioner stays revivable either way.
#[tokio::test]
async fn stop_kernel_without_a_kernel_is_a_no_op_and_stays_revivable() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let artifacts = dir.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(python),
            snapshot_dir: Some(artifacts),
            ..Default::default()
        },
    );
    // No kernel ever booted: the stop releases nothing and errors nothing.
    provisioner
        .stop_kernel(Some(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        }))
        .await;
    assert!(provisioner.manager().is_none());
    // The provisioner still boots and serves.
    let manager = provisioner.ensure(None, None).await.unwrap();
    let result = manager
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
}

/// A revival must not start or restore while its predecessor is still
/// draining host work in `stop_kernel()`. The held request gives an exact
/// ordering barrier rather than relying on timing of the snapshot flush.
#[tokio::test]
async fn revival_waits_for_in_flight_stop_before_booting() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let artifacts = dir.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let entered_tx = Arc::new(Mutex::new(Some(entered_tx)));
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let mut handlers = HostRequestHandlers::new();
    handlers.register(
        "rlm.find_models",
        host_handler({
            let entered_tx = Arc::clone(&entered_tx);
            move |_| {
                let entered_tx = Arc::clone(&entered_tx);
                let mut release_rx = release_rx.clone();
                async move {
                    let entered = { entered_tx.lock().unwrap().take() };
                    if let Some(tx) = entered {
                        let _ = tx.send(());
                        let _ = release_rx.wait_for(|released| *released).await;
                    }
                    Ok(serde_json::json!({"models": []}))
                }
            }
        }),
    );
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(python),
            snapshot_dir: Some(artifacts.clone()),
            host_handlers: handlers,
            ..Default::default()
        },
    );
    let first = provisioner.ensure(None, None).await.unwrap();
    let first_cell = tokio::spawn(async move {
        first
            .execute("await rlm.find_models('hold')", ExecuteOptions::default())
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), entered_rx)
        .await
        .expect("host request must enter before stop")
        .expect("host request signal");
    let stop = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.stop_kernel(None).await }
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        while provisioner.manager().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("stop claimed the prior manager");
    // Records, at the revival's first boot stage, whether the held host
    // request had been released yet; `waiting` fires once the revival is
    // parked on the predecessor-stop gate.
    let boot_saw_release = Arc::new(Mutex::new(None::<bool>));
    let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
    let waiting_tx = Arc::new(Mutex::new(Some(waiting_tx)));
    let progress: pa_core::kernel::bootstrap::KernelBootstrapProgressHandler = Arc::new({
        let boot_saw_release = Arc::clone(&boot_saw_release);
        let released = Arc::clone(&released);
        move |message| match message {
            "Waiting for the previous kernel to stop..." => {
                if let Some(tx) = waiting_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
            "Starting Python kernel..." => {
                boot_saw_release
                    .lock()
                    .unwrap()
                    .get_or_insert(released.load(std::sync::atomic::Ordering::SeqCst));
            }
            _ => {}
        }
    });
    let revival = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(Some(progress), None).await }
    });
    tokio::time::timeout(Duration::from_secs(10), waiting_rx)
        .await
        .expect("revival boot must park on the predecessor-stop gate")
        .expect("waiting signal");
    assert!(
        boot_saw_release.lock().unwrap().is_none(),
        "revival boot crossed the predecessor-stop gate"
    );
    released.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = release_tx.send(true);
    tokio::time::timeout(Duration::from_secs(15), stop)
        .await
        .expect("stop settled after releasing host work")
        .unwrap();
    let revived = tokio::time::timeout(Duration::from_secs(15), revival)
        .await
        .expect("revival settled after stop")
        .unwrap()
        .unwrap();
    assert_eq!(
        *boot_saw_release.lock().unwrap(),
        Some(true),
        "revival boot started only after the stop's held host request was released"
    );
    let result = revived
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
    let _ = first_cell.await;
}

/// Two concurrent `stop_kernel` calls on one in-flight boot must share the
/// first stop's gate: the second stop used to arm its own gate, and the
/// stop task that LOST the manager take opened it before the winner's
/// final snapshot flush - un-gating a revival to race that flush over the
/// same on-disk file. The observable is drain-structural, not timed: on
/// the single-threaded test runtime the winner's shutdown chain suspends
/// at its first await, so a loser that opened its own gate (and the stop
/// that armed it) completes within the boot's own settle drain - before
/// the first drain boundary after the settle; a joined gate holds the
/// second stop until the winner completes.
#[tokio::test]
async fn concurrent_stops_of_one_in_flight_boot_share_one_gate() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let artifacts = dir.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(python),
            snapshot_dir: Some(artifacts),
            ..Default::default()
        },
    );
    let boot = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    // Both stops enter while the boot is in flight: spawned after the boot
    // task, they observe the memo it installs (the single-threaded test
    // runtime polls them FIFO), long before the boot can settle.
    let first_stop = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.stop_kernel(None).await }
    });
    let second_stop = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.stop_kernel(None).await }
    });
    // The boot settles (the park, the publish, the takes, and the loser's
    // early gate open all run in one scheduler drain; this loop resumes at
    // the first drain boundary after them). The winner's shutdown chain
    // provably suspends at its first await, so at this boundary the second
    // stop may already be done ONLY if it opened its own gate in the
    // settle drain - a joined gate holds it until the winner completes.
    tokio::time::timeout(Duration::from_secs(30), async {
        while !boot.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the boot settled");
    assert!(
        !second_stop.is_finished(),
        "the second stop completed in the boot's settle drain: it opened its          own gate instead of joining the first stop's"
    );
    // The revival joins the pending-stop gate the stops armed.
    let revival = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    let revived = tokio::time::timeout(Duration::from_secs(30), revival)
        .await
        .expect("revival settled")
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), first_stop)
        .await
        .expect("the first stop settled")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), second_stop)
        .await
        .expect("the second stop settled")
        .unwrap();
    let result = revived
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
}

/// A stop armed for one boot, a `kill()`, a revival boot gated on that
/// stop's gate, and a second stop of the REVIVED boot: the second stop
/// supersedes the first stop's gate (the two arms are for different
/// boots), and the first stop's task - which loses the manager take -
/// must wait a strictly OLDER gate, never the currently-installed one.
/// Waiting the installed gate deadlocks: the first stop waits the second
/// stop's gate, which waits the revival's boot, which waits the FIRST
/// stop's gate (a cycle with no drain boundary left to cross). The
/// oracle is the settle itself, bounded: every task must settle within
/// the timeouts on the chained-gate shape; the cycle shape wedges
/// against the first bounded await. The absolute spawn count stays pinned
/// at two: nothing in the chain may arm a third interpreter.
#[tokio::test]
async fn superseding_stop_after_kill_cannot_deadlock_the_revival_gate() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    let wrapped = counting_kernel(dir.path(), &python, &count);
    let artifacts = dir.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(wrapped),
            snapshot_dir: Some(artifacts),
            ..Default::default()
        },
    );
    // Boot one, and observe it mid-flight through its first progress
    // stage (the memo is armed; the stage precedes the interpreter spawn,
    // and the handshake runs for seconds after it).
    let (stage_tx, stage_rx) = tokio::sync::oneshot::channel();
    let stage_tx = Arc::new(Mutex::new(Some(stage_tx)));
    let progress: pa_core::kernel::bootstrap::KernelBootstrapProgressHandler =
        Arc::new(move |message| {
            if !message.starts_with("Waiting for the previous kernel to stop") {
                if let Some(tx) = stage_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        });
    let doomed = tokio::spawn({
        let provisioner = provisioner.clone();
        let progress = progress.clone();
        async move { provisioner.ensure(Some(progress), None).await }
    });
    tokio::time::timeout(Duration::from_secs(30), stage_rx)
        .await
        .expect("the first boot reached its first stage")
        .expect("stage signal");
    // The first stop arms its gate for that boot (nothing to join yet);
    // one scheduler poll runs the stop task to its first await, past the
    // arm.
    let first_stop = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.stop_kernel(None).await }
    });
    tokio::task::yield_now().await;
    // The kill invalidates the boot's memo generation (TS kill() clears
    // managerPromise): the doomed boot still settles, but against no memo.
    provisioner.kill();
    // The revival boots fresh and parks on the first stop's gate.
    let revival = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.ensure(None, None).await }
    });
    tokio::task::yield_now().await;
    // A stop of the REVIVED boot supersedes the first stop's gate (its
    // arm is for the newer memo, so the same-boot JOIN does not apply).
    let second_stop = tokio::spawn({
        let provisioner = provisioner.clone();
        async move { provisioner.stop_kernel(None).await }
    });
    tokio::task::yield_now().await;
    // The doomed boot settles (its failure publishes to its own memo's
    // waiters); nothing here can wedge.
    let settled = tokio::time::timeout(Duration::from_secs(30), doomed)
        .await
        .expect("the doomed boot settled")
        .unwrap();
    assert!(
        settled.is_err(),
        "a boot doomed by kill() must settle as a failure"
    );
    // THE ORACLE: the first stop must settle too. On the cycle shape its
    // take-loser waits the currently-installed gate - the second stop's
    // gate - which waits the revival's boot, which waits the FIRST
    // stop's gate: the await below times out. On the chained-gate shape
    // the loser waits only the gate its own arm replaced (none here), its
    // gate opens, the revival parks, the second stop settles, all within
    // the bound.
    tokio::time::timeout(Duration::from_secs(30), first_stop)
        .await
        .expect("the first stop settled (no wait cycle)")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), second_stop)
        .await
        .expect("the second stop settled")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), revival)
        .await
        .expect("the revival settled")
        .unwrap()
        .unwrap();
    // The second stop took and shut down the revived kernel (it stopped
    // the NEW boot); the provisioner must be fully revivable after the
    // cycle: a fresh ensure boots a third interpreter and serves.
    assert!(provisioner.manager().is_none());
    assert!(!provisioner.has_running_kernel());
    let fresh = tokio::time::timeout(Duration::from_secs(30), provisioner.ensure(None, None))
        .await
        .expect("a fresh ensure booted after the cycle")
        .unwrap();
    let result = fresh
        .execute("1 + 1", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.status, ExecuteStatus::Ok);
    assert_eq!(
        starts(&count),
        3,
        "the doomed boot, the revival, the fresh boot - nothing else"
    );
}

/// A kernel interpreter wrapper that counts spawns into `count` before
/// exec'ing the real kernel Python (see `kernel_startup_memo.rs`), so a
/// test can pin exactly how many kernels were armed.
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
