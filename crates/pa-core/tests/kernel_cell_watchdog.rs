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
//! outlives its budget resolves as a `CellTimeout` error carrying the
//! teaching text; sub-budget cells, disabled budgets, and the kernel itself
//! (namespace intact, process alive) are untouched.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::PathBuf;

use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions,
};

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
async fn overage_cell_resolves_as_timeout_error_with_teaching_text() {
    let Some(manager) = started_manager().await else {
        return;
    };

    // Sub-budget cell: returns normally, result untouched.
    let quick = execute(
        &manager,
        "import time, sys\ntime.sleep(0.2)\n'quick'",
        Some(2000),
    )
    .await;
    assert_eq!(quick.status, ExecuteStatus::Ok);
    assert_eq!(quick.result.as_deref(), Some("'quick'"));
    assert!(quick.error.is_none());

    // Staged ~5s cell under a 2s budget: the cell runs to completion, then
    // the watchdog annotates its result as a CellTimeout teaching error.
    let slow = execute(&manager, "time.sleep(5)\n'slow'", Some(2000)).await;
    assert_eq!(
        slow.status,
        ExecuteStatus::Error,
        "an over-budget cell must not resolve as a quiet success"
    );
    let error = slow.error.expect("overage cell carries the watchdog error");
    assert_eq!(error.ename, "CellTimeout");
    assert!(
        error.evalue.contains("Cell exceeded 2s"),
        "teaching text names the budget: {}",
        error.evalue
    );
    assert!(
        error.evalue.contains("kernel state is preserved"),
        "teaching text preserves the kernel claim: {}",
        error.evalue
    );
    assert!(
        error
            .evalue
            .contains("Run long work via bash() so it can auto-background."),
        "teaching text points at bash(): {}",
        error.evalue
    );
    // The cell's own outcome survives alongside the annotation.
    assert_eq!(slow.result.as_deref(), Some("'slow'"));
    assert!(
        slow.duration_ms >= 5000,
        "the cell itself ran to completion"
    );

    // A zero budget disables the watchdog: the same ~5s cell stays ok.
    let disabled = execute(&manager, "time.sleep(5)\n'disabled'", Some(0)).await;
    assert_eq!(disabled.status, ExecuteStatus::Ok);
    assert_eq!(disabled.result.as_deref(), Some("'disabled'"));
    assert!(disabled.error.is_none());

    // The kernel was never killed: the namespace from the first cells is intact.
    let alive = execute(&manager, "time is not None and sys.executable", None).await;
    assert_eq!(alive.status, ExecuteStatus::Ok);
    assert!(alive.result.is_some(), "kernel state survived the watchdog");

    manager
        .shutdown(pa_core::kernel::shared::KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}
