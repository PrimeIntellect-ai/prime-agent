
use crate::agent_engine::tests::FAUX_TEST_LOCK;
use crate::engine::SessionEngine as _;

use super::*;
use crate::agent_engine::AgentEngineConfig;
use crate::engine::EngineModelSelection;
use pa_types::session::CustomMessage;

fn image_content(data: &str) -> pa_agent::types::ImageContent {
    pa_agent::types::ImageContent {
        data: data.to_string(),
        mime_type: "image/png".to_string(),
    }
}

fn user_turn(text: &str, images: Vec<pa_agent::types::ImageContent>) -> TurnPrompt {
    TurnPrompt::User {
        text: text.to_string(),
        images,
        batch: vec![PromptBatchRow {
            text: "second row".to_string(),
            images: vec![image_content("QkNE")],
        }],
    }
}

fn blocks_custom(images: usize) -> CustomMessage {
    let mut blocks = vec![pa_types::ai::UserContentBlock::Text(
        pa_types::ai::TextContent {
            text: "notice text".to_string(),
            text_signature: None,
            rest: serde_json::Map::default(),
        },
    )];
    for _ in 0..images {
        blocks.push(pa_types::ai::UserContentBlock::Image(
            pa_types::ai::ImageContent {
                data: "RUVG".to_string(),
                mime_type: "image/png".to_string(),
                rest: serde_json::Map::default(),
            },
        ));
    }
    CustomMessage {
        custom_type: "notice".to_string(),
        content: pa_types::ai::UserContent::Blocks(blocks),
        display: true,
        details: None,
        timestamp: 0,
        rest: serde_json::Map::default(),
    }
}

/// The child task quotes the user's text and instructs
/// description-only: the parent model owns the turn.
#[test]
fn child_prompt_quotes_the_user_text_and_forbids_solving() {
    let prompt = delegation_child_prompt("what is in this chart?");
    assert!(prompt.contains("<user_message>\nwhat is in this chart?\n</user_message>"));
    assert!(prompt.contains("Do not answer or solve"));
    assert!(prompt.contains("Describe every attached image"));
}

/// The delegation carries EVERY delivered image: the primary row's plus
/// every batched row's, or the injected custom row's blocks.
#[test]
fn delivered_images_collect_the_whole_batch() {
    let turn = user_turn("look", vec![image_content("QUJD")]);
    let images = delivered_images(&turn);
    assert_eq!(images.len(), 2);
    assert_eq!(images[0].data, "QUJD");
    assert_eq!(images[1].data, "QkNE");

    let text_only = user_turn("look", Vec::new());
    assert_eq!(delivered_images(&text_only).len(), 1);

    let injected = TurnPrompt::Injected(blocks_custom(2));
    assert_eq!(delivered_images(&injected).len(), 2);

    let text_custom = TurnPrompt::Injected(CustomMessage {
        content: pa_types::ai::UserContent::Text("plain".to_string()),
        ..blocks_custom(0)
    });
    assert!(delivered_images(&text_custom).is_empty());
}

/// The LLM-admitted copy of an injected row keeps its text and drops
/// the image blocks; an all-image row keeps the one-line marker
/// instead of an empty block list.
#[test]
fn stripped_custom_row_keeps_text_and_drops_images() {
    let stripped = stripped_custom_row(&blocks_custom(2));
    let pa_types::ai::UserContent::Blocks(blocks) = &stripped.content else {
        panic!("blocks content");
    };
    assert_eq!(blocks.len(), 1);
    assert!(!blocks
        .iter()
        .any(|block| matches!(block, pa_types::ai::UserContentBlock::Image(_))));

    let all_images = CustomMessage {
        content: pa_types::ai::UserContent::Blocks(vec![pa_types::ai::UserContentBlock::Image(
            pa_types::ai::ImageContent {
                data: "RUVG".to_string(),
                mime_type: "image/png".to_string(),
                rest: serde_json::Map::default(),
            },
        )]),
        ..blocks_custom(0)
    };
    let stripped = stripped_custom_row(&all_images);
    let pa_types::ai::UserContent::Blocks(blocks) = &stripped.content else {
        panic!("blocks content");
    };
    assert_eq!(blocks.len(), 1);
    assert!(matches!(
        &blocks[0],
        pa_types::ai::UserContentBlock::Text(text) if text.text == IMAGE_DELEGATION_ROW_MARKER
    ));
}

/// The battery-pair engine with a supervisor link: the worker is
/// daemon-backed (children present), so an image-attaching turn on the
/// text-only session model takes the delegation path, never the model
/// swap.
fn delegating_engine_with_socket(
    dir: &std::path::Path,
    socket: &std::path::Path,
) -> crate::agent_engine::AgentSessionEngine {
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "mock-battery",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "mock-battery",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        },
                        {
                            "id": "mock-vision",
                            "name": "Mock Vision",
                            "api": "mock-battery",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                            "input": ["text", "image"]
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({ "imageModel": "battery/mock-vision" }).to_string(),
    )
    .unwrap();
    let engine = crate::agent_engine::AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: Some(crate::agent_engine::SupervisorLinkConfig {
            socket_path: socket.to_path_buf(),
            active_session_id: "parent-active".to_string(),
            worker_token: String::new(),
        }),
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    engine.configure_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    engine
}

fn delegating_engine(dir: &std::path::Path) -> crate::agent_engine::AgentSessionEngine {
    delegating_engine_with_socket(dir, &dir.join("no-such-supervisor.sock"))
}

fn run_prompt_collecting(
    engine: &crate::agent_engine::AgentSessionEngine,
    images: Vec<pa_agent::types::ImageContent>,
) -> Vec<crate::engine::EngineEvent> {
    run_prompt_collecting_with_abort(engine, images, &|| false)
}

fn run_prompt_collecting_with_abort(
    engine: &crate::agent_engine::AgentSessionEngine,
    images: Vec<pa_agent::types::ImageContent>,
    aborted: &dyn Fn() -> bool,
) -> Vec<crate::engine::EngineEvent> {
    let mut events: Vec<crate::engine::EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        crate::engine::PromptRequest {
            batch: Vec::new(),
            images,
            message: "describe this".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        aborted,
        &mut |event| {
            events.push(event);
            true
        },
    );
    events
}

fn done_error(events: &[crate::engine::EngineEvent]) -> String {
    events
        .iter()
        .find_map(|event| match event {
            crate::engine::EngineEvent::Done(Err(error)) => Some(error.clone()),
            _ => None,
        })
        .expect("the turn ends with a loud failure")
}

fn register_text_only_battery_model() -> pa_ai::faux::FauxProviderRegistration {
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            api: Some("mock-battery".to_string()),
            provider: Some("battery".to_string()),
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "mock-1".to_string(),
                name: Some("Mock 1".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(128_000),
                max_tokens: Some(4096),
            }]),
            ..Default::default()
        });
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
        pa_ai::faux::faux_assistant_text_message(
            "the parent model answered",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
    )]);
    registration
}

/// A delegation whose child cannot spawn fails the turn LOUDLY: no
/// model turn runs (the text-only session model never receives the
/// request, and no placeholder answers for the images), the accepted
/// user row keeps its image blocks, and the session model is never
/// swapped onto the image model.
#[test]
fn image_turn_delegation_failure_is_loud_and_preserves_the_user_row() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let registration = register_text_only_battery_model();
    let dir = tempfile::TempDir::new().unwrap();
    let engine = delegating_engine(dir.path());
    let events = run_prompt_collecting(&engine, vec![image_content("QUJD")]);
    // The failure names the delegation; no assistant turn ran.
    let error = done_error(&events);
    assert!(error.contains("image delegation failed"), "{error}");
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, crate::engine::EngineEvent::TurnEnd { .. })),
        "the failed delegation produced no model turn"
    );
    // The accepted user row keeps its image blocks (the durable
    // transcript never loses the attachment).
    let user_row = events
        .iter()
        .find_map(|event| match event {
            crate::engine::EngineEvent::UserMessage(message) => Some(message.clone()),
            _ => None,
        })
        .expect("accepted user row");
    assert_eq!(user_row["content"][0]["text"], "describe this");
    assert_eq!(user_row["content"][1]["type"], "image");
    assert_eq!(user_row["content"][1]["data"], "QUJD");
    registration.unregister();
}

/// A depth-capped session cannot host the delegation child: the turn
/// fails loudly with the cap named — never a fallback swap onto the
/// image model.
#[test]
fn depth_capped_delegation_fails_loud_without_a_fallback_swap() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let registration = register_text_only_battery_model();
    let dir = tempfile::TempDir::new().unwrap();
    let engine = delegating_engine(dir.path());
    let children = engine
        .children
        .as_ref()
        .expect("daemon-backed engine has children")
        .clone();
    children.set_identity(crate::rlm_children::ParentIdentity {
        rlm_depth: 2,
        rlm_max_depth: 2,
        ..crate::rlm_children::ParentIdentity::with_default_depth()
    });
    let events = run_prompt_collecting(&engine, vec![image_content("QUJD")]);
    let error = done_error(&events);
    assert!(error.contains("image delegation failed"), "{error}");
    assert!(error.contains("depth cap"), "{error}");
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, crate::engine::EngineEvent::TurnEnd { .. })),
        "the capped delegation produced no model turn"
    );
    registration.unregister();
}

/// A scripted supervisor-link peer for the delegation integration
/// tests: answers `create`/`prompt`/`kill`/`wait_for_idle`/
/// `get_state`, and `get_last_assistant_text` with `answer`. Every
/// received command is captured for the wire assertions. Runs on its
/// own thread+runtime; each engine link request connects fresh, so
/// the accept loop serves one command per connection.
struct ScriptedSupervisor {
    captured: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
}

impl ScriptedSupervisor {
    fn spawn(socket: std::path::PathBuf, answer: &'static str) -> Self {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let captured: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured_thread = std::sync::Arc::clone(&captured);
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime.block_on(async move {
                    use pa_types::platform::transport::bind_transport;
                    let listener = bind_transport(&socket).await.unwrap();
                    loop {
                        let Ok(stream) = listener.accept().await else {
                            return;
                        };
                        let captured_thread = std::sync::Arc::clone(&captured_thread);
                        tokio::spawn(async move {
                            let (reader, mut writer) = stream.split();
                            let mut reader = BufReader::new(reader);
                            writer
                                .write_all(
                                    b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                                )
                                .await
                                .unwrap();
                            let mut line = String::new();
                            if reader.read_line(&mut line).await.unwrap() == 0 {
                                return;
                            }
                            let value: serde_json::Value =
                                serde_json::from_str(line.trim()).unwrap();
                            let id = value["id"].as_str().unwrap_or_default().to_string();
                            let command = value["command"].clone();
                            let command_type: &str =
                                command["type"].as_str().unwrap_or_default();
                            captured_thread.lock().unwrap().push(command.clone());
                            let response = crate::protocol::response_success(
                                Some(&id),
                                command_type,
                                match command_type {
                                    "create" => Some(serde_json::json!({
                                        "activeSessionId": "child-live",
                                        "sessionId": "child-file",
                                        "sessionFile": "/tmp/pa-image-delegation-child.jsonl",
                                        "sessionName": "img-child",
                                    })),
                                    "get_state" => Some(serde_json::json!({
                                        "isStreaming": false,
                                        "hasRunningSubagents": false,
                                        "sessionActions": { "queuedCount": 0 },
                                    })),
                                    "get_last_assistant_text" => {
                                        Some(serde_json::json!({ "text": answer }))
                                    }
                                    _ => None,
                                },
                            );
                            let mut wire = serde_json::to_string(&response).unwrap();
                            wire.push('\n');
                            writer.write_all(wire.as_bytes()).await.unwrap();
                        });
                    }
                });
        });
        Self { captured }
    }
}

/// The full happy path over a scripted supervisor: the child runs on
/// the resolved image model with the ACTUAL image bytes riding the
/// prompt wire, the parent's turn serves on the text-only SESSION
/// model (no swap), the description lands as exactly one durable
/// custom row, and the accepted user row is the only user row.
#[test]
fn image_turn_delegation_lands_the_child_answer_on_a_text_only_parent() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let registration = register_text_only_battery_model();
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("scripted-supervisor.sock");
    let supervisor =
        ScriptedSupervisor::spawn(socket.clone(), "a red square on a white background");
    let engine = delegating_engine_with_socket(dir.path(), &socket);
    let events = run_prompt_collecting(&engine, vec![image_content("QUJD")]);

    // The parent's model turn served on the SESSION model — never the
    // image model swap.
    let turn_end = events
        .iter()
        .find_map(|event| match event {
            crate::engine::EngineEvent::TurnEnd { message, .. } => Some(message.clone()),
            _ => None,
        })
        .expect("the parent's text-only turn ran");
    assert_eq!(turn_end["model"], serde_json::json!("mock-1"));
    assert_eq!(turn_end["provider"], serde_json::json!("battery"));

    // Exactly one user row (the accepted row, image blocks intact) and
    // exactly one custom row (the description) — no duplicates, no
    // terminal notice for the delegation child.
    let user_rows = events
        .iter()
        .filter(|event| matches!(event, crate::engine::EngineEvent::UserMessage(_)))
        .count();
    assert_eq!(user_rows, 1, "one accepted user row, no stripped twin");
    let description_row = events
        .iter()
        .filter_map(|event| match event {
            crate::engine::EngineEvent::CustomMessage(row) => Some(row.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(description_row.len(), 1, "one description row, no notice");
    let row = &description_row[0];
    assert_eq!(row["customType"], serde_json::json!("image_delegation"));
    assert_eq!(
        row["content"],
        serde_json::json!("a red square on a white background")
    );
    assert!(row["details"]["childId"]
        .as_str()
        .unwrap()
        .starts_with("sub-"));
    assert_eq!(
        row["details"]["sessionName"],
        serde_json::json!("img-child")
    );

    // The turn settled cleanly.
    assert!(events
        .iter()
        .any(|event| matches!(event, crate::engine::EngineEvent::Done(Ok(())))));

    // The child's create carried the resolved image model and the
    // next recursion depth; the child's prompt carried the user text
    // quote and the ACTUAL image bytes natively.
    let captured = supervisor.captured.lock().unwrap();
    let create = captured
        .iter()
        .find(|command| command["type"] == "create")
        .expect("create reached the supervisor");
    assert_eq!(create["config"]["provider"], serde_json::json!("battery"));
    assert_eq!(create["config"]["model"], serde_json::json!("mock-vision"));
    assert_eq!(create["config"]["rlmDepth"], serde_json::json!(1));
    let prompt = captured
        .iter()
        .find(|command| command["type"] == "prompt")
        .expect("prompt reached the supervisor");
    assert!(prompt["message"]
        .as_str()
        .unwrap()
        .contains("describe this"));
    assert!(prompt["message"]
        .as_str()
        .unwrap()
        .contains("Do not answer"));
    assert_eq!(
        prompt["images"],
        serde_json::json!([
            { "type": "image", "data": "QUJD", "mimeType": "image/png" }
        ]),
        "the child prompt rode the actual image bytes"
    );
    registration.unregister();
}

/// A settled child with an EMPTY answer fails the delegation loudly —
/// never a placeholder description — and no parent model turn runs.
#[test]
fn empty_child_answer_fails_the_delegation_loudly() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let registration = register_text_only_battery_model();
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("scripted-supervisor.sock");
    let _supervisor = ScriptedSupervisor::spawn(socket.clone(), "");
    let engine = delegating_engine_with_socket(dir.path(), &socket);
    let events = run_prompt_collecting(&engine, vec![image_content("QUJD")]);
    let error = done_error(&events);
    assert!(
        error.contains("image delegation failed") && error.contains("produced no answer"),
        "{error}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, crate::engine::EngineEvent::TurnEnd { .. })),
        "no parent model turn runs without a description"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, crate::engine::EngineEvent::CustomMessage(_))),
        "no description row lands for an answerless child"
    );
    registration.unregister();
}

/// An aborted delegation kills the child, settles it as errored, and
/// ends the turn as aborted — no model turn, no description row.
#[test]
fn aborted_delegation_kills_the_child_and_ends_aborted() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let registration = register_text_only_battery_model();
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("scripted-supervisor.sock");
    let supervisor =
        ScriptedSupervisor::spawn(socket.clone(), "an answer the abort never consumes");
    let engine = delegating_engine_with_socket(dir.path(), &socket);
    let events = run_prompt_collecting_with_abort(&engine, vec![image_content("QUJD")], &|| true);
    assert!(
        events
            .iter()
            .any(|event| matches!(event, crate::engine::EngineEvent::DoneAborted)),
        "the aborted delegation ends the turn as aborted"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, crate::engine::EngineEvent::TurnEnd { .. })),
        "no parent model turn runs for an aborted delegation"
    );
    // The child was killed and marked errored (settled), not left
    // running on the roster.
    let children = engine.children.as_ref().expect("children present");
    assert!(
        !children.has_running_children(),
        "the aborted delegation child settled"
    );
    // The abort raced the prompt admission: the supervisor may or may
    // not have seen the prompt, but it never owes a description.
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, crate::engine::EngineEvent::CustomMessage(_))),
        "no description row lands for an aborted delegation"
    );
    drop(supervisor);
    registration.unregister();
}
