// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Per-cell watchdog integration tests: spawn a real `python -m rlm.repl`
//! kernel and verify the watchdog teaches instead of killing. A cell that
//! outlives its budget still settles ok and keeps its own result, with the
//! teaching note appended to stderr; sub-budget cells, disabled budgets,
//! failed cells, and the kernel itself (namespace intact, process alive) are
//! untouched.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions, KernelSnapshotConfig,
};
use pa_core::kernel::state_snapshot::{manifest_path_in, snapshot_path_in};

/// The kernel Python with prime-agent-runtime installed. Ambient product
/// state, not test input: skipped (with a note) when absent;
/// `PA_CORE_KERNEL_PYTHON` points at an explicit interpreter instead.
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
        "kernel python {} not found; skipping live kernel test",
        candidate.display()
    );
    None
}

/// A started kernel manager, or `None` when no kernel interpreter is
/// available on this machine; the caller skips the test then. The watchdog
/// needs no RLM bootstrap: a bare `rlm.repl` kernel serves sleep cells.
async fn started_manager() -> Option<ReplKernelManager> {
    let python = kernel_python()?;
    let options = KernelManagerOptions {
        python: Some(python),
        cwd: Some(std::env::temp_dir()),
        env: HashMap::new(),
        session_id: Some("cell-watchdog-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        on_background_work_settled: None,
        snapshot: None,
        bootstrap_code: None,
        stderr_log_path: None,
    };
    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    Some(manager)
}

/// Execute one cell under the given watchdog budget (`None` or `0` disables).
async fn execute(
    manager: &ReplKernelManager,
    code: &str,
    cell_timeout_ms: Option<u64>,
) -> pa_core::kernel::shared::ExecuteResult {
    manager
        .execute(
            code,
            ExecuteOptions {
                cell_timeout_ms,
                ..ExecuteOptions::default()
            },
        )
        .await
        .expect("execute must not fail")
}

#[tokio::test]
async fn overage_cell_keeps_ok_with_the_watchdog_note_on_stderr() {
    let Some(manager) = started_manager().await else {
        return;
    };

    // Sub-budget cell: returns normally, result and stderr untouched.
    let quick = execute(
        &manager,
        "import time, sys\ntime.sleep(0.2)\n'quick'",
        Some(2000),
    )
    .await;
    assert_eq!(quick.status, ExecuteStatus::Ok);
    assert_eq!(quick.result.as_deref(), Some("'quick'"));
    assert!(quick.error.is_none());
    assert!(
        !quick.stderr.contains("[watchdog]"),
        "a sub-budget cell must carry no watchdog note"
    );

    // Staged ~5s cell under a 2s budget: the cell runs to completion and
    // keeps its ok status; the watchdog note is appended to stderr.
    let slow = execute(&manager, "time.sleep(5)\n'slow'", Some(2000)).await;
    assert_eq!(
        slow.status,
        ExecuteStatus::Ok,
        "a completed over-budget cell must not resolve as a failure: a \
         timeout-looking error invites a duplicate run of finished work"
    );
    assert!(slow.error.is_none());
    assert!(
        slow.stderr.contains("[watchdog]"),
        "the teaching note rides stderr: {}",
        slow.stderr
    );
    assert!(
        slow.stderr
            .contains("Cell exceeded the 2s python_repl budget"),
        "teaching text names the budget: {}",
        slow.stderr
    );
    assert!(
        slow.stderr.contains("Move long shell work to bash()"),
        "teaching text points at the real mechanism: {}",
        slow.stderr
    );
    // The cell's own outcome survives alongside the note.
    assert_eq!(slow.result.as_deref(), Some("'slow'"));
    assert!(
        slow.duration_ms >= 5000,
        "the cell itself ran to completion"
    );

    // A zero budget disables the watchdog: the same ~5s cell carries no note.
    let disabled = execute(&manager, "time.sleep(5)\n'disabled'", Some(0)).await;
    assert_eq!(disabled.status, ExecuteStatus::Ok);
    assert_eq!(disabled.result.as_deref(), Some("'disabled'"));
    assert!(!disabled.stderr.contains("[watchdog]"));

    // The kernel was never killed: the namespace from the first cells is intact.
    let alive = execute(&manager, "time is not None and sys.executable", None).await;
    assert_eq!(alive.status, ExecuteStatus::Ok);
    assert!(alive.result.is_some(), "kernel state survived the watchdog");

    manager
        .shutdown(pa_core::kernel::shared::KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn watchdog_noted_cell_still_schedules_the_snapshot() {
    let Some(python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let options = KernelManagerOptions {
        python: Some(python),
        cwd: Some(std::env::temp_dir()),
        env: HashMap::new(),
        session_id: Some("cell-watchdog-snapshot-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        on_background_work_settled: None,
        snapshot: Some(KernelSnapshotConfig {
            path: snapshot_path_in(dir.path()),
            manifest_path: manifest_path_in(dir.path()),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms: Some(100),
        }),
        bootstrap_code: None,
        stderr_log_path: None,
    };
    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");

    // The cell commits a variable but outruns a 500ms budget: the watchdog
    // appends its note, yet the cell completed ok in the kernel, so the
    // debounced namespace snapshot must still fire.
    let overage = execute(
        &manager,
        "import time\ntime.sleep(2)\nwatch_var = 'committed'",
        Some(500),
    )
    .await;
    assert_eq!(overage.status, ExecuteStatus::Ok);
    assert!(overage.stderr.contains("[watchdog]"));

    let snapshot = snapshot_path_in(dir.path());
    let mut flushed = false;
    for _ in 0..30 {
        let written =
            snapshot.exists() && std::fs::metadata(&snapshot).is_ok_and(|meta| meta.len() > 0);
        if written {
            flushed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        flushed,
        "the watchdog-flipped cell must still schedule the namespace snapshot"
    );

    manager
        .shutdown(pa_core::kernel::shared::KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn overage_error_cell_keeps_its_own_error() {
    let Some(manager) = started_manager().await else {
        return;
    };

    // A cell that FAILS after outrunning the budget keeps its own error:
    // the watchdog never fabricates a timeout over a real traceback, and
    // the failed cell carries no teaching note.
    let failed = execute(&manager, "import time\ntime.sleep(2.5)\n1/0", Some(1000)).await;
    assert_eq!(failed.status, ExecuteStatus::Error);
    let error = failed.error.expect("the cell's own error survives");
    assert_eq!(
        error.ename, "ZeroDivisionError",
        "the cell's own error wins"
    );
    assert!(
        !failed.stderr.contains("[watchdog]"),
        "a failed cell gets no watchdog note: {}",
        failed.stderr
    );

    manager
        .shutdown(pa_core::kernel::shared::KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn queue_wait_is_excluded_from_the_cell_budget() {
    let Some(manager) = started_manager().await else {
        return;
    };

    // A ~3s cell holds the serial execution queue; a fast cell enqueued
    // behind it measures its budget from its own wire write, not from its
    // enqueue, so its queue wait must not trip the watchdog.
    let slow_manager = manager.clone();
    let slow = tokio::spawn(async move {
        execute(&slow_manager, "import time\ntime.sleep(3)\n'slow'", Some(0)).await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let queued = execute(&manager, "'fast'", Some(2000)).await;
    // The queue wait (~2.8s) exceeds the 2s budget; the fast cell's own
    // run is instant, so it must resolve clean with no note.
    assert_eq!(queued.status, ExecuteStatus::Ok);
    assert!(
        !queued.stderr.contains("[watchdog]"),
        "queue wait must not trip the watchdog: {}",
        queued.stderr
    );
    let slow = slow.await.expect("slow cell join");
    assert_eq!(slow.status, ExecuteStatus::Ok);

    manager
        .shutdown(pa_core::kernel::shared::KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}
