//! Real daemon admission events feed the same durable sink as worker turns.
use super::*;

#[test]
fn hook_veto_keeps_primary_and_batch_out_of_durable_history() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&agent_dir).unwrap();
    let source = agent_dir.join("hooks.json");
    let bytes = serde_json::to_vec(&json!({"hooks": {
        "SessionStart": [{"hooks": [{"type": "command", "command": "{ cat; printf '\\n'; } >> starts.jsonl"}]}],
        "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "input=$(cat); case \"$input\" in *reject*) printf '%s' 'admission rejected' >&2; exit 2;; esac"}]}]
    }})).unwrap();
    std::fs::write(&source, &bytes).unwrap();
    let mut store = crate::session_store::SessionFile::create(cwd.to_str().unwrap(), None, 0);
    let path = dir.path().join("session.jsonl");
    store.set_path(path.clone());
    store.rewrite().unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: cwd.clone(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: Some(path.clone()),
        faux_script: Some(
            json!({"engine": "faux", "responses": [
                {"text": "accepted answer"}, {"text": "queued answer"}
            ]})
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut durable_users = Vec::new();
    for (message, batch) in [
        ("reject primary", Vec::new()),
        (
            "batch primary",
            vec![crate::engine::PromptBatchRow {
                text: "reject batch".into(),
                images: vec![],
            }],
        ),
        (
            "accepted primary",
            vec![crate::engine::PromptBatchRow {
                text: "accepted batch".into(),
                images: vec![pa_agent::types::ImageContent {
                    data: "QUJD".into(),
                    mime_type: "image/png".into(),
                }],
            }],
        ),
    ] {
        if message == "accepted primary" {
            let core = engine.session.blocking_lock().clone().unwrap();
            core.session
                .agent()
                .follow_up(pa_agent::types::AgentMessage::Standard(
                    pa_agent::types::Message::User(pa_agent::types::UserMessage {
                        content: pa_agent::types::UserContent::Text("queued later".into()),
                        timestamp: 0,
                    }),
                ));
        }
        let mut failed = false;
        engine.run_prompt(
            0,
            PromptRequest {
                message: message.into(),
                batch,
                images: vec![],
                source: "user".into(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                match event {
                    EngineEvent::UserMessage(message) => {
                        store
                            .persist_entry("message", json!({"message": message}))
                            .unwrap();
                        durable_users.push(message);
                    }
                    EngineEvent::Done(Err(_)) => failed = true,
                    _ => {}
                }
                true
            },
        );
        if message == "accepted primary" {
            assert!(!failed);
        } else {
            assert!(failed);
            assert!(durable_users.is_empty());
            let persisted = std::fs::read_to_string(&path).unwrap();
            assert!(!persisted.contains("\"role\":\"user\""));
        }
    }
    let texts: Vec<String> = durable_users
        .iter()
        .map(|message| match &message["content"] {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect(),
            other => panic!("unexpected user content: {other}"),
        })
        .collect();
    assert_eq!(
        texts,
        ["accepted primary", "accepted batch", "queued later"]
    );
    assert_eq!(
        durable_users[1]["content"],
        json!([
            {"type": "text", "text": "accepted batch"},
            {"type": "image", "data": "QUJD", "mimeType": "image/png"}
        ])
    );
    let starts: Vec<Value> = std::fs::read_to_string(cwd.join("starts.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        starts
            .iter()
            .map(|event| event["source"].clone())
            .collect::<Vec<_>>(),
        [json!("startup")]
    );
}
