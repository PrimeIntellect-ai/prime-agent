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

use pa_core::kernel::provisioner::{IpythonKernelProvisioner, IpythonKernelProvisionerOptions};
use pa_core::kernel::shared::{ExecuteOptions, ExecuteStatus, KernelShutdownOptions};

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
