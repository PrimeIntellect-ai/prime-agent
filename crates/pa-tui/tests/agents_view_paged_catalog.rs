//! The paged saved catalog: the first fetch asks for one page, the list says how many older
//! sessions are not loaded yet, scrolling to the end loads the next page, and a search walks the
//! rest of the store so the oldest session is still found.
#![cfg(unix)]

mod support;

use std::io::BufReader;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use serde_json::{json, Value};

use support::{read_line, respond, write_json};

const FILES: usize = 600;

/// Serve one view connection: `list_saved_sessions` answers the newest-first slice its
/// `cursor`/`limit` select (the mock's cursor is the slice start).
fn serve(listener: &UnixListener, saved_requests: &Mutex<Vec<Value>>) {
    let (stream, _) = listener.accept().expect("accept view connection");
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("read timeout");
    let mut writer = stream.try_clone().expect("clone socket");
    let mut reader = BufReader::new(stream);
    write_json(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
        }),
    );
    while let Some(line) = read_line(&mut reader) {
        let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = envelope["id"].as_str().unwrap_or_default().to_string();
        let command = envelope["command"].clone();
        match command["type"].as_str().unwrap_or_default() {
            "roster_subscribe" => respond(
                &mut writer,
                &id,
                "roster_subscribe",
                &json!({ "roster": [] }),
            ),
            "list_saved_sessions" => {
                saved_requests.lock().unwrap().push(command.clone());
                let start: usize = command["cursor"].as_str().map_or(0, |c| c.parse().unwrap());
                let end = command["limit"].as_u64().map_or(FILES, |limit| {
                    (start + usize::try_from(limit).unwrap()).min(FILES)
                });
                let rows: Vec<Value> = (start..end)
                    .map(|index| saved_row(FILES - 1 - index))
                    .collect();
                for row in &rows {
                    write_json(
                        &mut writer,
                        &json!({
                            "id": id,
                            "type": "session_list_item",
                            "command": "list_saved_sessions",
                            "session": row,
                        }),
                    );
                }
                let mut data = json!({ "sessions": rows, "remaining": FILES - end });
                if end < FILES {
                    data["nextCursor"] = json!(end.to_string());
                }
                respond(&mut writer, &id, "list_saved_sessions", &data);
            }
            other => respond(&mut writer, &id, other, &Value::Null),
        }
    }
}

/// Row `index` 0 is the oldest session; its name is the search target.
fn saved_row(index: usize) -> Value {
    let name = if index == 0 {
        "oldest drill".to_string()
    } else {
        format!("row {index:03}")
    };
    json!({
        "path": format!("/tmp/sessions/s{index:03}.jsonl"),
        "id": format!("s{index:03}"),
        "cwd": "/tmp",
        "rlmDepth": 0,
        "created": "2024-01-01T00:00:00.000Z",
        "modified": format!("2024-01-01T00:{:02}:{:02}.000Z", index / 60, index % 60),
        "messageCount": 3,
        "name": name,
    })
}

fn view_options(socket: &std::path::Path) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(PathBuf::from("/tmp/sessions")),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    }
}

#[tokio::test]
async fn the_catalog_pages_on_scroll_and_a_search_walks_the_rest() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let listener = UnixListener::bind(&socket).expect("bind mock socket");
    let saved_requests = Arc::new(Mutex::new(Vec::new()));
    let server = {
        let saved_requests = Arc::clone(&saved_requests);
        std::thread::spawn(move || serve(&listener, &saved_requests))
    };

    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitRender {
                needle: "400 older sessions not loaded".to_string(),
                timeout_ms: 3000,
            },
            AgentsStep::Key("end".to_string()),
            AgentsStep::WaitRender {
                needle: "200 older sessions not loaded".to_string(),
                timeout_ms: 3000,
            },
            AgentsStep::Type("oldest".to_string()),
            AgentsStep::WaitRender {
                needle: "oldest drill".to_string(),
                timeout_ms: 3000,
            },
        ],
        width: 120,
        height: 36,
    };
    let outcome = pa_tui::agents_view::run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("the agents view run")
    .outcome;

    let frames = outcome.frames.join("\n");
    assert!(frames.contains("400 older sessions not loaded"), "{frames}");
    assert!(
        frames.contains("Searching 200 older sessions"),
        "the search names the rows it is still loading: {frames}"
    );
    assert!(
        outcome.frames.last().is_some_and(
            |frame| frame.contains("oldest drill") && !frame.contains("older sessions")
        ),
        "the search found the oldest session and the whole store loaded: {:?}",
        outcome.frames.last()
    );
    let requests: Vec<(Value, Value)> = saved_requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| (request["cursor"].clone(), request["limit"].clone()))
        .collect();
    assert_eq!(
        requests,
        vec![
            (Value::Null, json!(200)),
            (json!("200"), json!(200)),
            (json!("400"), Value::Null),
        ],
        "first page, scroll page, then the search's remainder"
    );
    let _ = server.join();
}
