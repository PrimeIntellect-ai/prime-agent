//! Command-hook adapters at the loop's existing tool-decision boundaries.
//! These callbacks never acquire session or agent state locks. The diagnostic
//! sink only uses the agent's event delivery, which the loop never holds while
//! it awaits a hook.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock, Weak};

use pa_agent::agent_loop::{AfterToolCallFn, BeforeToolCallFn};
use pa_agent::types::{BeforeToolCallResult, ToolCall};
use serde_json::{json, Value};

use crate::hooks::{HookNoticeSink, HookRuntime};

pub(super) struct ToolHooks {
    pub runtime: Arc<HookRuntime>,
    pub before: BeforeToolCallFn,
    pub after: AfterToolCallFn,
    pub run_id: Arc<RwLock<String>>,
    pub finish: super::engine::SessionEndHook,
    pub lifecycle: Arc<super::lifecycle::LifecycleHooks>,
}

impl ToolHooks {
    pub fn new(
        cwd: PathBuf,
        agent_dir: PathBuf,
        session_id: String,
        transcript_path: Option<String>,
    ) -> Self {
        let runtime = Arc::new(HookRuntime::new(cwd.clone(), agent_dir));
        // A pre-run compaction has its own lifecycle identity; AgentStart
        // replaces it with the actual admitted run's identity.
        let run_id = Arc::new(RwLock::new(uuid::Uuid::new_v4().to_string()));
        let identity = Arc::new(Identity {
            cwd,
            session_id,
            transcript_path,
            run_id: Arc::clone(&run_id),
        });
        let lifecycle = Arc::new(super::lifecycle::LifecycleHooks::new(
            Arc::clone(&runtime),
            Arc::clone(&identity),
        ));
        let finish_runtime = Arc::clone(&runtime);
        let finish_identity = Arc::clone(&identity);
        let finish: super::engine::SessionEndHook = Arc::new(move || {
            let runtime = Arc::clone(&finish_runtime);
            let input = json!({
                "hook_event_name": "SessionEnd",
                "session_id": finish_identity.session_id,
                "transcript_path": finish_identity.transcript_path,
                "cwd": finish_identity.cwd,
                "reason": "other",
            });
            Box::pin(async move { runtime.finish(input).await })
        });
        let before_runtime = Arc::clone(&runtime);
        let before_identity = Arc::clone(&identity);
        let before: BeforeToolCallFn = Arc::new(move |context, signal| {
            if !before_runtime.might_run("PreToolUse") {
                return Box::pin(async { Ok(None) });
            }
            let runtime = Arc::clone(&before_runtime);
            let input = before_identity.input(
                "PreToolUse",
                &context.assistant_message.model,
                &context.tool_call,
                &context.resolved_tool_name,
                context.args,
            );
            Box::pin(async move {
                Ok(runtime
                    .evaluate(input, signal)
                    .await
                    .map(|reason| BeforeToolCallResult {
                        block: true,
                        reason: Some(format!("Blocked by a PreToolUse hook: {reason}")),
                    }))
            })
        });
        let after_runtime = Arc::clone(&runtime);
        let after: AfterToolCallFn = Arc::new(move |context, signal| {
            // The loop invokes this only for executed tools, including tools
            // returning an error result. Preparation refusals never get here.
            if !signal.is_aborted() && after_runtime.might_run("PostToolUse") {
                let mut input = identity.input(
                    "PostToolUse",
                    &context.assistant_message.model,
                    &context.tool_call,
                    &context.resolved_tool_name,
                    context.args,
                );
                input["tool_response"] = json!(context.result);
                after_runtime.observe(&input);
            }
            // Observers cannot replace the tool output or alter its error bit:
            // the original result persists through the ordinary message event.
            Box::pin(async { Ok(None) })
        });
        Self {
            runtime,
            before,
            after,
            run_id,
            finish,
            lifecycle,
        }
    }
}

/// Hook diagnostics become display-only `hook_notice` rows. Inside a run (where
/// load diagnostics and synchronous hook failures arise) the row lands through
/// the loop's event path, so every host persists and streams it like any other
/// settled message. Outside a run (late observers, close) it rides the next
/// admitted turn's prompt rows instead.
pub(super) fn notice_sink(
    agent: Weak<pa_agent::agent::Agent>,
    next_turn_rows: Arc<Mutex<Vec<pa_types::session::CustomMessage>>>,
) -> HookNoticeSink {
    Arc::new(move |text| {
        let row = super::messages::create_hook_notice_message(&text);
        let agent = agent.upgrade().filter(|agent| agent.signal().is_some());
        let next_turn_rows = Arc::clone(&next_turn_rows);
        Box::pin(async move {
            if let Some(agent) = agent {
                if let Some(message) = super::session_message_to_loop(
                    &pa_types::session::AgentMessage::Custom(row.clone()),
                ) {
                    let deliver = agent.event_sink();
                    let event = pa_agent::types::AgentEvent::MessageEnd { message };
                    if deliver(event).await.is_ok() {
                        return;
                    }
                }
            }
            next_turn_rows
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(row);
        })
    })
}

pub(super) struct Identity {
    pub cwd: PathBuf,
    pub session_id: String,
    pub transcript_path: Option<String>,
    pub run_id: Arc<RwLock<String>>,
}

impl Identity {
    fn input(
        &self,
        event: &str,
        model: &str,
        call: &ToolCall,
        resolved_tool_name: &str,
        args: Value,
    ) -> Value {
        let tool_name = match resolved_tool_name {
            "bash" => "Bash",
            name => name,
        };
        let mut input = json!({
            "session_id": self.session_id,
            "turn_id": *self.run_id.read().unwrap_or_else(std::sync::PoisonError::into_inner),
            "transcript_path": self.transcript_path,
            "cwd": self.cwd,
            "permission_mode": "default",
            "hook_event_name": event,
            "model": model,
            "tool_name": tool_name,
            "tool_use_id": call.id,
        });
        input["tool_input"] = args;
        input
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    use pa_agent::agent::{Agent, AgentInitialState, AgentOptions};
    use pa_agent::scripted::ScriptedProvider;
    use pa_agent::types::{AgentMessage, Message, Model};
    use sha2::{Digest, Sha256};

    use crate::session_engine::tool_bridge::bridge_tool;
    use crate::tools::tool_definition::{ToolDefinition, ToolExecutionResult};

    #[tokio::test]
    async fn external_denial_prevents_execution_and_preserves_model_tool_call() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().join("project");
        let agent_dir = directory.path().join("agent");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(&agent_dir).unwrap();
        let denial = json!({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "denied by test"
        }});
        std::fs::write(
            agent_dir.join("hooks.json"),
            serde_json::to_vec(&json!({"hooks": {"PreToolUse": [{
                "matcher": "echo",
                "hooks": [{"type": "command", "command": format!("printf '%s' '{denial}'")}]
            }]}}))
            .unwrap(),
        )
        .unwrap();
        trust_fixture(&cwd, &agent_dir);
        let hooks = ToolHooks::new(cwd, agent_dir, "session-test".into(), None);
        *hooks.run_id.write().unwrap() = "actual-run".into();
        let executed = Arc::new(AtomicBool::new(false));
        let execution_flag = Arc::clone(&executed);
        let tool = bridge_tool(ToolDefinition {
            name: "echo".into(),
            label: "echo".into(),
            description: "echo".into(),
            prompt_snippet: String::new(),
            parameters: json!({"type": "object"}),
            execution_mode: None,
            prepare_arguments: None,
            execute: Arc::new(move |_, _, _, _| {
                execution_flag.store(true, Ordering::SeqCst);
                Box::pin(async { Ok(ToolExecutionResult::text("must not execute")) })
            }),
        });
        let model = Model::unknown();
        let provider = Arc::new(ScriptedProvider::new(model.clone()));
        provider.push_tool_call_turn(
            None,
            vec![("call-original", "echo", json!({"original": true}))],
        );
        provider.push_text_turn("done");
        let agent = Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                model: Some(model),
                tools: Some(vec![tool]),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            before_tool_call: Some(hooks.before),
            after_tool_call: Some(hooks.after),
            ..Default::default()
        });
        agent.prompt("test").await.unwrap();
        assert!(!executed.load(Ordering::SeqCst));
        let state = agent.state().await;
        let tool_result = state
            .messages
            .iter()
            .find_map(|message| match message {
                AgentMessage::Standard(Message::ToolResult(result)) => Some(result),
                _ => None,
            })
            .unwrap();
        assert!(tool_result.is_error);
        assert_eq!(tool_result.tool_call_id, "call-original");
        assert_eq!(tool_result.tool_name, "echo");
        assert_eq!(
            serde_json::to_value(&tool_result.content).unwrap(),
            json!([{"type": "text", "text": "Blocked by a PreToolUse hook: denied by test"}])
        );
        let AgentMessage::Standard(Message::Assistant(final_message)) =
            state.messages.last().unwrap()
        else {
            panic!("model must continue after the denied tool call");
        };
        assert_eq!(
            serde_json::to_value(&final_message.content).unwrap(),
            json!([{"type": "text", "text": "done"}])
        );
        let call = state
            .messages
            .iter()
            .find_map(|message| match message {
                AgentMessage::Standard(Message::Assistant(message)) => {
                    message.tool_calls().into_iter().next()
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(call.arguments, json!({"original": true}));
    }

    fn trust_fixture(cwd: &std::path::Path, agent_dir: &std::path::Path) {
        let source = agent_dir.join("hooks.json").canonicalize().unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let mut hash = Sha256::new();
        hash.update(source.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(cwd.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(std::fs::read(source).unwrap());
        std::fs::write(
            agent_dir.join("hook-trust.json"),
            serde_json::to_vec(
                &json!({"version": 1, "trusted": [format!("{:x}", hash.finalize())]}),
            )
            .unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn observer_receives_original_result_without_returning_an_override() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().join("project");
        let agent_dir = directory.path().join("agent");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("hooks.json"),
            serde_json::to_vec(&json!({
                "hooks": {"PostToolUse": [{"hooks": [{"type": "command", "async": true,
                    "command": "cat > observed.tmp && mv observed.tmp observed.json"}]}]}
            }))
            .unwrap(),
        )
        .unwrap();
        trust_fixture(&cwd, &agent_dir);
        let hooks = ToolHooks::new(cwd.clone(), agent_dir, "session-test".into(), None);
        *hooks.run_id.write().unwrap() = "run-observed".into();
        let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
        provider.push_text_turn("model output");
        let agent = Agent::new(AgentOptions {
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        });
        agent.prompt("test").await.unwrap();
        let state = agent.state().await;
        let assistant_message = state
            .messages
            .iter()
            .find_map(|message| match message {
                AgentMessage::Standard(Message::Assistant(message)) => Some(message.clone()),
                _ => None,
            })
            .unwrap();
        let result = pa_agent::types::AgentToolResult::text("unmodified original output");
        let override_result = (hooks.after)(
            pa_agent::types::AfterToolCallContext {
                resolved_tool_name: "bash".into(),
                assistant_message,
                tool_call: ToolCall {
                    id: "call-observed".into(),
                    name: "bash".into(),
                    arguments: json!({}),
                    thought_signature: None,
                },
                args: json!({"command": "echo original"}),
                result: result.clone(),
                is_error: false,
                context: pa_agent::types::AgentContext::default(),
            },
            pa_agent::abort::AbortSignal::default(),
        )
        .await
        .unwrap();
        assert!(override_result.is_none());
        let observed_path = cwd.join("observed.json");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !observed_path.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let observed: Value =
            serde_json::from_slice(&std::fs::read(observed_path).unwrap()).unwrap();
        assert_eq!(
            observed,
            json!({
                "session_id": "session-test", "turn_id": "run-observed", "transcript_path": null,
                "cwd": cwd, "permission_mode": "default", "hook_event_name": "PostToolUse",
                "model": Model::unknown().id, "tool_name": "Bash", "tool_use_id": "call-observed",
                "tool_input": {"command": "echo original"}, "tool_response": result,
            })
        );
    }

    #[tokio::test]
    async fn python_aliases_match_resolved_tool_for_denials_and_observers() {
        for spelling in ["python_repl", "python", "ipython"] {
            for deny in [true, false] {
                let directory = tempfile::tempdir().unwrap();
                let cwd = directory.path().join("project");
                let agent_dir = directory.path().join("agent");
                std::fs::create_dir(&cwd).unwrap();
                std::fs::create_dir(&agent_dir).unwrap();
                let event = if deny { "PreToolUse" } else { "PostToolUse" };
                let command = if deny {
                    "cat > payload.tmp; mv payload.tmp payload.json; printf 'alias policy reason' >&2; exit 2"
                } else {
                    "cat > payload.tmp; mv payload.tmp payload.json"
                };
                std::fs::write(
                    agent_dir.join("hooks.json"),
                    serde_json::to_vec(&json!({
                        "hooks": {(event): [{"matcher": "^python_repl$", "hooks": [{
                            "type": "command", "command": command, "async": !deny
                        }]}]}
                    }))
                    .unwrap(),
                )
                .unwrap();
                trust_fixture(&cwd, &agent_dir);
                let hooks = ToolHooks::new(cwd.clone(), agent_dir, "alias-session".into(), None);
                let executed = Arc::new(AtomicBool::new(false));
                let execution_flag = Arc::clone(&executed);
                // Use the real bridge's alias resolution, without a live Python kernel.
                let tool = bridge_tool(ToolDefinition {
                    name: "python_repl".into(),
                    label: "Python".into(),
                    description: "Alias regression".into(),
                    prompt_snippet: String::new(),
                    parameters: json!({"type": "object"}),
                    execution_mode: None,
                    prepare_arguments: None,
                    execute: Arc::new(move |_, _, _, _| {
                        execution_flag.store(true, Ordering::SeqCst);
                        Box::pin(async { Ok(ToolExecutionResult::text("original output")) })
                    }),
                });
                let model = Model::unknown();
                let provider = Arc::new(ScriptedProvider::new(model.clone()));
                provider.push_tool_call_turn(
                    None,
                    vec![("alias-call", spelling, json!({"code": "1+1"}))],
                );
                provider.push_text_turn("done");
                let agent = Agent::new(AgentOptions {
                    initial_state: AgentInitialState {
                        model: Some(model),
                        tools: Some(vec![tool]),
                        ..Default::default()
                    },
                    stream_fn: Some(provider.stream_fn()),
                    before_tool_call: Some(hooks.before),
                    after_tool_call: Some(hooks.after),
                    ..Default::default()
                });
                agent.prompt("test alias").await.unwrap();
                assert_eq!(executed.load(Ordering::SeqCst), !deny, "{spelling}");
                tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    while !cwd.join("payload.json").exists() {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("canonical matcher must receive every executable alias");
                let payload: Value =
                    serde_json::from_slice(&std::fs::read(cwd.join("payload.json")).unwrap())
                        .unwrap();
                assert_eq!(payload["tool_name"], "python_repl");
                assert_eq!(payload["tool_use_id"], "alias-call");
                assert_eq!(payload["tool_input"], json!({"code": "1+1"}));
                assert_eq!(payload["hook_event_name"], event);
                if !deny {
                    assert_eq!(
                        payload["tool_response"]["content"],
                        json!([{"type":"text", "text":"original output"}])
                    );
                }
                let state = agent.state().await;
                let raw_call = state
                    .messages
                    .iter()
                    .find_map(|message| match message {
                        AgentMessage::Standard(Message::Assistant(message)) => {
                            message.content.iter().find_map(|part| match part {
                                pa_agent::types::AssistantContent::ToolCall(call) => Some(call),
                                _ => None,
                            })
                        }
                        _ => None,
                    })
                    .unwrap();
                assert_eq!(raw_call.name, spelling);
                assert_eq!(raw_call.id, "alias-call");
                assert_eq!(raw_call.arguments, json!({"code": "1+1"}));
                let result = state
                    .messages
                    .iter()
                    .find_map(|message| match message {
                        AgentMessage::Standard(Message::ToolResult(result)) => Some(result),
                        _ => None,
                    })
                    .unwrap();
                assert_eq!(result.tool_name, spelling);
                assert_eq!(result.tool_call_id, "alias-call");
                assert_eq!(result.is_error, deny);
                assert_eq!(
                    serde_json::to_value(&result.content).unwrap(),
                    json!([{"type":"text", "text": if deny {
                    "Blocked by a PreToolUse hook: alias policy reason"
                } else { "original output" }}])
                );
            }
        }
    }
}
