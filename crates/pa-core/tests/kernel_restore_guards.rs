//! Verifier integration tests for the restore-path guards (TS #2471 + #2478):
//!
//! - a restored `__main__` function runs against the LIVE namespace: a
//!   global redefined after the restore wins, and a name the saved function
//!   references but the snapshot never saved resolves once defined (the
//!   live-globals revival; pre-fix the function kept its frozen snapshot
//!   globals and the late name raised NameError);
//! - the debounced auto-snapshot that follows a restore skips while the
//!   namespace is unchanged (identical rewrite, no churn) and captures again
//!   after a real cell changes it;
//! - a failed restore keeps the on-disk payload the fresher copy: the
//!   debounced post-bootstrap snapshot skips AND the dispose flush (a
//!   `snapshot: true` shutdown) cannot clobber it with a skills-only
//!   namespace.
//!
//! The kernel Python is ambient product state like `kernel_lifecycle.rs`:
//! skipped with a note when absent; `PA_CORE_KERNEL_PYTHON` points at an
//! explicit interpreter.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use pa_core::kernel::bootstrap::build_rlm_bootstrap_code;
use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions,
    KernelShutdownOptions, KernelSnapshotConfig,
};
use pa_core::kernel::state_snapshot::{manifest_path_in, snapshot_path_in};

fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_CORE_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_CORE_KERNEL_PYTHON {explicit:?} not found"
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(
        std::env::var("HOME")
            .map(|home| format!("{home}/.prime/agent/kernel-venv/bin/python"))
            .unwrap_or_else(|_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string()),
    );
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live restore test");
    None
}

/// Options with a snapshot dir; `None` (skip) when no kernel interpreter is
/// available. `debounce_ms` shortens the auto-snapshot window in tests.
fn test_options(
    snapshot_dir: Option<&Path>,
    debounce_ms: Option<u64>,
) -> Option<KernelManagerOptions> {
    let python = kernel_python()?;
    Some(KernelManagerOptions {
        python: Some(python),
        cwd: Some(std::env::temp_dir()),
        env: HashMap::new(),
        session_id: Some("restore-guards-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        snapshot: snapshot_dir.map(|dir| KernelSnapshotConfig {
            path: snapshot_path_in(dir),
            manifest_path: manifest_path_in(dir),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms,
        }),
        bootstrap_code: Some(build_rlm_bootstrap_code(&[])),
        stderr_log_path: None,
    })
}

async fn execute(
    manager: &ReplKernelManager,
    code: &str,
) -> pa_core::kernel::shared::ExecuteResult {
    let result = manager
        .execute(code, ExecuteOptions::default())
        .await
        .expect("execute must not fail");
    result
}

fn file_bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).expect("read file")
}

/// Wait out the debounced auto-snapshot window.
async fn wait_out_debounce(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

#[tokio::test]
async fn restored_functions_run_against_live_namespace_globals() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let Some(writer_options) = test_options(Some(dir.path()), None) else {
        return;
    };

    let writer = ReplKernelManager::new(writer_options);
    writer
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(
        &writer,
        "G = 1\ndef reader():\n    return G\ndef prober():\n    return late",
    )
    .await;
    assert_eq!(defined.status, ExecuteStatus::Ok);
    let snapshot = writer.snapshot_state().await.expect("snapshot");
    assert!(snapshot.saved.iter().any(|name| name == "reader"));
    writer.kill().await;

    // A fresh kernel on the same snapshot: the restore revives the saved
    // functions against the live namespace of THIS kernel.
    let Some(reader_options) = test_options(Some(dir.path()), None) else {
        return;
    };
    let reader = ReplKernelManager::new(reader_options);
    reader
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let restore = reader.restore_state().await.expect("restore");
    assert!(restore.restored.iter().any(|name| name == "reader"));
    assert!(restore.restored.iter().any(|name| name == "prober"));

    // A global redefined after the restore wins over the frozen value the
    // saved function captured at snapshot time (pre-fix this returned 1).
    let live = execute(&reader, "G = 2\nreader()").await;
    assert_eq!(
        live.status,
        ExecuteStatus::Ok,
        "reader cell: {:?}",
        live.stderr
    );
    assert_eq!(live.result.as_deref(), Some("2"));

    // A name the saved function references but the snapshot never saved
    // resolves once defined in the live namespace (pre-fix: NameError).
    let late = execute(&reader, "late = 'live'\nprober()").await;
    assert_eq!(
        late.status,
        ExecuteStatus::Ok,
        "prober cell: {:?}",
        late.error.map(|e| e.evalue)
    );
    assert_eq!(late.result.as_deref(), Some("'live'"));

    let shutdown = reader.shutdown(KernelShutdownOptions::default()).await;
    assert!(shutdown.is_ok());
}

#[tokio::test]
async fn post_restore_auto_snapshot_skips_until_a_real_cell_changes_the_namespace() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let snapshot_path = snapshot_path_in(dir.path());
    let manifest_path = manifest_path_in(dir.path());

    let Some(writer_options) = test_options(Some(dir.path()), None) else {
        return;
    };
    let writer = ReplKernelManager::new(writer_options);
    writer
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&writer, "restored_var = 'from-disk'").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);
    let _ = writer
        .shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        })
        .await;
    assert!(
        snapshot_path.exists(),
        "the dispose flush wrote the payload"
    );
    assert!(
        manifest_path.exists(),
        "the dispose flush wrote the manifest"
    );

    // Production order (the provisioner): restore, then the bootstrap
    // (whose execution schedules the debounced snapshot), then the arm.
    let Some(reader_options) = test_options(Some(dir.path()), Some(50)) else {
        return;
    };
    let reader = ReplKernelManager::new(reader_options);
    reader
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let restore = reader.restore_state().await.expect("restore");
    assert!(restore.restored.iter().any(|name| name == "restored_var"));

    let bootstrap_code = build_rlm_bootstrap_code(&[]);
    let bootstrap = reader
        .execute(&bootstrap_code, ExecuteOptions::default())
        .await
        .expect("bootstrap execute must not fail");
    assert_eq!(bootstrap.status, ExecuteStatus::Ok);
    reader.mark_restored_namespace_fresh();

    // The debounced snapshot scheduled by the bootstrap must skip: the
    // payload and manifest are byte-identical to what the restore read.
    let payload_before = file_bytes(&snapshot_path);
    let manifest_before = file_bytes(&manifest_path);
    wait_out_debounce(400).await;
    assert_eq!(
        file_bytes(&snapshot_path),
        payload_before,
        "the unchanged namespace must not be re-snapshotted"
    );
    assert_eq!(file_bytes(&manifest_path), manifest_before);

    // A real cell changes the namespace: the next debounced snapshot runs and
    // carries both variables.
    let changed = execute(&reader, "user_var = 7").await;
    assert_eq!(changed.status, ExecuteStatus::Ok);
    wait_out_debounce(400).await;
    let manifest: serde_json::Value =
        serde_json::from_slice(&file_bytes(&manifest_path)).expect("manifest json");
    let saved = manifest
        .get("savedNames")
        .and_then(|names| names.as_array())
        .expect("savedNames");
    let names: Vec<&str> = saved.iter().filter_map(|name| name.as_str()).collect();
    assert!(names.contains(&"restored_var"));
    assert!(names.contains(&"user_var"));

    let shutdown = reader.shutdown(KernelShutdownOptions::default()).await;
    assert!(shutdown.is_ok());
}

#[tokio::test]
async fn failed_restore_keeps_the_on_disk_payload_through_the_debounced_snapshot() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let snapshot_path = snapshot_path_in(dir.path());
    let manifest_path = manifest_path_in(dir.path());
    // An unloadable payload takes the same failed-restore branch as a timeout
    // (TS #2478's test): nothing the kernel can do makes it load.
    std::fs::write(&snapshot_path, b"not-a-snapshot").expect("write bad payload");

    let Some(reader_options) = test_options(Some(dir.path()), Some(50)) else {
        return;
    };
    let reader = ReplKernelManager::new(reader_options);
    reader
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    assert!(
        reader.restore_state().await.is_none(),
        "the unloadable payload must fail the restore"
    );

    // Production order: a cell (here a plain pass instead of the full
    // bootstrap), then the arm. The first execute also reprovisions (the
    // failed restore left pending_restore set): the re-attempt fails again,
    // falls back to an empty namespace, and hands the flush duty back —
    // which is exactly why the debounced snapshot needs its own guard.
    let pass = execute(&reader, "pass").await;
    assert_eq!(pass.status, ExecuteStatus::Ok);
    reader.mark_restored_namespace_fresh();

    // The debounced auto-snapshot must skip: the on-disk payload is still the
    // fresher copy of the namespace the restore never delivered.
    wait_out_debounce(400).await;
    assert_eq!(
        file_bytes(&snapshot_path),
        b"not-a-snapshot".to_vec(),
        "the debounced snapshot must not clobber the on-disk payload"
    );
    assert!(
        !manifest_path.exists(),
        "no manifest may be written for a skipped snapshot"
    );

    let shutdown = reader.shutdown(KernelShutdownOptions::default()).await;
    assert!(shutdown.is_ok());
}

#[tokio::test]
async fn failed_restore_keeps_the_on_disk_payload_through_the_dispose_flush() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let snapshot_path = snapshot_path_in(dir.path());
    let manifest_path = manifest_path_in(dir.path());
    std::fs::write(&snapshot_path, b"not-a-snapshot").expect("write bad payload");

    let Some(options) = test_options(Some(dir.path()), Some(50)) else {
        return;
    };
    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    assert!(
        manager.restore_state().await.is_none(),
        "the unloadable payload must fail the restore"
    );

    // No cell runs between the failed restore and the dispose: the flush's
    // pending_restore guard (armed by the failed restore itself) is the only
    // thing standing between the skills-only namespace and the payload.
    let _ = manager
        .shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        })
        .await;
    assert_eq!(
        file_bytes(&snapshot_path),
        b"not-a-snapshot".to_vec(),
        "the dispose flush must not clobber the on-disk payload"
    );
    assert!(
        !manifest_path.exists(),
        "no manifest may be written by the guarded dispose flush"
    );
}
