use std::path::{Path, PathBuf};
use std::sync::Arc;

use pa_agent::scripted::ScriptedProvider;
use pa_agent::types::Model;
use serde_json::{json, Value};

use super::engine::{create_session, SessionEngineConfig};
use super::{PromptOptions, SessionAgentMessage};

struct Fixture {
    _directory: tempfile::TempDir,
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl Fixture {
    fn new(document: &Value) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().join("project");
        let agent_dir = directory.path().join("agent");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(&agent_dir).unwrap();
        let source = agent_dir.join("hooks.json");
        let bytes = serde_json::to_vec(document).unwrap();
        std::fs::write(&source, &bytes).unwrap();
        Self {
            _directory: directory,
            cwd,
            agent_dir,
        }
    }

    fn config(&self, provider: &Arc<ScriptedProvider>) -> SessionEngineConfig {
        SessionEngineConfig {
            cwd: self.cwd.clone(),
            agent_dir: self.agent_dir.clone(),
            model: Some(Model::unknown()),
            stream_fn: Some(provider.stream_fn()),
            custom_system_prompt: Some("Test lifecycle hooks.".into()),
            tools: vec![super::tool_bridge::bridge_tool(
                crate::tools::tool_definition::ToolDefinition {
                    name: "echo".into(),
                    label: "Echo".into(),
                    description: "Echo test".into(),
                    prompt_snippet: String::new(),
                    parameters: json!({"type": "object"}),
                    execution_mode: None,
                    prepare_arguments: None,
                    execute: Arc::new(|_, _, _, _| {
                        Box::pin(async {
                            Ok(crate::tools::tool_definition::ToolExecutionResult::text(
                                "echo result",
                            ))
                        })
                    }),
                },
            )],
            prewarm_ipython_kernel: Some(false),
            ..Default::default()
        }
    }
}

fn registry_model() -> pa_types::ai::Model {
    serde_json::from_value(json!({
        "id": "unknown", "name": "unknown", "api": "test", "provider": "test",
        "baseUrl": "", "reasoning": false, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 8192, "maxTokens": 1024
    }))
    .unwrap()
}

fn events(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn session_start_is_deferred_and_rearms_only_after_compaction() {
    let fixture = Fixture::new(&json!({"hooks": {"SessionStart": [{"hooks": [{
        "type": "command", "command": "{ cat; printf '\\n'; } >> starts.jsonl"
    }]}]}}));
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    for text in ["one", "two", "three"] {
        provider.push_text_turn(text);
    }
    let engine = create_session(fixture.config(&provider)).await.unwrap();
    let path = fixture.cwd.join("starts.jsonl");
    assert!(
        !path.exists(),
        "session construction must not execute commands"
    );
    engine
        .prompt("first", PromptOptions::default())
        .await
        .unwrap();
    engine
        .prompt("second", PromptOptions::default())
        .await
        .unwrap();
    engine.session.mark_compaction_hook();
    engine
        .prompt("third", PromptOptions::default())
        .await
        .unwrap();
    let starts = events(&path);
    assert_eq!(
        starts
            .iter()
            .map(|event| event["source"].clone())
            .collect::<Vec<_>>(),
        vec![json!("startup"), json!("compact")]
    );
    assert!(starts.iter().all(|event| event.get("turn_id").is_none()));
    assert_eq!(provider.calls().len(), 3);
}

#[tokio::test]
async fn denied_prompt_restores_deferred_custom_rows_for_the_next_accepted_turn() {
    let fixture = Fixture::new(&json!({"hooks": {"UserPromptSubmit": [{"hooks": [{
        "type": "command", "command": "cat >/dev/null; if [ ! -f allow ]; then printf '%s' '{\"decision\":\"block\",\"reason\":\"not yet\"}'; fi"
    }]}]}}));
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("accepted");
    let engine = create_session(fixture.config(&provider)).await.unwrap();
    let deferred = pa_types::session::CustomMessage {
        custom_type: "deferred-test".into(),
        content: pa_types::ai::UserContent::Text("preserve me".into()),
        display: false,
        details: None,
        timestamp: 17,
        rest: serde_json::Map::default(),
    };
    engine.session.queue_next_turn_row(deferred.clone());
    assert!(engine
        .prompt("denied", PromptOptions::default())
        .await
        .is_err());
    assert!(provider.calls().is_empty());
    std::fs::write(fixture.cwd.join("allow"), []).unwrap();
    engine
        .prompt("accepted", PromptOptions::default())
        .await
        .unwrap();
    let restored = engine.session.agent().state().await.messages.into_iter()
        .filter_map(|message| super::loop_message_to_session(&message))
        .filter(|message| matches!(message, SessionAgentMessage::Custom(row) if row.custom_type == "deferred-test"))
        .collect::<Vec<_>>();
    assert_eq!(restored, vec![SessionAgentMessage::Custom(deferred)]);
}

#[tokio::test]
/// A subagent runs the tool and prompt hooks (so a `PreToolUse` policy cannot be
/// bypassed through rlm.spawn), tagged with Codex's agent fields; session
/// lifecycle events stay with the root.
async fn subagent_runs_tool_and_prompt_hooks_but_not_session_lifecycle() {
    let mut hook_map = serde_json::Map::new();
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SessionEnd",
        "PreCompact",
    ] {
        hook_map.insert(event.into(), json!([{"hooks": [{"type": "command",
            "command": "{ cat; printf '\\n'; } >> observed.jsonl", "async": event == "PostToolUse"}]}]));
    }
    let fixture = Fixture::new(&json!({"hooks": hook_map}));
    let parent_provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    parent_provider.push_text_turn("parent");
    let parent = create_session(fixture.config(&parent_provider))
        .await
        .unwrap();
    parent
        .prompt("parent input", PromptOptions::default())
        .await
        .unwrap();
    parent
        .session
        .before_compaction_hook(
            super::compact_session::CompactionTrigger::Manual,
            None,
            &registry_model(),
            None,
        )
        .await
        .unwrap();
    parent.session_end_hook().unwrap()(super::engine::SessionEndReason::Other).await;
    let path = fixture.cwd.join("observed.jsonl");
    let child_provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    child_provider.push_tool_call_turn(None, vec![("child-call", "echo", json!({}))]);
    child_provider.push_text_turn("child");
    let child = create_session(SessionEngineConfig {
        rlm_depth: Some(1),
        ..fixture.config(&child_provider)
    })
    .await
    .unwrap();
    child
        .prompt("child input", PromptOptions::default())
        .await
        .unwrap();
    child
        .session
        .before_compaction_hook(
            super::compact_session::CompactionTrigger::Auto,
            None,
            &registry_model(),
            None,
        )
        .await
        .unwrap();
    assert!(child.session_end_hook().is_none());
    assert_ne!(
        parent.session.session_id().await,
        child.session.session_id().await
    );
    // The PostToolUse observer is asynchronous: wait for its line.
    let child_events = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let all = events(&path);
            if all.len() >= 8 {
                break all;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("child hook events");
    let child_events = &child_events[5..];
    let mut names = child_events
        .iter()
        .map(|event| event["hook_event_name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, ["PostToolUse", "PreToolUse", "UserPromptSubmit"]);
    let child_id = child.session.session_id().await;
    for event in child_events {
        assert_eq!(event["agent_type"], "rlm", "{event}");
        assert_eq!(event["agent_id"], json!(child_id), "{event}");
    }
    let parent_events = events(&path);
    assert!(parent_events[..5]
        .iter()
        .all(|event| event.get("agent_id").is_none()));
    let names = parent_events[..5]
        .iter()
        .map(|event| event["hook_event_name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "PreCompact",
            "SessionEnd"
        ]
    );
}

#[tokio::test]
async fn hooks_use_host_durable_identity_instead_of_in_memory_mirror_id() {
    let fixture = Fixture::new(&json!({"hooks": {"SessionEnd": [{"hooks": [{
        "type": "command", "command": "cat > ended.json"
    }]}]}}));
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    let transcript = fixture.cwd.join("durable.jsonl");
    std::fs::write(
        &transcript,
        "{\"type\":\"session\",\"id\":\"host-durable-session\"}\n",
    )
    .unwrap();
    let mut config = fixture.config(&provider);
    config.conversation_log_path = Some(transcript.clone());
    config.semantic_edges = Some(super::semantic_edges::SemanticEdgeIdentity {
        session_id: "host-durable-session".into(),
        ledger_path: None,
        parent_session_id: None,
        spawned_by_request_id: None,
    });
    provider.push_text_turn("started");
    let engine = create_session(config).await.unwrap();
    // SessionEnd pairs with a session that reached its SessionStart gate.
    engine
        .prompt("start", PromptOptions::default())
        .await
        .unwrap();
    engine.session_end_hook().unwrap()(super::engine::SessionEndReason::Clear).await;
    let observed: Value =
        serde_json::from_slice(&std::fs::read(fixture.cwd.join("ended.json")).unwrap()).unwrap();
    assert_eq!(observed["session_id"], "host-durable-session");
    assert_eq!(
        observed["transcript_path"],
        transcript.display().to_string()
    );
}

#[tokio::test]
async fn late_durable_history_adoption_marks_resume_without_rearming_navigation() {
    for windowed in [false, true] {
        let fixture = Fixture::new(&json!({"hooks": {"SessionStart": [{"hooks": [{
            "type": "command", "command": "{ cat; printf '\\n'; } >> starts.jsonl"
        }]}]}}));
        let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
        for text in ["first", "second", "third"] {
            provider.push_text_turn(text);
        }
        let engine = create_session(fixture.config(&provider)).await.unwrap();
        let mut durable = crate::session::manager::SessionManager::in_memory(&fixture.cwd);
        durable
            .append_message(SessionAgentMessage::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text("prior user input".into()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            }))
            .unwrap();
        let entries = durable.get_all_entries().to_vec();
        let path = fixture.cwd.join("restored.jsonl");
        let mut bytes = Vec::new();
        for entry in &entries {
            serde_json::to_writer(&mut bytes, entry).unwrap();
            bytes.push(b'\n');
        }
        std::fs::write(&path, bytes).unwrap();
        for turn in 0..3 {
            if turn == 2 {
                engine.session.mark_compaction_hook();
            }
            if windowed {
                let window = crate::session::window::WindowedSessionStore::open(&path)
                    .unwrap()
                    .expect("valid durable history");
                engine.session.restore_windowed_context(window).await;
            } else {
                engine
                    .session
                    .rebuild_branch_context(entries.clone())
                    .await
                    .unwrap();
            }
            engine
                .prompt("continue", PromptOptions::default())
                .await
                .unwrap();
        }
        let starts = events(&fixture.cwd.join("starts.jsonl"));
        assert_eq!(
            starts
                .iter()
                .map(|event| event["source"].clone())
                .collect::<Vec<_>>(),
            vec![json!("resume"), json!("compact")]
        );
        assert_eq!(provider.calls().len(), 3);
    }
}

#[tokio::test]
async fn session_start_stop_is_consumed_before_the_next_submission() {
    let fixture = Fixture::new(&json!({"hooks": {"SessionStart": [{"hooks": [{
        "type": "command", "command": "{ cat; printf '\\n'; } >> starts.jsonl; printf '%s' '{\"continue\":false,\"stopReason\":\"pause this admission\"}'"
    }]}]}}));
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("accepted later");
    let engine = create_session(fixture.config(&provider)).await.unwrap();
    let error = engine
        .prompt("blocked", PromptOptions::default())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("pause this admission"));
    assert!(provider.calls().is_empty());
    engine
        .prompt("accepted", PromptOptions::default())
        .await
        .unwrap();
    assert_eq!(events(&fixture.cwd.join("starts.jsonl")).len(), 1);
    assert_eq!(provider.calls().len(), 1);
}

#[tokio::test]
async fn cancelled_session_start_remains_pending_for_next_submission() {
    let fixture = Fixture::new(&json!({"hooks": {"SessionStart": [{"hooks": [{
        "type": "command", "command": "{ cat; printf '\\n'; } >> starts.jsonl"
    }]}]}}));
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("accepted after cancellation");
    let engine = create_session(fixture.config(&provider)).await.unwrap();
    let abort = pa_agent::abort::AbortController::new();
    abort.abort();
    assert!(engine
        .session
        .lifecycle_hooks
        .as_ref()
        .unwrap()
        .start("test", abort.signal())
        .await
        .is_err());
    assert!(provider.calls().is_empty());
    engine
        .prompt("accepted", PromptOptions::default())
        .await
        .unwrap();
    let starts = events(&fixture.cwd.join("starts.jsonl"));
    assert_eq!(
        starts
            .iter()
            .map(|event| event["source"].clone())
            .collect::<Vec<_>>(),
        [json!("startup")]
    );
    assert_eq!(provider.calls().len(), 1);
}

#[tokio::test]
async fn custom_only_adoption_keeps_startup_source() {
    for adoption in ["construction", "branch", "window"] {
        let fixture = Fixture::new(&json!({"hooks": {"SessionStart": [{"hooks": [{
            "type": "command", "command": "{ cat; printf '\\n'; } >> starts.jsonl"
        }]}]}}));
        let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
        provider.push_text_turn("first actual conversation");
        let mut durable = crate::session::manager::SessionManager::in_memory(&fixture.cwd);
        durable
            .append_custom_message(
                "goal_continuation",
                pa_types::ai::UserContent::Text("setup context".into()),
                /*display*/ false,
                None,
            )
            .unwrap();
        let entries = durable.get_all_entries().to_vec();
        let mut config = fixture.config(&provider);
        if adoption == "construction" {
            config.session_manager = Some(durable);
        }
        let engine = create_session(config).await.unwrap();
        if adoption == "branch" {
            engine
                .session
                .rebuild_branch_context(entries)
                .await
                .unwrap();
        } else if adoption == "window" {
            let path = fixture.cwd.join("restored.jsonl");
            let mut bytes = Vec::new();
            for entry in entries {
                serde_json::to_writer(&mut bytes, &entry).unwrap();
                bytes.push(b'\n');
            }
            std::fs::write(&path, bytes).unwrap();
            let window = crate::session::window::WindowedSessionStore::open(&path)
                .unwrap()
                .unwrap();
            engine.session.restore_windowed_context(window).await;
        }
        engine
            .prompt("first", PromptOptions::default())
            .await
            .unwrap();
        assert_eq!(
            events(&fixture.cwd.join("starts.jsonl"))
                .iter()
                .map(|event| event["source"].clone())
                .collect::<Vec<_>>(),
            [json!("startup")],
            "{adoption}"
        );
    }
}

#[tokio::test]
async fn stop_feedback_is_attributed_persisted_bounded_and_admitted() {
    let reason = "Run remaining validation.\nPreserve these details.";
    let attributed = format!("Continuation requested by a Stop hook: {reason}");
    for veto_continuation in [false, true] {
        let output =
            serde_json::to_string(&json!({"decision": "block", "reason": reason})).unwrap();
        let fixture = Fixture::new(&json!({"hooks": {
            "Stop": [{"hooks": [{"type": "command", "command": format!(
                "{{ cat; printf '\\n'; }} >> stops.jsonl; printf '%s' '{output}'"
            )}]}],
            "UserPromptSubmit": [{"hooks": [{"type": "command", "command":
                "input=$(cat); printf '%s\\n' \"$input\" >> prompts.jsonl; if [ -f veto ]; then case \"$input\" in *'Continuation requested by a Stop hook:'*) printf '%s' 'continuation veto' >&2; exit 2;; esac; fi"
            }]}]
        }}));
        if veto_continuation {
            std::fs::write(fixture.cwd.join("veto"), []).unwrap();
        }
        let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
        provider.push_text_turn("initial answer");
        provider.push_text_turn("validation answer");
        let engine = create_session(fixture.config(&provider)).await.unwrap();
        // A vetoed continuation is dropped with a notice: the finished run
        // stays successful and its answer is not followed by a failure row.
        engine
            .prompt("begin", PromptOptions::default())
            .await
            .unwrap();
        let entries = engine.session.entries().await;
        let notices: Vec<_> = entries
            .iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == super::messages::HOOK_NOTICE_CUSTOM_TYPE =>
                {
                    Some(payload.content.text())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            notices,
            if veto_continuation {
                vec!["Prompt blocked by a UserPromptSubmit hook: continuation veto".to_string()]
            } else {
                vec![]
            }
        );
        assert!(!entries.iter().any(|entry| matches!(
            entry,
            pa_types::session::FileEntry::Message {
                message: SessionAgentMessage::Assistant(assistant),
                ..
            } if assistant.error_message.is_some()
        )));
        let prompts = events(&fixture.cwd.join("prompts.jsonl"));
        assert_eq!(
            prompts
                .iter()
                .map(|event| event["prompt"].clone())
                .collect::<Vec<_>>(),
            vec![json!("begin"), json!(attributed)]
        );
        let stops = events(&fixture.cwd.join("stops.jsonl"));
        assert_eq!(
            stops
                .iter()
                .map(|event| event["stop_hook_active"].clone())
                .collect::<Vec<_>>(),
            if veto_continuation {
                vec![json!(false)]
            } else {
                vec![json!(false), json!(true)]
            }
        );
        let calls = provider.calls();
        assert_eq!(calls.len(), if veto_continuation { 1 } else { 2 });
        let persisted: Vec<_> = engine
            .session
            .entries()
            .await
            .into_iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::Message {
                    message: SessionAgentMessage::User(user),
                    ..
                } => Some(user.content),
                _ => None,
            })
            .collect();
        let feedback: Vec<_> = persisted.into_iter().filter(|content|
            matches!(content, pa_types::ai::UserContent::Text(text) if text == &attributed)
        ).collect();
        assert_eq!(
            feedback,
            if veto_continuation {
                vec![]
            } else {
                vec![pa_types::ai::UserContent::Text(attributed.clone())]
            }
        );
        if !veto_continuation {
            let model_feedback: Vec<_> = calls[1]
                .messages
                .iter()
                .filter_map(|message| match message {
                    pa_agent::types::Message::User(user)
                        if user.content
                            == pa_agent::types::UserContent::Text(attributed.clone()) =>
                    {
                        Some(user.content.clone())
                    }
                    _ => None,
                })
                .collect();
            assert_eq!(
                model_feedback,
                vec![pa_agent::types::UserContent::Text(attributed.clone())]
            );
            assert_eq!(stops[0]["turn_id"], stops[1]["turn_id"]);
        }
    }
}

#[tokio::test]
async fn pre_admission_compaction_preserves_initial_event_order_and_stop_retry() {
    for resumed in [false, true] {
        for stop_initial in [false, true] {
            let fixture = Fixture::new(&json!({"hooks": {"SessionStart": [{"hooks": [{
                "type": "command", "command": "input=$(cat); printf '%s\\n' \"$input\" >> starts.jsonl; if [ -f stop-initial ]; then case \"$input\" in *'\"source\":\"compact\"'*) ;; *) printf '%s' '{\"continue\":false,\"stopReason\":\"stop initial event\"}';; esac; fi"
            }]}]}}));
            if stop_initial {
                std::fs::write(fixture.cwd.join("stop-initial"), []).unwrap();
            }
            let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
            provider.push_text_turn("accepted after lifecycle work");
            let engine = create_session(fixture.config(&provider)).await.unwrap();
            engine.session.mark_compaction_hook();
            if resumed {
                let mut durable = crate::session::manager::SessionManager::in_memory(&fixture.cwd);
                durable
                    .append_message(SessionAgentMessage::User(pa_types::ai::UserMessage {
                        content: pa_types::ai::UserContent::Text("prior conversation".into()),
                        timestamp: 0,
                        rest: serde_json::Map::default(),
                    }))
                    .unwrap();
                engine
                    .session
                    .rebuild_branch_context(durable.get_all_entries().to_vec())
                    .await
                    .unwrap();
            }
            // Neither event may disappear when admission is cancelled first.
            let abort = pa_agent::abort::AbortController::new();
            abort.abort();
            assert!(engine
                .session
                .lifecycle_hooks
                .as_ref()
                .unwrap()
                .start("test", abort.signal())
                .await
                .is_err());
            assert!(!fixture.cwd.join("starts.jsonl").exists());
            if stop_initial {
                let error = engine
                    .prompt("stopped", PromptOptions::default())
                    .await
                    .unwrap_err();
                assert!(error.to_string().contains("stop initial event"));
                assert!(provider.calls().is_empty());
                assert_eq!(events(&fixture.cwd.join("starts.jsonl")).len(), 1);
            }
            engine
                .prompt("accepted", PromptOptions::default())
                .await
                .unwrap();
            assert_eq!(
                events(&fixture.cwd.join("starts.jsonl"))
                    .iter()
                    .map(|event| event["source"].clone())
                    .collect::<Vec<_>>(),
                vec![
                    json!(if resumed { "resume" } else { "startup" }),
                    json!("compact")
                ]
            );
            assert_eq!(provider.calls().len(), 1);
        }
    }
}

#[tokio::test]
async fn compact_mark_arriving_during_dispatch_survives_for_next_gate() {
    let fixture = Fixture::new(&json!({"hooks": {"SessionStart": [{"hooks": [{
        "type": "command", "command": "input=$(cat); printf '%s\\n' \"$input\" >> starts.jsonl; case \"$input\" in *'\"source\":\"compact\"'*) touch entered; while [ ! -f release ]; do sleep 0.02; done;; esac"
    }]}]}}));
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    let engine = create_session(fixture.config(&provider)).await.unwrap();
    let hooks = engine.session.lifecycle_hooks.as_ref().unwrap();
    hooks
        .start("test", pa_agent::abort::AbortSignal::never())
        .await
        .unwrap();
    engine.session.mark_compaction_hook();
    let dispatch = hooks.start("test", pa_agent::abort::AbortSignal::never());
    let concurrent_mark = async {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !fixture.cwd.join("entered").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("compact hook started");
        engine.session.mark_compaction_hook();
        std::fs::write(fixture.cwd.join("release"), []).unwrap();
    };
    let (result, ()) = tokio::join!(dispatch, concurrent_mark);
    result.unwrap();
    hooks
        .start("test", pa_agent::abort::AbortSignal::never())
        .await
        .unwrap();
    assert_eq!(
        events(&fixture.cwd.join("starts.jsonl"))
            .iter()
            .map(|event| event["source"].clone())
            .collect::<Vec<_>>(),
        vec![json!("startup"), json!("compact"), json!("compact")]
    );
}

#[tokio::test]
async fn hook_diagnostics_persist_as_display_rows_and_never_reach_the_model() {
    let fixture = Fixture::new(&json!({"hooks": {"Stop": [{"hooks": [{
        "type": "command", "command": "cat >/dev/null; printf '{\"decision\":'"
    }]}]}}));
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("first answer");
    provider.push_text_turn("second answer");
    let engine = create_session(fixture.config(&provider)).await.unwrap();
    engine
        .prompt("first", PromptOptions::default())
        .await
        .unwrap();
    engine
        .prompt("second", PromptOptions::default())
        .await
        .unwrap();
    let notices: Vec<_> = engine
        .session
        .entries()
        .await
        .into_iter()
        .filter_map(|entry| match entry {
            pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == super::messages::HOOK_NOTICE_CUSTOM_TYPE =>
            {
                Some((payload.content.text(), payload.display))
            }
            _ => None,
        })
        .collect();
    // Identical failures surface once per session. The parser's own wording
    // is not part of the contract: only the event, outcome and command are.
    let [(notice, true)] = notices.as_slice() else {
        panic!("one display-only notice: {notices:?}");
    };
    assert!(
        notice.starts_with("Stop hook failed, operation unchanged: ")
            && notice.ends_with("\ncommand: cat >/dev/null; printf '{\"decision\":'"),
        "{notice}"
    );
    let live = engine.session.agent().state().await.messages;
    assert!(live.iter().any(|message| matches!(
        message,
        pa_agent::types::AgentMessage::Custom(custom)
            if custom.payload["customType"] == super::messages::HOOK_NOTICE_CUSTOM_TYPE
    )));
    for call in provider.calls() {
        assert!(
            !format!("{:?}", call.messages).contains("Stop hook failed"),
            "hook diagnostics are never model context"
        );
    }
}

/// Every root session installs the tool-hook callbacks, even with no
/// configuration. An abort during a tool call must still record the executed
/// abort result with its status and duration, not the callback's abort error.
#[tokio::test]
async fn aborted_tool_call_keeps_its_result_with_hook_callbacks_installed() {
    let directory = tempfile::tempdir().unwrap();
    let cwd = directory.path().join("project");
    let agent_dir = directory.path().join("agent");
    std::fs::create_dir(&cwd).unwrap();
    std::fs::create_dir(&agent_dir).unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let entered_tool = Arc::clone(&entered);
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_tool_call_turn(Some("calling"), vec![("call-1", "stall", json!({}))]);
    provider.push_text_turn("unused");
    let engine = create_session(SessionEngineConfig {
        cwd,
        agent_dir,
        model: Some(Model::unknown()),
        stream_fn: Some(provider.stream_fn()),
        custom_system_prompt: Some("Test aborts.".into()),
        tools: vec![super::tool_bridge::bridge_tool(
            crate::tools::tool_definition::ToolDefinition {
                name: "stall".into(),
                label: "Stall".into(),
                description: "Runs until aborted".into(),
                prompt_snippet: String::new(),
                parameters: json!({"type": "object"}),
                execution_mode: None,
                prepare_arguments: None,
                execute: Arc::new(move |_, _, _, _| {
                    let entered = Arc::clone(&entered_tool);
                    Box::pin(async move {
                        entered.notify_one();
                        tokio::time::sleep(std::time::Duration::from_secs(600)).await;
                        Ok(crate::tools::tool_definition::ToolExecutionResult::text(
                            "finished",
                        ))
                    })
                }),
            },
        )],
        prewarm_ipython_kernel: Some(false),
        ..Default::default()
    })
    .await
    .unwrap();
    let engine = Arc::new(engine);
    let prompting = tokio::spawn({
        let engine = Arc::clone(&engine);
        async move { engine.session.prompt("go", PromptOptions::default()).await }
    });
    let session = &engine.session;
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .expect("the tool started");
    session.agent().abort();
    let _ = prompting.await.unwrap();
    session.agent().wait_for_idle().await;
    let result = session
        .entries()
        .await
        .into_iter()
        .find_map(|entry| match entry {
            pa_types::session::FileEntry::Message {
                message: SessionAgentMessage::ToolResult(result),
                ..
            } => Some(result),
            _ => None,
        })
        .expect("aborted toolResult persisted");
    let text = match &result.content[..] {
        [pa_types::ai::UserContentBlock::Text(text)] => text.text.clone(),
        other => panic!("expected the abort text: {other:?}"),
    };
    assert_eq!(
        (result.is_error, text.as_str()),
        (true, "Tool execution aborted")
    );
    assert_eq!(
        result
            .details
            .as_ref()
            .and_then(|details| details.get("status")),
        Some(&json!("aborted"))
    );
}

/// Every event carries `session_id` and `transcript_path`; a Stop hook reads
/// the finished turn, final answer included, at that path. An in-memory
/// session reports a null path.
#[tokio::test]
async fn stop_hook_reads_the_finished_transcript_at_transcript_path() {
    let fixture = Fixture::new(&json!({"hooks": {
        "UserPromptSubmit": [{"hooks": [{"type": "command",
            "command": "{ cat; printf '\\n'; } >> events.jsonl"}]}],
        "Stop": [{"hooks": [{"type": "command",
            "command": "input=$(cat); printf '%s\\n' \"$input\" >> events.jsonl; path=$(printf '%s' \"$input\" | sed -n 's/.*\"transcript_path\":\"\\([^\"]*\\)\".*/\\1/p'); cp \"$path\" seen.jsonl"}]}]
    }}));
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("the final answer");
    provider.push_text_turn("second answer");
    let session_dir = fixture.cwd.join("sessions");
    let engine = create_session(SessionEngineConfig {
        session_manager: Some(super::SessionManager::persisted(&fixture.cwd, &session_dir)),
        ..fixture.config(&provider)
    })
    .await
    .unwrap();
    engine
        .prompt("question", PromptOptions::default())
        .await
        .unwrap();
    let seen = std::fs::read_to_string(fixture.cwd.join("seen.jsonl")).unwrap();
    assert!(seen.contains("the final answer"), "{seen}");
    let session_id = engine.session.session_id().await;
    let all = events(&fixture.cwd.join("events.jsonl"));
    let stop = all
        .iter()
        .find(|event| event["hook_event_name"] == "Stop")
        .unwrap();
    assert_eq!(stop["session_id"], json!(session_id));
    assert!(stop["transcript_path"]
        .as_str()
        .is_some_and(|path| std::path::Path::new(path)
            .extension()
            .is_some_and(|extension| extension == "jsonl")));
    // The first prompt's admission precedes the session file, which is
    // written once the first assistant row exists: its path is still null.
    let first_prompt = all
        .iter()
        .find(|event| event["hook_event_name"] == "UserPromptSubmit")
        .unwrap();
    assert_eq!(first_prompt["session_id"], json!(session_id));
    assert!(first_prompt["transcript_path"].is_null());
}
