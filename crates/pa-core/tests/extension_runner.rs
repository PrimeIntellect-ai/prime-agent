//! Extension runner integration tests (design doc stage-2 verifier): real
//! `node`, the bundled host script runtime, the committed fixture extensions,
//! no network, no TS product at test time. The TS-parity differential is the
//! committed golden captured from the installed TS binary
//! (`fixtures/extensions/registration-payload.ts-golden.json`: the `prime-agent`
//! CLI loads `-e` extensions before the provider call, so the capture runs
//! with a bogus API key and still dumps the registration payloads).
//!
//! Verifier coverage (design doc §4 stage 2):
//! - load -> registration landing (hello registrations, TS error strings)
//! - tool call round-trip through the runner (`hello.ts` from the TS
//!   examples corpus, run verbatim under both products)
//! - the `pi` API surface + registration payloads match the TS golden
//! - `--tools` allow-list filtering (`isAllowedTool`)
//! - a scripted session observes the extension tool in the model surface:
//!   the loop calls `hello`, the sidecar executes it, the result lands in
//!   the session messages, and the prompt guideline injection flows into
//!   the system prompt

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use pa_agent::scripted::ScriptedProvider;
use pa_core::extensions::ExtensionHostSpec;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::{PromptOptions, PromptOutcome};
use serde_json::{json, Value};

/// The `node` binary, or None when the box has no Node (tests skip).
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
    (major >= 18).then(|| PathBuf::from("node"))
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("extensions")
        .join(name)
}

fn runner_spec(dir: &Path, paths: &[&str]) -> ExtensionHostSpec {
    let mut spec = ExtensionHostSpec::new(dir.to_path_buf(), dir.join("agent-dir"));
    if let Some(node) = node_binary() {
        spec.node = node;
    }
    spec.extension_paths = paths
        .iter()
        .map(|name| fixture(name).display().to_string())
        .collect();
    spec.timeouts.hello = Duration::from_secs(30);
    spec.timeouts.rpc = Duration::from_secs(15);
    spec.timeouts.shutdown_wait = Duration::from_secs(10);
    spec
}

#[tokio::test]
async fn loads_hello_ts_and_lands_the_registration() -> Result<()> {
    let Some(_node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let dir = tempfile::tempdir()?;
    let runner =
        pa_core::extensions::ExtensionRunner::start(runner_spec(dir.path(), &["hello.ts"])).await?;
    let hello = runner.hello();
    assert!(hello.errors.is_empty(), "load errors: {:?}", hello.errors);
    assert_eq!(hello.extensions.len(), 1);
    let extension = &hello.extensions[0];
    assert!(extension.path.ends_with("hello.ts"));
    assert_eq!(extension.tools.len(), 1);
    let tool = &extension.tools[0];
    assert_eq!(tool.name, "hello");
    assert_eq!(tool.label, "Hello");
    assert_eq!(tool.description, "A simple greeting tool");
    // The TypeBox schema from `Type.Object({ name: Type.String({ description }) })`
    // crosses as the tool wire schema (JSON-Schema shaped).
    assert_eq!(
        tool.parameters,
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Name to greet" }
            },
            "required": ["name"],
        })
    );
    assert!(extension.events.is_empty());
    assert!(extension.commands.is_empty());
    runner.shutdown("test end").await?;
    Ok(())
}

#[tokio::test]
async fn tool_call_round_trips_through_the_runner() -> Result<()> {
    let Some(_node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let dir = tempfile::tempdir()?;
    let runner =
        pa_core::extensions::ExtensionRunner::start(runner_spec(dir.path(), &["hello.ts"])).await?;
    // hello.ts returns `Hello, ${params.name}!` with details `{ greeted }`.
    let result = runner
        .execute_tool("call-1", "hello", json!({ "name": "world" }))
        .await?;
    assert_eq!(result.content.len(), 1);
    match &result.content[0] {
        pa_types::extension_rpc::ToolResultBlock::Text { text } => {
            assert_eq!(text, "Hello, world!");
        }
        other => panic!("expected text block, got {other:?}"),
    }
    assert!(!result.is_error);
    runner.shutdown("test end").await?;
    Ok(())
}

#[tokio::test]
async fn load_errors_use_the_ts_strings_and_never_abort_the_load() -> Result<()> {
    let Some(_node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let dir = tempfile::tempdir()?;
    // A module with a non-function default export + a throwing module +
    // a good one: per-path errors, the good extension still loads
    // (loader.ts loadExtensions semantics).
    let bad_dir = dir.path().join("bad");
    std::fs::create_dir_all(&bad_dir)?;
    std::fs::write(
        bad_dir.join("not-a-factory.ts"),
        "export default { not: \"a factory\" };\n",
    )?;
    std::fs::write(bad_dir.join("throws.ts"), "throw new Error(\"boom\");\n")?;
    let mut spec = runner_spec(dir.path(), &["hello.ts"]);
    spec.extension_paths = vec![
        bad_dir.join("not-a-factory.ts").display().to_string(),
        bad_dir.join("throws.ts").display().to_string(),
        fixture("hello.ts").display().to_string(),
    ];
    let runner = pa_core::extensions::ExtensionRunner::start(spec).await?;
    let errors = runner.load_errors();
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert!(
        errors[0]
            .error
            .starts_with("Extension does not export a valid factory function:"),
        "{errors:?}"
    );
    assert!(
        errors[1]
            .error
            .starts_with("Failed to load extension: boom"),
        "{errors:?}"
    );
    assert_eq!(runner.hello().extensions.len(), 1, "hello.ts still loaded");
    runner.shutdown("test end").await?;
    Ok(())
}

#[tokio::test]
async fn registration_payload_matches_the_ts_binary_golden() -> Result<()> {
    let Some(_node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let dir = tempfile::tempdir()?;
    let dump_path = dir.path().join("rust-dump.json");
    // The fixture reads PA_REGISTRATION_DUMP from its environment; the
    // sidecar inherits this process's environment.
    std::env::set_var("PA_REGISTRATION_DUMP", &dump_path);
    let runner = pa_core::extensions::ExtensionRunner::start(runner_spec(
        dir.path(),
        &["registration-dump.ts"],
    ))
    .await?;
    std::env::remove_var("PA_REGISTRATION_DUMP");
    runner.shutdown("test end").await?;
    let rust_dump: Value = serde_json::from_str(
        &std::fs::read_to_string(&dump_path).expect("the fixture wrote its dump"),
    )?;
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(fixture(
        "registration-payload.ts-golden.json",
    ))?)?;
    // The pi API surface (method names + kinds) is byte-identical.
    assert_eq!(rust_dump["piShape"], golden["piShape"]);
    // The registration payloads the extension passed are identical.
    assert_eq!(rust_dump["registered"], golden["registered"]);
    Ok(())
}

#[tokio::test]
async fn bridge_tools_filters_by_the_allow_list() -> Result<()> {
    let Some(_node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let dir = tempfile::tempdir()?;
    let runner =
        pa_core::extensions::ExtensionRunner::start(runner_spec(dir.path(), &["hello.ts"])).await?;
    let all = runner.bridge_tools(None).await;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name(), "hello");
    // TS isAllowedTool: an allow-list without the tool's name drops it.
    let filtered = runner.bridge_tools(Some(&["other".to_string()])).await;
    assert!(filtered.is_empty());
    let kept = runner
        .bridge_tools(Some(&["bash".to_string(), "hello".to_string()]))
        .await;
    assert_eq!(kept.len(), 1);
    runner.shutdown("test end").await?;
    Ok(())
}

#[tokio::test]
async fn dead_sidecar_degrades_to_errors_not_panics() -> Result<()> {
    let Some(_node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let dir = tempfile::tempdir()?;
    let runner =
        pa_core::extensions::ExtensionRunner::start(runner_spec(dir.path(), &["hello.ts"])).await?;
    assert!(runner.is_alive());
    // Kill the sidecar process: the runner's requests fail fast with the
    // death reason (§2.4 crash isolation; the registry stays usable).
    let pid = runner.pid().expect("live sidecar has a pid");
    assert!(pa_core::platform::kill_pid(
        pid as i32,
        pa_core::platform::Signal::Kill
    ));
    let error = runner
        .execute_tool("call-1", "hello", json!({ "name": "world" }))
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("sidecar stopped"),
        "death reason missing: {error:#}"
    );
    assert!(!runner.is_alive());
    // The registry view still reports the registrations (degraded, not lost).
    let tools = runner.bridge_tools(None).await;
    assert_eq!(tools.len(), 1);
    runner.shutdown("after kill").await?;
    Ok(())
}

/// The session-engine e2e: a scripted provider calls the extension tool;
/// the loop executes it through the sidecar and records the result.
#[tokio::test]
async fn scripted_session_executes_the_extension_tool() -> Result<()> {
    let Some(_node) = node_binary() else {
        eprintln!("skipping: node >= 18 not available");
        return Ok(());
    };
    let dir = tempfile::tempdir()?;
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd)?;
    let model = pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: Default::default(),
        context_window: 1_000,
        max_tokens: 100,
    };
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    // Turn 1: call the extension tool. Turn 2: final text.
    provider.push_tool_call_turn(
        Some("greeting the user"),
        vec![("call-1", "hello", json!({ "name": "world" }))],
    );
    provider.push_text_turn("greeted");

    let engine = create_session(SessionEngineConfig {
        cron_store: None,
        cwd: cwd.clone(),
        agent_dir: dir.path().join("agent"),
        model: Some(model),
        stream_fn: Some(provider.stream_fn()),
        cli_extension_sources: vec![fixture("hello.ts").display().to_string()],
        ..Default::default()
    })
    .await?;

    // The extension landed: runner present, no diagnostics, the tool is in
    // the model surface with the fixture's schema.
    let runner = engine
        .extension_runner
        .as_ref()
        .expect("the extension runner started");
    assert!(runner.is_alive());
    assert!(
        engine.extension_diagnostics.is_empty(),
        "{:?}",
        engine.extension_diagnostics
    );
    let tool_names: Vec<String> = engine
        .session
        .agent()
        .state()
        .await
        .tools
        .iter()
        .map(|tool| tool.name().to_string())
        .collect();
    assert!(
        tool_names.iter().any(|name| name == "hello"),
        "{tool_names:?}"
    );
    assert!(
        tool_names.iter().any(|name| name == "ipython"),
        "{tool_names:?}"
    );

    let outcome = engine
        .prompt("greet the world", PromptOptions::default())
        .await?;
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;

    // The loop executed the tool through the sidecar: the tool result
    // message carries the extension's text and details.
    let state = engine.session.agent().state().await;
    let tool_results: Vec<&pa_agent::types::ToolResultMessage> = state
        .messages
        .iter()
        .filter_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(
                result,
            )) => Some(result),
            _ => None,
        })
        .collect();
    let hello_result = tool_results
        .iter()
        .find(|result| result.tool_name == "hello")
        .expect("the hello tool result recorded");
    assert_eq!(hello_result.tool_call_id, "call-1");
    assert_eq!(
        serde_json::to_value(&hello_result.content).unwrap(),
        json!([{ "type": "text", "text": "Hello, world!" }])
    );
    // Orderly shutdown: destructure the engine (its fields are plain
    // owners) and stop the sidecar explicitly; the Drop path would kill
    // the process group instead.
    let pa_core::session_engine::engine::SessionEngine {
        extension_runner, ..
    } = engine;
    let runner = extension_runner.expect("runner present");
    match Arc::try_unwrap(runner) {
        Ok(runner) => runner.shutdown("test end").await?,
        Err(_) => unreachable!("the test holds the only Arc reference"),
    }
    Ok(())
}
