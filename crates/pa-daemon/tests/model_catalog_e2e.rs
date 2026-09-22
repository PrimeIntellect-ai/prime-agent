//! End-to-end verifier for the `/model` picker's live catalog surface: the
//! daemon's `get_model_catalog` command must serve the registry snapshot
//! (full catalog plus the providers with configured auth), and an offline
//! daemon (no network, no live catalog) must fall back to the bundled
//! catalog with the disk cache untouched — the offline fallback the picker
//! renders when the refresh cannot land.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Supervisor {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Supervisor {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("PRIME_API_KEY")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        // Offline mode: the catalog refresh must stay on the bundled
        // fallback and never write the disk cache (TS `PI_OFFLINE`).
        .env("PI_OFFLINE", "1")
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

struct Client {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn request(&mut self, id: &str, command: Value) -> Value {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize");
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .unwrap_or_else(|error| panic!("write command {id}: {error}"));
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

fn write_models_json(agent_dir: &Path, base_url: &str) {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let models = json!({
        "providers": {
            "prime-inference": {
                "api": "openai-completions",
                "baseUrl": base_url,
                "apiKey": "sk-catalog-e2e",
                "models": [
                    {
                        "id": "mock-1",
                        "name": "Mock 1",
                        "api": "openai-completions",
                        "baseUrl": base_url,
                        "contextWindow": 128000,
                        "maxTokens": 4096,
                    }
                ]
            }
        }
    });
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::to_string_pretty(&models).expect("serialize models.json"),
    )
    .expect("write models.json");
}

#[test]
fn offline_daemon_serves_the_bundled_catalog_fallback() {
    let dir = std::env::temp_dir().join(format!(
        "pa-model-catalog-{}",
        std::process::id() * 1000
            + std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let agent_dir = dir.join("agent");
    let socket = dir.join("daemon.sock");
    // No auth beyond the models.json key: no provider credentials, no
    // private-model entitlements.
    write_models_json(&agent_dir, "http://127.0.0.1:9/v1");
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    let session_dir = agent_dir.join("sessions");
    let created = client.request(
        "create-1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "noSession": true,
                "name": "catalog",
            },
        }),
    );
    assert!(created["success"].as_bool().unwrap_or(false), "{created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    // get_model_catalog: the full catalog with the configured providers.
    let response = client.request(
        "catalog-1",
        json!({ "type": "get_model_catalog", "activeSessionId": session_id }),
    );
    assert!(response["success"].as_bool().unwrap_or(false), "{response}");
    let data = &response["data"];
    let models = data["models"].as_array().expect("models array");
    assert!(
        models.len() > 100,
        "the bundled catalog must serve as the offline fallback (got {} models)",
        models.len()
    );
    // The models.json custom model is part of the catalog.
    assert!(models
        .iter()
        .any(|model| model["id"] == "mock-1" && model["provider"] == "prime-inference"));
    // A bundled public prime-inference model is present with its catalog
    // fields (name, cost, context window).
    let fable = models
        .iter()
        .find(|model| {
            model["id"] == "anthropic/claude-fable-5" && model["provider"] == "prime-inference"
        })
        .expect("a bundled featured model");
    assert_eq!(fable["name"], "Claude Fable 5");
    assert_eq!(fable["cost"]["input"], 10);
    assert_eq!(fable["contextWindow"], 1000000);
    // The configured providers: prime-inference (the models.json key) and
    // nothing else — no ambient credentials authorize other providers.
    let providers: Vec<&str> = data["configuredProviders"]
        .as_array()
        .expect("configuredProviders array")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(providers, vec!["prime-inference"]);
    // Private Prime Inference models stay out without authorization.
    assert!(models.iter().all(|model| !model["id"]
        .as_str()
        .unwrap_or_default()
        .starts_with("internal/")));

    // The offline refresh never wrote the live-catalog cache.
    assert!(
        !agent_dir.join("prime-inference-models-cache.json").exists(),
        "offline mode must not write the catalog cache"
    );
    drop(client);
    drop(supervisor);
    let _ = std::fs::remove_dir_all(&dir);
}
