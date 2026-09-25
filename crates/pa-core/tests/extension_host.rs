//! Extension host integration tests (design doc stage-1 verifier): real
//! `node`, no network, no TS product. The bundled host script proves the
//! spawn/handshake/ping/shutdown path end-to-end; the fixture script
//! (`tests/fixtures/extension_host_fixture.mjs`) drives the reverse ctx
//! direction and the mid-session death paths.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures::future::BoxFuture;
use futures::FutureExt;
use pa_core::extensions::{
    CtxCall, CtxCallHandler, ExtensionHost, ExtensionHostSpec, HostScript, HostTimeouts,
    SidecarNotification,
};
use pa_types::extension_rpc::{ExtensionError, RpcError};
use serde_json::{json, Value};

/// The `node` binary, or None when the box has no Node (tests skip; the
/// stage-1 verifier runs where node exists).
fn node_binary() -> Option<PathBuf> {
    let output = std::process::Command::new("node").arg("--version").output();
    let output = output.ok()?;
    let version = String::from_utf8(output.stdout).ok()?;
    let major: u32 = version
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()?;
    if major >= 18 {
        Some(PathBuf::from("node"))
    } else {
        None
    }
}

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/extension_host_fixture.mjs")
}

fn test_timeouts() -> HostTimeouts {
    HostTimeouts {
        hello: Duration::from_secs(20),
        rpc: Duration::from_secs(5),
        shutdown_wait: Duration::from_secs(5),
    }
}

fn spec(node: &Path, script: HostScript) -> ExtensionHostSpec {
    let mut spec = ExtensionHostSpec::new(std::env::temp_dir(), std::env::temp_dir());
    spec.node = node.to_path_buf();
    spec.script = script;
    spec.timeouts = test_timeouts();
    spec
}

struct TestCtx;

impl CtxCallHandler for TestCtx {
    fn handle(&self, call: CtxCall) -> BoxFuture<'static, Result<Value, RpcError>> {
        async move {
            match call.method.as_str() {
                "get_system_prompt" => Ok(json!({"systemPrompt": "test prompt"})),
                other => Err(RpcError::message(format!(
                    "test ctx: unknown method {other}"
                ))),
            }
        }
        .boxed()
    }
}

#[tokio::test]
async fn bundled_script_handshake_ping_shutdown() -> Result<()> {
    let Some(node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let agent_dir = tempfile::tempdir()?;
    let mut start_spec = spec(&node, HostScript::Bundled);
    start_spec.agent_dir = agent_dir.path().to_path_buf();
    let host = ExtensionHost::start(start_spec).await?;
    assert!(host.is_alive());
    assert!(host.pid().is_some());

    let pong = host.ping().await?;
    assert_eq!(pong, json!({"ok": true}));

    host.shutdown("test end").await?;
    Ok(())
}

#[tokio::test]
async fn fixture_ctx_roundtrip_notification_and_shutdown() -> Result<()> {
    let Some(node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let mut start_spec = spec(&node, HostScript::At(fixture_script()));
    start_spec.ctx_handler = Some(Arc::new(TestCtx) as Arc<dyn CtxCallHandler>);
    let mut host = ExtensionHost::start(start_spec).await?;

    // The fixture reports an extension_error notification during hello.
    match host.take_notifications().recv().await {
        Some(SidecarNotification::ExtensionError(ExtensionError {
            extension_path,
            event,
            error,
            ..
        })) => {
            assert_eq!(extension_path, "fixture.ts");
            assert_eq!(event, "session_start");
            assert_eq!(error, "fixture diagnostic");
        }
        other => panic!("expected ExtensionError notification, got {other:?}"),
    }

    // ping answers with the ctx round-trip result from the Rust handler.
    let pong = host.ping().await?;
    assert_eq!(pong, json!({"systemPrompt": "test prompt"}));

    host.shutdown("test end").await?;
    Ok(())
}

#[tokio::test]
async fn kill9_mid_session_fails_pending_requests() -> Result<()> {
    let Some(node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let mut start_spec = spec(&node, HostScript::At(fixture_script()));
    start_spec.extension_paths = vec!["mode:hang".to_string()];
    let host = ExtensionHost::start(start_spec).await?;

    let event = host.emit_event("session_start", json!({}));
    let pid = host.pid().expect("live sidecar has a pid");
    assert!(pa_core::platform::kill_pid(
        pid as i32,
        pa_core::platform::Signal::Kill
    ));

    let error = event.await.unwrap_err();
    // The pending request can fail through either transport arm after
    // the kill: the death watcher's tracked reason ("extension sidecar
    // stopped"), or the RPC write racing the dying pipe (the write error
    // — the pipe died BECAUSE of the kill). Both shapes prove the kill9
    // propagation; the ordering flips under load.
    let rendered = error.to_string();
    assert!(
        rendered.contains("extension sidecar stopped")
            || rendered.contains("write extension RPC request"),
        "death reason missing: {rendered}"
    );
    assert!(!host.is_alive());

    // Shutdown on a dead sidecar still reaps the child without error.
    host.shutdown("after kill").await?;
    Ok(())
}

#[tokio::test]
async fn sidecar_exit_fails_pending_requests_with_death_reason() -> Result<()> {
    let Some(node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let mut start_spec = spec(&node, HostScript::At(fixture_script()));
    start_spec.extension_paths = vec!["mode:die".to_string()];
    let host = ExtensionHost::start(start_spec).await?;

    let error = host
        .emit_event("session_start", json!({}))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("extension sidecar stopped"),
        "death reason missing: {error}"
    );
    assert!(!host.is_alive());
    host.shutdown("after death").await?;
    Ok(())
}
