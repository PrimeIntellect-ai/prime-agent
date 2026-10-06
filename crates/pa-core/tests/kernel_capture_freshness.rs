//! Verifier integration tests for the capture-freshness memo: while nothing settled since the last
//! committed capture and nothing replaced the committed manifest, the kernel's full-namespace
//! re-dump is skipped. The kernel Python is ambient product state; skipped when absent.
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
        "kernel python {} not found; skipping live capture-freshness test",
        candidate.display()
    );
    None
}

/// Options with a snapshot dir; `None` (skip) when no kernel interpreter is available.
fn test_options(snapshot_dir: Option<&Path>) -> Option<KernelManagerOptions> {
    let python = kernel_python()?;
    Some(KernelManagerOptions {
        python: Some(python),
        cwd: Some(std::env::temp_dir()),
        env: HashMap::new(),
        session_id: Some("capture-freshness-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        snapshot: snapshot_dir.map(|dir| KernelSnapshotConfig {
            path: snapshot_path_in(dir),
            manifest_path: manifest_path_in(dir),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms: None,
        }),
        bootstrap_code: Some(build_rlm_bootstrap_code(&[])),
        stderr_log_path: None,
        on_background_work_settled: None,
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

#[tokio::test]
async fn fresh_capture_skips_until_a_settled_cell_changes_the_namespace() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let manifest_path = manifest_path_in(dir.path());
    let payload_path = snapshot_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&manager, "alpha = 1\nbeta = \"x\" * 1024").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);

    let first = manager.snapshot_state().await.expect("first capture");
    assert!(first.saved.iter().any(|name| name == "alpha"));
    let first_manifest = file_bytes(&manifest_path);
    let first_payload = file_bytes(&payload_path);

    // The fresh window: no execution settled since the commit, so the next
    // capture replays the committed result.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let skipped = manager.snapshot_state().await.expect("fresh capture");
    assert_eq!(skipped, first, "the fresh capture replays the commit");
    assert_eq!(
        file_bytes(&manifest_path),
        first_manifest,
        "a fresh capture must not rewrite the manifest"
    );
    assert_eq!(
        file_bytes(&payload_path),
        first_payload,
        "a fresh capture must not rewrite the payload"
    );

    // The served path in the other direction: a settled cell changes the
    // namespace, so the next capture MUST re-dump it.
    let changed = execute(&manager, "alpha = 2").await;
    assert_eq!(changed.status, ExecuteStatus::Ok);
    let redumped = manager
        .snapshot_state()
        .await
        .expect("capture after a cell");
    assert!(redumped.saved.iter().any(|name| name == "alpha"));
    assert_ne!(
        file_bytes(&manifest_path),
        first_manifest,
        "a changed namespace must be re-dumped"
    );

    // The re-dumped payload restores the changed value, not the memo's
    // stale one (the crash-resume freshness contract).
    manager.kill();
    let Some(reader_options) = test_options(Some(dir.path())) else {
        return;
    };
    let reader = ReplKernelManager::new(reader_options);
    reader
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let restore = reader.restore_state().await.expect("restore");
    assert!(restore.restored.iter().any(|name| name == "alpha"));
    let live = execute(&reader, "alpha").await;
    assert_eq!(
        live.status,
        ExecuteStatus::Ok,
        "alpha cell: {:?}",
        live.stderr
    );
    assert_eq!(live.result.as_deref(), Some("2"));
    reader.kill();
}

#[tokio::test]
async fn prune_capture_runs_while_over_cap_survivors_live_then_skips_back_to_back() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let manifest_path = manifest_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    // `big` exceeds the 16MiB per-variable cap: the non-pruning capture
    // skips it (a live over-cap survivor).
    let defined = execute(&manager, "big = \"x\" * (16 * 1024 * 1024 + 1)\nsmall = 1").await;
    assert_eq!(
        defined.status,
        ExecuteStatus::Ok,
        "cell: {:?}",
        defined.stderr
    );

    let committed = manager.snapshot_state().await.expect("capture");
    assert!(
        committed
            .skipped
            .iter()
            .any(|skip| skip.name == "big"
                && skip.reason == "exceeds per-variable snapshot size cap"),
        "big must be skipped over-cap: {:?}",
        committed.skipped
    );
    assert!(committed.saved.iter().any(|name| name == "small"));

    // The pruning capture must NOT skip: `big` is a live over-cap survivor,
    // so the prune removes it and reports it — the #227 notice semantics.
    let pruned = manager
        .prune_oversized_variables()
        .await
        .expect("prune capture");
    assert_eq!(
        pruned.pruned.as_deref(),
        Some(std::slice::from_ref(&"big".to_string())),
        "the pruning capture must remove the live over-cap survivor"
    );

    // Back-to-back: nothing settled since the pruning commit and no live
    // over-cap survivor remains, so the second pruning capture is fresh.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let after_prune = file_bytes(&manifest_path);
    let fresh_prune = manager
        .prune_oversized_variables()
        .await
        .expect("fresh prune capture");
    assert_eq!(
        fresh_prune.pruned, None,
        "the fresh prune reports nothing left to prune"
    );
    assert!(
        fresh_prune.saved.iter().any(|name| name == "small"),
        "the fresh prune replays the committed saved list"
    );
    assert_eq!(
        file_bytes(&manifest_path),
        after_prune,
        "the fresh pruning capture must not rewrite the manifest"
    );

    // The first prune really removed `big` from the live namespace (this
    // check settles a cell, so it must come after the fresh-skip oracle).
    let gone = execute(&manager, "big").await;
    assert_ne!(
        gone.status,
        ExecuteStatus::Ok,
        "big must be gone from the namespace"
    );
    manager.kill();
}

#[tokio::test]
async fn dispose_flush_skips_when_fresh_and_still_restores() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let manifest_path = manifest_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&manager, "value = \"before-exit\"").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);

    let committed = manager.snapshot_state().await.expect("capture");
    assert!(committed.saved.iter().any(|name| name == "value"));
    let before_exit = file_bytes(&manifest_path);

    let shutdown = manager
        .shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        })
        .await;
    assert!(shutdown.is_ok());
    assert_eq!(
        file_bytes(&manifest_path),
        before_exit,
        "the fresh dispose flush must not rewrite the manifest"
    );

    // The crash-resume contract: the committed payload still revives the
    // exact namespace a fresh flush would have written.
    let Some(reader_options) = test_options(Some(dir.path())) else {
        return;
    };
    let reader = ReplKernelManager::new(reader_options);
    reader
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let restore = reader.restore_state().await.expect("restore");
    assert!(restore.restored.iter().any(|name| name == "value"));
    let live = execute(&reader, "value").await;
    assert_eq!(
        live.status,
        ExecuteStatus::Ok,
        "value cell: {:?}",
        live.stderr
    );
    assert_eq!(live.result.as_deref(), Some("'before-exit'"));
    reader.kill();
}

#[tokio::test]
async fn dispose_flush_dumps_after_a_settled_cell() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let manifest_path = manifest_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&manager, "value = \"committed\"").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);
    let committed = manager.snapshot_state().await.expect("capture");
    assert!(committed.saved.iter().any(|name| name == "value"));
    let committed_manifest = file_bytes(&manifest_path);

    let changed = execute(&manager, "value = \"final\"").await;
    assert_eq!(changed.status, ExecuteStatus::Ok);
    let shutdown = manager
        .shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        })
        .await;
    assert!(shutdown.is_ok());
    assert_ne!(
        file_bytes(&manifest_path),
        committed_manifest,
        "the dispose flush must re-dump after a settled cell"
    );

    let Some(reader_options) = test_options(Some(dir.path())) else {
        return;
    };
    let reader = ReplKernelManager::new(reader_options);
    reader
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    reader.restore_state().await.expect("restore");
    let live = execute(&reader, "value").await;
    assert_eq!(
        live.status,
        ExecuteStatus::Ok,
        "value cell: {:?}",
        live.stderr
    );
    assert_eq!(live.result.as_deref(), Some("'final'"));
    reader.kill();
}

#[tokio::test]
async fn an_externally_replaced_manifest_defeats_the_fresh_skip() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let manifest_path = manifest_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&manager, "alpha = 1").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);
    let committed = manager.snapshot_state().await.expect("capture");
    assert!(committed.saved.iter().any(|name| name == "alpha"));

    std::fs::write(&manifest_path, "{\"version\": 1, \"savedNames\": []}").expect("write");
    let redumped = manager.snapshot_state().await.expect("capture");
    assert!(redumped.saved.iter().any(|name| name == "alpha"));
    assert_ne!(
        file_bytes(&manifest_path),
        b"{\"version\": 1, \"savedNames\": []}" as &[u8],
        "the capture must commit a fresh manifest over the external one"
    );
    manager.kill();
}

#[tokio::test]
async fn an_internal_state_request_does_not_defeat_the_fresh_skip() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let manifest_path = manifest_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&manager, "alpha = 1").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);
    let committed = manager.snapshot_state().await.expect("capture");
    assert!(committed.saved.iter().any(|name| name == "alpha"));
    let committed_manifest = file_bytes(&manifest_path);

    // The compact-time namespace listing settles like any request but never
    // changes the namespace: a fresh window capture after it is still fresh.
    let names = manager.list_namespace_names(None).await.expect("listing");
    assert!(names.iter().any(|name| name == "alpha"));

    tokio::time::sleep(Duration::from_millis(5)).await;
    let skipped = manager
        .snapshot_state()
        .await
        .expect("capture after the listing");
    assert_eq!(skipped, committed, "the listing must not defeat the memo");
    assert_eq!(
        file_bytes(&manifest_path),
        committed_manifest,
        "the capture after an internal listing must not rewrite the manifest"
    );
    manager.kill();
}

#[tokio::test]
async fn an_internal_execute_that_writes_a_user_variable_defeats_the_memo() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let manifest_path = manifest_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&manager, "alpha = 1").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);
    let committed = manager.snapshot_state().await.expect("capture");
    assert!(committed.saved.iter().any(|name| name == "alpha"));
    let committed_manifest = file_bytes(&manifest_path);

    // An INTERNAL execute that writes a user name (the bootstrap class is the product's
    // internal-execute shape): the settle must end the memo's description.
    let internal = manager
        .execute(
            "late_from_internal = 42",
            ExecuteOptions {
                internal: true,
                ..ExecuteOptions::default()
            },
        )
        .await
        .expect("internal execute");
    assert_eq!(
        internal.status,
        ExecuteStatus::Ok,
        "cell: {:?}",
        internal.stderr
    );

    tokio::time::sleep(Duration::from_millis(5)).await;
    let redumped = manager
        .snapshot_state()
        .await
        .expect("capture after the internal cell");
    assert_ne!(
        file_bytes(&manifest_path),
        committed_manifest,
        "an internal execute that writes a user name must defeat the memo"
    );
    assert!(
        redumped
            .saved
            .iter()
            .any(|name| name == "late_from_internal"),
        "the internal write must be persisted"
    );

    manager.kill();
    let Some(reader_options) = test_options(Some(dir.path())) else {
        return;
    };
    let reader = ReplKernelManager::new(reader_options);
    reader
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    reader.restore_state().await.expect("restore");
    let live = execute(&reader, "late_from_internal").await;
    assert_eq!(
        live.status,
        ExecuteStatus::Ok,
        "late_from_internal cell: {:?}",
        live.stderr
    );
    assert_eq!(live.result.as_deref(), Some("42"));
    reader.kill();
}

#[tokio::test]
async fn a_restore_settle_clears_the_memo() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let manifest_path = manifest_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&manager, "value = 'committed'").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);
    let committed = manager.snapshot_state().await.expect("capture");
    assert!(committed.saved.iter().any(|name| name == "value"));
    let committed_manifest = file_bytes(&manifest_path);

    // A restore replaces the namespace wholesale: its settle ends the memo's description. The next
    // capture must re-dump even when the restored namespace happens to equal the committed one.
    let restore = manager.restore_state().await.expect("restore");
    assert!(restore.restored.iter().any(|name| name == "value"));

    tokio::time::sleep(Duration::from_millis(5)).await;
    let redumped = manager
        .snapshot_state()
        .await
        .expect("capture after the restore");
    assert_ne!(
        file_bytes(&manifest_path),
        committed_manifest,
        "a restore settle must clear the memo"
    );
    assert!(
        redumped.saved.iter().any(|name| name == "value"),
        "the capture after the restore re-describes the namespace"
    );
    manager.kill();
}

#[tokio::test]
async fn an_externally_replaced_payload_defeats_the_fresh_skip() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let payload_path = snapshot_path_in(dir.path());
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let defined = execute(&manager, "alpha = 1").await;
    assert_eq!(defined.status, ExecuteStatus::Ok);
    let committed = manager.snapshot_state().await.expect("capture");
    assert!(committed.saved.iter().any(|name| name == "alpha"));

    // An external actor replaces the committed PAYLOAD while the manifest (the bookkeeping file)
    // stands: the witness covers the payload itself — the file a later restore actually reads.
    std::fs::write(&payload_path, b"externally replaced").expect("write");
    let redumped = manager.snapshot_state().await.expect("capture");
    assert!(
        redumped.saved.iter().any(|name| name == "alpha"),
        "the capture must re-dump over the replaced payload"
    );
    let restored_bytes = file_bytes(&payload_path);
    assert_ne!(
        restored_bytes, b"externally replaced" as &[u8],
        "the capture must commit a fresh payload over the external one"
    );
    manager.kill();
}

#[tokio::test]
async fn concurrent_settles_keep_the_boundary_invariant() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };

    let manager = std::sync::Arc::new(ReplKernelManager::new(options));
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let seeded = execute(&manager, "v = 0").await;
    assert_eq!(seeded.status, ExecuteStatus::Ok);
    let committed = manager.snapshot_state().await.expect("capture");
    assert!(committed.saved.iter().any(|name| name == "v"));

    // Cells and captures race for a bounded window (the settle-race class: a cell settling between
    // a consult's count sample and its decision). The final on-disk payload must revive the LAST
    // SETTLED namespace — a capture may legitimately skip when a concurrent capture already
    // committed that exact namespace, so the assertion is on the restored value.
    let writer = {
        let manager = manager.clone();
        tokio::spawn(async move {
            for i in 1..40 {
                let cell = execute(&manager, &format!("v = {i}")).await;
                assert_eq!(cell.status, ExecuteStatus::Ok);
            }
        })
    };
    let reader = {
        let manager = manager.clone();
        tokio::spawn(async move {
            for _ in 0..20 {
                let _ = manager.snapshot_state().await;
            }
        })
    };
    writer.await.expect("writer task");
    reader.await.expect("reader task");

    let boundary = manager.snapshot_state().await.expect("boundary capture");
    assert!(
        boundary.saved.iter().any(|name| name == "v"),
        "the boundary capture describes the namespace"
    );
    let shutdown = manager
        .shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        })
        .await;
    assert!(shutdown.is_ok());

    let Some(reader_options) = test_options(Some(dir.path())) else {
        return;
    };
    let revived = ReplKernelManager::new(reader_options);
    revived
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let restore = revived.restore_state().await.expect("restore");
    assert!(restore.restored.iter().any(|name| name == "v"));
    let live = execute(&revived, "v").await;
    assert_eq!(live.status, ExecuteStatus::Ok, "v cell: {:?}", live.stderr);
    assert_eq!(
        live.result.as_deref(),
        Some("39"),
        "the persisted payload must carry the LAST settled value through every racing capture"
    );
    revived.kill();
}
