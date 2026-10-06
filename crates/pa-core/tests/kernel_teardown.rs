// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Verifier integration tests for kernel process teardown on drop: a session or harness that boots
//! a kernel and then drops its handles must not leave the `python -m rlm.repl` process alive. The
//! kernel Python is ambient product state; skipped when absent.
#![cfg(unix)]

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// The tests share one process (the process-table scans must see only the current test's kernel),
/// so this std lock serializes them (the only contenders).
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn test_lock() -> MutexGuard<'static, ()> {
    TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The kernel Python with prime-agent-runtime installed; set
/// `PA_CORE_KERNEL_PYTHON` to point at an explicit interpreter instead.
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
    let home = std::env::var("HOME").unwrap_or_default();
    let candidate = PathBuf::from(format!("{home}/.prime/agent/kernel-venv/bin/python"));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live teardown test",
        candidate.display()
    );
    None
}

/// True while a live (non-zombie) process with this pid exists.
fn process_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|raw| {
            // pid (comm) state ...
            let close = raw.rfind(')')?;
            raw[close + 1..]
                .trim_start()
                .chars()
                .next()
                .map(|state| state != 'Z' && state != 'X')
        })
        .unwrap_or(false)
}

/// Poll until the pid leaves the live-process table (teardown kills are synchronous, but the kernel
/// may be mid-boot when its owner drops, so the settle budget covers the boot finishing first).
async fn await_process_gone(pid: i32) {
    let deadline = Instant::now() + Duration::from_mins(1);
    while process_alive(pid) {
        assert!(
            Instant::now() < deadline,
            "kernel pid {pid} outlived the drop of its owner (teardown gap)"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Every live `python -m rlm.repl` child of this process (the session-path
/// test finds its kernel this way, without reaching into engine internals).
fn own_kernel_processes() -> Vec<i32> {
    let me = std::process::id();
    let mut found = Vec::new();
    let entries = std::fs::read_dir("/proc").unwrap_or_else(|e| panic!("read /proc: {e}"));
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some(close) = stat.rfind(')') else {
            continue;
        };
        let mut fields = stat[close + 1..].split_whitespace();
        let Some(state) = fields.next() else {
            continue;
        };
        let Some(parent_pid) = fields.next().and_then(|raw| raw.parse::<u32>().ok()) else {
            continue;
        };
        if parent_pid == me && state != "Z" && state != "X" {
            let Ok(cmdline) = std::fs::read_to_string(format!("/proc/{pid}/cmdline")) else {
                continue;
            };
            if cmdline.contains("rlm.repl") {
                found.push(pid as i32);
            }
        }
    }
    found
}

/// Start a manager and run the RLM bootstrap, mirroring the TS provisioner
/// contract (start, then the bootstrap cell must be `ok`).
async fn started_manager(
    options: pa_core::kernel::shared::KernelManagerOptions,
) -> pa_core::kernel::manager::ReplKernelManager {
    let bootstrap = options
        .bootstrap_code
        .clone()
        .expect("tests always pass the RLM bootstrap");
    let manager = pa_core::kernel::manager::ReplKernelManager::new(options);
    manager
        .start(pa_core::kernel::manager::KernelStartOptions::default())
        .await
        .expect("kernel must start");
    let result = manager
        .execute(
            &bootstrap,
            pa_core::kernel::shared::ExecuteOptions::default(),
        )
        .await
        .expect("bootstrap execute must not fail");
    assert_eq!(
        result.status,
        pa_core::kernel::shared::ExecuteStatus::Ok,
        "rlm runtime bootstrap failed: {}",
        result.stderr
    );
    manager
}

fn test_options() -> Option<pa_core::kernel::shared::KernelManagerOptions> {
    let python = kernel_python()?;
    Some(pa_core::kernel::shared::KernelManagerOptions {
        python: Some(python),
        cwd: Some(std::env::temp_dir()),
        env: std::collections::HashMap::default(),
        session_id: Some("teardown-test".to_string()),
        host_handlers: pa_core::kernel::shared::HostRequestHandlers::default(),
        python_skills: Vec::new(),
        on_background_work_settled: None,
        snapshot: None,
        bootstrap_code: Some(pa_core::kernel::bootstrap::build_rlm_bootstrap_code(&[])),
        stderr_log_path: None,
    })
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn manager_drop_kills_the_kernel_process() {
    let _guard = test_lock();
    let Some(options) = test_options() else {
        return;
    };
    let manager = started_manager(options).await;
    let pid = manager.process_id().expect("kernel pid");
    drop(manager);
    await_process_gone(pid).await;
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn provisioner_drop_kills_the_kernel_process() {
    let _guard = test_lock();
    let Some(python) = kernel_python() else {
        return;
    };
    let options = pa_core::kernel::provisioner::IpythonKernelProvisionerOptions {
        python: Some(python),
        ..Default::default()
    };
    let provisioner = pa_core::kernel::provisioner::IpythonKernelProvisioner::new("/tmp", options);
    let manager = provisioner
        .ensure(None, None)
        .await
        .expect("kernel must boot");
    let pid = manager.process_id().expect("kernel pid");
    drop(manager);
    drop(provisioner);
    await_process_gone(pid).await;
}

/// The session-engine path a fixture actually uses: `create_session` with
/// the prewarm flag boots a kernel in the background; found via the
/// process table, so the test exercises the public session surface.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn session_engine_drop_kills_the_prewarmed_kernel_process() {
    let _guard = test_lock();
    let Some(_kernel_python) = kernel_python() else {
        return;
    };

    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");

    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(100_000),
                max_tokens: Some(4_096),
            }]),
            ..Default::default()
        });
    let model = registration.get_model();
    let stream_fn = pa_core::session_engine::provider_adapter::real_stream_fn(None, model.clone());
    let agent_model: pa_agent::types::Model =
        pa_core::session_engine::provider_adapter::json_round_trip(&model)
            .expect("model conversion");

    let engine = pa_core::session_engine::engine::create_session(
        pa_core::session_engine::engine::SessionEngineConfig {
            cron_store: None,
            steering_mode: None,
            follow_up_mode: None,
            cwd: cwd.clone(),
            agent_dir: agent_dir.clone(),
            model: Some(agent_model),
            stream_fn: Some(stream_fn),
            tools: Vec::new(),
            prewarm_ipython_kernel: Some(true),
            ..Default::default()
        },
    )
    .await
    .expect("create the prewarmed session");

    // The prewarm boot is background: wait for the kernel child to appear.
    let deadline = Instant::now() + Duration::from_mins(2);
    loop {
        let kernels = own_kernel_processes();
        if let Some(pid) = kernels.first() {
            // Drop the engine (and with it the provisioner chain) while the
            // boot is settling: teardown must cover this drop too.
            drop(engine);
            let pid = *pid;
            await_process_gone(pid).await;
            assert!(
                own_kernel_processes().is_empty(),
                "the dropped session left extra kernel processes behind"
            );
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the prewarmed kernel never spawned"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The explicit dispose seam: a host that keeps the engine object but ends the session (the daemon
/// worker's shape) must be able to take the kernel down without dropping the engine.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn engine_dispose_kernel_kills_the_prewarmed_kernel_process() {
    let _guard = test_lock();
    let Some(_kernel_python) = kernel_python() else {
        return;
    };

    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");

    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(100_000),
                max_tokens: Some(4_096),
            }]),
            ..Default::default()
        });
    let model = registration.get_model();
    let stream_fn = pa_core::session_engine::provider_adapter::real_stream_fn(None, model.clone());
    let agent_model: pa_agent::types::Model =
        pa_core::session_engine::provider_adapter::json_round_trip(&model)
            .expect("model conversion");

    let engine = pa_core::session_engine::engine::create_session(
        pa_core::session_engine::engine::SessionEngineConfig {
            cron_store: None,
            steering_mode: None,
            follow_up_mode: None,
            cwd,
            agent_dir,
            model: Some(agent_model),
            stream_fn: Some(stream_fn),
            tools: Vec::new(),
            prewarm_ipython_kernel: Some(true),
            ..Default::default()
        },
    )
    .await
    .expect("create the prewarmed session");

    let deadline = Instant::now() + Duration::from_mins(2);
    loop {
        if let Some(pid) = own_kernel_processes().first() {
            let pid = *pid;
            engine.dispose_kernel().await;
            await_process_gone(pid).await;
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the prewarmed kernel never spawned"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
