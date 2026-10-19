//! Observe the production failover rebind before a successful response can restore it.
use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

const DEADLINE: Duration = Duration::from_secs(20);

/// Read one complete provider request, with bounded accept and IO waits.
fn request(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + DEADLINE;
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "provider request never arrived");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("accept provider request: {error}"),
        }
    };
    stream.set_nonblocking(false).unwrap();
    stream.set_read_timeout(Some(DEADLINE)).unwrap();
    stream.set_write_timeout(Some(DEADLINE)).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut content_length = 0;
    loop {
        let mut line = String::new();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "incomplete request"
        );
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap();
        }
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body).unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["model"], "mock-1");
    stream
}

#[test]
#[allow(clippy::too_many_lines)] // One real primary-failure / held-backup / restore episode.
fn failover_rebinds_model_facts_before_the_backup_can_restore_primary() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let primary = TcpListener::bind("127.0.0.1:0").unwrap();
    let backup = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut providers = Map::new();
    for (name, listener, input, window) in [
        ("facts-primary", &primary, json!(["text"]), 128_000),
        ("facts-backup", &backup, json!(["text", "image"]), 64_000),
    ] {
        providers.insert(
            name.to_string(),
            json!({
                "api": "openai-completions",
                "baseUrl": format!("http://{}/v1", listener.local_addr().unwrap()),
                "apiKey": "sk-facts-test",
                "models": [{
                    "id": "mock-1", "name": name, "api": "openai-completions",
                    "input": input, "contextWindow": window, "maxTokens": 4096
                }]
            }),
        );
    }
    std::fs::write(
        agent_dir.join("models.json"),
        json!({"providers": providers}).to_string(),
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "retry": {"enabled": true, "maxRetries": 1, "baseDelayMs": 1,
                "failover": {"enabled": true, "maxRetries": 1, "baseDelayMs": 1}}
        })
        .to_string(),
    )
    .unwrap();
    let engine = Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: Some("facts-primary".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: Some(true),
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    let model = engine.resolve_model().unwrap();
    engine.ensure_core_session(&model).unwrap();
    let core = engine.session.blocking_lock().as_ref().unwrap().clone();
    let primary_facts = core.turn_boundary.bound().unwrap();
    assert_eq!(primary_facts.model_info.provider, "facts-primary");
    assert_eq!(primary_facts.context_window, Some(128_000));
    std::thread::scope(|scope| {
        // Own the sender inside the scope body so an assertion failure releases the server.
        let (arrived_tx, arrived_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let primary_server = scope.spawn(move || {
            for _ in 0..2 {
                let mut stream = request(&primary);
                let body = r#"{"error":{"message":"mock provider overloaded","type":"server_error","code":500}}"#;
                write!(stream, "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let backup_server = scope.spawn(move || {
            let mut stream = request(&backup);
            arrived_tx.send(()).unwrap();
            // No headers or SSE bytes until the actual bound facts have been inspected.
            // A failed assertion drops the sender, releasing this owned server on unwind.
            if release_rx.recv_timeout(DEADLINE).is_err() {
                return;
            }
            let chunk = json!({
                "id": "facts-test", "object": "chat.completion.chunk", "created": 1,
                "model": "mock-1", "choices": [{"index": 0,
                    "delta": {"role": "assistant", "content": "backup completed"},
                    "finish_reason": "stop"}]
            });
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {chunk}\n\ndata: [DONE]\n\n").unwrap();
        });
        let running = Arc::clone(&engine);
        let turn = scope.spawn(move || {
            let mut events = Vec::new();
            admit(
                &running,
                "exercise actual provider failover".to_string(),
                &mut events,
            );
            events
        });
        arrived_rx
            .recv_timeout(DEADLINE)
            .expect("backup request must arrive after primary failures");
        let held_facts = core.turn_boundary.bound().unwrap();
        assert_eq!(
            (held_facts.model_info.clone(), held_facts.context_window),
            (
                pa_core::session_engine::turn_boundary::ModelInfo {
                    id: "mock-1".to_string(),
                    provider: "facts-backup".to_string(),
                    input: vec![
                        pa_types::ai::ModelInput::Text,
                        pa_types::ai::ModelInput::Image
                    ],
                },
                Some(64_000)
            ),
            "real model.info and compact.status runtime must rebind before backup success"
        );
        release_tx.send(()).unwrap();
        let events = turn.join().unwrap();
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("backup completed"),
            "the released backup must finish the real turn"
        );
        let restored = core.turn_boundary.bound().unwrap();
        assert_eq!(
            (restored.model_info.clone(), restored.context_window),
            (
                primary_facts.model_info.clone(),
                primary_facts.context_window
            ),
            "successful backup response restores the primary facts"
        );
        primary_server.join().unwrap();
        backup_server.join().unwrap();
    });
}
