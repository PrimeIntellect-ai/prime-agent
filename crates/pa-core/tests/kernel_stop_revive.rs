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
