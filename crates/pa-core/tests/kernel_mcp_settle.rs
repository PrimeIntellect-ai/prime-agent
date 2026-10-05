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

//! Verifier for the input-latency lane's kernel/MCP posture (the operator
//! rulings of 2026-10-03: "kernel spawns eagerly at startup, fully
//! background; nothing user-visible waits; kernel-needing ops await the
//! in-flight boot handle robustly" and "MCP spawn/settle also non-blocking
//! for time-to-textbox; eager background spawn, joined only at first use"),
//! driven in-process through `create_session` against a REAL kernel:
//!
//! - a kernel-needing op that arrives while the eager boot is still in
//!   flight waits for that boot and then succeeds (the join memo: one
//!   boot, never a second build);
//! - the configured generic MCP servers settle in the BACKGROUND once the
//!   kernel is up — the server process spawns with no user use anywhere
//!   (red on a lane-less tree: nothing else opens it) — and the FIRST
//!   use, issued while the settle's open is still in flight, waits for
//!   that open and succeeds instead of erroring.
#![cfg(unix)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pa_agent::scripted::{tool_call_turn_steps, ScriptedProvider, ScriptedTurn};
use pa_core::kernel::shared::{ExecuteOptions, ExecuteStatus};
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::PromptOutcome;
use serde_json::json;

/// The two tests share the process env (the kernel-python override is
/// process-global), so they serialize through this lock.
static LIVE_KERNEL_LOCK: Mutex<()> = Mutex::new(());

/// The kernel Python with prime-agent-runtime installed (the interpreter
/// the session-path provisioner resolves). Skipped (with a note) on
/// machines without a live install; set `PA_CORE_KERNEL_PYTHON` to point
/// at an explicit interpreter instead.
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

/// Scoped process-env overrides: applied on construction, restored on drop.
/// The tests hold [`LIVE_KERNEL_LOCK`], so nothing races the env.
struct EnvOverride {
    saved: Vec<(String, Option<String>)>,
}

impl EnvOverride {
    fn apply(pairs: &[(&str, Option<String>)]) -> Self {
        let saved = pairs
            .iter()
            .map(|(key, _)| ((*key).to_string(), std::env::var(key).ok()))
            .collect();
        for (key, value) in pairs {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        EnvOverride { saved }
    }
}

impl Drop for EnvOverride {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// The agent-loop model shape the engine config takes.
fn scripted_model() -> pa_agent::types::Model {
    serde_json::from_value(json!({
        "id": "faux-1", "name": "Faux", "api": "test", "provider": "faux",
        "baseUrl": "http://localhost", "reasoning": false,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 200_000, "maxTokens": 4_000
    }))
    .expect("faux loop model")
}

/// Wait for the eager boot to land (a background task).
async fn wait_for_kernel_boot(
    provisioner: &Arc<pa_core::kernel::provisioner::IpythonKernelProvisioner>,
) {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if provisioner.has_running_kernel() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the eagerly booted kernel never came up"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A kernel-needing op (the model's `ipython` tool call) that arrives while
/// the eager boot is still in flight waits for THAT boot and succeeds: the
/// join memo serves one boot, never a second build, and the cell runs.
#[tokio::test]
// The std Mutex guard for LIVE_KERNEL_LOCK rides the awaits on purpose
// (the lock's own doc above): the kernel-python env is process-global, so
// the tests serialize their whole kernel lifetimes, not just their setup.
#[allow(clippy::await_holding_lock)]
async fn a_kernel_needing_op_mid_boot_joins_the_in_flight_build_and_succeeds() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _lock = LIVE_KERNEL_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    std::fs::create_dir_all(&cwd).expect("cwd");

    // Hermeticity: the kernel runs on the ambient product venv, and no
    // ambient agent state leaks in.
    let _env = EnvOverride::apply(&[
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);

    let model = scripted_model();
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    // One turn: the model calls the kernel cell, then the turn settles.
    provider.push_turn(ScriptedTurn::Events(tool_call_turn_steps(
        &model,
        Some("calling the kernel"),
        vec![(
            "cell-1",
            "ipython",
            json!({ "code": "print('JOINED_BOOT_OK')" }),
        )],
    )));
    provider.push_text_turn("the turn settles");

    let engine = create_session(SessionEngineConfig {
        cwd,
        agent_dir,
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        tools: Vec::new(),
        prewarm_ipython_kernel: Some(true),
        ..Default::default()
    })
    .await
    .expect("create the session");

    // The mid-boot premise: the eager boot the create spawned is still in
    // flight, so the create itself never waited on it.
    let provisioner = engine
        .kernel_provisioner_weak()
        .upgrade()
        .expect("the session carries its kernel provisioner");
    assert!(
        !provisioner.has_running_kernel(),
        "the create must return with the eager boot still in flight"
    );

    // The kernel-needing op, issued mid-boot: it joins the in-flight build
    // (the memoized startup), waits it out, and the cell succeeds.
    let outcome = engine
        .prompt(
            "run the cell",
            pa_core::session_engine::PromptOptions::default(),
        )
        .await
        .expect("prompt");
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;

    let serialized = {
        let entries = engine.session.entries().await;
        serde_json::to_string(&entries).expect("entries json")
    };
    assert!(
        serialized.contains("JOINED_BOOT_OK"),
        "the mid-boot tool call never ran its cell: {serialized}"
    );
    assert!(
        provisioner.has_running_kernel(),
        "the joined boot must be the running kernel"
    );
}

/// The stdio MCP server fixture: it records its spawn to `marker`, delays
/// its handshake by [`SETTLE_SERVER_OPEN_DELAY_MS`], then serves one echo
/// tool. The delay is what keeps the settle's open in flight when the
/// test's first use arrives.
const SETTLE_SERVER_OPEN_DELAY_MS: u64 = 1_500;

/// The queue-contention fixture's handshake delay: long enough that a
/// python cell queued behind the listing can never meet the test's
/// bound (the listing holds the kernel's execution queue for the whole
/// handshake on a runtime without the dedicated MCP lane).
const HANGING_SERVER_OPEN_DELAY_MS: u64 = 8_000;

/// The cell's completion bound: half the hanging server's handshake, so
/// a queued shape (the cell waiting out the handshake) fails by seconds
/// while the dedicated-lane shape (the cell never touching the MCP
/// work) passes with margin.
const CELL_COMPLETION_BOUND_MS: u64 = 4_000;

fn slow_echo_server_code(handshake_delay_ms: u64) -> String {
    r#"import sys
import time
from pathlib import Path

Path(sys.argv[1]).write_text("started", encoding="utf-8")
time.sleep({HANDSHAKE_DELAY_MS} / 1000)

from mcp.server.mcpserver import MCPServer

server = MCPServer("settle-fixture")


@server.tool()
def echo(text: str) -> str:
    """Echo the text back."""
    return text


server.run()
"#
    .replace("{HANDSHAKE_DELAY_MS}", &handshake_delay_ms.to_string())
}

/// The configured generic MCP servers settle in the background once the
/// kernel is up (the fixture server's process spawns with no user use
/// anywhere — red on a tree without the settle), and the first use,
/// issued while the settle's open is still mid-handshake, waits for that
/// open and succeeds instead of erroring (the registry's per-server lock
/// joins both callers onto one open).
#[tokio::test]
// LIVE_KERNEL_LOCK held across the awaits on purpose (the lock's own doc
// above): the kernel-python env is process-global, so the tests serialize
// their whole kernel lifetimes.
#[allow(clippy::await_holding_lock)]
async fn generic_mcp_servers_settle_in_the_background_and_first_use_joins_the_open() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _lock = LIVE_KERNEL_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let marker = dir.path().join("settle-server-started");
    let server_script = dir.path().join("slow_echo_server.py");
    std::fs::write(
        &server_script,
        slow_echo_server_code(SETTLE_SERVER_OPEN_DELAY_MS),
    )
    .expect("server script");

    // The user-declared stdio server the kernel's generic MCP surface
    // resolves through the `mcp.config` host request.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "mcpServers": {
                "settle-fixture": {
                    "type": "stdio",
                    "command": kernel_python.display().to_string(),
                    "args": [
                        server_script.display().to_string(),
                        marker.display().to_string(),
                    ],
                },
            },
        })
        .to_string(),
    )
    .expect("settings");

    let _env = EnvOverride::apply(&[
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);

    let model = scripted_model();
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let engine = create_session(SessionEngineConfig {
        cwd,
        agent_dir,
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        tools: Vec::new(),
        prewarm_ipython_kernel: Some(true),
        ..Default::default()
    })
    .await
    .expect("create the session");

    let provisioner = engine
        .kernel_provisioner_weak()
        .upgrade()
        .expect("the session carries its kernel provisioner");
    wait_for_kernel_boot(&provisioner).await;

    // The settle, with no user use anywhere: the fixture server's process
    // spawns in the background once the kernel is up. On a tree without
    // the settle this wait times out — nothing else opens the server.
    let deadline = Instant::now() + Duration::from_secs(20);
    while !marker.exists() {
        assert!(
            Instant::now() < deadline,
            "the generic MCP server never settled in the background"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // First use, while the settle's open is still mid-handshake (the
    // fixture's spawn delay): the call joins the in-flight open on the
    // registry's per-server lock, waits it out, and succeeds.
    let manager = provisioner.manager().expect("the booted kernel's manager");
    let result = manager
        .execute(
            "result = await mcp.call_tool('settle-fixture', 'echo', {'text': 'probe'})\nresult",
            ExecuteOptions::default(),
        )
        .await
        .expect("the mcp cell must execute");
    assert_eq!(
        result.status,
        ExecuteStatus::Ok,
        "the first use must wait for the settle's open and succeed; stderr: {}",
        result.stderr
    );
    let echoed = result.result.unwrap_or_default();
    assert!(
        echoed.contains("probe"),
        "the echo tool's answer must come back; got {echoed:?} (stdout {})",
        result.stdout
    );
}

/// The eager MCP settle must never contend with the user's first-turn
/// path (the pre-bar review's finding: the eager `mcp_status` used to
/// ride the kernel's single execution queue, so a hanging server's
/// handshake parked the first `ipython` cell behind it for up to the
/// per-server timeout). The kernel runtime's dedicated MCP lane keeps
/// status/open work off the cell queue: with the settle's listing
/// provably in flight (the fixture server spawned, its handshake still
/// holding the listing), the user's first python cell must complete
/// without waiting out the handshake.
///
/// Red on a runtime without the lane (the cell queues behind the
/// listing); green with it.
#[tokio::test]
// LIVE_KERNEL_LOCK held across the awaits on purpose (the lock's own doc
// above): the kernel-python env is process-global, so the tests serialize
// their whole kernel lifetimes.
#[allow(clippy::await_holding_lock)]
async fn the_first_python_cell_never_waits_behind_the_eager_mcp_status() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _lock = LIVE_KERNEL_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let marker = dir.path().join("hanging-server-started");
    let server_script = dir.path().join("hanging_echo_server.py");
    std::fs::write(
        &server_script,
        slow_echo_server_code(HANGING_SERVER_OPEN_DELAY_MS),
    )
    .expect("server script");

    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "mcpServers": {
                "hanging-fixture": {
                    "type": "stdio",
                    "command": kernel_python.display().to_string(),
                    "args": [
                        server_script.display().to_string(),
                        marker.display().to_string(),
                    ],
                },
            },
        })
        .to_string(),
    )
    .expect("settings");

    let _env = EnvOverride::apply(&[
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);

    let model = scripted_model();
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    // One turn: the model runs a python cell, then the turn settles.
    provider.push_turn(ScriptedTurn::Events(tool_call_turn_steps(
        &model,
        Some("running the cell"),
        vec![("cell-1", "ipython", json!({ "code": "print('CELL_OK')" }))],
    )));
    provider.push_text_turn("the turn settles");

    let engine = create_session(SessionEngineConfig {
        cwd,
        agent_dir,
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        tools: Vec::new(),
        prewarm_ipython_kernel: Some(true),
        ..Default::default()
    })
    .await
    .expect("create the session");

    let provisioner = engine
        .kernel_provisioner_weak()
        .upgrade()
        .expect("the session carries its kernel provisioner");
    wait_for_kernel_boot(&provisioner).await;

    // The settle is provably in flight: the fixture server spawned (its
    // process marker landed), and its handshake still holds the listing.
    let deadline = Instant::now() + Duration::from_secs(20);
    while !marker.exists() {
        assert!(
            Instant::now() < deadline,
            "the eager MCP settle never reached the hanging server"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // The user's first python cell, issued with the listing in flight:
    // it must complete inside the bound — a cell queued behind the
    // handshake cannot.
    let cell_started = Instant::now();
    let outcome = engine
        .prompt(
            "run the cell",
            pa_core::session_engine::PromptOptions::default(),
        )
        .await
        .expect("prompt");
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;
    let cell_elapsed = cell_started.elapsed();
    assert!(
        cell_elapsed < Duration::from_millis(CELL_COMPLETION_BOUND_MS),
        "the first python cell waited {cell_elapsed:?} behind the eager          MCP status — the settle must never contend with the user's          first-turn path"
    );

    let serialized = {
        let entries = engine.session.entries().await;
        serde_json::to_string(&entries).expect("entries json")
    };
    assert!(
        serialized.contains("CELL_OK"),
        "the cell never ran: {serialized}"
    );
}
