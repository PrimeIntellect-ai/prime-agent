//! End-to-end verifier for the TUI export/share commands: a scripted daemon
//! session driven headlessly — `/export` (HTML and JSONL) writes the file and
//! reports the TS success row, and `/share` uploads through a stub `gh` on
//! PATH (no real upload ever leaves the box) and surfaces the share viewer
//! URL. `Usage: /share` is the TS error row when arguments appear.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_types::daemon::DaemonCommand;

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        graceful_shutdown(&self.socket);
        let worker_pids = child_pids_of(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        for pid in worker_pids {
            kill_worker(&pid);
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn kill_worker(pid: &u32) {
    unsafe {
        libc::kill(*pid as i32, libc::SIGKILL);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_alive(*pid) {
        assert!(
            Instant::now() < deadline,
            "worker {pid} survived the teardown kill"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn process_alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        let rest = stat
            .rsplit_once(')')
            .map(|(_, rest)| rest)
            .unwrap_or_default();
        !rest.starts_with('Z')
    })
}

fn child_pids_of(ppid: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    let entries = std::fs::read_dir("/proc").expect("read /proc");
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        fields.next(); // process state
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(pid);
        }
    }
    pids
}

fn graceful_shutdown(socket: &Path) {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    let Ok(stream) = UnixStream::connect(socket) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello); // daemon_hello
    let command = serde_json::json!({
        "type": "command",
        "id": "test-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let mut line = serde_json::to_string(&command).expect("serialize");
    line.push('\n');
    if writer.write_all(line.as_bytes()).is_err() {
        return;
    }
    let _ = writer.flush();
    let _ = reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = String::new();
    let _ = reader.read_line(&mut response);
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in [
        pa_daemon::worker::WORKER_ROLE_ENV,
        pa_daemon::worker::WORKER_TOKEN_ENV,
        pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
        pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
        pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
        pa_daemon::worker::WORKER_SOCKET_ENV,
        pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
        pa_daemon::worker::WORKER_SCRIPT_ENV,
    ] {
        command.env_remove(var);
    }
    for provider in pa_ai::models_generated::get_providers() {
        if let Some(vars) = pa_ai::env_api_keys::get_api_key_env_vars(provider) {
            for var in vars {
                command.env_remove(var);
            }
        }
    }
    command.env_remove("PRIME_TEAM_ID");
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor { child, socket };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// A stub `gh` binary: `auth status` succeeds, `gist create` requires the
/// upload file and prints a gist URL. No upload ever leaves the box.
fn write_stub_gh(dir: &Path) {
    let script = r#"#!/bin/bash
case "$1" in
  auth) exit 0 ;;
  gist)
    if [ $# -lt 4 ] || [ ! -f "$4" ]; then
      echo "gist: upload file missing" >&2
      exit 1
    fi
    echo "https://gist.github.com/testuser/abc123"
    ;;
  *) echo "unsupported: $1" >&2; exit 1 ;;
esac
"#;
    std::fs::write(dir.join("gh"), script).expect("write stub gh");
    make_executable(&dir.join("gh"));
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path).expect("stat").permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).expect("chmod");
}

#[tokio::test]
async fn tui_export_and_share_surface() {
    use base64::Engine as _;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());

    // The stub gh on PATH (isolated bin dir, PATH restored after the run).
    let stub_dir = dir.path().join("bin");
    std::fs::create_dir_all(&stub_dir).expect("bin dir");
    write_stub_gh(&stub_dir);
    let previous_path = std::env::var("PATH").unwrap_or_default();
    let previous_viewer_url = std::env::var("PI_SHARE_VIEWER_URL").ok();
    std::env::set_var("PATH", format!("{}:{}", stub_dir.display(), previous_path));

    // A live scripted session: one prompt, one scripted answer.
    // The faux engine (`engine: "faux"`) drives the real agent engine, so
    // the export embeds the real session's tools section.
    let script = serde_json::json!({ "engine": "faux", "responses": [
        { "text": "hello from scripted" },
    ] });
    let script_path = dir.path().join("script.json");
    std::fs::write(&script_path, script.to_string()).expect("write script");
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(&supervisor.socket)
        .await
        .expect("connect supervisor");
    let data = client
        .request_ok(DaemonCommand::Create {
            id: None,
            session_path: None,
            continue_recent: None,
            no_session: None,
            name: None,
            config: Some(serde_json::json!({
                "cwd": dir.path().display().to_string(),
                "sessionDir": session_dir.display().to_string(),
                "script": script_path.display().to_string(),
            })),
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: serde_json::Map::default(),
        })
        .await
        .expect("create session");
    client.close();
    let session_id = data
        .get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(serde_json::Value::as_str)
        .expect("session id")
        .to_string();

    let options = pa_tui::interactive::InteractiveOptions {
        socket_path: supervisor.socket.clone(),
        cwd: dir.path().to_path_buf(),
        session_dir: Some(session_dir.clone()),
        script_path: Some(script_path.clone()),
        model_selection: pa_tui::interactive::ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: pa_tui::interactive::SessionSelection::Attach(session_id.clone()),
        show_images: false,
        fullscreen_mouse: true,
        initial_message: None,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        client_settings: None,
    };
    let html_out = dir.path().join("export.html");
    let jsonl_out = dir.path().join("branch.jsonl");
    let plan = pa_tui::interactive::HeadlessPlan {
        steps: vec![
            pa_tui::interactive::HeadlessStep::Submit("say hi".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 30_000 },
            pa_tui::interactive::HeadlessStep::Submit(format!("/export {}", html_out.display())),
            pa_tui::interactive::HeadlessStep::Submit(format!("/export {}", jsonl_out.display())),
            pa_tui::interactive::HeadlessStep::Submit("/share".to_string()),
            pa_tui::interactive::HeadlessStep::WaitIdle { timeout_ms: 5_000 },
            pa_tui::interactive::HeadlessStep::Submit("/share now".to_string()),
        ],
        width: 100,
        height: 30,
    };
    let outcome =
        pa_tui::interactive::run_interactive(options, pa_tui::interactive::UiMode::Headless(plan))
            .await
            .expect("interactive run");

    std::env::set_var("PATH", previous_path);
    match previous_viewer_url {
        Some(value) => std::env::set_var("PI_SHARE_VIEWER_URL", value),
        None => std::env::remove_var("PI_SHARE_VIEWER_URL"),
    }

    let rendered = outcome.frames.join("\n");

    // The exported HTML: the TS success row, the standalone viewer file,
    // and the session data carrying the fixture turn.
    assert!(
        rendered.contains(&format!("Session exported to: {}", html_out.display())),
        "export success row missing:\n{rendered}"
    );
    let html = std::fs::read_to_string(&html_out).expect("exported html");
    assert!(html.contains("Session Export"), "template scaffold");
    assert!(html.contains("--accent: #7c6faf;"), "theme vars embedded");
    let marker = "session-data\" type=\"application/json\">";
    let start = html.find(marker).expect("session data element");
    let blob = &html[start + marker.len()..];
    let blob = blob.split('<').next().expect("script close");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob.trim())
        .expect("base64 session data");
    let data: serde_json::Value = serde_json::from_slice(&decoded).expect("session data");
    assert_eq!(data["header"]["type"], "session");
    let entries = data["entries"].as_array().expect("entries");
    // The faux engine normalizes the user message into content blocks
    // (the plain string form stays valid for scripted-harness sessions).
    let user_turn_present = |entry: &serde_json::Value| {
        entry["message"]["role"] == "user"
            && (entry["message"]["content"] == "say hi"
                || entry["message"]["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|block| block["text"] == "say hi")))
    };
    assert!(
        entries.iter().any(user_turn_present),
        "user message in export: {data}"
    );
    // The tools section: the session's registered tool contracts (TS
    // `state.tools` in the live-session export).
    let tools = data["tools"].as_array().expect("tools section");
    assert!(
        tools.iter().any(|tool| tool["name"] == "ipython"
            && tool["description"].is_string()
            && tool["parameters"].is_object()),
        "ipython contract in export tools: {data}"
    );
    // No custom tool ran: the pre-render section is omitted, not null.
    assert!(
        data.get("renderedTools").is_none(),
        "renderedTools omitted without custom-tool renders: {data}"
    );

    // The JSONL branch export: the success row plus a linear session file
    // starting with the header line.
    assert!(
        rendered.contains(&format!("Session exported to: {}", jsonl_out.display())),
        "jsonl export row missing:\n{rendered}"
    );
    let jsonl = std::fs::read_to_string(&jsonl_out).expect("exported jsonl");
    let first: serde_json::Value =
        serde_json::from_str(jsonl.lines().next().expect("header line")).expect("header");
    assert_eq!(first["type"], "session");
    assert!(
        jsonl.contains("say hi"),
        "branch export carries the turn:\n{jsonl}"
    );

    // The share rows: the stub gist URL surfaced as the viewer link.
    assert!(
        rendered.contains("Share URL: https://pi.dev/session/#abc123"),
        "share viewer URL missing:\n{rendered}"
    );
    assert!(
        rendered.contains("Gist: https://gist.github.com/testuser/abc123"),
        "gist URL missing:\n{rendered}"
    );
    // The loader surfaced while the upload ran (TS BorderedLoader).
    assert!(
        rendered.contains("Creating gist..."),
        "share loader row missing:\n{rendered}"
    );

    // `/share` with an argument is the TS usage error row.
    assert!(
        rendered.contains("Error: Usage: /share"),
        "usage error row missing:\n{rendered}"
    );
}
