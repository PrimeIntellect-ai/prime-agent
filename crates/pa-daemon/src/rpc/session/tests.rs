//! A same-path reopen builds the replacement engine before the replaced kernel's
//! dispose flushes its final snapshot into the shared artifact dir: the reopened
//! session must still revive that final namespace.

use std::path::Path;
use std::sync::Arc;

use pa_core::kernel::provisioner::{IpythonKernelProvisioner, KernelReadyGate};
use pa_core::kernel::shared::ExecuteOptions;
use pa_core::session::manager::SessionManager;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};

use super::{RpcEngineFactory, RpcEngineHandle, RpcEngineRequest, RpcSession};
use crate::rpc::LineWriter;
use crate::test_support::{live_kernel_python, KernelEnvOverride};

async fn engine_handle(
    cwd: &Path,
    agent_dir: &Path,
    manager: SessionManager,
    kernel_ready_gate: Option<KernelReadyGate>,
) -> RpcEngineHandle {
    let model = pa_agent::types::Model {
        id: "reopen-test".into(),
        name: "Reopen test".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    };
    let provider = Arc::new(pa_agent::scripted::ScriptedProvider::new(model.clone()));
    let engine = create_session(SessionEngineConfig {
        cwd: cwd.to_path_buf(),
        agent_dir: agent_dir.to_path_buf(),
        model: Some(model.clone()),
        stream_fn: Some(provider.stream_fn()),
        session_manager: Some(manager),
        kernel_ready_gate,
        ..Default::default()
    })
    .await
    .expect("the engine builds");
    RpcEngineHandle {
        engine: Arc::new(engine),
        model: pa_types::ai::Model {
            id: model.id,
            name: model.name,
            api: model.api,
            provider: model.provider,
            base_url: model.base_url,
            reasoning: false,
            thinking_level_map: None,
            input: vec![pa_types::ai::ModelInput::Text],
            cost: pa_types::ai::ModelCost {
                input: pa_types::JsNumber::from(0.0),
                output: pa_types::JsNumber::from(0.0),
                cache_read: pa_types::JsNumber::from(0.0),
                cache_write: pa_types::JsNumber::from(0.0),
            },
            context_window: 1_000,
            max_tokens: 100,
            max_tokens_explicit: false,
            featured: None,
            serving: None,
            headers: None,
            compat: None,
        },
        api_key: None,
        provider_target: Arc::default(),
        bash_wake: Arc::default(),
        session_lease: None,
    }
}

fn provisioner(handle: &RpcEngineHandle) -> Arc<IpythonKernelProvisioner> {
    handle
        .engine
        .kernel_provisioner_weak()
        .upgrade()
        .expect("the engine owns its provisioner")
}

fn mkfifo(path: &Path) {
    let status = std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .expect("mkfifo runs");
    assert!(status.success());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_same_path_reopen_revives_the_replaced_kernels_final_namespace() {
    let Some(python) = live_kernel_python() else {
        return;
    };
    let _env = KernelEnvOverride::apply(&[(
        "PRIME_AGENT_KERNEL_PYTHON",
        Some(python.display().to_string()),
    )]);
    let dir = tempfile::tempdir().expect("tempdir");
    let cwd = dir.path().join("project");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions").join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&session_dir).unwrap();

    let mut manager = SessionManager::persisted(&cwd, &session_dir);
    manager.flush_now().expect("the session file exists");
    let session_path = manager
        .get_session_file()
        .expect("a persisted session has a file")
        .to_path_buf();
    let mut old = engine_handle(&cwd, &agent_dir, manager, None).await;
    old.session_lease = Some(
        crate::lease::acquire_runtime_session_lease(&session_path, &agent_dir)
            .expect("the session lease"),
    );

    // x = 1 reaches the on-disk snapshot; x = 2 lives only in the old kernel: its cell
    // holds until released, so no debounced snapshot carries it before the final flush.
    let kernel = provisioner(&old).ensure(None, None).await.expect("kernel");
    let first = kernel.execute("x = 1", ExecuteOptions::default()).await;
    assert!(first.is_ok());
    assert!(
        kernel.snapshot_state().await.is_some(),
        "x = 1 is snapshotted"
    );
    let entered = dir.path().join("entered");
    let release = dir.path().join("release");
    mkfifo(&entered);
    mkfifo(&release);
    let cell = format!(
        "x = 2\nopen({entered:?}, 'w').close()\nimport asyncio\nawait asyncio.to_thread(lambda: open({release:?}).read())"
    );
    let held = tokio::spawn({
        let kernel = kernel.clone();
        async move { kernel.execute(&cell, ExecuteOptions::default()).await }
    });
    tokio::task::spawn_blocking(move || std::fs::read(entered).expect("the cell entered"))
        .await
        .unwrap();

    let factory: RpcEngineFactory = Arc::new({
        let cwd = cwd.clone();
        let agent_dir = agent_dir.clone();
        let session_dir = session_dir.clone();
        move |request| {
            let cwd = cwd.clone();
            let agent_dir = agent_dir.clone();
            let session_dir = session_dir.clone();
            let release = release.clone();
            Box::pin(async move {
                let RpcEngineRequest::Open {
                    session_path,
                    ready_gate,
                    ..
                } = request
                else {
                    return Err("only the reopen is expected".to_string());
                };
                let gate = ready_gate
                    .ok_or_else(|| "a same-path reopen carries a ready gate".to_string())?;
                let (entered_tx, entered) = tokio::sync::oneshot::channel();
                let entered_tx = Arc::new(std::sync::Mutex::new(Some(entered_tx)));
                let observed: KernelReadyGate = Arc::new(move || {
                    if let Some(tx) = entered_tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    gate()
                });
                let manager = SessionManager::open(&cwd, &session_dir, &session_path);
                let handle = engine_handle(&cwd, &agent_dir, manager, Some(observed)).await;
                // The replacement's resume prewarm either restores or waits on the gate
                // before the factory returns.
                let replacement = provisioner(&handle);
                tokio::select! {
                    restored = replacement.ensure(None, None) => {
                        restored.map_err(|error| format!("{error:#}"))?;
                    }
                    _ = entered => {}
                }
                tokio::task::spawn_blocking(move || std::fs::write(release, "go"))
                    .await
                    .unwrap()
                    .map_err(|error| error.to_string())?;
                Ok(handle)
            })
        }
    });
    let session = RpcSession::adopt(old, Some(factory), LineWriter::spawn()).await;
    session
        .replace_locked(RpcEngineRequest::Open {
            session_path,
            reuse_lease: false,
            ready_gate: None,
        })
        .await
        .expect("the same-path reopen succeeds");
    let _ = held.await;

    let revived = provisioner(&*session.handle().await)
        .ensure(None, None)
        .await
        .expect("the reopened kernel");
    let x = revived
        .execute("x", ExecuteOptions::default())
        .await
        .expect("x evaluates");
    assert_eq!(
        x.result.as_deref(),
        Some("2"),
        "the reopened session revived a namespace older than the replaced kernel's final flush"
    );
}
