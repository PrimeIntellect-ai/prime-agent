//! Compaction hooks must decide before providers and without holding persistence locks.
use std::sync::Arc;
use std::time::Duration;

use pa_agent::agent::{Agent, AgentOptions};
use serde_json::{json, Value};

use super::compact_session::{CompactOutcome, CompactionTrigger};
use super::{AgentSession, SessionManager};

struct Fixture {
    directory: tempfile::TempDir,
    session: Arc<AgentSession>,
    provider: pa_ai::faux::FauxProviderRegistration,
}

async fn fixture(command: &str, turns: usize) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let cwd = directory.path().join("project");
    let agent_dir = directory.path().join("agent");
    std::fs::create_dir(&cwd).unwrap();
    std::fs::create_dir(&agent_dir).unwrap();
    let source = agent_dir.join("hooks.json");
    std::fs::write(
        &source,
        serde_json::to_vec(&json!({"hooks": {"PreCompact": [{
            "hooks": [{"type": "command", "command": command, "timeout": 10}]
        }]}}))
        .unwrap(),
    )
    .unwrap();
    let mut manager = SessionManager::in_memory(&cwd);
    for index in 0..turns {
        manager
            .append_message(pa_types::session::AgentMessage::User(
                pa_types::ai::UserMessage {
                    content: pa_types::ai::UserContent::Text(format!(
                        "turn {index} with enough words to summarize"
                    )),
                    timestamp: 0,
                    rest: serde_json::Map::default(),
                },
            ))
            .unwrap();
        manager
            .append_message(pa_types::session::AgentMessage::Assistant(
                pa_ai::faux::faux_assistant_text_message(
                    "assistant reply",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ),
            ))
            .unwrap();
    }
    let mut session = AgentSession::new(
        Arc::new(Agent::new(AgentOptions::default())),
        manager,
        Vec::new(),
    )
    .await
    .unwrap();
    session.set_compaction_settings(super::compaction::CompactionSettings {
        keep_recent_tokens: 12,
        ..Default::default()
    });
    let hooks = super::hooks::ToolHooks::new(cwd, agent_dir, "compact-session".into(), None, None);
    *hooks.run_id.write().unwrap() = "compact-turn".into();
    session.lifecycle_hooks = Some(hooks.lifecycle);
    let provider = pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
        api: Some(format!("compact-hook-{}", uuid::Uuid::new_v4())),
        ..Default::default()
    });
    Fixture {
        directory,
        session: Arc::new(session),
        provider,
    }
}

#[tokio::test]
async fn skipped_compaction_never_runs_precompact_command() {
    let fixture = fixture(
        "touch hook-ran; printf '%s' '{\"continue\":false,\"stopReason\":\"hook stopped\"}'",
        0,
    )
    .await;
    let result = fixture
        .session
        .compact(None, &fixture.provider.get_model(), None, None)
        .await
        .unwrap();
    assert_eq!(
        result,
        CompactOutcome::Skipped("Session is too short to compact — try again once it grows")
    );
    assert!(!fixture.directory.path().join("project/hook-ran").exists());
}

#[tokio::test]
async fn precompact_stop_preserves_transcript_and_releases_locks_for_manual_and_auto() {
    for trigger in [CompactionTrigger::Manual, CompactionTrigger::Auto] {
        let fixture = fixture(
            "cat > payload.tmp; mv payload.tmp payload.json; while ! test -e release; do sleep 0.01; done; printf '%s' '{\"continue\":false,\"stopReason\":\"hook stopped\"}'", 3,
        ).await;
        let model = fixture.provider.get_model();
        let original = fixture
            .session
            .session
            .lock()
            .await
            .retained_entries()
            .to_vec();
        let session = Arc::clone(&fixture.session);
        let hook_model = model.clone();
        let run = tokio::spawn(async move {
            session
                .compact_with_trigger(Some("retain decisions"), &hook_model, None, None, trigger)
                .await
        });
        let cwd = fixture.directory.path().join("project");
        // The atomic rename is the readiness signal: the hook is alive and has read stdin.
        tokio::time::timeout(Duration::from_secs(5), async {
            while !cwd.join("payload.json").exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("PreCompact command became ready");
        let persistence = fixture
            .session
            .session
            .try_lock()
            .expect("hook must not hold session lock");
        assert_eq!(persistence.retained_entries(), original.as_slice());
        drop(persistence);
        let flight = fixture
            .session
            .compaction_flight
            .try_lock()
            .expect("hook must not hold compaction flight");
        drop(flight);
        let payload: Value =
            serde_json::from_slice(&std::fs::read(cwd.join("payload.json")).unwrap()).unwrap();
        assert_eq!(
            payload,
            json!({
                "session_id": "compact-session", "transcript_path": null,
                "cwd": cwd, "hook_event_name": "PreCompact", "model": model.id,
                "turn_id": "compact-turn", "trigger": match trigger {
                    CompactionTrigger::Manual => "manual", CompactionTrigger::Auto => "auto",
                }
            })
        );
        std::fs::write(cwd.join("release"), b"").unwrap();
        let error = tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("hook stopped"), "{error:#}");
        assert_eq!(
            fixture.session.session.lock().await.retained_entries(),
            original.as_slice()
        );
    }
}

#[tokio::test]
async fn veto_preserves_raw_slash_echo_and_failure_row() {
    let fixture = fixture(
        "printf x >> hook-count; printf '%s' '{\"continue\":false,\"stopReason\":\"retain raw attempt\"}'", 3,
    ).await;
    let cwd = fixture.directory.path().join("project");
    let manager = std::mem::replace(
        &mut *fixture.session.session.lock().await,
        SessionManager::in_memory(&cwd),
    );
    let provider = Arc::new(pa_agent::scripted::ScriptedProvider::new(
        pa_agent::types::Model::unknown(),
    ));
    let engine = super::engine::create_session(super::engine::SessionEngineConfig {
        cwd: cwd.clone(),
        agent_dir: fixture.directory.path().join("agent"),
        model: Some(pa_agent::types::Model::unknown()),
        session_manager: Some(manager),
        stream_fn: Some(provider.stream_fn()),
        custom_system_prompt: Some("Compaction veto regression.".into()),
        prewarm_ipython_kernel: Some(false),
        ..Default::default()
    })
    .await
    .unwrap();
    engine
        .session
        .set_compaction_settings(super::compaction::CompactionSettings {
            keep_recent_tokens: 12,
            ..Default::default()
        });
    let model = fixture.provider.get_model();
    let original = engine
        .session
        .session
        .lock()
        .await
        .retained_entries()
        .to_vec();
    let command = super::slash_commands::SessionSlashCommand {
        name: "compact",
        args: "retain decisions".into(),
        text: "/compact retain decisions".into(),
    };
    let mut autonomous = crate::autonomous::create_autonomous_runtime_state(None, None);
    let execution = super::session_commands::execute_session_command(
        &engine,
        &mut super::session_commands::SessionCommandParams {
            model: &model,
            api_key: None,
            global_harness_dir: fixture.directory.path().join("harness"),
            autonomous: &mut autonomous,
            compaction_abort: None,
        },
        &command,
        &[],
    )
    .await;
    assert!(execution
        .error
        .as_deref()
        .unwrap()
        .contains("retain raw attempt"));
    assert!(execution.compaction.is_none());
    let session = engine.session.session.lock().await;
    let entries = session.retained_entries();
    assert_eq!(&entries[..original.len()], original.as_slice());
    let rows: Vec<_> = entries[original.len()..]
        .iter()
        .filter_map(|entry| {
            if let super::FileEntry::CustomMessage { payload, .. } = entry {
                Some((payload.custom_type.as_str(), payload.content.text()))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                "session_slash_command",
                "/compact retain decisions".to_string()
            ),
            (
                "session_slash_command_result",
                format!("Command failed: {}", execution.error.unwrap())
            ),
        ]
    );
    assert_eq!(std::fs::read(cwd.join("hook-count")).unwrap(), b"x");
    assert!(provider.calls().is_empty());
}

#[tokio::test]
async fn host_abort_cancels_a_ready_precompact_command() {
    let fixture = fixture("cat >/dev/null; touch ready; while :; do sleep 1; done", 3).await;
    let model = fixture.provider.get_model();
    let controller = pa_agent::abort::AbortController::new();
    let signal = controller.signal();
    let original = fixture
        .session
        .session
        .lock()
        .await
        .retained_entries()
        .to_vec();
    let compaction = fixture.session.compact_with_trigger(
        None,
        &model,
        None,
        Some(&signal),
        CompactionTrigger::Manual,
    );
    let cancel_when_ready = async {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !fixture.directory.path().join("project/ready").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("external precompact became ready");
        assert!(fixture.session.session.try_lock().is_ok());
        controller.abort();
    };
    let result = tokio::time::timeout(Duration::from_secs(7), async {
        let (result, ()) = tokio::join!(compaction, cancel_when_ready);
        result
    })
    .await
    .expect("host abort cancels before the configured ten-second timeout");
    let Err(error) = result else {
        panic!("a cancelled hook must not compact");
    };
    assert!(pa_agent::abort::is_abort_error(&error));
    assert_eq!(
        fixture.session.session.lock().await.retained_entries(),
        original.as_slice()
    );
}
