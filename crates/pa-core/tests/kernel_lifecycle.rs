//! Verifier integration tests: spawn a real `python -m rlm.repl` kernel
//! (the same JSON-lines protocol v3 runtime the TS product ships) through
//! `ReplKernelManager`, and check the persistence/revival semantics against
//! the TS product's behavior contract:
//!
//! - state persists across cells and turns;
//! - kill -9 the kernel, restart a fresh manager on the same snapshot, and
//!   the namespace revives: serializable variables return, unserializable
//!   objects are dropped and reported;
//! - the RLM surface (rlm, bash, harness) injected by the bootstrap exists
//!   and host requests round-trip to the registered handler.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use pa_core::kernel::bootstrap::build_rlm_bootstrap_code;
use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions,
    KernelShutdownOptions, KernelSnapshotConfig,
};
use pa_core::kernel::state_snapshot::{manifest_path_in, snapshot_path_in};

/// The kernel Python with prime-agent-runtime installed. The TS product's
/// auto-bootstrapped kernel venv is the ground-truth environment; this is
/// exactly the interpreter `prime-agent` spawns.
///
/// The venv is ambient product state, not test input: it exists wherever a
/// TS product instance bootstrapped a kernel. Tests that need it are skipped
/// (with a note) rather than failing when it is absent, so the suite stays
/// hermetic on machines without a live install; set `PA_CORE_KERNEL_PYTHON`
/// to point at an explicit interpreter instead.
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

/// Test options, or `None` when no kernel interpreter is available on this
/// machine (see [`kernel_python`]); the caller skips the test then.
fn test_options(snapshot_dir: Option<&std::path::Path>) -> Option<KernelManagerOptions> {
    let python = kernel_python()?;
    Some(KernelManagerOptions {
        python: Some(python),
        cwd: Some(std::env::temp_dir()),
        env: HashMap::new(),
        session_id: Some("integration-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        snapshot: snapshot_dir.map(|dir| KernelSnapshotConfig {
            path: snapshot_path_in(dir),
            manifest_path: manifest_path_in(dir),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms: None,
        }),
        // The TS provisioner (ipython.ts) always builds and executes the RLM
        // bootstrap after start; tests match that contract.
        bootstrap_code: Some(build_rlm_bootstrap_code(&[])),
        stderr_log_path: None,
    })
}

/// Start a manager and run the RLM bootstrap, mirroring the TS provisioner
/// (ipython.ts: start, then `m.execute(bootstrapCode)` must be `ok`).
async fn started_manager(options: KernelManagerOptions) -> ReplKernelManager {
    let bootstrap = options
        .bootstrap_code
        .clone()
        .expect("tests always pass the RLM bootstrap");
    let manager = ReplKernelManager::new(options);
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let result = manager
        .execute(&bootstrap, ExecuteOptions::default())
        .await
        .expect("bootstrap execute must not fail");
    assert_eq!(
        result.status,
        ExecuteStatus::Ok,
        "rlm runtime bootstrap failed: {}",
        result.stderr
    );
    manager
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

#[tokio::test]
async fn kernel_state_persists_across_cells_and_turns() {
    let Some(options) = test_options(None) else {
        return;
    };
    let manager = started_manager(options).await;

    // One turn defines; a separate call (a later "turn") uses.
    let first = execute(&manager, "x = 21\ny = 'hello'\nprint('defined')").await;
    assert_eq!(first.status, ExecuteStatus::Ok);
    assert_eq!(first.stdout.trim(), "defined");
    assert_eq!(
        first.result, None,
        "assignment cells produce no trailing result"
    );

    let second = execute(&manager, "x * 2").await;
    assert_eq!(second.status, ExecuteStatus::Ok);
    assert_eq!(
        second.result.as_deref(),
        Some("42"),
        "trailing expression repr is captured"
    );

    // _ is bound to the last trailing expression value.
    let third = execute(&manager, "_ + 1").await;
    assert_eq!(third.result.as_deref(), Some("43"));

    // await works at top level across turns.
    let fourth = execute(
        &manager,
        "import asyncio\nresult = await asyncio.sleep(0, 'done')\nresult",
    )
    .await;
    assert_eq!(fourth.result.as_deref(), Some("'done'"));

    // Error cells report ename/evalue/traceback, and state survives them.
    let error = execute(&manager, "1 / 0").await;
    assert_eq!(error.status, ExecuteStatus::Error);
    let kernel_error = error.error.expect("error cell carries the kernel error");
    assert_eq!(kernel_error.ename, "ZeroDivisionError");
    assert!(!kernel_error.traceback.is_empty());
    let after = execute(&manager, "x").await;
    assert_eq!(after.result.as_deref(), Some("21"));

    let shutdown = manager.shutdown(KernelShutdownOptions::default()).await;
    assert!(shutdown.is_ok());
}

#[tokio::test]
async fn background_thread_output_is_separated_from_cell_output() {
    let Some(options) = test_options(None) else {
        return;
    };
    let manager = started_manager(options).await;
    // A user thread writing after its cell finished lands in background output.
    let first = execute(
        &manager,
        "import threading, time\ndef _bg():\n    time.sleep(0.3)\n    print('late from thread')\nt = threading.Thread(target=_bg); t.start()\nprint('from cell')",
    )
    .await;
    assert_eq!(first.stdout.trim(), "from cell");
    assert_eq!(first.status, ExecuteStatus::Ok);

    let second = execute(&manager, "time.sleep(0.5)").await;
    assert!(
        second
            .background_output
            .as_deref()
            .unwrap_or_default()
            .contains("late from thread"),
        "late thread output surfaces as background output, got {:?}",
        second.background_output
    );
    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn rlm_bootstrap_injects_the_kernel_surface() {
    let Some(base) = test_options(None) else {
        return;
    };
    let options = KernelManagerOptions {
        bootstrap_code: Some(build_rlm_bootstrap_code(&[])),
        ..base
    };
    let manager = started_manager(options).await;

    let result = execute(
        &manager,
        "callable(rlm.spawn) and callable(rlm.find_models) and hasattr(rlm, 'harness') and callable(bash) and hasattr(rlm, 'get_harness_state')",
    )
    .await;
    assert_eq!(
        result.status,
        ExecuteStatus::Ok,
        "bootstrap must bind the RLM surface"
    );
    assert_eq!(
        result.result.as_deref(),
        Some("True"),
        "rlm/bash/harness must be usable"
    );

    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn host_requests_round_trip_to_registered_handlers() {
    let mut handlers = HostRequestHandlers::new();
    handlers.register(
        "rlm.find_models",
        pa_core::kernel::shared::host_handler(|payload| async move {
            assert_eq!(payload.data["query"], "glm");
            assert_eq!(payload.data["limit"], 2);
            Ok(serde_json::json!({
                "models": [
                    {"provider": "pi", "id": "glm-5.3", "name": "GLM", "selector": "pi/glm-5.3"}
                ]
            }))
        }),
    );
    let Some(base) = test_options(None) else {
        return;
    };
    let options = KernelManagerOptions {
        host_handlers: handlers,
        bootstrap_code: Some(build_rlm_bootstrap_code(&[])),
        ..base
    };
    let manager = started_manager(options).await;

    // rlm.find_models runs through the runtime's host_request bridge; the
    // host reply must reach the awaiting cell.
    let result = execute(
        &manager,
        "result = await rlm.find_models('glm', 2)\nresult[0].selector",
    )
    .await;
    assert_eq!(result.status, ExecuteStatus::Ok, "cell: {:?}", result.error);
    assert_eq!(result.result.as_deref(), Some("'pi/glm-5.3'"));

    // An unregistered request type fails the cell with the TS error text.
    let error = execute(
        &manager,
        "import rlm\nawait rlm.host_request('nope.custom', {})",
    )
    .await;
    assert_eq!(error.status, ExecuteStatus::Error);
    // The runtime raises the host-reply error inside the awaiting cell: it
    // surfaces as the cell's KernelError (evalue), not as stderr.
    let message = error
        .error
        .as_ref()
        .map(|kernel_error| kernel_error.evalue.as_str())
        .unwrap_or_default();
    assert!(
        message.contains("not available in this session"),
        "expected the TS unavailable-handler error, got stderr {:?} error {:?}",
        error.stderr,
        error.error
    );

    manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn kill9_then_restart_revives_snapshot_and_reports_unserializable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };
    let manager = started_manager(options).await;

    // Serializable variables plus one unserializable object (an open socket)
    // across separate turns.
    execute(
        &manager,
        "answer = 42\nitems = ['a', 'b']\nimport socket\nconn = socket.socket()",
    )
    .await;
    execute(&manager, "answer += 0").await; // second turn touches the namespace

    // Flush a snapshot so the namespace is durable before the kill.
    let snapshot = tokio::time::timeout(Duration::from_secs(15), manager.snapshot_state())
        .await
        .expect("snapshot must settle")
        .expect("snapshot must run while the kernel is up");
    assert!(
        snapshot.saved.contains(&"answer".to_string()),
        "saved: {:?}",
        snapshot.saved
    );
    assert!(
        snapshot.skipped.iter().any(|skip| skip.name == "conn"),
        "an open socket must be skipped and reported, got: {:?}",
        snapshot.skipped
    );

    let pid = manager.process_id().expect("kernel pid");
    assert!(pid > 0);
    // kill -9 the kernel process, like a host OOM/infra kill.
    pa_core::platform::process::kill_pid(pid as i32, pa_core::platform::process::Signal::Kill);
    // The manager observes the death and goes defunct.
    for _ in 0..100 {
        if manager.is_defunct() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(manager.is_defunct(), "killed kernel must settle defunct");

    // Restart-and-revive: a fresh manager on the same snapshot directory.
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };
    let revived = started_manager(options).await;
    let restore = tokio::time::timeout(Duration::from_secs(15), revived.restore_state())
        .await
        .expect("restore must settle");
    let restore = restore.expect("restore must run");
    assert!(
        restore.restored.contains(&"answer".to_string())
            && restore.restored.contains(&"items".to_string()),
        "restored: {:?}",
        restore.restored
    );
    // TS semantics (state-snapshot.ts): `failed` names are entries present in
    // the snapshot that failed to revive. `conn` was skipped at snapshot time,
    // so it is absent from the payload and cannot appear here; its
    // drop-and-report already happened in `snapshot.skipped` above.

    // The revived values match the pre-kill values.
    let check = execute(&revived, "answer").await;
    assert_eq!(check.result.as_deref(), Some("42"));
    let items = execute(&revived, "items").await;
    assert_eq!(items.result.as_deref(), Some("['a', 'b']"));
    // The unserializable name is gone from the namespace.
    let missing = execute(&revived, "'conn' in dir()").await;
    assert_eq!(
        missing.result.as_deref(),
        Some("False"),
        "conn must be dropped"
    );

    revived
        .shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        })
        .await
        .expect("shutdown");
}

#[tokio::test]
async fn graceful_shutdown_flushes_the_final_snapshot() {
    let dir = tempfile::tempdir().expect("tempdir");
    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };
    let manager = started_manager(options).await;
    execute(&manager, "persisted = 'value'\n").await;

    // shutdown({snapshot: true}) must flush the namespace without an
    // explicit snapshot call.
    let performed = tokio::time::timeout(
        Duration::from_secs(15),
        manager.shutdown(KernelShutdownOptions {
            snapshot: true,
            drain_host_requests: true,
        }),
    )
    .await
    .expect("shutdown must settle");
    assert!(performed.expect("shutdown result"));

    let Some(options) = test_options(Some(dir.path())) else {
        return;
    };
    let revived = started_manager(options).await;
    let restore = revived
        .restore_state()
        .await
        .expect("restore after graceful shutdown");
    assert!(
        restore.restored.contains(&"persisted".to_string()),
        "graceful shutdown must persist the namespace, got {:?}",
        restore.restored
    );
    revived
        .shutdown(KernelShutdownOptions::default())
        .await
        .expect("shutdown");
}
